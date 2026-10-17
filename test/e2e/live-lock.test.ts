// The run lock, through bin/bend-iac in real concurrent processes: a
// command takes the exclusive run lock BEFORE it reads the ledger (or an
// artifact checked against the ledger), so it never decides or writes on a
// snapshot taken while it was waiting.
//
// Processes are held at a real blocking point with a FIFO: a Worker source
// or an artifact that is a named pipe blocks the reading process until the
// test writes to it. A non-blocking open for writing tells the test that
// the reader is waiting there.
//
// No Wrangler process may start in this offline lane, not even if this
// code regressed: each run directory has a `.env` file in the work
// directory of its first Wrangler command, which the adapter's real guard
// refuses before spawning anything (Wrangler would load it). The account
// id is made up.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { errorCode } from "../../src/errors";
import { BIN, cli, ROOT } from "./helpers";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CONSENT = "create-and-delete-disposable-bend-infra-e2e-resources";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bend-iac-live-lock-"));

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

let n = 0;

const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of children.splice(0))
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});

type Done = { code: number | null; out: string; err: string };

type Started = { child: ChildProcess; done: Promise<Done> };

function start(...args: string[]): Started {
  const child = spawn(BIN, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (err += d));

  return { child, done: new Promise((r) => child.on("close", (code) => r({ code, out, err }))) };
}

function fifo(file: string) {
  const r = spawnSync("mkfifo", [file]);

  if (r.status !== 0) throw new Error(`mkfifo ${file}: ${r.stderr}`);
}

// resolves once some process has the FIFO open for reading; returns the
// write end, which keeps that reader blocked until it is written and closed
async function waitForReader(file: string, ms = 20_000): Promise<number> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await Bun.sleep(25)) {
    try {
      return fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch (e) {
      if (errorCode(e) !== "ENXIO") throw e;
    }
  }

  throw new Error(`no process opened ${file} for reading`);
}

function release(fd: number, text: string) {
  fs.writeSync(fd, Buffer.from(text));
  fs.closeSync(fd);
}

type RunDir = { dir: string; run: string };

function runDir(): RunDir {
  const dir = path.join(scratch, `run${n++}`);
  const r = cli("live", "init", dir, "--account", ACCOUNT, "--consent", CONSENT, "--json");
  expect(r.code).toBe(0);
  // the no-Cloudflare guard described above
  fs.mkdirSync(path.join(dir, "work", "001-version"), { recursive: true });
  fs.writeFileSync(path.join(dir, "work", "001-version", ".env"), "");

  return { dir, run: JSON.parse(r.out).run };
}

const noWrangler = (dir: string) => {
  expect(fs.existsSync(path.join(dir, "journal.jsonl"))).toBe(false);
  expect(fs.readdirSync(path.join(dir, "work"))).toEqual(["001-version"]);
  expect(
    fs
      .readdirSync(path.join(dir, "work", "001-version"))
      .filter((f) => f !== ".env" && f !== "wrangler.json"),
  ).toEqual([]);
};

const SOURCE = "export default { fetch() { return new Response('ok'); } };\n";

type Spec = { dir: string; worker: string };

