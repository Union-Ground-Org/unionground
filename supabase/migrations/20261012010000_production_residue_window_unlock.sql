-- OPS-UG-PRODUCTION-RESIDUE-CLEANUP-EXECUTION-20260912
-- Removal-only capability for the owner-attended window. Applying this file
-- grants no authorization: an operator must insert the installation-bound
-- window after both owner texts and the completed nightly backup. F4 removes
-- this capability immediately after verification, or on any stop.
-- Owner order October 14, 2026 removed the Eastern time band and the 4 h 50 min
-- cap; a window now ends by F3/F4 re-lock or 24 hours after opening, whichever first.
begin;

-- Filled only by owner-approved SQL from the reviewed baseline before fill.
-- Empty on installation; client roles cannot choose or change kept identities.
create table private.production_residue_kept_scope (
  singleton boolean primary key default true check (singleton),
  organization_id uuid not null,
  chapter_id text not null
);
alter table private.production_residue_kept_scope enable row level security;
revoke all on table private.production_residue_kept_scope from public, anon, authenticated, service_role;

-- Only the SECURITY DEFINER removal RPC can establish this transaction-local
-- authority. A caller-controlled custom setting cannot grant an audit bypass.
create table private.production_residue_audit_context (
  backend_pid integer not null,
  transaction_id bigint not null,
  organization_id uuid not null,
  primary key (backend_pid, transaction_id)
);
alter table private.production_residue_audit_context enable row level security;
revoke all on table private.production_residue_audit_context from public, anon, authenticated, service_role;

