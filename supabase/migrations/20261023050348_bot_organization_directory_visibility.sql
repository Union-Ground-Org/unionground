-- OPS-UG-BOT-ORGANIZATIONS-DIRECTORY-VISIBILITY-20261022 (#5844)
-- Visibility is containment, never removal: the bot ledger and signup gate
-- remain intact. Tenant-local operations still work; public/foreign discovery
-- excludes fictional organizations even when their profiles are published.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Refuse stale re-emissions if another migration changed any reader first.
do $predecessors$
declare changed text;
begin
  select expected.signature into changed from (values
    ('private.bot_production_mark_row(text,text,text,text)', '4a1c54e3e3d37e43725595041f96f736'),
    ('private.bot_production_mark_founder_invitation()', 'faadecd2b1e2eee220544566431260b1'),
    ('private.bot_production_mark_chapter()', 'b96b64cd537b4d97d391230c4a80d416'),
    ('private.bot_production_mark_invitation()', 'c33f043531e5464f2b7b36797b26c322'),
    ('private.bot_production_mark_staged_account()', '4a2e6ca0e9f21788a03ae404e10bca67'),
    ('private.bot_production_reopen()', '44f8ad35a4382aeab10a0926d31157b2'),
    ('public.bot_production_mark(text,text[],text,text)', '3ada87615a4e3b10790a867feb6143f6'),
    ('public.get_public_site_content(text)', '5960a9b991fea7e2d8a31199f7a73813'),
    ('public.get_public_directory(text)', 'fc53c90f6bd5d3b1263f83c076d002fc'),
    ('public.get_public_event_detail(text,text)', 'bc487ae194a15cec3ba5796816a0f414'),
    ('public.get_public_chapter_microsite(text,text)', 'f68980cde3daef6a8e2499f411554ce5'),
    ('public.get_organization_public_verification(text)', 'd1be0ce09dff52ce9919f2d59268e464'),
    ('private.organization_network_can_discover(uuid)', 'cef07e2875b8ab0a27a7f8f5001f2739'),
    ('public.list_chapter_connection_profiles(text,text,integer,text,text)', '3f902867392972a25c8595b5fd3144be'),
    ('public.search_union_catalog(text,text,text,text,integer)', '57254a673ed238f69e2a3c841893023c'),
    ('public.get_union_catalog_profile(text)', 'e2ef37166ca2acc784680f6b12cbf1b7'),
    ('public.request_chapter_connection_handshake(text,text,text,text,text,text,uuid)', 'fe8ac014c317e38362a14b49c1f26ff6'),
    ('public.request_chapter_handshake(text,text,text,text,uuid)', 'c995db9ee653f581dad1997f8507ac80'),
    ('public.submit_public_event_rsvp(text,text,text,text,text,text,text,text)', '0816d19fe1d5482c648ed2c1efedad1c'),
    ('private.organization_catalog_parent(text)', '94d81052d95d852a39d93bd9f9479520'),
    ('public.submit_organization_claim(text,text,text,jsonb,jsonb,jsonb,text,text,uuid,uuid)', 'e603f229058ac3cea83fc83ec47fc494')
  ) expected(signature, source_md5)
  left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(expected.signature)
  where pg_catalog.md5(p.prosrc) is distinct from expected.source_md5 limit 1;
  if changed is not null then
    raise exception 'directory visibility predecessor changed: %', changed;
  end if;
end;
$predecessors$;


alter table public.organizations add column is_fictional boolean not null default false;
alter table public.union_orgs add column is_fictional boolean not null default false;
comment on column public.organizations.is_fictional is
  'Sticky fictional/test-data marker. Excluded from public and unrelated-organization discovery; not evidence of removal.';
comment on column public.union_orgs.is_fictional is
  'Sticky fictional registry marker. Never returned through the public registry or catalog search.';

-- Existing ledger anchors and exact identities from the retained October 15
-- residue manifest, not name/slug heuristics. A removed mark whose row remains
-- is still fictional. No rows or ledger entries are deleted by this migration.
-- Residue manifest SHA256: b803dbd419770ab7388ff073c36054233b290e207db98f0204c45160887baa49
update public.organizations o set is_fictional = true
where exists (select 1 from private.bot_production_marks m
  where m.kind = 'organization' and m.record_id = o.id::text)
  or o.id in ('1c72d037-7922-4433-b6d3-008beb04f7fa'::uuid, '2f991f03-ef3c-42c4-843d-87c3b65fca87'::uuid, '4627626b-31dd-41ae-a4a9-216204bb5a7b'::uuid, '4b7eadce-b065-44b1-9d75-57246ede15e2'::uuid, '6ed4decd-901b-4c29-99e9-c5082b43ca3b'::uuid, '875cba15-fa16-4689-8ce9-0df673f50cbd'::uuid, '913eeca3-1d22-44eb-be26-5495f64aad01'::uuid, 'bde781e4-0a4d-4544-a385-4cdc921db5cb'::uuid, 'c2824787-285e-4b45-be15-3250e9ead164'::uuid);

-- This is the seed's explicit source provenance, not a guessed identity.
update public.union_orgs set is_fictional = true where atlas_manifest_sha = 'tamarack-fixture-v1';
-- A requested or rejected placement is not evidence about the tenant.
-- Only a verified binding may inherit the registry's fictional provenance.
update public.organizations o set is_fictional = true
where exists (select 1 from public.chapters c
  join public.chapter_union_org_bindings b on b.chapter_id = c.id
  join public.union_orgs u on u.id = b.union_org_id
  where c.organization_id = o.id and b.status = 'verified' and u.is_fictional);

create function private.organization_visible_in_directory(p_organization_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (select 1 from public.organizations o
    where o.id = p_organization_id and not o.is_fictional
      and not exists (select 1 from private.bot_production_marks m
        where m.kind = 'organization' and m.record_id = o.id::text));
$function$;
revoke all on function private.organization_visible_in_directory(uuid) from public, anon, authenticated, service_role;

-- A fictional tenant retains its bound registry identities and their parent
-- filing. Membership comes from the verified session, never a supplied org ID.
create function private.organization_owns_fictional_registry(p_organization_id uuid, p_registry_id text)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from public.organizations o
    join public.chapters c on c.organization_id = o.id
    join public.chapter_union_org_bindings b on b.chapter_id = c.id
    join public.union_orgs bound on bound.id = b.union_org_id
    join public.union_orgs target on target.id = p_registry_id
    where o.id = p_organization_id and o.is_fictional and target.is_fictional
      and (bound.id = target.id or bound.parent_olms_file_number = target.olms_file_number)
  );
$function$;
revoke all on function private.organization_owns_fictional_registry(uuid, text) from public, anon, authenticated, service_role;

create function private.member_can_read_fictional_registry(p_registry_id text)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (select 1 from public.organization_memberships m
    where m.user_id = (select auth.uid()) and m.status = 'active'
      and private.organization_owns_fictional_registry(m.organization_id, p_registry_id));
$function$;
revoke all on function private.member_can_read_fictional_registry(text) from public, anon, authenticated, service_role;
grant execute on function private.member_can_read_fictional_registry(text) to anon, authenticated;

-- Catalog-to-registry links are optional. Preserve unlinked public-record
-- identities, but never expose a catalog alias of a flagged registry row.
create function private.catalog_registry_identity_visible(p_registry_id text)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select not exists (select 1 from public.union_orgs u
    where u.id = p_registry_id and u.is_fictional)
    or private.member_can_read_fictional_registry(p_registry_id);
$function$;
revoke all on function private.catalog_registry_identity_visible(text) from public, anon, authenticated, service_role;


-- Every organization created under a pre-marked id (Tamarack) inherits the
-- flag. The role-play founder writes its ledger mark later in the same
-- transaction; the ledger trigger below covers that ordering too.
create function private.keep_organization_fictional()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and old.is_fictional then new.is_fictional := true; end if;
  if exists (select 1 from private.bot_production_marks m
      where m.kind = 'organization' and m.record_id = new.id::text) then
    new.is_fictional := true;
  end if;
  return new;
end;
$function$;
revoke all on function private.keep_organization_fictional() from public, anon, authenticated, service_role;
create trigger keep_organization_fictional before insert or update on public.organizations
  for each row execute function private.keep_organization_fictional();

-- The ledger trigger writes organizations, a message/case graph parent.
-- Enter the shared protocol before the ledger statement takes any row locks.
create trigger a00_case_graph_lock before insert or update or delete on private.bot_production_marks
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.bot_production_marks
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger message_lifecycle_statement before insert or update or delete on private.bot_production_marks
for each statement execute function private.lock_message_lifecycle_statement();
-- Founder marking and its automation caller become messaging trigger hosts.
create trigger message_lifecycle_statement before insert or update or delete on public.organization_audit_ledger
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before insert or update or delete on public.organization_automation_settings
for each statement execute function private.lock_message_lifecycle_statement();

-- Previous definition: 20261017062000_bot_production_marker_ledger.sql
create or replace function private.bot_production_mark_row(p_kind text, p_record_id text, p_kit text, p_run_id text)
returns void language plpgsql volatile security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
insert into private.bot_production_marks (kind, record_id, kit, run_id)
  values (p_kind, p_record_id, p_kit, p_run_id)
  on conflict (kind, record_id) do update
    set removed_at = null
    where private.bot_production_marks.removed_at is not null;
end;
$function$;

-- Previous definition: 20261017062000_bot_production_marker_ledger.sql
create or replace function private.bot_production_mark_founder_invitation()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  founder private.bot_production_marks%rowtype;
begin
  if new.idempotency_key is null or new.event_type <> 'organization_founder_invited' then
    return null;
  end if;
  select * into founder from private.bot_production_marks m
   where m.kind = 'founder_key' and m.record_id = new.idempotency_key::text;
  if not found then
    return null;
  end if;
  perform private.bot_production_mark_row('founder_key', founder.record_id, founder.kit, founder.run_id);
  perform private.bot_production_mark_row('organization', new.organization_id::text, founder.kit, founder.run_id);
  if new.metadata ->> 'chapterId' is not null then
    perform private.bot_production_mark_row('chapter', new.metadata ->> 'chapterId', founder.kit, founder.run_id);
  end if;
  if new.metadata ->> 'entityId' is not null then
    perform private.bot_production_mark_row('invitation', new.metadata ->> 'entityId', founder.kit, founder.run_id);
  end if;
  return null;
end;
end;
$function$;

-- Previous definition: 20261017062000_bot_production_marker_ledger.sql
create or replace function private.bot_production_mark_chapter()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  parent private.bot_production_marks%rowtype;
begin
  if new.organization_id is null then
    return null;
  end if;
  select * into parent from private.bot_production_marks m
   where m.kind = 'organization' and m.record_id = new.organization_id::text and m.removed_at is null;
  if found then
    perform private.bot_production_mark_row('chapter', new.id, parent.kit, parent.run_id);
  end if;
  return null;
end;
end;
$function$;

-- Previous definition: 20261017062000_bot_production_marker_ledger.sql
create or replace function private.bot_production_mark_invitation()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  parent private.bot_production_marks%rowtype;
begin
  select * into parent from private.bot_production_marks m
   where m.kind = 'invitation' and m.record_id = new.id::text and m.removed_at is null;
  if not found then
    select * into parent from private.bot_production_marks m
     where m.kind = 'chapter' and m.record_id = new.chapter_id and m.removed_at is null;
    if not found then
      return null;
    end if;
    perform private.bot_production_mark_row('invitation', new.id::text, parent.kit, parent.run_id);
  end if;
  if new.auth_user_id is not null then
    perform private.bot_production_mark_row('auth_user', new.auth_user_id::text, parent.kit, parent.run_id);
  end if;
  return null;
end;
end;
$function$;

-- Previous definition: 20261017062000_bot_production_marker_ledger.sql
create or replace function private.bot_production_mark_staged_account()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  parent private.bot_production_marks%rowtype;
begin
  if new.raw_user_meta_data ->> 'union_base_invitation_id' is null then
    return null;
  end if;
  select * into parent from private.bot_production_marks m
   where m.kind = 'invitation' and m.record_id = new.raw_user_meta_data ->> 'union_base_invitation_id'
     and m.removed_at is null;
  if found then
    perform private.bot_production_mark_row('auth_user', new.id::text, parent.kit, parent.run_id);
  end if;
  return null;
end;
end;
$function$;

-- Previous definition: 20261017062000_bot_production_marker_ledger.sql
create or replace function private.bot_production_reopen()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
begin
  update private.bot_production_marks m set removed_at = null
   where m.kind = tg_argv[0] and m.record_id = new.id::text and m.removed_at is not null;
  return null;
end;
end;
$function$;

-- Previous definition: 20261017062000_bot_production_marker_ledger.sql
create or replace function public.bot_production_mark(p_kind text, p_record_ids text[], p_kit text, p_run_id text)
returns integer language plpgsql volatile security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  marked integer := 0;
  v_id text;
begin
  if p_kind is distinct from 'founder_key' then
    raise exception 'bot_production_mark accepts founder_key only' using errcode = '22023';
  end if;
  if p_record_ids is null or pg_catalog.cardinality(p_record_ids) = 0 or pg_catalog.cardinality(p_record_ids) > 200 then
    raise exception 'bot_production_mark needs 1 to 200 ids' using errcode = '22023';
  end if;
  foreach v_id in array p_record_ids loop
    if v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'bot_production_mark ids must be UUIDs' using errcode = '22023';
    end if;
    if exists (select 1 from public.organization_audit_ledger l where l.idempotency_key::text = pg_catalog.lower(v_id)) then
      -- A retry of this kit's own create (its response was lost) replays
      -- through the founder RPC; any other used key is refused.
      if exists (select 1 from private.bot_production_marks m
                  where m.kind = 'founder_key' and m.record_id = pg_catalog.lower(v_id)
                    and m.kit = p_kit and m.run_id = p_run_id) then
        marked := marked + 1;
        continue;
      end if;
      raise exception 'bot_production_mark refuses a key that has already been used' using errcode = '22023';
    end if;
    perform private.bot_production_mark_row(p_kind, pg_catalog.lower(v_id), p_kit, p_run_id);
    marked := marked + 1;
  end loop;
  return marked;
end;
end;
$function$;

create function private.mark_fictional_organization_from_bot_ledger()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  if new.kind = 'organization' then
    update public.organizations set is_fictional = true
    where id::text = new.record_id and not is_fictional;
  end if;
  return null;
end;
$function$;
revoke all on function private.mark_fictional_organization_from_bot_ledger() from public, anon, authenticated, service_role;
create trigger mark_fictional_organization_from_bot_ledger
  after insert or update on private.bot_production_marks
  for each row execute function private.mark_fictional_organization_from_bot_ledger();

create function private.keep_registry_fictional()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and old.is_fictional then new.is_fictional := true; end if;
  if new.atlas_manifest_sha = 'tamarack-fixture-v1' then new.is_fictional := true; end if;
  return new;
end;
$function$;
revoke all on function private.keep_registry_fictional() from public, anon, authenticated, service_role;
create trigger keep_registry_fictional before insert or update on public.union_orgs
  for each row execute function private.keep_registry_fictional();

-- Direct PostgREST registry search/detail/hierarchy reads share this boundary.
-- Restrictive composes with the existing public-read and MFA policies.
create policy union_orgs_exclude_fictional on public.union_orgs
  as restrictive for select to anon, authenticated
  using (not is_fictional or private.member_can_read_fictional_registry(id));
comment on policy union_orgs_exclude_fictional on public.union_orgs is
  'Exclude fictional registry rows from public and unrelated-tenant reads; authenticated active members retain their own bound identities and parent filing.';


-- Previous definition: 20260925620500_public_site_content_organization_quarantine.sql
create or replace function public.get_public_site_content(p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  wanted_locale text := case when p_locale = 'es' then 'es' else 'en' end;
  result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(c.item order by c.sort_order, c.published_at desc, c.id)
      from (
        select
          r.id,
          r.sort_order,
          r.published_at,
          pg_catalog.jsonb_build_object(
            'id', r.id,
            'title', case when wanted_locale = 'es' then r.title_es else r.title_en end,
            'body', case when wanted_locale = 'es' then r.body_es else r.body_en end,
            'region', case when wanted_locale = 'es' then r.region_es else r.region_en end,
            'url', r.url
          ) as item
        from public.public_site_records r
        where r.is_published
          and r.kind = 'chapter'
          and r.organization_id is not null
          and private.organization_visible_in_directory(r.organization_id)
        order by r.sort_order, r.published_at desc, r.id
        limit 12
      ) c
    ), '[]'::jsonb),
    'wins', coalesce((
      select pg_catalog.jsonb_agg(w.item order by w.sort_order, w.occurred_on desc, w.id)
      from (
        select
          r.id,
          r.sort_order,
          r.occurred_on,
          pg_catalog.jsonb_build_object(
            'id', r.id,
            'title', case when wanted_locale = 'es' then r.title_es else r.title_en end,
            'body', case when wanted_locale = 'es' then r.body_es else r.body_en end,
            'occurredOn', r.occurred_on,
            'url', r.url
          ) as item
        from public.public_site_records r
        where r.is_published
          and r.kind = 'win'
          and r.organization_id is not null
          and private.organization_visible_in_directory(r.organization_id)
        order by r.sort_order, r.occurred_on desc, r.id
        limit 12
      ) w
    ), '[]'::jsonb),
    'meetings', coalesce((
      select pg_catalog.jsonb_agg(m.item order by m.starts_at, m.sort_order, m.id)
      from (
        select
          r.id,
          r.starts_at,
          r.sort_order,
          pg_catalog.jsonb_build_object(
            'id', r.id,
            'title', case when wanted_locale = 'es' then r.title_es else r.title_en end,
            'body', case when wanted_locale = 'es' then r.body_es else r.body_en end,
            'startsAt', r.starts_at,
            'endsAt', r.ends_at,
            'location', case when wanted_locale = 'es' then r.location_es else r.location_en end,
            'url', r.url
          ) as item
        from public.public_site_records r
        where r.is_published
          and r.kind = 'meeting'
          and r.organization_id is not null
          and private.organization_visible_in_directory(r.organization_id)
          and coalesce(r.ends_at, r.starts_at + interval '2 hours') >= now()
        order by r.starts_at, r.sort_order, r.id
        limit 12
      ) m
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

-- Previous definition: 20260924150200_public_directory_upcoming_events_window.sql
create or replace function public.get_public_directory(p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  wanted text := case when p_locale = 'es' then 'es' else 'en' end;
begin
  return pg_catalog.jsonb_build_object(
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id,
        'title', case when wanted = 'es' then r.title_es else r.title_en end,
        'body', case when wanted = 'es' then r.body_es else r.body_en end,
        'region', case when wanted = 'es' then r.region_es else r.region_en end,
        'url', r.url,
        'sections', '[]'::jsonb
      ) order by r.sort_order, r.published_at desc, r.id)
      from public.public_site_records r
      where r.is_published
        and r.kind = 'chapter'
        and r.organization_id is not null
          and private.organization_visible_in_directory(r.organization_id)
    ), '[]'::jsonb),
    'events', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.starts_at, item.sort_order, item.id)
      from (
        select
          r.id,
          r.starts_at,
          r.sort_order,
          pg_catalog.jsonb_build_object(
            'id', r.id,
            'title', case when wanted = 'es' then r.title_es else r.title_en end,
            'body', case when wanted = 'es' then r.body_es else r.body_en end,
            'startsAt', r.starts_at,
            'endsAt', r.ends_at,
            'location', case when wanted = 'es' then r.location_es else r.location_en end,
            'url', r.url,
            'chapterCode', r.chapter_code,
            'category', 'meeting'
          ) as payload
        from public.public_site_records r
        where r.is_published
          and r.kind = 'meeting'
          and r.organization_id is not null
          and private.organization_visible_in_directory(r.organization_id)
          and coalesce(r.ends_at, r.starts_at + interval '2 hours') >= pg_catalog.now()
        order by r.starts_at, r.sort_order, r.id
        limit 12
      ) item
    ), '[]'::jsonb)
  );
