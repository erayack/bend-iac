// The live commands' local refusals, through bin/bend-iac. Every case
// here is refused before any Wrangler process could start, which the run
// directory shows: no journal.jsonl (the adapter journals each command
// before spawning it) and no work directory. The account id is a made-up
// one, so even a regression could not act on a real account. The real
// Cloudflare lane is npm run test:live (test/live).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { JsonData } from "../../src/json";
import { cli, raw, RawText, ROOT } from "./helpers";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CONSENT = "create-and-delete-disposable-bend-infra-e2e-resources";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bend-infra-live-local-"));

process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

let n = 0;

const noRemote = (dir: string) => {
  expect(fs.existsSync(path.join(dir, "journal.jsonl"))).toBe(false);
  expect(fs.existsSync(path.join(dir, "work"))).toBe(false);
};

type RunDir = { dir: string; run: string };

function runDir(): RunDir {
  const dir = path.join(scratch, `run${n++}`);
  const r = cli("live", "init", dir, "--account", ACCOUNT, "--consent", CONSENT, "--json");
  expect(r.code).toBe(0);

  return { dir, run: JSON.parse(r.out).run };
}

// a desired document, or raw text that must not parse
type Desired = ReturnType<typeof desired> | RawText;

// the grant names the desired graph's first environment
function specDir(
  d: Desired,
  files: Record<string, string> = { "worker.js": "export default {};\n" },
): string {
  const dir = path.join(scratch, `spec${n++}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "desired.json"),
    d instanceof RawText ? d.text : JSON.stringify(d),
  );
  fs.writeFileSync(
    path.join(dir, "grant.json"),
    JSON.stringify({
      version: 1,
      kind: "bend-infra/grant",
      environment: d instanceof RawText ? "e2e" : (d.environments[0] ?? "e2e"),
      allow: ["create"],
    }),
  );

  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);

  return dir;
}

const desired = (resources: JsonData[], environments = ["e2e"]) => ({
  version: 1,
  kind: "bend-infra/desired",
  environments,
  resources,
});

const db = (id = "e2e-db", env = "e2e") => ({
  type: "d1_database",
  id,
  environment: env,
  location: "weur",
  readReplication: "disabled",
  protected: true,
});

const wk = (id = "e2e-api", main = "worker.js", env = "e2e") => ({
  type: "worker",
  id,
  environment: env,
  main,
  compatibilityDate: "2026-06-01",
  bindings: [],
});

type Written = { file: string; digest: string };

function artifact(dir: string, run: string, patch: Record<string, JsonData> = {}): Written {
  const file = path.join(scratch, `artifact${n++}.json`);

  const text =
    JSON.stringify(
      {
        version: 1,
        kind: "bend-infra/live-artifact",
        purpose: "plan",
        run,
        account: ACCOUNT,
        environment: "e2e",
        wrangler: ["npx", "--yes", "wrangler@4.151.1"],
        outcome: "approved",
        ...patch,
      },
      null,
      2,
    ) + "\n";

  fs.writeFileSync(file, text);

  return { file, digest: `sha256:${createHash("sha256").update(text).digest("hex")}` };
}

describe("live: usage and consent", () => {
  test("`live` alone prints its help and exits 64", () => {
    const r = cli("live");
    expect(r.code).toBe(64);
    expect(r.out).toContain("bend-iac live prepare");
  });

  test("init requires the exact consent and a well-formed account id", () => {
    const dir = path.join(scratch, `noconsent${n++}`);
    expect(cli("live", "init", dir, "--account", ACCOUNT).code).toBe(64);
    expect(cli("live", "init", dir, "--account", ACCOUNT, "--consent", "yes").code).toBe(64);
    expect(cli("live", "init", dir, "--account", "not-an-account", "--consent", CONSENT).code).toBe(
      64,
    );
    expect(fs.existsSync(path.join(dir, "ledger.json"))).toBe(false);
  });

  test("init writes a ledger with a 64-bit random run id and touches nothing remote", () => {
    const { dir, run } = runDir();
    expect(run).toMatch(/^[0-9a-f]{16}$/);
    const l = JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8"));
    expect(l).toMatchObject({
      kind: "bend-infra/live-ledger",
      account: ACCOUNT,
      environment: "e2e",
      consent: CONSENT,
      resources: {},
    });
    expect(runDir().run).not.toBe(run);
    noRemote(dir);
  });

  test("a run directory holds one run: a second init is refused", () => {
    const { dir } = runDir();
    const r = cli("live", "init", dir, "--account", ACCOUNT, "--consent", CONSENT);
    expect(r.code).toBe(5);
    expect(r.err).toContain("not empty");
  });

  test("every command checks the account against the ledger first", () => {
    const { dir, run } = runDir();
    const other = "ffffffffffffffffffffffffffffffff";
    expect(cli("live", "observe", dir, "--account", other).code).toBe(5);
    expect(cli("live", "cleanup", dir, "--account", other, "--confirm-run", run).code).toBe(5);
    expect(cli("live", "prepare", dir, specDir(desired([db()])), "--account", other).code).toBe(5);
    noRemote(dir);
  });

  test("cleanup needs this run's id, confirmed", () => {
    const { dir } = runDir();

    const r = cli(
      "live",
      "cleanup",
      dir,
      "--account",
      ACCOUNT,
      "--confirm-run",
      "0000000000000000",
    );

    expect(r.code).toBe(5);
    expect(r.err).toContain("nothing ran");
    noRemote(dir);
  });

  test("the live lane fails without its explicit opt-in, before creating anything", () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("BEND_INFRA_LIVE_")),
    );

    const before = fs.existsSync(path.join(ROOT, ".live"))
      ? fs.readdirSync(path.join(ROOT, ".live")).length
      : 0;

    const r = spawnSync("bun", ["scripts/test-live.ts"], { cwd: ROOT, env, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("test:live: FAILED: explicit opt-in required");

    const after = fs.existsSync(path.join(ROOT, ".live"))
      ? fs.readdirSync(path.join(ROOT, ".live")).length
      : 0;

    expect(after).toBe(before);
  });
});

describe("live prepare: the spec is checked before any remote read", () => {
  const refused = (code: number, d: Desired, files?: Record<string, string>, text?: string) => {
    const { dir } = runDir();
    const r = cli("live", "prepare", dir, specDir(d, files), "--account", ACCOUNT);
    expect(r.code).toBe(code);

    if (text) expect(r.err).toContain(text);
    noRemote(dir);
  };

  test("only the e2e environment", () =>
    refused(
      4,
      desired([db("prod-db", "production")], ["production"]),
      undefined,
      'environments must be exactly ["e2e"]',
    ));
  test("at most one database and one Worker", () =>
    refused(
      4,
      desired([db("a-db"), db("b-db")]),
      undefined,
      "at most one d1_database and one worker",
    ));
  test("logical ids short enough for a Cloudflare name", () =>
    refused(
      4,
      desired([db("a-very-long-logical-id-name")]),
      undefined,
      "becomes part of a Cloudflare name",
    ));
  test("a Worker's main is a .js file inside the spec directory", () =>
    refused(
      4,
      desired([wk("e2e-api", "../escape.js")]),
      undefined,
      "main must name a .js module file",
    ));
  test("a missing Worker source is a missing input", () =>
    refused(66, desired([wk("e2e-api", "absent.js")]), {}));
  test("invalid desired JSON is an input error", () =>
    refused(65, raw('{"version": 1, "version": 1}')));
  test("a missing spec directory is a missing input", () => {
    const { dir } = runDir();
    expect(cli("live", "prepare", dir, path.join(scratch, "nope"), "--account", ACCOUNT).code).toBe(
      66,
    );
    noRemote(dir);
  });
});

describe("live apply: the artifact is verified before any remote read", () => {
  test.each(["desired", "observed"])(
    "R2 in saved %s inputs is refused before any remote read",
    (snapshot) => {
      const { dir, run } = runDir();
      const resources = [{ type: "r2_bucket", id: "assets", environment: "e2e", protected: false }];

      const a = artifact(dir, run, {
        inputs: {
          desired: desired(snapshot === "desired" ? resources : []),
          observed: {
            version: 1,
            kind: "bend-infra/observed",
            source: "wrangler",
            resources: snapshot === "observed" ? resources : [],
          },
          grant: {
            version: 1,
            kind: "bend-infra/grant",
            environment: "e2e",
            allow: ["create", "delete"],
          },
          approvals: { version: 1, kind: "bend-infra/approvals", approvals: [] },
        },
      });

      const r = cli(
        "live",
        "apply",
        dir,
        "--account",
        ACCOUNT,
        "--artifact",
        a.file,
        "--digest",
        a.digest,
      );

      expect(r.code).toBe(4);
      expect(r.err).toContain("R2 execution is not supported");
      noRemote(dir);
    },
  );
  test("a digest that does not match the artifact bytes is refused", () => {
    const { dir, run } = runDir();
    const a = artifact(dir, run);

    const r = cli(
      "live",
      "apply",
      dir,
      "--account",
      ACCOUNT,
      "--artifact",
      a.file,
      "--digest",
      `sha256:${"0".repeat(64)}`,
    );

    expect(r.code).toBe(5);
    expect(r.err).toContain("not the expected sha256");
    noRemote(dir);
  });

  test("the digest is required and must be sha256", () => {
    const { dir, run } = runDir();
    const a = artifact(dir, run);
    expect(cli("live", "apply", dir, "--account", ACCOUNT, "--artifact", a.file).code).toBe(64);
    expect(
      cli("live", "apply", dir, "--account", ACCOUNT, "--artifact", a.file, "--digest", "md5:abc")
        .code,
    ).toBe(64);
    noRemote(dir);
  });

  test("an artifact of another run is refused", () => {
    const { dir } = runDir();
    const a = artifact(dir, "fedcba9876543210");

    const r = cli(
      "live",
      "apply",
      dir,
      "--account",
      ACCOUNT,
      "--artifact",
      a.file,
      "--digest",
      a.digest,
    );

    expect(r.code).toBe(5);
    expect(r.err).toContain("belongs to run fedcba9876543210");
    noRemote(dir);
  });

  test("an artifact naming another account is refused", () => {
    const { dir, run } = runDir();
    const a = artifact(dir, run, { account: "ffffffffffffffffffffffffffffffff" });
    expect(
      cli("live", "apply", dir, "--account", ACCOUNT, "--artifact", a.file, "--digest", a.digest)
        .code,
    ).toBe(5);
    noRemote(dir);
  });

  test("approval_required and rejected artifacts never run (exit 3 and 2)", () => {
    const { dir, run } = runDir();
    const p = artifact(dir, run, { outcome: "approval_required" });
    const r = artifact(dir, run, { outcome: "rejected" });
    expect(
      cli("live", "apply", dir, "--account", ACCOUNT, "--artifact", p.file, "--digest", p.digest)
        .code,
    ).toBe(3);
    expect(
      cli("live", "apply", dir, "--account", ACCOUNT, "--artifact", r.file, "--digest", r.digest)
        .code,
    ).toBe(2);
    noRemote(dir);
  });

  test("approved artifacts whose inputs the planner does not reproduce are refused", () => {
    const { dir, run } = runDir();

    const a = artifact(dir, run, {
      inputs: {
        desired: desired([db()]),
        observed: { version: 1, kind: "bend-infra/observed", source: "wrangler", resources: [] },
        grant: { version: 1, kind: "bend-infra/grant", environment: "e2e", allow: ["create"] },
        approvals: { version: 1, kind: "bend-infra/approvals", approvals: [] },
      },
      operations: [],
      problems: [],
    });

    const r = cli(
      "live",
      "apply",
      dir,
      "--account",
      ACCOUNT,
      "--artifact",
      a.file,
      "--digest",
      a.digest,
    );

    expect(r.code).toBe(5);
    expect(r.err).toContain("the planner build differs");
    // with the right planner build, the claimed (empty) operations are not
    // what the planner returns for these inputs (create the database)
    const engine = JSON.parse(fs.readFileSync(path.join(ROOT, ".build", "stamp.json"), "utf8"));
    const b = artifact(dir, run, { ...JSON.parse(fs.readFileSync(a.file, "utf8")), engine });

    const r2 = cli(
      "live",
      "apply",
      dir,
      "--account",
      ACCOUNT,
      "--artifact",
      b.file,
      "--digest",
      b.digest,
    );

    expect(r2.code).toBe(5);
    expect(r2.err).toContain("the planner does not return the artifact's operations");
    noRemote(dir);
  });

  // An artifact whose inputs, engine and operations are what the planner
  // returns, so apply reaches the fields it decodes after them.
  // The run owns the database as `prepare` registers it (declared, never
  // attempted), without any remote read.
  function reproducible(dir: string, run: string, patch: Record<string, JsonData>) {
    const ledgerFile = path.join(dir, "ledger.json");
    const l = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));

    l.resources = {
      "e2e-db": {
        type: "d1_database",
        logicalId: "e2e-db",
        name: `bend-infra-e2e-${run}-e2e-db`,
        status: "new",
        physicalId: null,
        history: [{ at: new Date().toISOString(), event: "declared" }],
      },
    };

    fs.writeFileSync(ledgerFile, JSON.stringify(l, null, 2) + "\n");

    const inputs = {
      desired: desired([db()]),
      observed: { version: 1, kind: "bend-infra/observed", source: "wrangler", resources: [] },
      grant: { version: 1, kind: "bend-infra/grant", environment: "e2e", allow: ["create"] },
      approvals: { version: 1, kind: "bend-infra/approvals", approvals: [] },
    };

    const docs = path.join(scratch, `docs${n++}`);
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, "desired.json"), JSON.stringify(inputs.desired));
    fs.writeFileSync(
      path.join(docs, "observed.json"),
      JSON.stringify({ ...inputs.observed, source: "fixture" }),
    );
    fs.writeFileSync(path.join(docs, "grant.json"), JSON.stringify(inputs.grant));
    const planned = cli("plan", docs, "--json");
    expect(planned.code).toBe(0);
    const engine = JSON.parse(fs.readFileSync(path.join(ROOT, ".build", "stamp.json"), "utf8"));

    return artifact(dir, run, {
      inputs,
      engine,
      operations: JSON.parse(planned.out).operations,
      problems: [],
      ...patch,
    });
  }

  const applyCode = (dir: string, a: { file: string; digest: string }) =>
    cli("live", "apply", dir, "--account", ACCOUNT, "--artifact", a.file, "--digest", a.digest);

  test("a recorded observation that is not the evidence apply wrote is refused", () => {
    const { dir, run } = runDir();

    for (const [observation, detail] of [
      [undefined, "artifact: observation: expected an array"],
      [{}, "artifact: observation: expected an array"],
      [[{ id: "e2e-db" }], 'artifact: observation[0]: missing required field "type"'],
      [
        [{ id: "e2e-db", type: "d1_database", name: "x", present: "yes" }],
        "artifact: observation[0].present: expected true or false",
      ],
      [
        [{ id: "e2e-db", type: "d1_database", name: "x", present: true, uuid: 7 }],
        "artifact: observation[0].uuid: expected a string",
      ],
      [
        [{ id: "e2e-db", type: "d1_database", name: "x", present: true, size: 1 }],
        'artifact: observation[0]: unknown field "size"',
      ],
    ] as const) {
      const r = applyCode(
        dir,
        reproducible(dir, run, observation === undefined ? {} : { observation }),
      );

      expect(r.code).toBe(5);
      expect(r.err).toContain(detail);
      expect(r.err).toContain("nothing ran");
    }

    noRemote(dir);
  });

  test("a well-formed recorded observation is accepted, and the payload is checked next", () => {
    const { dir, run } = runDir();
    const r = applyCode(dir, reproducible(dir, run, { observation: [] }));
    expect(r.code).toBe(5);
    expect(r.err).toContain("the artifact payload is not the one its inputs produce");
    noRemote(dir);
  });

  test("artifact inputs are exactly the four documents", () => {
    const { dir, run } = runDir();
    const a = reproducible(dir, run, {});
    const text = JSON.parse(fs.readFileSync(a.file, "utf8"));
    const b = artifact(dir, run, { ...text, inputs: { ...text.inputs, extra: {} } });
    const r = applyCode(dir, b);
    expect(r.code).toBe(5);
    expect(r.err).toContain('artifact inputs: artifact: inputs: unknown field "extra"');
    noRemote(dir);
  });

  test("an artifact that is not valid JSON is refused", () => {
    const { dir } = runDir();
    const file = path.join(scratch, `garbage${n++}.json`);
    fs.writeFileSync(file, "{not json");
    const digest = `sha256:${createHash("sha256").update("{not json").digest("hex")}`;
    expect(
      cli("live", "apply", dir, "--account", ACCOUNT, "--artifact", file, "--digest", digest).code,
    ).toBe(5);
    noRemote(dir);
  });
});
