import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cli,
  db,
  desiredDoc,
  EX,
  grantDoc,
  observedDoc,
  raw,
  ROOT,
  run,
  scenario,
  worker,
  type Docs,
} from "./helpers";

const ok = {
  desired: desiredDoc([db("a", "staging")]),
  observed: observedDoc([]),
  grant: grantDoc("staging", ["create"]),
};

// each case: a mutation of a valid scenario that must fail closed with 65
const invalid: [string, Docs, string][] = [
  ["malformed JSON", { desired: raw("{ not json") }, "desired"],
  ["a duplicate key", { desired: raw('{"version":1,"version":1}') }, 'duplicate key "version"'],
  ["a wrong version", { desired: { ...ok.desired, version: 2 } }, "version"],
  ["a wrong document kind", { grant: { ...ok.grant, kind: "bend-infra/desired" } }, "kind"],
  [
    "an unknown top-level field",
    { desired: { ...ok.desired, extra: true } },
    'unknown field "extra"',
  ],
  [
    "an unknown resource field",
    { desired: desiredDoc([{ ...db("a", "staging"), name: "x" }]) },
    'unknown field "name"',
  ],
  [
    "a field of the other kind",
    { desired: desiredDoc([{ ...worker("w", "staging"), location: "weur" }]) },
    'unknown field "location"',
  ],
  [
    "an unknown resource type",
    { desired: desiredDoc([{ ...db("a", "staging"), type: "kv_namespace" }]) },
    "type",
  ],
  [
    "an unknown location",
    { desired: desiredDoc([db("a", "staging", { location: "mars" })]) },
    "location",
  ],
  [
    "a missing protected flag",
    { desired: desiredDoc([(({ protected: _protected, ...r }) => r)(db("a", "staging"))]) },
    'missing required field "protected"',
  ],
  [
    "protected as a string",
    { desired: desiredDoc([db("a", "staging", { protected: "true" })]) },
    "protected",
  ],
  [
    "an unknown replication mode",
    { desired: desiredDoc([db("a", "staging", { readReplication: "on" })]) },
    "readReplication",
  ],
  [
    "an undeclared environment",
    { desired: desiredDoc([db("a", "qa")]) },
    'environment "qa" is not declared',
  ],
  [
    "an undeclared observed environment",
    { observed: observedDoc([db("a", "qa")]) },
    'environment "qa" is not declared',
  ],
  [
    "an undeclared grant environment",
    { grant: grantDoc("qa", []) },
    'environment "qa" is not declared',
  ],
  ["no environments", { desired: desiredDoc([], []) }, "at least one environment"],
  ["duplicate environments", { desired: desiredDoc([], ["staging", "staging"]) }, "unique"],
  ["an unknown grant action", { grant: grantDoc("staging", ["destroy"]) }, "allow[0]"],
  ["a duplicate grant action", { grant: grantDoc("staging", ["create", "create"]) }, "unique"],
  [
    "a grant field typo",
    { grant: { ...grantDoc("staging", []), enviroment: "staging" } },
    'unknown field "enviroment"',
  ],
  [
    "an approval of a non-destructive action",
    {
      approvals: {
        version: 1,
        kind: "bend-infra/approvals",
        approvals: [
          { action: "create", resource: "a", environment: "staging", approvedBy: "x", reason: "y" },
        ],
      },
    },
    "action",
  ],
  [
    "an approval without approver",
    {
      approvals: {
        version: 1,
        kind: "bend-infra/approvals",
        approvals: [{ action: "delete", resource: "a", environment: "staging", reason: "y" }],
      },
    },
    'missing required field "approvedBy"',
  ],
  ["an uppercase id", { desired: desiredDoc([db("App", "staging")]) }, "id"],
  ["an id with a quote", { desired: desiredDoc([db('a"b', "staging")]) }, "id"],
  [
    "a lowercase binding name",
    { desired: desiredDoc([db("a", "staging"), worker("w", "staging", [["db", "a"]])]) },
    "name",
  ],
  [
    "an impossible compatibility date",
    { desired: desiredDoc([worker("w", "staging", [], { compatibilityDate: "2026-02-30" })]) },
    "calendar date",
  ],
  [
    "a control character in main",
    { desired: desiredDoc([worker("w", "staging", [], { main: "a\u0007b" })]) },
    "control characters",
  ],
  [
    "a live observation source",
    { observed: { ...observedDoc([]), source: "cloudflare-api" } },
    "fixture",
  ],
  [
    "too many resources",
    { desired: desiredDoc(Array.from({ length: 257 }, (_, i) => db(`d${i}`, "staging"))) },
    "at most 256",
  ],
  [
    "a non-array bindings",
    { desired: desiredDoc([{ ...worker("w", "staging"), bindings: {} }]) },
    "expected an array",
  ],
];

