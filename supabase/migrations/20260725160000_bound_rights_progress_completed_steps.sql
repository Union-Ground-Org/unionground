-- Bound member_rights_progress.completed_steps cardinality.
--
-- VECTOR (REQ-UG-RIGHTS-PROGRESS-BOUNDS-20260725)
-- saveRightsProgress (src/lib/memberApi.js) upserts completed_steps straight
-- from the wire: client.from('member_rights_progress').upsert({ ...,
-- completed_steps: completedSteps }). The column carried no CHECK, so a member
-- could open the browser console and store an arbitrarily large integer[] in
-- their OWN row. RLS confines the blast radius to that one row and the award
-- trigger only tests cardinality(completed_steps) > 0, so this is storage
-- abuse, not privilege escalation -- but it is unbounded and reachable today.
--
-- WHY A CHECK, NOT AN RPC
-- saveRightsProgress is deliberately NOT a definer RPC: it is idempotent,
-- self-healing on the next save, and it is the one member write that rides the
-- offline outbox, so routing it through a function would add failure surface to
-- offline replay for no atomicity gain (see the audit note on
-- REQ-UG-RIGHTS-PROGRESS-BOUNDS-20260725). A column CHECK bounds the value
-- without touching that path: the client keeps upserting exactly as before, and
-- an over-large array is refused at the wire by Postgres.
--
-- SIZING (against real data, 2026-07-25, prod productionprojectref)
-- completed_steps is integer[] (default '{}'::integer[]), so every element is a
-- fixed 4 bytes: cardinality IS the total-size bound, and no per-element length
-- guard is needed the way it would be for text[]. All 5 rights lessons carry
-- exactly 3 steps (max steps across member_rights_lessons = 3); the observed
-- max cardinality across 100,003 progress rows is 3, and handle_new_member
-- seeds a single-element array[0]. A CHECK cannot reference another table (no
-- subquery), so the bound is a static literal rather than "= max lesson steps";
-- 64 is ~21x the largest real lesson, future-proof against a lesson being
-- expanded, and caps a row at 256 payload bytes -- a hard ceiling versus
-- today's unbounded array. Every existing row already satisfies it, so the
-- constraint is added VALIDATED (a fast scan on 100k rows), enforcing on both
-- existing and future writes immediately.
--
-- CONTRACT
-- scripts/db-contract.json gains a constraints entry so the live-DB verifier
-- (npm run verify:db) fails if this constraint is ever dropped or weakened in
-- production. A migration-file text pin cannot see a prod-side DROP CONSTRAINT;
-- only the catalog sweep can.

set local lock_timeout = '5s';

-- Validate against existing rows BEFORE enforcing (acceptance): fail loudly with
-- an exact count rather than an opaque check_violation if any row already
-- exceeds the bound. Verified 0 such rows at authoring time (max cardinality 3).
do $$
declare
  v_over bigint;
begin
  select count(*)
    into v_over
    from public.member_rights_progress
   where cardinality(completed_steps) > 64;
  if v_over > 0 then
    raise exception
      'member_rights_progress has % row(s) with cardinality(completed_steps) > 64; resolve them before enforcing the bound',
      v_over
      using errcode = 'check_violation';
  end if;
end
$$;

alter table public.member_rights_progress
  add constraint member_rights_progress_completed_steps_bounded
  check (cardinality(completed_steps) <= 64);
