-- Forward-only reconciliation of the invitation acceptance lease with the
-- public endpoint. An already-claimed invitation remains private and locked,
-- but the service receives a bounded Retry-After value instead of collapsing
-- that recoverable state into the same terminal response as an invalid token.

create or replace function public.claim_member_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
      return pg_catalog.jsonb_build_object('available', false);
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
$$;

revoke all on function public.claim_member_invitation(text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_member_invitation(text)
  to service_role;
