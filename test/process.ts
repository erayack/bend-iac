// Process control for the lanes that signal a real child process group.
// This is test code, independent of src/live: each signal goes to a group
// only after a fresh `ps` shows that its leader still exists, leads its own
// group (pid = pgid) and is a child of the expected parent, plus any extra
// check the caller passes. A group that fails the check is not signalled.
// The check and kill(2) remain two steps; see docs/live.md.
import { spawnSync } from "node:child_process";

export type Proc = { pid: number; ppid: number; pgid: number; command: string };

export function processes(): Proc[] {
  const r = spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
  });

  if (r.status !== 0) throw new Error(`ps exited ${r.status}`);

  return r.stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);

    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] }] : [];
  });
}

export const groupMembers = (pgid: number) => processes().filter((p) => p.pgid === pgid);

// the group's leader, if it is now a child of `parent` leading group `pgid`
export function ownedLeader(pgid: number, parent: number): Proc | null {
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || !Number.isSafeInteger(parent) || parent <= 1)
    return null;

  return processes().find((p) => p.pid === pgid && p.pgid === pgid && p.ppid === parent) ?? null;
}

// sends `sig` to group `pgid` only if a fresh check verifies it; returns whether it did
export function signalOwnedGroup(
  pgid: number,
  parent: number,
  sig: NodeJS.Signals,
  also: (leader: Proc) => boolean = () => true,
): boolean {
  const leader = ownedLeader(pgid, parent);

  if (leader === null || !also(leader)) return false;

  try {
    process.kill(-pgid, sig);

    return true;
  } catch {
    return false;
  }
}
