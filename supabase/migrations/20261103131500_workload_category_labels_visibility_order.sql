-- REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103 (#6910),
-- the first slice of #6809 (project decision Nov 3, 2026).
--
-- An organization names, shows or hides, and orders the eight workload
-- categories of the member Workload log. The categories stay the fixed
-- columns of public.member_workload_logs; nothing here reads or writes those
-- logs, and the workload stats, intelligence, notification and export
-- functions are untouched. A hidden category keeps every historical value and
-- still counts wherever the server counts it; the page only stops asking for
-- it and stops showing it.
--
-- 1. The organization label list gains workload.cat.<key> for the eight
--    categories, saved through update_organization_label like every other
--    label (organization admins only, at most 40 characters).
-- 2. private.organization_workload_categories holds one row per category for
--    an organization that has saved a choice: visible and sort_order. No row
--    means the default: every category shown, in the page's own order.
--    Read through get_organization_workload_categories (members of the
--    caller's selected organization) and replaced whole by
--    save_organization_workload_categories (organization admins), which keeps
--    at least one category shown and records the change in the
--    organization's configuration history.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Workload category labels
-- ---------------------------------------------------------------------------
alter table public.organization_label_overrides
  drop constraint organization_label_overrides_key,
  add constraint organization_label_overrides_key check (label_key in (
    'nav.home', 'nav.myCases', 'nav.messages', 'nav.inbox', 'nav.knowRights',
    'nav.myChapter', 'nav.settings', 'staff.chapterWork', 'nav.casework',
    'admin.title', 'coordinator.title', 'advisor.title', 'vp.title',
    'term.chapter', 'term.chapters', 'term.worksite', 'term.worksites',
    'workload.cat.priority', 'workload.cat.pending', 'workload.cat.unread_docs', 'workload.cat.todos',
    'workload.cat.referrals', 'workload.cat.ce_activities', 'workload.cat.assistance_requests', 'workload.cat.aged_cases'
  ));

create or replace function public.update_organization_label(p_key text, p_value text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- The case-graph entry gate the base migrations installed, kept ahead of
  -- the declarations that read the caller's organization.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  org_id uuid := private.current_member_organization();
  caller uuid := (select auth.uid());
  clean text := pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_value, '')), '[[:space:]]+', ' ', 'g');
  valid_keys constant text[] := array[
    'nav.home', 'nav.myCases', 'nav.messages', 'nav.inbox', 'nav.knowRights',
    'nav.myChapter', 'nav.settings', 'staff.chapterWork', 'nav.casework',
    'admin.title', 'coordinator.title', 'advisor.title', 'vp.title',
    'term.chapter', 'term.chapters', 'term.worksite', 'term.worksites',
    'workload.cat.priority', 'workload.cat.pending', 'workload.cat.unread_docs', 'workload.cat.todos',
    'workload.cat.referrals', 'workload.cat.ce_activities', 'workload.cat.assistance_requests', 'workload.cat.aged_cases'
  ]::text[];
begin
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if not (p_key = any(valid_keys)) then raise exception 'invalid label key' using errcode = '22023'; end if;
  if clean = '' then
    delete from public.organization_label_overrides where organization_id = org_id and label_key = p_key;
    insert into public.organization_configuration_audit (organization_id, actor_user_id, action, item_key)
    values (org_id, caller, 'label_removed', p_key);
    return pg_catalog.jsonb_build_object('key', p_key, 'value', null, 'removed', true);
  end if;
  -- A term is one or a few words that sit inside sentences.
  if pg_catalog.char_length(clean) > 40 or clean ~ '[<>[:cntrl:]]'
     or (p_key like 'term.%' and (pg_catalog.char_length(clean) > 30 or clean !~ '^[[:alpha:]][[:alpha:] ''&-]*$')) then
    raise exception 'invalid label value' using errcode = '22023';
  end if;
  insert into public.organization_label_overrides (organization_id, label_key, label_value, updated_by)
  values (org_id, p_key, clean, caller)
  on conflict (organization_id, label_key) do update
    set label_value = excluded.label_value, updated_by = excluded.updated_by, updated_at = pg_catalog.now();
  insert into public.organization_configuration_audit (organization_id, actor_user_id, action, item_key)
  values (org_id, caller, 'label_updated', p_key);
  return pg_catalog.jsonb_build_object('key', p_key, 'value', clean, 'updated', true);
end;
end;
$function$;
revoke all on function public.update_organization_label(text, text) from public, anon, authenticated, service_role;
grant execute on function public.update_organization_label(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Which categories show, and in what order
-- ---------------------------------------------------------------------------
create table private.organization_workload_categories (
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  category_key text not null,
  visible boolean not null default true,
  sort_order smallint not null,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, category_key),
  constraint organization_workload_categories_key check (category_key in (
    'priority', 'pending', 'unread_docs', 'todos',
    'referrals', 'ce_activities', 'assistance_requests', 'aged_cases'
  )),
  constraint organization_workload_categories_sort_order check (sort_order between 1 and 8),
  constraint organization_workload_categories_order_key unique (organization_id, sort_order)
);
alter table private.organization_workload_categories enable row level security;
alter table private.organization_workload_categories force row level security;
revoke all on table private.organization_workload_categories from public, anon, authenticated, service_role;
create policy mfa_assurance on private.organization_workload_categories as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.organization_workload_categories is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC checks the caller''s organization and role.';
-- Organization children join the account case graph.
create trigger a00_case_graph_lock before insert or update or delete on private.organization_workload_categories
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_workload_categories
for each row execute function private.lock_case_graph_row_keys('', '');
comment on table private.organization_workload_categories is
  'REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103: whether each workload category shows on the member Workload log, and its place. Read only through get_organization_workload_categories and replaced only by save_organization_workload_categories.';
