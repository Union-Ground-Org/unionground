-- UB-RWD-01: make the restored `im-anyone` perk real without restoring the
-- deleted prototype's member directory. A member can share only their own
-- non-enumerable code. A live grantee can submit that exact code, but learns
-- no identity until the same-chapter recipient explicitly accepts.

set local lock_timeout = '5s';

-- The 80-bit display code is derived at the RPC boundary from a database-only
-- random secret. Plaintext contact codes are never stored, logged, indexed, or
-- accepted from any source other than the one request argument.
create table private.member_peer_contact_secret (
  id boolean primary key default true check (id),
  secret bytea not null check (pg_catalog.length(secret) = 32)
);

insert into private.member_peer_contact_secret (id, secret)
values (true, extensions.gen_random_bytes(32));

revoke all on private.member_peer_contact_secret from public, anon, authenticated, service_role;

create function private.member_peer_contact_code(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select 'UG-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(p_user_id::text, 'UTF8'), secret.secret, 'sha256'),
    'hex'), 1, 20))
  from private.member_peer_contact_secret secret
  where secret.id
$$;

revoke all on function private.member_peer_contact_code(uuid) from public, anon, authenticated, service_role;

-- Only the digest is indexed. This permits one exact lookup without storing a
-- recoverable code or scanning names, profiles, email addresses, or chapters.
create table public.member_peer_contact_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code_digest bytea not null unique,
  created_at timestamptz not null default now()
);

create function private.sync_member_peer_contact_key()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.member_peer_contact_keys (user_id, code_digest)
  values (
    new.id,
    extensions.digest(
      pg_catalog.convert_to(private.member_peer_contact_code(new.id), 'UTF8'),
      'sha256'))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function private.sync_member_peer_contact_key() from public, anon, authenticated, service_role;

insert into public.member_peer_contact_keys (user_id, code_digest)
select p.id, extensions.digest(
  pg_catalog.convert_to(private.member_peer_contact_code(p.id), 'UTF8'),
  'sha256')
from public.member_profiles p
on conflict (user_id) do nothing;

create trigger member_profiles_peer_contact_key
after insert on public.member_profiles
for each row execute function private.sync_member_peer_contact_key();

create table public.member_peer_contact_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  check (requester_id <> recipient_id),
  check (expires_at > created_at),
  check ((status = 'pending' and responded_at is null)
      or (status in ('declined', 'accepted') and responded_at is not null))
);

create index member_peer_contact_requests_requester_created_idx
  on public.member_peer_contact_requests (requester_id, created_at desc);
create index member_peer_contact_requests_recipient_pending_idx
  on public.member_peer_contact_requests (recipient_id, expires_at, created_at)
  where status = 'pending';
create index member_peer_contact_requests_pair_created_idx
  on public.member_peer_contact_requests (
    least(requester_id, recipient_id),
    greatest(requester_id, recipient_id),
    created_at desc);

create table public.member_peer_conversations (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  user_low uuid not null references auth.users(id) on delete cascade,
  user_high uuid not null references auth.users(id) on delete cascade,
  created_from_request uuid not null unique references public.member_peer_contact_requests(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_low < user_high),
  unique (user_low, user_high)
);

create index member_peer_conversations_low_updated_idx
  on public.member_peer_conversations (user_low, updated_at desc);
create index member_peer_conversations_high_updated_idx
  on public.member_peer_conversations (user_high, updated_at desc);

create table public.member_peer_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  conversation_id uuid not null references public.member_peer_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (pg_catalog.char_length(body) between 1 and 4000),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index member_peer_messages_conversation_created_idx
  on public.member_peer_messages (conversation_id, created_at desc, id desc);
create index member_peer_messages_sender_recent_idx
  on public.member_peer_messages (sender_id, created_at desc);

alter table public.member_peer_contact_keys enable row level security;
alter table public.member_peer_contact_requests enable row level security;
alter table public.member_peer_conversations enable row level security;
alter table public.member_peer_messages enable row level security;

-- Defense in depth for a future deliberately column-scoped grant. The tables
-- remain RPC-only below, so user ids never enter the browser payload today.
create policy member_peer_contact_keys_select_own on public.member_peer_contact_keys
  for select to authenticated using (user_id = (select auth.uid()));
