-- Role-map notifications wave (UB-SET-01, UB-SET-02, UB-SET-04, UB-CW-05 /
-- UB-CON-11, UB-RGT-03). Owner directives 2026-08-08: build the deadline /
-- vote / event producers (not hide the switches), implement the promised
-- 5-per-week nudge cap with the urgent override, defer quiet-hours outbound
-- instead of dropping it, deliver watch alerts, and make "your steward is
-- pinged instantly" true.
--
-- Also fixes a live defect found during the wave's research: the
-- outbound-eligible kind list inside expire_notification_deliveries() was
-- written before the 'tasks' (2026-07-28) and 'appointments' (2026-08-01)
-- topics existed and was never re-emitted, so every tasks/appointments
-- delivery has been terminalized as 'kind is not outbound-eligible' within
-- one dispatch tick. Task and appointment email/push never actually sent.
--
-- No new tables: producers are private.* sweeps keyed on nullable, ungranted
-- stamp columns (the appointment-reminder pattern), so rlsTableCount stays 79
-- and the table-grant census stays 118.

-- ---------------------------------------------------------------- 0. stamps

-- Nullable and deliberately ungranted: the client column grants on these
-- tables are exact lists, so an added column is invisible to members unless
-- someone grants it (the safe direction).
alter table public.member_cases
  add column deadline_notice_7_sent_at timestamptz,
  add column deadline_notice_3_sent_at timestamptz,
  add column deadline_notice_1_sent_at timestamptz;

comment on column public.member_cases.deadline_notice_7_sent_at is
  'Idempotency stamp for the 7-day deadline notice (deadline sweep, 20260809020000). Sending a closer notice back-fills the farther stamps so a case born inside the window gets exactly one notice.';

alter table public.member_ballots
  add column opened_notice_sent_at timestamptz,
  add column closing_notice_sent_at timestamptz,
  add column results_notice_sent_at timestamptz;

comment on column public.member_ballots.opened_notice_sent_at is
  'Idempotency stamps for the ballot notice sweep (20260809020000). Pre-stamped for every ballot that already existed when the sweep shipped, so the first tick cannot blast notices about long-open or long-closed ballots.';

alter table public.member_events
  add column reminder_notice_sent_at timestamptz;

comment on column public.member_events.reminder_notice_sent_at is
  'Idempotency stamp for the 24h event reminder (event notice sweep, 20260809020000). Reset by update_member_event when starts_at changes so a rescheduled event reminds again for its new time.';

-- Pre-stamp the world as it exists at apply time. 'Voting is open' about a
-- ballot that opened weeks ago (or results about a ballot closed in July)
-- would be noise, not news. Future ballots and future closings notify
-- normally. Cases are deliberately NOT pre-stamped: a true "deadline in N
-- days" notice on the first sweep is useful, not noise, and the sweep only
-- looks 7 days out.
update public.member_ballots set opened_notice_sent_at = now();
update public.member_ballots
  set closing_notice_sent_at = now(), results_notice_sent_at = now()
  where closes_at <= now() or not active;

-- ------------------------------------- 1. expire: repair the eligibility list

-- Body is 20260723202000's verbatim except the belt-and-braces kind list now
-- names all seven outbound-eligible topics. The old list predates 'tasks' and
-- 'appointments' and was killing their queues every tick.
create or replace function public.expire_notification_deliveries()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired integer := 0;
  exhausted integer := 0;
  ineligible integer := 0;
begin
  -- Ancient backlog never ships: once a provider is (re)configured we must not
  -- blast members with two-day-old alerts. This is also what bounds the
  -- quiet-hours deferral introduced in this same migration: a delivery that
  -- waits out a quiet window longer than 48 hours expires here instead of
  -- surprising the member days later ("defer, except items that expired").
  update public.member_notification_deliveries
    set status = 'skipped', last_error = 'expired before dispatch', updated_at = pg_catalog.now()
    where created_at < pg_catalog.now() - interval '48 hours'
      and (
        status = 'pending'
        or (status = 'sending' and updated_at < pg_catalog.now() - interval '15 minutes')
      );
  get diagnostics expired = row_count;

  update public.member_notification_deliveries
    set status = 'failed',
        last_error = coalesce(last_error, 'attempt budget exhausted'),
        updated_at = pg_catalog.now()
    where attempts >= 6
      and (
        status = 'pending'
        or (status = 'sending' and updated_at < pg_catalog.now() - interval '15 minutes')
      );
  get diagnostics exhausted = row_count;

  -- Belt and braces for the in-app-only rule. The list must equal the enqueue
  -- trigger's topic list exactly: when 'tasks' and 'appointments' were added
  -- there and not here, this clause silently terminalized both queues
  -- (found + fixed 20260809020000).
  update public.member_notification_deliveries d
    set status = 'skipped', last_error = 'kind is not outbound-eligible', updated_at = pg_catalog.now()
    from public.member_notifications n
    where n.id = d.notification_id
      and n.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments')
      and (
        d.status = 'pending'
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes')
      );
  get diagnostics ineligible = row_count;

  return pg_catalog.jsonb_build_object(
    'expired', expired, 'exhausted', exhausted, 'ineligible', ineligible);
