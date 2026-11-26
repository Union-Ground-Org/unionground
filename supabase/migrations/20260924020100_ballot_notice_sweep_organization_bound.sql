-- SEC-UG-ORGANIZATION-WIDE-BALLOT-NOTICE-SWEEP-SELECTS-RECIPIENTS-WITHOUT-A-TENANT-BOUNDARY-20260921
--
-- private.ballot_notice_sweep (20260809020000, case-graph wrapped by
-- 20260907151000) treated a ballot with chapter_id null as "everyone": its
-- opened, closing and results loops selected every member_profiles row in
-- every organization. A cron sweep has no JWT, so the ballot's organization
-- must come from the ballot row itself: the chapter's organization for a
-- chapter ballot, and the creating staff member's current organization for
-- an organization-wide ballot (save_vote_campaign_draft only accepts union
-- scope from an admin/vp of private.current_member_organization(), and the
-- same derivation is used here). A ballot whose organization cannot be
-- derived notifies nobody.
--
-- private.ballot_notice_recipients is the one recipient set for all three
-- notices. Every notice goes through private.notify_member, which writes the
-- in-app row that the email and push delivery queue fans out from, so in-app,
-- email and push share this boundary. Recipients must hold an active
-- organization membership in the ballot organization and a profile chapter
-- inside it; chapter ballots then narrow to that chapter.
--
-- The sweep keeps Main's installed body (the 20260907151000 case-graph lock
-- preamble first, then the three stamp-and-notify loops); only the recipient
-- SELECTs change.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.ballot_notice_recipients(p_chapter_id text, p_created_by uuid)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = ''
as $function$
  with ballot_organization as (
    select c.organization_id
    from public.chapters c
    where p_chapter_id is not null
      and c.id = p_chapter_id
      and c.organization_id is not null
    union all
    select c.organization_id
    from public.member_profiles creator
    join public.chapters c on c.id = creator.chapter_id
    join public.organization_memberships creator_membership
      on creator_membership.user_id = creator.id
     and creator_membership.organization_id = c.organization_id
     and creator_membership.status = 'active'
    where p_chapter_id is null
      and creator.id = p_created_by
      and c.organization_id is not null
  )
  select recipient.id
  from ballot_organization bo
  join public.organization_memberships recipient_membership
    on recipient_membership.organization_id = bo.organization_id
   and recipient_membership.status = 'active'
  join public.member_profiles recipient on recipient.id = recipient_membership.user_id
  join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
  where recipient_chapter.organization_id = bo.organization_id
    and (p_chapter_id is null or recipient.chapter_id = p_chapter_id)
$function$;

revoke all on function private.ballot_notice_recipients(text, uuid)
  from public, anon, authenticated, service_role;

comment on function private.ballot_notice_recipients(text, uuid) is
  'Tenant-bound recipient set for private.ballot_notice_sweep. Organization = the ballot chapter''s organization, or for an organization-wide ballot the creator''s current organization; an underivable organization yields no rows. Recipients hold an active organization membership and a profile chapter in that organization, narrowed to the ballot chapter when set. No client execute.';

create or replace function private.ballot_notice_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Preserve the installed 20260907151000 case-graph lock preamble.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  b record;
  m record;
begin
  -- Ballot became open (new since the last tick; existing ballots were
  -- pre-stamped at migration time).
  for b in
    select bl.id, bl.chapter_id, bl.created_by from public.member_ballots bl
    where bl.active
      and bl.closes_at > now()
      and bl.opened_notice_sent_at is null
    for update skip locked
  loop
    update public.member_ballots set opened_notice_sent_at = now() where id = b.id;
    for m in
      select r.user_id from private.ballot_notice_recipients(b.chapter_id, b.created_by) r
    loop
      perform private.notify_member(m.user_id, 'vote.opened', '{}'::jsonb, 'votes');
    end loop;
  end loop;

  -- Closes within a day: remind eligible members who have not voted yet.
  for b in
    select bl.id, bl.chapter_id, bl.created_by from public.member_ballots bl
    where bl.active
      and bl.closing_notice_sent_at is null
      and bl.closes_at > now()
      and bl.closes_at <= now() + interval '24 hours'
    for update skip locked
  loop
    update public.member_ballots set closing_notice_sent_at = now() where id = b.id;
    for m in
      select r.user_id from private.ballot_notice_recipients(b.chapter_id, b.created_by) r
      where not exists (
        select 1 from public.member_ballot_receipts rc
        where rc.ballot_id = b.id and rc.user_id = r.user_id
      )
    loop
      perform private.notify_member(m.user_id, 'vote.closing', '{}'::jsonb, 'votes');
    end loop;
  end loop;

  -- Results publish the moment the tally gate opens (get_ballot_tally:
  -- inactive OR closes_at passed). Historic ballots were pre-stamped at
  -- migration time, so this only ever fires for a close that happened since.
  for b in
    select bl.id, bl.chapter_id, bl.created_by from public.member_ballots bl
    where bl.results_notice_sent_at is null
      and (not bl.active or bl.closes_at <= now())
    for update skip locked
  loop
    update public.member_ballots set results_notice_sent_at = now() where id = b.id;
    for m in
      select r.user_id from private.ballot_notice_recipients(b.chapter_id, b.created_by) r
    loop
      perform private.notify_member(m.user_id, 'vote.results', '{}'::jsonb, 'votes');
    end loop;
  end loop;
end;
end;
$function$;

revoke all on function private.ballot_notice_sweep() from public, anon, authenticated, service_role;

comment on function private.ballot_notice_sweep() is
  'UB-SET-01 votes producer: opened / closing-within-24h / results sweeps. Every notice goes to private.ballot_notice_recipients, which bounds recipients to the ballot organization before any chapter targeting. Closing reminder skips receipt holders. Never touches member_ballot_choices.';

commit;
