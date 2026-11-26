-- REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001
-- REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001
--
-- Restore-everything campaign, GOVERNANCE. Two governance functions
-- the 2026-07-21 clean-room rewrite dropped (git ref de7df4b57c^).
--
-- ===========================================================================
-- 1. Chapter leadership recovery
-- ===========================================================================
-- Old app: lib/chapter-takeover/policy.ts (evaluateChapterTakeover,
-- TAKEOVER_INACTIVITY_MONTHS = 6 at line 4, CHAPTER_CONTROL_ROLES admin and
-- steward at line 5) and app/dashboard/chapters/[code]/takeover-actions.ts
-- (2026-07-08). An active, dues-counted member of a chapter could claim chapter
-- admin when every chapter admin and steward had no activity for six months.
-- The old grant was instant (members.role:= 'admin').
--
-- Restored with a safer shape (self-promotion is security sensitive):
--   * The caller must hold an MFA-assured session (AAL2), not only satisfy the
--     MFA floor. The old action already refused PIN sessions
--     (requireNonPinMember).
--   * Eligibility is computed here, server-side, from real activity: auth
--     sign-ins (auth.users.last_sign_in_at), live session refreshes
--     (auth.sessions), presence heartbeats, the role grant itself, and
--     authored work (member_admin_audit, member_case_updates, organization and
--     casework audit events). There is no per-user page-view log and none is
--     added. A leader whose account or role is newer than the window counts as
--     active, like the old createdAt floor.
--   * "Dues-counted": the current product has no guest or non-member tier
--     (every account is invited into an organization), so a counted member is
--     an active organization member with an active membership in the chapter.
--   * Leaders are the chapter's admins and stewards, plus organization admins
--     and stewards who are active members of the chapter (an organization
--     role acts in the chapter through private.member_has_chapter_role).
--   * One claim per chapter at a time (partial unique index), and a claimant
--     whose claim for the chapter was rejected waits 30 days to claim again.
--   * A chapter younger than the inactivity window cannot be claimed. The old
--     policy treated a chapter with no leaders as claimable at once; a brand
--     new chapter has no leaders yet, so that path is closed until the chapter
--     has existed for the whole window.
--   * NEW (safer than the old instant grant): organization admins are notified
--     immediately and have a cooling-off window (default 72 hours) to reject
--     the claim. Only after the window does private.finalize_due_chapter_
--     leadership_claims, run every 15 minutes by pg_cron, re-check
--     eligibility and grant the chapter admin role with the same writes and
--     audit row public.set_member_chapter_role performs (member_roles,
--     member_role_chapters, member_admin_audit 'grant_role' with role and
--     chapterId), under the same organization-role advisory lock. A claim
--     whose chapter no longer qualifies lapses instead.
--   * Every step is recorded: the claim row keeps who claimed, when, the
--     window, the inactive-leader count and who decided what and when; the
--     grant writes the standard role audit row (it appears in the member's
--     access history as a chapter role grant).
--
-- Switch features.governance.chapter_leadership_recovery: the old app had no
-- flag (lib/settings/settings-keys.ts has no takeover key; the action ran for
-- every chapter), so the default is ON, with the cooling-off window.
-- limits.governance.leadership_inactivity_months: old policy.ts:4 = 6.
-- limits.governance.leadership_claim_cooling_off_hours: new safeguard, 72.
--
-- ===========================================================================
-- 2. Officer removal ballots
-- ===========================================================================
-- Old app: supabase/migrations/0618_controller_removal_ballots.sql and
-- lib/voting/controller-removal.ts (SEC-controller-removal-cross-tenant-target
-- -20260708). A ballot type that names an officer and a reason (at least 10
-- characters), fixed options "remove" / "do not remove", and a staff-recorded
-- result "removed" or "retained". Nothing is demoted automatically.
--
-- Extends the current member_ballots model:
--   * ballot_type ('standard' | 'officer_removal'), the target officer (an
--     auth user, set null if the account is deleted), a snapshot of the
--     officer's name and role when the ballot was drafted, the reason, and
--     the recorded outcome with who recorded it and when.
--   * Tenant-scope check, server-side, from fresh rows (never client input):
--     a chapter ballot may name only someone holding a staff role in that
--     chapter; an organization-wide ballot may name someone holding an
--     organization staff role or a chapter staff role in one of its chapters.
--     The target must be an active member of the ballot's organization when
--     the draft is saved and again when the outcome is recorded.
--   * Drafts are written only by public.save_officer_removal_ballot_draft; a
--     trigger keeps their two options fixed, so the generic campaign editor
--     cannot rewrite them. Publishing and closing use the existing campaign
--     RPCs; a trigger refuses to open one while the switch is off.
--   * public.record_officer_removal_outcome records "removed" or "retained"
--     once, after voting has ended, by staff who manage the campaign.
--
-- Switch features.governance.officer_removal_ballots: old
-- 0618_controller_removal_ballots.sql:8 seeded controller_removal_enabled
-- 'true' => ON.
--
-- Boundaries kept: every RPC is SECURITY DEFINER with an empty search_path,
-- derives the organization and chapter from the session, and enters through
-- private.lock_case_graph when it writes. The new table has RLS, the MFA floor
-- and no client grant. No production rows are written except platform
-- definitions and notification copy.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. Switches and limits (admin page: Governance)
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- No old flag (de7df4b57c^ lib/settings/settings-keys.ts); the old takeover
  -- ran for every chapter => ON, now with the cooling-off window below.
  ('features.governance.chapter_leadership_recovery', 'boolean', 'Chapter leadership recovery',
   'An active chapter member may claim chapter admin when every chapter admin and steward has been inactive. Organization admins can reject the claim during the cooling-off window.',
   'true', null, null, null, 10, 'governance', true),
  -- Old lib/chapter-takeover/policy.ts:4 TAKEOVER_INACTIVITY_MONTHS = 6.
  ('limits.governance.leadership_inactivity_months', 'integer', 'Leader inactivity before a claim (months)',
   'Chapter admins and stewards count as inactive after this many months with no sign-in, session or authored activity.',
   '6', 3, 24, null, 20, 'governance', true),
  -- New safeguard (the old grant was instant): 72 hours.
  ('limits.governance.leadership_claim_cooling_off_hours', 'integer', 'Leadership claim cooling-off (hours)',
   'How long organization admins have to reject a chapter leadership claim before the chapter admin role takes effect.',
   '72', 24, 336, null, 30, 'governance', true),
  -- Old 0618_controller_removal_ballots.sql:8 controller_removal_enabled 'true'.
  ('features.governance.officer_removal_ballots', 'boolean', 'Officer removal ballots',
   'Staff can run a ballot on removing a named officer, with a reason. Staff record the result; nobody is removed automatically.',
   'true', null, null, null, 40, 'governance', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Chapter leadership claims
-- ---------------------------------------------------------------------------

create table public.chapter_leadership_claims (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  claimant_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  inactivity_months integer not null,
  cooling_off_hours integer not null,
  inactive_leader_count integer not null,
  activity_cutoff timestamptz not null,
  claimed_at timestamptz not null default pg_catalog.now(),
  effective_at timestamptz not null,
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  decision_note text,
  lapse_reason text,
  constraint chapter_leadership_claims_status_check
    check (status in ('pending', 'granted', 'rejected', 'withdrawn', 'lapsed')),
  constraint chapter_leadership_claims_window_check
    check (inactivity_months between 1 and 120 and cooling_off_hours between 1 and 2000
      and inactive_leader_count >= 0 and effective_at > claimed_at and activity_cutoff < claimed_at),
  constraint chapter_leadership_claims_decision_shape
    check ((status = 'pending') = (decided_at is null)),
  constraint chapter_leadership_claims_note_bounded
    check (decision_note is null or (pg_catalog.char_length(decision_note) between 1 and 1000
      and decision_note !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')),
  constraint chapter_leadership_claims_lapse_reason
    check ((status = 'lapsed') = (lapse_reason is not null)
      and (lapse_reason is null or lapse_reason in (
        'disabled', 'not_member', 'already_leader', 'chapter_too_new',
        'active_leader_present', 'chapter_unavailable', 'recently_rejected', 'claim_pending')))
);

-- One open claim per chapter at a time.
create unique index chapter_leadership_claims_one_pending_idx
  on public.chapter_leadership_claims (chapter_id) where status = 'pending';
create index chapter_leadership_claims_organization_idx
  on public.chapter_leadership_claims (organization_id, status, claimed_at desc);
create index chapter_leadership_claims_claimant_idx
  on public.chapter_leadership_claims (claimant_user_id, chapter_id, claimed_at desc);
create index chapter_leadership_claims_due_idx
  on public.chapter_leadership_claims (effective_at) where status = 'pending';

alter table public.chapter_leadership_claims enable row level security;

create policy mfa_assurance on public.chapter_leadership_claims
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy chapter_leadership_claims_select_own on public.chapter_leadership_claims
  for select to authenticated
  using ((select auth.uid()) = claimant_user_id);

comment on policy mfa_assurance on public.chapter_leadership_claims is
  'Restrictive MFA floor every RLS table carries.';
comment on policy chapter_leadership_claims_select_own on public.chapter_leadership_claims is
  'Self-only read of a claimant''s own claims. Defense in depth: the table has no client grant; the leadership recovery RPCs are the only readers and writers.';

revoke all on public.chapter_leadership_claims from public, anon, authenticated, service_role;

comment on table public.chapter_leadership_claims is
  'REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001. A member''s claim to chapter admin after every chapter admin and steward was inactive. Pending for a cooling-off window in which organization admins can reject it; then granted (through set_member_chapter_role''s writes) or lapsed. The row is the governance record of the claim; no client grant.';

create trigger a00_case_graph_lock before insert or update or delete on public.chapter_leadership_claims
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_leadership_claims
for each row execute function private.lock_case_graph_row_keys('{claimant_user_id},{decided_by}', '');

-- A claim moves once, from pending to one final state; its evidence never
-- changes. Account deletion may still null decided_by (ON DELETE SET NULL).
create function private.guard_chapter_leadership_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.chapter_id is distinct from old.chapter_id
     or new.claimant_user_id is distinct from old.claimant_user_id
     or new.inactivity_months is distinct from old.inactivity_months
     or new.cooling_off_hours is distinct from old.cooling_off_hours
     or new.inactive_leader_count is distinct from old.inactive_leader_count
     or new.activity_cutoff is distinct from old.activity_cutoff
     or new.claimed_at is distinct from old.claimed_at
     or new.effective_at is distinct from old.effective_at then
    raise exception 'leadership claim evidence is immutable' using errcode = '42501';
  end if;
  if old.status <> 'pending' and (
       new.status is distinct from old.status
       or new.decided_at is distinct from old.decided_at
       or new.decision_note is distinct from old.decision_note
       or new.lapse_reason is distinct from old.lapse_reason
       or (new.decided_by is not null and new.decided_by is distinct from old.decided_by)) then
    raise exception 'leadership claim is already decided' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create trigger b10_chapter_leadership_claim_guard
  before update on public.chapter_leadership_claims
  for each row execute function private.guard_chapter_leadership_claim();

-- Real activity of one chapter leader after the cutoff. Every source is the
-- leader's own sign-in, session, presence, role grant or authored work; the
-- organization- and chapter-scoped audit sources read their scoped indexes.
create function private.chapter_leader_active_since(
  p_user_id uuid,
  p_organization_id uuid,
  p_chapter_id text,
  p_cutoff timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
      select 1 from auth.users u
      where u.id = p_user_id
        and (u.last_sign_in_at > p_cutoff or u.created_at > p_cutoff)
    )
    or exists (
      select 1 from auth.sessions s
      where s.user_id = p_user_id
        and (s.created_at > p_cutoff or s.updated_at > p_cutoff
          or s.refreshed_at > (p_cutoff at time zone 'UTC'))
    )
    or exists (
      select 1 from public.member_presence presence
      where presence.user_id = p_user_id and presence.last_seen_at > p_cutoff
    )
    or exists (
      select 1 from public.member_role_chapters rc
      where rc.user_id = p_user_id and rc.chapter_id = p_chapter_id
        and rc.role in ('admin', 'steward') and rc.granted_at > p_cutoff
    )
    or exists (
      select 1 from public.organization_role_grants grant_row
      where grant_row.user_id = p_user_id
        and grant_row.organization_id = p_organization_id
        and grant_row.role in ('admin', 'steward')
        and grant_row.granted_at > p_cutoff
    )
    or exists (
      select 1 from public.member_admin_audit a
      where a.actor = p_user_id and a.created_at > p_cutoff
    )
    or exists (
      select 1 from public.member_case_updates cu
      where cu.author_user_id = p_user_id and cu.created_at > p_cutoff
    )
    or exists (
      select 1 from public.organization_audit_events e
      where e.organization_id = p_organization_id and e.created_at > p_cutoff
        and e.actor_user_id = p_user_id
    )
    or exists (
      select 1 from public.casework_audit_events e
      where e.organization_id = p_organization_id and e.chapter_id = p_chapter_id
        and e.created_at > p_cutoff and e.actor_user_id = p_user_id
    );
$function$;

-- The one eligibility authority (claim, read and the cron re-check). Reasons:
-- chapter_unavailable, disabled, not_member, already_leader, claim_pending,
-- recently_rejected, chapter_too_new, active_leader_present, eligible.
-- p_for_claim names the pending claim being finalized, so it does not block
-- itself.
create function private.chapter_leadership_recovery_state(
  p_user_id uuid,
  p_chapter_id text,
  p_for_claim uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  chapter_row record;
  months integer;
  hours integer;
  cutoff timestamptz;
  leader_count integer := 0;
  active_count integer := 0;
  reason text;
begin
  select c.id, c.name, c.organization_id, c.created_at into chapter_row
  from public.chapters c
  where c.id = p_chapter_id;
  if not found or chapter_row.organization_id is null then
    return pg_catalog.jsonb_build_object('eligible', false, 'reason', 'chapter_unavailable');
  end if;

  months := private.organization_limit(chapter_row.organization_id, 'limits.governance.leadership_inactivity_months');
  hours := private.organization_limit(chapter_row.organization_id, 'limits.governance.leadership_claim_cooling_off_hours');
  cutoff := pg_catalog.now() - pg_catalog.make_interval(months => months);

  if not private.organization_feature_enabled(chapter_row.organization_id, 'features.governance.chapter_leadership_recovery') then
    reason := 'disabled';
  elsif not exists (
      select 1 from public.organization_memberships om
      where om.organization_id = chapter_row.organization_id and om.user_id = p_user_id and om.status = 'active'
    ) or not exists (
      select 1 from public.member_chapter_memberships m
      where m.user_id = p_user_id and m.chapter_id = p_chapter_id and m.status = 'active'
    ) then
    reason := 'not_member';
  elsif exists (
      select 1 from public.member_role_chapters rc
      where rc.user_id = p_user_id and rc.chapter_id = p_chapter_id and rc.role in ('admin', 'steward')
    ) or exists (
      select 1 from public.organization_role_grants grant_row
      where grant_row.organization_id = chapter_row.organization_id and grant_row.user_id = p_user_id
        and grant_row.role in ('admin', 'steward')
    ) then
    reason := 'already_leader';
  elsif exists (
      select 1 from public.chapter_leadership_claims claim
      where claim.chapter_id = p_chapter_id and claim.status = 'pending'
        and claim.id is distinct from p_for_claim
    ) then
    reason := 'claim_pending';
  elsif exists (
      select 1 from public.chapter_leadership_claims claim
      where claim.chapter_id = p_chapter_id and claim.claimant_user_id = p_user_id
        and claim.status = 'rejected' and claim.decided_at > pg_catalog.now() - interval '30 days'
    ) then
    reason := 'recently_rejected';
  elsif chapter_row.created_at > cutoff then
    reason := 'chapter_too_new';
  else
    select pg_catalog.count(*)::integer,
      pg_catalog.count(*) filter (
        where private.chapter_leader_active_since(leader.user_id, chapter_row.organization_id, p_chapter_id, cutoff)
      )::integer
    into leader_count, active_count
    from (
      -- Chapter admins and stewards of this chapter, plus organization admins
      -- and stewards who are active members of it (private.member_has_chapter_role
      -- lets an organization role act in the chapter).
      select rc.user_id
      from public.member_role_chapters rc
      where rc.chapter_id = p_chapter_id and rc.role in ('admin', 'steward')
      union
      select grant_row.user_id
      from public.organization_role_grants grant_row
      where grant_row.organization_id = chapter_row.organization_id and grant_row.role in ('admin', 'steward')
    ) leader
    where exists (
        select 1 from public.member_chapter_memberships m
        where m.user_id = leader.user_id and m.chapter_id = p_chapter_id and m.status = 'active'
      )
      and exists (
        select 1 from public.organization_memberships om
        where om.user_id = leader.user_id and om.organization_id = chapter_row.organization_id and om.status = 'active'
      );
    reason := case when active_count > 0 then 'active_leader_present' else 'eligible' end;
  end if;

  return pg_catalog.jsonb_build_object(
    'eligible', reason = 'eligible',
    'reason', reason,
    'organizationId', chapter_row.organization_id,
    'chapterId', chapter_row.id,
    'chapterName', chapter_row.name,
    'inactivityMonths', months,
    'coolingOffHours', hours,
    'activityCutoff', cutoff,
    'inactiveLeaderCount', case when reason = 'eligible' then leader_count else null end
  );
end;
$function$;

create function private.chapter_leadership_claim_json(p_claim public.chapter_leadership_claims)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_claim.id,
    'chapterId', p_claim.chapter_id,
    'status', p_claim.status,
    'claimedAt', p_claim.claimed_at,
    'effectiveAt', p_claim.effective_at,
    'decidedAt', p_claim.decided_at,
    'decisionNote', p_claim.decision_note,
    'lapseReason', p_claim.lapse_reason,
    'inactiveLeaderCount', p_claim.inactive_leader_count,
    'inactivityMonths', p_claim.inactivity_months,
    'coolingOffHours', p_claim.cooling_off_hours
  );
$function$;

-- Active organization admins of an organization, for review notices.
create function private.organization_admin_recipients(p_organization_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select distinct grant_row.user_id
  from public.organization_role_grants grant_row
  join public.organization_memberships membership
    on membership.organization_id = grant_row.organization_id
   and membership.user_id = grant_row.user_id
   and membership.status = 'active'
  where grant_row.organization_id = p_organization_id
    and grant_row.role = 'admin';
$function$;

insert into private.notification_copy (key, lang, title, body) values
  ('governance.leadership_claim.submitted', 'en', 'Chapter leadership claim to review',
   'A member claimed chapter admin for {chapter} because its leaders have been inactive. It takes effect in {hours} hours unless an organization admin rejects it under Admin, Governance.'),
  ('governance.leadership_claim.submitted', 'es', 'Solicitud de liderazgo de capítulo por revisar',
   'Un miembro solicitó ser administrador del capítulo {chapter} porque sus líderes estuvieron inactivos. Entra en vigor en {hours} horas salvo que un administrador de la organización la rechace en Administración, Gobernanza.'),
  ('governance.leadership_claim.rejected', 'en', 'Chapter leadership claim not approved',
   'An organization admin rejected your claim to lead {chapter}.'),
  ('governance.leadership_claim.rejected', 'es', 'Solicitud de liderazgo no aprobada',
   'Un administrador de la organización rechazó tu solicitud para dirigir {chapter}.'),
  ('governance.leadership_claim.granted', 'en', 'You are now a chapter admin',
   'Your claim to lead {chapter} took effect. You now hold the chapter admin role.'),
  ('governance.leadership_claim.granted', 'es', 'Ahora eres administrador del capítulo',
   'Tu solicitud para dirigir {chapter} entró en vigor. Ahora tienes el rol de administrador del capítulo.'),
  ('governance.leadership_claim.granted_admins', 'en', 'Chapter leadership claim took effect',
   'A member became chapter admin of {chapter} after the cooling-off window ended.'),
  ('governance.leadership_claim.granted_admins', 'es', 'Una solicitud de liderazgo entró en vigor',
   'Un miembro pasó a ser administrador del capítulo {chapter} al terminar el periodo de espera.'),
  ('governance.leadership_claim.lapsed', 'en', 'Chapter leadership claim closed',
   'Your claim to lead {chapter} did not take effect because the chapter no longer qualifies.'),
  ('governance.leadership_claim.lapsed', 'es', 'Solicitud de liderazgo cerrada',
   'Tu solicitud para dirigir {chapter} no entró en vigor porque el capítulo ya no cumple las condiciones.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- Member read: the caller's selected chapter only.
create function public.get_chapter_leadership_recovery()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  org uuid := private.current_member_organization();
  state jsonb;
  latest public.chapter_leadership_claims%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if chapter is null or org is null or not private.is_organization_member(org) then
    return pg_catalog.jsonb_build_object('available', false, 'eligible', false, 'reason', 'chapter_unavailable', 'claim', null);
  end if;

  state := private.chapter_leadership_recovery_state(caller, chapter, null);

  select * into latest
  from public.chapter_leadership_claims claim
  where claim.claimant_user_id = caller and claim.chapter_id = chapter
    and (claim.status = 'pending' or claim.decided_at > pg_catalog.now() - interval '30 days')
  order by claim.claimed_at desc
  limit 1;

  return (state - 'organizationId' - 'activityCutoff') || pg_catalog.jsonb_build_object(
    'available', state ->> 'reason' <> 'disabled',
    'mfaAssured', coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2',
    'claim', case when latest.id is null then null else private.chapter_leadership_claim_json(latest) end
  );
end;
$function$;

create function public.claim_chapter_leadership(p_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  state jsonb;
  saved public.chapter_leadership_claims%rowtype;
  recipient uuid;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- MFA-assured: an AAL2 session, not only the factor-absent MFA floor.
  if not private.mfa_satisfied() or coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2' then
    raise exception 'two-step sign-in required' using errcode = '42501';
  end if;
  if p_chapter_id is null or p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter unavailable' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('chapter-leadership-claim:' || p_chapter_id, 509));

  state := private.chapter_leadership_recovery_state(caller, p_chapter_id, null);
  if not coalesce((state ->> 'eligible')::boolean, false) then
    raise exception 'leadership claim unavailable: %', state ->> 'reason' using errcode = '22023';
  end if;

  insert into public.chapter_leadership_claims (
    organization_id, chapter_id, claimant_user_id, inactivity_months, cooling_off_hours,
    inactive_leader_count, activity_cutoff, claimed_at, effective_at
  ) values (
    (state ->> 'organizationId')::uuid, p_chapter_id, caller,
    (state ->> 'inactivityMonths')::integer, (state ->> 'coolingOffHours')::integer,
    (state ->> 'inactiveLeaderCount')::integer, (state ->> 'activityCutoff')::timestamptz,
    pg_catalog.now(),
    pg_catalog.now() + pg_catalog.make_interval(hours => (state ->> 'coolingOffHours')::integer)
  )
  returning * into saved;

  -- Organization admins are told at once; the claimant is never one of them
  -- (an organization admin does not need this path).
  for recipient in select r from private.organization_admin_recipients(saved.organization_id) r loop
    if recipient is distinct from caller then
      perform private.notify_member(recipient, 'governance.leadership_claim.submitted',
        pg_catalog.jsonb_build_object('chapter', state ->> 'chapterName', 'hours', saved.cooling_off_hours::text),
        'general');
    end if;
  end loop;

  return private.chapter_leadership_claim_json(saved);
end;
end;
$function$;

create function public.withdraw_chapter_leadership_claim(p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  saved public.chapter_leadership_claims%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  update public.chapter_leadership_claims claim
  set status = 'withdrawn', decided_at = pg_catalog.now(), decided_by = caller
  where claim.id = p_claim_id and claim.claimant_user_id = caller and claim.status = 'pending'
  returning * into saved;
  if not found then
    raise exception 'claim not found' using errcode = 'P0002';
  end if;
  return private.chapter_leadership_claim_json(saved);
end;
end;
$function$;

-- Organization admin review list for the selected organization.
create function public.list_chapter_leadership_claims(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();
declare
  org uuid := private.current_member_organization();
  cap integer := coalesce(p_limit, 50);
  items jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if org is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if cap not between 1 and 200 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(row_data order by pending_first, claimed_at desc, id), '[]'::jsonb)
  into items
  from (
    select claim.id, claim.claimed_at,
      case when claim.status = 'pending' then 0 else 1 end as pending_first,
      private.chapter_leadership_claim_json(claim) || pg_catalog.jsonb_build_object(
        'chapterName', chapter_row.name,
        'claimantName', coalesce(claimant.full_name, 'Former member'),
        'decidedByName', case when claim.decided_by is null then null else coalesce(decider.full_name, 'Former member') end
      ) as row_data
    from public.chapter_leadership_claims claim
    join public.chapters chapter_row on chapter_row.id = claim.chapter_id
    left join public.member_profiles claimant on claimant.id = claim.claimant_user_id
    left join public.member_profiles decider on decider.id = claim.decided_by
    where claim.organization_id = org
      and (claim.status = 'pending' or claim.claimed_at > pg_catalog.now() - interval '180 days')
    order by case when claim.status = 'pending' then 0 else 1 end, claim.claimed_at desc, claim.id
    limit cap
  ) bounded;

  return pg_catalog.jsonb_build_object(
    'items', items,
    'enabled', private.organization_feature_enabled(org, 'features.governance.chapter_leadership_recovery'),
    'inactivityMonths', private.organization_limit(org, 'limits.governance.leadership_inactivity_months'),
    'coolingOffHours', private.organization_limit(org, 'limits.governance.leadership_claim_cooling_off_hours')
  );
end;

end;
$function$;

create function public.reject_chapter_leadership_claim(p_claim_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  saved public.chapter_leadership_claims%rowtype;
  chapter_name text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if org is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if note is not null and (pg_catalog.char_length(note) > 1000 or note ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]') then
    raise exception 'invalid note' using errcode = '22023';
  end if;

  update public.chapter_leadership_claims claim
  set status = 'rejected', decided_at = pg_catalog.now(), decided_by = caller, decision_note = note
  where claim.id = p_claim_id and claim.organization_id = org and claim.status = 'pending'
  returning * into saved;
  if not found then
    raise exception 'claim not found' using errcode = 'P0002';
  end if;

  select c.name into chapter_name from public.chapters c where c.id = saved.chapter_id;
  perform private.notify_member(saved.claimant_user_id, 'governance.leadership_claim.rejected',
    pg_catalog.jsonb_build_object('chapter', coalesce(chapter_name, saved.chapter_id)), 'general');
  return private.chapter_leadership_claim_json(saved);
end;
end;
$function$;

-- pg_cron target: grant or lapse claims whose cooling-off window has ended.
-- The grant performs public.set_member_chapter_role's enable branch (same
-- organization-role advisory lock, same membership re-checks, same three
-- writes); the audit actor is NULL because the system applies the grant after
-- the window, and detail.source names the claim.
create function private.finalize_due_chapter_leadership_claims(p_limit integer default 50)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  claim public.chapter_leadership_claims%rowtype;
  state jsonb;
  chapter_name text;
  recipient uuid;
  processed integer := 0;
begin
  for claim in
    select * from public.chapter_leadership_claims pending
    where pending.status = 'pending' and pending.effective_at <= pg_catalog.now()
    order by pending.effective_at, pending.id
    limit greatest(1, least(coalesce(p_limit, 50), 500))
    for update skip locked
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('organization-role:' || claim.organization_id::text, 509));
    state := private.chapter_leadership_recovery_state(claim.claimant_user_id, claim.chapter_id, claim.id);
    chapter_name := coalesce(state ->> 'chapterName', claim.chapter_id);

    if coalesce((state ->> 'eligible')::boolean, false)
       and (state ->> 'organizationId')::uuid = claim.organization_id then
      insert into public.member_roles (user_id, role, granted_by, chapter_id)
      values (claim.claimant_user_id, 'admin', null, claim.chapter_id)
      on conflict (user_id, role) do nothing;
      insert into public.member_role_chapters (user_id, role, chapter_id, granted_by)
      values (claim.claimant_user_id, 'admin', claim.chapter_id, null)
      on conflict (user_id, role, chapter_id) do nothing;
      insert into public.member_admin_audit (actor, action, target_user, detail)
      values (null, 'grant_role', claim.claimant_user_id, pg_catalog.jsonb_build_object(
        'role', 'admin', 'chapterId', claim.chapter_id,
        'source', 'chapter_leadership_recovery', 'claimId', claim.id));
      update public.chapter_leadership_claims
      set status = 'granted', decided_at = pg_catalog.now()
      where id = claim.id;
      perform private.notify_member(claim.claimant_user_id, 'governance.leadership_claim.granted',
        pg_catalog.jsonb_build_object('chapter', chapter_name), 'general');
      for recipient in select r from private.organization_admin_recipients(claim.organization_id) r loop
        if recipient is distinct from claim.claimant_user_id then
          perform private.notify_member(recipient, 'governance.leadership_claim.granted_admins',
            pg_catalog.jsonb_build_object('chapter', chapter_name), 'general');
        end if;
      end loop;
    else
      update public.chapter_leadership_claims
      set status = 'lapsed', decided_at = pg_catalog.now(),
          lapse_reason = case
            when state ->> 'reason' in ('disabled', 'not_member', 'already_leader', 'chapter_too_new',
              'active_leader_present', 'chapter_unavailable', 'recently_rejected', 'claim_pending')
              then state ->> 'reason'
            else 'chapter_unavailable' end
      where id = claim.id;
      perform private.notify_member(claim.claimant_user_id, 'governance.leadership_claim.lapsed',
        pg_catalog.jsonb_build_object('chapter', chapter_name), 'general');
    end if;
    processed := processed + 1;
  end loop;
  return processed;
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Officer removal ballots
-- ---------------------------------------------------------------------------

alter table public.member_ballots
  add column ballot_type text not null default 'standard',
  add column target_officer_id uuid references auth.users(id) on delete set null,
  add column target_officer_name text,
  add column target_officer_role text,
  add column removal_reason text,
  add column removal_outcome text,
  add column removal_outcome_recorded_at timestamptz,
  add column removal_outcome_recorded_by uuid references auth.users(id) on delete set null;

alter table public.member_ballots
  add constraint member_ballots_ballot_type_check
    check (ballot_type in ('standard', 'officer_removal')),
  add constraint member_ballots_officer_removal_shape check (
    (ballot_type = 'standard'
      and target_officer_id is null and target_officer_name is null and target_officer_role is null
      and removal_reason is null and removal_outcome is null
      and removal_outcome_recorded_at is null and removal_outcome_recorded_by is null)
    or (ballot_type = 'officer_removal'
      and pg_catalog.char_length(target_officer_name) between 1 and 160
      and target_officer_role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
      and pg_catalog.char_length(pg_catalog.btrim(removal_reason)) between 10 and 1000)
  ),
  add constraint member_ballots_removal_outcome_check check (
    (removal_outcome is null and removal_outcome_recorded_at is null)
    or (removal_outcome in ('removed', 'retained') and removal_outcome_recorded_at is not null)
  );

create index member_ballots_officer_removal_target_idx
  on public.member_ballots (target_officer_id) where target_officer_id is not null;

-- The two new auth.users columns join the ballot's case-graph row keys.
drop trigger z99_case_graph_keys on public.member_ballots;
create trigger z99_case_graph_keys before insert or update or delete on public.member_ballots
for each row execute function private.lock_case_graph_row_keys('{created_by},{removal_outcome_recorded_by},{target_officer_id}', '');

comment on column public.member_ballots.ballot_type is
  'standard, or officer_removal (REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001): a ballot on removing the named officer. Written only by save_officer_removal_ballot_draft.';
comment on column public.member_ballots.target_officer_name is
  'The officer''s name when the removal ballot was drafted, shown to eligible voters. No member column grant; read through get_officer_removal_ballot_details.';
comment on column public.member_ballots.removal_outcome is
  'removed or retained, recorded once by staff after voting ends (record_officer_removal_outcome). Nothing is demoted automatically.';

-- Fixed options: one "remove", one "do not remove". The generic draft editor
-- replaces options wholesale, so it can never rewrite a removal ballot.
create function private.guard_officer_removal_ballot_option()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  parent_type text;
begin
  select b.ballot_type into parent_type from public.member_ballots b where b.id = new.ballot_id;
  if parent_type = 'officer_removal' and not (
       (new.id = new.ballot_id || '-option-remove' and new.order_index = 1
        and new.label = 'Remove from office' and new.label_es = 'Destituir del cargo')
       or (new.id = new.ballot_id || '-option-retain' and new.order_index = 2
        and new.label = 'Do not remove' and new.label_es = 'No destituir')) then
    raise exception 'officer removal ballot options are fixed' using errcode = '22023';
  end if;
  return new;
end;
$function$;

create trigger b20_officer_removal_ballot_option_guard
  before insert or update on public.member_ballot_options
  for each row execute function private.guard_officer_removal_ballot_option();

-- Type, target snapshot and reason are fixed once a removal ballot leaves
-- draft; the recorded outcome is fixed once written; and a removal ballot
-- cannot open while the organization switch is off.
create function private.guard_officer_removal_ballot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' then
    if new.ballot_type is distinct from old.ballot_type then
      raise exception 'ballot type is immutable' using errcode = '42501';
    end if;
    if old.ballot_type = 'officer_removal' then
      if new.target_officer_id is distinct from old.target_officer_id
         and new.target_officer_id is not null and old.campaign_state <> 'draft' then
        raise exception 'removal ballot target is fixed' using errcode = '42501';
      end if;
      if old.campaign_state <> 'draft' and (
           new.target_officer_name is distinct from old.target_officer_name
           or new.target_officer_role is distinct from old.target_officer_role
           or new.removal_reason is distinct from old.removal_reason) then
        raise exception 'removal ballot target is fixed' using errcode = '42501';
      end if;
      if old.removal_outcome is not null and (
           new.removal_outcome is distinct from old.removal_outcome
           or new.removal_outcome_recorded_at is distinct from old.removal_outcome_recorded_at
           or (new.removal_outcome_recorded_by is not null
             and new.removal_outcome_recorded_by is distinct from old.removal_outcome_recorded_by)) then
        raise exception 'removal outcome already recorded' using errcode = '42501';
      end if;
    end if;
  end if;
  if new.ballot_type = 'officer_removal' and new.campaign_state = 'open'
     and (tg_op = 'INSERT' or old.campaign_state is distinct from 'open')
     and not private.organization_feature_enabled(new.organization_id, 'features.governance.officer_removal_ballots') then
    raise exception 'officer removal ballots are turned off' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create trigger b20_officer_removal_ballot_guard
  before insert or update on public.member_ballots
  for each row execute function private.guard_officer_removal_ballot();

-- The highest staff role the target holds inside the ballot scope, or NULL.
-- Chapter scope: a chapter staff role in that chapter. Organization scope: an
-- organization staff role, or a chapter staff role in one of its chapters.
-- The target must be an active member of the organization (and of the chapter
-- for a chapter role).
create function private.officer_removal_target_role(
  p_target_user_id uuid,
  p_organization_id uuid,
  p_chapter_id text
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select held.role
  from (
    select grant_row.role
    from public.organization_role_grants grant_row
    where p_chapter_id is null
      and grant_row.organization_id = p_organization_id
      and grant_row.user_id = p_target_user_id
    union all
    select rc.role
    from public.member_role_chapters rc
    join public.chapters chapter_row
      on chapter_row.id = rc.chapter_id and chapter_row.organization_id = p_organization_id
    join public.member_chapter_memberships m
      on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id and m.status = 'active'
    where rc.user_id = p_target_user_id
      and (p_chapter_id is null or rc.chapter_id = p_chapter_id)
  ) held
  where held.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    and p_organization_id is not null
    and exists (
      select 1 from public.organization_memberships om
      where om.organization_id = p_organization_id and om.user_id = p_target_user_id and om.status = 'active'
    )
  order by case held.role
    when 'admin' then 1 when 'vp' then 2 when 'coordinator' then 3 when 'advisor' then 4 else 5 end
  limit 1;
$function$;

-- Resolves the campaign scope exactly as public.save_vote_campaign_draft does.
create function private.officer_removal_scope_chapter(p_scope text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller_chapter text := private.current_member_chapter();
begin
  if p_scope = 'union' then
    if not private.can_manage_vote_scope(null) then
      raise exception 'campaign scope unavailable' using errcode = '42501';
    end if;
    return null;
  elsif p_scope = 'chapter' and caller_chapter is not null then
    if not private.can_manage_vote_scope(caller_chapter) then
      raise exception 'campaign scope unavailable' using errcode = '42501';
    end if;
    return caller_chapter;
  end if;
  raise exception 'campaign scope unavailable' using errcode = '42501';
end;
$function$;

create function public.list_officer_removal_targets(p_scope text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  target_chapter text;
  items jsonb;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  target_chapter := private.officer_removal_scope_chapter(p_scope);
  if org is null or not private.organization_feature_enabled(org, 'features.governance.officer_removal_ballots') then
    raise exception 'officer removal ballots are turned off' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', candidate.user_id, 'name', candidate.full_name, 'role', candidate.role)
    order by candidate.full_name, candidate.user_id), '[]'::jsonb)
  into items
  from (
    select people.user_id, coalesce(profile.full_name, 'Member') as full_name,
      private.officer_removal_target_role(people.user_id, org, target_chapter) as role
    from (
      select grant_row.user_id
      from public.organization_role_grants grant_row
      where target_chapter is null and grant_row.organization_id = org
      union
      select rc.user_id
      from public.member_role_chapters rc
      join public.chapters chapter_row on chapter_row.id = rc.chapter_id and chapter_row.organization_id = org
      where target_chapter is null or rc.chapter_id = target_chapter
    ) people
    left join public.member_profiles profile on profile.id = people.user_id
    limit 500
  ) candidate
  where candidate.role is not null;

  return pg_catalog.jsonb_build_object('scope', p_scope, 'items', items);
end;

end;
$function$;

create function public.save_officer_removal_ballot_draft(
  p_campaign_id text,
  p_scope text,
  p_target_user_id uuid,
  p_reason text,
  p_title_en text,
  p_title_es text,
  p_body_en text,
  p_body_es text,
  p_closes_at timestamptz,
  p_quorum_target integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  target_chapter text;
  campaign_id text := nullif(pg_catalog.btrim(coalesce(p_campaign_id, '')), '');
  created boolean := campaign_id is null;
  reason text := pg_catalog.btrim(coalesce(p_reason, ''));
  target_role text;
  target_name text;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  target_chapter := private.officer_removal_scope_chapter(p_scope);
  if org is null or not private.organization_feature_enabled(org, 'features.governance.officer_removal_ballots') then
    raise exception 'officer removal ballots are turned off' using errcode = '42501';
  end if;

  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title_en, ''))) not between 3 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title_es, ''))) not between 3 and 160
     or p_title_en ~ '[[:cntrl:]]' or p_title_es ~ '[[:cntrl:]]' then
    raise exception 'both campaign titles are required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body_en, ''))) > 1000
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body_es, ''))) > 1000 then
    raise exception 'campaign details are too long' using errcode = '22023';
  end if;
  if p_closes_at is null then
    raise exception 'close time is required' using errcode = '22023';
  end if;
  if p_quorum_target is null or p_quorum_target not between 1 and 1000000 then
    raise exception 'ballot quorum is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(reason) not between 10 and 1000 or reason ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    raise exception 'a removal reason of at least 10 characters is required' using errcode = '22023';
  end if;

  -- SEC-controller-removal-cross-tenant-target-20260708: the target is
  -- resolved from fresh rows inside the caller's organization and scope.
  target_role := private.officer_removal_target_role(p_target_user_id, org, target_chapter);
  if p_target_user_id is null or target_role is null then
    raise exception 'officer not found in this scope' using errcode = '22023';
  end if;
  select coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Member') into target_name
  from public.member_profiles profile where profile.id = p_target_user_id;
  target_name := pg_catalog.left(coalesce(target_name, 'Member'), 160);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member_ballots:order_index'));
  if created then
    campaign_id := 'ballot-' || extensions.gen_random_uuid()::text;
    insert into public.member_ballots
      (id, title, title_es, body, body_es, closes_at, active, order_index,
       quorum_target, chapter_id, campaign_state, created_by,
       ballot_type, target_officer_id, target_officer_name, target_officer_role, removal_reason)
    values
      (campaign_id, pg_catalog.btrim(p_title_en), pg_catalog.btrim(p_title_es),
       pg_catalog.btrim(coalesce(p_body_en, '')), pg_catalog.btrim(coalesce(p_body_es, '')),
       p_closes_at, false, coalesce((select pg_catalog.max(order_index) + 1 from public.member_ballots), 1),
       p_quorum_target, target_chapter, 'draft', caller,
       'officer_removal', p_target_user_id, target_name, target_role, reason);
    insert into public.member_ballot_options (id, ballot_id, label, label_es, order_index) values
      (campaign_id || '-option-remove', campaign_id, 'Remove from office', 'Destituir del cargo', 1),
      (campaign_id || '-option-retain', campaign_id, 'Do not remove', 'No destituir', 2);
  else
    update public.member_ballots b
    set title = pg_catalog.btrim(p_title_en), title_es = pg_catalog.btrim(p_title_es),
        body = pg_catalog.btrim(coalesce(p_body_en, '')), body_es = pg_catalog.btrim(coalesce(p_body_es, '')),
        closes_at = p_closes_at, quorum_target = p_quorum_target, chapter_id = target_chapter,
        target_officer_id = p_target_user_id, target_officer_name = target_name,
        target_officer_role = target_role, removal_reason = reason
    where b.id = campaign_id and b.campaign_state = 'draft' and b.ballot_type = 'officer_removal'
      and private.can_manage_vote_campaign(b.organization_id, b.chapter_id);
    if not found then raise exception 'campaign not found' using errcode = '22023'; end if;
  end if;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, case when created then 'create_campaign' else 'update_campaign_draft' end, p_target_user_id,
    pg_catalog.jsonb_build_object('campaignId', campaign_id, 'kind', 'ballot', 'ballotType', 'officer_removal',
      'scope', p_scope, 'state', 'draft', 'targetRole', target_role));

  return pg_catalog.jsonb_build_object('id', campaign_id, 'kind', 'ballot', 'ballotType', 'officer_removal', 'state', 'draft');
