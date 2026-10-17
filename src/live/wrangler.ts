// The Wrangler adapter: the only code in bend-infra that talks to
// Cloudflare. It is trusted, not proven (docs/live.md).
//
// It runs one pinned Wrangler (`npx --yes wrangler@4.151.1`) as a child
// process with an argument array (no shell), a generated config file whose
// account_id is the run's account, CLOUDFLARE_ACCOUNT_ID set to the same
// account, and an allowlisted environment. The allowlist matters: Wrangler
// treats itself as driven by an AI agent when it sees variables such as
// PI_CODING_AGENT or CLAUDECODE, and then auto-registers a workers.dev
// subdomain and skips confirmations. API-token variables are dropped as
// well, so the existing Wrangler login is the only credential, and this
// code never reads it. CI=true makes every Wrangler prompt take its
// non-interactive fallback (for example, declining subdomain registration).
//
// The command set is closed: each exported method builds one fixed
// argument shape from validated names. Every invocation is appended to the
// run's journal before it is spawned, then again with its result. A
// command that outlives its timeout is killed with its process group.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { JsonReader, parseStrict, type JsonFields, type JsonValue } from "../json";
import { LOCATIONS } from "../schema";

export const WRANGLER_VERSION = "4.151.1";
export const WRANGLER = ["npx", "--yes", `wrangler@${WRANGLER_VERSION}`] as const;

// Names and ids this adapter will pass to Wrangler: nothing else gets in.
export const ACCOUNT_RE = /^[0-9a-f]{32}$/;

// the two physical name shapes this tool generates: a disposable live run's
// bend-infra-e2e-<run>-<logical id>, and a project environment's
// <project>-<environment>-<logical id>-<run[0..8]> (at most 61 characters).
// Ownership is the ledger's exact name and id, never this shape alone.
export const LEGACY_NAME_RE = /^bend-infra-e2e-[0-9a-f]{16}-[a-z](?:[a-z0-9-]{0,18}[a-z0-9])?$/;

export const PROJECT_NAME_RE = /^[a-z][a-z0-9-]{3,50}[a-z0-9]-[0-9a-f]{8}$/;

export const NAME_RE =
  /^(?:bend-infra-e2e-[0-9a-f]{16}-[a-z](?:[a-z0-9-]{0,18}[a-z0-9])?|[a-z][a-z0-9-]{3,50}[a-z0-9]-[0-9a-f]{8})$/;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_ID_RE = UUID_RE;

const ENV_ALLOW = ["PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME"];

export class WranglerError extends Error {}

export type Purpose =
  | "version"
  | "r2-info"
  | "r2-create"
  | "r2-delete"
  | "d1-info"
  | "deployments-status"
  | "versions-view"
  | "deploy-dry-run"
  | "d1-create"
  | "deploy"
  | "delete-worker"
  | "d1-delete";

export const MUTATING: ReadonlySet<Purpose> = new Set([
  "d1-create",
  "r2-create",
  "r2-delete",
  "deploy",
  "delete-worker",
  "d1-delete",
]);

const TIMEOUT_MS: Record<Purpose, number> = {
  version: 120_000,
  "r2-info": 90_000,
  "r2-create": 120_000,
  "r2-delete": 120_000,
  "d1-info": 90_000,
  "deployments-status": 90_000,
  "versions-view": 90_000,
  "deploy-dry-run": 120_000,
  "d1-create": 120_000,
  deploy: 180_000,
  "delete-worker": 120_000,
  "d1-delete": 120_000,
};

export type Result = {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  out: string;
  err: string;
  ms: number;
};

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// what journals and evidence keep of child output: no colours, no e-mail
// addresses (Worker version metadata carries the author's), bounded size
export const sanitize = (s: string, max = 64 * 1024) =>
  s.replace(ANSI, "").replace(EMAIL, "<email>").slice(0, max);

// The run's journal.jsonl, one record per line: each command when it
// starts (before it is spawned), once spawned and when it ends, and the
// notes apply and cleanup leave before their steps.
export type Note = { phase: "apply"; artifact: string; digest: string } | { phase: "cleanup" };

