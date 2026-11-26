-- REQ-UG-FULL-DEPTH-20260723 PR5: notification kinds + outbound queue.
--
-- Semantics (the central PR5 decision): the in-app feed is ALWAYS on — prefs
-- gate outbound channels only. No pref ever hides a member_notifications row
-- (case history vanishing from a grievance tool is a compliance risk); the
-- notification_prefs toggles stop a topic from generating email/push sends.
--
-- Enforcement point: ONE AFTER INSERT trigger on member_notifications. The
-- 9 existing insert sites get a mechanical kind value only — none of them
-- know about prefs, channels, or the queue. member_notifications has no
-- client INSERT grant (every row comes from a definer body), so the trigger
-- needs no anti-forgery guard.
--
-- kind='general' NEVER enqueues outbound delivery (in-app only). This is
-- deliberate: a member who turns off every topic toggle must get zero
-- outbound mail, so no bypass kind exists. Every seed row written at signup
-- is classified 'general' — one welcome notification from
-- private.unionground_start_member_lifecycle as of 20261014001000, three
-- fictional grievance/case/conversation rows from private.handle_new_member
-- when this migration was written — because onboarding
-- content must never leave the app as real email/push (deviation from the
-- blueprint's votes/deadlines classification, which would have emailed
-- every new signup about a fake ballot).
--
-- Topics are deadlines / cases / forms / votes / events. 'forms' is separate
-- from 'cases' on purpose: seven form templates exist and only two of them
-- (grievance, alliance_grievance) can become a case, so filing "your FMLA
-- request was approved" under 'cases' would both read wrong and answer to the
-- wrong toggle. 'cases' now means an actual grievance case moved.
--
-- Outbound starts OFF. private.notification_controls.outbound_enabled
-- defaults to false, and the trigger returns early while it is false, so
-- applying this migration to the live database changes nothing a member can
-- observe and accumulates no queue. It is both the rollout gate (flip it on
-- once the dispatcher, route, secret and provider config are verified) and
-- the emergency stop (flip it off and every send stops within one claim
-- cycle, with no deploy and no dependency on Vercel being reachable).
--
-- The trigger is also rate limited per recipient and org-wide, because the
-- form flows are member-triggerable: without caps one account could cycle an
-- invite loop and aim tens of thousands of provider sends at a member of its
-- choosing. Suppressions are written as terminal 'skipped' rows so they are
-- visible rather than silent.

-- 1. Topic classification on the feed itself.
--
-- 'forms' is a distinct topic from 'cases'. Approving or returning an FMLA
-- request or a member service request is NOT case movement, and labelling it
-- 'cases' would both mis-describe it in the outbound copy and gate it behind
-- the wrong toggle. 'cases' is reserved for an actual grievance case.
--
-- The `kind` column, its CHECK and the narrowed grants live in
-- 20260723200500 so that their ACCESS EXCLUSIVE lock on the ~300k-row feed
-- commits on its own instead of being held across everything below.
-- NOTHING in this file may take a lock on public.member_notifications: the
-- enqueue TRIGGER is deliberately created later, in 20260723201500.

-- 2. The outbound queue. Service-role-only: RLS enabled with ZERO
--    authenticated/anon policies (default-deny), matching the
--    member_ai_requests idiom — members have no product need to see delivery
--    plumbing, and attempts/last_error would leak provider internals.
create table if not exists public.member_notification_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  notification_id uuid not null references public.member_notifications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('email', 'push', 'sms')),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  -- At most one delivery per notification per channel. Without this a retry
  -- that re-runs the enqueue path (or any direct insert) silently doubles the
  -- send, and both rows claim independently.
  unique (notification_id, channel)
);

-- Claim scan: due pending rows + stale 'sending' rows (crash watchdog).
create index if not exists member_notification_deliveries_claim_idx
  on public.member_notification_deliveries (channel, status, next_attempt_at)
  where status in ('pending', 'sending');
-- Leading FK column for cascade deletes, and the rolling per-recipient rate
-- window the enqueue trigger scans.
create index if not exists member_notification_deliveries_user_idx
  on public.member_notification_deliveries (user_id, created_at desc);
create index if not exists member_notification_deliveries_notification_idx
  on public.member_notification_deliveries (notification_id);

alter table public.member_notification_deliveries enable row level security;

