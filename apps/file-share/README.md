# File share

A small file-sharing workspace: a Worker serves the UI and API, D1 holds
metadata, and R2 holds bytes. Copy this directory into your own project.

## Local preview

Requires Node/npm (npx), no Cloudflare account or credentials. From this
directory, copy only the source and local config into a scratch workspace:

```sh
preview=$(mktemp -d)
mkdir -p "$preview/app/src" "$preview/home"
cp src/worker.js "$preview/app/src/"
cp wrangler.local.json "$preview/app/"
env -i HOME="$preview/home" PATH="$PATH" CI=true \
  XDG_CONFIG_HOME="$preview/home/.config" WRANGLER_SEND_METRICS=false \
  npx --yes wrangler@4.151.1 dev --local \
  --config "$preview/app/wrangler.local.json" \
  --persist-to "$preview/data" --ip 127.0.0.1 --port 8787
```

Open <http://127.0.0.1:8787>. Stop with Ctrl-C. Repeat the same command to
reuse D1/R2 data; edit the copied source for preview changes. Remove the
scratch directory only after Wrangler has stopped. The synthetic IDs and
explicit local bindings in `wrangler.local.json` are **preview only**:
never use this config for deployment. This is local Miniflare/workerd,
not Cloudflare live validation.

## API

Upload raw binary (maximum 1 MiB, also enforced while reading streamed bodies):

```sh
curl -X POST http://127.0.0.1:8787/api/files \
  -H 'X-File-Name: notes.txt' -H 'Content-Type: text/plain' \
  --data-binary @notes.txt
curl http://127.0.0.1:8787/api/files/FILE_ID
curl -OJ http://127.0.0.1:8787/api/files/FILE_ID/download
curl -X DELETE http://127.0.0.1:8787/api/files/FILE_ID \
  -H 'Authorization: Bearer DELETE_TOKEN'
```

Percent-encode Unicode filenames in `X-File-Name`. Upload returns metadata,
a random ID, and a one-time-returned `deleteToken`. Keep that capability:
D1 stores only its SHA-256 hash. Public metadata and download URLs never
contain it. Downloads are attachments with an octet-stream content type,
including uploaded HTML. The app creates its table on first API use.

The UI remembers uploads and delete capabilities in this browser's local
storage, not a public listing. Copy links grant download access to anyone
holding them. This is not an authenticated or quota-managed upload service;
add access controls before exposing it to an untrusted public audience.
Storage failure can require reconciling D1 and R2; they do not share a transaction.

## Project deployment

From the repository root, initialize the copied app's local ownership state:

```sh
bin/bend-iac init apps/file-share --project file-share --env dev --account <account-id>
bin/bend-iac plan --project apps/file-share --env dev --account <account-id>
bin/bend-iac apply --project apps/file-share --env dev --account <account-id> \
  --digest sha256:<reviewed-plan-digest>
```

The existing manifest is named `file-share`; initialization writes state
only. Desired infrastructure has protected D1 `db`, protected R2 `files`,
and Worker `api` bound as `DB` / `FILES`. No application dependency,
bundler, secret variable or IaC object primitive is needed. Actual deployment
requires your separately configured Cloudflare access; the local preview
does not test provider provisioning or destroy.

Before teardown, delete **every uploaded file using its own capability**.
bend-iac never purges bucket objects. Review/copy the separate root-level
`destroy-approvals.example.json` (both providers), then:

```sh
bin/bend-iac destroy --project apps/file-share --env dev --account <account-id> \
  --confirm file-share/dev --approvals apps/file-share/destroy-approvals.example.json
```

Do not place destroy approvals in `infra/dev`: they would be unused during
normal planning. Keep the project's state for subsequent generations.
See [project commands](../../docs/projects.md).
