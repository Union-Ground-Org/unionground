-- Civic member app layer: mailing-address capture with consent, the chapter
-- membership seam, officer participation counts, and the member/officer
-- row-level security for every civic table created so far.
--
-- Ported from civic-data-resolver migrations/006_member_app.sql with these
-- host deviations:
--   * The standalone civic_org_members shim is not created. The "org" is the
--     host chapter (public.chapters.id, text) and the four seam functions are
--     re-implemented against host tables:
--       civic_is_org_member(p_org)    an ACTIVE member_chapter_memberships row
--                                     for the chapter, or the caller's selected
--                                     member_profiles.chapter_id
--       civic_is_org_officer(p_org)   a steward/coordinator/vp/admin hat that
--                                     covers the chapter, resolved through the
--                                     host's tenant-scoped role helpers
--       civic_org_member_ids(p_org)   active memberships plus selected
--                                     profiles in the chapter (service_role)
--       civic_org_display_name(p_org) public.chapters.name (service_role)
--     plus public.civic_my_orgs(), which the apps call instead of reading
--     civic_org_members.
--   * civic_uid() is not created; policies and functions read
--     (select auth.uid()) directly, which is the same JWT subject.
--   * The civic AI ledger (civic_ai_requests, civic_reserve_draft,
--     civic_release_draft) is not ported: civic drafting shares the Compass
--     governance RPCs public.reserve_compass_ai_request and
--     public.release_member_ai_request.
--   * Policies are split per command so no role/action pair carries two
--     permissive policies; functions pin search_path = '' and qualify every
--     relation; every SECURITY DEFINER RPC reachable by authenticated
--     re-states the MFA floor itself.
--   * Trigger functions live in schema private and are not executable by any
--     API role.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- Mailing address + consent. The resolver's work queue:
--   MEMBERS_TABLE=civic_member_addresses  MEMBERS_ID_COLUMN=user_id
--   MEMBERS_ADDRESS_COLUMN=full_address   MEMBERS_STATUS_COLUMN=civic_lookup_status
-- ---------------------------------------------------------------------------
create table public.civic_member_addresses (
  user_id uuid primary key,
  full_name text not null check (length(btrim(full_name)) between 2 and 120),
  line1 text not null check (length(btrim(line1)) between 3 and 120),
  line2 text check (line2 is null or length(line2) <= 120),
  city text not null check (length(btrim(city)) between 2 and 80),
  state text not null check (state ~ '^[A-Z]{2}$'),
  postal_code text not null check (postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  -- One string for the geocoder. Generated, so it can never drift from the parts.
  full_address text generated always as (
    btrim(line1) || case when nullif(btrim(line2), '') is null then '' else ' ' || btrim(line2) end
    || ', ' || btrim(city) || ', ' || state || ' ' || postal_code) stored,
  -- Consent is a precondition of the row existing, not a checkbox beside it.
  consent_version text not null,
  consented_at timestamptz not null default now(),
  civic_lookup_status text not null default 'needs_lookup',
  updated_at timestamptz not null default now()
);

create function private.civic_member_address_changed()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  -- Only a change to where the member lives re-queues the (paid) lookup.
  -- (Compare the parts: a generated column is not computed in a BEFORE trigger.)
  if (new.line1, new.line2, new.city, new.state, new.postal_code)
     is distinct from (old.line1, old.line2, old.city, old.state, old.postal_code) then
    new.civic_lookup_status := 'needs_lookup';
  end if;
  return new;
end;
$function$;
revoke all on function private.civic_member_address_changed() from public, anon, authenticated, service_role;

create trigger civic_member_address_changed
before update on public.civic_member_addresses
for each row execute function private.civic_member_address_changed();

alter table public.civic_member_addresses enable row level security;
create policy mfa_assurance on public.civic_member_addresses
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- Chapter membership seam. Nothing else in the civic schema knows how
-- membership or officer hats are stored.
-- ---------------------------------------------------------------------------
create function public.civic_is_org_member(p_org text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and p_org is not null
    and (select private.mfa_satisfied())
    -- The host tenant rule (private.current_member_organization): a chapter
    -- counts only while its organization is active and the caller's
    -- organization membership is active. A suspended or archived organization
    -- takes its chapters' civic access with it.
    and exists (
      select 1
      from public.chapters chapter
      join public.organizations organization
        on organization.id = chapter.organization_id
       and organization.status = 'active'
      join public.organization_memberships organization_membership
        on organization_membership.organization_id = organization.id
       and organization_membership.user_id = (select auth.uid())
       and organization_membership.status = 'active'
      where chapter.id = p_org
    )
    and (
      -- The host's multi-chapter model: any ACTIVE membership row.
      exists (
        select 1
        from public.member_chapter_memberships membership
        where membership.user_id = (select auth.uid())
          and membership.chapter_id = p_org
          and membership.status = 'active'
      )
      -- The selected chapter projection. public.get_my_chapter_memberships()
      -- inner-joins membership rows, so it does not cover a profile chapter
      -- that has no membership row; keep that chapter reachable here.
      or exists (
        select 1
        from public.member_profiles profile
        where profile.id = (select auth.uid())
          and profile.chapter_id = p_org
      )
    );
$function$;

-- Officer = a steward, coordinator, vp or admin hat covering the chapter. An
-- organization-wide hat covers every chapter of the caller's current
-- organization; a chapter hat covers that chapter. Resolved through the same
-- tenant-scoped helpers as private.staff_visible_chapter_scope, so a hat in
-- one organization never reaches another organization's chapters and the
-- staff MFA policy applies.
create function public.civic_is_org_officer(p_org text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and p_org is not null
    and (select private.mfa_satisfied())
    -- The host tenant rule (private.current_member_organization): a chapter
    -- counts only while its organization is active and the caller's
    -- organization membership is active. A suspended or archived organization
    -- takes its chapters' civic access with it.
    and exists (
      select 1
      from public.chapters chapter
      join public.organizations organization
        on organization.id = chapter.organization_id
       and organization.status = 'active'
      join public.organization_memberships organization_membership
        on organization_membership.organization_id = organization.id
       and organization_membership.user_id = (select auth.uid())
       and organization_membership.status = 'active'
      where chapter.id = p_org
    )
    and exists (
      select 1
      from public.chapters target_chapter
      where target_chapter.id = p_org
        and (
          (
            target_chapter.organization_id is not null
            and target_chapter.organization_id = (select private.current_member_organization())
            and private.has_organization_role(target_chapter.organization_id,
              array['steward', 'coordinator', 'vp', 'admin']::text[])
          )
          or private.member_has_chapter_role(target_chapter.id,
            array['steward', 'coordinator', 'vp', 'admin']::text[])
        )
    );
$function$;

-- Every member of a chapter, for the officer's place counts: the same two
-- sources as civic_is_org_member (active membership rows, and the selected
-- profile chapter), de-duplicated. service_role only.
create function public.civic_org_member_ids(p_org text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  with active_organization as (
    -- The host tenant rule: nobody belongs to a chapter whose organization is
    -- suspended or archived, and a member's organization membership must be active.
    select organization.id
    from public.chapters chapter
    join public.organizations organization
      on organization.id = chapter.organization_id
     and organization.status = 'active'
    where chapter.id = p_org
  )
  select membership.user_id
  from public.member_chapter_memberships membership
  join public.organization_memberships organization_membership
    on organization_membership.user_id = membership.user_id
   and organization_membership.organization_id = (select active_organization.id from active_organization)
   and organization_membership.status = 'active'
  where membership.chapter_id = p_org
    and membership.status = 'active'
  union
  select profile.id
  from public.member_profiles profile
  join public.organization_memberships organization_membership
    on organization_membership.user_id = profile.id
   and organization_membership.organization_id = (select active_organization.id from active_organization)
   and organization_membership.status = 'active'
  where profile.chapter_id = p_org;
$function$;

-- The chapter's name, shown as "entered by ..." to other chapters' officers.
create function public.civic_org_display_name(p_org text)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select chapter.name
  from public.chapters chapter
  where chapter.id = p_org;
$function$;

-- The chapters the caller can act in: every chapter they belong to (each
-- active membership row plus the selected profile chapter; role 'officer'
-- when a hat covers it, else 'member') plus every other chapter an officer
-- hat covers (role 'officer'). The selected chapter sorts first.
create function public.civic_my_orgs()
returns table (org_id text, org_name text, role text)
language sql
stable
security definer
set search_path = ''
as $function$
  with caller as (
    select profile.id as user_id, profile.chapter_id
    from public.member_profiles profile
    where profile.id = (select auth.uid())
      and (select private.mfa_satisfied())
  ), memberships as (
    -- Only chapters whose organization is active and where the caller's
    -- organization membership is active, as the host's tenant rule requires.
    select candidate.chapter_id
    from (
      select membership.chapter_id
      from caller
      join public.member_chapter_memberships membership
        on membership.user_id = caller.user_id
       and membership.status = 'active'
      union
      select caller.chapter_id from caller where caller.chapter_id is not null
    ) candidate
    join public.chapters chapter on chapter.id = candidate.chapter_id
    join public.organizations organization
      on organization.id = chapter.organization_id
     and organization.status = 'active'
    join public.organization_memberships organization_membership
      on organization_membership.organization_id = organization.id
     and organization_membership.user_id = (select caller.user_id from caller)
     and organization_membership.status = 'active'
  ), candidates as (
    select chapter.id, chapter.name,
           (chapter.id in (select memberships.chapter_id from memberships)) as own,
           (chapter.id is not distinct from caller.chapter_id) as selected
    from caller
    join public.chapters chapter
      on chapter.id in (select memberships.chapter_id from memberships)
      or (
        chapter.organization_id is not distinct from (select private.current_member_organization())
        and (
          exists (
            select 1 from public.organization_role_grants organization_role
            where organization_role.user_id = caller.user_id
              and organization_role.role in ('steward', 'coordinator', 'vp', 'admin'))
          or exists (
            select 1 from public.member_role_chapters chapter_role
            where chapter_role.user_id = caller.user_id
              and chapter_role.role in ('steward', 'coordinator', 'vp', 'admin'))
          or exists (
            select 1 from public.member_roles legacy_role
            where legacy_role.user_id = caller.user_id
              and legacy_role.role in ('steward', 'coordinator', 'vp', 'admin'))
        )
      )
  ), resolved as (
    select candidate.id, candidate.name, candidate.own, candidate.selected,
           public.civic_is_org_officer(candidate.id) as officer
    from candidates candidate
  )
  select resolved.id, resolved.name, case when resolved.officer then 'officer' else 'member' end
  from resolved
  where resolved.own or resolved.officer
  order by resolved.selected desc, resolved.own desc, resolved.name, resolved.id;
$function$;

-- Withdrawing consent removes the address and everything derived from it.
-- Sent messages stay: they are the member's own record, not location data.
create function public.civic_withdraw_address()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not (select private.mfa_satisfied()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from public.civic_member_addresses where user_id = caller;
  delete from public.civic_user_districts where user_id = caller;
  delete from public.civic_quarantine where user_id = caller;
  delete from public.civic_user_district_changes where user_id = caller;
end;
$function$;

-- Fingerprints of the campaign's other messages, for the similarity gate.
-- MinHash signatures only: they cannot be turned back into text or members.
-- service_role only (the drafting route).
create function public.civic_campaign_fingerprints(p_campaign_id uuid, p_except_user uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $function$
  select message.body_fingerprint
  from public.civic_member_messages message
  where message.campaign_id = p_campaign_id
    and message.user_id <> p_except_user
    and message.body_fingerprint is not null
  order by message.drafted_at desc
  limit 500;
$function$;

-- Participation counts for officers. SECURITY DEFINER because it must count
-- rows the officer may not read; it returns numbers and nothing else.
create function public.civic_campaign_stats_for_org(p_org text)
returns table (campaign_id uuid, messages_sent bigint, messages_drafted bigint,
               members_participating bigint, officials_contacted bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not (select private.mfa_satisfied()) or not public.civic_is_org_officer(p_org) then
    raise exception 'officers only' using errcode = '42501';
  end if;
  return query
    select stats.campaign_id, stats.messages_sent, stats.messages_drafted,
           stats.members_participating, stats.officials_contacted
    from public.civic_campaign_stats stats
    where stats.org_id = p_org;
end;
$function$;

-- A member's letter is their own record, so deleting a campaign may never
-- take letters with it (the campaign_id foreign key cascades). Once any
-- letter exists the delete is refused with 23503 (PostgREST 409) and the
-- officer closes the campaign instead (status 'closed'). SECURITY DEFINER
-- because the officer cannot see members' letters; it reads existence only,
-- through the (campaign_id, user_id, official_key) unique index.
create function private.civic_campaign_keep_letters()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (select 1 from public.civic_member_messages message where message.campaign_id = old.id) then
    raise exception 'civic_campaign_has_messages: this campaign has member letters; close it instead of deleting it'
      using errcode = '23503',
            detail = 'civic_campaign_has_messages',
            hint = 'Set the campaign status to closed. Members keep their letters.';
  end if;
  return old;
end;
$function$;
revoke all on function private.civic_campaign_keep_letters() from public, anon, authenticated, service_role;

create trigger civic_campaign_keep_letters
before delete on public.civic_campaigns
for each row execute function private.civic_campaign_keep_letters();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- Own rows only. The address is writable by its owner; location results are
-- written by the worker and merely readable.
create policy civic_member_addresses_own on public.civic_member_addresses
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy civic_user_districts_read_own on public.civic_user_districts
  for select to authenticated using (user_id = (select auth.uid()));
create policy civic_quarantine_read_own on public.civic_quarantine
  for select to authenticated using (user_id = (select auth.uid()));
create policy civic_user_district_changes_read_own on public.civic_user_district_changes
  for select to authenticated using (user_id = (select auth.uid()));

-- Campaigns: members of the chapter read what has been published to them;
-- officers of that chapter do everything.
create policy civic_campaigns_read on public.civic_campaigns
  for select to authenticated
  using ((status <> 'draft' and public.civic_is_org_member(org_id)) or public.civic_is_org_officer(org_id));
create policy civic_campaigns_officer_insert on public.civic_campaigns
  for insert to authenticated
  with check (public.civic_is_org_officer(org_id));
create policy civic_campaigns_officer_update on public.civic_campaigns
  for update to authenticated
  using (public.civic_is_org_officer(org_id))
  with check (public.civic_is_org_officer(org_id));
create policy civic_campaigns_officer_delete on public.civic_campaigns
  for delete to authenticated
  using (public.civic_is_org_officer(org_id));

-- A member's letter is their own speech: theirs to read and write, nobody
-- else's, officers included. New messages only into an ACTIVE campaign of a
-- chapter the member belongs to, and only to one of the member's own
-- resolved officials whose office the campaign targets (any office when
-- target_offices is empty). The official lookup is the member's own
-- civic_member_officials_keyed rows (user_id-keyed, security_invoker), so
-- it stays on the civic_user_districts primary key.
create policy civic_member_messages_read_own on public.civic_member_messages
  for select to authenticated using (user_id = (select auth.uid()));
create policy civic_member_messages_insert_own on public.civic_member_messages
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.civic_campaigns campaign
      join public.civic_member_officials_keyed official
        on official.user_id = (select auth.uid())
       and official.official_key = civic_member_messages.official_key
      where campaign.id = civic_member_messages.campaign_id
        and campaign.status = 'active'
        and public.civic_is_org_member(campaign.org_id)
        and (cardinality(campaign.target_offices) = 0
             or official.office = any (campaign.target_offices))));
create policy civic_member_messages_update_own on public.civic_member_messages
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy civic_member_messages_delete_own on public.civic_member_messages
  for delete to authenticated using (user_id = (select auth.uid()));

-- Ratings reach members only once published; officers of the chapter grade.
create policy civic_official_ratings_read on public.civic_official_ratings
  for select to authenticated
  using ((published and public.civic_is_org_member(org_id)) or public.civic_is_org_officer(org_id));
create policy civic_official_ratings_officer_insert on public.civic_official_ratings
  for insert to authenticated
  with check (public.civic_is_org_officer(org_id));
create policy civic_official_ratings_officer_update on public.civic_official_ratings
  for update to authenticated
  using (public.civic_is_org_officer(org_id))
  with check (public.civic_is_org_officer(org_id));
create policy civic_official_ratings_officer_delete on public.civic_official_ratings
  for delete to authenticated
  using (public.civic_is_org_officer(org_id));

-- Public record: any signed-in member may read.
create policy civic_districts_public_read on public.civic_districts
  for select to authenticated using (true);
create policy civic_district_aliases_public_read on public.civic_district_aliases
  for select to authenticated using (true);
create policy civic_officials_public_read on public.civic_officials
  for select to authenticated using (true);
create policy civic_bills_public_read on public.civic_bills
  for select to authenticated using (true);
create policy civic_roll_calls_public_read on public.civic_roll_calls
  for select to authenticated using (true);
create policy civic_official_votes_public_read on public.civic_official_votes
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Grants: least privilege, nothing at all for signed-out visitors.
-- ---------------------------------------------------------------------------
revoke all on public.civic_member_addresses from public, anon, authenticated;
grant all on public.civic_member_addresses to service_role;

grant select on public.civic_districts, public.civic_district_aliases, public.civic_officials,
  public.civic_bills, public.civic_roll_calls, public.civic_official_votes,
  public.civic_user_districts, public.civic_quarantine, public.civic_user_district_changes,
  public.civic_member_officials, public.civic_member_officials_keyed,
  public.civic_bill_deciding_votes, public.civic_campaign_official_votes,
  public.civic_member_message_outcomes, public.civic_official_alignment,
  public.civic_member_official_ratings
  to authenticated;
grant select, insert, update, delete on public.civic_campaigns, public.civic_official_ratings to authenticated;
-- Column-level where a member writes: the lookup status is the worker's, and a
-- saved message can never be re-pointed at another campaign, member or official.
grant select, delete on public.civic_member_addresses, public.civic_member_messages to authenticated;
grant insert (user_id, full_name, line1, line2, city, state, postal_code, consent_version),
      update (full_name, line1, line2, city, state, postal_code, consent_version, consented_at)
  on public.civic_member_addresses to authenticated;
grant insert (campaign_id, user_id, official_key, official_name, office, channel, status,
              subject, body, body_fingerprint, sent_at),
      update (channel, status, subject, body, body_fingerprint, sent_at)
  on public.civic_member_messages to authenticated;

revoke all on function public.civic_is_org_member(text) from public, anon;
revoke all on function public.civic_is_org_officer(text) from public, anon;
revoke all on function public.civic_org_member_ids(text) from public, anon, authenticated;
revoke all on function public.civic_org_display_name(text) from public, anon, authenticated;
revoke all on function public.civic_my_orgs() from public, anon, service_role;
revoke all on function public.civic_withdraw_address() from public, anon;
revoke all on function public.civic_campaign_fingerprints(uuid, uuid) from public, anon, authenticated;
revoke all on function public.civic_campaign_stats_for_org(text) from public, anon;
-- The two predicates are evaluated inside the member policies, so the
-- authenticated role must be able to execute them.
grant execute on function public.civic_is_org_member(text) to authenticated, service_role;
grant execute on function public.civic_is_org_officer(text) to authenticated, service_role;
grant execute on function public.civic_org_member_ids(text) to service_role;
grant execute on function public.civic_org_display_name(text) to service_role;
grant execute on function public.civic_my_orgs() to authenticated;
grant execute on function public.civic_withdraw_address() to authenticated, service_role;
grant execute on function public.civic_campaign_fingerprints(uuid, uuid) to service_role;
grant execute on function public.civic_campaign_stats_for_org(text) to authenticated, service_role;

comment on policy mfa_assurance on public.civic_member_addresses is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy civic_member_addresses_own on public.civic_member_addresses is
  'Admits only the member who owns the mailing address to read, save, correct or delete it. Officers and other members never see an address; column grants keep the lookup queue columns worker-owned.';
comment on policy civic_user_districts_read_own on public.civic_user_districts is
  'Admits only the member the district links belong to. The resolver worker writes them; nobody else, officers included, can read where a member lives.';
comment on policy civic_quarantine_read_own on public.civic_quarantine is
  'Admits only the member whose address was quarantined, so they can see why their lookup is on hold. The worker writes the row.';
comment on policy civic_user_district_changes_read_own on public.civic_user_district_changes is
  'Admits only the member whose district links changed, for their own change history. The worker writes the log.';
comment on policy civic_campaigns_read on public.civic_campaigns is
  'Admits members of the campaign''s chapter to published (non-draft) campaigns, and officers of that chapter to all of its campaigns including drafts.';
comment on policy civic_campaigns_officer_insert on public.civic_campaigns is
  'Admits only officers (steward, coordinator, vp or admin hat covering the chapter) to create campaigns for that chapter.';
comment on policy civic_campaigns_officer_update on public.civic_campaigns is
  'Admits only officers of the campaign''s chapter to edit it, and the new row must still belong to a chapter they run.';
comment on policy civic_campaigns_officer_delete on public.civic_campaigns is
  'Admits only officers of the campaign''s chapter to delete it. The civic_campaign_keep_letters trigger refuses the delete once any member letter exists; the officer closes the campaign instead.';
comment on policy civic_member_messages_read_own on public.civic_member_messages is
  'A member''s letter to an official is their own political speech: only its author may read it. Officers get counts through civic_campaign_stats_for_org, never rows.';
comment on policy civic_member_messages_insert_own on public.civic_member_messages is
  'Admits a member to save a message only in their own name, only into an active campaign of a chapter they belong to, and only to one of their own resolved officials whose office the campaign targets.';
comment on policy civic_member_messages_update_own on public.civic_member_messages is
  'Admits only the author to edit or mark their message sent; column grants stop it being re-pointed at another campaign, member or official.';
comment on policy civic_member_messages_delete_own on public.civic_member_messages is
  'Admits only the author to delete their own message.';
comment on policy civic_official_ratings_read on public.civic_official_ratings is
  'Admits members of the chapter to its ratings only once published, and officers of the chapter to its drafts as well.';
comment on policy civic_official_ratings_officer_insert on public.civic_official_ratings is
  'Admits only officers of the chapter to grade officials on its behalf.';
comment on policy civic_official_ratings_officer_update on public.civic_official_ratings is
  'Admits only officers of the rating''s chapter to edit it, keeping it within a chapter they run.';
comment on policy civic_official_ratings_officer_delete on public.civic_official_ratings is
  'Admits only officers of the rating''s chapter to delete it.';
comment on policy civic_districts_public_read on public.civic_districts is
  'Admits any signed-in member to read worker-written public-record civic reference data (districts, officials, bills, roll calls, votes or Census places). It holds no member content, and signed-out visitors have no table grant at all.';
comment on policy civic_district_aliases_public_read on public.civic_district_aliases is
  'Admits any signed-in member to read worker-written public-record civic reference data (districts, officials, bills, roll calls, votes or Census places). It holds no member content, and signed-out visitors have no table grant at all.';
comment on policy civic_officials_public_read on public.civic_officials is
  'Admits any signed-in member to read worker-written public-record civic reference data (districts, officials, bills, roll calls, votes or Census places). It holds no member content, and signed-out visitors have no table grant at all.';
comment on policy civic_bills_public_read on public.civic_bills is
  'Admits any signed-in member to read worker-written public-record civic reference data (districts, officials, bills, roll calls, votes or Census places). It holds no member content, and signed-out visitors have no table grant at all.';
comment on policy civic_roll_calls_public_read on public.civic_roll_calls is
  'Admits any signed-in member to read worker-written public-record civic reference data (districts, officials, bills, roll calls, votes or Census places). It holds no member content, and signed-out visitors have no table grant at all.';
comment on policy civic_official_votes_public_read on public.civic_official_votes is
  'Admits any signed-in member to read worker-written public-record civic reference data (districts, officials, bills, roll calls, votes or Census places). It holds no member content, and signed-out visitors have no table grant at all.';

notify pgrst, 'reload schema';

commit;