export type JournalEntry =
  | ({ seq: number } & Note)
  | {
      seq: number;
      phase: "start";
      purpose: Purpose;
      mutating: boolean;
      argv: string[];
      configSha256: string;
    }
  | { seq: number; phase: "spawned"; purpose: Purpose; pid: number | null; ppid: number }
  | {
      seq: number;
      phase: "signal";
      purpose: Purpose;
      signal: "SIGTERM" | "SIGKILL";
      pgid: number | null;
      basis: SignalBasis;
      sent: boolean;
    }
  | {
      seq: number;
      phase: "end";
      purpose: Purpose;
      exit: number | null;
      signal: string | null;
      timedOut: boolean;
      ms: number;
      stderrTail: string;
    };

type WorkDir = { dir: string; config: string; configSha256: string };

// ---- signalling a timed-out command ----------------------------------------
// Each command runs detached: the child (npx) leads a new session and
// process group whose id is its pid. A signal goes to that group only on a
// basis checked at the moment of signalling, never on the number alone:
//
//   unreaped-leader  the runtime has not reported the leader's exit, so the
//                    leader still holds its pid and the group exists; its
//                    members are its own session's processes
//   config-in-group  the leader has exited, and a fresh `ps` shows a member
//                    of the group whose command line holds this command's
//                    unique generated config path (npm exec and Wrangler
//                    pass --config <path> on)
//
// Otherwise ("no-pid": the spawn failed; "unverified") nothing is sent.
// Limits: the check and the kill(2) are separate steps, so a group that
// empties and whose id is reused in that gap of milliseconds could still be
// hit, and the runtime may reap the leader shortly before it reports the
// exit. macOS has no pidfd to close that gap. Every decision is journaled.
export type SignalBasis = "unreaped-leader" | "config-in-group" | "no-pid" | "unverified";

function groupBasis(pid: number | undefined, leaderExited: boolean, marker: string): SignalBasis {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return "no-pid";

  if (!leaderExited) return "unreaped-leader";

  const ps = spawnSync("ps", ["-A", "-ww", "-o", "pgid=,command="], {
    encoding: "utf8",
    timeout: 10_000,
  });

  if (ps.status !== 0) return "unverified";

  const owned = ps.stdout.split("\n").some((line) => {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);

    return m !== null && Number(m[1]) === pid && m[2].includes(marker);
  });

  return owned ? "config-in-group" : "unverified";
}

// After the timeout: SIGTERM, then SIGKILL after graceMs, then, if the
// command still has not closed, stop waiting after settleMs. Production uses
// the defaults; the local process-integration test passes shorter ones.
export type Limits = { timeoutMs?: number; graceMs?: number; settleMs?: number };

export class Wrangler {
  private seq = 0;
  // Absolute: each child runs with cwd = its work directory and gets
  // --config and WRANGLER_LOG_PATH under this directory, so a relative run
  // directory would otherwise be resolved twice.
  readonly stateDir: string;
  constructor(
    stateDir: string,
    readonly account: string,
    private readonly onSpawn: (purpose: Purpose) => void = () => {},
    private readonly limits: Limits = {},
  ) {
    if (!ACCOUNT_RE.test(account)) throw new WranglerError(`invalid account id`);
    this.stateDir = path.resolve(stateDir);
    stateDir = this.stateDir;
    const j = path.join(stateDir, "journal.jsonl");

    if (fs.existsSync(j))
      this.seq = fs
        .readFileSync(j, "utf8")
        .split("\n")
        .filter((l) => l.includes('"phase":"start"')).length;
  }

  // a non-command record in the journal (apply/cleanup start)
  note(e: Note) {
    this.journal({ seq: this.seq, ...e });
  }

