import { describe, expect, test } from "bun:test";
import type { JsonData } from "../../src/json";
import {
  approvalsDoc,
  codes,
  db,
  desiredDoc,
  grantDoc,
  observedDoc,
  planJson,
  scenario,
  worker,
} from "./helpers";

// production holds a protected database bound by a Worker
const prodDb = db("prod-db", "production", { protected: true, location: "enam" });
const prodApi = worker("prod-api", "production", [["DB", "prod-db"]]);

const retire = (
  grant: string[],
  approvals?: Parameters<typeof approvalsDoc>[0],
  env = "production",
) =>
  scenario({
    desired: desiredDoc([]),
    observed: observedDoc([prodDb, prodApi]),
    grant: grantDoc(env, grant),
    approvals: approvals && approvalsDoc(approvals),
  });

describe("adversarial approvals", () => {
  test("a matching approval is accepted (control)", () => {
    const { run, json } = planJson(
      retire(["delete"], [{ action: "delete", resource: "prod-db", environment: "production" }]),
    );

    expect(run.code).toBe(0);
    expect(json.operations).toHaveLength(2);
  });

  test("an approval for another environment does not count, and is refused as stale", () => {
    const { run, json } = planJson(
      retire(["delete"], [{ action: "delete", resource: "prod-db", environment: "staging" }]),
    );

    expect(run.code).toBe(2);
    expect(json.operations).toEqual([]);
    expect(codes(json).sort()).toEqual(["APPROVAL_REQUIRED", "UNUSED_APPROVAL"]);
  });

  test("an approval for another resource does not count", () => {
    const { run, json } = planJson(
      retire(["delete"], [{ action: "delete", resource: "prod-api", environment: "production" }]),
    );

    // prod-api is deleted by this plan, so the approval is used; prod-db still lacks one
    expect(run.code).toBe(3);
    expect(json.problems.map((p: any) => [p.code, p.id])).toEqual([
      ["APPROVAL_REQUIRED", "prod-db"],
    ]);
  });

  test("a delete approval does not authorize a replacement", () => {
    const dir = scenario({
      desired: desiredDoc([{ ...prodDb, location: "weur" }, prodApi]),
      observed: observedDoc([prodDb, prodApi]),
      grant: grantDoc("production", ["create", "update", "delete"]),
      approvals: approvalsDoc([
        { action: "delete", resource: "prod-db", environment: "production" },
      ]),
    });

    const { run, json } = planJson(dir);
    expect(run.code).toBe(2);
    expect(json.operations).toEqual([]);
    expect(json.problems.map((p: any) => [p.code, p.action])).toEqual([
      ["UNUSED_APPROVAL", "delete"],
      ["APPROVAL_REQUIRED", "replace"],
    ]);
  });

  test("a replace approval does not authorize a delete", () => {
    const { run, json } = planJson(
      retire(["delete"], [{ action: "replace", resource: "prod-db", environment: "production" }]),
    );

    expect(run.code).toBe(2);
    expect(codes(json).sort()).toEqual(["APPROVAL_REQUIRED", "UNUSED_APPROVAL"]);
  });

  test("an approval does not widen the grant: delete still needs the delete action", () => {
    const { run, json } = planJson(
      retire(
        ["create", "update"],
        [{ action: "delete", resource: "prod-db", environment: "production" }],
      ),
    );

    expect(run.code).toBe(2);
    expect(json.problems.map((p: any) => [p.code, p.id])).toEqual([
      ["OUT_OF_GRANT", "prod-api"],
      ["OUT_OF_GRANT", "prod-db"],
    ]);
  });

  test("an approval for a plan without destructive steps is refused as unused", () => {
    const dir = scenario({
      desired: desiredDoc([prodDb, prodApi]),
      observed: observedDoc([prodDb, prodApi]),
      grant: grantDoc("production", []),
      approvals: approvalsDoc([
        { action: "delete", resource: "prod-db", environment: "production" },
      ]),
    });

    const { run, json } = planJson(dir);
    expect(run.code).toBe(2);
    expect(codes(json)).toEqual(["UNUSED_APPROVAL"]);
  });

  test("protection declared in the desired graph also guards a replacement", () => {
    const plain = db("ledger", "production", { protected: false, location: "enam" });

    const dir = scenario({
      desired: desiredDoc([{ ...plain, protected: true, location: "weur" }]),
      observed: observedDoc([plain]),
      grant: grantDoc("production", ["create", "update", "delete"]),
    });

    const { run, json } = planJson(dir);
    expect(run.code).toBe(3);
    expect(json.problems.map((p: any) => [p.code, p.action, p.id])).toEqual([
      ["APPROVAL_REQUIRED", "replace", "ledger"],
    ]);
  });

  test("an unprotected database is deleted without approval", () => {
    const dir = scenario({
      desired: desiredDoc([]),
      observed: observedDoc([db("scratch", "staging")]),
      grant: grantDoc("staging", ["delete"]),
    });

    const { run, json } = planJson(dir);
    expect(run.code).toBe(0);
    expect(json.operations.map((o: any) => [o.action, o.id])).toEqual([["delete", "scratch"]]);
  });
});