end;
end;
$function$;

-- Removal details for ballots the caller can read as a voter (published) or
-- manage as staff. Names, reasons and outcomes only; never who voted.
create function public.get_officer_removal_ballot_details(p_ballot_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  items jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_ballot_ids is null or pg_catalog.cardinality(p_ballot_ids) > 200 then
    raise exception 'invalid ballot ids' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'ballotId', b.id,
      'targetUserId', case when b.manageable then b.target_officer_id end,
      'targetName', b.target_officer_name,
      'targetRole', b.target_officer_role,
      'reason', b.removal_reason,
      'outcome', b.removal_outcome,
      'outcomeRecordedAt', b.removal_outcome_recorded_at,
      'canRecordOutcome', manageable and b.removal_outcome is null and b.target_officer_id is not null
        and (b.campaign_state = 'closed' or (b.campaign_state = 'open' and b.closes_at <= pg_catalog.now()))
    ) order by b.id), '[]'::jsonb)
  into items
  from (
    select ballot.*, private.can_manage_vote_campaign(ballot.organization_id, ballot.chapter_id) as manageable
    from public.member_ballots ballot
    where ballot.id = any(p_ballot_ids) and ballot.ballot_type = 'officer_removal'
  ) b
  where b.manageable
     or (b.campaign_state <> 'draft' and private.can_read_vote_campaign(b.organization_id, b.chapter_id));

  return pg_catalog.jsonb_build_object(
    'enabled', org is not null and private.organization_feature_enabled(org, 'features.governance.officer_removal_ballots'),
    'items', items);
