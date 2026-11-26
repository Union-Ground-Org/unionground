-- SEC-UG-CHAPTER-CONTACT-LOG-IMMUTABLE-HISTORY-20260921
--
-- save_chapter_contact_log currently overwrites the live chapter_contact_log
-- row on edit, archive, and unarchive, and inserts create rows with no
-- prior-image. This migration appends an access-controlled immutable version
-- and a bounded actor/action audit event on every create, edit, archive, and
-- unarchive transition. The audit payload is actor, action, contact_id, and
-- timestamp only; the free-text summary stays on the version snapshot.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.chapter_contact_log_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  contact_id uuid not null references public.chapter_contact_log(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  version integer not null check (version > 0),
  subject_user_id uuid,
  contact_kind text not null check (contact_kind in ('member', 'management', 'community', 'provider', 'other')),
  channel text not null check (channel in ('in_person', 'phone', 'email', 'message', 'meeting', 'other')),
  purpose text not null check (pg_catalog.char_length(pg_catalog.btrim(purpose)) between 1 and 160),
  summary text not null check (pg_catalog.char_length(pg_catalog.btrim(summary)) between 1 and 4000),
  outcome text check (outcome is null or pg_catalog.char_length(outcome) <= 1000),
  occurred_at timestamptz not null,
  follow_up_at timestamptz,
  case_id uuid,
  task_id uuid,
  archived_at timestamptz,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default pg_catalog.now(),
  unique (contact_id, version)
);

create index chapter_contact_log_versions_contact_version_idx
  on public.chapter_contact_log_versions (contact_id, version desc);

comment on table public.chapter_contact_log_versions is
  'Insert-only immutable snapshots of chapter contact-log rows. Writes travel only through save_chapter_contact_log; authenticated clients may SELECT chapter-scoped rows and have no INSERT/UPDATE/DELETE grant.';

comment on column public.chapter_contact_log_versions.changed_by is
  'Actor who produced this snapshot. ON DELETE SET NULL so version history outlives the actor account.';

alter table public.chapter_contact_log_versions enable row level security;

create policy mfa_assurance on public.chapter_contact_log_versions
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

comment on policy mfa_assurance on public.chapter_contact_log_versions is
  'Restrictive MFA floor on every RLS-enabled public table. Direct INSERT/UPDATE/DELETE grants stay revoked.';

create policy chapter_contact_log_versions_staff_read on public.chapter_contact_log_versions
  for select to authenticated
  using (private.can_read_chapter_contact_record(chapter_id));

comment on policy chapter_contact_log_versions_staff_read on public.chapter_contact_log_versions is
  'Chapter-scoped SELECT for the same staff readers as the live contact log. No UPDATE or DELETE policy exists.';

revoke all on public.chapter_contact_log_versions from public, anon, authenticated, service_role;
grant select on public.chapter_contact_log_versions to authenticated;

create trigger a00_case_graph_lock before insert or update or delete on public.chapter_contact_log_versions
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_contact_log_versions
for each row execute function private.lock_case_graph_row_keys('{changed_by}', '');

create table private.chapter_contact_log_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  contact_id uuid not null,
  actor_id uuid,
  action text not null check (action in ('created', 'edited', 'archived', 'unarchived')),
  created_at timestamptz not null default pg_catalog.now()
);

create index chapter_contact_log_audit_contact_created_idx
  on private.chapter_contact_log_audit (contact_id, created_at desc, id desc);

comment on table private.chapter_contact_log_audit is
  'Bounded contact-log transition audit. Payload is actor, action, contact_id, and timestamp only; never the free-text summary. Written only by save_chapter_contact_log.';

alter table private.chapter_contact_log_audit enable row level security;
revoke all on private.chapter_contact_log_audit from public, anon, authenticated, service_role;

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, exclusion_reason, note, reviewed_at)
values
  ('public', 'chapter_contact_log_versions', 'changed_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk',
   'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.',
   'Attribution column on immutable chapter contact-log versions; installed action is ON DELETE SET NULL so the version history outlives the actor account.',
   current_date);

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'public' and table_name = 'chapter_contact_log_versions'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_chapter_contact_log_versions_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after chapter contact-log immutable history';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after chapter contact-log immutable history';
  end if;
end;
$assert_chapter_contact_log_versions_trigger_review$;

