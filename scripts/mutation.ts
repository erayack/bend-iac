// npm run test:mutation: deliberate planner/authorization bugs must be
// caught by the laws.
//
// For each mutant, in an isolated temp copy (the real sources are never
// touched, and their hashes are compared before and after):
//   1. the unmutated copy's proofs pass (baseline, bend2 and --verdict)
//   2. the mutation applies at exactly one place in core/planner.bend
//   3. the mutated planner alone still checks: the mutant is a well-formed
//      program, not a syntax, type or import error
//   4. PROOF.bend is rejected, by bend2 and by --verdict, and bend2's
//      failure lies in the proof chain of the intended law
//   5. the CLI's build gate refuses to compile the mutant
//   6. the mutant is a real bug: compiled anyway (in scratch only), it
//      approves a witness scenario that the real planner blocks. One
//      mutant is "masked": another stage of the gate (the stale-approval
//      check) still blocks its witness, so only the proof exposes it; the
//      run checks that it stays blocked and says so
// A run where every mutant is caught exits 0: expected rejection is
// success. Writes .build/mutation-report.json.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decode, encode, type Outcome } from "../src/codec";
import { load, planFrom, type PlanFn } from "../src/engine";
import type { JsonData } from "../src/json";
import { parseApprovals, parseDesired, parseGrant, parseObserved } from "../src/schema";

const ROOT = path.resolve(import.meta.dir, "..");
const BEND = path.join(ROOT, "scripts", "bend.sh");

const COPY = [
  "core",
  "LAWS.bend",
  "PROOF.bend",
  "EXAMPLES.bend",
  "src",
  "scripts",
  "toolchain.env",
  "LAWS.sha256",
];

const WATCH = ["core/planner.bend", "LAWS.bend", "PROOF.bend", "EXAMPLES.bend", "LAWS.sha256"];

type Docs = { desired: JsonData; observed: JsonData; grant: JsonData; approvals?: JsonData };

// an example directory, or documents
type Witness = { example: string } | { docs: Docs };

type Mutant = {
  name: string;
  law: string;
  chain: RegExp; // defs of PROOF.bend that prove this law
  bug: string;
  find: string;
  replace: string;
  witness: Witness;
  effect: "bypass" | "masked"; // does the witness get through the whole gate?
};

const ex = (name: string) => path.join(ROOT, "examples", name);

// the example's documents as JSON.parse reads them; plan() serializes them
// again for the strict schema, like a file
const readDocs = (dir: string): Docs => {
  const r = (f: string) =>
    fs.existsSync(path.join(dir, f))
      ? JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
      : undefined;

  return {
    desired: r("desired.json"),
    observed: r("observed.json"),
    grant: r("grant.json"),
    approvals: r("approvals.json"),
  };
};

const prodDb = {
  type: "d1_database",
  id: "prod-db",
  environment: "production",
  location: "enam",
  readReplication: "auto",
  protected: true,
};