end;
$function$;

create function public.record_officer_removal_outcome(p_campaign_id text, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  ballot record;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('removed', 'retained') then
    raise exception 'invalid removal outcome' using errcode = '22023';
  end if;

  select b.id, b.organization_id, b.chapter_id, b.campaign_state, b.closes_at,
    b.target_officer_id, b.removal_outcome
  into ballot
  from public.member_ballots b
  where b.id = p_campaign_id and b.ballot_type = 'officer_removal'
    and private.can_manage_vote_campaign(b.organization_id, b.chapter_id)
  for update;
  if not found then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if not (ballot.campaign_state = 'closed' or (ballot.campaign_state = 'open' and ballot.closes_at <= pg_catalog.now())) then
    raise exception 'voting has not ended' using errcode = '22023';
  end if;
  if ballot.removal_outcome is not null then
    raise exception 'removal outcome already recorded' using errcode = '22023';
  end if;
  -- Re-check tenancy at apply time: the officer must still be an active
  -- member of the ballot's organization.
  if ballot.target_officer_id is null or not exists (
      select 1 from public.organization_memberships om
      where om.organization_id = ballot.organization_id and om.user_id = ballot.target_officer_id
        and om.status = 'active'
    ) then
    raise exception 'officer is no longer in this organization' using errcode = '22023';
  end if;

  update public.member_ballots
  set removal_outcome = p_outcome, removal_outcome_recorded_at = pg_catalog.now(),
      removal_outcome_recorded_by = caller
  where id = ballot.id;

  return pg_catalog.jsonb_build_object('id', ballot.id, 'outcome', p_outcome);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------

revoke all on function private.guard_chapter_leadership_claim() from public, anon, authenticated, service_role;
revoke all on function private.chapter_leader_active_since(uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.chapter_leadership_recovery_state(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.chapter_leadership_claim_json(public.chapter_leadership_claims) from public, anon, authenticated, service_role;
revoke all on function private.organization_admin_recipients(uuid) from public, anon, authenticated, service_role;
revoke all on function private.finalize_due_chapter_leadership_claims(integer) from public, anon, authenticated, service_role;
revoke all on function private.guard_officer_removal_ballot_option() from public, anon, authenticated, service_role;
revoke all on function private.guard_officer_removal_ballot() from public, anon, authenticated, service_role;
revoke all on function private.officer_removal_target_role(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.officer_removal_scope_chapter(text) from public, anon, authenticated, service_role;

revoke all on function public.get_chapter_leadership_recovery() from public, anon, authenticated, service_role;
revoke all on function public.claim_chapter_leadership(text) from public, anon, authenticated, service_role;
revoke all on function public.withdraw_chapter_leadership_claim(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_chapter_leadership_claims(integer) from public, anon, authenticated, service_role;
revoke all on function public.reject_chapter_leadership_claim(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.list_officer_removal_targets(text) from public, anon, authenticated, service_role;
revoke all on function public.save_officer_removal_ballot_draft(text, text, uuid, text, text, text, text, text, timestamptz, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_officer_removal_ballot_details(text[]) from public, anon, authenticated, service_role;
revoke all on function public.record_officer_removal_outcome(text, text) from public, anon, authenticated, service_role;

grant execute on function public.get_chapter_leadership_recovery() to authenticated;
grant execute on function public.claim_chapter_leadership(text) to authenticated;
grant execute on function public.withdraw_chapter_leadership_claim(uuid) to authenticated;
grant execute on function public.list_chapter_leadership_claims(integer) to authenticated;
grant execute on function public.reject_chapter_leadership_claim(uuid, text) to authenticated;
grant execute on function public.list_officer_removal_targets(text) to authenticated;
grant execute on function public.save_officer_removal_ballot_draft(text, text, uuid, text, text, text, text, text, timestamptz, integer) to authenticated;
grant execute on function public.get_officer_removal_ballot_details(text[]) to authenticated;
grant execute on function public.record_officer_removal_outcome(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Schedule
-- ---------------------------------------------------------------------------

do $scheduler$
begin
  if pg_catalog.to_regnamespace('cron') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'chapter-leadership-claims-tick';
    perform cron.schedule(
      'chapter-leadership-claims-tick',
      '*/15 * * * *',
      $job$select private.finalize_due_chapter_leadership_claims(50);$job$
    );
  end if;
end;
$scheduler$;

-- Monitoring: chapter-leadership-claims-tick joins the four copies of the
-- monitored set (the job-name CHECK, the mirror's jobname allow-list, the
-- list_organization_job_health() catalog, and PRODUCT_JOBS in
-- src/features/operations/jobRegistry.js). The three database copies are
-- re-emitted from 20261002102000 with only that name added.

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in ('account-deletion-reconcile-tick', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick'));

create or replace function private.sync_organization_job_runs_from_cron_history()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  changed_count integer;
  window_start timestamptz;
  open_runs bigint[];
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Incremental window: the newest cron start already mirrored, minus a
  -- fixed two-hour look-back, bounded below by the fourteen-day floor.
  select greatest(
      coalesce(pg_catalog.max(mirrored.started_at), pg_catalog.now() - interval '14 days')
        - interval '2 hours',
      pg_catalog.now() - interval '14 days')
    into window_start
  from public.organization_job_runs mirrored
  where mirrored.organization_id is null
    and mirrored.run_id like 'cron:%';

  -- Runs still mirrored as in progress are re-read whatever their start, so a
  -- completion later than the look-back still lands.
  select coalesce(pg_catalog.array_agg(pg_catalog.substr(open_run.run_id, 6)::bigint), array[]::bigint[])
    into open_runs
  from public.organization_job_runs open_run
  where open_run.organization_id is null
    and open_run.status = 'in_progress'
    and open_run.run_id like 'cron:%';

  -- Candidates are the eligible cron rows inside the window plus the still-open
  -- runs. Only a candidate whose mirrored outcome is missing or different
  -- reaches the insert, so the BEFORE INSERT row trigger fires for new or
  -- changed runs alone; the ON CONFLICT guard remains for a concurrent tick.
  with candidate as (
    select j.jobname as job_name,
      'cron:' || d.runid::text as run_id,
      case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end as status,
      coalesce(d.start_time, pg_catalog.now()) as started_at,
      d.end_time as finished_at,
      case when d.status = 'failed' then 'cron_failed' end as failure_code,
      case when d.status = 'failed' then 'Scheduled command failed.' end as redacted_summary
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname in ('appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick') and (d.start_time >= window_start or d.runid = any(open_runs))
  )
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  )
  select null, c.job_name, c.run_id, c.status, c.started_at, c.finished_at,
    c.failure_code, c.redacted_summary
  from candidate c
  left join public.organization_job_runs mirrored
    on mirrored.job_name = c.job_name
   and mirrored.run_id = c.run_id
   and mirrored.organization_id is null
  where mirrored.id is null
     or mirrored.status is distinct from c.status
     or mirrored.finished_at is distinct from c.finished_at
     or mirrored.failure_code is distinct from c.failure_code
     or mirrored.redacted_summary is distinct from c.redacted_summary
  on conflict (job_name, run_id, organization_id) do update
    set status = excluded.status, finished_at = excluded.finished_at,
        failure_code = excluded.failure_code,
        redacted_summary = excluded.redacted_summary
    where organization_job_runs.status is distinct from excluded.status
       or organization_job_runs.finished_at is distinct from excluded.finished_at
       or organization_job_runs.failure_code is distinct from excluded.failure_code
       or organization_job_runs.redacted_summary is distinct from excluded.redacted_summary;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$function$;

revoke all on function private.sync_organization_job_runs_from_cron_history()
  from public, anon, authenticated, service_role;

create or replace function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name, 'organizationId', org,
      'lastRunId', r.run_id, 'lastStatus', r.status,
      'lastStartedAt', r.started_at, 'lastFinishedAt', r.finished_at,
      'durationMs', case when r.finished_at is null then null else
        pg_catalog.floor(pg_catalog.date_part('epoch', r.finished_at - r.started_at) * 1000)::bigint end,
      'failureCode', r.failure_code, 'redactedSummary', r.redacted_summary,
      'acknowledged', a.run_id is not null, 'remediation', a.remediation
    ) order by catalog.job_name)
    from (select pg_catalog.unnest(array['account-deletion-reconcile-tick', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick']) as job_name) catalog
    left join lateral (
      select * from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org and a.job_name = catalog.job_name and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_organization_job_health()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_job_health() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Account lifecycle
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition, export_inventory_basis,
   exclusion_reason, note, reviewed_at)
values
  ('public', 'chapter_leadership_claims', 'claimant_user_id', 'cascade', 'excluded_with_reason', 'auth_user_fk',
   'Organization governance record reviewed by organization admins; the claimant sees its state in the app, and the resulting role grant is in the member''s access history.',
   'A member''s claim to chapter admin. Deleted with the claimant''s account.', date '2026-10-02'),
  ('public', 'chapter_leadership_claims', 'decided_by', 'not_applicable', 'excluded_with_reason', 'auth_user_fk',
   'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.',
   'Organization admin who rejected the claim, or the claimant who withdrew it; set null when that account is deleted.', date '2026-10-02'),
  ('public', 'member_ballots', 'target_officer_id', 'not_applicable', 'excluded_with_reason', 'auth_user_fk',
   'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.',
   'Officer named by an officer removal ballot; set null when that account is deleted.', date '2026-10-02'),
  ('public', 'member_ballots', 'removal_outcome_recorded_by', 'not_applicable', 'excluded_with_reason', 'auth_user_fk',
   'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.',
   'Staff member who recorded an officer removal outcome; set null when that account is deleted.', date '2026-10-02');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'public' and (
        (table_name = 'chapter_leadership_claims'
          and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys', 'b10_chapter_leadership_claim_guard'))
        or (table_name = 'member_ballots' and object_name in ('b20_officer_removal_ballot_guard', 'z99_case_graph_keys'))
        or (table_name = 'member_ballot_options' and object_name = 'b20_officer_removal_ballot_option_guard')))
   or (kind = 'function' and schema_name = 'private' and object_name in (
        'guard_chapter_leadership_claim()',
        'guard_officer_removal_ballot()',
        'guard_officer_removal_ballot_option()',
        'organization_feature_enabled(p_organization_id uuid, p_key text)',
        'organization_setting_effective(p_organization_id uuid, p_key text, p_kind text)'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_governance_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after governance: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after governance';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after governance';
  end if;
end;
$assert_governance_lifecycle$;

notify pgrst, 'reload schema';

commit;
