-- CR-084: provider-independent, organization-scoped dues ledger foundation.
--
-- This migration deliberately creates no organization, user, payment account,
-- or fictional record. Every tenant is derived from the authenticated session.
-- The optional provider is represented as unset in the read model until the
-- separate provider migration is deployed and an organization activates it.

begin;

set local lock_timeout = '5s';

-- Chapters have globally unique opaque identifiers today. This additional
-- candidate key makes every Dues relation that carries both keys reject a
-- chapter from another organization at the database boundary.
create unique index if not exists chapters_organization_id_id_dues_key
  on public.chapters (organization_id, id)
  where organization_id is not null;

create table public.dues_member_subjects (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, id),
  unique (organization_id, user_id)
);

create table public.dues_assessment_batches (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text,
  title text not null,
  description text,
  scope_kind text not null check (scope_kind in ('organization', 'chapter')),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  due_on date not null,
  eligibility_fingerprint text not null check (eligibility_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null check (pg_catalog.char_length(idempotency_key) between 16 and 128),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, id),
  unique (organization_id, idempotency_key),
  check ((scope_kind = 'organization' and chapter_id is null) or (scope_kind = 'chapter' and chapter_id is not null)),
  foreign key (organization_id, chapter_id)
    references public.chapters (organization_id, id) on update cascade on delete restrict
);

create table public.dues_obligations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  batch_id uuid not null,
  member_subject_id uuid not null,
  chapter_id text,
  issued_cents integer not null check (issued_cents > 0),
  due_on date not null,
  created_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, id),
  unique (organization_id, batch_id, member_subject_id),
  foreign key (organization_id, batch_id)
    references public.dues_assessment_batches (organization_id, id) on delete restrict,
  foreign key (organization_id, member_subject_id)
    references public.dues_member_subjects (organization_id, id) on delete restrict,
  foreign key (organization_id, chapter_id)
    references public.chapters (organization_id, id) on update cascade on delete restrict
);

create table public.dues_ledger_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  obligation_id uuid not null,
  event_kind text not null check (event_kind in ('assessment', 'payment', 'waiver', 'credit_adjustment', 'debit_adjustment')),
  amount_cents integer not null,
  effective_on date not null,
  reason text,
  payment_method text,
  external_reference text,
  receipt_number text,
  idempotency_key text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, id),
  unique (organization_id, idempotency_key),
  unique (organization_id, receipt_number),
  check (
    (event_kind in ('assessment', 'payment', 'waiver', 'credit_adjustment') and amount_cents > 0)
    or (event_kind = 'debit_adjustment' and amount_cents > 0)
  ),
  check (reason is null or pg_catalog.char_length(pg_catalog.btrim(reason)) between 1 and 500),
  check (payment_method is null or payment_method in ('manual_cash', 'manual_check', 'manual_other', 'stripe')),
  foreign key (organization_id, obligation_id)
    references public.dues_obligations (organization_id, id) on delete restrict
);

create table public.dues_receipt_counters (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  receipt_year integer not null check (receipt_year between 2000 and 9999),
  next_sequence integer not null default 1 check (next_sequence > 0),
  primary key (organization_id, receipt_year)
);

create table public.dues_reminder_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  obligation_id uuid not null,
  policy_window date not null,
  channel text not null check (channel in ('in_app', 'email')),
  state text not null default 'requested' check (state in ('requested', 'leased', 'sent', 'deferred', 'failed', 'blocked')),
  lease_epoch integer not null default 0 check (lease_epoch >= 0),
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0 and attempt_count <= 25),
  outcome_code text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, id),
  unique (organization_id, obligation_id, policy_window, channel),
  foreign key (organization_id, obligation_id)
    references public.dues_obligations (organization_id, id) on delete restrict
);

create index dues_member_subjects_user_org_idx
  on public.dues_member_subjects (user_id, organization_id)
  where user_id is not null;
create index dues_batches_org_due_idx
  on public.dues_assessment_batches (organization_id, due_on desc, id desc);
create index dues_obligations_org_due_idx
  on public.dues_obligations (organization_id, due_on asc, id asc);
create index dues_obligations_subject_due_idx
  on public.dues_obligations (organization_id, member_subject_id, due_on desc, id desc);
create index dues_ledger_events_obligation_created_idx
  on public.dues_ledger_events (organization_id, obligation_id, effective_on desc, id desc);
create index dues_reminder_attempts_claim_idx
  on public.dues_reminder_attempts (state, lease_expires_at, created_at)
  where state in ('requested', 'leased');

alter table public.dues_member_subjects enable row level security;
alter table public.dues_assessment_batches enable row level security;
alter table public.dues_obligations enable row level security;
alter table public.dues_ledger_events enable row level security;
alter table public.dues_receipt_counters enable row level security;
alter table public.dues_reminder_attempts enable row level security;