create table private.production_residue_windows (
  project_ref text primary key,
  system_identifier numeric not null,
  database_oid oid not null,
  authorization_reference text not null,
  backup_reference text not null,
  opened_at timestamptz not null default pg_catalog.statement_timestamp(),
  expires_at timestamptz not null,
  own_domain_confirmed_count integer check (own_domain_confirmed_count = 3),
  own_domain_disposition text check (own_domain_disposition in ('remove', 'preserve')),
  constraint production_residue_window_target check (project_ref = 'productionprojectref'),
  constraint production_residue_window_authorization_reference
    check (authorization_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'),
  constraint production_residue_window_backup_reference
    check (backup_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'),
  constraint production_residue_window_duration
    check (expires_at > opened_at
      and expires_at <= opened_at + interval '24 hours')
);
alter table private.production_residue_windows enable row level security;
revoke all on table private.production_residue_windows from public, anon, authenticated, service_role;

-- Stamp body comes from the predecessor without its Eastern opening band,
-- which the October 14 owner order removed. An UPDATE keeps the first stamp,
-- so no later write can restart the 24-hour cap.
create function private.production_residue_stamp_window()
returns trigger
language plpgsql
security definer
set search_path = ''
as $stamp_window$
declare
  database_opened_at timestamptz := pg_catalog.statement_timestamp();
begin
  -- A caller-supplied opened_at is never authoritative. PostgreSQL replaces it
  -- even when the INSERT explicitly names the column.
  if tg_op = 'UPDATE' then
    new.opened_at := old.opened_at;
  else
    new.opened_at := database_opened_at;
  end if;
  return new;
end;
$stamp_window$;
revoke all on function private.production_residue_stamp_window() from public, anon, authenticated, service_role;
create trigger production_residue_stamp_window
before insert or update on private.production_residue_windows
for each row execute function private.production_residue_stamp_window();

create table private.production_residue_ledger (
  subject_kind text not null check (subject_kind in ('account', 'organization', 'chapter')),
  subject_id text not null,
  cohort text not null check (cohort in ('org', 'org-kept', 'chapter', 'chapter-kept',
    'account-4a', 'account-4b', 'account-kept', 'account-4c', 'account-bootstrap')),
  own_domain boolean not null default false,
  filled_at timestamptz not null default pg_catalog.statement_timestamp(),
  -- Durable progress prevents a repeated org-content call selecting an already
  -- completed organization; no subject identifiers leave this private table.
  content_removed_at timestamptz,
  primary key (subject_kind, subject_id),
  check ((subject_kind = 'account' and cohort like 'account-%')
    or (subject_kind = 'organization' and cohort in ('org', 'org-kept'))
    or (subject_kind = 'chapter' and cohort in ('chapter', 'chapter-kept')))
);
alter table private.production_residue_ledger enable row level security;
revoke all on table private.production_residue_ledger from public, anon, authenticated, service_role;

create function private.production_residue_snapshot_accounted(p_stored jsonb, p_current jsonb, p_lane text)
returns boolean language plpgsql stable security definer set search_path = '' as $function$
begin
  if p_lane is null or p_lane not in ('uniondemo', 'member_stress')
    or pg_catalog.jsonb_typeof(p_stored) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_current) is distinct from 'array' then return false; end if;
  return not exists (
    select 1 from pg_catalog.jsonb_array_elements(p_stored) s
    where not exists (select 1 from pg_catalog.jsonb_array_elements(p_current) c where c = s)
  ) and not exists (
    select 1 from pg_catalog.jsonb_array_elements(p_current) c
    where c->>'id' is null or (
      not exists (select 1 from pg_catalog.jsonb_array_elements(p_stored) s where s = c)
      and not exists (select 1 from private.production_residue_ledger l
        where l.subject_kind = 'account' and l.subject_id = c->>'id')
      and not (p_lane = 'member_stress' and exists (
        select 1 from private.uniondemo_ledger l
        where l.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid and l.user_id::text = c->>'id'))
    )
  ) and not exists (
    select 1 from pg_catalog.jsonb_array_elements(p_current) c group by c->>'id' having count(*) > 1
  );
end;
$function$;
revoke all on function private.production_residue_snapshot_accounted(jsonb, jsonb, text) from public, anon, authenticated, service_role;

create function private.production_residue_authorize(p_gate text, p_operation text, p_target_ref text, p_confirm_token text)
returns void language plpgsql security definer set search_path = '' as $guard$
declare
  pinned_system_identifier constant numeric := 7662742571317219726;
  pinned_database_oid constant oid := 5;
  pinned_confirmation_digest constant text := '5155e1a3ed12485fe08548293aa3c12c49bf16bf0e0fbce8a4072914d7688a20';
  live_system_identifier numeric;
  live_database_oid oid;
  checked_at timestamptz := pg_catalog.clock_timestamp();
  active_window private.production_residue_windows%rowtype;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'production removal requires service_role' using errcode = '42501'; end if;
  if p_gate is null or p_operation is null or not (
    (p_gate = 'uniondemo' and p_operation in ('revoke-sessions', 'knowledge-remove', 'parity-remove', 'begin-remove', 'remove-batch'))
    or (p_gate = 'member_stress' and p_operation in ('begin-remove', 'remove-batch'))
    or (p_gate = 'bootstrap' and p_operation in ('revoke-sessions', 'remove-batch'))
    or (p_gate = 'swarm' and p_operation in ('fill-ledger', 'revoke-sessions', 'remove-batch'))
  ) then raise exception 'production removal operation refused' using errcode = '42501'; end if;
  if p_target_ref is distinct from 'productionprojectref' then
    raise exception 'production removal scope refused' using errcode = '42501'; end if;
  select control.system_identifier::numeric into live_system_identifier from pg_catalog.pg_control_system() control;
  select d.oid into live_database_oid from pg_catalog.pg_database d where d.datname = pg_catalog.current_database();
  if live_system_identifier is distinct from pinned_system_identifier or live_database_oid is distinct from pinned_database_oid then
    raise exception 'production removal installation refused' using errcode = '55000'; end if;
  select w.* into active_window from private.production_residue_windows w
    where w.project_ref = p_target_ref and w.system_identifier = live_system_identifier and w.database_oid = live_database_oid for share;
  if not found or active_window.opened_at > checked_at or active_window.expires_at <= checked_at
    or active_window.expires_at > active_window.opened_at + interval '24 hours' then
    raise exception 'production removal window is not active' using errcode = '55000'; end if;
  if pg_catalog.encode(extensions.digest(p_confirm_token, 'sha256'), 'hex') is distinct from pinned_confirmation_digest then
    raise exception 'production removal confirmation refused' using errcode = '42501'; end if;
  if exists (select 1 from private.demo_seed_installation_bindings)
    or exists (select 1 from storage.objects)
    or exists (select 1 from pg_catalog.pg_class where relkind = 'f') then
    raise exception 'production removal environment refused' using errcode = '55000'; end if;
  if p_operation <> 'fill-ledger' then
    if not exists (select 1 from private.production_residue_ledger) then
      raise exception 'production residue ledger is not filled' using errcode = '55000'; end if;
    if exists (select 1 from public.organizations o
      where not exists (select 1 from private.production_residue_ledger l
        where l.subject_kind = 'organization' and l.subject_id = o.id::text and l.cohort in ('org', 'org-kept'))
      and not (exists (select 1 from public.chapters c where c.organization_id = o.id)
        and not exists (select 1 from public.chapters c where c.organization_id = o.id
          and not exists (select 1 from private.uniondemo_chapters m where m.chapter_id = c.id
            and m.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid))))
      or exists (select 1 from auth.users u
        where not exists (select 1 from private.production_residue_ledger l where l.subject_kind = 'account' and l.subject_id = u.id::text)
          and not exists (select 1 from private.uniondemo_ledger l where l.user_id = u.id)
          and not exists (select 1 from private.member_stress_ledger l where l.user_id = u.id)) then
      raise exception 'production removal protected remainder refused' using errcode = '55000'; end if;
    if exists (select 1 from public.member_profiles p join private.uniondemo_chapters m on m.chapter_id = p.chapter_id
        where not exists (select 1 from private.uniondemo_ledger l where l.run_id = m.run_id and l.user_id = p.id))
      or exists (select 1 from public.member_roles r join private.uniondemo_chapters m on m.chapter_id = r.chapter_id
        where not exists (select 1 from private.uniondemo_ledger l where l.run_id = m.run_id and l.user_id = r.user_id))
      or exists (select 1 from public.organization_memberships r join public.chapters c on c.organization_id = r.organization_id
        join private.uniondemo_chapters m on m.chapter_id = c.id
        where not exists (select 1 from private.uniondemo_ledger l where l.run_id = m.run_id and l.user_id = r.user_id)) then
      raise exception 'production removal mapped chapter ownership refused' using errcode = '55000'; end if;
    if p_gate = 'uniondemo' and p_operation <> 'revoke-sessions' then
      perform 1 from private.uniondemo_runs r
        where r.id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
          and r.target_ref = p_target_ref and r.member_count = 30000 and r.state in ('verified', 'removing', 'removed')
          and private.production_residue_snapshot_accounted(r.protected_snapshot, private.uniondemo_protected_snapshot(r.id), 'uniondemo')
        for update;
      if not found or (select count(*) from private.uniondemo_ledger where run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid) <> 30000
        or exists (select 1 from private.uniondemo_ledger l join auth.users u on u.id = l.user_id
          where l.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
            and (pg_catalog.lower(u.email) is distinct from l.email or u.raw_app_meta_data->>'uniondemo_run_id' is distinct from l.run_id::text))
        or exists (select 1 from auth.sessions s join private.uniondemo_ledger l on l.user_id = s.user_id where l.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid)
        or exists (select 1 from auth.refresh_tokens t join private.uniondemo_ledger l on l.user_id::text = t.user_id::text where l.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid) then
        raise exception 'production removal ownership or session preflight refused' using errcode = '55000'; end if;
    end if;
  end if;
end;
$guard$;
revoke all on function private.production_residue_authorize(text, text, text, text) from public, anon, authenticated, service_role;

create function public.production_residue_fill_ledger(p_target_ref text, p_confirm_token text)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '60s' as $function$
declare counts jsonb; kept_organization uuid; kept_chapter text;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('production-residue-window', 0));
  perform private.production_residue_authorize('swarm', 'fill-ledger', p_target_ref, p_confirm_token);
  lock table private.production_residue_ledger in exclusive mode;
  if exists (select 1 from private.production_residue_ledger) then
    raise exception 'production residue ledger already filled' using errcode = '55000'; end if;
  lock table auth.users, public.organizations, public.chapters in share mode;
  lock table private.production_residue_kept_scope in share mode;
  select organization_id, chapter_id into kept_organization, kept_chapter
    from private.production_residue_kept_scope;
  if kept_organization is null or kept_chapter is null
    or not exists (select 1 from public.organizations o join public.chapters c
      on c.organization_id = o.id where o.id = kept_organization and c.id = kept_chapter)
    or exists (select 1 from public.chapters c where c.organization_id = kept_organization and c.id <> kept_chapter) then
    raise exception 'production residue kept organization identity refused' using errcode = '55000'; end if;
  insert into private.production_residue_ledger(subject_kind, subject_id, cohort, own_domain)
  select 'account', u.id::text,
    case when (u.created_at at time zone 'America/New_York')::date < date '2026-09-01' then 'account-bootstrap'
      when (u.created_at at time zone 'America/New_York')::date between date '2026-10-03' and date '2026-10-06'
        and not ((pg_catalog.lower(coalesce(u.email,'')) ~ '@(unionground[.]net|demo[.]example[.]com)$')) then 'account-4a'
      when (u.created_at at time zone 'America/New_York')::date = date '2026-10-07'
        and not ((pg_catalog.lower(coalesce(u.email,'')) ~ '@(unionground[.]net|demo[.]example[.]com)$')) then 'account-4c'
      when (u.created_at at time zone 'America/New_York')::date = date '2026-09-29'
        and (pg_catalog.lower(coalesce(u.email,'')) ~ '@(unionground[.]net|demo[.]example[.]com)$') then 'account-4b'
      else 'account-kept' end,
    (pg_catalog.lower(coalesce(u.email,'')) ~ '@(unionground[.]net|demo[.]example[.]com)$')
  from auth.users u
  where not exists (select 1 from private.uniondemo_ledger l where l.user_id = u.id)
    and not exists (select 1 from private.member_stress_ledger l where l.user_id = u.id)
    and not coalesce(u.raw_app_meta_data ?| array['uniondemo_run_id', 'presg_demo_run_id', 'member_stress_run_id'], false)
    and ((u.created_at at time zone 'America/New_York')::date < date '2026-09-01'
      or ((u.created_at at time zone 'America/New_York')::date between date '2026-10-03' and date '2026-10-07'
        and not (pg_catalog.lower(coalesce(u.email,'')) ~ '@(unionground[.]net|demo[.]example[.]com)$'))
      or ((u.created_at at time zone 'America/New_York')::date in (date '2026-09-29', date '2026-09-30')
        and (pg_catalog.lower(coalesce(u.email,'')) ~ '@(unionground[.]net|demo[.]example[.]com)$')));
  insert into private.production_residue_ledger(subject_kind, subject_id, cohort)
  select 'organization', o.id::text,
    case when o.id = kept_organization then 'org-kept' else 'org' end
  from public.organizations o
  where (o.created_at at time zone 'America/New_York')::date between date '2026-09-30' and date '2026-10-06'
    and not exists (select 1 from public.chapters c join private.uniondemo_chapters m on m.chapter_id = c.id where c.organization_id = o.id)
    and not exists (select 1 from auth.users u where u.id = o.created_by
      and (pg_catalog.lower(coalesce(u.email,'')) ~ '@(unionground[.]net|demo[.]example[.]com)$')
      and not exists (select 1 from private.production_residue_ledger l where l.subject_id = u.id::text and l.cohort = 'account-kept'));
  insert into private.production_residue_ledger(subject_kind, subject_id, cohort)
  select 'chapter', c.id, case when c.id = kept_chapter then 'chapter-kept' else 'chapter' end
  from public.chapters c join private.production_residue_ledger l
    on l.subject_kind = 'organization' and l.subject_id = c.organization_id::text;
  select pg_catalog.jsonb_object_agg(cohort, n) into counts
    from (select cohort, count(*) n from private.production_residue_ledger group by cohort) x;
  if counts is distinct from '{"org":10,"org-kept":1,"chapter":18,"chapter-kept":1,"account-4a":31,"account-4b":1,"account-kept":1,"account-4c":1,"account-bootstrap":4}'::jsonb
    or (select count(*) from private.production_residue_ledger where cohort = 'account-bootstrap' and own_domain) <> 1
    or exists (select 1 from auth.users u where not exists (select 1 from private.production_residue_ledger l where l.subject_kind = 'account' and l.subject_id = u.id::text)
      and not exists (select 1 from private.uniondemo_ledger l where l.user_id = u.id)
      and not exists (select 1 from private.member_stress_ledger l where l.user_id = u.id))
    or exists (select 1 from public.organizations o where not exists (select 1 from private.production_residue_ledger l where l.subject_kind = 'organization' and l.subject_id = o.id::text)) then
    raise exception 'production residue cohort counts or protected remainder refused' using errcode = '55000'; end if;
  if not exists (select 1 from private.production_residue_windows where expires_at > pg_catalog.clock_timestamp()) then
    raise exception 'production removal window expired during operation' using errcode = '55000'; end if;
  return counts || '{"protected_accounts":0,"protected_organizations":0}'::jsonb;
