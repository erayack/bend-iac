# bend-infra planner: the desired-state model, the diff, and the gate.
#
# Every name, environment and property value reaches this file as a Nat:
# the TypeScript glue (src/codec.ts) validates the JSON inputs and interns
# each string into a small table, so the planner compares numbers only. A
# Nat here means "the k-th distinct string of that table"; only equality
# matters, never order or magnitude.
#
# plan(desired, observed, grant, approvals) is the only entry point. It
# returns Approved{ops} (an ordered, fully authorized plan, maybe empty),
# Pending{problems} (only approvals are missing) or Rejected{problems}.
# Only Approved carries operations: a blocked outcome has nothing to run.
# LAWS.bend states what an Approved outcome guarantees; PROOF.bend proves it.

import Base

# Model
# =====

# what an operation does to one resource
type Act is Data:
  Create{}
  Update{}
  Delete{}
  Replace{}

type RKind is Data:
  KDb{}
  KWorker{}
  KBucket{}

# why an update or replacement happens
type Field is Data:
  FLocation{}
  FReplication{}
  FProtect{}
  FMain{}
  FCompat{}
  FBindings{}
  FRebind{}

# A Worker binding retains its target kind, even when target Nats coincide.
type Bind is Data:
  Bind{name: Nat, db: Nat}
  BucketBind{name: Nat, bucket: Nat}

type Bucket is Data:
  Bucket{id: Nat, env: Nat, protect: Bool}

# a D1 database: location is immutable (a change replaces it); replicas
# (read replication) and protect are mutable
type Db is Data:
  Db{id: Nat, env: Nat, protect: Bool, location: Nat, replicas: Bool}

# a Worker: main (its entry module) and compat (its compatibility date)
# are mutable, binds are its typed D1 or R2 bindings
type Wk is Data:
  Wk{id: Nat, env: Nat, main: Nat, compat: Nat, binds: List<&2, Bind>}

# a graph of resources, desired or observed
type State is Data:
  State{dbs: List<&2, Db>, wks: List<&2, Wk>, buckets: List<&2, Bucket>}

# what the caller may do: one environment, and which kinds of action
type Grant is Data:
  Grant{env: Nat, create: Bool, update: Bool, delete: Bool}

# an explicit approval of one destructive action on one resource
type Approval is Data:
  Approval{act: Act, id: Nat, env: Nat}

# one step of a plan
type Op is Data:
  Op{act: Act, kind: RKind, id: Nat, env: Nat, why: List<&2, Field>}

type Problem is Data:
  DupId{id: Nat}
  DupObserved{id: Nat}
  DupBinding{wk: Nat, name: Nat}
  Dangling{wk: Nat, name: Nat, db: Nat}
  CrossEnv{wk: Nat, name: Nat, db: Nat}
  DanglingBucket{wk: Nat, name: Nat, db: Nat}
  CrossEnvBucket{wk: Nat, name: Nat, db: Nat}
  KindChange{id: Nat}
  EnvChange{id: Nat}
  Unprotect{id: Nat}
  OutOfGrant{act: Act, id: Nat, env: Nat}
  NeedApproval{act: Act, id: Nat, env: Nat}
  UnusedApproval{act: Act, id: Nat, env: Nat}

type Outcome is Data:
  Approved{ops: List<&2, Op>}
  Pending{problems: List<&2, Problem>}
  Rejected{problems: List<&2, Problem>}

# Basics
# ======

def eqn(a: Nat, b: Nat) -> Bool:
  match a b:
    case 0n 0n:
      True{}
    case 0n 1n+q:
      False{}
    case 1n+p 0n:
      False{}
    case 1n+p 1n+q:
      eqn(p, q)

def eqb(a: Bool, b: Bool) -> Bool:
  match a b:
    case True{} True{}:
      True{}
    case False{} False{}:
      True{}
    case True{} False{}:
      False{}
    case False{} True{}:
      False{}