revoke all on public.member_notification_deliveries from anon, authenticated;
-- The dispatcher reaches this table ONLY through the claim/record RPCs, which
-- own the state machine. Direct DML from a service key would bypass both the
-- sole-enqueue trigger and every transition guard, so service_role gets read
-- access for operational inspection and nothing else.
revoke all on public.member_notification_deliveries from service_role;
grant select on public.member_notification_deliveries to service_role;

-- 2b. Outbound control plane.
--
-- outbound_enabled is the emergency stop AND the rollout gate. It defaults to
-- FALSE so that applying these migrations to a live database changes nothing
-- observable: the feed keeps working, the trigger stays inert, and no queue
-- accumulates while the dispatcher, route, secret and provider config are
-- still being put in place. Flipping it true is the activation step; flipping
-- it back false stops every outbound send within one claim cycle without a
-- deploy, and keeps working even when Vercel itself is the broken thing.
create table if not exists private.notification_controls (
  id boolean primary key default true check (id),
  outbound_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into private.notification_controls (id) values (true) on conflict (id) do nothing;

revoke all on private.notification_controls from public, anon, authenticated, service_role;

-- Cheap org-wide daily counter. Scanning the delivery table for an org-wide
-- total on every insert would not survive 100k members; an upserted row costs
-- one index hit.
--
-- SHARDED, and that is not premature optimisation. A single row per day would
-- put every notification-producing transaction in the product — every form
-- approval, every case update, every invitation — behind one tuple lock. They
-- would serialize org-wide, and a transaction that waited past statement_timeout
-- would raise query_canceled inside a trigger whose whole contract is that it
-- can never fail the business transaction that produced the notification.
-- Sixteen shards keyed off the backend pid cut that contention to ~1/16 while
-- the cap check just sums sixteen rows.
create table if not exists private.notification_outbound_counters (
  day date not null,
  shard smallint not null,
  enqueued integer not null default 0,
  primary key (day, shard)
);

-- Replay path for a database that already has the single-row shape.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'private.notification_outbound_counters'::regclass
      and attname = 'shard' and not attisdropped
  ) then
    alter table private.notification_outbound_counters add column shard smallint not null default 0;
    alter table private.notification_outbound_counters drop constraint notification_outbound_counters_pkey;
    alter table private.notification_outbound_counters add primary key (day, shard);
  end if;
end
$$;

revoke all on private.notification_outbound_counters from public, anon, authenticated, service_role;

-- 3. The single enforcement point. Reads notification_prefs exactly once per
--    topical notification; 'general' short-circuits before any read. An
--    'email' delivery row is enqueued whenever the topic is allowed —
--    provider configuration is a dispatch-time concern, not a schema-time
--    concern (flipping Resend on/off never needs a migration). A 'push' row
--    is enqueued only when the member has at least one push subscription.
--    SMS: the channel CHECK reserves the slot; nothing ever enqueues it and
--    the dispatcher never claims it (documented-disabled until a provider +
--    verified phone-number flow exist).
--
--    Two hard rules govern this function:
--
--    (a) It must never be able to fail the transaction that produced the
--        notification. The in-app feed is the product; outbound is a
--        best-effort side effect. A steward approving a form must not see
--        that approval roll back because a preference blob was malformed or
--        the queue was unavailable. Everything after the topic check runs
--        inside an exception boundary that logs and returns NEW.
--
--    (b) It must cast nothing that a member can write. notification_prefs is
--        member-writable and its CHECK only guarantees a bounded JSON object,
--        so `{"cases": []}` is a legal stored value. `(prefs ->> 'cases')::boolean`
--        on that raises 22P02 — which, before rule (a), took the steward's
--        approval down with it. Only an explicit JSON `false` disables a topic.
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
  org_today integer;
  limit_reason text;
  -- Real usage is a handful of events per member per day. These caps exist so
  -- one authenticated account cannot cycle a form flow and drive tens of
  -- thousands of provider sends at a recipient of its choosing.
  max_per_recipient_hour constant integer := 12;
  max_per_recipient_day constant integer := 50;
  max_org_day constant integer := 20000;
