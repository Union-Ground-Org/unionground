-- BUG-UG-MFA-RESET-PARTIAL-NO-MEMBER-NOTICE-20260917
--
-- THE DEFECT. Three paths through api/admin-mfa-reset.js finish a reset and
-- write the member no notice, and nothing durable records that one is owed:
--
--   1. a factor delete that fails partway returns 502 partial-reset — the
--      recovery boundary is already written, the member's sessions, web push
--      and native push installations are already closed, and some factors are
--      already gone — without ever calling notify_member_mfa_reset;
--   2. record_mfa_reset throwing returns 200 audited:false, notified:false
--      after every factor was deleted;
--   3. notify_member_mfa_reset throwing, or answering notified <> true,
--      returns 200 notified:false.
--
-- public.notify_member_mfa_reset (20260917120000) writes only when a
-- `reset_mfa` member_admin_audit row from the SAME caller for that member
-- exists within the last fifteen minutes, so after any of the three the notice
-- can only appear if an administrator notices a response flag and reruns the
-- whole reset inside that window. A member whose authenticator was removed and
-- whose sessions were closed — the member who did not ask for the reset is
-- exactly who this notice exists for — is left with no out-of-band signal.
--
-- THE SHAPE. The reset already has a durable, one-row-per-member record of
-- itself: private.member_mfa_reset_boundaries (20260901153738), written by
-- begin_mfa_reset before any factor can disappear and carrying the reset
-- instant (invalid_before) and the administrator who ran it (reset_by). The
-- owed notice is therefore two timestamps on that row rather than a new table:
--
--   notice_owed_at  — the reset instant a member notice is owed for. THE RESET
--                     THE ROW BELONGS TO, so the debt survives the fifteen-
--                     minute audit window; it is never cleared, only overtaken.
--   notice_sent_at  — when that debt was discharged. A row is pending exactly
--                     while notice_owed_at is not null and notice_sent_at is
--                     null or older than notice_owed_at.
--
-- and two RPCs, deliberately in separate transactions:
--
--   public.queue_member_mfa_reset_notice(uuid) marks the debt and returns;
--   public.drain_member_mfa_reset_notice(uuid) delivers it, once.
--
-- They are NOT one function. A mark and a delivery in one transaction commit
-- or roll back together, which is precisely the durability the record asks for
-- and would not get: the pending row has to outlive a delivery that never
-- happens. So the endpoint marks first, then drains, and a mark whose drain
-- never ran is drained by the next reset for that member — the retry the
-- record names. The drain is not bound to the administrator who failed: any
-- administrator of the member's own organization can discharge the debt,
-- because the member is owed the notice regardless of who could not send it.
--
-- NO SECOND NOTICE. The drain keeps notify_member_mfa_reset's own guard —
-- one notice per reset, recognized by the two localized titles — but anchors
-- it on the boundary instead of the audit row: a notice already written for
-- this reset by notify_member_mfa_reset, or by an earlier drain, settles the
-- row and writes nothing. The anchor is the reset instant, which precedes the
-- audit row, so it sees every notice the audit-anchored guard would see.
--
-- WHY THE DRAIN MAY WRITE WITHOUT AN AUDIT ROW. Path 2 has no audit row and
-- never will; refusing the notice there is what the defect IS. The notice is
-- not left without a trail: private.member_mfa_reset_boundaries names the
-- administrator (reset_by), the reset instant and the delivery instant, and
-- the retention/export manifest already classifies both of its identity
-- columns. member_admin_audit remains the audit trail of what an administrator
-- DID; this is the record of what the member was OWED.
--
-- Conventions: SECURITY DEFINER, empty search_path, every call pg_catalog- or
-- schema-qualified, EXECUTE revoked from PUBLIC/anon/authenticated/service_role
-- and re-granted to exactly `authenticated`. Both writers enter the case-graph
-- transaction gate first (private.member_mfa_reset_boundaries and
-- public.member_notifications are both graph relations), as
-- scripts/account-case-graph-inventory.mjs requires. Both gate on
-- public.member_has_role, which ANDs private.mfa_satisfied(), refuse a
-- self-target, and resolve the member through the caller's own organization
-- with the same tenant predicate authorize_mfa_reset, begin_mfa_reset and
-- record_mfa_reset use (20260917120000, 20260917130000) — with the same flat
-- 42501 for every refusal, so neither RPC is a membership oracle.
--
-- No existing function is re-declared and no shipped migration is edited.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- A. The owed notice, on the row that already records the reset.
-- ---------------------------------------------------------------------------
-- clock_timestamp(), not now(): invalid_before is written with
-- clock_timestamp() by begin_mfa_reset, and a delivery stamped with the
-- transaction clock could compare as older than the reset it discharges.
alter table private.member_mfa_reset_boundaries
  add column notice_owed_at timestamptz,
  add column notice_sent_at timestamptz;

comment on column private.member_mfa_reset_boundaries.notice_owed_at is
  'Reset instant (invalid_before) a member MFA-reset notice is owed for. Durable: it outlives the fifteen-minute member_admin_audit window public.notify_member_mfa_reset requires.';
comment on column private.member_mfa_reset_boundaries.notice_sent_at is
  'When the owed notice was discharged, by delivery or by recognising the notice public.notify_member_mfa_reset already wrote. Older than notice_owed_at means still pending.';

