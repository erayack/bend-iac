// The run ledger: the durable, local record of what one live run owns.
//
// A run has one account, one random run id and at most one Worker and one
// D1 database. A disposable live run (kind bend-infra/live-ledger) names
// them bend-infra-e2e-<run>-<logical id>; a project environment's state
// (kind bend-iac/project-state) names them
// <project>-<environment>-<logical id>-<run[0..8]>. The kind, project,
// environment, account and run of a ledger never change. The ledger is
// written (atomically: temp file, fsync, rename) before every remote
// mutation, recording the intent, and again after it with the outcome and
// the physical ids Cloudflare returned. Cleanup acts only on what this
// file says the run created, by exact name and recorded id, never by
// prefix. The model-only metadata (protected, the requested location
// hint) lives here: it is local and authoritative, not observed.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorCode, errorMessage } from "../errors";
import { JsonReader, parseStrict, type JsonValue } from "../json";
import { LOCATIONS, REPLICATION, type DbDecl } from "../schema";
import {
  ACCOUNT_RE,
  LEGACY_NAME_RE,
  NAME_RE,
  PROJECT_NAME_RE,
  UUID_RE,
  WRANGLER_VERSION,
} from "./wrangler";

export const CONSENT = "create-and-delete-disposable-bend-infra-e2e-resources";
export const ENVIRONMENT = "e2e";
export const LOGICAL_RE = /^[a-z](?:[a-z0-9-]{0,18}[a-z0-9])?$/;
export const PROJECT_RE = LOGICAL_RE;
export const ENVIRONMENT_RE = /^[a-z][a-z0-9]{0,9}$/;
export const LEGACY_KIND = "bend-infra/live-ledger";
export const PROJECT_KIND = "bend-iac/project-state";

// new       declared, never attempted
// creating  intent recorded, create command started or ambiguous
// created   created by this run and read back
// deleting  delete intent recorded
// deleted   delete ran and remote absence was observed
// absent    a create was attempted and the resource is observed absent
// conflict  the name existed before this run tried to create it: never ours
// unknown   a remote outcome could not be determined
const STATUSES = [
  "new",
  "creating",
  "created",
  "deleting",
  "deleted",
  "absent",
  "conflict",
  "unknown",
] as const;

export type Status = (typeof STATUSES)[number];

// what a history event records besides its name; each key as written by
// live.ts (an exit status is null when the process ended on a signal)
export type HistoryDetail = {
  artifact?: string;
  step?: number;
  uuid?: string;
  sourceSha256?: string;
  exit?: number | null;
  parsed?: string | null;
  versionId?: string | null;
  bucketCreated?: string; // v2 bucket history only
};

export type HistoryEntry = { at: string; event: string; detail?: HistoryDetail };

export type WorkerDbOwned = {
  type: "d1_database" | "worker";
  logicalId: string;
  name: string;
  status: Status;
  physicalId: string | null; // the D1 uuid; Workers are identified by their exact name
  // d1_database, local authoritative model metadata
  location?: DbDecl["location"];
  readReplication?: DbDecl["readReplication"];
  protected?: boolean;
  // worker, as deployed by this run
  versionId?: string | null;
  etag?: string | null;
  url?: string | null;
  sourceSha256?: string | null;
  history: HistoryEntry[];
};

// V2 buckets have no D1 UUID or Worker deployment metadata.
export type BucketOwned = Pick<WorkerDbOwned, "logicalId" | "name" | "status" | "history"> & {
  type: "r2_bucket";
  physicalId: null;
  protected: boolean;
  bucketCreated: string | null;
  location?: never;
  readReplication?: never;
  versionId?: never;
  etag?: never;
  url?: never;
  sourceSha256?: never;
};

export type Owned = WorkerDbOwned | BucketOwned;

export type LegacyLedger = {
  version: 1;
  kind: typeof LEGACY_KIND;
  run: string;
  account: string;
  environment: typeof ENVIRONMENT;
  consent: typeof CONSENT;
  wrangler: string;
  createdAt: string;
  resources: Record<string, WorkerDbOwned>;
};

export type ProjectLedger = {
  version: 1;
  kind: typeof PROJECT_KIND;
  project: string;
  environment: string;
  account: string;
  run: string;
  wrangler: string;
  createdAt: string;
  resources: Record<string, WorkerDbOwned>;
};

export type ProjectLedgerV2 = Omit<ProjectLedger, "version" | "resources"> & {
  version: 2;
  resources: Record<string, Owned>;
};

export type Ledger = LegacyLedger | ProjectLedger | ProjectLedgerV2;

export class LedgerError extends Error {}