begin
  -- 'general' is in-app only and must never reach a provider. Short-circuit
  -- before the control flag, before prefs, before anything.
  if new.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events') then
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

    -- Serialize per RECIPIENT before counting. Under READ COMMITTED two
    -- concurrent notifications to the same member both see the same "11 in the
    -- last hour" and both enqueue, because neither can see the other's
    -- uncommitted row — the cap is advisory-only without this. The lock is
    -- transaction-scoped (released at commit/rollback, no unlock path to leak)
    -- and keyed per member, so it never serializes unrelated recipients. This
    -- is the one place the cap can actually be enforced: the delivery table has
    -- no constraint that could express "at most 12 per rolling hour".
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

    select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
      from private.notification_outbound_counters c
      where c.day = current_date;

    if recent_hour >= max_per_recipient_hour then
      limit_reason := 'rate limited: recipient hour';
    elsif recent_day >= max_per_recipient_day then
      limit_reason := 'rate limited: recipient day';
    elsif org_today >= max_org_day then
      limit_reason := 'rate limited: org day';
    end if;

    -- Record the suppression as a terminal 'skipped' row rather than dropping
    -- it silently. A rate limit that leaves no trace is indistinguishable from
    -- a delivery pipeline that quietly stopped working.
    --
    -- Suppressed work does NOT touch the org counter. Counting it would let a
    -- single account that is already being rate-limited burn the org-wide
    -- allowance with rejected attempts and starve every other member's mail —
    -- turning a per-recipient cap into an org-wide denial of service.
    if limit_reason is not null then
      insert into public.member_notification_deliveries (notification_id, user_id, channel, status, last_error)
      values (new.id, new.user_id, 'email', 'skipped', limit_reason)
      on conflict (notification_id, channel) do nothing;
      return new;
    end if;

    -- Accepted: now charge the org allowance, on a pid-derived shard.
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
    -- query_canceled (57014) is one of the two conditions `when others` does
    -- NOT match, so without naming it a statement_timeout that fired while this
    -- trigger waited on a lock would propagate and roll back the steward's form
    -- approval. Rule (a) — outbound plumbing must never fail the transaction
    -- that produced the notification — has to hold for that case too. The
    -- handler does no further work, so a genuine cancellation still takes
    -- effect at the next statement.
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

-- The TRIGGER that calls this function is created in 20260723201500, not
-- here. `create trigger` takes ACCESS EXCLUSIVE on member_notifications, and
-- creating it at this point would hold that lock across the nine function
-- replacements and the 100k-row profile scan below. Deferring it is also the
-- safer order: the classified insert sites land first and the enqueue path is
-- switched on last.

-- 4. Mechanical kind classification at the 9 live insert sites. Each body
--    below reproduces the CURRENT live pg_get_functiondef dump verbatim
--    (post-PR1 chapter scope + post-PR2 registry/localization + PR2's
--    no-existence-oracle guards) — the ONLY change in each is the kind value
--    added to its member_notifications insert. Do not edit anything else.

-- 4a. Signup seed content → 'general' (fictional, in-app only — see header).
CREATE OR REPLACE FUNCTION private.handle_new_member()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  conversation_one uuid := extensions.gen_random_uuid();
  conversation_two uuid := extensions.gen_random_uuid();
  member_first text := coalesce(nullif(new.raw_user_meta_data ->> 'first_name', ''), 'Darnell');
  member_full text := coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), 'Darnell Foster');
  member_initials text := coalesce(nullif(new.raw_user_meta_data ->> 'initials', ''), 'DF');
  member_chapter text := nullif(new.raw_user_meta_data ->> 'chapter_id', '');
