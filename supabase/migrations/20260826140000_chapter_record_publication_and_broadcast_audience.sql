-- Chapter-record publication rules and broadcast audience boundary.
-- Reserved filename: 20260826140000_chapter_record_publication_and_broadcast_audience.sql
-- Created with `npx supabase migration new chapter_record_publication_and_broadcast_audience`
-- (CLI 2.109.1) and renamed to the reserved 14-digit prefix. No duplicate
-- prefix exists and no earlier version is edited: this file is forward-only.
--
-- Records closed here:
--   SEC-UG-CHAPTER-RECORDS-CONTACT-READ-20260817
--   SEC-UG-BROADCASTS-CHAPTER-BOUNDARY-20260817
--
-- This is a FRESH migration. PR #930's backdated single-tenant policy is not
-- ported, replayed, or cherry-picked. The organization-scope capability
-- contract from 20260822010000 (organizations, organization_memberships,
-- organization_role_grants, private.current_member_organization,
-- private.is_organization_member, private.has_organization_role,
-- private.member_has_chapter_role, private.staff_mfa_required) is the only
-- authorization foundation used.
--
-- WHY THIS FILE EXISTS ON TOP OF 20260822010000.
--
-- Say the good news first, because it changes what this migration is for.
-- 20260822010000 already withdraws contact records from ordinary members and
-- already scopes broadcasts to one tenant. A two-organization proof was run
-- against the pre-migration policies before this file was written and both
-- denials held. This is NOT a leak fix. It is the part of both records that
-- was never delivered: the rules were correct but IMPLICIT, UNPROVEN, and
-- UNDOCUMENTED, and each of those three is its own way to lose the boundary.
--
--   1. CONTACT-RECORD CONTAINMENT WAS BORROWED, NOT STATED.
--      chapter_records_read_contacts denied a foreign or non-member chapter
--      only because its `exists (... from public.chapters ...)` subquery was
--      itself filtered by chapters_select_all — a policy on a DIFFERENT table
--      — and only because private.member_has_chapter_role reaches
--      public.member_has_role, whose LAST clause happens to require a second
--      factor. Neither dependency is named anywhere, and widening either one
--      silently republishes grievance-adjacent PII. Both requirements are now
--      spelled out in the predicate that needs them.
--
--   2. RECORD-TYPE PUBLICATION WAS IMPLICIT.
--      The two policies each inlined a literal record_type list. A sixth
--      record type added later matches neither list, which happens to fail
--      closed, but nothing states the rule, nothing pins it, and nothing
--      records that minutes/decisions/milestones are chapter-wide ON PURPOSE.
--      The acceptance criteria ask for exactly that written decision.
--
--   3. BROADCAST AUDIENCE WAS NOT PINNED AFTER INSERT, AND THE STEWARD DESK
--      PAGER AND KPI COUNTED WITHOUT AN EXPLICIT TENANT BOUND.
--      member_broadcasts.audience_scope was set at publish and then free to be
--      widened by any later writer; a chapter broadcast quietly becoming an
--      organization broadcast is a republication nobody authorized.
--      list_steward_broadcasts and get_steward_desk_kpis are SECURITY INVOKER
--      and were bounded only by member_broadcasts RLS. That is correct today
--      and is one policy edit away from not being. They now name the caller's
--      organization themselves, and the pager returns the audience so the desk
--      can show which boundary a broadcast was published against.
--
-- The fourth deliverable is not SQL: scripts/verify-db-boundary-tenancy.mjs
-- stands two organizations up with COLLIDING chapter names and asks the
-- database every question both records' acceptance criteria ask, inside a
-- transaction that always rolls back.
--
-- MIGRATION SAFETY.
--
--   * Empty production database: creates three new private functions, replaces
--     two SELECT policies on an existing table, and replaces three existing
--     function bodies. No table, column, constraint, or index is added, so
--     there is nothing to backfill and no constraint that could fail on an
--     empty relation.
--   * Seeded SAMPLE database: no row is written, moved, or deleted. Quarantined
--     legacy rows (organization_id IS NULL) are NOT backfilled — inventing an
--     organization for them would manufacture a fictional tenant, which the
--     repository tenancy contract forbids. They stay excluded from every read
--     path, which is strictly narrower than what they had before this file.
--   * Every behaviour change is a NARROWING. No caller gains a read.
--
-- Supabase guidance (CLI 2.109.1): RLS on every public table; grants and RLS
-- are separate; policies name TO roles plus predicates; SECURITY DEFINER pins
-- an empty search_path, fully qualifies relations, revokes EXECUTE from PUBLIC,
-- and grants only the exact roles that need it.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Explicit record-type publication rules
-- ---------------------------------------------------------------------------

