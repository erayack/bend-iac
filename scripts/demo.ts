// npm run demo: plans every example with the real CLI and checks that each
// ends the way docs/model.md says. Nothing is applied: plan has no executor.
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

const DEMO: [string, string, number][] = [
  ["01-create", "create a Worker, a D1 database and the binding between them", 0],
  ["02-noop", "the observed snapshot already matches: no changes, safe with an empty grant", 0],
  ["03-update", "ordinary in-place updates (Worker entry module and date, D1 replication)", 0],
  ["04-cross-env-grant", "a staging grant cannot create production resources", 2],
  ["05-cross-env-binding", "a staging Worker cannot bind a production database", 2],
  ["06-dangling-binding", "a binding to an undeclared database is rejected", 2],
  [
    "07-protected-delete-unapproved",
    "deleting a protected production database without approval",
    3,
  ],
  [
    "08-protected-delete-approved",
    "the same deletion with a matching approval: Worker first, then the database",
    0,
  ],
  [
    "09-protected-replace-unapproved",
    "a location change replaces the protected database: destructive, needs approval",
    3,
  ],
  [
    "10-protected-replace-approved",
    "the same replacement approved: replace, then rebind the Worker",
    0,
  ],
  [
    "11-dependency-safe-removal",
    "removing a database: delete its consumer, unbind the other, then delete it",
    0,
  ],
  ["12-r2-mixed-create", "create D1 and R2 before their same-environment Worker", 0],
  ["13-r2-mixed-delete", "delete Worker, D1, then R2", 0],
  ["14-r2-cross-env-grant", "R2 changes outside the grant are refused", 2],
  ["15-r2-cross-env-binding", "cross-environment bucket binding is refused", 2],
  ["16-r2-missing-target", "missing bucket target is refused", 2],
  ["17-r2-wrong-kind-target", "bucket binding cannot target D1", 2],
  ["18-d1-wrong-r2-target", "D1 binding cannot target R2", 2],
  ["19-r2-duplicate-binding", "binding names share a namespace across target kinds", 2],
  ["20-r2-duplicate-id", "IDs are unique across all resource kinds", 2],
  ["21-r2-unprotect", "bucket protection cannot be removed", 2],
  ["22-r2-protected-delete", "protected bucket deletion needs approval", 3],
  ["23-r2-wrong-approval", "wrong-environment bucket approval is refused", 2],
  ["24-r2-approved-delete", "exact approved protected bucket deletion", 0],
  ["25-r2-protection-update", "bucket protection metadata update", 0],
  ["26-r2-noop", "unchanged mixed graph needs no grant actions", 0],
  ["27-r2-ambiguous-diagnostics", "duplicate names retain target-kind diagnostics", 2],
];

let failed = 0;

for (const [dir, title, want] of DEMO) {
  const ex = path.join("examples", dir);
  console.log(`\n${"=".repeat(78)}\n${dir}: ${title}\n$ bin/bend-iac plan ${ex}\n`);

  const r = spawnSync(path.join(ROOT, "bin", "bend-iac"), ["plan", ex], {
    cwd: ROOT,
    encoding: "utf8",
  });

  process.stdout.write(r.stdout + r.stderr);
  const ok = r.status === want;

  if (!ok) failed++;
  console.log(`[exit ${r.status}; expected ${want}: ${ok ? "ok" : "UNEXPECTED"}]`);
}

console.log(
  `\n${"=".repeat(78)}\ndemo: ${DEMO.length - failed}/${DEMO.length} examples ended as documented`,
);

process.exit(failed === 0 ? 0 : 1);
