// The narrow codec between validated JSON and the Bend planner.
//
// Strings never reach Bend. Each class of string (ids, environments,
// binding names, entry modules, compatibility dates, locations) is
// interned into its own table, sorted, and a value becomes its index (a
// Bend Nat). The planner only compares Nats for equality, so the encoding
// is faithful exactly when equal strings get equal indexes and different
// strings different ones, which a table lookup guarantees. Duplicate ids
// are deliberately NOT merged or dropped here: both declarations reach
// Bend with the same Nat, and Bend rejects them.
//
// The values are plain JS objects in the form the Bend JS backend uses
// ({$: "Ctor", field: ...}, Nat as number, Bool as boolean), passed to the
// compiled planner directly: no Bend source is generated from input.

import type { Approval, Desired, Grant, Observed, Resource } from "./schema";

// ---- Bend values ------------------------------------------------------------
// Values of core/planner.bend's types as Bend's JS backend represents them:
// a Nat is a number, a Bool a boolean, a constructor an object
// {$: name, field: value, ...} with its fields in declaration order.

export type Nat = number;

export type BList<T> =
  | { readonly $: "Nil" }
  | { readonly $: "Con"; readonly head: T; readonly tail: BList<T> };

export type ActTag = "Create" | "Update" | "Delete" | "Replace";

export type BAct = { $: ActTag };

export type BBind = { $: "Bind"; name: Nat; db: Nat } | { $: "BucketBind"; name: Nat; bucket: Nat };

export type BBucket = { $: "Bucket"; id: Nat; env: Nat; protect: boolean };

export type BDb = {
  $: "Db";
  id: Nat;
  env: Nat;
  protect: boolean;
  location: Nat;
  replicas: boolean;
};

export type BWk = { $: "Wk"; id: Nat; env: Nat; main: Nat; compat: Nat; binds: BList<BBind> };

export type BState = { $: "State"; dbs: BList<BDb>; wks: BList<BWk>; buckets: BList<BBucket> };

export type BGrant = { $: "Grant"; env: Nat; create: boolean; update: boolean; delete: boolean };

export type BApproval = { $: "Approval"; act: BAct; id: Nat; env: Nat };

// plan's arguments: desired state, observed state, grant, approvals
export type PlanArgs = [BState, BState, BGrant, BList<BApproval>];

// Any term of the JS backend: what the compiled planner returns before
// readOutcome() has checked it.
export type BendTerm = Nat | boolean | string | { readonly [field: string]: BendTerm };

export type Tables = {
  ids: string[];
  envs: string[];
  names: string[];
  mains: string[];
  compats: string[];
  locations: string[];
};

class Table {
  private index = new Map<string, number>();
  constructor(values: Iterable<string>) {
    [...new Set(values)].sort().forEach((v, i) => this.index.set(v, i));
  }
  nat(v: string): number {
    const n = this.index.get(v);

    if (n === undefined) throw new Error(`codec: "${v}" missing from its table`);

    return n;
  }
  list(): string[] {
    return [...this.index.keys()];
  }
}

const list = <T>(xs: readonly T[]): BList<T> =>
  xs.reduceRight<BList<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

export function fromList<T>(l: BList<T>): T[] {
  const out: T[] = [];

  for (let x = l; x.$ === "Con"; x = x.tail) out.push(x.head);

  return out;
}