  private journal(e: JournalEntry) {
    fs.appendFileSync(
      path.join(this.stateDir, "journal.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n",
    );
  }

  // writes the generated config into a fresh work directory; returns its path
  private workDir(
    purpose: Purpose,
    config: WranglerConfig,
    files: Record<string, Buffer> = {},
  ): WorkDir {
    const dir = path.join(
      this.stateDir,
      "work",
      `${String(this.seq + 1).padStart(3, "0")}-${purpose}`,
    );

    fs.mkdirSync(dir, { recursive: true });
    const text = JSON.stringify(config, null, 2) + "\n";
    const cfg = path.join(dir, "wrangler.json");
    fs.writeFileSync(cfg, text);

    for (const [f, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), bytes);

    return { dir, config: cfg, configSha256: createHash("sha256").update(text).digest("hex") };
  }

  // the allowlisted variables that are set, then the fixed ones
  private env(): Record<string, string> {
    return Object.fromEntries([
      ...ENV_ALLOW.flatMap((k) => {
        const v = process.env[k];

        return v === undefined ? [] : [[k, v]];
      }),
      ["CI", "true"],
      ["WRANGLER_SEND_METRICS", "false"],
      ["NO_COLOR", "1"],
      ["FORCE_COLOR", "0"],
      ["CLOUDFLARE_ACCOUNT_ID", this.account],
      ["WRANGLER_LOG_PATH", path.join(this.stateDir, "wrangler-logs")],
    ]);
  }

  async run(
    purpose: Purpose,
    args: string[],
    config: WranglerConfig,
    files: Record<string, Buffer> = {},
  ): Promise<Result> {
    if (config.account_id !== this.account)
      throw new WranglerError("generated config must name the run's account");
    const w = this.workDir(purpose, config, files);

    // Wrangler loads .env files from its working directory; refuse any
    if (fs.readdirSync(w.dir).some((f) => f.startsWith(".env") || f.startsWith(".dev.vars"))) {
      throw new WranglerError(`${w.dir} holds an env file; refusing to run Wrangler there`);
    }

    const argv = [...args, "--config", w.config];
    const seq = ++this.seq;
    const rel = path.relative(this.stateDir, w.dir);
    this.journal({
      seq,
      phase: "start",
      purpose,
      mutating: MUTATING.has(purpose),
      argv: [...WRANGLER, ...argv.map((a) => (a === w.config ? `${rel}/wrangler.json` : a))],
      configSha256: w.configSha256,
    });
    this.onSpawn(purpose);
    const t0 = performance.now();

    const r = await new Promise<Result>((resolve) => {
      const child = spawn(WRANGLER[0], [...WRANGLER.slice(1), ...argv], {
        cwd: w.dir,
        env: this.env(),
        detached: true, // own process group: a terminal ^C does not cut a command short, a timeout kills it whole
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.journal({ seq, phase: "spawned", purpose, pid: child.pid ?? null, ppid: process.pid });
      let out = "";
      let err = "";
      let timedOut = false;
      child.stdout.on("data", (d) => {
        if (out.length < 4 << 20) out += d;
      });
      child.stderr.on("data", (d) => {
        if (err.length < 4 << 20) err += d;
      });

      // the group the child leads (detached), and the run's lifecycle: once
      // settled, every timer is cleared and nothing is signalled again
      const pgid = child.pid;
      let settled = false;
      const timers = new Set<ReturnType<typeof setTimeout>>();

      const after = (ms: number, f: () => void) => {
        const t = setTimeout(() => {
          timers.delete(t);
          f();
        }, ms);

        timers.add(t);
      };

      const settle = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;

        for (const t of timers) clearTimeout(t);
        timers.clear();
        resolve({ code, signal, timedOut, out, err, ms: Math.round(performance.now() - t0) });
      };

      const signalGroup = (sig: "SIGTERM" | "SIGKILL") => {
        if (settled) return;
        const exited = child.exitCode !== null || child.signalCode !== null;
        const basis = groupBasis(pgid, exited, w.config);
        let sent = false;

        if (pgid !== undefined && (basis === "unreaped-leader" || basis === "config-in-group")) {
          try {
            process.kill(-pgid, sig);
            sent = true;
          } catch {
            /* the group is gone */
          }
        }

        this.journal({
          seq,
          phase: "signal",
          purpose,
          signal: sig,
          pgid: pgid ?? null,
          basis,
          sent,
        });
      };

      after(this.limits.timeoutMs ?? TIMEOUT_MS[purpose], () => {
        timedOut = true;
        signalGroup("SIGTERM");
        after(this.limits.graceMs ?? 5_000, () => {
          signalGroup("SIGKILL");
          after(this.limits.settleMs ?? 5_000, () => {
            // bounded: stop waiting for a command that did not close
            err +=
              "\nbend-iac: the command did not close after SIGTERM and SIGKILL; stopped waiting";
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            settle(null, null);
          });
        });
      });

      child.on("error", (e) => {
        err += String(e);
      });
      child.on("close", (code, signal) => settle(code, signal));
    });

    fs.writeFileSync(path.join(w.dir, "stdout.txt"), sanitize(r.out));
    fs.writeFileSync(path.join(w.dir, "stderr.txt"), sanitize(r.err));
    this.journal({
      seq,
      phase: "end",
      purpose,
      exit: r.code,
      signal: r.signal,
      timedOut: r.timedOut,
      ms: r.ms,
      stderrTail: sanitize(r.err).trim().slice(-600),
    });

    return r;
  }

  async version(): Promise<string> {
    const r = await this.run("version", ["--version"], build.base(this.account));
    const v = sanitize(r.out).trim();

    if (r.code !== 0 || !v.includes(WRANGLER_VERSION))
      throw new WranglerError(
        `wrangler --version: expected ${WRANGLER_VERSION}, got exit ${r.code}: ${tail(r)}`,
      );

    return v;
  }

  // The bucket GET precedes GraphQL metrics in the pin. Only its exact
  // API error context with NoSuchBucket (10006) establishes absence.
  async r2Info(name: string): Promise<{ present: true; info: R2Info } | { present: false }> {
    const r = await this.run("r2-info", build.r2InfoArgs(name), build.base(this.account));

    if (r.code !== 0 || r.timedOut || r.signal !== null) {
      const errors = clean(r.err).split("[ERROR]");
      const route = `/accounts/${this.account}/r2/buckets/${name}`;

      // Match the first note of a single formatted API error, not a route
      // somewhere in the output paired with an unrelated code elsewhere.
      // Requiring the documented message is deliberately conservative.
      const absent = new RegExp(
        `^\\s*A\\s+request\\s+to\\s+the\\s+Cloudflare\\s+API\\s+\\(${route}\\)\\s+failed\\.` +
          `\\s+The\\s+specified\\s+bucket\\s+does\\s+not\\s+exist\\.\\s+\\[code: 10006\\](?:\\s|$)`,
      );

      if (
        r.code !== null &&
        r.code !== 0 &&
        !r.timedOut &&
        r.signal === null &&
        clean(r.out).trim() === "" &&
        errors.length === 2 &&
        absent.test(errors[1]) &&
        (clean(r.err).match(/A request to the Cloudflare API/g) ?? []).length === 1 &&
        (clean(r.err).match(/\[code: /g) ?? []).length === 1
      )
        return { present: false };

      throw new WranglerError(`r2 info ${name}: not determined: ${tail(r)}`);
    }

    const info = r2InfoFrom(parseJson(r.out, "r2 info"));

    if (info.name !== name) throw new WranglerError("r2 info: unexpected bucket name");

    return { present: true, info };
  }

  // Exit zero is not ownership evidence. Callers must reconcile by readback.
  async r2Create(name: string): Promise<Result> {
    return this.run("r2-create", build.r2CreateArgs(name), build.base(this.account));
  }

  // No purge, force, object enumeration, or implicit retry.
  async r2Delete(name: string): Promise<Result> {
    return this.run("r2-delete", build.r2DeleteArgs(name), build.base(this.account));
  }

  // ---- read-only observations -------------------------------------------

  // d1 info by exact name (or uuid): present with the API's record, absent
  // only on Wrangler's not-found message for exactly that key; anything
  // else (auth, network, timeout) is an error, never "absent"
  async d1Info(key: string): Promise<{ present: true; info: D1Info } | { present: false }> {
    if (!NAME_RE.test(key) && !UUID_RE.test(key))
      throw new WranglerError(`refusing d1 info for ${key}`);
    const r = await this.run("d1-info", ["d1", "info", key, "--json"], build.base(this.account));

    if (r.code === 0 && !r.timedOut)
      return { present: true, info: d1InfoFrom(parseJson(r.out, "d1 info")) };

    if (
      !r.timedOut &&
      r.code !== null &&
      clean(r.err).includes(
        `Couldn't find a D1 DB with name or binding '${key}' in your config or the API`,
      )
    ) {
      return { present: false };
    }

    throw new WranglerError(
      `d1 info ${key}: not determined (exit ${r.code}${r.signal ? `, signal ${r.signal}` : ""}${r.timedOut ? ", timed out" : ""}): ${tail(r)}`,
    );
  }

  async deploymentStatus(
    name: string,
  ): Promise<{ present: true; deployment: Deployment } | { present: false }> {
    if (!NAME_RE.test(name)) throw new WranglerError(`refusing deployments status for ${name}`);

    const r = await this.run(
      "deployments-status",
      ["deployments", "status", "--name", name, "--json"],
      build.base(this.account),
    );

    if (r.code === 0 && !r.timedOut)
      return {
        present: true,
        deployment: deploymentFrom(parseJson(r.out, "deployments status")),
      };

    // Cloudflare API error 10007 on exactly this script's URL
    const e = clean(r.err);

    if (
      !r.timedOut &&
      r.code !== null &&
      /This Worker does not exist on your account\. \[code: 10007\]/.test(e) &&
      e.includes(`/workers/scripts/${name}/deployments`)
    ) {
      return { present: false };
    }

    throw new WranglerError(
      `deployments status ${name}: not determined (exit ${r.code}${r.signal ? `, signal ${r.signal}` : ""}${r.timedOut ? ", timed out" : ""}): ${tail(r)}`,
    );
  }

  async versionView(name: string, versionId: string): Promise<Version> {
    if (!NAME_RE.test(name) || !VERSION_ID_RE.test(versionId))
      throw new WranglerError("refusing versions view");

    const r = await this.run(
      "versions-view",
      ["versions", "view", versionId, "--name", name, "--json"],
      build.base(this.account),
    );

    if (r.code !== 0 || r.timedOut)
      throw new WranglerError(`versions view ${name} ${versionId}: exit ${r.code}: ${tail(r)}`);
    const v = versionFrom(parseJson(r.out, "versions view"));

    if (v.id !== versionId) throw new WranglerError("versions view: unexpected output");

    return v;
  }

  // local only: Wrangler validates the generated config and flags and
  // writes the would-be upload to dry-run-out; nothing is uploaded
  async deployDryRun(config: DeployConfig, source: Buffer, args: string[]): Promise<void> {
    checkDeploy(this.account, config, source, args);

    const r = await this.run(
      "deploy-dry-run",
      [...args, "--dry-run", "--outdir", "dry-run-out", "--outfile", "dry-run-upload.multipart"],
      config,
      { "worker.js": source },
    );

    if (r.code !== 0 || r.timedOut)
      throw new WranglerError(`deploy --dry-run: exit ${r.code}: ${tail(r)}`);
  }

  // ---- mutations --------------------------------------------------------

  async d1Create(name: string, location: string): Promise<{ result: Result; uuid: string | null }> {
    const r = await this.run(
      "d1-create",
      build.d1CreateArgs(name, location),
      build.base(this.account),
    );

    const m = /"database_id":\s*"([0-9a-f-]{36})"/.exec(clean(r.out));

    return { result: r, uuid: r.code === 0 && m && UUID_RE.test(m[1]) ? m[1] : null };
  }

  async deploy(
    config: DeployConfig,
    source: Buffer,
    args: string[],
  ): Promise<{ result: Result; url: string | null; versionId: string | null }> {
    checkDeploy(this.account, config, source, args);
    const r = await this.run("deploy", args, config, { "worker.js": source });
    const out = clean(r.out);

    // every workers.dev URL printed for this Worker's name
    const urls = [...out.matchAll(/https:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev\b/g)].flatMap(
      (m) => (m[1] === config.name ? [m[0]] : []),
    );

    const v = /Current Version ID: ([0-9a-f-]{36})/.exec(out);

    return {
      result: r,
      url: new Set(urls).size === 1 ? urls[0] : null,
      versionId: v && UUID_RE.test(v[1]) ? v[1] : null,
    };
  }

  async deleteWorker(name: string): Promise<Result> {
    return this.run(
      "delete-worker",
      build.deleteWorkerArgs(name),
      build.deleteWorkerConfig(this.account, name),
    );
  }

  // the config binds the exact database_id, so Wrangler deletes that uuid
  // and does not resolve the name through the API
  async d1Delete(name: string, uuid: string): Promise<Result> {
    return this.run(
      "d1-delete",
      build.d1DeleteArgs(name),
      build.d1DeleteConfig(this.account, name, uuid),
    );
  }
}

// The fixed argument and config shapes. The live planner derives an
// artifact's payload from these same builders, and apply re-derives it and
// compares before running anything.
const need = (ok: boolean, what: string) => {
  if (!ok) throw new WranglerError(`refusing: ${what}`);
};

export const build = {
  r2InfoArgs: (name: string) => {
    need(NAME_RE.test(name), "r2 info name");

    return ["r2", "bucket", "info", name, "--json"];
  },
  r2CreateArgs: (name: string) => {
    need(NAME_RE.test(name), "r2 create name");

    return ["r2", "bucket", "create", name, "--update-config=false"];
  },
  r2DeleteArgs: (name: string) => {
    need(NAME_RE.test(name), "r2 delete name");

    return ["r2", "bucket", "delete", name];
  },
  base: (account: string): BaseConfig => ({ account_id: account, send_metrics: false }),
  d1CreateArgs: (name: string, location: string) => {
    need(
      NAME_RE.test(name) && LOCATIONS.some((l) => l === location),
      `d1 create ${name} --location ${location}`,
    );

    return ["d1", "create", name, "--location", location, "--update-config=false"];
  },
  deployArgs: (run: string, sourceSha256: string) => {
    need(/^[0-9a-f]{16}$/.test(run) && /^[0-9a-f]{64}$/.test(sourceSha256), "deploy annotation");

    // the message is the observable source identity (Cloudflare keeps up
    // to 100 bytes; this is 82); the tag names the run (25 at most; 20)
    return [
      "deploy",
      "--no-bundle",
      "--autoconfig=false",
      "--strict",
      "--message",
      `bend-infra sha256:${sourceSha256}`,
      "--tag",
      `run-${run}`,
    ];
  },
  deployConfig: (
    account: string,
    name: string,
    compatibilityDate: string,
    d1: D1Binding[],
    r2: R2Binding[] = [],
  ): DeployConfig => {
    const config: DeployConfig = {
      name,
      main: "worker.js",
      compatibility_date: compatibilityDate,
      account_id: account,
      workers_dev: true,
      preview_urls: false,
      no_bundle: true,
      upload_source_maps: false,
      send_metrics: false,
      d1_databases: d1,
    };

    if (r2.length !== 0) config.r2_buckets = r2;

    return config;
  },
  deleteWorkerArgs: (name: string) => {
    need(NAME_RE.test(name), `delete ${name}`);

    return ["delete", "--name", name];
  },
  deleteWorkerConfig: (account: string, name: string): DeleteWorkerConfig => ({
    ...build.base(account),
    name,
  }),
  d1DeleteArgs: (name: string) => {
    need(NAME_RE.test(name), `d1 delete ${name}`);

    return ["d1", "delete", name, "--skip-confirmation"];
  },
  d1DeleteConfig: (account: string, name: string, uuid: string): D1DeleteConfig => {
    need(NAME_RE.test(name) && UUID_RE.test(uuid), `d1 delete ${name} (${uuid})`);

    return {
      ...build.base(account),
      d1_databases: [{ binding: "DB", database_name: name, database_id: uuid }],
    };
  },
};

const DEPLOY_KEYS = [
  "name",
  "main",
  "compatibility_date",
  "account_id",
  "workers_dev",
  "preview_urls",
  "no_bundle",
  "upload_source_maps",
  "send_metrics",
  "d1_databases",
];

// the deploy shape, re-checked at the last moment: exactly these config
// keys, at most one D1 binding to a run-named database by uuid, and an
// annotation whose digest is the digest of the bytes being uploaded
export function checkDeploy(account: string, c: DeployConfig, source: Buffer, args: string[]) {
  const sha = createHash("sha256").update(source).digest("hex");
  need(
    JSON.stringify(Object.keys(c)) ===
      JSON.stringify(c.r2_buckets === undefined ? DEPLOY_KEYS : [...DEPLOY_KEYS, "r2_buckets"]),
    "unexpected deploy config keys",
  );
  need(
    NAME_RE.test(c.name) && c.account_id === account && c.main === "worker.js",
    "deploy config identity",
  );
  need(
    c.workers_dev === true &&
      c.preview_urls === false &&
      c.no_bundle === true &&
      c.upload_source_maps === false &&
      c.send_metrics === false,
    "deploy config flags",
  );
  need(/^\d{4}-\d{2}-\d{2}$/.test(c.compatibility_date), "compatibility date");
  need(Array.isArray(c.d1_databases) && c.d1_databases.length <= 1, "at most one D1 binding");

  for (const d of c.d1_databases) {
    need(
      JSON.stringify(Object.keys(d)) === '["binding","database_name","database_id"]',
      "D1 binding keys",
    );
    need(
      /^[A-Z][A-Z0-9_]*$/.test(d.binding) &&
        NAME_RE.test(d.database_name) &&
        UUID_RE.test(d.database_id),
      "D1 binding values",
    );
  }

  const names = new Set(c.d1_databases.map((d) => d.binding));

  if (c.r2_buckets !== undefined) {
    need(Array.isArray(c.r2_buckets) && c.r2_buckets.length <= 1, "at most one R2 binding");

    for (const b of c.r2_buckets) {
      need(JSON.stringify(Object.keys(b)) === '["binding","bucket_name"]', "R2 binding keys");
      need(/^[A-Z][A-Z0-9_]*$/.test(b.binding) && NAME_RE.test(b.bucket_name), "R2 binding values");
      need(!names.has(b.binding), "distinct binding names");
      names.add(b.binding);
    }
  }

  need(
    args.length === 8 &&
      JSON.stringify(args) === JSON.stringify(build.deployArgs(args[7].slice(4), sha)),
    "deploy arguments must carry the uploaded bytes' sha256",
  );
}

// ---- what the adapter reads of Wrangler's --json output ------------------
// Each is the part of a response this code relies on, decoded from the
// strict reader. A response is an open object (Cloudflare adds fields), but
// every field used here must be present with its type, or the read is not
// determined: a WranglerError, never a default.

export type D1Info = {
  uuid: string;
  name: string;
  readReplication: string | null; // read_replication.mode
};

export type Deployment = { versions: { version_id: string; percentage: number }[] };

export type VersionBinding = {
  type: string;
  name: string;
  id: string | null;
  r2?: { bucketName: string; jurisdiction: string | null };
};

export type R2Info = { name: string; created: string };

export function r2InfoFrom(v: JsonValue): R2Info {
  const r = responseReader("r2 info");
  const o = r.fields(v, "(root)");
  const name = r.string(o.get("name"), "name");
  const created = r.string(o.get("created"), "created");

  if (
    !NAME_RE.test(name) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(created) ||
    !Number.isFinite(Date.parse(created))
  )
    throw new WranglerError("r2 info: invalid bucket generation identity");

  return { name, created };
}

export type Version = {
  id: string;
  message: string | null; // annotations["workers/message"]
  tag: string | null; // annotations["workers/tag"]
  etag: string | null; // resources.script.etag
  compatibilityDate: string | null; // resources.script_runtime.compatibility_date
  compatibilityFlags: string[]; // resources.script_runtime.compatibility_flags
  bindings: VersionBinding[]; // resources.bindings: the id, or else the database_id
};

const responseReader = (what: string) =>
  new JsonReader((where, detail) => {
    throw new WranglerError(`${what}: unexpected output: ${where}: ${detail}`);
  });

// an optional object: absent or null is none
const optionalFields = (r: JsonReader, o: JsonFields, k: string, where: string) => {
  const v = o.get(k);

  return v === undefined || v.kind === "null" ? null : r.fields(v, where);
};

// an optional string: absent or null is null
const optionalText = (r: JsonReader, o: JsonFields | null, k: string, where: string) => {
  const v = o?.get(k);

  return v === undefined || v.kind === "null" ? null : r.string(v, where);
};

export function d1InfoFrom(v: JsonValue): D1Info {
  const r = responseReader("d1 info");
  const o = r.fields(v, "(root)");
  const uuid = o.get("uuid");
  const name = o.get("name");

  if (uuid?.kind !== "string" || !UUID_RE.test(uuid.value))
    throw new WranglerError("d1 info: no uuid in output");

  if (name?.kind !== "string") throw new WranglerError("d1 info: no name in output");
  const rr = optionalFields(r, o, "read_replication", "read_replication");

  return {
    uuid: uuid.value,
    name: name.value,
    readReplication: optionalText(r, rr, "mode", "read_replication.mode"),
  };
}

export function deploymentFrom(v: JsonValue): Deployment {
  const r = responseReader("deployments status");
  const versions = r.fields(v, "(root)").get("versions");

  if (versions?.kind !== "array")
    throw new WranglerError("deployments status: no versions in output");

  return {
    versions: versions.items.map((x, i) => {
      const o = r.fields(x, `versions[${i}]`);

      return {
        version_id: r.string(o.get("version_id"), `versions[${i}].version_id`),
        percentage: r.number(o.get("percentage"), `versions[${i}].percentage`),
      };
    }),
  };
}

export function versionFrom(v: JsonValue): Version {
  const r = responseReader("versions view");
  const o = r.fields(v, "(root)");
  const resources = o.get("resources");

  if (o.get("id")?.kind !== "string" || resources?.kind !== "object")
    throw new WranglerError("versions view: unexpected output");
  const res = resources.fields;
  const annotations = optionalFields(r, o, "annotations", "annotations");
  const script = optionalFields(r, res, "script", "resources.script");
  const runtime = optionalFields(r, res, "script_runtime", "resources.script_runtime");
  const flags = runtime?.get("compatibility_flags");
  const bindings = res.get("bindings");

  return {
    id: r.string(o.get("id"), "id"),
    message: optionalText(r, annotations, "workers/message", "annotations.workers/message"),
    tag: optionalText(r, annotations, "workers/tag", "annotations.workers/tag"),
    etag: optionalText(r, script, "etag", "resources.script.etag"),
    compatibilityDate: optionalText(
      r,
      runtime,
      "compatibility_date",
      "resources.script_runtime.compatibility_date",
    ),
    compatibilityFlags:
      flags === undefined || flags.kind === "null"
        ? []
        : r
            .array(flags, "resources.script_runtime.compatibility_flags")
            .map((f, i) => r.string(f, `resources.script_runtime.compatibility_flags[${i}]`)),
    bindings:
      bindings === undefined || bindings.kind === "null"
        ? []
        : r.array(bindings, "resources.bindings").map((b, i) => {
            const at = `resources.bindings[${i}]`;
            const bo = r.fields(b, at);

            const type = r.string(bo.get("type"), `${at}.type`);

            const binding: VersionBinding = {
              type,
              name: r.string(bo.get("name"), `${at}.name`),
              id:
                optionalText(r, bo, "id", `${at}.id`) ??
                optionalText(r, bo, "database_id", `${at}.database_id`),
            };

            if (type === "r2_bucket")
              binding.r2 = {
                bucketName: r.string(bo.get("bucket_name"), `${at}.bucket_name`),
                jurisdiction: optionalText(r, bo, "jurisdiction", `${at}.jurisdiction`),
              };

            return binding;
          }),
  };
}

// The generated wrangler.json documents, one per command purpose. Every one
// names the run's account; run() checks that before anything is spawned.
export type BaseConfig = { account_id: string; send_metrics: false };

export type DeleteWorkerConfig = BaseConfig & { name: string };

export type R2Binding = { binding: string; bucket_name: string };

export type D1Binding = { binding: string; database_name: string; database_id: string };

export type D1DeleteConfig = BaseConfig & { d1_databases: D1Binding[] };

export type DeployConfig = {
  name: string;
  main: "worker.js";
  compatibility_date: string;
  account_id: string;
  workers_dev: true;
  preview_urls: false;
  no_bundle: true;
  upload_source_maps: false;
  send_metrics: false;
  d1_databases: D1Binding[];
  r2_buckets?: R2Binding[];
};

export type WranglerConfig = BaseConfig | DeleteWorkerConfig | D1DeleteConfig | DeployConfig;

const clean = (s: string) => s.replace(ANSI, "");

const tail = (r: Result) =>
  sanitize(r.err || r.out)
    .trim()
    .split("\n")
    .filter((l) => l.trim() && !l.includes("Logs were written"))
    .slice(-6)
    .join(" | ")
    .slice(0, 800);

// --json output is the whole of stdout, except that Wrangler may print its
// once-per-version telemetry notice first: then the document starts at the
// first line that opens one
export function parseJson(s: string, what: string): JsonValue {
  const t = clean(s).trim();
  const lines = t.split("\n");
  const start = lines.findIndex((l) => l.startsWith("{") || l.startsWith("["));

  try {
    return parseStrict(start <= 0 ? t : lines.slice(start).join("\n"));
  } catch {
    throw new WranglerError(`${what}: output is not JSON`);
  }
}
