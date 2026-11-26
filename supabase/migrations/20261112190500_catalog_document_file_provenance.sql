-- #8043 b2: metadata only. No file bytes, API grant or serving activation.
-- content_sha256 continues to identify catalog metadata, never file bytes.
begin;

create unique index catalog_releases_file_binding_idx
  on private.catalog_releases (id, artifact_sha256);

create table private.catalog_document_file_releases (
  id uuid primary key default extensions.gen_random_uuid(),
  label text not null unique check (label ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'),
  catalog_release_id uuid not null,
  catalog_artifact_sha256 text not null check (catalog_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  corpus_release text not null check (corpus_release ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  plan_sha256 text not null check (plan_sha256 ~ '^[0-9a-f]{64}$'),
  mapping_count integer not null check (mapping_count >= 0),
  provenance pg_catalog.jsonb not null,
  input_provenance pg_catalog.jsonb not null check (jsonb_typeof(input_provenance) = 'array' and pg_column_size(input_provenance) <= 16384),
  status text not null default 'staged' check (status in ('staged', 'revoked')),
  recorded_at timestamptz not null default pg_catalog.now(),
  constraint catalog_document_file_releases_catalog_fkey
    foreign key (catalog_release_id, catalog_artifact_sha256)
    references private.catalog_releases (id, artifact_sha256),
  constraint catalog_document_file_releases_binding_key unique (id, catalog_release_id),
  constraint catalog_document_file_releases_provenance_complete check (
    jsonb_typeof(provenance) = 'object'
    and coalesce(provenance ->> 'provenance_id', '') ~ '^prov-[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'url', '')) ~ '^https?://'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'publisher', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'retrieved_at', '')) <> ''
    and coalesce(provenance ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'capture' ->> 'method', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'as_of', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance -> 'review' ->> 'status', '')) <> ''
  )
);
create index catalog_document_file_releases_catalog_idx
  on private.catalog_document_file_releases (catalog_release_id, catalog_artifact_sha256);
comment on table private.catalog_document_file_releases is
  'Owner-loaded receipt binding a named corpus manifest and reviewed plan to one exact catalog artifact. Staged is not serving approval; revoked releases cannot be reused. Nothing activates delivery.';
alter table private.catalog_document_file_releases enable row level security;
alter table private.catalog_document_file_releases force row level security;
revoke all on table private.catalog_document_file_releases from public, anon, authenticated, service_role;

create table private.catalog_document_files (
  file_release_id uuid not null,
  catalog_release_id uuid not null,
  document_key text not null,
  catalog_content_sha256 text not null check (catalog_content_sha256 ~ '^[0-9a-f]{64}$'),
  catalog_row_json text not null check (octet_length(catalog_row_json) <= 65536),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  object_key text not null,
  byte_length bigint not null check (byte_length between 1 and 9007199254740991),
  source_url text not null check (source_url ~ '^https://' and char_length(source_url) <= 2000),
  license text check (char_length(license) <= 20000),
  source_occurrence_sha256 text not null check (source_occurrence_sha256 ~ '^[0-9a-f]{64}$'),
  source_occurrence jsonb not null check (jsonb_typeof(source_occurrence) = 'object' and pg_column_size(source_occurrence) <= 65536),
  holds jsonb not null check (jsonb_typeof(holds) = 'array' and pg_column_size(holds) <= 4096),
  serving_eligibility text not null default 'review_required'
    check (serving_eligibility in ('held', 'review_required')),
  provenance pg_catalog.jsonb not null,
  constraint catalog_document_files_pkey primary key (file_release_id, document_key),
  constraint catalog_document_files_release_fkey
    foreign key (file_release_id, catalog_release_id)
    references private.catalog_document_file_releases (id, catalog_release_id),
  constraint catalog_document_files_document_fkey foreign key (document_key)
    references private.catalog_documents (document_key),
  -- Catalog activation prunes old staging rows. Retain this exact, canonical
  -- row snapshot instead of pinning staging and blocking later activations.
  constraint catalog_document_files_snapshot_check check (
    pg_catalog.jsonb_typeof(catalog_row_json::jsonb) = 'object'
    and (catalog_row_json::jsonb->>'document_key') is not distinct from document_key
    and (catalog_row_json::jsonb->>'catalog_key') is not distinct from pg_catalog.split_part(document_key, '~', 1)
    and (catalog_row_json::jsonb->>'url') is not distinct from source_url
    and catalog_row_json::jsonb - array['document_key', 'catalog_key', 'doc_kind', 'title', 'title_derived', 'url', 'url_host', 'as_of', 'country', 'subdivision', 'postal_code', 'language', 'timezone', 'locale_unknowns'] = '{}'::jsonb
    and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(catalog_row_json, 'UTF8')), 'hex') = catalog_content_sha256
  ),
  constraint catalog_document_files_object_key_check
    check (object_key = 'documents/' || pg_catalog.left(file_sha256, 2) || '/' || file_sha256),
  constraint catalog_document_files_occurrence_check check (
    source_occurrence ?& array['sha256', 'key', 'bytes', 'primary_url']
    and source_occurrence - array['sha256', 'key', 'bytes', 'primary_url', 'license', 'access_scope', 'hold_classes', 'external_send_allowed', 'copy_original_allowed', 'rag_allowed', 'excluded'] = '{}'::jsonb
    and (source_occurrence->>'sha256') is not distinct from file_sha256
    and (source_occurrence->>'key') is not distinct from object_key
    and (source_occurrence->'bytes') is not distinct from pg_catalog.to_jsonb(byte_length)
    and license is not distinct from source_occurrence->>'license'
  ),
  constraint catalog_document_files_provenance_complete check (
    jsonb_typeof(provenance) = 'object'
    and coalesce(provenance ->> 'provenance_id', '') ~ '^prov-[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'url', '')) ~ '^https?://'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'publisher', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'retrieved_at', '')) <> ''
    and coalesce(provenance ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'capture' ->> 'method', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'as_of', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance -> 'review' ->> 'status', '')) <> ''
  ),
  constraint catalog_document_files_hold_check check (
    (serving_eligibility = 'held') = (pg_catalog.jsonb_array_length(holds) > 0)
    and (coalesce(license, '') !~* 'non[[:space:]-]*commercial'
      or (serving_eligibility = 'held' and holds ? 'noncommercial-license'))
  )
);
create index catalog_document_files_release_binding_idx
  on private.catalog_document_files (file_release_id, catalog_release_id);
create index catalog_document_files_document_idx on private.catalog_document_files (document_key);
create index catalog_document_files_byte_hash_idx on private.catalog_document_files (file_sha256);
comment on table private.catalog_document_files is
  'Private immutable-input provenance for exact catalog/manifest matches. The separate SHA is over file bytes. Holds and pending review never authorize serving; Cornell noncommercial objects remain held. No file body or member data.';
alter table private.catalog_document_files enable row level security;
alter table private.catalog_document_files force row level security;
revoke all on table private.catalog_document_files from public, anon, authenticated, service_role;

commit;
