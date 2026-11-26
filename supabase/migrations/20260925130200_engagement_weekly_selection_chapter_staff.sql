-- Chapter-scoped steward and coordinator hats pass the shell's member_has_role
-- check, so Campaigns -> Engagement mounts, but every staff engagement RPC
-- refused them because private.engagement_require_staff reads only
-- organization_role_grants. Widening that shared guard would admit chapter-only
-- hats to ~30 engagement RPCs that filter only by organization_id (for example
-- transition_organization_live_poll), so this migration leaves it untouched
-- and admits chapter hats only to the seven
-- weekly-question selection/pool RPCs, all of which already lock their reads
-- and writes to private.current_member_chapter().
--
-- private.engagement_require_weekly_selection_staff(org, chapter) keeps the MFA
-- raise and the organization-grant arm, and adds a chapter arm that requires
-- the chapter to be the caller's own selected chapter in org, a
-- member_role_chapters staff grant there (public.member_has_role), and the
-- tenant staff second-factor policy for org. The seven RPCs are re-emitted
-- from their installed definitions (pg_get_functiondef, so the case-graph lock
-- prologue and any newer body are kept) with only the guard call changed; the
-- guard call must occur exactly once in each.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function private.engagement_require_weekly_selection_staff(
  p_organization_id uuid,
  p_chapter_id text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if private.has_organization_role(
    p_organization_id,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    return;
  end if;
  if p_chapter_id is not null
    and p_chapter_id = private.current_member_chapter()
    and private.mi1_w2_same_org_chapter(p_organization_id, p_chapter_id)
    and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and (
      not private.staff_mfa_required(p_organization_id)
      or private.has_second_factor((select auth.uid()))
    )
  then
    return;
  end if;
  raise exception 'not authorized' using errcode = '42501';
end;
$function$;

revoke all on function private.engagement_require_weekly_selection_staff(uuid, text)
  from public, anon, authenticated, service_role;

do $weekly_selection_gate$
declare
  target record;
  old_guard constant text := 'perform private.engagement_require_staff(org);';
  definition text;
  occurrences integer;
begin
  for target in
    select * from (values
      ('public.list_weekly_question_editorial()', 'caller_chapter'),
      ('public.get_weekly_question_selection_workspace()', 'chapter'),
      ('public.list_weekly_question_selection_page(text,timestamp with time zone,uuid,integer)', 'chapter'),
      ('public.save_weekly_question_selection_policy(boolean,integer,integer,integer,text,timestamp with time zone)', 'chapter'),
      ('public.run_weekly_question_selection(uuid)', 'chapter'),
      ('public.review_weekly_poll_question(uuid,text,text)', 'caller_chapter'),
      ('public.publish_weekly_poll_question(uuid,integer)', 'caller_chapter')
    ) weekly(signature, chapter_variable)
  loop
    select pg_catalog.pg_get_functiondef(p.oid) into strict definition
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(target.signature);
    occurrences := (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_guard, ''))) / pg_catalog.length(old_guard);
    if occurrences <> 1
       or pg_catalog.strpos(definition, target.chapter_variable || ' text := private.current_member_chapter();') = 0 then
      raise exception 'weekly selection guard not found exactly once: %', target.signature
        using errcode = '55000';
    end if;
    definition := pg_catalog.replace(
      definition,
      old_guard,
      'perform private.engagement_require_weekly_selection_staff(org, ' || target.chapter_variable || ');'
    );
    execute definition;
  end loop;
end;
$weekly_selection_gate$;

commit;
