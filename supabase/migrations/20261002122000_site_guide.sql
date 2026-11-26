-- REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001
--
-- Restores the logged-in "How to use this site" guide for real accounts
-- (old de7df4b57c^:lib/welcome-guide/config.ts, route /dashboard/guide,
-- migration 0612_welcome_guide.sql). Today the guide and tour open only from
-- the SAMPLE demo bar. The guide's sections are generated on the client from
-- the signed-in person's own navigation (member groups plus the staff desks
-- they hold). The words are product defaults that an organization admin may
-- replace for the whole organization.
--
-- Defaults. 0612 seeded welcome_guide_enabled = 'true' and the page read it
-- with getBoolean(settings, welcomeGuideEnabled, true), so the switch
-- features.guidance_onboarding.site_guide starts ON.
--
-- Storage. private.organization_site_guide_copy holds one optional override
-- row per organization (title, intro, help card, per-section body and up to
-- six tips). No client grant: it is read through public.get_site_guide() and
-- written through public.save_site_guide(). The writer requires an
-- organization admin with an MFA-backed session (session-derived
-- organization) and records the acting admin on public.organization_audit_ledger.
-- The table holds no person-level data.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.guidance_onboarding.site_guide', 'boolean', 'Site guide',
   'Offer every signed-in person a "How to use this site" guide built from their own navigation.',
   'true', null, null, null, 1300, 'guidance_onboarding', true)
on conflict (key) do nothing;

create table private.organization_site_guide_copy (
  organization_id uuid primary key
    references public.organizations(id) on update cascade on delete cascade,
  title text,
  intro text,
  help_title text,
  help_body text,
  sections jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_site_guide_copy_title check (title is null or (pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 120 and title !~ '[[:cntrl:]]')),
  constraint organization_site_guide_copy_intro check (intro is null or (pg_catalog.char_length(pg_catalog.btrim(intro)) between 1 and 1000 and pg_catalog.regexp_replace(intro, '[\n]', '', 'g') !~ '[[:cntrl:]]')),
  constraint organization_site_guide_copy_help_title check (help_title is null or (pg_catalog.char_length(pg_catalog.btrim(help_title)) between 1 and 120 and help_title !~ '[[:cntrl:]]')),
  constraint organization_site_guide_copy_help_body check (help_body is null or (pg_catalog.char_length(pg_catalog.btrim(help_body)) between 1 and 800 and pg_catalog.regexp_replace(help_body, '[\n]', '', 'g') !~ '[[:cntrl:]]')),
  constraint organization_site_guide_copy_sections check (
    pg_catalog.jsonb_typeof(sections) = 'object' and pg_catalog.octet_length(sections::text) <= 32768
  )
);

comment on table private.organization_site_guide_copy is
  'REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001: one optional organization override of the Site Guide copy. No client grant; read through get_site_guide and written through save_site_guide. The acting admin is on the organization_audit_ledger row.';

alter table private.organization_site_guide_copy enable row level security;
alter table private.organization_site_guide_copy force row level security;
revoke all on table private.organization_site_guide_copy from public, anon, authenticated, service_role;

create trigger a00_case_graph_lock before insert or update or delete on private.organization_site_guide_copy
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_site_guide_copy
for each row execute function private.lock_case_graph_row_keys('', '');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private' and table_name = 'organization_site_guide_copy'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_site_guide_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the site guide copy table';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after the site guide copy table';
  end if;
end;
$assert_site_guide_trigger_review$;

create function public.get_site_guide()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  enabled boolean;
  copy_row private.organization_site_guide_copy%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  begin
    org := private.mi1_w2_selected_organization();
  exception when insufficient_privilege then
    return pg_catalog.jsonb_build_object('state', 'unavailable', 'enabled', false);
  end;
  enabled := private.organization_feature_enabled(org, 'features.guidance_onboarding.site_guide');
  if not enabled then
    return pg_catalog.jsonb_build_object('state', 'ready', 'organizationId', org, 'enabled', false,
      'canEdit', private.has_organization_role(org, array['admin']));
  end if;
  select * into copy_row from private.organization_site_guide_copy c where c.organization_id = org;
  return pg_catalog.jsonb_build_object(
    'state', 'ready',
    'organizationId', org,
    'enabled', true,
    'canEdit', private.has_organization_role(org, array['admin']),
    'copy', case when copy_row.organization_id is null then null else pg_catalog.jsonb_build_object(
      'title', copy_row.title,
      'intro', copy_row.intro,
      'helpTitle', copy_row.help_title,
      'helpBody', copy_row.help_body,
      'sections', copy_row.sections,
      'updatedAt', copy_row.updated_at
    ) end
  );
end;
$function$;

revoke all on function public.get_site_guide() from public, anon, authenticated, service_role;
grant execute on function public.get_site_guide() to authenticated;

