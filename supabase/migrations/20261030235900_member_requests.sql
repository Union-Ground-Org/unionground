-- REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030 (#6634,
-- split from #6561 by a project decision of October 30, 2026; Oct 29-30 role-play
-- findings 26 and 38)
--
-- A person whose only inviter was a Steward or a Member could not be brought
-- in, and a member's request for an elevated role arrived only as a plain
-- Steward-desk message. Ruling (least privilege, no new trust boundary):
--   * a Steward or Member may SUGGEST an invitation (name, address, note); it
--     lands with the people who may invite into that chapter (its admins, the
--     organization admins, and its President) as a request with Approve and
--     Decline; the suggester sees its state; nothing is sent until approved;
--   * a member's request for an elevated role uses the same request surface;
--     it lands with the people who may grant that role (organization admins
--     and the chapter's admins), with a notification.
--
-- public.member_requests holds both kinds. The table has no client grant;
-- these definers are its only readers and writers:
--   * submit_member_request: the signed-in member of the selected chapter,
--     bounded (10 pending, 10 per day). A suggestion never asks whether the
--     address has an account, so the answer reveals nothing about addresses.
--   * list_my_member_requests: the requester's own requests and their state.
--   * list_member_requests: the rows the caller may decide, keyset-paged.
--   * decide_member_request: Approve or Decline, re-checking the caller's
--     authority for that row. Approving an access request grants the role
--     through public.set_member_chapter_role, which checks the caller again.
--     Declining a suggestion whose address already has an open invitation in
--     that chapter is refused: that invitation stands until it is revoked.
--   * approve_member_request_invitation: approving a suggestion. The existing
--     invitation route (/api/admin-invitations) calls it with the request ID
--     in place of public.create_member_invitation, so the invitation is
--     created by that function (its authority, limits and no-enumeration
--     answers) in the same transaction that locks the pending request and
--     records the approval. A request someone already decided creates no
--     invitation; a refused invitation leaves the request pending. The route
--     then delivers the email exactly as for any invitation.

begin;

create table public.member_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  kind text not null,
  requester_user_id uuid not null references auth.users(id) on delete cascade,
  invitee_name text,
  invitee_email text,
  requested_role text,
  note text,
  status text not null default 'pending',
  created_at timestamptz not null default pg_catalog.now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  constraint member_requests_kind_check
    check (kind in ('invitation_suggestion', 'access_request')),
  constraint member_requests_status_check
    check (status in ('pending', 'approved', 'declined')),
  constraint member_requests_shape
    check ((kind = 'invitation_suggestion'
            and invitee_name is not null and invitee_email is not null and requested_role is null)
        or (kind = 'access_request'
            and invitee_name is null and invitee_email is null
            and requested_role in ('steward', 'coordinator', 'advisor'))),
  constraint member_requests_invitee_name_bounded
    check (invitee_name is null or (pg_catalog.char_length(invitee_name) between 2 and 120
      and invitee_name !~ '[[:cntrl:]]')),
  constraint member_requests_invitee_email_shape
    check (invitee_email is null or (invitee_email = pg_catalog.lower(pg_catalog.btrim(invitee_email))
      and pg_catalog.char_length(invitee_email) between 3 and 254
      and invitee_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  constraint member_requests_note_bounded
    check (note is null or (pg_catalog.char_length(note) between 1 and 500
      and note !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')),
  constraint member_requests_decision_shape
    check ((status = 'pending') = (decided_at is null))
);

create unique index member_requests_one_pending_suggestion_idx
  on public.member_requests (requester_user_id, chapter_id, invitee_email)
  where status = 'pending' and kind = 'invitation_suggestion';
create unique index member_requests_one_pending_access_idx
  on public.member_requests (requester_user_id, chapter_id, requested_role)
  where status = 'pending' and kind = 'access_request';
create index member_requests_organization_idx
  on public.member_requests (organization_id, status, created_at desc, id desc);
create index member_requests_requester_idx
  on public.member_requests (requester_user_id, created_at desc, id desc);

alter table public.member_requests enable row level security;

create policy mfa_assurance on public.member_requests
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy member_requests_select_own on public.member_requests
  for select to authenticated
  using ((select auth.uid()) = requester_user_id);

comment on policy mfa_assurance on public.member_requests is
  'Restrictive MFA floor every RLS table carries.';
comment on policy member_requests_select_own on public.member_requests is
  'Self-only read of a requester''s own requests. Defense in depth: the table has no client grant; the member request RPCs are the only readers and writers.';

revoke all on public.member_requests from public, anon, authenticated, service_role;

comment on table public.member_requests is
  'REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030. A member''s suggestion to invite someone, or request for an elevated chapter role, decided by the people who may invite into or grant roles in that chapter. No client grant.';

create trigger a00_case_graph_lock before insert or update or delete on public.member_requests
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_requests
for each row execute function private.lock_case_graph_row_keys('{decided_by},{requester_user_id}', '');

-- May the caller decide a request of this kind in this chapter? A suggestion:
-- whoever may invite into the chapter (its admin or an organization admin, or
-- its President). An access request: whoever may grant the role
-- (an organization admin, or the chapter's admin while that chapter is
-- selected, which is what public.set_member_chapter_role accepts).
create function private.member_request_decidable(p_kind text, p_organization_id uuid, p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case p_kind
    when 'invitation_suggestion' then
      private.member_invitation_chapter_administrable(p_chapter_id)
      or private.member_invitation_chapter_presided(p_chapter_id)
    when 'access_request' then
      private.has_organization_role(p_organization_id, array['admin'])
      or (p_chapter_id = private.current_member_chapter()
          and private.member_has_chapter_role(p_chapter_id, array['admin']))
    else false
  end;
$function$;

revoke all on function private.member_request_decidable(text, uuid, text)
  from public, anon, authenticated, service_role;

-- Who hears about a new request: the organization's admins and the chapter's
-- admins, plus, for a suggestion, the organization's and the chapter's
-- Presidents. Active memberships only.
create function private.member_request_recipients(p_kind text, p_organization_id uuid, p_chapter_id text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select grant_row.user_id
  from public.organization_role_grants grant_row
  join public.organization_memberships membership
    on membership.organization_id = grant_row.organization_id
   and membership.user_id = grant_row.user_id
   and membership.status = 'active'
  where grant_row.organization_id = p_organization_id
    and (grant_row.role = 'admin' or (p_kind = 'invitation_suggestion' and grant_row.role = 'vp'))
  union
  select role_row.user_id
  from public.member_role_chapters role_row
  join public.member_chapter_memberships chapter_membership
    on chapter_membership.user_id = role_row.user_id
   and chapter_membership.chapter_id = role_row.chapter_id
   and chapter_membership.status = 'active'
  join public.organization_memberships membership
    on membership.organization_id = p_organization_id
   and membership.user_id = role_row.user_id
   and membership.status = 'active'
  where role_row.chapter_id = p_chapter_id
    and (role_row.role = 'admin' or (p_kind = 'invitation_suggestion' and role_row.role = 'vp'));
$function$;

revoke all on function private.member_request_recipients(text, uuid, text)
  from public, anon, authenticated, service_role;

create function private.member_request_json(p_row public.member_requests)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'kind', p_row.kind,
    'chapterId', p_row.chapter_id,
    'inviteeName', p_row.invitee_name,
    'inviteeEmail', p_row.invitee_email,
    'requestedRole', p_row.requested_role,
    'note', p_row.note,
    'status', p_row.status,
    'createdAt', p_row.created_at,
    'decidedAt', p_row.decided_at
  );
$function$;

revoke all on function private.member_request_json(public.member_requests)
  from public, anon, authenticated, service_role;

create function public.submit_member_request(
  p_kind text,
  p_invitee_name text default null,
  p_invitee_email text default null,
  p_requested_role text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  chapter text := private.current_member_chapter();
  clean_kind text := pg_catalog.btrim(coalesce(p_kind, ''));
  clean_name text := nullif(pg_catalog.btrim(coalesce(p_invitee_name, '')), '');
  clean_email text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_invitee_email, ''))), '');
  clean_role text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_requested_role, ''))), '');
  clean_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  saved public.member_requests%rowtype;
  recipient uuid;
  chapter_name text;
  requester_name text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if org is null or chapter is null or not exists (
    select 1
    from public.chapters c
    join public.organization_memberships om
      on om.organization_id = c.organization_id and om.user_id = caller and om.status = 'active'
    join public.member_chapter_memberships cm
      on cm.chapter_id = c.id and cm.user_id = caller and cm.status = 'active'
    where c.id = chapter and c.organization_id = org
  ) then
    raise exception 'active membership required' using errcode = '42501';
  end if;
  if clean_kind not in ('invitation_suggestion', 'access_request') then
    raise exception 'unknown request kind' using errcode = '22023';
  end if;
  if clean_note is not null and (pg_catalog.char_length(clean_note) > 500
     or clean_note ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]') then
    raise exception 'invalid note' using errcode = '22023';
  end if;
  if clean_kind = 'invitation_suggestion' then
    if clean_name is null or pg_catalog.char_length(clean_name) not between 2 and 120 or clean_name ~ '[[:cntrl:]]' then
      raise exception 'invalid name' using errcode = '22023';
    end if;
    if clean_email is null or pg_catalog.char_length(clean_email) not between 3 and 254
       or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'invalid email' using errcode = '22023';
    end if;
    clean_role := null;
  else
    if clean_role is null or clean_role not in ('steward', 'coordinator', 'advisor') then
      raise exception 'unknown role' using errcode = '22023';
    end if;
    if exists (
      select 1 from public.member_role_chapters rc
      where rc.user_id = caller and rc.chapter_id = chapter and rc.role = clean_role
    ) then
      raise exception 'role already held' using errcode = '22023';
    end if;
    clean_name := null;
    clean_email := null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-request:' || caller::text, 509));
  -- The same open request from the same person is one request, before any
  -- limit: a retried submission is answered the same way.
  if exists (
    select 1 from public.member_requests r
    where r.requester_user_id = caller and r.chapter_id = chapter and r.kind = clean_kind
      and r.status = 'pending'
      and r.invitee_email is not distinct from clean_email
      and r.requested_role is not distinct from clean_role
  ) then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  if (select pg_catalog.count(*) from public.member_requests r
      where r.requester_user_id = caller and r.status = 'pending') >= 10
     or (select pg_catalog.count(*) from public.member_requests r
         where r.requester_user_id = caller and r.created_at > pg_catalog.now() - interval '24 hours') >= 10 then
    raise exception 'request limit reached' using errcode = '54000';
  end if;

  insert into public.member_requests (
    organization_id, chapter_id, kind, requester_user_id, invitee_name, invitee_email, requested_role, note
  ) values (
    org, chapter, clean_kind, caller, clean_name, clean_email, clean_role, clean_note
  )
  on conflict do nothing
  returning * into saved;

  -- The same pending suggestion or request from the same person is one
  -- request: the answer is the same either way.
  if saved.id is null then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;

  select c.name into chapter_name from public.chapters c where c.id = chapter;
  select coalesce(p.full_name, 'A member') into requester_name from public.member_profiles p where p.id = caller;
  for recipient in select * from private.member_request_recipients(clean_kind, org, chapter) loop
    if recipient <> caller then
      perform private.notify_member(recipient,
        case clean_kind when 'invitation_suggestion' then 'requests.invitation_suggested' else 'requests.access_requested' end,
        pg_catalog.jsonb_build_object('member', coalesce(requester_name, 'A member'), 'chapter', coalesce(chapter_name, chapter)),
        'general');
    end if;
  end loop;

  return pg_catalog.jsonb_build_object('accepted', true, 'request', private.member_request_json(saved));