end;
$function$;

-- Previous definition: 20260822020000_mi1_w1_feature_persistence.sql
create or replace function public.get_public_event_detail(p_event_id text, p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  wanted text := case when p_locale = 'es' then 'es' else 'en' end;
  result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'id', r.id,
    'title', case when wanted = 'es' then r.title_es else r.title_en end,
    'body', case when wanted = 'es' then r.body_es else r.body_en end,
    'startsAt', r.starts_at,
    'endsAt', r.ends_at,
    'location', case when wanted = 'es' then r.location_es else r.location_en end,
    'url', r.url,
    'chapterCode', r.chapter_code,
    'category', 'meeting'
  ) into result
  from public.public_site_records r
  where r.id = p_event_id
    and r.is_published
    and r.kind = 'meeting'
    and r.organization_id is not null
          and private.organization_visible_in_directory(r.organization_id);
  return result;
end;
$function$;

-- Previous definition: 20260924150000_public_chapter_microsite_upcoming_events.sql
create or replace function public.get_public_chapter_microsite(
  p_chapter_code text,
  p_locale text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  wanted text := case when p_locale = 'es' then 'es' else 'en' end;
  chapter jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'id', record.id,
    'title', case when wanted = 'es' then record.title_es else record.title_en end,
    'body', case when wanted = 'es' then record.body_es else record.body_en end,
    'region', case when wanted = 'es' then record.region_es else record.region_en end,
    'url', record.url,
    'sections', coalesce((
      select pg_catalog.jsonb_agg(section_item.item order by section_item.sort_order, section_item.slug)
      from (
        select section.sort_order, section.slug,
          pg_catalog.jsonb_build_object(
            'id', section.slug,
            'title', case when wanted = 'es' then section.title_es else section.title_en end,
            'body', case when wanted = 'es' then section.body_es else section.body_en end,
            'pages', coalesce((
              select pg_catalog.jsonb_agg(page_item.item order by page_item.sort_order, page_item.slug)
              from (
                select page.sort_order, page.slug,
                  pg_catalog.jsonb_build_object(
                    'id', page.slug,
                    'title', case when wanted = 'es' then page.title_es else page.title_en end,
                    'body', case when wanted = 'es' then page.body_es else page.body_en end,
                    'attachments', coalesce((
                      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'id', attachment.id,
                        'label', attachment.label,
                        'title', document.title,
                        'summary', document.summary,
                        'documentType', document.document_type,
                        'sourceUrl', case
                          when document.source_url ~ '^https://[^[:space:]]+$'
                            then document.source_url
                          else null
                        end
                      ) order by attachment.attached_at, attachment.id)
                      from public.public_chapter_page_attachments attachment
                      join public.chapter_documents document
                        on document.id = attachment.chapter_document_id
                      where attachment.organization_id = page.organization_id
                        and attachment.chapter_code = page.chapter_code
                        and attachment.section_slug = page.section_slug
                        and attachment.page_slug = page.slug
                        and document.status = 'published'
                        and document.visibility = 'chapter'
                    ), '[]'::jsonb)
                  ) as item
                from public.public_chapter_pages page
                where page.organization_id = section.organization_id
                  and page.chapter_code = section.chapter_code
                  and page.section_slug = section.slug
                  and page.is_published
                order by page.sort_order, page.slug
                limit 24
              ) page_item
            ), '[]'::jsonb)
          ) as item
        from public.public_chapter_sections section
        where section.organization_id = record.organization_id
          and section.chapter_code = record.id
          and section.is_published
        order by section.sort_order, section.slug
        limit 24
      ) section_item
    ), '[]'::jsonb),
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', event.id,
        'title', case when wanted = 'es' then event.title_es else event.title_en end,
        'body', case when wanted = 'es' then event.body_es else event.body_en end,
        'startsAt', event.starts_at,
        'endsAt', event.ends_at,
        'location', case when wanted = 'es' then event.location_es else event.location_en end,
        'url', event.url,
        'chapterCode', event.chapter_code,
        'category', 'meeting'
      ) order by event.starts_at, event.id)
      from (
        (
          select source.*
          from public.public_site_records source
          where source.is_published and source.kind = 'meeting'
            and source.organization_id = record.organization_id
            and source.chapter_code = record.id
            and coalesce(source.ends_at, source.starts_at) >= pg_catalog.now()
          order by source.starts_at, source.id
          limit 100
        )
        union all
        (
          select source.*
          from public.public_site_records source
          where source.is_published and source.kind = 'meeting'
            and source.organization_id = record.organization_id
            and source.chapter_code = record.id
            and coalesce(source.ends_at, source.starts_at) < pg_catalog.now()
          order by source.starts_at desc, source.id desc
          limit 12
        )
      ) event
    ), '[]'::jsonb)
  ) into chapter
  from public.public_site_records record
  where record.id = p_chapter_code
    and record.is_published and record.kind = 'chapter'
    and record.organization_id is not null
          and private.organization_visible_in_directory(record.organization_id);
  return chapter;