begin
  if member_chapter is null
     or not exists (select 1 from public.chapters where id = member_chapter) then
    select id into member_chapter from public.chapters where is_default limit 1;
  end if;

  insert into public.member_profiles (id, first_name, full_name, initials, chapter_id)
  values (new.id, member_first, member_full, member_initials, member_chapter);

  insert into public.member_notifications (user_id, title, body, kind, created_at) values
    (new.id, 'Ballot closes soon', 'Cast your vote on the chapter action budget priorities.', 'general', now() - interval '1 hour'),
    (new.id, 'Case deadline', 'Your Step 2 response deadline needs attention.', 'general', now() - interval '4 hours'),
    (new.id, 'New chapter update', 'The latest fictional chapter broadcast is ready.', 'general', now() - interval '1 day');

  insert into public.member_conversations (id, user_id, title, initials, created_at, updated_at) values
    (conversation_one, new.id, 'Chapter steward', 'CS', now() - interval '9 days', now() - interval '8 days'),
    (conversation_two, new.id, 'Chapter steward', 'CS', now() - interval '23 days', now() - interval '22 days');

  insert into public.member_messages (conversation_id, user_id, sender_kind, sender_name, body, read_at, created_at) values
    (conversation_one, new.id, 'steward', 'Chapter steward', 'Now the employer owes a written Step 2 answer, due at the end of next week.', null, now() - interval '8 days'),
    (conversation_two, new.id, 'steward', 'Chapter steward', 'HI', now() - interval '21 days', now() - interval '22 days');

  insert into public.member_cases (user_id, reference, title, deadline, case_type, articles, step, status, created_at, updated_at) values
    (new.id, 'GR-2026-509', 'Step 2 — discipline', current_date - 29, 'Discipline', 'Article 12 — Discipline · Article 3 — Union Rights and Representation', 'Step 2', 'active', now() - interval '40 days', now() - interval '8 days'),
    (new.id, 'GR-2026-312', 'Telework schedule restored', current_date - 128, 'Telework', 'Article 7 — Hours of Work', 'Closed', 'resolved', now() - interval '160 days', now() - interval '120 days'),
    (new.id, 'GR-2025-944', 'Safety equipment issued', current_date - 214, 'Safety', 'Article 16 — Health and Safety', 'Closed', 'resolved', now() - interval '245 days', now() - interval '210 days'),
    (new.id, 'GR-2025-721', 'Scheduling shift corrected', current_date - 284, 'Scheduling', 'Article 7 — Hours of Work', 'Closed', 'resolved', now() - interval '310 days', now() - interval '280 days');

  insert into public.member_rights_progress (lesson_id, user_id, completed_steps)
  values ('weingarten', new.id, array[0]);

  insert into public.member_action_log (user_id, action_key, action_kind, occurred_at) values
    (new.id, 'seed-tuesday', 'seed', date_trunc('week', now()) + interval '1 day 12 hours'),
    (new.id, 'seed-thursday', 'seed', date_trunc('week', now()) + interval '3 days 12 hours'),
    (new.id, 'seed-friday', 'seed', date_trunc('week', now()) + interval '4 days 12 hours');
  return new;
end;
$function$;

-- 4b. Steward form review + case opening → 'cases'.
CREATE OR REPLACE FUNCTION public.approve_form(p_form_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  clean_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  rec record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_note is not null then
    if pg_catalog.char_length(clean_note) > 4000 then
      raise exception 'note must be at most 4000 characters' using errcode = '22023';
    end if;
    if pg_catalog.regexp_replace(clean_note, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
      raise exception 'note contains unsupported control characters' using errcode = '22023';
    end if;
  end if;

  select f.id, f.user_id, f.status, f.template_key, f.template_version, coalesce(p.language, 'en') as lang into rec
    from public.member_forms f
    left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;

  update public.member_forms
    set status = 'approved', review_note = clean_note, reviewed_by = caller, reviewed_at = now(), updated_at = now()
    where id = p_form_id;

  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Formulario aprobado',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — revisado y aprobado por tu delegado.'
        || coalesce(' Nota: ' || clean_note, ''), 'forms');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Form approved',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — reviewed and approved by your steward.'
        || coalesce(' Note: ' || clean_note, ''), 'forms');
  end if;

  return pg_catalog.jsonb_build_object('formId', p_form_id, 'status', 'approved');
end;
$function$;

CREATE OR REPLACE FUNCTION public.return_form(p_form_id uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  clean_note text := pg_catalog.btrim(coalesce(p_note, ''));
  rec record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_note = '' or pg_catalog.char_length(clean_note) > 4000 then
    raise exception 'return note must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if pg_catalog.regexp_replace(clean_note, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'note contains unsupported control characters' using errcode = '22023';
  end if;

  select f.id, f.user_id, f.status, f.template_key, f.template_version, coalesce(p.language, 'en') as lang into rec
    from public.member_forms f
    left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;

  -- the one-active-per-template partial index covers draft+returned: if the
  -- member started a NEW draft of this template after submitting this row,
  -- flipping it to returned would collide. Surface a clean error instead of a
  -- unique_violation 500 — the steward can approve, or the member finishes
  -- the newer draft first.
  begin
    update public.member_forms
      set status = 'returned', review_note = clean_note, reviewed_by = caller, reviewed_at = now(), updated_at = now()
      where id = p_form_id;
  exception when unique_violation then
    raise exception 'member already has an active draft of this template; approve instead or ask them to finish it' using errcode = '23505';
  end;

  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Formulario devuelto',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — devuelto por tu delegado para cambios. Nota: ' || clean_note, 'forms');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Form returned',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — returned by your steward for changes. Note: ' || clean_note, 'forms');
  end if;

  return pg_catalog.jsonb_build_object('formId', p_form_id, 'status', 'returned');
