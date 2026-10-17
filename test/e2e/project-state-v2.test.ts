// Recorded project state through the public CLI. Every invocation has a
// scratch HOME and a PATH with genuine local tools, but no npx.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BIN } from "./helpers";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bend-state-v2-"));
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
  const r = spawnSync(BIN, args, {
    cwd,
    encoding: "utf8",
    env: { HOME: home, PATH: tools },
  });

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
  const state = path.join(dir, ".bend-iac", "dev");
  const file = path.join(state, "ledger.json");
  const ledger = JSON.parse(fs.readFileSync(file, "utf8"));

  expect(ledger.version).toBe(1);

  const bucket = {
    type: "r2_bucket",
    logicalId: "files",
    name: `hello-dev-files-${ledger.run.slice(0, 8)}`,
    status: "created",
    physicalId: null,
    protected: true,
    bucketCreated: "2026-06-01T12:30:00.000Z",
    history: [],
  };

  return { dir, state, file, ledger, bucket };
}

function unchanged(p: ReturnType<typeof project>, before: string) {
  expect(fs.readFileSync(p.file, "utf8")).toBe(before);
  expect(fs.readdirSync(p.state)).toEqual(["ledger.json"]);
}

function registeredAtVersion(p: ReturnType<typeof project>, before: string) {
  const prior = JSON.parse(before);
  const after = JSON.parse(fs.readFileSync(p.file, "utf8"));
  expect({ ...after, resources: prior.resources }).toEqual(prior);
  expect(after.resources.files).toEqual(prior.resources.files);

  for (const [id, type] of [
    ["db", "d1_database"],
    ["api", "worker"],
  ]) {
    expect(after.resources[id]).toMatchObject({
      type,
      logicalId: id,
      name: `hello-dev-${id}-${prior.run.slice(0, 8)}`,
      status: "new",
      physicalId: null,
    });
    expect(after.resources[id].history).toHaveLength(1);
    expect(after.resources[id].history[0].event).toBe("declared");
  }

  versionOnly(p.state);
}

