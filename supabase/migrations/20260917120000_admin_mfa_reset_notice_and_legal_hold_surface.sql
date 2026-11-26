-- REQ-UG-DORMANT-62-ADMIN-MFA-RESET-LEGAL-HOLD-20260917
--
-- A. Keep authorize_mfa_reset side-effect free and preserve SELF-RESET IS
-- REFUSED in both database authorities. The endpoint authenticates the caller,
-- calls authorize_mfa_reset, then retains begin_mfa_reset's durable session
-- boundary before any privileged Auth API call. The recovery-code and lock
-- reconciliation authorities are unchanged.
--
-- notify_member_mfa_reset uses the existing member_notifications path after
-- the same caller records the reset in member_admin_audit. It is deduplicated
-- against the recent audit timestamp under the shared graph lock.
--
-- B. Conversation legal hold.
--    public.place_member_message_legal_hold / release_member_message_legal_hold
--    (20260907121000, re-declared 20260907152000) have been reachable only from
--    SQL. The retention engine already excludes held conversations from
--    eligibility counts, previews and the run itself (private.retention_
--    eligible_count and private.perform_organization_retention_run both carry
--    `not private.member_message_under_legal_hold(...)`), and both RPCs write
--    `message.legal_hold_placed` / `message.legal_hold_released` to the
--    organization ledger. None of that changes here. What was missing is a
--    read surface the clients can build a marker and an admin control on:
--
--    * get_member_conversation_legal_holds(uuid[]) — for chapter staff who can
--      already see the conversation (the same private.staff_visible_member_ids
--      set the member_conversations steward policy uses). Returns whether a
--      hold is active; the reason code and placement time are disclosed only
--      to an organization admin, matching the table's admin-only SELECT policy.
--    * list_member_message_legal_holds() — the organization admin's list of
--      active preservation orders for the command center.
--    * list_legal_hold_conversations(text, integer) — the admin's metadata-only
--      conversation finder, so a hold can be placed from the command center
--      without assuming a steward hat.
--
-- Conventions: SECURITY DEFINER, empty search_path, EXECUTE revoked from
-- PUBLIC/anon/authenticated/service_role and re-granted to exactly
-- `authenticated`. Every caller gate goes through public.member_has_role,
-- which ANDs private.mfa_satisfied(), so the MFA assurance boundary covers
-- all four. The one writer (notify_member_mfa_reset) enters the case-graph
-- transaction gate first, as scripts/account-case-graph-inventory.mjs
-- requires of anything that writes a graph relation.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- Authorization only — no side effects, so a caller who abandons the flow
-- leaves no trace suggesting a reset happened.
--
-- SELF-RESET IS REFUSED, and that is the security-critical line here. Deleting
-- your own factors needs only an aal1 session, so an admin who could reset
-- themselves would hand any thief of an admin password a one-call MFA bypass —
-- the endpoint would become the very hole MFA is meant to close. An admin who
-- loses their own device is reset by another admin; the last admin standing
-- needs service-role SQL, which is the same escape hatch already documented for
-- minting the first admin.
create or replace function public.authorize_mfa_reset(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'target required' using errcode = '22023';
  end if;
  if p_user_id = caller then
    raise exception 'an admin cannot reset their own second factor' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.member_profiles p
    join public.chapters c on c.id = p.chapter_id
    where p.id = p_user_id and c.organization_id = private.current_member_organization()
  ) then
    raise exception 'unknown member' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'authorized', true);
end;
$$;

