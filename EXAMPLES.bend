# bend-infra: worked examples, checked inside Bend. These are finite
# checks, not laws: each {a == b} below holds because the checker
# evaluates P.plan on a concrete input and gets exactly b. They show the
# laws are not vacuous (an Approved outcome with destructive, protected
# operations is reachable, and the laws then say something real about
# it) and pin the same behaviour the CLI examples show.
#
# Encoding (what src/codec.ts would produce for these ids):
#   environments: 0n production, 1n staging
#   ids: 0n api, 1n app-db, 2n prod-api, 3n prod-db
#   locations: 0n enam, 1n weur; mains and compats: 0n; binding name DB: 0n

import Base
import ./core/planner.bend as P
import ./LAWS.bend as Laws
import ./PROOF.bend as Pf

# R2 tracer: a bucket is a distinct provider, not a database.
def ex.bucket_create() -> {P.plan(P.State{[], [], [P.Bucket{4n, 0n, False{}}]}, P.State{[], [], []}, P.Grant{0n, True{}, False{}, False{}}, []) == P.Approved{[P.Op{P.Create{}, P.KBucket{}, 4n, 0n, []}]} : P.Outcome}:
  {==}

def ex.prod_db() -> P.Db:
  P.Db{3n, 0n, True{}, 0n, True{}}

def ex.prod_api() -> P.Wk:
  P.Wk{2n, 0n, 0n, 0n, [P.Bind{0n, 3n}]}

def ex.observed() -> P.State:
  P.State{[ex.prod_db()], [ex.prod_api()], []}

def ex.retired() -> P.State:
  P.State{[], [], []}

def ex.moved() -> P.State:
  P.State{[P.Db{3n, 0n, True{}, 1n, True{}}], [ex.prod_api()], []}

def ex.grant_delete() -> P.Grant:
  P.Grant{0n, False{}, False{}, True{}}

def ex.grant_all() -> P.Grant:
  P.Grant{0n, True{}, True{}, True{}}

def ex.approve(act: P.Act) -> List<&2, P.Approval>:
  [P.Approval{act, 3n, 0n}]

def ex.retire_ops() -> List<&2, P.Op>:
  [P.Op{P.Delete{}, P.KWorker{}, 2n, 0n, []}, P.Op{P.Delete{}, P.KDb{}, 3n, 0n, []}]

# Deleting a protected database
# -----------------------------

# with a matching approval: approved, the Worker deleted before the database
def ex.delete_approved() -> {P.plan(ex.retired(), ex.observed(), ex.grant_delete(), ex.approve(P.Delete{})) == P.Approved{ex.retire_ops()} : P.Outcome}:
  {==}

# without one: pending, and no operations
def ex.delete_pending() -> {P.plan(ex.retired(), ex.observed(), ex.grant_delete(), []) == P.Pending{[P.NeedApproval{P.Delete{}, 3n, 0n}]} : P.Outcome}:
  {==}

# a replace approval does not authorize a delete
def ex.delete_wrong_act() -> {P.plan(ex.retired(), ex.observed(), ex.grant_delete(), ex.approve(P.Replace{})) == P.Rejected{[P.UnusedApproval{P.Replace{}, 3n, 0n}, P.NeedApproval{P.Delete{}, 3n, 0n}]} : P.Outcome}:
  {==}

# a grant for staging (1n) covers none of it
def ex.delete_wrong_env() -> {P.plan(ex.retired(), ex.observed(), P.Grant{1n, True{}, True{}, True{}}, ex.approve(P.Delete{})) == P.Rejected{[P.OutOfGrant{P.Delete{}, 2n, 0n}, P.OutOfGrant{P.Delete{}, 3n, 0n}]} : P.Outcome}:
  {==}

# Replacing a protected database
# ------------------------------

def ex.replace_approved() -> {P.plan(ex.moved(), ex.observed(), ex.grant_all(), ex.approve(P.Replace{})) == P.Approved{[P.Op{P.Replace{}, P.KDb{}, 3n, 0n, [P.FLocation{}]}, P.Op{P.Update{}, P.KWorker{}, 2n, 0n, [P.FRebind{}]}]} : P.Outcome}:
  {==}

def ex.replace_pending() -> {P.plan(ex.moved(), ex.observed(), ex.grant_all(), []) == P.Pending{[P.NeedApproval{P.Replace{}, 3n, 0n}]} : P.Outcome}:
  {==}

# No change
# ---------

