-- BUG-UG-EVENT-SAVE-SILENT-WITHOUT-CHECKIN-CODE-20261006
--
-- A deadline or reminder needed a made-up door code: member_events.check_in_code
-- was NOT NULL (20260722023422) and create_member_event refused a NULL code
-- (20261007023000). This lets an event have no check-in code and makes sure an
-- event without one admits nobody:
--   * member_events.check_in_code drops NOT NULL; the column's pattern check
--     (^SG-[0-9A-Z]{3,12}$) still holds any code that is present;
--   * create_member_event stores NULL for a NULL or empty code and still
--     refuses a code outside the pattern;
--   * update_member_event keeps the code when p_check_in_code is NULL (the
--     omission every existing caller sends) and removes it when it is the
--     empty string; a removal is audited as the check_in_code field, never
--     with the code value;
--   * check_in_to_event, request_event_checkin_token and scan_event_checkin
--     refuse an event with no code with DETAIL checkin_not_offered, after the
--     unchanged scope and cancellation checks and before the window, the
--     lockout and any attempt is counted. Without this a NULL code compared
--     as unknown in check_in_to_event and fell through to admission.
-- src/lib/rpcErrorText.js maps the token to English and Spanish copy.
--
-- All five bodies are the installed definitions read with pg_get_functiondef
-- from a disposable stack at Main, with only those lines changed, behind
-- prosrc predecessor/successor guards. Signatures, owners, security definer,
-- search_path and grants are unchanged by create or replace.
--
-- Repository only. Hosted application joins a later stage Main runs; until
-- then hosted events keep requiring a code and nothing else changes.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $predecessors$
declare
  -- Exact prosrc MD5s: reviewed predecessor, then this migration's successor.
  expected constant jsonb := pg_catalog.jsonb_build_object(
    'public.check_in_to_event(text,text)', pg_catalog.jsonb_build_array('c7c9ce64104514a73a5241e45438810d', 'be55f521f5a680f13804f7e7201d59e2'),
    'public.request_event_checkin_token(text)', pg_catalog.jsonb_build_array('0faa02cf60f01bf9dd9f66de001cedf4', 'e48a71a9b96d7b3450f25042b5149b21'),
    'public.scan_event_checkin(text,text)', pg_catalog.jsonb_build_array('b72a9365a295ddecdd8947fd3880e1c2', 'eb415453627c1f112828a6279a4d4daf'),
    'public.create_member_event(text,text,timestamptz,text,text,text,boolean,boolean)', pg_catalog.jsonb_build_array('8b91f4bdb7ba1965aeb230af8650e026', '87b83cc91da86aa519c242f65c86872f'),
    'public.update_member_event(text,text,timestamptz,text,text,text,boolean,boolean)', pg_catalog.jsonb_build_array('6876c53953c38bcd58f28111872fabcb', 'd9e1fcd72a890304bf25172221b7f9b1')
  );
  fn text;
  actual text;
begin
  for fn in select pg_catalog.jsonb_object_keys(expected) loop
    select pg_catalog.md5(p.prosrc) into strict actual
      from pg_catalog.pg_proc p
     where p.oid = fn::regprocedure;
    if not ((expected -> fn) ? actual) then
      raise exception 'unreviewed % body: %', fn, actual
        using errcode = '55000';
    end if;
  end loop;
end;
$predecessors$;

alter table public.member_events alter column check_in_code drop not null;

-- RLS still determines which events are readable. Only availability is
-- exposed; the admission secret retains its denied column privilege.
-- Generated storage keeps creates, removals and replacements in sync.
alter table public.member_events add column if not exists check_in_offered boolean
  generated always as (check_in_code is not null) stored;
grant select (check_in_offered) on public.member_events to authenticated;

