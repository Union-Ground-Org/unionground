-- UX-UG-AUTOMATE-THIS-WORKFLOW-IS-RENDERED-FOR-STEWARDS-COORDINATORS-ADVISORS-BUT-THE-SOURCE-20260921
--
-- 'Automate this workflow' is rendered for stewards, coordinators and
-- advisors, but public.mi1_get_automation_source_context
-- (20260910045839:1329-1339) entered through private.cr108_require_operator()
-- (20260829023000:233 — the admin/vp operator gate). The deep link from a
-- steward's own task board therefore refused the source context and the
-- Recipes tab rendered nothing (ConnectedAutomationPages.jsx gated the recipe
-- library on the read succeeding).
--
-- Repair. Resolve the organization through the shared automation author gate
-- private.automation_v3_require_author() (20260911070000:141 — steward,
-- coordinator, advisor, admin, vp) and check visibility with
-- private.automation_v3_source_visible() (:179), which still refuses any
-- source whose chapter the caller has no chapter staff role on. The chapter
-- lookup union and the 'chapter is null' refusal stay byte-identical, so a
-- hand-edited ?sourceId= for a task outside the caller's chapters still
-- raises the same 42501 'source unavailable'.
begin;

set local lock_timeout = '5s';

create or replace function public.mi1_get_automation_source_context(p_source text,p_source_id text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid:=private.automation_v3_require_author(); chapter text;
begin
 if not private.automation_v3_source_visible(auth.uid(),org,p_source,p_source_id) then raise exception 'source unavailable' using errcode='42501'; end if;
 select s.chapter_id into chapter from (
 select id::text id,chapter_id,'task'::text kind from public.chapter_tasks
 union all select id::text,chapter_id,'case' from public.member_cases
 union all select id::text,chapter_id,'appointment' from public.member_appointments
 union all select id,chapter_id,'event' from public.member_events) s where s.id=p_source_id and s.kind=p_source;
 if chapter is null then raise exception 'source unavailable' using errcode='42501'; end if;
 return jsonb_build_object('organizationId',org,'sourceKind',p_source,'sourceId',p_source_id,'chapterId',chapter); end; $$;

revoke all on function public.mi1_get_automation_source_context(text,text) from public,anon,authenticated,service_role;
grant execute on function public.mi1_get_automation_source_context(text,text) to authenticated;

commit;
