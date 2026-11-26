-- SEC-UG-COORDINATOR-CASE-POLICIES-AUTHOR-ONLY-20260917
--
-- A coordinator could read a RESTRICTED case's notes, logged contacts, recorded
-- outcome, both audit trails, attachment metadata and attachment bytes even
-- though PostgREST hid the case row itself.
--
-- 20260828210000_mi1_casework_suite introduced public.member_cases.is_restricted
-- and public.casework_access_grants, and 20260829001850_mi1_casework_policy_recursion_repair
-- settled the final parent predicate: an in-scope coordinator reads a restricted
-- case only when they are that case's own coordinator, hold an organization
-- advisor/admin/vp hat, or hold an active casework_access_grants row -- the last
-- through the SECURITY DEFINER helper private.casework_actor_has_active_grant,
-- because a direct subquery re-entered the casework_access_grants policy, which
-- reads member_cases again, and PostgreSQL raised 42P17.
--
-- The child rows never gained that gate. Seven read paths still authorized a
-- coordinator on the row's own owner column, or on a bare organization role,
-- without ever consulting the case -- so every fact the restriction is meant to
-- withhold stayed reachable one table across:
--
--   1. policy public.member_case_updates_select_coordinator
--      (20260723160000_coordinator_case_plane:31) -- the case notes. This is the
--      reported defect: GET /rest/v1/member_case_updates?case_id=eq.<restricted>
--      returns the whole timeline to any coordinator whose chapter scope covers
--      the case owner, with no grant. The predicate gates on the note AUTHOR,
--      which for every note coordinator_add_case_note writes is the case owner.
--   2. policy public.member_case_files_select_owner_or_coordinator
--      (20260810194000_member_case_files, re-emitted with the two-phase upload
--      guards by 20260905005500_g5_mobile_attachment_two_phase) -- the same
--      case's attachment metadata: filename, size, and the Storage object name.
--   3. private.can_read_member_case_object(text, text) (20260905005500), the
--      predicate behind the storage.objects policy member_case_files_storage_read
--      -- the attachment BYTES. Repairing (2) alone would leave the object
--      downloadable by the name (2) had already handed out.
--   4. policy public.coordinator_case_audit_select_coordinator
--      (20260810200000_coordinator_case_writes:58) -- the immutable coordinator
--      mutation trail, whose after_value carries the note bodies, contact
--      summaries and outcome text verbatim.
--   5. the organization-coordinator branch of policy
--      public.casework_audit_events_staff_read (20260828210000_mi1_casework_suite,
--      re-emitted by 20260907150000_account_lifecycle_manifest:2500) -- an
--      organization coordinator matched on the role alone. Its own
--      private.casework_staff_can_access branch already carried the gate; the
--      role branch bypassed it.
--   6. policy public.member_case_contacts_select_coordinator
--      (20260810200000:54) -- the case's logged contacts.
--   7. policy public.member_case_outcomes_select_coordinator
--      (20260810200000:56) -- the case's recorded outcome.
--
-- 1, 4 and 5 were reported by the PR #2102 / #2103 reviewers; 2, 3, 6 and 7 are
-- the same shape on the same case graph, found while auditing them.
-- public.member_case_assignment_audit is deliberately untouched:
-- member_case_assignment_audit_select_coordinator already resolves its case
-- through an RLS-evaluated public.member_cases subquery, which is the shape
-- adopted below. public.member_case_assignees does not exist -- 20260728170500
-- added assignee columns to member_cases rather than a table.
--
-- Repair. The table policies do not restate the parent's predicate; they
-- require the parent row to be visible. The added EXISTS reads
-- public.member_cases under RLS, so a child row is readable exactly when its
-- case row is readable, for the same actor, under whatever member_cases SELECT
-- policies are in force -- including any later change to them. Each policy's
-- existing scope conjunct is retained on purpose: the EXISTS alone would be a
-- widening, because it is also true for the member who owns the case, and would
-- newly expose every staff-authored note, contact, outcome and attachment on
-- their own case to them.
--
-- The EXISTS cannot recurse. member_cases carries exactly three SELECT policies
-- -- member_cases_select_own, member_cases_select_coordinator and
-- member_cases_select_steward -- plus the restrictive mfa_assurance policy.
-- Between them they read member_cases columns plus private.mfa_satisfied,
-- public.staff_can_see_user, public.member_has_role,
-- private.has_organization_role and private.casework_actor_has_active_grant,
-- all SECURITY DEFINER over auth.sessions / auth.mfa_factors / member_roles /
-- member_role_chapters / member_profiles / organization_role_grants /
-- casework_access_grants. None of them reads member_case_updates or
-- member_case_files, so evaluation cannot re-enter the policy being defined.
-- member_case_updates_select_own and member_case_updates_select_steward have
-- used this same "EXISTS over public.member_cases under RLS" shape since
-- 20260720191847 and 20260808210000 respectively.
--
-- The added EXISTS also imports member_cases' restrictive mfa_assurance, which
-- is not a tightening: member_case_updates and member_case_files each already
-- carry the identical restrictive policy, so an MFA-unsatisfied caller reads
-- neither side today.
--
-- (3) cannot use that shape. It is SECURITY DEFINER and runs as a role that is
-- exempt from row level security, so an EXISTS over member_cases inside it
-- would be unconditionally true. It gets the restriction gate explicitly,
-- through one new definer predicate whose bypass list is the union of the three
-- member_cases SELECT policies' restriction branches.
--
-- (5) is a partial repair by construction. advisor / admin / vp keep their
-- unconditional organization-role read: those three roles are themselves a
-- restriction bypass on member_cases, and they hold no member_cases read at all
-- (member_cases_select_coordinator ANDs staff_can_see_user in), so gating them
-- on case visibility would revoke the audit trail from the very roles the
-- restriction admits. Only the 'coordinator' role moves behind the gate, and
-- case_id IS NULL rows -- retained-case audit, which names no case to consult --
-- keep their current behaviour under both surviving branches.
--
-- Deliberately NOT changed here, and recorded as separate findings rather than
-- silently widened or narrowed by a read-path repair: the coordinator WRITE
-- paths private.coordinator_case_for_update (20260810200000_coordinator_case_writes,
-- behind coordinator_add_case_note / coordinator_log_case_contact /
-- coordinator_record_case_outcome), private.can_write_member_case_object and
-- private.can_delete_member_case_object (20260905005500) still authorize on
-- public.staff_can_see_user alone. A coordinator with no grant can therefore
-- still WRITE to a restricted case they can no longer read.