end;
$$;

revoke all on function public.expire_notification_deliveries() from public, anon, authenticated;
grant execute on function public.expire_notification_deliveries() to service_role;

-- --------------------------------- 2. quiet hours defer instead of drop

-- UB-SET-04. The old shape decided at enqueue time: a BEFORE INSERT trigger
-- on the delivery table wrote suppressed rows terminal-'skipped', so a notice
-- born at 11pm was gone forever. New shape: the decision moves to CLAIM time.
-- Suppressed rows simply stay 'pending' and every 5-minute tick re-asks
-- "is this member still in quiet hours / DND?". The window ends (or DND is
-- switched off) and the very next tick delivers. The 48-hour expiry sweep is
-- the deferral bound. A side benefit: the old trigger also fired on the
-- rate-limit 'skipped' rows and overwrote their last_error with
-- 'suppressed: …', losing the audit reason — that corruption ends here.
drop trigger apply_member_focus_to_delivery on public.member_notification_deliveries;
drop function private.apply_member_focus_to_delivery();

-- The per-row focus question, factored for the claim predicate. Same logic
-- the old trigger used: urgent = deadlines/cases while the member allows
-- urgent alerts; quiet window computed in the member's own timezone with the
-- wrap-around case; corrupt timezone fails OPEN for delivery.
create function private.member_focus_blocks(p_user_id uuid, p_kind text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  profile record;
  local_time time;
  in_quiet_hours boolean := false;
  urgent boolean := false;
begin
  select p.dnd_enabled, p.quiet_hours_start, p.quiet_hours_end,
         p.quiet_hours_timezone, p.urgent_notifications_enabled
    into profile
  from public.member_profiles p where p.id = p_user_id;
  if not found then
    return false;
  end if;
  urgent := p_kind in ('deadlines', 'cases')
    and coalesce(profile.urgent_notifications_enabled, true);
  if profile.quiet_hours_start is not null and profile.quiet_hours_end is not null then
    begin
      local_time := (pg_catalog.now() at time zone profile.quiet_hours_timezone)::time;
      in_quiet_hours := case when profile.quiet_hours_start < profile.quiet_hours_end
        then local_time >= profile.quiet_hours_start and local_time < profile.quiet_hours_end
        else local_time >= profile.quiet_hours_start or local_time < profile.quiet_hours_end end;
    exception
      when invalid_parameter_value then
        -- Fail open for delivery if a legacy/corrupt timezone somehow exists.
        -- member_profiles_validate_focus_timezone prevents new invalid values.
        in_quiet_hours := false;
    end;
  end if;
  return (coalesce(profile.dnd_enabled, false) or in_quiet_hours) and not urgent;
end
$$;

revoke all on function private.member_focus_blocks(uuid, text) from public, anon, authenticated, service_role;

-- Claim re-emit: 20260723202000's verbatim body plus (a) the candidates CTE
-- joins member_notifications for the kind and (b) the focus predicate. FOR
-- UPDATE names d so the join does not lock notification rows.
create or replace function public.claim_notification_deliveries(p_channel text, p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap integer := greatest(1, least(coalesce(p_limit, 200), 500));
  max_subscriptions constant integer := 10;
  outbound_on boolean;
  claimed jsonb;
begin
  if p_channel is null or p_channel not in ('email', 'push', 'sms') then
    raise exception 'unknown channel' using errcode = '22023';
  end if;

  select c.outbound_enabled into outbound_on
    from private.notification_controls c where c.id;
  if not coalesce(outbound_on, false) then
    return '[]'::jsonb;
  end if;

  with candidates as (
    select d.id
    from public.member_notification_deliveries d
    join public.member_notifications n on n.id = d.notification_id
    where d.channel = p_channel
      and d.attempts < 6
      and d.created_at >= pg_catalog.now() - interval '48 hours'
      and (
        (d.status = 'pending' and d.next_attempt_at <= pg_catalog.now())
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes')
      )
      -- Quiet hours / DND defer at the claim boundary (UB-SET-04): a
      -- suppressed row is not terminalized, it is simply not claimable this
      -- tick. Urgent kinds (deadlines, cases) pass while the member allows
      -- urgent alerts. The 48h window above bounds the deferral.
      and not private.member_focus_blocks(d.user_id, n.kind)
    order by d.next_attempt_at
    limit cap
    for update of d skip locked
  ),
  flipped as (
    update public.member_notification_deliveries d
      set status = 'sending', attempts = d.attempts + 1, updated_at = pg_catalog.now()
      from candidates c
      where d.id = c.id
      returning d.id, d.notification_id, d.user_id, d.attempts
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deliveryId', f.id,
    'kind', n.kind,
    'lang', coalesce(pr.language, 'en'),
    'attempt', f.attempts,
    'email', case when p_channel = 'email' then u.email end,
    'subscriptions', case when p_channel = 'push' then (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth_key))
      from (
        select s2.endpoint, s2.p256dh, s2.auth_key
        from public.member_push_subscriptions s2
        where s2.user_id = f.user_id
        order by s2.last_seen_at desc
        limit max_subscriptions
      ) s
    ) end)), '[]'::jsonb)
  into claimed
  from flipped f
  join public.member_notifications n on n.id = f.notification_id
  left join public.member_profiles pr on pr.id = f.user_id
  left join auth.users u on u.id = f.user_id;

  -- NOTE: title and body are deliberately absent. Provider payloads are
  -- generic per-kind templates, so the notification's own text must never
  -- leave the database — the dispatcher cannot leak what it never receives.
  return claimed;
