-- REQ-UG-OUTREACH-CODES-AND-NOTIFY-PREF-20261022: outreach codes and
-- a notification preference on the /contribute upload page (owner, October 22,
-- 2026, about 7:20 PM ET: "make sure each letter carries an identifier in the
-- qr code or link so that when they visit the site to upload the docs, the
-- site will know their exact organization. they also need to be asked how to
-- be notified when the docs are ready"; the same evening the owner approved
-- raising the 10-file limit).
--
-- Builds on 20261022172000_union_document_contribution_intake.sql:
--
--   * private.union_outreach_codes holds one row per printed or emailed code:
--     8 characters from 23456789ABCDEFGHJKMNPQRSTVWXYZ, single (one
--     organization) or shared (several organizations at one address), the
--     letter's channel, and the organizations as {body_id, display_name}.
--     RLS is on with no policy and no client grant, the posture of the intake
--     tables: only the two service-role definer functions below read or
--     write it. No address is stored here.
--   * public.lookup_union_outreach_code answers the page with display names
--     only, behind the landing form's durable limiter; an unknown code gets
--     the same answer as no code.
--   * public.upsert_union_outreach_codes is the only writer
--     (scripts/import-outreach-codes.mjs --apply).
--   * Each contribution now records the code it arrived with, the chosen
--     body_id (null when the visitor typed the organization), and how the
--     contributor wants to hear that the digitized forms are ready: email
--     (the contact address), a text message (a US mobile number) or mail (a
--     mailing address). Text-message sending is not built; only the
--     preference is stored.
--   * One submission may carry up to 40 files (was 10). Each file is still
--     one of the eight formats and 10 MiB or less, and the per-network
--     inspection budget rises from 60 to 600 per 15 minutes to match.
--
-- begin_union_document_contribution gains five arguments, so the 14-argument
-- function is dropped and the 19-argument one created in the same
-- transaction; the server function calls only the new one.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------- 1. outreach codes

