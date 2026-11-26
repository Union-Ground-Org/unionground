-- BUG-UG-INVITATION-ACCEPT-503-20261006.
-- An unconfirmed Auth create keeps the accepting lease so the same link can
-- recover the exact user. After the third attempt the claim used to answer
-- unavailable without changing the row, which then stayed accepting forever:
-- resend, revoke and a new invitation for that email all refuse an accepting
-- row. Once that last lease lapses, the claim now returns the row id with
-- cause acceptance-exhausted so api/accept-invitation.js can delete the exact
-- invitation-labelled pending identity and record fail_member_invitation_accept.
-- Everything else is the installed definition from
-- 20260927100000_org_admin_reinvite_former_member.sql; grants are unchanged.

begin;

create or replace function public.claim_member_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  invitation_row public.member_invitations%rowtype;
  recovery boolean := false;
  retry_after integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('available', false);
  end if;

  select * into invitation_row
  from public.member_invitations
  where token_hash = clean_hash
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  if invitation_row.status = 'pending'
     and invitation_row.expires_at <= clock_timestamp() then
    update public.member_invitations
    set status = 'expired', token_hash = null
    where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version)
    );
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  if invitation_row.status = 'accepting' then
    if invitation_row.accept_attempts >= 3 then
      -- A live lease (the last attempt, or a release that just re-leased the
      -- row) is still in progress: the same bounded wait as attempts 1-2, so
      -- the page waits and retries into the release below instead of
      -- reporting a terminal invitation.
      if invitation_row.accepting_at + interval '2 minutes' > clock_timestamp() then
        retry_after := greatest(
          1,
          least(
            120,
            pg_catalog.ceil(extract(epoch from (
              invitation_row.accepting_at + interval '2 minutes' - clock_timestamp()
            )))::integer
          )
        );
        return pg_catalog.jsonb_build_object(
          'available', false,
          'cause', 'acceptance-in-progress',
          'retryAfterSeconds', retry_after
        );
      end if;
      -- The last attempt's lease lapsed without an outcome. Re-lease the row
      -- so concurrent claims wait, and hand its id to the handler, which
      -- removes only the exact invitation-labelled pending identity and then
      -- records the failure so the row becomes resendable.
      update public.member_invitations
      set accepting_at = clock_timestamp()
      where id = invitation_row.id;
      return pg_catalog.jsonb_build_object(
        'available', false,
        'cause', 'acceptance-exhausted',
        'invitationId', invitation_row.id
      );
    end if;
    if invitation_row.accepting_at + interval '2 minutes' > clock_timestamp() then
      retry_after := greatest(
        1,
        least(
          120,
          pg_catalog.ceil(extract(epoch from (
            invitation_row.accepting_at + interval '2 minutes' - clock_timestamp()
          )))::integer
        )
      );
      return pg_catalog.jsonb_build_object(
        'available', false,
        'cause', 'acceptance-in-progress',
        'retryAfterSeconds', retry_after
      );
    end if;
    recovery := true;
  elsif invitation_row.status <> 'pending' then
    return pg_catalog.jsonb_build_object('available', false);
  end if;

  update public.member_invitations
  set status = 'accepting', accepting_at = clock_timestamp(),
      accept_attempts = accept_attempts + 1
  where id = invitation_row.id
  returning * into invitation_row;

  if not recovery then
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_claimed',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version)
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'available', true,
    'recovery', recovery,
    'kind', invitation_row.kind,
    'invitationId', invitation_row.id,
    'normalizedEmail', invitation_row.normalized_email,
    'fullName', invitation_row.full_name,
    'firstName', invitation_row.first_name,
    'initials', invitation_row.initials,
    'chapterId', invitation_row.chapter_id,
    'initialRole', invitation_row.initial_role,
    'locale', invitation_row.locale
  );
end;
end;
$function$;

commit;