-- A Dues subject contains only the active user link. Account deletion leaves
-- the ledger intact with a null user link rather than retained identity data.
create policy dues_member_subjects_own_select on public.dues_member_subjects
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and organization_id = (select private.current_member_organization())
  );

create policy dues_obligations_own_select on public.dues_obligations
  for select to authenticated
  using (
    organization_id = (select private.current_member_organization())
    and exists (
      select 1 from public.dues_member_subjects subject
      where subject.organization_id = dues_obligations.organization_id
        and subject.id = dues_obligations.member_subject_id
        and subject.user_id = (select auth.uid())
    )
  );

create policy dues_events_own_select on public.dues_ledger_events
  for select to authenticated
  using (
    organization_id = (select private.current_member_organization())
    and exists (
      select 1
      from public.dues_obligations obligation
      join public.dues_member_subjects subject
        on subject.organization_id = obligation.organization_id
       and subject.id = obligation.member_subject_id
      where obligation.organization_id = dues_ledger_events.organization_id
        and obligation.id = dues_ledger_events.obligation_id
        and subject.user_id = (select auth.uid())
    )
  );

create policy dues_reminders_own_select on public.dues_reminder_attempts
  for select to authenticated
  using (
    organization_id = (select private.current_member_organization())
    and exists (
      select 1
      from public.dues_obligations obligation
      join public.dues_member_subjects subject
        on subject.organization_id = obligation.organization_id
       and subject.id = obligation.member_subject_id
      where obligation.organization_id = dues_reminder_attempts.organization_id
        and obligation.id = dues_reminder_attempts.obligation_id
        and subject.user_id = (select auth.uid())
    )
  );

revoke all on table public.dues_member_subjects, public.dues_assessment_batches,
  public.dues_obligations, public.dues_ledger_events, public.dues_receipt_counters,
  public.dues_reminder_attempts from public, anon, authenticated, service_role;
grant select on public.dues_member_subjects, public.dues_obligations,
  public.dues_ledger_events, public.dues_reminder_attempts to authenticated;