-- One place that answers "who is this record type published to". The policies
-- below carry no literal record_type list any more, so a record type added to
-- chapter_records_record_type_check without a decision here resolves to
-- 'denied' and is readable by nobody until someone writes the rule down.
create function private.chapter_record_publication(p_record_type text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case p_record_type
    when 'minutes' then 'chapter_members'
    when 'decision' then 'chapter_members'
    when 'milestone' then 'chapter_members'
    when 'member_contact' then 'chapter_staff'
    when 'management_contact' then 'chapter_staff'
    else 'denied'
  end;
$function$;

comment on function private.chapter_record_publication(text) is
  'Publication audience per chapter_records.record_type. chapter_members = every active member of that chapter in the selected organization. chapter_staff = authorized staff after the tenant staff-MFA rule. Any unlisted record type resolves to denied and is published to nobody.';

-- ---------------------------------------------------------------------------
-- 2. Chapter-record read predicates
-- ---------------------------------------------------------------------------

-- Chapter-wide governance record visibility. Deliberately identical in effect
-- to the 20260822010000 predicate: this record's scope was contact PII, and
-- silently changing who can read minutes was explicitly out of scope.
create function private.can_read_chapter_member_record(p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null or p_chapter_id is null then false
    when not (select private.mfa_satisfied()) then false
    when p_chapter_id is distinct from (select private.current_member_chapter()) then false
    when not exists (
      select 1
      from public.member_chapter_memberships m
      where m.user_id = (select auth.uid())
        and m.chapter_id = p_chapter_id
        and m.status = 'active'
    ) then false
    else exists (
      select 1
      from public.chapters c
      where c.id = p_chapter_id
        and (
          (
            c.organization_id is not null
            and c.organization_id = (select private.current_member_organization())
            and (select private.is_organization_member(c.organization_id))
          )
          or (
            c.organization_id is null
            and (select private.current_member_organization()) is null
          )
        )
    )
  end;
$function$;

comment on function private.can_read_chapter_member_record(text) is
  'Chapter-wide governance record predicate. Requires MFA assurance, the chapter as the active selection, an active membership in it, and either the same active organization or a contained orphan-to-orphan session. A null organization is never a wildcard.';

-- Contact-record visibility. Contact notes are grievance-adjacent PII authored
-- by staff about named people, so this predicate is staff-only on BOTH
-- branches and MFA-gated on BOTH branches.
create function private.can_read_chapter_contact_record(p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null or p_chapter_id is null then false
    when not (select private.mfa_satisfied()) then false
    else exists (
      select 1
      from public.chapters c
      where c.id = p_chapter_id
        and (
          (
            -- Organization-backed chapter. `is_organization_member` is stated
            -- here rather than inherited from chapters_select_all: this
            -- predicate runs SECURITY DEFINER, so the chapters policy no
            -- longer filters the subquery and the containment has to be its
            -- own. An explicit tenant-wide hat OR an exact chapter role
            -- reads, and both helpers carry the tenant staff-MFA rule.
            c.organization_id is not null
            and c.organization_id = (select private.current_member_organization())
            and (select private.is_organization_member(c.organization_id))
            and (
              (select private.has_organization_role(
                c.organization_id,
                array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
              or (select private.member_has_chapter_role(
                c.id,
                array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
            )
          )
          or (
            -- Quarantined orphan chapter. Same three requirements, none of
            -- them borrowed: an ACTIVE membership in this exact chapter (was
            -- chapters_select_all), a staff role in it, and the second-factor
            -- rule (was the trailing clause of public.member_has_role, three
            -- helpers away). private.staff_mfa_required() fails closed to
            -- true, so an orphan session with no policy row is gated.
            c.organization_id is null
            and (select private.current_member_organization()) is null
            and exists (
              select 1
              from public.member_chapter_memberships m
              where m.user_id = (select auth.uid())
                and m.chapter_id = c.id
                and m.status = 'active'
            )
            and (select private.member_has_chapter_role(
              c.id,
              array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
            and (
              not (select private.staff_mfa_required())
              or (select private.has_second_factor((select auth.uid())))
            )
          )
        )
    )
  end;
$function$;

comment on function private.can_read_chapter_contact_record(text) is
  'Contact-record predicate for grievance-adjacent staff notes. Staff-only and second-factor gated on the organization branch and on the quarantined orphan branch alike. Chapter containment and the staff-MFA rule are stated here rather than inherited from chapters_select_all or from the tail of public.member_has_role, so neither can be widened elsewhere without this predicate noticing.';

revoke all on function private.chapter_record_publication(text)
  from public, anon, authenticated, service_role;
grant execute on function private.chapter_record_publication(text) to authenticated;

revoke all on function private.can_read_chapter_member_record(text)
  from public, anon, authenticated, service_role;
grant execute on function private.can_read_chapter_member_record(text) to authenticated;

revoke all on function private.can_read_chapter_contact_record(text)
  from public, anon, authenticated, service_role;
grant execute on function private.can_read_chapter_contact_record(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Chapter-record read policies, rebuilt behind the publication rules
-- ---------------------------------------------------------------------------

drop policy if exists chapter_records_read_chapter on public.chapter_records;
drop policy if exists chapter_records_read_contacts on public.chapter_records;

create policy chapter_records_read_chapter on public.chapter_records
  for select to authenticated
  using (
    private.chapter_record_publication(record_type) = 'chapter_members'
    and private.can_read_chapter_member_record(chapter_id)
  );

comment on policy chapter_records_read_chapter on public.chapter_records is
  'DELIBERATE VISIBILITY DECISION (SEC-UG-CHAPTER-RECORDS-CONTACT-READ-20260817): minutes, decisions, and milestones remain chapter-wide governance records readable by every active member of that chapter inside the selected organization. That is the product intent for a union chapter minute book and it is NOT changed by this migration; only staff-authored contact records were withdrawn from ordinary members. Changing this line requires its own decision.';

create policy chapter_records_read_contacts on public.chapter_records
  for select to authenticated
  using (
    private.chapter_record_publication(record_type) = 'chapter_staff'
    and private.can_read_chapter_contact_record(chapter_id)
  );

comment on policy chapter_records_read_contacts on public.chapter_records is
  'DELIBERATE VISIBILITY DECISION (SEC-UG-CHAPTER-RECORDS-CONTACT-READ-20260817): member_contact and management_contact are staff-authored, grievance-adjacent notes about named people. They are never published to ordinary chapter members. Authorized staff read them only after the tenant staff-MFA rule is satisfied, and never across organizations.';

-- ---------------------------------------------------------------------------
-- 4. Broadcast audience: pinned after insert
-- ---------------------------------------------------------------------------

-- The audience a broadcast was published against is part of who was allowed to
-- read it. Reassigning it after the fact would silently widen a chapter
-- broadcast to the whole organization, so it is immutable once set, exactly
-- like the owning organization already was.
create or replace function private.forbid_ownerless_broadcast_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' and new.organization_id is null then
    raise exception 'ownerless broadcast writes are prohibited' using errcode = '42501';
  end if;
  if tg_op = 'INSERT'
     and new.organization_id is not null
     and (new.chapter_id is null or new.audience_scope is null) then
    raise exception 'broadcast audience is required' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if old.organization_id is not null
       and new.organization_id is distinct from old.organization_id then
      raise exception 'broadcast organization is immutable' using errcode = '42501';
    end if;
    if old.organization_id is null and new.organization_id is not null then
      raise exception 'legacy broadcast reassignment is operator disposition' using errcode = '42501';
    end if;
    if old.audience_scope is not null
       and new.audience_scope is distinct from old.audience_scope then
      raise exception 'broadcast audience is immutable' using errcode = '42501';
    end if;
    if old.chapter_id is not null
       and new.chapter_id is distinct from old.chapter_id then
      raise exception 'broadcast chapter is immutable' using errcode = '42501';
    end if;
    if new.chapter_id is not null and new.organization_id is not null
       and not exists (
         select 1
         from public.chapters c
         where c.id = new.chapter_id
           and c.organization_id is not distinct from new.organization_id
       ) then
      raise exception 'broadcast chapter is outside organization' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT'
     and new.chapter_id is not null
     and new.organization_id is not null
     and not exists (
       select 1
       from public.chapters c
       where c.id = new.chapter_id
         and c.organization_id is not distinct from new.organization_id
     ) then
    raise exception 'broadcast chapter is outside organization' using errcode = '42501';
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Steward desk: explicit tenant bound and a visible audience
-- ---------------------------------------------------------------------------

-- Return-type change, so the signature is dropped and rebuilt. Both new
-- columns are additive for callers. The organization bound is defence in
-- depth: the pager is SECURITY INVOKER and member_broadcasts RLS already
-- denies foreign tenants, but a desk pager that also names the tenant cannot
-- be widened by a future policy edit alone, and neither can its total_count.
drop function if exists public.list_steward_broadcasts(text, text, timestamptz, text, integer);

create function public.list_steward_broadcasts(
  p_filter text default 'all',
  p_search text default null,
  p_after_published timestamptz default null,
  p_after_id text default null,
  p_limit integer default 20
) returns table (
  id text,
  sender text,
  title text,
  body text,
  published_at timestamptz,
  retracted_at timestamptz,
  locale text,
  audience_scope text,
  chapter_id text,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  needle text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
  desk_org uuid := private.current_member_organization();
  pattern text;
  total bigint;
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_filter not in ('all', 'active', 'retracted') then
    raise exception 'unknown broadcast filter' using errcode = '22023';
  end if;
  if (p_after_id is null) <> (p_after_published is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  -- An orphan or organization-less session has no desk feed. Returning zero
  -- rows here is the same answer RLS already gives; naming it makes the
  -- tenant bound explicit rather than incidental.
  if desk_org is null then
    return;
  end if;
  pattern := case when needle is null then null
    else '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  select count(*) into total
  from public.member_broadcasts b
  where b.organization_id = desk_org
    and (p_filter = 'all'
      or (p_filter = 'active' and b.retracted_at is null)
      or (p_filter = 'retracted' and b.retracted_at is not null))
    and (pattern is null or b.title ilike pattern or b.body ilike pattern);

  return query
  select b.id, b.sender, b.title, b.body, b.published_at, b.retracted_at,
         b.locale, b.audience_scope, b.chapter_id, total
  from public.member_broadcasts b
  where b.organization_id = desk_org
    and (p_filter = 'all'
      or (p_filter = 'active' and b.retracted_at is null)
      or (p_filter = 'retracted' and b.retracted_at is not null))
    and (pattern is null or b.title ilike pattern or b.body ilike pattern)
    and (p_after_id is null or (b.published_at, b.id) < (p_after_published, p_after_id))
  order by b.published_at desc, b.id desc
  limit page_limit;
end;
$$;

comment on function public.list_steward_broadcasts(text, text, timestamptz, text, integer) is
  'Steward desk broadcast pager. Bounded to the caller''s selected organization in both the page and its total_count, and returns the explicit audience each broadcast was published against.';

revoke all on function public.list_steward_broadcasts(text, text, timestamptz, text, integer) from public, anon;
grant execute on function public.list_steward_broadcasts(text, text, timestamptz, text, integer) to authenticated, service_role;

-- The 30-day tile counted every broadcast RLS would show. Same defence in
-- depth: the tile now names the tenant, so a KPI can never outrun the feed.
create or replace function public.get_steward_desk_kpis()
returns table (
  open_requests bigint,
  awaiting_reply bigint,
  broadcasts_30d bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  desk_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  return query
  select
    (select count(*) from public.member_steward_requests r where r.status <> 'closed'),
    (select count(*) from public.member_conversations c where (
      select m.sender_kind from public.member_messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1) = 'member'),
    (select count(*) from public.member_broadcasts b
     where b.retracted_at is null
       and b.published_at > now() - interval '30 days'
       and b.organization_id is not null
       and b.organization_id = desk_org);
end;
$$;

revoke all on function public.get_steward_desk_kpis() from public, anon;
grant execute on function public.get_steward_desk_kpis() to authenticated, service_role;