end;
end;
$function$;

comment on function public.submit_member_request(text, text, text, text, text) is
  'REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030: a member of the selected chapter suggests an invitation or requests a chapter role; bounded; the deciders are notified. Never reveals whether an address has an account.';

revoke all on function public.submit_member_request(text, text, text, text, text) from public, anon;
grant execute on function public.submit_member_request(text, text, text, text, text) to authenticated;

create function public.list_my_member_requests(
  p_limit integer default 20,
  p_before_created timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  items jsonb;
  more boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if (p_before_created is null) <> (p_before_id is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(private.member_request_json(r) || pg_catalog.jsonb_build_object('chapterName', c.name)
           order by r.created_at desc, r.id desc), '[]'::jsonb)
    into items
  from (
    select * from public.member_requests r
    where r.requester_user_id = caller
      and (p_before_created is null or (r.created_at, r.id) < (p_before_created, p_before_id))
    order by r.created_at desc, r.id desc
    limit page_limit
  ) r
  left join public.chapters c on c.id = r.chapter_id;

  select exists (
    select 1 from public.member_requests r
    where r.requester_user_id = caller
      and (p_before_created is null or (r.created_at, r.id) < (p_before_created, p_before_id))
    order by r.created_at desc, r.id desc
    offset page_limit
  ) into more;

  return pg_catalog.jsonb_build_object('items', items, 'hasMore', more);
end;
$function$;

comment on function public.list_my_member_requests(integer, timestamptz, uuid) is
  'REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030: the caller''s own suggestions and requests with their state, newest first, keyset-paged.';

revoke all on function public.list_my_member_requests(integer, timestamptz, uuid) from public, anon;
grant execute on function public.list_my_member_requests(integer, timestamptz, uuid) to authenticated;

create function public.list_member_requests(
  p_status text default 'pending',
  p_limit integer default 20,
  p_before_created timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  clean_status text := coalesce(nullif(pg_catalog.btrim(coalesce(p_status, '')), ''), 'pending');
  page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  items jsonb;
  more boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if clean_status not in ('pending', 'decided') then
    raise exception 'unknown status filter' using errcode = '22023';
  end if;
  if (p_before_created is null) <> (p_before_id is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  if org is null then
    return pg_catalog.jsonb_build_object('items', '[]'::jsonb, 'hasMore', false);
  end if;

  with visible as (
    select r.*
    from public.member_requests r
    where r.organization_id = org
      and ((clean_status = 'pending' and r.status = 'pending')
        or (clean_status = 'decided' and r.status <> 'pending'))
      and (p_before_created is null or (r.created_at, r.id) < (p_before_created, p_before_id))
      and private.member_request_decidable(r.kind, r.organization_id, r.chapter_id)
    order by r.created_at desc, r.id desc
    limit page_limit + 1
  )
  select
    coalesce(pg_catalog.jsonb_agg(row_data order by created_at desc, id desc)
      filter (where position <= page_limit), '[]'::jsonb),
    pg_catalog.count(*) > page_limit
    into items, more
  from (
    select v.created_at, v.id,
      pg_catalog.row_number() over (order by v.created_at desc, v.id desc) as position,
      private.member_request_json(v) || pg_catalog.jsonb_build_object(
        'chapterName', c.name,
        'requesterName', coalesce(requester.full_name, 'Former member')
      ) as row_data
    from visible v
    left join public.chapters c on c.id = v.chapter_id
    left join public.member_profiles requester on requester.id = v.requester_user_id
  ) ranked;

  return pg_catalog.jsonb_build_object('items', items, 'hasMore', coalesce(more, false));
end;
end;
$function$;

comment on function public.list_member_requests(text, integer, timestamptz, uuid) is
  'REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030: the requests in the selected organization the caller may decide (pending or decided), newest first, keyset-paged.';

revoke all on function public.list_member_requests(text, integer, timestamptz, uuid) from public, anon;
grant execute on function public.list_member_requests(text, integer, timestamptz, uuid) to authenticated;

create function public.decide_member_request(p_request_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  clean_decision text := pg_catalog.btrim(coalesce(p_decision, ''));
  found_row public.member_requests%rowtype;
  saved public.member_requests%rowtype;
  chapter_name text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if clean_decision not in ('approved', 'declined') then
    raise exception 'invalid decision' using errcode = '22023';
  end if;

  select * into found_row
  from public.member_requests r
  where r.id = p_request_id and r.organization_id = org and r.status = 'pending'
  for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if not private.member_request_decidable(found_row.kind, found_row.organization_id, found_row.chapter_id) then
    raise exception 'not permitted to decide this request' using errcode = '42501';
  end if;

  if found_row.kind = 'invitation_suggestion' then
    -- Approving a suggestion creates its invitation in the same transaction:
    -- public.approve_member_request_invitation, through the invitation route.
    if clean_decision = 'approved' then
      raise exception 'approve through the invitation route' using errcode = '22023';
    end if;
    -- A suggestion whose address already has an open invitation in that
    -- chapter (from the invitation page) cannot be declined: that invitation
    -- stands until it is revoked there. An invitation accepted in the past is
    -- history, not an open invitation, and blocks nothing.
    if exists (
      select 1 from public.member_invitations i
      where i.normalized_email = found_row.invitee_email and i.chapter_id = found_row.chapter_id
        and (i.status = 'accepting' or (i.status = 'pending' and i.expires_at > pg_catalog.now()))
    ) then
      raise exception 'invitation already sent' using errcode = '55000';
    end if;
  end if;

  -- An approved access request grants the role through the existing writer,
  -- which checks the caller's authority and the member's membership again.
  if clean_decision = 'approved' then
    perform public.set_member_chapter_role(found_row.requester_user_id, found_row.chapter_id, found_row.requested_role, true);
  end if;

  update public.member_requests r
  set status = clean_decision, decided_at = pg_catalog.now(), decided_by = caller
  where r.id = found_row.id
  returning * into saved;

  select c.name into chapter_name from public.chapters c where c.id = saved.chapter_id;
  perform private.notify_member(saved.requester_user_id,
    'requests.' || case saved.kind when 'invitation_suggestion' then 'suggestion' else 'access' end || '.' || clean_decision,
    pg_catalog.jsonb_build_object('name', coalesce(saved.invitee_name, ''), 'chapter', coalesce(chapter_name, saved.chapter_id)),
    'general');

  return private.member_request_json(saved);
end;
end;
$function$;

comment on function public.decide_member_request(uuid, text) is
  'REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030: Approve or Decline a pending role request, or Decline a pending suggestion, that the caller may decide; an approved role request grants through public.set_member_chapter_role; a suggestion whose address has an open invitation cannot be declined; the requester is notified.';

revoke all on function public.decide_member_request(uuid, text) from public, anon;
grant execute on function public.decide_member_request(uuid, text) to authenticated;

create function public.approve_member_request_invitation(
  p_request_id uuid,
  p_email text,
  p_locale text,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  found_row public.member_requests%rowtype;
  created jsonb;
  chapter_name text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into found_row
  from public.member_requests r
  where r.id = p_request_id and r.organization_id = org
    and r.kind = 'invitation_suggestion' and r.status = 'pending'
  for update;
  -- 22023 reaches the route as request-unavailable: nothing was created.
  if not found then
    raise exception 'request not found' using errcode = '22023';
  end if;
  if not private.member_request_decidable(found_row.kind, found_row.organization_id, found_row.chapter_id) then
    raise exception 'not permitted to decide this request' using errcode = '42501';
  end if;
  -- The route checks the address it will send to before calling; it must be
  -- this request's address.
  if pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, ''))) <> found_row.invitee_email then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- The invitation itself, with every check, limit and answer of the
  -- invitation page. Any refusal raises, and the request stays pending.
  created := public.create_member_invitation(found_row.invitee_email, found_row.invitee_name,
    found_row.chapter_id, null, p_locale, p_token_hash);
  update public.member_requests r
  set status = 'approved', decided_at = pg_catalog.now(), decided_by = caller
  where r.id = found_row.id;

  select c.name into chapter_name from public.chapters c where c.id = found_row.chapter_id;
  perform private.notify_member(found_row.requester_user_id, 'requests.suggestion.approved',
    pg_catalog.jsonb_build_object('name', found_row.invitee_name, 'chapter', coalesce(chapter_name, found_row.chapter_id)),
    'general');
  return created;
end;
end;
$function$;

comment on function public.approve_member_request_invitation(uuid, text, text, text) is
  'REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030: approves a pending invitation suggestion the caller may decide by creating its invitation through public.create_member_invitation in the same transaction; called by /api/admin-invitations, which delivers the email.';

revoke all on function public.approve_member_request_invitation(uuid, text, text, text) from public, anon;
grant execute on function public.approve_member_request_invitation(uuid, text, text, text) to authenticated;

insert into private.notification_copy (key, lang, title, body) values
  ('requests.invitation_suggested', 'en', 'Invitation suggested',
   '{member} suggested inviting someone to {chapter}. Approve or decline it under Requests.'),
  ('requests.invitation_suggested', 'es', 'Invitación sugerida',
   '{member} sugirió invitar a alguien a {chapter}. Apruébala o recházala en Solicitudes.'),
  ('requests.access_requested', 'en', 'Role requested',
   '{member} asked for a staff role in {chapter}. Approve or decline it under Requests.'),
  ('requests.access_requested', 'es', 'Rol solicitado',
   '{member} pidió un rol de personal en {chapter}. Apruébalo o recházalo en Solicitudes.'),
  ('requests.suggestion.approved', 'en', 'Invitation suggestion approved',
   'Your suggestion to invite {name} to {chapter} was approved, and the invitation is on its way.'),
  ('requests.suggestion.approved', 'es', 'Sugerencia de invitación aprobada',
   'Tu sugerencia de invitar a {name} a {chapter} fue aprobada y la invitación va en camino.'),
  ('requests.suggestion.declined', 'en', 'Invitation suggestion not approved',
   'Your suggestion to invite {name} to {chapter} was not approved.'),
  ('requests.suggestion.declined', 'es', 'Sugerencia de invitación no aprobada',
   'Tu sugerencia de invitar a {name} a {chapter} no fue aprobada.'),
  ('requests.access.approved', 'en', 'Role request approved',
   'Your request for a staff role in {chapter} was approved.'),
  ('requests.access.approved', 'es', 'Solicitud de rol aprobada',
   'Tu solicitud de un rol de personal en {chapter} fue aprobada.'),
  ('requests.access.declined', 'en', 'Role request not approved',
   'Your request for a staff role in {chapter} was not approved.'),
  ('requests.access.declined', 'es', 'Solicitud de rol no aprobada',
   'Tu solicitud de un rol de personal en {chapter} no fue aprobada.')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- Account lifecycle: the requester's rows go with the account; a decider's
-- attribution is set null.
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition, export_inventory_basis,
   exclusion_reason, note, reviewed_at)
values
  ('public', 'member_requests', 'requester_user_id', 'cascade', 'excluded_with_reason', 'auth_user_fk',
   'Organization request record reviewed by the chapter''s deciders; the requester sees its state in the app, and a resulting role grant is in the member''s access history.',
   'A member''s invitation suggestion or chapter role request. Deleted with the requester''s account.', date '2026-10-30'),
  ('public', 'member_requests', 'decided_by', 'not_applicable', 'excluded_with_reason', 'auth_user_fk',
   'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.',
   'Decider who approved or declined the request; set null when that account is deleted.', date '2026-10-30');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'public' and table_name = 'member_requests'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_member_requests_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after member requests: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after member requests';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after member requests';
  end if;
end;
$assert_member_requests_lifecycle$;

notify pgrst, 'reload schema';

commit;
