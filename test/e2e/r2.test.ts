import { expect, test } from "bun:test";
import { BIN, cli, EX, planJson, scenario, desiredDoc, observedDoc, grantDoc } from "./helpers";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import { parseDesired } from "../../src/schema";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonData } from "../../src/json";

test("R2 mixed creation orders both providers before their Worker", () => {
  const { run, json } = planJson(EX("12-r2-mixed-create"));
  expect(run.code).toBe(0);
  expect(json.operations.map((o: { type: string }) => o.type)).toEqual([
    "d1_database",
    "r2_bucket",
    "worker",
  ]);
  expect(cli("plan", EX("12-r2-mixed-create")).out).toContain("ASSETS->assets");
});

const outcomes: [string, number, string][] = [
  ["13-r2-mixed-delete", 0, ""],
  ["14-r2-cross-env-grant", 2, "OUT_OF_GRANT"],
  ["15-r2-cross-env-binding", 2, "CROSS_ENV_BUCKET_BINDING"],
  ["16-r2-missing-target", 2, "DANGLING_BUCKET_BINDING"],
  ["17-r2-wrong-kind-target", 2, "DANGLING_BUCKET_BINDING"],
  ["18-d1-wrong-r2-target", 2, "DANGLING_BINDING"],
  ["19-r2-duplicate-binding", 2, "DUPLICATE_BINDING"],
  ["20-r2-duplicate-id", 2, "DUPLICATE_ID"],
  ["21-r2-unprotect", 2, "UNPROTECT_REFUSED"],
  ["22-r2-protected-delete", 3, "APPROVAL_REQUIRED"],
  ["23-r2-wrong-approval", 2, "UNUSED_APPROVAL"],
  ["24-r2-approved-delete", 0, ""],
  ["25-r2-protection-update", 0, ""],
  ["26-r2-noop", 0, ""],
  ["27-r2-ambiguous-diagnostics", 2, "DANGLING_BUCKET_BINDING"],
];

test.each(outcomes)("%s has the documented outcome", (name, code, problem) => {
  const { run, json } = planJson(EX(name));
  expect(run.code).toBe(code);

  if (problem) expect(json.problems.map((p: { code: string }) => p.code)).toContain(problem);
  expect(planJson(EX(name)).run.out).toBe(run.out);
});

test("R2 deletion, approval text, protection metadata and no-op reports", () => {
  expect(
    planJson(EX("13-r2-mixed-delete")).json.operations.map((o: { type: string }) => o.type),
  ).toEqual(["worker", "d1_database", "r2_bucket"]);
  expect(cli("plan", EX("24-r2-approved-delete")).out).toContain(
    "approved by reviewer@example.com",
  );
  expect(planJson(EX("25-r2-protection-update")).json.operations[0].reasons).toEqual(["protected"]);
  expect(cli("plan", EX("25-r2-protection-update")).out).toContain("protected: false -> true");
  expect(planJson(EX("26-r2-noop")).json.operations).toEqual([]);
  const ps = planJson(EX("27-r2-ambiguous-diagnostics")).json.problems;
  expect(ps).toContainEqual(
    expect.objectContaining({ code: "DANGLING_BUCKET_BINDING", bucket: "missing-bucket" }),
  );
  expect(ps).toContainEqual(
    expect.objectContaining({ code: "DANGLING_BINDING", database: "missing-db" }),
  );
});

// Guard the newly enabled project paths before init or plan can run.
const projectHome = fs.mkdtempSync(path.join(os.tmpdir(), "bend-r2-project-"));
const projectPath = path.join(projectHome, "tools");

fs.mkdirSync(projectPath);

fs.symlinkSync(process.execPath, path.join(projectPath, "bun"));

fs.symlinkSync("/bin/bash", path.join(projectPath, "bash"));

fs.symlinkSync("/usr/bin/dirname", path.join(projectPath, "dirname"));

process.on("exit", () => fs.rmSync(projectHome, { recursive: true, force: true }));

function guardedProject(...args: string[]) {
  const r = spawnSync(BIN, args, {
    encoding: "utf8",
    env: { HOME: projectHome, PATH: projectPath },
  });

  if (r.error) throw r.error;

  return { code: r.status, out: r.stdout, err: r.stderr };
}

