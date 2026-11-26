-- BUG-UG-LEARNING-CASE-OUTCOME-UNDO-NOTICE-20261108 (#7634)
-- As with task undo, sent notices stay sent; a correcting notice describes
-- the restored state. No case or outcome content enters notification copy.
begin;

insert into private.notification_copy (key, lang, title, body)
values
  ('case.reopened', 'en', 'Your case was reopened', 'A practice resolution was undone. Open Cases to see its current status.'),
  ('case.reopened', 'es', 'Tu caso se reabrió', 'Se deshizo una resolución de práctica. Abre Casos para ver su estado actual.')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

create or replace function private.learning_undo_case_outcome(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  recipient uuid;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_cases c where c.id = target for update;
    perform 1 from public.member_case_outcomes o where o.case_id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_outcome_state(target);
  elsif p_mode = 'before' then
    return image;
  elsif p_mode = 'check' then
    -- Preserve the writer's current coordinator, scope, MFA and visibility gate.
    perform private.coordinator_case_for_update(target);
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  -- The outcome is applied before its parent case edit. An intermediate
  -- reopening is not the final state: older case entries can resolve it again.
  -- The engine supplies the complete validated projection and locked chain.
  -- Pick one eligible notice source per case, so multiple resolutions in the
  -- same chain still produce only one correction when its final case is active.
  -- The case updated_at and notice created_at both use the forward write's
  -- transaction timestamp. Read the immutable version, not today's outcome
  -- timestamp: a chain can already have restored a newer outcome. Requiring
  -- an existing notice also excludes pre-notification and suppressed writes.
  select c.user_id into recipient
  from public.member_cases c
  join lateral (
    select outcome_entry.id
    from private.learning_action_journal outcome_entry
    join private.learning_action_journal j
      on j.id = outcome_entry.parent_entry_id
     and j.target_table = 'public.member_cases' and j.target_id = c.id::text
     and j.organization_id = c.organization_id and j.action_kind = 'case_edit'
    join private.casework_record_versions v
      on v.id = j.before_ref and v.case_id = c.id
     and v.record_table = 'member_cases' and v.op = 'UPDATE'
    where outcome_entry.id in (
      select chain_id::uuid from pg_catalog.jsonb_array_elements_text(p_entry -> 'chain_entry_ids') chain_id
    )
      and outcome_entry.target_table = 'public.member_case_outcomes'
      and outcome_entry.target_id = c.id::text
      and outcome_entry.organization_id = c.organization_id
      and outcome_entry.action_kind = 'case_outcome'
      and v.old_row ->> 'status' = 'active'
      and v.new_row ->> 'status' = 'resolved'
      and exists (
        select 1 from public.member_notifications n
        where n.user_id = c.user_id and n.copy_key = 'case.resolved'
          and n.created_at = (v.new_row ->> 'updated_at')::timestamptz
      )
    order by outcome_entry.created_at desc, outcome_entry.id desc limit 1
  ) notice_source on notice_source.id = (p_entry ->> 'id')::uuid
  where c.id = target
    and p_entry -> 'final_projected' -> ('public.member_cases:' || target::text) ->> 'status' = 'active';

  if not coalesce((image ->> 'existed')::boolean, false) then
    delete from public.member_case_outcomes o where o.case_id = target;
  else
    update public.member_case_outcomes o
    set outcome = image ->> 'outcome', summary = image ->> 'summary',
        recorded_by = (image ->> 'recorded_by')::uuid, updated_at = pg_catalog.now()
    where o.case_id = target;
  end if;
  if recipient is not null then
    perform private.notify_member(recipient, 'case.reopened', '{}'::jsonb, 'cases');
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_case_outcome(text, jsonb) from public, anon, authenticated, service_role;

-- Supply every apply handler the completed projection, after all checks.
create or replace function public.undo_my_learning_action(p_entry_id uuid, p_expected_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid;
  requested private.learning_action_journal%rowtype;
  chain_ids uuid[];
  item record;
  target_key text;
  current_state jsonb;
  projected jsonb := '{}'::jsonb;
  undone integer := 0;
begin
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into requested from private.learning_action_journal j
  where j.id = p_entry_id and j.actor_user_id = caller and j.organization_id = org
  for update;
  if not found then
    raise exception 'learning entry not found' using errcode = 'P0002';
  end if;
  if requested.state = 'undone' then
    return pg_catalog.jsonb_build_object('status', 'already_undone', 'entryId', requested.id, 'version', requested.version);
  end if;
  if requested.state = 'kept' then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  if p_expected_version is distinct from requested.version then
    raise exception 'learning entry changed' using errcode = 'PT409';
  end if;

  -- The chain: this entry, your later active entries on the same targets,
  -- and every entry of a bulk action any of them belongs to (its parent and
  -- all its children), so a bulk action is never partly reversed. A parent
  -- joins whatever its state, and one no longer active refuses the undo.
  with recursive chain(id) as (
    select requested.id
    union
    select j.id
    from chain c
    join private.learning_action_journal cj on cj.id = c.id
    join private.learning_action_journal j
      on j.organization_id = org and j.period_id = requested.period_id
     and j.actor_user_id = caller
     and ((j.state = 'active'
           and ((j.target_table = cj.target_table and j.target_id = cj.target_id
                 and (j.created_at, j.id) > (cj.created_at, cj.id))
                or j.parent_entry_id = cj.id))
          or j.id = cj.parent_entry_id)
  )
  select pg_catalog.array_agg(chain.id order by chain.id) into chain_ids from chain;
  perform 1 from private.learning_action_journal j where j.id = any(chain_ids) order by j.id for update;

  if exists (
    select 1 from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids) and (j.state <> 'active' or k.disposition not in ('reverse', 'simulate'))
  ) then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  -- Someone else changed one of these targets after you: undo would take
  -- their work with it. What they sent on it stays sent and does not block.
  if exists (
    select 1
    from private.learning_action_journal c
    join private.learning_action_journal o
      on o.target_table = c.target_table and o.target_id = c.target_id
     and (o.created_at, o.id) > (c.created_at, c.id)
     and o.actor_user_id is distinct from caller and o.state <> 'undone'
    join private.learning_action_kinds ok on ok.action_kind = o.action_kind and ok.disposition <> 'permanent'
    where c.id = any(chain_ids)
  ) then
    raise exception 'someone else has changed this since' using errcode = 'PT409';
  end if;

  for item in
    select distinct j.target_table, j.target_id, k.handler
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids) and k.disposition = 'reverse'
    order by j.target_table, j.target_id
  loop
    perform private.learning_dispatch(item.handler, 'lock',
      pg_catalog.jsonb_build_object('target_table', item.target_table, 'target_id', item.target_id));
  end loop;

  -- Every lock is held: only now read the clock.
  if private.learning_period_running(org) is distinct from requested.period_id then
    raise exception 'the learning period has ended' using errcode = '55000';
  end if;

  for item in
    select j.*, k.handler, k.disposition
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids)
    order by j.created_at desc, j.id desc
  loop
    if item.disposition = 'reverse' then
      target_key := item.target_table || ':' || item.target_id;
      if projected ? target_key then
        current_state := projected -> target_key;
      else
        current_state := private.learning_dispatch(item.handler, 'state',
          pg_catalog.jsonb_build_object('target_table', item.target_table, 'target_id', item.target_id));
      end if;
      if private.learning_fingerprint(current_state) is distinct from item.after_fingerprint then
        raise exception 'this has changed since your practice action' using errcode = 'PT409';
      end if;
      projected := projected || pg_catalog.jsonb_build_object(target_key,
        coalesce(private.learning_dispatch(item.handler, 'before', pg_catalog.to_jsonb(item)), 'null'::jsonb));
      -- The handler authorizes against the state this entry is validated
      -- against (an edge a later step removed is judged as it stood) and
      -- sees what the newer steps already projected (a task this chain
      -- puts back is judged live).
      perform private.learning_dispatch(item.handler, 'check',
        pg_catalog.to_jsonb(item) || pg_catalog.jsonb_build_object('projected_state', current_state, 'projected', projected,
          'chain_entry_ids', chain_ids));
    end if;
  end loop;

  for item in
    select j.*, k.handler, k.disposition
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids)
    order by j.created_at desc, j.id desc
  loop
    if item.disposition = 'reverse' then
      perform private.learning_dispatch(item.handler, 'apply', pg_catalog.to_jsonb(item) || pg_catalog.jsonb_build_object('final_projected', projected, 'chain_entry_ids', chain_ids));
    end if;
    update private.learning_action_journal j
    set state = 'undone', undone_at = pg_catalog.clock_timestamp(), version = j.version + 1
    where j.id = item.id;
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'administration', 'learning_action_undone', 'update', caller,
      'learning_action', item.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('entryId', item.id, 'actionKind', item.action_kind, 'periodId', item.period_id)
    );
    undone := undone + 1;
  end loop;

  return pg_catalog.jsonb_build_object('status', 'undone', 'entryId', requested.id,
    'version', requested.version + 1, 'undoneCount', undone);
end;
end;
$function$;

commit;
