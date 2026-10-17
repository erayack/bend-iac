// Raw-byte input boundary: every document is read as bytes, size-checked,
// then decoded as strict UTF-8. Invalid bytes must fail closed (exit 65,
// attributed to their document) and are never repaired into U+FFFD; valid
// Unicode, a literal U+FFFD included, stays accepted. A leading UTF-8 BOM
// is preserved by decoding and rejected by the strict JSON reader.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  approvalsDoc,
  cli,
  db,
  desiredDoc,
  grantDoc,
  observedDoc,
  planJson,
  scenario,
  worker,
} from "./helpers";

type Doc = "desired" | "observed" | "grant" | "approvals";

// the documents, in the order of DOCS below
const DOC_NAMES: readonly Doc[] = ["desired", "observed", "grant", "approvals"];

const MARK = "MARK";

// writes a valid scenario, then replaces the ASCII placeholder MARK in one
// document with raw bytes (which need not be valid UTF-8)
function withBytes(docs: Parameters<typeof scenario>[0], doc: Doc, bytes: Buffer): string {
  const dir = scenario(docs);
  const file = path.join(dir, `${doc}.json`);
  const text = fs.readFileSync(file);
  const at = text.indexOf(MARK);

  if (at < 0) throw new Error(`no ${MARK} in ${doc}.json`);
  fs.writeFileSync(
    file,
    Buffer.concat([text.subarray(0, at), bytes, text.subarray(at + MARK.length)]),
  );

  return dir;
}

const hex = (h: string) => Buffer.from(h, "hex");

// a staging Worker to create; main carries the placeholder
const createDocs = () => ({
  desired: desiredDoc([worker("api", "staging", [], { main: `src/${MARK}.ts` })]),
  observed: observedDoc([]),
  grant: grantDoc("staging", ["create"]),
});

function expectInvalid(dir: string, doc: Doc) {
  const human = cli("plan", dir);
  expect(human.code).toBe(65);
  expect(human.out).toBe("");
  expect(human.err).toContain("error[invalid-input]");
  expect(human.err).toContain(`${doc}: (encoding): not valid UTF-8`);
  const { run, json } = planJson(dir);
  expect(run.code).toBe(65);
  expect(json).toEqual({
    outcome: "invalid_input",
    executable: false,
    error: { document: doc, at: "(encoding)", detail: expect.stringContaining("not valid UTF-8") },
  });
  expect(json.operations).toBeUndefined();
}

describe("invalid UTF-8 fails closed (review R1)", () => {
  test("a desired Worker main with a raw 0xff byte is not an approved create", () => {
    expectInvalid(withBytes(createDocs(), "desired", hex("ff")), "desired");
  });

  test("invalid desired bytes are not a false no-op against an observed literal U+FFFD", () => {
    const docs = {
      desired: desiredDoc([worker("api", "staging", [], { main: `src/${MARK}.ts` })]),
      observed: observedDoc([worker("api", "staging", [], { main: "src/\uFFFD.ts" })]),
      grant: grantDoc("staging", []),
    };

    expectInvalid(withBytes(docs, "desired", hex("ff")), "desired");
  });

  // representative malformed sequences: invalid leading byte, lone
  // continuation, truncated 3-byte sequence, overlong '/', a UTF-16
  // surrogate, and a code point past U+10FFFF
  const BAD: [string, string][] = [
    ["invalid leading byte 0xff", "ff"],
    ["lone continuation byte 0x80", "80"],
    ["truncated sequence e2 82", "e282"],
    ["overlong encoding c0 af", "c0af"],
    ["encoded surrogate ed a0 80", "eda080"],
    ["code point above U+10FFFF f4 90 80 80", "f4908080"],
  ];

  // where the placeholder sits in each document: a free-text field where
  // possible, so that a repaired U+FFFD would otherwise validate
  const DOCS: Record<Doc, () => Parameters<typeof scenario>[0]> = {
    desired: createDocs,
    observed: () => ({
      desired: desiredDoc([db("a", "staging")]),
      observed: observedDoc([worker("old", "staging", [], { main: `src/${MARK}.ts` })]),
      grant: grantDoc("staging", ["create", "delete"]),
    }),
    grant: () => ({
      desired: desiredDoc([db("a", "staging")]),
      observed: observedDoc([]),
      grant: { ...grantDoc("staging", ["create"]), kind: `bend-infra/grant${MARK}` },
    }),
    approvals: () => ({
      desired: desiredDoc([]),
      observed: observedDoc([db("prod-db", "production", { protected: true })]),
      grant: grantDoc("production", ["delete"]),
      approvals: {
        ...approvalsDoc([{ action: "delete", resource: "prod-db", environment: "production" }]),
        approvals: [
          {
            action: "delete",
            resource: "prod-db",
            environment: "production",
            approvedBy: `dba${MARK}@example.com`,
            reason: "retire",
          },
        ],
      },
    }),
  };

  for (const doc of DOC_NAMES) {
    test.each(BAD)(`${doc}: %s exits 65 with no operations`, (_, h) => {
      expectInvalid(withBytes(DOCS[doc](), doc, hex(h)), doc);
    });
  }

  test("the same scenarios with the placeholder kept are valid (controls)", () => {
    expect(cli("plan", scenario(DOCS.desired())).code).toBe(0);
    expect(cli("plan", scenario(DOCS.observed())).code).toBe(0);
    expect(
      cli("plan", scenario({ ...DOCS.grant(), grant: grantDoc("staging", ["create"]) })).code,
    ).toBe(0);
    expect(cli("plan", scenario(DOCS.approvals())).code).toBe(0);
  });
});

