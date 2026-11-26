-- UB-CASE-02: scoped, audited coordinator writes. No direct coordinator table
-- grant is added: every mutation runs through an MFA- and chapter-scoped RPC.

create table public.member_case_contacts (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null references public.member_cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  coordinator_id uuid not null references auth.users(id) on delete restrict,
  contact_type text not null check (contact_type in ('phone','email','meeting','letter','other')),
  direction text not null check (direction in ('outbound','inbound','internal')),
  summary text not null check (char_length(btrim(summary)) between 1 and 2000),
  contacted_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.member_case_outcomes (
  case_id uuid primary key references public.member_cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  outcome text not null check (outcome in ('upheld','settled','withdrawn','denied','other')),
  summary text not null check (char_length(btrim(summary)) between 1 and 4000),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.coordinator_case_audit (
  id bigint generated always as identity primary key,
  case_id uuid not null references public.member_cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('case_updated','note_added','contact_logged','outcome_recorded')),
  before_value jsonb,
  after_value jsonb not null,
  reason text,
  created_at timestamptz not null default now(),
  constraint coordinator_case_audit_reason_bounded check (reason is null or char_length(btrim(reason)) between 1 and 1000),
  constraint coordinator_case_audit_before_object check (before_value is null or jsonb_typeof(before_value) = 'object'),
  constraint coordinator_case_audit_after_object check (jsonb_typeof(after_value) = 'object')
);

create index member_case_contacts_case_contacted_idx on public.member_case_contacts(case_id, contacted_at desc, id desc);
create index member_case_contacts_user_contacted_idx on public.member_case_contacts(user_id, contacted_at desc);
create index member_case_contacts_coordinator_idx on public.member_case_contacts(coordinator_id, created_at desc);
create index member_case_outcomes_user_idx on public.member_case_outcomes(user_id, updated_at desc);
create index member_case_outcomes_recorded_by_idx on public.member_case_outcomes(recorded_by, updated_at desc);
create index coordinator_case_audit_case_created_idx on public.coordinator_case_audit(case_id, created_at desc, id desc);
create index coordinator_case_audit_user_created_idx on public.coordinator_case_audit(user_id, created_at desc);
create index coordinator_case_audit_actor_idx on public.coordinator_case_audit(actor_id, created_at desc);

alter table public.member_case_contacts enable row level security;
alter table public.member_case_outcomes enable row level security;
alter table public.coordinator_case_audit enable row level security;

create policy member_case_contacts_select_coordinator on public.member_case_contacts
  for select to authenticated using (public.staff_can_see_user(user_id, 'coordinator'));
create policy member_case_outcomes_select_coordinator on public.member_case_outcomes
  for select to authenticated using (public.staff_can_see_user(user_id, 'coordinator'));
create policy coordinator_case_audit_select_coordinator on public.coordinator_case_audit
  for select to authenticated using (public.staff_can_see_user(user_id, 'coordinator'));
create policy mfa_assurance on public.member_case_contacts as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_case_outcomes as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.coordinator_case_audit as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

revoke all on table public.member_case_contacts, public.member_case_outcomes, public.coordinator_case_audit from public, anon, authenticated;
grant select on table public.member_case_contacts, public.member_case_outcomes, public.coordinator_case_audit to authenticated;

create or replace function private.coordinator_case_for_update(p_case_id uuid)
returns public.member_cases language plpgsql security definer set search_path = '' as $$
declare found public.member_cases%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied()
     or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;
  select c.* into found from public.member_cases c
  where c.id = p_case_id and public.staff_can_see_user(c.user_id, 'coordinator')
  for update of c;
  if found.id is null then raise exception 'case unavailable' using errcode = '22023'; end if;
  return found;
end $$;

revoke all on function private.coordinator_case_for_update(uuid) from public, anon, authenticated;

create or replace function public.coordinator_update_case(
  p_case_id uuid, p_status text, p_step text, p_deadline date, p_reason text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare old_case public.member_cases%rowtype; changed public.member_cases%rowtype; clean_step text := btrim(coalesce(p_step,'')); clean_reason text := btrim(coalesce(p_reason,''));
begin
  old_case := private.coordinator_case_for_update(p_case_id);
  if p_status not in ('active','resolved') then raise exception 'invalid status' using errcode = '22023'; end if;
  if char_length(clean_step) not between 1 and 120 then raise exception 'step must be 1-120 characters' using errcode = '22023'; end if;
  if char_length(clean_reason) not between 1 and 1000 then raise exception 'reason must be 1-1000 characters' using errcode = '22023'; end if;
  if old_case.deadline is not null and (p_deadline is null or p_deadline < old_case.deadline) then
    raise exception 'deadline may only be extended' using errcode = '22023';
  end if;
  update public.member_cases set status=p_status, step=clean_step, deadline=p_deadline where id=old_case.id returning * into changed;
  insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,before_value,after_value,reason)
  values (old_case.id,old_case.user_id,(select auth.uid()),'case_updated',
    jsonb_build_object('status',old_case.status,'step',old_case.step,'deadline',old_case.deadline),
    jsonb_build_object('status',changed.status,'step',changed.step,'deadline',changed.deadline),clean_reason);
  return jsonb_build_object('id',changed.id,'status',changed.status,'step',changed.step,'deadline',changed.deadline);
end $$;

create or replace function public.coordinator_add_case_note(p_case_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.member_cases%rowtype; clean_body text := btrim(coalesce(p_body,'')); inserted public.member_case_updates%rowtype;
begin
  c := private.coordinator_case_for_update(p_case_id);
  if char_length(clean_body) not between 1 and 4000 then raise exception 'note must be 1-4000 characters' using errcode = '22023'; end if;
  insert into public.member_case_updates(case_id,user_id,body) values(c.id,c.user_id,clean_body) returning * into inserted;
  insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,after_value)
  values(c.id,c.user_id,(select auth.uid()),'note_added',jsonb_build_object('updateId',inserted.id,'body',inserted.body));
  return jsonb_build_object('id',inserted.id,'caseId',inserted.case_id,'body',inserted.body,'createdAt',inserted.created_at);
end $$;

create or replace function public.coordinator_log_case_contact(
  p_case_id uuid, p_contact_type text, p_direction text, p_summary text, p_contacted_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.member_cases%rowtype; clean_summary text := btrim(coalesce(p_summary,'')); inserted public.member_case_contacts%rowtype;
begin
  c := private.coordinator_case_for_update(p_case_id);
  if p_contact_type not in ('phone','email','meeting','letter','other') then raise exception 'invalid contact type' using errcode='22023'; end if;
  if p_direction not in ('outbound','inbound','internal') then raise exception 'invalid contact direction' using errcode='22023'; end if;
  if char_length(clean_summary) not between 1 and 2000 then raise exception 'summary must be 1-2000 characters' using errcode='22023'; end if;
  if p_contacted_at is null or p_contacted_at > now() + interval '5 minutes' then raise exception 'invalid contact time' using errcode='22023'; end if;
  insert into public.member_case_contacts(case_id,user_id,coordinator_id,contact_type,direction,summary,contacted_at)
  values(c.id,c.user_id,(select auth.uid()),p_contact_type,p_direction,clean_summary,p_contacted_at) returning * into inserted;
  insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,after_value)
  values(c.id,c.user_id,(select auth.uid()),'contact_logged',jsonb_build_object('contactId',inserted.id,'type',inserted.contact_type,'direction',inserted.direction,'summary',inserted.summary,'contactedAt',inserted.contacted_at));
  return jsonb_build_object('id',inserted.id,'caseId',inserted.case_id,'type',inserted.contact_type,'direction',inserted.direction,'summary',inserted.summary,'contactedAt',inserted.contacted_at);
end $$;

create or replace function public.coordinator_record_case_outcome(p_case_id uuid, p_outcome text, p_summary text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.member_cases%rowtype; prior public.member_case_outcomes%rowtype; saved public.member_case_outcomes%rowtype; clean_summary text := btrim(coalesce(p_summary,''));
begin
  c := private.coordinator_case_for_update(p_case_id);
  if p_outcome not in ('upheld','settled','withdrawn','denied','other') then raise exception 'invalid outcome' using errcode='22023'; end if;
  if char_length(clean_summary) not between 1 and 4000 then raise exception 'summary must be 1-4000 characters' using errcode='22023'; end if;
  select * into prior from public.member_case_outcomes where case_id=c.id;
  insert into public.member_case_outcomes(case_id,user_id,outcome,summary,recorded_by)
  values(c.id,c.user_id,p_outcome,clean_summary,(select auth.uid()))
  on conflict(case_id) do update set outcome=excluded.outcome,summary=excluded.summary,recorded_by=excluded.recorded_by,updated_at=now()
  returning * into saved;
  update public.member_cases set status='resolved' where id=c.id;
  insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,before_value,after_value)
  values(c.id,c.user_id,(select auth.uid()),'outcome_recorded',
    case when prior.case_id is null then null else jsonb_build_object('outcome',prior.outcome,'summary',prior.summary) end,
    jsonb_build_object('outcome',saved.outcome,'summary',saved.summary,'status','resolved'));
  return jsonb_build_object('caseId',saved.case_id,'outcome',saved.outcome,'summary',saved.summary,'recordedAt',saved.recorded_at,'updatedAt',saved.updated_at);
end $$;

revoke all on function public.coordinator_update_case(uuid,text,text,date,text) from public, anon;
grant execute on function public.coordinator_update_case(uuid,text,text,date,text) to authenticated;
revoke all on function public.coordinator_add_case_note(uuid,text) from public, anon;
grant execute on function public.coordinator_add_case_note(uuid,text) to authenticated;
revoke all on function public.coordinator_log_case_contact(uuid,text,text,text,timestamptz) from public, anon;
grant execute on function public.coordinator_log_case_contact(uuid,text,text,text,timestamptz) to authenticated;
revoke all on function public.coordinator_record_case_outcome(uuid,text,text) from public, anon;
grant execute on function public.coordinator_record_case_outcome(uuid,text,text) to authenticated;

comment on table public.coordinator_case_audit is 'Immutable coordinator case mutation evidence; no client table write grant exists.';
notify pgrst, 'reload schema';