end;
$function$;
revoke all on function public.production_residue_fill_ledger(text, text) from public, anon, authenticated, service_role;
grant execute on function public.production_residue_fill_ledger(text, text) to service_role;

create function public.production_residue_revoke_sessions(p_cohort text, p_target_ref text, p_confirm_token text)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '60s' as $function$
declare before_sessions bigint; before_tokens bigint; after_sessions bigint; after_tokens bigint; w private.production_residue_windows%rowtype; selected_users uuid[];
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('production-residue-window', 0));
  if p_cohort is null or p_cohort not in ('uniondemo', 'account-4a', 'account-4b', 'account-4c', 'account-bootstrap') then
    raise exception 'production residue cohort refused' using errcode = '42501'; end if;
  perform private.production_residue_authorize(case when p_cohort = 'uniondemo' then 'uniondemo'
    when p_cohort = 'account-bootstrap' then 'bootstrap' else 'swarm' end, 'revoke-sessions', p_target_ref, p_confirm_token);
  select * into w from private.production_residue_windows;
  if (p_cohort = 'account-4b' or exists (select 1 from private.production_residue_ledger l where l.cohort = p_cohort and l.own_domain))
    and w.own_domain_confirmed_count is distinct from 3 then
    raise exception 'production residue own-domain confirmation refused' using errcode = '42501'; end if;
  if p_cohort = 'uniondemo' and (
    not exists (select 1 from private.uniondemo_runs r where r.id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
      and r.member_count = 30000 and r.target_ref = p_target_ref and r.state in ('verified', 'removing', 'removed'))
    or (select count(*) from private.uniondemo_ledger where run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid) <> 30000
    or exists (select 1 from private.uniondemo_ledger l join auth.users u on u.id = l.user_id
    where l.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid and (pg_catalog.lower(u.email) is distinct from l.email
      or u.raw_app_meta_data->>'uniondemo_run_id' is distinct from l.run_id::text))) then
    raise exception 'production removal ownership preflight refused' using errcode = '55000'; end if;
  select coalesce(array_agg(c.user_id), array[]::uuid[]) into selected_users
  from (
    select u.id user_id from auth.users u join private.production_residue_ledger l on l.subject_id = u.id::text
      where l.subject_kind = 'account' and l.cohort = p_cohort
    union all
    select u.id from auth.users u join private.uniondemo_ledger l on l.user_id = u.id
      where p_cohort = 'uniondemo' and l.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid
        and not exists (select 1 from private.production_residue_ledger k where k.cohort = 'account-kept' and k.subject_id = u.id::text)
  ) c
  left join private.production_residue_ledger l on l.subject_kind = 'account' and l.subject_id = c.user_id::text
  where not (coalesce(l.own_domain, false) and coalesce(w.own_domain_disposition = 'preserve', false));
  select count(*) into before_sessions from auth.sessions s where s.user_id in (select unnest(selected_users));
  select count(*) into before_tokens from auth.refresh_tokens t where t.user_id::text in (select x::text from unnest(selected_users) x);
  delete from public.member_push_subscriptions s where s.user_id in (select unnest(selected_users));
  delete from public.member_native_push_installations s where s.user_id in (select unnest(selected_users));
  delete from auth.sessions s where s.user_id in (select unnest(selected_users));
  delete from auth.refresh_tokens t where t.user_id::text in (select x::text from unnest(selected_users) x);
  select count(*) into after_sessions from auth.sessions s where s.user_id in (select unnest(selected_users));
  select count(*) into after_tokens from auth.refresh_tokens t where t.user_id::text in (select x::text from unnest(selected_users) x);
  if after_sessions <> 0 or after_tokens <> 0 then raise exception 'production residue sessions remain' using errcode = '55000'; end if;
  if not exists (select 1 from private.production_residue_windows where expires_at > pg_catalog.clock_timestamp()) then
    raise exception 'production removal window expired during operation' using errcode = '55000'; end if;
  -- Already-issued access tokens remain valid until expiry (Auth default one
  -- hour); removal of the user follows in this same attended window.
  return pg_catalog.jsonb_build_object('cohort', p_cohort, 'before_sessions', before_sessions, 'before_tokens', before_tokens,
    'after_sessions', after_sessions, 'after_tokens', after_tokens, 'state',
    case when w.own_domain_disposition = 'preserve' and p_cohort in ('account-4b', 'account-bootstrap') then 'preserved' else 'revoked' end);
