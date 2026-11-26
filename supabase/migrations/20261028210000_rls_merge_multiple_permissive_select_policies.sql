-- PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028 (#6361)
--
-- The Supabase advisor's multiple_permissive_policies lint flagged eleven
-- tables where authenticated SELECT is decided by two or three permissive
-- policies. PostgreSQL ORs permissive policies, so each table's policies are
-- replaced by one permissive SELECT policy whose predicate is the OR of the
-- former predicates, copied from the catalog (pg_get_expr under an empty
-- search_path). The restrictive mfa_assurance and member_pin_step_up policies
-- are untouched, so the visible row sets are unchanged. The member's own-row
-- predicate comes first because it is the cheapest.
--
-- Merged policies (new name: former names):
--   casework_deadlines_select: casework_deadlines_read, casework_deadlines_staff_read
--   chapter_records_select: chapter_records_read_chapter, chapter_records_read_staff
--   member_case_updates_select: member_case_updates_select_own, member_case_updates_select_steward, member_case_updates_select_coordinator
--   member_cases_select: member_cases_select_own, member_cases_select_steward, member_cases_select_coordinator
--   member_conversations_select: member_conversations_select_own, member_conversations_select_steward
--   member_form_cosigners_select: member_form_cosigners_select_filer, member_form_cosigners_select_invitee, member_form_cosigners_select_steward
--   member_forms_select: member_forms_select_own, member_forms_select_cosigner, member_forms_select_steward
--   member_kb_articles_select: member_kb_articles_member_read, member_kb_articles_staff_read
--   member_messages_select: member_messages_select_own, member_messages_select_steward
--   member_profiles_select: member_profiles_select_own, member_profiles_select_steward, member_profiles_select_coordinator
--   member_steward_requests_select: member_steward_requests_select_own, member_steward_requests_select_steward
--
-- Every bare auth.uid() in a policy on the cold Home tables was already
-- wrapped as (select auth.uid()) before this migration; the delivering PR's
-- regression (tests/rls-home-policy-cost-db.test.js) pins that for every
-- policy in the schema.
--
-- The guard refuses to run when a table's permissive SELECT policies are not
-- exactly the reviewed predecessors (name and md5 of the stored predicate).
begin;

-- pg_get_expr qualifies every non-catalog name under this path, exactly as
-- under an empty one (pg_catalog is always searched), so the md5s are stable.
set local search_path = pg_catalog;

do $guard$
declare
  expected constant jsonb := '{"casework_deadlines":{"casework_deadlines_read":"6829615f1b01a407e7a5db70e82294c7","casework_deadlines_staff_read":"f1c9bfe24ef43b597d4ac38754a920e1"},"chapter_records":{"chapter_records_read_chapter":"249f6a3f5ca9adbc599c7ee64ea10bc0","chapter_records_read_staff":"20c59429580b12e16976798198713cb1"},"member_case_updates":{"member_case_updates_select_coordinator":"770429f064a1d354157763d23b06ecf3","member_case_updates_select_own":"1e0f6d07b28f06c944e6fce3fc4b11c2","member_case_updates_select_steward":"b002eefc00048c23198a3e1d04900e61"},"member_cases":{"member_cases_select_coordinator":"3e1831a3a58d4726c1bcd9dc2405675c","member_cases_select_own":"ff452c766f1dd1d84c376129b36406c1","member_cases_select_steward":"2b2635813d276c9f95d9388af58d0c34"},"member_conversations":{"member_conversations_select_own":"ff452c766f1dd1d84c376129b36406c1","member_conversations_select_steward":"4287b8ab0999ce40bf26f21d1b9f70b4"},"member_form_cosigners":{"member_form_cosigners_select_filer":"5f12e8b7f753e96fb552587f5b81e570","member_form_cosigners_select_invitee":"f02047a96a26ddf00c46861acd71300f","member_form_cosigners_select_steward":"39f73e616a4c793cfdd2da836506cc7f"},"member_forms":{"member_forms_select_cosigner":"453627d061ff51b1d1e687f4a1cb0c1a","member_forms_select_own":"ff452c766f1dd1d84c376129b36406c1","member_forms_select_steward":"1fa3d317d7c5a26ef3e89d382ddb065e"},"member_kb_articles":{"member_kb_articles_member_read":"85106ec4451866872372bf994edb2b00","member_kb_articles_staff_read":"1b1d68ea9ff41cda55fd4ff13f093942"},"member_messages":{"member_messages_select_own":"eb1a40bbe4f3a55213616198762bff07","member_messages_select_steward":"4287b8ab0999ce40bf26f21d1b9f70b4"},"member_profiles":{"member_profiles_select_coordinator":"d321bfde026f8ee9a6a0f6cb5bb3b4d4","member_profiles_select_own":"c778c06b8b516cb97a96969fe120a0e0","member_profiles_select_steward":"ec67c82be9848f94b5302041e2a41afa"},"member_steward_requests":{"member_steward_requests_select_own":"ff452c766f1dd1d84c376129b36406c1","member_steward_requests_select_steward":"4287b8ab0999ce40bf26f21d1b9f70b4"}}';
  t text;
  observed jsonb;
begin
  for t in select pg_catalog.jsonb_object_keys(expected) loop
    select coalesce(pg_catalog.jsonb_object_agg(p.polname, pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid))), '{}'::jsonb)
      into observed
      from pg_catalog.pg_policy p
     where p.polrelid = pg_catalog.to_regclass('public.' || t)
       and p.polpermissive and p.polcmd = 'r';
    if observed is distinct from expected -> t then
      raise exception 'public.% permissive SELECT policies drifted from the reviewed predecessors: %', t, observed
        using errcode = '55000';
    end if;
  end loop;
