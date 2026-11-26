-- REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118
--
-- Project decision, November 18, 2026: from the
-- People waiting page an intake_review platform operator writes one update
-- (subject and body) for one landing topic, sees the recipient count and a
-- preview, sends a test to their own signed-in address, then sends it to
-- everyone who opted into that topic.
--
-- 1. private.intake_topic_sends is the audit of every test and list send:
--    who, when, which topic, the exact subject and body, and the queued,
--    sent, failed and skipped counts. At most one list send per topic per
--    Eastern day, and a list send needs a delivered test of the same topic,
--    subject and body by the same operator within the last 24 hours.
-- 2. private.intake_topic_send_recipients is the queue. Recipients are the
--    landing opt-in rows for the topic with organization_id NULL whose
--    address is not on the Vault-keyed suppression ledger, one per address,
--    chosen when the operator presses Send. Each address is checked again
--    when the drain job takes it, and leaves the row as soon as its delivery
--    is settled.
-- 3. The drain (public.claim_intake_topic_send_batch and
--    public.finish_intake_topic_send_delivery) is called by the server job
--    in small batches. For every delivery it records a single-use stop token
--    digest in the existing private.public_interest_stop_confirmations, valid
--    for 60 days, so the email's unsubscribe link is the existing stop
--    confirmation (/stop-updates#confirm=...) and public.confirm_public_interest_stop
--    removes the address and suppresses it exactly as before.
-- 4. public.confirm_public_interest_unsubscribe is the RFC 8058 one-click
--    entry: mail providers post from their own servers, so it applies its own
--    network limit under its own limiter operation, unsubscribe-network-15m,
--    and refuses unknown tokens before any write, then calls
--    public.confirm_public_interest_stop unchanged. The shared limiter
--    (private.consume_public_interest_submission_limit and the operation check
--    on private.public_interest_submission_limits) admits that one new
--    operation; its body is otherwise the 20260930040000 definition. So
--    unsubscribe posts never spend the landing stop form's stop-network-15m
--    allowance for the same network.
--
-- No function or table of 20261118160000 is replaced. Nothing here sends
-- mail: the server routes do, and only after these functions say so.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------- 1. the send audit

create table private.intake_topic_sends (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('test', 'list')),
  topic text not null check (topic in ('chapter_updates', 'public_meetings', 'union_news')),
  subject text not null check (
    char_length(subject) between 1 and 150
    and subject = pg_catalog.btrim(subject)
    and subject !~ '[[:cntrl:]]'
  ),
  body text not null check (
    char_length(body) between 1 and 5000
    and pg_catalog.translate(body, pg_catalog.chr(10) || pg_catalog.chr(9), '') !~ '[[:cntrl:]]'
  ),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  operator_user_id uuid not null,
  idempotency_key uuid not null unique,
  eastern_day date not null,
  test_send_id uuid references private.intake_topic_sends (id),
  status text not null default 'sending' check (status in ('sending', 'done')),
  queued_count integer not null default 0 check (queued_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  constraint intake_topic_sends_shape check (
    (kind = 'test' and test_send_id is null and queued_count = 1 and skipped_count = 0)
    or (kind = 'list' and test_send_id is not null and queued_count >= 1)
  ),
  constraint intake_topic_sends_counts check (sent_count + failed_count + skipped_count <= queued_count),
  constraint intake_topic_sends_completion check ((status = 'done') = (completed_at is not null))
);

-- The owner's cadence: at most one list send per topic per Eastern day.
create unique index intake_topic_sends_one_list_per_topic_day
  on private.intake_topic_sends (topic, eastern_day)
  where kind = 'list';

create index intake_topic_sends_recent_idx
  on private.intake_topic_sends (created_at desc, id);

create index intake_topic_sends_operator_tests_idx
  on private.intake_topic_sends (operator_user_id, eastern_day)
  where kind = 'test';

alter table private.intake_topic_sends enable row level security;
alter table private.intake_topic_sends force row level security;
revoke all on private.intake_topic_sends from public, anon, authenticated, service_role;

comment on table private.intake_topic_sends is
  'Audit of every intake_review operator topic update: test sends to the operator and list sends to a landing topic, with subject, body and queued, sent, failed and skipped counts. Never holds a recipient address. Written only by the service-role definer functions; no client grant.';

-- ------------------------------------------------- 2. the delivery queue

create table private.intake_topic_send_recipients (
  id bigint generated always as identity primary key,
  send_id uuid not null references private.intake_topic_sends (id) on delete cascade,
  email text check (
    email is null
    or (char_length(email) <= 254
      and email = pg_catalog.lower(pg_catalog.btrim(email))
      and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
  ),
  locale text not null check (locale in ('en', 'es')),
  state text not null default 'queued' check (state in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  next_attempt_at timestamptz not null default pg_catalog.now(),
  lease_token uuid,
  leased_until timestamptz,
  unsubscribe_token_hash text check (unsubscribe_token_hash is null or unsubscribe_token_hash ~ '^[0-9a-f]{64}$'),
  finished_at timestamptz,
  constraint intake_topic_send_recipients_shape check (
    (state = 'queued' and email is not null and lease_token is null and leased_until is null
      and unsubscribe_token_hash is null and finished_at is null)
    or (state = 'sending' and email is not null and lease_token is not null and leased_until is not null
      and unsubscribe_token_hash is not null and finished_at is null)
    or (state in ('sent', 'failed', 'skipped') and email is null and lease_token is null and leased_until is null
      and unsubscribe_token_hash is null and finished_at is not null)
  )
);

create unique index intake_topic_send_recipients_one_per_address
  on private.intake_topic_send_recipients (send_id, email)
  where email is not null;

create index intake_topic_send_recipients_pending_idx
  on private.intake_topic_send_recipients (state, next_attempt_at, id)
  where state in ('queued', 'sending');

create index intake_topic_send_recipients_send_idx
  on private.intake_topic_send_recipients (send_id, state);

alter table private.intake_topic_send_recipients enable row level security;
alter table private.intake_topic_send_recipients force row level security;
revoke all on private.intake_topic_send_recipients from public, anon, authenticated, service_role;
revoke all on sequence private.intake_topic_send_recipients_id_seq from public, anon, authenticated, service_role;

comment on table private.intake_topic_send_recipients is
  'Queue of one list send''s deliveries. The address is held only while a delivery is queued or in flight and is cleared when it is sent, failed or skipped. Written only by the service-role definer functions; no client grant.';

-- ------------------------------------------------- 3. shared helpers (not executable)

-- The landing opt-ins for one topic that may receive it now: Union Ground's
-- own rows (organization_id NULL), one per address, not suppressed. The
-- newest row's language wins for the email's frame.
create function private.intake_topic_recipients(p_topic text)
returns table (email text, locale text)
language sql
stable
security definer
set search_path = ''
as $function$
  select r.email, r.locale
  from (
    select distinct on (s.email) s.email, s.locale
    from public.public_interest_submissions as s
    where s.organization_id is null
      and s.source = 'public-landing'
      and s.interest = p_topic
    order by s.email, s.last_submitted_at desc, s.id
  ) as r
  where not exists (
    select 1 from private.public_interest_suppressions as suppressed
    where suppressed.suppression_scope_hash = private.public_interest_suppression_scope(r.email)
  );
$function$;

revoke all on function private.intake_topic_recipients(text) from public, anon, authenticated, service_role;

-- Validates and normalizes the operator's update. Returns the clean subject
-- and body (CRLF and CR become LF), or raises 22023.
create function private.intake_topic_update_content(p_topic text, p_subject text, p_body text)
returns table (subject text, body text, content_sha256 text)
language plpgsql
stable
set search_path = ''
as $function$
declare
  clean_subject text := pg_catalog.btrim(coalesce(p_subject, ''));
  clean_body text := pg_catalog.btrim(
    pg_catalog.replace(pg_catalog.replace(coalesce(p_body, ''), pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10)),
      pg_catalog.chr(13), pg_catalog.chr(10)),
    ' ' || pg_catalog.chr(10) || pg_catalog.chr(9));
begin
  if p_topic is null or p_topic not in ('chapter_updates', 'public_meetings', 'union_news') then
    raise exception 'invalid topic' using errcode = '22023';
  end if;
  if char_length(clean_subject) not between 1 and 150 or clean_subject ~ '[[:cntrl:]]' then
    raise exception 'invalid subject' using errcode = '22023';
  end if;
  if char_length(clean_body) not between 1 and 5000
     or pg_catalog.translate(clean_body, pg_catalog.chr(10) || pg_catalog.chr(9), '') ~ '[[:cntrl:]]' then
    raise exception 'invalid body' using errcode = '22023';
  end if;
  return query select clean_subject, clean_body,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      p_topic || pg_catalog.chr(31) || clean_subject || pg_catalog.chr(31) || clean_body, 'UTF8')), 'hex');