describe("adversarial grants", () => {
  test("a grant for the wrong environment rejects every touched step", () => {
    const { run, json } = planJson(
      retire(
        ["create", "update", "delete"],
        [{ action: "delete", resource: "prod-db", environment: "production" }],
        "staging",
      ),
    );

    expect(run.code).toBe(2);
    expect(
      json.problems.filter((p: any) => p.code === "OUT_OF_GRANT").map((p: any) => p.id),
    ).toEqual(["prod-api", "prod-db"]);
  });

  test("a replacement needs both create and delete in the grant", () => {
    const plain = db("cache", "staging", { location: "enam" });

    const dir = scenario({
      desired: desiredDoc([{ ...plain, location: "weur" }]),
      observed: observedDoc([plain]),
      grant: grantDoc("staging", ["delete", "update"]),
    });

    const { run, json } = planJson(dir);
    expect(run.code).toBe(2);
    expect(json.problems.map((p: any) => [p.code, p.action])).toEqual([
      ["OUT_OF_GRANT", "replace"],
    ]);
  });

  test("an update needs the update action", () => {
    const dir = scenario({
      desired: desiredDoc([db("cache", "staging", { readReplication: "auto" })]),
      observed: observedDoc([db("cache", "staging")]),
      grant: grantDoc("staging", ["create", "delete"]),
    });

    const { run, json } = planJson(dir);
    expect(run.code).toBe(2);
    expect(json.problems.map((p: any) => [p.code, p.action])).toEqual([["OUT_OF_GRANT", "update"]]);
  });
});

describe("graph validation", () => {
  const run = (
    desired: JsonData[],
    observed: JsonData[] = [],
    allow = ["create", "update", "delete"],
  ) =>
    planJson(
      scenario({
        desired: desiredDoc(desired),
        observed: observedDoc(observed),
        grant: grantDoc("staging", allow),
      }),
    );

  test("duplicate ids in the desired graph are rejected, across kinds", () => {
    const { run: r, json } = run([db("app", "staging"), worker("app", "staging")]);
    expect(r.code).toBe(2);
    expect(codes(json)).toContain("DUPLICATE_ID");
    expect(json.operations).toEqual([]);
  });

  test("duplicate ids in the observed snapshot are rejected", () => {
    const { run: r, json } = run(
      [db("app", "staging")],
      [db("app", "staging"), db("app", "staging")],
    );

    expect(r.code).toBe(2);
    expect(codes(json)).toEqual(["DUPLICATE_OBSERVED_ID"]);
  });

  test("a Worker may not declare one binding name twice", () => {
    const { run: r, json } = run([
      db("a", "staging"),
      db("b", "staging"),
      worker("w", "staging", [
        ["DB", "a"],
        ["DB", "b"],
      ]),
    ]);

    expect(r.code).toBe(2);
    expect(json.problems).toEqual([
      expect.objectContaining({ code: "DUPLICATE_BINDING", worker: "w", binding: "DB" }),
    ]);
  });

  test("a binding to a database this plan deletes is dangling", () => {
    const { run: r, json } = run(
      [worker("w", "staging", [["DB", "a"]])],
      [db("a", "staging"), worker("w", "staging", [["DB", "a"]])],
    );

    expect(r.code).toBe(2);
    expect(codes(json)).toEqual(["DANGLING_BINDING"]);
  });

  test("a binding to a Worker id is dangling (bindings name databases)", () => {
    const { run: r, json } = run([
      worker("other", "staging"),
      worker("w", "staging", [["DB", "other"]]),
    ]);

    expect(r.code).toBe(2);
    expect(codes(json)).toEqual(["DANGLING_BINDING"]);
  });

  test("an id may not change kind", () => {
    const { run: r, json } = run([worker("x", "staging")], [db("x", "staging")]);
    expect(r.code).toBe(2);
    expect(codes(json)).toEqual(["KIND_CHANGE"]);
  });

  test("an id may not change environment", () => {
    const { run: r, json } = run([db("x", "production")], [db("x", "staging")]);
    expect(r.code).toBe(2);
    expect(codes(json)).toContain("ENV_CHANGE");
  });

  test("a plan may not remove protection", () => {
    const { run: r, json } = run(
      [db("x", "staging", { protected: false })],
      [db("x", "staging", { protected: true })],
    );

    expect(r.code).toBe(2);
    expect(codes(json)).toEqual(["UNPROTECT_REFUSED"]);
  });

  test("a plan may add protection, as an update", () => {
    const { run: r, json } = run([db("x", "staging", { protected: true })], [db("x", "staging")]);
    expect(r.code).toBe(0);
    expect(json.operations.map((o: any) => [o.action, o.reasons])).toEqual([
      ["update", ["protected"]],
    ]);
  });
});

describe("ordering", () => {
  test("a mixed plan follows the four phases", () => {
    const dir = scenario({
      desired: desiredDoc([
        db("new-db", "staging"),
        db("kept", "staging", { readReplication: "auto" }),
        worker("api", "staging", [["DB", "new-db"]]),
        worker("fresh", "staging", [["DB", "kept"]]),
      ]),
      observed: observedDoc([
        db("kept", "staging"),
        db("old-db", "staging"),
        worker("api", "staging", [["DB", "old-db"]]),
        worker("legacy", "staging", [["DB", "old-db"]]),
      ]),
      grant: grantDoc("staging", ["create", "update", "delete"]),
    });

    const { run, json } = planJson(dir);
    expect(run.code).toBe(0);
    expect(json.operations.map((o: any) => `${o.action} ${o.id}`)).toEqual([
      "delete legacy", // 1. consumers that leave go first
      "update kept", // 2. databases created/updated/replaced
      "create new-db",
      "update api", // 3. Workers created/updated (api now binds new-db)
      "create fresh",
      "delete old-db", // 4. databases removed last, after nothing binds them
    ]);
  });
});