def eqa(a: Act, b: Act) -> Bool:
  match a b:
    case Create{} Create{}:
      True{}
    case Update{} Update{}:
      True{}
    case Delete{} Delete{}:
      True{}
    case Replace{} Replace{}:
      True{}
    case x y:
      False{}

def mem(+x: Nat, xs: List<&2, Nat>) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{h, t}:
      Bool.or(eqn(x, h), mem(x, t))

# x in front of rest, unless skip
def skip_if(-A: Data, skip: Bool, x: A, rest: List<&2, A>) -> List<&2, A>:
  match skip:
    case True{}:
      rest
    case False{}:
      Con{x, rest}

# a gate step: keeps going when ok, else records problem p
def keep(ok: Bool, p: Problem, rest: List<&2, Problem>) -> List<&2, Problem>:
  match ok:
    case True{}:
      rest
    case False{}:
      Con{p, rest}

# Lookup
# ======

def db_ids(dbs: List<&2, Db>) -> List<&2, Nat>:
  match dbs:
    case Nil{}:
      Nil{}
    case Con{Db{id, env, protect, location, replicas}, t}:
      Con{id, db_ids(t)}

def wk_ids(wks: List<&2, Wk>) -> List<&2, Nat>:
  match wks:
    case Nil{}:
      Nil{}
    case Con{Wk{id, env, main, compat, binds}, t}:
      Con{id, wk_ids(t)}

def bucket_ids(buckets: List<&2, Bucket>) -> List<&2, Nat>:
  match buckets:
    case Nil{}:
      Nil{}
    case Con{Bucket{id, env, protect}, t}:
      Con{id, bucket_ids(t)}

def ids(s: State) -> List<&2, Nat>:
  match s:
    case State{dbs, wks, buckets}:
      List.append(&2, Nat, db_ids(dbs), List.append(&2, Nat, wk_ids(wks), bucket_ids(buckets)))

def find_db.pick(+id: Nat, +d: Db, rest: Maybe<&2, Db>) -> Maybe<&2, Db>:
  match d:
    case Db{did, env, protect, location, replicas}:
      Bool.pick(Maybe<&2, Db>, eqn(id, did), Some{d}, rest)

def find_db(+id: Nat, dbs: List<&2, Db>) -> Maybe<&2, Db>:
  match dbs:
    case Nil{}:
      None{}
    case Con{+d, t}:
      find_db.pick(id, d, find_db(id, t))

def find_wk.pick(+id: Nat, +w: Wk, rest: Maybe<&2, Wk>) -> Maybe<&2, Wk>:
  match w:
    case Wk{wid, env, main, compat, binds}:
      Bool.pick(Maybe<&2, Wk>, eqn(id, wid), Some{w}, rest)

def find_wk(+id: Nat, wks: List<&2, Wk>) -> Maybe<&2, Wk>:
  match wks:
    case Nil{}:
      None{}
    case Con{+w, t}:
      find_wk.pick(id, w, find_wk(id, t))

# is there a database with this id in this environment?
def db_at(+id: Nat, +env: Nat, dbs: List<&2, Db>) -> Bool:
  match dbs:
    case Nil{}:
      False{}
    case Con{Db{did, denv, protect, location, replicas}, t}:
      Bool.or(Bool.and(eqn(did, id), eqn(denv, env)), db_at(id, env, t))

# is any database with this id protected, in any environment?
def protected(+id: Nat, dbs: List<&2, Db>) -> Bool:
  match dbs:
    case Nil{}:
      False{}
    case Con{Db{did, denv, protect, location, replicas}, t}:
      Bool.or(Bool.and(eqn(did, id), protect), protected(id, t))

def find_bucket.pick(+id: Nat, +d: Bucket, rest: Maybe<&2, Bucket>) -> Maybe<&2, Bucket>:
  match d:
    case Bucket{did, env, protect}:
      Bool.pick(Maybe<&2, Bucket>, eqn(id, did), Some{d}, rest)