-- The two case-graph triggers join the reviewed account-lifecycle surface,
-- like every other organization child's.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind = 'trigger' and s.schema_name = 'private' and s.table_name = 'organization_workload_categories'
  and s.object_name in ('a00_case_graph_lock', 'z99_case_graph_keys')
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_workload_category_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after workload categories';
  end if;
end;
$assert_workload_category_trigger_review$;

-- The eight categories of one organization in its order, with the default
-- (all shown, page order) for any category it has not saved.
create function private.organization_workload_categories_payload(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'categories', pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('key', d.key, 'visible', coalesce(c.visible, true))
      order by coalesce(c.sort_order, d.position), d.position),
    'canEdit', private.has_organization_role(p_organization_id, array['admin']),
    'updatedAt', pg_catalog.max(c.updated_at)
  )
  from pg_catalog.unnest(array[
    'priority', 'pending', 'unread_docs', 'todos',
    'referrals', 'ce_activities', 'assistance_requests', 'aged_cases'
  ]::text[]) with ordinality as d(key, position)
  left join private.organization_workload_categories c
    on c.organization_id = p_organization_id and c.category_key = d.key;
$function$;
revoke all on function private.organization_workload_categories_payload(uuid) from public, anon, authenticated, service_role;

create function public.get_organization_workload_categories()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.chapter_units_context();
  if org is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  return private.organization_workload_categories_payload(org);
end;
$function$;
revoke all on function public.get_organization_workload_categories() from public, anon, authenticated, service_role;
grant execute on function public.get_organization_workload_categories() to authenticated;

-- p_categories lists all eight categories once each, in the new order, as
-- {"key": text, "visible": boolean}. At least one stays shown. The history
-- entry records the shown categories in order, before and after.
create function public.save_organization_workload_categories(p_categories jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  org uuid;
  caller uuid := (select auth.uid());
  entry jsonb;
  seen text[] := array[]::text[];
  shown integer := 0;
  previous_shown jsonb;
  next_shown jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.chapter_units_context();
  if org is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_categories is null or pg_catalog.jsonb_typeof(p_categories) <> 'array'
     or pg_catalog.jsonb_array_length(p_categories) <> 8 then
    raise exception 'invalid workload categories' using errcode = '22023';
  end if;
  for entry in select e.value from pg_catalog.jsonb_array_elements(p_categories) with ordinality as e(value, position) order by e.position loop
    if pg_catalog.jsonb_typeof(entry) <> 'object'
       or (select pg_catalog.array_agg(k.key order by k.key) from pg_catalog.jsonb_object_keys(entry) as k(key)) <> array['key', 'visible']::text[]
       or pg_catalog.jsonb_typeof(entry -> 'key') <> 'string'
       or pg_catalog.jsonb_typeof(entry -> 'visible') <> 'boolean'
       or not ((entry ->> 'key') = any(array[
         'priority', 'pending', 'unread_docs', 'todos',
         'referrals', 'ce_activities', 'assistance_requests', 'aged_cases'
       ]::text[]))
       or (entry ->> 'key') = any(seen) then
      raise exception 'invalid workload categories' using errcode = '22023';
    end if;
    seen := seen || (entry ->> 'key');
    if (entry -> 'visible') = 'true'::jsonb then shown := shown + 1; end if;
  end loop;
  if shown = 0 then
    raise exception 'at least one workload category must stay shown' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(c.value -> 'key' order by c.position), '[]'::jsonb) into previous_shown
  from pg_catalog.jsonb_array_elements(private.organization_workload_categories_payload(org) -> 'categories') with ordinality as c(value, position)
  where (c.value -> 'visible') = 'true'::jsonb;

  delete from private.organization_workload_categories where organization_id = org;
  insert into private.organization_workload_categories (organization_id, category_key, visible, sort_order, updated_at)
  select org, e.value ->> 'key', (e.value -> 'visible') = 'true'::jsonb, e.position::smallint, pg_catalog.clock_timestamp()
  from pg_catalog.jsonb_array_elements(p_categories) with ordinality as e(value, position);

  select coalesce(pg_catalog.jsonb_agg(e.value -> 'key' order by e.position), '[]'::jsonb) into next_shown
  from pg_catalog.jsonb_array_elements(p_categories) with ordinality as e(value, position)
  where (e.value -> 'visible') = 'true'::jsonb;
  insert into public.organization_configuration_audit
    (organization_id, actor_user_id, action, item_key, previous_value, new_value, created_at)
  values (org, caller, 'setting_updated', 'workload.categories', previous_shown, next_shown, pg_catalog.clock_timestamp());

  return private.organization_workload_categories_payload(org);
end;
end;
$function$;
revoke all on function public.save_organization_workload_categories(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_organization_workload_categories(jsonb) to authenticated;

commit;
