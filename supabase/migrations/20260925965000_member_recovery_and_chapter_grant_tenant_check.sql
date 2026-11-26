-- SEC-UG-MEMBER-RECOVERY-AND-CHAPTER-GRANT-TENANT-CHECK-20260925
--
-- Tenant check missing on two member recovery routines and chapter grant.
--
-- The MFA reset boundary (20260924100000) requires the target to be an active
-- member of the caller's organization. Three sibling routines did not:
--
--   * public.grant_member_chapter_membership adds a chapter for a user. It now
--     refuses anyone who is not already a member of the chapter's
--     organization, with the existing 'membership target unavailable' 22023
--     refusal, so the grant stays a chapter-within-organization action. A
--     former member whose organization membership was revoked (their last
--     chapter was removed) can be added back unless they are now active in
--     another organization.
--   * public.begin_member_signin_recovery now also requires the target to be
--     an active member of the caller's selected organization and of the shared
--     chapter, and of no other organization ('recovery unavailable' 42501,
--     unchanged wording).
--   * public.begin_member_password_reissue now also requires the target to be
--     an active member of the chapter's organization whose selected chapter,
--     if any, is inside it, and of no other organization ('password reissue
--     unavailable' 42501, unchanged wording).
--   Both change the whole account (address or password), so neither runs for
--   an account that is active in more than one organization. No organization
--   admin can do it for such an account; it needs an operator.
--
-- private.handle_new_member() also stops honouring a sign-up metadata chapter
-- without a matching accepting invitation in an active organization, so a
-- chapter that belongs to no organization is never honoured.
--
-- Each body is the installed definition (case-graph lock first, and the
-- message-lifecycle lock on the grant) with only the conjuncts above added.
-- No shipped migration is edited. CREATE OR REPLACE keeps each function's
-- existing ACL, so no grant is restated. The handle_new_member review pin in
-- private.account_lifecycle_trigger_review is reconciled against its reviewed
-- predecessor, and the inventory must be empty before this commits.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.grant_member_chapter_membership(p_user_id uuid, p_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  locked_org uuid;
  target_org uuid;
  org_admin boolean;
begin
  if caller is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select c.organization_id into locked_org
  from public.chapters c
  where c.id = p_chapter_id;
  if locked_org is null then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  -- Cheap plausibility check: ordinary members must not be able to queue on
  -- the tenant lock. The identical checks are repeated authoritatively below.
  org_admin := private.has_organization_role(locked_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || locked_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || p_user_id::text, 0));

  -- Re-resolve and authorize only after taking the same tenant→member lock
  -- order as revocation. A queued grant cannot reuse stale caller authority.
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is distinct from locked_org then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  org_admin := private.has_organization_role(target_org, array['admin']);
  if not org_admin and p_chapter_id is distinct from private.current_member_chapter() then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  if not org_admin and not private.member_has_chapter_role(p_chapter_id, array['admin']) then
    raise exception 'chapter outside admin scope' using errcode = '42501';
  end if;
  -- Tenant check: the grant adds a chapter inside the caller's organization
  -- for someone who is already an active member of that organization. It
  -- never admits a person from outside it; organization entry happens only
  -- through an accepted invitation or the organization's own creation.
  -- Unknown, outside and inactive targets share one refusal.
  if not exists (select 1 from public.member_profiles p where p.id = p_user_id)
     or not exists (select 1 from public.chapters c where c.id = p_chapter_id)
     or not exists (
       select 1 from public.organization_memberships om
       where om.organization_id = target_org
         and om.user_id = p_user_id
         and (
           om.status = 'active'
           -- A former member (their last chapter here was removed) may be
           -- added back, unless they are now active in another organization.
           or (
             om.status = 'revoked'
             and not exists (
               select 1 from public.organization_memberships other
               where other.user_id = p_user_id
                 and other.status = 'active'
                 and other.organization_id <> target_org
             )
           )
         )
     ) then
    raise exception 'membership target unavailable' using errcode = '22023';
  end if;

  insert into public.organization_memberships (organization_id, user_id, status)
  values (target_org, p_user_id, 'active')
  on conflict (organization_id, user_id) do update
    set status = 'active', revoked_at = null;

  insert into public.member_chapter_memberships (user_id, chapter_id, status)
  values (p_user_id, p_chapter_id, 'active')
  on conflict (user_id, chapter_id) do update
    set status = 'active', revoked_at = null;

  update public.member_profiles
  set chapter_id = p_chapter_id
  where id = p_user_id and chapter_id is null;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (caller, 'grant_chapter_membership', p_user_id,
    pg_catalog.jsonb_build_object('chapterId', p_chapter_id));
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'chapterId', p_chapter_id, 'active', true);
end;
end;
end;
$function$;

