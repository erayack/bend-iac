// npm test: the single local entry point. Runs, in order and offline:
//   1. check:proofs      pins, LAWS.bend hash, escape-hatch scan, bend2 and
//                        --verdict on PROOF.bend and EXAMPLES.bend
//   2. build             the proof-gated compile of core/planner.bend
//   3. test:e2e          bin/bend-iac in subprocesses: plan scenarios,
//                        grants, approvals, ordering, invalid input, CLI
//                        errors, determinism, missing toolchain
//   4. test:integration  real toolchain: compiled planner vs Bend checker
//                        (examples, random inputs), random laws, then the
//                        mutation run (planner mutants must be rejected)
// Both test lanes re-check the pinned toolchain and the --verdict stamp of
// the stage-2 build; that is cheap, and they do not rebuild a fresh planner.
// Exit 0 only when every stage passes.
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

const stages: [string, string[]][] = [
  ["check:proofs", ["bun", "scripts/check-proofs.ts"]],
  ["build", ["bun", "scripts/build.ts"]],
  ["test:e2e", ["bun", "scripts/test-lane.ts", "e2e"]],
  ["test:integration", ["bun", "scripts/test-lane.ts", "integration"]],
];

const results: [string, boolean, number][] = [];

for (const [name, [cmd, ...args]] of stages) {
  console.log(`\n=== ${name}: ${[cmd, ...args].join(" ")}`);
  const t = performance.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  results.push([name, r.status === 0, Math.round(performance.now() - t)]);

  if (r.status !== 0 && name === "build") break; // nothing else is meaningful without the planner
}

console.log("\n=== summary");

for (const [name, ok, ms] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${ms} ms)`);

const ok = results.length === stages.length && results.every(([, o]) => o);

console.log(ok ? "\nnpm test: all stages passed" : "\nnpm test: FAILED");

process.exit(ok ? 0 : 1);