create table private.union_outreach_codes (
  code text primary key check (code ~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$'),
  kind text not null check (kind in ('single', 'shared')),
  channel text not null check (channel in ('mail', 'email')),
  -- Every element is {body_id, display_name}; the upsert function validates
  -- each one. display_name is null when no safe display name exists, and
  -- such an organization is never offered on the page.
  orgs jsonb not null check (
    pg_catalog.jsonb_typeof(orgs) = 'array'
    and pg_catalog.jsonb_array_length(orgs) between 1 and 1000
    and (kind = 'single') = (pg_catalog.jsonb_array_length(orgs) = 1)
  ),
  created_at timestamptz not null default pg_catalog.now()
);

alter table private.union_outreach_codes enable row level security;
alter table private.union_outreach_codes force row level security;
revoke all on private.union_outreach_codes from public, anon, authenticated, service_role;

comment on table private.union_outreach_codes is
  'Outreach codes printed on letters and in emails for /contribute: kind, channel and the organizations as {body_id, display_name}. No address. Written only by upsert_union_outreach_codes and read only by lookup_union_outreach_code and begin_union_document_contribution; no client grant.';

-- ------------------------------------------------- 2. contribution columns and the 40-file limit

alter table public.union_document_contributions
  drop constraint union_document_contributions_file_count_check,
  add constraint union_document_contributions_file_count_check check (file_count between 1 and 40),
  add column outreach_code text
    check (outreach_code is null or outreach_code ~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$'),
  add column outreach_body_id text
    check (outreach_body_id is null or (outreach_code is not null and outreach_body_id ~ '^[a-z]{2,12}-[A-Za-z0-9]{1,40}$')),
  add column notify_via text not null default 'email' check (notify_via in ('email', 'text', 'mail')),
  add column notify_phone text check (notify_phone is null or notify_phone ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  add column notify_mail_address text check (
    notify_mail_address is null or (
      char_length(notify_mail_address) between 10 and 300
      and pg_catalog.translate(notify_mail_address, pg_catalog.chr(10), '') !~ '[[:cntrl:]]'
    )
  ),
  add constraint union_document_contributions_notify_shape check (
    (notify_via = 'email' and notify_phone is null and notify_mail_address is null)
    or (notify_via = 'text' and notify_phone is not null and notify_mail_address is null)
    or (notify_via = 'mail' and notify_mail_address is not null and notify_phone is null)
  );

comment on column public.union_document_contributions.outreach_code is
  'The outreach code the visitor arrived with, when it was a known code; null otherwise.';
comment on column public.union_document_contributions.outreach_body_id is
  'The body_id of the organization chosen from the outreach code; null when the visitor typed the organization.';
comment on column public.union_document_contributions.notify_via is
  'How the contributor wants to hear that the digitized forms are ready: email (contact_email), text (notify_phone) or mail (notify_mail_address).';

alter table public.union_document_contribution_files
  drop constraint union_document_contribution_files_position_check,
  add constraint union_document_contribution_files_position_check check (position between 1 and 40);

-- ------------------------------------------------- 3. the code writer (service role only)

-- p_codes is a JSON array of 1 to 1000 objects {code, kind, channel, orgs}.
-- Any invalid entry refuses the whole call before a row is written. An
-- existing code is updated only when its kind, channel or organizations
-- changed; created_at is kept.
--
-- A visitor's choice is the organization's position on the code, so a
-- refresh may rename organizations and append new ones but never move or
-- drop a body_id an existing code already has at a position: that would
-- attribute a pending visitor's documents to another organization.
-- Remapping takes a new code.
--
-- Two imports of the same code must not both validate against the same
-- positions and then overwrite each other's appended organizations.
-- Each call takes a transaction lock per incoming code,
-- in sorted order so overlapping batches cannot deadlock, before it reads
-- what a code already holds, and keeps the locks until it commits. The
-- conflicting update repeats the position check against the row it locked,
-- and every entry must end either written or already equal; anything else
-- refuses the whole call.
create function public.upsert_union_outreach_codes(p_codes jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
  updated_count integer;
  unchanged_count integer;
  total integer;
  locked_code text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_codes) is distinct from 'array' then
    raise exception 'invalid outreach codes' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_codes) not between 1 and 1000 then
    raise exception 'invalid outreach codes' using errcode = '22023';
  end if;
  -- OR operands have no guaranteed evaluation order, so every array or
  -- object function runs only inside a CASE branch that proved the type.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_codes) as entry(value)
    where case when pg_catalog.jsonb_typeof(entry.value) <> 'object' then true
      when pg_catalog.jsonb_typeof(entry.value -> 'orgs') is distinct from 'array' then true
      else coalesce(entry.value ->> 'code', '') !~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$'
        or coalesce(entry.value ->> 'kind', '') not in ('single', 'shared')
        or coalesce(entry.value ->> 'channel', '') not in ('mail', 'email')
        or pg_catalog.jsonb_array_length(entry.value -> 'orgs') not between 1 and 1000
        or ((entry.value ->> 'kind') = 'single') <> (pg_catalog.jsonb_array_length(entry.value -> 'orgs') = 1)
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(entry.value -> 'orgs') as org(value)
          where case when pg_catalog.jsonb_typeof(org.value) <> 'object' then true
            else coalesce(org.value ->> 'body_id', '') !~ '^[a-z]{2,12}-[A-Za-z0-9]{1,40}$'
              or pg_catalog.jsonb_typeof(coalesce(org.value -> 'display_name', 'null'::jsonb)) not in ('string', 'null')
              or char_length(pg_catalog.btrim(coalesce(org.value ->> 'display_name', 'ok'))) not between 2 and 500
              or coalesce(org.value ->> 'display_name', '') ~ '[[:cntrl:]]'
              or exists (select 1 from pg_catalog.jsonb_object_keys(org.value) as key(name) where key.name not in ('body_id', 'display_name'))
            end
        )
      end
  ) or (
    select pg_catalog.count(distinct entry.value ->> 'code') <> pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_codes) as entry(value)
  ) then
    raise exception 'invalid outreach codes' using errcode = '22023';
  end if;

  for locked_code in
    select entry.value ->> 'code'
    from pg_catalog.jsonb_array_elements(p_codes) as entry(value)
    order by (entry.value ->> 'code') collate "C"
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('private.union_outreach_codes:' || locked_code, 0));
  end loop;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_codes) as entry(value)
    join private.union_outreach_codes as existing on existing.code = entry.value ->> 'code'
    cross join lateral pg_catalog.jsonb_array_elements(existing.orgs) with ordinality as held(value, position)
    where (entry.value -> 'orgs' -> (held.position::integer - 1) ->> 'body_id') is distinct from (held.value ->> 'body_id')
  ) then
    raise exception 'outreach code remapped' using errcode = '22023',
      detail = 'An existing code keeps the body_id at every position it already has; issue a new code instead.';
  end if;

  with incoming as (
    select entry.value ->> 'code' as code, entry.value ->> 'kind' as kind,
      entry.value ->> 'channel' as channel,
      (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'body_id', org.value ->> 'body_id',
            'display_name', nullif(pg_catalog.btrim(coalesce(org.value ->> 'display_name', '')), '')
          ) order by org.ordinality)
        from pg_catalog.jsonb_array_elements(entry.value -> 'orgs') with ordinality as org(value, ordinality)
      ) as orgs
    from pg_catalog.jsonb_array_elements(p_codes) as entry(value)
  ), written as (
    insert into private.union_outreach_codes as existing (code, kind, channel, orgs)
    select incoming.code, incoming.kind, incoming.channel, incoming.orgs from incoming
    on conflict (code) do update set
      kind = excluded.kind, channel = excluded.channel, orgs = excluded.orgs
    where (existing.kind, existing.channel, existing.orgs) is distinct from (excluded.kind, excluded.channel, excluded.orgs)
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(existing.orgs) with ordinality as held(value, position)
        where (excluded.orgs -> (held.position::integer - 1) ->> 'body_id') is distinct from (held.value ->> 'body_id')
      )
    returning (xmax = 0) as fresh
  )
  select
    (select pg_catalog.count(*) filter (where fresh) from written),
    (select pg_catalog.count(*) filter (where not fresh) from written),
    (
      select pg_catalog.count(*)
      from incoming
      join private.union_outreach_codes as stored on stored.code = incoming.code
      where (stored.kind, stored.channel, stored.orgs) is not distinct from (incoming.kind, incoming.channel, incoming.orgs)
    )
  into inserted_count, updated_count, unchanged_count;

  total := pg_catalog.jsonb_array_length(p_codes);
  if inserted_count + updated_count + unchanged_count <> total then
    raise exception 'outreach code changed concurrently' using errcode = '40001',
      detail = 'Another import changed one of these codes; nothing was written. Run the import again.';
  end if;
  return pg_catalog.jsonb_build_object(
    'inserted', inserted_count, 'updated', updated_count, 'unchanged', unchanged_count
  );