def find_bucket(+id: Nat, buckets: List<&2, Bucket>) -> Maybe<&2, Bucket>:
  match buckets:
    case Nil{}:
      None{}
    case Con{+d, t}:
      find_bucket.pick(id, d, find_bucket(id, t))

def bucket_at(+id: Nat, +env: Nat, buckets: List<&2, Bucket>) -> Bool:
  match buckets:
    case Nil{}:
      False{}
    case Con{Bucket{did, denv, protect}, t}:
      Bool.or(Bool.and(eqn(did, id), eqn(denv, env)), bucket_at(id, env, t))

def bucket_protected(+id: Nat, buckets: List<&2, Bucket>) -> Bool:
  match buckets:
    case Nil{}:
      False{}
    case Con{Bucket{did, denv, protect}, t}:
      Bool.or(Bool.and(eqn(did, id), protect), bucket_protected(id, t))

# Validation
# ==========

# Bindings name a desired provider of the correct kind and environment.
def bind_err(wk: Nat, name: Nat, db: Nat, exists: Bool) -> Problem:
  match exists:
    case True{}:
      CrossEnv{wk, name, db}
    case False{}:
      Dangling{wk, name, db}

def bucket_bind_err(wk: Nat, name: Nat, db: Nat, exists: Bool) -> Problem:
  match exists:
    case True{}:
      CrossEnvBucket{wk, name, db}
    case False{}:
      DanglingBucket{wk, name, db}

def binds_problems(+wk: Nat, +env: Nat, binds: List<&2, Bind>, +dbs: List<&2, Db>, +buckets: List<&2, Bucket>) -> List<&2, Problem>:
  match binds:
    case Nil{}:
      Nil{}
    case Con{Bind{+name, +db}, t}:
      keep(db_at(db, env, dbs), bind_err(wk, name, db, mem(db, db_ids(dbs))), binds_problems(wk, env, t, dbs, buckets))
    case Con{BucketBind{+name, +bucket}, t}:
      keep(bucket_at(bucket, env, buckets), bucket_bind_err(wk, name, bucket, mem(bucket, bucket_ids(buckets))), binds_problems(wk, env, t, dbs, buckets))

def wks_problems(wks: List<&2, Wk>, +dbs: List<&2, Db>, +buckets: List<&2, Bucket>) -> List<&2, Problem>:
  match wks:
    case Nil{}:
      Nil{}
    case Con{Wk{id, env, main, compat, binds}, t}:
      List.append(&2, Problem, binds_problems(id, env, binds, dbs, buckets), wks_problems(t, dbs, buckets))

def binding_problems(s: State) -> List<&2, Problem>:
  match s:
    case State{dbs, wks, buckets}:
      wks_problems(wks, dbs, buckets)

# Duplicate ids: a logical id names one resource, across all three kinds.
def dup_problem(observed: Bool, id: Nat) -> Problem:
  match observed:
    case True{}:
      DupObserved{id}
    case False{}:
      DupId{id}

def dups(+observed: Bool, xs: List<&2, Nat>) -> List<&2, Problem>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{+h, +t}:
      keep(Bool.not(mem(h, t)), dup_problem(observed, h), dups(observed, t))

def bind_names(binds: List<&2, Bind>) -> List<&2, Nat>:
  match binds:
    case Nil{}:
      Nil{}
    case Con{Bind{name, db}, t}:
      Con{name, bind_names(t)}
    case Con{BucketBind{name, bucket}, t}:
      Con{name, bind_names(t)}

def dup_names(+wk: Nat, names: List<&2, Nat>) -> List<&2, Problem>:
  match names:
    case Nil{}:
      Nil{}
    case Con{+h, +t}:
      keep(Bool.not(mem(h, t)), DupBinding{wk, h}, dup_names(wk, t))