revoke all on function public.authorize_mfa_reset(uuid) from public, anon, authenticated, service_role;
grant execute on function public.authorize_mfa_reset(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- A2. Tell the member their second factor was reset.
-- ---------------------------------------------------------------------------
-- Called by api/admin-mfa-reset.js AS THE ADMIN, after record_mfa_reset has
-- written the audit row. The notice is bound to that row: without a reset
-- recorded by this caller for this member in the last fifteen minutes the
-- call refuses, and a second call for the same recorded reset writes nothing.
-- The same flat 42501 covers "not an admin", "yourself", "unknown member",
-- "member of another organization" and "no reset recorded" so the RPC is not
-- a membership oracle.
create function public.notify_member_mfa_reset(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  recorded_at timestamptz;
  member_lang text;
  notice_title text;
  notice_body text;
  inserted integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = caller then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  select max(a.created_at) into recorded_at
  from public.member_admin_audit a
  where a.actor = caller
    and a.target_user = p_user_id
    and a.action = 'reset_mfa'
    and a.created_at > pg_catalog.now() - interval '15 minutes';
  if recorded_at is null then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  -- Tenant-scoped like authorize_mfa_reset: record_mfa_reset (Main) accepts
  -- any auth.users id, so without this predicate an administrator of one
  -- organization could write this notice into a member of another
  -- organization's inbox. Same flat 42501 as every other refusal.
  select coalesce(p.language, 'en') into member_lang
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  where p.id = p_user_id
    and c.organization_id = private.current_member_organization();
  if member_lang is null then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  if member_lang = 'es' then
    notice_title := 'Un administrador restableció la verificación en dos pasos';
    notice_body := 'Un administrador quitó el autenticador de tu cuenta y cerró tus sesiones abiertas. Vuelve a configurar la verificación en dos pasos desde Ajustes. Si no lo pediste, contacta a tu oficina local de inmediato.';
  else
    notice_title := 'Two-step sign-in was reset by an administrator';
    notice_body := 'An administrator removed the authenticator from your account and signed out your open sessions. Set up two-step sign-in again from Settings. If you did not ask for this, contact your local office immediately.';
  end if;

  -- One notice per recorded reset. The titles are the two literals above, in
  -- either language, so a member who switched language between the reset and
  -- a retry still gets exactly one row.
  if exists (
    select 1 from public.member_notifications n
    where n.user_id = p_user_id
      and n.created_at >= recorded_at
      and n.title in ('Two-step sign-in was reset by an administrator',
                      'Un administrador restableció la verificación en dos pasos')
  ) then
    return pg_catalog.jsonb_build_object('userId', p_user_id, 'notified', false, 'duplicate', true);
  end if;

  insert into public.member_notifications (user_id, title, body, kind)
  values (p_user_id, notice_title, notice_body, 'general');
  get diagnostics inserted = row_count;

  return pg_catalog.jsonb_build_object('userId', p_user_id, 'notified', inserted = 1);
end;
$function$;

revoke all on function public.notify_member_mfa_reset(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.notify_member_mfa_reset(uuid) to authenticated;

comment on function public.notify_member_mfa_reset(uuid) is
  'Admin-gated, self-target refused: writes the member''s localized out-of-band notice for an admin-assisted MFA reset that record_mfa_reset already audited, exactly once per recorded reset.';

-- ---------------------------------------------------------------------------
-- B1. Hold status for staff who can see the conversation.
-- ---------------------------------------------------------------------------
create function public.get_member_conversation_legal_holds(p_conversation_ids uuid[])
returns table (
  conversation_id uuid,
  held boolean,
  reason_code text,
  placed_at timestamptz,
  can_manage boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  is_admin boolean;
begin
  caller := (select auth.uid());
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'admin']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_conversation_ids is null or pg_catalog.cardinality(p_conversation_ids) > 100 then
    raise exception 'at most 100 conversations per call' using errcode = '22023';
  end if;
  is_admin := public.member_has_role(array['admin']);

  return query
  select v.id,
         (h.conversation_id is not null),
         case when is_admin then h.reason_code end,
         case when is_admin then h.placed_at end,
         is_admin
  from public.member_conversations v
  left join public.member_message_legal_holds h
    on h.conversation_id = v.id and h.released_at is null
  where v.id = any(p_conversation_ids)
    and (
      (is_admin and coalesce(
        (select c.organization_id from public.member_profiles p join public.chapters c on c.id = p.chapter_id where p.id = v.user_id),
        h.organization_id
      ) = private.current_member_organization())
      or v.user_id in (select private.staff_visible_member_ids('steward'))
    )
  order by v.id;
end;
$function$;

revoke all on function public.get_member_conversation_legal_holds(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_member_conversation_legal_holds(uuid[]) to authenticated;

comment on function public.get_member_conversation_legal_holds(uuid[]) is
  'Preservation-order marker for chapter staff, limited to conversations the steward visibility set already exposes; reason and placement time are returned only to an organization admin.';

-- ---------------------------------------------------------------------------
-- B2. Active preservation orders for the admin command center.
-- ---------------------------------------------------------------------------
create function public.list_member_message_legal_holds()
returns table (
  conversation_id uuid,
  conversation_title text,
  member_name text,
  member_initials text,
  reason_code text,
  placed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
begin
  caller := (select auth.uid());
  org := (select private.current_member_organization());
  if caller is null or org is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  return query
  select h.conversation_id,
         v.title,
         p.full_name,
         p.initials,
         h.reason_code,
         h.placed_at
  from public.member_message_legal_holds h
  join public.member_conversations v on v.id = h.conversation_id
  left join public.member_profiles p on p.id = v.user_id
  where h.organization_id = org
    and h.released_at is null
  order by h.placed_at desc, h.conversation_id
  limit 100;
end;
$function$;

revoke all on function public.list_member_message_legal_holds()
  from public, anon, authenticated, service_role;
grant execute on function public.list_member_message_legal_holds() to authenticated;

comment on function public.list_member_message_legal_holds() is
  'Organization admin''s list of active preservation orders in their own tenant; carries the reason code and never message content.';

-- ---------------------------------------------------------------------------
-- B3. Conversation finder for placing a hold from the command center.
-- ---------------------------------------------------------------------------
-- Metadata only (member name, conversation title): an administrator need not
-- assume a steward hat to find the conversation a preservation order names.
-- Tenant-scoped through member_profiles -> chapters like the writers; 26 rows
-- per page so the client can tell "there is a next page" from 25. Search and
-- paging never touch message bodies.
create function public.list_legal_hold_conversations(
  p_search text default '',
  p_offset integer default 0
)
returns table (
  conversation_id uuid,
  conversation_title text,
  member_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
begin
  caller := (select auth.uid());
  org := (select private.current_member_organization());
  if caller is null or org is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 100000
     or pg_catalog.length(coalesce(p_search, '')) > 200 then
    raise exception 'invalid page' using errcode = '22023';
  end if;

  return query
  select v.id, v.title, p.full_name
  from public.member_conversations v
  join public.member_profiles p on p.id = v.user_id
  join public.chapters c on c.id = p.chapter_id
  where c.organization_id = org
    and (coalesce(p_search, '') = ''
         or p.full_name ilike '%' || p_search || '%'
         or v.title ilike '%' || p_search || '%')
  order by v.updated_at desc, v.id
  limit 26 offset p_offset;
end;
$function$;

revoke all on function public.list_legal_hold_conversations(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_legal_hold_conversations(text, integer) to authenticated;

comment on function public.list_legal_hold_conversations(text, integer) is
  'Organization admin''s metadata-only conversation finder (member name, title) for placing a preservation order; tenant-scoped, paged, never message content.';

notify pgrst, 'reload schema';

commit;
