# Model and CLI

## Resources

Every resource has a logical `id` matching `[a-z][a-z0-9-]*` (≤63 characters)
and an `environment` declared in `desired.environments`. Ids are unique across
resource kinds and environments; changing an id's kind or environment is refused.

| Kind          | Properties                                                                             | Change behavior                        |
| ------------- | -------------------------------------------------------------------------------------- | -------------------------------------- |
| `d1_database` | `location`: `wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`                               | Replacement                            |
|               | `readReplication`: `auto`, `disabled`                                                  | Update                                 |
|               | `protected`: required boolean                                                          | false→true updates; true→false refused |
| `r2_bucket`   | `protected`: required boolean; no other bucket properties                              | false→true updates; true→false refused |
| `worker`      | `main`: entry-module text; `compatibilityDate`: real `YYYY-MM-DD`                      | Update                                 |
|               | `bindings`: `[{name, database}]` or `[{name, bucket}]`; name matches `[A-Z][A-Z0-9_]*` | Update; order ignored                  |

Each binding must target its declared provider kind (`database`: D1; `bucket`: R2)
in the **desired** graph, in the Worker's own environment. Exactly one target key
is required. Binding names are unique across both kinds; the shared limit is 32. See the complete [create example](../examples/01-create).

## Planning and authorization

- **create:** desired, not observed. **delete:** observed, not desired.
- **update:** a mutable property differs. **replace:** D1 location differs;
  delete and recreate under the same id. Both delete and replace are destructive.
- An unchanged graph yields an approved empty plan. Replacing a database also
  updates its consumers with reason `rebind`.

Operations are sorted by id within six phases: delete departed Workers;
D1 changes; R2 changes; Worker changes; D1 deletes; R2 deletes.
A remaining Worker cannot bind a deleted provider.

A **grant** allows `create`, `update` and/or `delete` in one environment.
Replace requires both create and delete. Every operation and every desired or
observed declaration it touches must stay within that environment.

A database or bucket is protected if **either** snapshot marks it protected. Destruction
then requires an approval matching `(action, resource, environment)`, with
`approvedBy` and `reason` as audit text. Unused approvals are refused as stale;
approvals operate within the grant's permissions.

| Outcome             | Exit | Operations                                        |
| ------------------- | ---- | ------------------------------------------------- |
| `approved`          | 0    | Ordered plan, possibly empty                      |
| `approval_required` | 3    | None; only missing approvals                      |
| `rejected`          | 2    | None; validation, grant or stale-approval failure |

Problem codes: `DUPLICATE_ID`, `DUPLICATE_OBSERVED_ID`, `DUPLICATE_BINDING`,
`DANGLING_BINDING`, `CROSS_ENV_BINDING`, `DANGLING_BUCKET_BINDING`,
`CROSS_ENV_BUCKET_BINDING`, `KIND_CHANGE`, `ENV_CHANGE`,
`UNPROTECT_REFUSED`, `OUT_OF_GRANT`, `APPROVAL_REQUIRED`, `UNUSED_APPROVAL`.

## Documents

All documents use `version: 1` and the following format identifiers.

| File                        | `kind`                 | Contents                         |
| --------------------------- | ---------------------- | -------------------------------- |
| `desired.json`              | `bend-infra/desired`   | `environments`, `resources`      |
| `observed.json`             | `bend-infra/observed`  | `source: "fixture"`, `resources` |
| `grant.json`                | `bend-infra/grant`     | `environment`, `allow`           |
| `approvals.json` (optional) | `bend-infra/approvals` | `approvals`                      |

Start with the [working fixtures](../examples). `plan` accepts only fixture
observations; live commands obtain their own state through Wrangler.

Input is strict UTF-8 and strict JSON: duplicate keys, BOMs, unknown fields,
wrong types, missing required fields and unknown enum values are refused.
Invalid bytes are never silently repaired. Security-relevant fields have no
defaults, and every referenced environment must be declared.

Limits: 1 MiB per document, checked before decoding; 16 environments;
256 resources per document; 32 bindings per Worker; 64 approvals; text fields
≤256 characters without control characters. Unreadable files exit 66;
invalid input exits 65.

## R2 fixtures

Every numbered directory contains complete copyable JSON documents. Run
`bin/bend-iac plan examples/<name>` or `bun run demo` (all 27 scenarios).

| Fixture                     | Expected result                                        |
| --------------------------- | ------------------------------------------------------ |
| 12-r2-mixed-create          | D1, R2, then their same-environment Worker (exit 0)    |
| 13-r2-mixed-delete          | Worker, D1, then R2 (0)                                |
| 14-r2-cross-env-grant       | Refused grant (2)                                      |
| 15-r2-cross-env-binding     | Refused bucket environment (2)                         |
| 16-r2-missing-target        | Missing bucket (2)                                     |
| 17-r2-wrong-kind-target     | Bucket binding cannot target D1 (2)                    |
| 18-d1-wrong-r2-target       | D1 binding cannot target R2 (2)                        |
| 19-r2-duplicate-binding     | Shared binding-name namespace (2)                      |
| 20-r2-duplicate-id          | Global ID namespace across all three kinds (2)         |
| 21-r2-unprotect             | Removing protection refused (2)                        |
| 22-r2-protected-delete      | Approval required (3)                                  |
| 23-r2-wrong-approval        | Wrong-environment approval refused (2)                 |
| 24-r2-approved-delete       | Exact protected deletion approval (0)                  |
| 25-r2-protection-update     | Protection metadata update (0)                         |
| 26-r2-noop                  | Mixed graph, empty grant, no changes (0)               |
| 27-r2-ambiguous-diagnostics | Duplicate names retain distinct target diagnostics (2) |

Projects execute R2 bucket create/delete, Worker bucket bindings and local
false-to-true deletion protection updates. Disposable `live` remains D1/Worker
only and refuses R2 before remote access. Protection is authoritative local
metadata, not an R2 API setting.

## CLI

```text
bin/bend-iac plan <dir> [--json]
bin/bend-iac plan --desired F --observed F --grant F [--approvals F] [--json]
bin/bend-iac build | help | version
```

`<dir>` holds the files above; explicit file flags override directory defaults.
`--json` reports outcome, `executable`, operations/reasons, problems and engine
pins without timestamps, so identical inputs produce identical output.

Other exits: `64` usage; `70` missing toolchain, failed proofs or build error.
`plan --env <env>` plans a project environment instead; see [projects](projects.md).
See [live usage](live.md) for execution commands and their additional exits.
`bin/bend-infra` remains a compatibility alias.
