// Human-readable rendering of a planner outcome. Presentation only: what
// runs, in which order, and why something was refused all come from the
// Bend planner; this file looks up declarations to print their values.

import type { Operation, Outcome, Problem, Reason } from "./codec";
import type { Approval, Desired, Grant, Observed, Resource, WorkerDecl } from "./schema";
import type { Stamp } from "./engine";

// one step of an approved plan, as reported
export type ReportOperation = Operation & {
  step: number;
  destructive: boolean;
  approval?: { approvedBy: string; reason: string };
};

export type Report = {
  outcome: Outcome["outcome"];
  executable: boolean;
  summary: string;
  grant: Grant;
  operations: ReportOperation[];
  problems: (Problem & { message: string })[];
  engine: { planner: string; bendCommit: string; proofs: Stamp["proofs"] };
  observation: Observed["source"];
};

export function report(
  out: Outcome,
  des: Desired,
  obs: Observed,
  grant: Grant,
  apps: Approval[],
  stamp: Stamp,
): Report {
  const operations =
    out.outcome === "approved"
      ? out.operations.map((o, i) => {
          const a = apps.find(
            (x) => x.action === o.action && x.resource === o.id && x.environment === o.environment,
          );

          const op: ReportOperation = {
            step: i + 1,
            ...o,
            destructive: o.action === "delete" || o.action === "replace",
          };

          // only an operation an approval matches carries one
          if (a) op.approval = { approvedBy: a.approvedBy, reason: a.reason };

          return op;
        })
      : [];

  const problems =
    out.outcome === "approved"
      ? []
      : out.problems.map((p) => ({ ...p, message: describe(p, des, obs) }));

  return {
    outcome: out.outcome,
    executable: out.outcome === "approved",
    summary: summary(out),
    grant,
    operations,
    problems,
    engine: { planner: "core/planner.bend", bendCommit: stamp.bendCommit, proofs: stamp.proofs },
    observation: obs.source,
  };
}

function summary(out: Outcome): string {
  switch (out.outcome) {
    case "approved":
      return out.operations.length === 0
        ? "APPROVED: no changes (the desired graph matches the observed snapshot)"
        : `APPROVED: ${out.operations.length} operation${out.operations.length === 1 ? "" : "s"}, all within the grant`;
    case "approval_required":
      return `APPROVAL REQUIRED: nothing may run (${out.problems.length} missing approval${out.problems.length === 1 ? "" : "s"})`;
    case "rejected":
      return `REJECTED: nothing may run (${out.problems.length} problem${out.problems.length === 1 ? "" : "s"})`;
  }
}

const find = (rs: Resource[], id: string) => rs.find((r) => r.id === id);

function where(id: string, des: Desired, obs: Observed): string {
  const r = find(des.resources, id) ?? find(obs.resources, id);

  return r ? `${r.type} "${id}" [${r.environment}]` : `"${id}"`;
}

export function describe(p: Problem, des: Desired, obs: Observed): string {
  switch (p.code) {
    case "DUPLICATE_ID":
      return `id "${p.id}" is declared more than once in the desired graph (ids are unique across kinds)`;
    case "DUPLICATE_OBSERVED_ID":
      return `id "${p.id}" appears more than once in the observed snapshot`;
    case "DUPLICATE_BINDING":
      return `worker "${p.worker}" declares binding "${p.binding}" more than once`;
    case "DANGLING_BINDING":
      return `worker "${p.worker}" binding "${p.binding}" targets "${p.database}", which is not a d1_database of the desired graph`;
    case "CROSS_ENV_BINDING": {
      const w = find(des.resources, p.worker);
      const d = find(des.resources, p.database);

      return `worker "${p.worker}" [${w?.environment}] binding "${p.binding}" targets d1_database "${p.database}" [${d?.environment}] in another environment`;
    }

    case "DANGLING_BUCKET_BINDING":
      return `worker "${p.worker}" binding "${p.binding}" targets "${p.bucket}", which is not an r2_bucket of the desired graph`;
    case "CROSS_ENV_BUCKET_BINDING":
      return `worker "${p.worker}" binding "${p.binding}" targets r2_bucket "${p.bucket}" in another environment`;
    case "KIND_CHANGE":
      return `id "${p.id}" changes kind between the observed snapshot and the desired graph`;
    case "ENV_CHANGE":
      return `id "${p.id}" changes environment; moving a resource between environments is not supported`;
    case "UNPROTECT_REFUSED":
      return `${find(obs.resources, p.id)?.type ?? "resource"} "${p.id}" is protected in the observed snapshot; a plan may not remove its protection`;
    case "OUT_OF_GRANT":
      return `${p.action} of ${where(p.id, des, obs)} is outside the grant`;
    case "APPROVAL_REQUIRED":
      return `${p.action} of protected ${where(p.id, des, obs)} needs an approval ${JSON.stringify({ action: p.action, resource: p.id, environment: p.environment })}`;
    case "UNUSED_APPROVAL":
      return `approval ${JSON.stringify({ action: p.action, resource: p.id, environment: p.environment })} matches no operation of this plan`;
    default:
      return JSON.stringify(p);
  }
}

