# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit
`13909c9e07590f5a85d93c62712259fe14a883f7` (MIT, `LICENSE`).

Installed with the upstream fresh-install path: the skill's
`skills/install-anti-slop/scripts/install.mjs` copied
`skills/install-anti-slop/assets/anti-slop/` to this directory. At that commit
the assets equal the canonical `src/` minus `*.test.ts` (upstream
`scripts/sync-skill-assets.mjs --check` passes).

Registered in `/.oxlintrc.json` as the `anti-slop` JS plugin, entry point
`./tools/oxlint/anti-slop/index.ts`.

## Pristine identity

Every copied file is byte-identical to the upstream blob. Git object ids at
the source commit:

| Upstream path                                        | Object id                                  | Here                      |
| ---------------------------------------------------- | ------------------------------------------ | ------------------------- |
| `skills/install-anti-slop/assets/anti-slop/index.ts` | `a3876ec07e4548f66ee353096b3ac851b7572f5b` | `index.ts`                |
| `skills/install-anti-slop/assets/anti-slop/rules`    | `34b6570e1b25925f2609ee8daa35d4fd817db5ef` | `rules/`                  |
| `skills/install-anti-slop/assets/anti-slop/shared`   | `24f0d79ebb19987de8bd5ac6923537cff21e18e3` | `shared/`                 |
| `skills/install-anti-slop/assets/anti-slop/vendor`   | `4b3bb94e10e58b82afc11a688a8f47282b07475c` | `vendor/` (with `LICENSE`, `UPSTREAM.md`) |
| `LICENSE`                                            | `69239ead1ed4a05db45c0da08d1b8f64c0a76ee4` | `LICENSE`                 |

To check: `git rev-parse HEAD:tools/oxlint/anti-slop/rules` (and `shared`,
`vendor`) must print the ids above, and `git hash-object` on `index.ts` and
`LICENSE` must match.

## Intentional deviations

- **Effect plugin omitted.** `effect/` (tree
  `skills/install-anti-slop/assets/anti-slop/effect`) was removed after the
  copy. bend-iac has no direct `effect` dependency, so the opt-in Effect rules
  are not registered. Nothing in the generic plugin imports it.
- **Root `LICENSE` added** verbatim from the upstream repository root. The
  installer copies only the assets directory, which carries the nested
  `vendor/eslint-stylistic/LICENSE` but not the plugin's own license.
- **`UPSTREAM.md` added** (this file).
- **No rule changes.** Rules, options and diagnostics are unmodified.
  Upstream RuleTester suites are not vendored: upstream excludes them from
  the assets, and bend-iac has no unit tests.
- **Dependency versions.** Upstream pins `oxlint` and `@oxlint/plugins`
  1.78.0. bend-iac pins both at 1.88.0. The plugin typechecks against
  `@oxlint/plugins` 1.88.0 (`bun run typecheck`) and loads under `bun run lint`.

## Updating

Follow the upstream skill's update procedure
(`skills/install-anti-slop/references/update.md`): stage the new revision
separately and three-way merge against the commit above. Keep both licenses
and update this record.