create policy member_peer_contact_requests_select_participant on public.member_peer_contact_requests
  for select to authenticated using (
    requester_id = (select auth.uid()) or recipient_id = (select auth.uid()));
create policy member_peer_conversations_select_participant on public.member_peer_conversations
  for select to authenticated using (
    user_low = (select auth.uid()) or user_high = (select auth.uid()));
create policy member_peer_messages_select_participant on public.member_peer_messages
  for select to authenticated using (exists (
    select 1 from public.member_peer_conversations c
    where c.id = conversation_id
      and (c.user_low = (select auth.uid()) or c.user_high = (select auth.uid()))
  ));
create policy mfa_assurance on public.member_peer_contact_keys as restrictive
  for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
create policy mfa_assurance on public.member_peer_contact_requests as restrictive
  for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
create policy mfa_assurance on public.member_peer_conversations as restrictive
  for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
create policy mfa_assurance on public.member_peer_messages as restrictive
  for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());

revoke all on public.member_peer_contact_keys from public, anon, authenticated;
revoke all on public.member_peer_contact_requests from public, anon, authenticated;
revoke all on public.member_peer_conversations from public, anon, authenticated;
revoke all on public.member_peer_messages from public, anon, authenticated;

create function private.member_peer_profile_label(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'name', coalesce(nullif(pg_catalog.btrim(p.full_name), ''), 'Member'),
    'initials', coalesce(nullif(pg_catalog.btrim(p.initials), ''), 'M'))
  from public.member_profiles p
  where p.id = p_user_id
$$;

revoke all on function private.member_peer_profile_label(uuid) from public, anon, authenticated, service_role;

create function public.list_reward_peer_contact()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'available', true,
    'canRequest', private.member_reward_effect_enabled(caller, 'im-anyone'),
    'code', private.member_peer_contact_code(caller),
    'incoming', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', incoming.id,
        'requesterName', incoming.label ->> 'name',
        'requesterInitials', incoming.label ->> 'initials',
        'createdAt', incoming.created_at,
        'expiresAt', incoming.expires_at
      ) order by incoming.created_at desc)
      from (
        select r.id, r.created_at, r.expires_at,
          private.member_peer_profile_label(r.requester_id) as label
        from public.member_peer_contact_requests r
        where r.recipient_id = caller
          and r.status = 'pending'
          and r.expires_at > now()
          and r.chapter_id = private.current_member_chapter()
          and exists (
            select 1 from public.member_profiles p
            where p.id = r.requester_id and p.chapter_id = r.chapter_id
          )
        order by r.created_at desc
        limit 20
      ) incoming
    ), '[]'::jsonb),
    -- Pending/declined requests deliberately contain no recipient identity.
    'outgoing', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', outgoing.id,
        'status', outgoing.status,
        'createdAt', outgoing.created_at,
        'expiresAt', outgoing.expires_at
      ) order by outgoing.created_at desc)
      from (
        select r.id,
          case when r.status = 'pending' and r.expires_at <= now() then 'expired' else r.status end as status,
          r.created_at, r.expires_at
        from public.member_peer_contact_requests r
        where r.requester_id = caller
          and r.created_at >= now() - interval '90 days'
        order by r.created_at desc
        limit 20
      ) outgoing
    ), '[]'::jsonb),
    'conversations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', conversation.id,
        'peerName', conversation.label ->> 'name',
        'peerInitials', conversation.label ->> 'initials',
        'updatedAt', conversation.updated_at,
        'messages', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', message.id,
            'sentByMe', message.sender_id = caller,
            'body', message.body,
            'createdAt', message.created_at
          ) order by message.created_at, message.id)
          from (
            select m.id, m.sender_id, m.body, m.created_at
            from public.member_peer_messages m
            where m.conversation_id = conversation.id
            order by m.created_at desc, m.id desc
            limit 100
          ) message
        ), '[]'::jsonb)
      ) order by conversation.updated_at desc)
      from (
        select c.id, c.updated_at,
          -- Accepted consent survives a later chapter move, so both the
          -- conversation and the minimal name/initials label remain visible
          -- to its two participants. Pending labels above fail closed as soon
          -- as either profile leaves the request chapter.
          private.member_peer_profile_label(
            case when c.user_low = caller then c.user_high else c.user_low end) as label
        from public.member_peer_conversations c
        where c.user_low = caller or c.user_high = caller
        order by c.updated_at desc
        limit 50
      ) conversation
    ), '[]'::jsonb)
  );
