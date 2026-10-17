// Independent read-only corroboration for test:live. This file does not
// import src/live: it runs the same pinned Wrangler with its own minimal
// arguments, and plain HTTPS fetches, so a bug in the adapter cannot also
// hide in the evidence. Only reads: d1 info, d1 execute with a fixed
// SELECT, deployments status, versions view, GET/POST to the test Worker.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonData } from "../../src/json";

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

type ProbeRun = { code: number | null; out: string; err: string };

export class Probe {
  constructor(
    readonly account: string,
    readonly evidenceDir: string,
  ) {}

  private wrangler(args: string[], config: Record<string, JsonData>): ProbeRun {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend-infra-probe-"));

    try {
      fs.writeFileSync(
        path.join(dir, "wrangler.json"),
        JSON.stringify({ account_id: this.account, send_metrics: false, ...config }),
      );
      // same allowlisting as the adapter: no agent markers, no API tokens
      const env: Record<string, string> = {};

      for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME"])
        if (process.env[k]) env[k] = process.env[k]!;
      Object.assign(env, {
        CI: "true",
        WRANGLER_SEND_METRICS: "false",
        NO_COLOR: "1",
        CLOUDFLARE_ACCOUNT_ID: this.account,
        WRANGLER_LOG_PATH: path.join(dir, "logs"),
      });

      const r = spawnSync(
        "npx",
        ["--yes", "wrangler@4.151.1", ...args, "--config", path.join(dir, "wrangler.json")],
        { cwd: dir, env, encoding: "utf8", timeout: 90_000 },
      );

      return {
        code: r.status,
        out: (r.stdout ?? "").replace(ANSI, ""),
        err: (r.stderr ?? "").replace(ANSI, ""),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  save(name: string, value: JsonData) {
    fs.mkdirSync(this.evidenceDir, { recursive: true });

    const text = JSON.stringify(value, null, 2).replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      "<email>",
    );

    fs.writeFileSync(path.join(this.evidenceDir, `${name}.json`), text + "\n");
  }

  d1Info(key: string): { present: true; uuid: string } | { present: false } {
    const r = this.wrangler(["d1", "info", key, "--json"], {});

    if (r.code === 0) return { present: true, uuid: JSON.parse(r.out).uuid };

    if (r.err.includes(`Couldn't find a D1 DB with name or binding '${key}'`))
      return { present: false };
    throw new Error(`probe d1 info ${key}: exit ${r.code}: ${r.err.slice(-400)}`);
  }

  d1Markers(name: string, uuid: string): string[] {
    const r = this.wrangler(
      [
        "d1",
        "execute",
        name,
        "--remote",
        "--json",
        "--yes",
        "--command",
        "SELECT value FROM markers ORDER BY value",
      ],
      { d1_databases: [{ binding: "DB", database_name: name, database_id: uuid }] },
    );

    if (r.code !== 0) throw new Error(`probe d1 execute: exit ${r.code}: ${r.err.slice(-400)}`);

    return JSON.parse(r.out)[0].results.map((x: { value: string }) => x.value);
  }

  worker(name: string): { present: true; versionId: string; version: any } | { present: false } {
    const s = this.wrangler(["deployments", "status", "--name", name, "--json"], {});

    if (s.code !== 0) {
      if (/\[code: 10007\]/.test(s.err)) return { present: false };
      throw new Error(`probe deployments status: exit ${s.code}: ${s.err.slice(-400)}`);
    }

    const versionId = JSON.parse(s.out).versions[0].version_id;
    const v = this.wrangler(["versions", "view", versionId, "--name", name, "--json"], {});

    if (v.code !== 0) throw new Error(`probe versions view: exit ${v.code}: ${v.err.slice(-400)}`);

    return { present: true, versionId, version: JSON.parse(v.out) };
  }
}

export type Http = { status: number; body: string; json: any };

export async function https(url: string, init: RequestInit = {}): Promise<Http> {
  const r = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: { "cache-control": "no-cache" },
  });

  const body = await r.text();
  let json: any = null;

  try {
    json = JSON.parse(body);
  } catch {
    // not JSON (for example Cloudflare's page for a missing Worker)
  }

  return { status: r.status, body: body.slice(0, 2000), json };
}

// bounded polling: at most `tries` requests, `gapMs` apart
export async function poll(
  url: string,
  ok: (h: Http) => boolean,
  tries = 20,
  gapMs = 3_000,
  init: RequestInit = {},
): Promise<{ last: Http | null; attempts: number; error?: string }> {
  let last: Http | null = null;
  let error: string | undefined;

  for (let i = 1; i <= tries; i++) {
    try {
      last = await https(url, init);
      error = undefined;

      if (ok(last)) return { last, attempts: i };
    } catch (e) {
      error = String(e);
    }

    await new Promise((r) => setTimeout(r, gapMs));
  }

  return { last, attempts: tries, error };
}