describe("inputs fail closed", () => {
  test.each(invalid)("%s exits 65", (_, patch, expectText) => {
    const dir = scenario({ ...ok, ...patch });
    const run = cli("plan", dir);
    expect(run.code).toBe(65);
    expect(run.out).toBe("");
    expect(run.err).toContain("error[invalid-input]");
    expect(run.err).toContain(expectText);
  });

  test("--json reports invalid input as a non-executable outcome", () => {
    const run = cli("plan", scenario({ ...ok, grant: grantDoc("qa", []) }), "--json");
    expect(run.code).toBe(65);
    expect(JSON.parse(run.out)).toMatchObject({
      outcome: "invalid_input",
      executable: false,
      error: { document: "grant", at: "environment" },
    });
  });
});

describe("cli", () => {
  test("help lists commands and exit codes", () => {
    const run = cli("help");
    expect(run.code).toBe(0);

    for (const s of ["plan", "build", "Exit codes", "approval required", "no apply/destroy"])
      expect(run.out).toContain(s);
  });

  test("no command is a usage error", () => {
    expect(cli().code).toBe(64);
  });

  test("an unknown command or option is a usage error", () => {
    expect(cli("apply", EX("01-create")).code).toBe(64);
    expect(cli("destroy").code).toBe(64);
    expect(cli("plan", EX("01-create"), "--force").code).toBe(64);
  });

  test("a missing input is reported as such", () => {
    const run = cli(
      "plan",
      "--desired",
      "/nonexistent/desired.json",
      "--observed",
      "x",
      "--grant",
      "y",
    );

    expect(run.code).toBe(66);
    expect(run.err).toContain("error[no-input]");
  });

  test("a directory without a grant is a missing input", () => {
    const dir = scenario({ desired: ok.desired, observed: ok.observed });
    expect(cli("plan", dir).code).toBe(66);
  });

  test("explicit flags override files of the directory", () => {
    const grant = path.join(scenario({ grant: grantDoc("staging", []) }), "grant.json");
    const run = cli("plan", EX("01-create"), "--grant", grant, "--json");
    expect(run.code).toBe(2);
    expect(JSON.parse(run.out).problems.map((p: any) => p.code)).toEqual([
      "OUT_OF_GRANT",
      "OUT_OF_GRANT",
    ]);
  });

  test("version names the pinned Bend commit", () => {
    const env = fs.readFileSync(path.join(ROOT, "toolchain.env"), "utf8");
    const commit = /BEND_COMMIT=(\w+)/.exec(env)![1];
    expect(cli("version").out).toContain(commit);
  });
});

describe("engine", () => {
  test("without the pinned toolchain the CLI refuses to plan (exit 70), it never falls back", () => {
    // a copy of the project, public executable included, with no .toolchain and no .build
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend-infra-notool-"));

    try {
      for (const f of [
        "bin",
        "src",
        "scripts",
        "core",
        "LAWS.bend",
        "PROOF.bend",
        "toolchain.env",
        "examples",
      ])
        fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });

      const r = run(
        path.join(dir, "bin", "bend-iac"),
        "plan",
        path.join(dir, "examples", "01-create"),
      );

      expect(r.code).toBe(70);
      expect(r.out).toBe("");
      expect(r.err).toContain("toolchain is missing");
      // no planner was compiled or borrowed from elsewhere
      expect(fs.existsSync(path.join(dir, ".build", "planner.mjs"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a build stamp that is not one the build writes is not trusted: the planner is rebuilt", () => {
    // a copy of the project with this checkout's toolchain and build
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend-infra-stamp-"));

    try {
      for (const f of [
        "bin",
        "src",
        "scripts",
        "core",
        "LAWS.bend",
        "PROOF.bend",
        "toolchain.env",
        "examples",
        ".build",
      ])
        fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });

      fs.symlinkSync(path.join(ROOT, ".toolchain"), path.join(dir, ".toolchain"));
      const stampFile = path.join(dir, ".build", "stamp.json");
      const text = fs.readFileSync(stampFile, "utf8");
      const stamp = JSON.parse(text);
      expect(stamp.proofs).toBe("verdict");

      // the current source digests, with a proofs value no build writes; and
      // a duplicated key, which JSON.parse would have resolved silently
      for (const forged of [
        JSON.stringify({ ...stamp, proofs: "assumed" }),
        text.replace(/\}\s*$/, ', "proofs": "verdict"}'),
      ]) {
        fs.writeFileSync(stampFile, forged);

        const r = run(
          path.join(dir, "bin", "bend-iac"),
          "plan",
          path.join(dir, "examples", "01-create"),
          "--json",
        );

        expect(r.code).toBe(0);
        expect(JSON.parse(r.out).engine.proofs).toBe("verdict");
        // rebuilt behind the proofs: the stamp is again the build's own
        expect(fs.readFileSync(stampFile, "utf8")).not.toBe(forged);
        expect(JSON.parse(fs.readFileSync(stampFile, "utf8")).proofs).toBe("verdict");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
