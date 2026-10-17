// The engine: the Bend planner, compiled by the pinned Bend 2 compiler to
// an ES module that exports every non-IO def of core/planner.bend.
//
// build() refuses to emit the module unless the proofs check first: it
// runs `bend PROOF.bend` (and `--verdict` when the local BendTT kernel is
// built), then `bend core/planner.bend -o .build/planner.mjs`. A stamp
// records the sha256 of the sources it built from; when core, laws,
// proofs or the toolchain pin change, the next plan rebuilds. So the
// planner the CLI runs is always the one the laws were proven about, up
// to the trust in Bend's JS backend (see docs/proofs.md, "Verification coverage").

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BendTerm, PlanArgs } from "./codec";
import { JsonReader, parseStrict, type JsonValue } from "./json";

export const ROOT = path.resolve(import.meta.dir, "..");
const BUILD = path.join(ROOT, ".build");
const MODULE = path.join(BUILD, "planner.mjs");
const STAMP = path.join(BUILD, "stamp.json");
const BEND = path.join(ROOT, "scripts", "bend.sh");
const KERNEL = path.join(ROOT, ".toolchain", "bendtt", "bendtt");
export const SOURCES = ["core/planner.bend", "LAWS.bend", "PROOF.bend", "toolchain.env"];

export class EngineError extends Error {}

export type Stamp = {
  sources: Record<string, string>;
  bendCommit: string;
  proofs: "checked" | "verdict";
};

export function bendCommit(): string {
  const env = fs.readFileSync(path.join(ROOT, "toolchain.env"), "utf8");

  return /^BEND_COMMIT=(\w+)$/m.exec(env)?.[1] ?? "unknown";
}

function digests(): Record<string, string> {
  return Object.fromEntries(
    SOURCES.map((f) => [
      f,
      createHash("sha256")
        .update(fs.readFileSync(path.join(ROOT, f)))
        .digest("hex"),
    ]),
  );
}

export type BendRun = { code: number; out: string };

export function bend(args: string[], cwd = ROOT): BendRun {
  const r = spawnSync(BEND, args, { cwd, encoding: "utf8" });

  if (r.error) throw new EngineError(`cannot run ${BEND}: ${r.error.message}`);

  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function stampFrom(v: JsonValue): Stamp {
  const r = new JsonReader((where, detail) => {
    throw new EngineError(`${STAMP}: ${where}: ${detail}`);
  });

  const o = r.object(v, "(root)", ["sources", "bendCommit", "proofs"]);

  return {
    sources: Object.fromEntries(
      [...r.fields(o.get("sources"), "sources")].map(([f, x]) => [f, r.string(x, `sources.${f}`)]),
    ),
    bendCommit: r.string(o.get("bendCommit"), "bendCommit"),
    proofs: r.oneOf(o.get("proofs"), "proofs", ["checked", "verdict"] as const),
  };
}

// The stamp of the last build, or null when there is none or it is not one
// this build wrote (then the planner is stale and is rebuilt).
export function readStamp(): Stamp | null {
  try {
    return stampFrom(parseStrict(fs.readFileSync(STAMP, "utf8")));
  } catch {
    return null;
  }
}

export function isFresh(): boolean {
  const s = readStamp();

  return (
    s !== null && fs.existsSync(MODULE) && JSON.stringify(s.sources) === JSON.stringify(digests())
  );
}

export function build(log: (s: string) => void = () => {}): Stamp {
  if (!fs.existsSync(path.join(ROOT, ".toolchain", "bend", "bend2", "main.ts"))) {
    throw new EngineError(
      "the pinned Bend toolchain is missing: run `npm run bootstrap` (scripts/bootstrap.sh)",
    );
  }

  const sources = digests();
  const check = bend(["PROOF.bend"]);

  if (check.code !== 0 || !check.out.includes("ALL PROOFS CHECK")) {
    throw new EngineError("refusing to build: PROOF.bend does not check\n" + check.out.trim());
  }

  let proofs: Stamp["proofs"] = "checked";

  if (fs.existsSync(KERNEL)) {
    const v = bend(["PROOF.bend", "--verdict"]);

    if (v.code !== 0 || v.out.trim() !== "ALL PROOFS CHECK") {
      throw new EngineError("refusing to build: PROOF.bend --verdict failed\n" + v.out.trim());
    }

    proofs = "verdict";
  }

  log(
    `proofs: ${proofs === "verdict" ? "bend2 checker + BendTT kernel (--verdict)" : "bend2 checker only (no kernel built)"}`,
  );
  fs.mkdirSync(BUILD, { recursive: true });
  const tmp = path.join(BUILD, `planner.${process.pid}.tmp.mjs`);
  const out = bend(["core/planner.bend", "-o", tmp]);

  if (out.code !== 0 || !fs.existsSync(tmp)) {
    fs.rmSync(tmp, { force: true });
    throw new EngineError("compiling core/planner.bend failed\n" + out.out.trim());
  }

  fs.renameSync(tmp, MODULE);
  const stamp: Stamp = { sources, bendCommit: bendCommit(), proofs };
  const stmp = path.join(BUILD, `stamp.${process.pid}.tmp`);
  fs.writeFileSync(stmp, JSON.stringify(stamp, null, 2) + "\n");
  fs.renameSync(stmp, STAMP);
  log(
    `built ${path.relative(ROOT, MODULE)} from core/planner.bend (bend ${stamp.bendCommit.slice(0, 12)})`,
  );

  return stamp;
}

export type PlanFn = (...args: PlanArgs) => BendTerm;

export type Planner = { plan: PlanFn; stamp: Stamp };

// The one trusted boundary of the bridge: the compiled module is generated
// JavaScript, which TypeScript cannot type. Its `plan` must be a function;
// the codec passes it typed arguments, and readOutcome() checks every term
// it returns before anything uses it (docs/proofs.md, "Verification coverage").
export async function planFrom(file: string): Promise<PlanFn> {
  const mod = await import(file);

  if (!(mod.default?.plan instanceof Function))
    throw new EngineError(`${file} does not export plan`);

  // SAFETY: trusted generated code. `file` is Bend's JS compilation of
  // core/planner.bend (the proof-gated build, or a mutation run's scratch
  // copy); its plan takes State, State, Grant and List<Approval> and returns
  // an Outcome. The declared result is only BendTerm, which decode() and
  // readOutcome() check.
  return mod.default.plan as PlanFn;
}

export async function load(): Promise<Planner> {
  const stamp = (isFresh() ? readStamp() : null) ?? build();

  return { plan: await planFrom(MODULE), stamp };
}
