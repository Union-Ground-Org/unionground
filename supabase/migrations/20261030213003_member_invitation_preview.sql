-- REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030
--
-- The invitation page never said which organization had invited the person,
-- in what role, by whom, or which email address they would sign in with,
-- because the page learns nothing about an invitation until it is accepted.
-- This read lets the server acceptance boundary describe a pending invitation
-- to the holder of its emailed token, before anything is claimed:
--   * service role only, like claim_member_invitation (the API route rate
--     limits the network scope first, in a bucket separate from acceptance);
--   * read only: it never claims, expires, leases or audits the row;
--   * only a pending, unexpired invitation is described; anything else is
--     {"available": false}, the same answer as an unknown token;
--   * it returns the invitation's own address, the organization and chapter
--     names, the role acceptance will grant, and the inviting person's
--     profile name. An operator-issued founder invitation (kind founder,
--     invited_by null) is accepted as the organization admin
--     (private.grant_founder_organization_admin, 20261003010000); every other
--     invitation carries its initial role. The API drops a name that looks
--     like an email address.

begin;

create or replace function public.preview_member_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  found_row record;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('available', false);
  end if;

  select i.normalized_email,
         case when i.kind = 'founder' and i.invited_by is null then 'admin' else i.initial_role end as granted_role,
         c.name as chapter_name,
         o.name as organization_name, inviter.full_name as inviter_name
    into found_row
  from public.member_invitations i
  join public.chapters c on c.id = i.chapter_id
  left join public.organizations o on o.id = c.organization_id
  left join public.member_profiles inviter on inviter.id = i.invited_by
  where i.token_hash = clean_hash
    and i.status = 'pending'
    and i.expires_at > pg_catalog.clock_timestamp();
  if not found then
    return pg_catalog.jsonb_build_object('available', false);
  end if;

  return pg_catalog.jsonb_build_object(
    'available', true,
    'email', found_row.normalized_email,
    'role', found_row.granted_role,
    'chapterName', found_row.chapter_name,
    'organizationName', found_row.organization_name,
    'inviterName', found_row.inviter_name
  );
end;
$function$;

comment on function public.preview_member_invitation(text) is
  'REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030: service-only, read-only description of a pending, unexpired invitation (address, organization, chapter, initial role, inviter name) for the holder of its token; {"available": false} otherwise.';

revoke all on function public.preview_member_invitation(text) from public, anon, authenticated;
grant execute on function public.preview_member_invitation(text) to service_role;

notify pgrst, 'reload schema';

commit;
