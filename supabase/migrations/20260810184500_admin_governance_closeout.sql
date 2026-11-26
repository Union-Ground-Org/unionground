-- UB-HUB-01: an admin can review and close a member data-rights request.

create or replace function public.get_admin_governance_requests()
returns jsonb
language plpgsql security definer set search_path = '' stable
as $$
declare caller uuid := (select auth.uid()); caller_chapter text;
begin
  if caller is null or not private.mfa_satisfied() or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'requesterId', r.requester_id,
      'requesterName', coalesce(p.full_name, 'Member'),
      'requestType', r.request_type, 'details', r.details,
      'status', r.status, 'response', r.response,
      'createdAt', r.created_at, 'updatedAt', r.updated_at
    ) order by r.created_at desc)
    from public.chapter_governance_requests r
    left join public.member_profiles p on p.id = r.requester_id
    where r.chapter_id = caller_chapter
  ), '[]'::jsonb);
end
$$;

create or replace function public.close_admin_governance_request(
  p_request_id uuid, p_status text, p_response text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare caller uuid := (select auth.uid()); changed public.chapter_governance_requests%rowtype;
begin
  if caller is null or not private.mfa_satisfied() or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_status not in ('reviewing', 'fulfilled', 'denied') then
    raise exception 'invalid governance status' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_response, ''))) not between 1 and 10000 then
    raise exception 'response must be between 1 and 10000 characters' using errcode = '22023';
  end if;
  update public.chapter_governance_requests r
     set status = p_status, response = btrim(p_response), handled_by = caller
   where r.id = p_request_id and r.chapter_id = private.current_member_chapter()
   returning r.* into changed;
  if changed.id is null then raise exception 'request unavailable' using errcode = '22023'; end if;
  return jsonb_build_object('id', changed.id, 'status', changed.status, 'response', changed.response, 'handledBy', changed.handled_by, 'updatedAt', changed.updated_at);
end
$$;

revoke all on function public.get_admin_governance_requests() from public, anon, authenticated;
revoke all on function public.close_admin_governance_request(uuid, text, text) from public, anon, authenticated;
grant execute on function public.get_admin_governance_requests() to authenticated;
grant execute on function public.close_admin_governance_request(uuid, text, text) to authenticated;