end;
$$;

create function public.request_reward_peer_contact(p_contact_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  normalized_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_contact_code, '')));
  target uuid;
  target_chapter text;
  created_id uuid;
  created_at_value timestamptz;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- One caller lock makes the 24-hour limit exact even under two connections.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('peer-contact-caller:' || caller::text, 0));

  -- Every eligibility/code/scope/cooldown refusal is the same response and
  -- performs no write. In particular, an exact-code miss leaves no audit row
  -- containing the submitted plaintext or a derived identifier.
  if normalized_code !~ '^UG-[0-9A-F]{20}$'
     or not private.member_reward_effect_enabled(caller, 'im-anyone')
     or (select pg_catalog.count(*) from public.member_peer_contact_requests r
         where r.requester_id = caller and r.created_at >= now() - interval '24 hours') >= 3 then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  select k.user_id into target
  from public.member_peer_contact_keys k
  where k.code_digest = extensions.digest(
    pg_catalog.convert_to(normalized_code, 'UTF8'), 'sha256');

  if target is null or target = caller then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  -- Lock both exact profile rows in UUID order before deriving chapter scope.
  -- A concurrent member move/delete therefore completes first (and this call
  -- sees the new scope) or waits until this request decision commits.
  perform p.id
  from public.member_profiles p
  where p.id in (caller, target)
  order by p.id
  for share;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  select p.chapter_id into target_chapter
  from public.member_profiles p where p.id = target;

  if caller_chapter is null or target_chapter is distinct from caller_chapter then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'peer-contact-pair:' || least(caller, target)::text || ':' || greatest(caller, target)::text, 0));

  if exists (
    select 1 from public.member_peer_conversations c
    where c.user_low = least(caller, target) and c.user_high = greatest(caller, target)
  ) or exists (
    -- Pair requests are limited to one every 14 days in either direction.
    select 1 from public.member_peer_contact_requests r
    where least(r.requester_id, r.recipient_id) = least(caller, target)
      and greatest(r.requester_id, r.recipient_id) = greatest(caller, target)
      and r.created_at >= now() - interval '14 days'
  ) then
    return pg_catalog.jsonb_build_object('requested', false, 'reason', 'contact request unavailable');
  end if;

  insert into public.member_peer_contact_requests (requester_id, recipient_id, chapter_id)
  values (caller, target, caller_chapter)
  returning id, created_at into created_id, created_at_value;

  return pg_catalog.jsonb_build_object(
    'requested', true,
    'id', created_id,
    'status', 'pending',
    'createdAt', created_at_value);
end;
$$;

create function public.respond_reward_peer_contact(p_request_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  request_row public.member_peer_contact_requests%rowtype;
  conversation_id_value uuid;
  peer_label jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select r.* into request_row
  from public.member_peer_contact_requests r
  where r.id = p_request_id
    and r.recipient_id = caller
    and r.status = 'pending'
    and r.expires_at > now()
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('accepted', false, 'reason', 'contact request unavailable');
  end if;

  -- The request row is locked above; lock both participant profiles in the
  -- same deterministic order used by request creation before rechecking their
  -- live chapter membership. Moves/deletes cannot slip between check+accept.
  perform p.id
  from public.member_profiles p
  where p.id in (request_row.requester_id, request_row.recipient_id)
  order by p.id
  for share;

  if request_row.chapter_id is distinct from private.current_member_chapter()
     or request_row.chapter_id is distinct from (
       select p.chapter_id from public.member_profiles p where p.id = request_row.requester_id
     ) then
    return pg_catalog.jsonb_build_object('accepted', false, 'reason', 'contact request unavailable');
  end if;

  if not coalesce(p_accept, false) then
    update public.member_peer_contact_requests
    set status = 'declined', responded_at = now()
    where id = request_row.id;
    return pg_catalog.jsonb_build_object('accepted', false, 'declined', true);
  end if;

  insert into public.member_peer_conversations (
    chapter_id, user_low, user_high, created_from_request)
  values (
    request_row.chapter_id,
    least(request_row.requester_id, request_row.recipient_id),
    greatest(request_row.requester_id, request_row.recipient_id),
    request_row.id)
  on conflict (user_low, user_high) do update
    set updated_at = public.member_peer_conversations.updated_at
  returning id into conversation_id_value;

  update public.member_peer_contact_requests
  set status = 'accepted', responded_at = now()
  where id = request_row.id;

  peer_label := private.member_peer_profile_label(request_row.requester_id);
  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'conversation', pg_catalog.jsonb_build_object(
      'id', conversation_id_value,
      'peerName', peer_label ->> 'name',
      'peerInitials', peer_label ->> 'initials',
      'updatedAt', now(),
      'messages', '[]'::jsonb));