create or replace function public.begin_member_signin_recovery(p_target_user uuid, p_new_email_hash text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  target_chapter text;
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_new_email_hash, '')));
  clean_reason text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_reason, '')));
  operation_row private.member_signin_recoveries%rowtype;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_target_user is null or p_target_user = caller then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter from public.member_profiles p where p.id = caller;
  select p.chapter_id into target_chapter from public.member_profiles p where p.id = p_target_user;
  if caller_chapter is null or target_chapter is distinct from caller_chapter then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;
  -- Tenant check: the target must be an active member of the caller's
  -- organization and of the shared chapter, not only someone whose selected
  -- chapter happens to match.
  if not exists (
       select 1
       from public.chapters c
       join public.organization_memberships om
         on om.organization_id = c.organization_id
        and om.user_id = p_target_user
        and om.status = 'active'
       where c.id = caller_chapter
         and c.organization_id is not null
         and c.organization_id = private.current_member_organization()
     )
     or not exists (
       select 1 from public.member_chapter_memberships m
       where m.user_id = p_target_user
         and m.chapter_id = caller_chapter
         and m.status = 'active'
     )
     -- A new sign-in address changes the whole account, so an account that
     -- is also an active member of another organization is never recovered
     -- by an organization admin.
     or exists (
       select 1 from public.organization_memberships other
       where other.user_id = p_target_user
         and other.status = 'active'
         and other.organization_id is distinct from private.current_member_organization()
     ) then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$'
     or clean_reason not in ('lost_inbox', 'address_retired') then
    raise exception 'recovery unavailable' using errcode = '22023';
  end if;

  if not private.consume_member_signin_recovery_limit(
    'admin:' || caller::text, 'admin-hour', 5, interval '1 hour'
  ) or not private.consume_member_signin_recovery_limit(
    'target:' || p_target_user::text, 'target-day', 3, interval '1 day'
  ) then
    raise exception 'recovery rate limited' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-signin-recovery-target:' || p_target_user::text, 509)
  );
  select * into operation_row
  from private.member_signin_recoveries
  where target_user = p_target_user and status = 'changing'
  for update;

  if found then
    if operation_row.actor = caller
       and operation_row.new_email_hash = clean_hash
       and operation_row.reason = clean_reason then
      update private.member_signin_recoveries
      set attempts = least(attempts + 1, 20), updated_at = clock_timestamp()
      where id = operation_row.id;
      return pg_catalog.jsonb_build_object(
        'accepted', true, 'operationId', operation_row.id, 'retry', true
      );
    end if;
    raise exception 'recovery unavailable' using errcode = '22023';
  end if;

  -- Do not reveal whether the proposed address belongs to an Auth user or a
  -- still-live invitation. The endpoint maps every branch to generic copy.
  if exists (
    select 1 from auth.users u
    where u.email is not null
      and pg_catalog.encode(
        extensions.digest(pg_catalog.lower(pg_catalog.btrim(u.email)), 'sha256'), 'hex'
      ) = clean_hash
  ) or exists (
    select 1 from public.member_invitations i
    where i.status in ('pending', 'accepting')
      and pg_catalog.encode(extensions.digest(i.normalized_email, 'sha256'), 'hex') = clean_hash
  ) then
    raise exception 'recovery unavailable' using errcode = '22023';
  end if;

  insert into private.member_signin_recoveries
    (actor, target_user, chapter_id, new_email_hash, reason)
  values (caller, p_target_user, caller_chapter, clean_hash, clean_reason)
  returning * into operation_row;

  return pg_catalog.jsonb_build_object(
    'accepted', true, 'operationId', operation_row.id, 'retry', false
  );
end;
end;
$function$;

