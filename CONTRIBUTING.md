# Contributing

Requires Bun ≥ 1.3.12; bootstrap prerequisites are in the [README](README.md).
The CLI has no runtime dependencies. Development tools are pinned in `bun.lock`.

```sh
bun install --frozen-lockfile
bun run bootstrap                 # once: pinned Bend, Lean and BendTT kernel
bun run check                     # formatting, strict lint, typecheck
bun run test                      # proofs, build, E2E, integration, mutants
bun run demo
```

Use `bun run test`, **not bare `bun test`**: the latter bypasses the proof gate
and discovers the opt-in live lane. Missing prerequisites, skipped tests and
todos fail the supported test lanes.

| Command                    | Coverage                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `bun run check:proofs`     | Laws, proofs and finite examples via bend2 + BendTT                                            |
| `bun run test:e2e`         | Public CLI, project init/refusals, invalid inputs, local refusals and concurrent locking       |
| `bun run test:integration` | Compiled planner vs Bend checker, seeded law checks, mutants and real process timeouts         |
| `bun run test:live`        | Explicitly authorized disposable Cloudflare lifecycle; [instructions](docs/live.md#live-tests) |

There are no unit tests or mocks. Local lanes never call Cloudflare. Process integrations use pinned Wrangler
through `npx --version` and the file-share app's `dev --local` lifecycle with
scratch HOME, synthetic bindings and temporary D1/R2 persistence. These need
Node/npm, `ps`, and npm registry access; missing prerequisites fail the lane.
The local app scenario checks binary downloads, capability deletion, size limits,
SQLite metadata/object inventory, persistence and source updates. It is not
Cloudflare live validation.

Oxlint uses the vendored [anti-slop plugin](tools/oxlint/anti-slop/UPSTREAM.md);
Oxfmt formats owned files. Run `bun run lint:fix` followed by `bun run fmt`.
Do not weaken rules or suppress boundary-validation failures to make checks pass.

Keep generated toolchains/builds, live state, logs and credentials out of Git.
When changing the planner, preserve the laws and all tests; an intentional law
change requires updating `LAWS.sha256`. See [proofs](docs/proofs.md) for the
verification process and [model](docs/model.md) for the current contract.
