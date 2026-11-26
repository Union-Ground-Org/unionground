begin;

-- REQ-UG-DOCUMENT-CONVERSION-PROVENANCE-20260904.
--
-- WHAT THIS ADDS, AND WHY IT IS A LEDGER RATHER THAN COLUMNS.
--
-- api/knowledge-ingest.js downloads a private object, extracts text with unpdf
-- or fflate, and writes chunks that become model-grounding content. Until now
-- the only record of that transformation was the content it produced. During a
-- dispute -- "the agreement your assistant quoted is not what we signed" -- an
-- operator could not answer the first question anyone asks: which bytes, run
-- through which converter, at which version, produced this text?
--
-- Donor migration 0469_steward_document_conversion_metadata.sql answered it with
-- columns on the source row: source_sha256, source_bundle_path, conversion_tool,
-- conversion_metadata, conversion_reviewed_at, conversion_reviewed_by. The donor
-- SHAPE is the reference; its TOOL CHOICE (Docling, Presidio, MarkItDown) is
-- explicitly not binding and is not restored here. What is restored is the
-- question the columns answered.
--
-- Mutable columns cannot answer it, though, because a source is converted many
-- times: retries, a converter upgrade, a re-uploaded document, a human
-- correction. One row of columns keeps only the last of those and silently
-- destroys the sequence that makes an incident readable. So this is an
-- append-only ledger with one row per attempt, and the four cases are
-- discriminated by the DATABASE from the previous attempt, not asserted by the
-- caller:
--
--   initial            first conversion of this source
--   identical-input    same digest, same converter and version   (a retry)
--   changed-converter  same digest, different converter or version
--   changed-source     a different digest                        (new document)
--   manual-correction  a human replaced the extracted content
--
-- WHAT IT DELIBERATELY DOES NOT DO.
--
-- It does not gate on the Storage verdict. Every other privileged path in this
-- area re-establishes the verdict before acting, and must: those paths move
-- CONTENT. This one records that an attempt happened and what it was made of --
-- a digest, a converter name, a version, small integers. Refusing to record a
-- failed attempt because the verdict lapsed would delete exactly the evidence a
-- lapsed verdict makes interesting. Nothing here can be used to read a document.
--
-- It does not copy document text. conversion_metadata is constrained to a fixed
-- key allowlist with short scalar values, so a caller cannot smuggle an extract
-- of a member's grievance into a table that staff can list.
--
-- It does not modify public.replace_knowledge_source_chunks. That function is
-- the verdict-locked write path, pinned by scripts/db-contract.json and by five
-- rounds of security review; recording provenance is a separate concern and gets
-- a separate, separately authorized RPC.
--
-- Hosted application of this migration is the named `hosted-schema-cutover`
-- gate. It is sequenced by the controller inside a backup window, never by the
-- branch that wrote it. Nothing here is applied to a hosted database by this
-- change. See docs/conventions/migration-naming.md.

-- ==========================================================================
-- The containment predicate
-- ==========================================================================

-- A CHECK constraint cannot contain a subquery, and the containment rule needs
-- to walk the object's entries. An IMMUTABLE function is the supported way to
-- express that, and it also gives the rule one definition that the constraint,
-- the tests and a reader all share.
create function private.knowledge_conversion_metadata_is_bounded(p_metadata jsonb)
returns boolean language sql immutable set search_path = '' as $function$
  select pg_catalog.jsonb_typeof(p_metadata) = 'object'
    and pg_catalog.char_length(p_metadata::text) <= 1024
    and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_metadata)) <= 16
    and not exists (
      select 1 from pg_catalog.jsonb_each(p_metadata) entry
      where pg_catalog.jsonb_typeof(entry.value) not in ('number', 'boolean')
        or pg_catalog.char_length(entry.key) > 40
        or entry.key !~ '^[a-z][A-Za-z0-9]{1,39}$'
    );
$function$;

revoke all on function private.knowledge_conversion_metadata_is_bounded(jsonb)
  from public, anon, authenticated, service_role;

comment on function private.knowledge_conversion_metadata_is_bounded(jsonb) is
  'Bounds conversion metadata to at most sixteen camelCase keys with numeric or boolean values and 1024 bytes total, so document text cannot be carried into provenance rows that staff can list.';

-- ==========================================================================
-- The ledger
-- ==========================================================================