test.each([false, true])("project R2 registration/source boundary stays local", (bindingOnly) => {
  const root = `${scenario({})}/project`;
  const account = "00000000000000000000000000000000";
  expect(
    guardedProject("init", root, "--project", "hello", "--env", "dev", "--account", account).code,
  ).toBe(0);
  const file = path.join(root, "infra/dev/desired.json");

  const resources = bindingOnly
    ? [
        {
          type: "worker",
          id: "api",
          environment: "dev",
          main: "missing.js",
          compatibilityDate: "2026-01-01",
          bindings: [{ name: "ASSETS", bucket: "assets" }],
        },
      ]
    : [{ type: "r2_bucket", id: "assets", environment: "dev", protected: false }];

  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, kind: "bend-infra/desired", environments: ["dev"], resources }),
  );
  const result = guardedProject("plan", "--env", "dev", "--project", root, "--account", account);
  const state = path.join(root, ".bend-iac/dev");
  expect(result.code).toBe(bindingOnly ? 66 : 69);
  expect(result.err).toContain(bindingOnly ? "missing.js" : "npx");

  if (bindingOnly) {
    expect(fs.existsSync(path.join(state, "work"))).toBe(false);
    expect(fs.existsSync(path.join(state, "journal.jsonl"))).toBe(false);
  } else {
    const ledger = JSON.parse(fs.readFileSync(path.join(state, "ledger.json"), "utf8"));
    expect(ledger.version).toBe(2);
    expect(ledger.resources.assets).toMatchObject({
      type: "r2_bucket",
      status: "new",
      bucketCreated: null,
      protected: false,
    });

    const records = fs
      .readFileSync(path.join(state, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));

    expect(records.every((r) => r.purpose === "version")).toBe(true);
    expect(records.filter((r) => r.phase === "start").map((r) => r.mutating)).toEqual([false]);
    expect(records.filter((r) => r.phase === "spawned").every((r) => r.pid === null)).toBe(true);
    expect(fs.readdirSync(path.join(state, "work"))).toEqual(["001-version"]);
  }

  expect(fs.existsSync(path.join(state, "artifacts"))).toBe(false);
  expect(fs.existsSync(path.join(state, "lock"))).toBe(false);
});

const bucket = { type: "r2_bucket", id: "assets", environment: "staging", protected: false };

const worker = (bindings: JsonData[]) => ({
  type: "worker",
  id: "api",
  environment: "staging",
  main: "worker.js",
  compatibilityDate: "2026-01-01",
  bindings,
});

function input(resources: JsonData[]) {
  return scenario({
    desired: desiredDoc(resources),
    observed: observedDoc([]),
    grant: grantDoc("staging", ["create"]),
  });
}

test.each([
  { type: "r2_bucket", id: "assets", environment: "staging" },
  { ...bucket, protected: "false" },
  { ...bucket, location: "enam" },
  { ...bucket, bindings: [] },
])("R2 bucket fields are closed and protected is required", (r) => {
  expect(planJson(input([r])).run.code).toBe(65);
});

test.each([
  { name: "ASSETS" },
  { name: "ASSETS", database: "db", bucket: "assets" },
  { name: "ASSETS", bucket: 42 },
  { name: "ASSETS", bucket: "assets", extra: true },
])("binding target is an exact closed union", (binding) => {
  expect(planJson(input([worker([binding])])).run.code).toBe(65);
});

test("mixed resources and bindings canonicalize independently of document order", () => {
  const dir = EX("12-r2-mixed-create");
  const desired = parseDesired(fs.readFileSync(path.join(dir, "desired.json"), "utf8"));
  desired.resources.reverse();

  for (const r of desired.resources) if (r.type === "worker") r.bindings.reverse();

  const permuted = scenario({
    desired: desiredDoc(desired.resources, desired.environments),
    observed: observedDoc([]),
    grant: grantDoc("staging", ["create"]),
  });

  expect(planJson(permuted).run.out).toBe(planJson(dir).run.out);
});

test("the 32 binding limit is shared across both target kinds", () => {
  const bindings = Array.from({ length: 33 }, (_, i) =>
    i % 2 ? { name: `B${i}`, bucket: "assets" } : { name: `B${i}`, database: "db" },
  );

  expect(planJson(input([worker(bindings)])).run.code).toBe(65);

  const db = {
    type: "d1_database",
    id: "db",
    environment: "staging",
    location: "enam",
    readReplication: "disabled",
    protected: false,
  };

  expect(planJson(input([bucket, db, worker(bindings.slice(0, 32))])).run.code).toBe(0);
});

test.each([bucket, worker([{ name: "ASSETS", bucket: "assets" }])])(
  "live refuses R2 before source/tool/account access",
  (resource) => {
    const dir = scenario({
      desired: desiredDoc([{ ...resource, environment: "e2e" }], ["e2e"]),
      grant: grantDoc("e2e", ["create"]),
    });

    const state = `${dir}/state`;
    expect(
      cli(
        "live",
        "init",
        state,
        "--account",
        "00000000000000000000000000000000",
        "--consent",
        "create-and-delete-disposable-bend-infra-e2e-resources",
      ).code,
    ).toBe(0);
    const r = cli("live", "prepare", state, dir, "--account", "00000000000000000000000000000000");
    expect(r.code).toBe(4);
    expect(r.err).toContain("R2 execution is not supported");
  },
);
