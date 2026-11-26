-- SEC-UG-ORGANIZATION-COORDINATION-SHARES-IGNORE-UNIT-NARROWING-20261114 (#8752).
-- Organization coordination shares took any chapter document in the caller's
-- organization from anyone holding an organization staff role, an
-- organization steward limited to one unit included, and the sending
-- organization then read the body back through a security definer function.
-- Neither checked the document's unit or committee, or that unit's documents
-- switch (#7667). Both now ask private.organization_coordination_document_allows
-- on the sending side; the receiving organization keeps its read of an
-- accepted share.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Whether the caller may hand one of its own organization's chapter documents
-- to a partner organization, or read it back from that organization's side.
-- A chapter-wide document (no unit, no committee) stays open to organization
-- staff as before. A unit or committee document needs a route to it:
-- organization-wide or chapter-wide leadership and officers keep theirs, an
-- office role scoped to the container passes through chapter_officer_can_for_scope
-- (which applies that role's chapter setting and unit switch), a steward with
-- carry-over chapter coverage or a chapter-wide steward role keeps the chapter,
-- and a steward assigned to that unit needs the unit's documents switch on
-- (private.unit_staff_capability_allows). An organization steward grant alone
-- reaches no unit document.
create function private.organization_coordination_document_allows(p_document uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select auth.uid()) is not null and exists(select 1 from public.chapter_documents d
    join public.chapters c on c.id=d.chapter_id
    where d.id=p_document and c.organization_id=(select private.current_member_organization())
      and ((d.access_unit_id is null and d.access_committee_id is null)
        or private.has_organization_role(c.organization_id,array['coordinator','advisor','admin','vp'])
        or private.member_has_chapter_role(d.chapter_id,array['coordinator','advisor','admin','vp'])
        or private.chapter_officer_can_for_scope(d.chapter_id,'documents',d.access_unit_id,d.access_committee_id)
        -- Carry-over chapter coverage, from either assignment source, and a
        -- chapter-wide steward role are chapter-wide routes: no unit switch
        -- narrows them, whatever other office the person holds in a unit
        -- (gate stage 195 r1s1, r2s1).
        or exists(select 1 from private.steward_assignment_scopes((select auth.uid()),d.chapter_id) s
          where s.role='steward' and s.legacy_chapter_coverage)
        or exists(select 1 from public.member_role_chapters r
          join public.member_chapter_memberships m on m.user_id=r.user_id and m.chapter_id=r.chapter_id and m.status='active'
          where r.user_id=(select auth.uid()) and r.chapter_id=d.chapter_id and r.role='steward'
            and not exists(select 1 from private.steward_assignment_scopes((select auth.uid()),d.chapter_id) s
              where s.role='steward' and not s.legacy_chapter_coverage))
        -- A steward assigned to this unit needs the unit's documents switch on.
        or (d.access_unit_id is not null
          and exists(select 1 from private.steward_assignment_scopes((select auth.uid()),d.chapter_id) s
            where s.role='steward' and not s.legacy_chapter_coverage and s.unit_id=d.access_unit_id)
          and private.unit_staff_capability_allows(d.chapter_id,d.access_unit_id,'documents')))),false);
$$;
revoke all on function private.organization_coordination_document_allows(uuid) from public,anon,authenticated,service_role;

-- Preserve the reviewed predecessors before replacing them: the share body as
-- the 20260907151000 case-graph wrapper left it, and the read body from
-- 20260828232000_mi1_organization_coordination_workflows.sql.
do $guard$ begin
  if (select md5(prosrc) from pg_proc where oid='public.share_organization_coordination_resource(uuid,text,text,uuid,uuid)'::regprocedure) is distinct from '0f6c3b91852eb32465f2502530745fee' then
    raise exception 'unreviewed public.share_organization_coordination_resource predecessor' using errcode='55000';
  end if;
  if (select md5(prosrc) from pg_proc where oid='public.get_organization_coordination_shared_document(uuid)'::regprocedure) is distinct from 'bdd9a49e1f7f207fe1af06935b9762b3' then
    raise exception 'unreviewed public.get_organization_coordination_shared_document predecessor' using errcode='55000';
  end if;
end $guard$;

create or replace function public.share_organization_coordination_resource(
  p_record_id uuid,
  p_resource_kind text,
  p_title text,
  p_chapter_document_id uuid default null,
  p_idempotency_key uuid default extensions.gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  item public.organization_coordination_records%rowtype;
  target uuid;
  resource_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization staff role required' using errcode = '42501';
  end if;
  select * into item from public.organization_coordination_records r
  where r.id = p_record_id and r.status = 'active';
  if not found or not private.organization_coordination_can_read(item.id)
     or item.partner_organization_id is null then
    raise exception 'coordination resource lane unavailable' using errcode = '22023';
  end if;
  target := case when item.organization_id = organization
    then item.partner_organization_id else item.organization_id end;
  -- #8752: the caller must reach the document's unit or committee, under
  -- that unit's documents switch, not only hold an organization staff role.
  if p_resource_kind = 'share' and not exists (
    select 1 from public.chapter_documents d
    join public.chapters c on c.id = d.chapter_id
    where d.id = p_chapter_document_id and c.organization_id = organization
      and private.organization_coordination_document_allows(d.id)
  ) then
    raise exception 'authorized chapter document required' using errcode = '22023';
  end if;
  insert into public.organization_coordination_resources (
    record_id, from_organization_id, to_organization_id, chapter_document_id,
    resource_kind, title, status, idempotency_key, created_by
  ) values (
    item.id, organization, target, p_chapter_document_id, p_resource_kind,
    pg_catalog.btrim(p_title), case when p_resource_kind = 'share' then 'available' else 'requested' end,
    p_idempotency_key, caller
  )
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning id into resource_id;
  return pg_catalog.jsonb_build_object('created', true, 'resourceId', resource_id);
end;
end;
$function$;

create or replace function public.get_organization_coordination_shared_document(
  p_resource_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  resource public.organization_coordination_resources%rowtype;
  document public.chapter_documents%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization resource role required' using errcode = '42501';
  end if;
  select * into resource
  from public.organization_coordination_resources x
  where x.id = p_resource_id and x.resource_kind = 'share'
    and x.status = 'accepted'
    and organization in (x.from_organization_id, x.to_organization_id);
  if not found or not private.organization_network_has_permission(
    resource.from_organization_id, resource.to_organization_id, 'resource_share'
  ) then
    raise exception 'shared document unavailable' using errcode = '22023';
  end if;
  select * into document
  from public.chapter_documents d where d.id = resource.chapter_document_id;
  -- #8752: the sending organization reads its own document back only on the
  -- terms it could share it; the receiving organization keeps its read.
  if not found or (organization = resource.from_organization_id
    and not private.organization_coordination_document_allows(document.id)) then
    raise exception 'shared document unavailable' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object(
    'resourceId', resource.id,
    'documentId', document.id,
    'title', document.title,
    'documentType', document.document_type,
    'summary', document.summary,
    'body', document.body,
    'sourceUrl', document.source_url,
    'version', document.version
  );
end;
$function$;

comment on function private.organization_coordination_document_allows(uuid) is
  'SEC-UG-ORGANIZATION-COORDINATION-SHARES-IGNORE-UNIT-NARROWING-20261114 (#8752): whether the caller may share one of its organization''s chapter documents with a partner organization, or read it back from the sending side. Unit and committee documents need a route to their container and, for a steward, the unit''s documents switch.';

notify pgrst,'reload schema';
commit;
