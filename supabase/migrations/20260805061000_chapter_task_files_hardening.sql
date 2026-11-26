-- Hardening pass on 20260805051500 (adversarial-review findings, applied as a
-- separate migration so the recorded history of the original stays
-- byte-identical).
--
-- 1. Write capability was uploader-identity alone: a registrant who lost the
--    staff role (or whose task was deleted) could still upload to or delete
--    their previously registered path. The write helper now re-checks the
--    staff role, chapter membership, and live-task status at USE time.
-- 2. Both helpers are declared STABLE so the planner may cache them within a
--    statement instead of re-executing per candidate row.

create or replace function private.can_read_chapter_task_object(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.chapter_task_files f
    join public.chapter_tasks t on t.id = f.task_id and t.deleted_at is null
    join public.member_profiles p
      on p.id = (select auth.uid())
     and p.chapter_id = t.chapter_id
    where f.bucket_id = p_bucket
      and f.object_name = p_name
  );
$$;

create or replace function private.can_write_chapter_task_object(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.chapter_task_files f
    join public.chapter_tasks t on t.id = f.task_id and t.deleted_at is null
    join public.member_profiles p
      on p.id = (select auth.uid())
     and p.chapter_id = t.chapter_id
    where f.bucket_id = p_bucket
      and f.object_name = p_name
      and f.uploaded_by = (select auth.uid())
  )
  and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']);
$$;
