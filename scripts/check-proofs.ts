// npm run check:proofs: every check that concerns the Bend sources.
//
//   1. the toolchain is the pinned one (bend commit, kernel source)
//   2. LAWS.bend is unchanged (sha256 in LAWS.sha256): laws are never
//      weakened silently to fit the implementation
//   3. no escape hatches in our Bend files: no @unsafe, no `def f?(`, no
//      holes (?name, ?TODO), no foreign imports, no `law` outside LAWS.bend
//   4. bend2 checks the planner, PROOF.bend and EXAMPLES.bend; LAWS.bend
//      alone has exactly its three open claims
//   5. --verdict: BendTT's kernel re-checks PROOF.bend and EXAMPLES.bend
//   6. the exported kernel translation states each law about the planner's
//      own `plan`
//
// Prints a report and writes .build/proof-report.json. Exit 0 iff all pass.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkPinnedToolchain, pin } from "./toolchain";

const ROOT = path.resolve(import.meta.dir, "..");
const BEND = path.join(ROOT, "scripts", "bend.sh");
const LAWS = ["env_isolation", "binding_validity", "protected_deletion"];
const OWN = ["core/planner.bend", "LAWS.bend", "PROOF.bend", "EXAMPLES.bend"];

type Step = { name: string; ok: boolean; detail: string; ms: number };

const steps: Step[] = [];

function step(name: string, f: () => string) {
  const t = performance.now();
  let ok = true;
  let detail: string;

  try {
    detail = f();
  } catch (e) {
    ok = false;
    detail = e instanceof Error ? e.message : String(e);
  }

  const ms = Math.round(performance.now() - t);
  steps.push({ name, ok, detail, ms });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${ms} ms)`);

  for (const l of detail.trim().split("\n")) if (l) console.log(`      ${l}`);
}

type BendRun = { code: number; out: string };

function bend(...args: string[]): BendRun {
  const r = spawnSync(BEND, args, { cwd: ROOT, encoding: "utf8" });

  return { code: r.status ?? 1, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

function expectPass(file: string, verdict = false): string {
  const r = verdict ? bend(file, "--verdict") : bend(file);
  const want = verdict ? r.out === "ALL PROOFS CHECK" : r.out.startsWith("ALL PROOFS CHECK");

  if (r.code !== 0 || !want)
    throw new Error(`bend ${file}${verdict ? " --verdict" : ""} -> exit ${r.code}\n${r.out}`);

  return `bend ${file}${verdict ? " --verdict" : ""}: ${r.out.split("\n")[0]}`;
}

const sha = (f: string) =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(ROOT, f)))
    .digest("hex");

step("toolchain is the pinned one", checkPinnedToolchain);

step("LAWS.bend matches LAWS.sha256", () => {
  const want = fs.readFileSync(path.join(ROOT, "LAWS.sha256"), "utf8").trim().split(/\s+/)[0];
  const got = sha("LAWS.bend");

  if (got !== want)
    throw new Error(
      `LAWS.bend sha256 ${got} != LAWS.sha256 ${want}: a law changed; review it and update LAWS.sha256 deliberately`,
    );

  return `sha256 ${got}`;
});

step("no escape hatches in our Bend files", () => {
  const bad: string[] = [];

  for (const f of OWN) {
    fs.readFileSync(path.join(ROOT, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        const code = line.replace(/#.*$/, "");

        const hit = (re: RegExp, why: string) =>
          re.test(code) && bad.push(`${f}:${i + 1}: ${why}: ${line.trim()}`);

        hit(/@unsafe/, "@unsafe");
        hit(/^def\s+[\w.]+\?\(/, "unchecked recursion (def f?)");
        hit(/\?[A-Za-z_]/, "a hole");
        hit(/^\s*import\s+"/, "a foreign import");
        hit(/^\s*import\s+0x/, "a hub import");

        if (f !== "LAWS.bend") hit(/^law\s/, "a law outside LAWS.bend (an unproven axiom?)");
      });
  }

  const laws = [
    ...fs.readFileSync(path.join(ROOT, "LAWS.bend"), "utf8").matchAll(/^law\s+(\w+):/gm),
  ].map((m) => m[1]);

  if (JSON.stringify(laws) !== JSON.stringify(LAWS))
    bad.push(`LAWS.bend declares [${laws}], expected [${LAWS}]`);
  const proof = fs.readFileSync(path.join(ROOT, "PROOF.bend"), "utf8");

  for (const l of LAWS)
    if (!new RegExp(`^def Laws\\.${l}\\(`, "m").test(proof))
      bad.push(`PROOF.bend does not define Laws.${l}`);

  if (bad.length) throw new Error(bad.join("\n"));

  return `scanned ${OWN.join(", ")}; laws: ${laws.join(", ")}`;
});

step("bend2 checks core/planner.bend (types, linearity, termination)", () =>
  expectPass("core/planner.bend"),
);

step("LAWS.bend alone leaves exactly its 3 laws open", () => {
  const r = bend("LAWS.bend");

  if (r.code === 0 || !r.out.includes("3 TODOs found")) throw new Error(r.out);

  return r.out.replace(/\n/g, " ");
});

step("bend2 checks PROOF.bend", () => expectPass("PROOF.bend"));

step("BendTT kernel checks PROOF.bend (--verdict)", () => expectPass("PROOF.bend", true));

step("bend2 checks EXAMPLES.bend (finite examples, law instances)", () =>
  expectPass("EXAMPLES.bend"),
);

step("BendTT kernel checks EXAMPLES.bend (--verdict)", () => expectPass("EXAMPLES.bend", true));

step("kernel translation states each law about core/planner.bend's plan", () => {
  fs.mkdirSync(path.join(ROOT, ".build"), { recursive: true });
  const out = path.join(".build", "PROOF.bendtt");
  const r = bend("PROOF.bend", "-o", out);

  if (r.code !== 0) throw new Error(r.out);
  const text = fs.readFileSync(path.join(ROOT, out), "utf8");
  const lines: string[] = [];

  for (const l of LAWS) {
    const decl = text.split("\n").find((x) => x.startsWith(`LAWS.${l} :`));

    if (!decl || !decl.includes("(core_2f_planner.plan +x0 +x1 +x2 +x3)"))
      throw new Error(`LAWS.${l} is not stated over core_2f_planner.plan:\n${decl}`);
    lines.push(decl.replace(/ =\s*$/, ""));
  }

  return `wrote ${out} (${text.length} bytes)\n` + lines.join("\n");
});

fs.mkdirSync(path.join(ROOT, ".build"), { recursive: true });

fs.writeFileSync(
  path.join(ROOT, ".build", "proof-report.json"),
  JSON.stringify({ bendCommit: pin("BEND_COMMIT"), steps }, null, 2) + "\n",
);

const failed = steps.filter((s) => !s.ok).length;

console.log(
  failed === 0
    ? `\ncheck:proofs: all ${steps.length} checks passed`
    : `\ncheck:proofs: ${failed} of ${steps.length} checks FAILED`,
);

process.exit(failed === 0 ? 0 : 1);