create function public.save_site_guide(
  p_title text,
  p_intro text,
  p_help_title text,
  p_help_body text,
  p_sections jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  declare
    org uuid := private.mi1_w2_selected_organization();
    clean_title text := nullif(pg_catalog.btrim(coalesce(p_title, '')), '');
    clean_intro text := nullif(pg_catalog.btrim(coalesce(p_intro, '')), '');
    clean_help_title text := nullif(pg_catalog.btrim(coalesce(p_help_title, '')), '');
    clean_help_body text := nullif(pg_catalog.btrim(coalesce(p_help_body, '')), '');
    clean_sections jsonb := '{}'::jsonb;
    section_key text;
    section_value jsonb;
    section_body text;
    section_steps jsonb;
    step text;
    clean_steps jsonb;
    fields text[] := '{}'::text[];
  begin
    if not private.has_organization_role(org, array['admin']) then
      raise exception 'admin role required' using errcode = '42501';
    end if;
    if p_idempotency_key is null then
      raise exception 'invalid site guide' using errcode = '22023';
    end if;
    if p_sections is not null and pg_catalog.jsonb_typeof(p_sections) <> 'object' then
      raise exception 'invalid site guide' using errcode = '22023';
    end if;
    if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(coalesce(p_sections, '{}'::jsonb))) > 20 then
      raise exception 'invalid site guide' using errcode = '22023';
    end if;
    for section_key, section_value in select key, value from pg_catalog.jsonb_each(coalesce(p_sections, '{}'::jsonb)) loop
      if section_key !~ '^[a-z][a-z0-9_-]{1,39}$' or pg_catalog.jsonb_typeof(section_value) <> 'object'
        or exists (select 1 from pg_catalog.jsonb_object_keys(section_value) k where k not in ('body', 'steps')) then
        raise exception 'invalid site guide' using errcode = '22023';
      end if;
      section_body := null;
      if section_value ? 'body' and pg_catalog.jsonb_typeof(section_value -> 'body') <> 'null' then
        if pg_catalog.jsonb_typeof(section_value -> 'body') <> 'string' then
          raise exception 'invalid site guide' using errcode = '22023';
        end if;
        section_body := nullif(pg_catalog.btrim(section_value ->> 'body'), '');
        if section_body is not null and (pg_catalog.char_length(section_body) > 1200
          or pg_catalog.regexp_replace(section_body, '[\n]', '', 'g') ~ '[[:cntrl:]]') then
          raise exception 'invalid site guide' using errcode = '22023';
        end if;
      end if;
      clean_steps := '[]'::jsonb;
      section_steps := section_value -> 'steps';
      if section_steps is not null and pg_catalog.jsonb_typeof(section_steps) <> 'null' then
        if pg_catalog.jsonb_typeof(section_steps) <> 'array' or pg_catalog.jsonb_array_length(section_steps) > 6 then
          raise exception 'invalid site guide' using errcode = '22023';
        end if;
        for step in select pg_catalog.btrim(value) from pg_catalog.jsonb_array_elements_text(section_steps) loop
          if step = '' then continue; end if;
          if pg_catalog.char_length(step) > 220 or step ~ '[[:cntrl:]]' then
            raise exception 'invalid site guide' using errcode = '22023';
          end if;
          clean_steps := clean_steps || pg_catalog.to_jsonb(step);
        end loop;
      end if;
      if section_body is not null or pg_catalog.jsonb_array_length(clean_steps) > 0 then
        clean_sections := clean_sections || pg_catalog.jsonb_build_object(section_key,
          pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'body', section_body,
            'steps', case when pg_catalog.jsonb_array_length(clean_steps) > 0 then clean_steps end
          )));
      end if;
    end loop;

    if clean_title is not null then fields := fields || 'title'::text; end if;
    if clean_intro is not null then fields := fields || 'intro'::text; end if;
    if clean_help_title is not null then fields := fields || 'helpTitle'::text; end if;
    if clean_help_body is not null then fields := fields || 'helpBody'::text; end if;
    if clean_sections <> '{}'::jsonb then fields := fields || 'sections'::text; end if;

    if pg_catalog.cardinality(fields) = 0 then
      -- Nothing left to override: the organization is back on the defaults.
      delete from private.organization_site_guide_copy where organization_id = org;
    else
      insert into private.organization_site_guide_copy (organization_id, title, intro, help_title, help_body, sections, updated_at)
      values (org, clean_title, clean_intro, clean_help_title, clean_help_body, clean_sections, pg_catalog.now())
      on conflict (organization_id) do update set
        title = excluded.title,
        intro = excluded.intro,
        help_title = excluded.help_title,
        help_body = excluded.help_body,
        sections = excluded.sections,
        updated_at = excluded.updated_at;
    end if;

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'administration', 'site_guide_copy_changed', 'settings_change',
      (select auth.uid()), 'organization', org::text, p_idempotency_key,
      pg_catalog.jsonb_build_object(
        'fieldsChanged', pg_catalog.to_jsonb(fields),
        'reasonCode', case when pg_catalog.cardinality(fields) = 0 then 'restored_defaults' else 'copy_saved' end
      )
    ) on conflict (idempotency_key) do nothing;

    return pg_catalog.jsonb_build_object('saved', true, 'restoredDefaults', pg_catalog.cardinality(fields) = 0, 'fields', pg_catalog.to_jsonb(fields));
  end;
end;
$function$;

revoke all on function public.save_site_guide(text, text, text, text, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_site_guide(text, text, text, text, jsonb, uuid) to authenticated;

comment on function public.get_site_guide() is
  'REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001: the session organization''s Site Guide switch and optional copy override; canEdit for admins.';
comment on function public.save_site_guide(text, text, text, text, jsonb, uuid) is
  'REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001: admin-only, MFA-backed save (or restore to defaults) of the organization''s Site Guide copy, audited on organization_audit_ledger.';

notify pgrst, 'reload schema';

commit;
