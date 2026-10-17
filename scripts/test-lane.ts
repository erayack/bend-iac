// npm run test:e2e / npm run test:integration: one complete test lane.
//
//   bun scripts/test-lane.ts e2e          bin/bend-iac in subprocesses (test/e2e)
//   bun scripts/test-lane.ts integration  compiled planner vs Bend checker,
//                                         random laws (test/integration), then
//                                         the mutation run (scripts/mutation.ts)
//
// Both lanes first require the pinned toolchain, BendTT kernel included,
// and a planner built behind bend2 + --verdict (rebuilt if stale or built
// without the kernel; a no-op when fresh). A lane fails if anything is
// missing, if any test fails, is skipped or is a todo, or if fewer test
// files ran than the lane's directory holds. Nothing is mocked or stubbed.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { build, EngineError, isFresh, readStamp } from "../src/engine";
import { checkPinnedToolchain } from "./toolchain";

const ROOT = path.resolve(import.meta.dir, "..");
const LANES = ["e2e", "integration"] as const;
const lane = LANES.find((l) => l === process.argv[2]);

if (lane === undefined) {
  console.error(`usage: bun scripts/test-lane.ts ${LANES.join("|")}`);
  process.exit(64);
}

const fail = (msg: string): never => {
  console.error(`test:${lane}: FAILED: ${msg}`);
  process.exit(1);
};

try {
  console.log(`toolchain: ${checkPinnedToolchain()}`);

  if (!isFresh() || readStamp()?.proofs !== "verdict") build((s) => console.log(s));
} catch (e) {
  fail(e instanceof EngineError || e instanceof Error ? e.message : String(e));
}

const stamp = readStamp();

if (!isFresh() || stamp?.proofs !== "verdict")
  fail(`planner is not a fresh --verdict build (stamp: ${JSON.stringify(stamp)})`);

console.log(`planner: .build/planner.mjs, proofs ${stamp!.proofs}, bend ${stamp!.bendCommit}`);

const dir = path.join("test", lane);
const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".test.ts"));

console.log(`\n$ bun test ./${dir}`);

const r = spawnSync("bun", ["test", `./${dir}`], { cwd: ROOT, encoding: "utf8" });

process.stdout.write(r.stdout ?? "");

process.stderr.write(r.stderr ?? "");

const out = (r.stdout ?? "") + (r.stderr ?? "");
const count = (what: string) => Number(new RegExp(`^\\s*(\\d+) ${what}$`, "m").exec(out)?.[1] ?? 0);
const ran = /^Ran (\d+) tests? across (\d+) files?/m.exec(out);

if (r.status !== 0) fail(`bun test exited ${r.status}`);

if (count("fail") !== 0) fail(`${count("fail")} failing tests`);

if (count("skip") !== 0 || count("todo") !== 0)
  fail(`${count("skip")} skipped and ${count("todo")} todo tests`);

if (!ran || Number(ran[1]) === 0) fail("no tests ran");

if (Number(ran![2]) !== files.length) fail(`ran ${ran![2]} files, ${dir} holds ${files.length}`);

if (lane === "integration") {
  console.log("\n$ bun scripts/mutation.ts");
  const m = spawnSync("bun", ["scripts/mutation.ts"], { cwd: ROOT, stdio: "inherit" });

  if (m.status !== 0) fail(`mutation run exited ${m.status}`);
}

console.log(
  `\ntest:${lane}: ${ran![1]} tests in ${ran![2]} files passed, none skipped${lane === "integration" ? "; all mutants caught" : ""}`,
);