end;
$$;

revoke all on function public.claim_notification_deliveries(text, integer) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(text, integer) to service_role;

-- ------------------------------------------- 3. the five-a-week promise

-- UB-SET-02. Settings has told every member "We cap nudges at 5 per week —
-- deadlines always get through" since the card shipped; the delivery path
-- only ever had 12/hour + 50/day. This re-emit (v3 = 20260801120000,
-- verbatim otherwise) adds the promised cap: at most 5 non-urgent topical
-- enqueues per recipient per rolling 7 days, counted on the email channel
-- (push mirrors email 1:1, counting both would double-charge) and excluding
-- suppressed rows (a rate-limited row must not consume next week's
-- allowance). 'deadlines' and 'cases' — the delivery plane's existing urgent
-- classification — bypass the cap and do not count toward it, per owner
-- decision 2026-08-08.
create or replace function private.enqueue_notification_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prefs jsonb;
  pref_value jsonb;
  outbound_on boolean;
  recent_hour integer;
  recent_day integer;
  recent_week integer := 0;
  org_today integer;
  limit_reason text;
  max_per_recipient_hour constant integer := 12;
  max_per_recipient_day constant integer := 50;
  max_per_recipient_week constant integer := 5;
  max_org_day constant integer := 20000;
begin
  -- 'general' is in-app only and must never reach a provider. Short-circuit
  -- before the control flag, before prefs, before anything.
  if new.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments') then
    return new;
  end if;

  begin
    select c.outbound_enabled into outbound_on
      from private.notification_controls c where c.id;
    if not coalesce(outbound_on, false) then
      return new;
    end if;

    select p.notification_prefs into prefs
      from public.member_profiles p where p.id = new.user_id;

    pref_value := prefs -> new.kind;
    if pref_value = 'false'::jsonb then
      return new;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_notification_rate:' || new.user_id::text, 0));

    select pg_catalog.count(*) into recent_hour
      from public.member_notification_deliveries d
      where d.user_id = new.user_id
        and d.created_at > pg_catalog.now() - interval '1 hour';

    select pg_catalog.count(*) into recent_day
      from public.member_notification_deliveries d
      where d.user_id = new.user_id
        and d.created_at > pg_catalog.now() - interval '24 hours';

    -- The weekly nudge budget: only non-urgent kinds count, only the email
    -- channel (one per notification), and never rows suppressed at enqueue.
    if new.kind not in ('deadlines', 'cases') then
      select pg_catalog.count(*) into recent_week
        from public.member_notification_deliveries d
        join public.member_notifications n2 on n2.id = d.notification_id
        where d.user_id = new.user_id
          and d.channel = 'email'
          and d.status <> 'skipped'
          and d.created_at > pg_catalog.now() - interval '7 days'
          and n2.kind not in ('deadlines', 'cases');
    end if;

    select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
      from private.notification_outbound_counters c
      where c.day = current_date;

    if recent_hour >= max_per_recipient_hour then
      limit_reason := 'rate limited: recipient hour';
    elsif recent_day >= max_per_recipient_day then
      limit_reason := 'rate limited: recipient day';
    elsif new.kind not in ('deadlines', 'cases') and recent_week >= max_per_recipient_week then
      limit_reason := 'rate limited: weekly nudge cap';
    elsif org_today >= max_org_day then
      limit_reason := 'rate limited: org day';
    end if;

    if limit_reason is not null then
      insert into public.member_notification_deliveries (notification_id, user_id, channel, status, last_error)
      values (new.id, new.user_id, 'email', 'skipped', limit_reason)
      on conflict (notification_id, channel) do nothing;
      return new;
    end if;

    insert into private.notification_outbound_counters (day, shard, enqueued)
    values (current_date, (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
    on conflict (day, shard) do update
      set enqueued = private.notification_outbound_counters.enqueued + 1;

    insert into public.member_notification_deliveries (notification_id, user_id, channel)
    values (new.id, new.user_id, 'email')
    on conflict (notification_id, channel) do nothing;

    insert into public.member_notification_deliveries (notification_id, user_id, channel)
    select new.id, new.user_id, 'push'
    where exists (select 1 from public.member_push_subscriptions s where s.user_id = new.user_id)
    on conflict (notification_id, channel) do nothing;
  exception
    when query_canceled then
      raise warning 'enqueue_notification_deliveries cancelled for notification %', new.id;
    when others then
      raise warning 'enqueue_notification_deliveries failed for notification %: % (%)',
        new.id, sqlerrm, sqlstate;
  end;

  return new;
end;
$$;

revoke all on function private.enqueue_notification_deliveries() from public, anon, authenticated, service_role;

-- ------------------------------------------------ 4. notification copy

-- Shoulder rule throughout (20260728221106): a lock screen on a break-room
-- table must not disclose the work. No notice names a case, ballot, event,
-- task, lesson, or member. The app holds the details.
insert into private.notification_copy (key, lang, title, body) values
  ('deadline.case.days', 'en', 'Case deadline approaching', 'A case deadline is {days} days away. Open Cases for the details.'),
  ('deadline.case.days', 'es', 'Se acerca un plazo de caso', 'Un plazo de caso vence en {days} días. Abre Casos para ver los detalles.'),
  ('deadline.case.tomorrow', 'en', 'Case deadline tomorrow', 'A case deadline is tomorrow. Open Cases for the details.'),
  ('deadline.case.tomorrow', 'es', 'Plazo de caso mañana', 'Un plazo de caso vence mañana. Abre Casos para ver los detalles.'),
  ('deadline.case.today', 'en', 'Case deadline today', 'A case deadline is due today. Open Cases for the details.'),
  ('deadline.case.today', 'es', 'Plazo de caso hoy', 'Un plazo de caso vence hoy. Abre Casos para ver los detalles.'),
  ('vote.opened', 'en', 'Voting is open', 'A new ballot is open for your vote. Open Voice to cast it.'),
  ('vote.opened', 'es', 'La votación está abierta', 'Hay una nueva votación abierta. Abre Voz para emitir tu voto.'),
  ('vote.closing', 'en', 'Voting closes soon', 'A ballot you can vote in closes within a day. Open Voice to cast your vote.'),
  ('vote.closing', 'es', 'La votación cierra pronto', 'Una votación en la que puedes participar cierra en menos de un día. Abre Voz para emitir tu voto.'),
  ('vote.results', 'en', 'Ballot results are in', 'Results are available for a recent ballot. Open Voice to see them.'),
  ('vote.results', 'es', 'Resultados de la votación', 'Ya están los resultados de una votación reciente. Abre Voz para verlos.'),
  ('event.created', 'en', 'New union event', 'A new event was posted. Open Events for the details.'),
  ('event.created', 'es', 'Nuevo evento sindical', 'Se publicó un nuevo evento. Abre Eventos para ver los detalles.'),
  ('event.reminder', 'en', 'Event coming up', 'An event you RSVPed to starts within the next day. Open Events for the details.'),
  ('event.reminder', 'es', 'Evento próximo', 'Un evento al que confirmaste asistencia comienza dentro del próximo día. Abre Eventos para ver los detalles.'),
  ('event.rescheduled', 'en', 'An event was rescheduled', 'An event you RSVPed to changed its time. Open Events for the new details.'),
  ('event.rescheduled', 'es', 'Se reprogramó un evento', 'Un evento al que confirmaste asistencia cambió de horario. Abre Eventos para ver los nuevos detalles.'),
  ('task.watched', 'en', 'A task you watch changed', 'A task you watch was updated. Open Chapter Work for the details.'),
  ('task.watched', 'es', 'Cambió una tarea que sigues', 'Se actualizó una tarea que sigues. Abre Trabajo de Capítulo para ver los detalles.'),
  ('steward.request.new', 'en', 'A member needs steward backup', 'A member just requested steward support. Open your steward desk to respond.'),
  ('steward.request.new', 'es', 'Un miembro necesita apoyo de delegado', 'Un miembro acaba de solicitar apoyo de delegado. Abre tu mesa de delegado para responder.'),
  ('steward.request.acknowledged', 'en', 'A steward is on it', 'A steward acknowledged your request for backup. Open Learn to see your request.'),
  ('steward.request.acknowledged', 'es', 'Un delegado lo está atendiendo', 'Un delegado confirmó tu solicitud de apoyo. Abre Aprender para ver tu solicitud.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- --------------------------------------- 5. deadline producer (UB-SET-01)

-- The 'deadlines' switch finally governs real traffic: 7 / 3 / 1 days before
-- every case deadline (the design-source contractual-clock cadence). Stamps
-- make overlapping ticks idempotent; sending a closer notice back-fills the
-- farther stamps so a case born 2 days before its deadline gets exactly one
-- notice, not three. 'deadlines' is urgent: it pierces quiet hours (while the
-- member allows urgent alerts) and bypasses the weekly nudge cap.
create function private.case_deadline_notice_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select c.id, c.user_id, (c.deadline - current_date) as days_left
    from public.member_cases c
    where c.status = 'active'
      and c.deadline is not null
      and (c.deadline - current_date) between 0 and 7
      and (
        ((c.deadline - current_date) <= 1 and c.deadline_notice_1_sent_at is null)
        or ((c.deadline - current_date) between 2 and 3 and c.deadline_notice_3_sent_at is null)
        or ((c.deadline - current_date) between 4 and 7 and c.deadline_notice_7_sent_at is null)
      )
    for update skip locked
  loop
    if r.days_left <= 1 then
      update public.member_cases
        set deadline_notice_1_sent_at = now(),
            deadline_notice_3_sent_at = coalesce(deadline_notice_3_sent_at, now()),
            deadline_notice_7_sent_at = coalesce(deadline_notice_7_sent_at, now())
        where id = r.id;
      perform private.notify_member(
        r.user_id,
        case when r.days_left <= 0 then 'deadline.case.today' else 'deadline.case.tomorrow' end,
        '{}'::jsonb, 'deadlines');
    elsif r.days_left <= 3 then
      update public.member_cases
        set deadline_notice_3_sent_at = now(),
            deadline_notice_7_sent_at = coalesce(deadline_notice_7_sent_at, now())
        where id = r.id;
      perform private.notify_member(
        r.user_id, 'deadline.case.days',
        pg_catalog.jsonb_build_object('days', r.days_left::text), 'deadlines');
    else
      update public.member_cases
        set deadline_notice_7_sent_at = now()
        where id = r.id;
      perform private.notify_member(
        r.user_id, 'deadline.case.days',
        pg_catalog.jsonb_build_object('days', r.days_left::text), 'deadlines');
    end if;
  end loop;
end
$$;

revoke all on function private.case_deadline_notice_sweep() from public, anon, authenticated, service_role;

-- ----------------------------------------- 6. ballot producer (UB-SET-01)

-- Nothing ever flips member_ballots.active at close — "closed" is a predicate
-- (closes_at <= now()), not an event — so every ballot notice is a sweep, not
-- a trigger. Eligibility scoping is mandatory (UB-VOTE-03): chapter_id null =
-- union-wide, else members of that chapter only; current_member_chapter() is
-- useless here (no JWT in cron), so the sweep joins member_profiles directly.
-- The closing reminder skips members who already hold a receipt (owner
-- decision 2026-08-08): the read stays inside this definer sweep and is
-- visible to no one. member_ballot_choices is never touched — it stays
-- voterless (UB-VOTE-04).
create function private.ballot_notice_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b record;
  m record;
begin
  -- Ballot became open (new since the last tick; existing ballots were
  -- pre-stamped at migration time).
  for b in
    select bl.id, bl.chapter_id from public.member_ballots bl
    where bl.active
      and bl.closes_at > now()
      and bl.opened_notice_sent_at is null
    for update skip locked
  loop
    update public.member_ballots set opened_notice_sent_at = now() where id = b.id;
    for m in
      select p.id from public.member_profiles p
      where b.chapter_id is null or p.chapter_id = b.chapter_id
    loop
      perform private.notify_member(m.id, 'vote.opened', '{}'::jsonb, 'votes');
    end loop;
  end loop;

  -- Closes within a day: remind eligible members who have not voted yet.
  for b in
    select bl.id, bl.chapter_id from public.member_ballots bl
    where bl.active
      and bl.closing_notice_sent_at is null
      and bl.closes_at > now()
      and bl.closes_at <= now() + interval '24 hours'
    for update skip locked
  loop
    update public.member_ballots set closing_notice_sent_at = now() where id = b.id;
    for m in
      select p.id from public.member_profiles p
      where (b.chapter_id is null or p.chapter_id = b.chapter_id)
        and not exists (
          select 1 from public.member_ballot_receipts rc
          where rc.ballot_id = b.id and rc.user_id = p.id
        )
    loop
      perform private.notify_member(m.id, 'vote.closing', '{}'::jsonb, 'votes');
    end loop;
  end loop;

  -- Results publish the moment the tally gate opens (get_ballot_tally:
  -- inactive OR closes_at passed). Historic ballots were pre-stamped at
  -- migration time, so this only ever fires for a close that happened since.
  for b in
    select bl.id, bl.chapter_id from public.member_ballots bl
    where bl.results_notice_sent_at is null
      and (not bl.active or bl.closes_at <= now())
    for update skip locked
  loop
    update public.member_ballots set results_notice_sent_at = now() where id = b.id;
    for m in
      select p.id from public.member_profiles p
      where b.chapter_id is null or p.chapter_id = b.chapter_id
    loop
      perform private.notify_member(m.id, 'vote.results', '{}'::jsonb, 'votes');
    end loop;
  end loop;
end
$$;

revoke all on function private.ballot_notice_sweep() from public, anon, authenticated, service_role;

-- ------------------------------------------ 7. event producers (UB-SET-01)

-- Reminder sweep: 24h before start, to 'going' RSVPs. Stamp + SKIP LOCKED =
-- idempotent overlapping ticks (the appointment-reminder pattern).
create function private.event_notice_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  m record;
begin
  for r in
    select e.id from public.member_events e
    where e.reminder_notice_sent_at is null
      and e.starts_at > now()
      and e.starts_at <= now() + interval '24 hours'
    for update skip locked
  loop
    update public.member_events set reminder_notice_sent_at = now() where id = r.id;
    for m in
      select rv.user_id from public.member_event_rsvps rv
      where rv.event_id = r.id and rv.status = 'going'
    loop
      perform private.notify_member(m.user_id, 'event.reminder', '{}'::jsonb, 'events');
    end loop;
  end loop;
end
$$;

revoke all on function private.event_notice_sweep() from public, anon, authenticated, service_role;

-- create_member_event re-emit: 20260723182000's verbatim body plus the
-- event-created fan-out. Events are org-wide by design (no chapter column,
-- read policy is unconditional), so the audience is every member except the
-- posting admin; the per-recipient and org caps bound the burst. The notify
-- loop is exception-fenced so outbound plumbing can never fail the create.
create or replace function public.create_member_event(
  p_id text,
  p_title text,
  p_starts_at timestamptz,
  p_location text,
  p_summary text,
  p_check_in_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  m record;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_id is null or p_id !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid event id' using errcode = '22023';
  end if;
  if p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120
     or p_title ~ '[[:cntrl:]]' then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'invalid start time' using errcode = '22023';
  end if;
  if p_location is null or pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120
     or p_location ~ '[[:cntrl:]]' then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is null or pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500
     or p_summary ~ '[[:cntrl:]]' then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if p_check_in_code is null or p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member_events:order_index'));
  if exists (select 1 from public.member_events where id = p_id) then
    raise exception 'event id already exists' using errcode = '22023';
  end if;

  insert into public.member_events (id, title, starts_at, location, summary, check_in_code, order_index)
  values (p_id, pg_catalog.btrim(p_title), p_starts_at, pg_catalog.btrim(p_location),
          pg_catalog.btrim(p_summary), p_check_in_code,
          coalesce((select pg_catalog.max(order_index) + 1 from public.member_events), 1));

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_event',
          pg_catalog.jsonb_build_object('eventId', p_id, 'title', pg_catalog.btrim(p_title)));

  -- UB-SET-01: the 'events' switch governs real traffic from here on.
  begin
    for m in select p.id from public.member_profiles p where p.id <> caller loop
      perform private.notify_member(m.id, 'event.created', '{}'::jsonb, 'events');
    end loop;
  exception
    when others then
      raise warning 'event.created notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'created', true);
end;
$$;

revoke all on function public.create_member_event(text, text, timestamptz, text, text, text) from public, anon;
grant execute on function public.create_member_event(text, text, timestamptz, text, text, text) to authenticated;

-- update_member_event re-emit: verbatim body plus, when starts_at really
-- changed, (a) the reminder stamp resets so the new time reminds again and
-- (b) 'going' RSVPs hear about the reschedule.
create or replace function public.update_member_event(
  p_id text,
  p_title text default null,
  p_starts_at timestamptz default null,
  p_location text default null,
  p_summary text default null,
  p_check_in_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev public.member_events%rowtype;
  changed text[];
  m record;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select * into ev from public.member_events where id = p_id for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  if p_title is not null
     and (pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120
          or p_title ~ '[[:cntrl:]]') then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_location is not null
     and (pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120
          or p_location ~ '[[:cntrl:]]') then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is not null
     and (pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500
          or p_summary ~ '[[:cntrl:]]') then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if p_check_in_code is not null and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  changed := pg_catalog.array_remove(array[
    case when p_title is not null and pg_catalog.btrim(p_title) is distinct from ev.title then 'title' end,
    case when p_starts_at is not null and p_starts_at is distinct from ev.starts_at then 'starts_at' end,
    case when p_location is not null and pg_catalog.btrim(p_location) is distinct from ev.location then 'location' end,
    case when p_summary is not null and pg_catalog.btrim(p_summary) is distinct from ev.summary then 'summary' end,
    case when p_check_in_code is not null and p_check_in_code is distinct from ev.check_in_code then 'check_in_code' end
  ], null);

  if pg_catalog.cardinality(changed) > 0 then
    update public.member_events set
      title = coalesce(pg_catalog.btrim(p_title), title),
      starts_at = coalesce(p_starts_at, starts_at),
      location = coalesce(pg_catalog.btrim(p_location), location),
      summary = coalesce(pg_catalog.btrim(p_summary), summary),
      check_in_code = coalesce(p_check_in_code, check_in_code)
    where id = p_id;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event',
            pg_catalog.jsonb_build_object('eventId', p_id, 'title', ev.title,
              'fields', pg_catalog.to_jsonb(changed)));

    if 'starts_at' = any(changed) then
      -- The new time deserves its own 24h reminder.
      update public.member_events set reminder_notice_sent_at = null where id = p_id;
      begin
        for m in
          select rv.user_id from public.member_event_rsvps rv
          where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
        loop
          perform private.notify_member(m.user_id, 'event.rescheduled', '{}'::jsonb, 'events');
        end loop;
      exception
        when others then
          raise warning 'event.rescheduled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
      end;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('id', p_id, 'updated', pg_catalog.cardinality(changed) > 0);
end;
$$;

revoke all on function public.update_member_event(text, text, timestamptz, text, text, text) from public, anon;
grant execute on function public.update_member_event(text, text, timestamptz, text, text, text) to authenticated;

-- ------------------------------------- 8. watch alerts (UB-CW-05/UB-CON-11)

-- The watch bell finally does something. chapter_task_activity is the one
-- place every audited task mutation lands (direct UPDATE or RPC alike), so
-- the fan-out keys on its INSERT. Audience = the task's watchers minus the
-- actor minus anyone the action's own producer already notified (assignees
-- get task.assigned/unassigned; the primary assignee gets deleted/restored).
-- Watchers are same-chapter by construction (prepare trigger). The roster
-- read happens here, SECURITY DEFINER — the client-side privacy boundary
-- (nobody can read anyone else's watch rows) is untouched.
create function private.notify_chapter_task_watchers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  primary_assignee uuid;
begin
  -- A task cannot have watchers at the moment it is created.
  if new.action = 'created' then
    return new;
  end if;

  begin
    if new.action in ('deleted', 'restored') then
      select t.assignee_id into primary_assignee
      from public.chapter_tasks t where t.id = new.task_id;
    end if;

    for r in
      select w.user_id from public.chapter_task_watchers w
      where w.task_id = new.task_id
        and (new.actor_id is null or w.user_id <> new.actor_id)
        and not (new.action = 'assignee_changed'
                 and w.user_id::text in (coalesce(new.from_value, ''), coalesce(new.to_value, '')))
        and not (new.action in ('deleted', 'restored')
                 and primary_assignee is not distinct from w.user_id)
    loop
      perform private.notify_member(r.user_id, 'task.watched', '{}'::jsonb, 'tasks');
    end loop;
  exception
    when query_canceled then
      raise warning 'notify_chapter_task_watchers cancelled for activity %', new.id;
    when others then
      raise warning 'notify_chapter_task_watchers failed for activity %: % (%)',
        new.id, sqlerrm, sqlstate;
  end;

  return new;
end
$$;

revoke all on function private.notify_chapter_task_watchers() from public, anon, authenticated, service_role;

create trigger chapter_task_activity_notify_watchers
after insert on public.chapter_task_activity
for each row execute function private.notify_chapter_task_watchers();

-- add_chapter_task_comment re-emit: 20260802190831's verbatim body with the
-- watcher roster joined into the audience. Its copy has read "{name} added an
-- update to a task you follow" since the day it shipped — written for
-- watchers who were never in the audience set. Now they are.
create or replace function public.add_chapter_task_comment(
  p_task_id uuid,
  p_body text,
  p_mention_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_name text;
  task_row public.chapter_tasks%rowtype;
  clean_mentions uuid[] := '{}';
  inserted public.chapter_task_comments%rowtype;
  recipient uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception 'comment must be between 1 and 2000 characters' using errcode = '22023';
  end if;

  select t.*
    into task_row
  from public.chapter_tasks t
  join public.member_profiles p
    on p.id = caller
   and p.chapter_id = t.chapter_id
  where t.id = p_task_id
    and t.deleted_at is null
  for update of t;

  select p.full_name
    into caller_name
  from public.member_profiles p
  where p.id = caller;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_mention_ids, '{}')) mention_id
    where not exists (
      select 1 from public.member_profiles p
      where p.id = mention_id and p.chapter_id = task_row.chapter_id
    )
  ) then
    raise exception 'mentioned member must belong to this chapter' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct mention_id order by mention_id), '{}')
    into clean_mentions
  from unnest(coalesce(p_mention_ids, '{}')) mention_id;

  insert into public.chapter_task_comments (
    task_id, chapter_id, author_id, body, mentioned_user_ids
  ) values (
    task_row.id, task_row.chapter_id, caller, btrim(p_body), clean_mentions
  ) returning * into inserted;

  for recipient in
    select distinct audience.user_id
    from (
      select task_row.created_by as user_id
      union all select task_row.assignee_id
      union all select unnest(clean_mentions)
      -- UB-CW-05: watchers join the comment audience.
      union all select w.user_id from public.chapter_task_watchers w where w.task_id = task_row.id
    ) audience
    join public.member_profiles recipient_profile
      on recipient_profile.id = audience.user_id
     and recipient_profile.chapter_id = task_row.chapter_id
    where audience.user_id is not null and audience.user_id <> caller
  loop
    perform private.notify_member(
      recipient,
      'task.comment',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')),
      'tasks'
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'id', inserted.id,
    'taskId', inserted.task_id,
    'chapterId', inserted.chapter_id,
    'authorId', inserted.author_id,
    'body', inserted.body,
    'mentionedUserIds', inserted.mentioned_user_ids,
    'createdAt', inserted.created_at
  );
