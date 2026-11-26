-- SEC-UG-EVENT-CHECKIN-CODE-UNBOUNDED-GUESSES-20260920:
-- public.check_in_to_event compared a caller-supplied code against the event's
-- staff-chosen shared secret and refused a mismatch without counting, delaying
-- or bounding the attempt. (PLAN.md section 13):
--   * the bound is 10 wrong codes per (caller, event);
--   * after the 10th wrong code the caller is refused for 15 minutes;
--   * a bound refusal is INDISTINGUISHABLE from a wrong code to the caller
--     (same error code and message);
--   * every lockout is audited (one audit row naming the event and the
--     caller, never a code value);
--   * staff see a notice on the event ("N check-in lockouts in the last 24 h").
-- A refused attempt must survive its own refusal, and a plpgsql exception
-- rolls its transaction back, so the two refusals are one returned payload
-- (checkedIn=false, code 22023, message 'invalid check-in code') instead of a
-- raised exception; every calling surface turns that payload into the same
-- failure the exception produced. No member_event_checkins row and no point
-- award is written for a refused caller. The separate scan-token path is
-- untouched.

begin;

set local lock_timeout = '5s';

-- 20260907151000 wrapped the 20260901153739 inner source ef911d26… in the
-- case-graph entry gate, and that wrapped body is the only predecessor this
-- change may supersede. A fresh install still wraps the original inner source
-- first; this file then replaces the wrapped routine while keeping the gate as
-- its first statement.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.check_in_to_event(text, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '6bfeba86e1bb8afb89346f6f385d758d4b6d4c05878bedb16eda28de8059b6ed' then
    raise exception 'unreviewed check_in_to_event predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

-- ------------------------------------------------- 1. the per-pair attempt row
--
-- One row per (event, caller) that has sent a wrong code. wrong_attempts is
-- the count inside the current window; locked_until is set on the tenth wrong
-- code and, once it has passed, the next wrong code starts a new window at 1.
-- A correct code outside a lockout deletes the row. Definer-only: no member
-- role can read how many guesses remain.
create table private.member_event_checkin_attempts (
  event_id text not null references public.member_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  wrong_attempts integer not null default 0 check (wrong_attempts between 0 and 10),
  locked_until timestamptz,
  last_attempt_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

alter table private.member_event_checkin_attempts enable row level security;
alter table private.member_event_checkin_attempts force row level security;
revoke all on table private.member_event_checkin_attempts from public, anon, authenticated, service_role;

-- Account lifecycle inventory: the attempt row hangs from auth.users, so the
-- export ownership inventory needs its reviewed classification. Attempts are
-- an operational abuse bound, not member content: excluded from the account
-- export with a reason, and they leave with the account (ON DELETE CASCADE).
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_inventory_basis, exclusion_reason, note)
values ('private', 'member_event_checkin_attempts', 'user_id', 'cascade',
  'excluded_with_reason', 'auth_user_fk',
  'Wrong-code attempt counters and lockout clocks are an operational abuse bound, not member content; the row records nothing the member authored.',
  'Installed action is ON DELETE CASCADE; the counter row leaves with the account and with its event.');

-- Account case-graph coordination: the row hangs from auth.users, so it joins
-- the lock graph like every other auth child and its row-key trigger names the
-- identity column.
create trigger a00_case_graph_lock before insert or update or delete on private.member_event_checkin_attempts
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_event_checkin_attempts
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private' and table_name = 'member_event_checkin_attempts'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_member_event_checkin_attempts_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after member event check-in attempts';
  end if;
end;
$assert_member_event_checkin_attempts_trigger_review$;

-- ------------------------------------------- 2. service-role clock override
--
-- The lockout proof needs to observe "15 minutes later" without waiting. The
-- override is a private singleton no client role can read or write directly;
-- the service role (a disposable proof stack, or an operator on purpose) sets
-- or clears it through one definer setter that lives in public because the
-- service role has no usage on the private schema; an empty table means the
-- real clock. It is read through one stable helper so the bound and the lockout
-- expiry share a single notion of now.
create table private.event_checkin_clock_override (
  singleton boolean primary key default true check (singleton),
  now_at timestamptz not null,
  set_by text not null default 'service_role'
);

revoke all on table private.event_checkin_clock_override from public, anon, authenticated, service_role;

create or replace function public.set_event_checkin_clock_override(p_now_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', current_user) <> 'service_role' and current_user <> 'postgres' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_now_at is null then
    delete from private.event_checkin_clock_override;
    return;
  end if;
  insert into private.event_checkin_clock_override (singleton, now_at, set_by)
  values (true, p_now_at, coalesce(auth.jwt() ->> 'role', current_user))
  on conflict (singleton) do update
    set now_at = excluded.now_at, set_by = excluded.set_by;
end;
$$;

revoke all on function public.set_event_checkin_clock_override(timestamptz) from public, anon, authenticated;
grant execute on function public.set_event_checkin_clock_override(timestamptz) to service_role;

create or replace function private.event_checkin_clock()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select o.now_at from private.event_checkin_clock_override o where o.singleton), now());
$$;