def wks_dup_names(wks: List<&2, Wk>) -> List<&2, Problem>:
  match wks:
    case Nil{}:
      Nil{}
    case Con{Wk{id, env, main, compat, binds}, t}:
      List.append(&2, Problem, dup_names(id, bind_names(binds)), wks_dup_names(t))

# Identity: an id keeps its kind and environment, and a protected provider
# stays protected (removing protection would let a later plan delete it
# without approval).
def db_vs(+id: Nat, +env: Nat, protect: Bool, m: Maybe<&2, Db>) -> List<&2, Problem>:
  match m:
    case None{}:
      Nil{}
    case Some{Db{oid, oenv, oprotect, olocation, oreplicas}}:
      keep(eqn(env, oenv), EnvChange{id}, keep(Bool.or(protect, Bool.not(oprotect)), Unprotect{id}, Nil{}))

def wk_vs(+id: Nat, +env: Nat, m: Maybe<&2, Wk>) -> List<&2, Problem>:
  match m:
    case None{}:
      Nil{}
    case Some{Wk{oid, oenv, omain, ocompat, obinds}}:
      keep(eqn(env, oenv), EnvChange{id}, Nil{})

def dbs_identity.go(+id: Nat, +env: Nat, protect: Bool, +obs: State, rest: List<&2, Problem>) -> List<&2, Problem>:
  match obs:
    case State{odbs, owks, obuckets}:
      keep(Bool.not(Bool.or(mem(id, wk_ids(owks)), mem(id, bucket_ids(obuckets)))), KindChange{id}, List.append(&2, Problem, db_vs(id, env, protect, find_db(id, odbs)), rest))

def dbs_identity(dbs: List<&2, Db>, +obs: State) -> List<&2, Problem>:
  match dbs:
    case Nil{}:
      Nil{}
    case Con{Db{+id, +env, protect, location, replicas}, t}:
      dbs_identity.go(id, env, protect, obs, dbs_identity(t, obs))

def wks_identity.go(+id: Nat, +env: Nat, +obs: State, rest: List<&2, Problem>) -> List<&2, Problem>:
  match obs:
    case State{odbs, owks, obuckets}:
      keep(Bool.not(Bool.or(mem(id, db_ids(odbs)), mem(id, bucket_ids(obuckets)))), KindChange{id}, List.append(&2, Problem, wk_vs(id, env, find_wk(id, owks)), rest))

def wks_identity(wks: List<&2, Wk>, +obs: State) -> List<&2, Problem>:
  match wks:
    case Nil{}:
      Nil{}
    case Con{Wk{+id, +env, main, compat, binds}, t}:
      wks_identity.go(id, env, obs, wks_identity(t, obs))

def bucket_vs(+id: Nat, +env: Nat, protect: Bool, m: Maybe<&2, Bucket>) -> List<&2, Problem>:
  match m:
    case None{}:
      Nil{}
    case Some{Bucket{oid, oenv, oprotect}}:
      keep(eqn(env, oenv), EnvChange{id}, keep(Bool.or(protect, Bool.not(oprotect)), Unprotect{id}, Nil{}))

def buckets_identity.go(+id: Nat, +env: Nat, protect: Bool, +obs: State, rest: List<&2, Problem>) -> List<&2, Problem>:
  match obs:
    case State{odbs, owks, obuckets}:
      keep(Bool.not(Bool.or(mem(id, db_ids(odbs)), mem(id, wk_ids(owks)))), KindChange{id}, List.append(&2, Problem, bucket_vs(id, env, protect, find_bucket(id, obuckets)), rest))

def buckets_identity(buckets: List<&2, Bucket>, +obs: State) -> List<&2, Problem>:
  match buckets:
    case Nil{}:
      Nil{}
    case Con{Bucket{+id, +env, protect}, t}:
      buckets_identity.go(id, env, protect, obs, buckets_identity(t, obs))

def identity_problems(+des: State, +obs: State) -> List<&2, Problem>:
  match des:
    case State{dbs, wks, buckets}:
      List.append(&2, Problem, dbs_identity(dbs, obs), List.append(&2, Problem, wks_identity(wks, obs), buckets_identity(buckets, obs)))