create or replace function public.save_chapter_contact_log(
  p_contact_id uuid,
  p_contact_kind text,
  p_channel text,
  p_purpose text,
  p_summary text,
  p_outcome text,
  p_occurred_at timestamptz,
  p_follow_up_at timestamptz default null,
  p_subject_user_id uuid default null,
  p_case_id uuid default null,
  p_task_id uuid default null,
  p_archive boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare ctx record; saved public.chapter_contact_log%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);
  if p_contact_kind not in ('member','management','community','provider','other')
     or p_channel not in ('in_person','phone','email','message','meeting','other')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose, ''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, ''))) not between 1 and 4000
     or pg_catalog.char_length(coalesce(p_outcome, '')) > 1000
     or p_occurred_at is null or (p_follow_up_at is not null and p_follow_up_at < p_occurred_at) then
    raise exception 'invalid contact log' using errcode = '22023';
  end if;
  if p_subject_user_id is not null and not exists (
    select 1 from public.member_chapter_memberships cm where cm.chapter_id = ctx.chapter_id and cm.user_id = p_subject_user_id and cm.status = 'active'
  ) then raise exception 'contact subject is outside this chapter' using errcode = '42501'; end if;
  if p_case_id is not null and not exists (
    select 1 from public.member_cases c join public.member_profiles p on p.id = c.user_id
    where c.id = p_case_id and p.chapter_id = ctx.chapter_id
  ) then raise exception 'case is outside this chapter' using errcode = '42501'; end if;
  if p_task_id is not null and not exists (
    select 1 from public.chapter_tasks t where t.id = p_task_id and t.chapter_id = ctx.chapter_id
  ) then raise exception 'task is outside this chapter' using errcode = '42501'; end if;

  if p_contact_id is null then
    insert into public.chapter_contact_log (
      organization_id, chapter_id, subject_user_id, contact_kind, channel, purpose, summary,
      outcome, occurred_at, follow_up_at, case_id, task_id, created_by, updated_by, archived_at
    ) values (
      ctx.organization_id, ctx.chapter_id, p_subject_user_id, p_contact_kind, p_channel,
      pg_catalog.btrim(p_purpose), pg_catalog.btrim(p_summary), nullif(pg_catalog.btrim(p_outcome), ''),
      p_occurred_at, p_follow_up_at, p_case_id, p_task_id, ctx.caller_id, ctx.caller_id,
      case when p_archive then pg_catalog.now() end
    ) returning * into saved;
    insert into public.chapter_contact_log_versions (
      contact_id, chapter_id, version, subject_user_id, contact_kind, channel, purpose, summary,
      outcome, occurred_at, follow_up_at, case_id, task_id, archived_at, changed_by, changed_at
    ) values (
      saved.id, saved.chapter_id, 1, saved.subject_user_id, saved.contact_kind, saved.channel,
      saved.purpose, saved.summary, saved.outcome, saved.occurred_at, saved.follow_up_at,
      saved.case_id, saved.task_id, saved.archived_at, ctx.caller_id, pg_catalog.now()
    );
    insert into private.chapter_contact_log_audit (contact_id, actor_id, action, created_at)
    values (saved.id, ctx.caller_id, 'created', pg_catalog.now());
  else
    with pre as (
      select *
      from public.chapter_contact_log l
      where l.id = p_contact_id
        and l.organization_id = ctx.organization_id
        and l.chapter_id = ctx.chapter_id
      for update
    ),
    written as (
      update public.chapter_contact_log l set
        subject_user_id = p_subject_user_id, contact_kind = p_contact_kind, channel = p_channel,
        purpose = pg_catalog.btrim(p_purpose), summary = pg_catalog.btrim(p_summary),
        outcome = nullif(pg_catalog.btrim(p_outcome), ''), occurred_at = p_occurred_at,
        follow_up_at = p_follow_up_at, case_id = p_case_id, task_id = p_task_id,
        updated_by = ctx.caller_id, updated_at = pg_catalog.now(),
        archived_at = case when p_archive then pg_catalog.now() else null end
      from pre
      where l.id = pre.id
      returning l.*
    ),
    versioned as (
      insert into public.chapter_contact_log_versions (
        contact_id, chapter_id, version, subject_user_id, contact_kind, channel, purpose, summary,
        outcome, occurred_at, follow_up_at, case_id, task_id, archived_at, changed_by, changed_at
      )
      select
        pre.id,
        pre.chapter_id,
        (select coalesce(max(v.version), 0) + 1 from public.chapter_contact_log_versions v where v.contact_id = pre.id),
        pre.subject_user_id, pre.contact_kind, pre.channel, pre.purpose, pre.summary, pre.outcome,
        pre.occurred_at, pre.follow_up_at, pre.case_id, pre.task_id, pre.archived_at,
        ctx.caller_id, pg_catalog.now()
      from pre
      returning contact_id
    ),
    audited as (
      insert into private.chapter_contact_log_audit (contact_id, actor_id, action, created_at)
      select
        written.id,
        ctx.caller_id,
        case
          when pre.archived_at is null and written.archived_at is not null then 'archived'
          when pre.archived_at is not null and written.archived_at is null then 'unarchived'
          else 'edited'
        end,
        pg_catalog.now()
      from pre
      cross join written
      returning contact_id
    )
    select written.* into saved
    from written
    left join versioned on true
    left join audited on true;
    if saved.id is null then raise exception 'contact log not found' using errcode = 'P0002'; end if;
  end if;
  return pg_catalog.to_jsonb(saved);
end;
$function$;

revoke all on function public.save_chapter_contact_log(uuid,text,text,text,text,text,timestamptz,timestamptz,uuid,uuid,uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.save_chapter_contact_log(uuid,text,text,text,text,text,timestamptz,timestamptz,uuid,uuid,uuid,boolean) to authenticated;

comment on function public.save_chapter_contact_log(uuid,text,text,text,text,text,timestamptz,timestamptz,uuid,uuid,uuid,boolean) is
  'Staff-only cross-purpose contact ledger mutation with tenant, chapter, subject, case, and task scope checks. Every create, edit, archive, and unarchive appends an immutable version and a bounded actor/action audit event.';

notify pgrst, 'reload schema';

commit;