create table public.organization_knowledge_conversions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  source_id uuid not null
    references public.organization_knowledge_sources(id) on delete cascade,
  file_id uuid not null
    references public.organization_knowledge_files(id) on delete cascade,
  attempt integer not null check (attempt >= 1),
  -- The exact bytes that were converted. Recomputed by the handler from what it
  -- actually downloaded, not copied from the authorization that promised it.
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_byte_size bigint not null check (source_byte_size between 1 and 10485760),
  source_format text not null check (source_format in (
    'pdf', 'docx', 'pptx', 'xlsx', 'rtf', 'txt', 'csv'
  )),
  converter_name text not null check (converter_name ~ '^[a-z][a-z0-9-]{1,62}$'),
  converter_version text not null check (converter_version ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$'),
  -- Bumped whenever this repository's own extraction, normalization or chunking
  -- behaviour changes. Two runs of the same library version can still produce
  -- different text if the code around it moved; without this the ledger would
  -- claim they could not.
  pipeline_version text not null check (pipeline_version ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$'),
  outcome text not null check (outcome in ('succeeded', 'failed')),
  error_code text check (error_code ~ '^knowledge-[a-z0-9-]{1,110}$'),
  change_kind text not null check (change_kind in (
    'initial', 'identical-input', 'changed-converter', 'changed-source', 'manual-correction'
  )),
  conversion_metadata jsonb not null default '{}'::jsonb,
  converted_at timestamptz not null default pg_catalog.now(),
  conversion_reviewed_at timestamptz,
  conversion_reviewed_by uuid references auth.users(id) on delete restrict,
  unique (source_id, attempt),
  constraint organization_knowledge_conversions_error_matches_outcome check (
    (outcome = 'failed') = (error_code is not null)
  ),
  constraint organization_knowledge_conversions_review_is_complete check (
    (conversion_reviewed_at is null) = (conversion_reviewed_by is null)
  ),
  -- A failed conversion produced no content, so there is nothing for a reviewer
  -- to have reviewed. Signing one off would be a review of nothing.
  constraint organization_knowledge_conversions_review_needs_content check (
    conversion_reviewed_at is null or outcome = 'succeeded'
  ),
  -- THE CONTAINMENT RULE. Sixteen camelCase keys, each value a number or a
  -- boolean. Document text structurally cannot fit, and cannot be assembled
  -- across many keys either.
  constraint organization_knowledge_conversions_metadata_is_bounded check (
    private.knowledge_conversion_metadata_is_bounded(conversion_metadata)
  )
);

create index organization_knowledge_conversions_source_attempt_idx
  on public.organization_knowledge_conversions (source_id, attempt desc);
create index organization_knowledge_conversions_org_converted_idx
  on public.organization_knowledge_conversions (organization_id, converted_at desc, id desc);
create index organization_knowledge_conversions_digest_idx
  on public.organization_knowledge_conversions (organization_id, source_sha256);
create index organization_knowledge_conversions_reviewer_idx
  on public.organization_knowledge_conversions (conversion_reviewed_by)
  where conversion_reviewed_by is not null;

comment on table public.organization_knowledge_conversions is
  'Append-only provenance for every document-conversion attempt: the exact source digest, converter identity and version, this repository''s pipeline version, bounded conversion metadata, and the authorized reviewer who signed the result off. One row per attempt; rows are never rewritten.';

-- ==========================================================================
-- Immutability
-- ==========================================================================

-- Append-only is a claim the database has to keep, not a convention writers are
-- asked to respect. Everything except the two review columns is frozen at
-- insert, and the review pair may be set exactly once -- a second reviewer
-- cannot overwrite the first, and nobody can un-review a row that was signed.
create function private.knowledge_conversion_is_append_only()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.source_id is distinct from old.source_id
     or new.file_id is distinct from old.file_id
     or new.attempt is distinct from old.attempt
     or new.source_sha256 is distinct from old.source_sha256
     or new.source_byte_size is distinct from old.source_byte_size
     or new.source_format is distinct from old.source_format
     or new.converter_name is distinct from old.converter_name
     or new.converter_version is distinct from old.converter_version
     or new.pipeline_version is distinct from old.pipeline_version
     or new.outcome is distinct from old.outcome
     or new.error_code is distinct from old.error_code
     or new.change_kind is distinct from old.change_kind
     or new.conversion_metadata is distinct from old.conversion_metadata
     or new.converted_at is distinct from old.converted_at then
    raise exception 'knowledge conversion provenance is immutable' using errcode = '42501';
  end if;
  if old.conversion_reviewed_at is not null
     and (new.conversion_reviewed_at is distinct from old.conversion_reviewed_at
          or new.conversion_reviewed_by is distinct from old.conversion_reviewed_by) then
    raise exception 'knowledge conversion review is recorded once' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function private.knowledge_conversion_is_append_only() from public, anon, authenticated, service_role;

comment on function private.knowledge_conversion_is_append_only() is
  'Freezes every provenance column of public.organization_knowledge_conversions after insert and allows the reviewer pair to be written exactly once.';

create trigger organization_knowledge_conversions_append_only
  before update on public.organization_knowledge_conversions
  for each row execute function private.knowledge_conversion_is_append_only();

-- ==========================================================================
-- Row-level security
-- ==========================================================================

alter table public.organization_knowledge_conversions enable row level security;

create policy organization_knowledge_conversions_staff_read
  on public.organization_knowledge_conversions
  for select to authenticated
  using (private.has_organization_role(
    organization_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ));

comment on policy organization_knowledge_conversions_staff_read
  on public.organization_knowledge_conversions is
  'Conversion provenance is operational evidence about the organization''s own documents, so active staff holding steward, coordinator, advisor, admin or vp in THAT organization may read it and nobody else can. The rows carry digests, converter identity and bounded counters only, never document text, and there is no insert, update or delete policy: every write goes through a security-definer RPC.';

create policy mfa_assurance on public.organization_knowledge_conversions
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

comment on policy mfa_assurance on public.organization_knowledge_conversions is
  'Repository-wide restrictive overlay: a session that has not satisfied its MFA assurance level reads no row of this table regardless of role, matching every other tenant table.';

revoke all on public.organization_knowledge_conversions from public, anon, authenticated, service_role;
grant select on public.organization_knowledge_conversions to authenticated;

-- ==========================================================================
-- Recording an attempt
-- ==========================================================================

create function public.record_knowledge_conversion(
  p_organization_id uuid, p_source_id uuid, p_actor_user_id uuid, p_conversion jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  source public.organization_knowledge_sources%rowtype;
  previous public.organization_knowledge_conversions%rowtype;
  next_attempt integer;
  digest text := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'sourceSha256', '')), '');
  raw_byte_size text := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'sourceByteSize', '')), '');
  byte_size bigint;
  source_format text := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'sourceFormat', '')), '');
  converter_name text := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'converterName', '')), '');
  converter_version text := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'converterVersion', '')), '');
  pipeline_version text := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'pipelineVersion', '')), '');
  outcome text := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'outcome', '')), '');
  error_code text := nullif(pg_catalog.btrim(coalesce(p_conversion ->> 'errorCode', '')), '');
  metadata jsonb := coalesce(p_conversion -> 'metadata', '{}'::jsonb);
  manual_correction boolean := coalesce((p_conversion ->> 'manualCorrection')::boolean, false);
  change_kind text;
  inserted public.organization_knowledge_conversions%rowtype;
