// Toolchain integration. Seeded random inputs straight in the codec's shape (small id ranges, so
// duplicates, kind clashes, dangling and cross-environment bindings,
// protected resources and stray approvals all occur). Two checks:
//   1. the compiled JS planner agrees with Bend's checker on every input
//   2. the three laws, re-stated as runtime predicates, hold of every
//      approved outcome of the compiled planner (a test of the artifact
//      the CLI runs; the proofs cover the Bend source for ALL inputs)
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  fromList,
  encode,
  readOutcome,
  type ActTag,
  type BApproval,
  type BDb,
  type BGrant,
  type BList,
  type BState,
  type BWk,
  type PlanArgs,
  type ReadOp,
} from "../../src/codec";
import { load, ROOT } from "../../src/engine";
import { toBend } from "../../src/term";
import { parseDesired, parseObserved, parseGrant, parseApprovals } from "../../src/schema";
import type { JsonData } from "../../src/json";

const SEED = 20261016;
const CASES = 400;

function rng(seed: number) {
  let s = seed >>> 0;

  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const list = <T>(xs: T[]): BList<T> =>
  xs.reduceRight<BList<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

const ACTS: readonly ActTag[] = ["Create", "Update", "Delete", "Replace"];

function gen(r: () => number): PlanArgs {
  const n = (k: number) => Math.floor(r() * k);
  const b = (p = 0.5) => r() < p;
  // each id lives in one environment (mostly 0n, the usual grant's)
  const envOf = Array.from({ length: 6 }, () => (b(0.75) ? 0 : 1));
  const envFor = (id: number) => (b(0.05) ? 1 - envOf[id] : envOf[id]);

  const state = (): BState => {
    // ids drawn without replacement (a duplicate now and then)
    const pool = [0, 1, 2, 3, 4, 5].sort(() => r() - 0.5);
    const take = () => (b(0.08) ? n(6) : (pool.pop() ?? n(6)));

    const dbs = Array.from({ length: n(4) }, (): BDb => {
      const id = take();

      return { $: "Db", id, env: envFor(id), protect: b(0.4), location: n(2), replicas: b() };
    });

    const wks = Array.from({ length: n(3) }, (): BWk => {
      const id = take();
      const env = envFor(id);
      // bindings usually target a database of the Worker's environment
      const same = dbs.filter((d) => d.env === env);

      return {
        $: "Wk",
        id,
        env,
        main: n(2),
        compat: n(2),
        binds: list(
          Array.from({ length: n(3) }, (_, i) => ({
            $: "Bind",
            name: i + (b(0.1) ? 0 : n(2)),
            db: same.length && b(0.85) ? same[n(same.length)].id : n(6),
          })),
        ),
      };
    });

    return { $: "State", dbs: list(dbs), wks: list(wks), buckets: list([]) };
  };

  const obs = state();
  // half the time, start from the observed graph and perturb it, so that
  // approved plans with updates, replacements and deletes are common
  const des = b(0.3) ? state() : structuredClone(obs);

  if (des.dbs.$ === "Con" && b()) des.dbs.head.location = 1 - des.dbs.head.location;

  if (des.dbs.$ === "Con" && b(0.3)) des.dbs = des.dbs.tail;

  if (des.wks.$ === "Con" && b(0.3)) des.wks = des.wks.tail;

  const grant: BGrant = {
    $: "Grant",
    env: b(0.85) ? 0 : 1,
    create: b(0.85),
    update: b(0.85),
    delete: b(0.85),
  };

  const apps = list(
    Array.from({ length: b(0.5) ? 0 : 1 + n(2) }, (): BApproval => {
      const id = n(6);

      return { $: "Approval", act: { $: ACTS[2 + n(2)] }, id, env: b(0.85) ? envOf[id] : n(2) };
    }),
  );

  return [des, obs, grant, apps];
}

const cases = (() => {
  const r = rng(SEED);

  return Array.from({ length: CASES }, () => gen(r));
})();

// The laws as runtime predicates over plain values (independent of the
// planner's code, like LAWS.bend).
function lawsHold(
  des: BState,
  obs: BState,
  g: BGrant,
  apps: BList<BApproval>,
  ops: ReadOp[],
): string | null {
  const dbs = fromList(des.dbs);
  const odbs = fromList(obs.dbs);
  const approvals = fromList(apps);

  for (const op of ops) {
    const a = op.act;

    const permitted =
      a === "Create"
        ? g.create
        : a === "Update"
          ? g.update
          : a === "Delete"
            ? g.delete
            : g.create && g.delete;

    if (op.env !== g.env || !permitted) return `env_isolation: ${JSON.stringify(op)}`;

    const all = [
      ...dbs,
      ...odbs,
      ...fromList(des.wks),
      ...fromList(obs.wks),
      ...fromList(des.buckets),
      ...fromList(obs.buckets),
    ];

    if (all.some((r) => r.id === op.id && r.env !== g.env))
      return `env_isolation (residency): ${JSON.stringify(op)}`;

    if (a === "Delete" || a === "Replace") {
      const prot = [...odbs, ...dbs, ...fromList(des.buckets), ...fromList(obs.buckets)].some(
        (d) => d.id === op.id && d.protect,
      );

      if (prot && !approvals.some((x) => x.act.$ === a && x.id === op.id && x.env === op.env))
        return `protected_deletion: ${JSON.stringify(op)}`;
    }
  }

  for (const w of fromList(des.wks)) {
    for (const bd of fromList(w.binds)) {
      const targets = bd.$ === "Bind" ? dbs : fromList(des.buckets);
      const id = bd.$ === "Bind" ? bd.db : bd.bucket;

      if (!targets.some((d) => d.id === id && d.env === w.env))
        return `binding_validity: worker ${w.id} -> ${id}`;
    }
  }

  return null;
}

const R2_SEED = 20261102;

const r2cases = (() => {
  const r = rng(R2_SEED);

  return Array.from({ length: 160 }, (_, i) => {
    const id = `bucket-${Math.floor(r() * 100000)}`;
    const environment = r() < 0.5 ? "staging" : "production";
    const bucket = { type: "r2_bucket", id, environment, protected: r() < 0.5 };

    const worker = {
      type: "worker",
      id: "api",
      environment,
      main: `worker-${Math.floor(r() * 3)}.js`,
      compatibilityDate: "2026-01-01",
      bindings: [{ name: "ASSETS", bucket: id }],
    };

    let des: JsonData[] = [bucket, worker];
    let obs: JsonData[] = [];
    let apps: JsonData[] = [];

    switch (i % 8) {
      case 0:
        break; // approved provider + consumer creates
      case 1:
        obs = des;
        break; // approved no-op
      case 2:
        obs = [{ ...bucket, protected: true }];
        des = [];
        break; // pending
      case 3:
        obs = [{ ...bucket, protected: true }];
        des = [];
        apps = [
          {
            action: "delete",
            resource: id,
            environment,
            approvedBy: "reviewer@example.com",
            reason: "seeded fixture retirement",
          },
        ];
        break;
      case 4:
        des = [
          bucket,
          { ...worker, environment: environment === "staging" ? "production" : "staging" },
        ];
        break;
      case 5:
        des = [
          {
            type: "d1_database",
            id,
            environment,
            location: "enam",
            readReplication: "disabled",
            protected: false,
          },
          worker,
        ];
        break;
      case 6:
        obs = [{ ...bucket, protected: false }];
        des = [{ ...bucket, protected: true }];
        break;
      case 7:
        des = [bucket, { ...worker, bindings: [{ name: "DB", database: id }] }];
        break;
    }

    const desired = parseDesired(
      JSON.stringify({
        version: 1,
        kind: "bend-infra/desired",
        environments: ["staging", "production"],
        resources: des,
      }),
    );

    const observed = parseObserved(
      JSON.stringify({
        version: 1,
        kind: "bend-infra/observed",
        source: "fixture",
        resources: obs,
      }),
      desired.environments,
    );

    const grant = parseGrant(
      JSON.stringify({
        version: 1,
        kind: "bend-infra/grant",
        environment,
        allow: ["create", "update", "delete"],
      }),
      desired.environments,
    );

    const approvals = parseApprovals(
      JSON.stringify({ version: 1, kind: "bend-infra/approvals", approvals: apps }),
      desired.environments,
    );

    return encode(desired, observed, grant, approvals).args;
  });
})();

describe(`R2 public-schema random inputs (seed ${R2_SEED}, 160 cases)`, () => {
  test("varied outcomes, approved destructive operations and independent law predicates", async () => {
    const planner = await load();
    const tally = { Approved: 0, Pending: 0, Rejected: 0 };
    let destructive = 0;

    for (const c of r2cases) {
      const out = readOutcome(planner.plan(...c));
      tally[out.$]++;

      if (out.$ === "Approved") {
        expect(lawsHold(...c, out.ops)).toBeNull();

        if (out.ops.some((o) => o.act === "Delete")) destructive++;
      }
    }

    console.log(
      `R2 seed ${R2_SEED}: ${JSON.stringify(tally)}, approved destructive ${destructive}`,
    );
    expect(tally).toEqual({ Approved: 80, Pending: 20, Rejected: 60 });
    expect(destructive).toBe(20);
  });

  test("R2 compiled planner agrees with the genuine Bend checker", async () => {
    const planner = await load();
    const dir = path.join(ROOT, ".build", "differential");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "random-r2.bend");
    const calls = r2cases.map((c) => `P.plan(${c.map((a) => toBend(a, "P.")).join(", ")})`);
    fs.writeFileSync(
      file,
      `import Base\nimport ../../core/planner.bend as P\n\ndef main() -> List<&2, P.Outcome>:\n  [${calls.join(",\n   ")}]\n`,
    );

    const result = spawnSync(path.join(ROOT, "scripts", "bend.sh"), [path.relative(ROOT, file)], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim().replaceAll("../../core/planner.", "")).toBe(
      `[${r2cases.map((c) => toBend(planner.plan(...c))).join(", ")}]`,
    );
  }, 60000);
});