end;
$function$;

revoke all on function private.intake_topic_update_content(text, text, text) from public, anon, authenticated, service_role;

-- One send's audit row for the operator's page: never an address.
create function private.intake_topic_send_row(p_send private.intake_topic_sends)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_send.id,
    'kind', p_send.kind,
    'topic', p_send.topic,
    'subject', p_send.subject,
    'status', p_send.status,
    'easternDay', p_send.eastern_day,
    'queued', p_send.queued_count,
    'sent', p_send.sent_count,
    'failed', p_send.failed_count,
    'skipped', p_send.skipped_count,
    'createdAt', p_send.created_at,
    'completedAt', p_send.completed_at
  );
$function$;

revoke all on function private.intake_topic_send_row(private.intake_topic_sends) from public, anon, authenticated, service_role;

-- Recounts one list send from its queue and closes it when nothing is left.
create function private.intake_topic_send_settle(p_send_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  pending integer;
begin
  -- Lock the send row in its own statement first. Under read committed each
  -- later statement takes a fresh snapshot, so a completion that waited here
  -- for another one to commit counts that one's settled delivery too, and two
  -- overlapping completions can never write stale counts or leave a finished
  -- send marked sending.
  perform 1 from private.intake_topic_sends as locked where locked.id = p_send_id for update;

  select pg_catalog.count(*) filter (where r.state in ('queued', 'sending'))::integer
  into pending
  from private.intake_topic_send_recipients as r
  where r.send_id = p_send_id;

  update private.intake_topic_sends as s
  set sent_count = c.sent,
      failed_count = c.failed,
      skipped_count = c.skipped,
      status = case when pending = 0 then 'done' else 'sending' end,
      completed_at = case when pending = 0 then coalesce(s.completed_at, pg_catalog.clock_timestamp()) else null end
  from (
    select
      pg_catalog.count(*) filter (where r.state = 'sent')::integer as sent,
      pg_catalog.count(*) filter (where r.state = 'failed')::integer as failed,
      pg_catalog.count(*) filter (where r.state = 'skipped')::integer as skipped
    from private.intake_topic_send_recipients as r
    where r.send_id = p_send_id
  ) as c
  where s.id = p_send_id and s.kind = 'list';
end;
$function$;

revoke all on function private.intake_topic_send_settle(uuid) from public, anon, authenticated, service_role;

-- ------------------------------------------------- 4. the operator's functions

-- Recipient counts per topic, today's list sends and the 20 newest sends.
-- Counts only, no address; not logged, like the queue summary.
create function public.intake_topic_send_overview(
  p_operator_user_id uuid,
  p_operator_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  topics jsonb;
  recent jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'topic', t.topic,
      'recipients', (select pg_catalog.count(*)::integer from private.intake_topic_recipients(t.topic)),
      'sentToday', exists (
        select 1 from private.intake_topic_sends as s
        where s.kind = 'list' and s.topic = t.topic and s.eastern_day = today))
    order by t.ordinal)
  into topics
  from unnest(array['chapter_updates', 'public_meetings', 'union_news']) with ordinality as t(topic, ordinal);

  select coalesce(pg_catalog.jsonb_agg(
      private.intake_topic_send_row(s) || pg_catalog.jsonb_build_object('mine', s.operator_user_id = p_operator_user_id)
      order by s.created_at desc, s.id), '[]'::jsonb)
  into recent
  from (
    select * from private.intake_topic_sends
    order by created_at desc, id
    limit 20
  ) as s;

  return pg_catalog.jsonb_build_object('today', today, 'topics', topics, 'sends', recent);