def other_problems(+des: State, +obs: State) -> List<&2, Problem>:
  match des:
    case State{+dbs, +wks, +buckets}:
      List.append(&2, Problem, dups(False{}, ids(des)), List.append(&2, Problem, dups(True{}, ids(obs)), List.append(&2, Problem, wks_dup_names(wks), identity_problems(des, obs))))

# binding problems come first: binding_validity reads them off the front
def validate(+des: State, +obs: State) -> List<&2, Problem>:
  List.append(&2, Problem, binding_problems(des), other_problems(des, obs))

# Diff
# ====
# Phases, in order, so dependencies hold at every step:
#   1. delete Workers that left the desired graph (consumers go first)
#   2. create, update or replace databases (providers before consumers)
#   3. create or update buckets (protection updates are local metadata)
#   4. create or update Workers (providers precede consumers;
#      a Worker bound to a replaced database is updated to rebind it)
#   5. delete departed databases
#   6. delete departed buckets (validation requires desired binding targets)

def put(b: Bool, f: Field, fs: List<&2, Field>) -> List<&2, Field>:
  match b:
    case True{}:
      Con{f, fs}
    case False{}:
      fs

# one op, or none when nothing changed
def op_if(act: Act, kind: RKind, id: Nat, env: Nat, why: List<&2, Field>) -> List<&2, Op>:
  match why:
    case Nil{}:
      Nil{}
    case Con{f, fs}:
      [Op{act, kind, id, env, Con{f, fs}}]

def db_change.go(same_location: Bool, id: Nat, env: Nat, why: List<&2, Field>) -> List<&2, Op>:
  match same_location:
    case True{}:
      op_if(Update{}, KDb{}, id, env, why)
    case False{}:
      [Op{Replace{}, KDb{}, id, env, Con{FLocation{}, why}}]

def db_change(+d: Db, m: Maybe<&2, Db>) -> List<&2, Op>:
  match d m:
    case Db{id, env, protect, location, replicas} None{}:
      [Op{Create{}, KDb{}, id, env, Nil{}}]
    case Db{id, env, +protect, +location, +replicas} Some{Db{oid, oenv, +oprotect, +olocation, +oreplicas}}:
      db_change.go(eqn(location, olocation), id, env, put(Bool.not(eqb(replicas, oreplicas)), FReplication{}, put(Bool.not(eqb(protect, oprotect)), FProtect{}, Nil{})))

def Db.id(d: Db) -> Nat:
  match d:
    case Db{id, env, protect, location, replicas}:
      id

def db_changes(dbs: List<&2, Db>, +odbs: List<&2, Db>) -> List<&2, Op>:
  match dbs:
    case Nil{}:
      Nil{}
    case Con{+d, t}:
      List.append(&2, Op, db_change(d, find_db(Db.id(d), odbs)), db_changes(t, odbs))

# ids of the databases this plan replaces
def replaced.go(d: Db, m: Maybe<&2, Db>, rest: List<&2, Nat>) -> List<&2, Nat>:
  match d m:
    case Db{id, env, protect, location, replicas} None{}:
      rest
    case Db{id, env, protect, location, replicas} Some{Db{oid, oenv, oprotect, olocation, oreplicas}}:
      skip_if(Nat, eqn(location, olocation), id, rest)

def replaced(dbs: List<&2, Db>, +odbs: List<&2, Db>) -> List<&2, Nat>:
  match dbs:
    case Nil{}:
      Nil{}
    case Con{+d, t}:
      replaced.go(d, find_db(Db.id(d), odbs), replaced(t, odbs))