begin;
set local lock_timeout = '5s';

-- 1. Case notes: the reported defect.
drop policy if exists member_case_updates_select_coordinator on public.member_case_updates;
create policy member_case_updates_select_coordinator on public.member_case_updates
  for select to authenticated using (
    public.staff_can_see_user(user_id, 'coordinator')
    and exists (
      select 1
      from public.member_cases c
      where c.id = member_case_updates.case_id
    )
  );

comment on policy member_case_updates_select_coordinator on public.member_case_updates is
  'Admits a chapter-scoped grievance coordinator to a case note only while the parent case row is itself visible to them under the member_cases policies, so a restricted case''s timeline needs the case''s own coordinator, an organization advisor/admin/vp hat, or an active casework_access_grants row.';

-- 2. Attachment metadata. The owner branch and both two-phase upload guards
--    from 20260905005500 are preserved byte-for-byte; only the coordinator
--    branch gains the parent-visibility requirement.
drop policy if exists member_case_files_select_owner_or_coordinator on public.member_case_files;
create policy member_case_files_select_owner_or_coordinator
  on public.member_case_files for select to authenticated
  using (
    member_case_files.confirmed_at is not null
    and member_case_files.removal_requested_at is null
    and (
      member_case_files.user_id = (select auth.uid())
      or (
        public.staff_can_see_user(member_case_files.user_id, 'coordinator')
        and exists (
          select 1
          from public.member_cases c
          where c.id = member_case_files.case_id
        )
      )
    )
  );

comment on policy member_case_files_select_owner_or_coordinator on public.member_case_files is
  'Admits the case owner to their own confirmed, untombstoned attachments, and a chapter-scoped grievance coordinator only while the parent case row is itself visible to them under the member_cases policies, so a restricted case''s attachment list needs an explicit casework access grant.';

-- 3. Attachment bytes. The definer predicate behind member_case_files_storage_read
--    bypasses RLS, so the gate is stated rather than delegated. The bypass list
--    is the union of the three member_cases SELECT policies' restriction
--    branches: the case owner, the assigned steward, the case's own
--    coordinator, an organization advisor/admin/vp, or an active grant.
create or replace function private.member_case_restriction_cleared(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.member_cases c
    where c.id = p_case_id
      and (
        not c.is_restricted
        or c.user_id = (select auth.uid())
        or c.steward_user_id = (select auth.uid())
        or c.coordinator_user_id = (select auth.uid())
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
        or private.casework_actor_has_active_grant(c.id)
      )
  );
