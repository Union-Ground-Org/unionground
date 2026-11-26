begin;

-- BUG-UG-STEWARD-DESK-RPC-LATENCY-AT-SCALE-20260908.
-- Corrected-fixture measurements retained with this delivery show that the
-- broadcast policy's per-row private.can_read_member_broadcast(id) calls are
-- the largest independently attributable initial-wave cost. The set helper
-- below evaluates the same caller, MFA, organization-membership, tenant, and
-- chapter-audience predicates once per statement; the policy still admits
-- only broadcast IDs produced by that exact predicate. The KPI returns to its
-- original SECURITY INVOKER aggregate: an aggregate result never authorizes
-- bypassing either conversation or message RLS.

create or replace function private.visible_member_broadcast_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $function$
  with caller as materialized (
    select
      (select auth.uid()) as uid,
      (select private.mfa_satisfied()) as mfa,
      (select private.current_member_organization()) as organization_id,
      (select private.is_organization_member(private.current_member_organization())) as is_member
  ),
  active_chapters as materialized (
    select membership.chapter_id
    from public.member_chapter_memberships membership
    cross join caller
    where membership.user_id = caller.uid
      and membership.status = 'active'
  )
  select broadcast.id
  from public.member_broadcasts broadcast
  cross join caller
  where caller.uid is not null
    and caller.mfa
    and broadcast.organization_id is not null
    and broadcast.organization_id = caller.organization_id
    and caller.is_member
    and (
      broadcast.audience_scope = 'organization'
      or (
        broadcast.audience_scope = 'chapter'
        and broadcast.chapter_id in (select active_chapters.chapter_id from active_chapters)
      )
    );
$function$;

revoke all on function private.visible_member_broadcast_ids()
  from public, anon, authenticated, service_role;
grant execute on function private.visible_member_broadcast_ids()
  to authenticated, service_role;

drop policy member_broadcasts_read_authenticated on public.member_broadcasts;
create policy member_broadcasts_read_authenticated on public.member_broadcasts
  for select to authenticated
  using (id in (select private.visible_member_broadcast_ids()));

comment on policy member_broadcasts_read_authenticated on public.member_broadcasts is
  'Authenticated broadcast visibility is the exact can_read_member_broadcast audience predicate, evaluated once as a statement-scoped ID set: authenticated AAL2 caller, active selected-organization membership, organization audience or active chapter membership only.';

create or replace function public.get_steward_desk_kpis()
returns table (open_requests bigint, awaiting_reply bigint, broadcasts_30d bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  desk_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  return query
  select
    (select count(*) from public.member_steward_requests request where request.status <> 'closed'),
    (select count(*) from public.member_conversations conversation where (
      select message.sender_kind from public.member_messages message
      where message.conversation_id = conversation.id
      order by message.created_at desc, message.id desc
      limit 1) = 'member'),
    (select count(*) from public.member_broadcasts broadcast
     where broadcast.retracted_at is null
       and broadcast.published_at > now() - interval '30 days'
       and broadcast.organization_id is not null
       and broadcast.organization_id = desk_org);
end;
$function$;

revoke all on function public.get_steward_desk_kpis() from public, anon;
grant execute on function public.get_steward_desk_kpis() to authenticated, service_role;

drop function if exists private.steward_awaiting_reply_count();

comment on function private.visible_member_broadcast_ids() is
  'Set-wise exact equivalent of can_read_member_broadcast for broadcast RLS; not a client RPC.';

notify pgrst, 'reload schema';

commit;