function versionOnly(state: string) {
  const journal = fs
    .readFileSync(path.join(state, "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));

  expect(journal.filter((r) => r.phase === "start").map((r) => [r.purpose, r.mutating])).toEqual([
    ["version", false],
  ]);
  expect(journal.every((r) => r.purpose === "version")).toBe(true);
  expect(journal.filter((r) => r.phase === "spawned").every((r) => r.pid === null)).toBe(true);
  expect(fs.readdirSync(path.join(state, "work"))).toEqual(["001-version"]);
  expect(fs.existsSync(path.join(state, "artifacts"))).toBe(false);
  expect(fs.existsSync(path.join(state, "lock"))).toBe(false);
}

test("project v2: a valid bucket state reaches only the guarded planning version child", () => {
  const p = project();
  fs.writeFileSync(
    p.file,
    JSON.stringify({ ...p.ledger, version: 2, resources: { files: p.bucket } }),
  );
  const before = fs.readFileSync(p.file, "utf8");
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(69);
  expect(r.err).toContain("npx");
  registeredAtVersion(p, before);
});

test("project v2: account and caller identity checks precede the execution fence", () => {
  const p = project();
  fs.writeFileSync(
    p.file,
    JSON.stringify({ ...p.ledger, version: 2, resources: { files: p.bucket } }),
  );
  const before = fs.readFileSync(p.file, "utf8");

  const account = cli(
    p.dir,
    "plan",
    "--env",
    "dev",
    "--account",
    "fedcba9876543210fedcba9876543210",
  );

  expect(account.code).toBe(5);
  expect(account.err).toContain("does not match");

  const caller = cli(p.dir, "live", "observe", p.state, "--account", ACCOUNT);
  expect(caller.code).toBe(5);
  expect(caller.err).toContain("not a live run");
  unchanged(p, before);
});

test.each([1, 2])("legacy live v%s: bucket rows are never accepted", (version) => {
  const p = project();

  const ledger = {
    version,
    kind: "bend-infra/live-ledger",
    run: p.ledger.run,
    account: ACCOUNT,
    environment: "e2e",
    consent: "create-and-delete-disposable-bend-infra-e2e-resources",
    wrangler: p.ledger.wrangler,
    createdAt: p.ledger.createdAt,
    resources: { files: { ...p.bucket, name: `bend-infra-e2e-${p.ledger.run}-files` } },
  };

  fs.writeFileSync(p.file, JSON.stringify(ledger));
  const before = fs.readFileSync(p.file, "utf8");
  const r = cli(p.dir, "live", "observe", p.state, "--account", ACCOUNT);
  expect(r.code).toBe(65);
  unchanged(p, before);
});

test.each([1, 2])("project v%s: non-bucket rows cannot carry generation fields", (version) => {
  const p = project();
  const database = { ...p.bucket, type: "d1_database" };
  fs.writeFileSync(
    p.file,
    JSON.stringify({ ...p.ledger, version, resources: { files: database } }),
  );
  const before = fs.readFileSync(p.file, "utf8");
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(65);
  expect(r.err).toContain("bucketCreated");
  unchanged(p, before);
});

const invalid = [
  ["missing generation", "bucketCreated", undefined],
  ["numeric generation", "bucketCreated", 123],
  ["invalid generation", "bucketCreated", "not-a-date"],
  ["non-UTC generation", "bucketCreated", "2026-06-01T12:30:00+00:00"],
  ["normalized invalid date", "bucketCreated", "2026-02-30T12:30:00Z"],
  ["null created generation", "bucketCreated", null],
  ["missing protection", "protected", undefined],
  ["string protection", "protected", "true"],
  ["foreign name", "name", "other-dev-files-01234567"],
  ["foreign logical id", "logicalId", "other"],
  ["D1 uuid", "physicalId", "12345678-1234-1234-1234-123456789abc"],
  ["location metadata", "location", "weur"],
  ["replication metadata", "readReplication", "disabled"],
  ["Worker version", "versionId", null],
  ["Worker etag", "etag", null],
  ["Worker URL", "url", null],
  ["Worker source", "sourceSha256", null],
  ["unknown bucket option", "jurisdiction", "eu"],
] as const;

test.each(invalid)("project v2: rejects %s before any process", (_label, key, value) => {
  const p = project();
  const bucket = { ...p.bucket, [key]: value };
  fs.writeFileSync(
    p.file,
    JSON.stringify({ ...p.ledger, version: 2, resources: { files: bucket } }),
  );
  const before = fs.readFileSync(p.file, "utf8");
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(65);
  expect(r.err).toContain(
    key === "name" || key === "logicalId" ? "does not belong to run" : "ledger.json",
  );
  unchanged(p, before);
});

test.each(["new", "creating", "absent", "conflict", "unknown"])(
  "project v2: %s retains null generation before the guarded planning version child",
  (status) => {
    const p = project();
    const bucket = { ...p.bucket, status, bucketCreated: null, protected: false };
    fs.writeFileSync(
      p.file,
      JSON.stringify({ ...p.ledger, version: 2, resources: { files: bucket } }),
    );
    const before = fs.readFileSync(p.file, "utf8");
    const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
    expect(r.code).toBe(69);
    expect(r.err).toContain("npx");
    registeredAtVersion(p, before);
  },
);

test.each(["created", "deleting", "deleted"])(
  "project v2: %s requires a non-null generation",
  (status) => {
    const p = project();
    const bucket = { ...p.bucket, status, bucketCreated: null };
    fs.writeFileSync(
      p.file,
      JSON.stringify({ ...p.ledger, version: 2, resources: { files: bucket } }),
    );
    const before = fs.readFileSync(p.file, "utf8");
    const r = cli(p.dir, "destroy", "--env", "dev", "--account", ACCOUNT, "--confirm", "hello/dev");
    expect(r.code).toBe(65);
    expect(r.err).toContain("requires its generation timestamp");
    unchanged(p, before);
  },
);

test.each(["2026-06-01T12:30:00Z", "2026-06-01T12:30:00.123456Z"])(
  "project v2: preserves valid UTC generation %s without writing state",
  (bucketCreated) => {
    const p = project();
    const bucket = { ...p.bucket, status: "deleted", bucketCreated };
    fs.writeFileSync(
      p.file,
      JSON.stringify({ ...p.ledger, version: 2, resources: { files: bucket } }),
    );
    const before = fs.readFileSync(p.file, "utf8");
    const r = cli(p.dir, "destroy", "--env", "dev", "--account", ACCOUNT, "--confirm", "hello/dev");
    expect(r.code).toBe(69);
    expect(r.err).toContain("npx");
    expect(fs.readFileSync(p.file, "utf8")).toBe(before);
    versionOnly(p.state);
  },
);

test("project v1: R2 rows cannot opt into the new owner contract", () => {
  const p = project();
  fs.writeFileSync(p.file, JSON.stringify({ ...p.ledger, resources: { files: p.bucket } }));
  const before = fs.readFileSync(p.file, "utf8");
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(65);
  unchanged(p, before);
});

test("project v2: a typed delete-intent generation loads without changing its ownership history", () => {
  const p = project();

  const bucket = {
    ...p.bucket,
    status: "unknown",
    history: [
      {
        at: "2026-06-01T00:00:00Z",
        event: "delete-intent",
        detail: { bucketCreated: p.bucket.bucketCreated, artifact: "sha256:recorded", step: 1 },
      },
    ],
  };

  fs.writeFileSync(
    p.file,
    JSON.stringify({ ...p.ledger, version: 2, resources: { files: bucket } }),
  );
  const before = fs.readFileSync(p.file, "utf8");
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(69);
  expect(r.err).toContain("npx");
  registeredAtVersion(p, before);
});

test.each([null, 123, "yesterday", "2026-02-30T00:00:00Z"])(
  "project v2: malformed history generation %s refuses before provider work",
  (bucketCreated) => {
    const p = project();

    const bucket = {
      ...p.bucket,
      history: [{ at: "2026-06-01T00:00:00Z", event: "delete-intent", detail: { bucketCreated } }],
    };

    fs.writeFileSync(
      p.file,
      JSON.stringify({ ...p.ledger, version: 2, resources: { files: bucket } }),
    );
    const before = fs.readFileSync(p.file, "utf8");
    const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
    expect(r.code).toBe(65);
    expect(r.err).toContain("bucketCreated");
    unchanged(p, before);
  },
);

test.each([1, 2])("project v%s: D1 history cannot acquire bucket-generation fields", (version) => {
  const p = project();

  const db = {
    type: "d1_database",
    logicalId: "db",
    name: `hello-dev-db-${p.ledger.run.slice(0, 8)}`,
    status: "created",
    physicalId: "11111111-1111-4111-8111-111111111111",
    location: "weur",
    readReplication: "disabled",
    protected: true,
    history: [
      {
        at: "2026-06-01T00:00:00Z",
        event: "delete-intent",
        detail: { bucketCreated: p.bucket.bucketCreated },
      },
    ],
  };

  fs.writeFileSync(p.file, JSON.stringify({ ...p.ledger, version, resources: { db } }));
  const before = fs.readFileSync(p.file, "utf8");
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(65);
  expect(r.err).toContain("unknown field");
  unchanged(p, before);
});

test("project v2: a held lock wins over corrupt state parsing", () => {
  const p = project();
  fs.writeFileSync(p.file, "{corrupt v2 input");
  const lock = path.join(p.state, "lock");
  fs.writeFileSync(lock, "held by another command\n");
  const r = cli(p.dir, "plan", "--env", "dev", "--account", ACCOUNT);
  expect(r.code).toBe(5);
  expect(r.err).toContain("holds this run");
  expect(fs.readFileSync(p.file, "utf8")).toBe("{corrupt v2 input");
  expect(fs.readFileSync(lock, "utf8")).toBe("held by another command\n");
  expect(fs.readdirSync(p.state).sort()).toEqual(["ledger.json", "lock"]);
});