begin
  if (select auth.role()) <> 'service_role'
     or p_organization_id is null or p_source_id is null or p_actor_user_id is null
     or pg_catalog.jsonb_typeof(coalesce(p_conversion, 'null'::jsonb)) <> 'object'
     or digest is null or raw_byte_size is null or raw_byte_size !~ '^[0-9]{1,10}$'
     or source_format is null
     or converter_name is null or converter_version is null or pipeline_version is null
     or outcome is null then
    raise exception 'invalid conversion provenance' using errcode = '22023';
  end if;
  byte_size := raw_byte_size::bigint;

  select * into source from public.organization_knowledge_sources row
  where row.id = p_source_id and row.organization_id = p_organization_id
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;

  -- The same staff authorization the ingest completion demands. A conversion
  -- attributed to somebody who could not have started it is worse than none.
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id and membership.status = 'active'
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ) then raise exception 'not authorized' using errcode = '42501'; end if;

  select * into previous from public.organization_knowledge_conversions row
  where row.source_id = source.id
  order by row.attempt desc limit 1;

  next_attempt := coalesce(previous.attempt, 0) + 1;

  -- DERIVED HERE, NEVER ACCEPTED FROM THE CALLER. A handler that could name its
  -- own change_kind could relabel a changed source as a retry, which is the one
  -- lie this ledger exists to make impossible.
  if manual_correction then
    change_kind := 'manual-correction';
  elsif previous.id is null then
    change_kind := 'initial';
  elsif previous.source_sha256 is distinct from digest then
    change_kind := 'changed-source';
  elsif previous.converter_name is distinct from converter_name
     or previous.converter_version is distinct from converter_version
     or previous.pipeline_version is distinct from pipeline_version then
    change_kind := 'changed-converter';
  else
    change_kind := 'identical-input';
  end if;

  insert into public.organization_knowledge_conversions (
    organization_id, source_id, file_id, attempt, source_sha256, source_byte_size,
    source_format, converter_name, converter_version, pipeline_version,
    outcome, error_code, change_kind, conversion_metadata
  ) values (
    p_organization_id, source.id, source.file_id, next_attempt, digest, byte_size,
    source_format, converter_name, converter_version, pipeline_version,
    outcome, error_code, change_kind, metadata
  ) returning * into inserted;

  return pg_catalog.jsonb_build_object(
    'id', inserted.id,
    'sourceId', inserted.source_id,
    'attempt', inserted.attempt,
    'changeKind', inserted.change_kind,
    'outcome', inserted.outcome
  );