const MUTANTS: Mutant[] = [
  {
    name: "replace-not-destructive",
    law: "protected_deletion",
    chain: /^(prot\.|Laws\.protected_deletion$)/,
    bug: "replacing a database is treated like an update: no approval needed",
    find: "    case Replace{}:\n      Bool.or(Bool.not(is_protected(id, des, obs)), approved(Replace{}, id, env, apps))",
    replace: "    case Replace{}:\n      True{}",
    witness: { example: ex("09-protected-replace-unapproved") },
    effect: "bypass",
  },
  {
    name: "approval-any-environment",
    law: "protected_deletion",
    chain: /^(prot\.|Laws\.protected_deletion$)/,
    bug: "an approval matches by action and id only, ignoring its environment",
    find: "Bool.or(Bool.and(eqa(aact, act), Bool.and(eqn(aid, id), eqn(aenv, env))), approved(act, id, env, t))",
    replace: "Bool.or(Bool.and(eqa(aact, act), eqn(aid, id)), approved(act, id, env, t))",
    witness: {
      docs: {
        ...readDocs(ex("08-protected-delete-approved")),
        approvals: {
          version: 1,
          kind: "bend-infra/approvals",
          approvals: [
            {
              action: "delete",
              resource: "prod-db",
              environment: "staging",
              approvedBy: "x@example.com",
              reason: "misdirected",
            },
          ],
        },
      },
    },
    effect: "masked",
  },
  {
    name: "grant-ignores-environment",
    law: "env_isolation",
    chain: /^(env\.|Laws\.env_isolation$)/,
    bug: "the grant check looks at the action only, not the environment",
    find: "      Bool.and(eqn(env, genv), Bool.and(permits(g, act), Bool.and(resident(id, genv, des), resident(id, genv, obs))))",
    replace: "      permits(g, act)",
    witness: { example: ex("04-cross-env-grant") },
    effect: "bypass",
  },
  {
    name: "grant-trusts-op-label",
    law: "env_isolation",
    chain: /^(env\.|Laws\.env_isolation$)/,
    bug: "the grant check trusts the op's environment label and skips residency of the resource it touches",
    find: "      Bool.and(eqn(env, genv), Bool.and(permits(g, act), Bool.and(resident(id, genv, des), resident(id, genv, obs))))",
    replace: "      Bool.and(eqn(env, genv), permits(g, act))",
    witness: {
      docs: {
        desired: {
          version: 1,
          kind: "bend-infra/desired",
          environments: ["staging", "production"],
          resources: [{ ...prodDb, environment: "staging", readReplication: "disabled" }],
        },
        observed: {
          version: 1,
          kind: "bend-infra/observed",
          source: "fixture",
          resources: [prodDb],
        },
        grant: { version: 1, kind: "bend-infra/grant", environment: "staging", allow: ["update"] },
      },
    },
    effect: "masked",
  },
  {
    name: "binding-ignores-environment",
    law: "binding_validity",
    chain: /^(bind\.|Laws\.binding_validity$)/,
    bug: "a binding is valid when its database exists in any environment",
    find: "keep(db_at(db, env, dbs), bind_err(",
    replace: "keep(mem(db, db_ids(dbs)), bind_err(",
    witness: {
      docs: {
        desired: {
          version: 1,
          kind: "bend-infra/desired",
          environments: ["staging", "production"],
          resources: [
            prodDb,
            {
              type: "worker",
              id: "api",
              environment: "staging",
              main: "src/api.ts",
              compatibilityDate: "2026-09-01",
              bindings: [{ name: "DB", database: "prod-db" }],
            },
          ],
        },
        observed: {
          version: 1,
          kind: "bend-infra/observed",
          source: "fixture",
          resources: [prodDb],
        },
        grant: { version: 1, kind: "bend-infra/grant", environment: "staging", allow: ["create"] },
      },
    },
    effect: "bypass",
  },
  {
    name: "bucket-binding-ignores-kind-and-environment",
    law: "binding_validity",
    chain: /^(bind\.|Laws\.binding_validity$)/,
    bug: "bucket bindings skip typed target and environment validation",
    find: "keep(bucket_at(bucket, env, buckets), bucket_bind_err(",
    replace: "keep(True{}, bucket_bind_err(",
    witness: { example: ex("17-r2-wrong-kind-target") },
    effect: "bypass",
  },
  {
    name: "protected-bucket-delete-unchecked",
    law: "protected_deletion",
    chain: /^(prot\.|Laws\.protected_deletion$)/,
    bug: "protected bucket witnesses are omitted from the destruction gate",
    find: "      Bool.or(Bool.or(protected(id, odbs), protected(id, dbs)), Bool.or(bucket_protected(id, obuckets), bucket_protected(id, buckets)))",
    replace: "      Bool.or(protected(id, odbs), protected(id, dbs))",
    witness: { example: ex("22-r2-protected-delete") },
    effect: "bypass",
  },
];

const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const hashes = () => Object.fromEntries(WATCH.map((f) => [f, sha(path.join(ROOT, f))]));

type BendRun = { code: number; out: string };

