# bend-infra: the proofs of LAWS.bend. Each law unfolds P.plan to
# P.finish over the gate's four problem lists: an Approved outcome means
# every list was empty (finish.ok). An empty list is then read back, by
# induction over the operations (or Workers, bindings, approvals), as the
# law's predicate: each gate step is a P.keep whose Nil means its Bool
# check said True (keep.ok/keep.rest), and each Bool check is shown sound against
# the law's own predicate. Lemma names carry the law they serve: env.*,
# bind.*, prot.*; shared ones are plain.

import Base
import ./core/planner.bend as P
import ./LAWS.bend as Laws

# Logic
# =====

# the clash True/False refutes, through a motive that sends True to Empty
def NotTrue(b: Bool) -> Type:
  match b:
    case False{}:
      Unit
    case True{}:
      Empty

def false_ne_true(e: {False{} == True{} : Bool}) -> Empty:
  %e : NotTrue(_)
  Unit{}

def and_l(a: Bool, -b: Bool, e: {Bool.and(a, b) == True{} : Bool}) -> {a == True{} : Bool}:
  match a:
    case True{}:
      {==}
    case False{}:
      e

def and_r(a: Bool, -b: Bool, e: {Bool.and(a, b) == True{} : Bool}) -> {b == True{} : Bool}:
  match a:
    case True{}:
      e
    case False{}:
      Empty.absurd({b == True{} : Bool}, false_ne_true(e))

def or_true(a: Bool, -b: Bool, e: {Bool.or(a, b) == True{} : Bool}) -> Or({a == True{} : Bool}, {b == True{} : Bool}):
  match a:
    case True{}:
      Inl{{==}}
    case False{}:
      Inr{e}

def or_l(a: Bool, -b: Bool, e: {a == True{} : Bool}) -> {Bool.or(a, b) == True{} : Bool}:
  match a:
    case True{}:
      {==}
    case False{}:
      Empty.absurd({b == True{} : Bool}, false_ne_true(e))

def or_r(a: Bool, -b: Bool, e: {b == True{} : Bool}) -> {Bool.or(a, b) == True{} : Bool}:
  match a:
    case True{}:
      {==}
    case False{}:
      e

def and_tt(a: Bool, -b: Bool, ea: {a == True{} : Bool}, eb: {b == True{} : Bool}) -> {Bool.and(a, b) == True{} : Bool}:
  match a:
    case True{}:
      eb
    case False{}:
      Empty.absurd({False{} == True{} : Bool}, false_ne_true(ea))

def not_true(a: Bool, e: {Bool.not(a) == True{} : Bool}) -> {a == False{} : Bool}:
  match a:
    case False{}:
      {==}
    case True{}:
      Empty.absurd({True{} == False{} : Bool}, false_ne_true(e))

def or_map(-A: Type, -B: Type, -C: Type, -D: Type, f: A -> C, g: B -> D, r: Or(A, B)) -> Or(C, D):
  match r:
    case Inl{a}:
      Inl{f(a)}
    case Inr{b}:
      Inr{g(b)}

# Equality tests
# ==============