end;
$function$;

CREATE OR REPLACE FUNCTION public.open_form_as_case(p_form_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  rec record;
  new_case uuid;
  ref text;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  select f.id, f.user_id, f.status, f.template_key, f.template_version, f.answers, f.case_id, coalesce(p.language, 'en') as lang into rec
    from public.member_forms f
    left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  -- Not-found, the caller's own form, member-private states (draft/returned
  -- are never steward-visible), and out-of-chapter-scope targets all collapse
  -- to one generic error so a steward holding a guessed form UUID cannot use
  -- the status-specific raises below as an existence oracle for another
  -- member's in-progress filing.
  if not found or rec.user_id = caller or rec.status in ('draft', 'returned')
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found or your own' using errcode = '22023';
  end if;
  if rec.status <> 'approved' then
    raise exception 'only approved forms can be opened as cases' using errcode = '22023';
  end if;
  if rec.template_key not in ('grievance', 'alliance_grievance') then
    raise exception 'only grievance forms can be opened as cases' using errcode = '22023';
  end if;
  if rec.case_id is not null then
    raise exception 'this form already has a case' using errcode = '22023';
  end if;

  -- server-generated reference (pre-mortem #3): the form id is member-visible,
  -- so a member could pre-insert its derived reference and permanently block
  -- this call. A fresh uuid is unknowable to the member; 8 hex chars kill the
  -- intra-user birthday collision. The case_id-null guard makes this
  -- single-shot, and any residual unique_violation surfaces as a clean error
  -- rather than a duplicate case. No action-log write here: steward actions
  -- never mint member points.
  new_case := extensions.gen_random_uuid();
  ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-F' || pg_catalog.substr(pg_catalog.replace(new_case::text, '-', ''), 1, 8);
  begin
    insert into public.member_cases (id, user_id, reference, title, case_type, articles, step)
    values (
      new_case,
      rec.user_id,
      ref,
      coalesce(nullif(pg_catalog.btrim(pg_catalog.left(coalesce(rec.answers->>'summary', ''), 200)), ''), 'Grievance from submitted form'),
      'Grievance',
      pg_catalog.btrim(pg_catalog.left(coalesce(rec.answers->>'articles', ''), 200)),
      'Intake')
    returning id into new_case;
  exception when unique_violation then
    raise exception 'a case with this reference already exists for the member' using errcode = '23505';
  end;

  update public.member_forms set case_id = new_case, updated_at = now() where id = p_form_id;

  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Caso de queja abierto',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — tu delegado abrió el caso ' || ref || ' a partir de tu formulario aprobado. Síguelo en Casos.', 'cases');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Grievance case opened',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — your steward opened case ' || ref || ' from your approved form. Track it under Cases.', 'cases');
  end if;

  return new_case;
end;
$function$;

