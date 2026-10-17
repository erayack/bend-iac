# Planner proofs

```text
JSON → strict schema → interned Bend values → validate → diff → authorize
                                                           ↓
                                  Approved{ops} | Pending | Rejected
```

## Laws

[`LAWS.bend`](../LAWS.bend) states three independent predicates over the real
`core/planner.bend` entry point. They hold for **every** desired state, observed
state, grant and approval list in the planner's types:

- **`env_isolation`:** every approved operation uses the grant's environment
  and permitted action. Every desired/observed resource with the touched id
  also resides there. Replace requires create and delete permission.
- **`binding_validity`:** every desired Worker binding resolves to a desired
  database or bucket of the binding's target kind in the Worker's environment.
- **`protected_deletion`:** destructive operations on an id held by a database
  or bucket protected in either snapshot require an approval matching action,
  id and environment.

Only `Approved` carries operations. The predicates use model constructors and
Base equality, not the planner's checking functions.

[`PROOF.bend`](../PROOF.bend) uses structural induction: approval means the
gate's problem lists are empty; soundness lemmas turn the successful Boolean
checks into each law's predicate. These are universal proofs, not enumerated
tests. [`EXAMPLES.bend`](../EXAMPLES.bend) supplies finite checked examples,
including an approved protected deletion, to demonstrate non-vacuity.

The laws establish safety properties of approved plans over the model's inputs.
Integration tests cover diff behavior, dependency ordering and cloud execution.

## Kernel resource protocol

The Bend kernel represents `State{dbs, wks, buckets}`, with distinct
`Bucket{id, env, protect}` and `KBucket` constructors. Worker bindings are
`Bind{name, db}` or `BucketBind{name, bucket}`; lookup and equality preserve
that distinction. Bucket changes are create, delete and false→true protection
metadata updates (`FProtect`); removing protection is refused. Dependency phases
are Worker deletes, D1 changes, bucket changes, Worker changes, D1 deletes,
bucket deletes. Input list order is retained within each phase.

The three laws quantify over arbitrary kernel values, including duplicate ids.
Residency includes all three lists in both snapshots. Protection retains every
D1 witness and adds bucket witnesses from both snapshots. With empty buckets
and D1-only bindings, the original clauses remain: added residency is `Unit`
and added protection witnesses are `Empty`. `LAWS.sha256` intentionally pins
these strengthened statements. R2 examples check typed bindings, refusals and
an approved protected deletion with an extracted approval witness.

Public JSON encodes all three resource kinds and distinct D1/R2 bindings.
Bucket diagnostics have distinct constructors, preserving target kind even for
ambiguous duplicate binding names. Project environments execute all three resource
kinds through Wrangler; see [projects](projects.md).

## Verification

```sh
bun run check:proofs
bun run test:mutation
```

The proof gate checks the pinned toolchain, `LAWS.sha256`, absence of escape
hatches/extra axioms, core type-checking, exactly three open claims in the laws
alone, and complete proofs/examples through **bend2 and BendTT `--verdict`**.
It also checks the exported kernel statements refer to the actual planner.
The build refuses failed proofs; a source-hash stamp triggers stale rebuilds.
Intentional law changes require updating the pinned hash explicitly.

Mutation tests retain five original well-typed planner bugs: replacement not destructive,
approval/environment mismatch, ignored grant environment, trusted operation
environment label, and ignored binding environment. Each must fail the intended
proof chain and the CLI build gate. Three demonstrate authorization bypasses;
two remain blocked by other gates and are reported as masked, not runtime
bypasses. Two additional well-typed R2 mutants bypass bucket target-kind/environment
validation and protected bucket deletion. Both fail their independent law chains,
BendTT verdict and build gate, and both demonstrate compiled bypass witnesses.
Seed 20261016 retains 400 baseline cases; seed 20261102 adds 160 public-schema
R2 cases with approved, pending, rejected and approved destructive outcomes.
See [contributing](../CONTRIBUTING.md) for all test lanes.

## Toolchain

`bun run bootstrap` installs locally under `.toolchain/`:

- Bend 2 at `234cb9b950800f20b15feafcb4ce2f43e76e7fae`;
- Lean 4.34.0, with per-platform SHA256s in [`toolchain.env`](../toolchain.env);
- BendTT compiled from that Bend revision.

`BEND_SRC=/path/to/clone` can supply the pinned checkout. Nothing is installed
globally or into `~/.bend` or `~/.elan`; the pinned runner disables telemetry.
Planning and proof checks run offline after bootstrap. The separate process
integration uses `npx`, and live execution calls Cloudflare.

## Verification coverage

- **Planner:** universal Bend proofs, checked by bend2 and the BendTT kernel.
- **CLI bridge:** strict input validation, injective string-to-Nat encoding,
  and output checks for constructors, lists, Nats and table bounds.
- **Compiled planner:** differential tests compare Bend's JS backend output
  with checker evaluation on examples and seeded inputs.
- **Cloud execution:** live integration tests exercise Wrangler operations,
  D1 SQL, HTTPS, recovery and teardown. See [live usage](live.md).

The formal proofs apply to the Bend planner; the surrounding pipeline is covered
by these tests and runtime checks. `planFrom` supplies the generated module's
TypeScript signature. Normal input passes as values, without generating Bend
source; differential tests emit Nat literals and allowlisted constructors.