def eqn.sound(a: Nat, b: Nat, e: {P.eqn(a, b) == True{} : Bool}) -> {a == b : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+q:
      Empty.absurd({0n == 1n+q : Nat}, false_ne_true(e))
    case 1n+p 0n:
      Empty.absurd({1n+p == 0n : Nat}, false_ne_true(e))
    case 1n+p 1n+q:
      %eqn.sound(p, q, e) : {1n+p == 1n+_ : Nat}
      {==}

def eqn.refl(a: Nat) -> {P.eqn(a, a) == True{} : Bool}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      eqn.refl(p)

def eqn.complete(a: Nat, -b: Nat, e: {a == b : Nat}) -> {P.eqn(a, b) == True{} : Bool}:
  %e : {P.eqn(a, _) == True{} : Bool}
  eqn.refl(a)

def eqa.sound(a: P.Act, b: P.Act, e: {P.eqa(a, b) == True{} : Bool}) -> {a == b : P.Act}:
  match a b:
    case P.Create{} P.Create{}:
      {==}
    case P.Update{} P.Update{}:
      {==}
    case P.Delete{} P.Delete{}:
      {==}
    case P.Replace{} P.Replace{}:
      {==}
    case P.Create{} P.Update{}:
      Empty.absurd({P.Create{} == P.Update{} : P.Act}, false_ne_true(e))
    case P.Create{} P.Delete{}:
      Empty.absurd({P.Create{} == P.Delete{} : P.Act}, false_ne_true(e))
    case P.Create{} P.Replace{}:
      Empty.absurd({P.Create{} == P.Replace{} : P.Act}, false_ne_true(e))
    case P.Update{} P.Create{}:
      Empty.absurd({P.Update{} == P.Create{} : P.Act}, false_ne_true(e))
    case P.Update{} P.Delete{}:
      Empty.absurd({P.Update{} == P.Delete{} : P.Act}, false_ne_true(e))
    case P.Update{} P.Replace{}:
      Empty.absurd({P.Update{} == P.Replace{} : P.Act}, false_ne_true(e))
    case P.Delete{} P.Create{}:
      Empty.absurd({P.Delete{} == P.Create{} : P.Act}, false_ne_true(e))
    case P.Delete{} P.Update{}:
      Empty.absurd({P.Delete{} == P.Update{} : P.Act}, false_ne_true(e))
    case P.Delete{} P.Replace{}:
      Empty.absurd({P.Delete{} == P.Replace{} : P.Act}, false_ne_true(e))
    case P.Replace{} P.Create{}:
      Empty.absurd({P.Replace{} == P.Create{} : P.Act}, false_ne_true(e))
    case P.Replace{} P.Update{}:
      Empty.absurd({P.Replace{} == P.Update{} : P.Act}, false_ne_true(e))
    case P.Replace{} P.Delete{}:
      Empty.absurd({P.Replace{} == P.Delete{} : P.Act}, false_ne_true(e))

# The gate
# ========

# A list that is not empty is not Nil: a motive that sends Nil to Empty.
def IsCon(xs: List<&2, P.Problem>) -> Type:
  match xs:
    case Nil{}:
      Empty
    case Con{h, t}:
      Unit

def con_ne_nil(-h: P.Problem, -t: List<&2, P.Problem>, e: {Con{h, t} == Nil{} : List<&2, P.Problem>}) -> Empty:
  %e : IsCon(_)
  Unit{}

# a gate step yields Nil only when its check said True and the rest is Nil
def keep.ok(ok: Bool, -p: P.Problem, -rest: List<&2, P.Problem>, e: {P.keep(ok, p, rest) == Nil{} : List<&2, P.Problem>}) -> {ok == True{} : Bool}:
  match ok:
    case True{}:
      {==}
    case False{}:
      Empty.absurd({False{} == True{} : Bool}, con_ne_nil(p, rest, e))

def keep.rest(ok: Bool, -p: P.Problem, -rest: List<&2, P.Problem>, e: {P.keep(ok, p, rest) == Nil{} : List<&2, P.Problem>}) -> {rest == Nil{} : List<&2, P.Problem>}:
  match ok:
    case True{}:
      e
    case False{}:
      Empty.absurd({rest == Nil{} : List<&2, P.Problem>}, con_ne_nil(p, rest, e))

# an append is Nil only when both sides are
def append.l(xs: List<&2, P.Problem>, -ys: List<&2, P.Problem>, e: {List.append(&2, P.Problem, xs, ys) == Nil{} : List<&2, P.Problem>}) -> {xs == Nil{} : List<&2, P.Problem>}:
  match xs:
    case Nil{}:
      {==}
    case Con{h, t}:
      Empty.absurd({Con{h, t} == Nil{} : List<&2, P.Problem>}, con_ne_nil(h, List.append(&2, P.Problem, t, ys), e))

def append.r(xs: List<&2, P.Problem>, -ys: List<&2, P.Problem>, e: {List.append(&2, P.Problem, xs, ys) == Nil{} : List<&2, P.Problem>}) -> {ys == Nil{} : List<&2, P.Problem>}:
  match xs:
    case Nil{}:
      e
    case Con{h, t}:
      Empty.absurd({ys == Nil{} : List<&2, P.Problem>}, con_ne_nil(h, List.append(&2, P.Problem, t, ys), e))

# a blocked outcome satisfies any IfApproved claim
def classify.ok(b: Bool, -ps: List<&2, P.Problem>, -F: List<&2, P.Op> -> Type) -> Laws.IfApproved(P.classify(b, ps), F):
  match b:
    case True{}:
      Unit{}
    case False{}:
      Unit{}

# finish approves only an empty problem list
def finish.ok(-F: List<&2, P.Op> -> Type, ps: List<&2, P.Problem>, -ops: List<&2, P.Op>, k: {ps == Nil{} : List<&2, P.Problem>} -> F(ops))
  -> Laws.IfApproved(P.finish(ps, ops), F):
  match ps:
    case Nil{}:
      k({==})
    case Con{+p, +t}:
      classify.ok(P.all_pending(Con{p, t}), Con{p, t}, F)

# the four stages of P.plan, named as plan names them
def S.ops(+des: P.State, +obs: P.State) -> List<&2, P.Op>:
  P.diff(des, obs)

def S.tail3(+des: P.State, +obs: P.State, +apps: List<&2, P.Approval>) -> List<&2, P.Problem>:
  List.append(&2, P.Problem, P.unused_problems(apps, P.diff(des, obs)), P.approval_problems(apps, des, obs, P.diff(des, obs)))

def S.tail2(+des: P.State, +obs: P.State, +g: P.Grant, +apps: List<&2, P.Approval>) -> List<&2, P.Problem>:
  List.append(&2, P.Problem, P.grant_problems(g, des, obs, P.diff(des, obs)), S.tail3(des, obs, apps))

def S.all(+des: P.State, +obs: P.State, +g: P.Grant, +apps: List<&2, P.Approval>) -> List<&2, P.Problem>:
  List.append(&2, P.Problem, P.validate(des, obs), S.tail2(des, obs, g, apps))

# Environment isolation
# =====================

def env.permits(genv: Nat, +c: Bool, u: Bool, +d: Bool, act: P.Act, +e: {P.permits(P.Grant{genv, c, u, d}, act) == True{} : Bool})
  -> Laws.Permits(P.Grant{genv, c, u, d}, act):
  match act:
    case P.Create{}:
      e
    case P.Update{}:
      e
    case P.Delete{}:
      e
    case P.Replace{}:
      (and_l(c, d, e), and_r(c, d, e))

# a database, Worker or bucket with the op's id lives in the grant environment:
# the check said "not this id, or this env", and it is this id
def env.here.or(+did: Nat, +id: Nat, +denv: Nat, +env: Nat, h: {did == id : Nat},
  r: Or({Bool.not(P.eqn(did, id)) == True{} : Bool}, {P.eqn(denv, env) == True{} : Bool})) -> {denv == env : Nat}:
  match r:
    case Inl{n}:
      Empty.absurd({denv == env : Nat}, false_ne_true(Equal.trans(Bool, False{}, P.eqn(did, id), True{}, Equal.sym(Bool, P.eqn(did, id), False{}, not_true(P.eqn(did, id), n)), eqn.complete(did, id, h))))
    case Inr{y}:
      eqn.sound(denv, env, y)

def env.here(+did: Nat, +id: Nat, +denv: Nat, +env: Nat, c: {Bool.or(Bool.not(P.eqn(did, id)), P.eqn(denv, env)) == True{} : Bool}, h: {did == id : Nat}) -> {denv == env : Nat}:
  env.here.or(did, id, denv, env, h, or_true(Bool.not(P.eqn(did, id)), P.eqn(denv, env), c))

def env.dbs(+id: Nat, +env: Nat, dbs: List<&2, P.Db>) -> {P.dbs_in(id, env, dbs) == True{} : Bool} -> Laws.DbsIn(id, env, dbs):
  match dbs:
    case Nil{}:
      e => Unit{}
    case Con{P.Db{+did, +denv, protect, location, replicas}, t}:
      +e => (h => env.here(did, id, denv, env, and_l(Bool.or(Bool.not(P.eqn(did, id)), P.eqn(denv, env)), P.dbs_in(id, env, t), e), h), env.dbs(id, env, t)(and_r(Bool.or(Bool.not(P.eqn(did, id)), P.eqn(denv, env)), P.dbs_in(id, env, t), e)))

def env.wks(+id: Nat, +env: Nat, wks: List<&2, P.Wk>) -> {P.wks_in(id, env, wks) == True{} : Bool} -> Laws.WksIn(id, env, wks):
  match wks:
    case Nil{}:
      e => Unit{}
    case Con{P.Wk{+wid, +wenv, main, compat, binds}, t}:
      +e => (h => env.here(wid, id, wenv, env, and_l(Bool.or(Bool.not(P.eqn(wid, id)), P.eqn(wenv, env)), P.wks_in(id, env, t), e), h), env.wks(id, env, t)(and_r(Bool.or(Bool.not(P.eqn(wid, id)), P.eqn(wenv, env)), P.wks_in(id, env, t), e)))

def env.buckets(+id: Nat, +env: Nat, buckets: List<&2, P.Bucket>) -> {P.buckets_in(id, env, buckets) == True{} : Bool} -> Laws.BucketsIn(id, env, buckets):
  match buckets:
    case Nil{}:
      e => Unit{}
    case Con{P.Bucket{+did, +denv, protect}, t}:
      +e => (h => env.here(did, id, denv, env, and_l(Bool.or(Bool.not(P.eqn(did, id)), P.eqn(denv, env)), P.buckets_in(id, env, t), e), h), env.buckets(id, env, t)(and_r(Bool.or(Bool.not(P.eqn(did, id)), P.eqn(denv, env)), P.buckets_in(id, env, t), e)))

def env.resident(+id: Nat, +env: Nat, s: P.State, +e: {P.resident(id, env, s) == True{} : Bool}) -> Laws.Resident(id, env, s):
  match s:
    case P.State{+dbs, +wks, +buckets}:
      +d = and_l(Bool.and(P.dbs_in(id, env, dbs), P.wks_in(id, env, wks)), P.buckets_in(id, env, buckets), e)
      ((env.dbs(id, env, dbs)(and_l(P.dbs_in(id, env, dbs), P.wks_in(id, env, wks), d)), env.wks(id, env, wks)(and_r(P.dbs_in(id, env, dbs), P.wks_in(id, env, wks), d))), env.buckets(id, env, buckets)(and_r(Bool.and(P.dbs_in(id, env, dbs), P.wks_in(id, env, wks)), P.buckets_in(id, env, buckets), e)))

def env.granted(g: P.Grant, +des: P.State, +obs: P.State, op: P.Op, +e: {P.granted(g, des, obs, op) == True{} : Bool}) -> Laws.InGrant(g, des, obs, op):
  match g op:
    case P.Grant{+genv, +c, +u, +d} P.Op{+act, kind, +id, +env, why}:
      +r1 = and_r(P.eqn(env, genv), Bool.and(P.permits(P.Grant{genv, c, u, d}, act), Bool.and(P.resident(id, genv, des), P.resident(id, genv, obs))), e)
      +r2 = and_r(P.permits(P.Grant{genv, c, u, d}, act), Bool.and(P.resident(id, genv, des), P.resident(id, genv, obs)), r1)
      (eqn.sound(env, genv, and_l(P.eqn(env, genv), Bool.and(P.permits(P.Grant{genv, c, u, d}, act), Bool.and(P.resident(id, genv, des), P.resident(id, genv, obs))), e)),
        (env.permits(genv, c, u, d, act, and_l(P.permits(P.Grant{genv, c, u, d}, act), Bool.and(P.resident(id, genv, des), P.resident(id, genv, obs)), r1)),
          (env.resident(id, genv, des, and_l(P.resident(id, genv, des), P.resident(id, genv, obs), r2)),
           env.resident(id, genv, obs, and_r(P.resident(id, genv, des), P.resident(id, genv, obs), r2)))))

def env.ops(+g: P.Grant, +des: P.State, +obs: P.State, ops: List<&2, P.Op>, +e: {P.grant_problems(g, des, obs, ops) == Nil{} : List<&2, P.Problem>}) -> Laws.AllInGrant(g, des, obs, ops):
  match ops:
    case Nil{}:
      Unit{}
    case Con{+op, t}:
      (env.granted(g, des, obs, op, keep.ok(P.granted(g, des, obs, op), P.out_of_grant(op), P.grant_problems(g, des, obs, t), e)), env.ops(g, des, obs, t, keep.rest(P.granted(g, des, obs, op), P.out_of_grant(op), P.grant_problems(g, des, obs, t), e)))

def Laws.env_isolation(des, obs, g, apps):
  finish.ok(ops => Laws.AllInGrant(g, des, obs, ops), S.all(des, obs, g, apps), S.ops(des, obs), +e =>
    env.ops(g, des, obs, S.ops(des, obs), append.l(P.grant_problems(g, des, obs, S.ops(des, obs)), S.tail3(des, obs, apps), append.r(P.validate(des, obs), S.tail2(des, obs, g, apps), e))))

# Binding validity
# ================

def bind.here(+did: Nat, +id: Nat, +denv: Nat, +env: Nat, +h: {Bool.and(P.eqn(did, id), P.eqn(denv, env)) == True{} : Bool})
  -> ({did == id : Nat} & {denv == env : Nat}):
  (eqn.sound(did, id, and_l(P.eqn(did, id), P.eqn(denv, env), h)), eqn.sound(denv, env, and_r(P.eqn(did, id), P.eqn(denv, env), h)))

def bind.db_at(+id: Nat, +env: Nat, dbs: List<&2, P.Db>) -> {P.db_at(id, env, dbs) == True{} : Bool} -> Laws.DbAt(id, env, dbs):
  match dbs:
    case Nil{}:
      e => Empty.absurd(Empty, false_ne_true(e))
    case Con{P.Db{+did, +denv, protect, location, replicas}, t}:
      e => or_map(
        {Bool.and(P.eqn(did, id), P.eqn(denv, env)) == True{} : Bool},
        {P.db_at(id, env, t) == True{} : Bool},
        ({did == id : Nat} & {denv == env : Nat}),
        Laws.DbAt(id, env, t),
        h => bind.here(did, id, denv, env, h),
        bind.db_at(id, env, t),
        or_true(Bool.and(P.eqn(did, id), P.eqn(denv, env)), P.db_at(id, env, t), e))

def bind.bucket_at(+id: Nat, +env: Nat, buckets: List<&2, P.Bucket>) -> {P.bucket_at(id, env, buckets) == True{} : Bool} -> Laws.BucketAt(id, env, buckets):
  match buckets:
    case Nil{}:
      e => Empty.absurd(Empty, false_ne_true(e))
    case Con{P.Bucket{+did, +denv, protect}, t}:
      e => or_map(
        {Bool.and(P.eqn(did, id), P.eqn(denv, env)) == True{} : Bool},
        {P.bucket_at(id, env, t) == True{} : Bool},
        ({did == id : Nat} & {denv == env : Nat}),
        Laws.BucketAt(id, env, t),
        h => bind.here(did, id, denv, env, h),
        bind.bucket_at(id, env, t),
        or_true(Bool.and(P.eqn(did, id), P.eqn(denv, env)), P.bucket_at(id, env, t), e))

def bind.binds(+wk: Nat, +env: Nat, binds: List<&2, P.Bind>, +dbs: List<&2, P.Db>, +buckets: List<&2, P.Bucket>, +e: {P.binds_problems(wk, env, binds, dbs, buckets) == Nil{} : List<&2, P.Problem>})
  -> Laws.BindsAt(env, binds, dbs, buckets):
  match binds:
    case Nil{}:
      Unit{}
    case Con{P.Bind{+name, +db}, t}:
      (bind.db_at(db, env, dbs)(keep.ok(P.db_at(db, env, dbs), P.bind_err(wk, name, db, P.mem(db, P.db_ids(dbs))), P.binds_problems(wk, env, t, dbs, buckets), e)), bind.binds(wk, env, t, dbs, buckets, keep.rest(P.db_at(db, env, dbs), P.bind_err(wk, name, db, P.mem(db, P.db_ids(dbs))), P.binds_problems(wk, env, t, dbs, buckets), e)))
    case Con{P.BucketBind{+name, +bucket}, t}:
      (bind.bucket_at(bucket, env, buckets)(keep.ok(P.bucket_at(bucket, env, buckets), P.bucket_bind_err(wk, name, bucket, P.mem(bucket, P.bucket_ids(buckets))), P.binds_problems(wk, env, t, dbs, buckets), e)), bind.binds(wk, env, t, dbs, buckets, keep.rest(P.bucket_at(bucket, env, buckets), P.bucket_bind_err(wk, name, bucket, P.mem(bucket, P.bucket_ids(buckets))), P.binds_problems(wk, env, t, dbs, buckets), e)))

def bind.wks(wks: List<&2, P.Wk>, +dbs: List<&2, P.Db>, +buckets: List<&2, P.Bucket>, +e: {P.wks_problems(wks, dbs, buckets) == Nil{} : List<&2, P.Problem>}) -> Laws.WorkersBound(wks, dbs, buckets):
  match wks:
    case Nil{}:
      Unit{}
    case Con{P.Wk{+id, +env, main, compat, +binds}, t}:
      (bind.binds(id, env, binds, dbs, buckets, append.l(P.binds_problems(id, env, binds, dbs, buckets), P.wks_problems(t, dbs, buckets), e)), bind.wks(t, dbs, buckets, append.r(P.binds_problems(id, env, binds, dbs, buckets), P.wks_problems(t, dbs, buckets), e)))

def bind.state(des: P.State, e: {P.binding_problems(des) == Nil{} : List<&2, P.Problem>}) -> Laws.BindingsValid(des):
  match des:
    case P.State{dbs, wks, buckets}:
      bind.wks(wks, dbs, buckets, e)

def Laws.binding_validity(des, obs, g, apps):
  finish.ok(ops => Laws.BindingsValid(des), S.all(des, obs, g, apps), S.ops(des, obs), +e =>
    bind.state(des, append.l(P.binding_problems(des), P.other_problems(des, obs), append.l(P.validate(des, obs), S.tail2(des, obs, g, apps), e))))

# Protected deletion
# ==================

def prot.in.here(+id: Nat, +did: Nat, +protect: Bool, -t: List<&2, P.Db>,
  x: Or(({did == id : Nat} & {protect == True{} : Bool}), Laws.ProtectedIn(id, t)),
  rec: Laws.ProtectedIn(id, t) -> {P.protected(id, t) == True{} : Bool})
  -> {Bool.or(Bool.and(P.eqn(did, id), protect), P.protected(id, t)) == True{} : Bool}:
  match x:
    case Inl{(a, b)}:
      or_l(Bool.and(P.eqn(did, id), protect), P.protected(id, t), and_tt(P.eqn(did, id), protect, eqn.complete(did, id, a), b))
    case Inr{y}:
      or_r(Bool.and(P.eqn(did, id), protect), P.protected(id, t), rec(y))

def prot.in(+id: Nat, dbs: List<&2, P.Db>) -> Laws.ProtectedIn(id, dbs) -> {P.protected(id, dbs) == True{} : Bool}:
  match dbs:
    case Nil{}:
      x => Empty.absurd({False{} == True{} : Bool}, x)
    case Con{P.Db{+did, denv, +protect, location, replicas}, t}:
      x => prot.in.here(id, did, protect, t, x, prot.in(id, t))

def prot.complete.or(+id: Nat, +dbs: List<&2, P.Db>, +odbs: List<&2, P.Db>, x: Or(Laws.ProtectedIn(id, odbs), Laws.ProtectedIn(id, dbs)))
  -> {Bool.or(P.protected(id, odbs), P.protected(id, dbs)) == True{} : Bool}:
  match x:
    case Inl{a}:
      or_l(P.protected(id, odbs), P.protected(id, dbs), prot.in(id, odbs)(a))
    case Inr{b}:
      or_r(P.protected(id, odbs), P.protected(id, dbs), prot.in(id, dbs)(b))

def prot.bucket_in.here(+id: Nat, +did: Nat, +protect: Bool, -t: List<&2, P.Bucket>,
  x: Or(({did == id : Nat} & {protect == True{} : Bool}), Laws.BucketProtectedIn(id, t)),
  rec: Laws.BucketProtectedIn(id, t) -> {P.bucket_protected(id, t) == True{} : Bool})
  -> {Bool.or(Bool.and(P.eqn(did, id), protect), P.bucket_protected(id, t)) == True{} : Bool}:
  match x:
    case Inl{(a, b)}:
      or_l(Bool.and(P.eqn(did, id), protect), P.bucket_protected(id, t), and_tt(P.eqn(did, id), protect, eqn.complete(did, id, a), b))
    case Inr{y}:
      or_r(Bool.and(P.eqn(did, id), protect), P.bucket_protected(id, t), rec(y))

def prot.bucket_in(+id: Nat, buckets: List<&2, P.Bucket>) -> Laws.BucketProtectedIn(id, buckets) -> {P.bucket_protected(id, buckets) == True{} : Bool}:
  match buckets:
    case Nil{}:
      x => Empty.absurd({False{} == True{} : Bool}, x)
    case Con{P.Bucket{+did, denv, +protect}, t}:
      x => prot.bucket_in.here(id, did, protect, t, x, prot.bucket_in(id, t))

def prot.bucket_complete.or(+id: Nat, +buckets: List<&2, P.Bucket>, +obuckets: List<&2, P.Bucket>, x: Or(Laws.BucketProtectedIn(id, obuckets), Laws.BucketProtectedIn(id, buckets)))
  -> {Bool.or(P.bucket_protected(id, obuckets), P.bucket_protected(id, buckets)) == True{} : Bool}:
  match x:
    case Inl{a}:
      or_l(P.bucket_protected(id, obuckets), P.bucket_protected(id, buckets), prot.bucket_in(id, obuckets)(a))
    case Inr{b}:
      or_r(P.bucket_protected(id, obuckets), P.bucket_protected(id, buckets), prot.bucket_in(id, buckets)(b))

def prot.complete.combine(+id: Nat, +dbs: List<&2, P.Db>, +odbs: List<&2, P.Db>, +buckets: List<&2, P.Bucket>, +obuckets: List<&2, P.Bucket>,
  x: Or(Or(Laws.ProtectedIn(id, odbs), Laws.ProtectedIn(id, dbs)), Or(Laws.BucketProtectedIn(id, obuckets), Laws.BucketProtectedIn(id, buckets))))
  -> {Bool.or(Bool.or(P.protected(id, odbs), P.protected(id, dbs)), Bool.or(P.bucket_protected(id, obuckets), P.bucket_protected(id, buckets))) == True{} : Bool}:
  match x:
    case Inl{a}:
      or_l(Bool.or(P.protected(id, odbs), P.protected(id, dbs)), Bool.or(P.bucket_protected(id, obuckets), P.bucket_protected(id, buckets)), prot.complete.or(id, dbs, odbs, a))
    case Inr{b}:
      or_r(Bool.or(P.protected(id, odbs), P.protected(id, dbs)), Bool.or(P.bucket_protected(id, obuckets), P.bucket_protected(id, buckets)), prot.bucket_complete.or(id, buckets, obuckets, b))

def prot.complete(+id: Nat, des: P.State, obs: P.State, x: Laws.Protected(id, des, obs)) -> {P.is_protected(id, des, obs) == True{} : Bool}:
  match des obs:
    case P.State{dbs, wks, buckets} P.State{odbs, owks, obuckets}:
      prot.complete.combine(id, dbs, odbs, buckets, obuckets, x)

def prot.approved.here(+aact: P.Act, +act: P.Act, +aid: Nat, +id: Nat, +aenv: Nat, +env: Nat,
  +h: {Bool.and(P.eqa(aact, act), Bool.and(P.eqn(aid, id), P.eqn(aenv, env))) == True{} : Bool})
  -> ({aact == act : P.Act} & ({aid == id : Nat} & {aenv == env : Nat})):
  (eqa.sound(aact, act, and_l(P.eqa(aact, act), Bool.and(P.eqn(aid, id), P.eqn(aenv, env)), h)),
    (eqn.sound(aid, id, and_l(P.eqn(aid, id), P.eqn(aenv, env), and_r(P.eqa(aact, act), Bool.and(P.eqn(aid, id), P.eqn(aenv, env)), h))),
     eqn.sound(aenv, env, and_r(P.eqn(aid, id), P.eqn(aenv, env), and_r(P.eqa(aact, act), Bool.and(P.eqn(aid, id), P.eqn(aenv, env)), h)))))

def prot.approved(+act: P.Act, +id: Nat, +env: Nat, apps: List<&2, P.Approval>) -> {P.approved(act, id, env, apps) == True{} : Bool} -> Laws.Approves(act, id, env, apps):
  match apps:
    case Nil{}:
      e => Empty.absurd(Empty, false_ne_true(e))
    case Con{P.Approval{+aact, +aid, +aenv}, t}:
      e => or_map(
        {Bool.and(P.eqa(aact, act), Bool.and(P.eqn(aid, id), P.eqn(aenv, env))) == True{} : Bool},
        {P.approved(act, id, env, t) == True{} : Bool},
        ({aact == act : P.Act} & ({aid == id : Nat} & {aenv == env : Nat})),
        Laws.Approves(act, id, env, t),
        h => prot.approved.here(aact, act, aid, id, aenv, env, h),
        prot.approved(act, id, env, t),
        or_true(Bool.and(P.eqa(aact, act), Bool.and(P.eqn(aid, id), P.eqn(aenv, env))), P.approved(act, id, env, t), e))

# a destructive act on a protected id: cleared means approved, since the
# "not protected" side of the check contradicts the protection witness
def prot.destroy.or(+act: P.Act, +id: Nat, +env: Nat, +apps: List<&2, P.Approval>, +des: P.State, +obs: P.State,
  x: Laws.Protected(id, des, obs),
  r: Or({Bool.not(P.is_protected(id, des, obs)) == True{} : Bool}, {P.approved(act, id, env, apps) == True{} : Bool}))
  -> Laws.Approves(act, id, env, apps):
  match r:
    case Inl{n}:
      Empty.absurd(Laws.Approves(act, id, env, apps), false_ne_true(Equal.trans(Bool, False{}, P.is_protected(id, des, obs), True{}, Equal.sym(Bool, P.is_protected(id, des, obs), False{}, not_true(P.is_protected(id, des, obs), n)), prot.complete(id, des, obs, x))))
    case Inr{y}:
      prot.approved(act, id, env, apps)(y)

def prot.destroy(+act: P.Act, +id: Nat, +env: Nat, +apps: List<&2, P.Approval>, +des: P.State, +obs: P.State,
  ok: {Bool.or(Bool.not(P.is_protected(id, des, obs)), P.approved(act, id, env, apps)) == True{} : Bool},
  x: Laws.Protected(id, des, obs)) -> Laws.Approves(act, id, env, apps):
  prot.destroy.or(act, id, env, apps, des, obs, x, or_true(Bool.not(P.is_protected(id, des, obs)), P.approved(act, id, env, apps), ok))

def prot.op(+apps: List<&2, P.Approval>, +des: P.State, +obs: P.State, op: P.Op, ok: {P.op_cleared(apps, des, obs, op) == True{} : Bool})
  -> Laws.DestroyOk(des, obs, apps, op):
  match op:
    case P.Op{P.Create{}, kind, id, env, why}:
      Unit{}
    case P.Op{P.Update{}, kind, id, env, why}:
      Unit{}
    case P.Op{P.Delete{}, kind, id, env, why}:
      x => prot.destroy(P.Delete{}, id, env, apps, des, obs, ok, x)
    case P.Op{P.Replace{}, kind, id, env, why}:
      x => prot.destroy(P.Replace{}, id, env, apps, des, obs, ok, x)

def prot.ops(+apps: List<&2, P.Approval>, +des: P.State, +obs: P.State, ops: List<&2, P.Op>, +e: {P.approval_problems(apps, des, obs, ops) == Nil{} : List<&2, P.Problem>})
  -> Laws.AllDestroyOk(des, obs, apps, ops):
  match ops:
    case Nil{}:
      Unit{}
    case Con{+op, t}:
      (prot.op(apps, des, obs, op, keep.ok(P.op_cleared(apps, des, obs, op), P.need_approval(op), P.approval_problems(apps, des, obs, t), e)), prot.ops(apps, des, obs, t, keep.rest(P.op_cleared(apps, des, obs, op), P.need_approval(op), P.approval_problems(apps, des, obs, t), e)))

def Laws.protected_deletion(des, obs, g, apps):
  finish.ok(ops => Laws.AllDestroyOk(des, obs, apps, ops), S.all(des, obs, g, apps), S.ops(des, obs), +e =>
    prot.ops(apps, des, obs, S.ops(des, obs), append.r(P.unused_problems(apps, S.ops(des, obs)), P.approval_problems(apps, des, obs, S.ops(des, obs)), append.r(P.grant_problems(g, des, obs, S.ops(des, obs)), S.tail3(des, obs, apps), append.r(P.validate(des, obs), S.tail2(des, obs, g, apps), e)))))
