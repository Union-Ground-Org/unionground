begin;

-- REQ-UG-ASSISTANT-HISTORY-LEGACY-ORG-ATTRIBUTION-20261003
--
-- 20261003050000 scoped assistant history to the organization that produced
-- it and left every earlier thread and message unstamped, so that history no
-- longer shows in any assistant. This one-time backfill attributes a legacy
-- thread to its owner's organization only when there is exactly one to choose:
-- one active organization membership in an active organization. An owner with
-- none or several keeps NULL rows (no guessing); they stay retained, outside
-- tenant purges and in the account export. Stamped messages take their
-- thread's new organization. Rows already stamped are not touched.
--
-- stamp_retention_scope refuses every change of organization_id, so it is
-- disabled on the two tables for these two statements only and enabled again
-- in this same transaction. The trigger function is unchanged and keeps the
-- stamp immutable for every later write; no API or member path can set one.
-- The updated_at touch trigger is held too, so legacy threads keep their
-- order in the assistant and their age for retention. The case-graph lock and
-- key triggers and the PIN step-up trigger stay enabled. DISABLE TRIGGER takes
-- an ACCESS EXCLUSIVE lock on both tables until commit.

alter table public.member_guide_threads disable trigger stamp_retention_scope;
alter table public.member_guide_threads disable trigger member_guide_threads_touch_updated_at;
alter table public.member_guide_messages disable trigger stamp_retention_scope;

with sole_organization as (
  select om.user_id, (pg_catalog.array_agg(om.organization_id))[1] as organization_id
  from public.organization_memberships om
  join public.organizations o on o.id = om.organization_id and o.status = 'active'
  where om.status = 'active'
  group by om.user_id
  having pg_catalog.count(distinct om.organization_id) = 1
),
stamped_threads as (
  update public.member_guide_threads t
  set organization_id = s.organization_id
  from sole_organization s
  where t.organization_id is null
    and t.user_id = s.user_id
  returning t.id, t.user_id, t.organization_id
)
update public.member_guide_messages m
set organization_id = st.organization_id
from stamped_threads st
where m.thread_id = st.id
  and m.user_id = st.user_id
  and m.organization_id is null;

alter table public.member_guide_threads enable trigger stamp_retention_scope;
alter table public.member_guide_threads enable trigger member_guide_threads_touch_updated_at;
alter table public.member_guide_messages enable trigger stamp_retention_scope;

commit;
