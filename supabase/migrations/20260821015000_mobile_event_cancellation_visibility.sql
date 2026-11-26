-- Restore the cancellation state that the chapter-scoped event regrant
-- accidentally removed from authenticated column privileges. RLS still
-- decides which events a member or staff account may read; sensitive check-in
-- and reminder columns remain inaccessible.
begin;

revoke select (cancelled_at, cancelled_reason) on public.member_events from anon;
grant select (cancelled_at, cancelled_reason) on public.member_events to authenticated;

comment on column public.member_events.cancelled_at is
  'Soft-cancellation timestamp visible through chapter-scoped RLS.';
comment on column public.member_events.cancelled_reason is
  'Member-safe cancellation explanation visible through chapter-scoped RLS.';

commit;