-- ---------------------------------------------------------------------------
-- B. Mark the notice owed — durable, and nothing else.
-- ---------------------------------------------------------------------------
-- Called by api/admin-mfa-reset.js AS THE ADMINISTRATOR on every path that
-- ends without a delivered notice. Bound to a reset this caller actually
-- began: begin_mfa_reset wrote the boundary row and named itself in reset_by,
-- so there is no way to mint a debt for a member nobody reset.
create function public.queue_member_mfa_reset_notice(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  owed_at timestamptz;
  sent_at timestamptz;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = caller then
    raise exception 'invalid target' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.member_profiles p
    join public.chapters c on c.id = p.chapter_id
    where p.id = p_user_id
      and c.organization_id = private.current_member_organization()
  ) then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  select b.invalid_before, b.notice_sent_at into owed_at, sent_at
  from private.member_mfa_reset_boundaries b
  where b.user_id = p_user_id
    and b.reset_by = caller
  for update;
  if not found then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  -- Idempotent: the mark is the reset instant itself, so a second call for the
  -- same reset re-writes the same value and cannot un-discharge a delivered
  -- notice — notice_sent_at is what settles it, and it is left alone here.
  update private.member_mfa_reset_boundaries
  set notice_owed_at = owed_at
  where user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'userId', p_user_id,
    'resetAt', owed_at,
    'pending', sent_at is null or sent_at < owed_at);
end;
$function$;

revoke all on function public.queue_member_mfa_reset_notice(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.queue_member_mfa_reset_notice(uuid) to authenticated;

comment on function public.queue_member_mfa_reset_notice(uuid) is
  'Admin-gated, tenant-scoped, self-target refused: durably records that the member is owed an MFA-reset notice for the reset this administrator began, without sending anything.';

-- ---------------------------------------------------------------------------
-- C. Deliver the owed notice, exactly once.
-- ---------------------------------------------------------------------------
-- Separate transaction, separate call: this is what a retry drains. Any
-- administrator of the member's own organization may run it; the member is
-- owed the notice regardless of which administrator's reset could not send it.
create function public.drain_member_mfa_reset_notice(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  owed_at timestamptz;
  sent_at timestamptz;
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

  select coalesce(p.language, 'en') into member_lang
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  where p.id = p_user_id
    and c.organization_id = private.current_member_organization();
  if member_lang is null then
    raise exception 'invalid target' using errcode = '42501';
  end if;

  select b.notice_owed_at, b.notice_sent_at into owed_at, sent_at
  from private.member_mfa_reset_boundaries b
  where b.user_id = p_user_id
  for update;
  -- Nothing owed is the ordinary answer on a reset that notified normally;
  -- it is not an error and says nothing a caller could not already ask for.
  if not found or owed_at is null or (sent_at is not null and sent_at >= owed_at) then
    return pg_catalog.jsonb_build_object(
      'userId', p_user_id, 'drained', false, 'notified', false, 'pending', false);
  end if;

  if member_lang = 'es' then
    notice_title := 'Un administrador restableció la verificación en dos pasos';
    notice_body := 'Un administrador quitó el autenticador de tu cuenta y cerró tus sesiones abiertas. Vuelve a configurar la verificación en dos pasos desde Ajustes. Si no lo pediste, contacta a tu oficina local de inmediato.';
  else
    notice_title := 'Two-step sign-in was reset by an administrator';
    notice_body := 'An administrator removed the authenticator from your account and signed out your open sessions. Set up two-step sign-in again from Settings. If you did not ask for this, contact your local office immediately.';
  end if;

  -- One notice per reset, the same guard and the same two titles
  -- public.notify_member_mfa_reset applies, anchored on the reset instead of
  -- the audit row: whichever writer got there first, the debt is discharged
  -- and no second notice is written.
  if exists (
    select 1 from public.member_notifications n
    where n.user_id = p_user_id
      and n.created_at >= owed_at
      and n.title in ('Two-step sign-in was reset by an administrator',
                      'Un administrador restableció la verificación en dos pasos')
  ) then
    update private.member_mfa_reset_boundaries
    set notice_sent_at = pg_catalog.clock_timestamp()
    where user_id = p_user_id;
    return pg_catalog.jsonb_build_object(
      'userId', p_user_id, 'drained', true, 'notified', false,
      'duplicate', true, 'pending', false);
  end if;

  insert into public.member_notifications (user_id, title, body, kind)
  values (p_user_id, notice_title, notice_body, 'general');
  get diagnostics inserted = row_count;

  update private.member_mfa_reset_boundaries
  set notice_sent_at = pg_catalog.clock_timestamp()
  where user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'userId', p_user_id, 'drained', true, 'notified', inserted = 1, 'pending', false);
end;
$function$;

revoke all on function public.drain_member_mfa_reset_notice(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.drain_member_mfa_reset_notice(uuid) to authenticated;

comment on function public.drain_member_mfa_reset_notice(uuid) is
  'Admin-gated, tenant-scoped, self-target refused: delivers the member''s owed MFA-reset notice once, keeping the one-notice-per-reset guard, and settles the pending row whether it wrote the notice or found it already written.';

notify pgrst, 'reload schema';

commit;