-- 4c. Alliance co-signer flow → 'cases'.
CREATE OR REPLACE FUNCTION public.invite_cosigner(p_form_id uuid, p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  norm text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  frec record;
  target uuid;
  existing record;
  active_count integer;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;

  -- caller must own an eligible alliance_grievance form (not yet approved). One
  -- generic message; the form is the caller's own, so no cross-member leak.
  select id, user_id, template_key, status into frec
    from public.member_forms where id = p_form_id;
  if not found or frec.user_id <> caller
     or frec.template_key <> 'alliance_grievance'
     or frec.status not in ('draft','returned','submitted','in_review') then
    raise exception 'form not found or not eligible for co-signers' using errcode='22023';
  end if;

  -- validate caller-supplied email (own input, not an enumeration surface)
  if norm = '' or pg_catalog.length(norm) > 320
     or norm !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'a valid email address is required' using errcode='22023';
  end if;
  if norm = caller_email then
    raise exception 'you cannot invite yourself' using errcode='22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cosign-'||p_form_id::text, 509));

  -- resolve target member LOCALLY (notification only; never stored here — D1)
  select id into target from auth.users where pg_catalog.lower(email) = norm limit 1;

  select id, status into existing from public.member_form_cosigners
    where form_id = p_form_id and invited_email = norm for update;
  if existing.id is not null then
    if existing.status in ('invited','accepted','reaffirm_needed') then
      return pg_catalog.jsonb_build_object('status','invited');  -- already active: uniform no-op
    end if;
    select count(*) into active_count from public.member_form_cosigners
      where form_id = p_form_id and status in ('invited','accepted','reaffirm_needed');
    if active_count >= 10 then raise exception 'co-signer limit reached (max 10)' using errcode='22023'; end if;
    update public.member_form_cosigners
      set status='invited', cosigner_user_id=null, invited_by=caller, invited_at=now(), responded_at=null
      where id = existing.id;
  else
    select count(*) into active_count from public.member_form_cosigners
      where form_id = p_form_id and status in ('invited','accepted','reaffirm_needed');
    if active_count >= 10 then raise exception 'co-signer limit reached (max 10)' using errcode='22023'; end if;
    insert into public.member_form_cosigners (form_id, invited_email, cosigner_user_id, invited_by)
      values (p_form_id, norm, null, caller);
  end if;

  -- notify ONLY members; non-member emails sit inert (D1)
  if target is not null then
    insert into public.member_notifications (user_id, title, body, kind)
    values (target, 'Co-sign invitation',
      'A member invited you to co-sign an alliance grievance. Open Forms to review and accept or decline.', 'forms');
  end if;

  return pg_catalog.jsonb_build_object('status','invited');  -- uniform (D1)
end $function$;