export const ledgerPath = (dir: string) => path.join(dir, "ledger.json");

export const physicalName = (run: string, logicalId: string) =>
  `bend-infra-e2e-${run}-${logicalId}`;

export const projectName = (project: string, environment: string, run: string, id: string) =>
  `${project}-${environment}-${id}-${run.slice(0, 8)}`;

// the exact physical name of a logical id in this ledger's namespace
export const nameOf = (l: Ledger, id: string) =>
  l.kind === LEGACY_KIND
    ? physicalName(l.run, id)
    : projectName(l.project, l.environment, l.run, id);

// a name this ledger may own: its namespace's shape, and never the other's
export const nameAllowed = (l: Ledger, name: string) =>
  l.kind === LEGACY_KIND
    ? LEGACY_NAME_RE.test(name)
    : PROJECT_NAME_RE.test(name) && !LEGACY_NAME_RE.test(name);

export function initLedger(dir: string, account: string): LegacyLedger {
  if (!ACCOUNT_RE.test(account))
    throw new LedgerError("--account must be a 32-character lowercase hex Cloudflare account id");

  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0)
    throw new LedgerError(`${dir} is not empty; a run directory holds exactly one run`);
  fs.mkdirSync(dir, { recursive: true });

  const ledger: LegacyLedger = {
    version: 1,
    kind: "bend-infra/live-ledger",
    run: randomBytes(8).toString("hex"), // 64 random bits in every resource name
    account,
    environment: ENVIRONMENT,
    consent: CONSENT,
    wrangler: WRANGLER_VERSION,
    createdAt: new Date().toISOString(),
    resources: {},
  };

  saveLedger(dir, ledger);

  return ledger;
}

// Claim an absent environment directory exclusively before publishing its
// identity. Even an empty/partial directory belongs to its initializer:
// never adopt it or replace a ledger while another command holds its lock.
export function initProjectLedger(
  dir: string,
  project: string,
  environment: string,
  account: string,
): ProjectLedger {
  if (!ACCOUNT_RE.test(account))
    throw new LedgerError("--account must be a 32-character lowercase hex Cloudflare account id");

  if (!PROJECT_RE.test(project) || !ENVIRONMENT_RE.test(environment))
    throw new LedgerError(`invalid project "${project}" or environment "${environment}"`);

  fs.mkdirSync(path.dirname(dir), { recursive: true });

  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (errorCode(e) !== "EEXIST") throw e;
    throw new LedgerError(
      `${dir} already holds state for environment ${environment}; it is never re-initialised (including empty or partial state)`,
    );
  }

  const ledger: ProjectLedger = {
    version: 1,
    kind: PROJECT_KIND,
    project,
    environment,
    account,
    run: randomBytes(8).toString("hex"),
    wrangler: WRANGLER_VERSION,
    createdAt: new Date().toISOString(),
    resources: {},
  };

  saveLedger(dir, ledger);

  return ledger;
}

const DETAIL_TEXT = ["artifact", "uuid", "sourceSha256"] as const;
const DETAIL_TEXT_OR_NULL = ["parsed", "versionId"] as const;

const validBucketGeneration = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

function detailFrom(r: JsonReader, v: JsonValue, where: string, bucket = false): HistoryDetail {
  const d: HistoryDetail = {};

  // in the order written; a key is one of the known ones, with its type
  for (const [k, x] of r.fields(v, where)) {
    const at = `${where}.${k}`;
    const text = DETAIL_TEXT.find((t) => t === k);
    const textOrNull = DETAIL_TEXT_OR_NULL.find((t) => t === k);

    if (text !== undefined) d[text] = r.string(x, at);
    else if (textOrNull !== undefined) d[textOrNull] = x.kind === "null" ? null : r.string(x, at);
    else if (k === "step") d.step = r.count(x, at);
    else if (k === "exit") d.exit = x.kind === "null" ? null : r.number(x, at);
    else if (bucket && k === "bucketCreated") {
      const created = r.string(x, at);

      if (!validBucketGeneration(created))
        r.fail(at, "expected a valid UTC ISO generation timestamp");
      d.bucketCreated = created;
    } else r.fail(where, `unknown field "${k}"`);
  }

  return d;
}

const OWNED_REQUIRED = ["type", "logicalId", "name", "status", "physicalId", "history"];

const OWNED_OPTIONAL = [
  "location",
  "readReplication",
  "protected",
  "versionId",
  "etag",
  "url",
  "sourceSha256",
];

