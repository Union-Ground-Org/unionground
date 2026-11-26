-- REQ-UG-UNION-DOCUMENT-INTAKE-PAGE-20261022: the public "Share your
-- union's documents" page (/contribute; project decisions of October 22, 2026:
-- an upload page on unionground.net, blank forms only, every file through the
-- production private-upload scanner, no account, English only, an invitation
-- only ever sent by the operator).
--
-- An officer of a labor organization uploads blank contracts, bylaws,
-- grievance forms and other forms so Union Ground can digitize them. The
-- browser never touches Storage or these tables: api/document-contribution.js
-- calls the service-only functions below, mints one signed upload target per
-- file into the private bucket created here, and records the scanner's verdict
-- through the same lease shape as the private-upload pipeline
-- (authorize_private_upload_inspection / finish_private_upload_inspection).
--
--   * The bucket is private, takes the eight private-upload formats and 10 MiB,
--     and has no storage.objects policy, so no anon or authenticated client can
--     list, read, write or sign anything in it. Only the service role (the
--     server function and the operator) reaches it.
--   * A file counts as received only after a clean verdict; a contribution
--     stays 'pending' until its first clean file, and a blocked or failed file
--     is never shown as received.
--   * The writes share the landing form's durable limiter, keyed by their own
--     HMAC purposes so the landing and request-to-join allowances are
--     untouched, and read its Vault-keyed suppression ledger. A stopped
--     address is stored and answered exactly like any other, so the public
--     answer never reveals the ledger; the row carries contact_suppressed so
--     the operator does not contact that address.
--   * Both tables keep RLS on with no permissive policy and no client grant
--     (the public_interest_submissions posture). The owner reads and works the
--     queue only through two service-role functions, each writing one row to
--     private.union_document_contribution_access_events.
--
-- Nothing here creates an account, an organization or an invitation, and the
-- organization name is what the contributor typed: never a claim about any
-- affiliation of the operator. Converting a file to a fillable form and
-- returning a copy are separate records.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------- 1. the private bucket

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'union-document-contributions', 'union-document-contributions', false, 10485760,
  array[
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
    'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ------------------------------------------------- 2. contributions and their files

create table public.union_document_contributions (
  id uuid primary key default extensions.gen_random_uuid(),
  created_at timestamptz not null default pg_catalog.now(),
  organization_name text not null
    check (char_length(organization_name) between 2 and 160 and organization_name !~ '[[:cntrl:]]'),
  affiliation text
    check (affiliation is null or (char_length(affiliation) between 1 and 160 and affiliation !~ '[[:cntrl:]]')),
  state text not null check (state ~ '^[A-Z]{2}$' or state = 'outside-us'),
  contact_name text not null
    check (char_length(contact_name) between 2 and 120 and contact_name !~ '[[:cntrl:]]'),
  contact_role text not null check (contact_role in ('officer', 'staff', 'steward', 'member', 'other')),
  contact_email text not null check (
    char_length(contact_email) <= 254
    and contact_email = pg_catalog.lower(contact_email)
    and contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    and contact_email !~ '[[:cntrl:]]'
  ),
  notes text check (notes is null or char_length(notes) between 1 and 2000),
  blank_forms_attested boolean not null check (blank_forms_attested),
  permission_granted boolean not null check (permission_granted),
  source text not null default 'contribute-page' check (source = 'contribute-page'),
  status text not null default 'pending'
    check (status in ('pending', 'received', 'reviewed', 'digitized', 'declined')),
  status_changed_at timestamptz,
  reviewer_notes text check (reviewer_notes is null or char_length(reviewer_notes) between 1 and 2000),
  file_count smallint not null check (file_count between 1 and 10),
  -- SHA-256 of the per-contribution receipt the browser holds; only a caller
  -- presenting the receipt may ask for one of its files to be inspected.
  receipt_hash text not null check (receipt_hash ~ '^[0-9a-f]{64}$'),
  -- The address was on the suppression ledger when the submission arrived:
  -- the operator does not email it.
  contact_suppressed boolean not null default false
);

create index union_document_contributions_queue_idx
  on public.union_document_contributions (created_at desc, id);

comment on table public.union_document_contributions is
  'Public /contribute submissions: organization and contact as typed, both attestations, operator status. No client access; written and read only through service-role definer functions.';
comment on column public.union_document_contributions.organization_name is
  'The organization the contributor typed. Never a claim about any affiliation of the operator.';

create table public.union_document_contribution_files (
  id uuid primary key default extensions.gen_random_uuid(),
  contribution_id uuid not null references public.union_document_contributions (id) on delete cascade,
  position smallint not null check (position between 1 and 10),
  bucket text not null default 'union-document-contributions' check (bucket = 'union-document-contributions'),
  object_path text not null unique
    check (object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  original_name text not null check (
    char_length(pg_catalog.btrim(original_name)) between 1 and 160
    and original_name !~ '[/\\]' and original_name !~ '[[:cntrl:]]'
  ),
  declared_kind text not null
    check (declared_kind in ('contract', 'bylaws', 'grievance-form', 'other-form', 'other')),
  mime text not null check (mime in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  inspection_status text not null default 'pending'
    check (inspection_status in ('pending', 'clean', 'blocked', 'failed')),
  inspected_at timestamptz,
  scan_engine text check (scan_engine is null or char_length(scan_engine) between 1 and 120),
  signature_version bigint check (signature_version is null or signature_version > 0),
  signature_updated_at timestamptz,
  storage_object_id uuid,
  inspection_attempts smallint not null default 0 check (inspection_attempts between 0 and 3),
  inspection_attempt_id uuid unique,
  inspection_lease_until timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  unique (contribution_id, position),
  constraint union_document_contribution_files_clean_shape check (
    inspection_status <> 'clean' or (
      sha256 is not null and inspected_at is not null and scan_engine is not null
      and signature_version is not null and signature_updated_at is not null
      and storage_object_id is not null
    )
  ),
  constraint union_document_contribution_files_lease_shape check (
    (inspection_attempt_id is null) = (inspection_lease_until is null)
  )
);

comment on table public.union_document_contribution_files is
  'One row per file of a /contribute submission: the private object, the declared kind and the scanner verdict. A file counts as received only when inspection_status is clean.';

alter table public.union_document_contributions enable row level security;
alter table public.union_document_contributions force row level security;
alter table public.union_document_contribution_files enable row level security;
alter table public.union_document_contribution_files force row level security;

create policy mfa_assurance on public.union_document_contributions
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.union_document_contributions is
  'Restrictive floor shared by every table in public. There is no permissive policy and no client grant, so contributions are reachable only through the service-role definer functions.';
create policy mfa_assurance on public.union_document_contribution_files
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.union_document_contribution_files is
  'Restrictive floor shared by every table in public. There is no permissive policy and no client grant, so contribution files are reachable only through the service-role definer functions.';

revoke all on public.union_document_contributions from public, anon, authenticated, service_role;
revoke all on public.union_document_contribution_files from public, anon, authenticated, service_role;

-- ------------------------------------------------- 3. the owner access ledger

create table private.union_document_contribution_access_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default pg_catalog.now(),
  actor text not null check (char_length(actor) between 2 and 80),
  action text not null check (action in ('list', 'status')),
  status_filter text check (status_filter is null
    or status_filter in ('pending', 'received', 'reviewed', 'digitized', 'declined')),
  row_count integer check (row_count is null or row_count >= 0),
  contribution_id uuid,
  from_status text check (from_status is null
    or from_status in ('pending', 'received', 'reviewed', 'digitized', 'declined')),
  to_status text check (to_status is null
    or to_status in ('pending', 'received', 'reviewed', 'digitized', 'declined')),
  constraint union_document_contribution_access_events_shape check (
    (action = 'list'
      and row_count is not null
      and contribution_id is null and from_status is null and to_status is null)
    or
    (action = 'status'
      and contribution_id is not null and from_status is not null and to_status is not null
      and row_count is null and status_filter is null)
  )
);

alter table private.union_document_contribution_access_events enable row level security;
alter table private.union_document_contribution_access_events force row level security;
revoke all on private.union_document_contribution_access_events from public, anon, authenticated, service_role;

comment on table private.union_document_contribution_access_events is
  'Audit of every owner list and status change of /contribute submissions. Written only by the two service-role functions; no client grant.';

-- ------------------------------------------------- 4. the public write (service role only)

-- p_files is a JSON array of 1 to 10 objects {name, kind, mime, size}. The
-- answer carries the file ids and object paths the server signs upload
-- targets for, and a limiter hit gets accepted false with the refusal. A
-- suppressed address gets the same stored answer as any other (a
-- different answer would let anyone test an address
-- against the private ledger); only contact_suppressed on the row differs.
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
  p_email_scope_hash text
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
  moment timestamptz := clock_timestamp();
  derived_suppression_scope_hash text;
  suppressed boolean;
  new_contribution_id uuid;
  stored_files jsonb;
  payload_invalid boolean;
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
    or pg_catalog.jsonb_array_length(files) not between 1 and 10
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

  if not private.consume_public_interest_submission_limit(
    p_scope_hash, 'network-15m', 10, interval '15 minutes'
  ) or not private.consume_public_interest_submission_limit(
    p_email_scope_hash, 'email-interest-day', 5, interval '1 day'
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
    notes, blank_forms_attested, permission_granted, file_count, receipt_hash, contact_suppressed
  ) values (
    organization_name, affiliation, p_state, contact_name, p_contact_role, normalized_email,
    pg_catalog.replace(notes, pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10)), true, true, pg_catalog.jsonb_array_length(files), p_receipt_hash, suppressed
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

revoke all on function public.begin_union_document_contribution(text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_union_document_contribution(text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text)
  to service_role;

comment on function public.begin_union_document_contribution(text, text, text, text, text, text, text, boolean, boolean, jsonb, text, text, text, text) is
  'Service-only /contribute write: validates the submission and both attestations, charges the landing limiter under its own HMAC scopes, reads the Vault-keyed suppression ledger under its transaction lock into contact_suppressed without changing the answer, and stores one contribution with one pending row per file.';

-- ------------------------------------------------- 5. the scanner lease (service role only)

-- Reserves one 60-second inspection attempt for a file the caller proves it
-- uploaded (the receipt digest). At most three attempts per file. A file with
-- no stored object yet, an unknown file and a wrong receipt spend no attempt.
-- Bytes whose stored size or type disagrees with what was declared are
-- blocked without being scanned.
create function public.authorize_union_document_file_inspection(
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
    p_scope_hash, 'network-15m', 60, interval '15 minutes'
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
  'Service-only /contribute inspection lease: receipt-bound, at most three 60-second attempts per file, binds the stored object id, and blocks bytes whose stored size or type disagrees with the declaration.';

-- Records the verdict for a live attempt only. A clean verdict needs the full
-- scanner provenance and the same stored object the lease bound; the first
-- clean file marks the contribution received.
create function public.finish_union_document_file_inspection(
  p_attempt_id uuid,
  p_verdict text,
  p_sha256 text,
  p_engine text,
  p_signature_version bigint,
  p_signature_updated_at timestamptz,
  p_scanned_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  file_row public.union_document_contribution_files%rowtype;
  verdict text := p_verdict;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_attempt_id is null or p_verdict is null or p_verdict not in ('clean', 'blocked', 'failed') then
    raise exception 'invalid inspection verdict' using errcode = '22023';
  end if;
  if p_verdict = 'clean' and (
    p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
    or p_engine is null or char_length(p_engine) not between 1 and 120
    or p_signature_version is null or p_signature_version < 1
    or p_signature_updated_at is null or p_scanned_at is null
  ) then
    raise exception 'clean verdict needs scanner provenance' using errcode = '22023';
  end if;
  if p_sha256 is not null and p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid digest' using errcode = '22023';
  end if;

  select * into file_row
  from public.union_document_contribution_files as candidate
  where candidate.inspection_attempt_id = p_attempt_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('recorded', false, 'refusal', 'stale');
  end if;
  if file_row.inspection_lease_until <= clock_timestamp() then
    update public.union_document_contribution_files
    set inspection_attempt_id = null, inspection_lease_until = null
    where id = file_row.id;
    return pg_catalog.jsonb_build_object('recorded', false, 'refusal', 'stale');
  end if;

  -- The object the lease bound must still be the one at that path.
  if verdict = 'clean' and not exists (
    select 1 from storage.objects as stored
    where stored.id = file_row.storage_object_id
      and stored.bucket_id = file_row.bucket and stored.name = file_row.object_path
  ) then
    verdict := 'failed';
  end if;

  update public.union_document_contribution_files
  set inspection_status = verdict,
    inspected_at = coalesce(p_scanned_at, clock_timestamp()),
    sha256 = case when verdict = 'failed' then sha256 else coalesce(p_sha256, sha256) end,
    scan_engine = case when verdict = 'failed' then scan_engine else coalesce(p_engine, scan_engine) end,
    signature_version = case when verdict = 'failed' then signature_version else coalesce(p_signature_version, signature_version) end,
    signature_updated_at = case when verdict = 'failed' then signature_updated_at else coalesce(p_signature_updated_at, signature_updated_at) end,
    inspection_attempt_id = null,
    inspection_lease_until = null
  where id = file_row.id;

  if verdict = 'clean' then
    update public.union_document_contributions
    set status = 'received', status_changed_at = clock_timestamp()
    where id = file_row.contribution_id and status = 'pending';
  end if;

  return pg_catalog.jsonb_build_object('recorded', true, 'fileId', file_row.id, 'status', verdict);
end;
$$;

revoke all on function public.finish_union_document_file_inspection(uuid, text, text, text, bigint, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_union_document_file_inspection(uuid, text, text, text, bigint, timestamptz, timestamptz) to service_role;

comment on function public.finish_union_document_file_inspection(uuid, text, text, text, bigint, timestamptz, timestamptz) is
  'Service-only /contribute verdict: only a live lease records; clean needs full scanner provenance and the bound object; the first clean file marks the contribution received.';

-- ------------------------------------------------- 6. the owner read and status path (service role only)

-- Pages of at most 100, newest first, ordered by (created_at desc, id), with
-- every file and its verdict. The two-part keyset cursor is the last row of
-- the previous page.
create function public.list_union_document_contributions(p_status text, p_actor text, p_before timestamptz, p_before_id uuid)
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
      -- A stop confirmed after the submission counts too: the stored flag
      -- records the ledger at submission, the live lookup records it now.
      'contactSuppressed', page.contact_suppressed or exists (
        select 1 from private.public_interest_suppressions s
        where s.suppression_scope_hash = private.public_interest_suppression_scope(page.contact_email)),
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
  'Service-only owner read of /contribute submissions with their files and verdicts: one page of at most 100 ordered by (created_at desc, id), optional status filter, two-part keyset cursor. Writes one access event per call.';

-- received, reviewed and digitized need at least one clean file; declined is
-- always available. 'pending' is never a target: only a clean verdict leaves it.
create function public.set_union_document_contribution_status(p_id uuid, p_status text, p_actor text, p_reviewer_notes text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor text := nullif(pg_catalog.btrim(coalesce(p_actor, '')), '');
  new_notes text := nullif(pg_catalog.btrim(coalesce(p_reviewer_notes, '')), '');
  current_status text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if actor is null or char_length(actor) not between 2 and 80 then
    raise exception 'actor required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('received', 'reviewed', 'digitized', 'declined') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if p_id is null then
    raise exception 'contribution id required' using errcode = '22023';
  end if;
  if new_notes is not null and char_length(new_notes) > 2000 then
    raise exception 'reviewer notes too long' using errcode = '22023';
  end if;

  select contribution.status into current_status
  from public.union_document_contributions as contribution
  where contribution.id = p_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('updated', false, 'refusal', 'not-found');
  end if;
  if current_status = p_status then
    return pg_catalog.jsonb_build_object('updated', false, 'refusal', 'unchanged', 'status', current_status);
  end if;
  if p_status <> 'declined' and not exists (
    select 1 from public.union_document_contribution_files f
    where f.contribution_id = p_id and f.inspection_status = 'clean'
  ) then
    return pg_catalog.jsonb_build_object('updated', false, 'refusal', 'no-clean-file', 'status', current_status);
  end if;

  update public.union_document_contributions
  set status = p_status,
    status_changed_at = clock_timestamp(),
    reviewer_notes = coalesce(new_notes, reviewer_notes)
  where id = p_id;

  insert into private.union_document_contribution_access_events (actor, action, contribution_id, from_status, to_status)
  values (actor, 'status', p_id, current_status, p_status);

  return pg_catalog.jsonb_build_object('updated', true, 'id', p_id, 'from', current_status, 'status', p_status);
end;
$$;

revoke all on function public.set_union_document_contribution_status(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_union_document_contribution_status(uuid, text, text, text) to service_role;

comment on function public.set_union_document_contribution_status(uuid, text, text, text) is
  'Service-only owner status change of one /contribute submission (received, reviewed, digitized need a clean file; declined always) under a row lock, with optional reviewer notes. Writes one access event per change.';

notify pgrst, 'reload schema';

commit;
