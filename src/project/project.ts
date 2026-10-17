// bend-iac project commands: one app project, named environments, and a
// persistent state per environment, deployed by the same live executor
// and the same compiled Bend planner as `bend-iac live`.
//
//   init     scaffold a Worker + D1 project (never overwriting a file) and
//            create an environment's state; nothing remote
//   plan     observe the environment read-only, plan, write the artifact
//   apply    verify the reviewed artifact against its explicit digest, run it
//   destroy  a Bend-planned teardown of what the environment's state owns
//
// The manifest bend-iac.json names the project and, per environment, a spec
// directory holding the ordinary desired/grant/approvals documents. The
// account is always an explicit flag and lives only in the git-ignored
// state under .bend-iac/<environment>/.

import * as fs from "node:fs";
import * as path from "node:path";
import { decodeUtf8, NoInputError, readBytes, UsageError } from "../input";
import { errorCode, errorMessage } from "../errors";
import { LIMITS, parseApprovals, readJson, InputError } from "../schema";
import { JsonReader, type JsonData } from "../json";
import {
  ENVIRONMENT_RE,
  initProjectLedger,
  ledgerPath,
  LedgerError,
  PROJECT_KIND,
  PROJECT_RE,
  projectName,
} from "../live/ledger";
import {
  applyRun,
  flags,
  LIVE_EXIT,
  LiveError,
  need,
  planRun,
  readSpec,
  teardownRun,
  type Accept,
  type Flags,
  type SpecPolicy,
} from "../live/live";
import { ACCOUNT_RE } from "../live/wrangler";

export const MANIFEST = "bend-iac.json";
const STATE = ".bend-iac";
const MAX_ENVIRONMENTS = LIMITS.environments;

// a relative path of plain segments: never absolute, never `..`, never hidden
const SEGMENTS = "[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*";
const SPEC_RE = new RegExp(`^${SEGMENTS}$`);
const MAIN_RE = new RegExp(`^${SEGMENTS}\\.m?js$`);

type Manifest = { root: string; project: string; specs: ReadonlyMap<string, string> };

const say = (s: string) => process.stdout.write(s + "\n");

const refused = (m: string): never => {
  throw new LiveError(LIVE_EXIT.refused, m);
};

export function readManifest(root: string): Manifest {
  const file = path.join(root, MANIFEST);
  const v = readJson("manifest", decodeUtf8("manifest", readBytes(file)));

  const r = new JsonReader((where, detail) => {
    throw new InputError("manifest", where, detail);
  });

  const o = r.object(v, "(root)", ["version", "kind", "project", "environments"]);
  const version = o.get("version");

  if (version?.kind !== "number" || version.value !== 1) r.fail("version", "expected 1");

  if (r.string(o.get("kind"), "kind") !== "bend-iac/project")
    r.fail("kind", 'expected "bend-iac/project"');
  const project = r.string(o.get("project"), "project");

  if (!PROJECT_RE.test(project)) r.fail("project", `must match ${PROJECT_RE} (≤20 characters)`);
  const envs = r.fields(o.get("environments"), "environments");

  if (envs.size === 0 || envs.size > MAX_ENVIRONMENTS)
    r.fail("environments", `expected 1 to ${MAX_ENVIRONMENTS} environments`);
  const specs = new Map<string, string>();

  for (const [env, e] of envs) {
    const at = `environments.${env}`;

    if (!ENVIRONMENT_RE.test(env)) r.fail(at, `name must match ${ENVIRONMENT_RE} (≤10 characters)`);
    const spec = r.string(r.object(e, at, ["spec"]).get("spec"), `${at}.spec`);

    if (!SPEC_RE.test(spec)) r.fail(`${at}.spec`, "must be a relative path inside the project");
    specs.set(env, spec);
  }

  return { root, project, specs };
}

const stateDir = (root: string, env: string) => path.join(root, STATE, env);