create or replace function private.dues_require_financial_hat(p_selected_hat text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
begin
  if org is null or (select auth.uid()) is null then
    raise exception 'dues authorization required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'dues financial role or MFA required' using errcode = '42501';
  end if;
  if p_selected_hat not in ('admin', 'vp') then
    raise exception 'dues financial hat required' using errcode = '42501';
  end if;
  -- has_organization_role includes active matching grant, the session-derived
  -- organization, enrollment under an MFA-required policy, and current AAL.
  if not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'dues financial role or MFA required' using errcode = '42501';
  end if;
  return org;
end;
$function$;

create or replace function private.provision_dues_member_subjects()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.dues_member_subjects (organization_id, user_id)
  select membership.organization_id, membership.user_id
  from public.organization_memberships membership
  join public.organizations organization
    on organization.id = membership.organization_id
   and organization.status = 'active'
  where membership.status = 'active'
  order by membership.organization_id, membership.user_id
  on conflict (organization_id, user_id) do nothing;
end;
$function$;

create or replace function private.provision_dues_member_subject_from_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status = 'active' then
    insert into public.dues_member_subjects (organization_id, user_id)
    values (new.organization_id, new.user_id)
    on conflict (organization_id, user_id) do nothing;
  end if;
  return new;
end;
$function$;

drop trigger if exists provision_dues_member_subject_on_membership on public.organization_memberships;
create trigger provision_dues_member_subject_on_membership
  after insert or update of status on public.organization_memberships
  for each row execute function private.provision_dues_member_subject_from_membership();

select private.provision_dues_member_subjects();

create or replace function private.dues_fingerprint(
  p_organization_id uuid,
  p_title text,
  p_description text,
  p_scope_kind text,
  p_chapter_id text,
  p_amount_cents integer,
  p_due_on date
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  with eligible as materialized (
    select subject.id
    from public.dues_member_subjects subject
    join public.organization_memberships membership
      on membership.organization_id = subject.organization_id
     and membership.user_id = subject.user_id
     and membership.status = 'active'
    where subject.organization_id = p_organization_id
      and (
        p_scope_kind = 'organization'
        or exists (
          select 1
          from public.member_chapter_memberships chapter_membership
          join public.chapters chapter
            on chapter.id = chapter_membership.chapter_id
           and chapter.organization_id = subject.organization_id
          where chapter_membership.user_id = membership.user_id
            and chapter_membership.status = 'active'
            and chapter_membership.chapter_id = p_chapter_id
        )
      )
    order by subject.id
  )
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'organizationId', p_organization_id,
          'title', p_title,
          'description', p_description,
          'scopeKind', p_scope_kind,
          'chapterId', p_chapter_id,
          'memberSubjectIds', coalesce((select pg_catalog.jsonb_agg(id) from eligible), '[]'::jsonb),
          'amountCents', p_amount_cents,
          'dueOn', p_due_on,
          'currency', 'USD',
          'kind', 'assessment',
          'reminderPolicy', 'monthly-overdue-v1'
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$function$;

create or replace function public.preview_dues_assessment_batch(
  p_title text,
  p_description text,
  p_scope_kind text,
  p_chapter_id text,
  p_amount_cents integer,
  p_due_on date,
  p_selected_hat text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  normalized_title text := nullif(pg_catalog.btrim(pg_catalog.normalize(p_title)), '');
  normalized_description text := nullif(pg_catalog.btrim(pg_catalog.normalize(coalesce(p_description, ''))), '');
  eligible_count integer;
  fingerprint text;
begin
  if normalized_title is null or pg_catalog.char_length(normalized_title) > 160
     or (normalized_description is not null and pg_catalog.char_length(normalized_description) > 4000)
     or p_scope_kind not in ('organization', 'chapter')
     or p_amount_cents is null or p_amount_cents <= 0
     or p_due_on is null then
    raise exception 'invalid dues assessment preview' using errcode = '22023';
  end if;
  if (p_scope_kind = 'organization' and p_chapter_id is not null)
     or (p_scope_kind = 'chapter' and not exists (
       select 1 from public.chapters chapter
       where chapter.organization_id = org and chapter.id = p_chapter_id
     )) then
    raise exception 'dues chapter scope invalid' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = org
      and membership.status = 'active'
      and not exists (
        select 1 from public.dues_member_subjects subject
        where subject.organization_id = membership.organization_id
          and subject.user_id = membership.user_id
      )
  ) then
    raise exception 'dues subject provisioning incomplete' using errcode = '55000';
  end if;
  select count(*) into eligible_count
  from public.dues_member_subjects subject
  join public.organization_memberships membership
    on membership.organization_id = subject.organization_id
   and membership.user_id = subject.user_id
   and membership.status = 'active'
  where subject.organization_id = org
    and (
      p_scope_kind = 'organization'
      or exists (
        select 1
        from public.member_chapter_memberships chapter_membership
        join public.chapters chapter
          on chapter.id = chapter_membership.chapter_id
         and chapter.organization_id = subject.organization_id
        where chapter_membership.user_id = membership.user_id
          and chapter_membership.status = 'active'
          and chapter_membership.chapter_id = p_chapter_id
      )
    );
  fingerprint := private.dues_fingerprint(
    org, normalized_title, normalized_description, p_scope_kind, p_chapter_id, p_amount_cents, p_due_on
  );
  return pg_catalog.jsonb_build_object(
    'eligibleCount', eligible_count,
    'excludedCount', 0,
    'totalCents', eligible_count * p_amount_cents,
    'fingerprint', fingerprint
  );
end;
$function$;

create or replace function public.get_my_dues_workspace(
  p_after_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  member_subject uuid;
  limit_value integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if org is null or (select auth.uid()) is null then
    raise exception 'dues authorization required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'dues MFA required' using errcode = '42501';
  end if;
  select subject.id into member_subject
  from public.dues_member_subjects subject
  where subject.organization_id = org and subject.user_id = (select auth.uid());
  if member_subject is null then
    raise exception 'dues subject provisioning incomplete' using errcode = '55000';
  end if;
  return (
    with page as (
      select obligation.*,
        coalesce((
          select sum(case ledger_event.event_kind
            when 'payment' then ledger_event.amount_cents
            when 'waiver' then ledger_event.amount_cents
            when 'credit_adjustment' then ledger_event.amount_cents
            when 'debit_adjustment' then -ledger_event.amount_cents
            else 0 end)
          from public.dues_ledger_events ledger_event
          where ledger_event.organization_id = obligation.organization_id
            and ledger_event.obligation_id = obligation.id
        ), 0) as settled_cents
      from public.dues_obligations obligation
      where obligation.organization_id = org
        and obligation.member_subject_id = member_subject
        and (p_after_id is null or obligation.id > p_after_id)
      order by obligation.id asc
      limit limit_value + 1
    ), visible as (
      select * from page order by id asc limit limit_value
    )
    select pg_catalog.jsonb_build_object(
      'state', 'ready',
      'staff', false,
      'summary', pg_catalog.jsonb_build_object(
        'outstandingCents', coalesce((select sum(greatest(issued_cents - settled_cents, 0)) from visible), 0),
        'overdueCents', coalesce((select sum(greatest(issued_cents - settled_cents, 0)) from visible where due_on < current_date), 0),
        'collectedCents', coalesce((select sum(settled_cents) from visible), 0),
        'memberCount', 1
      ),
      'obligations', pg_catalog.jsonb_build_object(
        'items', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', id, 'issuedCents', issued_cents, 'settledCents', settled_cents,
            'balanceCents', greatest(issued_cents - settled_cents, 0), 'dueOn', due_on,
            'events', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', ledger_event.id, 'kind', ledger_event.event_kind, 'amountCents', ledger_event.amount_cents,
              'effectiveOn', ledger_event.effective_on, 'receiptNumber', ledger_event.receipt_number,
              'paymentMethod', ledger_event.payment_method
            ) order by ledger_event.effective_on desc, ledger_event.id desc)
            from public.dues_ledger_events ledger_event
            where ledger_event.organization_id = org and ledger_event.obligation_id = visible.id), '[]'::jsonb)
          ) order by id)
          from visible
        ), '[]'::jsonb),
        'nextCursor', (select id from page order by id asc offset limit_value limit 1)
      ),
      'chapters', '[]'::jsonb,
      'provider', pg_catalog.jsonb_build_object('state', 'unset', 'checkoutAvailable', false)
    )
  );
