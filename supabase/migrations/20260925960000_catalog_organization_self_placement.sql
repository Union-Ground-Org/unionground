-- Phase 4a DB half: organization self-placement (self-reported).
--
-- An organization admin can say where the organization belongs in the public
-- union catalog: under a catalog organization (by its catalog key), under a
-- parent the catalog does not list (a name and an optional state), or that the
-- catalog does not list the organization itself. Every placement written here
-- is self_reported. A verified placement, its checkmark and any verifier undo
-- belong to a later phase, which extends this table rather than replacing it.
--
-- Boundaries:
--   * one row per organization, in private schema, with no client grant and
--     no policy; reads and writes travel only through the three RPCs below;
--   * no auth.users column: the acting admin is recorded on the
--     organization_audit_ledger row, so the table needs no lifecycle manifest
--     row. It joins the account case graph through its organization key;
--   * the catalog key is plain text plus a writer-side existence check, never
--     a foreign key, so nothing here points into private.catalog_* and the
--     catalog stays outside the case graph;
--   * the union catalog tables come from 20260925950000, which applies
--     before this file. The one read of them still sits behind a to_regclass
--     check, so a database without the catalog answers instead of raising:
--     every parent key is then "placement target unavailable";
--   * unknown, retired and duplicate keys all get the same refusal, so the
--     write path never discloses catalog bookkeeping;
--   * a free-text parent name is refused when it has no letter or digit, or
--     carries an email marker, a link or a phone-length digit run (spaces,
--     brackets, dots, plus signs, slashes, underscores and dashes do not break
--     the run), and it never enters audit metadata.
--   * chapter_union_org_bindings is neither read nor written.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.organization_catalog_placements (
  organization_id uuid primary key
    references public.organizations(id) on update cascade on delete cascade,
  parent_catalog_key text
    constraint organization_catalog_placements_parent_catalog_key_check
    check (parent_catalog_key ~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$'),
  unlisted_parent_name text
    constraint organization_catalog_placements_unlisted_parent_name_check
    check (pg_catalog.char_length(pg_catalog.btrim(unlisted_parent_name)) between 3 and 200
           and unlisted_parent_name !~ '[[:cntrl:]]'
           and unlisted_parent_name ~ '[[:alnum:]]'),
  unlisted_parent_state text
    constraint organization_catalog_placements_unlisted_parent_state_check
    check (unlisted_parent_state ~ '^[A-Z]{2}$'),
  identity_unlisted boolean not null default false,
  verification_status text not null default 'self_reported'
    constraint organization_catalog_placements_verification_status_check
    check (verification_status in ('self_reported')),
  placed_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_catalog_placements_one_parent
    check (pg_catalog.num_nonnulls(parent_catalog_key, unlisted_parent_name) <= 1),
  constraint organization_catalog_placements_state_needs_name
    check (unlisted_parent_state is null or unlisted_parent_name is not null),
  constraint organization_catalog_placements_something_placed
    check (parent_catalog_key is not null or unlisted_parent_name is not null or identity_unlisted)
);

create index organization_catalog_placements_parent_key_idx
  on private.organization_catalog_placements (parent_catalog_key);

comment on table private.organization_catalog_placements is
  'One self-reported union catalog placement per organization: a catalog parent key, an unlisted parent name and state, or "the catalog does not list us". No client grant; read and written only through get/set/clear_organization_catalog_placement. The acting admin is on the organization_audit_ledger row.';

alter table private.organization_catalog_placements enable row level security;
alter table private.organization_catalog_placements force row level security;
revoke all on table private.organization_catalog_placements from public, anon, authenticated, service_role;

-- Account case-graph coordination: the row hangs from public.organizations, so
-- it joins the lock graph like every other organization child. It has no
-- auth.users column, so the row-key trigger names no identity column.
create trigger a00_case_graph_lock before insert or update or delete on private.organization_catalog_placements
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_catalog_placements
for each row execute function private.lock_case_graph_row_keys('', '');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private' and table_name = 'organization_catalog_placements'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_organization_catalog_placements_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after organization catalog placements';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after organization catalog placements';
  end if;
end;
$assert_organization_catalog_placements_trigger_review$;

-- The catalog parent a key names: {"name", "active"}, or null when the key is
-- not a catalog row or the union catalog is not installed. Active means the
-- row is neither retired nor folded into another row, and a catalog release is
-- active: the same rule the anonymous catalog profile read applies.
--
-- The catalog tables come from 20260925950000, which applies first, so the
-- read is plain plpgsql that plpgsql_check can see. The to_regclass guard only
-- keeps a database without the catalog answering null instead of raising.
create function private.organization_catalog_parent(p_catalog_key text)
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
   where o.catalog_key = p_catalog_key;
  return parent;
end;
$function$;

revoke all on function private.organization_catalog_parent(text)
  from public, anon, authenticated, service_role;

comment on function private.organization_catalog_parent(text) is
  'Non-executable catalog parent lookup for the organization placement RPCs. Answers null when the key is not a catalog row or the union catalog tables are not installed.';

-- The shared response shape of all three placement RPCs.
create function private.organization_catalog_placement_state(p_organization_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  placement private.organization_catalog_placements%rowtype;
  parent jsonb;
begin
  select * into placement
    from private.organization_catalog_placements as p
   where p.organization_id = p_organization_id;
  if not found then
    return pg_catalog.jsonb_build_object('placement', null);
  end if;
  parent := private.organization_catalog_parent(placement.parent_catalog_key);
  return pg_catalog.jsonb_build_object('placement', pg_catalog.jsonb_build_object(
    'parentCatalogKey', placement.parent_catalog_key,
    'parentName', parent ->> 'name',
    'parentActive', coalesce((parent ->> 'active')::boolean, false),
    'unlistedParentName', placement.unlisted_parent_name,
    'unlistedParentState', placement.unlisted_parent_state,
    'identityUnlisted', placement.identity_unlisted,
    'verificationStatus', placement.verification_status,
    'updatedAt', placement.updated_at
  ));
end;
$function$;

revoke all on function private.organization_catalog_placement_state(uuid)
  from public, anon, authenticated, service_role;

comment on function private.organization_catalog_placement_state(uuid) is
  'Non-executable response projection shared by the organization catalog placement RPCs.';

create function public.get_organization_catalog_placement(
  p_selected_hat text,
  p_expected_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return private.organization_catalog_placement_state(org);
end;
$function$;

create function public.set_organization_catalog_placement(
  p_selected_hat text,
  p_expected_organization_id uuid,
  p_parent_catalog_key text,
  p_unlisted_parent_name text,
  p_unlisted_parent_state text,
  p_identity_unlisted boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  parent_key text;
  parent_name text;
  parent_state text;
  identity_only boolean;
  parent jsonb;
  prior_status text;
  replay record;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- A replay is the same key, organization and operation: a key first spent
  -- on a clear is not a replay of a set.
  select l.organization_id, l.event_type, l.metadata ->> 'reasonCode' as reason_code into replay
    from public.organization_audit_ledger as l
   where l.idempotency_key = p_idempotency_key;
  if found then
    if replay.organization_id is distinct from org
       or replay.event_type is distinct from 'organization_catalog_placement_changed'
       or replay.reason_code is not distinct from 'cleared' then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    return private.organization_catalog_placement_state(org);
  end if;

  parent_key := nullif(pg_catalog.btrim(p_parent_catalog_key), '');
  parent_name := nullif(pg_catalog.btrim(p_unlisted_parent_name), '');
  parent_state := nullif(pg_catalog.btrim(p_unlisted_parent_state), '');
  identity_only := coalesce(p_identity_unlisted, false);

  if parent_key is not null and parent_name is not null then
    raise exception 'placement parent ambiguous' using errcode = '22023';
  end if;
  if parent_state is not null and parent_name is null then
    raise exception 'placement state needs name' using errcode = '22023';
  end if;
  if parent_key is null and parent_name is null and not identity_only then
    raise exception 'placement empty' using errcode = '22023';
  end if;
  if parent_name is not null and (
       pg_catalog.char_length(parent_name) not between 3 and 200
       or parent_name ~ '[[:cntrl:]]'
       or parent_name !~ '[[:alnum:]]'
       or pg_catalog.strpos(parent_name, '@') > 0
       or pg_catalog.strpos(parent_name, '://') > 0
       or pg_catalog.regexp_replace(parent_name, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}') then
    raise exception 'placement name invalid' using errcode = '22023';
  end if;
  if parent_state is not null and parent_state !~ '^[A-Z]{2}$' then
    raise exception 'placement state invalid' using errcode = '22023';
  end if;
  if parent_key is not null then
    if parent_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
      raise exception 'placement target unavailable' using errcode = '22023';
    end if;
    parent := private.organization_catalog_parent(parent_key);
    if not coalesce((parent ->> 'active')::boolean, false) then
      raise exception 'placement target unavailable' using errcode = '22023';
    end if;
  end if;

  if (select pg_catalog.count(*)
        from public.organization_audit_ledger as l
       where l.organization_id = org
         and l.event_type = 'organization_catalog_placement_changed'
         and l.occurred_at > pg_catalog.now() - interval '24 hours') >= 10 then
    raise exception 'placement change limit' using errcode = '22023';
  end if;

  select p.verification_status into prior_status
    from private.organization_catalog_placements as p
   where p.organization_id = org;

  insert into private.organization_catalog_placements as p (
    organization_id, parent_catalog_key, unlisted_parent_name, unlisted_parent_state,
    identity_unlisted, verification_status, placed_at, updated_at
  ) values (
    org, parent_key, parent_name, parent_state, identity_only, 'self_reported',
    pg_catalog.now(), pg_catalog.now()
  )
  on conflict (organization_id) do update
    set parent_catalog_key = excluded.parent_catalog_key,
        unlisted_parent_name = excluded.unlisted_parent_name,
        unlisted_parent_state = excluded.unlisted_parent_state,
        identity_unlisted = excluded.identity_unlisted,
        verification_status = 'self_reported',
        updated_at = pg_catalog.now();

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'administration', 'organization_catalog_placement_changed', 'update',
    (select auth.uid()), 'organization', org::text, p_idempotency_key,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'entityType', case when parent_key is not null then 'catalog_organization' else 'unlisted' end,
      'entityId', parent_key,
      'fromStatus', coalesce(prior_status, 'unset'),
      'toStatus', 'self_reported',
      'reasonCode', case when parent_key is not null or parent_name is not null
                         then 'parent_set' else 'identity_unlisted' end
    ))
  );

  return private.organization_catalog_placement_state(org);
end;
$function$;

create function public.clear_organization_catalog_placement(
  p_selected_hat text,
  p_expected_organization_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  prior_status text;
  replay record;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- A replay is the same key, organization and operation: a key first spent
  -- on a set is not a replay of a clear.
  select l.organization_id, l.event_type, l.metadata ->> 'reasonCode' as reason_code into replay
    from public.organization_audit_ledger as l
   where l.idempotency_key = p_idempotency_key;
  if found then
    if replay.organization_id is distinct from org
       or replay.event_type is distinct from 'organization_catalog_placement_changed'
       or replay.reason_code is distinct from 'cleared' then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    return private.organization_catalog_placement_state(org);
  end if;

  select p.verification_status into prior_status
    from private.organization_catalog_placements as p
   where p.organization_id = org;
  if not found then
    return pg_catalog.jsonb_build_object('placement', null);
  end if;

  if (select pg_catalog.count(*)
        from public.organization_audit_ledger as l
       where l.organization_id = org
         and l.event_type = 'organization_catalog_placement_changed'
         and l.occurred_at > pg_catalog.now() - interval '24 hours') >= 10 then
    raise exception 'placement change limit' using errcode = '22023';
  end if;

  delete from private.organization_catalog_placements as p
   where p.organization_id = org;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'administration', 'organization_catalog_placement_changed', 'update',
    (select auth.uid()), 'organization', org::text, p_idempotency_key,
    pg_catalog.jsonb_build_object(
      'fromStatus', prior_status,
      'toStatus', 'cleared',
      'reasonCode', 'cleared'
    )
  );

  return pg_catalog.jsonb_build_object('placement', null);
end;
$function$;

revoke all on function public.get_organization_catalog_placement(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_organization_catalog_placement(text, uuid, text, text, text, boolean, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.clear_organization_catalog_placement(text, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_organization_catalog_placement(text, uuid) to authenticated;
grant execute on function public.set_organization_catalog_placement(text, uuid, text, text, text, boolean, uuid) to authenticated;
grant execute on function public.clear_organization_catalog_placement(text, uuid, uuid) to authenticated;

comment on function public.get_organization_catalog_placement(text, uuid) is
  'Admin read of the organization''s self-reported union catalog placement, with the parent''s catalog name and whether it is still active. MFA-guarded; writes nothing.';
comment on function public.set_organization_catalog_placement(text, uuid, text, text, text, boolean, uuid) is
  'Admin write of the organization''s self-reported union catalog placement. MFA-guarded, idempotent by key, at most ten changes per organization in 24 hours; unknown, retired and duplicate catalog keys share one refusal. Audited on organization_audit_ledger without the unlisted name.';
comment on function public.clear_organization_catalog_placement(text, uuid, uuid) is
  'Admin removal of the organization''s self-reported union catalog placement. MFA-guarded, idempotent by key; clearing nothing writes nothing.';

notify pgrst, 'reload schema';

commit;
