// Public project planning with real state inputs. No npx exists in the
// child PATH, so registration can run but no provider observation can start.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BIN } from "./helpers";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const UUID = "11111111-1111-4111-8111-111111111111";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bend-r2-plan-"));
const tools = path.join(scratch, "tools");
const home = path.join(scratch, "home");

fs.mkdirSync(tools);

fs.mkdirSync(home);

fs.symlinkSync(process.execPath, path.join(tools, "bun"));

fs.symlinkSync("/bin/bash", path.join(tools, "bash"));

fs.symlinkSync("/usr/bin/dirname", path.join(tools, "dirname"));

process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync(BIN, args, { cwd, encoding: "utf8", env: { HOME: home, PATH: tools } });

  if (r.error) throw r.error;

  return { code: r.status, out: r.stdout, err: r.stderr };
}

function project() {
  const dir = path.join(scratch, `p${sequence++}`);

  const init = cli(
    scratch,
    "init",
    dir,
    "--project",
    "hello",
    "--env",
    "dev",
    "--account",
    ACCOUNT,
  );

  expect(init.code).toBe(0);
  const state = path.join(dir, ".bend-iac/dev");
  const file = path.join(state, "ledger.json");
  const ledger = JSON.parse(fs.readFileSync(file, "utf8"));

  expect(ledger.version).toBe(1);
  const name = (id: string) => `hello-dev-${id}-${ledger.run.slice(0, 8)}`;
  ledger.resources = {
    db: {
      type: "d1_database",
      logicalId: "db",
      name: name("db"),
      status: "created",
      physicalId: UUID,
      location: "weur",
      readReplication: "disabled",
      protected: true,
      history: [{ at: "2026-06-01T00:00:00Z", event: "created", detail: { uuid: UUID } }],
    },
    api: {
      type: "worker",
      logicalId: "api",
      name: name("api"),
      status: "created",
      physicalId: null,
      versionId: "owned-version",
      etag: "owned-etag",
      sourceSha256: "a".repeat(64),
      history: [
        { at: "2026-06-01T00:00:00Z", event: "created", detail: { versionId: "owned-version" } },
      ],
    },
  };
  fs.writeFileSync(file, JSON.stringify(ledger));
  const desiredFile = path.join(dir, "infra/dev/desired.json");
  const desired = JSON.parse(fs.readFileSync(desiredFile, "utf8"));
  desired.resources.push({ type: "r2_bucket", id: "files", environment: "dev", protected: false });
  desired.resources[1].bindings.push({ name: "FILES", bucket: "files" });
  fs.writeFileSync(desiredFile, JSON.stringify(desired));

  return { dir, state, file, ledger, desired, desiredFile, name };
}

