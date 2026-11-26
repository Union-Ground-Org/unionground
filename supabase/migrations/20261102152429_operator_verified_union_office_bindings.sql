-- SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101 — only a
-- platform operator confirms that a chapter is a union office.
--
-- Any administrator of an onboarded organization can ask for a binding from
-- their own chapter to a catalogue office (public.request_chapter_union_org_binding).
-- Until now the same administrator could also verify it: the verification API
-- checked only organization-admin scope on the caller's own chapter, and
-- public.verify_chapter_union_org_binding checked only for the service role
-- and an existing verifier user. A chapter could therefore present itself as an
-- official union office it does not belong to. 20261101224749 stopped such a
-- binding from receiving standing offers; this migration stops it being
-- verified at all.
--
-- 1. public.verify_chapter_union_org_binding refuses a verifier who is not an
--    active platform operator (private.compass_platform_operators, revoked_at
--    null), for both verify and reject. The signature, defaults, grants, the
--    case-graph entry and the audit row are unchanged.
-- 2. public.list_union_office_bindings_without_operator_verifier is the
--    retained read of existing decisions nobody on the operator registry made:
--    verified or rejected bindings whose verifier is null or not an active
--    operator. It changes nothing; the owner rules on each row.
-- 3. public.reopen_chapter_union_org_binding applies a ruling: on behalf of an
--    active operator it returns one verified or rejected binding to requested,
--    clearing the verifier, and records the decision in the tenant ledger. An
--    operator can then verify or reject it through the ordinary path.
--
-- Re-pointing a binding at another office already returns it to requested:
-- request_chapter_union_org_binding's upsert clears status, verifier and
-- verified_at, and the table grants no writes to any client role. That is
-- unchanged and is proved by tests/operator-verified-union-office-bindings-db.test.js.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
-- pg_catalog alone resolves names exactly as an empty path does (it is always searched first).
set local search_path = pg_catalog;

create or replace function public.verify_chapter_union_org_binding(
  p_chapter_id text,
  p_union_org_id text,
  p_verified boolean,
  p_public_note text default '',
  p_verified_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  organization uuid;
  changed integer;
begin
  -- 20260907151000 wrapped this function's shipped body in the case-graph
  -- transaction entry, and chapter_union_org_bindings is in the FK closure the
  -- gate covers. Replacing the function must re-state that entry verbatim, and
  -- it stays first: per that migration's protocol every authorization read runs
  -- after the gate, so the lock order is the same for every writer.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  -- The service role is a machine credential, not a person. It may act only on
  -- behalf of a named reviewer, so an absent or unknown identity is refused
  -- before the binding moves.
  if p_verified_by is null then
    raise exception 'verifier identity required' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_verified_by) then
    raise exception 'verifier unavailable' using errcode = '22023';
  end if;
  -- An organization administrator can request their own chapter's binding,
  -- which says nothing about whether the chapter is that office. Only an
  -- active platform operator confirms or refuses it.
  if not private.partner_binding_verifier_is_operator(p_verified_by) then
    raise exception 'platform operator required' using errcode = '42501';
  end if;

  select c.organization_id into organization
  from public.chapters c
  where c.id = p_chapter_id;
  -- Every audited decision lands in its tenant's ledger. A chapter with no
  -- organization is a quarantined pre-MI1 row (20260822010000) and cannot
  -- carry tenant audit evidence, so it is not verifiable through this path.
  if organization is null then
    raise exception 'chapter organization required' using errcode = '22023';
  end if;

  update public.chapter_union_org_bindings
  set status = case when p_verified then 'verified' else 'rejected' end,
      verified_by = p_verified_by,
      verified_at = case when p_verified then pg_catalog.clock_timestamp() else null end,
      public_note = pg_catalog.left(coalesce(p_public_note, ''), 500)
  where chapter_id = p_chapter_id and union_org_id = p_union_org_id and status = 'requested';
  get diagnostics changed = row_count;
  if changed = 0 then raise exception 'binding unavailable' using errcode = '22023'; end if;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    organization, 'administration', 'chapter_union_org_binding_verified', 'update',
    p_verified_by, 'chapter', p_chapter_id, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'chapterId', p_chapter_id,
      'userId', p_verified_by,
      'entityType', 'union_org',
      'entityId', p_union_org_id,
      'fromStatus', 'requested',
      'toStatus', case when p_verified then 'verified' else 'rejected' end
    )
  );

  return pg_catalog.jsonb_build_object(
    'verified', p_verified,
    'chapterId', p_chapter_id,
    'verifiedBy', p_verified_by
  );
