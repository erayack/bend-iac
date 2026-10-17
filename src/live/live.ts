// bend-infra live: one Wrangler-backed Cloudflare slice (one Worker, one D1
// database) driven by the proof-gated Bend planner.
//
//   init     a run directory: account, random run id, empty ledger
//   prepare  read-only Wrangler observation -> canonical model inputs ->
//            P.plan (the compiled core/planner.bend) -> an artifact file
//            holding the inputs, the approved ordered operations, the
//            Worker source digest and the exact generated Wrangler payload;
//            prints its sha256
//   apply    given that artifact and its sha256: re-checks digest, account,
//            run, planner result, adapter support, source bytes and the
//            live state, then runs the payload's steps in order
//   observe  read-only report of what the ledger owns and what is remote
//   cleanup  a Bend-planned teardown of exactly what the ledger owns
//
// The planner decides; this module never invents an operation. It only
// refuses: a planner outcome other than approved, an operation outside the
// supported subset, or any mismatch between the artifact and what apply
// recomputes. The artifact digest is a drift check, not a signature.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonical, decode, encode, type Operation } from "../codec";
import { load, type Stamp } from "../engine";
import { report, type Report } from "../format";
import { decodeUtf8, NoInputError, readBytes, UsageError } from "../input";
import { errorMessage } from "../errors";
import {
  JsonReader,
  matchesRecorded,
  parseStrict,
  sameJson,
  stringify,
  type JsonData,
  type JsonFields,
  type JsonValue,
} from "../json";
import {
  approvalsFrom,
  desiredFrom,
  grantFrom,
  InputError,
  observedFrom,
  parseApprovals,
  parseDesired,
  parseGrant,
  parseObserved,
  REPLICATION,
  type Approval,
  type DbDecl,
  type Desired,
  type Grant,
  type Observed,
  type Resource,
  type WorkerDecl,
} from "../schema";
import {
  CONSENT,
  ENVIRONMENT,
  initLedger,
  LEGACY_KIND,
  ledgerPath,
  loadLedger,
  lock,
  LOGICAL_RE,
  nameAllowed,
  nameOf,
  outstanding,
  physicalName,
  record,
  saveLedger,
  type Ledger,
  type Owned,
} from "./ledger";
import {
  ACCOUNT_RE,
  NAME_RE,
  build,
  checkDeploy,
  UUID_RE,
  sanitize,
  WRANGLER,
  Wrangler,
  WranglerError,
  type BaseConfig,
  type D1DeleteConfig,
  type DeleteWorkerConfig,
  type DeployConfig,
  type VersionBinding,
} from "./wrangler";

export const LIVE_EXIT = {
  ok: 0,
  failed: 1, // remote work started and did not complete; see the ledger
  rejected: 2,
  approvalRequired: 3,
  unsupported: 4,
  refused: 5, // artifact, digest, source, account or live-state mismatch
  usage: 64,
  input: 65,
  noInput: 66,
  unavailable: 69, // Wrangler could not determine remote state
  engine: 70,
  interrupted: 130,
} as const;