end;
$function$;

-- Previous definition: 20260930040000_union_catalog_claims_verification.sql
create or replace function public.get_organization_public_verification(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  organization public.organizations%rowtype;
  placement private.organization_catalog_placements%rowtype;
  identity jsonb;
  parent jsonb;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    return pg_catalog.jsonb_build_object('found', false);
  end if;
  select * into organization
    from public.organizations as o
   where o.slug = p_slug
     and o.status = 'active'
     and private.organization_visible_in_directory(o.id);
  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  select * into placement
    from private.organization_catalog_placements as p
   where p.organization_id = organization.id;
  if found and placement.verified_at is not null
     and (placement.identity_catalog_key is null or exists (select 1 from private.catalog_organizations o
       where o.catalog_key = placement.identity_catalog_key and private.catalog_registry_identity_visible(o.union_org_id))) then
    identity := case
      when placement.identity_catalog_key is not null then pg_catalog.jsonb_build_object(
        'kind', 'catalog',
        'catalogKey', placement.identity_catalog_key,
        'name', (select o.name from private.catalog_organizations as o
                  where o.catalog_key = placement.identity_catalog_key))
      else pg_catalog.jsonb_build_object('kind', 'unlisted') end;
  end if;
  if found and placement.parent_catalog_key is not null
     and exists (select 1 from private.catalog_organizations o where o.catalog_key = placement.parent_catalog_key
       and private.catalog_registry_identity_visible(o.union_org_id)) then
    parent := pg_catalog.jsonb_build_object(
      'kind', 'catalog',
      'catalogKey', placement.parent_catalog_key,
      'name', (select o.name from private.catalog_organizations as o
                where o.catalog_key = placement.parent_catalog_key),
      'selfReported', true);
  elsif found and placement.unlisted_parent_name is not null then
    parent := pg_catalog.jsonb_build_object('kind', 'unlisted', 'selfReported', true);
  end if;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'organization', pg_catalog.jsonb_build_object('name', organization.name, 'slug', organization.slug),
    'verification', pg_catalog.jsonb_build_object(
      'status', case when identity is not null then 'verified' else 'self_reported' end,
      'identity', identity,
      'verifiedOn', case when identity is not null then (placement.verified_at at time zone 'America/New_York')::date end),
    'placement', parent
  );