end;
$function$;

revoke all on function public.record_knowledge_conversion(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_knowledge_conversion(uuid, uuid, uuid, jsonb) to service_role;

comment on function public.record_knowledge_conversion(uuid, uuid, uuid, jsonb) is
  'Appends one immutable conversion attempt for a knowledge source. Derives the attempt number and the change_kind discriminator from the previous attempt rather than trusting the caller, and refuses an actor without an active staff role in the owning organization.';

-- ==========================================================================
-- Recording the human review
-- ==========================================================================

create function public.review_knowledge_conversion(
  p_organization_id uuid, p_conversion_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  reviewer uuid := (select auth.uid());
  row_out public.organization_knowledge_conversions%rowtype;
begin
  if reviewer is null or p_organization_id is null or p_conversion_id is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- MFA is asked of the reviewer, not assumed from the session's age: signing
  -- off on what a model will quote is exactly the class of action the
  -- repository-wide assurance overlay exists for.
  if not (select private.mfa_satisfied()) then
    raise exception 'reauthentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = reviewer and membership.status = 'active'
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ) then raise exception 'not authorized' using errcode = '42501'; end if;

  update public.organization_knowledge_conversions
  set conversion_reviewed_at = pg_catalog.now(), conversion_reviewed_by = reviewer
  where id = p_conversion_id
    and organization_id = p_organization_id
    and conversion_reviewed_at is null
  returning * into row_out;
  if not found then
    -- Either the row is not this organization's, or it is already signed. Both
    -- answers are the same to the caller; the append-only trigger enforces the
    -- second independently of this predicate.
    raise exception 'conversion is not awaiting review' using errcode = 'P0002';
  end if;

  -- NO organization_audit_events ROW IS WRITTEN, DELIBERATELY.
  --
  -- The obvious move is to emit an audit event here, as every other staff
  -- mutation does. It would require widening two allowlists on a table shared by
  -- every feature -- the event_type enum and the metadata-key set -- and it
  -- would add nothing: the row this statement just wrote IS the audit record.
  -- It names the reviewer, the instant, the attempt and the change kind; the
  -- append-only trigger makes it unforgeable and unrepeatable; and unlike an
  -- audit event it cannot drift away from the thing it describes. Widening a
  -- shared constraint to duplicate evidence that already exists buys risk, not
  -- assurance.
  return pg_catalog.jsonb_build_object(
    'id', row_out.id,
    'sourceId', row_out.source_id,
    'attempt', row_out.attempt,
    'reviewedAt', row_out.conversion_reviewed_at,
    'reviewedBy', row_out.conversion_reviewed_by
  );
end;
$function$;

revoke all on function public.review_knowledge_conversion(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.review_knowledge_conversion(uuid, uuid) to authenticated;

comment on function public.review_knowledge_conversion(uuid, uuid) is
  'Records the authorized reviewer and timestamp for one conversion attempt. Attribution is auth.uid(), never a parameter, and the append-only trigger makes the signature unrepeatable. The ledger row is itself the audit record, so no shared audit-event allowlist is widened and no document content is copied anywhere.';

commit;