end;
$function$;

revoke all on function public.verify_chapter_union_org_binding(text, text, boolean, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_chapter_union_org_binding(text, text, boolean, text, uuid) to service_role;

-- The retained read. A binding verified before the identity migration has a
-- null verifier, and one an organization administrator approved or refused
-- has a verifier who is not an operator; both are listed. Rows stay as they
-- are until the owner's ruling is applied with the function below.
create function public.list_union_office_bindings_without_operator_verifier()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'chapterId', b.chapter_id,
      'organizationId', c.organization_id,
      'unionOrgId', b.union_org_id,
      'status', b.status,
      'verifiedBy', b.verified_by,
      'verifiedAt', b.verified_at,
      'requestedAt', b.requested_at
    ) order by b.chapter_id)
    from public.chapter_union_org_bindings b
    left join public.chapters c on c.id = b.chapter_id
    where b.status in ('verified', 'rejected')
      and not private.partner_binding_verifier_is_operator(b.verified_by)
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_union_office_bindings_without_operator_verifier()
  from public, anon, authenticated, service_role;
grant execute on function public.list_union_office_bindings_without_operator_verifier() to service_role;
comment on function public.list_union_office_bindings_without_operator_verifier() is
  'SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101: service role only; read-only list of verified or rejected chapter-to-union-office bindings whose verifier is null or not an active platform operator, for the owner''s ruling on each.';

-- Applies a ruling: one verified or rejected binding goes back to requested,
-- with no verifier, so an operator decides it again through
-- public.verify_chapter_union_org_binding. Standing offers already delivered
-- stay as handshake requests the chapter can decline; nothing is accepted.
create function public.reopen_chapter_union_org_binding(
  p_chapter_id text,
  p_union_org_id text,
  p_operator_user_id uuid,
  p_public_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  organization uuid;
  previous text;
begin
  perform private.lock_case_graph(array[p_operator_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not private.partner_binding_verifier_is_operator(p_operator_user_id) then
    raise exception 'platform operator required' using errcode = '42501';
  end if;

  select c.organization_id into organization
  from public.chapters c
  where c.id = p_chapter_id;
  if organization is null then
    raise exception 'chapter organization required' using errcode = '22023';
  end if;

  select b.status into previous
  from public.chapter_union_org_bindings b
  where b.chapter_id = p_chapter_id and b.union_org_id = p_union_org_id
    and b.status in ('verified', 'rejected')
  for update;
  if not found then raise exception 'binding unavailable' using errcode = '22023'; end if;

  update public.chapter_union_org_bindings
  set status = 'requested',
      verified_by = null,
      verified_at = null,
      public_note = pg_catalog.left(coalesce(p_public_note, ''), 500)
  where chapter_id = p_chapter_id and union_org_id = p_union_org_id;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    organization, 'administration', 'chapter_union_org_binding_reopened', 'update',
    p_operator_user_id, 'chapter', p_chapter_id, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'chapterId', p_chapter_id,
      'userId', p_operator_user_id,
      'entityType', 'union_org',
      'entityId', p_union_org_id,
      'fromStatus', previous,
      'toStatus', 'requested'
    )
  );

  return pg_catalog.jsonb_build_object(
    'chapterId', p_chapter_id,
    'unionOrgId', p_union_org_id,
    'fromStatus', previous,
    'status', 'requested'
  );
end;
$function$;

revoke all on function public.reopen_chapter_union_org_binding(text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reopen_chapter_union_org_binding(text, text, uuid, text) to service_role;
comment on function public.reopen_chapter_union_org_binding(text, text, uuid, text) is
  'SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101: service role only, on behalf of an active platform operator; returns one verified or rejected chapter-to-union-office binding to requested with no verifier, and records it in the tenant ledger.';

notify pgrst, 'reload schema';

commit;