end;
$function$;

-- Previous definition: 20260930040200_self_serve_organization_shell.sql
create or replace function private.organization_network_can_discover(p_subject_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_subject_organization_id is not null
    and private.current_member_organization() is not null
    and (
      p_subject_organization_id = (select private.current_member_organization())
      or (
        private.organization_clears_signup_boundary((select private.current_member_organization()))
        and private.organization_visible_in_directory(p_subject_organization_id)
        and (
          exists (
            select 1
            from public.organization_network_directory_profiles p
            where p.organization_id = p_subject_organization_id
              and p.visibility = 'directory'
          )
          or private.organization_network_has_permission(
            (select private.current_member_organization()),
            p_subject_organization_id,
            'directory_contact'
          )
        )
      )
    );
$function$;

-- Previous definition: 20260930040200_self_serve_organization_shell.sql
create or replace function public.list_chapter_connection_profiles(
  p_selected_hat text,
  p_after_id text default null,
  p_limit integer default 250,
  p_snapshot_token text default null,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  viewer_chapter text;
  cap integer;
  current_epoch bigint;
  token_epoch bigint;
  snapshot_at timestamptz;
  token text;
  scope_hash text;
  after_id text;
  rows_out jsonb;
  fetched integer;
  last_id text;
begin
  org := private.mi1_require_selected_organization();
  viewer_chapter := private.chapter_connection_require_chapter(org, coalesce(nullif(pg_catalog.btrim(p_chapter_id), ''), private.current_member_chapter()));
  perform private.chapter_connection_require_hat(
    org, p_selected_hat, viewer_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']);

  scope_hash := pg_catalog.md5(org::text || ':' || viewer_chapter || ':' || p_selected_hat);

  cap := least(greatest(coalesce(p_limit, 250), 1), 500);
  after_id := nullif(pg_catalog.btrim(coalesce(p_after_id, '')), '');

  select e.epoch into current_epoch from private.chapter_connection_registry_epoch e where e.singleton;
  current_epoch := coalesce(current_epoch, 1);

  if p_snapshot_token is null then
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.now()))::double precision);
  else
    if p_snapshot_token !~ '^[0-9]{1,18}:[0-9]{1,12}:[a-f0-9]{32}$' then
      raise exception 'connection registry snapshot token invalid' using errcode = '22023';
    end if;
    token_epoch := pg_catalog.split_part(p_snapshot_token, ':', 1)::bigint;
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.split_part(p_snapshot_token, ':', 2)::double precision);
    if pg_catalog.split_part(p_snapshot_token, ':', 3) <> scope_hash then
      raise exception 'connection registry snapshot scope changed' using errcode = '22023';
    end if;
    if token_epoch <> current_epoch then
      raise exception 'connection registry snapshot changed' using errcode = '22023';
    end if;
    if snapshot_at > pg_catalog.now() + interval '1 minute'
       or snapshot_at < pg_catalog.now() - interval '1 hour' then
      raise exception 'connection registry snapshot expired' using errcode = '22023';
    end if;
  end if;
  token := current_epoch::text || ':' || pg_catalog.floor(extract(epoch from snapshot_at))::bigint::text || ':' || scope_hash;

  select
    coalesce(pg_catalog.jsonb_agg(page.item order by page.chapter_id collate "C"), '[]'::jsonb),
    pg_catalog.count(*)::integer,
    pg_catalog.max(page.chapter_id collate "C")
  into rows_out, fetched, last_id
  from (
    select
      p.chapter_id,
      private.chapter_connection_profile_projection(p, c.name) as item
    from private.chapter_connection_profiles p
    join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
    join public.organizations o on o.id = p.organization_id and o.status = 'active'
    where p.publication_status = 'published'
      and (p.organization_id = org or private.organization_visible_in_directory(p.organization_id))
      and p.expires_at > snapshot_at
      and p.chapter_id <> viewer_chapter
      and private.organization_clears_signup_boundary(org)
      and (after_id is null or p.chapter_id collate "C" > after_id collate "C")
      and not exists (
        select 1 from private.chapter_connection_hides h
        where (h.chapter_id = viewer_chapter and h.hidden_chapter_id = p.chapter_id)
           or (h.chapter_id = p.chapter_id and h.hidden_chapter_id = viewer_chapter)
      )
    order by p.chapter_id collate "C"
    limit cap + 1
  ) page;

  if fetched > cap then
    -- Drop the look-ahead row: the page is the first cap rows in order.
    rows_out := (
      select coalesce(pg_catalog.jsonb_agg(elem.value order by elem.ordinality), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(rows_out) with ordinality as elem
      where elem.ordinality <= cap
    );
    last_id := rows_out -> (cap - 1) ->> 'id';
  end if;

  return pg_catalog.jsonb_build_object(
    'snapshotToken', token,
    'snapshotAt', snapshot_at,
    'rows', rows_out,
    'nextCursor', case when fetched > cap then last_id else null end,
    'complete', fetched <= cap
  );
end;
$function$;

-- Previous definition: 20260925950000_union_catalog_reference_foundation.sql
create or replace function public.search_union_catalog(
  p_query text,
  p_state text,
  p_family text,
  p_tier text,
  p_page integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  query_text text := nullif(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')), '');
  state_filter text := nullif(p_state, '');
  family_filter text := nullif(pg_catalog.btrim(coalesce(p_family, '')), '');
  tier_filter text := nullif(p_tier, '');
  registry_level text;
  number_match text[];
  local_number_filter text;
  text_part text;
  pattern text;
  full_pattern text;
  catalog_live boolean;
  match_count bigint;
  page_rows jsonb;
begin
  if p_query ~ '[[:cntrl:]]' then
    raise exception 'invalid catalog search query' using errcode = '22023';
  end if;
  if query_text is not null and pg_catalog.char_length(query_text) not between 2 and 80 then
    raise exception 'catalog search query must be 2 to 80 characters' using errcode = '22023';
  end if;
  if state_filter is not null and state_filter !~ '^[A-Z]{2}$' then
    raise exception 'invalid catalog search state' using errcode = '22023';
  end if;
  if query_text is null and state_filter is null then
    raise exception 'catalog search needs a query or a state' using errcode = '22023';
  end if;
  if p_family ~ '[[:cntrl:]]' or pg_catalog.char_length(family_filter) > 40 then
    raise exception 'invalid catalog search family' using errcode = '22023';
  end if;
  if tier_filter is not null and tier_filter not in ('national', 'regional', 'state', 'local', 'sub_local') then
    raise exception 'invalid catalog search tier' using errcode = '22023';
  end if;
  if p_page is null or p_page not between 1 and 40 then
    raise exception 'invalid catalog search page' using errcode = '22023';
  end if;

  registry_level := case tier_filter
    when 'national' then 'national'
    when 'regional' then 'intermediate'
    when 'state' then 'intermediate'
    when 'local' then 'local'
    when 'sub_local' then 'local'
  end;

  -- The Phase 1 reading of a query: "Local 600", "lu 12 boston" or a bare
  -- number names a local number; the remaining text (two characters or more)
  -- matches a name, a city or the catalog search text.
  if query_text is not null then
    number_match := pg_catalog.regexp_match(query_text, '^#?([0-9]{1,7})$');
    if number_match is not null then
      local_number_filter := (number_match[1])::integer::text;
    else
      number_match := pg_catalog.regexp_match(query_text,
        '(^|\s)(local|lu|lodge|branch|br|chapter|ch|division|div)\s*#?\s*([0-9]{1,7})(?=\s|$)', 'i');
      if number_match is not null then
        local_number_filter := (number_match[3])::integer::text;
        text_part := pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(query_text,
          '(^|\s)(local|lu|lodge|branch|br|chapter|ch|division|div)\s*#?\s*([0-9]{1,7})(?=\s|$)', ' ', 'i'), '\s+', ' ', 'g'));
        full_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(query_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
      else
        text_part := query_text;
      end if;
    end if;
    if pg_catalog.char_length(text_part) >= 2 then
      pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(text_part, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    end if;
  end if;

  catalog_live := exists (select 1 from private.catalog_releases as r where r.status = 'active');

  with matches as (
    select 0 as source_rank, o.name as sort_name, o.catalog_key as sort_key, null::text as registry_parent,
      pg_catalog.jsonb_build_object(
        'key', o.catalog_key,
        'registryOnly', false,
        'name', o.name,
        'family', o.family,
        'designation', o.designation,
        'localNumber', o.local_number,
        'tier', o.tier,
        'level', case o.tier when 'national' then 'national' when 'regional' then 'intermediate'
                   when 'state' then 'intermediate' else 'local' end,
        'city', o.city,
        'state', o.state,
        'website', o.website,
        'membersReported', o.members_reported,
        'membersFiscalYear', o.members_fiscal_year,
        'registryId', o.union_org_id
      ) as payload
      from private.catalog_organizations as o
     where catalog_live
       and o.retired_release_id is null
       and o.duplicate_of is null
       and private.catalog_registry_identity_visible(o.union_org_id)
       and (local_number_filter is null or o.local_number = local_number_filter
            or (full_pattern is not null and o.name ilike full_pattern escape '\'))
       and (pattern is null or o.name ilike pattern escape '\' or o.city ilike pattern escape '\'
            or o.search_text ilike pattern escape '\')
       and (state_filter is null or o.state = state_filter)
       and (family_filter is null or o.family = family_filter)
       and (tier_filter is null or o.tier = tier_filter)
    union all
    select 1 as source_rank, u.name as sort_name, u.id as sort_key, u.parent_name as registry_parent,
      pg_catalog.jsonb_build_object(
        'key', u.id,
        'registryOnly', true,
        'name', u.name,
        'family', u.affiliation,
        'designation', u.designation,
        'localNumber', u.local_number,
        'tier', null,
        'level', u.level,
        'city', u.city,
        'state', u.state,
        'website', u.website,
        'membersReported', u.members_latest,
        'membersFiscalYear', u.members_latest_year,
        'registryId', u.id
      ) as payload
      from public.union_orgs as u
     where not u.is_fictional
       and (local_number_filter is null or u.local_number = local_number_filter
            or (full_pattern is not null and u.name ilike full_pattern escape '\'))
       and (pattern is null or u.name ilike pattern escape '\' or u.city ilike pattern escape '\'
            or u.affiliation ilike pattern escape '\')
       and (state_filter is null or u.state = state_filter)
       and (family_filter is null or u.affiliation = family_filter)
       and (registry_level is null or u.level = registry_level)
       and (not catalog_live or not exists (
             select 1 from private.catalog_organizations as c
              where c.olms_file_number = u.olms_file_number and c.retired_release_id is null
                and private.catalog_registry_identity_visible(c.union_org_id)))
  )
  select
    (select pg_catalog.count(*) from (select 1 from matches limit 1001) as capped),
    coalesce((
      select pg_catalog.jsonb_agg(
               -- The "Part of" line. A catalog row: the highest-ranked live
               -- edge that still names something visible, that is its
               -- visible parent (an edge to a retired or duplicate
               -- organization is skipped, as in the profile) or else its
               -- scrubbed label (a label-only edge whose label is scrubbed is
               -- skipped, so a lower-ranked visible parent wins); null when
               -- no edge qualifies. A registry row: the registry's own
               -- parent name, scrubbed the same way.
               page.payload || pg_catalog.jsonb_build_object('parentName', case when page.source_rank = 0 then (
                 select coalesce(parent.name, private.catalog_scrub_text(e.parent_label))
                   from private.catalog_edges as e
                   left join private.catalog_organizations as parent
                     on parent.catalog_key = e.parent_key
                    and parent.retired_release_id is null
                    and parent.duplicate_of is null
                    and private.catalog_registry_identity_visible(parent.union_org_id)
                  where e.child_key = page.sort_key
                    and e.retired_release_id is null
                    and (e.parent_key is null or parent.catalog_key is not null)
                    and coalesce(parent.name, private.catalog_scrub_text(e.parent_label)) is not null
                  order by case e.edge_kind when 'olms_parent' then 0 when 'parent_body' then 1 else 2 end, e.edge_key
                  limit 1
               ) else private.catalog_scrub_text(page.registry_parent) end)
               order by page.source_rank, page.sort_name, page.sort_key)
        from (
          select m.source_rank, m.sort_name, m.sort_key, m.registry_parent, m.payload
            from matches as m
           order by m.source_rank, m.sort_name, m.sort_key
           limit 25 offset (p_page - 1) * 25
        ) as page
    ), '[]'::jsonb)
    into match_count, page_rows;

  return pg_catalog.jsonb_build_object(
    'rows', page_rows,
    'page', p_page,
    'pageSize', 25,
    'total', least(match_count, 1000),
    'totalCapped', match_count > 1000,
    'hasNext', p_page < 40 and p_page * 25 < least(match_count, 1000)
  );
end;
$function$;

-- Previous definition: 20260925950000_union_catalog_reference_foundation.sql
create or replace function public.get_union_catalog_profile(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  organization jsonb;
begin
  if p_key is null or p_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
    raise exception 'invalid catalog key' using errcode = '22023';
  end if;

  -- Unknown, retired and duplicate keys, and every key while no release is
  -- active, get the same answer.
  select pg_catalog.jsonb_build_object(
      'key', o.catalog_key,
      'olmsFileNumber', o.olms_file_number,
      'registryId', o.union_org_id,
      'origin', o.origin,
      'name', o.name,
      'aka', o.aka,
      'family', o.family,
      'designation', o.designation,
      'localNumber', o.local_number,
      'tier', o.tier,
      'level', case o.tier when 'national' then 'national' when 'regional' then 'intermediate'
                 when 'state' then 'intermediate' else 'local' end,
      'orgTypeLabel', o.org_type_label,
      'sector', o.sector,
      'industries', o.industries,
      'occupations', o.occupations,
      'trades', o.trades,
      'city', o.city,
      'state', o.state,
      'zip5', o.zip5,
      'censusRegion', o.census_region,
      'censusDivision', o.census_division,
      'latitude', o.latitude,
      'longitude', o.longitude,
      'geoPrecision', o.geo_precision,
      'website', o.website,
      'membersReported', o.members_reported,
      'membersFiscalYear', o.members_fiscal_year,
      'structureNote', private.catalog_scrub_text(o.structure_note),
      'electionTermYears', o.election_term_years,
      'nextElectionOn', o.next_election_on,
      'bylawsUrl', o.bylaws_url,
      'confidence', o.confidence,
      'researchedOn', o.researched_on,
      'sourceUrls', o.source_urls
    )
    into organization
    from private.catalog_organizations as o
   where o.catalog_key = p_key
     and o.retired_release_id is null
     and o.duplicate_of is null
     and private.catalog_registry_identity_visible(o.union_org_id)
     and exists (select 1 from private.catalog_releases as r where r.status = 'active');
  if organization is null then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'organization', organization,
    'parents', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.depth, item.edge_kind, item.edge_key)
        from (
          select walked.depth, walked.edge_kind, walked.edge_key,
            pg_catalog.jsonb_build_object(
              'depth', walked.depth,
              'childKey', walked.child_key,
              'parentKey', parent.catalog_key,
              'parentName', parent.name,
              'parentLabel', private.catalog_scrub_text(walked.parent_label),
              'edgeKind', walked.edge_kind,
              'certainty', walked.certainty,
              'sourceUrl', walked.source_url
            ) as payload
            from (
              with recursive chain as (
                select e.edge_key, e.child_key, e.parent_key, e.parent_label, e.edge_kind, e.certainty, e.source_url,
                       1 as depth
                  from private.catalog_edges as e
                 where e.child_key = p_key
                   and e.retired_release_id is null
                union
                select e.edge_key, e.child_key, e.parent_key, e.parent_label, e.edge_kind, e.certainty, e.source_url,
                       chain.depth + 1
                  from chain
                  -- The walk continues only through a visible organization.
                  join private.catalog_organizations as via
                    on via.catalog_key = chain.parent_key
                   and via.retired_release_id is null
                   and via.duplicate_of is null
                   and private.catalog_registry_identity_visible(via.union_org_id)
                  join private.catalog_edges as e on e.child_key = via.catalog_key
                 where chain.depth < 8
                   and e.retired_release_id is null
              )
              select distinct on (chain.edge_key)
                     chain.edge_key, chain.child_key, chain.parent_key, chain.parent_label, chain.edge_kind,
                     chain.certainty, chain.source_url, chain.depth
                from chain
               order by chain.edge_key, chain.depth
            ) as walked
            left join private.catalog_organizations as parent
              on parent.catalog_key = walked.parent_key
             and parent.retired_release_id is null
             and parent.duplicate_of is null
             and private.catalog_registry_identity_visible(parent.union_org_id)
           -- An edge to a retired or duplicate organization is left out, as
           -- that organization's own profile is; a label-only edge stays.
           where walked.parent_key is null or parent.catalog_key is not null
           order by walked.depth, walked.edge_kind, walked.edge_key
           limit 100
        ) as item
    ), '[]'::jsonb),
    'children', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.sort_name, item.edge_key)
        from (
          select child.name as sort_name, e.edge_key,
            pg_catalog.jsonb_build_object(
              'key', child.catalog_key,
              'name', child.name,
              'tier', child.tier,
              'localNumber', child.local_number,
              'city', child.city,
              'state', child.state,
              'edgeKind', e.edge_kind,
              'certainty', e.certainty
            ) as payload
            from private.catalog_edges as e
            join private.catalog_organizations as child on child.catalog_key = e.child_key
           where e.parent_key = p_key
             and e.retired_release_id is null
             and child.retired_release_id is null
             and child.duplicate_of is null
             and private.catalog_registry_identity_visible(child.union_org_id)
           order by child.name, e.edge_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'childrenTotal', (
      select pg_catalog.count(*)
        from private.catalog_edges as e
        join private.catalog_organizations as child on child.catalog_key = e.child_key
       where e.parent_key = p_key
         and e.retired_release_id is null
         and child.retired_release_id is null
         and child.duplicate_of is null
         and private.catalog_registry_identity_visible(child.union_org_id)
    ),
    'subunits', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.kind, item.name, item.subunit_key)
        from (
          select s.kind, s.name, s.subunit_key,
            pg_catalog.jsonb_build_object(
              'key', s.subunit_key,
              'parentKey', s.parent_subunit_key,
              'kind', s.kind,
              'kindLabel', private.catalog_scrub_text(s.kind_label),
              'name', private.catalog_scrub_text(s.name),
              'location', private.catalog_scrub_text(s.location),
              'employer', private.catalog_scrub_text(s.employer),
              'members', s.members,
              'membersSource', private.catalog_scrub_text(s.members_source),
              'densityNote', private.catalog_scrub_text(s.density_note),
              'website', s.website,
              'electionNote', private.catalog_scrub_text(s.election_note),
              'structureNote', private.catalog_scrub_text(s.structure_note),
              'confidence', s.confidence,
              'sourceUrl', s.source_url,
              'asOf', s.as_of
            ) as payload
            from private.catalog_subunits as s
           where s.catalog_key = p_key
             and s.retired_release_id is null
           order by s.kind, s.name, s.subunit_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'seatOutlines', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.scope, item.seat_class, item.outline_key)
        from (
          select coalesce(so.subunit_key, '') as scope, so.seat_class, so.outline_key,
            pg_catalog.jsonb_build_object(
              'key', so.outline_key,
              'subunitKey', so.subunit_key,
              'seatClass', so.seat_class,
              'title', private.catalog_scrub_text(so.title),
              'listed', so.listed,
              'vacant', so.vacant,
              'sourceUrl', so.source_url,
              'asOf', so.as_of
            ) as payload
            from private.catalog_seat_outlines as so
           where so.catalog_key = p_key
             and so.retired_release_id is null
           order by coalesce(so.subunit_key, ''), so.seat_class, so.outline_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'contacts', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.contact_kind, item.contact_key)
        from (
          select c.contact_kind, c.contact_key,
            pg_catalog.jsonb_build_object(
              'kind', c.contact_kind,
              'value', c.value,
              'label', private.catalog_scrub_text(c.label),
              'basis', c.basis,
              'sourceUrl', c.source_url,
              'asOf', c.as_of
            ) as payload
            from private.catalog_contacts as c
           where c.catalog_key = p_key
             and c.retired_release_id is null
           order by c.contact_kind, c.contact_key
           limit 50
        ) as item
    ), '[]'::jsonb),
    'documents', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.doc_kind, item.document_key)
        from (
          select d.doc_kind, d.document_key,
            pg_catalog.jsonb_build_object(
              'key', d.document_key,
              'kind', d.doc_kind,
              'title', private.catalog_scrub_text(d.title),
              'titleDerived', d.title_derived,
              'url', d.url,
              'urlHost', d.url_host,
              'asOf', d.as_of,
              'subunitKeys', coalesce((
                select pg_catalog.jsonb_agg(link.subunit_key order by link.subunit_key)
                  from (
                    select ds.subunit_key
                      from private.catalog_document_subunits as ds
                     where ds.document_key = d.document_key
                       and ds.retired_release_id is null
                     order by ds.subunit_key
                     limit 50
                  ) as link
              ), '[]'::jsonb)
            ) as payload
            from private.catalog_documents as d
           where d.catalog_key = p_key
             and d.retired_release_id is null
           order by d.doc_kind, d.document_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'coverage', (
      select pg_catalog.jsonb_build_object(
          'band', cov.band,
          'checklist', cov.checklist,
          'subunits', cov.subunits,
          'subunitsWithMembers', cov.subunits_with_members,
          'seatOutlines', cov.seat_outlines,
          'documents', cov.documents,
          'demandBand', cov.demand_band,
          'communityVerifiedOn', cov.community_verified_on,
          'lastResearched', cov.last_researched
        )
        from private.catalog_coverage as cov
       where cov.catalog_key = p_key
    )
  );
end;
$function$;

-- Previous definition: 20260930040200_self_serve_organization_shell.sql
create or replace function public.request_chapter_connection_handshake(
  p_selected_hat text,
  p_chapter_id text,
  p_target_chapter_id text,
  p_title text,
  p_purpose text,
  p_data_scope text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  target text;
  partner text;
  registry_epoch bigint;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter,
    array['steward','coordinator','advisor','admin','vp']);
  if chapter is distinct from private.current_member_chapter()
     or not private.member_has_chapter_role(chapter, array[p_selected_hat]) then
    raise exception 'select the source chapter before requesting a handshake' using errcode = '42501';
  end if;
  if p_idempotency_key is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title,''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose,''))) not between 1 and 4000
     or p_data_scope is null or p_data_scope not in ('docs_only','no_member_data','aggregate_only') then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  target := nullif(pg_catalog.btrim(coalesce(p_target_chapter_id, '')), '');
  if target is null or target = chapter then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  -- An unverified self-created organization cannot hand-shake: it gets the
  -- legacy not-onboarded answer before any published profile or registry
  -- binding is read, so the answer never depends on the target.
  if not private.organization_clears_signup_boundary(org) then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;

  -- Serialize retries before taking the registry lock. The legacy event's
  -- globally unique key remains the durable idempotency authority.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key::text, 509281));
  -- Every eligibility dependency advances this row in the existing registry
  -- triggers. SHARE prevents a withdrawal/hide/rebind/quarantine from
  -- committing between the following fresh read and the legacy request.
  -- Do not take target-row locks: registry writers lock those before epoch.
  select e.epoch into registry_epoch
  from private.chapter_connection_registry_epoch e where e.singleton for share;
  if registry_epoch is null then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  select b.union_org_id into partner
  from private.chapter_connection_profiles p
  join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
  join public.organizations o on o.id = p.organization_id and o.status = 'active'
  join public.chapter_union_org_bindings b on b.chapter_id = p.chapter_id and b.status = 'verified'
  join public.union_orgs u on u.id = b.union_org_id
  where p.chapter_id = target
    and p.publication_status = 'published'
    and (c.organization_id = org or private.organization_visible_in_directory(c.organization_id))
    and private.catalog_registry_identity_visible(u.id)
    and p.expires_at > pg_catalog.clock_timestamp()
    and not exists (
      select 1 from private.chapter_connection_hides h
      where (h.chapter_id = chapter and h.hidden_chapter_id = target)
         or (h.chapter_id = target and h.hidden_chapter_id = chapter)
    );
  if partner is null then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  -- union_org_id is UNIQUE in chapter_union_org_bindings. Under the registry
  -- lock the legacy resolver must select this exact receiving chapter.
  return public.request_chapter_handshake(partner, p_title, p_purpose, p_data_scope, p_idempotency_key);
