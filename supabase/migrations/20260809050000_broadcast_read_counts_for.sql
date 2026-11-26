-- Steward desk paging, sol follow-up (UB-DESK-01, PR #734 review finding F7):
-- get_broadcast_read_counts() aggregates the newest 20 broadcasts only, so a
-- broadcast reached by paging or search past that window rendered with its
-- read count silently missing — "not counted" as the quiet face of "not in
-- the newest twenty". This variant counts receipts for EXACTLY the ids of
-- the page being rendered.
--
-- SECURITY DEFINER like the original, and for the same reason:
-- member_broadcast_receipts is self-scoped RLS (a member sees only their own
-- receipt), so an invoker aggregate would count at most one row. The steward
-- gate raises 42501 (this wave's convention — the desk must never mistake
-- "not allowed" for "nobody read it"), and the id list is bounded to the
-- broadcast pager's own cap.
create function public.get_broadcast_read_counts_for(p_broadcast_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_broadcast_ids is null
     or pg_catalog.cardinality(p_broadcast_ids) < 1
     or pg_catalog.cardinality(p_broadcast_ids) > 100 then
    raise exception 'between 1 and 100 broadcast ids' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'broadcastId', b.id,
      'readCount', (select count(*) from public.member_broadcast_receipts reads where reads.broadcast_id = b.id)
    ) order by b.published_at desc
  ), '[]'::jsonb)
  into result
  from public.member_broadcasts b
  where b.id = any(p_broadcast_ids);

  return result;
end;
$$;

revoke all on function public.get_broadcast_read_counts_for(text[]) from public, anon;
grant execute on function public.get_broadcast_read_counts_for(text[]) to authenticated, service_role;
