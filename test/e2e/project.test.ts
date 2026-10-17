// The project workflow (init, plan --env, apply, destroy) through the public
// executable, in throwaway project directories. Every case here ends before
// any Cloudflare request: a refusal before the lock or under it (no
// journal.jsonl, no work directory), or, for the positive boundary checks,
// a PATH without npx, so the first Wrangler process cannot start. The
// account id is made up.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { errorCode } from "../../src/errors";
import { BIN, ROOT, type Run } from "./helpers";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const CONSENT = "create-and-delete-disposable-bend-infra-e2e-resources";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bend-iac-project-"));
const NO_NPX = fs.mkdtempSync(path.join(os.tmpdir(), "bend-iac-no-npx-"));

process.on("exit", () => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(NO_NPX, { recursive: true, force: true });
});

let n = 0;

// bin/bend-iac with the given working directory, as a user runs it there
function at(cwd: string, ...args: string[]): Run {
  const r = spawnSync(BIN, args, { cwd, encoding: "utf8" });

  if (r.error) throw r.error;

  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

// the CLI with a PATH holding no npx: Wrangler cannot start, so nothing
// remote can happen, and the command shows how far it got
function noNpx(cwd: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [path.join(ROOT, "src", "cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: NO_NPX, HOME: scratch },
  });

  if (r.error) throw r.error;

  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const read = (...p: string[]) => fs.readFileSync(path.join(...p), "utf8");
const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

const noRemote = (state: string) => {
  expect(fs.existsSync(path.join(state, "journal.jsonl"))).toBe(false);
  expect(fs.existsSync(path.join(state, "work"))).toBe(false);
  expect(fs.existsSync(path.join(state, "artifacts"))).toBe(false);
};

type Project = { dir: string; state: string; run: string };

// a freshly initialised project, environment dev
function project(name = "hello", env = "dev"): Project {
  const dir = path.join(scratch, `p${n++}`);
  const r = at(scratch, "init", dir, "--project", name, "--env", env, "--account", ACCOUNT);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  const state = path.join(dir, ".bend-iac", env);

  return { dir, state, run: JSON.parse(read(state, "ledger.json")).run };
}

// infra/<env>: the dev spec, retargeted at another environment
function specFor(p: Project, env: string) {
  const dir = path.join(p.dir, "infra", env);
  fs.mkdirSync(dir, { recursive: true });
  const des = JSON.parse(read(p.dir, "infra/dev/desired.json"));
  des.environments = [env];

  for (const x of des.resources) x.environment = env;
  fs.writeFileSync(path.join(dir, "desired.json"), JSON.stringify(des));
  const grant = JSON.parse(read(p.dir, "infra/dev/grant.json"));
  fs.writeFileSync(path.join(dir, "grant.json"), JSON.stringify({ ...grant, environment: env }));
}

const plan = (p: Project, ...extra: string[]) =>
  at(p.dir, "plan", "--env", "dev", "--account", ACCOUNT, ...extra);

describe("project: init", () => {
  test("scaffolds a Worker + D1 project and the environment's state, touching nothing remote", () => {
    const dir = path.join(scratch, `p${n++}`);
    const r = at(scratch, "init", dir, "--project", "hello", "--env", "dev", "--account", ACCOUNT);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing remote was touched.");
    expect(r.out).toContain(`Next: bend-iac plan --env dev --account ${ACCOUNT} --project ${dir}`);

    expect(JSON.parse(read(dir, "bend-iac.json"))).toEqual({
      version: 1,
      kind: "bend-iac/project",
      project: "hello",
      environments: { dev: { spec: "infra/dev" } },
    });
    const des = JSON.parse(read(dir, "infra/dev/desired.json"));
    expect(des.environments).toEqual(["dev"]);
    expect(des.resources.map((x: { id: string }) => x.id)).toEqual(["db", "api"]);
    expect(JSON.parse(read(dir, "infra/dev/grant.json")).environment).toBe("dev");
    expect(read(dir, "src/worker.js")).toContain("env.DB.prepare");

    // the account is in the state only, never in authored files
    for (const f of ["bend-iac.json", "infra/dev/desired.json", "infra/dev/grant.json"])
      expect(read(dir, f)).not.toContain(ACCOUNT);
    const state = path.join(dir, ".bend-iac", "dev");
    const l = JSON.parse(read(state, "ledger.json"));
    expect(Object.keys(l)).toEqual([
      "version",
      "kind",
      "project",
      "environment",
      "account",
      "run",
      "wrangler",
      "createdAt",
      "resources",
    ]);
    expect(l).toMatchObject({
      version: 1,
      kind: "bend-iac/project-state",
      project: "hello",
      environment: "dev",
      account: ACCOUNT,
      resources: {},
    });
    expect(l.run).toMatch(/^[0-9a-f]{16}$/);
    expect(r.out).toContain(`hello-dev-<logical-id>-${l.run.slice(0, 8)}`);
    noRemote(state);
  });

  test("the state directory is git-ignored", () => {
    const p = project();
    const g = spawnSync("git", ["init", "-q", p.dir]);
    expect(g.status).toBe(0);

    const ignored = spawnSync("git", ["check-ignore", "-q", ".bend-iac/dev/ledger.json"], {
      cwd: p.dir,
    });

    expect(ignored.status).toBe(0);

    const tracked = spawnSync("git", ["check-ignore", "-q", "bend-iac.json"], { cwd: p.dir });
    expect(tracked.status).toBe(1);
  });

  test("never overwrites: one existing scaffold file refuses the whole init", () => {
    const dir = path.join(scratch, `p${n++}`);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "worker.js"), "mine\n");
    const r = at(dir, "init", "--project", "hello", "--env", "dev", "--account", ACCOUNT);
    expect(r.code).toBe(5);
    expect(r.err).toContain("src/worker.js already exist; nothing was written");
    expect(read(dir, "src/worker.js")).toBe("mine\n");
    expect(fs.readdirSync(dir)).toEqual(["src"]);
  });

  test("an existing environment's state is never re-initialised", () => {
    const p = project();
    const before = sha(path.join(p.state, "ledger.json"));
    const r = at(p.dir, "init", "--project", "hello", "--env", "dev", "--account", OTHER);
    expect(r.code).toBe(5);
    expect(r.err).toContain("is never re-initialised");
    expect(sha(path.join(p.state, "ledger.json"))).toBe(before);
  });

  test("a declared environment of an existing project gets its own state; nothing else is written", () => {
    const p = project();
    const m = JSON.parse(read(p.dir, "bend-iac.json"));
    m.environments.staging = { spec: "infra/staging" };
    fs.writeFileSync(path.join(p.dir, "bend-iac.json"), JSON.stringify(m));
    const before = read(p.dir, "bend-iac.json");
    const r = at(p.dir, "init", "--project", "hello", "--env", "staging", "--account", ACCOUNT);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("created ");
    expect(read(p.dir, "bend-iac.json")).toBe(before);
    const l = JSON.parse(read(p.dir, ".bend-iac", "staging", "ledger.json"));
    expect(l.environment).toBe("staging");
    expect(l.run).not.toBe(p.run);
  });

  test("an undeclared environment or another project name is refused", () => {
    const p = project();

    const undeclared = at(
      p.dir,
      "init",
      "--project",
      "hello",
      "--env",
      "prod",
      "--account",
      ACCOUNT,
    );

    expect(undeclared.code).toBe(5);
    expect(undeclared.err).toContain("environment prod is not declared in bend-iac.json");

    const other = at(p.dir, "init", "--project", "other", "--env", "dev", "--account", ACCOUNT);
    expect(other.code).toBe(5);
    expect(other.err).toContain("bend-iac.json names project hello, not other");
    expect(fs.readdirSync(path.join(p.dir, ".bend-iac")).sort()).toEqual([".gitignore", "dev"]);
  });

  test("project, environment and account inputs are explicit and well-formed", () => {
    const dir = path.join(scratch, `p${n++}`);
    const ok = ["--project", "hello", "--env", "dev", "--account", ACCOUNT];

    for (const args of [
      ["--project", "hello", "--env", "dev"],
      ["--project", "Hello", "--env", "dev", "--account", ACCOUNT],
      ["--project", "hello", "--env", "dev-1", "--account", ACCOUNT],
      ["--project", "hello", "--env", "development", "--account", ACCOUNT],
      ["--project", "hello", "--env", "dev", "--account", "123"],
      [...ok, "--consent", CONSENT],
    ]) {
      const r = at(scratch, "init", dir, ...args);
      expect(r.code).toBe(64);
    }

    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("project: plan dispatch", () => {
  test("--env selects the project; without it plan is fixture planning, unchanged", () => {
    const p = project();
    const fixture = at(p.dir, "plan", path.join(ROOT, "examples", "01-create"), "--json");
    expect(fixture.code).toBe(0);
    expect(JSON.parse(fixture.out).outcome).toBe("approved");

    // a project directory is not a fixture: no --env, no project mode
    const bare = at(p.dir, "plan");
    expect(bare.code).toBe(64);
    expect(bare.err).toContain("missing --desired (or a <dir>)");
    noRemote(p.state);
  });

  test("--env with a fixture directory or fixture flags is ambiguous", () => {
    const p = project();
    const withDir = plan(p, path.join(ROOT, "examples", "01-create"));
    expect(withDir.code).toBe(64);
    expect(withDir.err).toContain("plan --env takes no positional argument");

    const withFlag = plan(p, "--desired", path.join(ROOT, "examples", "01-create", "desired.json"));

    expect(withFlag.code).toBe(64);
    expect(withFlag.err).toContain("unknown option --desired");
    noRemote(p.state);
  });

  test("the manifest is ./bend-iac.json or --project <dir>/bend-iac.json, nothing else", () => {
    const p = project();
    const elsewhere = at(scratch, "plan", "--env", "dev", "--account", ACCOUNT);
    expect(elsewhere.code).toBe(66);
    expect(elsewhere.err).toContain("bend-iac.json: ENOENT");

    const nested = path.join(p.dir, "src");
    expect(at(nested, "plan", "--env", "dev", "--account", ACCOUNT).code).toBe(66);
    noRemote(p.state);
  });
});

describe("project: plan refusals before anything remote", () => {
  test("an environment without state is refused, never initialised implicitly", () => {
    const p = project();
    fs.rmSync(p.state, { recursive: true });
    const r = plan(p);
    expect(r.code).toBe(5);
    expect(r.err).toContain(
      "no state for environment dev (.bend-iac/dev); create it with bend-iac init --env dev --account <id>",
    );
    expect(fs.existsSync(p.state)).toBe(false);
  });

  test("an undeclared environment is refused", () => {
    const p = project();
    const r = at(p.dir, "plan", "--env", "staging", "--account", ACCOUNT);
    expect(r.code).toBe(5);
    expect(r.err).toContain("environment staging is not declared in bend-iac.json");
  });

  test("another account is refused under the lock", () => {
    const p = project();
    const r = at(p.dir, "plan", "--env", "dev", "--account", OTHER);
    expect(r.code).toBe(5);
    expect(r.err).toContain("--account does not match the run's account");
    expect(fs.existsSync(path.join(p.state, "lock"))).toBe(false);
    noRemote(p.state);
  });

  test("renaming the project in the manifest does not start a new namespace", () => {
    const p = project();
    const m = JSON.parse(read(p.dir, "bend-iac.json"));
    fs.writeFileSync(
      path.join(p.dir, "bend-iac.json"),
      JSON.stringify({ ...m, project: "renamed" }),
    );
    const r = plan(p);
    expect(r.code).toBe(5);
    expect(r.err).toContain("state belongs to project hello, but bend-iac.json names renamed");
    noRemote(p.state);
  });

  test("one environment's state copied into another's is refused", () => {
    const p = project();
    const m = JSON.parse(read(p.dir, "bend-iac.json"));
    m.environments.staging = { spec: "infra/staging" };
    fs.writeFileSync(path.join(p.dir, "bend-iac.json"), JSON.stringify(m));
    specFor(p, "staging");
    const staging = path.join(p.dir, ".bend-iac", "staging");
    fs.cpSync(p.state, staging, { recursive: true });
    const r = at(p.dir, "plan", "--env", "staging", "--account", ACCOUNT);
    expect(r.code).toBe(5);
    expect(r.err).toContain("state belongs to environment dev, not staging");
    noRemote(staging);
  });

  test("a disposable live run is not a project state, and a project state is not a live run", () => {
    const p = project();
    const runDir = path.join(scratch, `run${n++}`);

    expect(
      at(scratch, "live", "init", runDir, "--account", ACCOUNT, "--consent", CONSENT).code,
    ).toBe(0);

    fs.rmSync(p.state, { recursive: true });
    fs.cpSync(runDir, p.state, { recursive: true });
    const asProject = plan(p);
    expect(asProject.code).toBe(5);
    expect(asProject.err).toContain("is not a project environment's state");

    const q = project();
    const asLive = at(scratch, "live", "observe", q.state, "--account", ACCOUNT);
    expect(asLive.code).toBe(5);
    expect(asLive.err).toContain("this is a project environment's state, not a live run");
    noRemote(q.state);
  });

  test("the spec must name exactly its environment", () => {
    const p = project();
    specFor(p, "staging");
    const m = JSON.parse(read(p.dir, "bend-iac.json"));
    m.environments.dev = { spec: "infra/staging" };
    fs.writeFileSync(path.join(p.dir, "bend-iac.json"), JSON.stringify(m));
    const r = plan(p);
    expect(r.code).toBe(4);
    expect(r.err).toContain('desired.environments must be exactly ["dev"]');
    noRemote(p.state);
  });

  test("a Worker main outside the project is refused", () => {
    const p = project();
    const f = path.join(p.dir, "infra/dev/desired.json");

    for (const main of ["../worker.js", "/tmp/worker.js", "src/../../worker.js", "src/worker.ts"]) {
      const des = JSON.parse(fs.readFileSync(f, "utf8"));
      des.resources[1].main = main;
      fs.writeFileSync(f, JSON.stringify(des));
      const r = plan(p);
      expect(r.code).toBe(4);
      expect(r.err).toContain("main must name a .js module path inside the project");
    }

    noRemote(p.state);
  });

  test("the manifest is strict: duplicate keys, unknown fields, bad paths and bad bytes", () => {
    const p = project();
    const file = path.join(p.dir, "bend-iac.json");
    const env = '"environments": { "dev": { "spec": "infra/dev" } }';

    for (const [text, where] of [
      [
        `{ "version": 1, "kind": "bend-iac/project", "project": "hello", "project": "x", ${env} }`,
        "duplicate",
      ],
      [
        `{ "version": 1, "kind": "bend-iac/project", "project": "hello", "account": "${ACCOUNT}", ${env} }`,
        "account",
      ],
      [`{ "version": 2, "kind": "bend-iac/project", "project": "hello", ${env} }`, "version"],
      [
        '{ "version": 1, "kind": "bend-iac/project", "project": "hello", "environments": { "dev": { "spec": "../dev" } } }',
        "spec",
      ],
      [
        '{ "version": 1, "kind": "bend-iac/project", "project": "hello", "environments": {} }',
        "environments",
      ],
      [
        '{ "version": 1, "kind": "bend-iac/project", "project": "hello", "environments": { "Dev": { "spec": "infra/dev" } } }',
        "environments.Dev",
      ],
    ]) {
      fs.writeFileSync(file, text);
      const r = at(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
      expect(r.code).toBe(65);
      expect(r.err).toContain("manifest:");
      expect(r.err).toContain(where);
    }

    fs.writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    const bytes = plan(p);
    expect(bytes.code).toBe(65);
    expect(bytes.err).toContain("not valid UTF-8");
    noRemote(p.state);
  });

  test("a held lock refuses before the state is read", () => {
    const p = project();
    fs.writeFileSync(path.join(p.state, "ledger.json"), "{ not a ledger");
    fs.writeFileSync(path.join(p.state, "lock"), '{"pid":1}\n');
    const r = plan(p);
    expect(r.code).toBe(5);
    expect(r.err).toContain("another bend-infra live command holds this run");
    expect(read(p.state, "lock")).toBe('{"pid":1}\n');
    noRemote(p.state);
  });
});

describe("project: the remote boundary", () => {
  test("plan reaches Wrangler only after every local check, with stable physical names", () => {
    const p = project();

    for (let i = 0; i < 2; i++) {
      const r = noNpx(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
      expect(r.code).toBe(69);
      expect(r.out).toBe("");
      expect(r.err).toContain("wrangler --version");
      const l = JSON.parse(read(p.state, "ledger.json"));
      const suffix = p.run.slice(0, 8);
      expect(l.resources.db.name).toBe(`hello-dev-db-${suffix}`);
      expect(l.resources.api.name).toBe(`hello-dev-api-${suffix}`);
      expect(l.resources.db.status).toBe("new");

      // the only command ever started was the version check
      const starts = read(p.state, "journal.jsonl")
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x))
        .filter((x) => x.phase === "start");

      expect(starts.map((x) => x.purpose)).toEqual(i === 0 ? ["version"] : ["version", "version"]);
      expect(fs.existsSync(path.join(p.state, "artifacts"))).toBe(false);
      expect(fs.existsSync(path.join(p.state, "lock"))).toBe(false);
    }
  });

  test("destroy reaches Wrangler only after its confirmation", () => {
    const p = project();

    const r = noNpx(
      p.dir,
      "destroy",
      "--env",
      "dev",
      "--account",
      ACCOUNT,
      "--confirm",
      "hello/dev",
    );

    expect(r.code).toBe(69);
    expect(r.out).toBe("");
    expect(fs.existsSync(path.join(p.state, "artifacts"))).toBe(false);
  });
});

describe("project: apply refusals", () => {
  test("the digest is always explicit", () => {
    const p = project();
    const r = at(p.dir, "apply", "--env", "dev", "--account", ACCOUNT);
    expect(r.code).toBe(64);
    expect(r.err).toContain("missing --digest");
  });

  test("without --artifact, the newest plan artifact is required to exist", () => {
    const p = project();

    const r = at(
      p.dir,
      "apply",
      "--env",
      "dev",
      "--account",
      ACCOUNT,
      "--digest",
      `sha256:${"0".repeat(64)}`,
    );

    expect(r.code).toBe(5);
    expect(r.err).toContain("holds no plan artifact");
    noRemote(p.state);
  });

  // an artifact file as written, with its digest
  function artifact(dir: string, fields: Record<string, string | number>): string[] {
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    const file = path.join(dir, "artifacts", "001-plan-approved.json");
    const text = JSON.stringify(fields, null, 2) + "\n";
    fs.writeFileSync(file, text);

    return [file, `sha256:${createHash("sha256").update(text).digest("hex")}`];
  }

  test("the newest artifact must have the caller's digest", () => {
    const p = project();
    artifact(p.state, { version: 1 });

    const r = at(
      p.dir,
      "apply",
      "--env",
      "dev",
      "--account",
      ACCOUNT,
      "--digest",
      `sha256:${"0".repeat(64)}`,
    );

    expect(r.code).toBe(5);
    expect(r.err).toContain(`not the expected sha256:${"0".repeat(64)}; nothing ran`);
    expect(fs.existsSync(path.join(p.state, "journal.jsonl"))).toBe(false);
  });

  test("a disposable run's artifact, another project's or another environment's is refused", () => {
    const p = project();
    const l = JSON.parse(read(p.state, "ledger.json"));
    const base = { version: 1, purpose: "plan", run: l.run, account: ACCOUNT, environment: "dev" };

    for (const [fields, why] of [
      [{ ...base, kind: "bend-infra/live-artifact" }, "not a bend-infra live plan artifact"],
      [
        {
          version: 1,
          kind: "bend-iac/project-artifact",
          project: "other",
          purpose: "plan",
          run: l.run,
          account: ACCOUNT,
          environment: "dev",
        },
        "belongs to project other, not hello",
      ],
      [
        {
          version: 1,
          kind: "bend-iac/project-artifact",
          project: "hello",
          purpose: "plan",
          run: l.run,
          account: ACCOUNT,
          environment: "staging",
        },
        "environment or Wrangler pin differs",
      ],
      [
        {
          version: 1,
          kind: "bend-iac/project-artifact",
          project: "hello",
          purpose: "plan",
          run: "0".repeat(16),
          account: ACCOUNT,
          environment: "dev",
        },
        "belongs to run 0000000000000000",
      ],
    ] as const) {
      const [file, digest] = artifact(path.join(scratch, `a${n++}`), fields);

      const r = at(
        p.dir,
        "apply",
        "--env",
        "dev",
        "--account",
        ACCOUNT,
        "--artifact",
        file,
        "--digest",
        digest,
      );

      expect(r.code).toBe(5);
      expect(r.err).toContain(why);
    }

    noRemote(p.state);
  });
});

describe("project: destroy refusals", () => {
  const destroy = (p: Project, ...extra: string[]) =>
    at(p.dir, "destroy", "--env", "dev", "--account", ACCOUNT, ...extra);

  test("--confirm must name exactly <project>/<environment>", () => {
    const p = project();
    expect(destroy(p).code).toBe(64);

    for (const c of ["hello", "dev", "hello/staging", "other/dev", p.run]) {
      const r = destroy(p, "--confirm", c);
      expect(r.code).toBe(5);
      expect(r.err).toContain("--confirm must be exactly hello/dev; nothing ran");
    }

    noRemote(p.state);
  });

  test("another account is refused", () => {
    const p = project();
    const r = at(p.dir, "destroy", "--env", "dev", "--account", OTHER, "--confirm", "hello/dev");
    expect(r.code).toBe(5);
    noRemote(p.state);
  });

  test("approvals are the strict approvals document, for this environment", () => {
    const p = project();
    const f = path.join(scratch, `approvals${n++}.json`);

    fs.writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        kind: "bend-infra/approvals",
        approvals: [
          {
            action: "delete",
            resource: "db",
            environment: "staging",
            approvedBy: "me",
            reason: "x",
          },
        ],
      }),
    );

    const r = destroy(p, "--confirm", "hello/dev", "--approvals", f);
    expect(r.code).toBe(65);
    expect(r.err).toContain("approvals:");
    noRemote(p.state);
  });

  test("a held lock refuses", () => {
    const p = project();
    fs.writeFileSync(path.join(p.state, "lock"), '{"pid":1}\n');
    const r = destroy(p, "--confirm", "hello/dev");
    expect(r.code).toBe(5);
    expect(r.err).toContain("holds this run");
    noRemote(p.state);
  });
});

describe("project: the environment lock, in concurrent processes", () => {
  test("apply selects and reads the newest artifact inside the lock; plan, apply and destroy meanwhile are refused and change nothing", async () => {
    const p = project();
    // no Wrangler may start even on a regression: the adapter refuses a
    // work directory holding an env file before spawning anything
    fs.mkdirSync(path.join(p.state, "work", "001-version"), { recursive: true });
    fs.writeFileSync(path.join(p.state, "work", "001-version", ".env"), "");
    fs.mkdirSync(path.join(p.state, "artifacts"));
    const newest = path.join(p.state, "artifacts", "002-plan-approved.json");
    fs.writeFileSync(path.join(p.state, "artifacts", "001-plan-approved.json"), "{}\n");
    expect(spawnSync("mkfifo", [newest]).status).toBe(0);
    const ledgerBefore = fs.readFileSync(path.join(p.state, "ledger.json"));

    const a = spawn(
      BIN,
      ["apply", "--env", "dev", "--account", ACCOUNT, "--digest", `sha256:${"0".repeat(64)}`],
      {
        cwd: p.dir,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let err = "";
    a.stderr!.on("data", (d) => (err += d));
    const done = new Promise<number | null>((r) => a.on("close", (code) => r(code)));

    try {
      let fd = -1;

      for (const t0 = Date.now(); fd < 0 && Date.now() - t0 < 20_000; await Bun.sleep(25)) {
        try {
          fd = fs.openSync(newest, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        } catch (e) {
          if (errorCode(e) !== "ENXIO") throw e;
        }
      }

      expect(fd).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(read(p.state, "lock")).pid).toBe(a.pid);

      for (const args of [
        ["plan", "--env", "dev", "--account", ACCOUNT],
        ["apply", "--env", "dev", "--account", ACCOUNT, "--digest", `sha256:${"0".repeat(64)}`],
        ["destroy", "--env", "dev", "--account", ACCOUNT, "--confirm", "hello/dev"],
      ]) {
        const b = at(p.dir, ...args);
        expect(b.code).toBe(5);
        expect(b.err).toContain("exists: another bend-infra live command holds this run");
      }

      fs.writeSync(fd, Buffer.from("{}\n"));
      fs.closeSync(fd);
      expect(await done).toBe(5);
      expect(err).toContain("not the expected sha256");
    } finally {
      if (a.exitCode === null) a.kill("SIGKILL");
    }

    expect(fs.existsSync(path.join(p.state, "lock"))).toBe(false);
    expect(fs.readFileSync(path.join(p.state, "ledger.json"))).toEqual(ledgerBefore);
    expect(fs.existsSync(path.join(p.state, "journal.jsonl"))).toBe(false);
    expect(fs.readdirSync(path.join(p.state, "work"))).toEqual(["001-version"]);
  }, 60_000);
});

// Recorded local state/artifact inputs, NOT provider evidence. The public
// apply command reruns the real Bend planner, then checks adapter support.
// An intentionally wrong payload stops it before any Wrangler invocation.
describe("project: recreating the same logical resource", () => {
  test("a confirmed deleted Worker can be planned again while its database identity stays intact", () => {
    const p = project();
    const ledger = JSON.parse(read(p.state, "ledger.json"));
    const suffix = p.run.slice(0, 8);
    const uuid = "11111111-1111-4111-8111-111111111111";
    const des = JSON.parse(read(p.dir, "infra/dev/desired.json"));
    const source = read(p.dir, "src/worker.js");
    const digest = createHash("sha256").update(source).digest("hex");
    des.resources[1].main = `sha256:${digest}`;
    const db = des.resources[0];
    ledger.resources = {
      db: {
        type: "d1_database",
        logicalId: "db",
        name: `hello-dev-db-${suffix}`,
        status: "created",
        physicalId: uuid,
        location: "weur",
        readReplication: "disabled",
        protected: true,
        history: [{ at: "2026-01-01T00:00:00Z", event: "created" }],
      },
      api: {
        type: "worker",
        logicalId: "api",
        name: `hello-dev-api-${suffix}`,
        status: "deleted",
        physicalId: null,
        versionId: "old-version",
        sourceSha256: "old-source",
        history: [{ at: "2026-01-01T00:00:00Z", event: "deleted" }],
      },
    };
    fs.writeFileSync(path.join(p.state, "ledger.json"), JSON.stringify(ledger));
    const before = read(p.state, "ledger.json");
    const inputs = path.join(scratch, `inputs${n++}`);
    fs.mkdirSync(inputs);
    fs.writeFileSync(path.join(inputs, "desired.json"), JSON.stringify(des));
    fs.writeFileSync(
      path.join(inputs, "observed.json"),
      JSON.stringify({
        version: 1,
        kind: "bend-infra/observed",
        source: "fixture",
        resources: [db],
      }),
    );
    const grant = JSON.parse(read(p.dir, "infra/dev/grant.json"));
    fs.writeFileSync(path.join(inputs, "grant.json"), JSON.stringify(grant));
    const planned = at(p.dir, "plan", inputs, "--json");
    expect(planned.code).toBe(0);
    const rep = JSON.parse(planned.out);
    expect(rep.operations.map((o: { action: string; id: string }) => [o.action, o.id])).toEqual([
      ["create", "api"],
    ]);
    fs.mkdirSync(path.join(p.state, "sources"));
    fs.writeFileSync(path.join(p.state, "sources", `${digest}.js`), source);
    const artifact = path.join(inputs, "artifact.json");

    const text = JSON.stringify({
      version: 1,
      kind: "bend-iac/project-artifact",
      project: "hello",
      purpose: "plan",
      run: p.run,
      account: ACCOUNT,
      environment: "dev",
      wrangler: ["npx", "--yes", "wrangler@4.151.1"],
      engine: JSON.parse(read(ROOT, ".build/stamp.json")),
      outcome: "approved",
      operations: rep.operations,
      problems: rep.problems,
      inputs: {
        desired: des,
        observed: { version: 1, kind: "bend-infra/observed", source: "wrangler", resources: [db] },
        grant,
        approvals: { version: 1, kind: "bend-infra/approvals", approvals: [] },
      },
      observation: [
        { id: "db", type: "d1_database", name: ledger.resources.db.name, present: true, uuid },
        { id: "api", type: "worker", name: ledger.resources.api.name, present: false },
      ],
      source: {
        file: "src/worker.js",
        path: path.join(p.dir, "src/worker.js"),
        sha256: digest,
        bytes: Buffer.byteLength(source),
        stored: `sources/${digest}.js`,
      },
      payload: [],
    });

    fs.writeFileSync(artifact, text);

    const r = noNpx(
      p.dir,
      "apply",
      "--env",
      "dev",
      "--account",
      ACCOUNT,
      "--artifact",
      artifact,
      "--digest",
      `sha256:${createHash("sha256").update(text).digest("hex")}`,
    );

    expect(r.code).toBe(5);
    expect(r.err).toContain("artifact payload is not the one its inputs produce");
    expect(read(p.state, "ledger.json")).toBe(before);
    expect(fs.existsSync(path.join(p.state, "journal.jsonl"))).toBe(false);

    // Neither uncertain generations nor a conflict can use the deleted
    // generation allowance, even if an artifact records absence.
    for (const status of ["unknown", "creating", "deleting", "conflict"]) {
      ledger.resources.api.status = status;
      fs.writeFileSync(path.join(p.state, "ledger.json"), JSON.stringify(ledger));

      const blocked = noNpx(
        p.dir,
        "apply",
        "--env",
        "dev",
        "--account",
        ACCOUNT,
        "--artifact",
        artifact,
        "--digest",
        `sha256:${createHash("sha256").update(text).digest("hex")}`,
      );

      expect(blocked.code).toBe(4);
      expect(blocked.err).toContain(`ledger status is ${status}`);
    }

    ledger.resources.api.status = "deleted";
    fs.writeFileSync(path.join(p.state, "ledger.json"), JSON.stringify(ledger));

    for (const present of [true, null]) {
      const recorded = JSON.parse(text);
      recorded.observation =
        present === null
          ? recorded.observation.filter((e: { id: string }) => e.id !== "api")
          : recorded.observation.map((e: { id: string }) =>
              e.id === "api" ? { ...e, present } : e,
            );
      const recordedText = JSON.stringify(recorded);
      fs.writeFileSync(artifact, recordedText);

      const blocked = noNpx(
        p.dir,
        "apply",
        "--env",
        "dev",
        "--account",
        ACCOUNT,
        "--artifact",
        artifact,
        "--digest",
        `sha256:${createHash("sha256").update(recordedText).digest("hex")}`,
      );

      expect(blocked.code).toBe(4);
      expect(blocked.err).toContain(
        present === true ? "already present remotely" : "ledger status is deleted",
      );
    }

    // Full teardown is reusable too: both tombstones remain in the same
    // state, with the same exact names and history. The real planner
    // orders the D1 create before the Worker create.
    ledger.resources.api.status = "deleted";
    ledger.resources.db.status = "deleted";
    fs.writeFileSync(path.join(p.state, "ledger.json"), JSON.stringify(ledger));
    fs.writeFileSync(
      path.join(inputs, "observed.json"),
      JSON.stringify({ version: 1, kind: "bend-infra/observed", source: "fixture", resources: [] }),
    );
    const fullPlan = at(p.dir, "plan", inputs, "--json");
    expect(fullPlan.code).toBe(0);
    const fullRep = JSON.parse(fullPlan.out);
    expect(fullRep.operations.map((o: { action: string; id: string }) => [o.action, o.id])).toEqual(
      [
        ["create", "db"],
        ["create", "api"],
      ],
    );
    const full = JSON.parse(text);
    full.operations = fullRep.operations;
    full.problems = fullRep.problems;
    full.inputs.observed.resources = [];
    full.observation = full.observation.map((e: { id: string; type: string; name: string }) => ({
      id: e.id,
      type: e.type,
      name: e.name,
      present: false,
    }));
    const fullText = JSON.stringify(full);
    fs.writeFileSync(artifact, fullText);

    const fullResult = noNpx(
      p.dir,
      "apply",
      "--env",
      "dev",
      "--account",
      ACCOUNT,
      "--artifact",
      artifact,
      "--digest",
      `sha256:${createHash("sha256").update(fullText).digest("hex")}`,
    );

    expect(fullResult.code).toBe(5);
    expect(fullResult.err).toContain("artifact payload is not the one its inputs produce");
    expect(fs.existsSync(path.join(p.state, "journal.jsonl"))).toBe(false);
  });
});

describe("project: exclusive initialization", () => {
  test("competing public initializers publish one identity, never replace it", async () => {
    const p = project();
    fs.rmSync(p.state, { recursive: true });

    const results = await Promise.all(
      Array.from(
        { length: 12 },
        (_, i) =>
          new Promise<Run>((resolve, reject) => {
            const child = spawn(
              BIN,
              [
                "init",
                "--project",
                "hello",
                "--env",
                "dev",
                "--account",
                i % 2 === 0 ? ACCOUNT : OTHER,
                "--json",
              ],
              { cwd: p.dir, stdio: ["ignore", "pipe", "pipe"] },
            );

            let out = "";
            let err = "";
            child.stdout!.on("data", (d) => (out += d));
            child.stderr!.on("data", (d) => (err += d));
            child.on("error", reject);
            child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
          }),
      ),
    );

    const winners = results.filter((r) => r.code === 0);
    expect(winners.length).toBe(1);
    expect(results.filter((r) => r.code === 5).length).toBe(11);
    const l = JSON.parse(read(p.state, "ledger.json"));
    const winner = JSON.parse(winners[0].out);
    expect(l.account).toBe(winner.account);
    expect(winner.names).toBe(`hello-dev-<logical-id>-${l.run.slice(0, 8)}`);
    const before = read(p.state, "ledger.json");
    fs.writeFileSync(path.join(p.state, "lock"), '{"pid":1}\n');
    expect(at(p.dir, "init", "--project", "hello", "--env", "dev", "--account", OTHER).code).toBe(
      5,
    );
    expect(read(p.state, "ledger.json")).toBe(before);
    expect(read(p.state, "lock")).toBe('{"pid":1}\n');
    expect(fs.existsSync(path.join(p.state, "journal.jsonl"))).toBe(false);
  }, 30_000);

  test("an empty or partially initialized environment directory is never adopted", () => {
    const p = project();
    fs.rmSync(p.state, { recursive: true });
    fs.mkdirSync(p.state);
    const args = ["init", "--project", "hello", "--env", "dev", "--account", ACCOUNT];
    expect(at(p.dir, ...args).code).toBe(5);
    expect(fs.readdirSync(p.state)).toEqual([]);
    fs.writeFileSync(path.join(p.state, "ledger.123.tmp"), "partial\n");
    expect(at(p.dir, ...args).code).toBe(5);
    expect(fs.readdirSync(p.state)).toEqual(["ledger.123.tmp"]);
    expect(read(p.state, "ledger.123.tmp")).toBe("partial\n");
  });
});

describe("project: logical identity remains fixed", () => {
  test("a tombstone does not enable a different logical id or lose another resource's ownership", () => {
    const p = project();
    const l = JSON.parse(read(p.state, "ledger.json"));
    l.resources.api = {
      type: "worker",
      logicalId: "api",
      name: `hello-dev-api-${p.run.slice(0, 8)}`,
      status: "deleted",
      physicalId: null,
      history: [{ at: "2026-01-01T00:00:00Z", event: "deleted" }],
    };
    fs.writeFileSync(path.join(p.state, "ledger.json"), JSON.stringify(l));
    const des = JSON.parse(read(p.dir, "infra/dev/desired.json"));
    des.resources[1].id = "renamed";
    fs.writeFileSync(path.join(p.dir, "infra/dev/desired.json"), JSON.stringify(des));
    const r = noNpx(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
    expect(r.code).toBe(4);
    expect(r.err).toContain('already has a worker ("api")');
    const after = JSON.parse(read(p.state, "ledger.json"));
    expect(after.resources.api).toEqual(l.resources.api);
    expect(after.resources.renamed).toBeUndefined();
    expect(fs.existsSync(path.join(p.state, "journal.jsonl"))).toBe(false);
  });
});