end;
$$;

revoke all on function public.upsert_union_outreach_codes(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.upsert_union_outreach_codes(jsonb) to service_role;

comment on function public.upsert_union_outreach_codes(jsonb) is
  'Service-only writer of outreach codes (scripts/import-outreach-codes.mjs --apply): validates every entry of a 1 to 1000 code batch before writing, locks each incoming code, refuses to move or drop an organization a code already holds at a position, then inserts new codes and updates changed ones by code.';

-- ------------------------------------------------- 4. the code lookup (service role only)

-- The page asks once per visit. A known code answers its kind and the
-- organizations that have a display name, each with its 1-based position on
-- the code (the submission sends the position back, never a body_id). An
-- unknown code, and a known code with no displayable organization, answer
-- exactly like no code.
create function public.lookup_union_outreach_code(p_code text, p_scope_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_code text := pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_code, ''), '[[:space:]-]', '', 'g'));
  code_row private.union_outreach_codes%rowtype;
  named jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;
  if normalized_code !~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$' then
    raise exception 'invalid outreach code' using errcode = '22023';
  end if;
  if not private.consume_public_interest_submission_limit(
    p_scope_hash, 'network-15m', 30, interval '15 minutes'
  ) then
    return pg_catalog.jsonb_build_object('refusal', 'rate-limited');
  end if;

  select * into code_row
  from private.union_outreach_codes as candidate
  where candidate.code = normalized_code;
  if not found then
    return pg_catalog.jsonb_build_object('kind', null, 'organizations', '[]'::jsonb);
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'choice', org.ordinality, 'name', org.value ->> 'display_name'
    ) order by org.ordinality), '[]'::jsonb)
  into named
  from pg_catalog.jsonb_array_elements(code_row.orgs) with ordinality as org(value, ordinality)
  where pg_catalog.jsonb_typeof(org.value -> 'display_name') = 'string';

  if pg_catalog.jsonb_array_length(named) = 0 then
    return pg_catalog.jsonb_build_object('kind', null, 'organizations', '[]'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object('kind', code_row.kind, 'organizations', named);
end;
$$;

revoke all on function public.lookup_union_outreach_code(text, text) from public, anon, authenticated, service_role;
grant execute on function public.lookup_union_outreach_code(text, text) to service_role;

comment on function public.lookup_union_outreach_code(text, text) is
  'Service-only /contribute code lookup behind the landing limiter (30 per network per 15 minutes): answers the kind and the display names with their positions, never a body_id; an unknown code answers like no code.';

-- ------------------------------------------------- 5. the inspection budget for 40 files

-- Unchanged except the per-network inspection budget, 60 -> 600 per 15
-- minutes. Each file needs at least one register call and the page asks again
-- for an upload not yet visible, a running lease and an ambiguous answer, so
-- 60 could not cover even two 40-file submissions from one office (shared
-- codes send one submission per organization). 600 covers the ten
-- submissions per network the begin limiter admits per 15 minutes at 40 files
-- each with half again for re-asks. Every
-- scan still needs a granted lease, and leases stay at three per file.
create or replace function public.authorize_union_document_file_inspection(
  p_contribution_id uuid,
  p_file_id uuid,
  p_receipt_hash text,
  p_scope_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  contribution_receipt text;
  file_row public.union_document_contribution_files%rowtype;
  object_row storage.objects%rowtype;
  attempt uuid;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_contribution_id is null or p_file_id is null
     or p_receipt_hash is null or p_receipt_hash !~ '^[0-9a-f]{64}$'
     or p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid inspection request' using errcode = '22023';
  end if;
  if not private.consume_public_interest_submission_limit(
    p_scope_hash, 'network-15m', 600, interval '15 minutes'
  ) then
    return pg_catalog.jsonb_build_object('refusal', 'rate-limited');
  end if;

  select contribution.receipt_hash into contribution_receipt
  from public.union_document_contributions as contribution
  where contribution.id = p_contribution_id;
  if contribution_receipt is null or contribution_receipt <> p_receipt_hash then
    return pg_catalog.jsonb_build_object('refusal', 'not-found');
  end if;

  select * into file_row
  from public.union_document_contribution_files as candidate
  where candidate.id = p_file_id and candidate.contribution_id = p_contribution_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('refusal', 'not-found');
  end if;
  if file_row.inspection_status in ('clean', 'blocked') then
    return pg_catalog.jsonb_build_object('fileId', file_row.id, 'status', file_row.inspection_status);
  end if;
  if file_row.inspection_lease_until is not null and file_row.inspection_lease_until > clock_timestamp() then
    return pg_catalog.jsonb_build_object('refusal', 'busy');
  end if;
  if file_row.inspection_attempts >= 3 then
    return pg_catalog.jsonb_build_object('fileId', file_row.id, 'status', file_row.inspection_status, 'refusal', 'exhausted');
  end if;

  select * into object_row
  from storage.objects as stored
  where stored.bucket_id = file_row.bucket and stored.name = file_row.object_path;
  if not found then
    return pg_catalog.jsonb_build_object('refusal', 'not-uploaded');
  end if;

  if (object_row.metadata ->> 'size') is distinct from file_row.size_bytes::text
     or pg_catalog.split_part(pg_catalog.lower(coalesce(object_row.metadata ->> 'mimetype', '')), ';', 1) <> file_row.mime then
    update public.union_document_contribution_files
    set inspection_status = 'blocked', inspected_at = clock_timestamp(), storage_object_id = object_row.id,
      inspection_attempt_id = null, inspection_lease_until = null
    where id = file_row.id;
    return pg_catalog.jsonb_build_object('fileId', file_row.id, 'status', 'blocked');
  end if;

  attempt := pg_catalog.gen_random_uuid();
  update public.union_document_contribution_files
  set inspection_attempts = inspection_attempts + 1,
    inspection_attempt_id = attempt,
    inspection_lease_until = clock_timestamp() + interval '60 seconds',
    storage_object_id = object_row.id
  where id = file_row.id;

  return pg_catalog.jsonb_build_object(
    'fileId', file_row.id,
    'attemptId', attempt,
    'bucketId', file_row.bucket,
    'objectName', file_row.object_path,
    'objectId', object_row.id,
    'filename', file_row.original_name,
    'mimeType', file_row.mime,
    'sizeBytes', file_row.size_bytes
  );
end;
$$;

revoke all on function public.authorize_union_document_file_inspection(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_union_document_file_inspection(uuid, uuid, text, text) to service_role;

comment on function public.authorize_union_document_file_inspection(uuid, uuid, text, text) is
  'Service-only /contribute inspection lease behind 600 requests per network per 15 minutes: receipt-bound, at most three 60-second attempts per file, binds the stored object id, and blocks bytes whose stored size or type disagrees with the declaration.';


-- ------------------------------------------------- 6. the public write, now with the code and the preference

drop function public.begin_union_document_contribution(text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text);

-- As in 20261022172000, plus: p_outreach_code (any spacing or hyphens, or
-- null), p_outreach_choice (the 1-based position from the lookup, or null
-- for a typed organization), and the required preference p_notify_via with
-- its contact value. A known code is stored with the submission; a chosen
-- position that names an organization stores its body_id and display name.
-- A shared code raises the per-address daily allowance from 5 to 25, since
-- one officer may send one submission per organization at that address.
create function public.begin_union_document_contribution(
  p_email text,
  p_organization_name text,
  p_affiliation text,
  p_state text,
  p_contact_name text,
  p_contact_role text,
  p_notes text,
  p_blank_forms_attested boolean,
  p_permission_granted boolean,
  p_files jsonb,
  p_receipt_hash text,
  p_website text,
  p_scope_hash text,
  p_email_scope_hash text,
  p_outreach_code text,
  p_outreach_choice integer,
  p_notify_via text,
  p_notify_phone text,
  p_notify_mail_address text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  organization_name text := nullif(pg_catalog.btrim(coalesce(p_organization_name, '')), '');
  affiliation text := nullif(pg_catalog.btrim(coalesce(p_affiliation, '')), '');
  contact_name text := nullif(pg_catalog.btrim(coalesce(p_contact_name, '')), '');
  notes text := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  files jsonb := case when pg_catalog.jsonb_typeof(p_files) = 'array' then p_files else '[]'::jsonb end;
  normalized_code text := nullif(pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_outreach_code, ''), '[[:space:]-]', '', 'g')), '');
  notify_phone text := nullif(pg_catalog.btrim(coalesce(p_notify_phone, '')), '');
  notify_mail_address text := nullif(pg_catalog.btrim(pg_catalog.replace(coalesce(p_notify_mail_address, ''), pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10))), '');
  moment timestamptz := clock_timestamp();
  derived_suppression_scope_hash text;
  suppressed boolean;
  new_contribution_id uuid;
  stored_files jsonb;
  payload_invalid boolean;
  code_row private.union_outreach_codes%rowtype;
  stored_code text;
  chosen jsonb;
  chosen_body_id text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;

  -- Honeypot submissions receive the same answer without a row or a limit hit.
  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then
    return pg_catalog.jsonb_build_object('accepted', true, 'stored', false, 'files', '[]'::jsonb);
  end if;

  payload_invalid := char_length(normalized_email) > 254
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or normalized_email ~ '[[:cntrl:]]'
    or organization_name is null
    or char_length(organization_name) not between 2 and 160
    or organization_name ~ '[[:cntrl:]]'
    or (affiliation is not null and (char_length(affiliation) > 160 or affiliation ~ '[[:cntrl:]]'))
    or contact_name is null
    or char_length(contact_name) not between 2 and 120
    or contact_name ~ '[[:cntrl:]]'
    or p_contact_role is null or p_contact_role not in ('officer', 'staff', 'steward', 'member', 'other')
    or p_state is null
    or p_state <> all (array[
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
      'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
      'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
      'VT','VA','WA','WV','WI','WY','AS','GU','MP','PR','VI','outside-us'
    ]::text[])
    or (notes is not null and char_length(notes) > 2000)
    or p_blank_forms_attested is not true
    or p_permission_granted is not true
    or p_receipt_hash is null or p_receipt_hash !~ '^[0-9a-f]{64}$'
    or (normalized_code is not null and normalized_code !~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$')
    or (p_outreach_choice is not null and (normalized_code is null or p_outreach_choice not between 1 and 1000))
    or p_notify_via is null or p_notify_via not in ('email', 'text', 'mail')
    or (p_notify_via = 'text') <> (notify_phone is not null)
    or (notify_phone is not null and notify_phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$')
    or (p_notify_via = 'mail') <> (notify_mail_address is not null)
    or (notify_mail_address is not null and (
      char_length(notify_mail_address) not between 10 and 300
      or pg_catalog.translate(notify_mail_address, pg_catalog.chr(10), '') ~ '[[:cntrl:]]'
    ))
    or pg_catalog.jsonb_array_length(files) not between 1 and 40
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(files) as entry(value)
      where pg_catalog.jsonb_typeof(entry.value) <> 'object'
        or pg_catalog.jsonb_typeof(entry.value -> 'name') is distinct from 'string'
        or char_length(pg_catalog.btrim(entry.value ->> 'name')) not between 1 and 160
        or (entry.value ->> 'name') ~ '[/\\]'
        or (entry.value ->> 'name') ~ '[[:cntrl:]]'
        or coalesce(entry.value ->> 'kind', '') not in ('contract', 'bylaws', 'grievance-form', 'other-form', 'other')
        or coalesce(entry.value ->> 'mime', '') not in (
          'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'text/csv',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        or pg_catalog.jsonb_typeof(entry.value -> 'size') is distinct from 'number'
        -- The cast runs only on a value the pattern admitted: OR operands
        -- have no guaranteed evaluation order.
        or case when (entry.value ->> 'size') ~ '^[1-9][0-9]{0,7}$'
             then (entry.value ->> 'size')::bigint > 10485760
             else true end
    );
  -- The server validates every field first, so an invalid payload here is a
  -- caller defect, not a visitor's typo: refuse it before any limit is spent.
  if payload_invalid then
    raise exception 'invalid contribution' using errcode = '22023';
  end if;

  -- An unknown code is stored as no code, exactly as the lookup answers it.
  if normalized_code is not null then
    select * into code_row
    from private.union_outreach_codes as candidate
    where candidate.code = normalized_code;
    if found then
      stored_code := code_row.code;
      if p_outreach_choice is not null then
        chosen := code_row.orgs -> (p_outreach_choice - 1);
        if pg_catalog.jsonb_typeof(chosen -> 'display_name') = 'string' then
          chosen_body_id := chosen ->> 'body_id';
          organization_name := pg_catalog.left(chosen ->> 'display_name', 160);
        end if;
      end if;
    end if;
  end if;

  if not private.consume_public_interest_submission_limit(
    p_scope_hash, 'network-15m', 10, interval '15 minutes'
  ) or not private.consume_public_interest_submission_limit(
    p_email_scope_hash, 'email-interest-day',
    case when code_row.kind = 'shared' then 25 else 5 end, interval '1 day'
  ) then
    return pg_catalog.jsonb_build_object('accepted', false, 'refusal', 'rate-limited');
  end if;

  derived_suppression_scope_hash := private.public_interest_suppression_scope(normalized_email);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-interest-suppression:' || derived_suppression_scope_hash,
      509
    )
  );

  -- A stopped address is recorded, never answered differently: the visitor
  -- chose to send these documents, and the answer must not reveal the ledger.
  suppressed := exists (
    select 1
    from private.public_interest_suppressions as suppression
    where suppression.suppression_scope_hash = derived_suppression_scope_hash
  );

  insert into public.union_document_contributions (
    organization_name, affiliation, state, contact_name, contact_role, contact_email,
    notes, blank_forms_attested, permission_granted, file_count, receipt_hash, contact_suppressed,
    outreach_code, outreach_body_id, notify_via, notify_phone, notify_mail_address
  ) values (
    organization_name, affiliation, p_state, contact_name, p_contact_role, normalized_email,
    pg_catalog.replace(notes, pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10)), true, true, pg_catalog.jsonb_array_length(files), p_receipt_hash, suppressed,
    stored_code, chosen_body_id, p_notify_via, notify_phone, notify_mail_address
  )
  returning id into new_contribution_id;

  with entries as (
    select entry.value, entry.ordinality::smallint as position, pg_catalog.gen_random_uuid() as file_id
    from pg_catalog.jsonb_array_elements(files) with ordinality as entry(value, ordinality)
  ), inserted as (
    insert into public.union_document_contribution_files (
      id, contribution_id, position, object_path, original_name, declared_kind, mime, size_bytes
    )
    select e.file_id, new_contribution_id, e.position,
      new_contribution_id::text || '/' || e.file_id::text,
      pg_catalog.btrim(e.value ->> 'name'), e.value ->> 'kind', e.value ->> 'mime', (e.value ->> 'size')::integer
    from entries e
    returning id, position, object_path
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fileId', inserted.id, 'position', inserted.position, 'objectPath', inserted.object_path
    ) order by inserted.position), '[]'::jsonb)
  into stored_files
  from inserted;

  delete from private.public_interest_submission_limits as stale
  where stale.ctid in (
    select candidate.ctid
    from private.public_interest_submission_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash not in (p_scope_hash, p_email_scope_hash)
    order by candidate.window_started_at
    limit 200
    for update skip locked
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true, 'stored', true, 'contributionId', new_contribution_id, 'files', stored_files
  );
