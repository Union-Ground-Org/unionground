-- REQ-UG-STANDARD-TASK-CONTRACT-20260802
-- Cover every new foreign key not already led by a query index. These keep
-- parent updates/deletes and auth-user cleanup from scanning the task tables.

create index chapter_task_comments_author_idx
  on public.chapter_task_comments (author_id);

create index chapter_task_attachments_chapter_idx
  on public.chapter_task_attachments (chapter_id);

create index chapter_task_attachments_created_by_idx
  on public.chapter_task_attachments (created_by);

create index chapter_task_activity_chapter_idx
  on public.chapter_task_activity (chapter_id);

create index chapter_task_activity_actor_idx
  on public.chapter_task_activity (actor_id);
