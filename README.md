# bend-iac

Proof-oriented infrastructure-as-code planner in
[Bend 2](https://github.com/bendlang/bend) for Cloudflare.

Describe your infrastructure and supply an observed snapshot and a grant.
bend-iac returns an authorized, ordered plan or explains why the change is blocked.
Three safety laws about the planner are mechanically proven before it runs.

## Quick start

Requires Bun ≥ 1.3.12, Git, curl and zstd on macOS (arm64/x86_64) or
Linux (x86_64/aarch64).

```sh
git clone https://github.com/erayack/bend-iac.git
cd bend-iac
bun run bootstrap                    # pinned Bend + Lean; nothing installed globally
bin/bend-iac plan examples/01-create
```

`plan` evaluates local JSON. The [example inputs](examples/01-create)
declare a database and a Worker with this binding:

```json
{
  "type": "worker",
  "id": "api",
  "environment": "staging",
  "main": "src/api.ts",
  "compatibilityDate": "2026-09-01",
  "bindings": [{ "name": "DB", "database": "app-db" }]
}
```

The plan lists `app-db` before `api`. Use `--json` for a deterministic,
machine-readable report. Run `bun run demo` for all [27 scenarios](examples),
including blocked cross-environment changes and protected deletions.

## Deploy an app

```sh
bin/bend-iac init hello --project hello --env dev --account <account-id>
cd hello
../bin/bend-iac plan  --env dev --account <account-id>
../bin/bend-iac apply --env dev --account <account-id> --digest sha256:<digest from plan>
```

`init` scaffolds a Worker with a D1 database, a `bend-iac.json` manifest and
git-ignored per-environment state. `plan` observes the environment and saves
a reviewable artifact; `apply` runs exactly that artifact. Environments keep
stable resource names across deployments. See [projects](docs/projects.md).

Try the copyable [file-sharing app](apps/file-share): Worker UI/API, D1 metadata,
R2 files, and a credential-free pinned Wrangler local preview.

## Currently supported

- **Cloudflare D1:** location, read replication and deletion protection.
  A location change is a destructive replacement.
- **Cloudflare R2:** project buckets with deletion protection and Worker bindings.
- **Cloudflare Workers:** entry module, compatibility date, D1 and R2 bindings.
- **Planning:** create, update, replace and delete, in dependency order.
- **Deployment:** create, update and delete a Worker; create and delete
  a D1 database through Wrangler, per project environment or disposable run.
  Project environments also create/delete R2 buckets and enable local bucket
  deletion protection. Object contents are never purged.

See [model and CLI](docs/model.md) for schemas, [projects](docs/projects.md)
for app environments and [live usage](docs/live.md) for the executor,
disposable runs and cleanup.

## Verified guarantees

For every input, an approved Bend plan satisfies:

1. **Environment isolation:** every operation and resource it touches stays
   within the grant's environment and allowed actions.
2. **Binding validity:** every desired Worker binding targets a D1 database or R2 bucket
   of its declared kind in the same environment.
3. **Protected deletion:** deleting or replacing a protected database or bucket needs
   a matching approval.

Only approved outcomes contain operations. `approval_required` and `rejected`
never carry a partial plan. The build checks the proofs with bend2 and the
BendTT kernel. See [proofs](docs/proofs.md) for the laws and verification process.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and checks.
Tests use the public CLI and real integrations, with no unit tests or mocks.

[MIT](LICENSE).
