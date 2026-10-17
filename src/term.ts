// Renders codec values as Bend terms, for the differential test that
// evaluates the planner with Bend's own checker (see
// test/differential.test.ts). Only allow-listed constructor names, Nat
// literals and punctuation are emitted: the codec carries no strings, so
// no input text can reach the generated source.

import { isNat, type BendTerm } from "./codec";

const CTORS = [
  "Create",
  "Update",
  "Delete",
  "Replace",
  "KDb",
  "KWorker",
  "KBucket",
  "FLocation",
  "FReplication",
  "FProtect",
  "FMain",
  "FCompat",
  "FBindings",
  "FRebind",
  "Bind",
  "BucketBind",
  "Bucket",
  "Db",
  "Wk",
  "State",
  "Grant",
  "Approval",
  "Op",
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
  "Approved",
  "Pending",
  "Rejected",
];

export function toBend(v: BendTerm, prefix = ""): string {
  if (v === true || v === false) return v ? "True{}" : "False{}";

  if (!(v instanceof Object)) {
    if (!isNat(v)) throw new Error(`term: not a Nat: ${String(v)}`);

    return `${v}n`;
  }

  if (v.$ === "Nil" || v.$ === "Con") {
    const xs: string[] = [];
    let x: BendTerm = v;

    while (x instanceof Object && x.$ === "Con") {
      xs.push(toBend(x.head, prefix));
      x = x.tail;
    }

    if (!(x instanceof Object) || x.$ !== "Nil") throw new Error("term: improper list");

    return `[${xs.join(", ")}]`;
  }

  const name = CTORS.find((c) => c === v.$);

  if (name === undefined) throw new Error(`term: unknown constructor ${String(v.$)}`);

  const fields = Object.entries(v).flatMap(([k, x]) => (k === "$" ? [] : [toBend(x, prefix)]));

  return `${prefix}${name}{${fields.join(", ")}}`;
}
