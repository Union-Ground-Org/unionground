begin;

-- SEC-UG-POST-BODY-MUTATION-AUDIT-20260904 — revoke branch.
--
-- 20260727211853_full_product_completion.sql granted `authenticated` UPDATE on
-- (body, edited_at, deleted_at) of public.chapter_thread_posts and created
-- chapter_thread_posts_update_own, so any author could PATCH a delivered post
-- body through PostgREST. No client ever exposed that capability, no revision
-- history was ever written, and edited_at / deleted_at were never read by any
-- surface: the grant is a live silent-rewrite capability with no audit.
--
-- Three facts decide the branch:
--   1. supabase_realtime carries chapter_thread_posts INSERT-only
--      (20260820150000 / db-contract publication). A body rewrite is therefore
--      invisible to every already-subscribed reader — the rewritten row only
--      appears on the next full fetch, so two participants can hold different
--      texts of the same post with no signal at all.
--   2. private.stamp_channel_post_author() preserves author identity on UPDATE,
--      so a rewrite keeps the original byline. The rewrite is attributable to
--      nobody and dated to the original post.
--   3. There is no prior-value store, so a rewrite is unrecoverable.
--
-- Under a best-practice default the correct move is to close the capability
-- now and ship a complete edit contract deliberately (bounded eligibility,
-- immutable prior-value evidence, edited markers, realtime and notification
-- semantics) rather than leave an unaudited one standing while that contract
-- is designed. This migration is that closure.
--
-- WHAT SURVIVES: insert (thread_id, body, parent_post_id) and select. Posting
-- and reading are unchanged. Nothing in the product loses a working control,
-- because nothing in the product used the update grant.
--
-- WHAT REFERENTIAL MAINTENANCE STILL DOES: the guard below inspects only body,
-- edited_at and deleted_at. chapter_thread_posts carries author_id ON DELETE
-- SET NULL to auth.users, parent_post_id ON DELETE SET NULL to itself, and
-- chapter_id ON UPDATE CASCADE to public.chapters, and PostgreSQL performs each
-- of those as a real UPDATE that fires this trigger. Member account deletion,
-- the deletion of a post that has replies, and the SAMPLE/demo teardowns
-- therefore keep working; tests/chapter-post-referential-maintenance-db.test.js
-- proves it against a live disposable stack.
--
-- HOW THE EDIT CONTRACT TURNS BACK ON: private.chapter_post_edit_contract_active()
-- is the single switch point. It returns false today. A future contract
-- migration replaces that function with its real predicate AND supplies the
-- revision store, the edited marker projection and the re-grant. The guard
-- trigger below refuses body mutation from every path — including
-- service_role and any future definer function — while the switch is false,
-- so the contract cannot be half-shipped.
--
-- ROLLBACK (only with a deliberate, reviewed decision to restore an unaudited
-- rewrite capability — do not use this to unblock an edit feature; ship the
-- contract instead):
--   drop trigger chapter_thread_posts_guard_body_mutation on public.chapter_thread_posts;
--   drop function private.guard_chapter_post_body_mutation();
--   drop function private.chapter_post_edit_contract_active();
--   grant update (body, edited_at, deleted_at) on public.chapter_thread_posts to authenticated;
--   create policy chapter_thread_posts_update_own on public.chapter_thread_posts for update to authenticated
--     using (author_id = (select auth.uid()))
--     with check (author_id = (select auth.uid()) and chapter_id = private.current_member_chapter());
--   notify pgrst, 'reload schema';

set local lock_timeout = '5s';

-- Refuse loudly rather than silently no-op if the table this closes is absent.
do $$
begin
  if pg_catalog.to_regclass('public.chapter_thread_posts') is null then
    raise exception 'public.chapter_thread_posts is missing; apply 20260727211853_full_product_completion first'
      using errcode = '42P01';
  end if;
end
$$;

revoke update on public.chapter_thread_posts from authenticated;
drop policy chapter_thread_posts_update_own on public.chapter_thread_posts;

comment on column public.chapter_thread_posts.edited_at is
  'Reserved for the future edit contract. No path writes it while private.chapter_post_edit_contract_active() is false; readers must not treat null as "never edited" evidence for a period during which edits were impossible.';
