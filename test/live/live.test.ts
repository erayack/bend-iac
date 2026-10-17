// test:live: the real Cloudflare slice, through the public executable.
//
// Run only by scripts/test-live.ts (npm run test:live), which demands the
// explicit opt-in, gives this file a fresh run directory and, whatever
// happens here, runs `bend-iac live cleanup` afterwards and proves the
// run's resources absent. One Worker and one D1 database, named
// bend-infra-e2e-<random run id>-*, are created, probed, updated and
// deleted. The tests run in order; each builds on the previous one.
//
// Every live command gets the run directory as a RELATIVE path (from the
// repository root, the commands' cwd); the lane's own cleanup uses the
// absolute one. Two failure paths are exercised with real processes:
// a prepare held (by a FIFO source) before the run lock while another
// command applies, and a cleanup whose Worker read is interrupted.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorCode } from "../../src/errors";
import type { JsonData } from "../../src/json";
import { BIN, run, type Run } from "../e2e/helpers";
import { signalOwnedGroup, type Proc } from "../process";
import { https, poll, Probe } from "./probe";
import { workerSource } from "./worker";

const ACCOUNT = process.env.BEND_INFRA_LIVE_ACCOUNT ?? "";
const STATE = process.env.BEND_INFRA_LIVE_STATE ?? "";
const CONSENT = "create-and-delete-disposable-bend-infra-e2e-resources";
const T = 900_000;

// outside the lane this file fails at once; it never skips and never
// falls back to a default account or directory
if (!/^[0-9a-f]{32}$/.test(ACCOUNT) || !path.isAbsolute(STATE) || fs.existsSync(STATE)) {
  throw new Error(
    "test/live runs only under `npm run test:live` (scripts/test-live.ts), which sets BEND_INFRA_LIVE_ACCOUNT and a fresh BEND_INFRA_LIVE_STATE",
  );
}

// relative to the repository root, the cwd of every command (helpers.run)
const RUN = path.relative(path.resolve(import.meta.dir, "..", ".."), STATE);
const live = (...args: string[]): Run => run(BIN, "live", ...args);

type Done = { code: number | null; out: string; err: string };

type Started = { child: ChildProcess; done: Promise<Done> };