function spec(source: "fifo" | "file"): Spec {
  const dir = path.join(scratch, `spec${n++}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "desired.json"),
    JSON.stringify({
      version: 1,
      kind: "bend-infra/desired",
      environments: ["e2e"],
      resources: [
        {
          type: "d1_database",
          id: "e2e-db",
          environment: "e2e",
          location: "weur",
          readReplication: "disabled",
          protected: true,
        },
        {
          type: "worker",
          id: "e2e-api",
          environment: "e2e",
          main: "worker.js",
          compatibilityDate: "2026-06-01",
          bindings: [{ name: "DB", database: "e2e-db" }],
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "grant.json"),
    JSON.stringify({ version: 1, kind: "bend-infra/grant", environment: "e2e", allow: ["create"] }),
  );
  const worker = path.join(dir, "worker.js");

  if (source === "fifo") fifo(worker);
  else fs.writeFileSync(worker, SOURCE);

  return { dir, worker };
}

describe("live: the run lock is taken before the ledger is read", () => {
  test("apply reads its artifact while holding the lock; concurrent commands are refused on the held lock and change nothing", async () => {
    const { dir, run } = runDir();
    const ledgerBefore = fs.readFileSync(path.join(dir, "ledger.json"));
    const artifact = path.join(scratch, `artifact${n++}.json`);
    fifo(artifact);

    const a = start(
      "live",
      "apply",
      dir,
      "--account",
      ACCOUNT,
      "--artifact",
      artifact,
      "--digest",
      `sha256:${"0".repeat(64)}`,
    );

    const fd = await waitForReader(artifact);
    // A waits on its artifact INSIDE the lock, which names A's process
    const lockFile = path.join(dir, "lock");
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid).toBe(a.child.pid);

    const s = spec("file");

    for (const args of [
      ["observe", dir, "--account", ACCOUNT],
      ["cleanup", dir, "--account", ACCOUNT, "--confirm-run", run],
      ["prepare", dir, s.dir, "--account", ACCOUNT],
    ]) {
      const b = cli("live", ...args);
      expect(b.code).toBe(5);
      expect(b.err).toContain("exists: another bend-infra live command holds this run");
    }

    expect(fs.readFileSync(lockFile, "utf8")).toContain(`"pid":${a.child.pid}`);

    release(fd, "{}\n");
    const r = await a.done;
    expect(r.code).toBe(5);
    expect(r.err).toContain("not the expected sha256");
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "ledger.json"))).toEqual(ledgerBefore);
    noWrangler(dir);
  }, 60_000);

  test("prepare holds no lock while it waits on its spec, then works on the ledger committed meanwhile (no stale overwrite)", async () => {
    const { dir, run } = runDir();
    const s = spec("fifo");
    const b = start("live", "prepare", dir, s.dir, "--account", ACCOUNT);
    const fd = await waitForReader(s.worker);
    expect(fs.existsSync(path.join(dir, "lock"))).toBe(false);

    // While B waits, the run's ledger moves on: another command records the
    // two resources it created, with their physical ids. Written the way
    // the ledger is always written: a temp file renamed over ledger.json.
    const l = JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8"));
    const at = new Date().toISOString();
    l.resources = {
      "e2e-api": {
        type: "worker",
        logicalId: "e2e-api",
        name: `bend-infra-e2e-${run}-e2e-api`,
        status: "created",
        physicalId: null,
        versionId: "11111111-1111-4111-8111-111111111111",
        etag: "e".repeat(64),
        url: null,
        sourceSha256: "a".repeat(64),
        history: [{ at, event: "created" }],
      },
      "e2e-db": {
        type: "d1_database",
        logicalId: "e2e-db",
        name: `bend-infra-e2e-${run}-e2e-db`,
        status: "created",
        physicalId: "22222222-2222-4222-8222-222222222222",
        location: "weur",
        readReplication: "disabled",
        protected: true,
        history: [{ at, event: "created" }],
      },
    };
    const committed = JSON.stringify(l, null, 2) + "\n";
    fs.writeFileSync(path.join(dir, "ledger.tmp"), committed);
    fs.renameSync(path.join(dir, "ledger.tmp"), path.join(dir, "ledger.json"));

    release(fd, SOURCE);
    const r = await b.done;
    // B got past the lock with the committed ledger and stopped at its first
    // Wrangler command (the guard), having rewritten nothing
    expect(r.code).toBe(69);
    expect(r.err).toContain("holds an env file");
    expect(fs.readFileSync(path.join(dir, "ledger.json"), "utf8")).toBe(committed);
    expect(fs.existsSync(path.join(dir, "lock"))).toBe(false);
    noWrangler(dir);
  }, 60_000);

  test("a missing run directory, or one without a ledger, is refused before any lock or state is created", () => {
    const missing = path.join(scratch, `missing${n++}`);
    const s = spec("file");

    for (const args of [
      ["prepare", missing, s.dir, "--account", ACCOUNT],
      [
        "apply",
        missing,
        "--account",
        ACCOUNT,
        "--artifact",
        path.join(scratch, "x.json"),
        "--digest",
        `sha256:${"0".repeat(64)}`,
      ],
      ["observe", missing, "--account", ACCOUNT],
      ["cleanup", missing, "--account", ACCOUNT, "--confirm-run", "0000000000000000"],
    ])
      expect(cli("live", ...args).code).toBe(66);
    expect(fs.existsSync(missing)).toBe(false);

    const empty = path.join(scratch, `empty${n++}`);
    fs.mkdirSync(empty);

    for (const args of [
      ["observe", empty, "--account", ACCOUNT],
      ["prepare", empty, s.dir, "--account", ACCOUNT],
    ]) {
      const r = cli("live", ...args);
      expect(r.code).toBe(65);
      expect(r.err).toContain("ledger.json");
    }

    expect(fs.readdirSync(empty)).toEqual([]);
  });
});

describe("live: the ledger is this tool's own document, read strictly under the lock", () => {
  // a ledger as a run leaves it after creating both resources
  function owned(run: string) {
    const at = new Date().toISOString();

    return {
      "e2e-db": {
        type: "d1_database",
        logicalId: "e2e-db",
        name: `bend-infra-e2e-${run}-e2e-db`,
        status: "created",
        physicalId: "22222222-2222-4222-8222-222222222222",
        history: [
          { at, event: "declared" },
          { at, event: "create-intent", detail: { artifact: `sha256:${"a".repeat(64)}`, step: 1 } },
          { at, event: "created", detail: { uuid: "22222222-2222-4222-8222-222222222222" } },
        ],
        location: "weur",
        readReplication: "disabled",
        protected: true,
      },
      "e2e-api": {
        type: "worker",
        logicalId: "e2e-api",
        name: `bend-infra-e2e-${run}-e2e-api`,
        status: "created",
        physicalId: null,
        history: [{ at, event: "created", detail: { versionId: null, exit: 0 } }],
        versionId: "11111111-1111-4111-8111-111111111111",
        etag: "e".repeat(64),
        url: null,
        sourceSha256: "a".repeat(64),
      },
    };
  }

  function withLedger(edit: (l: any, run: string) => string | void) {
    const { dir, run } = runDir();
    const file = path.join(dir, "ledger.json");
    const l = JSON.parse(fs.readFileSync(file, "utf8"));
    l.resources = owned(run);
    const text = edit(l, run) ?? JSON.stringify(l, null, 2) + "\n";
    fs.writeFileSync(file, text);

    return { dir, run, text };
  }

  test("a well-formed ledger is accepted: the command goes on to its first Wrangler step", () => {
    const { dir, text } = withLedger(() => {});
    const r = cli("live", "observe", dir, "--account", ACCOUNT);
    // stopped by the no-Cloudflare guard, past the ledger
    expect(r.code).toBe(69);
    expect(r.err).toContain("holds an env file");
    expect(fs.readFileSync(path.join(dir, "ledger.json"), "utf8")).toBe(text);
    expect(fs.existsSync(path.join(dir, "lock"))).toBe(false);
    noWrangler(dir);
  });

  test.each([
    [
      "a duplicated key (JSON.parse would keep the last)",
      (l: any) =>
        (JSON.stringify(l, null, 2) + "\n").replace(
          '"status": "created"',
          '"status": "new", "status": "created"',
        ),
      'duplicate key "status"',
    ],
    [
      "an unknown status",
      (l: any) => void (l.resources["e2e-db"].status = "adopted"),
      ".status: expected one of",
    ],
    [
      "a physical id that is not a D1 uuid",
      (l: any) => void (l.resources["e2e-db"].physicalId = "prod-db"),
      ".physicalId: expected a D1 uuid or null",
    ],
    [
      "an unknown resource field",
      (l: any) => void (l.resources["e2e-api"].owner = "x"),
      'unknown field "owner"',
    ],
    [
      "a location the model does not know",
      (l: any) => void (l.resources["e2e-db"].location = "mars"),
      ".location: expected one of",
    ],
    [
      "protected as a string",
      (l: any) => void (l.resources["e2e-db"].protected = "true"),
      ".protected: expected true or false",
    ],
    [
      "an unknown history detail",
      (l: any) => void (l.resources["e2e-db"].history[2].detail.size = 1),
      'unknown field "size"',
    ],
    [
      "a history step that is not a count",
      (l: any) => void (l.resources["e2e-db"].history[1].detail.step = "1"),
      ".step: expected a number",
    ],
    ["an unknown top-level field", (l: any) => void (l.extra = true), 'unknown field "extra"'],
    [
      "resources that are not an object",
      (l: any) => void (l.resources = []),
      "resources: expected an object",
    ],
  ])("%s is refused (65) before anything else, and nothing is rewritten", (_, edit, detail) => {
    const { dir, text } = withLedger(edit);

    for (const args of [
      ["observe", dir, "--account", ACCOUNT],
      ["prepare", dir, spec("file").dir, "--account", ACCOUNT],
    ]) {
      const r = cli("live", ...args);
      expect(r.code).toBe(65);
      expect(r.err).toContain("ledger.json");
      expect(r.err).toContain(detail);
    }

    expect(fs.readFileSync(path.join(dir, "ledger.json"), "utf8")).toBe(text);
    expect(fs.existsSync(path.join(dir, "lock"))).toBe(false);
    noWrangler(dir);
  });
});