def eq_binds(xs: List<&2, Bind>, ys: List<&2, Bind>) -> Bool:
  match xs ys:
    case Nil{} Nil{}:
      True{}
    case Con{Bind{n, d}, xt} Con{Bind{m, e}, yt}:
      Bool.and(Bool.and(eqn(n, m), eqn(d, e)), eq_binds(xt, yt))
    case Con{BucketBind{n, d}, xt} Con{BucketBind{m, e}, yt}:
      Bool.and(Bool.and(eqn(n, m), eqn(d, e)), eq_binds(xt, yt))
    case xs ys:
      False{}

def binds_any(binds: List<&2, Bind>, +rs: List<&2, Nat>) -> Bool:
  match binds:
    case Nil{}:
      False{}
    case Con{Bind{name, db}, t}:
      Bool.or(mem(db, rs), binds_any(t, rs))
    case Con{BucketBind{name, bucket}, t}:
      binds_any(t, rs)

def wk_change(+w: Wk, m: Maybe<&2, Wk>, +rs: List<&2, Nat>) -> List<&2, Op>:
  match w m:
    case Wk{id, env, main, compat, binds} None{}:
      [Op{Create{}, KWorker{}, id, env, Nil{}}]
    case Wk{id, env, main, compat, +binds} Some{Wk{oid, oenv, omain, ocompat, obinds}}:
      op_if(Update{}, KWorker{}, id, env, put(Bool.not(eqn(main, omain)), FMain{}, put(Bool.not(eqn(compat, ocompat)), FCompat{}, put(Bool.not(eq_binds(binds, obinds)), FBindings{}, put(binds_any(binds, rs), FRebind{}, Nil{})))))

def Wk.id(w: Wk) -> Nat:
  match w:
    case Wk{id, env, main, compat, binds}:
      id

def wk_changes(wks: List<&2, Wk>, +owks: List<&2, Wk>, +rs: List<&2, Nat>) -> List<&2, Op>:
  match wks:
    case Nil{}:
      Nil{}
    case Con{+w, t}:
      List.append(&2, Op, wk_change(w, find_wk(Wk.id(w), owks), rs), wk_changes(t, owks, rs))

# observed resources whose id the desired graph no longer has
def db_deletes(odbs: List<&2, Db>, +keep_ids: List<&2, Nat>) -> List<&2, Op>:
  match odbs:
    case Nil{}:
      Nil{}
    case Con{Db{+id, env, protect, location, replicas}, t}:
      skip_if(Op, mem(id, keep_ids), Op{Delete{}, KDb{}, id, env, Nil{}}, db_deletes(t, keep_ids))

def wk_deletes(owks: List<&2, Wk>, +keep_ids: List<&2, Nat>) -> List<&2, Op>:
  match owks:
    case Nil{}:
      Nil{}
    case Con{Wk{+id, env, main, compat, binds}, t}:
      skip_if(Op, mem(id, keep_ids), Op{Delete{}, KWorker{}, id, env, Nil{}}, wk_deletes(t, keep_ids))

def bucket_change(b: Bucket, m: Maybe<&2, Bucket>) -> List<&2, Op>:
  match b m:
    case Bucket{id, env, protect} None{}:
      [Op{Create{}, KBucket{}, id, env, Nil{}}]
    case Bucket{id, env, protect} Some{Bucket{oid, oenv, oprotect}}:
      op_if(Update{}, KBucket{}, id, env, put(Bool.not(eqb(protect, oprotect)), FProtect{}, Nil{}))

def Bucket.id(b: Bucket) -> Nat:
  match b:
    case Bucket{id, env, protect}:
      id

def bucket_changes(buckets: List<&2, Bucket>, +obuckets: List<&2, Bucket>) -> List<&2, Op>:
  match buckets:
    case Nil{}:
      Nil{}
    case Con{+b, t}:
      List.append(&2, Op, bucket_change(b, find_bucket(Bucket.id(b), obuckets)), bucket_changes(t, obuckets))

