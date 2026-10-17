// Toolchain integration, differential test of the JS backend: for every
// example, the planner compiled to JS by the pinned Bend 2 (what the CLI
// runs) and the same planner evaluated by Bend's checker (normalization of
// `main = plan(<input>)`, a real scripts/bend.sh run) must agree exactly.
// This narrows, but does not remove, the trust placed in the JS emitter:
// it covers these inputs only.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { encode } from "../../src/codec";
import { bendCommit, isFresh, load, ROOT } from "../../src/engine";
import { parseApprovals, parseDesired, parseGrant, parseObserved } from "../../src/schema";
import { toBend } from "../../src/term";

const DIR = path.join(ROOT, ".build", "differential");

const examples = fs
  .readdirSync(path.join(ROOT, "examples"))
  .filter((d) => fs.existsSync(path.join(ROOT, "examples", d, "desired.json")))
  .sort();

function inputs(ex: string) {
  const r = (f: string) => fs.readFileSync(path.join(ROOT, "examples", ex, f), "utf8");
  const des = parseDesired(r("desired.json"));
  const obs = parseObserved(r("observed.json"), des.environments);
  const grant = parseGrant(r("grant.json"), des.environments);

  const apps = fs.existsSync(path.join(ROOT, "examples", ex, "approvals.json"))
    ? parseApprovals(r("approvals.json"), des.environments)
    : [];

  return encode(des, obs, grant, apps);
}

describe("differential: compiled JS planner vs Bend checker evaluation", () => {
  test("the compiled planner under test is the proof-gated build (bend2 + --verdict) of the current sources", async () => {
    const planner = await load();
    expect(isFresh()).toBe(true);
    expect(planner.stamp.proofs).toBe("verdict");
    expect(planner.stamp.bendCommit).toBe(bendCommit());
  });

  test.each(examples)("%s", async (ex) => {
    const planner = await load();
    const enc = inputs(ex);
    const js = toBend(planner.plan(...enc.args));
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, `${ex}.bend`);
    const args = enc.args.map((a) => toBend(a, "P.")).join(", ");
    fs.writeFileSync(
      file,
      `import Base\nimport ../../core/planner.bend as P\n\ndef main() -> P.Outcome:\n  P.plan(${args})\n`,
    );

    const r = spawnSync(path.join(ROOT, "scripts", "bend.sh"), [path.relative(ROOT, file)], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const checker = r.stdout.trim().replaceAll("../../core/planner.", "");
    expect(checker).toBe(js);
  });
});