end;
$function$;

-- Previous definition: 20260930040200_self_serve_organization_shell.sql
create or replace function public.request_chapter_handshake(p_partner_org_id text, p_title text, p_purpose text, p_data_scope text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  receiving text;
  created public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
  caller_organization uuid;
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_role(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title,''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose,''))) not between 1 and 4000
     or p_data_scope not in ('docs_only','no_member_data','aggregate_only') then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  -- An unverified self-created organization cannot hand-shake, so it gets
  -- the not-onboarded answer before any registry binding is read: the answer
  -- never depends on whether the partner has a verified binding. A legacy
  -- chapter with no organization keeps its previous behaviour.
  caller_organization := private.current_member_organization();
  if caller_organization is not null
     and not private.organization_clears_signup_boundary(caller_organization) then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;
  select b.chapter_id into receiving
  from public.chapter_union_org_bindings b
  where b.union_org_id = p_partner_org_id and b.status = 'verified'
    and private.catalog_registry_identity_visible(p_partner_org_id)
    and exists (select 1 from public.chapters c where c.id = b.chapter_id
      and (c.organization_id = caller_organization or private.organization_visible_in_directory(c.organization_id)));
  if receiving is null or receiving = chapter then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;
  select * into prior_event from public.chapter_handshake_events e
  where e.idempotency_key = p_idempotency_key;
  if found then
    select h.* into created from public.chapter_handshakes h
    where h.id = prior_event.handshake_id;
    if prior_event.transition <> 'requested' or prior_event.actor <> caller
       or created.chapter_id <> chapter or created.receiving_chapter_id <> receiving
       or created.partner_org_id <> p_partner_org_id
       or created.title <> pg_catalog.btrim(p_title)
       or created.purpose <> pg_catalog.btrim(p_purpose)
       or created.data_scope <> p_data_scope then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(created);
  end if;
  insert into public.chapter_handshakes
    (chapter_id, receiving_chapter_id, partner_org_id, title, purpose, data_scope,
     status, requested_by, requested_at)
  values (chapter, receiving, p_partner_org_id, pg_catalog.btrim(p_title),
    pg_catalog.btrim(p_purpose), p_data_scope, 'requested', caller, pg_catalog.clock_timestamp())
  returning * into created;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (created.id, p_idempotency_key, caller, chapter, 'requested', 'draft', 'requested');
  perform private.notify_handshake_staff(receiving, 'Partnership request received',
    'An authorized chapter sent a two-sided partnership request for review.');
  return pg_catalog.to_jsonb(created);