def bucket_deletes(obuckets: List<&2, Bucket>, +keep_ids: List<&2, Nat>) -> List<&2, Op>:
  match obuckets:
    case Nil{}:
      Nil{}
    case Con{Bucket{+id, env, protect}, t}:
      skip_if(Op, mem(id, keep_ids), Op{Delete{}, KBucket{}, id, env, Nil{}}, bucket_deletes(t, keep_ids))

def diff(+des: State, +obs: State) -> List<&2, Op>:
  match des obs:
    case State{+dbs, +wks, +buckets} State{+odbs, +owks, +obuckets}:
      List.append(&2, Op, wk_deletes(owks, ids(des)), List.append(&2, Op, db_changes(dbs, odbs), List.append(&2, Op, bucket_changes(buckets, obuckets), List.append(&2, Op, wk_changes(wks, owks, replaced(dbs, odbs)), List.append(&2, Op, db_deletes(odbs, ids(des)), bucket_deletes(obuckets, ids(des)))))))

# Gate
# ====

# Grant: every op stays in the granted environment, with a granted action.
# A replacement both deletes and creates, so it needs both.
def permits(+g: Grant, act: Act) -> Bool:
  match g act:
    case Grant{env, c, u, d} Create{}:
      c
    case Grant{env, c, u, d} Update{}:
      u
    case Grant{env, c, u, d} Delete{}:
      d
    case Grant{env, c, u, d} Replace{}:
      Bool.and(c, d)

# every resource with this id, in these lists, lives in env
def dbs_in(+id: Nat, +env: Nat, dbs: List<&2, Db>) -> Bool:
  match dbs:
    case Nil{}:
      True{}
    case Con{Db{did, denv, protect, location, replicas}, t}:
      Bool.and(Bool.or(Bool.not(eqn(did, id)), eqn(denv, env)), dbs_in(id, env, t))

def wks_in(+id: Nat, +env: Nat, wks: List<&2, Wk>) -> Bool:
  match wks:
    case Nil{}:
      True{}
    case Con{Wk{wid, wenv, main, compat, binds}, t}:
      Bool.and(Bool.or(Bool.not(eqn(wid, id)), eqn(wenv, env)), wks_in(id, env, t))

def buckets_in(+id: Nat, +env: Nat, buckets: List<&2, Bucket>) -> Bool:
  match buckets:
    case Nil{}:
      True{}
    case Con{Bucket{did, denv, protect}, t}:
      Bool.and(Bool.or(Bool.not(eqn(did, id)), eqn(denv, env)), buckets_in(id, env, t))

def resident(+id: Nat, +env: Nat, s: State) -> Bool:
  match s:
    case State{dbs, wks, buckets}:
      Bool.and(Bool.and(dbs_in(id, env, dbs), wks_in(id, env, wks)), buckets_in(id, env, buckets))

# the op is labelled with the granted environment, its action is granted,
# and every declaration and observation of its id lives in that
# environment, so the label cannot misstate what the op touches
def granted(+g: Grant, +des: State, +obs: State, +op: Op) -> Bool:
  match g op:
    case Grant{+genv, c, u, d} Op{+act, kind, +id, +env, why}:
      Bool.and(eqn(env, genv), Bool.and(permits(g, act), Bool.and(resident(id, genv, des), resident(id, genv, obs))))

def out_of_grant(op: Op) -> Problem:
  match op:
    case Op{act, kind, id, env, why}:
      OutOfGrant{act, id, env}

def grant_problems(+g: Grant, +des: State, +obs: State, ops: List<&2, Op>) -> List<&2, Problem>:
  match ops:
    case Nil{}:
      Nil{}
    case Con{+op, t}:
      keep(granted(g, des, obs, op), out_of_grant(op), grant_problems(g, des, obs, t))

# Approvals: a destructive op (delete or replace) on an id that a protected
# database or bucket holds, in either snapshot, needs an approval
# naming that exact action, id and environment.
def approved(+act: Act, +id: Nat, +env: Nat, apps: List<&2, Approval>) -> Bool:
  match apps:
    case Nil{}:
      False{}
    case Con{Approval{aact, aid, aenv}, t}:
      Bool.or(Bool.and(eqa(aact, act), Bool.and(eqn(aid, id), eqn(aenv, env))), approved(act, id, env, t))

