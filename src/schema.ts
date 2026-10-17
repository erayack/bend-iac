// The input schema: four JSON documents, each validated strictly and
// failing closed. Unknown keys, unknown enum values, missing
// security-relevant fields, undeclared environments and out-of-range sizes
// are errors, never defaults. Semantic checks that concern the graph
// (duplicate ids, dangling or cross-environment bindings, identity
// changes) are left to the Bend planner, which reports them as problems.

import { JsonError, JsonReader, parseStrict, type JsonFields, type JsonValue } from "./json";

export const LIMITS = {
  fileBytes: 1 << 20,
  environments: 16,
  resources: 256,
  bindingsPerWorker: 32,
  approvals: 64,
  idLength: 63,
  envLength: 32,
  textLength: 256,
} as const;

export const LOCATIONS = ["wnam", "enam", "weur", "eeur", "apac", "oc"] as const;
export const REPLICATION = ["auto", "disabled"] as const;
export const GRANT_ACTIONS = ["create", "update", "delete"] as const;
export const APPROVAL_ACTIONS = ["delete", "replace"] as const;

const ID_RE = /^[a-z][a-z0-9-]*$/;
const ENV_RE = /^[a-z][a-z0-9-]*$/;
const BINDING_RE = /^[A-Z][A-Z0-9_]*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DbDecl = {
  type: "d1_database";
  id: string;
  environment: string;
  location: (typeof LOCATIONS)[number];
  readReplication: (typeof REPLICATION)[number];
  protected: boolean;
};

export type BucketDecl = {
  type: "r2_bucket";
  id: string;
  environment: string;
  protected: boolean;
};

export type BindingDecl = { name: string; database: string } | { name: string; bucket: string };

export type WorkerDecl = {
  type: "worker";
  id: string;
  environment: string;
  main: string;
  compatibilityDate: string;
  bindings: BindingDecl[];
};

export type Resource = DbDecl | BucketDecl | WorkerDecl;

export type Desired = { environments: string[]; resources: Resource[] };

// "wrangler" is only produced by the live slice (src/live), never accepted by `plan`.
export type Observed = { source: "fixture" | "wrangler"; resources: Resource[] };

export type Grant = { environment: string; allow: (typeof GRANT_ACTIONS)[number][] };

export type Approval = {
  action: (typeof APPROVAL_ACTIONS)[number];
  resource: string;
  environment: string;
  approvedBy: string;
  reason: string;
};

export class InputError extends Error {
  constructor(
    readonly doc: string,
    readonly where: string,
    readonly detail: string,
  ) {
    super(`${doc}: ${where}: ${detail}`);
  }
}

// The schema's decoders: the shared JSON reader, failing with this
// document's InputError, plus the string, header and environment rules.
class Ctx extends JsonReader {
  constructor(readonly doc: string) {
    super((where, detail) => {
      throw new InputError(doc, where || "(root)", detail);
    });
  }
  str(v: JsonValue | undefined, where: string, re: RegExp | null, max: number): string {
    const s = this.string(v, where);

    if (s.length === 0 || s.length > max) this.fail(where, `expected 1..${max} characters`);

    if (/[\u0000-\u001f\u007f]/.test(s)) this.fail(where, "control characters are not allowed");

    if (re && !re.test(s)) this.fail(where, `"${s}" does not match ${re}`);

    return s;
  }
  header(o: JsonFields, kind: string) {
    const version = o.get("version");

    if (version?.kind !== "number" || version.value !== 1) this.fail("version", "expected 1");
    const k = o.get("kind");

    if (k?.kind !== "string" || k.value !== kind) this.fail("kind", `expected "${kind}"`);
  }
  env(v: JsonValue | undefined, where: string, envs: readonly string[]): string {
    const e = this.str(v, where, ENV_RE, LIMITS.envLength);

    if (!envs.includes(e))
      this.fail(where, `environment "${e}" is not declared in desired.environments`);

    return e;
  }
}

export function readJson(doc: string, text: string): JsonValue {
  if (Buffer.byteLength(text) > LIMITS.fileBytes)
    throw new InputError(doc, "(file)", `larger than ${LIMITS.fileBytes} bytes`);

  try {
    return parseStrict(text);
  } catch (e) {
    if (e instanceof JsonError) throw new InputError(doc, "(json)", e.message);
    throw e;
  }
}