function liveAsync(...args: string[]): Started {
  const child = spawn(BIN, ["live", ...args], {
    cwd: path.resolve(import.meta.dir, "..", ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (err += d));

  return { child, done: new Promise((r) => child.on("close", (code) => r({ code, out, err }))) };
}

// resolves when a process has the FIFO open for reading; the returned write
// end keeps that reader blocked until it is written and closed
async function waitForReader(file: string, ms = 30_000): Promise<number> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await Bun.sleep(25)) {
    try {
      return fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch (e) {
      if (errorCode(e) !== "ENXIO") throw e;
    }
  }

  throw new Error(`no process opened ${file} for reading`);
}

const json = (r: Run) => {
  try {
    return JSON.parse(r.out);
  } catch {
    throw new Error(`not JSON (exit ${r.code}):\n${r.out}\n${r.err}`);
  }
};

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const journal = () =>
  fs
    .readFileSync(path.join(STATE, "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

const mutations = () =>
  journal()
    .filter((e) => e.phase === "start" && e.mutating)
    .map((e) => `${e.seq} ${e.purpose}`);

const ledger = () => JSON.parse(fs.readFileSync(path.join(STATE, "ledger.json"), "utf8"));

const SPECS = path.join(STATE, "specs");
const probe = new Probe(ACCOUNT, path.join(STATE, "evidence"));
const MARKER = `bend-infra-e2e-marker-${randomBytes(16).toString("hex")}`;

const db = (extra: Record<string, JsonData> = {}) => ({
  type: "d1_database",
  id: "e2e-db",
  environment: "e2e",
  location: "weur",
  readReplication: "disabled",
  protected: true,
  ...extra,
});

const wk = {
  type: "worker",
  id: "e2e-api",
  environment: "e2e",
  main: "worker.js",
  compatibilityDate: "2026-06-01",
  bindings: [{ name: "DB", database: "e2e-db" }],
};

function spec(
  name: string,
  resources: JsonData[],
  allow: string[],
  source: string | null,
  approvals?: JsonData[],
): string {
  const dir = path.join(SPECS, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "desired.json"),
    JSON.stringify(
      { version: 1, kind: "bend-infra/desired", environments: ["e2e"], resources },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, "grant.json"),
    JSON.stringify({ version: 1, kind: "bend-infra/grant", environment: "e2e", allow }, null, 2),
  );

  if (approvals)
    fs.writeFileSync(
      path.join(dir, "approvals.json"),
      JSON.stringify({ version: 1, kind: "bend-infra/approvals", approvals }, null, 2),
    );

  if (source !== null) fs.writeFileSync(path.join(dir, "worker.js"), source);

  return dir;
}

function prepare(dir: string) {
  const r = live("prepare", RUN, dir, "--account", ACCOUNT, "--json");
  const j = json(r);

  return {
    r,
    j,
    apply: (digest = j.digest, account = ACCOUNT) =>
      live("apply", RUN, "--account", account, "--artifact", j.artifact, "--digest", digest),
  };
}

const ops = (j: any) => j.operations.map((o: any) => [o.action, o.type, o.id, o.reasons]);

type Names = { db: string; worker: string };

let names: Names;
let uuid = "";
let url = "";

describe("test:live (Cloudflare, disposable resources)", () => {
  test(
    "the lane opted in explicitly: account, consent and a fresh run directory",
    () => {
      expect(ACCOUNT).toMatch(/^[0-9a-f]{32}$/);
      expect(process.env.BEND_INFRA_LIVE_CONSENT).toBe(CONSENT);
      expect(STATE).not.toBe("");
      expect(path.isAbsolute(RUN)).toBe(false);
      const r = live("init", RUN, "--account", ACCOUNT, "--consent", CONSENT, "--json");
      expect(r.code).toBe(0);
      const l = ledger();
      expect(l.account).toBe(ACCOUNT);
      expect(l.run).toMatch(/^[0-9a-f]{16}$/);
      names = { db: `bend-infra-e2e-${l.run}-e2e-db`, worker: `bend-infra-e2e-${l.run}-e2e-api` };
      probe.save("00-run", { run: l.run, account: ACCOUNT, names, marker: MARKER });
    },
    T,
  );

  let create: ReturnType<typeof prepare>;

  test(
    "prepare: live absence of both exact names, then the Bend planner approves create D1, then create Worker",
    () => {
      create = prepare(spec("01-create", [db(), wk], ["create", "update"], workerSource("v1")));
      expect(create.r.code).toBe(0);
      expect(create.j.outcome).toBe("approved");
      expect(create.j.executable).toBe(true);
      expect(ops(create.j)).toEqual([
        ["create", "d1_database", "e2e-db", []],
        ["create", "worker", "e2e-api", []],
      ]);
      expect(create.j.observation).toEqual([
        { id: "e2e-api", type: "worker", name: names.worker, present: false },
        { id: "e2e-db", type: "d1_database", name: names.db, present: false },
      ]);
      const a = JSON.parse(fs.readFileSync(create.j.artifact, "utf8"));
      expect(`sha256:${sha256(fs.readFileSync(create.j.artifact))}`).toBe(create.j.digest);
      expect(a.inputs.observed.source).toBe("wrangler");
      expect(a.inputs.desired.resources.find((r: any) => r.type === "worker").main).toBe(
        `sha256:${sha256(workerSource("v1"))}`,
      );
      expect(a.payload.map((s: any) => s.purpose)).toEqual(["d1-create", "deploy"]);
      expect(a.payload[1].config.d1_databases[0].database_id).toBe(
        '{uuid of d1_database "e2e-db" created by an earlier step}',
      );
      expect(mutations()).toEqual([]);
      probe.save("01-prepare-create", create.j);
    },
    T,
  );

  test(
    "tampering refuses before any remote mutation: digest, operations, payload, account, source",
    () => {
      const art: string = create.j.artifact;
      const original = fs.readFileSync(art);
      const results: Record<string, [number, string]> = {};
      const flip = create.j.digest.replace(/.$/, (c: string) => (c === "0" ? "1" : "0"));
      let r = create.apply(flip);
      results.wrongDigest = [r.code, r.err.trim()];
      expect(r.code).toBe(5);
      expect(r.err).toContain("nothing ran");

      const edit = (f: (a: any) => void) => {
        const a = JSON.parse(original.toString());
        f(a);
        const text = JSON.stringify(a, null, 2) + "\n";
        fs.writeFileSync(art, text);

        return `sha256:${sha256(text)}`;
      };

      r = create.apply(edit((a) => a.operations.reverse()));
      results.reorderedOperations = [r.code, r.err.trim()];
      expect(r.code).toBe(5);
      expect(r.err).toContain("the planner does not return the artifact's operations");

      r = create.apply(edit((a) => (a.payload[0].args[4] = "enam")));
      results.payloadLocation = [r.code, r.err.trim()];
      expect(r.code).toBe(5);
      expect(r.err).toContain("payload is not the one its inputs produce");

      r = create.apply(edit((a) => (a.outcome = "approval_required")));
      results.pendingArtifact = [r.code, r.err.trim()];
      expect(r.code).toBe(3);
      fs.writeFileSync(art, original);

      r = create.apply(create.j.digest, "0123456789abcdef0123456789abcdef");
      results.otherAccount = [r.code, r.err.trim()];
      expect(r.code).toBe(5);

      const src = path.join(SPECS, "01-create", "worker.js");
      fs.writeFileSync(src, workerSource("v1-tampered"));
      r = create.apply();
      results.sourceChanged = [r.code, r.err.trim()];
      expect(r.code).toBe(5);
      expect(r.err).toContain("changed since prepare");
      fs.writeFileSync(src, workerSource("v1"));

      const stored = path.join(STATE, "sources", `${sha256(workerSource("v1"))}.js`);
      fs.writeFileSync(stored, workerSource("v1-tampered"));
      r = create.apply();
      results.storedSourceChanged = [r.code, r.err.trim()];
      expect(r.code).toBe(5);
      fs.writeFileSync(stored, workerSource("v1"));

      expect(mutations()).toEqual([]);
      expect(probe.d1Info(names.db)).toEqual({ present: false });
      expect(probe.worker(names.worker)).toEqual({ present: false });
      probe.save("02-tamper-refusals", results);
    },
    T,
  );

  type Waiting = { b: Started; fd: number; fifo: string };

  let waiting: Waiting;

  test(
    "apply: the approved create plan creates the D1 database and deploys the Worker bound to it",
    async () => {
      // R3: before the apply starts, a second prepare of the same run is
      // running and waits on its Worker source (a FIFO), before the run lock
      const dir = spec("01-create-concurrent", [db(), wk], ["create", "update"], null);
      const fifo = path.join(dir, "worker.js");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const b = liveAsync("prepare", RUN, dir, "--account", ACCOUNT, "--json");
      waiting = { b, fifo, fd: await waitForReader(fifo) };
      expect(fs.existsSync(path.join(STATE, "lock"))).toBe(false);

      const r = create.apply();
      expect(r.code).toBe(0);
      expect(mutations().map((m) => m.split(" ")[1])).toEqual(["d1-create", "deploy"]);
      const l = ledger();
      expect(l.resources["e2e-db"]).toMatchObject({
        status: "created",
        name: names.db,
        protected: true,
        location: "weur",
      });
      expect(l.resources["e2e-api"]).toMatchObject({
        status: "created",
        name: names.worker,
        sourceSha256: sha256(workerSource("v1")),
      });
      uuid = l.resources["e2e-db"].physicalId;
      url = l.resources["e2e-api"].url;
      expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(url).toMatch(new RegExp(`^https://${names.worker}\\.[a-z0-9-]+\\.workers\\.dev$`));
      // independent: the database by exact name, the Worker's live binding
      expect(probe.d1Info(names.db)).toEqual({ present: true, uuid });
      const w = probe.worker(names.worker);
      expect(w.present).toBe(true);

      if (!w.present) return;

      const bindings = w.version.resources.bindings.map((b: any) => [
        b.type,
        b.name,
        b.id ?? b.database_id,
      ]);

      expect(bindings).toEqual([["d1", "DB", uuid]]);
      expect(w.version.annotations["workers/message"]).toBe(
        `bend-infra sha256:${sha256(workerSource("v1"))}`,
      );
      probe.save("03-apply-create", {
        stdout: r.out,
        ledger: l.resources,
        probe: { d1: uuid, versionId: w.versionId, bindings, annotations: w.version.annotations },
      });
    },
    T,
  );

  test(
    "a prepare that waited before the lock during that apply plans from the updated ledger: no lost ids, no false conflict",
    async () => {
      const before = ledger().resources;
      const appliedUntil = journal().length;
      fs.writeSync(waiting.fd, Buffer.from(workerSource("v1")));
      fs.closeSync(waiting.fd);
      const r = await waiting.b.done;
      expect(r.code).toBe(0);
      const j = JSON.parse(r.out);
      expect(j.outcome).toBe("approved");
      expect(j.operations).toEqual([]);
      expect(j.observation.map((e: any) => [e.id, e.present])).toEqual([
        ["e2e-api", true],
        ["e2e-db", true],
      ]);
      const after = ledger().resources;

      for (const id of ["e2e-api", "e2e-db"]) {
        expect(after[id].status).toBe("created");
        expect(after[id].history.map((h: any) => h.event)).not.toContain(
          "name-exists-before-create",
        );
      }

      expect(after["e2e-db"].physicalId).toBe(uuid);
      expect(after["e2e-api"].versionId).toBe(before["e2e-api"].versionId);
      // its commands all ran after the apply's last one, and none mutated
      const own = journal().slice(appliedUntil);
      expect(own.length).toBeGreaterThan(0);
      expect(own.some((e: any) => e.mutating)).toBe(false);
      probe.save("03b-concurrent-prepare", {
        exit: r.code,
        plan: j,
        ledgerBefore: before,
        ledgerAfter: after,
        journal: own,
      });
    },
    T,
  );

  test(
    "HTTPS: a unique marker written through the Worker is read back, and remote D1 SQL corroborates it",
    async () => {
      const up = await poll(`${url}/version`, (h) => h.status === 200 && h.json?.version === "v1");
      expect(up.last?.json).toEqual({ version: "v1" });
      const post = await https(`${url}/marker?value=${MARKER}`, { method: "POST" });
      expect(post.status).toBe(200);
      expect(post.json).toEqual({ version: "v1", stored: MARKER });
      const get = await https(`${url}/marker`);
      expect(get.status).toBe(200);
      expect(get.json.markers).toContain(MARKER);
      const sql = probe.d1Markers(names.db, uuid);
      expect(sql).toContain(MARKER);
      probe.save("04-https-and-sql", {
        version: { attempts: up.attempts, ...up.last },
        post,
        get,
        sqlMarkers: sql,
      });
    },
    T,
  );

  test(
    "no-op: the unchanged spec plans no operations, and apply runs nothing",
    () => {
      const before = mutations();
      const p = prepare(path.join(SPECS, "01-create"));
      expect(p.r.code).toBe(0);
      expect(p.j.operations).toEqual([]);
      expect(p.j.observation.map((e: any) => [e.id, e.present])).toEqual([
        ["e2e-api", true],
        ["e2e-db", true],
      ]);
      const r = p.apply();
      expect(r.code).toBe(0);
      expect(r.out).toContain("no changes; nothing ran");
      expect(mutations()).toEqual(before);
      probe.save("05-noop", p.j);
    },
    T,
  );

  test(
    "update: changed source bytes are a planned Worker update; the new version serves and the marker remains",
    async () => {
      const p = prepare(spec("02-update", [db(), wk], ["update"], workerSource("v2")));
      expect(p.r.code).toBe(0);
      expect(ops(p.j)).toEqual([["update", "worker", "e2e-api", ["main"]]]);
      const r = p.apply();
      expect(r.code).toBe(0);
      expect(mutations().slice(-1)[0]).toMatch(/ deploy$/);
      const up = await poll(`${url}/version`, (h) => h.status === 200 && h.json?.version === "v2");
      expect(up.last?.json).toEqual({ version: "v2" });
      const get = await poll(`${url}/marker`, (h) => h.status === 200 && h.json?.version === "v2");
      expect(get.last?.json.markers).toContain(MARKER);
      expect(probe.d1Markers(names.db, uuid)).toContain(MARKER);
      const w = probe.worker(names.worker);
      expect(w.present && w.version.annotations["workers/message"]).toBe(
        `bend-infra sha256:${sha256(workerSource("v2"))}`,
      );
      expect(ledger().resources["e2e-db"].physicalId).toBe(uuid);
      probe.save("06-update", {
        plan: p.j,
        apply: r.out,
        version: up.last,
        marker: get.last,
        versionId: w.present ? w.versionId : null,
      });
    },
    T,
  );

  test(
    "unsupported operations fail closed: a D1 update, and an approved D1 replacement",
    () => {
      const before = mutations();
      const out: Record<string, JsonData> = {};

      const upd = prepare(
        spec("03-db-update", [db({ readReplication: "auto" }), wk], ["update"], workerSource("v2")),
      );

      expect(upd.r.code).toBe(4);
      expect(ops(upd.j)).toEqual([["update", "d1_database", "e2e-db", ["readReplication"]]]);
      expect(upd.j.executable).toBe(false);
      expect(upd.j.unsupported.join("\n")).toContain(
        "update of a d1_database (readReplication) is not supported",
      );
      const ua = upd.apply();
      expect(ua.code).toBe(4);
      out.update = { plan: upd.j, apply: [ua.code, ua.err.trim()] };

      const rep = prepare(
        spec(
          "04-db-replace-unapproved",
          [db({ location: "enam" }), wk],
          ["create", "update", "delete"],
          workerSource("v2"),
        ),
      );

      expect(rep.r.code).toBe(3);
      expect(rep.j.problems.map((p: any) => p.code)).toEqual(["APPROVAL_REQUIRED"]);

      const approved = prepare(
        spec(
          "05-db-replace-approved",
          [db({ location: "enam" }), wk],
          ["create", "update", "delete"],
          workerSource("v2"),
          [
            {
              action: "replace",
              resource: "e2e-db",
              environment: "e2e",
              approvedBy: "test:live",
              reason: "probe the unsupported path",
            },
          ],
        ),
      );

      expect(approved.r.code).toBe(4);
      expect(ops(approved.j)).toEqual([
        ["replace", "d1_database", "e2e-db", ["location"]],
        ["update", "worker", "e2e-api", ["rebind"]],
      ]);
      const aa = approved.apply();
      expect(aa.code).toBe(4);
      out.replace = { unapproved: rep.j, approved: approved.j, apply: [aa.code, aa.err.trim()] };
      expect(mutations()).toEqual(before);
      probe.save("07-unsupported", out);
    },
    T,
  );

  test(
    "protected delete without approval is blocked; the Worker, the database and the marker remain",
    async () => {
      const before = mutations();
      const p = prepare(spec("06-delete-unapproved", [], ["delete"], null));
      expect(p.r.code).toBe(3);
      expect(p.j.outcome).toBe("approval_required");
      expect(p.j.operations).toEqual([]);
      expect(p.j.problems.map((x: any) => [x.code, x.id])).toEqual([
        ["APPROVAL_REQUIRED", "e2e-db"],
      ]);
      const r = p.apply();
      expect(r.code).toBe(3);
      expect(mutations()).toEqual(before);
      expect(probe.d1Info(names.db)).toEqual({ present: true, uuid });
      expect(probe.worker(names.worker).present).toBe(true);
      const get = await https(`${url}/marker`);
      expect(get.json.markers).toContain(MARKER);
      expect(probe.d1Markers(names.db, uuid)).toContain(MARKER);
      probe.save("08-delete-unapproved", { plan: p.j, apply: [r.code, r.err.trim()], marker: get });
    },
    T,
  );

  test(
    "cleanup whose Worker read is interrupted refuses every mutation; Worker, database and marker remain, and the run stays observable",
    async () => {
      const run = ledger().run;
      const ledgerBefore = ledger().resources;
      const base = journal().length;
      const c = liveAsync("cleanup", RUN, "--account", ACCOUNT, "--confirm-run", run);
      // the cleanup's own child for `deployments status` of this run's Worker:
      // found in the journal, checked with ps, then its process group (the
      // child runs detached, as its own group) is stopped and terminated
      let target: any = null;

      for (const t0 = Date.now(); !target && Date.now() - t0 < 60_000; await Bun.sleep(20)) {
        const es = journal().slice(base);
        const from = es.findIndex((e: any) => e.phase === "cleanup");

        if (from >= 0)
          target =
            es
              .slice(from)
              .find((e: any) => e.phase === "spawned" && e.purpose === "deployments-status") ??
            null;
      }

      // A failed spawn is journaled with pid:null. Never negate an unchecked
      // PID: -null is 0, which would signal this runner\'s own process group.
      if (
        !target ||
        !Number.isSafeInteger(target.pid) ||
        target.pid <= 1 ||
        !Number.isSafeInteger(c.child.pid) ||
        c.child.pid! <= 1 ||
        target.ppid !== c.child.pid
      ) {
        throw new Error("no valid owned Wrangler child PID; nothing was signalled");
      }

      const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8" })
        .stdout.split("\n")
        .filter((l) => Number(l.trim().split(/\s+/)[2]) === target.pid)
        .join("\n");

      const head = ps
        .trim()
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .find((x) => Number(x[0]) === target.pid);

      // identity: its own group, parent = this cleanup process, and that
      // process's journal says this seq is `deployments status` of our Worker.
      // (npm sets the full process title shortly after start; before that ps
      // shows just "npm".)
      const argv =
        journal().find((e: any) => e.phase === "start" && e.seq === target.seq)?.argv ?? [];

      const title = head ? head.slice(3).join(" ") : "";

      const verified =
        !!head &&
        Number(head[1]) === c.child.pid &&
        Number(head[2]) === target.pid &&
        argv.join(" ").includes(`deployments status --name ${names.worker} --json`) &&
        (title === "npm" || (title.includes("deployments status") && title.includes(names.worker)));

      // Verify the live parent/group and the exact owned command before ANY
      // signal, including SIGSTOP. An absent or unverified child is untouched.
      expect(verified).toBe(true);

      // ...and again, afresh, before each signal: the leader still leads its
      // group, is the running cleanup's child, and runs the same command
      const same = (leader: Proc) =>
        c.child.exitCode === null &&
        (leader.command.trim() === "npm" ||
          (leader.command.includes("deployments status") && leader.command.includes(names.worker)));

      let stopped = false;

      try {
        stopped = signalOwnedGroup(target.pid, c.child.pid!, "SIGSTOP", same);
        expect(stopped).toBe(true);
        expect(signalOwnedGroup(target.pid, c.child.pid!, "SIGTERM", same)).toBe(true);
      } finally {
        // never leave the group stopped: SIGCONT lets a pending SIGTERM act,
        // and an unverified (gone) group has nothing left to continue
        if (stopped) expect(signalOwnedGroup(target.pid, c.child.pid!, "SIGCONT", same)).toBe(true);
      }

      const r = await c.done;

      expect(r.code).toBe(69);
      expect(r.out).toContain("Cleanup: REFUSED");
      expect(r.out).toContain(names.worker);
      const own = journal().slice(base);
      const read = own.find((e: any) => e.phase === "end" && e.seq === target.seq);
      expect(read.exit === 0 && read.signal === null).toBe(false);
      expect(
        own.some((e: any) => e.phase === "end" && e.purpose === "d1-info" && e.exit === 0),
      ).toBe(true);
      expect(own.filter((e: any) => e.mutating)).toEqual([]);
      expect(fs.readdirSync(path.join(STATE, "artifacts")).some((f) => f.includes("cleanup"))).toBe(
        false,
      );
      expect(ledger().resources).toEqual(ledgerBefore);

      // independently: everything is still there and still works
      const w = probe.worker(names.worker);
      expect(w.present && w.versionId).toBe(ledgerBefore["e2e-api"].versionId);
      expect(probe.d1Info(names.db)).toEqual({ present: true, uuid });
      const get = await https(`${url}/marker`);
      expect(get.json.markers).toContain(MARKER);
      expect(probe.d1Markers(names.db, uuid)).toContain(MARKER);

      // the ledger inventory is intact: a read that is not interrupted sees both
      const o = live("observe", RUN, "--account", ACCOUNT, "--json");
      expect(o.code).toBe(0);
      const oj = json(o);
      expect(oj.undetermined).toEqual([]);
      expect(oj.evidence.map((e: any) => [e.id, e.present])).toEqual([
        ["e2e-api", true],
        ["e2e-db", true],
      ]);
      expect(oj.outstanding.length).toBe(2);
      probe.save("08b-cleanup-interrupted", {
        cleanup: { exit: r.code, stdout: r.out, stderr: r.err.slice(-2000) },
        interruptedChild: { ...target, argv, ps: ps.trim() },
        journal: own,
        retained: { versionId: w.present ? w.versionId : null, uuid, marker: get.json },
        observe: oj,
      });
    },
    T,
  );

  test(
    "approved teardown: the exact delete plan removes the Worker, then the database; remote absence is observed",
    async () => {
      const p = prepare(
        spec("07-delete-approved", [], ["delete"], null, [
          {
            action: "delete",
            resource: "e2e-db",
            environment: "e2e",
            approvedBy: "test:live under the user's disposable-resource consent",
            reason: "teardown of this run",
          },
        ]),
      );

      expect(p.r.code).toBe(0);
      expect(ops(p.j)).toEqual([
        ["delete", "worker", "e2e-api", []],
        ["delete", "d1_database", "e2e-db", []],
      ]);
      const before = mutations().length;
      const r = p.apply();
      expect(r.code).toBe(0);
      expect(
        mutations()
          .slice(before)
          .map((m) => m.split(" ")[1]),
      ).toEqual(["delete-worker", "d1-delete"]);
      const l = ledger();
      expect(l.resources["e2e-api"].status).toBe("deleted");
      expect(l.resources["e2e-db"].status).toBe("deleted");
      expect(probe.worker(names.worker)).toEqual({ present: false });
      expect(probe.d1Info(names.db)).toEqual({ present: false });
      expect(probe.d1Info(uuid)).toEqual({ present: false });
      const gone = await poll(`${url}/version`, (h) => h.status !== 200, 10, 3_000);
      expect(gone.last?.status).not.toBe(200);
      probe.save("09-delete-approved", {
        plan: p.j,
        apply: r.out,
        ledger: l.resources,
        https: {
          attempts: gone.attempts,
          status: gone.last?.status,
          body: gone.last?.body.slice(0, 300),
        },
      });
    },
    T,
  );
});
