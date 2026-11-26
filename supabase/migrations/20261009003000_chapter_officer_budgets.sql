-- REQ-UG-CHAPTER-BUDGET-FOR-OFFICERS-20261008.
-- Proposal: budget-only office assignments are explicit, never inferred from
-- display titles. Existing chapter Presidents (vp) have budget access; a chapter
-- administrator assigns Treasurer, Secretary-Treasurer or Secretary access.
-- Admin alone may assign access but cannot read financial contents.
-- No hosted apply or SAMPLE acceptance is claimed by this migration.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- As in 20261008235000, accept only reviewed predecessor/successor prosrc
-- MD5s. Budget routines are new: absence is allowed, an unrelated body is not.
do $predecessors$
declare
  expected constant jsonb := pg_catalog.jsonb_build_object(
    'private.clear_inactive_budget_office()', pg_catalog.jsonb_build_array('f47735a3e184a597c250dade278bfc00'),
    'private.chapter_budget_context(uuid,text)', pg_catalog.jsonb_build_array('2bd0ab767a8a73460d36c87adb91e9a2'),
    'public.get_chapter_budget_access(uuid,text,integer)', pg_catalog.jsonb_build_array('b1904b493bff5f713821cca83c97a3a8', '76bb1538fe08083de0bf4048c56989f6'),
    'public.set_chapter_budget_office(uuid,text,uuid,text)', pg_catalog.jsonb_build_array('e73c8660c1cedec81c38aa0c5ac6c81d'),
    'public.list_chapter_budgets(uuid,text,integer)', pg_catalog.jsonb_build_array('371ac6c958f30338218fd2f9dbd0b70c'),
    'public.save_chapter_budget(uuid,text,uuid,integer,text,date,date,text,jsonb)', pg_catalog.jsonb_build_array('3b234cf374439b80a3930703fe887923'),
    'private.account_lifecycle_export_member_chapter_memberships(uuid)', pg_catalog.jsonb_build_array('d2d4ee359ad1c7f412ae2f1f07d1cf3c', 'ba06a52f523a9851ece459bd8ee8858e')
  );
  fn text;
  actual text;
begin
  for fn in select pg_catalog.jsonb_object_keys(expected) loop
    select pg_catalog.md5(p.prosrc) into actual
      from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(fn);
    if actual is null and fn = 'private.account_lifecycle_export_member_chapter_memberships(uuid)' then
      raise exception 'missing reviewed % predecessor', fn using errcode = '55000';
    end if;
    if actual is not null and not ((expected -> fn) ? actual) then
      raise exception 'unreviewed % body: %', fn, actual using errcode = '55000';
    end if;
  end loop;
end;
$predecessors$;


create table if not exists private.chapter_budgets (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  chapter_id text not null,
  title text not null,
  period_start date not null,
  period_end date not null,
  notes text not null default '',
  items jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default pg_catalog.now(),
  constraint chapter_budgets_bounds check (
    pg_catalog.char_length(title) between 1 and 160 and title = pg_catalog.btrim(title)
    and period_end >= period_start and pg_catalog.char_length(notes) <= 4000
    and pg_catalog.jsonb_typeof(items) = 'array'
    and pg_catalog.jsonb_array_length(items) between 1 and 100
    and pg_catalog.octet_length(items::text) <= 65536 and revision > 0)
);
create temporary table chapter_budgets_expected_definition (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  chapter_id text not null,
  title text not null,
  period_start date not null,
  period_end date not null,
  notes text not null default '',
  items jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default pg_catalog.now(),
  constraint chapter_budgets_bounds check (
    pg_catalog.char_length(title) between 1 and 160 and title = pg_catalog.btrim(title)
    and period_end >= period_start and pg_catalog.char_length(notes) <= 4000
    and pg_catalog.jsonb_typeof(items) = 'array'
    and pg_catalog.jsonb_array_length(items) between 1 and 100
    and pg_catalog.octet_length(items::text) <= 65536 and revision > 0)
) on commit drop;
do $budgets$
declare
  actual jsonb;
  expected jsonb;