-- IF NOT EXISTS must not silently accept a different definition or exposure.
do $availability$
begin
  if not exists (
    select 1
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.member_events'::regclass
       and a.attname = 'check_in_offered' and not a.attisdropped
       and a.atttypid = 'boolean'::regtype and a.attgenerated = 's'
       and pg_catalog.pg_get_expr(d.adbin, d.adrelid) = '(check_in_code IS NOT NULL)'
  ) then
    raise exception 'unreviewed member_events.check_in_offered definition'
      using errcode = '55000';
  end if;
  if not pg_catalog.has_column_privilege('authenticated', 'public.member_events', 'check_in_offered', 'SELECT')
     or pg_catalog.has_column_privilege('authenticated', 'public.member_events', 'check_in_code', 'SELECT')
     or pg_catalog.has_column_privilege('anon', 'public.member_events', 'check_in_offered', 'SELECT')
     or pg_catalog.has_column_privilege('anon', 'public.member_events', 'check_in_code', 'SELECT') then
    raise exception 'unreviewed member_events check-in column grants'
      using errcode = '55000';
  end if;
end;
$availability$;

comment on column public.member_events.check_in_code is
  'Static on-site check-in code (^SG-[0-9A-Z]{3,12}$), or NULL for an event with no check-in such as a deadline or reminder. Every check-in path refuses an event whose code is NULL.';