create or replace function public.begin_member_password_reissue(p_target_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  operation private.member_password_reissues%rowtype;
  live_operation_found boolean := false;
begin
  if caller is null or not private.mfa_satisfied()
     or not private.member_has_chapter_role(chapter, array['admin'])
     or p_target_user is null or p_target_user = caller
     or not exists (
       select 1 from public.member_chapter_memberships m
       where m.user_id = p_target_user and m.chapter_id = chapter and m.status = 'active'
     )
     -- Tenant check: the target is an active member of this chapter's
     -- organization, and any chapter they have selected is inside it.
     or not exists (
       select 1
       from public.chapters cc
       join public.organization_memberships om
         on om.organization_id = cc.organization_id
        and om.user_id = p_target_user
        and om.status = 'active'
       join public.member_profiles tp on tp.id = p_target_user
       left join public.chapters tc on tc.id = tp.chapter_id
       where cc.id = chapter
         and cc.organization_id is not null
         and (tp.chapter_id is null or tc.organization_id = cc.organization_id)
     )
     -- A new password changes the whole account, so a member of another
     -- organization as well is never reissued from here.
     or exists (
       select 1
       from public.organization_memberships other
       join public.chapters cc on cc.id = chapter
       where other.user_id = p_target_user
         and other.status = 'active'
         and other.organization_id is distinct from cc.organization_id
     ) then
    raise exception 'password reissue unavailable' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-password-reissue:' || p_target_user::text, 509));
  select * into operation from private.member_password_reissues
  where target_user = p_target_user and status = 'delivering' for update;
  live_operation_found := found;

  if live_operation_found and operation.chapter_id <> chapter then
    raise exception 'password reissue unavailable' using errcode = '42501';
  end if;

  if live_operation_found
     and operation.updated_at > pg_catalog.clock_timestamp() - interval '15 minutes' then
    raise exception 'password reissue already in progress' using errcode = 'P0001';
  end if;

  if not private.consume_member_signin_recovery_limit(
    'admin:' || caller::text, 'admin-hour', 5, interval '1 hour'
  ) then
    raise exception 'password reissue rate limited' using errcode = 'P0001';
  end if;

  -- A stale operation already consumed the target's daily allowance when it
  -- was created. Taking over that lease must not consume another target slot,
  -- or three provider failures could prevent the required recovery attempt.
  if not live_operation_found and not private.consume_member_signin_recovery_limit(
    'target:' || p_target_user::text, 'target-day', 3, interval '1 day'
  ) then
    raise exception 'password reissue rate limited' using errcode = 'P0001';
  end if;

  if live_operation_found then
    update private.member_password_reissues
    set actor = caller, attempts = least(attempts + 1, 20), updated_at = pg_catalog.clock_timestamp()
    where id = operation.id;
    return pg_catalog.jsonb_build_object('accepted', true, 'operationId', operation.id, 'retry', true);
  end if;

  insert into private.member_password_reissues (actor, target_user, chapter_id)
  values (caller, p_target_user, chapter) returning * into operation;
  return pg_catalog.jsonb_build_object('accepted', true, 'operationId', operation.id, 'retry', false);
end;
end;
$function$;

create or replace function private.handle_new_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  member_first text := coalesce(nullif(new.raw_user_meta_data ->> 'first_name', ''), 'Member');
  member_full text := coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), 'Member');
  member_initials text := coalesce(nullif(new.raw_user_meta_data ->> 'initials', ''), 'M');
  member_chapter text := nullif(new.raw_user_meta_data ->> 'chapter_id', '');
  invitation_id text := nullif(new.raw_user_meta_data ->> 'union_base_invitation_id', '');
  member_organization uuid;
begin
  if member_chapter is not null
     and not exists (select 1 from public.chapters where id = member_chapter) then
    member_chapter := null;
  end if;
  -- Every chapter named in sign-up metadata needs a matching accepting
  -- invitation in an active organization; a chapter that belongs to no
  -- organization is never honoured. Otherwise the account starts with no
  -- chapter.
  if member_chapter is not null then
    if invitation_id is null
       or invitation_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or not exists (
         select 1
         from public.member_invitations i
         join public.chapters c on c.id = i.chapter_id
         join public.organizations o
           on o.id = c.organization_id
          and o.status = 'active'
         where i.id = invitation_id::uuid
           and i.status = 'accepting'
           and i.chapter_id = member_chapter
           and i.normalized_email = pg_catalog.lower(new.email)
           and i.token_hash is not null
       ) then
      member_chapter := null;
    else
      select c.organization_id into member_organization
      from public.chapters c
      where c.id = member_chapter;
    end if;
  end if;

  insert into public.member_profiles (id, first_name, full_name, initials, chapter_id)
  values (new.id, member_first, member_full, member_initials, member_chapter);

  if member_organization is not null then
    insert into public.organization_memberships
      (organization_id, user_id, status)
    values (member_organization, new.id, 'active');
  end if;

  if member_chapter is not null then
    insert into public.member_chapter_memberships
      (user_id, chapter_id, status, last_selected_at)
    values (new.id, member_chapter, 'active', pg_catalog.now());
  end if;
  return new;
end;
end;
$function$;


do $reconcile_new_member_trigger_review$
declare
  reconciled integer;
begin
  update private.account_lifecycle_trigger_review
  set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(
    'private.handle_new_member()'::regprocedure))
  where kind = 'function' and schema_name = 'private' and table_name = ''
    and object_name = 'handle_new_member()'
    and definition_hash = '3570385dd35ebbb12c57706d377120e1';
  get diagnostics reconciled = row_count;
  if reconciled <> 1 then
    raise exception 'handle_new_member review pin was not updated exactly once';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the member tenant check migration';
  end if;
end;
$reconcile_new_member_trigger_review$;

notify pgrst, 'reload schema';

commit;