begin
  -- Exact columns, types, nullability and defaults; dropped columns excluded.
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attname, a.atttypid, a.atttypmod,
    a.attnotnull, a.attidentity, a.attgenerated, a.attcollation, pg_catalog.pg_get_expr(d.adbin, d.adrelid)) order by a.attnum)
    into actual from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d
      on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'private.chapter_budgets'::regclass and a.attnum > 0 and not a.attisdropped;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attname, a.atttypid, a.atttypmod,
    a.attnotnull, a.attidentity, a.attgenerated, a.attcollation, pg_catalog.pg_get_expr(d.adbin, d.adrelid)) order by a.attnum)
    into expected from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d
      on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'pg_temp.chapter_budgets_expected_definition'::regclass and a.attnum > 0 and not a.attisdropped;
  if actual is distinct from expected or not exists (
    select 1 from pg_catalog.pg_class where oid = 'private.chapter_budgets'::regclass and relkind = 'r' and relpersistence = 'p'
  ) then
    raise exception 'unreviewed private.chapter_budgets columns' using errcode = '55000';
  end if;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.regexp_replace(c.conname, '^chapter_budgets_expected_definition_pkey$', 'chapter_budgets_pkey'), c.contype, c.convalidated,
    c.condeferrable, c.condeferred, c.connoinherit, pg_catalog.pg_get_constraintdef(c.oid)) order by c.contype, pg_catalog.pg_get_constraintdef(c.oid))
    into actual from pg_catalog.pg_constraint c where c.conrelid = 'private.chapter_budgets'::regclass;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(pg_catalog.regexp_replace(c.conname, '^chapter_budgets_expected_definition_pkey$', 'chapter_budgets_pkey'), c.contype, c.convalidated,
    c.condeferrable, c.condeferred, c.connoinherit, pg_catalog.pg_get_constraintdef(c.oid)) order by c.contype, pg_catalog.pg_get_constraintdef(c.oid))
    into expected from pg_catalog.pg_constraint c where c.conrelid = 'pg_temp.chapter_budgets_expected_definition'::regclass;
  if actual is distinct from expected then
    raise exception 'unreviewed private.chapter_budgets constraints' using errcode = '55000';
  end if;
end;
$budgets$;
drop table pg_temp.chapter_budgets_expected_definition;
create index if not exists chapter_budgets_scope_idx on private.chapter_budgets
  (organization_id, chapter_id, created_at desc, id desc);
do $index$
begin
  if not exists (
    select 1 from pg_catalog.pg_index i where i.indexrelid = 'private.chapter_budgets_scope_idx'::regclass
      and i.indrelid = 'private.chapter_budgets'::regclass and i.indisvalid and i.indisready
      and pg_catalog.pg_get_indexdef(i.indexrelid) =
        'CREATE INDEX chapter_budgets_scope_idx ON private.chapter_budgets USING btree (organization_id, chapter_id, created_at DESC, id DESC)'
  ) then
    raise exception 'unreviewed chapter_budgets_scope_idx definition' using errcode = '55000';
  end if;
end;
$index$;
alter table private.chapter_budgets enable row level security;
alter table private.chapter_budgets force row level security;
revoke all on private.chapter_budgets from public, anon, authenticated, service_role;
comment on table private.chapter_budgets is
  'Officer-only chapter budget documents, USD amounts. No client table grants or person columns; financial bodies are never copied to audit metadata. Scope derives from active membership and every RPC binds the expected organization and chapter.';

create or replace function private.chapter_budget_context(p_expected_org uuid, p_expected_chapter text)
returns table (organization_id uuid, chapter_id text, can_read boolean, can_assign boolean)
language plpgsql stable security definer set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  caller uuid := (select auth.uid());
begin
  perform private.member_pin_require_full_session();
  if caller is null or not private.mfa_satisfied()
     or org is null or chapter is null
     or (private.staff_mfa_required(org) and not private.has_second_factor(caller))
     or org is distinct from p_expected_org or chapter is distinct from p_expected_chapter
     or not exists (select 1 from public.organizations o where o.id = org and o.status = 'active')
     or not exists (select 1 from public.chapters c where c.id = chapter and c.organization_id = org)
     or not exists (select 1 from public.organization_memberships m where m.user_id = caller and m.organization_id = org and m.status = 'active')
     or not exists (select 1 from public.member_chapter_memberships m where m.user_id = caller and m.chapter_id = chapter and m.status = 'active') then
    raise exception 'budget context required' using errcode = '42501';
  end if;
  return query select org, chapter,
    (exists (select 1 from public.member_role_chapters r where r.user_id = caller and r.chapter_id = chapter and r.role = 'vp')
     or exists (select 1 from public.member_chapter_memberships m where m.user_id = caller and m.chapter_id = chapter and m.status = 'active' and m.budget_office is not null)),
    exists (select 1 from public.member_role_chapters r where r.user_id = caller and r.chapter_id = chapter and r.role = 'admin');
end;
$function$;
revoke all on function private.chapter_budget_context(uuid, text) from public, anon, authenticated, service_role;