end;
$function$;
revoke all on function public.production_residue_revoke_sessions(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.production_residue_revoke_sessions(text, text, text) to service_role;

-- Read-only catalogue completeness check. The DELETE statements below remain a
-- static reviewed list. Newly introduced tables can only stop the operation;
-- they can never acquire deletion authority by adding a foreign key.
create function private.production_residue_check_references(p_org uuid, p_before boolean)
returns void language plpgsql security definer set search_path = '' as $function$
declare fk record; occupied boolean;
begin
  for fk in
    select ns.nspname, rel.relname, k.confrelid,
      (select string_agg(format('r.%I = t.%I', a.attname, b.attname), ' and ' order by u.n)
        from unnest(k.conkey, k.confkey) with ordinality u(child_key, parent_key, n)
        join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.child_key
        join pg_catalog.pg_attribute b on b.attrelid = k.confrelid and b.attnum = u.parent_key) predicate
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class rel on rel.oid = k.conrelid
    join pg_catalog.pg_namespace ns on ns.oid = rel.relnamespace
    where k.contype = 'f' and k.confrelid in ('public.organizations'::regclass, 'public.chapters'::regclass)
      and k.conrelid not in ('public.chapters'::regclass, 'public.member_profiles'::regclass)
  loop
    if p_before and (fk.nspname || '.' || fk.relname) = any(array[
      'private.casework_record_versions',
      'private.chapter_task_number_counters',
      'private.dues_financial_identity_selections',
      'private.meeting_minutes_event_notices',
      'private.member_password_reissues',
      'private.mi1_w2_operation_receipt_rows',
      'private.organization_catalog_placements',
      'private.organization_notification_outbound_counters',
      'public.casework_audit_events',
      'public.casework_bargaining_events',
      'public.casework_bargaining_proposals',
      'public.casework_bargaining_workspaces',
      'public.casework_checklist_templates',
      'public.casework_deadlines',
      'public.casework_intake_drafts',
      'public.chapter_contact_log',
      'public.chapter_contact_log_versions',
      'public.chapter_documents',
      'public.chapter_record_versions',
      'public.chapter_records',
      'public.chapter_space_notification_settings',
      'public.chapter_spaces',
      'public.chapter_task_activity',
      'public.chapter_task_assignments',
      'public.chapter_task_attachments',
      'public.chapter_task_comments',
      'public.chapter_task_messages',
      'public.chapter_tasks',
      'public.chapter_thread_posts',
      'public.chapter_threads',
      'public.chapter_workstreams',
      'public.dues_member_subjects',
      'public.engagement_delivery_outbox',
      'public.form_templates',
      'public.meeting_attendance',
      'public.meeting_minutes_dispatches',
      'public.member_access_events',
      'public.member_admin_audit',
      'public.member_ai_requests',
      'public.member_ballots',
      'public.member_broadcasts',
      'public.member_cases',
      'public.member_chapter_memberships',
      'public.member_contact_notes',
      'public.member_conversations',
      'public.member_emergency_checklists',
      'public.member_events',
      'public.member_guide_messages',
      'public.member_guide_threads',
      'public.member_invitation_audit',
      'public.member_invitations',
      'public.member_presence',
      'public.member_qa_questions',
      'public.member_qa_votes',
      'public.member_role_chapters',
      'public.member_roles',
      'public.member_support_events',
      'public.member_surveys',
      'public.member_weekly_questions',
      'public.mfa_recovery_code_sets',
      'public.mfa_recovery_codes',
      'public.org_security_policy',
      'public.organization_audit_events',
      'public.organization_audit_ledger',
      'public.organization_chart_nodes',
      'public.organization_configuration_audit',
      'public.organization_engagement_events',
      'public.organization_failed_login_attempts',
      'public.organization_integrations',
      'public.organization_intelligence_audit_events',
      'public.organization_member_operational_profiles',
      'public.organization_memberships',
      'public.organization_page_views',
      'public.organization_retention_policies',
      'public.organization_role_grants',
      'public.organization_setting_values',
      'public.organization_structure_imports'
    ]) then continue; end if;
    -- Same read-only catalogue technique as the retained October 11 footprint.
    -- Only catalog-quoted names and a quoted UUID enter this SELECT; neither
    -- callers nor new foreign keys can introduce a write or a policy change.
    select coalesce((xpath('/row/occupied/text()', pg_catalog.query_to_xml(
      format('select exists(select 1 from %I.%I r join %s t on %s where %s = %L::uuid) occupied',
        fk.nspname, fk.relname, fk.confrelid::regclass, fk.predicate,
        case when fk.confrelid = 'public.organizations'::regclass then 't.id' else 't.organization_id' end, p_org),
      false, true, '')))[1]::text::boolean, false) into occupied;
    if occupied then
      raise exception 'production residue unremoved or unreviewed dependency' using errcode = '55000';
    end if;
  end loop;
end;
$function$;
revoke all on function private.production_residue_check_references(uuid, boolean) from public, anon, authenticated, service_role;

create function public.production_residue_remove_batch(p_cohort text, p_batch integer, p_target_ref text, p_confirm_token text)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '300s' set lock_timeout = '3s' as $function$
declare
  w private.production_residue_windows%rowtype;
  selected_org uuid;
  selected_users uuid[];
  message_id uuid;
  removed bigint := 0;
  remaining bigint;
  preserved bigint := 0;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('production-residue-window', 0));
  if p_cohort is null or p_cohort not in ('org-content', 'org-shell', 'account-4a', 'account-4b', 'account-4c', 'account-bootstrap') then
    raise exception 'production residue cohort refused' using errcode = '42501'; end if;
  if p_batch is null or p_batch < 1 or p_batch > 50 or (p_cohort like 'org-%' and p_batch <> 1) then
    raise exception 'production residue batch size refused' using errcode = '22023'; end if;
  perform private.production_residue_authorize(case when p_cohort = 'account-bootstrap' then 'bootstrap' else 'swarm' end,
    'remove-batch', p_target_ref, p_confirm_token);
  select * into w from private.production_residue_windows;
  if p_cohort like 'account-%' then
    if (p_cohort = 'account-4b' or exists (select 1 from private.production_residue_ledger l where l.cohort = p_cohort and l.own_domain))
      and w.own_domain_confirmed_count is distinct from 3 then
      raise exception 'production residue own-domain confirmation refused' using errcode = '42501'; end if;
    if exists (select 1 from private.production_residue_ledger l join auth.users u on u.id::text = l.subject_id
      where l.cohort = p_cohort and l.own_domain) and w.own_domain_disposition is null then
      raise exception 'production residue own-domain disposition refused' using errcode = '42501'; end if;
    if p_cohort in ('account-4a', 'account-4b', 'account-4c') and exists (
      select 1 from private.production_residue_ledger where cohort = 'org' and content_removed_at is null) then
      raise exception 'production residue organization content remains' using errcode = '55000'; end if;
    select count(*) into preserved from private.production_residue_ledger l join auth.users u on u.id::text = l.subject_id
      where l.cohort = p_cohort and l.own_domain and w.own_domain_disposition = 'preserve';
    select coalesce(array_agg(id order by id), array[]::uuid[]) into selected_users from (
      select u.id from private.production_residue_ledger l join auth.users u on u.id::text = l.subject_id
      where l.subject_kind = 'account' and l.cohort = p_cohort and l.cohort <> 'account-kept'
        and (not l.own_domain or w.own_domain_disposition = 'remove')
      order by l.subject_id limit p_batch for update of u
    ) selected;
    if exists (select 1 from auth.sessions s join private.production_residue_ledger l on l.subject_id = s.user_id::text
        where l.subject_kind = 'account' and l.cohort = p_cohort and (not l.own_domain or w.own_domain_disposition = 'remove'))
      or exists (select 1 from auth.refresh_tokens t join private.production_residue_ledger l on l.subject_id = t.user_id::text
        where l.subject_kind = 'account' and l.cohort = p_cohort and (not l.own_domain or w.own_domain_disposition = 'remove')) then
      raise exception 'production residue sessions remain' using errcode = '55000'; end if;
    -- A kept organization and its chapter cannot be reached by another cohort's
    -- Auth cascade, membership removal, or message redaction.
    if exists (select 1 from public.organization_memberships m join private.production_residue_ledger l
        on l.subject_kind = 'organization' and l.subject_id = m.organization_id::text and l.cohort = 'org-kept'
        where m.user_id = any(selected_users))
      or exists (select 1 from public.member_profiles p join private.production_residue_ledger l
        on l.subject_kind = 'chapter' and l.subject_id = p.chapter_id and l.cohort = 'chapter-kept' where p.id = any(selected_users))
      or exists (select 1 from public.member_chapter_memberships m join private.production_residue_ledger l
        on l.subject_kind = 'chapter' and l.subject_id = m.chapter_id and l.cohort = 'chapter-kept'
        where m.user_id = any(selected_users))
      or exists (select 1 from public.organization_role_grants g join private.production_residue_ledger l
        on l.subject_kind = 'organization' and l.subject_id = g.organization_id::text and l.cohort = 'org-kept'
        where g.user_id = any(selected_users) or g.granted_by = any(selected_users))
      or exists (select 1 from public.member_roles r
        where (r.user_id = any(selected_users) or r.granted_by = any(selected_users)) and (
          exists (select 1 from private.production_residue_ledger l
            where l.subject_kind = 'chapter' and l.subject_id = r.chapter_id and l.cohort = 'chapter-kept')
          or exists (select 1 from private.production_residue_ledger l
            where l.subject_kind = 'account' and l.subject_id = r.user_id::text and l.cohort = 'account-kept')
          or exists (select 1 from public.member_role_chapters c join private.production_residue_ledger l
            on l.subject_kind = 'chapter' and l.subject_id = c.chapter_id and l.cohort = 'chapter-kept'
            where c.user_id = r.user_id and c.role = r.role)))
      or exists (select 1 from public.member_role_chapters r join private.production_residue_ledger l
        on l.subject_kind = 'chapter' and l.subject_id = r.chapter_id and l.cohort = 'chapter-kept'
        where r.user_id = any(selected_users) or r.granted_by = any(selected_users))
      or exists (select 1 from public.member_conversations c join private.production_residue_ledger l
        on l.subject_kind = 'organization' and l.subject_id = c.organization_id::text and l.cohort = 'org-kept'
        where c.user_id = any(selected_users) or c.steward_user_id = any(selected_users))
      or exists (select 1 from public.member_messages m join public.member_conversations c on c.id = m.conversation_id
        join private.production_residue_ledger l on l.cohort = 'account-kept'
          and (l.subject_id = m.sender_id::text or l.subject_id = m.user_id::text or l.subject_id = c.user_id::text)
        where c.user_id = any(selected_users) or m.user_id = any(selected_users) or m.sender_id = any(selected_users)) then
      raise exception 'production residue kept scope refused' using errcode = '55000'; end if;
    if exists (select 1 from public.member_conversations c
      where (c.user_id = any(selected_users)
        or exists (select 1 from public.member_messages m where m.conversation_id = c.id and (m.user_id = any(selected_users) or m.sender_id = any(selected_users)))
        or exists (select 1 from public.member_scheduled_messages s where s.conversation_id = c.id and (s.actor_id = any(selected_users) or s.recipient_id = any(selected_users)))
        or exists (select 1 from public.compass_message_briefings b where b.source_kind = 'private' and b.target_id = c.id and b.requested_by = any(selected_users))
        or exists (select 1 from public.compass_workspace_actions a join public.member_messages m on m.id::text = a.source_id
          where a.source_kind = 'message' and m.conversation_id = c.id and a.actor_user_id = any(selected_users)))
        and private.member_message_under_legal_hold(c.id)) then
      raise exception 'production residue preservation order refused' using errcode = '55000'; end if;
    for message_id in select m.id from public.member_messages m join public.member_conversations c on c.id = m.conversation_id
      where c.user_id = any(selected_users) or m.user_id = any(selected_users) or m.sender_id = any(selected_users) order by m.id loop
      perform private.redact_member_message_row(message_id, 'account_closed', null);
    end loop;
    delete from auth.users where id = any(selected_users);
    get diagnostics removed = row_count;
    select count(*) into remaining from private.production_residue_ledger l join auth.users u on u.id::text = l.subject_id
      where l.subject_kind = 'account' and l.cohort = p_cohort;
  else
    select o.id into selected_org from public.organizations o join private.production_residue_ledger l
      on l.subject_kind = 'organization' and l.subject_id = o.id::text and l.cohort = 'org'
      where p_cohort = 'org-shell' or l.content_removed_at is null
      order by l.subject_id limit 1 for update of o;
    if selected_org is not null then
      if exists (select 1 from public.chapters c where c.organization_id = selected_org
        and not exists (select 1 from private.production_residue_ledger l where l.subject_kind = 'chapter' and l.subject_id = c.id and l.cohort = 'chapter')) then
        raise exception 'production residue chapter ownership refused' using errcode = '55000'; end if;
      if p_cohort = 'org-content' then
        -- All checks precede redaction; any failure also rolls the transaction back.
        if exists (select 1 from public.member_profiles p join public.chapters c on c.id = p.chapter_id
            join private.production_residue_ledger l on l.cohort = 'account-kept' and l.subject_id = p.id::text
            where c.organization_id = selected_org)
          or exists (select 1 from public.organization_memberships m join private.production_residue_ledger l
            on l.cohort = 'account-kept' and l.subject_id = m.user_id::text where m.organization_id = selected_org) then
          raise exception 'production residue kept scope refused' using errcode = '55000'; end if;
        if exists (select 1 from public.member_conversations c where c.organization_id = selected_org
          and private.member_message_under_legal_hold(c.id)) then
          raise exception 'production residue preservation order refused' using errcode = '55000'; end if;
        if exists (select 1 from public.member_conversations c join private.production_residue_ledger l
            on l.cohort = 'account-kept' and (l.subject_id = c.user_id::text or l.subject_id = c.steward_user_id::text)
            where c.organization_id = selected_org)
          or exists (select 1 from public.member_messages m join public.member_conversations c on c.id = m.conversation_id
            join private.production_residue_ledger l on l.cohort = 'account-kept' and (l.subject_id = m.sender_id::text or l.subject_id = m.user_id::text)
            where c.organization_id = selected_org) then
          raise exception 'production residue kept scope refused' using errcode = '55000'; end if;
        perform private.production_residue_check_references(selected_org, true);
        for message_id in select m.id from public.member_messages m join public.member_conversations c on c.id = m.conversation_id
          where c.organization_id = selected_org order by m.id loop
          perform private.redact_member_message_row(message_id, 'account_closed', null);
        end loop;
        insert into private.production_residue_audit_context(backend_pid, transaction_id, organization_id)
          values (pg_catalog.pg_backend_pid(), pg_catalog.txid_current(), selected_org);
        delete from private.casework_record_versions r where r.organization_id = selected_org;
        delete from private.chapter_task_number_counters r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from private.dues_financial_identity_selections r where r.organization_id = selected_org;
        delete from private.meeting_minutes_event_notices r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from private.member_password_reissues r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from private.mi1_w2_operation_receipt_rows r where r.organization_id = selected_org;
        delete from private.organization_catalog_placements r where r.organization_id = selected_org;
        delete from private.organization_notification_outbound_counters r where r.organization_id = selected_org;
        delete from public.casework_audit_events r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.casework_bargaining_events r where r.organization_id = selected_org;
        delete from public.casework_checklist_templates r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.casework_deadlines r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.casework_intake_drafts r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_contact_log_versions r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_documents r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_record_versions r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_space_notification_settings r where r.organization_id = selected_org;
        delete from public.chapter_task_activity r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_task_assignments r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_task_attachments r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_task_comments r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_task_messages r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_thread_posts r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_workstreams r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.dues_member_subjects r where r.organization_id = selected_org;
        delete from public.engagement_delivery_outbox r where r.organization_id = selected_org;
        delete from public.form_templates r where r.organization_id = selected_org;
        delete from public.meeting_attendance r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.meeting_minutes_dispatches r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_access_events r where r.organization_id = selected_org;
        delete from public.member_admin_audit r where r.organization_id = selected_org;
        delete from public.member_ai_requests r where r.organization_id = selected_org;
        delete from public.member_ballots r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_broadcasts r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_contact_notes r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_emergency_checklists r where r.organization_id = selected_org;
        delete from public.member_guide_messages r where r.organization_id = selected_org;
        delete from public.member_invitation_audit r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_presence r where r.organization_id = selected_org;
        delete from public.member_qa_votes r where r.organization_id = selected_org;
        delete from public.member_role_chapters r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_support_events r where r.organization_id = selected_org;
        delete from public.member_surveys r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_weekly_questions r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.mfa_recovery_code_sets r where r.organization_id = selected_org;
        delete from public.mfa_recovery_codes r where r.organization_id = selected_org;
        delete from public.org_security_policy r where r.organization_id = selected_org;
        delete from public.organization_audit_events r where r.organization_id = selected_org;
        delete from public.organization_audit_ledger r where r.organization_id = selected_org;
        delete from public.organization_chart_nodes r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.organization_configuration_audit r where r.organization_id = selected_org;
        delete from public.organization_engagement_events r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.organization_failed_login_attempts r where r.organization_id = selected_org;
        delete from public.organization_integrations r where r.organization_id = selected_org;
        delete from public.organization_intelligence_audit_events r where r.organization_id = selected_org;
        delete from public.organization_member_operational_profiles r where r.organization_id = selected_org;
        delete from public.organization_page_views r where r.organization_id = selected_org;
        delete from public.organization_retention_policies r where r.organization_id = selected_org;
        delete from public.organization_role_grants r where r.organization_id = selected_org;
        delete from public.organization_setting_values r where r.organization_id = selected_org;
        delete from public.organization_structure_imports r where r.organization_id = selected_org;
        delete from public.casework_bargaining_proposals r where r.organization_id = selected_org;
        delete from public.chapter_contact_log r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_records r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_chapter_memberships r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_conversations r where r.organization_id = selected_org;
        delete from public.member_events r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_guide_threads r where r.organization_id = selected_org;
        delete from public.member_invitations r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_qa_questions r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_roles r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.organization_memberships r where r.organization_id = selected_org;
        delete from public.casework_bargaining_workspaces r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_threads r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_spaces r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_tasks r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.member_cases r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.chapter_task_activity r where r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        delete from public.casework_audit_events r where r.organization_id = selected_org or r.chapter_id in (select c.id from public.chapters c join private.production_residue_ledger l on l.subject_id = c.id and l.cohort = 'chapter' where c.organization_id = selected_org);
        -- Deleting checklist templates and other versioned roots can append
        -- organization-scoped history with no case_id. Sweep it after every
        -- version-producing delete, before proving the organization empty.
        delete from private.casework_record_versions r where r.organization_id = selected_org;
        delete from public.organization_audit_events r where r.organization_id = selected_org;
        delete from public.organization_audit_ledger r where r.organization_id = selected_org;
        delete from private.production_residue_audit_context
          where backend_pid = pg_catalog.pg_backend_pid() and transaction_id = pg_catalog.txid_current();
        perform private.production_residue_check_references(selected_org, false);
        update private.production_residue_ledger set content_removed_at = pg_catalog.clock_timestamp()
          where cohort = 'org' and subject_id = selected_org::text;
      else
        if exists (select 1 from private.production_residue_ledger where cohort = 'org' and subject_id = selected_org::text and content_removed_at is null) then
          raise exception 'production residue organization content remains' using errcode = '55000'; end if;
        if exists (select 1 from public.member_profiles p join public.chapters c on c.id = p.chapter_id where c.organization_id = selected_org) then
          raise exception 'production residue chapter still has profiles' using errcode = '55000'; end if;
        perform private.production_residue_check_references(selected_org, false);
        delete from public.chapters c using private.production_residue_ledger l
          where l.cohort = 'chapter' and l.subject_kind = 'chapter' and l.subject_id = c.id and c.organization_id = selected_org;
        delete from public.organizations where id = selected_org;
      end if;
      removed := 1;
    end if;
    select count(*) into remaining from public.organizations o join private.production_residue_ledger l
      on l.subject_kind = 'organization' and l.subject_id = o.id::text and l.cohort = 'org'
      where p_cohort = 'org-shell' or l.content_removed_at is null;
  end if;
  if not exists (select 1 from private.production_residue_windows where expires_at > pg_catalog.clock_timestamp()) then
    raise exception 'production removal window expired during operation' using errcode = '55000'; end if;
  return pg_catalog.jsonb_build_object('cohort', p_cohort, 'removed', removed, 'remaining', remaining,
    'state', case when remaining = 0 then 'removed' when remaining = preserved then 'preserved' else 'removing' end);