end;
$$;

revoke all on function public.begin_union_document_contribution(text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text, text, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_union_document_contribution(text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text, text, integer, text, text, text)
  to service_role;

comment on function public.begin_union_document_contribution(text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text, text, integer, text, text, text) is
  'Service-only /contribute write: validates the submission, both attestations, 1 to 40 declared files and the required notification preference, stores a known outreach code and the chosen organization''s body_id, charges the landing limiter under its own HMAC scopes, reads the Vault-keyed suppression ledger under its transaction lock into contact_suppressed without changing the answer, and stores one contribution with one pending row per file.';

-- ------------------------------------------------- 7. the owner read, now with the code and the preference

create or replace function public.list_union_document_contributions(p_status text, p_actor text, p_before timestamptz, p_before_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor text := nullif(pg_catalog.btrim(coalesce(p_actor, '')), '');
  wanted text := nullif(pg_catalog.btrim(coalesce(p_status, '')), '');
  contributions_json jsonb;
  fetched integer;
  total integer;
  has_more boolean;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if actor is null or char_length(actor) not between 2 and 80 then
    raise exception 'actor required' using errcode = '22023';
  end if;
  if wanted is not null and wanted not in ('pending', 'received', 'reviewed', 'digitized', 'declined') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if (p_before is null) <> (p_before_id is null) then
    raise exception 'cursor needs both parts' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', page.id,
      'createdAt', page.created_at,
      'organizationName', page.organization_name,
      'affiliation', page.affiliation,
      'state', page.state,
      'contactName', page.contact_name,
      'contactRole', page.contact_role,
      'contactEmail', page.contact_email,
      'contactSuppressed', page.contact_suppressed or exists (
        select 1 from private.public_interest_suppressions s
        where s.suppression_scope_hash = private.public_interest_suppression_scope(page.contact_email)),
      'notifyVia', page.notify_via,
      'notifyPhone', page.notify_phone,
      'notifyMailAddress', page.notify_mail_address,
      'outreachCode', page.outreach_code,
      'outreachBodyId', page.outreach_body_id,
      'notes', page.notes,
      'blankFormsAttested', page.blank_forms_attested,
      'permissionGranted', page.permission_granted,
      'status', page.status,
      'statusChangedAt', page.status_changed_at,
      'reviewerNotes', page.reviewer_notes,
      'files', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', f.id,
            'position', f.position,
            'declaredKind', f.declared_kind,
            'originalName', f.original_name,
            'mime', f.mime,
            'sizeBytes', f.size_bytes,
            'bucket', f.bucket,
            'objectPath', f.object_path,
            'sha256', f.sha256,
            'inspectionStatus', f.inspection_status,
            'inspectedAt', f.inspected_at
          ) order by f.position), '[]'::jsonb)
        from public.union_document_contribution_files f
        where f.contribution_id = page.id
      )
    ) order by page.created_at desc, page.id), '[]'::jsonb)
  into contributions_json
  from (
    select c.*
    from public.union_document_contributions c
    where (wanted is null or c.status = wanted)
      and (p_before is null
        or c.created_at < p_before
        or (c.created_at = p_before and c.id > p_before_id))
    order by c.created_at desc, c.id
    limit 101
  ) page;

  fetched := pg_catalog.jsonb_array_length(contributions_json);
  has_more := fetched > 100;
  if has_more then
    contributions_json := contributions_json - 100;
  end if;
  total := pg_catalog.jsonb_array_length(contributions_json);

  insert into private.union_document_contribution_access_events (actor, action, status_filter, row_count)
  values (actor, 'list', wanted, total);

  return pg_catalog.jsonb_build_object(
    'status', wanted,
    'rowCount', total,
    'contributions', contributions_json,
    'hasMore', has_more,
    'cursorCreatedAt', case when total > 0 then contributions_json -> (total - 1) -> 'createdAt' end,
    'cursorId', case when total > 0 then contributions_json -> (total - 1) -> 'id' end
  );
end;
$$;

revoke all on function public.list_union_document_contributions(text, text, timestamptz, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_union_document_contributions(text, text, timestamptz, uuid) to service_role;

comment on function public.list_union_document_contributions(text, text, timestamptz, uuid) is
  'Service-only owner read of /contribute submissions with their outreach code, notification preference, files and verdicts: one page of at most 100 ordered by (created_at desc, id), optional status filter, two-part keyset cursor. Writes one access event per call.';

notify pgrst, 'reload schema';

commit;