comment on column public.chapter_thread_posts.deleted_at is
  'Reserved for the future post-removal contract. No path writes it while private.chapter_post_edit_contract_active() is false.';

-- The single switch point. False until a reviewed edit contract ships with a
-- revision store, edited-marker projection, realtime/notification semantics and
-- server-side eligibility. Immutable so the planner can fold it, and executable
-- by nobody: only the trigger below (a definer-free trigger running as the
-- table owner) consults it.
create function private.chapter_post_edit_contract_active()
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select false;
$function$;

comment on function private.chapter_post_edit_contract_active() is
  'SEC-UG-POST-BODY-MUTATION-AUDIT: returns false until a complete chapter-post edit contract ships. Replacing this with a real predicate without also shipping revision storage and edited-marker rendering reopens a silent-rewrite capability.';

revoke all on function private.chapter_post_edit_contract_active()
  from public, anon, authenticated, service_role;

create function private.guard_chapter_post_body_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if private.chapter_post_edit_contract_active() then
    return new;
  end if;
  -- SCOPE: exactly the three columns the retired UPDATE grant covered. The
  -- identity columns are deliberately NOT restated here, and removing them is
  -- the whole point of this comment.
  --
  -- public.chapter_thread_posts carries three referential actions that
  -- PostgreSQL implements as REAL UPDATEs on this table, and such an UPDATE
  -- fires ordinary row triggers:
  --   author_id      references auth.users(id)                   on delete set null
  --                  (set that way by 20260812180000_member_account_lifecycle)
  --   parent_post_id references public.chapter_thread_posts(id)  on delete set null
  --   chapter_id     references public.chapters(id)              on update cascade
  -- A guard that refused those columns would refuse member account deletion
  -- for anyone who has ever posted in a chapter thread, refuse the deletion of
  -- any post that has replies, and refuse a chapter-id rename — the exact
  -- hazard 20260812180000's own header describes ("A referential ON DELETE SET
  -- NULL is also an UPDATE, however, so the old implementation restored the
  -- deleted UUID inside the cascade and made the auth-user delete fail").
  --
  -- Identity stays immutable without this guard's help. No role can name those
  -- columns in an UPDATE — the grant is revoked outright above and the INSERT
  -- grant does not carry UPDATE — and private.stamp_product_identity() restores
  -- thread_id / chapter_id / author_id / created_at on every ordinary UPDATE,
  -- permitting a null author only inside a nested referential action whose
  -- referenced auth.users row is already gone. parent_post_id is the one column
  -- that stamp does not restore: it is grantable on INSERT only, no definer
  -- function writes it, and re-parenting a reply is not content, so the revoked
  -- grant is its whole protection. This guard adds what stamp cannot: a refusal
  -- that also binds the table owner, service_role and any future definer
  -- function, for the three content columns.
  if new.body is distinct from old.body
     or new.edited_at is distinct from old.edited_at
     or new.deleted_at is distinct from old.deleted_at then
    raise exception 'chapter post body mutation is not permitted'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

comment on function private.guard_chapter_post_body_mutation() is
  'SEC-UG-POST-BODY-MUTATION-AUDIT: refuses every body and tombstone mutation on chapter_thread_posts (body, edited_at, deleted_at), from any role including service_role, until the edit contract switch is true. It deliberately does not inspect identity columns: author_id, parent_post_id and chapter_id carry referential actions that PostgreSQL performs as row-trigger-firing UPDATEs, so comparing them would refuse account deletion, the deletion of a post that has replies, and a chapter-id rename. private.stamp_product_identity restores thread_id/chapter_id/author_id/created_at on every ordinary UPDATE; parent_post_id is protected by the revoked grant alone.';

revoke all on function private.guard_chapter_post_body_mutation()
  from public, anon, authenticated, service_role;

-- Fires before chapter_thread_posts_stamp_author (g < s) so a rejected write
-- never reaches the identity stamp.
create trigger chapter_thread_posts_guard_body_mutation
  before update on public.chapter_thread_posts
  for each row execute function private.guard_chapter_post_body_mutation();

notify pgrst, 'reload schema';

commit;