$function$;

comment on function private.member_case_restriction_cleared(uuid) is
  'RLS predicate: the caller clears public.member_cases.is_restricted for this case. For SECURITY DEFINER callers that cannot delegate to the member_cases policies.';

-- No EXECUTE for any client role. Unlike private.casework_actor_has_active_grant
-- this predicate is never named by an authenticated policy; its only caller is
-- private.can_read_member_case_object, which is SECURITY DEFINER and reaches it
-- as the owner. private.casework_member_owns carries the same empty ACL.
revoke all on function private.member_case_restriction_cleared(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.can_read_member_case_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from public.member_case_files f
    where f.bucket_id = p_bucket and f.object_name = p_name
      and f.confirmed_at is not null
      and f.removal_requested_at is null
      and (f.user_id = (select auth.uid())
        or (public.staff_can_see_user(f.user_id, 'coordinator')
          and private.member_case_restriction_cleared(f.case_id)))
  );
$function$;

-- 4. The immutable coordinator mutation trail. Its after_value replays the note
--    bodies, contact summaries and outcome text, so it is the same disclosure
--    as (1), (6) and (7) with an extra hop.
drop policy if exists coordinator_case_audit_select_coordinator on public.coordinator_case_audit;
create policy coordinator_case_audit_select_coordinator on public.coordinator_case_audit
  for select to authenticated using (
    public.staff_can_see_user(user_id, 'coordinator')
    and exists (
      select 1
      from public.member_cases c
      where c.id = coordinator_case_audit.case_id
    )
  );

comment on policy coordinator_case_audit_select_coordinator on public.coordinator_case_audit is
  'Admits a chapter-scoped grievance coordinator to the immutable case mutation trail only while the parent case row is itself visible to them under the member_cases policies; the recorded after_value replays note, contact and outcome text, so a restricted case needs an explicit casework access grant.';

-- 5. The casework audit trail. Only the plain organization-coordinator branch
--    moves behind the gate; see the header for why advisor/admin/vp and the two
--    case_id IS NULL paths keep their current behaviour, and note that the
--    private.casework_staff_can_access branch already carried the restriction
--    gate and is preserved verbatim.
drop policy if exists casework_audit_events_staff_read on public.casework_audit_events;
create policy casework_audit_events_staff_read on public.casework_audit_events
  for select to authenticated using (
    private.has_organization_role(organization_id, array['advisor','admin','vp'])
    or (
      private.has_organization_role(organization_id, array['coordinator'])
      and (
        case_id is null
        or exists (
          select 1
          from public.member_cases c
          where c.id = casework_audit_events.case_id
        )
      )
    )
    or (case_id is not null and private.casework_staff_can_access(case_id))
    or (case_id is null and private.account_lifecycle_retained_case_scope_allows('casework_audit', id::text, chapter_id))
  );

comment on policy casework_audit_events_staff_read on public.casework_audit_events is
  'Authenticated organization staff read audit events only through their organization role, current case authorization, or captured retained-case scope. A plain organization coordinator additionally needs the parent case to be visible under the member_cases policies, so a restricted case''s audit trail requires a casework_access_grants row.';

-- 6/7. The logged contacts and the recorded outcome, both owner-column gated in
--      20260810200000 exactly as the notes were.
drop policy if exists member_case_contacts_select_coordinator on public.member_case_contacts;
create policy member_case_contacts_select_coordinator on public.member_case_contacts
  for select to authenticated using (
    public.staff_can_see_user(user_id, 'coordinator')
    and exists (
      select 1
      from public.member_cases c
      where c.id = member_case_contacts.case_id
    )
  );

comment on policy member_case_contacts_select_coordinator on public.member_case_contacts is
  'Admits a chapter-scoped grievance coordinator to a logged case contact only while the parent case row is itself visible to them under the member_cases policies, so a restricted case''s contact log needs an explicit casework access grant.';

drop policy if exists member_case_outcomes_select_coordinator on public.member_case_outcomes;
create policy member_case_outcomes_select_coordinator on public.member_case_outcomes
  for select to authenticated using (
    public.staff_can_see_user(user_id, 'coordinator')
    and exists (
      select 1
      from public.member_cases c
      where c.id = member_case_outcomes.case_id
    )
  );

comment on policy member_case_outcomes_select_coordinator on public.member_case_outcomes is
  'Admits a chapter-scoped grievance coordinator to a recorded case outcome only while the parent case row is itself visible to them under the member_cases policies, so a restricted case''s outcome needs an explicit casework access grant.';

commit;
