# Live usage

The Wrangler adapter executes Bend-approved plans in your Cloudflare account.
[Project environments](projects.md) and the disposable runs below share it.
Keep run state under git-ignored `.live/` or outside the repository.

Project environments also support R2 buckets, bucket bindings and local deletion
protection updates. The disposable `live` scope below remains Worker+D1 only;
its R2 declarations are refused with exit 4 before any remote call.

## Supported operations

One `d1_database`, one `worker` and at most one binding per run, with exactly
`["e2e"]` as the environments. Logical ids (≤20 characters) become physical
names `bend-infra-e2e-<random-run-id>-<id>`.

Supported: create D1 with replication disabled; create/update the Worker;
delete the Worker, then the database when no longer bound. D1 updates,
replacements, `rebind` and unowned operations are refused (exit 4). The whole
operation list is checked; unsupported steps are never silently skipped.

Deployments use the account's existing workers.dev subdomain.

## Commands

Requires the bootstrapped toolchain, `npx`, network access and an existing
`wrangler login` with Workers Scripts and D1 write access for the chosen account.

```text
bin/bend-iac live init    <run-dir> --account <id> --consent create-and-delete-disposable-bend-infra-e2e-resources
bin/bend-iac live prepare <run-dir> <spec-dir> --account <id> [--json]
bin/bend-iac live apply   <run-dir> --account <id> --artifact <file> --digest sha256:<hex> [--json]
bin/bend-iac live observe <run-dir> --account <id> [--json]
bin/bend-iac live cleanup <run-dir> --account <id> --confirm-run <run-id>
```

- **init:** writes a local ledger with account, consent and random 64-bit run id.
- **prepare:** reads desired/grant/optional approvals and Worker source from the
  spec directory, observes live state, then writes a plan artifact and digest.
- **apply:** verifies that artifact and executes its approved operations.
- **observe:** reads live state without mutating Cloudflare.
- **cleanup:** plans and executes teardown of exactly the run's owned resources.