def ex.noop() -> {P.plan(ex.observed(), ex.observed(), P.Grant{0n, False{}, False{}, False{}}, []) == P.Approved{[]} : P.Outcome}:
  {==}

# The laws at an approved input
# -----------------------------
# Instantiated at the approved deletion, each law's IfApproved computes to
# its real claim about the two operations; the proofs deliver it.

def ex.law_env() -> Laws.AllInGrant(ex.grant_delete(), ex.retired(), ex.observed(), ex.retire_ops()):
  Laws.env_isolation(ex.retired(), ex.observed(), ex.grant_delete(), ex.approve(P.Delete{}))

def ex.law_protected() -> Laws.AllDestroyOk(ex.retired(), ex.observed(), ex.approve(P.Delete{}), ex.retire_ops()):
  Laws.protected_deletion(ex.retired(), ex.observed(), ex.grant_delete(), ex.approve(P.Delete{}))

# the protected-deletion claim for the database step, applied to the
# protection witness (prod-db is protected in the observed graph), yields
# the approval witness: the first approval, matching act, id and env
def ex.law_protected_db(ok: Laws.AllDestroyOk(ex.retired(), ex.observed(), ex.approve(P.Delete{}), ex.retire_ops())) -> Laws.Approves(P.Delete{}, 3n, 0n, ex.approve(P.Delete{})):
  match ok:
    case (w, (d, u)):
      d(Inl{Inl{Inl{({==}, {==})}}})

def ex.approval_witness() -> Laws.Approves(P.Delete{}, 3n, 0n, ex.approve(P.Delete{})):
  ex.law_protected_db(ex.law_protected())

def ex.law_binding() -> Laws.BindingsValid(ex.moved()):
  Laws.binding_validity(ex.moved(), ex.observed(), ex.grant_all(), ex.approve(P.Replace{}))

# R2: typed bindings, protection and nonvacuous law witnesses.
def r2.empty() -> P.State:
  P.State{[], [], []}

def r2.bucket(protect: Bool) -> P.State:
  P.State{[], [], [P.Bucket{4n, 0n, protect}]}

def r2.bound(env: Nat, target: Nat) -> P.State:
  P.State{[], [P.Wk{0n, 0n, 0n, 0n, [P.BucketBind{0n, target}]}], [P.Bucket{4n, env, False{}}]}

def r2.binding_approved() -> {P.plan(r2.bound(0n, 4n), r2.empty(), ex.grant_all(), []) == P.Approved{[P.Op{P.Create{}, P.KBucket{}, 4n, 0n, []}, P.Op{P.Create{}, P.KWorker{}, 0n, 0n, []}]} : P.Outcome}:
  {==}

def r2.cross_env() -> {P.plan(r2.bound(1n, 4n), r2.empty(), ex.grant_all(), []) == P.Rejected{[P.CrossEnvBucket{0n, 0n, 4n}, P.OutOfGrant{P.Create{}, 4n, 1n}]} : P.Outcome}:
  {==}

def r2.missing() -> {P.plan(r2.bound(0n, 5n), r2.empty(), ex.grant_all(), []) == P.Rejected{[P.DanglingBucket{0n, 0n, 5n}]} : P.Outcome}:
  {==}

# A D1 at the same Nat is not a bucket target.
def r2.wrong_kind() -> {P.plan(P.State{[P.Db{4n, 0n, False{}, 0n, False{}}], [P.Wk{0n, 0n, 0n, 0n, [P.BucketBind{0n, 4n}]}], []}, r2.empty(), ex.grant_all(), []) == P.Rejected{[P.DanglingBucket{0n, 0n, 4n}]} : P.Outcome}:
  {==}

def r2.d1_wrong_kind() -> {P.plan(P.State{[], [P.Wk{0n, 0n, 0n, 0n, [P.Bind{0n, 4n}]}], [P.Bucket{4n, 0n, False{}}]}, r2.empty(), ex.grant_all(), []) == P.Rejected{[P.Dangling{0n, 0n, 4n}]} : P.Outcome}:
  {==}

# Duplicate binding names span both target kinds.
def r2.duplicate_name() -> {P.plan(P.State{[P.Db{3n, 0n, False{}, 0n, False{}}], [P.Wk{0n, 0n, 0n, 0n, [P.Bind{0n, 3n}, P.BucketBind{0n, 4n}]}], [P.Bucket{4n, 0n, False{}}]}, r2.empty(), ex.grant_all(), []) == P.Rejected{[P.DupBinding{0n, 0n}]} : P.Outcome}:
  {==}

