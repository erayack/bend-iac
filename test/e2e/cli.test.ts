import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cli, EX, planJson, ROOT, run } from "./helpers";

describe("plan: engine", () => {
  test("plans come from the pinned planner, gated by bend2 and the BendTT kernel, over a fixture snapshot", () => {
    const commit = /BEND_COMMIT=(\w+)/.exec(
      fs.readFileSync(path.join(ROOT, "toolchain.env"), "utf8"),
    )![1];

    const { run, json } = planJson(EX("01-create"));
    expect(run.code).toBe(0);
    expect(json.engine).toEqual({
      planner: "core/planner.bend",
      bendCommit: commit,
      proofs: "verdict",
    });
    expect(json.observation).toBe("fixture");
  });
});

describe("plan: create", () => {
  test("creates the database before the Worker that binds it", () => {
    const { run, json } = planJson(EX("01-create"));
    expect(run.code).toBe(0);
    expect(json.outcome).toBe("approved");
    expect(json.operations.map((o: any) => [o.action, o.type, o.id, o.environment])).toEqual([
      ["create", "d1_database", "app-db", "staging"],
      ["create", "worker", "api", "staging"],
    ]);
  });
});

describe("plan: no changes", () => {
  test("an unchanged graph yields an approved, empty plan even with an empty grant", () => {
    const { run, json } = planJson(EX("02-noop"));
    expect(run.code).toBe(0);
    expect(json.outcome).toBe("approved");
    expect(json.operations).toEqual([]);
    expect(json.summary).toContain("no changes");
  });
});

describe("plan: update", () => {
  test("mutable property changes become in-place updates with their reasons", () => {
    const { run, json } = planJson(EX("03-update"));
    expect(run.code).toBe(0);
    expect(json.operations.map((o: any) => [o.action, o.type, o.id, o.reasons])).toEqual([
      ["update", "d1_database", "app-db", ["readReplication"]],
      ["update", "worker", "api", ["main", "compatibilityDate"]],
    ]);
  });

  test("the human summary shows old and new values", () => {
    const run = cli("plan", EX("03-update"));
    expect(run.code).toBe(0);
    expect(run.out).toContain("main: src/api.ts -> src/api-v2.ts");
    expect(run.out).toContain("readReplication: disabled -> auto");
  });
});

describe("plan: environment isolation", () => {
  test("operations outside the grant's environment reject the whole plan", () => {
    const { run, json } = planJson(EX("04-cross-env-grant"));
    expect(run.code).toBe(2);
    expect(json.outcome).toBe("rejected");
    expect(json.executable).toBe(false);
    expect(json.operations).toEqual([]);
    expect(json.problems.map((p: any) => [p.code, p.action, p.id, p.environment])).toEqual([
      ["OUT_OF_GRANT", "create", "prod-db", "production"],
      ["OUT_OF_GRANT", "create", "prod-api", "production"],
    ]);
  });

  test("a Worker may not bind a database of another environment", () => {
    const { run, json } = planJson(EX("05-cross-env-binding"));
    expect(run.code).toBe(2);
    expect(json.operations).toEqual([]);
    expect(json.problems[0]).toMatchObject({
      code: "CROSS_ENV_BINDING",
      worker: "api",
      binding: "DB",
      database: "prod-db",
    });
  });
});

describe("plan: binding validity", () => {
  test("a binding to an undeclared database is rejected, and nothing runs", () => {
    const { run, json } = planJson(EX("06-dangling-binding"));
    expect(run.code).toBe(2);
    expect(json.operations).toEqual([]);
    expect(json.problems).toEqual([
      expect.objectContaining({
        code: "DANGLING_BINDING",
        worker: "api",
        binding: "CACHE_DB",
        database: "ghost-db",
      }),
    ]);
  });
});

describe("plan: protected deletion", () => {
  test("deleting a protected database without approval requires approval, and nothing runs", () => {
    const { run, json } = planJson(EX("07-protected-delete-unapproved"));
    expect(run.code).toBe(3);
    expect(json.outcome).toBe("approval_required");
    expect(json.operations).toEqual([]);
    expect(json.problems.map((p: any) => [p.code, p.action, p.id, p.environment])).toEqual([
      ["APPROVAL_REQUIRED", "delete", "prod-db", "production"],
    ]);
  });

  test("the same plan with a matching approval is approved, consumers deleted first", () => {
    const { run, json } = planJson(EX("08-protected-delete-approved"));
    expect(run.code).toBe(0);
    expect(json.operations.map((o: any) => [o.action, o.type, o.id, o.environment])).toEqual([
      ["delete", "worker", "prod-api", "production"],
      ["delete", "d1_database", "prod-db", "production"],
    ]);
  });

  test("replacing a protected database (location change) counts as destructive", () => {
    const { run, json } = planJson(EX("09-protected-replace-unapproved"));
    expect(run.code).toBe(3);
    expect(json.operations).toEqual([]);
    expect(json.problems.map((p: any) => [p.code, p.action, p.id])).toEqual([
      ["APPROVAL_REQUIRED", "replace", "prod-db"],
    ]);
  });

  test("an approved replacement rebinds its Workers after the new database exists", () => {
    const { run, json } = planJson(EX("10-protected-replace-approved"));
    expect(run.code).toBe(0);
    expect(json.operations.map((o: any) => [o.action, o.type, o.id, o.reasons])).toEqual([
      ["replace", "d1_database", "prod-db", ["location"]],
      ["update", "worker", "prod-api", ["rebind"]],
    ]);
  });
});

describe("plan: dependency-safe removal", () => {
  test("bindings are removed and dependents deleted before the database", () => {
    const { run, json } = planJson(EX("11-dependency-safe-removal"));
    expect(run.code).toBe(0);
    expect(json.operations.map((o: any) => [o.action, o.type, o.id, o.reasons])).toEqual([
      ["delete", "worker", "jobs", []],
      ["update", "worker", "api", ["bindings"]],
      ["delete", "d1_database", "app-db", []],
    ]);
  });
});

describe("plan: readable approvals", () => {
  test("an approved destructive step names its approver and reason", () => {
    const run = cli("plan", EX("08-protected-delete-approved"));
    expect(run.code).toBe(0);
    expect(run.out).toMatch(
      /delete\s+d1_database\s+prod-db\s+\[production\]\s+protected; approved by dba@example.com: retire the production app/,
    );
  });
});

describe("cli: executable names", () => {
  test("bin/bend-iac is the public name; bin/bend-infra is a compatibility alias with identical output", () => {
    expect(cli("help").out).toContain("bend-iac plan <dir>");
    expect(cli("version").out).toMatch(/^bend-iac 0\.1\.0 /);
    const legacy = path.join(ROOT, "bin", "bend-infra");

    for (const args of [
      ["plan", EX("01-create"), "--json"],
      ["plan", EX("07-protected-delete-unapproved")],
      ["version"],
    ]) {
      const now = cli(...args);
      expect(run(legacy, ...args)).toEqual(now);
    }
  });
});
