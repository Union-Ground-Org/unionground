-- REQ-UG-DESIGN-BACKEND-P2-20260721 (review fix): the steward desk reads
-- conversations, messages, and requests ordered globally (no user_id filter,
-- because a steward sees the whole chapter). The existing composite indexes
-- lead with user_id and cannot serve those global orderings, so at the live
-- stress scale (~200k conversations/messages) the planner seq-scans and sorts
-- the whole table and the read exceeds the statement timeout. These standalone
-- descending indexes turn each order-by-limit into an index scan.
create index if not exists member_conversations_updated_at_idx on public.member_conversations(updated_at desc);
create index if not exists member_messages_created_at_idx on public.member_messages(created_at desc);
create index if not exists member_steward_requests_created_at_idx on public.member_steward_requests(created_at desc);
