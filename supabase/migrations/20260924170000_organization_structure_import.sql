-- REQ-UG-ORG-CHART-LOVABLE-DATA-LAYOUT-IMPORT-20260922
--
-- The owner's organization keeps its union and state-agency structure in an
-- external chart application. docs/orgchart/lovable-mapping-20260922.md maps
-- that layout onto this repository and records three gaps: the chart tables
-- carry no contact, note, metric or cross-reference row, no person node can be
-- tied to a membership, and public.save_organization_chart_node writes exactly
-- one node per call with no way to load a whole structure in one transaction.
--
-- This migration closes the schema half of that record. It adds the columns and
-- the six content tables the mapping proves missing, an import ledger, and one
-- admin-only batch RPC that validates a whole payload, can dry-run it, writes
-- nothing when any row is invalid, and audits a committed run once per entity
-- kind.
--
-- BLANK SYSTEM. Nothing here ships a union, an agency, a chapter, a person, a
-- contact or a pay figure. The dataset the mapping describes is the importing
-- organization's own content and enters only through the RPC below, as that
-- organization's rows, under its own attestation. No seed, no fixture, no
-- SAMPLE row, and no default is added by this file.
--
-- PRIVACY. Contacts carry their own visibility and default to staff, never to
-- members; a personal address may not be published to members without recorded
-- consent. Public-payroll rows are organization-attributed timeline events and
-- are staff-visible only: decision 49 admits them as imported rows with
-- visibility restrictions, and whether members ever see pay disclosures is an
-- open owner decision, so widening that is a later, separately reviewed
-- migration and not a client-side flag.
--
-- The member-facing read path is NOT in this file. It belongs to
-- REQ-UG-MEMBER-ORG-STRUCTURE-VIEW-20260922, which reads the columns this
-- migration adds and applies the filters named above.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Chart node columns the mapping proves missing
-- ---------------------------------------------------------------------------

alter table public.organization_chart_nodes
  add column user_id uuid,
  add column import_key text,
  add column badge text,
  add column role_class text,
  add column vacant boolean not null default false,
  add column collapsed_by_default boolean not null default false,
  add column reports_to_label text,
  add column chip_label text,
  add column source_label text,
  add column source_as_of date;

-- The only person-node identity link. It is written from an explicit member id
-- the importer verified against an active membership, never guessed from a
-- display name, so an unresolved person simply has no identity.
--
-- Account deletion cascades auth.users -> organization_memberships, so this
-- edge sits inside the reviewed account-lifecycle closure (invariant 3 of
-- 20260907150000_account_lifecycle_manifest.sql). RESTRICT would abort that
-- cascade and strand a member's self-service deletion. The node is the
-- organization's chart position, not the member's data: only the identity
-- link detaches, and the column list keeps the NOT NULL organization_id.
alter table public.organization_chart_nodes
  add constraint organization_chart_nodes_user_membership_fkey
    foreign key (organization_id, user_id)
    references public.organization_memberships(organization_id, user_id)
    on delete set null (user_id),
  add constraint organization_chart_nodes_user_is_person check (
    user_id is null or node_kind = 'person'
  ),
  add constraint organization_chart_nodes_role_class check (
    role_class is null or role_class in ('regional', 'support', 'director', 'functional', 'vacant')
  ),
  add constraint organization_chart_nodes_import_key_format check (
    import_key is null or import_key ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'
  ),
  add constraint organization_chart_nodes_badge_bounded check (
    badge is null or (pg_catalog.char_length(pg_catalog.btrim(badge)) between 1 and 80 and badge !~ '[[:cntrl:]]')
  ),
  add constraint organization_chart_nodes_reports_to_bounded check (
    reports_to_label is null or (
      pg_catalog.char_length(pg_catalog.btrim(reports_to_label)) between 1 and 160
      and reports_to_label !~ '[[:cntrl:]]')
  ),
  add constraint organization_chart_nodes_chip_bounded check (
    chip_label is null or (
      pg_catalog.char_length(pg_catalog.btrim(chip_label)) between 1 and 120
      and chip_label !~ '[[:cntrl:]]')
  ),
  add constraint organization_chart_nodes_source_label_bounded check (
    source_label is null or (
      pg_catalog.char_length(pg_catalog.btrim(source_label)) between 1 and 180
      and source_label !~ '[[:cntrl:]]')
  );

-- One node per identity per chart, so a relationship overlay resolves a
-- participant to exactly one node instead of choosing between duplicates.
create unique index organization_chart_nodes_identity_idx
  on public.organization_chart_nodes (organization_id, chart_kind, user_id)
  where user_id is not null;

-- Re-import identity. A second run of the same payload updates the same rows.
create unique index organization_chart_nodes_import_key_idx
  on public.organization_chart_nodes (organization_id, chart_kind, import_key)
  where import_key is not null;

comment on column public.organization_chart_nodes.user_id is
  'Optional link from a person node to an active organization membership. Written only from an explicitly supplied, verified member id; NULL for everyone the import could not verify.';
comment on column public.organization_chart_nodes.import_key is
  'Import-local stable key. Scoped to (organization_id, chart_kind) so a re-import updates rather than duplicates.';

-- ---------------------------------------------------------------------------
-- 2. Timeline events: node binding, the second pay figure, and visibility
-- ---------------------------------------------------------------------------

alter table public.organization_timeline_events
  add column node_id uuid,
  add column import_key text,
  add column secondary_amount_cents bigint,
  add column partial_period boolean not null default false,
  add column visibility text not null default 'staff';

alter table public.organization_timeline_events
  add constraint organization_timeline_events_node_fkey
    foreign key (organization_id, node_id)
    references public.organization_chart_nodes(organization_id, id) on delete restrict,
  add constraint organization_timeline_events_visibility check (visibility in ('members', 'staff')),
  add constraint organization_timeline_events_secondary_amount check (
    secondary_amount_cents is null or secondary_amount_cents between 0 and 1000000000000000
  ),
  add constraint organization_timeline_events_import_key_format check (
    import_key is null or import_key ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'
  ),
  -- Decision 49 admits public-payroll figures as one organization's attributed
  -- rows with visibility restrictions. Staff-only is that restriction until the
  -- owner decides whether members may see pay disclosures at all.
  add constraint organization_timeline_events_payroll_staff_only check (
    event_kind <> 'payroll_snapshot' or visibility = 'staff'
  );

create unique index organization_timeline_events_import_key_idx
  on public.organization_timeline_events (organization_id, import_key)
  where import_key is not null;

comment on column public.organization_timeline_events.visibility is
  'members or staff. Payroll snapshots are staff-only by constraint; widening that needs an owner decision and its own migration.';

-- ---------------------------------------------------------------------------
-- 3. Content tables the chart model lacks
-- ---------------------------------------------------------------------------

-- A named person's address or number, with its own visibility so a single
-- contact can be withdrawn without disturbing the chart.
create table public.organization_chart_node_contacts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  node_id uuid not null,
  contact_kind text not null check (contact_kind in ('email', 'phone')),
  contact_value text not null,
  dial_href text,
  confirmation_state text not null default 'unconfirmed'
    check (confirmation_state in ('confirmed', 'unconfirmed', 'not_listed')),
  contact_visibility text not null default 'staff'
    check (contact_visibility in ('members', 'staff', 'private')),
  is_personal_address boolean not null default false,
  consent_source text,
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint orgchart_node_contacts_node_fkey foreign key (organization_id, node_id)
    references public.organization_chart_nodes(organization_id, id) on delete cascade,
  constraint orgchart_node_contacts_value_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(contact_value)) between 3 and 254
    and contact_value !~ '[[:cntrl:]]'
  ),
  constraint orgchart_node_contacts_dial_href_bounded check (
    dial_href is null or dial_href ~ '^[+0-9][0-9 ().-]{2,39}$'
  ),
  constraint orgchart_node_contacts_consent_bounded check (
    consent_source is null or pg_catalog.char_length(pg_catalog.btrim(consent_source)) between 1 and 240
  )
);

create index orgchart_node_contacts_node_idx
  on public.organization_chart_node_contacts (organization_id, node_id, sort_order, id);
create index orgchart_node_contacts_visibility_idx
  on public.organization_chart_node_contacts (organization_id, contact_visibility);

-- Free-form lines the source keeps beside a record: office addresses, prose
-- contact lines, and the notes a person carries.
create table public.organization_chart_node_notes (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  node_id uuid not null,
  note_kind text not null default 'note' check (note_kind in ('note', 'address', 'prose_line')),
  body text not null,
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint orgchart_node_notes_node_fkey foreign key (organization_id, node_id)
    references public.organization_chart_nodes(organization_id, id) on delete cascade,
  constraint orgchart_node_notes_body_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 500
  )
);

create index orgchart_node_notes_node_idx
  on public.organization_chart_node_notes (organization_id, node_id, sort_order, id);

-- Member counts, density percentages and unit head counts stay numbers instead
-- of being embedded in a subtitle string.
create table public.organization_chart_node_metrics (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  node_id uuid not null,
  metric_key text not null,
  metric_label text,
  metric_value numeric(18, 4) not null,
  metric_unit text check (metric_unit is null or metric_unit in ('count', 'percent', 'currency_cents')),
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint orgchart_node_metrics_node_fkey foreign key (organization_id, node_id)
    references public.organization_chart_nodes(organization_id, id) on delete cascade,
  constraint orgchart_node_metrics_key_format check (metric_key ~ '^[a-z0-9][a-z0-9_]{0,39}$'),
  constraint orgchart_node_metrics_label_bounded check (
    metric_label is null or (
      pg_catalog.char_length(pg_catalog.btrim(metric_label)) between 1 and 80
      and metric_label !~ '[[:cntrl:]]')
  ),
  constraint orgchart_node_metrics_value_bounded check (metric_value between -1000000000 and 1000000000),
  unique (organization_id, node_id, metric_key)
);

create index orgchart_node_metrics_node_idx
  on public.organization_chart_node_metrics (organization_id, node_id, sort_order, id);

-- Context-only tags between the two structures. They are deliberately NOT
-- public.organization_relationships rows: that table's ends are memberships and
-- its kinds assert a personal working link, while these tags exist to say the
-- opposite — separate reporting systems, context only, no authority and no
-- representation.
create table public.organization_chart_cross_references (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  node_id uuid not null,
  target_node_id uuid,
  reference_kind text not null check (reference_kind in ('bargaining_unit', 'context_note')),
  label text not null,
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint orgchart_xref_node_fkey foreign key (organization_id, node_id)
    references public.organization_chart_nodes(organization_id, id) on delete cascade,
  constraint orgchart_xref_target_fkey foreign key (organization_id, target_node_id)
    references public.organization_chart_nodes(organization_id, id) on delete restrict,
  constraint orgchart_xref_label_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(label)) between 1 and 120
    and label !~ '[[:cntrl:]]'
  ),
  constraint orgchart_xref_not_self check (target_node_id is distinct from node_id)
);

create index orgchart_xref_node_idx
  on public.organization_chart_cross_references (organization_id, node_id, sort_order, id);

-- The source's content tabs: one section per tab, and a recursive block tree.
create table public.organization_reference_sections (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chart_kind text not null check (chart_kind in ('agency', 'union')),
  section_key text not null,
  tab_label text not null,
  panel_title text,
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  source_label text,
  source_as_of date,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, id),
  unique (organization_id, chart_kind, section_key),
  constraint orgchart_sections_key_format check (section_key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  constraint orgchart_sections_tab_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(tab_label)) between 1 and 80
    and tab_label !~ '[[:cntrl:]]'
  ),
  constraint orgchart_sections_title_bounded check (
    panel_title is null or (
      pg_catalog.char_length(pg_catalog.btrim(panel_title)) between 1 and 180
      and panel_title !~ '[[:cntrl:]]')
  ),
  constraint orgchart_sections_source_bounded check (
    source_label is null or (
      pg_catalog.char_length(pg_catalog.btrim(source_label)) between 1 and 180
      and source_label !~ '[[:cntrl:]]')
  )
);

