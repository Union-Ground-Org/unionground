-- SEC-UG-EVENT-SCAN-TENANT-ISOLATION-20260921: the steward scan was the
-- one event entry point not re-emitted by 20260901153739; its scanned-member
-- predicate still carried the pre-tenant visibility rules (caller chapter,
-- cross-agency flag, or a same-region public event), none of which checks the
-- event's organization. Re-emit it from its installed definition (the
-- 20260812231000 body wrapped with the case-graph entry lock by
-- 20260907151000; predecessor digest guarded) unchanged except that
-- eligibility now resolves through private.member_can_access_event_scope_for_user,
-- the tenant-first helper from 20260901153739. The scanner's own boundary
-- (event row fetched only in the caller's chapter), lock order, refusal
-- details and grants are unchanged; an out-of-organization token gets the
-- same 'invalid or expired check-in code' (scan_code_invalid) refusal.

begin;

set local lock_timeout = '5s';

do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.scan_event_checkin(text, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '1ed7870ef1c933138cac81dd280a53cb5c295047d9ec0feafb72f702177c3425' then
    raise exception 'unreviewed scan_event_checkin predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function public.scan_event_checkin(p_event_id text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
  select e.id, e.chapter_id, e.starts_at, e.cancelled_at, e.is_public, e.is_public_across_agencies into ev
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

revoke all on function public.scan_event_checkin(text, text) from public, anon;
grant execute on function public.scan_event_checkin(text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
