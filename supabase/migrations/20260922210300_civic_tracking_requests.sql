-- Officer-initiated bill tracking and the instant address lookup claim.
--
-- Ported from civic-data-resolver migrations/007_tracking_requests.sql.
-- Host deviations: p_org is the host chapter id (text); the officer RPC
-- re-states the MFA floor; functions pin search_path = '' and qualify every
-- relation.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A bill can be asked for before the worker has ever fetched it: the stub row
-- carries everything the next refresh needs (jurisdiction + session + identifier).
create function public.civic_request_bill(p_org text, p_jurisdiction text, p_session text, p_identifier text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  clean_jurisdiction text := lower(btrim(p_jurisdiction));
  clean_session text := btrim(p_session);
  clean_identifier text := upper(regexp_replace(btrim(p_identifier), '\s+', ' ', 'g'));
  compact text := lower(regexp_replace(clean_identifier, '[^A-Za-z0-9]', '', 'g'));
  federal text[];
  labels constant jsonb := '{"hr":"H.R.","s":"S.","hjres":"H.J.Res.","sjres":"S.J.Res.","hconres":"H.Con.Res.","sconres":"S.Con.Res.","hres":"H.Res.","sres":"S.Res."}'::jsonb;
  requested_key text;
begin
  if not (select private.mfa_satisfied()) or not public.civic_is_org_officer(p_org) then
    raise exception 'officers only' using errcode = '42501';
  end if;
  if clean_jurisdiction = 'us' then
    federal := regexp_match(compact, '^(hr|s|hjres|sjres|hconres|sconres|hres|sres)([0-9]{1,5})$');
    if federal is null or clean_session !~ '^[0-9]{2,3}$' then
      raise exception 'expected a Congress number and a bill like HR 1 or S 5' using errcode = '22023';
    end if;
    requested_key := 'us/' || clean_session || '/' || federal[1] || '/' || federal[2];
    clean_identifier := (labels ->> federal[1]) || ' ' || federal[2];
  else
    if clean_jurisdiction !~ '^[a-z]{2}$' or clean_session !~ '^[A-Za-z0-9 _-]{2,40}$'
       or compact !~ '^[a-z]{1,6}[0-9]{1,6}$' then
      raise exception 'expected a state code, a session, and a bill like HB 123' using errcode = '22023';
    end if;
    requested_key := clean_jurisdiction || '/' || clean_session || '/' || compact;
  end if;
  insert into public.civic_bills (bill_key, jurisdiction, session, identifier, title, status, tracked, source, source_retrieved_at)
  values (requested_key, clean_jurisdiction, clean_session, clean_identifier, clean_identifier, 'introduced', true,
          'officer_request', now())
  on conflict (bill_key) do update set tracked = true;
  return requested_key;
end;
$function$;

-- Instant lookup: one claim per address change, bounded for everyone. The
-- claim is what authorizes the server route to start a paid worker run.
alter table public.civic_member_addresses add column lookup_requested_at timestamptz;

create function public.civic_claim_instant_lookup(p_user_id uuid, p_shared_hourly integer default 40)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  lookup_status text;
  requested_at timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('civic_claim_instant_lookup'));
  select address.civic_lookup_status, address.lookup_requested_at
    into lookup_status, requested_at
    from public.civic_member_addresses address
   where address.user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'cause', 'no_address');
  end if;
  if lookup_status <> 'needs_lookup' then
    return jsonb_build_object('ok', false, 'cause', 'not_pending');
  end if;
  if requested_at > now() - interval '10 minutes' then
    return jsonb_build_object('ok', false, 'cause', 'already_requested');
  end if;
  if (select count(*) from public.civic_member_addresses recent
      where recent.lookup_requested_at > now() - interval '1 hour') >= p_shared_hourly then
    return jsonb_build_object('ok', false, 'cause', 'shared');
  end if;
  update public.civic_member_addresses set lookup_requested_at = now() where user_id = p_user_id;
  return jsonb_build_object('ok', true);
end;
$function$;

create function public.civic_unclaim_instant_lookup(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $function$
  update public.civic_member_addresses set lookup_requested_at = null where user_id = p_user_id;
$function$;

revoke all on function public.civic_request_bill(text, text, text, text) from public, anon;
revoke all on function public.civic_claim_instant_lookup(uuid, integer) from public, anon, authenticated;
revoke all on function public.civic_unclaim_instant_lookup(uuid) from public, anon, authenticated;
grant execute on function public.civic_request_bill(text, text, text, text) to authenticated, service_role;
grant execute on function public.civic_claim_instant_lookup(uuid, integer) to service_role;
grant execute on function public.civic_unclaim_instant_lookup(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