describe(`random inputs (seed ${SEED}, ${CASES} cases)`, () => {
  test("the outcomes are varied enough to mean something", async () => {
    const planner = await load();
    const tally: Record<string, number> = {};
    let destructiveApproved = 0;

    for (const c of cases) {
      const out = readOutcome(planner.plan(...c));
      tally[out.$] = (tally[out.$] ?? 0) + 1;

      if (out.$ === "Approved" && out.ops.some((o) => o.act === "Delete" || o.act === "Replace"))
        destructiveApproved++;
    }

    console.log(
      `  outcomes: ${JSON.stringify(tally)}, approved with destructive ops: ${destructiveApproved}`,
    );
    expect(tally.Approved).toBeGreaterThan(30);
    expect(tally.Rejected).toBeGreaterThan(30);
    expect(tally.Pending).toBeGreaterThan(5);
    expect(destructiveApproved).toBeGreaterThan(8);
  });

  test("every approved outcome satisfies the three laws (runtime check of the compiled planner)", async () => {
    const planner = await load();

    for (const c of cases) {
      const out = readOutcome(planner.plan(...c));

      if (out.$ === "Approved") expect(lawsHold(...c, out.ops)).toBeNull();
    }
  });

  test("the compiled JS planner agrees with Bend's checker on every case", async () => {
    const planner = await load();
    const js = cases.map((c) => toBend(planner.plan(...c)));
    const dir = path.join(ROOT, ".build", "differential");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "random.bend");
    const calls = cases.map((c) => `P.plan(${c.map((a) => toBend(a, "P.")).join(", ")})`);
    fs.writeFileSync(
      file,
      `import Base\nimport ../../core/planner.bend as P\n\ndef main() -> List<&2, P.Outcome>:\n  [${calls.join(",\n   ")}]\n`,
    );

    const r = spawnSync(path.join(ROOT, "scripts", "bend.sh"), [path.relative(ROOT, file)], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    expect(r.stdout.trim().replaceAll("../../core/planner.", "")).toBe(`[${js.join(", ")}]`);
  }, 60_000);
});
