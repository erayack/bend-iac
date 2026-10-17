// npm run test:live: the real Cloudflare lane. Never part of `npm test`.
//
// It mutates a Cloudflare account, so it runs only with an explicit
// opt-in, and it FAILS (never skips, never passes) without one:
//
//   BEND_INFRA_LIVE_ACCOUNT=<32-hex account id>
//   BEND_INFRA_LIVE_CONSENT=create-and-delete-disposable-bend-infra-e2e-resources
//   BEND_INFRA_LIVE_STATE_DIR=<new directory>   (optional; default .live/<time>)
//
// Prerequisites: the pinned toolchain and a fresh --verdict planner (as for
// the other lanes), network, `npx`, and an existing Wrangler login for that
// account with Workers and D1 write access. Nothing here logs in, refreshes
// scopes or reads credentials.
//
// Steps: run test/live (bin/bend-iac live ... in subprocesses), then,
// whatever happened, including a test failure or SIGINT/SIGTERM, run
// `bend-iac live cleanup` for the run's ledger and `live observe` to
// prove every resource the run owned is absent. The lane passes only if
// every test passed, none was skipped, and absence is confirmed.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { build, EngineError, isFresh, readStamp } from "../src/engine";
import { checkPinnedToolchain } from "./toolchain";

const ROOT = path.resolve(import.meta.dir, "..");
const CONSENT = "create-and-delete-disposable-bend-infra-e2e-resources";

const fail = (msg: string): never => {
  console.error(`test:live: FAILED: ${msg}`);
  process.exit(1);
};

const account = process.env.BEND_INFRA_LIVE_ACCOUNT ?? "";

if (!/^[0-9a-f]{32}$/.test(account) || process.env.BEND_INFRA_LIVE_CONSENT !== CONSENT) {
  fail(
    `explicit opt-in required: set BEND_INFRA_LIVE_ACCOUNT=<32-hex Cloudflare account id> and BEND_INFRA_LIVE_CONSENT=${CONSENT}. Nothing ran and nothing was created.`,
  );
}

try {
  console.log(`toolchain: ${checkPinnedToolchain()}`);

  if (!isFresh() || readStamp()?.proofs !== "verdict") build((s) => console.log(s));
} catch (e) {
  fail(e instanceof EngineError || e instanceof Error ? e.message : String(e));
}

if (!isFresh() || readStamp()?.proofs !== "verdict") fail("planner is not a fresh --verdict build");

const state = path.resolve(
  process.env.BEND_INFRA_LIVE_STATE_DIR ??
    path.join(ROOT, ".live", new Date().toISOString().replace(/[:.]/g, "-")),
);

if (fs.existsSync(state)) fail(`${state} exists; each live run needs a new directory`);

fs.mkdirSync(path.dirname(state), { recursive: true });

console.log(`run directory: ${state}`);

let signalled: string | null = null;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    signalled ??= sig;
    console.error(`test:live: ${sig}: waiting for the current step, then cleaning up`);
  });
}

const dir = path.join("test", "live");
const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".test.ts"));

console.log(`\n$ bun test ./${dir}`);

const test = await new Promise<{ code: number | null; out: string }>((resolve) => {
  const child = spawn("bun", ["test", `./${dir}`, "--timeout", "900000"], {
    cwd: ROOT,
    env: { ...process.env, BEND_INFRA_LIVE_STATE: state },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
    process.stdout.write(d);
  });
  child.stderr.on("data", (d) => {
    out += d;
    process.stderr.write(d);
  });
  child.on("close", (code) => resolve({ code, out }));
});

// cleanup, always: exactly the ledger's resources, by a Bend-planned teardown
const bin = path.join(ROOT, "bin", "bend-iac");

type Cleanup = { code: number | null; out: string };

let cleanup: Cleanup = {
  code: null,
  out: "no ledger: nothing was created",
};

let observed: any = null;
const ledgerFile = path.join(state, "ledger.json");

if (fs.existsSync(ledgerFile)) {
  const run = JSON.parse(fs.readFileSync(ledgerFile, "utf8")).run;

  // bounded retries: only when cleanup could not determine the remote state
  // (exit 69) and therefore refused to change anything
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await Bun.sleep(15_000);
    console.log(
      `\n$ bin/bend-iac live cleanup ${state} --account <account> --confirm-run ${run}   # attempt ${attempt} of 3`,
    );

    const c = spawnSync(
      bin,
      ["live", "cleanup", state, "--account", account, "--confirm-run", run],
      { cwd: ROOT, encoding: "utf8", timeout: 20 * 60_000 },
    );

    cleanup = { code: c.status, out: (c.stdout ?? "") + (c.stderr ?? "") };
    process.stdout.write(cleanup.out);

    if (c.status !== 69) break;
  }

  const o = spawnSync(bin, ["live", "observe", state, "--account", account, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10 * 60_000,
  });

  try {
    observed = JSON.parse(o.stdout);
  } catch {
    observed = { error: `live observe exited ${o.status}`, stderr: o.stderr };
  }
}

const absent =
  observed === null ||
  (Array.isArray(observed.evidence) &&
    observed.evidence.every((e: any) => !e.present) &&
    observed.outstanding?.length === 0 &&
    observed.undetermined?.length === 0);

const count = (what: string) =>
  Number(new RegExp(`^\\s*(\\d+) ${what}$`, "m").exec(test.out)?.[1] ?? 0);

const ran = /^Ran (\d+) tests? across (\d+) files?/m.exec(test.out);

const summary = {
  state,
  tests: {
    exit: test.code,
    pass: count("pass"),
    fail: count("fail"),
    skip: count("skip"),
    todo: count("todo"),
    ran: ran?.[1] ?? null,
    files: ran?.[2] ?? null,
  },
  signalled,
  cleanup: { exit: cleanup.code },
  observedAfterCleanup: observed,
  absenceConfirmed: absent,
};

fs.mkdirSync(state, { recursive: true });

fs.writeFileSync(path.join(state, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

if (!absent || (cleanup.code !== null && cleanup.code !== 0)) {
  fail(
    `cleanup NOT confirmed; see ${path.join(state, "summary.json")} and ${ledgerFile} (outstanding: ${JSON.stringify(observed?.outstanding ?? observed)})`,
  );
}

if (signalled) fail(`interrupted by ${signalled}; cleanup confirmed`);

if (test.code !== 0 || count("fail") !== 0)
  fail(`bun test exited ${test.code} with ${count("fail")} failing tests; cleanup confirmed`);

if (count("skip") !== 0 || count("todo") !== 0)
  fail(`${count("skip")} skipped and ${count("todo")} todo tests`);

if (!ran || Number(ran[1]) === 0) fail("no tests ran");

if (Number(ran![2]) !== files.length) fail(`ran ${ran![2]} files, ${dir} holds ${files.length}`);

console.log(
  `\ntest:live: ${ran![1]} tests in ${ran![2]} files passed against Cloudflare, none skipped; every resource of the run is confirmed absent (${state})`,
);