function bend(cwd: string, ...args: string[]): BendRun {
  const r = spawnSync(BEND, args, { cwd, encoding: "utf8" });

  return { code: r.status ?? 1, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

function copyTree(dst: string) {
  for (const f of COPY) fs.cpSync(path.join(ROOT, f), path.join(dst, f), { recursive: true });
  fs.symlinkSync(path.join(ROOT, ".toolchain"), path.join(dst, ".toolchain"));
}

function plan(planFn: PlanFn, docs: Docs): Outcome {
  const des = parseDesired(JSON.stringify(docs.desired));
  const obs = parseObserved(JSON.stringify(docs.observed), des.environments);
  const grant = parseGrant(JSON.stringify(docs.grant), des.environments);

  const apps = docs.approvals
    ? parseApprovals(JSON.stringify(docs.approvals), des.environments)
    : [];

  const enc = encode(des, obs, grant, apps);

  return decode(planFn(...enc.args), enc.tables);
}

type Result = {
  mutant: string;
  law: string;
  bug: string;
  effect: Mutant["effect"];
  caught: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
};

async function main(): Promise<number> {
  const before = hashes();
  const real = await load(); // the real, proof-gated planner
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bend-infra-mutation-"));
  const results: Result[] = [];

  try {
    // baseline: the unmutated copy proves
    const base = path.join(scratch, "baseline");
    copyTree(base);
    const b1 = bend(base, "PROOF.bend");
    const b2 = bend(base, "PROOF.bend", "--verdict");

    const baselineOk =
      b1.code === 0 &&
      b1.out.startsWith("ALL PROOFS CHECK") &&
      b2.code === 0 &&
      b2.out === "ALL PROOFS CHECK";

    console.log(
      `${baselineOk ? "PASS" : "FAIL"}  baseline: unmutated PROOF.bend checks (bend2: ${b1.out.split("\n")[0]}; --verdict: ${b2.out.split("\n")[0]})`,
    );

    if (!baselineOk) {
      console.log(b1.out + "\n" + b2.out);

      return 1;
    }

    for (const m of MUTANTS) {
      const dir = path.join(scratch, m.name);
      copyTree(dir);
      const checks: Result["checks"] = [];

      const check = (name: string, ok: boolean, detail: string) =>
        checks.push({ name, ok, detail });

      const core = path.join(dir, "core", "planner.bend");
      const src = fs.readFileSync(core, "utf8");
      const n = src.split(m.find).length - 1;
      check("mutation applies at exactly one place", n === 1, `${n} occurrence(s)`);

      if (n === 1) {
        fs.writeFileSync(core, src.replace(m.find, m.replace));

        const alone = bend(dir, "core/planner.bend");
        check(
          "mutated planner alone still checks (not a syntax/type/import error)",
          alone.code === 0 && alone.out.startsWith("ALL PROOFS CHECK"),
          alone.out.split("\n")[0],
        );

        const proof = bend(dir, "PROOF.bend");
        const loc = /^Location: (\S+)/m.exec(proof.out)?.[1] ?? "(none)";
        const typeError = /^- expected/m.test(proof.out) && /^- observed/m.test(proof.out);
        check(
          "bend2 rejects PROOF.bend",
          proof.code !== 0 && proof.out.startsWith("SOME PROOFS FAIL"),
          proof.out.split("\n")[0],
        );
        check(
          `the failure is a proof error in the ${m.law} chain`,
          typeError && m.chain.test(loc),
          `failing def: ${loc}`,
        );

        const verdict = bend(dir, "PROOF.bend", "--verdict");
        check(
          "--verdict also rejects PROOF.bend",
          verdict.code !== 0 && verdict.out.startsWith("SOME PROOFS FAIL"),
          verdict.out.split("\n")[0],
        );

        const gate = spawnSync("bun", [path.join(dir, "src", "cli.ts"), "build"], {
          cwd: dir,
          encoding: "utf8",
        });

        check(
          "the CLI build gate refuses the mutant",
          gate.status === 70 && gate.stderr.includes("refusing to build"),
          `exit ${gate.status}: ${gate.stderr.split("\n")[0]}`,
        );

        // compiled anyway, in scratch only, to show the bug is real
        const mjs = path.join(dir, "mutant.mjs");
        const comp = bend(dir, "core/planner.bend", "-o", mjs);

        if (comp.code === 0 && fs.existsSync(mjs)) {
          const docs = "example" in m.witness ? readDocs(m.witness.example) : m.witness.docs;
          const bad = plan(await planFrom(mjs), docs);
          const good = plan(real.plan, docs);

          const label =
            "example" in m.witness ? path.relative(ROOT, m.witness.example) : "generated witness";

          const ops =
            bad.outcome === "approved"
              ? bad.operations.map((o) => `${o.action} ${o.id}@${o.environment}`).join(", ")
              : "";

          const codes =
            bad.outcome === "approved" ? "" : bad.problems.map((p) => p.code).join(", ");

          if (m.effect === "bypass") {
            check(
              "witness: the mutant approves what the real planner blocks",
              bad.outcome === "approved" && good.outcome !== "approved",
              `${label}: real=${good.outcome}, mutant=${bad.outcome}${ops ? ` [${ops}]` : ""}`,
            );
          } else {
            check(
              "witness: masked, another gate stage still blocks it (only the proof exposes the bug)",
              bad.outcome !== "approved" && good.outcome !== "approved",
              `${label}: real=${good.outcome}, mutant=${bad.outcome} [${codes}]`,
            );
          }
        } else {
          check(
            "witness: the mutant approves what the real planner blocks",
            false,
            `could not compile mutant: ${comp.out}`,
          );
        }
      }

      const caught = checks.every((c) => c.ok);
      results.push({ mutant: m.name, law: m.law, bug: m.bug, effect: m.effect, caught, checks });
      console.log(
        `\n${caught ? "CAUGHT" : "MISSED"}  ${m.name}  (law ${m.law}; ${m.effect}): ${m.bug}`,
      );

      for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const after = hashes();
  const untouched = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\n${untouched ? "PASS" : "FAIL"}  original sources unchanged (${WATCH.join(", ")})`);
  console.log(`PASS  scratch copies removed`);
  fs.mkdirSync(path.join(ROOT, ".build"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, ".build", "mutation-report.json"),
    JSON.stringify({ results, untouched }, null, 2) + "\n",
  );
  const all = results.every((r) => r.caught) && untouched;
  console.log(
    all
      ? `\ntest:mutation: all ${results.length} mutants caught by the laws`
      : `\ntest:mutation: FAILED`,
  );

  return all ? 0 : 1;
}

process.exit(await main());