end;
$$;

create function public.send_reward_peer_message(p_conversation_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), E' \t\n\r\f\v');
  conversation_row public.member_peer_conversations%rowtype;
  message_id_value uuid;
  created_at_value timestamptz;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('peer-message-sender:' || caller::text, 0));

  select c.* into conversation_row
  from public.member_peer_conversations c
  where c.id = p_conversation_id
    and (c.user_low = caller or c.user_high = caller)
  for update;

  if not found or (select pg_catalog.count(*) from public.member_peer_messages m
      where m.sender_id = caller and m.created_at >= now() - interval '5 minutes') >= 20 then
    raise exception 'message unavailable' using errcode = '22023';
  end if;

  -- An accepted conversation is durable. Revoking im-anyone blocks new
  -- requests immediately but does not withdraw consent already exchanged.
  insert into public.member_peer_messages (conversation_id, sender_id, body)
  values (conversation_row.id, caller, clean_body)
  returning id, created_at into message_id_value, created_at_value;

  update public.member_peer_conversations
  set updated_at = created_at_value
  where id = conversation_row.id;

  return pg_catalog.jsonb_build_object(
    'message', pg_catalog.jsonb_build_object(
      'id', message_id_value,
      'sentByMe', true,
      'body', clean_body,
      'createdAt', created_at_value));
end;
$$;

revoke all on function public.list_reward_peer_contact() from public, anon;
revoke all on function public.request_reward_peer_contact(text) from public, anon;
revoke all on function public.respond_reward_peer_contact(uuid, boolean) from public, anon;
revoke all on function public.send_reward_peer_message(uuid, text) from public, anon;
grant execute on function public.list_reward_peer_contact() to authenticated;
grant execute on function public.request_reward_peer_contact(text) to authenticated;
grant execute on function public.respond_reward_peer_contact(uuid, boolean) to authenticated;
grant execute on function public.send_reward_peer_message(uuid, text) to authenticated;

