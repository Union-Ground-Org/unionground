-- BUG-UG-WEB-CASE-RESTRICT-LOCKS-OUT-COORDINATOR-20261003
-- An unassigned chapter coordinator reaches a case through the coordinator hat
-- (private.casework_staff_can_access), may restrict it, and then loses it at
-- once: the restricted branch admits only the assigned staff, an organization
-- advisor, admin or vp, and active grantees. She could not lift her own
-- restriction.
--
-- This refuses the restriction before it would remove the caller's own access.
-- The body is the installed public.casework_set_restriction(uuid, boolean, text)
-- definition (the 20260907151000 case-graph and message-lifecycle gates wrapped
-- around the 20260828210000 body), changed only to re-check
-- private.casework_staff_can_access after the update and, when restricting
-- would leave the caller outside, raise 22023 with the translated detail token
-- casework_restriction_self_lockout. It also re-checks private.member_case_row_visible on the
-- updated row, the predicate the member_cases read policies use, so a stale steward
-- assignment without the steward role cannot pass the first check and still lose the case
-- from the board. That predicate can return NULL (an unassigned coordinator column), so it
-- is tested with IS NOT TRUE. The exception rolls the update back, so
-- nothing is written or audited. Lifting a restriction and who may see a
-- restricted case are unchanged. Hosted application needs the owner's separate
-- go-ahead.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
declare
  installed text;
begin
  select pg_catalog.md5(p.prosrc) into strict installed
    from pg_catalog.pg_proc p
   where p.oid = 'public.casework_set_restriction(uuid, boolean, text)'::regprocedure;
  -- The reviewed predecessor is the gated wrapper that
  -- 20260907151000_account_deletion_finalization_reconciliation.sql installed.
  if installed is distinct from 'eec7d5d1a77caacd6e19565c2454c4d0' then
    raise exception 'unreviewed casework_set_restriction predecessor: %', installed
      using errcode = '55000';
  end if;
end
$predecessor$;

create or replace function public.casework_set_restriction(p_case_id uuid, p_restricted boolean, p_reason text)
returns public.member_cases
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare v_case public.member_cases%rowtype;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_restricted and pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 8 and 500 then raise exception 'restriction reason is required' using errcode = '22023'; end if;
  update public.member_cases set
    is_restricted = p_restricted,
    restriction_reason = case when p_restricted then pg_catalog.btrim(p_reason) else null end,
    restricted_at = case when p_restricted then pg_catalog.now() else null end,
    restricted_by = case when p_restricted then (select auth.uid()) else null end,
    updated_at = pg_catalog.now()
  where id = p_case_id returning * into v_case;
  if p_restricted and (not private.casework_staff_can_access(p_case_id) or private.member_case_row_visible(v_case) is not true)
  then raise exception 'restricting this case would remove your own access to it' using errcode = '22023', detail = 'casework_restriction_self_lockout'; end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'restriction_changed', 'case', v_case.id, pg_catalog.jsonb_build_object('restricted', p_restricted));
  return v_case;
end;
end;
end;
$function$;

notify pgrst, 'reload schema';
commit;