end;
$$;

revoke all on function public.intake_topic_send_overview(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.intake_topic_send_overview(uuid, uuid) to service_role;

comment on function public.intake_topic_send_overview(uuid, uuid) is
  'Service-only intake_review operator read: recipients per landing topic (organization_id NULL, not suppressed, one per address), whether each topic had its list send today (Eastern), and the 20 newest sends with counts. No address; not logged.';

-- Records a test of the update and answers the operator's own signed-in
-- address, which the server mails it to. At most ten tests per operator per
-- Eastern day; the same idempotency key answers the same row.
create function public.begin_intake_topic_test_send(
  p_operator_user_id uuid,
  p_operator_session_id uuid,
  p_topic text,
  p_subject text,
  p_body text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  today date;
  content record;
  operator_email text;
  existing private.intake_topic_sends%rowtype;
  created private.intake_topic_sends%rowtype;
begin
  -- It reads the operator's auth.users row and takes an advisory lock, so it
  -- enters the account case graph first, before any initializer or read
  -- (tests/account-case-graph-lock-inventory.test.js).
  perform private.lock_case_graph(array[p_operator_user_id], array[]::uuid[]);
  today := (pg_catalog.now() at time zone 'America/New_York')::date;
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  select * into content from private.intake_topic_update_content(p_topic, p_subject, p_body);

  select * into existing from private.intake_topic_sends where idempotency_key = p_idempotency_key;
  if found then
    if existing.kind <> 'test' or existing.operator_user_id <> p_operator_user_id
       or existing.content_sha256 <> content.content_sha256 then
      return pg_catalog.jsonb_build_object('started', false, 'refusal', 'key-reused');
    end if;
    return pg_catalog.jsonb_build_object('started', false, 'refusal', 'repeat', 'send', private.intake_topic_send_row(existing));
  end if;

  select pg_catalog.lower(pg_catalog.btrim(u.email)) into operator_email
  from auth.users as u
  where u.id = p_operator_user_id;
  if operator_email is null or char_length(operator_email) > 254
     or operator_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return pg_catalog.jsonb_build_object('started', false, 'refusal', 'no-operator-email');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('intake-topic-test:' || p_operator_user_id::text, 509));
  if (select pg_catalog.count(*) from private.intake_topic_sends as s
      where s.kind = 'test' and s.operator_user_id = p_operator_user_id and s.eastern_day = today) >= 10 then
    return pg_catalog.jsonb_build_object('started', false, 'refusal', 'test-limit');
  end if;

  insert into private.intake_topic_sends (
    kind, topic, subject, body, content_sha256, operator_user_id, idempotency_key, eastern_day, queued_count
  ) values (
    'test', p_topic, content.subject, content.body, content.content_sha256, p_operator_user_id, p_idempotency_key, today, 1
  )
  returning * into created;

  return pg_catalog.jsonb_build_object(
    'started', true,
    'send', private.intake_topic_send_row(created),
    'to', operator_email,
    'subject', created.subject,
    'body', created.body
  );
end;
$$;

revoke all on function public.begin_intake_topic_test_send(uuid, uuid, text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.begin_intake_topic_test_send(uuid, uuid, text, text, text, uuid) to service_role;

comment on function public.begin_intake_topic_test_send(uuid, uuid, text, text, text, uuid) is
  'Service-only intake_review operator test of a topic update: records one test send (at most ten per operator per Eastern day; idempotent by key) and answers the operator''s own signed-in address for the server to mail it to.';

-- Records whether the provider accepted the test. Only the operator who
-- began it, and only once.
create function public.finish_intake_topic_test_send(
  p_operator_user_id uuid,
  p_operator_session_id uuid,
  p_send_id uuid,
  p_delivered boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_send private.intake_topic_sends%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);
  if p_send_id is null or p_delivered is null then
    raise exception 'send and outcome required' using errcode = '22023';
  end if;

  select * into current_send
  from private.intake_topic_sends
  where id = p_send_id and kind = 'test' and operator_user_id = p_operator_user_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('recorded', false, 'refusal', 'not-found');
  end if;
  if current_send.status = 'done' then
    return pg_catalog.jsonb_build_object('recorded', false, 'refusal', 'already-recorded', 'send', private.intake_topic_send_row(current_send));
  end if;

  update private.intake_topic_sends
  set status = 'done',
      completed_at = pg_catalog.clock_timestamp(),
      sent_count = case when p_delivered then 1 else 0 end,
      failed_count = case when p_delivered then 0 else 1 end
  where id = p_send_id
  returning * into current_send;

  return pg_catalog.jsonb_build_object('recorded', true, 'send', private.intake_topic_send_row(current_send));
end;
$$;

revoke all on function public.finish_intake_topic_test_send(uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.finish_intake_topic_test_send(uuid, uuid, uuid, boolean) to service_role;

comment on function public.finish_intake_topic_test_send(uuid, uuid, uuid, boolean) is
  'Service-only: records once whether the provider accepted the operator''s own test send.';

-- The operator presses Send. Needs a delivered test of exactly this topic,
-- subject and body by the same operator within 24 hours, and no list send of
-- this topic yet today (Eastern). Chooses the recipients now and queues them.
create function public.queue_intake_topic_send(
  p_operator_user_id uuid,
  p_operator_session_id uuid,
  p_topic text,
  p_subject text,
  p_body text,
  p_test_send_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  moment timestamptz := clock_timestamp();
  content record;
  existing private.intake_topic_sends%rowtype;
  test_send private.intake_topic_sends%rowtype;
  created private.intake_topic_sends%rowtype;
  queued integer;
  recipient_emails text[];
  recipient_locales text[];
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);
  if p_idempotency_key is null or p_test_send_id is null then
    raise exception 'idempotency key and test send required' using errcode = '22023';
  end if;
  select * into content from private.intake_topic_update_content(p_topic, p_subject, p_body);

  select * into existing from private.intake_topic_sends where idempotency_key = p_idempotency_key;
  if found then
    if existing.kind <> 'list' or existing.operator_user_id <> p_operator_user_id
       or existing.content_sha256 <> content.content_sha256 then
      return pg_catalog.jsonb_build_object('queued', false, 'refusal', 'key-reused');
    end if;
    return pg_catalog.jsonb_build_object('queued', false, 'refusal', 'repeat', 'send', private.intake_topic_send_row(existing));
  end if;

  select * into test_send
  from private.intake_topic_sends
  where id = p_test_send_id;
  if not found or test_send.kind <> 'test'
     or test_send.operator_user_id <> p_operator_user_id
     or test_send.content_sha256 <> content.content_sha256
     or test_send.status <> 'done' or test_send.sent_count <> 1
     or test_send.created_at <= moment - interval '24 hours' then
    return pg_catalog.jsonb_build_object('queued', false, 'refusal', 'test-required');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('intake-topic-send:' || p_topic, 509));
  if exists (
    select 1 from private.intake_topic_sends as s
    where s.kind = 'list' and s.topic = p_topic and s.eastern_day = today
  ) then
    return pg_catalog.jsonb_build_object('queued', false, 'refusal', 'already-sent-today');
  end if;

  -- One read of the recipient set: the send's queued_count and its queue rows
  -- come from the same snapshot, so an opt-in that lands meanwhile can never
  -- queue a delivery the count does not hold.
  select coalesce(pg_catalog.array_agg(r.email order by r.email), array[]::text[]),
         coalesce(pg_catalog.array_agg(r.locale order by r.email), array[]::text[])
  into recipient_emails, recipient_locales
  from private.intake_topic_recipients(p_topic) as r;
  queued := pg_catalog.cardinality(recipient_emails);
  if queued = 0 then
    return pg_catalog.jsonb_build_object('queued', false, 'refusal', 'no-recipients');
  end if;

  insert into private.intake_topic_sends (
    kind, topic, subject, body, content_sha256, operator_user_id, idempotency_key, eastern_day,
    test_send_id, queued_count, created_at
  ) values (
    'list', p_topic, content.subject, content.body, content.content_sha256, p_operator_user_id, p_idempotency_key, today,
    p_test_send_id, queued, moment
  )
  returning * into created;

  insert into private.intake_topic_send_recipients (send_id, email, locale, next_attempt_at)
  select created.id, r.email, r.locale, moment
  from unnest(recipient_emails, recipient_locales) as r(email, locale);

  return pg_catalog.jsonb_build_object('queued', true, 'send', private.intake_topic_send_row(created));
end;
$$;

revoke all on function public.queue_intake_topic_send(uuid, uuid, text, text, text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.queue_intake_topic_send(uuid, uuid, text, text, text, uuid, uuid) to service_role;

comment on function public.queue_intake_topic_send(uuid, uuid, text, text, text, uuid, uuid) is
  'Service-only intake_review operator list send of one topic update: needs the same operator''s delivered test of the same content within 24 hours and no list send of the topic today (Eastern); queues one delivery per opted-in, unsuppressed Union Ground address (organization_id NULL). The send row is the audit.';

-- ------------------------------------------------- 5. the drain (server job only)

-- Takes up to one batch of due deliveries. A delivery whose lease ran out
-- with no outcome counts as failed (the provider may have accepted it, so it
-- is never sent twice). Each address is checked again: no longer opted in or
-- now suppressed is skipped. Every taken delivery gets one of the caller's
-- token digests, recorded as a 60-day stop confirmation for its address.
create function public.claim_intake_topic_send_batch(
  p_lease_token uuid,
  p_token_hashes text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  moment timestamptz := clock_timestamp();
  wanted integer := coalesce(pg_catalog.cardinality(p_token_hashes), 0);
  used integer := 0;
  candidate record;
  touched uuid[] := array[]::uuid[];
  deliveries jsonb := '[]'::jsonb;
  skipped integer := 0;
  expired integer := 0;
  send_id uuid;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_lease_token is null or wanted not between 1 and 50
     or exists (select 1 from unnest(p_token_hashes) as h(v) where h.v is null or h.v !~ '^[0-9a-f]{64}$')
     or (select pg_catalog.count(distinct h.v) from unnest(p_token_hashes) as h(v)) <> wanted then
    raise exception 'invalid batch' using errcode = '22023';
  end if;

  with stale as (
    select r.id from private.intake_topic_send_recipients as r
    where r.state = 'sending' and r.leased_until < moment
    order by r.leased_until, r.id
    limit 200
    for update skip locked
  ), settled as (
    update private.intake_topic_send_recipients as r
    set state = 'failed', email = null, lease_token = null, leased_until = null,
        unsubscribe_token_hash = null, finished_at = moment
    from stale
    where r.id = stale.id
    returning r.send_id
  )
  select pg_catalog.count(*)::integer, coalesce(pg_catalog.array_agg(distinct settled.send_id), array[]::uuid[])
  into expired, touched
  from settled;

  for candidate in
    select r.id, r.send_id, r.email, r.locale, r.attempts, s.topic, s.subject, s.body
    from private.intake_topic_send_recipients as r
    join private.intake_topic_sends as s on s.id = r.send_id
    where r.state = 'queued' and r.next_attempt_at <= moment and s.kind = 'list'
    order by r.next_attempt_at, r.id
    limit wanted
    for update of r skip locked
  loop
    touched := touched || candidate.send_id;
    if not exists (
         select 1 from public.public_interest_submissions as s
         where s.email = candidate.email and s.interest = candidate.topic
           and s.source = 'public-landing' and s.organization_id is null)
       or exists (
         select 1 from private.public_interest_suppressions as suppressed
         where suppressed.suppression_scope_hash = private.public_interest_suppression_scope(candidate.email)) then
      update private.intake_topic_send_recipients
      set state = 'skipped', email = null, finished_at = moment
      where id = candidate.id;
      skipped := skipped + 1;
      continue;
    end if;

    used := used + 1;
    insert into private.public_interest_stop_confirmations (
      token_hash, normalized_email, locale, source, created_at, expires_at
    ) values (
      p_token_hashes[used], candidate.email, candidate.locale, 'public-landing', moment, moment + interval '60 days'
    );
    update private.intake_topic_send_recipients
    set state = 'sending', attempts = attempts + 1, lease_token = p_lease_token,
        leased_until = moment + interval '5 minutes', unsubscribe_token_hash = p_token_hashes[used]
    where id = candidate.id;
    deliveries := deliveries || pg_catalog.jsonb_build_object(
      'id', candidate.id,
      'sendId', candidate.send_id,
      'email', candidate.email,
      'locale', candidate.locale,
      'topic', candidate.topic,
      'subject', candidate.subject,
      'body', candidate.body,
      'attempt', candidate.attempts + 1,
      'token', used
    );
  end loop;

  foreach send_id in array array(select distinct t from unnest(touched) as t order by t) loop
    perform private.intake_topic_send_settle(send_id);
  end loop;

  return pg_catalog.jsonb_build_object('deliveries', deliveries, 'skipped', skipped, 'expired', expired);
end;
$$;

revoke all on function public.claim_intake_topic_send_batch(uuid, text[]) from public, anon, authenticated, service_role;
grant execute on function public.claim_intake_topic_send_batch(uuid, text[]) to service_role;

comment on function public.claim_intake_topic_send_batch(uuid, text[]) is
  'Service-only drain step for queued topic update deliveries: at most 50 per call, each address re-checked against the opt-in and the suppression ledger, each taken delivery leased for 5 minutes and given one caller token digest as a 60-day stop confirmation. An expired lease counts as failed and is never retried.';

-- Settles one leased delivery:
--   sent      the provider accepted it;
--   failed    the provider refused it (a definite rejection): its unused stop
--             confirmation is deleted;
--   retry     the provider declined it for now (rate limited): queued again
--             with a backoff, up to three attempts, its unused confirmation
--             deleted (the next attempt gets a new one);
--   unknown   no definite answer (no reply, a timeout or a provider error):
--             the email may have been delivered, so it is counted failed,
--             never sent again, and keeps its stop confirmation, so its
--             unsubscribe link and header keep working;
-- A delivery the dispatcher ran out of time for was never tried; it goes back
-- through public.release_intake_topic_send_deliveries, one call for the whole
-- untried tail, so only a real send attempt counts towards the three.
create function public.finish_intake_topic_send_delivery(
  p_lease_token uuid,
  p_delivery_id bigint,
  p_outcome text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  moment timestamptz := clock_timestamp();
  current_row private.intake_topic_send_recipients%rowtype;
  final_state text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_lease_token is null or p_delivery_id is null or p_outcome is null
     or p_outcome not in ('sent', 'failed', 'retry', 'unknown') then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;

  select * into current_row
  from private.intake_topic_send_recipients
  where id = p_delivery_id and state = 'sending' and lease_token = p_lease_token
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;

  if p_outcome in ('failed', 'retry') then
    delete from private.public_interest_stop_confirmations
    where token_hash = current_row.unsubscribe_token_hash;
  end if;

  if p_outcome = 'retry' and current_row.attempts < 3 then
    update private.intake_topic_send_recipients
    set state = 'queued', lease_token = null, leased_until = null, unsubscribe_token_hash = null,
        next_attempt_at = moment + pg_catalog.make_interval(mins => 5 * current_row.attempts)
    where id = p_delivery_id;
    final_state := 'queued';
  else
    final_state := case when p_outcome = 'sent' then 'sent' else 'failed' end;
    update private.intake_topic_send_recipients
    set state = final_state, email = null, lease_token = null, leased_until = null,
        unsubscribe_token_hash = null, finished_at = moment
    where id = p_delivery_id;
  end if;

  perform private.intake_topic_send_settle(current_row.send_id);
  return pg_catalog.jsonb_build_object('recorded', true, 'state', final_state);
end;
$$;

revoke all on function public.finish_intake_topic_send_delivery(uuid, bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.finish_intake_topic_send_delivery(uuid, bigint, text) to service_role;

comment on function public.finish_intake_topic_send_delivery(uuid, bigint, text) is
  'Service-only drain step: records one leased topic update delivery as sent, failed (definite rejection), retry (rate limited; at most three real attempts) or unknown (may have been delivered: failed, never resent, stop confirmation kept); clears the address once settled, deletes the unused stop confirmation of a delivery that was definitely not delivered, and recounts its send.';

-- Gives back, in one call, every delivery of one lease that the dispatcher
-- never tried because it ran out of time: each goes back to the queue at
-- once with the attempt the claim counted given back, and loses its unused
-- stop confirmation (its token never left the server). A delivery of another
-- lease, or one already settled, is left alone. The dispatcher reserves this
-- call's time before its runtime limit.
create function public.release_intake_topic_send_deliveries(
  p_lease_token uuid,
  p_delivery_ids bigint[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  moment timestamptz := clock_timestamp();
  released integer := 0;
  touched uuid[];
  send_id uuid;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_lease_token is null or coalesce(pg_catalog.cardinality(p_delivery_ids), 0) not between 1 and 50
     or exists (select 1 from unnest(p_delivery_ids) as d(v) where d.v is null) then
    raise exception 'invalid release' using errcode = '22023';
  end if;

  with taken as (
    select r.id, r.send_id, r.unsubscribe_token_hash
    from private.intake_topic_send_recipients as r
    where r.id = any (p_delivery_ids) and r.state = 'sending' and r.lease_token = p_lease_token
    order by r.id
    for update
  ), dropped as (
    delete from private.public_interest_stop_confirmations as c
    using taken
    where c.token_hash = taken.unsubscribe_token_hash
  ), requeued as (
    update private.intake_topic_send_recipients as r
    set state = 'queued', attempts = r.attempts - 1, lease_token = null, leased_until = null,
        unsubscribe_token_hash = null, next_attempt_at = moment
    from taken
    where r.id = taken.id
    returning r.send_id
  )
  select pg_catalog.count(*)::integer, coalesce(pg_catalog.array_agg(distinct requeued.send_id), array[]::uuid[])
  into released, touched
  from requeued;

  foreach send_id in array array(select distinct t from unnest(touched) as t order by t) loop
    perform private.intake_topic_send_settle(send_id);
  end loop;

  return pg_catalog.jsonb_build_object('released', released);
end;
$$;

revoke all on function public.release_intake_topic_send_deliveries(uuid, bigint[]) from public, anon, authenticated, service_role;
grant execute on function public.release_intake_topic_send_deliveries(uuid, bigint[]) to service_role;

comment on function public.release_intake_topic_send_deliveries(uuid, bigint[]) is
  'Service-only drain step: in one call, puts back every still-leased delivery of one lease that the dispatcher never tried (at most 50): queued at once, the claimed attempt given back, its unused stop confirmation deleted; recounts each send. Other leases and settled deliveries are untouched.';

-- ------------------------------------------------- 6. one-click unsubscribe

-- The unsubscribe route derives its network scope the way the stop form does,
-- so it needs its own operation: on stop-network-15m the two would share one
-- window row, and junk unsubscribe posts could lock a network out of the stop
-- form. Same check and same limiter body as 20260930040000, plus that one
-- operation.
alter table private.public_interest_submission_limits
  drop constraint public_interest_submission_limits_operation_check;

alter table private.public_interest_submission_limits
  add constraint public_interest_submission_limits_operation_check
  check (operation in (
    'network-15m',
    'email-interest-day',
    'stop-network-15m',
    'stop-email-day',
    'claim-network-hour',
    'claim-email-day',
    'claim-org-day',
    'claim-confirm-network-15m',
    'unsubscribe-network-15m'
  ));

create or replace function private.consume_public_interest_submission_limit(
  p_scope_hash text,
  p_operation text,
  p_limit integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row private.public_interest_submission_limits%rowtype;
  moment timestamptz := clock_timestamp();
begin
  if p_scope_hash is null
     or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_operation not in (
       'network-15m',
       'email-interest-day',
       'stop-network-15m',
       'stop-email-day',
       'claim-network-hour',
       'claim-email-day',
       'claim-org-day',
       'claim-confirm-network-15m',
       'unsubscribe-network-15m'
     )
     or p_limit < 1
     or p_window <= interval '0 seconds' then
    raise exception 'invalid public interest rate limit' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-interest-rate:' || p_operation || ':' || p_scope_hash,
      509
    )
  );

  select * into current_row
  from private.public_interest_submission_limits
  where scope_hash = p_scope_hash and operation = p_operation
  for update;

  if not found then
    insert into private.public_interest_submission_limits
      (scope_hash, operation, window_started_at, request_count)
    values (p_scope_hash, p_operation, moment, 1);
    return true;
  end if;

  if current_row.window_started_at + p_window <= moment then
    update private.public_interest_submission_limits
    set window_started_at = moment, request_count = 1
    where scope_hash = p_scope_hash and operation = p_operation;
    return true;
  end if;

  if current_row.request_count >= p_limit then
    return false;
  end if;

  update private.public_interest_submission_limits
  set request_count = request_count + 1
  where scope_hash = p_scope_hash and operation = p_operation;
  return true;
end;
$$;


revoke all on function private.consume_public_interest_submission_limit(text, text, integer, interval)
  from public, anon, authenticated, service_role;

-- RFC 8058: the mail provider posts from its own servers. A per-network
-- limit under its own operation (unsubscribe-network-15m, never the stop
-- form's stop-network-15m), an unknown or expired token refused before any
-- write, then the existing stop confirmation, charged to a scope of the token
-- itself.
create function public.confirm_public_interest_unsubscribe(
  p_token_hash text,
  p_scope_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;
  if not private.consume_public_interest_submission_limit(
    p_scope_hash, 'unsubscribe-network-15m', 300, interval '15 minutes'
  ) then
    return pg_catalog.jsonb_build_object('confirmed', false, 'refusal', 'rate-limited');
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' or not exists (
    select 1 from private.public_interest_stop_confirmations as pending
    where pending.token_hash = clean_hash and pending.expires_at > pg_catalog.clock_timestamp()
  ) then
    return pg_catalog.jsonb_build_object('confirmed', false, 'refusal', 'unavailable');
  end if;
  return public.confirm_public_interest_stop(
    clean_hash,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('intake-topic-unsubscribe-v1:' || clean_hash, 'UTF8')), 'hex')
  );
end;
$$;

revoke all on function public.confirm_public_interest_unsubscribe(text, text) from public, anon, authenticated, service_role;
grant execute on function public.confirm_public_interest_unsubscribe(text, text) to service_role;

comment on function public.confirm_public_interest_unsubscribe(text, text) is
  'Service-only RFC 8058 one-click unsubscribe from a topic update email: its own per-network limit (unsubscribe-network-15m, 300 per 15 minutes), unknown and expired tokens refused before any write, then public.confirm_public_interest_stop unchanged (suppression and removal of every row for the address).';

notify pgrst, 'reload schema';

commit;