export class LiveError extends Error {
  constructor(
    readonly exit: number,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const say = (s: string) => process.stdout.write(s + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let interrupted = false;

function onSignals() {
  const stop = (sig: string) => {
    if (!interrupted)
      process.stderr.write(
        `bend-infra live: ${sig}: finishing the current step, then stopping (no new remote step starts)\n`,
      );
    interrupted = true;
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

// ---- the spec: desired.json, grant.json, approvals.json, Worker source ---

type Source = { file: string; abs: string; bytes: Buffer; sha256: string };

export type Spec = { des: Desired; grant: Grant; apps: Approval[]; source: Source | null };

// Where a spec's environment and Worker source come from: a disposable
// run's spec directory holds its .js file and names exactly ["e2e"]; a
// project environment's spec names exactly its environment, and the Worker
// main is a plain relative path inside the project root.
export type SpecPolicy = {
  environment: string;
  root: string;
  main: RegExp;
  mainHint: string;
  r2: boolean;
};

const MAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.m?js$/;

export const LEGACY_SPEC = (dir: string): SpecPolicy => ({
  environment: ENVIRONMENT,
  root: dir,
  main: MAIN_RE,
  mainHint: "a .js module file in the spec directory",
  r2: false,
});

function refuseR2(resources: Resource[]): void {
  if (
    resources.some(
      (r) =>
        r.type === "r2_bucket" || (r.type === "worker" && r.bindings.some((b) => "bucket" in b)),
    )
  )
    throw new LiveError(
      LIVE_EXIT.unsupported,
      "R2 planning is supported; R2 execution is not supported; nothing ran",
    );
}

export function readSpec(dir: string, policy: SpecPolicy): Spec {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    throw new NoInputError(`${dir}: not a directory`);
  const des = parseDesired(decodeUtf8("desired", readBytes(path.join(dir, "desired.json"))));

  const grant = parseGrant(
    decodeUtf8("grant", readBytes(path.join(dir, "grant.json"))),
    des.environments,
  );

  const ap = path.join(dir, "approvals.json");

  const apps = fs.existsSync(ap)
    ? parseApprovals(decodeUtf8("approvals", readBytes(ap)), des.environments)
    : [];

  const unsupported: (m: string) => never = (m) => {
    throw new LiveError(LIVE_EXIT.unsupported, `live slice: ${m}`);
  };

  if (!policy.r2) refuseR2(des.resources);

  if (!sameJson(des.environments, [policy.environment]))
    unsupported(`desired.environments must be exactly ["${policy.environment}"]`);
  const dbs = des.resources.filter((r) => r.type === "d1_database");
  const wks = des.resources.filter((r): r is WorkerDecl => r.type === "worker");

  if (dbs.length > 1 || wks.length > 1) unsupported("at most one d1_database and one worker");

  if (des.resources.filter((r) => r.type === "r2_bucket").length > 1)
    unsupported("at most one r2_bucket");

  for (const r of des.resources)
    if (!LOGICAL_RE.test(r.id))
      unsupported(`id "${r.id}" must match ${LOGICAL_RE} (it becomes part of a Cloudflare name)`);
  let source: Source | null = null;

  if (wks.length === 1) {
    const w = wks[0];

    if (!policy.main.test(w.main))
      unsupported(`worker "${w.id}" main must name ${policy.mainHint} (got "${w.main}")`);

    if (!policy.r2 && w.bindings.length > 1)
      unsupported(`worker "${w.id}" has at most one binding`);

    if (
      policy.r2 &&
      (w.bindings.filter((b) => "database" in b).length > 1 ||
        w.bindings.filter((b) => "bucket" in b).length > 1)
    )
      unsupported(`worker "${w.id}" has at most one binding per provider kind`);
    const abs = path.resolve(policy.root, w.main);
    const bytes = readBytes(abs);

    if (bytes.length > 1 << 20)
      throw new InputError("worker source", "(file)", "larger than 1 MiB");
    source = { file: w.main, abs, bytes, sha256: sha256(bytes) };
  }

  return { des, grant, apps, source };
}

// The model's Worker `main` is the source's content identity, not its file
// name, so changed bytes are an update and never a silent no-op.
function modelDesired(s: Spec): Desired {
  return {
    environments: s.des.environments,
    resources: canonical(
      s.des.resources.map((r) =>
        r.type === "worker" ? { ...r, main: `sha256:${s.source!.sha256}` } : r,
      ),
    ),
  };
}

function register(dir: string, loaded: Ledger, des: Desired): Ledger {
  let l = loaded;
  let changed = false;

  if (des.resources.some((r) => r.type === "r2_bucket")) {
    if (l.kind === LEGACY_KIND)
      throw new LiveError(LIVE_EXIT.unsupported, "R2 execution is not supported");

    if (l.version === 1) {
      // Publish promotion and registration together under the existing lock.
      // All old owner objects/metadata/history and namespace identity survive.
      l = { ...l, version: 2, resources: { ...l.resources } };
      changed = true;
    }
  }

  for (const r of des.resources) {
    const o = l.resources[r.id];

    if (o) {
      if (o.type !== r.type)
        throw new LiveError(
          LIVE_EXIT.unsupported,
          `live slice: "${r.id}" is a ${o.type} in run ${l.run}`,
        );
      continue;
    }

    const other = Object.values(l.resources).find((x) => x.type === r.type);

    if (other)
      throw new LiveError(
        LIVE_EXIT.unsupported,
        `live slice: run ${l.run} already has a ${r.type} ("${other.logicalId}"); ${l.version === 2 ? "a project state keeps one lifetime logical ID per provider kind" : "a run owns one Worker and one D1 database"}`,
      );
    const name = nameOf(l, r.id);

    if (!nameAllowed(l, name))
      throw new LiveError(
        LIVE_EXIT.unsupported,
        `live slice: "${r.id}" would be named ${name}, outside this state's namespace`,
      );
    const history = [{ at: new Date().toISOString(), event: "declared" }];

    if (r.type === "r2_bucket") {
      if (l.version !== 2)
        throw new LiveError(LIVE_EXIT.unsupported, "buckets require project state version 2");
      l.resources[r.id] = {
        type: r.type,
        logicalId: r.id,
        name,
        status: "new",
        physicalId: null,
        protected: r.protected,
        bucketCreated: null,
        history,
      };
    } else
      l.resources[r.id] = {
        type: r.type,
        logicalId: r.id,
        name,
        status: "new",
        physicalId: null,
        history,
      };
    changed = true;
  }

  if (changed) saveLedger(dir, l);

  return l;
}

// ---- observation ----------------------------------------------------------

type ProviderBindingEvidence =
  | { type: "d1"; name: string; id: string }
  | {
      type: "r2_bucket";
      name: string;
      id: null;
      r2: { bucketName: string; jurisdiction: null };
    };

type ExistingEvidence = {
  id: string;
  type: "d1_database" | "worker";
  name: string;
  present: boolean;
  uuid?: string;
  readReplication?: string | null;
  versionId?: string;
  etag?: string | null;
  message?: string | null;
  tag?: string | null;
  compatibilityDate?: string | null;
  compatibilityFlags?: string[];
  bindings?: {
    type: string;
    name: string;
    id: string | null;
    r2?: { bucketName: string; jurisdiction: string | null };
  }[];
  bucketCreated?: never;
};

type BucketEvidence = Pick<ExistingEvidence, "id" | "name" | "present"> & {
  type: "r2_bucket";
  bucketCreated: string | null;
  uuid?: never;
  readReplication?: never;
  versionId?: never;
  etag?: never;
  message?: never;
  tag?: never;
  compatibilityDate?: never;
  compatibilityFlags?: never;
  bindings?: never;
};

export type Evidence = ExistingEvidence | BucketEvidence;

const generationValid = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

function providerBindingFrom(r: JsonReader, v: JsonValue, where: string): ProviderBindingEvidence {
  const fields = r.fields(v, where);
  const type = r.oneOf(fields.get("type"), `${where}.type`, ["d1", "r2_bucket"] as const);

  const o = r.object(
    v,
    where,
    type === "d1" ? ["type", "name", "id"] : ["type", "name", "id", "r2"],
  );

  const name = r.string(o.get("name"), `${where}.name`);

  if (type === "d1") {
    const id = r.string(o.get("id"), `${where}.id`);

    if (!UUID_RE.test(id)) r.fail(`${where}.id`, "expected a D1 uuid");

    return { type, name, id };
  }

  if (o.get("id")?.kind !== "null") r.fail(`${where}.id`, "R2 bindings have no D1 uuid");

  const target = r.object(o.get("r2"), `${where}.r2`, ["bucketName", "jurisdiction"]);

  if (target.get("jurisdiction")?.kind !== "null")
    r.fail(`${where}.r2.jurisdiction`, "only default jurisdiction is supported");

  return {
    type,
    name,
    id: null,
    r2: {
      bucketName: r.string(target.get("bucketName"), `${where}.r2.bucketName`),
      jurisdiction: null,
    },
  };
}

// Evidence as an artifact recorded it, decoded for apply; each key in the
// order observe() writes it, and only the keys it wrote.
function evidenceFrom(r: JsonReader, v: JsonValue, where: string, v2 = false): Evidence {
  const fields = r.fields(v, where);
  const type = fields.get("type");

  if (v2 && type?.kind === "string" && type.value === "r2_bucket") {
    const o = r.object(v, where, ["id", "type", "name", "present", "bucketCreated"]);
    const present = r.boolean(o.get("present"), `${where}.present`);
    const generation = o.get("bucketCreated");

    const bucketCreated =
      generation?.kind === "null" ? null : r.string(generation, `${where}.bucketCreated`);

    if (
      present ? bucketCreated === null || !generationValid(bucketCreated) : bucketCreated !== null
    )
      r.fail(
        `${where}.bucketCreated`,
        "presence requires a valid generation; absence requires null",
      );

    return {
      id: r.string(o.get("id"), `${where}.id`),
      type: "r2_bucket",
      name: r.string(o.get("name"), `${where}.name`),
      present,
      bucketCreated,
    };
  }

  const o = r.object(
    v,
    where,
    ["id", "type", "name", "present"],
    [
      "uuid",
      "readReplication",
      "versionId",
      "etag",
      "message",
      "tag",
      "compatibilityDate",
      "compatibilityFlags",
      "bindings",
    ],
  );

  const text = (k: string) => r.string(o.get(k), `${where}.${k}`);

  const textOrNull = (k: string) => {
    const x = o.get(k);

    return x?.kind === "null" ? null : r.string(x, `${where}.${k}`);
  };

  const e: ExistingEvidence = {
    id: text("id"),
    type: r.oneOf(o.get("type"), `${where}.type`, ["d1_database", "worker"] as const),
    name: text("name"),
    present: r.boolean(o.get("present"), `${where}.present`),
  };

  if (o.has("uuid")) e.uuid = text("uuid");

  if (o.has("readReplication")) e.readReplication = textOrNull("readReplication");

  if (o.has("versionId")) e.versionId = text("versionId");

  if (o.has("etag")) e.etag = textOrNull("etag");

  if (o.has("message")) e.message = textOrNull("message");

  if (o.has("tag")) e.tag = textOrNull("tag");

  if (o.has("compatibilityDate")) e.compatibilityDate = textOrNull("compatibilityDate");

  if (o.has("compatibilityFlags")) {
    e.compatibilityFlags = r
      .array(o.get("compatibilityFlags"), `${where}.compatibilityFlags`)
      .map((f, i) => r.string(f, `${where}.compatibilityFlags[${i}]`));
  }

  if (o.has("bindings")) {
    e.bindings = r.array(o.get("bindings"), `${where}.bindings`).map((b, i) => {
      const bw = `${where}.bindings[${i}]`;

      if (v2) return providerBindingFrom(r, b, bw);
      const bo = r.object(b, bw, ["type", "name", "id"]);
      const id = bo.get("id");

      return {
        type: r.string(bo.get("type"), `${bw}.type`),
        name: r.string(bo.get("name"), `${bw}.name`),
        id: id?.kind === "null" ? null : r.string(id, `${bw}.id`),
      };
    });
  }

  return e;
}

type Observation = {
  observed: Observed;
  evidence: Evidence[];
  undetermined: { id: string; name: string; reason: string }[];
};

const MESSAGE_RE = /^bend-infra sha256:([0-9a-f]{64})$/;

// statuses after an intent whose outcome was ambiguous: a presence under
// the exact name is this run's own resource (the name was observed absent
// just before the intent was recorded)
const unsettled = (r: Owned) =>
  r.status === "creating" || r.status === "absent" || r.status === "unknown";

const lastIntent = (r: Owned) =>
  [...r.history].reverse().find((h) => h.event.endsWith("-intent"))?.event;

const intentSha = (r: Owned) =>
  [...r.history].reverse().find((h) => h.event === "create-intent" || h.event === "update-intent")
    ?.detail?.sourceSha256;

// A bucket's first generation can only reconcile an outstanding create
// whose immediately preceding durable event records fresh exact-name absence.
// A confirmed absence/other event after that intent closes the ambiguity.
const R2_CREATE_REJECTED = "r2-create-provider-rejected";

const bucketCreatePending = (r: Owned, allowRejected = false) => {
  if (r.status !== "creating" && r.status !== "unknown") return false;
  const intent = [...r.history].reverse().find((h) => h.event.endsWith("-intent"));

  if (!intent || intent.event !== "create-intent") return false;
  const i = r.history.indexOf(intent);

  return (
    i > 0 &&
    r.history[i - 1].event === "observed-absent-before-create" &&
    r.history
      .slice(i + 1)
      .every(
        (h) =>
          h.event === "create-outcome-unknown" &&
          (allowRejected || h.detail?.parsed !== R2_CREATE_REJECTED),
      )
  );
};

// strict (prepare, apply): every remote fact must agree with the ledger, or
// the command refuses. cleanup (observe, cleanup): disagreements are
// reported as undetermined and nothing is deleted on their basis.
async function observe(
  dir: string,
  l: Ledger,
  w: Wrangler,
  mode: "strict" | "cleanup",
): Promise<Observation> {
  const evidence: Evidence[] = [];
  const undetermined: Observation["undetermined"] = [];
  const resources: Resource[] = [];
  const dbOwned = Object.values(l.resources).find((r) => r.type === "d1_database");
  const bucketOwned = Object.values(l.resources).find((r) => r.type === "r2_bucket");

  const ordered = Object.values(l.resources).sort((a, b) => {
    // Preserve the original order/bytes for disposable and v1 runs. V2 must
    // reconcile provider identities before interpreting consumer bindings.
    const providerOrder =
      l.version === 2 ? Number(a.type === "worker") - Number(b.type === "worker") : 0;

    return providerOrder || (a.logicalId < b.logicalId ? -1 : 1);
  });

  for (const r of ordered) {
    let blocked = false;

    const fail = (reason: string) => {
      if (mode === "strict")
        throw new LiveError(LIVE_EXIT.refused, `${r.type} ${r.name}: ${reason}`);
      undetermined.push({ id: r.logicalId, name: r.name, reason });
      blocked = true;
    };

    if (r.type === "r2_bucket") {
      const uncertain = (reason: string) => {
        if (mode === "strict")
          throw new LiveError(LIVE_EXIT.unavailable, `${r.type} ${r.name}: ${reason}`);
        undetermined.push({ id: r.logicalId, name: r.name, reason });
      };

      let bucket;

      try {
        bucket = await w.r2Info(r.name);
      } catch (e) {
        if (!(e instanceof WranglerError)) throw e;
        uncertain(e.message);
        continue;
      }

      if (!bucket.present) {
        evidence.push({
          id: r.logicalId,
          type: r.type,
          name: r.name,
          present: false,
          bucketCreated: null,
        });

        if (
          r.bucketCreated !== null &&
          ["created", "creating", "deleting", "unknown"].includes(r.status)
        )
          record(dir, l, r.logicalId, { status: "deleted" }, "observed-absent-owned-generation");
        else if (r.bucketCreated === null && bucketCreatePending(r, true))
          record(dir, l, r.logicalId, { status: "absent" }, "observed-absent-after-create-attempt");
        else if (["creating", "unknown", "conflict"].includes(r.status))
          uncertain(
            `absence does not settle ledger status ${r.status} without owned generation or create intent`,
          );
        continue;
      }

      const created = bucket.info.created;
      evidence.push({
        id: r.logicalId,
        type: r.type,
        name: r.name,
        present: true,
        bucketCreated: created,
      });

      if (bucket.info.name !== r.name || !generationValid(created)) {
        uncertain("exact bucket name/generation identity is undetermined");
        continue;
      }

      if (r.bucketCreated !== null && r.bucketCreated !== created) {
        uncertain(
          `a different bucket generation (${created}) holds this name; this state recorded ${r.bucketCreated}`,
        );
        continue;
      }

      if (["new", "absent", "deleted", "conflict"].includes(r.status)) {
        if (r.status === "new")
          record(dir, l, r.logicalId, { status: "conflict" }, "name-exists-before-create");
        uncertain(`present with ledger status ${r.status}: never adopted, overwritten or deleted`);
        continue;
      }

      const deletion = [...r.history].reverse().find((h) => h.event.endsWith("-intent"));

      if (
        r.bucketCreated !== null &&
        (r.status === "deleting" || r.status === "unknown") &&
        deletion?.event === "delete-intent" &&
        deletion.detail?.bucketCreated === r.bucketCreated
      )
        record(dir, l, r.logicalId, { status: "created" }, "reconciled-present-after-delete", {
          bucketCreated: r.bucketCreated,
        });

      if (r.bucketCreated === null && bucketCreatePending(r))
        record(
          dir,
          l,
          r.logicalId,
          { status: "created", bucketCreated: created },
          "reconciled-by-exact-name",
          { bucketCreated: created },
        );
      else if (r.status !== "created" || r.bucketCreated === null) {
        uncertain(
          `present with unsettled ledger status ${r.status}; no safe first-generation create reconciliation`,
        );
        continue;
      }

      resources.push({
        type: "r2_bucket",
        id: r.logicalId,
        environment: l.environment,
        protected: r.protected,
      });
      continue;
    }

    const absent = () => {
      evidence.push({ id: r.logicalId, type: r.type, name: r.name, present: false });

      if (r.status === "creating")
        record(dir, l, r.logicalId, { status: "absent" }, "observed-absent-after-create-attempt");
      else if (r.status === "deleting")
        record(dir, l, r.logicalId, { status: "deleted" }, "observed-absent-after-delete");
      else if (r.status === "unknown") {
        const deleting = lastIntent(r) === "delete-intent";
        record(
          dir,
          l,
          r.logicalId,
          { status: deleting ? "deleted" : "absent" },
          deleting ? "observed-absent-after-delete" : "observed-absent-after-create-attempt",
        );
      } else if (r.status === "created") {
        if (mode === "strict")
          fail(
            "created by this run but now absent remotely (removed out of band?); run `live cleanup` or start a new run",
          );
        else record(dir, l, r.logicalId, { status: "deleted" }, "observed-absent");
      }
    };

    const presentButNotOurs = (): boolean => {
      if (r.status === "new") {
        record(dir, l, r.logicalId, { status: "conflict" }, "name-exists-before-create");
        fail(
          "the exact name already exists and this run never created it: it is not adopted, overwritten or deleted",
        );

        return true;
      }

      if (r.status === "conflict") {
        fail("the name belonged to someone else before this run: never touched");

        return true;
      }

      if (r.status === "deleted") {
        fail("recorded deleted, but the name is present again");

        return true;
      }

      return false;
    };

    let got;

    try {
      got = r.type === "d1_database" ? await w.d1Info(r.name) : await w.deploymentStatus(r.name);
    } catch (e) {
      if (!(e instanceof WranglerError)) throw e;

      if (mode === "strict") throw new LiveError(LIVE_EXIT.unavailable, `${r.name}: ${e.message}`);
      undetermined.push({ id: r.logicalId, name: r.name, reason: e.message });
      continue;
    }

    if (!got.present) {
      absent();
      continue;
    }

    if (presentButNotOurs()) continue;

    if (r.type === "d1_database" && "info" in got) {
      const uuid = got.info.uuid;
      const rr = got.info.readReplication;
      evidence.push({
        id: r.logicalId,
        type: r.type,
        name: r.name,
        present: true,
        uuid,
        readReplication: rr,
      });

      if (r.physicalId !== null && r.physicalId !== uuid) {
        fail(`a different database (${uuid}) holds this name; this run recorded ${r.physicalId}`);
        continue;
      }

      if (unsettled(r))
        record(
          dir,
          l,
          r.logicalId,
          { status: "created", physicalId: uuid },
          "reconciled-by-exact-name",
          { uuid },
        );

      // the observed mode, else (none observed) the one this run recorded
      const mode = rr === null ? r.readReplication : REPLICATION.find((x) => x === rr);

      if (mode === undefined) {
        fail(
          rr === null
            ? "no read replication mode observed or recorded"
            : `unknown read replication mode "${rr}"`,
        );
        continue;
      }

      if (r.location === undefined) {
        fail("this run's ledger records no location for it");
        continue;
      }

      if (blocked) continue;
      resources.push({
        type: "d1_database",
        id: r.logicalId,
        environment: l.environment,
        location: r.location,
        readReplication: mode,
        protected: r.protected === true,
      });
      continue;
    }

    if (r.type === "worker" && "deployment" in got) {
      const vs = got.deployment.versions;
      let v = null;

      if (vs.length === 1 && vs[0].percentage === 100) {
        try {
          v = await w.versionView(r.name, vs[0].version_id);
        } catch (e) {
          if (!(e instanceof WranglerError)) throw e;

          if (mode === "strict")
            throw new LiveError(LIVE_EXIT.unavailable, `${r.name}: ${e.message}`);
        }
      }

      const ev: Evidence = !v
        ? { id: r.logicalId, type: r.type, name: r.name, present: true }
        : {
            id: r.logicalId,
            type: r.type,
            name: r.name,
            present: true,
            versionId: v.id,
            etag: v.etag,
            message: v.message,
            tag: v.tag,
            compatibilityDate: v.compatibilityDate,
            compatibilityFlags: v.compatibilityFlags,
            bindings: v.bindings,
          };

      evidence.push(ev);
      const m = MESSAGE_RE.exec(ev.message ?? "");

      if (mode === "cleanup") {
        // the exact name of a Worker this run set out to create (after
        // observing the name absent) is this run's to delete, whatever
        // its current version
        if (unsettled(r)) {
          record(
            dir,
            l,
            r.logicalId,
            {
              status: "created",
              versionId: ev.versionId ?? null,
              etag: ev.etag ?? null,
              sourceSha256: m?.[1] ?? null,
            },
            "reconciled-by-exact-name",
            { versionId: ev.versionId ?? null },
          );
        }

        resources.push(cleanupWorker(r, l.environment));
        continue;
      }

      if (!v) fail(`expected one version at 100% of traffic, got ${JSON.stringify(vs)}`);

      if (unsettled(r)) {
        // an ambiguous create or update: reconciled only if it carries the source we meant to deploy
        if (m && m[1] === intentSha(r) && ev.tag === `run-${l.run}`) {
          record(
            dir,
            l,
            r.logicalId,
            { status: "created", versionId: ev.versionId, etag: ev.etag, sourceSha256: m[1] },
            "reconciled-by-exact-name",
            { versionId: ev.versionId },
          );
        } else {
          fail(
            "present under this run's name after an ambiguous create, but without this run's annotation",
          );
        }
      } else if (ev.versionId !== r.versionId || ev.etag !== r.etag) {
        fail(
          `deployed version ${ev.versionId} (etag ${ev.etag}) is not the one this run recorded (${r.versionId}, ${r.etag}): changed outside this run`,
        );
      }

      if (!m || m[1] !== r.sourceSha256)
        fail(
          `version message ${JSON.stringify(ev.message)} does not carry the recorded source sha256`,
        );

      if (ev.tag !== `run-${l.run}`)
        fail(`version tag ${JSON.stringify(ev.tag)} is not run-${l.run}`);

      if (ev.compatibilityFlags!.length > 0)
        fail(`compatibility flags ${JSON.stringify(ev.compatibilityFlags)} are not modelled`);

      if (!ev.compatibilityDate || !/^\d{4}-\d{2}-\d{2}$/.test(ev.compatibilityDate))
        fail("no compatibility date observed");

      const binds = ev.bindings!.flatMap<WorkerDecl["bindings"][number]>((b) => {
        if (l.version !== 2) {
          if (b.type !== "d1" || !dbOwned || b.id !== dbOwned.physicalId)
            fail(`binding ${JSON.stringify(b)} is not a D1 binding to this run's database`);

          return [{ name: b.name, database: dbOwned!.logicalId }];
        }

        // A confirmed-absent provider still keeps its lifetime logical ID.
        // Mapping is by recorded target identity; support separately checks
        // any provider creation needed by the desired consumer.
        if (
          b.type === "d1" &&
          dbOwned &&
          dbOwned.physicalId !== null &&
          b.id === dbOwned.physicalId
        )
          return [{ name: b.name, database: dbOwned.logicalId }];

        if (
          b.type === "r2_bucket" &&
          b.id === null &&
          bucketOwned &&
          b.r2?.bucketName === bucketOwned.name &&
          b.r2.jurisdiction === null
        )
          return [{ name: b.name, bucket: bucketOwned.logicalId }];
        fail(
          `binding ${JSON.stringify(b)} is not a default-jurisdiction binding to this state's recorded provider`,
        );

        return [];
      });

      if (
        l.version === 2 &&
        (binds.filter((b) => "database" in b).length > 1 ||
          binds.filter((b) => "bucket" in b).length > 1)
      )
        fail("at most one binding per provider kind is modelled");

      resources.push({
        type: "worker",
        id: r.logicalId,
        environment: l.environment,
        main: `sha256:${m![1]}`,
        compatibilityDate: ev.compatibilityDate!,
        bindings: binds,
      });
    }
  }

  const doc = {
    version: 1,
    kind: "bend-infra/observed",
    source: "wrangler",
    resources: canonical(resources),
  };

  return {
    observed: parseObserved(JSON.stringify(doc), [l.environment], "wrangler"),
    evidence,
    undetermined,
  };
}

// for a teardown, only the id, kind and environment of an observed Worker
// matter: the plan deletes it
const cleanupWorker = (r: Owned, environment: string): Resource => ({
  type: "worker",
  id: r.logicalId,
  environment,
  main: `sha256:${r.sourceSha256 ?? "unknown"}`,
  compatibilityDate: "2000-01-01",
  bindings: [],
});

// ---- planning: the compiled Bend planner, unchanged ---------------------

async function runPlanner(
  des: Desired,
  obs: Observed,
  grant: Grant,
  apps: Approval[],
): Promise<{ rep: Report; stamp: Stamp }> {
  const planner = await load();
  const enc = encode(des, obs, grant, apps);
  const out = decode(planner.plan(...enc.args), enc.tables);

  return { rep: report(out, des, obs, grant, apps, planner.stamp), stamp: planner.stamp };
}

// The supported subset, checked over the whole operation list before any
// remote work: create D1 (no read replication), create or update the Worker
// with at most the one D1 binding, delete the Worker, delete the D1
// database after its consumer. Everything else fails closed.
function v2EvidenceProblems(
  des: Desired,
  obs: Observed | undefined,
  l: Ledger,
  ev: Evidence[],
  cleanup = false,
): string[] {
  const problems: string[] = [];
  const bad = (why: string) => problems.push(`project v2 evidence: ${why}`);
  const owned = Object.values(l.resources);

  if (!obs) return ["project v2 requires its recorded observed snapshot"];

  for (const type of ["d1_database", "r2_bucket", "worker"] as const)
    if (
      owned.filter((r) => r.type === type).length > 1 ||
      des.resources.filter((r) => r.type === type).length > 1
    )
      bad(`at most one lifetime ${type}`);

  for (const d of des.resources)
    if (!l.resources[d.id] || l.resources[d.id].type !== d.type || d.environment !== l.environment)
      bad(`desired ${d.id} is not this state's provider kind/environment`);

  if (new Set(ev.map((e) => e.id)).size !== ev.length) bad("duplicate resource evidence");

  for (const e of ev) {
    const r = l.resources[e.id];

    if (!r || r.type !== e.type || r.name !== e.name)
      bad(`${e.id} has foreign type/name/ownership`);
  }

  for (const r of owned) {
    const e = ev.find((x) => x.id === r.logicalId);
    const model = obs.resources.find((x) => x.id === r.logicalId);

    if (!e) {
      bad(`${r.logicalId} existence is undetermined`);
      continue;
    }

    if (
      e.present !== Boolean(model) ||
      (model && (model.type !== r.type || model.environment !== l.environment))
    )
      bad(`${r.logicalId} snapshot presence/type/environment differs`);

    if (e.present ? r.status !== "created" : !["new", "absent", "deleted"].includes(r.status))
      bad(`${r.logicalId} ledger status is ${r.status}; not settled ownership/absence`);

    if (!e.present) continue;

    if (r.type === "r2_bucket") {
      if (e.type !== "r2_bucket" || !r.bucketCreated || e.bucketCreated !== r.bucketCreated)
        bad(`${r.logicalId} generation differs from owned bucket`);

      if (model?.type !== "r2_bucket" || model.protected !== r.protected)
        bad(`${r.logicalId} snapshot protection differs from local metadata`);
    } else if (r.type === "d1_database") {
      if (!r.physicalId || e.uuid !== r.physicalId || !UUID_RE.test(r.physicalId))
        bad(`${r.logicalId} D1 uuid differs from owned database`);

      if (
        model?.type !== "d1_database" ||
        model.location !== r.location ||
        model.readReplication !== r.readReplication ||
        model.protected !== (r.protected === true)
      )
        bad(`${r.logicalId} snapshot differs from owned database metadata`);
    } else {
      // Teardown may delete an owned Worker despite version/config drift.
      // Provider deletion still requires the consumer gate and fresh check.
      if (cleanup) continue;

      if (
        !e.bindings ||
        !e.compatibilityFlags ||
        e.compatibilityFlags.length !== 0 ||
        !e.versionId ||
        e.versionId !== r.versionId ||
        e.etag !== r.etag ||
        !r.sourceSha256 ||
        e.message !== `bend-infra sha256:${r.sourceSha256}` ||
        e.tag !== `run-${l.run}`
      )
        bad(`${r.logicalId} Worker identity/bindings/flags are undetermined or drifted`);

      const bindings = (e.bindings ?? []).flatMap<WorkerDecl["bindings"][number]>((b) => {
        const target = owned.find((p) =>
          b.type === "d1"
            ? p.type === "d1_database" && b.id === p.physicalId
            : b.type === "r2_bucket" && p.type === "r2_bucket" && b.r2?.bucketName === p.name,
        );

        if (!target || (b.type === "r2_bucket" && (b.id !== null || b.r2?.jurisdiction !== null))) {
          bad(`${r.logicalId} binding ${b.name} has a foreign provider target`);

          return [];
        }

        return target.type === "d1_database"
          ? [{ name: b.name, database: target.logicalId }]
          : [{ name: b.name, bucket: target.logicalId }];
      });

      if (
        (e.bindings ?? []).filter((b) => b.type === "d1").length > 1 ||
        (e.bindings ?? []).filter((b) => b.type === "r2_bucket").length > 1
      )
        bad(`${r.logicalId} has multiple bindings of one provider kind`);

      if (
        model?.type !== "worker" ||
        model.main !== `sha256:${r.sourceSha256}` ||
        model.compatibilityDate !== e.compatibilityDate ||
        !sameJson(model.bindings, bindings)
      )
        bad(`${r.logicalId} Worker snapshot differs from its typed evidence`);
    }
  }

  for (const model of obs.resources)
    if (!l.resources[model.id]) bad(`${model.id} snapshot resource is not owned`);

  return problems;
}

function support(
  ops: Operation[],
  des: Desired,
  l: Ledger,
  ev: Evidence[],
  obs?: Observed,
  cleanup = false,
): string[] {
  const problems: string[] = l.version === 2 ? v2EvidenceProblems(des, obs, l, ev, cleanup) : [];
  const present = new Map(ev.map((e) => [e.id, e.present]));
  const db = Object.values(l.resources).find((r) => r.type === "d1_database");
  const wk = Object.values(l.resources).find((r) => r.type === "worker");
  const bucket = Object.values(l.resources).find((r) => r.type === "r2_bucket");
  ops.forEach((o, i) => {
    const at = `step ${i + 1} (${o.action} ${o.type} "${o.id}")`;
    const r = l.resources[o.id];

    if (!r || r.type !== o.type) return problems.push(`${at}: not a resource of run ${l.run}`);

    if (o.environment !== l.environment)
      return problems.push(`${at}: environment "${o.environment}" is not ${l.environment}`);

    const dbDecl = des.resources.find(
      (x): x is DbDecl => x.id === o.id && x.type === "d1_database",
    );

    const wkDecl = des.resources.find((x): x is WorkerDecl => x.id === o.id && x.type === "worker");

    const bindsOk = (w: WorkerDecl | undefined) => {
      if (!w) {
        problems.push(`${at}: not a worker of the desired graph`);

        return;
      }

      if (
        l.version === 2 &&
        (w.bindings.filter((b) => "database" in b).length > 1 ||
          w.bindings.filter((b) => "bucket" in b).length > 1)
      )
        problems.push(`${at}: at most one binding to each provider kind`);

      for (const b of w.bindings) {
        if ("database" in b) {
          if (!db || b.database !== db.logicalId || !present.get(b.database))
            problems.push(
              `${at}: binding ${b.name} must target this run's D1 database, created before the Worker`,
            );
        } else if (l.version !== 2)
          throw new LiveError(LIVE_EXIT.unsupported, "R2 execution is not supported");
        else if (!bucket || b.bucket !== bucket.logicalId || !present.get(b.bucket))
          problems.push(
            `${at}: binding ${b.name} must target this state's bucket, created before the Worker`,
          );
      }
    };

    // Project identity survives a confirmed deletion. Reuse that exact
    // logical id/name only with explicit absence evidence; execute checks
    // the exact name again immediately before recording the new intent.
    const recreatable =
      l.kind !== LEGACY_KIND && r.status === "deleted" && present.get(o.id) === false;

    switch (`${o.action} ${o.type}`) {
      case "create d1_database":
        if (present.get(o.id)) problems.push(`${at}: already present remotely`);

        if (r.status !== "new" && r.status !== "absent" && !recreatable)
          problems.push(`${at}: ledger status is ${r.status}; a run creates each resource once`);

        if (!dbDecl) problems.push(`${at}: not a d1_database of the desired graph`);
        else if (dbDecl.readReplication !== "disabled")
          problems.push(
            `${at}: creating with readReplication "${dbDecl.readReplication}" is not supported`,
          );
        present.set(o.id, true);

        return;
      case "create r2_bucket":
        if (l.version !== 2) problems.push(`${at}: buckets require project v2`);

        if (present.get(o.id) !== false)
          problems.push(`${at}: explicit exact-name absence is required`);

        if (r.status !== "new" && r.status !== "absent" && !recreatable)
          problems.push(`${at}: ledger status is ${r.status}; cannot create a new generation`);

        if (!des.resources.some((d) => d.id === o.id && d.type === "r2_bucket"))
          problems.push(`${at}: not a desired bucket`);
        present.set(o.id, true);

        return;
      case "update r2_bucket": {
        const d = des.resources.find((x) => x.id === o.id);

        if (
          l.version !== 2 ||
          r.type !== "r2_bucket" ||
          !present.get(o.id) ||
          r.status !== "created" ||
          !r.bucketCreated ||
          ev.find((e) => e.id === o.id)?.bucketCreated !== r.bucketCreated ||
          r.protected !== false ||
          d?.type !== "r2_bucket" ||
          d.protected !== true ||
          !sameJson(o.reasons, ["protected"])
        )
          problems.push(`${at}: only FProtect false-to-true on the owned generation is supported`);

        return;
      }

      case "delete r2_bucket": {
        if (
          l.version !== 2 ||
          r.type !== "r2_bucket" ||
          !present.get(o.id) ||
          r.status !== "created" ||
          !r.bucketCreated ||
          ev.find((e) => e.id === o.id)?.bucketCreated !== r.bucketCreated
        )
          problems.push(
            `${at}: not a bucket this state owns and observes at the recorded generation`,
          );

        if (wk && present.get(wk.logicalId) !== false) {
          const updated = ops
            .slice(0, i)
            .some((p) => p.id === wk.logicalId && p.action === "update");

          const desiredWorker = des.resources.find((d) => d.id === wk.logicalId);
          const binds = ev.find((e) => e.id === wk.logicalId)?.bindings;

          const safe = updated
            ? desiredWorker?.type === "worker" &&
              !desiredWorker.bindings.some((b) => "bucket" in b && b.bucket === o.id)
            : binds !== undefined &&
              !binds.some((b) => b.type === "r2_bucket" && b.r2?.bucketName === r.name);

          if (!present.has(wk.logicalId) || !safe)
            problems.push(
              `${at}: Worker existence/bindings do not positively permit bucket deletion`,
            );
        }

        present.set(o.id, false);

        return;
      }

      case "create worker":
        if (present.get(o.id)) problems.push(`${at}: already present remotely`);

        if (r.status !== "new" && r.status !== "absent" && !recreatable)
          problems.push(`${at}: ledger status is ${r.status}; a run creates each resource once`);
        bindsOk(wkDecl);
        present.set(o.id, true);

        return;
      case "update worker":
        if (!present.get(o.id) || r.status !== "created")
          problems.push(`${at}: not a Worker this run created and observes`);

        for (const why of o.reasons)
          if (!["main", "compatibilityDate", "bindings"].includes(why))
            problems.push(`${at}: update reason "${why}" is not supported`);
        bindsOk(wkDecl);

        return;
      case "delete worker":
        if (!present.get(o.id) || r.status !== "created")
          problems.push(`${at}: not a Worker this run created and observes`);
        present.set(o.id, false);

        return;
      case "delete d1_database": {
        if (!present.get(o.id) || r.status !== "created" || !r.physicalId)
          problems.push(`${at}: not a D1 database this run created and observes`);

        if (wk && !present.has(wk.logicalId)) {
          problems.push(
            `${at}: whether the run's Worker ${wk.name} exists was not determined; it may still bind the database`,
          );
        } else if (
          wk &&
          present.get(wk.logicalId) &&
          !ops.slice(0, i).some((p) => p.id === wk.logicalId && p.action === "update")
        ) {
          const binds = ev.find((e) => e.id === wk.logicalId)?.bindings;

          if (!binds)
            problems.push(
              `${at}: the Worker's bindings were not observed; it may still bind the database`,
            );
          else if (binds.some((b) => b.id === r.physicalId))
            problems.push(`${at}: the Worker still binds it`);
        }

        present.set(o.id, false);

        return;
      }

      default:
        problems.push(
          `${at}: ${o.action} of a ${o.type}${o.reasons.length ? ` (${o.reasons.join(", ")})` : ""} is not supported by the live slice`,
        );
    }
  });

  return problems;
}

// ---- the payload: exactly what apply will run ----------------------------

// one payload step: the fixed argument and config document of its purpose
export type Step = {
  step: number;
  action: Operation["action"];
  type: Operation["type"];
  id: string;
  name: string;
} & (
  | { purpose: "d1-create"; args: string[]; config: BaseConfig }
  | { purpose: "deploy"; args: string[]; config: DeployConfig; sourceSha256: string }
  | { purpose: "delete-worker"; args: string[]; config: DeleteWorkerConfig }
  | { purpose: "d1-delete"; args: string[]; config: D1DeleteConfig }
  | { purpose: "r2-create" | "r2-delete"; args: string[]; config: BaseConfig }
  | { purpose: "protect-bucket"; bucketCreated: string; protected: true }
);

const placeholder = (id: string) => `{uuid of d1_database "${id}" created by an earlier step}`;

function payload(
  ops: Operation[],
  des: Desired,
  l: Ledger,
  ev: Evidence[],
  source: Source | null,
): Step[] {
  return ops.map((o, i): Step => {
    const r = l.resources[o.id];
    const head = { step: i + 1, action: o.action, type: o.type, id: o.id, name: r.name };
    const d = des.resources.find((x) => x.id === o.id);

    const undeclared = (): never => {
      throw new LiveError(LIVE_EXIT.unsupported, `no ${o.type} "${o.id}" in the desired graph`);
    };

    switch (`${o.action} ${o.type}`) {
      case "create d1_database":
        return {
          ...head,
          purpose: "d1-create",
          args: build.d1CreateArgs(r.name, d?.type === "d1_database" ? d.location : undeclared()),
          config: build.base(l.account),
        };
      case "create worker":
      case "update worker": {
        const w = d?.type === "worker" ? d : undeclared();

        const d1 = w.bindings
          .filter((b) => "database" in b)
          .map((b) => {
            const createdHere = ops
              .slice(0, i)
              .some((p) => p.action === "create" && p.id === b.database);

            return {
              binding: b.name,
              database_name: l.resources[b.database].name,
              database_id: createdHere
                ? placeholder(b.database)
                : ev.find((e) => e.id === b.database)!.uuid!,
            };
          });

        return {
          ...head,
          purpose: "deploy",
          args: build.deployArgs(l.run, source!.sha256),
          config: build.deployConfig(
            l.account,
            r.name,
            w.compatibilityDate,
            d1,
            w.bindings
              .filter((b) => "bucket" in b)
              .map((b) => ({
                binding: b.name,
                bucket_name: l.resources[b.bucket].name,
              })),
          ),
          sourceSha256: source!.sha256,
        };
      }

      case "create r2_bucket":
      case "delete r2_bucket":
        return {
          ...head,
          purpose: o.action === "create" ? "r2-create" : "r2-delete",
          args: o.action === "create" ? build.r2CreateArgs(r.name) : build.r2DeleteArgs(r.name),
          config: build.base(l.account),
        };
      case "update r2_bucket":
        if (r.type !== "r2_bucket" || !r.bucketCreated)
          throw new LiveError(
            LIVE_EXIT.unsupported,
            "bucket protection requires its owned generation",
          );

        return {
          ...head,
          purpose: "protect-bucket",
          bucketCreated: r.bucketCreated,
          protected: true,
        };
      case "delete worker":
        return {
          ...head,
          purpose: "delete-worker",
          args: build.deleteWorkerArgs(r.name),
          config: build.deleteWorkerConfig(l.account, r.name),
        };
      case "delete d1_database":
        return {
          ...head,
          purpose: "d1-delete",
          args: build.d1DeleteArgs(r.name),
          config: build.d1DeleteConfig(l.account, r.name, ev.find((e) => e.id === o.id)!.uuid!),
        };
      default:
        throw new LiveError(LIVE_EXIT.unsupported, `no payload for ${o.action} ${o.type}`);
    }
  });
}

// ---- the artifact ---------------------------------------------------------

const TRUST =
  "The sha256 of this file is a drift check that apply re-verifies against the caller's digest. It is not a signature and authenticates no one: anyone who can write this file can write a consistent new one.";

type ArtifactSource = { file: string; path: string; sha256: string; bytes: number; stored: string };

type Purpose = "plan" | "cleanup";

// an artifact's identity, in the order written: a disposable run's
// artifact keeps its original fields; a project environment's adds its
// project and has its own kind, so neither is read as the other
type ArtifactHead =
  | {
      version: 1;
      kind: "bend-infra/live-artifact";
      purpose: Purpose;
      run: string;
      account: string;
      environment: string;
    }
  | {
      version: 1 | 2;
      kind: "bend-iac/project-artifact";
      project: string;
      purpose: Purpose;
      run: string;
      account: string;
      environment: string;
    };

const head = (l: Ledger, purpose: Purpose): ArtifactHead =>
  l.kind === LEGACY_KIND
    ? {
        version: 1,
        kind: "bend-infra/live-artifact",
        purpose,
        run: l.run,
        account: l.account,
        environment: l.environment,
      }
    : {
        version: l.version,
        kind: "bend-iac/project-artifact",
        project: l.project,
        purpose,
        run: l.run,
        account: l.account,
        environment: l.environment,
      };

type Artifact = ArtifactHead & {
  wrangler: string[];
  engine: Stamp;
  preparedAt: string;
  inputs: InputDocs;
  outcome: Report["outcome"];
  executable: boolean;
  operations: Report["operations"];
  problems: Report["problems"];
  unsupported: string[];
  resources: { id: string; type: string; name: string }[];
  observation: Evidence[];
  source: ArtifactSource | null;
  payload: Step[];
  trust: string;
};

// the canonical model inputs, as the four documents (re-read by apply)
const docs = (des: Desired, obs: Observed, grant: Grant, apps: Approval[]) => ({
  desired: {
    version: 1,
    kind: "bend-infra/desired",
    environments: des.environments,
    resources: canonical(des.resources),
  },
  observed: {
    version: 1,
    kind: "bend-infra/observed",
    source: obs.source,
    resources: canonical(obs.resources),
  },
  grant: {
    version: 1,
    kind: "bend-infra/grant",
    environment: grant.environment,
    allow: grant.allow,
  },
  approvals: { version: 1, kind: "bend-infra/approvals", approvals: apps },
});

type Written = { file: string; digest: string };

type InputDocs = ReturnType<typeof docs>;

function writeArtifact(dir: string, a: Artifact): Written {
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  const text = JSON.stringify(a, null, 2) + "\n";
  const n = fs.readdirSync(path.join(dir, "artifacts")).length + 1;

  const file = path.join(
    dir,
    "artifacts",
    `${String(n).padStart(3, "0")}-${a.purpose}-${a.outcome}.json`,
  );

  fs.writeFileSync(file, text, { flag: "wx" });

  return { file, digest: sha256(text) };
}

function storeSource(dir: string, s: Source): string {
  const rel = path.join("sources", `${s.sha256}.js`);
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  if (!fs.existsSync(abs)) fs.writeFileSync(abs, s.bytes, { flag: "wx" });

  if (sha256(fs.readFileSync(abs)) !== s.sha256)
    throw new LiveError(LIVE_EXIT.refused, `${abs} does not hold the source it is named after`);

  return rel;
}

// ---- execution ------------------------------------------------------------

async function pollUntil<T>(
  tries: number,
  gapMs: number,
  f: () => Promise<T>,
  done: (t: T) => boolean,
): Promise<T> {
  let last = await f();

  for (let i = 1; i < tries && !done(last); i++) {
    await sleep(gapMs);
    last = await f();
  }

  return last;
}

async function tryRead<T>(f: () => Promise<T>): Promise<T | "undetermined"> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof WranglerError) return "undetermined";
    throw e;
  }
}

type Ctx = {
  dir: string;
  l: Ledger;
  w: Wrangler;
  des: Desired;
  digest: string;
  source: Buffer | null;
  log: (s: string) => void;
};

// Independent fresh consumer check, after any earlier verified update/delete.
// A split, unreadable version or unmodelled binding is not non-binding evidence.
async function checkBucketConsumer(l: Ledger, w: Wrangler, name: string) {
  const worker = Object.values(l.resources).find((r) => r.type === "worker");

  if (!worker) return;
  const status = await tryRead(() => w.deploymentStatus(worker.name));

  if (status !== "undetermined" && !status.present) return;

  if (
    status === "undetermined" ||
    status.deployment.versions.length !== 1 ||
    status.deployment.versions[0].percentage !== 100
  )
    throw new LiveError(
      LIVE_EXIT.unavailable,
      `${worker.name}: Worker existence/version is undetermined; bucket ${name} is not deleted`,
    );

  const v = await tryRead(() =>
    w.versionView(worker.name, status.deployment.versions[0].version_id),
  );

  if (
    v === "undetermined" ||
    v.compatibilityFlags.length > 0 ||
    v.bindings.some(
      (b) =>
        !/^[A-Z][A-Z0-9_]*$/.test(b.name) ||
        (b.type === "d1"
          ? !UUID_RE.test(b.id ?? "") || b.r2 !== undefined
          : b.type !== "r2_bucket" ||
            b.id !== null ||
            !b.r2 ||
            b.r2.jurisdiction !== null ||
            !NAME_RE.test(b.r2.bucketName)),
    ) ||
    new Set(v.bindings.map((b) => b.name)).size !== v.bindings.length ||
    v.bindings.filter((b) => b.type === "d1").length > 1 ||
    v.bindings.filter((b) => b.type === "r2_bucket").length > 1
  )
    throw new LiveError(
      LIVE_EXIT.unavailable,
      `${worker.name}: Worker bindings are undetermined; bucket ${name} is not deleted`,
    );

  if (v.bindings.some((b) => b.type === "r2_bucket" && b.r2?.bucketName === name))
    throw new LiveError(
      LIVE_EXIT.refused,
      `${worker.name}: Worker still binds bucket ${name}; not deleted`,
    );
}

async function execute(c: Ctx, steps: Step[]) {
  const { dir, l, w } = c;
  const createdHere = new Map<string, string>();

  for (const s of steps) {
    if (interrupted)
      throw new LiveError(
        LIVE_EXIT.interrupted,
        `interrupted before step ${s.step}; no further step ran`,
      );
    const r = l.resources[s.id];
    const at = `step ${s.step} (${s.action} ${s.type} ${r.name})`;

    const failed: (m: string) => never = (m) => {
      throw new LiveError(LIVE_EXIT.failed, `${at}: ${m}`);
    };

    c.log(`  ${s.step}. ${s.action} ${s.type} ${r.name}`);

    switch (s.purpose) {
      case "r2-create": {
        const d = c.des.resources.find((x) => x.id === s.id);

        if (
          l.version !== 2 ||
          r.type !== "r2_bucket" ||
          s.type !== r.type ||
          s.name !== r.name ||
          s.action !== "create" ||
          d?.type !== "r2_bucket" ||
          !["new", "absent", "deleted"].includes(r.status)
        )
          throw new LiveError(LIVE_EXIT.refused, `${at}: not an approved new bucket generation`);
        const pre = await w.r2Info(r.name);

        if (pre.present) {
          record(dir, l, s.id, { status: "conflict" }, "name-exists-before-create");
          throw new LiveError(
            LIVE_EXIT.refused,
            `${at}: the exact bucket name already exists; never adopted`,
          );
        }

        record(dir, l, s.id, {}, "observed-absent-before-create", {
          artifact: c.digest,
          step: s.step,
        });
        record(
          dir,
          l,
          s.id,
          { status: "creating", physicalId: null, bucketCreated: null, protected: d.protected },
          "create-intent",
          { artifact: c.digest, step: s.step },
        );
        const res = await w.r2Create(r.name);
        const diagnostics = sanitize(res.err, 4 << 20);

        // Official BucketConflict (10073) is a denial, not ambiguous ownership.
        // Other explicit API rejections also forbid presence reconciliation.
        // Pinned Wrangler retains API error codes in [code: ...] notes.
        if (/\[code:\s*10073\]/.test(diagnostics)) {
          record(dir, l, s.id, { status: "conflict" }, "create-name-conflict", { exit: res.code });
          failed("R2 create reported BucketConflict; the bucket is never adopted or deleted");
        }

        const rejected =
          /\[code:\s*\d+\]/.test(diagnostics) ||
          /A\s+request\s+to\s+the\s+Cloudflare\s+API\s*\(/.test(diagnostics);

        if (res.code !== 0 || res.signal !== null || res.timedOut || rejected) {
          record(dir, l, s.id, { status: "unknown" }, "create-outcome-unknown", {
            exit: res.code,
            parsed: rejected ? R2_CREATE_REJECTED : null,
          });
          failed(
            `R2 create exited ${res.code}; outcome requires exact-name reconciliation, not a create retry`,
          );
        }

        const back = await pollUntil(
          3,
          4_000,
          () => tryRead(() => w.r2Info(r.name)),
          (x) => x !== "undetermined" && x.present,
        );

        if (
          back !== "undetermined" &&
          back.present &&
          back.info.name === r.name &&
          generationValid(back.info.created)
        ) {
          record(dir, l, s.id, { status: "created", bucketCreated: back.info.created }, "created", {
            bucketCreated: back.info.created,
          });
          c.log(`     created R2 generation ${back.info.created}`);
          break;
        }

        if (back !== "undetermined" && !back.present) {
          record(dir, l, s.id, { status: "absent" }, "create-failed-absent", { exit: res.code });
          failed("R2 create returned success but exact-name absence was observed; stopping");
        }

        record(dir, l, s.id, { status: "unknown" }, "create-outcome-unknown", { exit: res.code });
        failed("R2 create readback is undetermined; no create retry was attempted");
      }

      case "r2-delete": {
        if (
          l.version !== 2 ||
          r.type !== "r2_bucket" ||
          s.type !== r.type ||
          s.name !== r.name ||
          s.action !== "delete" ||
          r.status !== "created" ||
          !r.bucketCreated
        )
          throw new LiveError(LIVE_EXIT.refused, `${at}: not an owned bucket generation`);
        const generation = r.bucketCreated;
        await checkBucketConsumer(l, w, r.name);
        const pre = await w.r2Info(r.name);

        if (!pre.present || pre.info.name !== r.name || pre.info.created !== generation)
          throw new LiveError(
            LIVE_EXIT.unavailable,
            `${at}: exact owned generation ${generation} was not confirmed; not deleted`,
          );
        record(dir, l, s.id, { status: "deleting" }, "delete-intent", {
          artifact: c.digest,
          step: s.step,
          bucketCreated: generation,
        });
        const res = await w.r2Delete(r.name);

        const back = await pollUntil(
          4,
          4_000,
          () => tryRead(() => w.r2Info(r.name)),
          (x) => x !== "undetermined" && !x.present,
        );

        if (back !== "undetermined" && !back.present) {
          record(dir, l, s.id, { status: "deleted" }, "deleted", {
            exit: res.code,
            bucketCreated: generation,
          });

          if (res.code !== 0 || res.signal !== null || res.timedOut)
            failed(
              `R2 delete exited ${res.code}, but absence is confirmed; stopping after this step`,
            );
          c.log(`     absent R2 generation ${generation}`);
          break;
        }

        const same =
          back !== "undetermined" &&
          back.present &&
          back.info.name === r.name &&
          back.info.created === generation;

        record(dir, l, s.id, { status: same ? "created" : "unknown" }, "delete-not-confirmed", {
          exit: res.code,
          bucketCreated: generation,
        });
        failed(
          `R2 delete exited ${res.code}; absence not confirmed; bucket remains outstanding (objects are never purged)`,
        );
      }

      case "protect-bucket": {
        const d = c.des.resources.find((x) => x.id === s.id);

        if (
          l.version !== 2 ||
          r.type !== "r2_bucket" ||
          s.type !== r.type ||
          s.name !== r.name ||
          s.action !== "update" ||
          s.protected !== true ||
          d?.type !== "r2_bucket" ||
          !d.protected ||
          r.status !== "created" ||
          r.protected !== false ||
          !r.bucketCreated ||
          s.bucketCreated !== r.bucketCreated
        )
          throw new LiveError(
            LIVE_EXIT.refused,
            `${at}: not an approved false-to-true protection update`,
          );
        const pre = await w.r2Info(r.name);

        if (!pre.present || pre.info.name !== r.name || pre.info.created !== s.bucketCreated)
          throw new LiveError(
            LIVE_EXIT.unavailable,
            `${at}: protection requires the exact owned bucket generation`,
          );
        record(dir, l, s.id, { protected: true }, "protected", {
          artifact: c.digest,
          step: s.step,
          bucketCreated: s.bucketCreated,
        });
        c.log("     deletion protection enabled in local state (no provider write)");
        break;
      }

      case "d1-create": {
        const d = c.des.resources.find(
          (x): x is DbDecl => x.id === s.id && x.type === "d1_database",
        );

        if (!d)
          throw new LiveError(LIVE_EXIT.refused, `${at}: not a d1_database of the desired graph`);
        const pre = await w.d1Info(r.name);

        if (pre.present) {
          record(dir, l, s.id, { status: "conflict" }, "name-exists-before-create", {
            uuid: pre.info.uuid,
          });
          throw new LiveError(
            LIVE_EXIT.refused,
            `${at}: the exact name already exists; not adopted`,
          );
        }

        record(
          dir,
          l,
          s.id,
          {
            status: "creating",
            // A new generation must not reconcile against the deleted
            // generation's UUID. This happens only after fresh absence.
            physicalId: l.kind === LEGACY_KIND ? r.physicalId : null,
            location: d.location,
            readReplication: d.readReplication,
            protected: d.protected,
          },
          "create-intent",
          { artifact: c.digest, step: s.step },
        );
        const res = await w.d1Create(r.name, d.location);

        // read back by exact name; on an ambiguous outcome this reconciles
        const back = await pollUntil(
          3,
          4_000,
          () => tryRead(() => w.d1Info(r.name)),
          (x) => x !== "undetermined" && x.present,
        );

        if (
          back !== "undetermined" &&
          back.present &&
          (res.uuid === null || res.uuid === back.info.uuid)
        ) {
          record(
            dir,
            l,
            s.id,
            { status: "created", physicalId: back.info.uuid },
            res.result.code === 0 ? "created" : "reconciled-by-exact-name",
            { uuid: back.info.uuid },
          );
          createdHere.set(s.id, back.info.uuid);

          if (res.result.code !== 0)
            failed(
              `d1 create exited ${res.result.code}, but the database exists (${back.info.uuid}); recorded, stopping`,
            );
          c.log(`     created D1 ${back.info.uuid}`);
          break;
        }

        if (back !== "undetermined" && !back.present) {
          record(dir, l, s.id, { status: "absent" }, "create-failed-absent", {
            exit: res.result.code,
          });
          failed(`d1 create failed (exit ${res.result.code}) and the database is absent`);
        }

        record(dir, l, s.id, { status: "unknown" }, "create-outcome-unknown", {
          exit: res.result.code,
          parsed: res.uuid,
        });
        failed("d1 create outcome could not be determined; run `live cleanup`");
      }

      case "deploy": {
        const cfg = structuredClone(s.config);

        for (const b of cfg.d1_databases) {
          const m = /^\{uuid of d1_database "([a-z0-9-]+)" created by an earlier step\}$/.exec(
            b.database_id,
          );

          if (m) {
            const uuid = createdHere.get(m[1]);

            if (!uuid || l.resources[m[1]].physicalId !== uuid)
              failed(`no uuid from an earlier create step of "${m[1]}"`);
            b.database_id = uuid!;
          }
        }

        if (!c.source || sha256(c.source) !== s.sourceSha256)
          throw new LiveError(
            LIVE_EXIT.refused,
            `${at}: source bytes do not match ${s.sourceSha256}`,
          );
        checkDeploy(l.account, cfg, c.source, s.args);

        if (s.action === "create") {
          const pre = await w.deploymentStatus(r.name);

          if (pre.present) {
            record(dir, l, s.id, { status: "conflict" }, "name-exists-before-create");
            throw new LiveError(
              LIVE_EXIT.refused,
              `${at}: the exact name already exists; not adopted`,
            );
          }

          const generation: Partial<Owned> =
            l.kind === LEGACY_KIND
              ? { status: "creating" }
              : {
                  status: "creating",
                  physicalId: null,
                  versionId: null,
                  etag: null,
                  url: null,
                  sourceSha256: null,
                };

          record(dir, l, s.id, generation, "create-intent", {
            artifact: c.digest,
            step: s.step,
            sourceSha256: s.sourceSha256,
          });
        } else {
          record(dir, l, s.id, {}, "update-intent", {
            artifact: c.digest,
            step: s.step,
            sourceSha256: s.sourceSha256,
          });
        }

        const res = await w.deploy(cfg, c.source, s.args);
        const errText = res.result.err + res.result.out;

        if (res.result.code !== 0 && /register a workers\.dev subdomain/.test(errText)) {
          record(dir, l, s.id, {}, "workers-dev-subdomain-unavailable");
        }

        // read back what is deployed now, whatever the exit status said
        const now = await pollUntil(
          4,
          4_000,
          () => tryRead(() => w.deploymentStatus(r.name)),
          (x) =>
            x !== "undetermined" &&
            x.present &&
            x.deployment.versions[0]?.version_id === res.versionId,
        );

        if (now === "undetermined") {
          record(dir, l, s.id, { status: "unknown" }, "deploy-outcome-unknown", {
            exit: res.result.code,
          });
          failed("deploy outcome could not be determined; run `live cleanup`");
        }

        if (!now.present) {
          if (s.action === "create")
            record(dir, l, s.id, { status: "absent" }, "create-failed-absent", {
              exit: res.result.code,
            });
          failed(
            `deploy exited ${res.result.code} and the Worker is absent${/register a workers\.dev subdomain/.test(errText) ? " (the account has no workers.dev subdomain; this tool never registers one)" : ""}`,
          );
        }

        const vs = now.deployment.versions;

        const v =
          vs.length === 1 && vs[0].percentage === 100
            ? await tryRead(() => w.versionView(r.name, vs[0].version_id))
            : "undetermined";

        if (v === "undetermined") {
          record(dir, l, s.id, { status: "unknown" }, "deploy-readback-unknown", {
            exit: res.result.code,
          });
          failed("deployed version could not be read back; run `live cleanup`");
        }

        const m = MESSAGE_RE.exec(v.message ?? "");

        const expectedBindings: VersionBinding[] = [
          ...cfg.d1_databases.map((b) => ({ type: "d1", name: b.binding, id: b.database_id })),
          ...(cfg.r2_buckets ?? []).map((b) => ({
            type: "r2_bucket",
            name: b.binding,
            id: null,
            r2: { bucketName: b.bucket_name, jurisdiction: null },
          })),
        ];

        const byName = (a: VersionBinding, b: VersionBinding) => a.name.localeCompare(b.name);

        const bindingsMatch =
          l.version === 2
            ? sameJson([...v.bindings].sort(byName), expectedBindings.sort(byName))
            : sameJson(
                v.bindings.map((b) => b.id),
                cfg.d1_databases.map((d) => d.database_id),
              );

        const ok =
          res.result.code === 0 &&
          m?.[1] === s.sourceSha256 &&
          v.id === res.versionId &&
          bindingsMatch &&
          (l.version !== 2 ||
            (res.result.signal === null &&
              !res.result.timedOut &&
              v.tag === `run-${l.run}` &&
              v.compatibilityDate === cfg.compatibility_date &&
              v.compatibilityFlags.length === 0));

        record(
          dir,
          l,
          s.id,
          {
            status: "created",
            versionId: v.id,
            etag: v.etag,
            sourceSha256: m?.[1] ?? null,
            url: res.url ?? r.url ?? null,
          },
          ok ? (s.action === "create" ? "created" : "updated") : "deploy-readback-mismatch",
          { versionId: v.id, exit: res.result.code },
        );

        if (!ok)
          failed(
            `deploy exited ${res.result.code}; read back version ${v.id} does not match what was deployed`,
          );

        if (!res.url && !r.url) failed("deploy printed no workers.dev URL for this Worker");
        c.log(`     deployed version ${v.id} at ${l.resources[s.id].url}`);
        break;
      }

      case "delete-worker": {
        record(dir, l, s.id, { status: "deleting" }, "delete-intent", {
          artifact: c.digest,
          step: s.step,
        });
        const res = await w.deleteWorker(r.name);

        const gone = await pollUntil(
          4,
          4_000,
          () => tryRead(() => w.deploymentStatus(r.name)),
          (x) => x !== "undetermined" && !x.present,
        );

        if (gone !== "undetermined" && !gone.present) {
          record(dir, l, s.id, { status: "deleted" }, "deleted", { exit: res.code });
          c.log("     absent (deployments status: code 10007)");
          break;
        }

        record(
          dir,
          l,
          s.id,
          { status: gone === "undetermined" ? "unknown" : "created" },
          "delete-not-confirmed",
          { exit: res.code },
        );
        failed(`delete exited ${res.code}; absence not confirmed`);
      }

      case "d1-delete": {
        const uuid = s.config.d1_databases[0].database_id;

        const pre = await w.d1Info(r.name);

        if (!pre.present || pre.info.uuid !== uuid || r.physicalId !== uuid)
          throw new LiveError(LIVE_EXIT.refused, `${at}: live uuid is not the recorded ${uuid}`);
        record(dir, l, s.id, { status: "deleting" }, "delete-intent", {
          artifact: c.digest,
          step: s.step,
          uuid,
        });
        const res = await w.d1Delete(r.name, uuid);

        const goneName = await pollUntil(
          4,
          4_000,
          () => tryRead(() => w.d1Info(r.name)),
          (x) => x !== "undetermined" && !x.present,
        );

        const goneId = await tryRead(() => w.d1Info(uuid));

        if (
          goneName !== "undetermined" &&
          !goneName.present &&
          goneId !== "undetermined" &&
          !goneId.present
        ) {
          record(dir, l, s.id, { status: "deleted" }, "deleted", { exit: res.code, uuid });
          c.log(`     absent by name and by uuid ${uuid}`);
          break;
        }

        record(
          dir,
          l,
          s.id,
          {
            status:
              goneName === "undetermined" || goneId === "undetermined" ? "unknown" : "created",
          },
          "delete-not-confirmed",
          { exit: res.code },
        );
        failed(`d1 delete exited ${res.code}; absence not confirmed`);
      }

      default:
        throw new LiveError(
          LIVE_EXIT.unsupported,
          "unsupported execution purpose; no step was skipped",
        );
    }
  }
}

// ---- commands -------------------------------------------------------------

export type Flags = { pos: string[]; opts: Record<string, string>; json: boolean };

export function flags(argv: string[], known: string[]): Flags {
  const f: Flags = { pos: [], opts: {}, json: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--json") f.json = true;
    else if (a.startsWith("--")) {
      const k = a.slice(2);

      if (!known.includes(k)) throw new UsageError(`unknown option ${a}`);
      const v = argv[++i];

      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);

      if (k in f.opts) throw new UsageError(`${a} given twice`);
      f.opts[k] = v;
    } else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else f.pos.push(a);
  }

  return f;
}

export function need(f: Flags, k: string): string {
  if (f.opts[k] === undefined) throw new UsageError(`missing --${k}`);

  return f.opts[k];
}

// Before the lock, only the shape of <run-dir> is checked: a directory
// holding a ledger file. Nothing about ownership is read there.
function runDir(dir: string) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    throw new LiveError(LIVE_EXIT.noInput, `${dir}: not a run directory`);

  if (!fs.existsSync(ledgerPath(dir)))
    throw new LiveError(LIVE_EXIT.input, `${ledgerPath(dir)}: ENOENT`);
}

// the identity a command requires of the ledger it opened; throws to refuse
export type Accept = (l: Ledger) => void;

function openRun(dir: string, account: string, accept: Accept, allowV2 = false): Ledger {
  let l: Ledger;

  try {
    l = loadLedger(dir);
  } catch (e) {
    throw new LiveError(fs.existsSync(dir) ? LIVE_EXIT.input : LIVE_EXIT.noInput, errorMessage(e));
  }

  if (account !== l.account)
    throw new LiveError(
      LIVE_EXIT.refused,
      `--account does not match the run's account (ledger ${dir}); nothing ran`,
    );
  accept(l);

  // Project commands opt in only after locked decoding and caller identity
  // checks. Disposable commands retain their v1-only contract.
  if (l.version === 2 && !allowV2)
    throw new LiveError(
      LIVE_EXIT.unsupported,
      "project state version 2 execution is not supported; nothing ran",
    );

  return l;
}

// a disposable run's commands act only on a disposable run's ledger
const legacyRun: Accept = (l) => {
  if (l.kind !== LEGACY_KIND)
    throw new LiveError(
      LIVE_EXIT.refused,
      "this is a project environment's state, not a live run; use bend-iac plan/apply/destroy; nothing ran",
    );
};

// The exclusive run lock is taken BEFORE the ledger is read, so every
// decision and every ledger write of a command is based on the ledger as
// the previous command left it, never on a snapshot taken before waiting.
export async function withRun<T>(
  dir: string,
  account: string,
  accept: Accept,
  f: (l: Ledger) => Promise<T>,
  allowV2 = false,
): Promise<T> {
  runDir(dir);
  let unlock: () => void;

  try {
    unlock = lock(dir);
  } catch (e) {
    throw new LiveError(LIVE_EXIT.refused, errorMessage(e));
  }

  try {
    return await f(openRun(dir, account, accept, allowV2));
  } finally {
    unlock();
  }
}

async function init(argv: string[]): Promise<number> {
  const f = flags(argv, ["account", "consent"]);

  if (f.pos.length !== 1)
    throw new UsageError("live init <run-dir> --account <id> --consent " + CONSENT);
  const account = need(f, "account");

  if (!ACCOUNT_RE.test(account))
    throw new UsageError("--account must be a 32-character lowercase hex Cloudflare account id");

  if (need(f, "consent") !== CONSENT)
    throw new UsageError(`--consent must be exactly "${CONSENT}"`);
  let l: Ledger;

  try {
    l = initLedger(f.pos[0], account);
  } catch (e) {
    throw new LiveError(LIVE_EXIT.refused, errorMessage(e));
  }

  const out = {
    run: l.run,
    account: l.account,
    environment: l.environment,
    ledger: path.join(f.pos[0], "ledger.json"),
    names: physicalName(l.run, "<logical-id>"),
  };

  if (f.json) say(JSON.stringify(out, null, 2));
  else
    say(
      `Run ${l.run} for account ${l.account}: resources will be named ${out.names}; nothing remote was touched.`,
    );

  return LIVE_EXIT.ok;
}

async function prepare(argv: string[]): Promise<number> {
  const f = flags(argv, ["account"]);

  if (f.pos.length !== 2) throw new UsageError("live prepare <run-dir> <spec-dir> --account <id>");
  const [dir, specDir] = f.pos;
  const account = need(f, "account");
  runDir(dir);
  // every local check before any remote read; outside the lock, because
  // the spec is not run state (the ledger is only read under the lock)
  const spec = readSpec(specDir, LEGACY_SPEC(specDir));

  return planRun(
    dir,
    account,
    spec,
    f.json,
    legacyRun,
    (file, digest, l) =>
      `bend-iac live apply ${dir} --account ${l.account} --artifact ${file} --digest sha256:${digest}`,
  );
}

// how the command that applies an artifact is shown to the user
export type ApplyHint = (file: string, digest: string, l: Ledger) => string;

// Observe, plan with the compiled Bend planner and write the artifact, all
// under the run lock. `dir` has been checked; `spec` was read before the lock.
export async function planRun(
  dir: string,
  account: string,
  spec: Spec,
  json: boolean,
  accept: Accept,
  hint: ApplyHint,
): Promise<number> {
  const f = { json };

  return withRun(
    dir,
    account,
    accept,
    async (loaded) => {
      const des = modelDesired(spec);
      const l = register(dir, loaded, des);
      const w = new Wrangler(dir, l.account);
      await wranglerVersion(w);
      const obs = await observe(dir, l, w, "strict");
      const { rep, stamp } = await runPlanner(des, obs.observed, spec.grant, spec.apps);

      const ops = rep.operations.map(({ action, type, id, environment, reasons }) => ({
        action,
        type,
        id,
        environment,
        reasons,
      }));

      const unsupported =
        rep.outcome === "approved" ? support(ops, des, l, obs.evidence, obs.observed) : [];

      const steps =
        rep.outcome === "approved" && unsupported.length === 0
          ? payload(ops, des, l, obs.evidence, spec.source)
          : [];

      // local validation of each generated deploy before anything can run it
      for (const s of steps) {
        if (s.purpose !== "deploy") continue;
        const cfg = structuredClone(s.config);

        for (const b of cfg.d1_databases)
          if (!UUID_RE.test(b.database_id)) b.database_id = "00000000-0000-4000-8000-000000000000";
        await w.deployDryRun(cfg, spec.source!.bytes, s.args).catch((e) => {
          throw new LiveError(
            LIVE_EXIT.unsupported,
            `Wrangler refused the generated deploy in --dry-run: ${errorMessage(e)}`,
          );
        });
      }

      const stored = spec.source ? storeSource(dir, spec.source) : null;

      const a: Artifact = {
        ...head(l, "plan"),
        wrangler: [...WRANGLER],
        engine: stamp,
        preparedAt: new Date().toISOString(),
        inputs: docs(des, obs.observed, spec.grant, spec.apps),
        outcome: rep.outcome,
        executable: steps.length > 0 || (rep.outcome === "approved" && unsupported.length === 0),
        operations: rep.operations,
        problems: rep.problems,
        unsupported,
        resources: Object.values(l.resources).map((r) => ({
          id: r.logicalId,
          type: r.type,
          name: r.name,
        })),
        observation: obs.evidence,
        source: spec.source
          ? {
              file: spec.source.file,
              path: spec.source.abs,
              sha256: spec.source.sha256,
              bytes: spec.source.bytes.length,
              stored: stored!,
            }
          : null,
        payload: steps,
        trust: TRUST,
      };

      const { file, digest } = writeArtifact(dir, a);

      const exit =
        rep.outcome === "approved"
          ? unsupported.length
            ? LIVE_EXIT.unsupported
            : LIVE_EXIT.ok
          : rep.outcome === "approval_required"
            ? LIVE_EXIT.approvalRequired
            : LIVE_EXIT.rejected;

      if (f.json) {
        say(
          JSON.stringify(
            {
              outcome: rep.outcome,
              executable: a.executable,
              artifact: file,
              digest: `sha256:${digest}`,
              operations: rep.operations,
              problems: rep.problems,
              unsupported,
              observation: obs.evidence,
            },
            null,
            2,
          ),
        );
      } else {
        say(`Plan: ${rep.summary}`);

        for (const o of rep.operations)
          say(
            `  ${o.step}. ${o.action} ${o.type} ${o.id} -> ${l.resources[o.id].name}${o.reasons.length ? ` (${o.reasons.join(", ")})` : ""}`,
          );

        for (const p of rep.problems)
          say(`  ${rep.outcome === "approval_required" ? "!" : "x"} ${p.code}: ${p.message}`);

        for (const u of unsupported) say(`  x UNSUPPORTED: ${u}`);
        say(
          `Observed live by Wrangler: ${obs.evidence.map((e) => `${e.name} ${e.present ? "present" : "absent"}`).join(", ") || "(nothing owned yet)"}`,
        );
        say(`Artifact: ${file}`);
        say(`Digest: sha256:${digest}`);
        say(
          a.executable
            ? `Apply with: ${hint(file, digest, l)}`
            : "Not executable: nothing may run.",
        );
      }

      return exit;
    },
    true,
  );
}

async function wranglerVersion(w: Wrangler) {
  try {
    await w.version();
  } catch (e) {
    throw new LiveError(LIVE_EXIT.unavailable, errorMessage(e));
  }
}

type ArtifactInputs = { des: Desired; obs: Observed; grant: Grant; apps: Approval[] };

// An artifact as apply reads it back: parsed strictly, its identity checked
// first, then every other field decoded where apply uses it, in the order
// apply uses it. Fields that apply only compares with what it recomputes
// keep their recorded JSON, so those comparisons stay byte for byte.
class RecordedArtifact {
  private readonly r = new JsonReader((where, detail) => {
    throw new LiveError(LIVE_EXIT.refused, `artifact: ${where}: ${detail}; nothing ran`);
  });