describe("valid Unicode stays accepted", () => {
  test("a literal U+FFFD (valid bytes ef bf bd) is an ordinary character", () => {
    const dir = withBytes(createDocs(), "desired", hex("efbfbd"));
    const run = cli("plan", dir);
    expect(run.code).toBe(0);
    expect(run.out).toContain("main=src/\uFFFD.ts");
  });

  test("an observed literal U+FFFD matching a desired literal U+FFFD is a true no-op", () => {
    const docs = {
      desired: desiredDoc([worker("api", "staging", [], { main: `src/${MARK}.ts` })]),
      observed: observedDoc([worker("api", "staging", [], { main: "src/\uFFFD.ts" })]),
      grant: grantDoc("staging", []),
    };

    const { run, json } = planJson(withBytes(docs, "desired", hex("efbfbd")));
    expect(run.code).toBe(0);
    expect(json.operations).toEqual([]);
  });

  test("multi-byte text in main and in an approval is accepted and shown intact", () => {
    const dir = scenario({
      desired: desiredDoc([worker("api", "staging", [], { main: "src/café/日本/😀.ts" })]),
      observed: observedDoc([]),
      grant: grantDoc("staging", ["create"]),
    });

    const run = cli("plan", dir);
    expect(run.code).toBe(0);
    expect(run.out).toContain("main=src/café/日本/😀.ts");
    const d = DOCS_APPROVAL_UNICODE();
    const ar = cli("plan", d);
    expect(ar.code).toBe(0);
    expect(ar.out).toContain("approved by Zoë Ünal ✓: ретайр");
  });
});

function DOCS_APPROVAL_UNICODE(): string {
  return scenario({
    desired: desiredDoc([]),
    observed: observedDoc([db("prod-db", "production", { protected: true })]),
    grant: grantDoc("production", ["delete"]),
    approvals: {
      version: 1,
      kind: "bend-infra/approvals",
      approvals: [
        {
          action: "delete",
          resource: "prod-db",
          environment: "production",
          approvedBy: "Zoë Ünal ✓",
          reason: "ретайр",
        },
      ],
    },
  });
}

describe("byte order mark, size and unreadable files", () => {
  test("a leading UTF-8 BOM is kept by decoding and rejected by the strict JSON reader", () => {
    const dir = scenario(createDocs());
    const file = path.join(dir, "desired.json");
    fs.writeFileSync(file, Buffer.concat([hex("efbbbf"), fs.readFileSync(file)]));
    const run = cli("plan", dir);
    expect(run.code).toBe(65);
    expect(run.out).toBe("");
    expect(run.err).toContain("desired: (json): unexpected token");
    const { run: jr, json } = planJson(dir);
    expect(jr.code).toBe(65);
    expect(json).toMatchObject({
      outcome: "invalid_input",
      executable: false,
      error: { document: "desired", at: "(json)" },
    });
  });

  test("an oversize document is attributed to it (65), checked before decoding", () => {
    const dir = scenario(createDocs());
    // valid JSON followed by more than 1 MiB of invalid bytes: the size
    // error must win, so decoding never runs on an oversize file
    const file = path.join(dir, "observed.json");
    fs.writeFileSync(
      file,
      Buffer.concat([fs.readFileSync(file), Buffer.alloc((1 << 20) + 1, 0xff)]),
    );
    const run = cli("plan", dir);
    expect(run.code).toBe(65);
    expect(run.out).toBe("");
    expect(run.err).toContain("observed: (file): larger than 1048576 bytes");
    const { run: jr, json } = planJson(dir);
    expect(jr.code).toBe(65);
    expect(json).toMatchObject({
      outcome: "invalid_input",
      executable: false,
      error: { document: "observed", at: "(file)" },
    });
  });

  test("a document of exactly 1 MiB is within the limit", () => {
    const dir = scenario(createDocs());
    const file = path.join(dir, "grant.json");
    const text = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([text, Buffer.alloc((1 << 20) - text.length, 0x20)]));
    expect(cli("plan", dir).code).toBe(0);
  });

  test("an unreadable document stays a missing input (66), even with --json", () => {
    const dir = scenario(createDocs());
    const file = path.join(dir, "approvals.json");
    fs.writeFileSync(file, "{}");
    fs.chmodSync(file, 0o000);

    try {
      const run = cli("plan", dir, "--json");
      expect(run.code).toBe(66);
      expect(run.out).toBe("");
      expect(run.err).toContain("error[no-input]");
      expect(run.err).toContain("EACCES");
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  test("a directory given as a document is a missing input (66), not 65 or 70", () => {
    const dir = scenario(createDocs());
    const run = cli("plan", dir, "--desired", dir);
    expect(run.code).toBe(66);
    expect(run.err).toContain("error[no-input]");
    expect(run.err).toContain("EISDIR");
  });

  test("a missing file takes precedence over invalid bytes in another document", () => {
    const dir = withBytes(createDocs(), "desired", hex("ff"));
    fs.rmSync(path.join(dir, "observed.json"));
    const run = cli("plan", dir, "--observed", path.join(dir, "observed.json"));
    expect(run.code).toBe(66);
    expect(run.err).toContain("ENOENT");
  });
});
