-- BUG-UG-DUES-SUMMARY-TOTALS-FILTERED-SUBSET-20260921
--
-- Restore the staff Dues workspace header totals to the full-org standing.
-- 20260831170400 computed outstandingCents, overdueCents, collectedCents and
-- memberCount from the `calculated` CTE. 20260831211500 kept that CTE chain
-- but pointed the four summary aggregates at `filtered`, so a status, name or
-- due-on filter silently rewrote the header cards (paid filter -> $0
-- outstanding; name search -> memberCount 1).
--
-- Re-emit public.get_dues_workspace with the current body unchanged except
-- that those four aggregates read from `classified` (the full-org standing,
-- equivalent to `calculated` plus the standing column). overdueCents keeps
-- `due_on < current_date` over `classified`. The filtered/page/visible CTEs,
-- the obligations page, nextCursor, chapters and provider projection stay as
-- they are. Signature, SECURITY DEFINER, `set search_path = ''` and EXECUTE
-- grants are unchanged (CREATE OR REPLACE preserves ACLs).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_dues_workspace(
  p_query text default null,
  p_status text default null,
  p_due_on date default null,
  p_after_id uuid default null,
  p_limit integer default 25,
  p_selected_hat text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  query_value text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
  limit_value integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if query_value is not null and pg_catalog.char_length(query_value) > 120 then
    raise exception 'dues search too long' using errcode = '22023';
  end if;
  if p_status is not null
     and p_status not in ('open', 'partial', 'overdue', 'paid', 'waived') then
    raise exception 'invalid dues status' using errcode = '22023';
  end if;
  return (
    with calculated as (
      select obligation.*, batch.title as assessment_title, subject.user_id,
        coalesce(profile.full_name, 'Member') as member_label,
        coalesce((
          select sum(case event.event_kind
            when 'payment' then event.amount_cents
            when 'waiver' then event.amount_cents
            when 'credit_adjustment' then event.amount_cents
            when 'debit_adjustment' then -event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as settled_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'payment')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as paid_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'waiver')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as waived_cents,
        coalesce((
          select sum(case event.event_kind
            when 'credit_adjustment' then -event.amount_cents
            when 'debit_adjustment' then event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as adjustment_cents
      from public.dues_obligations obligation
      join public.dues_assessment_batches batch
        on batch.organization_id = obligation.organization_id
       and batch.id = obligation.batch_id
      join public.dues_member_subjects subject
        on subject.organization_id = obligation.organization_id
       and subject.id = obligation.member_subject_id
      left join public.member_profiles profile on profile.id = subject.user_id
      where obligation.organization_id = org
    ), classified as (
      select *, case
        when issued_cents - settled_cents <= 0
          and waived_cents > 0 and paid_cents = 0 then 'waived'
        when issued_cents - settled_cents <= 0 then 'paid'
        when paid_cents > 0 or waived_cents > 0
          or adjustment_cents < 0 then 'partial'
        when due_on < current_date then 'overdue'
        else 'open'
      end as standing
      from calculated
    ), filtered as (
      select * from classified
      where (p_due_on is null or due_on = p_due_on)
        and (p_status is null or standing = p_status)
        and (query_value is null
          or member_label ilike '%' || query_value || '%' escape '\'
          or assessment_title ilike '%' || query_value || '%' escape '\')
    ), page as (
      select * from filtered
      where p_after_id is null or id > p_after_id
      order by id
      limit limit_value + 1
    ), visible as (
      select * from page order by id limit limit_value
    )
    select pg_catalog.jsonb_build_object(
      'state', 'ready',
      'staff', true,
      'summary', pg_catalog.jsonb_build_object(
        'outstandingCents', coalesce((
          select sum(greatest(issued_cents - settled_cents, 0)) from classified
        ), 0),
        'overdueCents', coalesce((
          select sum(greatest(issued_cents - settled_cents, 0))
          from classified where due_on < current_date
        ), 0),
        'collectedCents', coalesce((select sum(paid_cents) from classified), 0),
        'memberCount', (select count(distinct member_subject_id) from classified)
      ),
      'obligations', pg_catalog.jsonb_build_object(
        'items', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', id,
            'memberSubjectId', member_subject_id,
            'memberLabel', member_label,
            'assessmentTitle', assessment_title,
            'issuedCents', issued_cents,
            'settledCents', settled_cents,
            'balanceCents', greatest(issued_cents - settled_cents, 0),
            'dueOn', due_on,
            'standing', standing,
            'chapterId', chapter_id
          ) order by id) from visible
        ), '[]'::jsonb),
        'nextCursor', case
          when (select count(*) from page) > limit_value
          then (select id from visible order by id desc limit 1)
          else null
        end
      ),
      'chapters', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', chapter.id, 'name', chapter.name
        ) order by chapter.name)
        from public.chapters chapter
        where chapter.organization_id = org
      ), '[]'::jsonb),
      'provider', private.dues_provider_projection(org)
    )
  );
end;
$function$;

comment on function public.get_dues_workspace(text, text, date, uuid, integer, text) is
  'Staff Dues workspace. Header summary aggregates outstandingCents, overdueCents, collectedCents and memberCount over the full-org classified standing so status, name and due-on filters change only the obligation list; SECURITY DEFINER with an empty search_path, reachable by authenticated financial hats.';

notify pgrst, 'reload schema';

commit;