-- Metadata only: ordinary members learn no office holder names or budget data.
create or replace function public.get_chapter_budget_access(p_expected_org uuid, p_expected_chapter text, p_page integer default 0)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  ctx record;
  people jsonb := '[]'::jsonb;
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
begin
  -- This mount-time capability probe reveals nothing to ordinary members.
  -- Only callers with a chapter grant or explicit office need staff step-up.
  if not exists (select 1 from public.member_role_chapters r
      where r.user_id = caller and r.chapter_id = chapter and r.role in ('vp', 'admin'))
     and not exists (select 1 from public.member_chapter_memberships m
      where m.user_id = caller and m.chapter_id = chapter and m.status = 'active' and m.budget_office is not null) then
    return pg_catalog.jsonb_build_object('canRead', false, 'canAssign', false, 'members', people);
  end if;
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into ctx from private.chapter_budget_context(p_expected_org, p_expected_chapter);
  if p_page is null or p_page < 0 or p_page > 10000 then raise exception 'invalid page' using errcode = '22023'; end if;
  if ctx.can_assign then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', m.user_id, 'name', p.full_name, 'office', m.budget_office) order by m.user_id), '[]'::jsonb)
    into people from (select cm.user_id, cm.budget_office from public.member_chapter_memberships cm
      join public.organization_memberships om on om.user_id = cm.user_id and om.organization_id = ctx.organization_id and om.status = 'active'
      where cm.chapter_id = ctx.chapter_id and cm.status = 'active'
      order by cm.user_id limit 21 offset p_page * 20) m
      join public.member_profiles p on p.id = m.user_id;
  end if;
  return pg_catalog.jsonb_build_object('canRead', ctx.can_read, 'canAssign', ctx.can_assign, 'members', people);
end;
$function$;

create or replace function public.set_chapter_budget_office(p_expected_org uuid, p_expected_chapter text, p_user_id uuid, p_office text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare ctx record; old_office text;
begin
  perform private.lock_case_graph(array[(select auth.uid()), p_user_id], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into ctx from private.chapter_budget_context(p_expected_org, p_expected_chapter);
  if not ctx.can_assign then raise exception 'chapter admin required' using errcode = '42501'; end if;
  if p_office is not null and p_office not in ('treasurer', 'secretary_treasurer', 'secretary') then
    raise exception 'invalid budget office' using errcode = '22023';
  end if;
  select m.budget_office into old_office from public.member_chapter_memberships m
    join public.organization_memberships om on om.user_id = m.user_id and om.organization_id = ctx.organization_id and om.status = 'active'
    where m.user_id = p_user_id and m.chapter_id = ctx.chapter_id and m.status = 'active'
    for update of m;
  if not found then raise exception 'chapter member required' using errcode = '42501'; end if;
  update public.member_chapter_memberships set budget_office = p_office
    where user_id = p_user_id and chapter_id = ctx.chapter_id;
  if old_office is distinct from p_office then
    insert into public.organization_audit_ledger
      (organization_id, domain, event_type, action, actor_user_id, entity_type, entity_id, idempotency_key, metadata)
    values (ctx.organization_id, 'administration', 'chapter_budget_office', case when p_office is null then 'revoke' else 'grant' end,
      (select auth.uid()), 'membership', p_user_id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('chapterId', ctx.chapter_id, 'fromRole', old_office, 'toRole', p_office));
  end if;
  return pg_catalog.jsonb_build_object('saved', true);
end;
$function$;

create or replace function public.list_chapter_budgets(p_expected_org uuid, p_expected_chapter text, p_page integer default 0)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare ctx record; budgets jsonb;
begin
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into ctx from private.chapter_budget_context(p_expected_org, p_expected_chapter);
  if not ctx.can_read then raise exception 'budget office required' using errcode = '42501'; end if;
  if p_page is null or p_page < 0 or p_page > 10000 then raise exception 'invalid page' using errcode = '22023'; end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(b) order by b.created_at desc, b.id desc), '[]'::jsonb)
    into budgets from (select * from private.chapter_budgets
      where organization_id = ctx.organization_id and chapter_id = ctx.chapter_id
      order by created_at desc, id desc limit 21 offset p_page * 20) b;
  return budgets;
end;
$function$;

