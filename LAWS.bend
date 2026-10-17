# bend-infra: the laws. Each states what an Approved outcome of the real
# planner entry point, P.plan, guarantees for EVERY input: any desired
# graph, any observed snapshot, any grant and any list of approvals.
# Blocked outcomes (Pending, Rejected) carry no operations, so each law
# holds of them trivially. The predicates below are written against the
# model's constructors and Base equality only; they reuse no function of
# the planner, so a law cannot be closed by echoing the implementation.
# PROOF.bend proves them; `npm run check:proofs` checks it, also with
# Bend's --verdict kernel.

import Base
import ./core/planner.bend as P

# Shared
# ------

# the claim F holds of the operations, when the outcome is Approved
def IfApproved(out: P.Outcome, F: List<&2, P.Op> -> Type) -> Type:
  match out:
    case P.Approved{ops}:
      F(ops)
    case P.Pending{ps}:
      Unit
    case P.Rejected{ps}:
      Unit

# Environment isolation
# ---------------------

# the grant permits the action: a replacement deletes and creates
def Permits(g: P.Grant, act: P.Act) -> Type:
  match g act:
    case P.Grant{env, c, u, d} P.Create{}:
      {c == True{} : Bool}
    case P.Grant{env, c, u, d} P.Update{}:
      {u == True{} : Bool}
    case P.Grant{env, c, u, d} P.Delete{}:
      {d == True{} : Bool}
    case P.Grant{env, c, u, d} P.Replace{}:
      ({c == True{} : Bool} & {d == True{} : Bool})

# every desired or observed resource with this id lives in env
def DbsIn(id: Nat, env: Nat, dbs: List<&2, P.Db>) -> Type:
  match dbs:
    case Nil{}:
      Unit
    case Con{P.Db{did, denv, protect, location, replicas}, t}:
      (({did == id : Nat} -> {denv == env : Nat}) & DbsIn(id, env, t))

def WksIn(id: Nat, env: Nat, wks: List<&2, P.Wk>) -> Type:
  match wks:
    case Nil{}:
      Unit
    case Con{P.Wk{wid, wenv, main, compat, binds}, t}:
      (({wid == id : Nat} -> {wenv == env : Nat}) & WksIn(id, env, t))

def BucketsIn(id: Nat, env: Nat, buckets: List<&2, P.Bucket>) -> Type:
  match buckets:
    case Nil{}:
      Unit
    case Con{P.Bucket{did, denv, protect}, t}:
      (({did == id : Nat} -> {denv == env : Nat}) & BucketsIn(id, env, t))

def Resident(id: Nat, env: Nat, s: P.State) -> Type:
  match s:
    case P.State{dbs, wks, buckets}:
      ((DbsIn(id, env, dbs) & WksIn(id, env, wks)) & BucketsIn(id, env, buckets))

# the op is labelled with the grant's environment, its action is
# permitted, and the resource it touches lives only in that environment,
# in the desired graph and in the observed snapshot
def InGrant(g: P.Grant, des: P.State, obs: P.State, op: P.Op) -> Type:
  match g op:
    case P.Grant{genv, c, u, d} P.Op{act, kind, id, env, why}:
      ({env == genv : Nat} & (Permits(P.Grant{genv, c, u, d}, act) & (Resident(id, genv, des) & Resident(id, genv, obs))))

def AllInGrant(g: P.Grant, des: P.State, obs: P.State, ops: List<&2, P.Op>) -> Type:
  match ops:
    case Nil{}:
      Unit
    case Con{op, t}:
      (InGrant(g, des, obs, op) & AllInGrant(g, des, obs, t))

# LAW: every operation of an approved plan lies within the supplied
# environment grant: it is labelled with the grant's environment, its
# action is one the grant permits, and every resource with its id, desired
# or observed, lives in that environment
law env_isolation:
  for +des: P.State
  for +obs: P.State
  for +g: P.Grant
  for +apps: List<&2, P.Approval>
  IfApproved(P.plan(des, obs, g, apps), ops => AllInGrant(g, des, obs, ops))

# Binding validity
# ----------------

# some database of dbs has this id and this environment
def DbAt(id: Nat, env: Nat, dbs: List<&2, P.Db>) -> Type:
  match dbs:
    case Nil{}:
      Empty
    case Con{P.Db{did, denv, protect, location, replicas}, t}:
      Or(({did == id : Nat} & {denv == env : Nat}), DbAt(id, env, t))

