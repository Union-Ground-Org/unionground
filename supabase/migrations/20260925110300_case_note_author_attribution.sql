-- BUG-UG-CASE-HISTORY-STAFF-NOTES-ATTRIBUTED-TO-THE-MEMBER-20260920
--
-- public.member_case_updates.user_id is the case member for every note:
-- coordinator_add_case_note and casework_add_case_note store the case owner
-- there whoever writes the note, and the table had no author column. So
-- public.casework_case_history attributed every staff-written note to the
-- member, with the member role label, for every reader.
--
-- 1. member_case_updates gains author_user_id (auth.users, ON DELETE SET
--    NULL). A BEFORE INSERT OR UPDATE trigger stamps it from the writing
--    session's auth.uid() on insert and afterwards admits only a clear to NULL
--    (account deletion's ON DELETE SET NULL), so no
--    writer or client can choose an author. Both note writers run with the
--    staff caller's session and need no change; a member's own note stamps the
--    member. Rows written with no session (seed and demo jobs) and every row
--    written before this migration stay NULL.
-- 2. casework_case_history projects coalesce(author_user_id, user_id), so a
--    staff note names its staff author, a member note is unchanged, and legacy
--    rows keep their old attribution. Names and role labels still resolve
--    through the unchanged SECURITY INVOKER profile read, the case assignee
--    labels and private.casework_case_actor_roles, so no caller gains a name.
-- 3. Account lifecycle: the new auth.users link joins the case-graph row-key
--    trigger and the lifecycle manifest (pseudonymized by SET NULL; the note
--    stays with the member's case), and the re-created trigger enters the
--    reviewed trigger surface with the new stamp trigger and its function
--    (account deletion's SET NULL on author_user_id fires the stamp).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.member_case_updates
  add column author_user_id uuid references auth.users(id) on delete set null;

create index member_case_updates_author_idx
  on public.member_case_updates (author_user_id)
  where author_user_id is not null;

create function private.stamp_case_update_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    new.author_user_id := (select auth.uid());
  elsif new.author_user_id is not null then
    -- Only account deletion's ON DELETE SET NULL may change the author.
    new.author_user_id := old.author_user_id;
  end if;
  return new;
end;
$function$;

revoke all on function private.stamp_case_update_author() from public, anon, authenticated, service_role;

create trigger member_case_updates_stamp_author
before insert or update on public.member_case_updates
for each row execute function private.stamp_case_update_author();

drop trigger z99_case_graph_keys on public.member_case_updates;
create trigger z99_case_graph_keys before insert or update or delete on public.member_case_updates
for each row execute function private.lock_case_graph_row_keys('{author_user_id},{user_id}', '{case_id}');

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition,
   export_disposition, export_projection, export_inventory_basis,
   export_projection_version, export_domain, export_columns,
   exclusion_reason, note, reviewed_at)
values
  ('public', 'member_case_updates', 'author_user_id', 'pseudonymize',
   'excluded_with_reason', null, 'auth_user_fk',
   null, null, null,
   'The note belongs to the case member''s record and is exported to that member under cases[].updates; the author column is attribution only.',
   'Installed action is ON DELETE SET NULL; a departed author detaches and the note falls back to the case member attribution.',
   date '2026-09-24');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger'
    and schema_name = 'public'
    and table_name = 'member_case_updates'
    and object_name in ('z99_case_graph_keys', 'member_case_updates_stamp_author'))
  or (kind = 'function'
    and schema_name = 'private'
    and object_name = 'stamp_case_update_author()')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

create or replace function public.casework_case_history(p_case_id uuid, p_limit integer default 50, p_before timestamp with time zone default null::timestamp with time zone)
returns table(event_id text, kind text, at timestamp with time zone, actor_user_id uuid, actor_name text, actor_role text, details jsonb)
language sql
stable
set search_path = ''
as $function$
  with events as (
    -- The note author is readable by anyone the row's own RLS already admits.
    -- A note carries its writer in author_user_id (20260925110300); a note
    -- written before that column existed, or by a job with no session, keeps
    -- the case member attribution it always had.
    select 'note:' || n.id event_id, 'note'::text kind, n.created_at at, coalesce(n.author_user_id, n.user_id) actor_user_id,
      pg_catalog.jsonb_build_object('body', n.body) details
    from public.member_case_updates n where n.case_id = p_case_id
    union all
    select 'transition:' || s.id, 'transition', s.created_at, s.transitioned_by,
      pg_catalog.jsonb_build_object('from_step', s.from_step, 'to_step', s.to_step, 'outcome', s.outcome)
    from public.casework_step_transitions s where s.case_id = p_case_id
    union all
    select 'assignment:' || a.id, 'assignment', a.created_at, a.actor_id,
      pg_catalog.jsonb_build_object('before', a.before_assignment, 'after', a.after_assignment)
    from public.member_case_assignment_audit a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select 'coordinator:' || a.id, 'coordinator', a.created_at, a.actor_id,
      pg_catalog.jsonb_build_object('action', a.action, 'before', a.before_value, 'after', a.after_value, 'reason', a.reason)
    from public.coordinator_case_audit a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select 'audit:' || a.id, 'audit', a.created_at, a.actor_user_id,
      pg_catalog.jsonb_build_object('action', a.event_type, 'metadata', a.metadata)
    from public.casework_audit_events a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select * from private.casework_history_versions(p_case_id)
  ), page as (
    select * from events where private.casework_can_read(p_case_id)
      and (p_before is null or events.at < p_before)
    order by events.at desc
    fetch first (greatest(1, least(coalesce(p_limit, 50), 100))) rows with ties
  -- Attribution is resolved under the CALLER's own visibility and nothing
  -- wider. public.member_profiles answers only for the accounts
  -- private.staff_visible_member_ids (the set-wise public.staff_can_see_user)
  -- already exposes, plus the caller's own row; the assignee labels stamped on
  -- public.member_cases are exactly the two staff names a member may already
  -- read on their own case, which is where the case detail's assignee line
  -- comes from. A member therefore names their own steward, their own
  -- coordinator and themselves, and no other staff account. An actor the
  -- caller may not name carries a role label instead: the uuid is never a
  -- display value.
  ), subject as (
    select c.user_id member_user_id, c.steward_user_id, c.steward_name,
      c.coordinator_user_id, c.coordinator_name
    from public.member_cases c where c.id = p_case_id
  -- A ROLE IS NOT ATTRIBUTION. The subject CTE above stays INVOKER because it
  -- carries the two assignee NAMES; a caller who cannot read the case row gets
  -- no names from it, which is the design. The role label is different: it says
  -- only which of three positions an actor the caller is ALREADY looking at
  -- occupies on this case. Deriving it from the same empty INVOKER read made an
  -- organization advisor see every event as 'staff', including the member's own
  -- note. private.casework_case_actor_roles is the definer helper that answers
  -- it, from the case row the existing definer read boundary already consults,
  -- for exactly the actor ids on this caller's own page and nothing else.
  ), roles as (
    select r.actor_user_id role_user_id, r.actor_role role_label
    from private.casework_case_actor_roles(
      p_case_id,
      -- `fetch first N rows with ties` can return more than the clamped page
      -- size, so the distinct actor list is capped here too. The helper's own
      -- guard is the authority; this keeps the reader provably inside it, and
      -- an id beyond the cap degrades to the historical 'staff' fallback below
      -- instead of raising in the feed.
      (select pg_catalog.array_agg(candidate.actor_user_id) from (
        select distinct page.actor_user_id from page
        where page.actor_user_id is not null limit 100
      ) candidate)
    ) r
  )
  select page.event_id, page.kind, page.at, page.actor_user_id,
    nullif(pg_catalog.btrim(coalesce(
      (select p.full_name from public.member_profiles p where p.id = page.actor_user_id),
      (select s.steward_name from subject s where s.steward_user_id = page.actor_user_id),
      (select s.coordinator_name from subject s where s.coordinator_user_id = page.actor_user_id),
      '')), ''),
    case
      when page.actor_user_id is null then null
      else coalesce((select r.role_label from roles r where r.role_user_id = page.actor_user_id), 'staff')
    end,
    page.details
  from page order by page.at desc, page.event_id desc;
$function$;

do $assert_case_update_author_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'account lifecycle deletion inventory is incomplete after the case note author column';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after the case note author column';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the case note author column';
  end if;
end;
$assert_case_update_author_lifecycle$;

notify pgrst, 'reload schema';

commit;