// the state a project command acts on must be exactly this project's and
// environment's; its account is checked against --account before this
const projectState =
  (m: Manifest, env: string): Accept =>
  (l) => {
    if (l.kind !== PROJECT_KIND)
      refused(`${stateDir(m.root, env)} is not a project environment's state; nothing ran`);
    else if (l.project !== m.project)
      refused(
        `state belongs to project ${l.project}, but ${MANIFEST} names ${m.project}; nothing ran`,
      );
    else if (l.environment !== env)
      refused(`state belongs to environment ${l.environment}, not ${env}; nothing ran`);
  };

// --env selects project mode; the manifest is --project <dir>/bend-iac.json
// or ./bend-iac.json, and the environment must be declared in it
type Target = { m: Manifest; env: string; account: string };

function target(f: Flags, what: string): Target {
  if (f.pos.length > 0)
    throw new UsageError(
      `${what} --env takes no positional argument (got ${f.pos[0]}); fixture planning is plan <dir> without --env`,
    );
  const env = need(f, "env");
  const account = need(f, "account");

  if (!ENVIRONMENT_RE.test(env)) throw new UsageError(`--env must match ${ENVIRONMENT_RE}`);

  if (!ACCOUNT_RE.test(account))
    throw new UsageError("--account must be a 32-character lowercase hex Cloudflare account id");
  const m = readManifest(f.opts.project ?? ".");

  if (!m.specs.has(env)) refused(`environment ${env} is not declared in ${MANIFEST}; nothing ran`);

  if (!fs.existsSync(ledgerPath(stateDir(m.root, env))))
    refused(
      `no state for environment ${env} (${stateDir(m.root, env)}); create it with bend-iac init --env ${env} --account <id>; nothing ran`,
    );

  return { m, env, account };
}

const projectFlag = (m: Manifest) => (m.root === "." ? "" : ` --project ${m.root}`);

export async function projectPlan(argv: string[]): Promise<number> {
  const f = flags(argv, ["env", "account", "project"]);
  const { m, env, account } = target(f, "plan");

  const policy: SpecPolicy = {
    environment: env,
    root: m.root,
    main: MAIN_RE,
    mainHint: "a .js module path inside the project",
    r2: true,
  };

  // every local check before the lock and before anything remote
  const spec = readSpec(path.join(m.root, m.specs.get(env)!), policy);

  return planRun(
    stateDir(m.root, env),
    account,
    spec,
    f.json,
    projectState(m, env),
    (_file, digest, l) =>
      `bend-iac apply --env ${env} --account ${l.account}${projectFlag(m)} --digest sha256:${digest}`,
  );
}

export async function projectApply(argv: string[]): Promise<number> {
  const f = flags(argv, ["env", "account", "project", "artifact", "digest"]);
  const { m, env, account } = target(f, "apply");

  return applyRun(
    stateDir(m.root, env),
    account,
    projectState(m, env),
    f.opts.artifact ?? null,
    need(f, "digest"),
    f.json,
  );
}

export async function projectDestroy(argv: string[]): Promise<number> {
  const f = flags(argv, ["env", "account", "project", "confirm", "approvals"]);
  const confirm = need(f, "confirm");
  const { m, env, account } = target(f, "destroy");
  const id = `${m.project}/${env}`;

  if (confirm !== id) refused(`--confirm must be exactly ${id}; nothing ran`);
  const file = f.opts.approvals;

  const apps =
    file === undefined ? [] : parseApprovals(decodeUtf8("approvals", readBytes(file)), [env]);

  // the locked state must be this project's and environment's: the one
  // --confirm names
  return teardownRun(stateDir(m.root, env), account, {
    accept: projectState(m, env),
    approvals: () => apps,
    word: "Destroy",
  });
}

// ---- init -------------------------------------------------------------------

const json = (v: JsonData) => JSON.stringify(v, null, 2) + "\n";

const WORKER = `// A Worker with its D1 database bound as DB, deployed as this file.
export default {
  async fetch(request, env) {
    const row = await env.DB.prepare("select 1 as ok").first();

    return Response.json({ ok: row.ok === 1 });
  },
};
`;

