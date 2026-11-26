-- REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030
--
-- An organization's own fillable HTML forms (owner direction, October 30,
-- 2026): every grievance and other fillable form an organization prescribes
-- gets a phone-friendly HTML version its members fill on phone or desktop,
-- print, save as a self-contained HTML file, reopen and send, while the
-- organization's own print and PDF layout stays its own.
--
-- 1. private.organization_form_documents holds one organization's blank form
--    documents. A row is always a reusable blank template: document_kind
--    admits only 'blank_template'. Completed forms and their HTML or PDF
--    exports are a member's private data; they stay on the member's device
--    and are never stored or re-ingested here. The writer refuses a document
--    that carries the completed-form marker or saved signatures.
-- 2. Rows bind to exactly one organization (organization_id). Nothing seeds
--    this table: a new organization starts with no forms, and no shared or
--    public catalog reads it. Private schema, no table grants: only the four
--    functions below read or write it.
-- 3. public.list_organization_form_documents() and
--    public.get_organization_form_document(uuid) serve the caller's
--    organization to its active members (not to a PIN-restricted session),
--    resolved exactly as the administrator writers resolve it.
--    Another organization's document id answers exactly like a missing one.
-- 4. public.accept_organization_form_document(...) and
--    public.retire_organization_form_document(uuid) are the organization
--    administrator's review and import (private.has_organization_role:
--    active membership, the admin grant, MFA and the organization's second
--    factor rule). Accepting requires the administrator's attestation that
--    the file is the organization's own form, is theirs to share with
--    members and holds no member's answers. The browser blanks the file
--    first (src/lib/organizationHtmlForms.js); a new acceptance under the
--    same title becomes the next version and retires the previous one.
--
-- The stored HTML runs only inside /org-form-frame.html, an opaque-origin
-- sandbox with its own Content-Security-Policy (vercel.json), never in the
-- application origin.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.organization_form_documents (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  title text not null,
  form_key text,
  document_kind text not null default 'blank_template',
  document_html text not null,
  document_sha256 text not null,
  source_sha256 text,
  cleared_field_count integer not null default 0,
  version integer not null,
  active boolean not null default true,
  accepted_at timestamptz not null default pg_catalog.now(),
  retired_at timestamptz,
  constraint organization_form_documents_title_check
    check (pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 160),
  constraint organization_form_documents_form_key_check
    check (form_key is null or form_key ~ '^[a-z][a-z0-9_]{2,49}$'),
  constraint organization_form_documents_kind_check
    check (document_kind = 'blank_template'),
  constraint organization_form_documents_size_check
    check (pg_catalog.octet_length(document_html) between 1 and 4194304),
  constraint organization_form_documents_sha256_check
    check (document_sha256 ~ '^[0-9a-f]{64}$'),
  constraint organization_form_documents_source_sha256_check
    check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  constraint organization_form_documents_cleared_check
    check (cleared_field_count between 0 and 100000),
  constraint organization_form_documents_version_check
    check (version >= 1),
  constraint organization_form_documents_retired_check
    check (active = (retired_at is null))
);

create unique index organization_form_documents_active_title_idx
  on private.organization_form_documents (organization_id, pg_catalog.lower(title)) where active;
create index organization_form_documents_organization_idx
  on private.organization_form_documents (organization_id, active, accepted_at desc);

alter table private.organization_form_documents enable row level security;
revoke all on table private.organization_form_documents from public, anon, authenticated, service_role;

-- The table references public.organizations, so it joins the account case
-- graph: every write takes the graph lock first. It has no identity column.
create trigger a00_case_graph_lock before insert or update or delete on private.organization_form_documents
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_form_documents
for each row execute function private.lock_case_graph_row_keys('', '');

comment on table private.organization_form_documents is
  'REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: one organization''s own blank fillable HTML forms, accepted by its administrator. Never a completed form, never seeded, never a shared catalog. Read and written only through the organization form document functions.';

-- The organization whose forms the caller may read, never in a
-- PIN-restricted session. It is the same organization the administrator
-- writers below act on (private.current_mobile_staff_organization): the
-- selected chapter's organization for an active member, or, with no chapter
-- selected, the caller's one active organization membership (none when there
-- are two). An administrator therefore always sees what they imported.
create function private.organization_form_reader_organization()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null then null
    when (select private.member_pin_session_restricted()) then null
    else (select private.current_mobile_staff_organization())
  end;
$function$;

create function public.list_organization_form_documents()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.organization_form_reader_organization();
begin
  -- Two-step sign-in, like every member read (REQ-UG-DEFINER-MFA-AUDIT).
  if org is null or not private.mfa_satisfied() then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', d.id,
        'title', d.title,
        'formKey', d.form_key,
        'version', d.version,
        'documentSha256', d.document_sha256,
        'clearedFieldCount', d.cleared_field_count,
        'bytes', pg_catalog.octet_length(d.document_html),
        'acceptedAt', d.accepted_at)
      order by pg_catalog.lower(d.title), d.version desc)
    from private.organization_form_documents d
    where d.organization_id = org and d.active
  ), '[]'::jsonb);
end;
$function$;