function resource(c: Ctx, v: JsonValue, where: string, envs: readonly string[]): Resource {
  const base = c.object(
    v,
    where,
    ["type"],
    [
      "id",
      "environment",
      "location",
      "readReplication",
      "protected",
      "main",
      "compatibilityDate",
      "bindings",
    ],
  );

  const type = c.oneOf(base.get("type"), `${where}.type`, [
    "d1_database",
    "r2_bucket",
    "worker",
  ] as const);

  if (type === "d1_database") {
    const o = c.object(v, where, [
      "type",
      "id",
      "environment",
      "location",
      "readReplication",
      "protected",
    ]);

    return {
      type,
      id: c.str(o.get("id"), `${where}.id`, ID_RE, LIMITS.idLength),
      environment: c.env(o.get("environment"), `${where}.environment`, envs),
      location: c.oneOf(o.get("location"), `${where}.location`, LOCATIONS),
      readReplication: c.oneOf(o.get("readReplication"), `${where}.readReplication`, REPLICATION),
      protected: c.boolean(o.get("protected"), `${where}.protected`),
    };
  }

  if (type === "r2_bucket") {
    const o = c.object(v, where, ["type", "id", "environment", "protected"]);

    return {
      type,
      id: c.str(o.get("id"), `${where}.id`, ID_RE, LIMITS.idLength),
      environment: c.env(o.get("environment"), `${where}.environment`, envs),
      protected: c.boolean(o.get("protected"), `${where}.protected`),
    };
  }

  const o = c.object(v, where, [
    "type",
    "id",
    "environment",
    "main",
    "compatibilityDate",
    "bindings",
  ]);

  const date = c.str(o.get("compatibilityDate"), `${where}.compatibilityDate`, DATE_RE, 10);
  const [, y, m, d] = DATE_RE.exec(date)!.map(Number);
  const real = new Date(Date.UTC(y, m - 1, d));

  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) {
    c.fail(`${where}.compatibilityDate`, `"${date}" is not a calendar date`);
  }

  const bindings = c
    .array(o.get("bindings"), `${where}.bindings`, LIMITS.bindingsPerWorker)
    .map((b, i): BindingDecl => {
      const bw = `${where}.bindings[${i}]`;
      const bo = c.object(b, bw, ["name"], ["database", "bucket"]);

      if (bo.has("database") === bo.has("bucket"))
        c.fail(bw, "expected exactly one of database or bucket");
      const name = c.str(bo.get("name"), `${bw}.name`, BINDING_RE, LIMITS.idLength);

      return bo.has("database")
        ? { name, database: c.str(bo.get("database"), `${bw}.database`, ID_RE, LIMITS.idLength) }
        : { name, bucket: c.str(bo.get("bucket"), `${bw}.bucket`, ID_RE, LIMITS.idLength) };
    });

  return {
    type,
    id: c.str(o.get("id"), `${where}.id`, ID_RE, LIMITS.idLength),
    environment: c.env(o.get("environment"), `${where}.environment`, envs),
    main: c.str(o.get("main"), `${where}.main`, null, LIMITS.textLength),
    compatibilityDate: date,
    bindings,
  };
}

export function desiredFrom(v: JsonValue | undefined): Desired {
  const c = new Ctx("desired");
  const o = c.object(v, "", ["version", "kind", "environments", "resources"]);
  c.header(o, "bend-infra/desired");

  const envs = c
    .array(o.get("environments"), "environments", LIMITS.environments)
    .map((e, i) => c.str(e, `environments[${i}]`, ENV_RE, LIMITS.envLength));

  if (envs.length === 0) c.fail("environments", "declare at least one environment");

  if (new Set(envs).size !== envs.length)
    c.fail("environments", "environment names must be unique");

  const resources = c
    .array(o.get("resources"), "resources", LIMITS.resources)
    .map((r, i) => resource(c, r, `resources[${i}]`, envs));

  return { environments: envs, resources };
}

// The observed snapshot is a fixture: a record of what was last applied,
// in the same resource layout. Its environments must be ones the desired
// document declares; anything else is ambiguous and refused.
// The live slice validates the snapshot it builds from Wrangler reads with
// the same rules, under source "wrangler"; the plan command accepts only
// "fixture".
export function observedFrom(
  v: JsonValue | undefined,
  envs: readonly string[],
  source: Observed["source"] = "fixture",
): Observed {
  const c = new Ctx("observed");
  const o = c.object(v, "", ["version", "kind", "source", "resources"]);
  c.header(o, "bend-infra/observed");
  const s = o.get("source");

  if (s?.kind !== "string" || s.value !== source) {
    c.fail(
      "source",
      source === "fixture"
        ? 'expected "fixture" (live observation is not supported)'
        : `expected "${source}"`,
    );
  }

  const resources = c
    .array(o.get("resources"), "resources", LIMITS.resources)
    .map((r, i) => resource(c, r, `resources[${i}]`, envs));

  return { source, resources };
}

export function grantFrom(v: JsonValue | undefined, envs: readonly string[]): Grant {
  const c = new Ctx("grant");
  const o = c.object(v, "", ["version", "kind", "environment", "allow"]);
  c.header(o, "bend-infra/grant");
  const environment = c.env(o.get("environment"), "environment", envs);

  const allow = c
    .array(o.get("allow"), "allow", GRANT_ACTIONS.length)
    .map((a, i) => c.oneOf(a, `allow[${i}]`, GRANT_ACTIONS));

  if (new Set(allow).size !== allow.length) c.fail("allow", "actions must be unique");

  return { environment, allow };
}

export function approvalsFrom(v: JsonValue | undefined, envs: readonly string[]): Approval[] {
  const c = new Ctx("approvals");
  const o = c.object(v, "", ["version", "kind", "approvals"]);
  c.header(o, "bend-infra/approvals");

  return c.array(o.get("approvals"), "approvals", LIMITS.approvals).map((a, i) => {
    const w = `approvals[${i}]`;
    const ao = c.object(a, w, ["action", "resource", "environment", "approvedBy", "reason"]);

    return {
      action: c.oneOf(ao.get("action"), `${w}.action`, APPROVAL_ACTIONS),
      resource: c.str(ao.get("resource"), `${w}.resource`, ID_RE, LIMITS.idLength),
      environment: c.env(ao.get("environment"), `${w}.environment`, envs),
      approvedBy: c.str(ao.get("approvedBy"), `${w}.approvedBy`, null, LIMITS.textLength),
      reason: c.str(ao.get("reason"), `${w}.reason`, null, LIMITS.textLength),
    };
  });
}

// The documents as text: the size limit, then the strict JSON reader,
// then the schema.
export const parseDesired = (text: string): Desired => desiredFrom(readJson("desired", text));

export const parseObserved = (
  text: string,
  envs: readonly string[],
  source: Observed["source"] = "fixture",
): Observed => observedFrom(readJson("observed", text), envs, source);

export const parseGrant = (text: string, envs: readonly string[]): Grant =>
  grantFrom(readJson("grant", text), envs);

export const parseApprovals = (text: string, envs: readonly string[]): Approval[] =>
  approvalsFrom(readJson("approvals", text), envs);

export { JsonError };