end;
$function$;

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
  if p_status is not null and p_status not in ('open', 'partial', 'overdue', 'paid', 'waived') then
    raise exception 'invalid dues status' using errcode = '22023';
  end if;
  return (
    with calculated as (
      select obligation.*,
        subject.user_id,
        coalesce((
          select sum(case ledger_event.event_kind
            when 'payment' then ledger_event.amount_cents
            when 'waiver' then ledger_event.amount_cents
            when 'credit_adjustment' then ledger_event.amount_cents
            when 'debit_adjustment' then -ledger_event.amount_cents
            else 0 end)
          from public.dues_ledger_events ledger_event
          where ledger_event.organization_id = obligation.organization_id
            and ledger_event.obligation_id = obligation.id
        ), 0) as settled_cents
      from public.dues_obligations obligation
      join public.dues_member_subjects subject
        on subject.organization_id = obligation.organization_id
       and subject.id = obligation.member_subject_id
      where obligation.organization_id = org
    ), page as (
      select *, case
        when issued_cents - settled_cents <= 0 then 'paid'
        when settled_cents > 0 then 'partial'
        when due_on < current_date then 'overdue'
        else 'open'
      end as standing
      from calculated
      where (p_after_id is null or id > p_after_id)
        and (p_due_on is null or due_on = p_due_on)
      order by id asc
      limit limit_value + 1
    ), visible as (
      select * from page
      where p_status is null or standing = p_status
      order by id asc
      limit limit_value
    )
    select pg_catalog.jsonb_build_object(
      'state', 'ready',
      'staff', true,
      'summary', pg_catalog.jsonb_build_object(
        'outstandingCents', coalesce((select sum(greatest(issued_cents - settled_cents, 0)) from calculated), 0),
        'overdueCents', coalesce((select sum(greatest(issued_cents - settled_cents, 0)) from calculated where due_on < current_date), 0),
        'collectedCents', coalesce((select sum(settled_cents) from calculated), 0),
        'memberCount', (select count(distinct member_subject_id) from calculated)
      ),
      'obligations', pg_catalog.jsonb_build_object(
        'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', id, 'memberSubjectId', member_subject_id,
          'memberLabel', case when user_id is null then 'Former member' else 'Member' end,
          'issuedCents', issued_cents, 'settledCents', settled_cents,
          'balanceCents', greatest(issued_cents - settled_cents, 0), 'dueOn', due_on,
          'standing', standing, 'chapterId', chapter_id
        ) order by id) from visible), '[]'::jsonb),
        'nextCursor', (select id from page order by id asc offset limit_value limit 1)
      ),
      'chapters', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', chapter.id, 'name', chapter.name) order by chapter.name)
        from public.chapters chapter where chapter.organization_id = org), '[]'::jsonb),
      'provider', pg_catalog.jsonb_build_object('state', 'unset', 'checkoutAvailable', false)
    )
  );
end;
$function$;

revoke all on function private.dues_require_financial_hat(text),
  private.provision_dues_member_subjects(),
  private.provision_dues_member_subject_from_membership(),
  private.dues_fingerprint(uuid, text, text, text, text, integer, date)
  from public, anon, authenticated, service_role;
revoke all on function public.preview_dues_assessment_batch(text, text, text, text, integer, date, text),
  public.get_my_dues_workspace(uuid, integer),
  public.get_dues_workspace(text, text, date, uuid, integer, text)
  from public, anon;
grant execute on function public.preview_dues_assessment_batch(text, text, text, text, integer, date, text),
  public.get_my_dues_workspace(uuid, integer),
  public.get_dues_workspace(text, text, date, uuid, integer, text)
  to authenticated;

commit;