CREATE OR REPLACE FUNCTION public.check_in_to_event(p_event_id text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  ev record;
  prior_wrong integer;
  prior_locked_until timestamptz;
  now_at timestamptz;
  wrong_count integer;
  checkin_org uuid;
  checkin_limit integer;
  checkin_lock_minutes integer;
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
    'message', 'invalid check-in code',
    'token', 'checkin_code_invalid'
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
  -- No code, no check-in: a deadline or reminder admits nobody. Refused
  -- before the window or any attempt is counted, so a NULL code never
  -- reaches a comparison that SQL would leave unknown.
  if ev.check_in_code is null then
    raise exception 'this event has no check-in'
      using errcode = '22023', detail = 'checkin_not_offered';
  end if;

  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
    raise exception 'check-in is only open around the event start time' using errcode = '22023', detail = 'checkin_not_open';
  end if;

  -- Bound by the event organization's nonzero lock settings.
  select c.organization_id into checkin_org
  from public.member_events e join public.chapters c on c.id = e.chapter_id
  where e.id = p_event_id;
  checkin_limit := private.organization_limit(checkin_org, 'limits.security.event_checkin_wrong_codes');
  checkin_lock_minutes := private.organization_limit(checkin_org, 'limits.security.event_checkin_lock_minutes');
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
      case when wrong_count >= checkin_limit then now_at + pg_catalog.make_interval(mins => checkin_lock_minutes) end,
      now_at
    )
    on conflict (event_id, user_id) do update
      set wrong_attempts = excluded.wrong_attempts,
          locked_until = excluded.locked_until,
          last_attempt_at = excluded.last_attempt_at;
    if wrong_count >= checkin_limit then
      -- One audit row per lockout naming the event and the caller; no code
      -- value, neither the guess nor the secret, is ever written.
      insert into public.member_admin_audit (actor, action, target_user, detail)
      values (caller, 'event_checkin_lockout', caller, pg_catalog.jsonb_build_object(
        'eventId', p_event_id,
        'wrongAttempts', wrong_count,
        'lockedUntil', now_at + pg_catalog.make_interval(mins => checkin_lock_minutes)
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

CREATE OR REPLACE FUNCTION public.request_event_checkin_token(p_event_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  ev record;
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea;
  plain text := '';
  valid_until timestamptz;
  i integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select e.starts_at, e.cancelled_at, e.check_in_code into ev
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
  -- No code, no check-in: a deadline or reminder admits nobody. Refused
  -- before the window or any attempt is counted, so a NULL code never
  -- reaches a comparison that SQL would leave unknown.
  if ev.check_in_code is null then
    raise exception 'this event has no check-in'
      using errcode = '22023', detail = 'checkin_not_offered';
  end if;
  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
    raise exception 'check-in codes are only available around the event start time' using errcode = '22023', detail = 'checkin_not_open';
  end if;

  delete from private.member_event_checkin_tokens
  where event_id = p_event_id and user_id = caller and consumed_at is null;

  bytes := extensions.gen_random_bytes(7);
  for i in 0..6 loop
    plain := plain || pg_catalog.substr(alphabet, (pg_catalog.get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  valid_until := now() + interval '90 seconds';

  insert into private.member_event_checkin_tokens (event_id, user_id, token_hash, expires_at)
  values (p_event_id, caller, pg_catalog.encode(extensions.digest(plain, 'sha256'), 'hex'), valid_until);

  return pg_catalog.jsonb_build_object('token', plain, 'expiresAt', valid_until, 'ttlSeconds', 90);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.scan_event_checkin(p_event_id text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  clean_token text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_token, '')));
  steward_grant record;
  ev record;
  tok record;
  scanned_name text;
  new_checkin integer := 0;
  member_logged integer := 0;
  scanner_logged integer := 0;
  member_points integer := 0;
  scanner_points integer := 0;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'steward role required'
      using errcode = '42501', detail = 'scan_not_steward';
  end if;

  -- Fix the caller's chapter first, then lock one qualifying grant. Exact
  -- chapter grants are preferred over the legacy org-wide sentinel so this
  -- stays deterministic even if the role model later permits multiple scoped
  -- rows for one hat. A concurrent profile move or role revocation either
  -- commits first and is rechecked here, or waits until this scan finishes.
  select cp.chapter_id into caller_chapter
  from public.member_profiles cp
  where cp.id = caller
  for update of cp;
  if not found or caller_chapter is null then
    raise exception 'invalid or expired check-in code'
      using errcode = '22023', detail = 'scan_code_invalid';
  end if;

  select r.user_id, r.role, r.chapter_id into steward_grant
  from public.member_roles r
  where r.user_id = caller and r.role = 'steward'
    and (r.chapter_id = caller_chapter or r.chapter_id is null)
  order by case when r.chapter_id = caller_chapter then 0 else 1 end,
           r.chapter_id nulls last
  limit 1
  for update of r;
  if not found or not public.member_has_role(array['steward']) then
    raise exception 'steward role required'
      using errcode = '42501', detail = 'scan_not_steward';
  end if;

  if clean_token = '' then
    raise exception 'enter the member''s check-in code'
      using errcode = '22023', detail = 'scan_code_missing';
  end if;

  -- Cancel/restore/delete/reschedule all take this same row lock. Recheck
  -- chapter, cancellation, and the live check-in window on the locked tuple
  -- before looking at or consuming a token.
  select e.id, e.chapter_id, e.starts_at, e.cancelled_at, e.is_public, e.is_public_across_agencies, e.check_in_code into ev
  from public.member_events e
  where e.id = p_event_id
    and e.chapter_id = caller_chapter
  for update of e;
  if not found then
    raise exception 'invalid or expired check-in code'
      using errcode = '22023', detail = 'scan_code_invalid';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'scan_event_cancelled';
  end if;
  -- No code, no check-in: a deadline or reminder admits nobody, so
  -- a personal code minted before the code was removed cannot be redeemed.
  if ev.check_in_code is null then
    raise exception 'this event has no check-in'
      using errcode = '22023', detail = 'checkin_not_offered';
  end if;
  if ev.starts_at is null
     or now() < ev.starts_at - interval '2 hours'
     or now() > ev.starts_at + interval '4 hours' then
    raise exception 'invalid or expired check-in code'
      using errcode = '22023', detail = 'scan_code_invalid';
  end if;

  select id, user_id, expires_at, consumed_at into tok
  from private.member_event_checkin_tokens
  where event_id = p_event_id
    and token_hash = pg_catalog.encode(extensions.digest(clean_token, 'sha256'), 'hex')
  for update;
  if not found then
    raise exception 'invalid or expired check-in code'
      using errcode = '22023', detail = 'scan_code_invalid';
  end if;
  if tok.consumed_at is not null then
    raise exception 'this code has already been used'
      using errcode = '22023', detail = 'scan_code_used';
  end if;
  if tok.expires_at < now() then
    raise exception 'this code has expired - ask the member to refresh it'
      using errcode = '22023', detail = 'scan_code_expired';
  end if;
  if tok.user_id = caller then
    raise exception 'you cannot scan your own check-in code'
      using errcode = '22023', detail = 'scan_code_self';
  end if;

  -- Resolve, eligibility-check, and lock the member before consuming their
  -- single-use token. A concurrent deletion or chapter move either commits
  -- first and is rechecked, or waits; it cannot turn a successful response's
  -- memberName into null or make an ineligible token succeed after mutation.
  -- The token owner's eligibility is the same tenant-first event scope used
  -- by RSVP, self check-in, and token minting: active chapter and
  -- organization membership in the event's organization before any agency or
  -- cross-agency widening.
  select p.full_name into scanned_name
  from public.member_profiles p
  where p.id = tok.user_id
    and p.chapter_id is not null
    and private.member_can_access_event_scope_for_user(
      tok.user_id, ev.chapter_id, ev.is_public, ev.is_public_across_agencies
    )
  for update of p;
  if not found or nullif(pg_catalog.btrim(scanned_name), '') is null then
    raise exception 'invalid or expired check-in code'
      using errcode = '22023', detail = 'scan_code_invalid';
  end if;

  update private.member_event_checkin_tokens
  set consumed_at = now(), consumed_by = caller
  where id = tok.id;

  insert into public.member_event_checkins (event_id, user_id, scanned_by)
  values (p_event_id, tok.user_id, caller)
  on conflict (event_id, user_id) do nothing;
  get diagnostics new_checkin = row_count;

  insert into public.member_action_log (user_id, action_key, action_kind)
  values (tok.user_id, 'checkin-' || p_event_id, 'checkin')
  on conflict (user_id, action_key) do nothing;
  get diagnostics member_logged = row_count;

  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, 'scan-' || tok.user_id::text || '-' || p_event_id, 'scan')
  on conflict (user_id, action_key) do nothing;
  get diagnostics scanner_logged = row_count;

  if member_logged = 1 then
    select coalesce(pg_catalog.max(points), 0) into member_points
    from public.member_point_events
    where user_id = tok.user_id and action_key = 'checkin-' || p_event_id;
  end if;
  if scanner_logged = 1 then
    select coalesce(pg_catalog.max(points), 0) into scanner_points
    from public.member_point_events
    where user_id = caller and action_key = 'scan-' || tok.user_id::text || '-' || p_event_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'memberUserId', tok.user_id,
    'memberName', scanned_name,
    'checkedIn', true,
    'alreadyCheckedIn', new_checkin = 0,
    'memberAwardedPoints', member_points,
    'scannerAwardedPoints', scanner_points
  );
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_member_event(p_id text, p_title text, p_starts_at timestamp with time zone, p_location text, p_summary text, p_check_in_code text, p_is_public boolean DEFAULT false, p_is_public_across_agencies boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  -- NULL or empty: no check-in code (a deadline or reminder).
  clean_code text := nullif(p_check_in_code, '');
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_is_public is null or p_is_public_across_agencies is null then
    raise exception 'event visibility is required' using errcode = '22023';
  end if;
  if p_id is null or p_id !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid event id' using errcode = '22023';
  end if;
  if p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]' then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'invalid start time' using errcode = '22023';
  end if;
  if p_location is null or pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]' then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is null or pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]' then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if clean_code is not null and clean_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member_events:order_index:' || caller_chapter, 509));
  if exists (select 1 from public.member_events where id = p_id) then
    raise exception 'event id already exists' using errcode = '22023';
  end if;

  insert into public.member_events (
    id, title, starts_at, location, summary, check_in_code, order_index,
    chapter_id, is_public, is_public_across_agencies)
  values (
    p_id, pg_catalog.btrim(p_title), p_starts_at, pg_catalog.btrim(p_location),
    pg_catalog.btrim(p_summary), clean_code,
    coalesce((select pg_catalog.max(order_index) + 1 from public.member_events where chapter_id = caller_chapter), 1),
    caller_chapter, p_is_public, p_is_public_across_agencies);

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', pg_catalog.btrim(p_title),
    'chapterId', caller_chapter,
    'isPublic', p_is_public,
    'isPublicAcrossAgencies', p_is_public_across_agencies));

  begin
    for m in
      select recipient.id
      from public.member_profiles recipient
      join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
      join public.chapters publisher_chapter on publisher_chapter.id = caller_chapter
      join public.organization_memberships recipient_membership
        on recipient_membership.user_id = recipient.id
       and recipient_membership.organization_id = publisher_chapter.organization_id
       and recipient_membership.status = 'active'
      where recipient.id <> caller
        and recipient_chapter.organization_id = publisher_chapter.organization_id
        and (
          recipient.chapter_id = caller_chapter
          or p_is_public_across_agencies
          or (p_is_public and publisher_chapter.region is not null
              and recipient_chapter.region = publisher_chapter.region)
        )
    loop
      perform private.notify_member_event(m.id, p_id, 'created');
    end loop;
  exception
    when others then
      raise warning 'event.created notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'created', true);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_member_event(p_id text, p_title text DEFAULT NULL::text, p_starts_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_location text DEFAULT NULL::text, p_summary text DEFAULT NULL::text, p_check_in_code text DEFAULT NULL::text, p_is_public boolean DEFAULT NULL::boolean, p_is_public_across_agencies boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  changed text[];
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  if p_title is not null and (pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]') then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_location is not null and (pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]') then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is not null and (pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]') then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  -- NULL keeps the current code; the empty string removes it.
  if p_check_in_code is not null and p_check_in_code <> '' and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  changed := pg_catalog.array_remove(array[
    case when p_title is not null and pg_catalog.btrim(p_title) is distinct from ev.title then 'title' end,
    case when p_starts_at is not null and p_starts_at is distinct from ev.starts_at then 'starts_at' end,
    case when p_location is not null and pg_catalog.btrim(p_location) is distinct from ev.location then 'location' end,
    case when p_summary is not null and pg_catalog.btrim(p_summary) is distinct from ev.summary then 'summary' end,
    case when p_check_in_code is not null and nullif(p_check_in_code, '') is distinct from ev.check_in_code then 'check_in_code' end,
    case when p_is_public is not null and p_is_public is distinct from ev.is_public then 'is_public' end,
    case when p_is_public_across_agencies is not null and p_is_public_across_agencies is distinct from ev.is_public_across_agencies then 'is_public_across_agencies' end
  ], null);

  if pg_catalog.cardinality(changed) > 0 then
    update public.member_events set
      title = coalesce(pg_catalog.btrim(p_title), title),
      starts_at = coalesce(p_starts_at, starts_at),
      location = coalesce(pg_catalog.btrim(p_location), location),
      summary = coalesce(pg_catalog.btrim(p_summary), summary),
      check_in_code = case when p_check_in_code is null then check_in_code else nullif(p_check_in_code, '') end,
      is_public = coalesce(p_is_public, is_public),
      is_public_across_agencies = coalesce(p_is_public_across_agencies, is_public_across_agencies)
    where id = p_id and chapter_id = caller_chapter;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.to_jsonb(changed),
      'isPublic', coalesce(p_is_public, ev.is_public),
      'isPublicAcrossAgencies', coalesce(p_is_public_across_agencies, ev.is_public_across_agencies)));

    if 'starts_at' = any(changed) then
      update public.member_events set reminder_notice_sent_at = null
      where id = p_id and chapter_id = caller_chapter;
      begin
        for m in
          select rv.user_id
          from public.member_event_rsvps rv
          join public.member_profiles recipient on recipient.id = rv.user_id
          join public.member_events current_event on current_event.id = rv.event_id
          join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
          join public.chapters publisher_chapter on publisher_chapter.id = current_event.chapter_id
          where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
            and (
              recipient.chapter_id = current_event.chapter_id
              or current_event.is_public_across_agencies
              or (current_event.is_public and publisher_chapter.region is not null
                  and recipient_chapter.region = publisher_chapter.region)
            )
        loop
          perform private.notify_member_event(m.user_id, p_id, 'rescheduled');
        end loop;
      exception
        when others then
          raise warning 'event.rescheduled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
      end;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('id', p_id, 'updated', pg_catalog.cardinality(changed) > 0);
end;
end;
$function$;

commit;