CREATE OR REPLACE FUNCTION public.respond_to_cosign(p_form_id uuid, p_accept boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  inv record;
  new_status text;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select id, invited_by into inv
    from public.member_form_cosigners
    where form_id = p_form_id
      and status in ('invited','reaffirm_needed')
      and (cosigner_user_id = caller or (caller_email <> '' and invited_email = caller_email))
    order by invited_at desc
    for update
    limit 1;
  if inv.id is null then
    raise exception 'no pending co-sign invitation for you on this form' using errcode='22023';
  end if;

  new_status := case when p_accept then 'accepted' else 'declined' end;
  update public.member_form_cosigners
    set status = new_status,
        cosigner_user_id = case when p_accept then caller else cosigner_user_id end,
        responded_at = now()
    where id = inv.id;

  if p_accept then
    insert into public.member_notifications (user_id, title, body, kind)
    values (inv.invited_by, 'Co-signer accepted',
      'A member accepted your invitation to co-sign your alliance grievance.', 'forms');
  end if;
  return pg_catalog.jsonb_build_object('status', new_status);
end $function$;

CREATE OR REPLACE FUNCTION public.withdraw_cosign(p_form_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  inv record;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select id, invited_by into inv
    from public.member_form_cosigners
    where form_id = p_form_id and cosigner_user_id = caller and status = 'accepted'
    for update limit 1;
  if inv.id is null then
    raise exception 'you have no active co-signature on this form' using errcode='22023';
  end if;
  update public.member_form_cosigners
    set status = 'withdrawn', responded_at = now() where id = inv.id;
  insert into public.member_notifications (user_id, title, body, kind)
  values (inv.invited_by, 'Co-signer withdrew',
    'A co-signer withdrew from your alliance grievance.', 'forms');
  return pg_catalog.jsonb_build_object('status','withdrawn');
end $function$;

CREATE OR REPLACE FUNCTION public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  existing uuid;
  clean jsonb := coalesce(p_answers, '{}'::jsonb);
  prev_answers jsonb;
  tpl record;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select version, active into tpl from public.form_templates
    where key = p_template_key order by version desc limit 1;
  if not found then raise exception 'invalid template' using errcode='22023'; end if;
  if pg_catalog.jsonb_typeof(clean) <> 'object' or pg_catalog.length(clean::text) > 20000
    then raise exception 'answers too large' using errcode='22023'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-form-'||caller::text||'-'||p_template_key, 509));
  select id, answers into existing, prev_answers from public.member_forms
    where user_id=caller and template_key=p_template_key and status in ('draft','returned')
    order by updated_at desc limit 1;
  if existing is null then
    if not tpl.active then
      raise exception 'this form is no longer accepting new submissions' using errcode='22023';
    end if;
    insert into public.member_forms (user_id, template_key, template_version, answers, step)
      values (caller, p_template_key, tpl.version, clean, least(greatest(coalesce(p_step,0),0),50))
      returning id into existing;
  else
    update public.member_forms set answers=clean, step=least(greatest(coalesce(p_step,0),0),50), updated_at=now()
      where id=existing and user_id=caller;
    if p_template_key = 'alliance_grievance' and clean is distinct from prev_answers then
      with reset as (
        update public.member_form_cosigners
          set status='reaffirm_needed', responded_at=now()
          where form_id=existing and status='accepted'
          returning cosigner_user_id
      )
      insert into public.member_notifications (user_id, title, body, kind)
        select cosigner_user_id, 'Re-affirm your co-signature',
          'An alliance grievance you co-signed was edited. Please review and re-affirm your co-signature.', 'forms'
        from reset where cosigner_user_id is not null;
    end if;
  end if;
  return existing;
end;
$function$;

CREATE OR REPLACE FUNCTION private.notify_cosigners_on_approve()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.member_notifications (user_id, title, body, kind)
    select c.cosigner_user_id, 'Group workplace issue approved',
      'An alliance grievance you co-signed was approved by a steward.', 'forms'
    from public.member_form_cosigners c
    where c.form_id = new.id and c.status = 'accepted' and c.cosigner_user_id is not null;
  return new;
end $function$;

-- 5. Preference hygiene.
--
-- The trigger no longer casts anything a member can write, so this is defence
-- in depth rather than the fix for that defect. It matters for a second
-- reason: a member who stores {"cases": "false"} (a JSON *string*) would
-- reasonably expect case mail to stop, and under the no-cast rule it would
-- not. Rejecting non-boolean values makes the stored shape match the meaning.
--
-- ORDER MATTERS, and it is the reverse of the obvious one. The constraint is
-- created FIRST, then the existing rows are normalized. Normalizing first
-- would leave a window between the UPDATE's scan of a row and the constraint
-- becoming visible, and a member writing {"cases": []} inside that window
-- would be accepted by the old shape CHECK and then grandfathered forever by
-- a constraint that never re-examines existing rows. Creating it first closes
-- the window: NOT VALID skips the 100k-row scan but still rejects every new
-- and updated row from the moment it commits.

create or replace function private.notification_prefs_are_boolean(prefs jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select pg_catalog.count(*) = 0
  from pg_catalog.jsonb_each(prefs) e
  where pg_catalog.jsonb_typeof(e.value) <> 'boolean';
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.member_profiles'::regclass
      and conname = 'member_profiles_notification_prefs_boolean'
  ) then
    -- NOT VALID keeps this metadata-only against a 100k-row table. It is NOT
    -- a weaker constraint for new writes — only existing rows go unscanned.
    -- 20260723205000 validates it as an executable statement.
    alter table public.member_profiles
      add constraint member_profiles_notification_prefs_boolean
      check (private.notification_prefs_are_boolean(notification_prefs)) not valid;
  end if;
end
$$;

-- Now normalize what was already stored. Guarded by `where exists`, so on a
-- database whose rows are already boolean-only this updates zero rows and
-- rewrites nothing.
update public.member_profiles p
set notification_prefs = coalesce(
  (
    select pg_catalog.jsonb_object_agg(e.key, e.value)
    from pg_catalog.jsonb_each(p.notification_prefs) e
    where pg_catalog.jsonb_typeof(e.value) = 'boolean'
  ),
  '{}'::jsonb
)
where exists (
  select 1 from pg_catalog.jsonb_each(p.notification_prefs) e
  where pg_catalog.jsonb_typeof(e.value) <> 'boolean'
);

-- New members get the full topic set spelled out. Absent keys already mean
-- "enabled" in the trigger, so this only makes the stored shape self-describing.
alter table public.member_profiles
  alter column notification_prefs
  set default '{"deadlines": true, "cases": true, "forms": true, "votes": true, "events": true}'::jsonb;

notify pgrst, 'reload schema';