-- `experimental-access` is also a real effect, not a future-looking label.
-- Content is row-backed and bilingual; the first active pilot is a local
-- meeting-prep worksheet whose answers never leave the browser.
create table public.member_experimental_content (
  id text primary key check (id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title_en text not null check (pg_catalog.char_length(pg_catalog.btrim(title_en)) between 3 and 120),
  title_es text not null check (pg_catalog.char_length(pg_catalog.btrim(title_es)) between 3 and 120),
  summary_en text not null check (pg_catalog.char_length(pg_catalog.btrim(summary_en)) between 10 and 500),
  summary_es text not null check (pg_catalog.char_length(pg_catalog.btrim(summary_es)) between 10 and 500),
  prompts_en jsonb not null check (pg_catalog.jsonb_typeof(prompts_en) = 'array' and pg_catalog.length(prompts_en::text) <= 4000),
  prompts_es jsonb not null check (pg_catalog.jsonb_typeof(prompts_es) = 'array' and pg_catalog.length(prompts_es::text) <= 4000),
  active boolean not null default true,
  sort integer not null default 100 check (sort between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.member_experimental_content
  (id, title_en, title_es, summary_en, summary_es, prompts_en, prompts_es, sort)
values (
  'meeting-prep',
  'Meeting prep builder',
  'Preparación de reuniones',
  'Turn three workplace observations into a member-led meeting plan. Answers stay on this device.',
  'Convierte tres observaciones del trabajo en un plan de reunión dirigido por miembros. Las respuestas quedan en este dispositivo.',
  '["What changed at work?","Who is affected?","What outcome should members ask for?"]'::jsonb,
  '["¿Qué cambió en el trabajo?","¿A quién afecta?","¿Qué resultado deben pedir los miembros?"]'::jsonb,
  10);

alter table public.member_experimental_content enable row level security;
revoke all on public.member_experimental_content from public, anon, authenticated;

create function public.list_reward_experimental_content(p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  wanted_locale text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.member_reward_effect_enabled(caller, 'experimental-access') then
    return '[]'::jsonb;
  end if;

  select case
    when p_locale = 'es' or (p_locale is null and p.language = 'es') then 'es'
    else 'en'
  end into wanted_locale
  from public.member_profiles p
  where p.id = caller;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', content.id,
      'title', case when wanted_locale = 'es' then content.title_es else content.title_en end,
      'summary', case when wanted_locale = 'es' then content.summary_es else content.summary_en end,
      'prompts', case when wanted_locale = 'es' then content.prompts_es else content.prompts_en end
    ) order by content.sort, content.id)
    from (
      select c.*
      from public.member_experimental_content c
      where c.active
      order by c.sort, c.id
      limit 8
    ) content
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_reward_experimental_content(text) from public, anon;
grant execute on function public.list_reward_experimental_content(text) to authenticated;

-- HUB-02 promises a complete caller-owned export. Preserve the established
-- exporter as a private implementation and add the peer-contact section in a
-- narrow wrapper. The implementation remains the only place that writes the
-- pseudonymous `export_generated` audit row, so one RPC still creates exactly
-- one audit event.
alter function public.get_member_data_export()
  rename to member_data_export_without_peer_contact;
alter function public.member_data_export_without_peer_contact()
  set schema private;
revoke all on function private.member_data_export_without_peer_contact()
  from public, anon, authenticated, service_role;

create function public.get_member_data_export()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  exported jsonb;
  peer_contact jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- This private implementation performs the single lifecycle audit write.
  exported := private.member_data_export_without_peer_contact();

  select pg_catalog.jsonb_build_object(
    'requests', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', request.id,
        'direction', case when request.requester_id = caller then 'sent' else 'received' end,
        'chapterId', request.chapter_id,
        'status', request.status,
        'createdAt', request.created_at,
        'respondedAt', request.responded_at,
        'expiresAt', request.expires_at
      ) order by request.created_at, request.id)
      from (
        select r.id, r.requester_id, r.chapter_id, r.status,
          r.created_at, r.responded_at, r.expires_at
        from public.member_peer_contact_requests r
        where r.requester_id = caller or r.recipient_id = caller
        order by r.created_at desc, r.id desc
        limit 100
      ) request
    ), '[]'::jsonb),
    'conversations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', conversation.id,
        'chapterId', conversation.chapter_id,
        'createdAt', conversation.created_at,
        'updatedAt', conversation.updated_at,
        'messages', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', message.id,
            'sentByMe', message.sender_id = caller,
            'body', message.body,
            'readAt', message.read_at,
            'createdAt', message.created_at
          ) order by message.created_at, message.id)
          from (
            select m.id, m.sender_id, m.body, m.read_at, m.created_at
            from public.member_peer_messages m
            where m.conversation_id = conversation.id
            order by m.created_at desc, m.id desc
            limit 100
          ) message
        ), '[]'::jsonb)
      ) order by conversation.created_at, conversation.id)
      from (
        select c.id, c.chapter_id, c.created_at, c.updated_at
        from public.member_peer_conversations c
        where c.user_low = caller or c.user_high = caller
        order by c.updated_at desc, c.id desc
        limit 20
      ) conversation
    ), '[]'::jsonb)
  ) into peer_contact;

  -- No peer id, profile label, email/address, share code, or digest is added.
  -- Direction is expressed only relative to the authenticated caller.
  return pg_catalog.jsonb_set(exported, '{peerContact}', peer_contact, true);
end;
$$;

revoke all on function public.get_member_data_export() from public, anon;
grant execute on function public.get_member_data_export() to authenticated;
