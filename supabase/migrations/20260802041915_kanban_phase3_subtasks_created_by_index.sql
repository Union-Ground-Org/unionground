-- REQ-UG-KANBAN-PHASE3-20260801
-- Cover the created_by foreign key used by auth.users ON DELETE SET NULL.

set local lock_timeout = '5s';

create index chapter_task_subtasks_created_by_idx
  on public.chapter_task_subtasks (created_by);
