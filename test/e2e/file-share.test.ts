// Public CLI only. Authored observations are source:fixture, never provider evidence.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BIN, ROOT } from "./helpers";
import type { JsonData } from "../../src/json";

const APP = path.join(ROOT, "apps/file-share");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

test("copyable file-share initializes and promotes ownership, stopping at the missing-npx version boundary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend-file-app-cli-"));

  try {
    const app = path.join(dir, "app");
    const tools = path.join(dir, "tools");
    const home = path.join(dir, "home");
    fs.cpSync(APP, app, { recursive: true });
    fs.mkdirSync(tools);
    fs.mkdirSync(home);

    for (const [name, target] of [
      ["bun", process.execPath],
      ["bash", "/bin/bash"],
      ["dirname", "/usr/bin/dirname"],
    ])
      fs.symlinkSync(target, path.join(tools, name));

    function cli(...args: string[]) {
      const r = spawnSync(BIN, args, {
        cwd: app,
        encoding: "utf8",
        env: { HOME: home, PATH: tools, WRANGLER_SEND_METRICS: "false", CI: "true" },
        timeout: 30000,
      });

      if (r.error) throw r.error;

      return r;
    }

    const flags = ["--env", "dev", "--account", "0123456789abcdef0123456789abcdef"];
    expect(cli("init", "--project", "file-share", ...flags).status).toBe(0);
    const state = path.join(app, ".bend-iac/dev");
    const before = read(path.join(state, "ledger.json"));
    expect(before.version).toBe(1);
    const plan = cli("plan", ...flags);
    expect(plan.status).toBe(69);
    expect(plan.stderr).toContain("npx");
    const ledger = read(path.join(state, "ledger.json"));
    expect(ledger.version).toBe(2);
    expect(ledger.run).toBe(before.run);
    expect(ledger.account).toBe(before.account);

    for (const id of ["db", "files", "api"])
      expect(ledger.resources[id]).toMatchObject({
        logicalId: id,
        status: "new",
        name: `file-share-dev-${id}-${ledger.run.slice(0, 8)}`,
      });

    const journal = fs
      .readFileSync(path.join(state, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(journal.every((row) => row.purpose === "version")).toBe(true);
    expect(journal.filter((row) => row.phase === "start").map((row) => row.mutating)).toEqual([
      false,
    ]);
    expect(journal.filter((row) => row.phase === "spawned").map((row) => row.pid)).toEqual([null]);
    expect(fs.readdirSync(path.join(state, "work"))).toEqual(["001-version"]);
    expect(fs.existsSync(path.join(state, "artifacts"))).toBe(false);
    expect(fs.existsSync(path.join(state, "lock"))).toBe(false);
    const ownership = fs.readFileSync(path.join(state, "ledger.json"), "utf8");
    expect(
      cli("plan", "--env", "dev", "--account", "fedcba9876543210fedcba9876543210").status,
    ).toBe(5);
    expect(fs.readFileSync(path.join(state, "ledger.json"), "utf8")).toBe(ownership);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test("file-share fixture plans create, no-op, source-hash update and protected teardown without provider calls", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend-file-app-plan-"));

  try {
    const tools = path.join(dir, "tools");
    fs.mkdirSync(tools);

    for (const [name, target] of [
      ["bun", process.execPath],
      ["bash", "/bin/bash"],
      ["dirname", "/usr/bin/dirname"],
    ])
      fs.symlinkSync(target, path.join(tools, name));
    const desired = read(path.join(APP, "infra/dev/desired.json"));
    const grant = read(path.join(APP, "infra/dev/grant.json"));
    const source = fs.readFileSync(path.join(APP, "src/worker.js"), "utf8");
    const sha = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
    const worker = desired.resources.find((r: { type: string }) => r.type === "worker");
    worker.main = sha(source);
    const observed = { version: 1, kind: "bend-infra/observed", source: "fixture", resources: [] };

    const write = (name: string, value: JsonData) =>
      fs.writeFileSync(path.join(dir, name + ".json"), JSON.stringify(value));

    function plan() {
      write("desired", desired);
      write("observed", observed);
      write("grant", grant);

      const r = spawnSync(BIN, ["plan", dir, "--json"], {
        encoding: "utf8",
        timeout: 30000,
        env: { HOME: dir, PATH: tools, WRANGLER_SEND_METRICS: "false", CI: "true" },
      });

      if (r.error) throw r.error;

      return { code: r.status, json: JSON.parse(r.stdout) };
    }

    const create = plan();
    expect(create.code).toBe(0);
    expect(create.json.operations.map((o: { type: string }) => o.type)).toEqual([
      "d1_database",
      "r2_bucket",
      "worker",
    ]);
    observed.resources = JSON.parse(JSON.stringify(desired.resources));
    expect(plan().json.operations).toEqual([]);
    worker.main = sha(source.replace('APP_VERSION = "1"', 'APP_VERSION = "2"'));
    const update = plan();
    expect(update.code).toBe(0);
    expect(
      update.json.operations.map((o: { action: string; type: string }) => [o.action, o.type]),
    ).toEqual([["update", "worker"]]);
    desired.resources = [];
    grant.allow = ["delete"];
    expect(plan().code).toBe(3);
    write("approvals", read(path.join(APP, "destroy-approvals.example.json")));
    const destroy = plan();
    expect(destroy.code).toBe(0);
    expect(destroy.json.operations.map((o: { type: string }) => o.type)).toEqual([
      "worker",
      "d1_database",
      "r2_bucket",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