// canonical order: by id, then type; a Worker's bindings by name. The
// planner's output order follows this, so file order never matters.
export function canonical(rs: Resource[]): Resource[] {
  return [...rs]
    .map((r) =>
      r.type === "worker"
        ? {
            ...r,
            bindings: [...r.bindings].sort(
              (a, b) =>
                cmp(a.name, b.name) ||
                cmp(
                  "database" in a ? "database" : "bucket",
                  "database" in b ? "database" : "bucket",
                ) ||
                cmp(
                  "database" in a ? a.database : a.bucket,
                  "database" in b ? b.database : b.bucket,
                ),
            ),
          }
        : r,
    )
    .sort((a, b) => cmp(a.id, b.id) || cmp(a.type, b.type));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type Encoded = {
  args: PlanArgs;
  tables: Tables;
};

export function encode(des: Desired, obs: Observed, grant: Grant, apps: Approval[]): Encoded {
  const all = [...des.resources, ...obs.resources];
  const workers = all.filter((r) => r.type === "worker");
  const dbs = all.filter((r) => r.type === "d1_database");

  const ids = new Table([
    ...all.map((r) => r.id),
    ...workers.flatMap((w) => w.bindings.map((b) => ("database" in b ? b.database : b.bucket))),
    ...apps.map((a) => a.resource),
  ]);

  const envs = new Table(des.environments);
  const names = new Table(workers.flatMap((w) => w.bindings.map((b) => b.name)));
  const mains = new Table(workers.map((w) => w.main));
  const compats = new Table(workers.map((w) => w.compatibilityDate));
  const locations = new Table(dbs.map((d) => d.location));

  const state = (rs: Resource[]): BState => {
    const c = canonical(rs);

    return {
      $: "State",
      dbs: list(
        c.flatMap((r): BDb[] =>
          r.type !== "d1_database"
            ? []
            : [
                {
                  $: "Db",
                  id: ids.nat(r.id),
                  env: envs.nat(r.environment),
                  protect: r.protected,
                  location: locations.nat(r.location),
                  replicas: r.readReplication === "auto",
                },
              ],
        ),
      ),
      wks: list(
        c.flatMap((r): BWk[] =>
          r.type !== "worker"
            ? []
            : [
                {
                  $: "Wk",
                  id: ids.nat(r.id),
                  env: envs.nat(r.environment),
                  main: mains.nat(r.main),
                  compat: compats.nat(r.compatibilityDate),
                  binds: list(
                    r.bindings.map((b): BBind =>
                      "database" in b
                        ? {
                            $: "Bind",
                            name: names.nat(b.name),
                            db: ids.nat(b.database),
                          }
                        : { $: "BucketBind", name: names.nat(b.name), bucket: ids.nat(b.bucket) },
                    ),
                  ),
                },
              ],
        ),
      ),
      buckets: list(
        c.flatMap((r): BBucket[] =>
          r.type === "r2_bucket"
            ? [
                {
                  $: "Bucket",
                  id: ids.nat(r.id),
                  env: envs.nat(r.environment),
                  protect: r.protected,
                },
              ]
            : [],
        ),
      ),
    };
  };

  const g: BGrant = {
    $: "Grant",
    env: envs.nat(grant.environment),
    create: grant.allow.includes("create"),
    update: grant.allow.includes("update"),
    delete: grant.allow.includes("delete"),
  };

  const sortedApps = [...apps].sort(
    (a, b) =>
      cmp(a.resource, b.resource) || cmp(a.action, b.action) || cmp(a.environment, b.environment),
  );

  const approvals = list(
    sortedApps.map((a): BApproval => ({
      $: "Approval",
      act: { $: a.action === "delete" ? "Delete" : "Replace" },
      id: ids.nat(a.resource),
      env: envs.nat(a.environment),
    })),
  );

  return {
    args: [state(des.resources), state(obs.resources), g, approvals],
    tables: {
      ids: ids.list(),
      envs: envs.list(),
      names: names.list(),
      mains: mains.list(),
      compats: compats.list(),
      locations: locations.list(),
    },
  };
}

// ---- reading the planner's outcome -----------------------------------------
// The term the compiled planner returned, checked against core/planner.bend's
// Outcome: every constructor name, Nat and list. Any term the codec does not
// expect is an engine error, never a guess. Nats stay Nats here; decode()
// then names them.

export type KindTag = "KDb" | "KWorker" | "KBucket";

export type FieldTag =
  | "FLocation"
  | "FReplication"
  | "FProtect"
  | "FMain"
  | "FCompat"
  | "FBindings"
  | "FRebind";

export type ReadOp = { act: ActTag; kind: KindTag; id: Nat; env: Nat; why: FieldTag[] };

export type ReadProblem =
  | { $: "DupId" | "DupObserved" | "KindChange" | "EnvChange" | "Unprotect"; id: Nat }
  | { $: "DupBinding"; wk: Nat; name: Nat }
  | {
      $: "Dangling" | "CrossEnv" | "DanglingBucket" | "CrossEnvBucket";
      wk: Nat;
      name: Nat;
      db: Nat;
    }
  | { $: "OutOfGrant" | "NeedApproval" | "UnusedApproval"; act: ActTag; id: Nat; env: Nat };

export type ReadOutcome =
  | { $: "Approved"; ops: ReadOp[] }
  | { $: "Pending" | "Rejected"; problems: ReadProblem[] };

const ACT_TAGS = ["Create", "Update", "Delete", "Replace"] as const;
const KIND_TAGS = ["KDb", "KWorker", "KBucket"] as const;

const FIELD_TAGS = [
  "FLocation",
  "FReplication",
  "FProtect",
  "FMain",
  "FCompat",
  "FBindings",
  "FRebind",
] as const;

const PROBLEM_TAGS = [
  "DupId",
  "DupObserved",
  "DupBinding",
  "Dangling",
  "CrossEnv",
  "DanglingBucket",
  "CrossEnvBucket",
  "KindChange",
  "EnvChange",
  "Unprotect",
  "OutOfGrant",
  "NeedApproval",
  "UnusedApproval",
] as const;

type BendNode = { readonly [field: string]: BendTerm };

const show = (t: BendTerm | undefined) => JSON.stringify(t)?.slice(0, 200);

export const isNat = (t: BendTerm): t is Nat => Number.isSafeInteger(t) && Number(t) >= 0;

// The backend builds every constructor as an object literal, so a term
// that is not an Object instance is not a constructor.
function node(t: BendTerm | undefined, what: string): BendNode {
  if (!(t instanceof Object)) throw new Error(`codec: unexpected ${what} ${show(t)}`);

  return t;
}

function tag<T extends string>(t: BendTerm | undefined, what: string, tags: readonly T[]): T {
  const name = node(t, what).$;
  const found = tags.find((k) => k === name);

  if (found === undefined) throw new Error(`codec: unexpected ${what} ${show(t)}`);

  return found;
}

function nat(t: BendTerm | undefined, what: string): Nat {
  if (t === undefined || !isNat(t)) throw new Error(`codec: ${what} ${show(t)} is out of range`);

  return t;
}

function readList<T>(
  t: BendTerm | undefined,
  where: string,
  item: (x: BendTerm | undefined) => T,
): T[] {
  const out: T[] = [];

  for (let x = t; ;) {
    if (!(x instanceof Object) || (x.$ !== "Nil" && x.$ !== "Con"))
      throw new Error(`codec: ${where} is not a Bend list`);

    if (x.$ === "Nil") return out;
    out.push(item(x.head));
    x = x.tail;
  }
}

function readOp(t: BendTerm | undefined): ReadOp {
  const op = node(t, "operation");

  if (op.$ !== "Op") throw new Error("codec: expected an Op");

  return {
    act: tag(op.act, "action", ACT_TAGS),
    kind: tag(op.kind, "kind", KIND_TAGS),
    id: nat(op.id, "id"),
    env: nat(op.env, "environment"),
    why: readList(op.why, "why", (f) => tag(f, "field", FIELD_TAGS)),
  };
}

function readProblem(t: BendTerm | undefined): ReadProblem {
  const p = node(t, "problem");
  const k = tag(p, "problem", PROBLEM_TAGS);

  switch (k) {
    case "DupId":
    case "DupObserved":
    case "KindChange":
    case "EnvChange":
    case "Unprotect":
      return { $: k, id: nat(p.id, "id") };
    case "DupBinding":
      return { $: k, wk: nat(p.wk, "id"), name: nat(p.name, "binding name") };
    case "Dangling":
    case "CrossEnv":
    case "DanglingBucket":
    case "CrossEnvBucket":
      return {
        $: k,
        wk: nat(p.wk, "id"),
        name: nat(p.name, "binding name"),
        db: nat(p.db, "id"),
      };
    case "OutOfGrant":
    case "NeedApproval":
    case "UnusedApproval":
      return {
        $: k,
        act: tag(p.act, "action", ACT_TAGS),
        id: nat(p.id, "id"),
        env: nat(p.env, "environment"),
      };
  }
}

export function readOutcome(t: BendTerm): ReadOutcome {
  const k = tag(t, "outcome", ["Approved", "Pending", "Rejected"] as const);
  const o = node(t, "outcome");

  return k === "Approved"
    ? { $: k, ops: readList(o.ops, "ops", readOp) }
    : { $: k, problems: readList(o.problems, "problems", readProblem) };
}

// ---- decoding: the read outcome back into names -----------------------------

export type Action = "create" | "update" | "delete" | "replace";

export type ResourceType = "d1_database" | "worker" | "r2_bucket";

// why an update or replacement happens: a declared field, or a rebind
export type Reason =
  | "location"
  | "readReplication"
  | "protected"
  | "main"
  | "compatibilityDate"
  | "bindings"
  | "rebind";

export type Operation = {
  action: Action;
  type: ResourceType;
  id: string;
  environment: string;
  reasons: Reason[];
};

export type Problem =
  | {
      code:
        | "DUPLICATE_ID"
        | "DUPLICATE_OBSERVED_ID"
        | "KIND_CHANGE"
        | "ENV_CHANGE"
        | "UNPROTECT_REFUSED";
      id: string;
    }
  | { code: "DUPLICATE_BINDING"; worker: string; binding: string }
  | {
      code: "DANGLING_BINDING" | "CROSS_ENV_BINDING";
      worker: string;
      binding: string;
      database: string;
    }
  | {
      code: "DANGLING_BUCKET_BINDING" | "CROSS_ENV_BUCKET_BINDING";
      worker: string;
      binding: string;
      bucket: string;
    }
  | {
      code: "OUT_OF_GRANT" | "APPROVAL_REQUIRED" | "UNUSED_APPROVAL";
      action: Action;
      id: string;
      environment: string;
    };

export type Outcome =
  | { outcome: "approved"; operations: Operation[] }
  | { outcome: "approval_required"; problems: Problem[] }
  | { outcome: "rejected"; problems: Problem[] };

const ACTIONS: Record<ActTag, Action> = {
  Create: "create",
  Update: "update",
  Delete: "delete",
  Replace: "replace",
};

const KINDS: Record<KindTag, ResourceType> = {
  KDb: "d1_database",
  KWorker: "worker",
  KBucket: "r2_bucket",
};

const REASONS: Record<FieldTag, Reason> = {
  FLocation: "location",
  FReplication: "readReplication",
  FProtect: "protected",
  FMain: "main",
  FCompat: "compatibilityDate",
  FBindings: "bindings",
  FRebind: "rebind",
};

function at(table: string[], n: Nat, what: string): string {
  if (n >= table.length) throw new Error(`codec: ${what} ${n} is out of range`);

  return table[n];
}

function problem(p: ReadProblem, t: Tables): Problem {
  switch (p.$) {
    case "DupId":
      return { code: "DUPLICATE_ID", id: at(t.ids, p.id, "id") };
    case "DupObserved":
      return { code: "DUPLICATE_OBSERVED_ID", id: at(t.ids, p.id, "id") };
    case "DupBinding":
      return {
        code: "DUPLICATE_BINDING",
        worker: at(t.ids, p.wk, "id"),
        binding: at(t.names, p.name, "binding name"),
      };
    case "Dangling":
    case "CrossEnv":
      return {
        code: p.$ === "Dangling" ? "DANGLING_BINDING" : "CROSS_ENV_BINDING",
        worker: at(t.ids, p.wk, "id"),
        binding: at(t.names, p.name, "binding name"),
        database: at(t.ids, p.db, "id"),
      };
    case "DanglingBucket":
    case "CrossEnvBucket":
      return {
        code: p.$ === "DanglingBucket" ? "DANGLING_BUCKET_BINDING" : "CROSS_ENV_BUCKET_BINDING",
        worker: at(t.ids, p.wk, "id"),
        binding: at(t.names, p.name, "binding name"),
        bucket: at(t.ids, p.db, "id"),
      };
    case "KindChange":
      return { code: "KIND_CHANGE", id: at(t.ids, p.id, "id") };
    case "EnvChange":
      return { code: "ENV_CHANGE", id: at(t.ids, p.id, "id") };
    case "Unprotect":
      return { code: "UNPROTECT_REFUSED", id: at(t.ids, p.id, "id") };
    case "OutOfGrant":
    case "NeedApproval":
    case "UnusedApproval":
      return {
        code:
          p.$ === "OutOfGrant"
            ? "OUT_OF_GRANT"
            : p.$ === "NeedApproval"
              ? "APPROVAL_REQUIRED"
              : "UNUSED_APPROVAL",
        action: ACTIONS[p.act],
        id: at(t.ids, p.id, "id"),
        environment: at(t.envs, p.env, "environment"),
      };
  }
}

// The planner's term, read and then named through the tables encode() built.
export function decode(term: BendTerm, t: Tables): Outcome {
  const o = readOutcome(term);

  if (o.$ === "Approved") {
    return {
      outcome: "approved",
      operations: o.ops.map((op) => ({
        action: ACTIONS[op.act],
        type: KINDS[op.kind],
        id: at(t.ids, op.id, "id"),
        environment: at(t.envs, op.env, "environment"),
        reasons: op.why.map((f) => REASONS[f]),
      })),
    };
  }

  const problems = o.problems.map((p) => problem(p, t));

  return o.$ === "Pending"
    ? { outcome: "approval_required", problems }
    : { outcome: "rejected", problems };
}