create or replace function public.save_chapter_budget(p_expected_org uuid, p_expected_chapter text, p_id uuid, p_revision integer, p_title text, p_period_start date, p_period_end date, p_notes text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare ctx record; line jsonb; saved private.chapter_budgets%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then raise exception 'MFA required' using errcode = '42501'; end if;
  select * into ctx from private.chapter_budget_context(p_expected_org, p_expected_chapter);
  if not ctx.can_read then raise exception 'budget office required' using errcode = '42501'; end if;
  if p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 1 and 160
     or p_period_start is null or p_period_end is null or p_period_end < p_period_start
     or p_notes is null or pg_catalog.char_length(p_notes) > 4000
     or p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid budget' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_items) not between 1 and 100 or pg_catalog.octet_length(p_items::text) > 65536 then
    raise exception 'invalid budget items' using errcode = '22023';
  end if;
  for line in select value from pg_catalog.jsonb_array_elements(p_items) loop
    if pg_catalog.jsonb_typeof(line) <> 'object' or line - array['name','planned','actual'] <> '{}'::jsonb
       or not line ?& array['name','planned','actual']
       or pg_catalog.jsonb_typeof(line->'name') <> 'string'
       or pg_catalog.char_length(pg_catalog.btrim(line->>'name')) not between 1 and 160
       or pg_catalog.jsonb_typeof(line->'planned') <> 'number' or pg_catalog.jsonb_typeof(line->'actual') <> 'number' then
      raise exception 'invalid budget item' using errcode = '22023';
    end if;
    if abs((line->>'planned')::numeric) > 9999999999.99 or abs((line->>'actual')::numeric) > 9999999999.99
       or (line->>'planned')::numeric <> round((line->>'planned')::numeric, 2)
       or (line->>'actual')::numeric <> round((line->>'actual')::numeric, 2) then
      raise exception 'invalid budget amount' using errcode = '22023';
    end if;
  end loop;
  if p_id is null then
    if p_revision is distinct from 0 then raise exception 'budget conflict' using errcode = '40001'; end if;
    insert into private.chapter_budgets (organization_id, chapter_id, title, period_start, period_end, notes, items)
      values (ctx.organization_id, ctx.chapter_id, pg_catalog.btrim(p_title), p_period_start, p_period_end, p_notes, p_items)
      returning * into saved;
  else
    update private.chapter_budgets set title = pg_catalog.btrim(p_title), period_start = p_period_start,
      period_end = p_period_end, notes = p_notes, items = p_items, revision = revision + 1
      where id = p_id and organization_id = ctx.organization_id and chapter_id = ctx.chapter_id and revision = p_revision
      returning * into saved;
    if not found then raise exception 'budget conflict' using errcode = '40001'; end if;
  end if;
  insert into public.organization_audit_ledger
    (organization_id, domain, event_type, action, actor_user_id, entity_type, entity_id, idempotency_key, metadata)
  values (ctx.organization_id, 'administration', 'chapter_budget_saved', case when p_id is null then 'create' else 'update' end,
    (select auth.uid()), 'document', saved.id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('chapterId', ctx.chapter_id));
  return pg_catalog.to_jsonb(saved);
end;
$function$;

revoke all on function public.get_chapter_budget_access(uuid, text, integer),
  public.set_chapter_budget_office(uuid, text, uuid, text), public.list_chapter_budgets(uuid, text, integer),
  public.save_chapter_budget(uuid, text, uuid, integer, text, date, date, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.get_chapter_budget_access(uuid, text, integer),
  public.set_chapter_budget_office(uuid, text, uuid, text), public.list_chapter_budgets(uuid, text, integer),
  public.save_chapter_budget(uuid, text, uuid, integer, text, date, date, text, jsonb) to authenticated;
-- Membership DDL takes an ACCESS EXCLUSIVE lock until commit. Do it last,
-- after the independent budget table and RPC work, to keep that window short.
-- Keep the existing membership lifecycle, user deletion and case-graph locks.
alter table public.member_chapter_memberships add column if not exists budget_office text;
-- IF NOT EXISTS may not silently accept a different column or constraint.
-- A disposable reference lets PostgreSQL normalize the expected CHECK itself.
create temporary table membership_budget_expected_definition (
  budget_office text constraint membership_budget_office_check
    check (budget_office is null or budget_office in ('treasurer', 'secretary_treasurer', 'secretary'))
) on commit drop;
do $membership$
begin
  if not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = 'public.member_chapter_memberships'::regclass
      and a.attname = 'budget_office' and not a.attisdropped
      and a.atttypid = 'text'::regtype and a.atttypmod = -1
      and not a.attnotnull and not a.atthasdef and a.attidentity = '' and a.attgenerated = ''
      and a.attcollation = (select typcollation from pg_catalog.pg_type where oid = 'text'::regtype)
  ) then
    raise exception 'unreviewed member_chapter_memberships.budget_office definition' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.member_chapter_memberships'::regclass and conname = 'membership_budget_office_check') then
    alter table public.member_chapter_memberships add constraint membership_budget_office_check
      check (budget_office is null or budget_office in ('treasurer', 'secretary_treasurer', 'secretary'));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
    join pg_catalog.pg_constraint expected
      on expected.conrelid = 'pg_temp.membership_budget_expected_definition'::regclass
      and expected.conname = 'membership_budget_office_check'
    where c.conrelid = 'public.member_chapter_memberships'::regclass and c.conname = expected.conname
      and c.contype = 'c' and c.convalidated and not c.connoinherit
      and not c.condeferrable and not c.condeferred
      and pg_catalog.pg_get_constraintdef(c.oid) = pg_catalog.pg_get_constraintdef(expected.oid)
  ) then
    raise exception 'unreviewed membership_budget_office_check definition' using errcode = '55000';
  end if;