function ownedFrom(r: JsonReader, v: JsonValue, where: string): WorkerDbOwned {
  const o = r.object(v, where, OWNED_REQUIRED, OWNED_OPTIONAL);
  const physicalId = o.get("physicalId");

  const textOrNull = (x: JsonValue, at: string) => (x.kind === "null" ? null : r.string(x, at));

  const owned: WorkerDbOwned = {
    type: r.oneOf(o.get("type"), `${where}.type`, ["d1_database", "worker"] as const),
    logicalId: r.string(o.get("logicalId"), `${where}.logicalId`),
    name: r.string(o.get("name"), `${where}.name`),
    status: r.oneOf(o.get("status"), `${where}.status`, STATUSES),
    physicalId: physicalId?.kind === "null" ? null : r.string(physicalId, `${where}.physicalId`),
    history: r.array(o.get("history"), `${where}.history`).map((h, i) => {
      const hw = `${where}.history[${i}]`;
      const ho = r.object(h, hw, ["at", "event"], ["detail"]);
      const detail = ho.get("detail");

      const entry: HistoryEntry = {
        at: r.string(ho.get("at"), `${hw}.at`),
        event: r.string(ho.get("event"), `${hw}.event`),
      };

      if (detail !== undefined) entry.detail = detailFrom(r, detail, `${hw}.detail`);

      return entry;
    }),
  };

  if (owned.physicalId !== null && !UUID_RE.test(owned.physicalId))
    r.fail(`${where}.physicalId`, "expected a D1 uuid or null");

  // the optional fields, in the order written
  for (const [k, x] of o) {
    const at = `${where}.${k}`;

    if (k === "location") owned.location = r.oneOf(x, at, LOCATIONS);
    else if (k === "readReplication") owned.readReplication = r.oneOf(x, at, REPLICATION);
    else if (k === "protected") owned.protected = r.boolean(x, at);
    else if (k === "versionId") owned.versionId = textOrNull(x, at);
    else if (k === "etag") owned.etag = textOrNull(x, at);
    else if (k === "url") owned.url = textOrNull(x, at);
    else if (k === "sourceSha256") owned.sourceSha256 = textOrNull(x, at);
  }

  return owned;
}

function bucketFrom(r: JsonReader, v: JsonValue, where: string): BucketOwned {
  const o = r.object(v, where, [...OWNED_REQUIRED, "protected", "bucketCreated"]);
  r.oneOf(o.get("type"), `${where}.type`, ["r2_bucket"] as const);
  const status = r.oneOf(o.get("status"), `${where}.status`, STATUSES);
  const generation = o.get("bucketCreated");

  const bucketCreated =
    generation?.kind === "null" ? null : r.string(generation, `${where}.bucketCreated`);

  if (bucketCreated !== null && !validBucketGeneration(bucketCreated))
    r.fail(`${where}.bucketCreated`, "expected a valid UTC ISO generation timestamp or null");

  if (["created", "deleting", "deleted"].includes(status) && bucketCreated === null)
    r.fail(`${where}.bucketCreated`, `a ${status} bucket requires its generation timestamp`);

  if (o.get("physicalId")?.kind !== "null")
    r.fail(`${where}.physicalId`, "a bucket has no D1 uuid; expected null");

  return {
    type: "r2_bucket",
    logicalId: r.string(o.get("logicalId"), `${where}.logicalId`),
    name: r.string(o.get("name"), `${where}.name`),
    status,
    physicalId: null,
    protected: r.boolean(o.get("protected"), `${where}.protected`),
    bucketCreated,
    history: r.array(o.get("history"), `${where}.history`).map((h, i) => {
      const hw = `${where}.history[${i}]`;
      const ho = r.object(h, hw, ["at", "event"], ["detail"]);
      const detail = ho.get("detail");

      const entry: HistoryEntry = {
        at: r.string(ho.get("at"), `${hw}.at`),
        event: r.string(ho.get("event"), `${hw}.event`),
      };

      if (detail !== undefined) entry.detail = detailFrom(r, detail, `${hw}.detail`, true);

      return entry;
    }),
  };
}

