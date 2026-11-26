begin;

-- UX-UG-KNOWLEDGE-CONVERSION-DENY-NOT-PERSISTED-20260917.
--
-- The conversion ledger could record a human signature, and nothing else. A
-- reviewer who refused an extraction had no write: the row stayed unsigned and
-- looked pending forever. This migration adds a one-time review decision
-- (`approved` or `rejected`) and a bounded rejection reason, stamps already
-- signed rows as approved, and gives Deny a sibling RPC that persists the
-- refusal with auth.uid() under the same MFA and staff gate as sign-off.
--
-- WHAT IT DELIBERATELY DOES NOT DO.
--
-- It does not copy document text. rejection_reason is trimmed plain text of at
-- most 280 characters, so a grievance extract cannot ride along on a refuse.
-- It does not reopen a signed or rejected row. The append-only trigger still
-- records the decision once.
-- It does not let a failed conversion be approved. Approval still requires a
-- succeeded outcome; rejection is the path that closes a failed attempt.
-- It does not write organization_audit_events. The ledger row remains the
-- audit record, as 20260907110000 established.

alter table public.organization_knowledge_conversions
  add column review_status text,
  add column rejection_reason text;

comment on column public.organization_knowledge_conversions.review_status is
  'One-time review decision for this conversion attempt: approved, rejected, or null while unsigned. Written with the reviewer pair and never rewritten.';

comment on column public.organization_knowledge_conversions.rejection_reason is
  'Trimmed reviewer explanation required exactly when review_status is rejected. Bounded to 280 characters so document text cannot be stored on a refused conversion.';

-- Allow the new decision columns to be written with the reviewer pair, and
-- allow already-signed rows (review_status still null) to be stamped approved
-- without changing the reviewer. Every other provenance column stays frozen.
create or replace function private.knowledge_conversion_is_append_only()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if (pg_catalog.to_jsonb(new)
        - 'conversion_reviewed_at'
        - 'conversion_reviewed_by'
        - 'review_status'
        - 'rejection_reason')
     is distinct from
     (pg_catalog.to_jsonb(old)
        - 'conversion_reviewed_at'
        - 'conversion_reviewed_by'
        - 'review_status'
        - 'rejection_reason') then
    raise exception 'knowledge conversion provenance is immutable' using errcode = '42501';
  end if;
  if old.conversion_reviewed_at is not null and old.review_status is not null
     and (new.conversion_reviewed_at, new.conversion_reviewed_by, new.review_status, new.rejection_reason)
        is distinct from
        (old.conversion_reviewed_at, old.conversion_reviewed_by, old.review_status, old.rejection_reason) then
    raise exception 'knowledge conversion review is recorded once' using errcode = '42501';
  end if;
  if old.conversion_reviewed_at is not null and old.review_status is null
     and (new.conversion_reviewed_at is distinct from old.conversion_reviewed_at
          or new.conversion_reviewed_by is distinct from old.conversion_reviewed_by
          or new.rejection_reason is not null
          or new.review_status is distinct from 'approved') then
    raise exception 'knowledge conversion review is recorded once' using errcode = '42501';
  end if;
  return new;
end;
$function$;

comment on function private.knowledge_conversion_is_append_only() is
  'Freezes every provenance column of public.organization_knowledge_conversions after insert. The reviewer pair, review_status and rejection_reason may be written exactly once; an already-signed row whose status is still null may only be stamped approved so historical signatures become a complete decision.';

update public.organization_knowledge_conversions
set review_status = 'approved'
where conversion_reviewed_at is not null
  and review_status is null;

alter table public.organization_knowledge_conversions
  drop constraint organization_knowledge_conversions_review_is_complete,
  drop constraint organization_knowledge_conversions_review_needs_content;

alter table public.organization_knowledge_conversions
  add constraint organization_knowledge_conversions_review_is_complete check (
    (conversion_reviewed_at is null) = (conversion_reviewed_by is null)
    and (conversion_reviewed_at is null) = (review_status is null)
    and (review_status = 'rejected') = (rejection_reason is not null)
  ),
  add constraint organization_knowledge_conversions_review_needs_content check (
    conversion_reviewed_at is null
    or review_status = 'rejected'
    or outcome = 'succeeded'
  ),
  add constraint organization_knowledge_conversions_review_status_known check (
    review_status is null or review_status in ('approved', 'rejected')
  ),
  add constraint organization_knowledge_conversions_rejection_reason_bounded check (
    rejection_reason is null
    or (
      pg_catalog.char_length(rejection_reason) between 1 and 280
      and rejection_reason = pg_catalog.btrim(rejection_reason)
    )
  );