function scaffold(project: string, env: string): [string, string][] {
  const spec = `infra/${env}`;

  return [
    [
      MANIFEST,
      json({ version: 1, kind: "bend-iac/project", project, environments: { [env]: { spec } } }),
    ],
    ["src/worker.js", WORKER],
    [
      `${spec}/desired.json`,
      json({
        version: 1,
        kind: "bend-infra/desired",
        environments: [env],
        resources: [
          {
            type: "d1_database",
            id: "db",
            environment: env,
            location: "weur",
            readReplication: "disabled",
            protected: true,
          },
          {
            type: "worker",
            id: "api",
            environment: env,
            main: "src/worker.js",
            compatibilityDate: "2026-06-01",
            bindings: [{ name: "DB", database: "db" }],
          },
        ],
      }),
    ],
    [
      `${spec}/grant.json`,
      json({ version: 1, kind: "bend-infra/grant", environment: env, allow: ["create", "update"] }),
    ],
  ];
}

export async function projectInit(argv: string[]): Promise<number> {
  const f = flags(argv, ["project", "env", "account"]);

  if (f.pos.length > 1)
    throw new UsageError("init [<dir>] --project <name> --env <environment> --account <id>");
  const root = f.pos[0] ?? ".";
  const project = need(f, "project");
  const env = need(f, "env");
  const account = need(f, "account");

  if (!PROJECT_RE.test(project)) throw new UsageError(`--project must match ${PROJECT_RE}`);

  if (!ENVIRONMENT_RE.test(env)) throw new UsageError(`--env must match ${ENVIRONMENT_RE}`);

  if (!ACCOUNT_RE.test(account))
    throw new UsageError("--account must be a 32-character lowercase hex Cloudflare account id");

  if (fs.existsSync(root) && !fs.statSync(root).isDirectory())
    throw new NoInputError(`${root}: not a directory`);
  const state = stateDir(root, env);
  const existing = fs.existsSync(path.join(root, MANIFEST));

  if (existing) {
    const m = readManifest(root);

    if (m.project !== project)
      refused(`${MANIFEST} names project ${m.project}, not ${project}; nothing was written`);

    if (!m.specs.has(env))
      refused(
        `environment ${env} is not declared in ${MANIFEST}; declare it and its spec first; nothing was written`,
      );
  }

  if (fs.existsSync(state))
    refused(`${state} already exists; an environment's state is never re-initialised`);
  let created: string[] = [];

  if (!existing) {
    const files = scaffold(project, env);
    const taken = files.map(([p]) => p).filter((p) => fs.existsSync(path.join(root, p)));

    if (taken.length > 0) refused(`${taken.join(", ")} already exist; nothing was written`);

    for (const [p, text] of files) {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });

      try {
        fs.writeFileSync(path.join(root, p), text, { flag: "wx" });
      } catch (e) {
        if (errorCode(e) !== "EEXIST") throw e;
        refused(`${p} was created by another initializer; existing files were not overwritten`);
      }
    }

    created = files.map(([p]) => p);
  }

  const ignore = path.join(root, STATE, ".gitignore");
  fs.mkdirSync(path.dirname(ignore), { recursive: true });

  try {
    fs.writeFileSync(ignore, "*\n", { flag: "wx" });
  } catch (e) {
    // Different environments may initialize concurrently in one project.
    // The first writer owns this file; no initializer overwrites it.
    if (errorCode(e) !== "EEXIST") throw e;
  }

  let run: string;

  try {
    run = initProjectLedger(state, project, env, account).run;
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;

    return refused(errorMessage(e));
  }

  const names = projectName(project, env, run, "<logical-id>");

  if (f.json) say(json({ project, environment: env, account, state, names, created }).trimEnd());
  else {
    for (const p of created) say(`created ${path.join(root, p)}`);
    say(
      `Environment ${env} of project ${project}: state ${state}, account ${account}; resources will be named ${names}. Nothing remote was touched.`,
    );
    say(
      `Next: bend-iac plan --env ${env} --account ${account}${root === "." ? "" : ` --project ${root}`}`,
    );
  }

  return LIVE_EXIT.ok;
}