end;
$guard$;

drop policy casework_deadlines_read on public.casework_deadlines;
drop policy casework_deadlines_staff_read on public.casework_deadlines;
create policy casework_deadlines_select on public.casework_deadlines for select to authenticated using (
  (private.casework_can_read(case_id))
  or (private.casework_staff_can_access(case_id))
);
comment on policy casework_deadlines_select on public.casework_deadlines is 'PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: one permissive SELECT policy, the OR of the former casework_deadlines_read; casework_deadlines_staff_read (Restates the SELECT half of the retired casework_deadlines_staff_write FOR ALL policy; deadline creation belongs to the audited public.casework_create_deadline).';

drop policy chapter_records_read_chapter on public.chapter_records;
drop policy chapter_records_read_staff on public.chapter_records;
create policy chapter_records_select on public.chapter_records for select to authenticated using (
  (((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND (lifecycle_status = 'published'::text) AND (visibility = 'chapter'::text) AND (archived_at IS NULL) AND private.can_read_chapter_member_record(chapter_id)))
  or (((archived_at IS NULL) AND private.can_read_chapter_contact_record(chapter_id)))
);
comment on policy chapter_records_select on public.chapter_records is 'PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: one permissive SELECT policy, the OR of the former chapter_records_read_chapter (Members read only published, chapter-visible minutes, decisions, and milestones in their active chapter and organization); chapter_records_read_staff (MFA-satisfied authorized staff read the complete active institutional record workspace for the selected chapter).';

drop policy member_case_updates_select_own on public.member_case_updates;
drop policy member_case_updates_select_steward on public.member_case_updates;
drop policy member_case_updates_select_coordinator on public.member_case_updates;
create policy member_case_updates_select on public.member_case_updates for select to authenticated using (
  (((( SELECT auth.uid() AS uid) = user_id) AND (EXISTS ( SELECT 1
   FROM public.member_cases c
  WHERE ((c.id = member_case_updates.case_id) AND (c.user_id = ( SELECT auth.uid() AS uid)))))))
  or ((public.member_has_role(ARRAY['steward'::text]) AND (EXISTS ( SELECT 1
   FROM public.member_cases c
  WHERE ((c.id = member_case_updates.case_id) AND (c.steward_user_id = ( SELECT auth.uid() AS uid)))))))
  or ((public.staff_can_see_user(user_id, 'coordinator'::text) AND (EXISTS ( SELECT 1
   FROM public.member_cases c
  WHERE (c.id = member_case_updates.case_id)))))
);
comment on policy member_case_updates_select on public.member_case_updates is 'PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: one permissive SELECT policy, the OR of the former member_case_updates_select_own; member_case_updates_select_steward; member_case_updates_select_coordinator (Admits a chapter-scoped grievance coordinator to a case note only while the parent case row is itself visible to them under the member_cases policies, so a restricted case''s timeline needs the case''s own coordinator, an organization advisor/admin/vp hat, or an active casework_access_grants row).';

drop policy member_cases_select_own on public.member_cases;
drop policy member_cases_select_steward on public.member_cases;
drop policy member_cases_select_coordinator on public.member_cases;
create policy member_cases_select on public.member_cases for select to authenticated using (
  ((( SELECT auth.uid() AS uid) = user_id))
  or (((steward_user_id = ( SELECT auth.uid() AS uid)) AND public.member_has_role(ARRAY['steward'::text])))
  or ((public.staff_can_see_user(user_id, 'coordinator'::text) AND private.member_case_row_visible(member_cases.*)))
);
comment on policy member_cases_select on public.member_cases is 'PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: one permissive SELECT policy, the OR of the former member_cases_select_own; member_cases_select_steward; member_cases_select_coordinator (A chapter-scoped coordinator reads a case only while private.member_case_row_visible clears its restriction for them; the predicate is the single source the by-id definer helpers also consume (DEBT-UG-MEMBER-CASE-VISIBILITY-PREDICATE-SINGLE-SOURCE-20260917)).';

drop policy member_conversations_select_own on public.member_conversations;
drop policy member_conversations_select_steward on public.member_conversations;
create policy member_conversations_select on public.member_conversations for select to authenticated using (
  ((( SELECT auth.uid() AS uid) = user_id))
  or ((user_id IN ( SELECT private.staff_visible_member_ids('steward'::text) AS staff_visible_member_ids)))
);
comment on policy member_conversations_select on public.member_conversations is 'PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: one permissive SELECT policy, the OR of the former member_conversations_select_own; member_conversations_select_steward (Steward visibility is the set-wise equivalent of staff_can_see_user).';

drop policy member_form_cosigners_select_filer on public.member_form_cosigners;
drop policy member_form_cosigners_select_invitee on public.member_form_cosigners;
drop policy member_form_cosigners_select_steward on public.member_form_cosigners;
create policy member_form_cosigners_select on public.member_form_cosigners for select to authenticated using (
  (public.form_is_owned_by_caller(form_id))
  or (((cosigner_user_id = ( SELECT auth.uid() AS uid)) OR (lower(invited_email) = lower(COALESCE(( SELECT auth.email() AS email), ''::text)))))
  or (((status = 'accepted'::text) AND private.form_is_alliance_reviewable(form_id) AND public.form_owner_in_steward_scope(form_id)))
);
comment on policy member_form_cosigners_select on public.member_form_cosigners is 'PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: one permissive SELECT policy, the OR of the former member_form_cosigners_select_filer; member_form_cosigners_select_invitee; member_form_cosigners_select_steward (Only accepted co-signers of reviewable alliance forms in the caller''s steward scope; the review-state lookup stays private to avoid a public cross-tenant oracle).';

drop policy member_forms_select_own on public.member_forms;
drop policy member_forms_select_cosigner on public.member_forms;
drop policy member_forms_select_steward on public.member_forms;
create policy member_forms_select on public.member_forms for select to authenticated using (
  ((( SELECT auth.uid() AS uid) = user_id))
  or (((template_key = 'alliance_grievance'::text) AND public.caller_is_accepted_cosigner(id)))
  or (((status = ANY (ARRAY['submitted'::text, 'in_review'::text])) AND (user_id IN ( SELECT private.staff_visible_member_ids('steward'::text) AS staff_visible_member_ids))))
);
comment on policy member_forms_select on public.member_forms is 'PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: one permissive SELECT policy, the OR of the former member_forms_select_own; member_forms_select_cosigner; member_forms_select_steward (Active-review allow-list plus set-wise steward visibility).';

drop policy member_kb_articles_member_read on public.member_kb_articles;
drop policy member_kb_articles_staff_read on public.member_kb_articles;
create policy member_kb_articles_select on public.member_kb_articles for select to authenticated using (
  ((private.compass_article_scope_current(member_kb_articles.*) AND (private.compass_scope_specificity(compass_organization_id, compass_scope_path, compass_scope_level) > 0) AND (NOT is_sample) AND (status = 'published'::text) AND (verified_by IS NOT NULL) AND (verified_at IS NOT NULL) AND private.knowledge_article_content_current(member_kb_articles.*) AND private.compass_article_classification_current(member_kb_articles.*)))
  or (((chapter_id = private.current_member_chapter()) AND (NOT is_sample) AND public.member_has_role(ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text]) AND private.knowledge_article_content_current(member_kb_articles.*)))
);
comment on policy member_kb_articles_select on public.member_kb_articles is 'PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: one permissive SELECT policy, the OR of the former member_kb_articles_member_read (Member knowledge reads require the active organization and verified membership scope intersection, current canonical path, publication, source verdict and ingestion classification); member_kb_articles_staff_read.';

