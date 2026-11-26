-- Follow-up to #7031 (#6945); stamp reserved by .
-- Fix forward after 20261104111500; no journal or audit row changes.
-- Undoing a held invitation revoke ignored an account created before the
-- invitation, so an older account moved onto the invited address through
-- sign-in recovery let a provision invitation reopen for an address an
-- account already owns. A provision invitation now refuses the undo
-- whenever any account owns the address; only a reactivation invitation,
-- whose person's account predates it, keeps the creation-time exception.
-- The body is otherwise the one 20261104111500 installed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.learning_undo_invitation_revoke(p_mode text, p_entry jsonb)
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
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  invitation_row public.member_invitations%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_invitations i where i.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_invitation_state(target);
  elsif p_mode = 'before' then
    return image;
  elsif p_mode = 'check' then
    select i.* into invitation_row from public.member_invitations i where i.id = target;
    if invitation_row.id is null
       or not (private.member_invitation_chapter_administrable(invitation_row.chapter_id)
               or (invitation_row.initial_role is null and invitation_row.kind = 'provision'
                   and private.member_invitation_chapter_presided(invitation_row.chapter_id))) then
      raise exception 'you can no longer manage this invitation' using errcode = '42501';
    end if;
    if invitation_row.learning_revoke_held_at is null
       or (image ->> 'status' = 'pending' and (invitation_row.token_hash is null
           or invitation_row.expires_at <= pg_catalog.clock_timestamp())) then
      raise exception 'this invitation link has expired' using errcode = '55000';
    end if;
    -- Nobody may have become this person since the invitation was sent: no
    -- account owns the address and no invitation to it was accepted or is
    -- being accepted. (A former member's account predates their
    -- reactivation invitation and does not count; any account owning a
    -- provision invitation's address does, however it got the address.)
    if invitation_row.auth_user_id is not null or exists (
      select 1 from auth.users u
      where pg_catalog.lower(u.email) = invitation_row.normalized_email
        and (invitation_row.kind = 'provision' or u.created_at >= invitation_row.created_at)
    ) or exists (
      select 1 from public.member_invitations other
      where other.normalized_email = invitation_row.normalized_email and other.id <> invitation_row.id
        and (other.status = 'accepting' or (other.status = 'accepted' and other.accepted_at >= invitation_row.created_at))
    ) then
      raise exception 'this person has joined since; send a new invitation instead' using errcode = '40001';
    end if;
    if image ->> 'status' = 'pending' and exists (
      select 1 from public.member_invitations other
      where other.normalized_email = invitation_row.normalized_email and other.id <> invitation_row.id
        and other.status in ('pending', 'accepting')
    ) then
      raise exception 'a newer invitation to this person is already open' using errcode = '40001';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  update public.member_invitations i
  set status = image ->> 'status',
      revoked_at = null,
      failure_code = image ->> 'failure_code',
      -- Only a pending invitation has a working link; any other earlier state
      -- carries no token, exactly as before the revoke.
      token_hash = case when image ->> 'status' = 'pending' then i.token_hash end,
      learning_revoke_held_at = null
  where i.id = target and i.status = 'revoked' and i.learning_revoke_held_at is not null
  returning i.* into invitation_row;
  perform private.audit_member_invitation(
    invitation_row.id, invitation_row.chapter_id, caller, 'invite_restored',
    pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
      'deliveryVersion', invitation_row.delivery_version));
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_invitation_revoke(text, jsonb) from public, anon, authenticated, service_role;

commit;