function onlyVersion(state: string, count = 1) {
  const records = fs
    .readFileSync(path.join(state, "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));

  expect(records.filter((r) => r.phase === "start").map((r) => [r.purpose, r.mutating])).toEqual(
    Array.from({ length: count }, () => ["version", false]),
  );
  expect(records.every((r) => r.purpose === "version")).toBe(true);
  expect(records.filter((r) => r.phase === "spawned").every((r) => r.pid === null)).toBe(true);
  expect(fs.readdirSync(path.join(state, "work")).sort()).toEqual(
    Array.from({ length: count }, (_, i) => `${String(i + 1).padStart(3, "0")}-version`),
  );
  expect(fs.existsSync(path.join(state, "artifacts"))).toBe(false);
  expect(fs.existsSync(path.join(state, "lock"))).toBe(false);
}

test("project R2 plan: promotes v1 losslessly and registers a bucket before the guarded version child", () => {
  const p = project();
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(69);
  expect(r.err).toContain("npx");
  const after = JSON.parse(fs.readFileSync(p.file, "utf8"));
  expect(after).toEqual({
    ...p.ledger,
    version: 2,
    resources: {
      ...p.ledger.resources,
      files: {
        type: "r2_bucket",
        logicalId: "files",
        name: p.name("files"),
        status: "new",
        physicalId: null,
        protected: false,
        bucketCreated: null,
        history: after.resources.files.history,
      },
    },
  });
  expect(after.resources.files.history).toHaveLength(1);
  expect(after.resources.files.history[0].event).toBe("declared");
  onlyVersion(p.state);
});

test("project R2 plan: repeat registration preserves promoted bytes and a single owner history", () => {
  const p = project();
  const first = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(first.code).toBe(69);
  const promoted = fs.readFileSync(p.file, "utf8");
  const second = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(second.code).toBe(69);
  expect(fs.readFileSync(p.file, "utf8")).toBe(promoted);
  expect(JSON.parse(promoted).resources.files.history).toHaveLength(1);
  onlyVersion(p.state, 2);
});

function noProviderWork(p: ReturnType<typeof project>, before: string) {
  expect(fs.readFileSync(p.file, "utf8")).toBe(before);
  expect(fs.readdirSync(p.state)).toEqual(["ledger.json"]);
}

test("project R2 plan: registration never overwrites existing bucket protection or generation/history", () => {
  const p = project();
  p.ledger.version = 2;
  p.ledger.resources.files = {
    type: "r2_bucket",
    logicalId: "files",
    name: p.name("files"),
    status: "created",
    physicalId: null,
    protected: false,
    bucketCreated: "2026-06-01T00:00:00Z",
    history: [{ at: "2026-06-01T00:00:00Z", event: "created" }],
  };
  p.desired.resources[2].protected = true;
  fs.writeFileSync(p.desiredFile, JSON.stringify(p.desired));
  const before = JSON.stringify(p.ledger);
  fs.writeFileSync(p.file, before);
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(69);
  expect(r.err).toContain("npx");
  expect(fs.readFileSync(p.file, "utf8")).toBe(before);
  onlyVersion(p.state);
});

test("project D1 plan: no bucket declaration leaves v1 bytes untouched", () => {
  const p = project();
  p.desired.resources.pop();
  p.desired.resources[1].bindings.pop();
  fs.writeFileSync(p.desiredFile, JSON.stringify(p.desired));
  const before = fs.readFileSync(p.file, "utf8");
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(69);
  expect(fs.readFileSync(p.file, "utf8")).toBe(before);
  expect(JSON.parse(before).version).toBe(1);
  onlyVersion(p.state);
});

type Project = ReturnType<typeof project>;

const invalidSpecs: {
  label: string;
  change: (p: Project) => void;
  code: number;
  diagnostic: string;
}[] = [
  {
    label: "second bucket",
    change: (p) => {
      p.desired.resources.push({ ...p.desired.resources[2], id: "other" });
    },
    code: 4,
    diagnostic: "at most one r2_bucket",
  },
  {
    label: "second D1 binding",
    change: (p) => {
      p.desired.resources[1].bindings.push({ name: "DB2", database: "db" });
    },
    code: 4,
    diagnostic: "one binding per provider kind",
  },
  {
    label: "second R2 binding",
    change: (p) => {
      p.desired.resources[1].bindings.push({ name: "FILES2", bucket: "files" });
    },
    code: 4,
    diagnostic: "one binding per provider kind",
  },
  {
    label: "foreign bucket fields",
    change: (p) => {
      p.desired.resources[2].location = "weur";
    },
    code: 65,
    diagnostic: "location",
  },
  {
    label: "nonboolean protection",
    change: (p) => {
      p.desired.resources[2].protected = "true";
    },
    code: 65,
    diagnostic: "protected",
  },
  {
    label: "oversized logical id",
    change: (p) => {
      p.desired.resources[2].id = "x".repeat(21);
    },
    code: 4,
    diagnostic: "must match",
  },
  {
    label: "missing source",
    change: (p) => {
      p.desired.resources[1].main = "src/missing.js";
    },
    code: 66,
    diagnostic: "missing.js",
  },
  {
    label: "absolute source",
    change: (p) => {
      p.desired.resources[1].main = "/tmp/worker.js";
    },
    code: 4,
    diagnostic: "main must name",
  },
  {
    label: "oversized source",
    change: (p) => {
      fs.writeFileSync(path.join(p.dir, "src/worker.js"), "x".repeat((1 << 20) + 1));
    },
    code: 65,
    diagnostic: "larger than 1 MiB",
  },
];

for (const control of invalidSpecs)
  test(`project R2 plan: ${control.label} refuses before promotion or provider work`, () => {
    const p = project();
    const before = fs.readFileSync(p.file, "utf8");
    control.change(p);
    fs.writeFileSync(p.desiredFile, JSON.stringify(p.desired));
    const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
    expect(r.code).toBe(control.code);
    expect(r.err).toContain(control.diagnostic);
    noProviderWork(p, before);
  });

test("project R2 plan: held lock wins over corrupt state before registration", () => {
  const p = project();
  fs.writeFileSync(p.file, "{corrupt state");
  const held = path.join(p.state, "lock");
  fs.writeFileSync(held, "held by another command\n");
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(5);
  expect(r.err).toContain("holds this run");
  expect(fs.readFileSync(p.file, "utf8")).toBe("{corrupt state");
  expect(fs.readFileSync(held, "utf8")).toBe("held by another command\n");
  expect(fs.readdirSync(p.state).sort()).toEqual(["ledger.json", "lock"]);
});

test("project R2 plan: another account cannot promote state", () => {
  const p = project();
  const before = fs.readFileSync(p.file, "utf8");
  const r = cli(p.dir, "plan", "--env", "dev", "--account", "fedcba9876543210fedcba9876543210");
  expect(r.code).toBe(5);
  expect(r.err).toContain("does not match");
  noProviderWork(p, before);
});

test("project R2 plan: cross-kind logical ID conflict does not publish a partial promotion", () => {
  const p = project();
  p.ledger.resources.files = {
    type: "worker",
    logicalId: "files",
    name: p.name("files"),
    status: "new",
    physicalId: null,
    history: [],
  };
  const before = JSON.stringify(p.ledger);
  fs.writeFileSync(p.file, before);
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(4);
  expect(r.err).toContain('"files" is a worker');
  noProviderWork(p, before);
});

test("project R2 plan: a deleted bucket still reserves its lifetime logical ID", () => {
  const p = project();
  p.ledger.version = 2;
  p.ledger.resources.oldfiles = {
    type: "r2_bucket",
    logicalId: "oldfiles",
    name: p.name("oldfiles"),
    status: "deleted",
    physicalId: null,
    protected: true,
    bucketCreated: "2026-06-01T00:00:00Z",
    history: [],
  };
  const before = JSON.stringify(p.ledger);
  fs.writeFileSync(p.file, before);
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(4);
  expect(r.err).toContain('already has a r2_bucket ("oldfiles")');
  noProviderWork(p, before);
});