create index orgchart_sections_org_kind_idx
  on public.organization_reference_sections (organization_id, chart_kind, sort_order, id);

create table public.organization_reference_blocks (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  section_id uuid not null,
  parent_block_id uuid,
  block_type text not null check (block_type in (
    'title', 'subtitle', 'heading', 'subheading', 'paragraph', 'source', 'list',
    'stats', 'bars', 'table', 'card', 'cards', 'collapsible', 'columns', 'note',
    'contactHeader', 'contacts'
  )),
  depth smallint not null default 0 check (depth between 0 and 6),
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, id),
  constraint orgchart_blocks_section_fkey foreign key (organization_id, section_id)
    references public.organization_reference_sections(organization_id, id) on delete cascade,
  constraint orgchart_blocks_parent_fkey foreign key (organization_id, parent_block_id)
    references public.organization_reference_blocks(organization_id, id) on delete cascade,
  constraint orgchart_blocks_not_own_parent check (parent_block_id is distinct from id),
  constraint orgchart_blocks_payload_object check (pg_catalog.jsonb_typeof(payload) = 'object'),
  constraint orgchart_blocks_payload_bounded check (pg_catalog.octet_length(payload::text) <= 20000)
);

create index orgchart_blocks_section_idx
  on public.organization_reference_blocks (organization_id, section_id, sort_order, id);

-- One row per committed import: who supplied the content, under what authority,
-- whether the named people consented, and how many rows of each kind landed.
create table public.organization_structure_imports (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  schema_version text not null,
  selected_hat text not null check (selected_hat in ('advisor', 'admin', 'vp')),
  supplied_by text not null,
  supplied_on date not null,
  authority text not null,
  personal_contact_consent text not null
    check (personal_contact_consent in ('obtained', 'not_obtained', 'mixed')),
  consent_note text,
  sources jsonb not null default '[]'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint orgchart_imports_schema_version check (schema_version = 'org-structure/1'),
  constraint orgchart_imports_supplied_by_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(supplied_by)) between 1 and 160
    and supplied_by !~ '[[:cntrl:]]'
  ),
  constraint orgchart_imports_authority_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(authority)) between 1 and 240
  ),
  constraint orgchart_imports_consent_note_bounded check (
    consent_note is null or pg_catalog.char_length(pg_catalog.btrim(consent_note)) between 1 and 500
  ),
  constraint orgchart_imports_counts_object check (pg_catalog.jsonb_typeof(counts) = 'object'),
  constraint orgchart_imports_sources_array check (pg_catalog.jsonb_typeof(sources) = 'array'),
  constraint orgchart_imports_sources_bounded check (pg_catalog.octet_length(sources::text) <= 4194304),
  constraint orgchart_imports_counts_bounded check (pg_catalog.octet_length(counts::text) <= 1024)
);