def r2.duplicate_id() -> {P.plan(P.State{[P.Db{4n, 0n, False{}, 0n, False{}}], [], [P.Bucket{4n, 0n, False{}}]}, r2.empty(), ex.grant_all(), []) == P.Rejected{[P.DupId{4n}]} : P.Outcome}:
  {==}

def r2.kind_change() -> {P.plan(r2.bucket(False{}), P.State{[P.Db{4n, 0n, False{}, 0n, False{}}], [], []}, ex.grant_all(), []) == P.Rejected{[P.KindChange{4n}]} : P.Outcome}:
  {==}

def r2.binding_kind_equality() -> {P.eq_binds([P.Bind{0n, 4n}], [P.BucketBind{0n, 4n}]) == False{} : Bool}:
  {==}

def r2.mixed() -> P.State:
  P.State{[P.Db{3n, 0n, False{}, 0n, False{}}], [P.Wk{0n, 0n, 0n, 0n, [P.Bind{0n, 3n}, P.BucketBind{1n, 4n}]}], [P.Bucket{4n, 0n, False{}}]}

def r2.mixed_create() -> {P.plan(r2.mixed(), r2.empty(), ex.grant_all(), []) == P.Approved{[P.Op{P.Create{}, P.KDb{}, 3n, 0n, []}, P.Op{P.Create{}, P.KBucket{}, 4n, 0n, []}, P.Op{P.Create{}, P.KWorker{}, 0n, 0n, []}]} : P.Outcome}:
  {==}

def r2.mixed_delete() -> {P.plan(r2.empty(), r2.mixed(), ex.grant_all(), []) == P.Approved{[P.Op{P.Delete{}, P.KWorker{}, 0n, 0n, []}, P.Op{P.Delete{}, P.KDb{}, 3n, 0n, []}, P.Op{P.Delete{}, P.KBucket{}, 4n, 0n, []}]} : P.Outcome}:
  {==}

def r2.delete_ops() -> List<&2, P.Op>:
  [P.Op{P.Delete{}, P.KBucket{}, 4n, 0n, []}]

def r2.approvals() -> List<&2, P.Approval>:
  [P.Approval{P.Delete{}, 4n, 0n}]

def r2.delete_pending() -> {P.plan(r2.empty(), r2.bucket(True{}), ex.grant_delete(), []) == P.Pending{[P.NeedApproval{P.Delete{}, 4n, 0n}]} : P.Outcome}:
  {==}

def r2.delete_approved() -> {P.plan(r2.empty(), r2.bucket(True{}), ex.grant_delete(), r2.approvals()) == P.Approved{r2.delete_ops()} : P.Outcome}:
  {==}

def r2.protect_update() -> {P.plan(r2.bucket(True{}), r2.bucket(False{}), ex.grant_all(), []) == P.Approved{[P.Op{P.Update{}, P.KBucket{}, 4n, 0n, [P.FProtect{}]}]} : P.Outcome}:
  {==}

def r2.unprotect() -> {P.plan(r2.bucket(False{}), r2.bucket(True{}), ex.grant_all(), []) == P.Rejected{[P.Unprotect{4n}]} : P.Outcome}:
  {==}

def r2.law_env() -> Laws.AllInGrant(ex.grant_delete(), r2.empty(), r2.bucket(True{}), r2.delete_ops()):
  Laws.env_isolation(r2.empty(), r2.bucket(True{}), ex.grant_delete(), r2.approvals())

def r2.law_binding() -> Laws.BindingsValid(r2.bound(0n, 4n)):
  Laws.binding_validity(r2.bound(0n, 4n), r2.empty(), ex.grant_all(), [])

# Applying the universal protection law to the observed bucket witness
# yields an actual exact-action/id/environment approval witness.
def r2.witness(ok: Laws.AllDestroyOk(r2.empty(), r2.bucket(True{}), r2.approvals(), r2.delete_ops())) -> Laws.Approves(P.Delete{}, 4n, 0n, r2.approvals()):
  match ok:
    case (d, u):
      d(Inr{Inl{Inl{({==}, {==})}}})

def r2.approval_witness() -> Laws.Approves(P.Delete{}, 4n, 0n, r2.approvals()):
  r2.witness(Laws.protected_deletion(r2.empty(), r2.bucket(True{}), ex.grant_delete(), r2.approvals()))
