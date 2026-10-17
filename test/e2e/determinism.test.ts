import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cli, EX, scenario } from "./helpers";

const read = (dir: string, f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

describe("determinism", () => {
  test("the same inputs give byte-identical output", () => {
    for (const ex of ["01-create", "08-protected-delete-approved", "11-dependency-safe-removal"]) {
      const a = cli("plan", EX(ex), "--json");
      const b = cli("plan", EX(ex), "--json");
      expect(a.code).toBe(0);
      expect(b.out).toBe(a.out);
    }
  });

  test("resource, binding and approval order in the files does not change the plan", () => {
    const ex = EX("10-protected-replace-approved");
    const des = read(ex, "desired.json");
    const obs = read(ex, "observed.json");
    des.resources.reverse();
    obs.resources.reverse();

    for (const r of [...des.resources, ...obs.resources]) if (r.bindings) r.bindings.reverse();

    const dir = scenario({
      desired: des,
      observed: obs,
      grant: read(ex, "grant.json"),
      approvals: read(ex, "approvals.json"),
    });

    expect(cli("plan", dir, "--json").out).toBe(cli("plan", ex, "--json").out);
  });

  test("reordering bindings is not an update", () => {
    const ex = EX("02-noop");
    const des = read(ex, "desired.json");
    const w = des.resources.find((r: any) => r.type === "worker");
    w.bindings.push({ name: "AUDIT", database: "app-db" });
    const obs = read(ex, "observed.json");
    const ow = obs.resources.find((r: any) => r.type === "worker");
    ow.bindings.unshift({ name: "AUDIT", database: "app-db" });

    const run = cli(
      "plan",
      scenario({ desired: des, observed: obs, grant: read(ex, "grant.json") }),
      "--json",
    );

    expect(run.code).toBe(0);
    expect(JSON.parse(run.out).operations).toEqual([]);
  });
});
