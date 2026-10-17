// E2E helpers: every test drives the public executable bin/bend-iac in a
// child process and asserts only on its exit status, stdout and stderr.
// The builders below only write input documents; nothing is mocked.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { JsonData } from "../../src/json";

export const ROOT = path.resolve(import.meta.dir, "..", "..");
export const EX = (name: string) => path.join(ROOT, "examples", name);

export type Run = { code: number; out: string; err: string };

// runs a bend-iac executable (by default this checkout's bin/bend-iac)
// in a child process, as a user would
export function run(bin: string, ...args: string[]): Run {
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: "utf8" });

  if (r.error) throw r.error;

  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

export const BIN = path.join(ROOT, "bin", "bend-iac");
export const cli = (...args: string[]): Run => run(BIN, ...args);

// a plan's --json report, or null when stdout is not JSON
export type PlanJson = { run: Run; json: any };

export function planJson(...args: string[]): PlanJson {
  const run = cli("plan", ...args, "--json");
  let json: any = null;

  try {
    json = JSON.parse(run.out);
  } catch {
    // leave null; the test will show run.out
  }

  return { run, json };
}

import * as fs from "node:fs";
import * as os from "node:os";

// Building blocks for generated scenarios
export const ENVS = ["staging", "production"];

// fields that replace or extend a built document's
export type Fields = Record<string, JsonData>;

export const db = (id: string, env: string, extra: Fields = {}) => ({
  type: "d1_database",
  id,
  environment: env,
  location: "weur",
  readReplication: "disabled",
  protected: false,
  ...extra,
});

export const worker = (
  id: string,
  env: string,
  binds: [string, string][] = [],
  extra: Fields = {},
) => ({
  type: "worker",
  id,
  environment: env,
  main: "src/index.ts",
  compatibilityDate: "2026-09-01",
  bindings: binds.map(([name, database]) => ({ name, database })),
  ...extra,
});

export const desiredDoc = (resources: JsonData[], environments = ENVS) => ({
  version: 1,
  kind: "bend-infra/desired",
  environments,
  resources,
});

export const observedDoc = (resources: JsonData[]) => ({
  version: 1,
  kind: "bend-infra/observed",
  source: "fixture",
  resources,
});

export const grantDoc = (environment: string, allow: string[]) => ({
  version: 1,
  kind: "bend-infra/grant",
  environment,
  allow,
});

export const approvalsDoc = (
  approvals: { action: string; resource: string; environment: string }[],
) => ({
  version: 1,
  kind: "bend-infra/approvals",
  approvals: approvals.map((a) => ({ approvedBy: "owner@example.com", reason: "test", ...a })),
});

// A document's text, written verbatim: input that must not parse as JSON
export class RawText {
  constructor(readonly text: string) {}
}

export const raw = (text: string) => new RawText(text);

// a JSON document to write (serialized), or raw text
export type Doc = { readonly [k: string]: JsonData | undefined } | readonly JsonData[] | RawText;

export type Docs = { desired?: Doc; observed?: Doc; grant?: Doc; approvals?: Doc };

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "bend-infra-test-"));

process.on("exit", () => fs.rmSync(SCRATCH, { recursive: true, force: true }));

let n = 0;

// writes a scenario directory: the documents given, raw text verbatim
export function scenario(docs: Docs): string {
  const dir = path.join(SCRATCH, `s${n++}`);
  fs.mkdirSync(dir);

  for (const [k, v] of Object.entries(docs)) {
    if (v !== undefined)
      fs.writeFileSync(
        path.join(dir, `${k}.json`),
        v instanceof RawText ? v.text : JSON.stringify(v, null, 2),
      );
  }

  return dir;
}

export const codes = (json: any) => json.problems.map((p: any) => p.code);