end;
$function$;
revoke all on function public.production_residue_remove_batch(text, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function public.production_residue_remove_batch(text, integer, text, text) to service_role;

create function public.production_residue_status()
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '60s' as $function$
declare result jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'production removal requires service_role' using errcode = '42501'; end if;
  select coalesce(jsonb_object_agg(cohort, counts), '{}'::jsonb) into result from (
    select l.cohort, jsonb_build_object('ledger', count(*),
      'content_remaining', count(*) filter (where l.cohort = 'org' and l.content_removed_at is null),
      'remaining', count(*) filter (where
        (l.subject_kind = 'account' and exists (select 1 from auth.users u where u.id::text = l.subject_id))
        or (l.subject_kind = 'organization' and exists (select 1 from public.organizations o where o.id::text = l.subject_id))
        or (l.subject_kind = 'chapter' and exists (select 1 from public.chapters c where c.id = l.subject_id)))) counts
    from private.production_residue_ledger l group by l.cohort
  ) x;
  return jsonb_build_object('cohorts', result, 'sessions', (
    select jsonb_object_agg(cohort_name, jsonb_build_object('sessions', sessions, 'tokens', tokens)) from (
      select cohorts.cohort_name,
        (select count(*) from auth.sessions s where exists (select 1 from private.production_residue_ledger l where l.subject_kind = 'account' and l.cohort = cohorts.cohort_name and l.subject_id = s.user_id::text) or (cohorts.cohort_name = 'uniondemo' and exists (select 1 from private.uniondemo_ledger l where l.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid and l.user_id = s.user_id))) sessions,
        (select count(*) from auth.refresh_tokens t where exists (select 1 from private.production_residue_ledger l where l.subject_kind = 'account' and l.cohort = cohorts.cohort_name and l.subject_id = t.user_id::text) or (cohorts.cohort_name = 'uniondemo' and exists (select 1 from private.uniondemo_ledger l where l.run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid and l.user_id::text = t.user_id::text))) tokens
      from unnest(array['uniondemo', 'account-4a', 'account-4b', 'account-kept', 'account-4c', 'account-bootstrap']) as cohorts(cohort_name)
    ) counts),
    'protected_accounts', (select count(*) from auth.users u
      where not exists (select 1 from private.production_residue_ledger l where l.subject_kind = 'account' and l.subject_id = u.id::text)
        and not exists (select 1 from private.uniondemo_ledger l where l.user_id = u.id)
        and not exists (select 1 from private.member_stress_ledger l where l.user_id = u.id)),
    'protected_organizations', (select count(*) from public.organizations o
      where not exists (select 1 from private.production_residue_ledger l where l.subject_kind = 'organization' and l.subject_id = o.id::text)),
    'accounted_uniondemo', (select private.production_residue_snapshot_accounted(r.protected_snapshot, private.uniondemo_protected_snapshot(r.id), 'uniondemo')
      from private.uniondemo_runs r where r.id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid),
    'accounted_member_stress', (select private.production_residue_snapshot_accounted(r.protected_snapshot, private.member_stress_protected_snapshot(r.id), 'member_stress')
      from private.member_stress_runs r where r.id = '6aae4c0b-856d-4fa9-a26c-ce21a1179f8d'::uuid));
end;
$function$;
revoke all on function public.production_residue_status() from public, anon, authenticated, service_role;
grant execute on function public.production_residue_status() to service_role;

-- Captured trigger substitutions follow. No seed, apply, login or snapshot
-- refresh body is replaced by this migration.

-- captured Main body SHA-256: bd18a57d8212da747472de6ee2d63c29e389e03fdf62a1e40f0b6c0e494cdff2
CREATE OR REPLACE FUNCTION private.forbid_organization_audit_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' and (select auth.role()) = 'service_role'
    and exists (select 1 from private.production_residue_audit_context c
      where c.backend_pid = pg_catalog.pg_backend_pid() and c.transaction_id = pg_catalog.txid_current()
        and c.organization_id = old.organization_id)
    and exists (select 1 from private.production_residue_ledger l where l.cohort = 'org'
      and l.subject_kind = 'organization' and l.subject_id = old.organization_id::text)
    and exists (select 1 from private.production_residue_windows w
      where w.project_ref = 'productionprojectref'
        and w.system_identifier = (select system_identifier::numeric from pg_catalog.pg_control_system())
        and w.database_oid = (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database())
        and w.opened_at <= pg_catalog.clock_timestamp() and w.expires_at > pg_catalog.clock_timestamp()) then
    return old;
  end if;
  raise exception 'organization audit events are append-only' using errcode = '55000';
end;
$function$
;

-- captured Main body SHA-256: d4c46a480061b5ed065f5c6ef1f06c6b7a25a535fb783b165e1e472a128d6adc
CREATE OR REPLACE FUNCTION private.mi1_audit_ledger_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' and (select auth.role()) = 'service_role'
    and exists (select 1 from private.production_residue_audit_context c
      where c.backend_pid = pg_catalog.pg_backend_pid() and c.transaction_id = pg_catalog.txid_current()
        and c.organization_id = old.organization_id)
    and exists (select 1 from private.production_residue_ledger l where l.cohort = 'org'
      and l.subject_kind = 'organization' and l.subject_id = old.organization_id::text)
    and exists (select 1 from private.production_residue_windows w
      where w.project_ref = 'productionprojectref'
        and w.system_identifier = (select system_identifier::numeric from pg_catalog.pg_control_system())
        and w.database_oid = (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database())
        and w.opened_at <= pg_catalog.clock_timestamp() and w.expires_at > pg_catalog.clock_timestamp()) then
    return old;
  end if;
  if tg_op = 'DELETE'
     and (select auth.role()) = 'service_role'
     and old.source = 'demo_seed'
     and old.metadata ->> 'reasonCode' = 'sample-seed'
     and old.metadata ->> 'runId' = pg_catalog.current_setting('unionground.demo_seed_remove_run', true) then
    return old;
  end if;
  raise exception 'organization audit ledger is append-only' using errcode = '55000';
end;
$function$
;

commit;
