-- REQ-UG-DORMANT-64-CHAPTER-LIFECYCLE-FLOWS-20260917 — verifier identity.
--
-- verify_chapter_union_org_binding and verify_chapter_connection_setup carry
-- the two strongest decisions in the chapter lifecycle: whether a chapter is
-- bound to a union organization, and whether a chapter-owned provider is
-- activated. Both run under the service role, and both threw the reviewer's
-- identity away. The binding writer hard-coded `verified_by = null`,
-- chapter_connection_readiness had no verifier column at all, and neither
-- wrote an audit row. api/chapter-lifecycle-verification.js authorizes the
-- caller with the caller's own JWT and then calls these functions with the
-- service key, so the one fact worth keeping — WHO approved or rejected — was
-- the one fact that was lost.
--
-- This migration gives both functions a required p_verified_by argument,
-- stores it on the row, and writes the decision to the existing append-only
-- tenant ledger. Following 20260830180000: retention and verification evidence
-- belong in public.organization_audit_ledger; do not add a parallel audit
-- authority. The ledger's closed vocabularies already admit every value used
-- here (domain 'administration', action 'update', entity_type 'chapter', and
-- the chapterId/userId/entityType/entityId/fromStatus/toStatus metadata keys),
-- so no constraint is widened.
--
-- The four-argument signatures are REPLACED, not overloaded. A five-argument
-- overload whose p_verified_by defaults to null would leave the old
-- identity-less call resolvable — ambiguous for PostgREST's named-argument
-- dispatch and still reachable by the service role — which is exactly the
-- hole being closed. p_verified_by must follow the already-defaulted
-- p_public_note/p_public_message, so it carries `default null` and is refused
-- explicitly in the body: a caller that omits it gets a deliberate 42501, not
-- a silent null-verifier write.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.chapter_connection_readiness
  add column verified_by uuid references auth.users(id) on delete set null;

comment on column public.chapter_connection_readiness.verified_by is
  'Operator who recorded the last verification outcome. Written only by public.verify_chapter_connection_setup, which refuses a null verifier.';

-- private.lock_case_graph_row_keys reads the identity columns it must lock from
-- the argument list this trigger was created with (20260907150000), not from the
-- catalogue. A new auth.users reference that is not in that list would be
-- written without its identity lock, so the trigger is re-created with both.
drop trigger z99_case_graph_keys on public.chapter_connection_readiness;
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_connection_readiness
for each row execute function private.lock_case_graph_row_keys('{requested_by},{verified_by}', '');

drop function public.verify_chapter_union_org_binding(text, text, boolean, text);
drop function public.verify_chapter_connection_setup(text, text, text, text);

create function public.verify_chapter_union_org_binding(
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

create function public.verify_chapter_connection_setup(
  p_chapter_id text,
  p_capability text,
  p_status text,
  p_public_message text default '',
  p_verified_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  saved public.chapter_connection_readiness%rowtype;
  previous text;
  organization uuid;
begin
  -- Same case-graph entry 20260907151000 wrapped around the shipped body.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_verified_by is null then
    raise exception 'verifier identity required' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_verified_by) then
    raise exception 'verifier unavailable' using errcode = '22023';
  end if;
  if p_status not in ('active','error','disabled') then
    raise exception 'invalid verification status' using errcode = '22023';
  end if;

  select c.organization_id into organization
  from public.chapters c
  where c.id = p_chapter_id;
  if organization is null then
    raise exception 'chapter organization required' using errcode = '22023';
  end if;

  select r.status into previous
  from public.chapter_connection_readiness r
  where r.chapter_id = p_chapter_id and r.capability = p_capability;

  update public.chapter_connection_readiness
  set status = p_status,
      public_message = pg_catalog.left(coalesce(p_public_message,''),500),
      verified_by = p_verified_by,
      verified_at = case when p_status = 'active' then pg_catalog.clock_timestamp() else null end,
      updated_at = pg_catalog.clock_timestamp()
  where chapter_id = p_chapter_id and capability = p_capability and status in ('configuring','active','error','disabled')
  returning * into saved;
  if not found then raise exception 'setup request unavailable' using errcode = '22023'; end if;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    organization, 'administration', 'chapter_connection_setup_verified', 'update',
    p_verified_by, 'chapter', p_chapter_id, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'chapterId', p_chapter_id,
      'userId', p_verified_by,
      'entityType', 'connection_capability',
      'entityId', p_capability,
      'fromStatus', coalesce(previous, 'unset'),
      'toStatus', p_status
    )
  );

  return pg_catalog.to_jsonb(saved);
end;
$function$;

revoke all on function public.verify_chapter_union_org_binding(text, text, boolean, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_chapter_union_org_binding(text, text, boolean, text, uuid) to service_role;
revoke all on function public.verify_chapter_connection_setup(text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_chapter_connection_setup(text, text, text, text, uuid) to service_role;

-- The new auth.users reference has to be classified in the account-lifecycle
-- ownership inventory, or private.account_lifecycle_unmanaged_export_fks()
-- reports it as missing-review. It is operator attribution, not caller-owned
-- portable content, and its delete action is ON DELETE SET NULL — the same
-- disposition chapter_connection_readiness.requested_by already carries.
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition,
   export_disposition, export_projection, export_inventory_basis,
   exclusion_reason, note, reviewed_at)
values (
  'public', 'chapter_connection_readiness', 'verified_by', 'not_applicable',
  'excluded_with_reason', null, 'auth_user_fk',
  'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.',
  'Reviewed against the complete direct auth.users ownership inventory; installed action is ON DELETE SET NULL.',
  date '2026-09-16'
);

-- Re-creating the row-key trigger changes its reviewed lifecycle-manifest
-- definition hash. Reconcile the exact four-part review key from the installed
-- surface before the fail-closed assertion below. The two replaced verifiers
-- are not reachable from that surface and carry no review row.
update private.account_lifecycle_trigger_review review
set definition_hash = surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
where surface.kind = review.kind
  and surface.schema_name = review.schema_name
  and surface.table_name = review.table_name
  and surface.object_name = review.object_name
  and review.kind = 'trigger'
  and review.schema_name = 'public'
  and review.table_name = 'chapter_connection_readiness'
  and review.object_name = 'z99_case_graph_keys';

do $assert_account_lifecycle_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the chapter verification identity migration';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after the chapter verification identity migration';
  end if;
end;
$assert_account_lifecycle_trigger_review$;

notify pgrst, 'reload schema';

commit;
