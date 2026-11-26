-- BUG-UG-PUBLIC-EVENT-RSVP-RPC-ACCEPTS-SUBMISSIONS-ENDED-FAR-PAST-PUBLISHED-20260921:
-- public.submit_public_event_rsvp resolved a meeting from public_site_records
-- on is_published / kind / organization_id alone, with no time predicate, so a
-- direct POST to /api/public/event-rsvp carrying the id of a meeting that ended
-- months ago still persisted a public_event_rsvps lead row. The published event
-- page for a past meeting offers no RSVP form at all -- src/features/
-- publicDirectory/projectPublicContent.js isPublicEventPast() hides it once
-- coalesce(endsAt, startsAt) is in the past -- so the server boundary was more
-- permissive than the only control the product offers. Resolve the event with
-- the same window the UI uses; a past meeting now leaves event_org null and is
-- treated exactly like a missing event: no email/event rate-limit consumption,
-- no insert, and the same uniform {"accepted": true} reply, so the RPC still
-- gives an anonymous caller no existence oracle.
--
-- public_site_records already guarantees the window is total for this kind:
-- 20260812130000 requires starts_at NOT NULL when kind = 'meeting' and ends_at
-- either null or later than starts_at, so coalesce(ends_at, starts_at) is
-- always a real bound. No table, constraint, policy, grant or rate-limit change
-- here; only the event lookup inside the definer body moves.
--
-- 20260907151000 wrapped the 20260826156000 inner source 8405d8a2... in the
-- case-graph lock gate, and that wrapped body is the only predecessor this
-- repair may supersede. The replacement keeps the identical outer gate, so the
-- lock order this function takes is unchanged.

begin;

set local lock_timeout = '5s';

do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.submit_public_event_rsvp(text, text, text, text, text, text, text, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'b08bdabdd57d4e94e0d20f88dedc7be266775c80f1e0105862ea17150e305c59' then
    raise exception 'unreviewed submit_public_event_rsvp predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function public.submit_public_event_rsvp(
  p_event_id text, p_email text, p_name text, p_locale text,
  p_source text, p_website text, p_scope_hash text, p_email_scope_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  event_org uuid;
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  normalized_name text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  event_scope_hash text;
  moment timestamptz := clock_timestamp();
  network_allowed boolean;
  email_allowed boolean := false;
  event_allowed boolean := false;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then return pg_catalog.jsonb_build_object('accepted', true); end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  if pg_catalog.char_length(coalesce(p_event_id, '')) not between 1 and 128
     or pg_catalog.char_length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or (normalized_name is not null and pg_catalog.char_length(normalized_name) > 100)
     or p_source is distinct from 'public-event-rsvp'
     or p_locale is null or p_locale not in ('en', 'es') then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  network_allowed := private.consume_public_event_rsvp_limit(p_scope_hash, 'network-15m', 20, interval '15 minutes');
  if network_allowed then
    select r.organization_id into event_org from public.public_site_records r
    where r.id = p_event_id and r.is_published and r.kind = 'meeting' and r.organization_id is not null
      and coalesce(r.ends_at, r.starts_at) >= now();
  end if;
  if network_allowed and event_org is not null then
    email_allowed := private.consume_public_event_rsvp_limit(
      p_email_scope_hash, 'email-event-day', 3, interval '1 day'
    );
  end if;
  if network_allowed and email_allowed then
    event_scope_hash := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(event_org::text || ':' || p_event_id, 'UTF8'), 'sha256'), 'hex'
    );
    event_allowed := private.consume_public_event_rsvp_limit(event_scope_hash, 'event-day', 500, interval '1 day');
  end if;
  if network_allowed and email_allowed and event_allowed then
    insert into public.public_event_rsvps (organization_id, event_id, email, name, locale)
    values (event_org, p_event_id, normalized_email, normalized_name, p_locale)
    on conflict (event_id, email) do nothing;
  end if;
  delete from private.public_event_rsvp_limits as stale
  where stale.ctid in (
    select candidate.ctid from private.public_event_rsvp_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash <> all(pg_catalog.array_remove(
        array[p_scope_hash, p_email_scope_hash, event_scope_hash]::text[], null
      ))
    order by candidate.window_started_at limit 200 for update skip locked
  );
  return pg_catalog.jsonb_build_object('accepted', true);
end;
end;
$function$;

revoke all on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text)
  to service_role;

comment on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text) is
  'Service-only public event RSVP boundary. A meeting is resolved only while coalesce(ends_at, starts_at) >= now(), the same window the published event page uses to decide whether to offer an RSVP form; an ended meeting is treated as a missing event, so nothing is inserted and the reply stays the uniform accepted envelope that leaks no existence oracle.';

do $ledger$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.submit_public_event_rsvp(text, text, text, text, text, text, text, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '90aa74b51242ccaa49d7c9e35e8008cd0a815117cfa2156ca2da08ea71a3ca51' then
    raise exception 'submit_public_event_rsvp source hash drifted: %', digest
      using errcode = '55000';
  end if;
end;
$ledger$;

notify pgrst, 'reload schema';

commit;