end;
end;
$function$;

-- Previous definition: 20260925220000_public_event_rsvp_ended_meeting_gate.sql
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
      and coalesce(r.ends_at, r.starts_at) >= now()
      and private.organization_visible_in_directory(r.organization_id);
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

-- Previous definition: 20260925960000_catalog_organization_self_placement.sql
create or replace function private.organization_catalog_parent(p_catalog_key text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  parent jsonb;
begin
  if p_catalog_key is null
     or p_catalog_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$'
     or pg_catalog.to_regclass('private.catalog_organizations') is null
     or pg_catalog.to_regclass('private.catalog_releases') is null then
    return null;
  end if;
  select pg_catalog.jsonb_build_object(
           'name', o.name,
           'active', o.retired_release_id is null
                     and o.duplicate_of is null
                     and exists (select 1 from private.catalog_releases as r where r.status = 'active'))
    into parent
    from private.catalog_organizations as o
   where o.catalog_key = p_catalog_key
     and private.catalog_registry_identity_visible(o.union_org_id);
  return parent;
end;
$function$;

-- Previous definition: 20260930040000_union_catalog_claims_verification.sql
create or replace function public.submit_organization_claim(
  p_scope_hash text,
  p_email_scope_hash text,
  p_catalog_key text,
  p_unlisted jsonb,
  p_claimant jsonb,
  p_attestation jsonb,
  p_locale text,
  p_confirm_token_hash text,
  p_requesting_user_id uuid,
  p_organization_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  moment timestamptz;
  clean_claimant_name text;
  clean_claimant_title text;
  clean_claimant_email text;
  clean_claimant_statement text;
  clean_unlisted_name text;
  clean_unlisted_city text;
  clean_unlisted_state text;
  allowed boolean;
  target_normalized text;
  new_claim_id uuid;
begin
  perform private.lock_case_graph(array[p_requesting_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  moment := clock_timestamp();

  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;
  if p_confirm_token_hash is null or p_confirm_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid confirmation token' using errcode = '22023';
  end if;
  if p_locale is null or p_locale not in ('en', 'es') then
    raise exception 'invalid locale' using errcode = '22023';
  end if;
  if p_attestation is null or p_attestation is distinct from
       '{"version":"claim-attest/1","officer":true,"verifyFirst":true,"noPersonalData":true,"notEmployer":true}'::jsonb then
    raise exception 'attestation required' using errcode = '22023';
  end if;

  -- Exactly one target: a catalog key, or an unlisted organization.
  if pg_catalog.num_nonnulls(p_catalog_key, p_unlisted) <> 1 then
    raise exception 'claim target invalid' using errcode = '22023';
  end if;
  if p_catalog_key is not null and p_catalog_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
    raise exception 'claim target invalid' using errcode = '22023';
  end if;
  if p_unlisted is not null then
    if pg_catalog.jsonb_typeof(p_unlisted) is distinct from 'object'
       or p_unlisted - array['name', 'city', 'state'] <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(p_unlisted -> 'name') is distinct from 'string'
       or (p_unlisted ? 'city' and pg_catalog.jsonb_typeof(p_unlisted -> 'city') not in ('string', 'null'))
       or (p_unlisted ? 'state' and pg_catalog.jsonb_typeof(p_unlisted -> 'state') not in ('string', 'null')) then
      raise exception 'claim target invalid' using errcode = '22023';
    end if;
    clean_unlisted_name := pg_catalog.btrim(p_unlisted ->> 'name');
    clean_unlisted_city := nullif(pg_catalog.btrim(coalesce(p_unlisted ->> 'city', '')), '');
    clean_unlisted_state := nullif(pg_catalog.btrim(coalesce(p_unlisted ->> 'state', '')), '');
    -- The unlisted name is shown to a vouching organization's admins, so it
    -- gets 4a's placement-name filter: no email, link or phone number.
    if pg_catalog.char_length(clean_unlisted_name) not between 3 and 200
       or clean_unlisted_name ~ '[[:cntrl:]]'
       or clean_unlisted_name !~ '[[:alnum:]]'
       or pg_catalog.strpos(clean_unlisted_name, '@') > 0
       or pg_catalog.strpos(clean_unlisted_name, '://') > 0
       or pg_catalog.regexp_replace(clean_unlisted_name, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}'
       or (clean_unlisted_city is not null and (pg_catalog.char_length(clean_unlisted_city) > 120 or clean_unlisted_city ~ '[[:cntrl:]]'
           or pg_catalog.strpos(clean_unlisted_city, '@') > 0
           or pg_catalog.strpos(clean_unlisted_city, '://') > 0
           or pg_catalog.regexp_replace(clean_unlisted_city, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}'))
       or (clean_unlisted_state is not null and clean_unlisted_state !~ '^[A-Z]{2}$') then
      raise exception 'claim target invalid' using errcode = '22023';
    end if;
  end if;

  -- The claimant: exactly name, title, email and statement, all strings.
  if pg_catalog.jsonb_typeof(p_claimant) is distinct from 'object'
     or (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_claimant) as k)
          is distinct from array['email', 'name', 'statement', 'title']
     or pg_catalog.jsonb_typeof(p_claimant -> 'name') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'title') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'email') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'statement') <> 'string' then
    raise exception 'claimant invalid' using errcode = '22023';
  end if;
  clean_claimant_name := pg_catalog.btrim(p_claimant ->> 'name');
  clean_claimant_title := pg_catalog.btrim(p_claimant ->> 'title');
  clean_claimant_email := pg_catalog.btrim(p_claimant ->> 'email');
  clean_claimant_statement := nullif(pg_catalog.btrim(p_claimant ->> 'statement'), '');
  if pg_catalog.char_length(clean_claimant_name) not between 2 and 120 or clean_claimant_name ~ '[[:cntrl:]]'
     or pg_catalog.char_length(clean_claimant_title) not between 1 and 120 or clean_claimant_title ~ '[[:cntrl:]]'
     or pg_catalog.char_length(clean_claimant_email) not between 3 and 254
     or clean_claimant_email <> pg_catalog.lower(clean_claimant_email)
     or clean_claimant_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'
     or pg_catalog.char_length(coalesce(clean_claimant_statement, '')) > 1000 then
    raise exception 'claimant invalid' using errcode = '22023';
  end if;

  -- The requesting admin of an existing organization (organizations are
  -- created at signup, never by a claim).
  if p_requesting_user_id is null or p_organization_id is null then
    raise exception 'claim requester invalid' using errcode = '22023';
  end if;
  if not exists (
       select 1 from public.organizations as o
        where o.id = p_organization_id and o.status = 'active')
     or not exists (
       select 1 from public.organization_memberships as m
        where m.organization_id = p_organization_id
          and m.user_id = p_requesting_user_id
          and m.status = 'active')
     or not exists (
       select 1 from public.organization_role_grants as g
        where g.organization_id = p_organization_id
          and g.user_id = p_requesting_user_id
          and g.role = 'admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Limits, then silent refusals. Every refusal answers exactly like success.
  allowed := private.consume_public_interest_submission_limit(
    p_scope_hash, 'claim-network-hour', 5, interval '1 hour');
  if allowed then
    allowed := private.consume_public_interest_submission_limit(
      p_email_scope_hash, 'claim-email-day', 3, interval '1 day');
  end if;
  if allowed then
    allowed := private.consume_public_interest_submission_limit(
      pg_catalog.encode(extensions.digest('organization-claim-org:' || p_organization_id::text, 'sha256'), 'hex'),
      'claim-org-day', 3, interval '1 day');
  end if;

  if allowed then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-target:' || coalesce(p_catalog_key, 'unlisted'), 509));
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-org:' || p_organization_id::text, 509));

    target_normalized := coalesce(p_catalog_key, 'unlisted:' || pg_catalog.lower(clean_unlisted_name));

    -- A claim whose confirmation deadline has passed is lapsed even before the
    -- daily sweep runs: expire it here, exactly as the sweep would, so it never
    -- blocks this organization or this listing.
    with lapsed as (
      update private.organization_claims as c
         set status = 'expired',
             confirm_token_hash = null,
             closed_at = pg_catalog.now(),
             updated_at = pg_catalog.now()
       where c.status = 'awaiting_email'
         and c.confirm_expires_at <= pg_catalog.now()
         and (c.organization_id = p_organization_id
              or coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized)
      returning c.id, c.organization_id, c.catalog_key
    )
    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    )
    select 'claim_expired', 'system', null, 'claim', lapsed.id, lapsed.organization_id,
           pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
             'catalogKey', lapsed.catalog_key, 'fromStatus', 'awaiting_email', 'toStatus', 'expired')),
           extensions.gen_random_uuid()
      from lapsed;

    if p_catalog_key is not null and not exists (
         select 1 from private.catalog_organizations as o
          where o.catalog_key = p_catalog_key
            and o.retired_release_id is null
            and o.duplicate_of is null
            and (private.catalog_registry_identity_visible(o.union_org_id)
              or private.organization_owns_fictional_registry(p_organization_id, o.union_org_id))) then
      allowed := false;
    elsif (select pg_catalog.count(*)
             from private.organization_claims as c
            where coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized
              and c.status in ('awaiting_email', 'under_review', 'held')) >= 20 then
      allowed := false;
    elsif exists (
         select 1 from private.organization_claims as c
          where c.claimant_email_scope = p_email_scope_hash
            and coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized
            and c.status in ('awaiting_email', 'under_review', 'held')) then
      allowed := false;
    elsif exists (
         select 1 from private.organization_claims as c
          where c.organization_id = p_organization_id
            and c.status in ('awaiting_email', 'under_review', 'held')) then
      allowed := false;
    elsif private.organization_is_verified(p_organization_id) then
      allowed := false;
    elsif exists (
         select 1 from private.public_interest_suppressions as suppression
          where suppression.suppression_scope_hash = private.public_interest_suppression_scope(clean_claimant_email)) then
      allowed := false;
    end if;
  end if;

  if allowed then
    insert into private.organization_claims (
      catalog_key, unlisted_name, unlisted_city, unlisted_state,
      organization_id, claimant_user_id,
      claimant_name, claimant_title, claimant_email, statement, claimant_email_scope,
      locale, attestation_version, attested_at, confirm_token_hash, confirm_expires_at, status
    ) values (
      p_catalog_key, clean_unlisted_name, clean_unlisted_city, clean_unlisted_state,
      p_organization_id, p_requesting_user_id,
      clean_claimant_name, clean_claimant_title, clean_claimant_email, clean_claimant_statement, p_email_scope_hash,
      p_locale, 'claim-attest/1', pg_catalog.now(), p_confirm_token_hash, pg_catalog.now() + interval '24 hours',
      'awaiting_email'
    )
    returning id into new_claim_id;

    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'claim_submitted', 'organization_admin',
      p_requesting_user_id, 'claim', new_claim_id, p_organization_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'catalogKey', p_catalog_key, 'toStatus', 'awaiting_email')),
      extensions.gen_random_uuid()
    );

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      p_organization_id, 'administration', 'organization_catalog_verification_requested', 'create',
      p_requesting_user_id, 'organization', p_organization_id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', p_organization_id,
        'entityType', 'catalog_organization',
        'entityId', coalesce(p_catalog_key, 'unlisted'),
        'toStatus', 'awaiting_email'
      )
    );
  end if;

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

  return pg_catalog.jsonb_build_object('accepted', true, 'deliver', allowed);
