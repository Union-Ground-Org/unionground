-- BUG-UG-STEWARD-DESK-SHARED-DRAFTS-CASE-UPDATES-KB-READS-SLOW-AT-SCALE-20261106 (#7353);
-- stamp reserved by .
-- public.list_shared_member_drafts, a read of the steward desk's shared-access
-- panel, took 5.1 s on SAMPLE (Tamarack, 1,002 accounts) and returned an empty
-- list. The body is security invoker, so the planner read every row of
-- public.member_forms and ran the table's row policies (the restrictive
-- private.member_form_scope_and_identity_allowed among them) and
-- private.member_draft_shared_to_caller for each one, although only drafts
-- explicitly shared with the caller can ever qualify.
-- private.caller_shared_draft_form_ids lists those drafts once from
-- private.member_draft_steward_shares (indexed by steward) with the same
-- private.member_draft_shared_to_caller check, and the body reads
-- public.member_forms by primary key for those ids only. The listed ids are a
-- subset of what member_draft_shared_to_caller already admits, the body keeps
-- that check and runs under the same row policies, so rows, columns, order and
-- the 100-row cap are unchanged. The function keeps its name, signature, owner,
-- security invoker status and grants.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Replace only the exact predecessor 20261102005607 installed.
do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_shared_member_drafts()'::regprocedure)) <> '6aad559788966564af90f1472d3a2798' then
    raise exception 'unreviewed predecessor: public.list_shared_member_drafts' using errcode = '55000';
  end if;
end;
$preflight$;

-- The caller's own explicit shares in the current organization and chapter,
-- each still admitted by private.member_draft_shared_to_caller.
create function private.caller_shared_draft_form_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.array_agg(f.id), '{}'::uuid[])
  from private.member_draft_steward_shares share
  join public.member_forms f on f.id = share.form_id
  where share.steward_id = (select auth.uid())
    and share.organization_id = (select private.current_member_organization())
    and share.chapter_id = (select private.current_member_chapter())
    and private.member_draft_shared_to_caller(f);
$function$;
revoke all on function private.caller_shared_draft_form_ids() from public, anon, authenticated, service_role;
grant execute on function private.caller_shared_draft_form_ids() to authenticated;

create or replace function public.list_shared_member_drafts()
returns jsonb language sql stable security invoker set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(draft)),'[]'::jsonb)
  from (select f.id,f.template_key,f.user_id,f.answers,f.updated_at,pg_catalog.to_jsonb(template) as template
    from public.member_forms f join public.form_template_registry template on template.key=f.template_key and template.version=f.template_version
    where f.id = any((select private.caller_shared_draft_form_ids())::uuid[])
      and private.member_draft_shared_to_caller(f)
    order by f.updated_at desc,f.id limit 100) draft;
$function$;
revoke all on function public.list_shared_member_drafts() from public, anon, authenticated, service_role;
grant execute on function public.list_shared_member_drafts() to authenticated;

notify pgrst, 'reload schema';
commit;