Additional live exits: `1` failed remote step or unconfirmed teardown;
`4` unsupported operation; `5` artifact/source/account/state refusal or held lock;
`69` undetermined remote state; `130` interrupted. Other exits follow the
[planner CLI](model.md#cli).

Run directories may be relative or absolute. Every command takes the local run
lock before reading the ledger; apply also reads its artifact under that lock.
Prepare reads the spec before locking. A held lock exits 5; stale locks must be
inspected and removed manually.

## What apply verifies

The artifact records canonical inputs, planner outcome/operations, engine pins,
account/run identity, observation, source digest/copy and exact Wrangler
argument arrays/configs. Before mutation, apply verifies:

1. Artifact bytes match the caller's digest and the run/account/Wrangler pin.
2. Replanning the saved inputs reproduces the approved outcome and engine.
3. All operations are supported; original and stored source bytes still match.
4. Recomputed payload equals the recorded payload.
5. A fresh observation equals the recorded evidence.

Saved inputs, source and observations are decoded strictly. The digest binds
apply to the artifact bytes the caller reviewed.

Worker `main` is modelled as `sha256:<source-bytes>`, so byte changes produce
updates. Deployment uses `--no-bundle` and a version-message digest, checked
with the version id and etag.

Steps execute sequentially: recheck create-name absence or D1 delete UUID,
record intent, run Wrangler and read back the result. Project bucket steps also
recheck generation and consumer bindings; enabling bucket protection updates only
local metadata after generation readback. A failed step stops apply, reconciles
project inventory and prints exact cleanup instructions; use project `destroy`
or disposable `live cleanup` to tear down the corresponding scope. SIGINT/SIGTERM finish
the current command and start no further step.

## Observation and recovery

Read-only `d1 info`, project `r2 bucket info`, `deployments status` and `versions view` calls establish
existence, identity, configuration and bindings by exact name. Only an exact
not-found response counts as absence. Auth, network, timeout or malformed
used fields mean **undetermined**, never absent. Required JSON fields are
typed; optional absent/null fields become null or empty flags/bindings. Added
provider fields are ignored; present optional values must have the right type.

The ledger stores provider protection and the requested D1 location. Bindings
resolve through the recorded D1 UUID or project bucket name/generation;
unmodelled bindings, flags, traffic splits or identity drift are refused.
Cleanup may remove an owned Worker despite version drift; prepare/apply may not.

- **Ownership:** existing names become conflicts, never adopted, overwritten
  or deleted. Ambiguous creates are reconciled by exact name and recorded intent,
  not blindly retried. Bucket generation changes and explicit create rejections
  never authorize adoption. An ambiguous bucket delete can be retried through a
  new plan only after the same owned generation is read back.
- **Persistence:** the strictly decoded ledger is atomically rewritten around
  each mutation with statuses and identity/history. The journal records argv,
  config hashes, process identity, signal decisions and results; output strips
  ANSI escapes and email addresses.
- **Cleanup:** uses a Bend plan with empty desired state and a delete grant;
  consent plus `--confirm-run` supplies the protected-deletion approval.
  Undetermined ownership/existence blocks **every cleanup mutation** (exit 69).
  Observation may still reconcile local metadata. D1 deletion additionally
  requires its consumer absent, deleted earlier, or known not to bind it.
  Project bucket deletion also rechecks its generation and the Worker's current
  bindings immediately before deletion. Nonempty buckets remain owned/outstanding;
  no object enumeration or purge is performed. If final absence cannot be
  confirmed, cleanup reports inventory and manual removal commands. Retry when
  observation works again. Protected project resources require explicit approvals,
  not disposable-run consent.

## Process safeguards

Pinned `npx --yes wrangler@4.151.1` runs without a shell, in fresh per-command
work directories that refuse `.env`/`.dev.vars`. Generated configs and environment
both name the explicit account. Children receive an allowlisted environment
(`PATH`, `HOME`, `TMPDIR`, `LANG`, `USER`, `LOGNAME`) plus fixed CI, logging,
color and telemetry settings. Agent variables and API tokens are dropped:
Wrangler's agent detection can otherwise auto-register workers.dev. The existing
OAuth login is used opaquely; bend-iac does not read its credentials.

Commands have 90–180 s timeouts, followed by SIGTERM and a 5 s SIGKILL grace.
The adapter checks process ownership before signalling and cancels pending
timers when the command closes. An unresolved command returns undetermined
state for reconciliation.

## Live tests

```sh
BEND_INFRA_LIVE_ACCOUNT=<32-hex-account-id> \
BEND_INFRA_LIVE_CONSENT=create-and-delete-disposable-bend-infra-e2e-resources \
bun run test:live
```

Optionally set `BEND_INFRA_LIVE_STATE_DIR` to a new directory; the default is
`.live/<timestamp>`. Missing consent, toolchain or login fails—never skips.
`bun run test` does not run this lane.

The public CLI drives create, tamper/unsupported/approval refusals, HTTPS↔D1
round trips, no-op, update and teardown. Real concurrent CLI and interrupted
observation cases check locking and refusal without data loss. Independent
Wrangler/SQL/HTTPS probes verify results. Finally, cleanup retries undetermined
state at most twice more, 15 s apart; the lane fails unless every resource is
confirmed absent.

## Compatibility identifiers

`bend-infra/` document kinds (including live artifact/ledger), the
`bend-infra-e2e-` name prefix, consent literal above, `bend-infra sha256:<hex>`
version message and `BEND_INFRA_LIVE_*` variables are format identifiers,
as are the project kinds `bend-iac/project`, `bend-iac/project-state` and
`bend-iac/project-artifact`.
`bin/bend-infra` is a CLI alias.

See [model](model.md), [proofs](proofs.md#verification-coverage) and
[contributing](../CONTRIBUTING.md).