comment on table public.organization_knowledge_conversions is
  'Append-only provenance for every document-conversion attempt: the exact source digest, converter identity and version, this repository''s pipeline version, bounded conversion metadata, and the authorized reviewer who approved or rejected the result. One row per attempt; rows are never rewritten.';

create or replace function public.review_knowledge_conversion(
  p_organization_id uuid, p_conversion_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  reviewer uuid;
  row_out public.organization_knowledge_conversions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  reviewer := (select auth.uid());
  if reviewer is null or p_organization_id is null or p_conversion_id is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not (select private.mfa_satisfied()) then
    raise exception 'reauthentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = reviewer and membership.status = 'active'
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ) then raise exception 'not authorized' using errcode = '42501'; end if;

  update public.organization_knowledge_conversions
  set conversion_reviewed_at = pg_catalog.now(),
      conversion_reviewed_by = reviewer,
      review_status = 'approved'
  where id = p_conversion_id
    and organization_id = p_organization_id
    and conversion_reviewed_at is null
  returning * into row_out;
  if not found then
    raise exception 'conversion is not awaiting review' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'id', row_out.id,
    'sourceId', row_out.source_id,
    'attempt', row_out.attempt,
    'reviewedAt', row_out.conversion_reviewed_at,
    'reviewedBy', row_out.conversion_reviewed_by,
    'reviewStatus', row_out.review_status
  );
end;
$function$;

comment on function public.review_knowledge_conversion(uuid, uuid) is
  'Records an approved review of one conversion attempt. Attribution is auth.uid(), never a parameter, MFA is demanded of the reviewer, and the append-only trigger makes the signature unrepeatable. Approval still requires a succeeded conversion; refusals use reject_knowledge_conversion.';

create function public.reject_knowledge_conversion(
  p_organization_id uuid, p_conversion_id uuid, p_reason text
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  reviewer uuid;
  reason text;
  row_out public.organization_knowledge_conversions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  reviewer := (select auth.uid());
  reason := pg_catalog.btrim(coalesce(p_reason, ''));
  if reviewer is null or p_organization_id is null or p_conversion_id is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not (select private.mfa_satisfied()) then
    raise exception 'reauthentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(reason) not between 1 and 280 then
    raise exception 'invalid conversion rejection' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = reviewer and membership.status = 'active'
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ) then raise exception 'not authorized' using errcode = '42501'; end if;

  update public.organization_knowledge_conversions
  set conversion_reviewed_at = pg_catalog.now(),
      conversion_reviewed_by = reviewer,
      review_status = 'rejected',
      rejection_reason = reason
  where id = p_conversion_id
    and organization_id = p_organization_id
    and conversion_reviewed_at is null
  returning * into row_out;
  if not found then
    raise exception 'conversion is not awaiting review' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'id', row_out.id,
    'sourceId', row_out.source_id,
    'attempt', row_out.attempt,
    'reviewedAt', row_out.conversion_reviewed_at,
    'reviewedBy', row_out.conversion_reviewed_by,
    'reviewStatus', row_out.review_status,
    'rejectionReason', row_out.rejection_reason
  );
end;
$function$;

revoke all on function public.reject_knowledge_conversion(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reject_knowledge_conversion(uuid, uuid, text) to authenticated;

comment on function public.reject_knowledge_conversion(uuid, uuid, text) is
  'Records a rejected review of one conversion attempt with a bounded reason. Attribution is auth.uid(), never a parameter, MFA is demanded of the reviewer, and the append-only trigger makes the refusal unrepeatable. Failed conversions may be rejected so they do not remain pending; the ledger row is itself the audit record.';

-- THE ACCOUNT-LIFECYCLE REVIEW PIN.
--
-- private.account_lifecycle_trigger_surface() hashes the full definition of
-- every trigger reachable from the referential-action surface, and
-- private.account_lifecycle_referential_action_trigger_issues() reports any
-- hash the manifest has not reviewed. Re-emitting
-- private.knowledge_conversion_is_append_only() above changes that hash, so the
-- manifest row is reconciled here against its reviewed predecessor and the
-- inventory is asserted empty before this migration is allowed to commit.
do $reconcile_conversion_trigger_review$
declare
  reconciled integer;
begin
  update private.account_lifecycle_trigger_review
  set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(
    'private.knowledge_conversion_is_append_only()'::regprocedure))
  where kind = 'function' and schema_name = 'private' and table_name = ''
    and object_name = 'knowledge_conversion_is_append_only()'
    and definition_hash = 'f3ff882f1f0396eef2b122f820fae986';
  get diagnostics reconciled = row_count;
  if reconciled <> 1 then
    raise exception 'knowledge conversion append-only review pin was not updated exactly once';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the conversion rejection migration';
  end if;
end;
$reconcile_conversion_trigger_review$;

commit;