drop policy member_messages_select_own on public.member_messages;
drop policy member_messages_select_steward on public.member_messages;
create policy member_messages_select on public.member_messages for select to authenticated using (
  (((( SELECT auth.uid() AS uid) = user_id) AND (EXISTS ( SELECT 1
   FROM public.member_conversations c
  WHERE ((c.id = member_messages.conversation_id) AND (c.user_id = ( SELECT auth.uid() AS uid)))))))
  or ((user_id IN ( SELECT private.staff_visible_member_ids('steward'::text) AS staff_visible_member_ids)))
);
comment on policy member_messages_select on public.member_messages is 'PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: one permissive SELECT policy, the OR of the former member_messages_select_own; member_messages_select_steward (Steward visibility is the set-wise equivalent of staff_can_see_user).';

drop policy member_profiles_select_own on public.member_profiles;
drop policy member_profiles_select_steward on public.member_profiles;
drop policy member_profiles_select_coordinator on public.member_profiles;
create policy member_profiles_select on public.member_profiles for select to authenticated using (
  ((( SELECT auth.uid() AS uid) = id))
  or ((id IN ( SELECT private.staff_visible_member_ids('steward'::text) AS staff_visible_member_ids)))
  or ((id IN ( SELECT private.staff_visible_member_ids('coordinator'::text) AS staff_visible_member_ids)))
);
comment on policy member_profiles_select on public.member_profiles is 'PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: one permissive SELECT policy, the OR of the former member_profiles_select_own; member_profiles_select_steward (Steward name lookups use the set-wise equivalent of staff_can_see_user); member_profiles_select_coordinator (Coordinator name lookups use the set-wise equivalent of staff_can_see_user).';

drop policy member_steward_requests_select_own on public.member_steward_requests;
drop policy member_steward_requests_select_steward on public.member_steward_requests;
create policy member_steward_requests_select on public.member_steward_requests for select to authenticated using (
  ((( SELECT auth.uid() AS uid) = user_id))
  or ((user_id IN ( SELECT private.staff_visible_member_ids('steward'::text) AS staff_visible_member_ids)))
);
comment on policy member_steward_requests_select on public.member_steward_requests is 'PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: one permissive SELECT policy, the OR of the former member_steward_requests_select_own; member_steward_requests_select_steward (Steward visibility is the set-wise equivalent of staff_can_see_user).';

commit;
