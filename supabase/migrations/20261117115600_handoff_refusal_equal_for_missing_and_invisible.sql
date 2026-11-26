-- SEC-UG-HANDOFF-RESOLVE-REVEALS-ANOTHER-CHAPTERS-HANDOFF-20261115 (#8914).
--
-- public.acknowledge_member_handoff, cancel_member_handoff and
-- decline_member_handoff call private.mi1_w2_resolve_handoff, which refused
-- "not found" only when private.mi1_w2_handoff_visible was not true. That
-- helper ORs four tests, one of them from_steward_id = auth.uid(); with
-- from_steward_id null and a caller who is not a party, the OR was NULL, so
-- `not visible` skipped the refusal and the party checks answered 42501
-- "not authorized" where a missing id answered P0002 "not found". A caller
-- elsewhere in the organization could tell that a handoff exists, and the
-- resolver took its row lock before refusing (found by the non-interference
-- proof, #8359 batch 18).
--
-- mi1_w2_handoff_visible now answers false, never NULL (coalesce). The
-- resolver reads and checks the handoff without a lock, refusing a missing
-- and an invisible handoff alike, then takes the row lock it took before and
-- checks again, as #8851 does. Who may see and act on a handoff is
-- unchanged: its initiator, its receiving and previous steward, and the
-- organization's overseers. The two list reads that use the helper in a
-- WHERE clause already dropped a NULL row and answer the same. Nothing else
-- in the two bodies changes; the predecessor bodies are guarded below.
-- Signatures, owners and grants are unchanged (create or replace).

begin;

-- The hosted runner applies migrations with an empty search_path. The
-- predecessor renderings below name public.member_handoffs unqualified only
-- when public is searched, and the re-emitted helper takes that composite
-- type, so this migration names its own search path for its statements. Each
-- function keeps its own empty search_path (review of #8936, round 1).
set local search_path = pg_catalog, public;

-- Each re-emitted function must still be the reviewed live body.
do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.mi1_w2_handoff_visible(uuid, public.member_handoffs)'))) is distinct from '5203180e931d5406e1ee928149e9c1d0' then
    raise exception 'unreviewed predecessor: private.mi1_w2_handoff_visible' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.mi1_w2_resolve_handoff(uuid, text)'))) is distinct from '613121df8131f8a325153a50c928c852' then
    raise exception 'unreviewed predecessor: private.mi1_w2_resolve_handoff' using errcode = '55000';
  end if;
end;
$predecessors$;

CREATE OR REPLACE FUNCTION private.mi1_w2_handoff_visible(p_org uuid, p_handoff public.member_handoffs)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- Never NULL: a null party column (from_steward_id is null when the member
  -- had no steward) made the OR NULL for a caller who is not a party, and
  -- `not visible` then skipped the resolver's refusal (#8914).
  select coalesce(p_handoff.organization_id = p_org
    and (
      p_handoff.initiated_by = (select auth.uid())
      or p_handoff.to_steward_id = (select auth.uid())
      or p_handoff.from_steward_id = (select auth.uid())
      or private.mi1_w2_handoff_can_oversee(p_org)
    ), false)
$function$;

CREATE OR REPLACE FUNCTION private.mi1_w2_resolve_handoff(p_handoff_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_w2_selected_organization();
  handoff public.member_handoffs%rowtype;
  actor uuid := (select auth.uid());
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  -- A missing handoff and one the caller may not see get the same refusal,
  -- and no lock is taken on a handoff the caller may not see (#8914): read
  -- and check without a lock, then lock and check again.
  select * into handoff from public.member_handoffs where id = p_handoff_id;
  if not found
     or handoff.organization_id is distinct from org
     or not private.mi1_w2_handoff_visible(org, handoff) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into handoff from public.member_handoffs where id = p_handoff_id for update;
  if not found
     or handoff.organization_id is distinct from org
     or not private.mi1_w2_handoff_visible(org, handoff) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_action in ('acknowledged', 'declined') and handoff.to_steward_id is distinct from actor then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_action = 'cancelled'
     and handoff.initiated_by is distinct from actor
     and not private.mi1_w2_handoff_can_oversee(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if handoff.status = p_action then
    return pg_catalog.jsonb_build_object('id', handoff.id, 'status', handoff.status, 'kind', 'reuse');
  end if;
  if handoff.status <> 'pending' then
    raise exception 'This handoff is no longer pending.' using errcode = 'P0001';
  end if;
  update public.member_handoffs
  set status = p_action,
      acknowledged_at = case when p_action = 'acknowledged' then pg_catalog.now() else null end,
      resolved_at = pg_catalog.now()
  where id = handoff.id;
  if p_action = 'acknowledged' then
    insert into public.member_steward_relationships (
      organization_id, chapter_id, member_user_id, steward_user_id
    ) values (
      org, handoff.chapter_id, handoff.member_user_id, handoff.to_steward_id
    )
    on conflict (organization_id, chapter_id, member_user_id) do update
      set steward_user_id = excluded.steward_user_id,
          updated_at = pg_catalog.now();
  end if;
  perform private.mi1_w2_write_audit(org, 'member_handoff_' || p_action, pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', handoff.chapter_id,
    'userId', handoff.member_user_id, 'status', p_action,
    'handoffId', handoff.id, 'fromStewardId', handoff.from_steward_id,
    'toStewardId', handoff.to_steward_id
  ));
  return pg_catalog.jsonb_build_object('id', handoff.id, 'status', p_action, 'kind', p_action);
end;
end;
$function$;

commit;