function details(o: Operation, des: Desired, obs: Observed, apps: Approval[]): string {
  const now = find(des.resources, o.id);
  const before = find(obs.resources, o.id);

  const isProtected = [before, now].some(
    (r) => r !== undefined && r.type !== "worker" && r.protected,
  );

  const approval = apps.find(
    (a) => a.action === o.action && a.resource === o.id && a.environment === o.environment,
  );

  const guard = isProtected
    ? `protected; ${approval ? `approved by ${approval.approvedBy}: ${approval.reason}` : "approved"}`
    : "";

  const show = (r: Resource | undefined, f: Reason): string => {
    if (!r) return "-";

    if (f === "bindings") return r.type === "worker" ? bindings(r) : "-";

    return field(r, f);
  };

  switch (o.action) {
    case "create":
      return now ? props(now) : "";
    case "delete":
      return guard;
    case "update":
    case "replace":
      return (
        o.reasons
          .map((f) =>
            f === "rebind"
              ? "rebind: a bound database is replaced"
              : `${f}: ${show(before, f)} -> ${show(now, f)}`,
          )
          .join("; ") + (o.action === "replace" && guard ? `; ${guard}` : "")
      );
  }
}

const bindings = (w: WorkerDecl) =>
  w.bindings.length === 0
    ? "none"
    : w.bindings.map((b) => `${b.name}->${"database" in b ? b.database : b.bucket}`).join(",");

// a declared field's value as text; "undefined" for a field the kind lacks
function field(r: Resource, f: Reason): string {
  if (r.type === "r2_bucket") return f === "protected" ? String(r.protected) : "undefined";

  if (r.type === "d1_database") {
    switch (f) {
      case "location":
        return r.location;
      case "readReplication":
        return r.readReplication;
      case "protected":
        return String(r.protected);
      default:
        return "undefined";
    }
  }

  switch (f) {
    case "main":
      return r.main;
    case "compatibilityDate":
      return r.compatibilityDate;
    default:
      return "undefined";
  }
}

function props(r: Resource): string {
  if (r.type === "r2_bucket") return `protected=${r.protected}`;

  if (r.type === "worker")
    return `main=${r.main} compatibilityDate=${r.compatibilityDate} bindings=${bindings(r)}`;

  return `location=${r.location} readReplication=${r.readReplication} protected=${r.protected}`;
}

export function render(r: Report, des: Desired, obs: Observed, apps: Approval[]): string {
  const lines: string[] = [];
  lines.push(`Plan: ${r.summary}`);
  lines.push(`Grant: environment "${r.grant.environment}", actions [${r.grant.allow.join(", ")}]`);

  if (r.operations.length > 0) {
    lines.push("");
    const w = (k: keyof Operation) => Math.max(...r.operations.map((o) => String(o[k]).length));
    const [wa, wt, wi, we] = [w("action"), w("type"), w("id"), w("environment") + 2];

    for (const o of r.operations) {
      const d = details(o, des, obs, apps);
      lines.push(
        `  ${String(o.step).padStart(2)}. ${o.action.padEnd(wa)}  ${o.type.padEnd(wt)}  ${o.id.padEnd(wi)}  ${`[${o.environment}]`.padEnd(we)}${d ? "  " + d : ""}`.trimEnd(),
      );
    }
  }

  if (r.problems.length > 0) {
    lines.push("");

    for (const p of r.problems)
      lines.push(`  ${r.outcome === "approval_required" ? "!" : "x"} ${p.code}: ${p.message}`);
  }

  lines.push("");
  lines.push(
    `Engine: core/planner.bend compiled by Bend ${r.engine.bendCommit.slice(0, 12)}; proofs ${r.engine.proofs === "verdict" ? "checked by bend2 and the BendTT kernel" : "checked by bend2"}.`,
  );
  lines.push(
    r.executable
      ? "Observed state came from a fixture. This is a plan only: no executor exists, nothing was applied."
      : "Observed state came from a fixture. No executable plan was produced.",
  );

  return lines.join("\n") + "\n";
}