  constructor(
    readonly fields: JsonFields,
    private readonly v2 = false,
  ) {}

  text(k: string): string | undefined {
    const v = this.fields.get(k);

    return v?.kind === "string" ? v.value : undefined;
  }

  // the recorded value as written, for a refusal
  shown(k: string): string {
    const v = this.fields.get(k);

    return v === undefined ? "undefined" : v.kind === "string" ? v.value : stringify(v);
  }

  matches(k: string, recomputed: JsonData): boolean {
    return matchesRecorded(recomputed, this.fields.get(k));
  }

  // the saved canonical model inputs, as the four documents
  inputs(): ArtifactInputs {
    const inputs = new JsonReader((where, detail) => {
      throw new InputError("artifact", where, detail);
    }).object(this.fields.get("inputs"), "inputs", ["desired", "observed", "grant", "approvals"]);

    const des = desiredFrom(inputs.get("desired"));
    const obs = observedFrom(inputs.get("observed"), des.environments, "wrangler");

    if (!this.v2) refuseR2([...des.resources, ...obs.resources]);

    return {
      des,
      obs,
      grant: grantFrom(inputs.get("grant"), des.environments),
      apps: approvalsFrom(inputs.get("approvals"), des.environments),
    };
  }

  observation(): Evidence[] {
    return this.r
      .array(this.fields.get("observation"), "observation")
      .map((v, i) => evidenceFrom(this.r, v, `observation[${i}]`, this.v2));
  }