def is_protected(+id: Nat, +des: State, +obs: State) -> Bool:
  match des obs:
    case State{dbs, wks, buckets} State{odbs, owks, obuckets}:
      Bool.or(Bool.or(protected(id, odbs), protected(id, dbs)), Bool.or(bucket_protected(id, obuckets), bucket_protected(id, buckets)))

# true when the op needs no approval, or has one
def cleared(+act: Act, +id: Nat, +env: Nat, +apps: List<&2, Approval>, +des: State, +obs: State) -> Bool:
  match act:
    case Create{}:
      True{}
    case Update{}:
      True{}
    case Delete{}:
      Bool.or(Bool.not(is_protected(id, des, obs)), approved(Delete{}, id, env, apps))
    case Replace{}:
      Bool.or(Bool.not(is_protected(id, des, obs)), approved(Replace{}, id, env, apps))

def op_cleared(+apps: List<&2, Approval>, +des: State, +obs: State, op: Op) -> Bool:
  match op:
    case Op{act, kind, id, env, why}:
      cleared(act, id, env, apps, des, obs)

def need_approval(op: Op) -> Problem:
  match op:
    case Op{act, kind, id, env, why}:
      NeedApproval{act, id, env}

def approval_problems(+apps: List<&2, Approval>, +des: State, +obs: State, ops: List<&2, Op>) -> List<&2, Problem>:
  match ops:
    case Nil{}:
      Nil{}
    case Con{+op, t}:
      keep(op_cleared(apps, des, obs, op), need_approval(op), approval_problems(apps, des, obs, t))

# An approval must match an op of this plan: a stale or misdirected
# approval is refused rather than silently ignored.
def used(+act: Act, +id: Nat, +env: Nat, ops: List<&2, Op>) -> Bool:
  match ops:
    case Nil{}:
      False{}
    case Con{Op{oact, kind, oid, oenv, why}, t}:
      Bool.or(Bool.and(eqa(oact, act), Bool.and(eqn(oid, id), eqn(oenv, env))), used(act, id, env, t))

def unused_problems(apps: List<&2, Approval>, +ops: List<&2, Op>) -> List<&2, Problem>:
  match apps:
    case Nil{}:
      Nil{}
    case Con{Approval{+act, +id, +env}, t}:
      keep(used(act, id, env, ops), UnusedApproval{act, id, env}, unused_problems(t, ops))

# Outcome
# =======

def is_pending(p: Problem) -> Bool:
  match p:
    case NeedApproval{act, id, env}:
      True{}
    case p:
      False{}

def all_pending(ps: List<&2, Problem>) -> Bool:
  match ps:
    case Nil{}:
      True{}
    case Con{p, t}:
      Bool.and(is_pending(p), all_pending(t))

def classify(pending: Bool, ps: List<&2, Problem>) -> Outcome:
  match pending:
    case True{}:
      Pending{ps}
    case False{}:
      Rejected{ps}

# Approved only when no stage found a problem
def finish(ps: List<&2, Problem>, ops: List<&2, Op>) -> Outcome:
  match ps:
    case Nil{}:
      Approved{ops}
    case Con{+p, +t}:
      classify(all_pending(Con{p, t}), Con{p, t})

# The gate's stages, in report order: validation, grant, stale approvals,
# missing approvals. All four must be empty for the plan to be Approved.
def plan(+des: State, +obs: State, +g: Grant, +apps: List<&2, Approval>) -> Outcome:
  +ops = diff(des, obs)
  finish(List.append(&2, Problem, validate(des, obs), List.append(&2, Problem, grant_problems(g, des, obs, ops), List.append(&2, Problem, unused_problems(apps, ops), approval_problems(apps, des, obs, ops)))), ops)