create index orgchart_imports_org_created_idx
  on public.organization_structure_imports (organization_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- 4. RLS floor, grants and case-graph coordination
-- ---------------------------------------------------------------------------
-- Every table here is RPC-only: all client grants are revoked, so the
-- restrictive MFA floor is the second lock on rows that are never selected
-- directly by a browser session.

alter table public.organization_chart_node_contacts enable row level security;
alter table public.organization_chart_node_notes enable row level security;
alter table public.organization_chart_node_metrics enable row level security;
alter table public.organization_chart_cross_references enable row level security;
alter table public.organization_reference_sections enable row level security;
alter table public.organization_reference_blocks enable row level security;
alter table public.organization_structure_imports enable row level security;

create policy mfa_assurance on public.organization_chart_node_contacts
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.organization_chart_node_contacts is
  'Restrictive MFA floor for every authenticated session; direct grants are revoked, so reads and writes reach these contact rows only through a security-definer RPC that has already checked the hat.';

create policy mfa_assurance on public.organization_chart_node_notes
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.organization_chart_node_notes is
  'Restrictive MFA floor for every authenticated session; direct grants are revoked, so these note lines reach a caller only through a security-definer RPC that has already checked the hat.';

create policy mfa_assurance on public.organization_chart_node_metrics
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.organization_chart_node_metrics is
  'Restrictive MFA floor for every authenticated session; direct grants are revoked, so these chart metrics reach a caller only through a security-definer RPC that has already checked the hat.';

create policy mfa_assurance on public.organization_chart_cross_references
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.organization_chart_cross_references is
  'Restrictive MFA floor for every authenticated session; direct grants are revoked, so these context-only cross-reference tags reach a caller only through a security-definer RPC that has already checked the hat.';

create policy mfa_assurance on public.organization_reference_sections
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.organization_reference_sections is
  'Restrictive MFA floor for every authenticated session; direct grants are revoked, so imported reference tabs reach a caller only through a security-definer RPC that has already checked the hat.';

create policy mfa_assurance on public.organization_reference_blocks
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.organization_reference_blocks is
  'Restrictive MFA floor for every authenticated session; direct grants are revoked, so imported reference content reaches a caller only through a security-definer RPC that has already checked the hat.';

create policy mfa_assurance on public.organization_structure_imports
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.organization_structure_imports is
  'Restrictive MFA floor for every authenticated session; direct grants are revoked, so the import ledger with its attestation is readable only through a security-definer RPC that has already checked the hat.';

revoke all on public.organization_chart_node_contacts from public, anon, authenticated, service_role;
revoke all on public.organization_chart_node_notes from public, anon, authenticated, service_role;
revoke all on public.organization_chart_node_metrics from public, anon, authenticated, service_role;
revoke all on public.organization_chart_cross_references from public, anon, authenticated, service_role;
revoke all on public.organization_reference_sections from public, anon, authenticated, service_role;
revoke all on public.organization_reference_blocks from public, anon, authenticated, service_role;
revoke all on public.organization_structure_imports from public, anon, authenticated, service_role;

-- Account case-graph coordination: these tables are organization children, so
-- they join the lock graph the account lifecycle depends on, exactly like the
-- chart nodes they hang from.
create trigger a00_case_graph_lock before insert or update or delete on public.organization_chart_node_contacts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_chart_node_metrics
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_chart_node_notes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_chart_cross_references
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_reference_blocks
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_reference_sections
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_structure_imports
for each statement execute function private.lock_case_graph_statement();

create trigger z99_case_graph_keys before insert or update or delete on public.organization_chart_node_contacts
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_chart_node_metrics
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_chart_node_notes
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_chart_cross_references
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_reference_blocks
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_reference_sections
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_structure_imports
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');

-- ---------------------------------------------------------------------------
-- 5. Audit vocabulary for the import
-- ---------------------------------------------------------------------------
-- The existing audit table admits one event type per single-row save. A batch
-- import emits one counted event per entity kind instead, so the vocabulary
-- widens by exactly those kinds and by the two metadata keys the counts need.
-- Metadata still carries counts and identifiers only: never a name, an address,
-- a number or an amount.

alter table public.organization_intelligence_audit_events
  drop constraint organization_intelligence_audit_events_event_type_check,
  drop constraint organization_intelligence_audit_events_entity_kind_check,
  drop constraint organization_intelligence_audit_metadata_keys;

alter table public.organization_intelligence_audit_events
  add constraint organization_intelligence_audit_events_event_type_check check (event_type in (
    'chart_node_saved', 'relationship_saved', 'topic_progress_saved',
    'timeline_event_saved', 'digital_action_saved',
    'digital_action_participation_joined', 'digital_action_participation_withdrawn',
    'digital_action_export_requested', 'structure_imported'
  )),
  add constraint organization_intelligence_audit_events_entity_kind_check check (entity_kind in (
    'chart_node', 'relationship', 'topic_progress', 'timeline_event',
    'digital_action', 'digital_action_participation', 'digital_action_export',
    'chapter', 'chart_node_contact', 'chart_node_note', 'chart_node_metric',
    'chart_cross_reference', 'reference_section', 'reference_block'
  )),
  add constraint organization_intelligence_audit_metadata_keys check (
    metadata - array[
      'chartKind', 'nodeKind', 'relationshipKind', 'topicKey', 'progressState',
      'eventKind', 'actionKind', 'status', 'participationKind', 'rowCount',
      'expiresAt', 'chapterId', 'importId', 'entityKind'
    ] = '{}'::jsonb
  );

-- ---------------------------------------------------------------------------
-- 6. Payload shape helpers
-- ---------------------------------------------------------------------------
-- Pure predicates. They read nothing and write nothing, so the validation pass
-- can run over a whole payload before the import takes any row.

create function private.org_structure_note(
  p_list jsonb,
  p_path text,
  p_code text,
  p_message text
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  -- Bounded: a payload with thousands of faults returns the first 200 and the
  -- caller fixes those first. The report never echoes a payload value.
  select case
    when pg_catalog.jsonb_array_length(p_list) >= 200 then p_list
    else p_list || pg_catalog.jsonb_build_object('path', p_path, 'code', p_code, 'message', p_message)
  end;
$function$;

create function private.org_structure_text_ok(p_value jsonb, p_min integer, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select p_value is not null
    and pg_catalog.jsonb_typeof(p_value) = 'string'
    and pg_catalog.char_length(pg_catalog.btrim(p_value #>> '{}')) between p_min and p_max
    and (p_value #>> '{}') !~ '[[:cntrl:]]';
$function$;

create function private.org_structure_extra_keys(p_object jsonb, p_allowed text[])
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select coalesce(pg_catalog.array_agg(key order by key), array[]::text[])
  from pg_catalog.jsonb_object_keys(p_object) as key
  where not (key = any (p_allowed));
$function$;

create function private.org_structure_date_ok(p_value jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $function$
declare
  parsed date;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'string' then return false; end if;
  if (p_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  parsed := (p_value #>> '{}')::date;
  return parsed between '1900-01-01'::date and '2200-01-01'::date;
exception when others then
  return false;
end;
$function$;

create function private.org_structure_int_ok(p_value jsonb, p_min bigint, p_max bigint)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select p_value is not null
    and pg_catalog.jsonb_typeof(p_value) = 'number'
    and (p_value #>> '{}') ~ '^-?\d+$'
    and (p_value #>> '{}')::numeric between p_min and p_max;
$function$;

create function private.org_structure_uuid_ok(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select p_value is not null
    and pg_catalog.jsonb_typeof(p_value) = 'string'
    and (p_value #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$function$;

revoke all on function private.org_structure_note(jsonb, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.org_structure_text_ok(jsonb, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.org_structure_extra_keys(jsonb, text[])
  from public, anon, authenticated, service_role;
revoke all on function private.org_structure_date_ok(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.org_structure_int_ok(jsonb, bigint, bigint)
  from public, anon, authenticated, service_role;
revoke all on function private.org_structure_uuid_ok(jsonb)
  from public, anon, authenticated, service_role;

-- Recursive block-tree validation, kept separate so the node pass stays flat.
create function private.org_structure_validate_blocks(
  p_blocks jsonb,
  p_path text,
  p_depth integer,
  p_errors jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  errors jsonb;
  total integer;
  block jsonb;
  block_path text;
  nested jsonb;
  extra text[];
begin
  errors := p_errors;
  total := 0;
  if pg_catalog.jsonb_typeof(p_blocks) <> 'array' then
    return pg_catalog.jsonb_build_object(
      'errors', private.org_structure_note(errors, p_path, 'blocks_not_array', 'blocks must be an array'),
      'count', 0);
  end if;
  if pg_catalog.jsonb_array_length(p_blocks) > 500 then
    return pg_catalog.jsonb_build_object(
      'errors', private.org_structure_note(errors, p_path, 'too_many_blocks', 'a section carries at most 500 blocks'),
      'count', 0);
  end if;
  if p_depth > 6 then
    return pg_catalog.jsonb_build_object(
      'errors', private.org_structure_note(errors, p_path, 'blocks_too_deep', 'block nesting is bounded at six levels'),
      'count', 0);
  end if;
  for idx in 0 .. pg_catalog.jsonb_array_length(p_blocks) - 1 loop
    block := p_blocks -> idx;
    block_path := p_path || '[' || idx || ']';
    if pg_catalog.jsonb_typeof(block) <> 'object' then
      errors := private.org_structure_note(errors, block_path, 'block_not_object', 'a block must be an object');
      continue;
    end if;
    extra := private.org_structure_extra_keys(block, array['blockType', 'sortOrder', 'payload', 'blocks']);
    if pg_catalog.array_length(extra, 1) is not null then
      errors := private.org_structure_note(errors, block_path, 'unknown_property', 'unknown block property');
    end if;
    if (block ->> 'blockType') is null or (block ->> 'blockType') not in (
      'title', 'subtitle', 'heading', 'subheading', 'paragraph', 'source', 'list',
      'stats', 'bars', 'table', 'card', 'cards', 'collapsible', 'columns', 'note',
      'contactHeader', 'contacts'
    ) then
      errors := private.org_structure_note(errors, block_path, 'block_type', 'unknown block type');
    end if;
    if block ? 'sortOrder' and not private.org_structure_int_ok(block -> 'sortOrder', -100000, 100000) then
      errors := private.org_structure_note(errors, block_path, 'sort_order', 'sortOrder is out of range');
    end if;
    if block ? 'payload' then
      if pg_catalog.jsonb_typeof(block -> 'payload') <> 'object' then
        errors := private.org_structure_note(errors, block_path, 'block_payload', 'block payload must be an object');
      elsif pg_catalog.octet_length((block -> 'payload')::text) > 20000 then
        errors := private.org_structure_note(errors, block_path, 'block_payload_size', 'block payload is larger than 20 kB');
      end if;
    end if;
    total := total + 1;
    if block ? 'blocks' then
      nested := private.org_structure_validate_blocks(block -> 'blocks', block_path || '.blocks', p_depth + 1, errors);
      errors := nested -> 'errors';
      total := total + (nested ->> 'count')::integer;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('errors', errors, 'count', total);
end;
$function$;

revoke all on function private.org_structure_validate_blocks(jsonb, text, integer, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Whole-payload validation
-- ---------------------------------------------------------------------------
-- Every row is checked before the import writes anything, and the report lists
-- every fault it found rather than the first. The organization is the caller's
-- own, resolved by the RPC; nothing here trusts a tenant named in the payload.

create function private.org_structure_validate(p_organization_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  errors jsonb;
  warnings jsonb;
  counts jsonb;
  keys jsonb;
  identities jsonb;
  chapter_keys jsonb;
  section_keys jsonb;
  event_keys jsonb;
  consent text;
  attestation jsonb;
  entry jsonb;
  node jsonb;
  child jsonb;
  blocks jsonb;
  extra text[];
  kind text;
  base text;
  node_path text;
  child_path text;
  key_text text;
  parent_text text;
  address text;
  hops integer;
  chapter_rows integer;
  node_rows integer;
  contact_rows integer;
  note_rows integer;
  metric_rows integer;
  xref_rows integer;
  section_rows integer;
  block_rows integer;
  event_rows integer;
  bound integer;
  unresolved integer;
begin
  errors := '[]'::jsonb;
  warnings := '[]'::jsonb;
  keys := pg_catalog.jsonb_build_object('union', '{}'::jsonb, 'agency', '{}'::jsonb);
  identities := pg_catalog.jsonb_build_object('union', '{}'::jsonb, 'agency', '{}'::jsonb);
  chapter_keys := '{}'::jsonb;
  section_keys := '{}'::jsonb;
  event_keys := '{}'::jsonb;
  chapter_rows := 0; node_rows := 0; contact_rows := 0; note_rows := 0;
  metric_rows := 0; xref_rows := 0; section_rows := 0; block_rows := 0; event_rows := 0;
  bound := 0; unresolved := 0;
  consent := 'not_obtained';

  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    errors := private.org_structure_note(errors, '', 'payload_not_object', 'the payload must be a JSON object');
    return pg_catalog.jsonb_build_object('errors', errors, 'warnings', warnings,
      'counts', '{}'::jsonb, 'identity', pg_catalog.jsonb_build_object('bound', 0, 'unresolved', 0));
  end if;
  if pg_catalog.octet_length(p_payload::text) > 4194304 then
    errors := private.org_structure_note(errors, '', 'payload_too_large', 'the payload is larger than 4 MB');
    return pg_catalog.jsonb_build_object('errors', errors, 'warnings', warnings,
      'counts', '{}'::jsonb, 'identity', pg_catalog.jsonb_build_object('bound', 0, 'unresolved', 0));
  end if;

  extra := private.org_structure_extra_keys(p_payload, array[
    'schemaVersion', 'selectedHat', 'dryRun', 'attestation', 'sources',
    'chapters', 'charts', 'referenceSections', 'timelineEvents', 'topicSeeds']);
  if pg_catalog.array_length(extra, 1) is not null then
    errors := private.org_structure_note(errors, '', 'unknown_property', 'unknown top-level property');
  end if;
  if (p_payload ->> 'schemaVersion') is distinct from 'org-structure/1' then
    errors := private.org_structure_note(errors, 'schemaVersion', 'schema_version', 'schemaVersion must be org-structure/1');
  end if;
  if p_payload ? 'dryRun' and pg_catalog.jsonb_typeof(p_payload -> 'dryRun') <> 'boolean' then
    errors := private.org_structure_note(errors, 'dryRun', 'not_boolean', 'dryRun must be a boolean');
  end if;

  -- Attestation: who supplied this content, when, under what authority, and
  -- whether the named people agreed to be published to members.
  attestation := p_payload -> 'attestation';
  if attestation is null or pg_catalog.jsonb_typeof(attestation) <> 'object' then
    errors := private.org_structure_note(errors, 'attestation', 'attestation_required',
      'an import must name who supplied the content and under what authority');
  else
    extra := private.org_structure_extra_keys(attestation, array[
      'suppliedBy', 'suppliedOn', 'authority', 'personalContactConsent', 'consentNote']);
    if pg_catalog.array_length(extra, 1) is not null then
      errors := private.org_structure_note(errors, 'attestation', 'unknown_property', 'unknown attestation property');
    end if;
    if not private.org_structure_text_ok(attestation -> 'suppliedBy', 1, 160) then
      errors := private.org_structure_note(errors, 'attestation.suppliedBy', 'invalid_text', 'suppliedBy must be 1-160 characters');
    end if;
    if not private.org_structure_date_ok(attestation -> 'suppliedOn') then
      errors := private.org_structure_note(errors, 'attestation.suppliedOn', 'invalid_date', 'suppliedOn must be a date');
    end if;
    if not private.org_structure_text_ok(attestation -> 'authority', 1, 240) then
      errors := private.org_structure_note(errors, 'attestation.authority', 'invalid_text', 'authority must be 1-240 characters');
    end if;
    if (attestation ->> 'personalContactConsent') is null
       or (attestation ->> 'personalContactConsent') not in ('obtained', 'not_obtained', 'mixed') then
      errors := private.org_structure_note(errors, 'attestation.personalContactConsent', 'invalid_enum',
        'personalContactConsent must be obtained, not_obtained or mixed');
    else
      consent := attestation ->> 'personalContactConsent';
    end if;
    if attestation ? 'consentNote' and not private.org_structure_text_ok(attestation -> 'consentNote', 1, 500) then
      errors := private.org_structure_note(errors, 'attestation.consentNote', 'invalid_text', 'consentNote must be 1-500 characters');
    end if;
  end if;

  -- Sources
  if p_payload ? 'sources' then
    if pg_catalog.jsonb_typeof(p_payload -> 'sources') <> 'array' then
      errors := private.org_structure_note(errors, 'sources', 'not_array', 'sources must be an array');
    else
      for idx in 0 .. pg_catalog.jsonb_array_length(p_payload -> 'sources') - 1 loop
        entry := (p_payload -> 'sources') -> idx;
        base := 'sources[' || idx || ']';
        if pg_catalog.jsonb_typeof(entry) <> 'object' then
          errors := private.org_structure_note(errors, base, 'not_object', 'a source must be an object');
          continue;
        end if;
        extra := private.org_structure_extra_keys(entry, array['sourceLabel', 'sourceAsOf']);
        if pg_catalog.array_length(extra, 1) is not null then
          errors := private.org_structure_note(errors, base, 'unknown_property', 'unknown source property');
        end if;
        if not private.org_structure_text_ok(entry -> 'sourceLabel', 1, 180) then
          errors := private.org_structure_note(errors, base || '.sourceLabel', 'invalid_text', 'sourceLabel must be 1-180 characters');
        end if;
        if not private.org_structure_date_ok(entry -> 'sourceAsOf') then
          errors := private.org_structure_note(errors, base || '.sourceAsOf', 'invalid_date', 'sourceAsOf must be a date');
        end if;
      end loop;
    end if;
  end if;

  -- Chapters. public.chapters.id is a repository-wide identifier while slug is
  -- unique per organization, so a key another organization already owns is a
  -- refusal, never a silent bind to someone else's chapter.
  if p_payload ? 'chapters' then
    if pg_catalog.jsonb_typeof(p_payload -> 'chapters') <> 'array' then
      errors := private.org_structure_note(errors, 'chapters', 'not_array', 'chapters must be an array');
    else
      for idx in 0 .. pg_catalog.jsonb_array_length(p_payload -> 'chapters') - 1 loop
        entry := (p_payload -> 'chapters') -> idx;
        base := 'chapters[' || idx || ']';
        if pg_catalog.jsonb_typeof(entry) <> 'object' then
          errors := private.org_structure_note(errors, base, 'not_object', 'a chapter must be an object');
          continue;
        end if;
        extra := private.org_structure_extra_keys(entry, array[
          'chapterKey', 'name', 'region', 'chapterClass', 'orderIndex']);
        if pg_catalog.array_length(extra, 1) is not null then
          errors := private.org_structure_note(errors, base, 'unknown_property', 'unknown chapter property');
        end if;
        key_text := entry ->> 'chapterKey';
        if key_text is null or key_text !~ '^[a-z0-9][a-z0-9-]{0,39}$' then
          errors := private.org_structure_note(errors, base || '.chapterKey', 'invalid_key', 'chapterKey must be a lowercase slug');
          continue;
        end if;
        if chapter_keys ? key_text then
          errors := private.org_structure_note(errors, base || '.chapterKey', 'duplicate_key', 'chapterKey is used twice');
        end if;
        chapter_keys := pg_catalog.jsonb_set(chapter_keys, array[key_text], 'true'::jsonb, true);
        if not private.org_structure_text_ok(entry -> 'name', 1, 120) then
          errors := private.org_structure_note(errors, base || '.name', 'invalid_text', 'name must be 1-120 characters');
        end if;
        if entry ? 'region' and not private.org_structure_text_ok(entry -> 'region', 1, 120) then
          errors := private.org_structure_note(errors, base || '.region', 'invalid_text', 'region must be 1-120 characters');
        end if;
        if entry ? 'chapterClass' and (entry ->> 'chapterClass') not in ('public', 'other') then
          errors := private.org_structure_note(errors, base || '.chapterClass', 'invalid_enum', 'chapterClass must be public or other');
        end if;
        if not private.org_structure_int_ok(entry -> 'orderIndex', 1, 10000) then
          errors := private.org_structure_note(errors, base || '.orderIndex', 'invalid_integer', 'orderIndex must be 1-10000');
        end if;
        if exists (
          select 1 from public.chapters c
          where c.id = key_text and c.organization_id is distinct from p_organization_id
        ) then
          errors := private.org_structure_note(errors, base || '.chapterKey', 'chapter_key_taken',
            'this chapter key already identifies a chapter outside this organization');
        end if;
        chapter_rows := chapter_rows + 1;
      end loop;
    end if;
  end if;

  -- Charts. Pass one validates each node on its own and records its key and
  -- its parent's key; pass two resolves the tree and the cross-chart tags.
  if p_payload ? 'charts' then
    if pg_catalog.jsonb_typeof(p_payload -> 'charts') <> 'object' then
      errors := private.org_structure_note(errors, 'charts', 'not_object', 'charts must be an object');
    else
      extra := private.org_structure_extra_keys(p_payload -> 'charts', array['union', 'agency']);
      if pg_catalog.array_length(extra, 1) is not null then
        errors := private.org_structure_note(errors, 'charts', 'unknown_property', 'a chart kind must be union or agency');
      end if;
      foreach kind in array array['union', 'agency'] loop
        if not (coalesce(p_payload -> 'charts', '{}'::jsonb) ? kind) then continue; end if;
        if pg_catalog.jsonb_typeof((p_payload -> 'charts') -> kind) <> 'object'
           or pg_catalog.jsonb_typeof(((p_payload -> 'charts') -> kind) -> 'nodes') <> 'array' then
          errors := private.org_structure_note(errors, 'charts.' || kind, 'not_object', 'a chart must carry a nodes array');
          continue;
        end if;
        extra := private.org_structure_extra_keys((p_payload -> 'charts') -> kind, array['nodes']);
        if pg_catalog.array_length(extra, 1) is not null then
          errors := private.org_structure_note(errors, 'charts.' || kind, 'unknown_property',
            'a chart carries nodes only; masthead text is the root node label, subtitle and source');
        end if;
        if pg_catalog.jsonb_array_length(((p_payload -> 'charts') -> kind) -> 'nodes') > 5000 then
          errors := private.org_structure_note(errors, 'charts.' || kind || '.nodes', 'too_many_nodes', 'a chart carries at most 5000 nodes');
          continue;
        end if;
        for idx in 0 .. pg_catalog.jsonb_array_length(((p_payload -> 'charts') -> kind) -> 'nodes') - 1 loop
          node := (((p_payload -> 'charts') -> kind) -> 'nodes') -> idx;
          node_path := 'charts.' || kind || '.nodes[' || idx || ']';
          if pg_catalog.jsonb_typeof(node) <> 'object' then
            errors := private.org_structure_note(errors, node_path, 'not_object', 'a node must be an object');
            continue;
          end if;
          extra := private.org_structure_extra_keys(node, array[
            'nodeKey', 'parentKey', 'nodeKind', 'chapterKey', 'label', 'subtitle', 'badge',
            'roleClass', 'vacant', 'collapsedByDefault', 'reportsToLabel', 'chipLabel',
            'sortOrder', 'memberUserId', 'sourceLabel', 'sourceAsOf',
            'notes', 'metrics', 'contacts', 'crossReferences']);
          if pg_catalog.array_length(extra, 1) is not null then
            errors := private.org_structure_note(errors, node_path, 'unknown_property', 'unknown node property');
          end if;
          key_text := node ->> 'nodeKey';
          if key_text is null or key_text !~ '^[a-z0-9][a-z0-9_.-]{0,79}$' then
            errors := private.org_structure_note(errors, node_path || '.nodeKey', 'invalid_key', 'nodeKey must be a lowercase key');
            continue;
          end if;
          if (keys -> kind) ? key_text then
            errors := private.org_structure_note(errors, node_path || '.nodeKey', 'duplicate_key', 'nodeKey is used twice in this chart');
          end if;
          keys := pg_catalog.jsonb_set(keys, array[kind, key_text],
            pg_catalog.to_jsonb(coalesce(node ->> 'parentKey', '')), true);
          node_rows := node_rows + 1;

          if (node ->> 'nodeKind') is null or (node ->> 'nodeKind') not in
             ('organization', 'division', 'chapter', 'team', 'role', 'person') then
            errors := private.org_structure_note(errors, node_path || '.nodeKind', 'invalid_enum', 'unknown node kind');
          end if;
          if not private.org_structure_text_ok(node -> 'label', 1, 160) then
            errors := private.org_structure_note(errors, node_path || '.label', 'invalid_text', 'label must be 1-160 characters');
          end if;
          if node ? 'subtitle' and pg_catalog.jsonb_typeof(node -> 'subtitle') <> 'null'
             and not private.org_structure_text_ok(node -> 'subtitle', 1, 240) then
            errors := private.org_structure_note(errors, node_path || '.subtitle', 'invalid_text', 'subtitle must be 1-240 characters');
          end if;
          if node ? 'badge' and pg_catalog.jsonb_typeof(node -> 'badge') <> 'null'
             and not private.org_structure_text_ok(node -> 'badge', 1, 80) then
            errors := private.org_structure_note(errors, node_path || '.badge', 'invalid_text', 'badge must be 1-80 characters');
          end if;
          if node ? 'reportsToLabel' and pg_catalog.jsonb_typeof(node -> 'reportsToLabel') <> 'null'
             and not private.org_structure_text_ok(node -> 'reportsToLabel', 1, 160) then
            errors := private.org_structure_note(errors, node_path || '.reportsToLabel', 'invalid_text', 'reportsToLabel must be 1-160 characters');
          end if;
          if node ? 'chipLabel' and pg_catalog.jsonb_typeof(node -> 'chipLabel') <> 'null'
             and not private.org_structure_text_ok(node -> 'chipLabel', 1, 120) then
            errors := private.org_structure_note(errors, node_path || '.chipLabel', 'invalid_text', 'chipLabel must be 1-120 characters');
          end if;
          if node ? 'sourceLabel' and pg_catalog.jsonb_typeof(node -> 'sourceLabel') <> 'null'
             and not private.org_structure_text_ok(node -> 'sourceLabel', 1, 180) then
            errors := private.org_structure_note(errors, node_path || '.sourceLabel', 'invalid_text', 'sourceLabel must be 1-180 characters');
          end if;
          if node ? 'sourceAsOf' and pg_catalog.jsonb_typeof(node -> 'sourceAsOf') <> 'null'
             and not private.org_structure_date_ok(node -> 'sourceAsOf') then
            errors := private.org_structure_note(errors, node_path || '.sourceAsOf', 'invalid_date', 'sourceAsOf must be a date');
          end if;
          if node ? 'roleClass' and pg_catalog.jsonb_typeof(node -> 'roleClass') <> 'null'
             and (node ->> 'roleClass') not in ('regional', 'support', 'director', 'functional', 'vacant') then
            errors := private.org_structure_note(errors, node_path || '.roleClass', 'invalid_enum', 'unknown role class');
          end if;
          if node ? 'vacant' and pg_catalog.jsonb_typeof(node -> 'vacant') <> 'boolean' then
            errors := private.org_structure_note(errors, node_path || '.vacant', 'not_boolean', 'vacant must be a boolean');
          end if;
          if node ? 'collapsedByDefault' and pg_catalog.jsonb_typeof(node -> 'collapsedByDefault') <> 'boolean' then
            errors := private.org_structure_note(errors, node_path || '.collapsedByDefault', 'not_boolean', 'collapsedByDefault must be a boolean');
          end if;
          if node ? 'sortOrder' and not private.org_structure_int_ok(node -> 'sortOrder', -100000, 100000) then
            errors := private.org_structure_note(errors, node_path || '.sortOrder', 'sort_order', 'sortOrder is out of range');
          end if;

          -- Chapter reference: either a chapter this payload creates, or one the
          -- organization already owns.
          if node ? 'chapterKey' and pg_catalog.jsonb_typeof(node -> 'chapterKey') <> 'null' then
            key_text := node ->> 'chapterKey';
            if not (chapter_keys ? key_text) and not exists (
              select 1 from public.chapters c
              where c.organization_id = p_organization_id and (c.slug = key_text or c.id = key_text)
            ) then
              errors := private.org_structure_note(errors, node_path || '.chapterKey', 'unknown_chapter',
                'chapterKey names no chapter of this organization and none this payload creates');
            end if;
          end if;

          -- Identity. Explicit, verified, and person-only; anything else stays
          -- unresolved rather than guessed.
          if node ? 'memberUserId' and pg_catalog.jsonb_typeof(node -> 'memberUserId') <> 'null' then
            if not private.org_structure_uuid_ok(node -> 'memberUserId') then
              errors := private.org_structure_note(errors, node_path || '.memberUserId', 'invalid_uuid', 'memberUserId must be a uuid');
            elsif (node ->> 'nodeKind') is distinct from 'person' then
              errors := private.org_structure_note(errors, node_path || '.memberUserId', 'identity_not_person',
                'only a person node can carry a member identity');
            elsif not exists (
              select 1 from public.organization_memberships m
              where m.organization_id = p_organization_id
                and m.user_id = (node ->> 'memberUserId')::uuid
                and m.status = 'active'
            ) then
              errors := private.org_structure_note(errors, node_path || '.memberUserId', 'unknown_member',
                'memberUserId is not an active member of this organization');
            elsif (identities -> kind) ? (node ->> 'memberUserId') then
              errors := private.org_structure_note(errors, node_path || '.memberUserId', 'duplicate_identity',
                'this member is already bound to another node of this chart');
            else
              identities := pg_catalog.jsonb_set(identities, array[kind, node ->> 'memberUserId'], 'true'::jsonb, true);
              bound := bound + 1;
            end if;
          elsif (node ->> 'nodeKind') = 'person' then
            unresolved := unresolved + 1;
          end if;

          -- Contacts
          if node ? 'contacts' then
            if pg_catalog.jsonb_typeof(node -> 'contacts') <> 'array' then
              errors := private.org_structure_note(errors, node_path || '.contacts', 'not_array', 'contacts must be an array');
            elsif pg_catalog.jsonb_array_length(node -> 'contacts') > 20 then
              errors := private.org_structure_note(errors, node_path || '.contacts', 'too_many', 'a node carries at most 20 contacts');
            else
              for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'contacts') - 1 loop
                child := (node -> 'contacts') -> jdx;
                child_path := node_path || '.contacts[' || jdx || ']';
                if pg_catalog.jsonb_typeof(child) <> 'object' then
                  errors := private.org_structure_note(errors, child_path, 'not_object', 'a contact must be an object');
                  continue;
                end if;
                if child ? 'sortOrder' and not private.org_structure_int_ok(child -> 'sortOrder', -100000, 100000) then
                  errors := private.org_structure_note(errors, child_path || '.sortOrder', 'sort_order', 'sortOrder is out of range');
                end if;
                extra := private.org_structure_extra_keys(child, array[
                  'contactKind', 'contactValue', 'dialHref', 'confirmationState',
                  'contactVisibility', 'isPersonalAddress', 'consentSource', 'sortOrder']);
                if pg_catalog.array_length(extra, 1) is not null then
                  errors := private.org_structure_note(errors, child_path, 'unknown_property', 'unknown contact property');
                end if;
                if (child ->> 'contactKind') not in ('email', 'phone') or (child ->> 'contactKind') is null then
                  errors := private.org_structure_note(errors, child_path || '.contactKind', 'invalid_enum', 'contactKind must be email or phone');
                end if;
                if not private.org_structure_text_ok(child -> 'contactValue', 3, 254) then
                  errors := private.org_structure_note(errors, child_path || '.contactValue', 'invalid_text', 'contactValue must be 3-254 characters');
                elsif (child ->> 'contactKind') = 'email'
                      and (child ->> 'contactValue') !~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then
                  errors := private.org_structure_note(errors, child_path || '.contactValue', 'invalid_email', 'contactValue is not an email address');
                end if;
                if child ? 'dialHref' and (child ->> 'dialHref') !~ '^[+0-9][0-9 ().-]{2,39}$' then
                  errors := private.org_structure_note(errors, child_path || '.dialHref', 'invalid_dial', 'dialHref must be a dialable number');
                end if;
                if child ? 'confirmationState'
                   and (child ->> 'confirmationState') not in ('confirmed', 'unconfirmed', 'not_listed') then
                  errors := private.org_structure_note(errors, child_path || '.confirmationState', 'invalid_enum', 'unknown confirmation state');
                end if;
                if child ? 'contactVisibility' and (
                   (child ->> 'contactVisibility') is null
                   or (child ->> 'contactVisibility') not in ('members', 'staff', 'private')) then
                  errors := private.org_structure_note(errors, child_path || '.contactVisibility', 'invalid_enum',
                    'contactVisibility must be members, staff or private');
                end if;
                if child ? 'isPersonalAddress' and pg_catalog.jsonb_typeof(child -> 'isPersonalAddress') <> 'boolean' then
                  errors := private.org_structure_note(errors, child_path || '.isPersonalAddress', 'not_boolean', 'isPersonalAddress must be a boolean');
                end if;
                if child ? 'consentSource' and not private.org_structure_text_ok(child -> 'consentSource', 1, 240) then
                  errors := private.org_structure_note(errors, child_path || '.consentSource', 'invalid_text', 'consentSource must be 1-240 characters');
                end if;
                -- A personal address may not be published to members unless the
                -- attestation records that the named people agreed to it.
                if (child ->> 'contactVisibility') = 'members'
                   and (child -> 'isPersonalAddress') = 'true'::jsonb
                   and consent <> 'obtained' then
                  errors := private.org_structure_note(errors, child_path, 'personal_contact_without_consent',
                    'a personal address cannot be published to members without recorded consent');
                end if;
                -- Publishing an employer mailbox as a union contact channel is a
                -- decision about the member's employer relationship, so the
                -- report says so instead of letting it pass silently.
                address := pg_catalog.lower(coalesce(child ->> 'contactValue', ''));
                if (child ->> 'contactKind') = 'email' and (child ->> 'contactVisibility') = 'members'
                   and address ~ '@([a-z0-9-]+\.)*(gov|mil)$' then
                  warnings := private.org_structure_note(warnings, child_path, 'employer_domain_contact',
                    'this member-visible address is an employer or government mailbox');
                end if;
                contact_rows := contact_rows + 1;
              end loop;
            end if;
          end if;

          -- Notes
          if node ? 'notes' then
            if pg_catalog.jsonb_typeof(node -> 'notes') <> 'array' then
              errors := private.org_structure_note(errors, node_path || '.notes', 'not_array', 'notes must be an array');
            elsif pg_catalog.jsonb_array_length(node -> 'notes') > 40 then
              errors := private.org_structure_note(errors, node_path || '.notes', 'too_many', 'a node carries at most 40 notes');
            else
              for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'notes') - 1 loop
                child := (node -> 'notes') -> jdx;
                child_path := node_path || '.notes[' || jdx || ']';
                if pg_catalog.jsonb_typeof(child) <> 'object' then
                  errors := private.org_structure_note(errors, child_path, 'not_object', 'a note must be an object');
                  continue;
                end if;
                if child ? 'sortOrder' and not private.org_structure_int_ok(child -> 'sortOrder', -100000, 100000) then
                  errors := private.org_structure_note(errors, child_path || '.sortOrder', 'sort_order', 'sortOrder is out of range');
                end if;
                extra := private.org_structure_extra_keys(child, array['noteKind', 'body', 'sortOrder']);
                if pg_catalog.array_length(extra, 1) is not null then
                  errors := private.org_structure_note(errors, child_path, 'unknown_property', 'unknown note property');
                end if;
                if child ? 'noteKind' and (child ->> 'noteKind') not in ('note', 'address', 'prose_line') then
                  errors := private.org_structure_note(errors, child_path || '.noteKind', 'invalid_enum', 'unknown note kind');
                end if;
                if not private.org_structure_text_ok(child -> 'body', 1, 500) then
                  errors := private.org_structure_note(errors, child_path || '.body', 'invalid_text', 'body must be 1-500 characters');
                end if;
                note_rows := note_rows + 1;
              end loop;
            end if;
          end if;

          -- Metrics
          if node ? 'metrics' then
            if pg_catalog.jsonb_typeof(node -> 'metrics') <> 'array' then
              errors := private.org_structure_note(errors, node_path || '.metrics', 'not_array', 'metrics must be an array');
            elsif pg_catalog.jsonb_array_length(node -> 'metrics') > 20 then
              errors := private.org_structure_note(errors, node_path || '.metrics', 'too_many', 'a node carries at most 20 metrics');
            else
              for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'metrics') - 1 loop
                child := (node -> 'metrics') -> jdx;
                child_path := node_path || '.metrics[' || jdx || ']';
                if pg_catalog.jsonb_typeof(child) <> 'object' then
                  errors := private.org_structure_note(errors, child_path, 'not_object', 'a metric must be an object');
                  continue;
                end if;
                if child ? 'sortOrder' and not private.org_structure_int_ok(child -> 'sortOrder', -100000, 100000) then
                  errors := private.org_structure_note(errors, child_path || '.sortOrder', 'sort_order', 'sortOrder is out of range');
                end if;
                extra := private.org_structure_extra_keys(child, array[
                  'metricKey', 'metricLabel', 'metricValue', 'metricUnit', 'sortOrder']);
                if pg_catalog.array_length(extra, 1) is not null then
                  errors := private.org_structure_note(errors, child_path, 'unknown_property', 'unknown metric property');
                end if;
                if (child ->> 'metricKey') is null or (child ->> 'metricKey') !~ '^[a-z0-9][a-z0-9_]{0,39}$' then
                  errors := private.org_structure_note(errors, child_path || '.metricKey', 'invalid_key', 'metricKey must be a lowercase key');
                end if;
                if pg_catalog.jsonb_typeof(child -> 'metricValue') <> 'number' then
                  errors := private.org_structure_note(errors, child_path || '.metricValue', 'not_number', 'metricValue must be a number');
                end if;
                if child ? 'metricUnit' and pg_catalog.jsonb_typeof(child -> 'metricUnit') <> 'null'
                   and (child ->> 'metricUnit') not in ('count', 'percent', 'currency_cents') then
                  errors := private.org_structure_note(errors, child_path || '.metricUnit', 'invalid_enum', 'unknown metric unit');
                end if;
                metric_rows := metric_rows + 1;
              end loop;
            end if;
          end if;
        end loop;
      end loop;

      -- Pass two: parents, depth and the context-only cross-reference tags.
      foreach kind in array array['union', 'agency'] loop
        if not ((p_payload -> 'charts') ? kind)
           or pg_catalog.jsonb_typeof(((p_payload -> 'charts') -> kind) -> 'nodes') <> 'array' then
          continue;
        end if;
        for idx in 0 .. pg_catalog.jsonb_array_length(((p_payload -> 'charts') -> kind) -> 'nodes') - 1 loop
          node := (((p_payload -> 'charts') -> kind) -> 'nodes') -> idx;
          node_path := 'charts.' || kind || '.nodes[' || idx || ']';
          if pg_catalog.jsonb_typeof(node) <> 'object' then continue; end if;
          key_text := node ->> 'nodeKey';
          parent_text := node ->> 'parentKey';
          if parent_text is not null then
            if parent_text = key_text then
              errors := private.org_structure_note(errors, node_path || '.parentKey', 'self_parent', 'a node cannot be its own parent');
            elsif not ((keys -> kind) ? parent_text) then
              errors := private.org_structure_note(errors, node_path || '.parentKey', 'unknown_parent',
                'parentKey names no node of this chart');
            else
              -- Walk up. A chain that does not end within 32 hops is either a
              -- cycle or deeper than any chart this import supports.
              hops := 0;
              while parent_text is not null and parent_text <> '' and hops < 32 loop
                if parent_text = key_text then
                  errors := private.org_structure_note(errors, node_path || '.parentKey', 'cycle', 'this parent chain is a cycle');
                  exit;
                end if;
                parent_text := (keys -> kind) ->> parent_text;
                hops := hops + 1;
              end loop;
              if hops >= 32 then
                errors := private.org_structure_note(errors, node_path || '.parentKey', 'chain_too_deep',
                  'a parent chain is bounded at 32 levels');
              end if;
            end if;
          end if;
          if node ? 'crossReferences' then
            if pg_catalog.jsonb_typeof(node -> 'crossReferences') <> 'array' then
              errors := private.org_structure_note(errors, node_path || '.crossReferences', 'not_array', 'crossReferences must be an array');
            elsif pg_catalog.jsonb_array_length(node -> 'crossReferences') > 10 then
              errors := private.org_structure_note(errors, node_path || '.crossReferences', 'too_many', 'a node carries at most 10 cross-references');
            else
              for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'crossReferences') - 1 loop
                child := (node -> 'crossReferences') -> jdx;
                child_path := node_path || '.crossReferences[' || jdx || ']';
                if pg_catalog.jsonb_typeof(child) <> 'object' then
                  errors := private.org_structure_note(errors, child_path, 'not_object', 'a cross-reference must be an object');
                  continue;
                end if;
                if child ? 'sortOrder' and not private.org_structure_int_ok(child -> 'sortOrder', -100000, 100000) then
                  errors := private.org_structure_note(errors, child_path || '.sortOrder', 'sort_order', 'sortOrder is out of range');
                end if;
                extra := private.org_structure_extra_keys(child, array[
                  'referenceKind', 'label', 'targetNodeKey', 'sortOrder']);
                if pg_catalog.array_length(extra, 1) is not null then
                  errors := private.org_structure_note(errors, child_path, 'unknown_property', 'unknown cross-reference property');
                end if;
                if (child ->> 'referenceKind') is null
                   or (child ->> 'referenceKind') not in ('bargaining_unit', 'context_note') then
                  errors := private.org_structure_note(errors, child_path || '.referenceKind', 'invalid_enum', 'unknown cross-reference kind');
                end if;
                if not private.org_structure_text_ok(child -> 'label', 1, 120) then
                  errors := private.org_structure_note(errors, child_path || '.label', 'invalid_text', 'label must be 1-120 characters');
                end if;
                -- A tag points at the other structure or at nothing. It is
                -- context only and confers no authority or representation.
                if child ? 'targetNodeKey' and pg_catalog.jsonb_typeof(child -> 'targetNodeKey') <> 'null' then
                  if not ((keys -> (case when kind = 'union' then 'agency' else 'union' end)) ? (child ->> 'targetNodeKey')) then
                    errors := private.org_structure_note(errors, child_path || '.targetNodeKey', 'unknown_cross_reference_target',
                      'targetNodeKey must name a node of the other chart in this payload');
                  end if;
                end if;
                xref_rows := xref_rows + 1;
              end loop;
            end if;
          end if;
        end loop;
      end loop;
    end if;
  end if;

  -- Reference sections and their block trees
  if p_payload ? 'referenceSections' then
    if pg_catalog.jsonb_typeof(p_payload -> 'referenceSections') <> 'array' then
      errors := private.org_structure_note(errors, 'referenceSections', 'not_array', 'referenceSections must be an array');
    elsif pg_catalog.jsonb_array_length(p_payload -> 'referenceSections') > 40 then
      errors := private.org_structure_note(errors, 'referenceSections', 'too_many', 'an import carries at most 40 reference sections');
    else
      for idx in 0 .. pg_catalog.jsonb_array_length(p_payload -> 'referenceSections') - 1 loop
        entry := (p_payload -> 'referenceSections') -> idx;
        base := 'referenceSections[' || idx || ']';
        if pg_catalog.jsonb_typeof(entry) <> 'object' then
          errors := private.org_structure_note(errors, base, 'not_object', 'a reference section must be an object');
          continue;
        end if;
        extra := private.org_structure_extra_keys(entry, array[
          'chartKind', 'sectionKey', 'tabLabel', 'panelTitle', 'sortOrder',
          'sourceLabel', 'sourceAsOf', 'blocks']);
        if pg_catalog.array_length(extra, 1) is not null then
          errors := private.org_structure_note(errors, base, 'unknown_property', 'unknown reference section property');
        end if;
        if (entry ->> 'chartKind') is null or (entry ->> 'chartKind') not in ('union', 'agency') then
          errors := private.org_structure_note(errors, base || '.chartKind', 'invalid_enum', 'chartKind must be union or agency');
        end if;
        key_text := entry ->> 'sectionKey';
        if key_text is null or key_text !~ '^[a-z0-9][a-z0-9_-]{0,39}$' then
          errors := private.org_structure_note(errors, base || '.sectionKey', 'invalid_key', 'sectionKey must be a lowercase key');
        else
          key_text := coalesce(entry ->> 'chartKind', '?') || '/' || key_text;
          if section_keys ? key_text then
            errors := private.org_structure_note(errors, base || '.sectionKey', 'duplicate_key', 'this chart already carries that sectionKey');
          end if;
          section_keys := pg_catalog.jsonb_set(section_keys, array[key_text], 'true'::jsonb, true);
        end if;
        if not private.org_structure_text_ok(entry -> 'tabLabel', 1, 80) then
          errors := private.org_structure_note(errors, base || '.tabLabel', 'invalid_text', 'tabLabel must be 1-80 characters');
        end if;
        if entry ? 'panelTitle' and not private.org_structure_text_ok(entry -> 'panelTitle', 1, 180) then
          errors := private.org_structure_note(errors, base || '.panelTitle', 'invalid_text', 'panelTitle must be 1-180 characters');
        end if;
        if entry ? 'sourceLabel' and not private.org_structure_text_ok(entry -> 'sourceLabel', 1, 180) then
          errors := private.org_structure_note(errors, base || '.sourceLabel', 'invalid_text', 'sourceLabel must be 1-180 characters');
        end if;
        if entry ? 'sourceAsOf' and not private.org_structure_date_ok(entry -> 'sourceAsOf') then
          errors := private.org_structure_note(errors, base || '.sourceAsOf', 'invalid_date', 'sourceAsOf must be a date');
        end if;
        if entry ? 'sortOrder' and not private.org_structure_int_ok(entry -> 'sortOrder', -100000, 100000) then
          errors := private.org_structure_note(errors, base || '.sortOrder', 'sort_order', 'sortOrder is out of range');
        end if;
        blocks := private.org_structure_validate_blocks(coalesce(entry -> 'blocks', '[]'::jsonb), base || '.blocks', 0, errors);
        errors := blocks -> 'errors';
        block_rows := block_rows + (blocks ->> 'count')::integer;
        section_rows := section_rows + 1;
      end loop;
    end if;
  end if;

  -- Timeline events, including the organization-attributed payroll rows
  if p_payload ? 'timelineEvents' then
    if pg_catalog.jsonb_typeof(p_payload -> 'timelineEvents') <> 'array' then
      errors := private.org_structure_note(errors, 'timelineEvents', 'not_array', 'timelineEvents must be an array');
    elsif pg_catalog.jsonb_array_length(p_payload -> 'timelineEvents') > 5000 then
      errors := private.org_structure_note(errors, 'timelineEvents', 'too_many', 'an import carries at most 5000 timeline events');
    else
      for idx in 0 .. pg_catalog.jsonb_array_length(p_payload -> 'timelineEvents') - 1 loop
        entry := (p_payload -> 'timelineEvents') -> idx;
        base := 'timelineEvents[' || idx || ']';
        if pg_catalog.jsonb_typeof(entry) <> 'object' then
          errors := private.org_structure_note(errors, base, 'not_object', 'a timeline event must be an object');
          continue;
        end if;
        extra := private.org_structure_extra_keys(entry, array[
          'eventKind', 'importKey', 'chartKind', 'nodeKey', 'chapterKey', 'title', 'detail',
          'effectiveOn', 'endedOn', 'amountCents', 'amountBasis', 'secondaryAmountCents',
          'partialPeriod', 'sourceLabel', 'sourceAsOf', 'visibility']);
        if pg_catalog.array_length(extra, 1) is not null then
          errors := private.org_structure_note(errors, base, 'unknown_property', 'unknown timeline event property');
        end if;
        if (entry ->> 'eventKind') is null or (entry ->> 'eventKind') not in ('leadership_term', 'payroll_snapshot') then
          errors := private.org_structure_note(errors, base || '.eventKind', 'invalid_enum', 'eventKind must be leadership_term or payroll_snapshot');
        end if;
        key_text := entry ->> 'importKey';
        if key_text is null or key_text !~ '^[a-z0-9][a-z0-9_.-]{0,79}$' then
          errors := private.org_structure_note(errors, base || '.importKey', 'invalid_key',
            'importKey is required so a re-import updates rather than duplicates');
        elsif event_keys ? key_text then
          errors := private.org_structure_note(errors, base || '.importKey', 'duplicate_key', 'importKey is used twice');
        else
          event_keys := pg_catalog.jsonb_set(event_keys, array[key_text], 'true'::jsonb, true);
        end if;
        if not private.org_structure_text_ok(entry -> 'title', 1, 180) then
          errors := private.org_structure_note(errors, base || '.title', 'invalid_text', 'title must be 1-180 characters');
        end if;
        if entry ? 'detail' and not private.org_structure_text_ok(entry -> 'detail', 1, 2000) then
          errors := private.org_structure_note(errors, base || '.detail', 'invalid_text', 'detail must be 1-2000 characters');
        end if;
        if not private.org_structure_date_ok(entry -> 'effectiveOn') then
          errors := private.org_structure_note(errors, base || '.effectiveOn', 'invalid_date', 'effectiveOn must be a date');
        end if;
        if entry ? 'endedOn' then
          if not private.org_structure_date_ok(entry -> 'endedOn') then
            errors := private.org_structure_note(errors, base || '.endedOn', 'invalid_date', 'endedOn must be a date');
          elsif private.org_structure_date_ok(entry -> 'effectiveOn')
                and (entry ->> 'endedOn')::date < (entry ->> 'effectiveOn')::date then
            errors := private.org_structure_note(errors, base || '.endedOn', 'date_order', 'endedOn is before effectiveOn');
          end if;
        end if;
        if entry ? 'nodeKey' and pg_catalog.jsonb_typeof(entry -> 'nodeKey') <> 'null' then
          if (entry ->> 'chartKind') is null or (entry ->> 'chartKind') not in ('union', 'agency') then
            errors := private.org_structure_note(errors, base || '.chartKind', 'chart_kind_required',
              'an event bound to a node names the chart that node belongs to');
          elsif not ((keys -> (entry ->> 'chartKind')) ? (entry ->> 'nodeKey')) then
            errors := private.org_structure_note(errors, base || '.nodeKey', 'unknown_node', 'nodeKey names no node of that chart');
          end if;
        end if;
        if entry ? 'chapterKey' and pg_catalog.jsonb_typeof(entry -> 'chapterKey') <> 'null' then
          key_text := entry ->> 'chapterKey';
          if not (chapter_keys ? key_text) and not exists (
            select 1 from public.chapters c
            where c.organization_id = p_organization_id and (c.slug = key_text or c.id = key_text)
          ) then
            errors := private.org_structure_note(errors, base || '.chapterKey', 'unknown_chapter',
              'chapterKey names no chapter of this organization');
          end if;
        end if;
        if entry ? 'amountCents' and not private.org_structure_int_ok(entry -> 'amountCents', 0, 1000000000000000) then
          errors := private.org_structure_note(errors, base || '.amountCents', 'invalid_integer', 'amountCents is out of range');
        end if;
        if entry ? 'secondaryAmountCents'
           and not private.org_structure_int_ok(entry -> 'secondaryAmountCents', 0, 1000000000000000) then
          errors := private.org_structure_note(errors, base || '.secondaryAmountCents', 'invalid_integer', 'secondaryAmountCents is out of range');
        end if;
        if entry ? 'amountBasis' and not private.org_structure_text_ok(entry -> 'amountBasis', 1, 80) then
          errors := private.org_structure_note(errors, base || '.amountBasis', 'invalid_text', 'amountBasis must be 1-80 characters');
        end if;
        if entry ? 'partialPeriod' and pg_catalog.jsonb_typeof(entry -> 'partialPeriod') <> 'boolean' then
          errors := private.org_structure_note(errors, base || '.partialPeriod', 'not_boolean', 'partialPeriod must be a boolean');
        end if;
        if entry ? 'sourceLabel' and not private.org_structure_text_ok(entry -> 'sourceLabel', 1, 180) then
          errors := private.org_structure_note(errors, base || '.sourceLabel', 'invalid_text', 'sourceLabel must be 1-180 characters');
        end if;
        if entry ? 'sourceAsOf' and not private.org_structure_date_ok(entry -> 'sourceAsOf') then
          errors := private.org_structure_note(errors, base || '.sourceAsOf', 'invalid_date', 'sourceAsOf must be a date');
        end if;
        if entry ? 'visibility' and (entry ->> 'visibility') not in ('members', 'staff') then
          errors := private.org_structure_note(errors, base || '.visibility', 'invalid_enum', 'visibility must be members or staff');
        end if;
        if (entry ->> 'eventKind') = 'payroll_snapshot' then
          -- A named person's public pay figure enters as this organization's
          -- attributed row, with its source, and stays staff-visible.
          if not private.org_structure_int_ok(entry -> 'amountCents', 0, 1000000000000000)
             or not private.org_structure_text_ok(entry -> 'amountBasis', 1, 80)
             or not private.org_structure_text_ok(entry -> 'sourceLabel', 1, 180)
             or not private.org_structure_date_ok(entry -> 'sourceAsOf') then
            errors := private.org_structure_note(errors, base, 'payroll_incomplete',
              'a payroll snapshot needs amountCents, amountBasis, sourceLabel and sourceAsOf');
          end if;
          if (entry ->> 'visibility') = 'members' then
            errors := private.org_structure_note(errors, base || '.visibility', 'payroll_member_visibility',
              'payroll snapshots are staff-visible only until the owner decides otherwise');
          end if;
        end if;
        event_rows := event_rows + 1;
      end loop;
    end if;
  end if;

  -- Topic seeds are vocabulary only. The import never writes a member's
  -- progress, so these are validated and counted, not stored.
  if p_payload ? 'topicSeeds' then
    if pg_catalog.jsonb_typeof(p_payload -> 'topicSeeds') <> 'array' then
      errors := private.org_structure_note(errors, 'topicSeeds', 'not_array', 'topicSeeds must be an array');
    elsif pg_catalog.jsonb_array_length(p_payload -> 'topicSeeds') > 100 then
      errors := private.org_structure_note(errors, 'topicSeeds', 'too_many', 'an import carries at most 100 topic seeds');
    else
      for idx in 0 .. pg_catalog.jsonb_array_length(p_payload -> 'topicSeeds') - 1 loop
        entry := (p_payload -> 'topicSeeds') -> idx;
        base := 'topicSeeds[' || idx || ']';
        if pg_catalog.jsonb_typeof(entry) <> 'object' then
          errors := private.org_structure_note(errors, base, 'not_object', 'a topic seed must be an object');
          continue;
        end if;
        if (entry ->> 'topicKey') is null or (entry ->> 'topicKey') !~ '^[a-z0-9][a-z0-9_-]{0,79}$' then
          errors := private.org_structure_note(errors, base || '.topicKey', 'invalid_key', 'topicKey must be a lowercase key');
        end if;
        if not private.org_structure_text_ok(entry -> 'topicLabel', 1, 160) then
          errors := private.org_structure_note(errors, base || '.topicLabel', 'invalid_text', 'topicLabel must be 1-160 characters');
        end if;
      end loop;
    end if;
  end if;

  counts := pg_catalog.jsonb_build_object(
    'chapter', chapter_rows,
    'chart_node', node_rows,
    'chart_node_contact', contact_rows,
    'chart_node_note', note_rows,
    'chart_node_metric', metric_rows,
    'chart_cross_reference', xref_rows,
    'reference_section', section_rows,
    'reference_block', block_rows,
    'timeline_event', event_rows
  );
  return pg_catalog.jsonb_build_object(
    'errors', errors,
    'warnings', warnings,
    'counts', counts,
    'identity', pg_catalog.jsonb_build_object('bound', bound, 'unresolved', unresolved)
  );
end;
$function$;

revoke all on function private.org_structure_validate(uuid, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Writers
-- ---------------------------------------------------------------------------

-- The block tree is the one recursive shape in the payload, so it gets its own
-- writer. Every row it writes belongs to a section the caller's organization
-- owns; the caller's authorization was settled before this is reached.
create function private.org_structure_write_blocks(
  p_organization_id uuid,
  p_section_id uuid,
  p_parent_block_id uuid,
  p_blocks jsonb,
  p_depth integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  written integer;
  block jsonb;
  block_id uuid;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  written := 0;
  if pg_catalog.jsonb_typeof(p_blocks) <> 'array' then return 0; end if;
  for idx in 0 .. pg_catalog.jsonb_array_length(p_blocks) - 1 loop
    block := p_blocks -> idx;
    block_id := extensions.gen_random_uuid();
    insert into public.organization_reference_blocks (
      id, organization_id, section_id, parent_block_id, block_type, depth, sort_order, payload
    ) values (
      block_id, p_organization_id, p_section_id, p_parent_block_id, block ->> 'blockType',
      p_depth, coalesce((block ->> 'sortOrder')::integer, idx),
      coalesce(block -> 'payload', '{}'::jsonb)
    );
    written := written + 1;
    if block ? 'blocks' then
      written := written + private.org_structure_write_blocks(
        p_organization_id, p_section_id, block_id, block -> 'blocks', p_depth + 1);
    end if;
  end loop;
  return written;
end;
$function$;

revoke all on function private.org_structure_write_blocks(uuid, uuid, uuid, jsonb, integer)
  from public, anon, authenticated, service_role;

-- The import. One call, one transaction, one report.
--
--   * the organization comes from the session, never from the payload;
--   * an advisor, admin or vp hat with MFA is required;
--   * the whole payload is validated before anything is written;
--   * a dry run returns the same report and writes nothing;
--   * a failure while writing — including a constraint a validator did not
--     anticipate — leaves zero rows and zero audit events behind;
--   * a committed run writes one audit event per entity kind it touched,
--     carrying counts and identifiers only.
create function public.import_organization_structure(
  p_selected_hat text,
  p_payload jsonb,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid;
  caller uuid;
  report jsonb;
  v_counts jsonb;
  keys jsonb;
  import_id uuid;
  audit_events integer;
  committed boolean;
  dry boolean;
  kind text;
  entity text;
  entry jsonb;
  node jsonb;
  child jsonb;
  v_node_id uuid;
  target_id uuid;
  v_section_id uuid;
  chapter_key text;
  chapter_row text;
  key_text text;
  attestation jsonb;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  org := private.mi1_require_selected_organization();
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is null or p_selected_hat not in ('advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  dry := coalesce(p_dry_run, true);
  report := private.org_structure_validate(org, p_payload);
  if pg_catalog.jsonb_typeof(p_payload) = 'object' then
    if p_payload ? 'selectedHat' and (p_payload ->> 'selectedHat') is distinct from p_selected_hat then
      report := pg_catalog.jsonb_set(report, array['errors'], private.org_structure_note(
        report -> 'errors', 'selectedHat', 'hat_disagreement',
        'the payload names a different hat than the call'));
    end if;
    -- A payload that asks for a dry run may not be committed by the argument.
    if (p_payload -> 'dryRun') = 'true'::jsonb and not dry then
      report := pg_catalog.jsonb_set(report, array['errors'], private.org_structure_note(
        report -> 'errors', 'dryRun', 'dry_run_disagreement',
        'the payload asks for a dry run, so this call cannot commit'));
    end if;
  end if;

  v_counts := report -> 'counts';
  committed := false;
  audit_events := 0;
  import_id := null;

  if pg_catalog.jsonb_array_length(report -> 'errors') = 0 and not dry then
    begin
      attestation := p_payload -> 'attestation';
      keys := pg_catalog.jsonb_build_object('union', '{}'::jsonb, 'agency', '{}'::jsonb);

      -- Chapters first: a chapter node cannot reference a chapter row that does
      -- not exist yet.
      if p_payload ? 'chapters' then
        for idx in 0 .. pg_catalog.jsonb_array_length(p_payload -> 'chapters') - 1 loop
          entry := (p_payload -> 'chapters') -> idx;
          chapter_key := entry ->> 'chapterKey';
          chapter_row := null;
          select c.id into chapter_row
          from public.chapters c
          where c.organization_id = org and (c.slug = chapter_key or c.id = chapter_key)
          limit 1;
          if chapter_row is null then
            insert into public.chapters (
              id, name, region, is_default, order_index, organization_id, slug
            ) values (
              chapter_key, pg_catalog.btrim(entry ->> 'name'),
              nullif(pg_catalog.btrim(coalesce(entry ->> 'region', '')), ''),
              false, (entry ->> 'orderIndex')::integer, org, chapter_key
            );
          else
            update public.chapters set
              name = pg_catalog.btrim(entry ->> 'name'),
              region = nullif(pg_catalog.btrim(coalesce(entry ->> 'region', '')), ''),
              order_index = (entry ->> 'orderIndex')::integer
            where id = chapter_row and organization_id = org;
          end if;
        end loop;
      end if;

      -- Nodes, parents unset: a parent may appear after its child in the payload.
      foreach kind in array array['union', 'agency'] loop
        if not (coalesce(p_payload -> 'charts', '{}'::jsonb) ? kind) then continue; end if;
        for idx in 0 .. pg_catalog.jsonb_array_length(((p_payload -> 'charts') -> kind) -> 'nodes') - 1 loop
          node := (((p_payload -> 'charts') -> kind) -> 'nodes') -> idx;
          key_text := node ->> 'nodeKey';
          chapter_row := null;
          if node ? 'chapterKey' and pg_catalog.jsonb_typeof(node -> 'chapterKey') <> 'null' then
            select c.id into chapter_row
            from public.chapters c
            where c.organization_id = org
              and (c.slug = (node ->> 'chapterKey') or c.id = (node ->> 'chapterKey'))
            limit 1;
          end if;
          v_node_id := null;
          select n.id into v_node_id
          from public.organization_chart_nodes n
          where n.organization_id = org and n.chart_kind = kind and n.import_key = key_text;
          if v_node_id is null then
            v_node_id := extensions.gen_random_uuid();
            insert into public.organization_chart_nodes (
              id, organization_id, chapter_id, chart_kind, node_kind, parent_id, label, subtitle,
              position_x, position_y, sort_order, created_by, updated_by, user_id, import_key,
              badge, role_class, vacant, collapsed_by_default, reports_to_label, chip_label,
              source_label, source_as_of
            ) values (
              v_node_id, org, chapter_row, kind, node ->> 'nodeKind', null,
              pg_catalog.btrim(node ->> 'label'),
              nullif(pg_catalog.btrim(coalesce(node ->> 'subtitle', '')), ''),
              0, 0, coalesce((node ->> 'sortOrder')::integer, idx), caller, caller,
              (node ->> 'memberUserId')::uuid, key_text,
              nullif(pg_catalog.btrim(coalesce(node ->> 'badge', '')), ''),
              node ->> 'roleClass',
              coalesce((node ->> 'vacant')::boolean, false),
              coalesce((node ->> 'collapsedByDefault')::boolean, false),
              nullif(pg_catalog.btrim(coalesce(node ->> 'reportsToLabel', '')), ''),
              nullif(pg_catalog.btrim(coalesce(node ->> 'chipLabel', '')), ''),
              nullif(pg_catalog.btrim(coalesce(node ->> 'sourceLabel', '')), ''),
              (node ->> 'sourceAsOf')::date
            );
          else
            update public.organization_chart_nodes set
              chapter_id = chapter_row,
              node_kind = node ->> 'nodeKind',
              label = pg_catalog.btrim(node ->> 'label'),
              subtitle = nullif(pg_catalog.btrim(coalesce(node ->> 'subtitle', '')), ''),
              sort_order = coalesce((node ->> 'sortOrder')::integer, idx),
              user_id = (node ->> 'memberUserId')::uuid,
              badge = nullif(pg_catalog.btrim(coalesce(node ->> 'badge', '')), ''),
              role_class = node ->> 'roleClass',
              vacant = coalesce((node ->> 'vacant')::boolean, false),
              collapsed_by_default = coalesce((node ->> 'collapsedByDefault')::boolean, false),
              reports_to_label = nullif(pg_catalog.btrim(coalesce(node ->> 'reportsToLabel', '')), ''),
              chip_label = nullif(pg_catalog.btrim(coalesce(node ->> 'chipLabel', '')), ''),
              source_label = nullif(pg_catalog.btrim(coalesce(node ->> 'sourceLabel', '')), ''),
              source_as_of = (node ->> 'sourceAsOf')::date,
              updated_by = caller,
              updated_at = pg_catalog.now()
            where id = v_node_id and organization_id = org;
          end if;
          keys := pg_catalog.jsonb_set(keys, array[kind, key_text], pg_catalog.to_jsonb(v_node_id::text), true);
        end loop;
      end loop;

      -- Parents, then the rows that belong to a node. A node's contacts, notes
      -- and metrics are replaced wholesale: the payload is the record of what
      -- the organization publishes, so withdrawing a contact is an import away.
      foreach kind in array array['union', 'agency'] loop
        if not (coalesce(p_payload -> 'charts', '{}'::jsonb) ? kind) then continue; end if;
        for idx in 0 .. pg_catalog.jsonb_array_length(((p_payload -> 'charts') -> kind) -> 'nodes') - 1 loop
          node := (((p_payload -> 'charts') -> kind) -> 'nodes') -> idx;
          v_node_id := ((keys -> kind) ->> (node ->> 'nodeKey'))::uuid;
          if node ? 'parentKey' and pg_catalog.jsonb_typeof(node -> 'parentKey') <> 'null' then
            update public.organization_chart_nodes
            set parent_id = ((keys -> kind) ->> (node ->> 'parentKey'))::uuid,
                updated_by = caller,
                updated_at = pg_catalog.now()
            where id = v_node_id and organization_id = org;
          else
            update public.organization_chart_nodes
            set parent_id = null, updated_by = caller, updated_at = pg_catalog.now()
            where id = v_node_id and organization_id = org;
          end if;

          delete from public.organization_chart_node_contacts where organization_id = org and node_id = v_node_id;
          delete from public.organization_chart_node_notes where organization_id = org and node_id = v_node_id;
          delete from public.organization_chart_node_metrics where organization_id = org and node_id = v_node_id;

          if node ? 'contacts' then
            for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'contacts') - 1 loop
              child := (node -> 'contacts') -> jdx;
              insert into public.organization_chart_node_contacts (
                organization_id, node_id, contact_kind, contact_value, dial_href,
                confirmation_state, contact_visibility, is_personal_address, consent_source, sort_order
              ) values (
                org, v_node_id, child ->> 'contactKind', pg_catalog.btrim(child ->> 'contactValue'),
                nullif(pg_catalog.btrim(coalesce(child ->> 'dialHref', '')), ''),
                coalesce(child ->> 'confirmationState', 'unconfirmed'),
                coalesce(child ->> 'contactVisibility', 'staff'),
                coalesce((child ->> 'isPersonalAddress')::boolean, false),
                nullif(pg_catalog.btrim(coalesce(child ->> 'consentSource', '')), ''),
                coalesce((child ->> 'sortOrder')::integer, jdx)
              );
            end loop;
          end if;
          if node ? 'notes' then
            for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'notes') - 1 loop
              child := (node -> 'notes') -> jdx;
              insert into public.organization_chart_node_notes (
                organization_id, node_id, note_kind, body, sort_order
              ) values (
                org, v_node_id, coalesce(child ->> 'noteKind', 'note'),
                pg_catalog.btrim(child ->> 'body'),
                coalesce((child ->> 'sortOrder')::integer, jdx)
              );
            end loop;
          end if;
          if node ? 'metrics' then
            for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'metrics') - 1 loop
              child := (node -> 'metrics') -> jdx;
              insert into public.organization_chart_node_metrics (
                organization_id, node_id, metric_key, metric_label, metric_value, metric_unit, sort_order
              ) values (
                org, v_node_id, child ->> 'metricKey',
                nullif(pg_catalog.btrim(coalesce(child ->> 'metricLabel', '')), ''),
                (child ->> 'metricValue')::numeric,
                child ->> 'metricUnit',
                coalesce((child ->> 'sortOrder')::integer, jdx)
              );
            end loop;
          end if;
        end loop;
      end loop;

      -- Cross-references last among the node rows: a tag may point at a node of
      -- the other chart, which only exists once both charts are written.
      foreach kind in array array['union', 'agency'] loop
        if not (coalesce(p_payload -> 'charts', '{}'::jsonb) ? kind) then continue; end if;
        for idx in 0 .. pg_catalog.jsonb_array_length(((p_payload -> 'charts') -> kind) -> 'nodes') - 1 loop
          node := (((p_payload -> 'charts') -> kind) -> 'nodes') -> idx;
          v_node_id := ((keys -> kind) ->> (node ->> 'nodeKey'))::uuid;
          delete from public.organization_chart_cross_references
          where organization_id = org and node_id = v_node_id;
          if node ? 'crossReferences' then
            for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'crossReferences') - 1 loop
              child := (node -> 'crossReferences') -> jdx;
              target_id := null;
              if child ? 'targetNodeKey' and pg_catalog.jsonb_typeof(child -> 'targetNodeKey') <> 'null' then
                target_id := ((keys -> (case when kind = 'union' then 'agency' else 'union' end))
                  ->> (child ->> 'targetNodeKey'))::uuid;
              end if;
              insert into public.organization_chart_cross_references (
                organization_id, node_id, target_node_id, reference_kind, label, sort_order
              ) values (
                org, v_node_id, target_id, child ->> 'referenceKind',
                pg_catalog.btrim(child ->> 'label'),
                coalesce((child ->> 'sortOrder')::integer, jdx)
              );
            end loop;
          end if;
        end loop;
      end loop;

      -- Reference tabs. A section's block tree is replaced wholesale.
      if p_payload ? 'referenceSections' then
        for idx in 0 .. pg_catalog.jsonb_array_length(p_payload -> 'referenceSections') - 1 loop
          entry := (p_payload -> 'referenceSections') -> idx;
          v_section_id := null;
          select s.id into v_section_id
          from public.organization_reference_sections s
          where s.organization_id = org
            and s.chart_kind = (entry ->> 'chartKind')
            and s.section_key = (entry ->> 'sectionKey');
          if v_section_id is null then
            v_section_id := extensions.gen_random_uuid();
            insert into public.organization_reference_sections (
              id, organization_id, chart_kind, section_key, tab_label, panel_title,
              sort_order, source_label, source_as_of
            ) values (
              v_section_id, org, entry ->> 'chartKind', entry ->> 'sectionKey',
              pg_catalog.btrim(entry ->> 'tabLabel'),
              nullif(pg_catalog.btrim(coalesce(entry ->> 'panelTitle', '')), ''),
              coalesce((entry ->> 'sortOrder')::integer, idx),
              nullif(pg_catalog.btrim(coalesce(entry ->> 'sourceLabel', '')), ''),
              (entry ->> 'sourceAsOf')::date
            );
          else
            update public.organization_reference_sections set
              tab_label = pg_catalog.btrim(entry ->> 'tabLabel'),
              panel_title = nullif(pg_catalog.btrim(coalesce(entry ->> 'panelTitle', '')), ''),
              sort_order = coalesce((entry ->> 'sortOrder')::integer, idx),
              source_label = nullif(pg_catalog.btrim(coalesce(entry ->> 'sourceLabel', '')), ''),
              source_as_of = (entry ->> 'sourceAsOf')::date,
              updated_at = pg_catalog.now()
            where id = v_section_id and organization_id = org;
            delete from public.organization_reference_blocks
            where organization_id = org and section_id = v_section_id;
          end if;
          perform private.org_structure_write_blocks(
            org, v_section_id, null, coalesce(entry -> 'blocks', '[]'::jsonb), 0);
        end loop;
      end if;

      -- Timeline events, including the organization's attributed payroll rows.
      if p_payload ? 'timelineEvents' then
        for idx in 0 .. pg_catalog.jsonb_array_length(p_payload -> 'timelineEvents') - 1 loop
          entry := (p_payload -> 'timelineEvents') -> idx;
          v_node_id := null;
          if entry ? 'nodeKey' and pg_catalog.jsonb_typeof(entry -> 'nodeKey') <> 'null' then
            v_node_id := ((keys -> (entry ->> 'chartKind')) ->> (entry ->> 'nodeKey'))::uuid;
          end if;
          chapter_row := null;
          if entry ? 'chapterKey' and pg_catalog.jsonb_typeof(entry -> 'chapterKey') <> 'null' then
            select c.id into chapter_row
            from public.chapters c
            where c.organization_id = org
              and (c.slug = (entry ->> 'chapterKey') or c.id = (entry ->> 'chapterKey'))
            limit 1;
          end if;
          delete from public.organization_timeline_events
          where organization_id = org and import_key = (entry ->> 'importKey');
          insert into public.organization_timeline_events (
            organization_id, chapter_id, node_id, import_key, event_kind, title, detail,
            effective_on, ended_on, amount_cents, amount_basis, secondary_amount_cents,
            partial_period, visibility, source_label, source_as_of, created_by, updated_by
          ) values (
            org, chapter_row, v_node_id, entry ->> 'importKey', entry ->> 'eventKind',
            pg_catalog.btrim(entry ->> 'title'),
            nullif(pg_catalog.btrim(coalesce(entry ->> 'detail', '')), ''),
            (entry ->> 'effectiveOn')::date, (entry ->> 'endedOn')::date,
            (entry ->> 'amountCents')::bigint,
            nullif(pg_catalog.btrim(coalesce(entry ->> 'amountBasis', '')), ''),
            (entry ->> 'secondaryAmountCents')::bigint,
            coalesce((entry ->> 'partialPeriod')::boolean, false),
            coalesce(entry ->> 'visibility', 'staff'),
            nullif(pg_catalog.btrim(coalesce(entry ->> 'sourceLabel', '')), ''),
            (entry ->> 'sourceAsOf')::date, caller, caller
          );
        end loop;
      end if;

      -- The ledger row is the attestation: who supplied this content, when, and
      -- under what authority the organization publishes it.
      import_id := extensions.gen_random_uuid();
      insert into public.organization_structure_imports (
        id, organization_id, schema_version, selected_hat, supplied_by, supplied_on,
        authority, personal_contact_consent, consent_note, sources, counts, actor_user_id
      ) values (
        import_id, org, p_payload ->> 'schemaVersion', p_selected_hat,
        pg_catalog.btrim(attestation ->> 'suppliedBy'),
        (attestation ->> 'suppliedOn')::date,
        pg_catalog.btrim(attestation ->> 'authority'),
        attestation ->> 'personalContactConsent',
        nullif(pg_catalog.btrim(coalesce(attestation ->> 'consentNote', '')), ''),
        coalesce(p_payload -> 'sources', '[]'::jsonb), v_counts, caller
      );

      -- One counted audit event per entity kind this run wrote.
      foreach entity in array array[
        'chapter', 'chart_node', 'chart_node_contact', 'chart_node_note',
        'chart_node_metric', 'chart_cross_reference', 'reference_section',
        'reference_block', 'timeline_event'
      ] loop
        if coalesce((v_counts ->> entity)::integer, 0) > 0 then
          perform private.write_organization_intelligence_audit(
            org, 'structure_imported', entity, import_id::text,
            pg_catalog.jsonb_build_object('rowCount', (v_counts ->> entity)::integer, 'importId', import_id::text)
          );
          audit_events := audit_events + 1;
        end if;
      end loop;
      committed := true;
    exception when others then
      -- Nothing above survives: the block is one subtransaction, so a late
      -- constraint failure takes every row of this run with it.
      committed := false;
      import_id := null;
      audit_events := 0;
      report := pg_catalog.jsonb_set(report, array['errors'], private.org_structure_note(
        report -> 'errors', '', 'write_refused',
        'the import was refused while writing and nothing was written (' || sqlstate || ')'));
    end;
  end if;

  return pg_catalog.jsonb_build_object(
    'schemaVersion', 'org-structure/1',
    'organizationId', org,
    'importId', import_id,
    'dryRun', dry,
    'committed', committed,
    'generatedAt', pg_catalog.now(),
    'counts', v_counts,
    'identity', report -> 'identity',
    'errors', report -> 'errors',
    'warnings', report -> 'warnings',
    'auditEvents', audit_events
  );
end;
end;
$function$;

revoke all on function public.import_organization_structure(text, jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.import_organization_structure(text, jsonb, boolean) to authenticated;

comment on function public.import_organization_structure(text, jsonb, boolean) is
  'Admin-only organization-scoped structure import. Derives the organization from the session, requires an advisor/admin/vp hat with MFA, validates the whole payload before writing, supports a write-free dry run, leaves zero rows behind when any row fails, and audits a committed run once per entity kind.';

-- ---------------------------------------------------------------------------
-- 9. Account-lifecycle registration
-- ---------------------------------------------------------------------------
-- BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION-20260831 owns every deletion and
-- export disposition. This migration adds one direct auth.users link and one
-- edge inside the cascade closure, so both are reviewed here and all three
-- inventories must be complete before the migration may commit.

-- The person-node identity link now detaches with the deleted member's
-- membership, so its account key joins the row lock set the deletion takes.
drop trigger z99_case_graph_keys on public.organization_chart_nodes;
create trigger z99_case_graph_keys before insert or update or delete on public.organization_chart_nodes
for each row execute function private.lock_case_graph_row_keys('{created_by},{updated_by},{user_id}', '');

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition,
   export_disposition, export_projection, export_inventory_basis,
   exclusion_reason, note, reviewed_at)
values (
  'public', 'organization_structure_imports', 'actor_user_id', 'pseudonymize',
  'excluded_with_reason', null, 'auth_user_fk',
  'Operator attribution on an organization-owned import ledger. The ledger records the organization''s own attested structure, not caller-owned portable content.',
  'Installed action is ON DELETE SET NULL; the ledger row and its attestation survive while the departed operator identity detaches.',
  date '2026-09-23'
);

insert into private.account_lifecycle_transitive_fk_manifest
  (parent_schema_name, parent_table_name, schema_name, table_name, constraint_name,
   delete_disposition, set_null_columns, review_reason, reviewed_at)
values (
  'public', 'organization_memberships', 'public', 'organization_chart_nodes',
  'organization_chart_nodes_user_membership_fkey', 'pseudonymize', array['user_id'],
  'An imported chart position belongs to the organization. When the member''s membership is deleted, including by account deletion, only the identity link detaches and the position remains as an unlinked node.',
  date '2026-09-23'
);

-- The new tables' lock triggers and the re-created chart-node key trigger
-- enter the reviewed trigger surface with hashes taken from the surface itself.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger'
  and schema_name = 'public'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys')
  and table_name in (
    'organization_chart_nodes', 'organization_chart_node_contacts',
    'organization_chart_node_metrics', 'organization_chart_node_notes',
    'organization_chart_cross_references', 'organization_reference_sections',
    'organization_reference_blocks', 'organization_structure_imports')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_org_structure_account_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'account lifecycle deletion inventory is incomplete after the organization structure import migration';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after the organization structure import migration';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the organization structure import migration';
  end if;
end;
$assert_org_structure_account_lifecycle$;

notify pgrst, 'reload schema';

commit;
