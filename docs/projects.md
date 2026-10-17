# Projects

A bend-iac project is an app directory with a `bend-iac.json` manifest and one
spec per environment. `init`, `plan`, `apply` and `destroy` deploy each
environment through Wrangler, with persistent state and stable resource names.
Every plan comes from the same proof-checked Bend planner as `plan <dir>`.

## Quick start

```sh
bin/bend-iac init hello --project hello --env dev --account <account-id>
cd hello
../bin/bend-iac plan  --env dev --account <account-id>
../bin/bend-iac apply --env dev --account <account-id> --digest sha256:<digest from plan>
```

`init` writes a runnable Worker with a D1 database and touches nothing remote:

```text
bend-iac.json            the manifest
src/worker.js            the Worker, deployed as-is (no bundling)
infra/dev/desired.json   bend-infra/desired: a protected D1 "db", a Worker "api" binding it as DB
infra/dev/grant.json     bend-infra/grant: create and update in dev
.bend-iac/dev/           the environment's state (git-ignored)
```

`init` never overwrites: if any of these files exists, nothing is written.

## The manifest

```json
{
  "version": 1,
  "kind": "bend-iac/project",
  "project": "hello",
  "environments": {
    "dev": { "spec": "infra/dev" },
    "staging": { "spec": "infra/staging" }
  }
}
```

- `project`: `[a-z][a-z0-9-]*`, at most 20 characters, not ending in `-`.
- Environment names: `[a-z][a-z0-9]*`, at most 10 characters; 1–16 environments.
- `spec`: a project-root-relative directory holding the
  [model documents](model.md#documents) `desired.json` and `grant.json`, and
  optionally `approvals.json`. Its `environments` must be exactly `[<name>]`.
- A Worker `main` is a project-root-relative `.js`/`.mjs` path.

The manifest is strict like every other document. Accounts and credentials
never go in it; pass `--account` on each command.

Each environment supports one D1 database, one R2 bucket and one Worker,
with at most one binding per provider kind. Add a bucket to `resources`:

```json
{ "type": "r2_bucket", "id": "files", "environment": "dev", "protected": true }
```

A Worker's bindings can include both `{ "name": "DB", "database": "db" }`
and `{ "name": "FILES", "bucket": "files" }`. Providers are created before
the Worker; teardown removes its bindings or deletes it before the bucket.
R2 supports create, delete and enabling deletion protection in local state;
D1 and Worker operations are described in [live usage](live.md#supported-operations).

## Environments and state

`init` creates `.bend-iac/<env>/` with a `bend-iac/project-state` ledger
recording the project, environment, account and a random 64-bit state id.
`.bend-iac/.gitignore` keeps all state out of Git.

To add an environment, declare it and its spec in the manifest, then run:

```sh
../bin/bend-iac init --project hello --env staging --account <account-id>
```

With a manifest present, `init` writes only the new state.

A bucket declaration promotes project state and artifacts to version 2 under
the environment lock, preserving existing identities and history. Plan again
rather than applying an older version-1 artifact after this promotion. Bucket
ownership records its creation timestamp; a same-name replacement is not adopted.

State is never created implicitly: `plan`, `apply` and `destroy` refuse an
environment without state. The state's project, environment and account
never change. A renamed project, another `--account`, or state copied
between environments is refused before anything remote runs.

Resources are named `<project>-<env>-<logical id>-<first 8 hex of the state id>`,
for example `hello-dev-api-1f3a9c2e` (at most 61 characters). The names stay the
same across deployments. Updates deploy a new Worker version in place;
the D1 database, R2 bucket and their data are kept. A removed resource can be re-added
with the same logical id and name after its deletion is confirmed. Logical
ids stay fixed for the lifetime of the environment's state; renaming them
is not supported. A name that already exists before
bend-iac created it is a conflict: it is never adopted, overwritten or deleted.

## Commands

```text
bend-iac init [<dir>] --project <name> --env <env> --account <id>
bend-iac plan    --env <env> --account <id> [--project <dir>] [--json]
bend-iac apply   --env <env> --account <id> --digest sha256:<hex> [--artifact <file>] [--project <dir>] [--json]
bend-iac destroy --env <env> --account <id> --confirm <project>/<env> [--approvals <file>] [--project <dir>]
```

The manifest is `<dir>/bend-iac.json` from `--project`, or `./bend-iac.json`.

- **plan:** observes the environment read-only, runs the planner and writes an
  artifact to `.bend-iac/<env>/artifacts/` with its digest.
- **apply:** runs the artifact whose sha256 is `--digest`. Without `--artifact`,
  the newest plan artifact of the environment must have that digest. Apply
  performs every [verification](live.md#what-apply-verifies) of `live apply`.
- **destroy:** plans a teardown of exactly what the state owns: an empty
  desired graph and a delete grant for the environment. `--confirm` must name
  the project and environment. Each protected database or bucket requires its
  own matching `delete` approval in `--approvals`; otherwise destroy exits 3 and
  nothing runs. Undetermined state blocks every deletion (exit 69).

A destroyed environment's state keeps its history. Plan and apply again to
recreate its resources under the same logical ids and names; do not discard
the state. Each create rechecks exact-name absence before starting a new
generation. A nonempty bucket stops teardown with outstanding inventory;
bend-iac never lists or deletes its objects. Initialization exclusively claims a new environment directory;
existing state, including an empty or partial directory, is never overwritten.

### Plan dispatch

`plan` with `--env` plans a project; `plan` without `--env` is fixture planning
and never contacts Cloudflare. Combining `--env` with a fixture directory or
fixture file flags is a usage error.

### Exits

`0` ok; `1` remote step failed or teardown not confirmed; `2` rejected;
`3` approval required; `4` unsupported by the adapter; `5` refused (digest,
artifact, state identity, confirmation, existing file or held lock); `64` usage;
`65` invalid input; `66` missing input; `69` remote state undetermined;
`70` engine; `130` interrupted.

## Execution

Project commands share the `live` executor: per-environment lock taken before
state or artifact reads, Wrangler process safeguards, ownership checks,
ambiguous-create reconciliation and fail-closed teardown. See
[live usage](live.md). Requirements are the same: the bootstrapped toolchain,
`npx`, network access and an existing `wrangler login` for the account.
