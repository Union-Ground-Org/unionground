-- UB-MSG-02 / UB-MSG-05: provider-neutral steward email intake. The network
-- boundary verifies the raw signed envelope; this migration owns replay
-- protection, chapter scope, and staff review. No incoming body is ever
-- copied to the shared admin audit trail or published automatically.

set local lock_timeout = '5s';

create table public.steward_email_intakes (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  provider_message_digest text not null unique
    check (provider_message_digest ~ '^[a-f0-9]{64}$'),
  from_address text not null
    check (char_length(from_address) between 3 and 320),
  subject text not null default ''
    check (char_length(subject) <= 500),
  body_text text not null
    check (char_length(body_text) between 1 and 60000),
  received_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending','reviewing','accepted','rejected')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint steward_email_intakes_review_state check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null)
    -- reviewed_by may detach when an account is deleted; reviewed_at and the
    -- immutable admin transition record preserve that a real review occurred.
    or (status in ('reviewing','accepted','rejected') and reviewed_at is not null)
  )
);

create index steward_email_intakes_chapter_status_received_idx
  on public.steward_email_intakes(chapter_id, status, received_at desc, id);

alter table public.steward_email_intakes enable row level security;
create policy mfa_assurance on public.steward_email_intakes as restrictive
  for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
revoke all on public.steward_email_intakes from public, anon, authenticated;

create function public.ingest_steward_email(p_provider_message_digest text, p_chapter_id text, p_from_address text, p_subject text, p_body_text text, p_received_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted boolean;
  clean_address text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_from_address, '')));
  clean_subject text := pg_catalog.btrim(coalesce(p_subject, ''));
  clean_body text := pg_catalog.btrim(coalesce(p_body_text, ''));
begin
  if (select auth.jwt() ->> 'role') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_provider_message_digest is null or p_provider_message_digest !~ '^[a-f0-9]{64}$'
     or p_chapter_id is null or p_chapter_id !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or pg_catalog.char_length(clean_address) not between 3 and 320
     or clean_address !~ '^[^[:space:]@]+@[^[:space:]@]+$'
     or pg_catalog.char_length(clean_subject) > 500
     or pg_catalog.char_length(clean_body) not between 1 and 60000
     or p_received_at is null
     or p_received_at > now() + interval '5 minutes' then
    raise exception 'invalid intake envelope' using errcode = '22023';
  end if;
  if not exists (select 1 from public.chapters chapter where chapter.id = p_chapter_id) then
    raise exception 'unknown chapter' using errcode = '22023';
  end if;

  insert into public.steward_email_intakes(
    provider_message_digest, chapter_id, from_address, subject, body_text, received_at)
  values (
    p_provider_message_digest, p_chapter_id, clean_address, clean_subject, clean_body, p_received_at)
  on conflict (provider_message_digest) do nothing;
  get diagnostics inserted = row_count;

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'duplicate', not inserted
  );
end;
$$;

create function public.list_steward_email_intakes(p_status text default 'pending', p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null
     or not private.mfa_satisfied()
     or not public.member_has_role(array['steward','admin']) then
    raise exception 'MFA staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if not private.actor_has_chapter_staff_role(caller, caller_chapter) then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_status not in ('pending','reviewing','accepted','rejected','all')
     or p_limit not between 1 and 100 then
    raise exception 'invalid intake filter' using errcode = '22023';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', intake.id,
      'chapterId', intake.chapter_id,
      'from', intake.from_address,
      'subject', intake.subject,
      'text', intake.body_text,
      'receivedAt', intake.received_at,
      'status', intake.status,
      'reviewedBy', intake.reviewed_by,
      'reviewedAt', intake.reviewed_at
    ) order by intake.received_at desc, intake.id)
    from (
      select row.* from public.steward_email_intakes row
      where row.chapter_id = caller_chapter
        and (p_status = 'all' or row.status = p_status)
      order by row.received_at desc, row.id
      limit p_limit
    ) intake
  ), '[]'::jsonb);
end;
$$;

-- Extend the immutable audit allow-list before the review function can write
-- its bounded transition record. Content and sender identity stay only in the
-- intake table and never appear in this cross-product audit.
alter table public.member_admin_audit
  drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit
  add constraint member_admin_audit_action_check
  check (action in ('grant_role', 'revoke_role', 'create_event', 'update_event', 'reset_mfa',
                    'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward',
                    'set_staff_mfa_policy', 'set_compass_ai_enabled',
                    'set_compass_ai_role_limit', 'attest_compass_ai_provider',
                    'review_email_intake'));

create function public.review_steward_email_intake(p_intake_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  intake record;
  next_status text;
begin
  if caller is null
     or not private.mfa_satisfied()
     or not public.member_has_role(array['steward','admin']) then
    raise exception 'MFA staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if not private.actor_has_chapter_staff_role(caller, caller_chapter) then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_action not in ('claim','accept','reject','reopen') then
    raise exception 'invalid review action' using errcode = '22023';
  end if;

  select id, chapter_id, status into intake
  from public.steward_email_intakes
  where id = p_intake_id and chapter_id = caller_chapter
  for update;
  if not found then raise exception 'intake unavailable' using errcode = '22023'; end if;

  next_status := case p_action
    when 'claim' then 'reviewing'
    when 'accept' then 'accepted'
    when 'reject' then 'rejected'
    when 'reopen' then 'reviewing'
  end;
  if (p_action = 'claim' and intake.status <> 'pending')
     or (p_action in ('accept','reject') and intake.status <> 'reviewing')
     or (p_action = 'reopen' and intake.status not in ('accepted','rejected')) then
    raise exception 'intake transition unavailable' using errcode = '22023';
  end if;

  update public.steward_email_intakes
  set status = next_status, reviewed_by = caller, reviewed_at = now()
  where id = intake.id;

  insert into public.member_admin_audit(actor, action, detail)
  values (caller, 'review_email_intake', pg_catalog.jsonb_build_object(
    'intakeId', intake.id,
    'chapterId', intake.chapter_id,
    'fromStatus', intake.status,
    'toStatus', next_status,
    'reviewAction', p_action));

  return pg_catalog.jsonb_build_object(
    'id', intake.id, 'status', next_status, 'reviewed', true);
end;
$$;

revoke all on function public.ingest_steward_email(text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.list_steward_email_intakes(text, integer)
  from public, anon, authenticated;
revoke all on function public.review_steward_email_intake(uuid, text)
  from public, anon, authenticated;

grant execute on function public.ingest_steward_email(text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.list_steward_email_intakes(text, integer) to authenticated;
grant execute on function public.review_steward_email_intake(uuid, text) to authenticated;

do $$ begin perform pg_catalog.pg_notify('pgrst', 'reload schema'); end $$;