end;
$membership$;
drop table pg_temp.membership_budget_expected_definition;


create or replace function private.clear_inactive_budget_office()
returns trigger language plpgsql set search_path = ''
as $function$
begin
  if new.status <> 'active' then new.budget_office := null; end if;
  return new;
end;
$function$;
revoke all on function private.clear_inactive_budget_office() from public, anon, authenticated, service_role;
do $trigger$
begin
  if exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.member_chapter_memberships'::regclass and t.tgname = 'b15_clear_budget_office'
      and (t.tgenabled <> 'O' or t.tgisinternal or pg_catalog.pg_get_triggerdef(t.oid) <>
        'CREATE TRIGGER b15_clear_budget_office BEFORE INSERT OR UPDATE ON public.member_chapter_memberships FOR EACH ROW EXECUTE FUNCTION private.clear_inactive_budget_office()')
  ) then
    raise exception 'unreviewed b15_clear_budget_office definition' using errcode = '55000';
  end if;
end;
$trigger$;
drop trigger if exists b15_clear_budget_office on public.member_chapter_memberships;
create trigger b15_clear_budget_office before insert or update on public.member_chapter_memberships
  for each row execute function private.clear_inactive_budget_office();
-- Use the inventory's exact hash formulas, scoped to this trigger and function.
-- A full account_lifecycle_trigger_surface scan walks every reachable routine
-- and takes tens of seconds; never hold the membership DDL lock for that scan.
do $trigger_review$
declare reviewed record;
begin
  for reviewed in
    select 'trigger'::text as kind, 'public'::text as schema_name,
      'member_chapter_memberships'::text as table_name, t.tgname::text as object_name,
      pg_catalog.md5(pg_catalog.pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text) as definition_hash
    from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.member_chapter_memberships'::regclass
      and t.tgname = 'b15_clear_budget_office' and not t.tgisinternal
    union all
    select 'function', 'private', '', 'clear_inactive_budget_office()',
      pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
    from pg_catalog.pg_proc p where p.oid = 'private.clear_inactive_budget_office()'::regprocedure
  loop
    if exists (
      select 1 from private.account_lifecycle_trigger_review r
      where r.kind = reviewed.kind and r.schema_name = reviewed.schema_name
        and r.table_name = reviewed.table_name and r.object_name = reviewed.object_name
        and r.definition_hash <> reviewed.definition_hash
    ) then
      raise exception 'unreviewed budget trigger lifecycle receipt' using errcode = '55000';
    end if;
    insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
    values (reviewed.kind, reviewed.schema_name, reviewed.table_name, reviewed.object_name, reviewed.definition_hash)
    on conflict (kind, schema_name, table_name, object_name) do nothing;
  end loop;
end;
$trigger_review$;

-- Carry the explicit office through the existing member-owned export domain.
update private.account_lifecycle_manifest
set export_columns = export_columns || array['budget_office']::text[]
where schema_name = 'public' and table_name = 'member_chapter_memberships' and user_column = 'user_id'
  and not ('budget_office' = any(export_columns));
create or replace function private.account_lifecycle_export_member_chapter_memberships(p_caller uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'user_id', t.user_id, 'chapter_id', t.chapter_id, 'status', t.status, 'pinned', t.pinned,
    'last_selected_at', t.last_selected_at, 'joined_at', t.joined_at, 'revoked_at', t.revoked_at,
    'compass_unit_keys', t.compass_unit_keys, 'compass_scope_verification', t.compass_scope_verification,
    'display_title', t.display_title, 'budget_office', t.budget_office)), '[]'::jsonb)
  from public.member_chapter_memberships t where t.user_id = p_caller;
$$;
revoke all on function private.account_lifecycle_export_member_chapter_memberships(uuid)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