def BucketAt(id: Nat, env: Nat, buckets: List<&2, P.Bucket>) -> Type:
  match buckets:
    case Nil{}:
      Empty
    case Con{P.Bucket{did, denv, protect}, t}:
      Or(({did == id : Nat} & {denv == env : Nat}), BucketAt(id, env, t))

def BindsAt(env: Nat, binds: List<&2, P.Bind>, dbs: List<&2, P.Db>, buckets: List<&2, P.Bucket>) -> Type:
  match binds:
    case Nil{}:
      Unit
    case Con{P.Bind{name, db}, t}:
      (DbAt(db, env, dbs) & BindsAt(env, t, dbs, buckets))
    case Con{P.BucketBind{name, bucket}, t}:
      (BucketAt(bucket, env, buckets) & BindsAt(env, t, dbs, buckets))

def WorkersBound(wks: List<&2, P.Wk>, dbs: List<&2, P.Db>, buckets: List<&2, P.Bucket>) -> Type:
  match wks:
    case Nil{}:
      Unit
    case Con{P.Wk{id, env, main, compat, binds}, t}:
      (BindsAt(env, binds, dbs, buckets) & WorkersBound(t, dbs, buckets))

def BindingsValid(des: P.State) -> Type:
  match des:
    case P.State{dbs, wks, buckets}:
      WorkersBound(wks, dbs, buckets)

# LAW: when a plan is approved, every binding of every desired Worker
# names a desired database or bucket of the correct target kind, in that
# Worker's own environment
law binding_validity:
  for +des: P.State
  for +obs: P.State
  for +g: P.Grant
  for +apps: List<&2, P.Approval>
  IfApproved(P.plan(des, obs, g, apps), ops => BindingsValid(des))

# Protected deletion
# ------------------

# some database of dbs with this id is protected (in any environment)
def ProtectedIn(id: Nat, dbs: List<&2, P.Db>) -> Type:
  match dbs:
    case Nil{}:
      Empty
    case Con{P.Db{did, denv, protect, location, replicas}, t}:
      Or(({did == id : Nat} & {protect == True{} : Bool}), ProtectedIn(id, t))

# some bucket with this id is protected (in any environment)
def BucketProtectedIn(id: Nat, buckets: List<&2, P.Bucket>) -> Type:
  match buckets:
    case Nil{}:
      Empty
    case Con{P.Bucket{did, denv, protect}, t}:
      Or(({did == id : Nat} & {protect == True{} : Bool}), BucketProtectedIn(id, t))

# the id is protected in either snapshot, by either provider kind
def Protected(id: Nat, des: P.State, obs: P.State) -> Type:
  match des obs:
    case P.State{dbs, wks, buckets} P.State{odbs, owks, obuckets}:
      Or(Or(ProtectedIn(id, odbs), ProtectedIn(id, dbs)), Or(BucketProtectedIn(id, obuckets), BucketProtectedIn(id, buckets)))

# some approval names exactly this action, id and environment
def Approves(act: P.Act, id: Nat, env: Nat, apps: List<&2, P.Approval>) -> Type:
  match apps:
    case Nil{}:
      Empty
    case Con{P.Approval{aact, aid, aenv}, t}:
      Or(({aact == act : P.Act} & ({aid == id : Nat} & {aenv == env : Nat})), Approves(act, id, env, t))

# a destructive op (delete, or replace, which destroys the old resource)
# on a protected id carries a matching approval
def DestroyOk(des: P.State, obs: P.State, apps: List<&2, P.Approval>, op: P.Op) -> Type:
  match op:
    case P.Op{P.Create{}, kind, id, env, why}:
      Unit
    case P.Op{P.Update{}, kind, id, env, why}:
      Unit
    case P.Op{P.Delete{}, kind, id, env, why}:
      Protected(id, des, obs) -> Approves(P.Delete{}, id, env, apps)
    case P.Op{P.Replace{}, kind, id, env, why}:
      Protected(id, des, obs) -> Approves(P.Replace{}, id, env, apps)

def AllDestroyOk(des: P.State, obs: P.State, apps: List<&2, P.Approval>, ops: List<&2, P.Op>) -> Type:
  match ops:
    case Nil{}:
      Unit
    case Con{op, t}:
      (DestroyOk(des, obs, apps, op) & AllDestroyOk(des, obs, apps, t))

# LAW: every destructive operation of an approved plan, on an id that a
# protected database or bucket holds (observed or desired), carries an explicit
# approval of that exact action, id and environment
law protected_deletion:
  for +des: P.State
  for +obs: P.State
  for +g: P.Grant
  for +apps: List<&2, P.Approval>
  IfApproved(P.plan(des, obs, g, apps), ops => AllDestroyOk(des, obs, apps, ops))