end;
$function$;

-- Enrol only this patch's trigger surface, preserving the reviewed baseline.
insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and (
    (s.schema_name = 'public' and s.table_name = 'organizations' and s.object_name = 'keep_organization_fictional')
    or (s.schema_name = 'public' and s.table_name = 'union_orgs' and s.object_name = 'keep_registry_fictional')
    or (s.schema_name = 'public' and s.table_name in ('organization_audit_ledger', 'organization_automation_settings') and s.object_name = 'message_lifecycle_statement')
    or (s.schema_name = 'private' and s.table_name = 'bot_production_marks' and s.object_name in ('mark_fictional_organization_from_bot_ledger', 'a00_case_graph_lock', 'z99_case_graph_keys', 'message_lifecycle_statement'))))
  or (s.kind = 'function' and (
    (s.schema_name = 'private' and pg_catalog.split_part(s.object_name, '(', 1) in (
      'keep_organization_fictional', 'keep_registry_fictional', 'mark_fictional_organization_from_bot_ledger',
      'organization_visible_in_directory', 'organization_network_can_discover', 'catalog_registry_identity_visible',
      'organization_owns_fictional_registry', 'member_can_read_fictional_registry', 'organization_catalog_parent',
      'bot_production_mark_row', 'bot_production_mark_founder_invitation', 'bot_production_mark_chapter',
      'bot_production_mark_invitation', 'bot_production_mark_staged_account', 'bot_production_reopen'))
    or (s.schema_name = 'public' and pg_catalog.split_part(s.object_name, '(', 1) in (
      'get_public_site_content', 'get_public_directory', 'get_public_event_detail',
      'get_public_chapter_microsite', 'get_organization_public_verification',
      'list_chapter_connection_profiles', 'search_union_catalog', 'get_union_catalog_profile',
      'request_chapter_connection_handshake', 'request_chapter_handshake', 'submit_public_event_rsvp', 'submit_organization_claim', 'bot_production_mark'))))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $inventory$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review incomplete after directory containment: %',
      (select pg_catalog.jsonb_agg(i) from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
end;
$inventory$;

notify pgrst, 'reload schema';
commit;
