// Real pinned local Wrangler lifecycle only. No credentials or account calls.
import { expect } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { groupMembers, signalOwnedGroup } from "../process";

export class FileShareRuntime {
  readonly app: string;
  readonly config: string;
  readonly persist: string;
  readonly marker = randomUUID();
  readonly base: string;
  private readonly home: string;
  private child: ReturnType<typeof spawn> | undefined;
  private ready = false;
  log = "";

  constructor(dir: string, port: number) {
    this.app = path.join(dir, "app");
    this.home = path.join(dir, "home");
    this.persist = path.join(dir, "persist");
    this.config = path.join(this.app, "wrangler.local.json");
    this.base = `http://127.0.0.1:${port}`;
    fs.mkdirSync(this.home, { recursive: true });
    fs.cpSync(path.resolve(import.meta.dir, "../../apps/file-share"), this.app, {
      recursive: true,
    });
    const localConfig = JSON.parse(fs.readFileSync(this.config, "utf8"));
    expect(localConfig.account_id).toBe("0123456789abcdef0123456789abcdef");
    expect(localConfig.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "file-share-local-db",
        database_id: "11111111-1111-4111-8111-111111111111",
        remote: false,
      },
    ]);
    expect(localConfig.r2_buckets).toEqual([
      { binding: "FILES", bucket_name: "file-share-local-files", remote: false },
    ]);
    // Instrument only the scratch copy. Stable across source-version updates/restarts,
    // unique across runtimes; the mutation counter exposes even rejected foreign POSTs.
    const source = path.join(this.app, "src/worker.js");
    const original = fs.readFileSync(source, "utf8");
    expect(original.split('"x-app-version": APP_VERSION').length).toBe(2);
    expect(original.split("return await route(request, env);").length).toBe(2);
    fs.writeFileSync(
      source,
      "let TEST_MUTATIONS = 0;\n" +
        original
          .replace(
            '"x-app-version": APP_VERSION',
            `"x-test-runtime": "${this.marker}", "x-test-mutations": String(TEST_MUTATIONS), "x-app-version": APP_VERSION`,
          )
          .replace(
            "return await route(request, env);",
            'if (!["GET", "HEAD"].includes(request.method)) TEST_MUTATIONS++; return await route(request, env);',
          ),
    );
  }

  get exitCode() {
    return this.child?.exitCode;
  }

  private probe() {
    return fetch(this.base + "/", { signal: AbortSignal.timeout(3000) });
  }

  async request(url: string, init?: RequestInit) {
    if (!this.ready) throw new Error("Local runtime is not ready");
    const identity = await this.probe();

    if (!identity.ok || identity.headers.get("x-test-runtime") !== this.marker) {
      this.ready = false;
      throw new Error("Local runtime identity lost: foreign listener");
    }

    return fetch(this.base + url, { ...init, signal: AbortSignal.timeout(3000) });
  }

  async start() {
    this.ready = false;
    this.child = spawn(
      "npx",
      [
        "--yes",
        "wrangler@4.151.1",
        "dev",
        "--local",
        "--config",
        this.config,
        "--persist-to",
        this.persist,
        "--ip",
        "127.0.0.1",
        "--port",
        new URL(this.base).port,
        "--inspector-port",
        "0",
      ],
      {
        cwd: this.app,
        env: {
          HOME: this.home,
          PATH: process.env.PATH!,
          WRANGLER_SEND_METRICS: "false",
          CI: "true",
          XDG_CONFIG_HOME: path.join(this.home, ".config"),
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child.stdout!.on("data", (b) => {
      this.log += b;
    });
    this.child.stderr!.on("data", (b) => {
      this.log += b;
    });
    let spawnError: Error | undefined;
    this.child.once("error", (error) => {
      spawnError = error;
    });
    let foreign = false;

    for (const deadline = Date.now() + 45000; Date.now() < deadline;) {
      if (spawnError) throw spawnError;

      if (this.child.exitCode !== null) break;
      const response = await this.probe().catch(() => null);

      if (response?.ok) {
        if (response.headers.get("x-test-runtime") === this.marker) {
          this.ready = true;

          return;
        }

        foreign = true;
      }

      await Bun.sleep(100);
    }

    throw new Error(
      `Local runtime not ready${foreign ? ": foreign listener on requested port" : ""}\n${this.log}`,
    );
  }

  async stop() {
    this.ready = false;
    const pid = this.child?.pid;

    if (pid === undefined) return;
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);

    if (groupMembers(pid).length) {
      expect(
        signalOwnedGroup(pid, process.pid, "SIGTERM", (p) => p.command.includes(this.config)),
      ).toBe(true);

      for (let i = 0; i < 100 && groupMembers(pid).length; i++) await Bun.sleep(100);

      if (groupMembers(pid).length) {
        expect(
          signalOwnedGroup(pid, process.pid, "SIGKILL", (p) => p.command.includes(this.config)),
        ).toBe(true);

        for (let i = 0; i < 50 && groupMembers(pid).length; i++) await Bun.sleep(100);
      }
    }

    expect(groupMembers(pid)).toEqual([]);
    // A foreign listener may legitimately remain. Only our identity must be gone.
    const response = await this.probe().catch(() => null);
    expect(response?.headers.get("x-test-runtime")).not.toBe(this.marker);
    this.child = undefined;
  }
}