// The ledger is this tool's own document: parsed strictly and decoded as a
// closed object, every field with its type, before any command decides on
// it. Then it must be a ledger of this tool, and every entry this run's.
export function loadLedger(dir: string): Ledger {
  const file = ledgerPath(dir);
  let text: string;

  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new LedgerError(`${file}: ${errorCode(e) ?? "not a readable ledger"}`);
  }

  const r = new JsonReader((where, detail) => {
    throw new LedgerError(`${file}: ${where}: ${detail}`);
  });

  let root: JsonValue;

  try {
    root = parseStrict(text);
  } catch (e) {
    throw new LedgerError(`${file}: ${errorMessage(e)}`);
  }

  if (root.kind !== "object") throw new LedgerError(`${file} is not a bend-infra live ledger`);
  const o = root.fields;
  const version = o.get("version");

  const field = (k: string) => {
    const v = o.get(k);

    return v?.kind === "string" ? v.value : undefined;
  };

  const run = field("run");
  const account = field("account");
  const kind = field("kind");
  const project = field("project");
  const environment = field("environment");

  const common =
    version?.kind === "number" &&
    (version.value === 1 || version.value === 2) &&
    run !== undefined &&
    /^[0-9a-f]{16}$/.test(run) &&
    account !== undefined &&
    ACCOUNT_RE.test(account);

  const legacy =
    common &&
    version.value === 1 &&
    kind === LEGACY_KIND &&
    field("consent") === CONSENT &&
    environment === ENVIRONMENT;

  const projectState =
    common &&
    kind === PROJECT_KIND &&
    project !== undefined &&
    PROJECT_RE.test(project) &&
    environment !== undefined &&
    ENVIRONMENT_RE.test(environment);

  if (!legacy && !projectState) throw new LedgerError(`${file} is not a bend-infra live ledger`);

  r.object(
    root,
    "(root)",
    legacy
      ? [
          "version",
          "kind",
          "run",
          "account",
          "environment",
          "consent",
          "wrangler",
          "createdAt",
          "resources",
        ]
      : [
          "version",
          "kind",
          "project",
          "environment",
          "account",
          "run",
          "wrangler",
          "createdAt",
          "resources",
        ],
  );

  const wrangler = r.string(o.get("wrangler"), "wrangler");
  const createdAt = r.string(o.get("createdAt"), "createdAt");

  // the identity checked above, as the ledger's own type
  const l: Ledger = legacy
    ? {
        version: 1,
        kind: LEGACY_KIND,
        run: run!,
        account: account!,
        environment: ENVIRONMENT,
        consent: CONSENT,
        wrangler,
        createdAt,
        resources: {},
      }
    : {
        version: version?.kind === "number" && version.value === 2 ? 2 : 1,
        kind: PROJECT_KIND,
        project: project!,
        environment: environment!,
        account: account!,
        run: run!,
        wrangler,
        createdAt,
        resources: {},
      };

  for (const [id, v] of r.fields(o.get("resources"), "resources")) {
    const bucket = v.kind === "object" && v.fields.get("type");

    const owned =
      l.version === 2 && bucket && bucket.kind === "string" && bucket.value === "r2_bucket"
        ? bucketFrom(r, v, `resources.${id}`)
        : ownedFrom(r, v, `resources.${id}`);

    if (
      owned.logicalId !== id ||
      owned.name !== nameOf(l, id) ||
      !NAME_RE.test(owned.name) ||
      !nameAllowed(l, owned.name)
    )
      throw new LedgerError(`ledger entry ${id} does not belong to run ${l.run}`);

    if (owned.type === "r2_bucket") {
      if (l.version !== 2) throw new LedgerError("buckets require project state version 2");
      l.resources[id] = owned;
    } else l.resources[id] = owned;
  }

  return l;
}

export function saveLedger(dir: string, l: Ledger) {
  const tmp = path.join(dir, `ledger.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, JSON.stringify(l, null, 2) + "\n");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, ledgerPath(dir));
}

export function record(
  dir: string,
  l: Ledger,
  id: string,
  patch: Partial<Owned>,
  event: string,
  detail?: HistoryDetail,
) {
  const r = l.resources[id];
  Object.assign(r, patch);
  const entry: HistoryEntry = { at: new Date().toISOString(), event };

  // an event without details records none
  if (detail !== undefined) entry.detail = detail;
  r.history.push(entry);
  saveLedger(dir, l);
}

// One command at a time per run: an exclusive lock file. A stale lock
// (a killed process) is reported, never broken automatically.
export function lock(dir: string): () => void {
  const f = path.join(dir, "lock");

  try {
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", {
      flag: "wx",
    });
  } catch (e) {
    if (errorCode(e) !== "EEXIST")
      throw new LedgerError(`${f}: ${errorCode(e) ?? "cannot create the lock"}`);
    throw new LedgerError(
      `${f} exists: another bend-infra live command holds this run (if none is running, inspect journal.jsonl and remove the lock)`,
    );
  }

  return () => fs.rmSync(f, { force: true });
}

// what is still, or possibly still, remote
export const outstanding = (l: Ledger) =>
  Object.values(l.resources).filter(
    (r) =>
      r.status === "creating" ||
      r.status === "created" ||
      r.status === "deleting" ||
      r.status === "unknown",
  );
