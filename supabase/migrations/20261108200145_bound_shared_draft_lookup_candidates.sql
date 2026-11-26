-- BUG-UG-SHARED-DRAFTS-LOOKUP-CHECKS-UNSHARED-FORMS-20261108 (#7618).
-- #7353 bounded the invoker RPC's form reads; #7502 bounded the table policies.
-- The remaining helper could still validate every form before joining shares.
-- Materialize ONLY forms named by the caller's shares in its current scope,
-- then apply the unchanged per-form authorization. The fence prevents join
-- plans from pushing that check back onto unrelated member_forms rows.
-- The public RPC, row policies, signatures and execute boundary stay intact.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.caller_shared_draft_form_ids()'::regprocedure)) <> '521f6313328e8afbfb251b4b770e035d' then
    raise exception 'unreviewed predecessor: private.caller_shared_draft_form_ids' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_shared_member_drafts()'::regprocedure)) <> '43bdb54fd27b023404f5b5a40b08fb02' then
    raise exception 'unreviewed predecessor: public.list_shared_member_drafts' using errcode = '55000';
  end if;
end;
$preflight$;

create or replace function private.caller_shared_draft_form_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $function$
  with caller_forms as materialized (
    select f as form_row
    from private.member_draft_steward_shares share
    join public.member_forms f on f.id = share.form_id
    where share.steward_id = (select auth.uid())
      and share.organization_id = (select private.current_member_organization())
      and share.chapter_id = (select private.current_member_chapter())
  )
  select coalesce(pg_catalog.array_agg((candidate.form_row).id), '{}'::uuid[])
  from caller_forms candidate
  where private.member_draft_shared_to_caller(candidate.form_row);
$function$;
revoke all on function private.caller_shared_draft_form_ids() from public, anon, authenticated, service_role;
grant execute on function private.caller_shared_draft_form_ids() to authenticated;

notify pgrst, 'reload schema';
commit;