revoke all on function private.event_checkin_clock() from public, anon, authenticated;
grant execute on function private.event_checkin_clock() to service_role;

-- ---------------------------------------------- 3. the audited lockout action
--
-- Existing audit table has a closed vocabulary; extend it by the one new
-- action without dropping any settled action from 20260821014000.
alter table public.member_admin_audit drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit add constraint member_admin_audit_action_check
  check (action in (
    'grant_role', 'revoke_role',
    'create_event', 'update_event', 'cancel_event', 'restore_event', 'delete_event',
    'reset_mfa',
    'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward',
    'set_staff_mfa_policy',
    'set_compass_ai_enabled', 'set_compass_ai_role_limit', 'attest_compass_ai_provider',
    'create_campaign', 'update_campaign_draft', 'publish_campaign', 'close_campaign',
    'recover_signin_address', 'recover_signin_address_failed',
    'review_email_intake',
    'create_chapter', 'update_chapter',
    'grant_chapter_membership', 'revoke_chapter_membership',
    'event_checkin_lockout'
  ));

-- --------------------------------------------- 4. the bounded check-in itself
--
-- Re-emitted from the wrapped 20260901153739 body. Every guard it had stays in
-- the same order (assurance, tenant-scoped lookup under a share lock, the
-- cancelled guard, the time window); the code comparison now sits behind the
-- lockout check and records its outcome before returning.
create or replace function public.check_in_to_event(p_event_id text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  ev record;
  prior_wrong integer;
  prior_locked_until timestamptz;
  now_at timestamptz;
  wrong_count integer;
  new_checkin integer := 0;
  awarded integer := 0;
  rule_points integer;
  -- One literal for both refusals (: a bound refusal is
  -- indistinguishable from a wrong code). Same SQLSTATE and message the
  -- raised refusal carried, so every surface reports the same failure.
  refusal constant jsonb := pg_catalog.jsonb_build_object(
    'checkedIn', false,
    'refused', true,
    'code', '22023',
    'message', 'invalid check-in code'
  );
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select e.id, e.check_in_code, e.starts_at, e.cancelled_at into ev
  from public.member_events e
  where e.id = p_event_id
    and private.member_can_access_event_scope(
      e.chapter_id, e.is_public, e.is_public_across_agencies
    )
  for share;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'event_cancelled';
  end if;

  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
    raise exception 'check-in is only open around the event start time' using errcode = '22023';
  end if;

  -- Bound: 10 wrong codes per (caller, event), then 15 minutes of refusal.
  now_at := private.event_checkin_clock();
  select a.wrong_attempts, a.locked_until into prior_wrong, prior_locked_until
  from private.member_event_checkin_attempts a
  where a.event_id = p_event_id and a.user_id = caller
  for update;
  if prior_locked_until is not null and now_at < prior_locked_until then
    -- Locked out: the correct code is refused too, nothing is counted, and
    -- the caller cannot tell this apart from a wrong code.
    return refusal;
  end if;

  if pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, ''))) <> pg_catalog.upper(ev.check_in_code) then
    -- An expired lockout starts a fresh window; otherwise the window continues.
    wrong_count := case
      when prior_wrong is null or prior_locked_until is not null then 1
      else prior_wrong + 1
    end;
    insert into private.member_event_checkin_attempts (event_id, user_id, wrong_attempts, locked_until, last_attempt_at)
    values (
      p_event_id, caller, wrong_count,
      case when wrong_count >= 10 then now_at + interval '15 minutes' end,
      now_at
    )
    on conflict (event_id, user_id) do update
      set wrong_attempts = excluded.wrong_attempts,
          locked_until = excluded.locked_until,
          last_attempt_at = excluded.last_attempt_at;
    if wrong_count >= 10 then
      -- One audit row per lockout naming the event and the caller; no code
      -- value, neither the guess nor the secret, is ever written.
      insert into public.member_admin_audit (actor, action, target_user, detail)
      values (caller, 'event_checkin_lockout', caller, pg_catalog.jsonb_build_object(
        'eventId', p_event_id,
        'wrongAttempts', wrong_count,
        'lockedUntil', now_at + interval '15 minutes'
      ));
    end if;
    return refusal;
  end if;

  -- A correct code outside a lockout closes the window.
  delete from private.member_event_checkin_attempts
  where event_id = p_event_id and user_id = caller;

  insert into public.member_event_checkins (event_id, user_id)
  values (p_event_id, caller)
  on conflict (event_id, user_id) do nothing;
  get diagnostics new_checkin = row_count;

  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, 'checkin-' || p_event_id, 'checkin')
  on conflict (user_id, action_key) do nothing;
  get diagnostics awarded = row_count;

  select points into rule_points
  from public.member_point_rules where action_kind = 'checkin';
  return pg_catalog.jsonb_build_object(
    'checkedIn', true,
    'alreadyCheckedIn', new_checkin = 0,
    'awardedPoints', case when awarded = 1 then coalesce(rule_points, 0) else 0 end
  );