create function public.get_organization_form_document(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.organization_form_reader_organization();
  doc record;
begin
  select d.id, d.title, d.form_key, d.version, d.document_sha256, d.document_html
    into doc
    from private.organization_form_documents d
    where org is not null and private.mfa_satisfied()
      and d.id = p_id and d.organization_id = org and d.active;
  if not found then
    raise exception 'organization form not found' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object(
    'id', doc.id,
    'title', doc.title,
    'formKey', doc.form_key,
    'version', doc.version,
    'documentSha256', doc.document_sha256,
    'html', doc.document_html);
end;
$function$;

create function public.accept_organization_form_document(
  p_title text,
  p_form_key text,
  p_document_html text,
  p_source_sha256 text,
  p_cleared_field_count integer,
  p_attested boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
  clean_title text;
  clean_key text;
  digest text;
  next_version integer;
  new_row record;
begin
  -- Case-graph gate first, like every writer of an organization-linked table.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  org := private.current_mobile_staff_organization();
  clean_title := pg_catalog.btrim(coalesce(p_title, ''));
  clean_key := nullif(pg_catalog.btrim(coalesce(p_form_key, '')), '');
  if caller is null or org is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'organization administrator and MFA required' using errcode = '42501';
  end if;
  if p_attested is not true then
    raise exception 'administrator attestation required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) not between 1 and 160 then
    raise exception 'title must be 1 to 160 characters' using errcode = '22023';
  end if;
  if clean_key is not null and clean_key !~ '^[a-z][a-z0-9_]{2,49}$' then
    raise exception 'invalid form key' using errcode = '22023';
  end if;
  if p_document_html is null or pg_catalog.octet_length(p_document_html) not between 1 and 4194304 then
    raise exception 'form document must be 1 byte to 4 MiB' using errcode = '22023';
  end if;
  if p_document_html !~* '<(input|textarea|select)[[:space:]/>]' then
    raise exception 'a fillable form needs at least one field' using errcode = '22023';
  end if;
  -- A completed form is a member's private data: never a template.
  if pg_catalog.strpos(p_document_html, 'data-ug-form-instance') > 0
    or pg_catalog.strpos(p_document_html, 'ug-saved-signatures') > 0 then
    raise exception 'a completed form cannot become a template' using errcode = '22023';
  end if;
  if p_source_sha256 is not null and p_source_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid source digest' using errcode = '22023';
  end if;
  if p_cleared_field_count is null or p_cleared_field_count not between 0 and 100000 then
    raise exception 'invalid cleared field count' using errcode = '22023';
  end if;

  digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_document_html, 'UTF8')), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-form-document-' || org::text || '-' || pg_catalog.lower(clean_title), 509));
  select coalesce(max(d.version), 0) + 1 into next_version
    from private.organization_form_documents d
    where d.organization_id = org and pg_catalog.lower(d.title) = pg_catalog.lower(clean_title);

  update private.organization_form_documents d
    set active = false, retired_at = pg_catalog.now()
    where d.organization_id = org and pg_catalog.lower(d.title) = pg_catalog.lower(clean_title) and d.active;

  insert into private.organization_form_documents
    (organization_id, title, form_key, document_html, document_sha256, source_sha256, cleared_field_count, version)
  values
    (org, clean_title, clean_key, p_document_html, digest, p_source_sha256, p_cleared_field_count, next_version)
  returning id, version, document_sha256 into new_row;

  return pg_catalog.jsonb_build_object('id', new_row.id, 'version', new_row.version,
    'documentSha256', new_row.document_sha256);
end;
$function$;

create function public.retire_organization_form_document(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'organization administrator and MFA required' using errcode = '42501';
  end if;
  update private.organization_form_documents d
    set active = false, retired_at = pg_catalog.now()
    where d.id = p_id and d.organization_id = org and d.active;
  if not found then
    raise exception 'organization form not found' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object('id', p_id, 'active', false);
end;
$function$;

revoke all on function private.organization_form_reader_organization() from public, anon, authenticated, service_role;
revoke all on function public.list_organization_form_documents() from public, anon, authenticated, service_role;
revoke all on function public.get_organization_form_document(uuid) from public, anon, authenticated, service_role;
revoke all on function public.accept_organization_form_document(text, text, text, text, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function public.retire_organization_form_document(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_organization_form_documents() to authenticated;
grant execute on function public.get_organization_form_document(uuid) to authenticated;
grant execute on function public.accept_organization_form_document(text, text, text, text, integer, boolean) to authenticated;
grant execute on function public.retire_organization_form_document(uuid) to authenticated;

comment on function public.list_organization_form_documents() is
  'Active blank HTML forms of the caller''s selected organization, for its active members (empty for anyone else and for PIN-restricted sessions). No document bodies.';
comment on function public.get_organization_form_document(uuid) is
  'One active blank HTML form of the caller''s selected organization, with its body. Another organization''s id answers as not found.';
comment on function public.accept_organization_form_document(text, text, text, text, integer, boolean) is
  'Organization administrator (MFA) imports an already blanked form under attestation. Refuses completed forms; a same-title import becomes the next version and retires the previous one.';
comment on function public.retire_organization_form_document(uuid) is
  'Organization administrator (MFA) stops offering one of the organization''s HTML forms.';

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private' and table_name = 'organization_form_documents'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_organization_form_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the organization form documents';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after the organization form documents';
  end if;
end;
$assert_organization_form_trigger_review$;

notify pgrst, 'reload schema';

commit;