  source(): ArtifactSource | null {
    const v = this.fields.get("source");

    if (v === undefined || v.kind === "null") return null;
    const o = this.r.object(v, "source", ["file", "path", "sha256", "bytes", "stored"]);

    return {
      file: this.r.string(o.get("file"), "source.file"),
      path: this.r.string(o.get("path"), "source.path"),
      sha256: this.r.string(o.get("sha256"), "source.sha256"),
      bytes: this.r.count(o.get("bytes"), "source.bytes"),
      stored: this.r.string(o.get("stored"), "source.stored"),
    };
  }
}

type Read = { a: RecordedArtifact; hex: string };

function readArtifact(file: string, digest: string, l: Ledger): Read {
  const want = /^(?:sha256:)?([0-9a-f]{64})$/.exec(digest)?.[1];

  if (!want) throw new UsageError("--digest must be sha256:<64 hex>");
  const bytes = readBytes(file);
  const hex = sha256(bytes);

  if (hex !== want)
    throw new LiveError(
      LIVE_EXIT.refused,
      `artifact digest is sha256:${hex}, not the expected sha256:${want}; nothing ran`,
    );
  let root: JsonValue;

  try {
    root = parseStrict(decodeUtf8("artifact", bytes));
  } catch (e) {
    throw new LiveError(LIVE_EXIT.refused, `artifact: ${errorMessage(e)}; nothing ran`);
  }

  const bad: (m: string) => never = (m) => {
    throw new LiveError(LIVE_EXIT.refused, `artifact: ${m}; nothing ran`);
  };

  if (root.kind !== "object") return bad("not a bend-infra live plan artifact");

  if (l.version === 2)
    new JsonReader((where, detail) => bad(`${where}: ${detail}`)).object(
      root,
      "(root)",
      [
        "version",
        "kind",
        "project",
        "purpose",
        "run",
        "account",
        "environment",
        "wrangler",
        "engine",
        "inputs",
        "outcome",
        "operations",
        "problems",
        "observation",
        "source",
        "payload",
      ],
      ["preparedAt", "executable", "unsupported", "resources", "trust"],
    );
  const a = new RecordedArtifact(root.fields, l.version === 2);
  const version = a.fields.get("version");
  const own = head(l, "plan");

  if (
    a.text("kind") !== own.kind ||
    version?.kind !== "number" ||
    version.value !== own.version ||
    a.text("purpose") !== "plan"
  )
    bad("not a bend-infra live plan artifact");

  if (own.kind === "bend-iac/project-artifact" && a.text("project") !== own.project)
    bad(`belongs to project ${a.shown("project")}, not ${own.project}`);

  if (a.text("run") !== l.run) bad(`belongs to run ${a.shown("run")}, not ${l.run}`);

  if (a.text("account") !== l.account) bad("names another account");

  if (a.text("environment") !== l.environment || !a.matches("wrangler", [...WRANGLER]))
    bad("environment or Wrangler pin differs");

  return { a, hex };
}

async function apply(argv: string[]): Promise<number> {
  const f = flags(argv, ["account", "artifact", "digest"]);

  if (f.pos.length !== 1)
    throw new UsageError(
      "live apply <run-dir> --account <id> --artifact <file> --digest sha256:<hex>",
    );
  const dir = f.pos[0];
  const account = need(f, "account");

  return applyRun(dir, account, legacyRun, need(f, "artifact"), need(f, "digest"), f.json);
}

// the newest plan artifact of a run, chosen under its lock
function latestPlan(dir: string): string {
  const d = path.join(dir, "artifacts");

  const plans = fs.existsSync(d)
    ? fs
        .readdirSync(d)
        .filter((n) => /^\d{3,}-plan-[a-z_]+\.json$/.test(n))
        .sort((x, y) => Number.parseInt(x, 10) - Number.parseInt(y, 10))
    : [];

  if (plans.length === 0)
    throw new LiveError(LIVE_EXIT.refused, `${d} holds no plan artifact; plan first; nothing ran`);

  return path.join(d, plans[plans.length - 1]);
}

// Verify an artifact against the caller's digest, the locked ledger, the
// planner, the source and a fresh observation, then run its steps. With
// no artifact file, the run's newest plan artifact is checked against the
// digest: the digest stays the caller's explicit choice.
export async function applyRun(
  dir: string,
  account: string,
  accept: Accept,
  artifact: string | null,
  digest: string,
  json: boolean,
): Promise<number> {
  const f = { json };

  return withRun(
    dir,
    account,
    accept,
    async (l) => {
      const artifactFile = artifact ?? latestPlan(dir);
      // the artifact is read and checked against the locked ledger
      const { a, hex } = readArtifact(artifactFile, digest, l);

      const outcome = a.text("outcome");

      if (outcome !== "approved") {
        throw new LiveError(
          outcome === "approval_required" ? LIVE_EXIT.approvalRequired : LIVE_EXIT.rejected,
          `artifact outcome is ${a.shown("outcome")}: nothing may run`,
        );
      }

      // 1. the planner, re-run on the saved canonical inputs, must give the
      //    same outcome and the same ordered operations
      const refuse: (m: string) => never = (m) => {
        throw new LiveError(LIVE_EXIT.refused, `${m}; nothing ran`);
      };

      let inputs: ArtifactInputs;

      try {
        inputs = a.inputs();
      } catch (e) {
        if (e instanceof LiveError && e.exit === LIVE_EXIT.unsupported) throw e;

        return refuse(`artifact inputs: ${errorMessage(e)}`);
      }

      const { des, obs, grant, apps } = inputs;

      if (!sameJson(des.environments, [l.environment]))
        refuse(`artifact inputs are not the ${l.environment} environment`);
      const { rep, stamp } = await runPlanner(des, obs, grant, apps);

      if (!a.matches("engine", stamp))
        refuse("the planner build differs from the one that prepared the artifact");

      if (
        rep.outcome !== "approved" ||
        !a.matches("operations", rep.operations) ||
        !a.matches("problems", rep.problems)
      ) {
        refuse(
          `the planner does not return the artifact's operations for its inputs (planner: ${rep.outcome}, ${rep.operations.length} operations)`,
        );
      }

      // 2. the whole operation list must be in the supported subset
      const ops = rep.operations.map(({ action, type, id, environment, reasons }) => ({
        action,
        type,
        id,
        environment,
        reasons,
      }));

      for (const o of ops)
        if (!l.resources[o.id]) refuse(`operation on "${o.id}", which run ${l.run} does not own`);
      const observation = a.observation();
      const unsupported = support(ops, des, l, observation, obs);

      if (unsupported.length)
        throw new LiveError(
          LIVE_EXIT.unsupported,
          `not supported, nothing ran:\n  ${unsupported.join("\n  ")}`,
        );
      // 3. the source bytes: the stored copy and the original file
      let src: Source | null = null;

      if (ops.some((o) => o.type === "worker" && o.action !== "delete")) {
        const s = a.source();

        if (!s || des.resources.find((r) => r.type === "worker" && r.main !== `sha256:${s.sha256}`))
          return refuse("artifact source does not match its desired Worker");

        if (l.version === 2) {
          const root = path.resolve(dir, "../..");
          const original = path.resolve(root, s.file);

          if (
            !/^[0-9a-f]{64}$/.test(s.sha256) ||
            s.stored !== `sources/${s.sha256}.js` ||
            path.isAbsolute(s.file) ||
            !/\.m?js$/.test(s.file) ||
            !original.startsWith(root + path.sep) ||
            s.path !== original
          )
            return refuse("artifact source identity/copy path differs from this project");
        }

        const bytes = readBytes(path.join(dir, s.stored));

        if (l.version === 2 && bytes.length !== s.bytes)
          refuse("artifact source byte count differs from the stored copy");

        if (sha256(bytes) !== s.sha256)
          refuse(`stored source ${s.stored} no longer has sha256 ${s.sha256}`);
        const orig = fs.existsSync(s.path) ? sha256(fs.readFileSync(s.path)) : null;

        if (orig !== s.sha256)
          refuse(
            `Worker source ${s.path} changed since prepare (sha256 ${orig ?? "missing"}, artifact ${s.sha256}); prepare again`,
          );
        src = { file: s.file, abs: s.path, bytes, sha256: s.sha256 };
      }

      const source = src?.bytes ?? null;
      // 4. the payload must be exactly what these inputs and the artifact's
      //    observation produce (all local so far: nothing remote has run)
      const steps = payload(ops, des, l, observation, src);

      if (!a.matches("payload", steps))
        refuse("the artifact payload is not the one its inputs produce");

      // 5. the live state must still be the one the plan was made from:
      //    read-only Wrangler observation, compared field for field
      const w = new Wrangler(dir, l.account);
      await wranglerVersion(w);
      w.note({ phase: "apply", artifact: path.resolve(artifactFile), digest: `sha256:${hex}` });
      const now = await observe(dir, l, w, "strict");

      if (!sameJson(now.observed, obs) || !a.matches("observation", now.evidence))
        refuse("the live state differs from the artifact's observation (drift)");

      if (l.version === 2 && support(ops, des, l, now.evidence, now.observed).length)
        refuse("the fresh observation no longer supports the approved operations");
      const log = f.json ? (m: string) => process.stderr.write(m + "\n") : say;

      if (steps.length === 0) {
        log("Apply: no changes; nothing ran.");
      } else {
        onSignals();
        log(
          `Apply: ${steps.length} step${steps.length === 1 ? "" : "s"} of artifact sha256:${hex}`,
        );

        try {
          await execute({ dir, l, w, des, digest: `sha256:${hex}`, source, log }, steps);
        } catch (e) {
          if (l.version !== 2) throw e;
          // Stop after the failed step; only read-only ownership reconciliation
          // follows. Preserve the original failure even if reconciliation fails.
          let unsettled: Observation["undetermined"];

          try {
            unsettled = (await observe(dir, l, w, "cleanup")).undetermined;
          } catch (reconcile) {
            unsettled = Object.values(l.resources).map((r) => ({
              id: r.logicalId,
              name: r.name,
              reason: `reconciliation failed: ${errorMessage(reconcile)}`,
            }));
          }

          log("Apply: stopped; outstanding inventory (no further mutation ran):");

          for (const item of leftovers(l, unsettled)) log(`  ${item}`);
          throw e;
        }

        log("Apply: done; every step was read back.");
      }

      if (f.json)
        say(
          JSON.stringify(
            {
              applied: steps.length,
              digest: `sha256:${hex}`,
              ledger: Object.values(l.resources).map(({ history: _history, ...r }) => r),
            },
            null,
            2,
          ),
        );

      return LIVE_EXIT.ok;
    },
    true,
  );
}

// What this run may still own remotely, with manual cleanup commands. A
// name in conflict was never ours and is reported as such, never listed
// for deletion.
function leftovers(l: Ledger, undetermined: Observation["undetermined"]): string[] {
  const ours = (n: string) =>
    Object.values(l.resources).find((x) => x.name === n)?.status !== "conflict";

  const names = new Set(undetermined.map((u) => u.name).filter(ours));

  for (const r of outstanding(l)) names.add(r.name);

  return [...names].map((n) => {
    const r = Object.values(l.resources).find((x) => x.name === n)!;
    const why = undetermined.find((u) => u.name === n)?.reason ?? `ledger status ${r.status}`;

    const manual =
      r.type === "worker"
        ? `CLOUDFLARE_ACCOUNT_ID=${l.account} npx --yes wrangler@4.151.1 delete --name ${r.name}`
        : r.type === "r2_bucket"
          ? `CLOUDFLARE_ACCOUNT_ID=${l.account} npx --yes wrangler@4.151.1 r2 bucket info ${r.name} --json   # ${
              r.bucketCreated === null
                ? "ownership generation not recorded: do not delete or adopt this name"
                : `only after confirming created=${r.bucketCreated}, no Worker binding and an empty bucket: CLOUDFLARE_ACCOUNT_ID=${l.account} npx --yes wrangler@4.151.1 r2 bucket delete ${r.name}`
            }`
          : `CLOUDFLARE_ACCOUNT_ID=${l.account} npx --yes wrangler@4.151.1 d1 delete ${r.name} --skip-confirmation   # check: d1 info ${r.name} --json shows uuid ${r.physicalId ?? "(not recorded)"}`;

    const identity =
      r.type === "r2_bucket"
        ? `created ${r.bucketCreated ?? "(not recorded)"}`
        : `uuid ${r.physicalId ?? "-"}`;

    return `${r.type} ${r.name} (${identity}, status ${r.status}): ${why}\n      manual: ${manual}`;
  });
}

async function observeCmd(argv: string[]): Promise<number> {
  const f = flags(argv, ["account"]);

  if (f.pos.length !== 1) throw new UsageError("live observe <run-dir> --account <id>");
  const dir = f.pos[0];

  return withRun(dir, need(f, "account"), legacyRun, async (l) => {
    const w = new Wrangler(dir, l.account);
    await wranglerVersion(w);
    const o = await observe(dir, l, w, "cleanup");
    const left = leftovers(l, o.undetermined);

    if (f.json) {
      say(
        JSON.stringify(
          {
            run: l.run,
            account: l.account,
            evidence: o.evidence,
            undetermined: o.undetermined,
            ledger: Object.values(l.resources).map(({ history: _history, ...r }) => r),
            outstanding: left,
          },
          null,
          2,
        ),
      );
    } else {
      for (const e of o.evidence)
        say(
          `${e.type} ${e.name}: ${e.present ? "present" : "absent"}${e.uuid ? ` uuid ${e.uuid}` : ""}${e.versionId ? ` version ${e.versionId}` : ""}`,
        );

      for (const x of left) say(`  outstanding: ${x}`);
    }

    return o.undetermined.length ? LIVE_EXIT.unavailable : LIVE_EXIT.ok;
  });
}

// Teardown of exactly what the ledger owns: the observed owned resources,
// an empty desired graph, a delete grant and, for each protected owned
// database, the approval the run's consent stands for. The plan comes
// from the Bend planner like any other; only then does anything run.
async function cleanup(argv: string[]): Promise<number> {
  const f = flags(argv, ["account", "confirm-run"]);

  if (f.pos.length !== 1)
    throw new UsageError("live cleanup <run-dir> --account <id> --confirm-run <run-id>");
  const dir = f.pos[0];
  const confirm = need(f, "confirm-run");

  return teardownRun(dir, need(f, "account"), {
    accept: (l) => {
      legacyRun(l);

      if (confirm !== l.run)
        throw new LiveError(
          LIVE_EXIT.refused,
          `--confirm-run must be this run's id (${l.run}); nothing ran`,
        );
    },
    approvals: (observed, l) =>
      observed.resources
        .filter((r) => r.type === "d1_database" && r.protected)
        .map((r) => ({
          action: "delete",
          resource: r.id,
          environment: l.environment,
          approvedBy: `run consent "${CONSENT}"`,
          reason: `bend-infra live cleanup --confirm-run ${l.run}`,
        })),
    word: "Cleanup",
  });
}

// What a teardown takes from its command: the identity and confirmation
// it requires of the locked ledger, and the approvals the Bend planner
// gets for deleting protected databases (it decides; nothing bypasses it).
export type Teardown = {
  accept: Accept;
  approvals: (observed: Observed, l: Ledger) => Approval[];
  word: "Cleanup" | "Destroy";
};

// Teardown of exactly what the ledger owns, planned by the Bend planner.
export async function teardownRun(dir: string, account: string, t: Teardown): Promise<number> {
  const word = t.word;

  return withRun(
    dir,
    account,
    t.accept,
    async (l) => {
      const w = new Wrangler(dir, l.account);
      await wranglerVersion(w);
      w.note({ phase: "cleanup" });
      const o = await observe(dir, l, w, "cleanup");

      // A resource whose state could not be read (network, auth, timeout,
      // an interrupted read, an unexpected version) is not absent: deleting
      // anything else could break a consumer that is still live. Nothing is
      // planned or run; the ledger keeps the full inventory for a retry.
      if (o.undetermined.length) {
        say(
          `${word}: REFUSED: the state of these resources of this run could not be determined; no cleanup step ran:`,
        );

        for (const u of o.undetermined) say(`  ${u.name}: ${u.reason}`);
        say("Outstanding resources of this run (retry cleanup once they can be observed):");

        for (const x of leftovers(l, o.undetermined)) say(`  ${x}`);

        return LIVE_EXIT.unavailable;
      }

      const des: Desired = { environments: [l.environment], resources: [] };
      const grant: Grant = { environment: l.environment, allow: ["delete"] };
      const apps = t.approvals(o.observed, l);

      const { rep, stamp } = await runPlanner(des, o.observed, grant, apps);

      const ops = rep.operations.map(({ action, type, id, environment, reasons }) => ({
        action,
        type,
        id,
        environment,
        reasons,
      }));

      const unsupported =
        rep.outcome === "approved"
          ? support(ops, des, l, o.evidence, o.observed, true)
          : [`teardown plan is ${rep.outcome}`];

      const steps = unsupported.length === 0 ? payload(ops, des, l, o.evidence, null) : [];

      const a: Artifact = {
        ...head(l, "cleanup"),
        wrangler: [...WRANGLER],
        engine: stamp,
        preparedAt: new Date().toISOString(),
        inputs: docs(des, o.observed, grant, apps),
        outcome: rep.outcome,
        executable: steps.length > 0,
        operations: rep.operations,
        problems: rep.problems,
        unsupported,
        resources: Object.values(l.resources).map((r) => ({
          id: r.logicalId,
          type: r.type,
          name: r.name,
        })),
        observation: o.evidence,
        source: null,
        payload: steps,
        trust: TRUST,
      };

      const { file, digest } = writeArtifact(dir, a);
      say(`${word} plan: ${rep.summary} (artifact ${file}, sha256:${digest})`);

      // a destroy the planner did not approve runs nothing: its problems
      // (a protected database without a matching approval) are the answer
      if (word === "Destroy" && rep.outcome !== "approved") {
        for (const p of rep.problems)
          say(`  ${rep.outcome === "approval_required" ? "!" : "x"} ${p.code}: ${p.message}`);
        say(`${word}: nothing ran.`);

        return rep.outcome === "approval_required"
          ? LIVE_EXIT.approvalRequired
          : LIVE_EXIT.rejected;
      }

      for (const u of unsupported) say(`  x ${u}`);
      let failure: LiveError | null = null;

      if (steps.length) {
        onSignals();

        try {
          await execute(
            { dir, l, w, des, digest: `sha256:${digest}`, source: null, log: say },
            steps,
          );
        } catch (e) {
          if (e instanceof LiveError) failure = e;
          else if (l.version === 2 && e instanceof WranglerError)
            failure = new LiveError(LIVE_EXIT.unavailable, e.message);
          else throw e;
          say(`  cleanup step failed: ${failure.message}`);
        }
      }

      const after = await observe(dir, l, w, "cleanup");
      const left = leftovers(l, [...o.undetermined, ...after.undetermined]);

      const stillThere = after.evidence.filter(
        (e) => e.present && l.resources[e.id].status !== "conflict",
      );

      if (
        left.length === 0 &&
        stillThere.length === 0 &&
        failure === null &&
        unsupported.length === 0
      ) {
        say(
          `${word}: confirmed absent: ${
            Object.values(l.resources)
              .filter((r) => r.status === "deleted" || r.status === "absent")
              .map((r) => r.name)
              .join(", ") || "(nothing was created)"
          }`,
        );

        return LIVE_EXIT.ok;
      }

      say(`${word}: NOT confirmed. Outstanding resources of this run:`);

      for (const x of left) say(`  ${x}`);

      for (const e of stillThere)
        if (!left.some((x) => x.includes(e.name))) say(`  ${e.type} ${e.name} is still present`);

      return l.version === 2 &&
        (after.undetermined.length > 0 || failure?.exit === LIVE_EXIT.unavailable)
        ? LIVE_EXIT.unavailable
        : LIVE_EXIT.failed;
    },
    word === "Destroy",
  );
}

export const LIVE_HELP = `bend-iac live: one Wrangler-backed Worker + D1 slice (disposable e2e resources only)

  bend-iac live init <run-dir> --account <id> --consent ${CONSENT}
  bend-iac live prepare <run-dir> <spec-dir> --account <id> [--json]
  bend-iac live apply <run-dir> --account <id> --artifact <file> --digest sha256:<hex> [--json]
  bend-iac live observe <run-dir> --account <id> [--json]
  bend-iac live cleanup <run-dir> --account <id> --confirm-run <run-id>

A <spec-dir> holds desired.json (environments exactly ["e2e"], at most one
d1_database and one worker whose main is a .js file in the spec dir),
grant.json and optionally approvals.json. Names are
bend-infra-e2e-<run>-<logical id>. Wrangler ${"4.151.1"} runs via npx with the
existing login, an allowlisted environment and a generated config.

Exit codes: 0 ok, 1 remote step failed (see ledger.json), 2 rejected,
3 approval required, 4 unsupported by the live slice, 5 refused (digest,
artifact, source, account or live-state mismatch), 64 usage, 65 input,
66 missing input, 69 remote state undetermined, 70 engine, 130 interrupted.
`;

export async function live(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;

  switch (sub) {
    case "init":
      return init(rest);
    case "prepare":
      return prepare(rest);
    case "apply":
      return apply(rest);
    case "observe":
      return observeCmd(rest);
    case "cleanup":
      return cleanup(rest);
    case "help":
    case undefined:
      process.stdout.write(LIVE_HELP);

      return sub === undefined ? LIVE_EXIT.usage : LIVE_EXIT.ok;
    default:
      throw new UsageError(`unknown live command "${sub}"`);
  }
}
