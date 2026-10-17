// Process integration of the Wrangler adapter's timeout handling, with real
// child processes: the pinned `npx --yes wrangler@4.151.1 --version`, run
// by the adapter (through wrangler-driver.ts) with short timeouts. No
// Cloudflare API is contacted and no credentials are read (`--version`, a
// made-up account); npx may consult the npm registry for the pinned package.
// This is not a live Cloudflare test.
//
// To make a command outlive its timeout, the test stops its process group,
// and continues it where a case needs that. Before every such signal it
// checks afresh that the group's leader is the driver's child and leads its
// own group (test/process.ts); every case cleans up in `finally`.
//
// The adapter journals every signal decision. The invariant checked here:
// it signals only while the command has not closed, on a basis checked at
// that moment, and the escalation is cancelled once the command closes, so
// nothing is signalled after it even while the process lives on.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { groupMembers, signalOwnedGroup } from "../process";

const DRIVER = path.join(import.meta.dir, "wrangler-driver.ts");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bend-iac-wrangler-process-"));

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

let n = 0;

type Driver = {
  child: ChildProcess;
  dir: string;
  done: Promise<{ code: number | null; signal: string | null; out: string }>;
};

// the driver runs detached, in its own process group, so a wrong group
// signal from the adapter could not reach this test runner
function driver(limits: number[], env: NodeJS.ProcessEnv = process.env): Driver {
  const dir = path.join(scratch, `run${n++}`);
  fs.mkdirSync(dir);

  const child = spawn(process.execPath, [DRIVER, dir, ...limits.map(String)], {
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));

  const done = new Promise<{ code: number | null; signal: string | null; out: string }>((r) =>
    child.on("close", (code, signal) => r({ code, signal, out })),
  );

  return { child, dir, done };
}

const journal = (dir: string) => {
  const f = path.join(dir, "journal.jsonl");

  return fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
};

async function until<T>(f: () => T | undefined, ms: number, what: string): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await Bun.sleep(2)) {
    const v = f();

    if (v !== undefined) return v;
  }

  throw new Error(`timed out waiting for ${what}`);
}

// the Wrangler command's process group, from the adapter's journal
const spawnedPid = (d: Driver): Promise<number> =>
  until(() => journal(d.dir).find((e) => e.phase === "spawned")?.pid, 15_000, "the spawned record");

const config = (d: Driver) => path.join(d.dir, "work", "001-version", "wrangler.json");

// whatever happened: stop the driver (our direct child) and any member of
// the command's group that still carries this case's config path. Never
// throws, so it cannot hide the case's own failure; if ps cannot run,
// nothing is verified and the group is not signalled.
function cleanup(d: Driver, pgid: number | null) {
  if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill("SIGKILL");

  if (pgid === null || !Number.isSafeInteger(pgid) || pgid <= 1) return;

  try {
    if (groupMembers(pgid).some((p) => p.command.includes(config(d))))
      process.kill(-pgid, "SIGKILL");
  } catch {
    /* gone, or not verifiable */
  }
}

// signal records, and whether any came after the command's end record
function signals(dir: string) {
  const j = journal(dir);
  const end = j.findIndex((e) => e.phase === "end");

  return {
    all: j.filter((e) => e.phase === "signal"),
    afterEnd: j.slice(end + 1).filter((e) => e.phase === "signal"),
    end: j[end],
  };
}

describe("Wrangler adapter: timeouts with real processes (local, no Cloudflare)", () => {
  test("a command that ignores SIGTERM (its group is stopped) gets a verified SIGKILL; the run ends bounded and the group is gone", async () => {
    // timeout 2 s, SIGKILL 1.5 s later, give up 5 s after that; linger 7 s
    const d = driver([2_000, 1_500, 5_000, 7_000]);
    let pgid: number | null = null;

    try {
      const group = await spawnedPid(d);
      pgid = group;
      expect(Number.isSafeInteger(group) && group > 1).toBe(true);
      expect(signalOwnedGroup(group, d.child.pid!, "SIGSTOP")).toBe(true);
      const r = await d.done;
      expect([r.code, r.signal]).toEqual([0, null]);
      const result = JSON.parse(r.out.trim().split("\n")[0]);
      expect(result).toMatchObject({ code: null, signal: "SIGKILL", timedOut: true });
      expect(result.ms).toBeLessThan(2_000 + 1_500 + 5_000);
      const s = signals(d.dir);
      expect(s.all.map((e) => [e.signal, e.pgid, e.basis, e.sent])).toEqual([
        ["SIGTERM", group, "unreaped-leader", true],
        ["SIGKILL", group, "unreaped-leader", true],
      ]);
      expect(s.afterEnd).toEqual([]);
      expect(s.end).toMatchObject({ timedOut: true, signal: "SIGKILL" });
      expect(groupMembers(group)).toEqual([]);
    } finally {
      cleanup(d, pgid);
    }
  }, 60_000);

  test("a command that obeys SIGTERM: the SIGKILL escalation is cancelled when it closes, and nothing is signalled after", async () => {
    // timeout 2 s, SIGKILL would follow 3 s later; the driver lingers 7 s
    const d = driver([2_000, 3_000, 3_000, 7_000]);
    let pgid: number | null = null;
    let stopped = false;

    try {
      const group = await spawnedPid(d);
      pgid = group;
      stopped = signalOwnedGroup(group, d.child.pid!, "SIGSTOP");
      expect(stopped).toBe(true);
      // the adapter's SIGTERM is pending in the stopped group
      await until(
        () => (signals(d.dir).all.length > 0 ? true : undefined),
        30_000,
        "the adapter's SIGTERM",
      );
      expect(signalOwnedGroup(group, d.child.pid!, "SIGCONT")).toBe(true);
      stopped = false;
      const r = await d.done;
      expect([r.code, r.signal]).toEqual([0, null]);
      const result = JSON.parse(r.out.trim().split("\n")[0]);
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe("SIGTERM");
      expect(result.ms).toBeLessThan(2_000 + 3_000);
      const s = signals(d.dir);
      expect(s.all.map((e) => [e.signal, e.pgid, e.basis, e.sent])).toEqual([
        ["SIGTERM", group, "unreaped-leader", true],
      ]);
      // the driver lived 7 s past the close, longer than the 3 s escalation
      expect(s.afterEnd).toEqual([]);
      expect(groupMembers(group)).toEqual([]);
    } finally {
      // never leave a stopped group behind
      if (stopped && pgid !== null) signalOwnedGroup(pgid, d.child.pid!, "SIGCONT");
      cleanup(d, pgid);
    }
  }, 60_000);

  test("a Wrangler that cannot be spawned (pid null) is never signalled: no group 0, the driver survives", async () => {
    // npx is not on this PATH: the spawn itself fails
    const empty = fs.mkdtempSync(path.join(scratch, "nopath-"));
    const d = driver([300, 300, 300, 1_500], { ...process.env, PATH: empty });

    try {
      const r = await d.done;
      expect([r.code, r.signal]).toEqual([0, null]);
      const result = JSON.parse(r.out.trim().split("\n")[0]);
      expect(result.timedOut).toBe(false);
      expect(journal(d.dir).find((e) => e.phase === "spawned")).toMatchObject({ pid: null });
      expect(signals(d.dir).all).toEqual([]);
    } finally {
      cleanup(d, null);
    }
  }, 30_000);
});