end
$$;

revoke all on function public.add_chapter_task_comment(uuid, text, uuid[])
  from public, anon, authenticated;
grant execute on function public.add_chapter_task_comment(uuid, text, uuid[])
  to authenticated;

-- ------------------------------------------- 9. steward ping (UB-RGT-03)

-- "Your steward is pinged instantly" becomes true. No per-member steward
-- assignment exists; the honest audience is every steward whose role scope
-- covers the requester's chapter (chapter_id null = org-wide) — the same set
-- staff_can_see_user() grants read access to. Kind 'cases': the urgent
-- classification, so a mid-meeting request pierces quiet hours while the
-- steward allows urgent alerts. The requester is
-- excluded (a steward can file their own request; the self-deal guard on the
-- ack mint exists for the same reason). Exception-fenced: outbound plumbing
-- must never fail the member's request.
create function private.notify_stewards_of_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  req_chapter text;
  r record;
begin
  begin
    select p.chapter_id into req_chapter
    from public.member_profiles p where p.id = new.user_id;

    for r in
      select distinct mr.user_id from public.member_roles mr
      where mr.role = 'steward'
        and (mr.chapter_id is null or mr.chapter_id = req_chapter)
        and mr.user_id <> new.user_id
    loop
      perform private.notify_member(r.user_id, 'steward.request.new', '{}'::jsonb, 'cases');
    end loop;
  exception
    when query_canceled then
      raise warning 'notify_stewards_of_request cancelled for request %', new.id;
    when others then
      raise warning 'notify_stewards_of_request failed for request %: % (%)',
        new.id, sqlerrm, sqlstate;
  end;

  return new;