end;
end;
$function$;

comment on function public.check_in_to_event(text, text) is
  'Member self check-in with the event''s shared code. Wrong codes are bounded to 10 per (caller, event); the tenth locks the pair out for 15 minutes, during which the correct code is refused with the same payload as a wrong code (checkedIn=false, code 22023, message ''invalid check-in code''); each lockout writes one member_admin_audit row (event_checkin_lockout) naming the event and the caller and never a code value.';

-- --------------------------------------------- 5. the staff notice on the desk
--
-- Re-emitted from 20260812170000 with one more count per event: lockouts
-- audited in the last 24 hours. Same caller gate, same chapter scope, same
-- column list otherwise.
create or replace function public.get_admin_events()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id, 'title', e.title, 'startsAt', e.starts_at,
      'location', e.location, 'summary', e.summary,
      'checkInCode', e.check_in_code, 'orderIndex', e.order_index,
      'chapterId', e.chapter_id, 'chapterName', c.name,
      'isPublic', e.is_public,
      'isPublicAcrossAgencies', e.is_public_across_agencies,
      'cancelledAt', e.cancelled_at,
      'cancelledReason', e.cancelled_reason,
      'rsvpCount', coalesce(r.n, 0), 'checkinCount', coalesce(k.n, 0),
      'checkinLockouts24h', coalesce(l.n, 0)
    ) order by e.order_index)
    from public.member_events e
    join public.chapters c on c.id = e.chapter_id
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_rsvps where status = 'going' group by event_id
    ) r on r.event_id = e.id
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_checkins group by event_id
    ) k on k.event_id = e.id
    left join (
      select a.detail ->> 'eventId' as event_id, pg_catalog.count(*) as n
      from public.member_admin_audit a
      where a.action = 'event_checkin_lockout'
        and a.created_at >= now() - interval '24 hours'
      group by a.detail ->> 'eventId'
    ) l on l.event_id = e.id
    where e.chapter_id = caller_chapter
  ), '[]'::jsonb);
end;
$$;

-- The delivered source is pinned so a later unreviewed edit fails closed here
-- exactly as the predecessor guard above does.
do $ledger$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.check_in_to_event(text, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'b9f4f0866cad603508ce4c38e8a6cdd593a77a89b2eebb3006f4489ef3caeff5' then
    raise exception 'check_in_to_event source hash drifted: %', digest
      using errcode = '55000';
  end if;
end;
$ledger$;

do $lifecycle_inventory$
begin
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after the check-in attempt bound';
  end if;
end;
$lifecycle_inventory$;

notify pgrst, 'reload schema';

commit;