end
$$;

revoke all on function private.notify_stewards_of_request() from public, anon, authenticated, service_role;

create trigger member_steward_requests_notify_stewards
after insert on public.member_steward_requests
for each row execute function private.notify_stewards_of_request();

-- triage_steward_request re-emit: 20260723040000's verbatim body plus the
-- ping back — the member hears when a steward takes their request, closing
-- the loop UB-RGT-03 found open in both directions. Self-triage stays silent.
create or replace function public.triage_steward_request(p_request_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  updated integer;
  row_out record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  if p_action = 'acknowledge' then
    update public.member_steward_requests
    set status = 'acknowledged', acknowledged_at = now(), handled_by = caller
    where id = p_request_id and status = 'requested'
      and public.staff_can_see_user(user_id, 'steward');
  elsif p_action = 'close' then
    update public.member_steward_requests
    set status = 'closed', closed_at = now(), handled_by = caller
    where id = p_request_id and status in ('requested', 'acknowledged')
      and public.staff_can_see_user(user_id, 'steward');
  else
    raise exception 'unknown triage action' using errcode = '22023';
  end if;

  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'request not found or already past this step' using errcode = '22023';
  end if;

  select id, status, acknowledged_at, closed_at, user_id into row_out
  from public.member_steward_requests where id = p_request_id;

  if p_action = 'acknowledge' and row_out.user_id is not null and row_out.user_id <> caller then
    begin
      perform private.notify_member(row_out.user_id, 'steward.request.acknowledged', '{}'::jsonb, 'cases');
    exception
      when others then
        raise warning 'steward.request.acknowledged notify failed for %: % (%)',
          p_request_id, sqlerrm, sqlstate;
    end;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', row_out.id,
    'status', row_out.status,
    'acknowledgedAt', row_out.acknowledged_at,
    'closedAt', row_out.closed_at
  );
end;
$$;

-- --------------------------------------------------------- 10. cron jobs

-- Same guard shape as 20260723204000: environments without pg_cron (local
-- shadow DBs, CI) skip scheduling without failing the apply.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    return;
  end if;
  execute 'create extension if not exists pg_cron';

  -- Case deadlines are DATE-granular; one morning pass is the cadence the
  -- 7/3/1 design intends (13:05 UTC ≈ 9:05am ET).
  perform cron.unschedule(jobid) from cron.job where jobname = 'deadline-notices-tick';
  perform cron.schedule(
    'deadline-notices-tick',
    '5 13 * * *',
    $job$ select private.case_deadline_notice_sweep(); $job$);

  perform cron.unschedule(jobid) from cron.job where jobname = 'ballot-notices-tick';
  perform cron.schedule(
    'ballot-notices-tick',
    '*/15 * * * *',
    $job$ select private.ballot_notice_sweep(); $job$);

  perform cron.unschedule(jobid) from cron.job where jobname = 'event-notices-tick';
  perform cron.schedule(
    'event-notices-tick',
    '*/15 * * * *',
    $job$ select private.event_notice_sweep(); $job$);
end
$$;
