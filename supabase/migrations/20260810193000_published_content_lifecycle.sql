-- UB-HUB-04: durable staff edit, re-publish/version, and archive lifecycle.

alter table public.chapter_records add column archived_at timestamptz;
grant update (archived_at) on public.chapter_records to authenticated;

create or replace function private.assert_publisher()
returns text language plpgsql security definer set search_path = '' stable as $$
declare chapter text;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff publishing role required' using errcode = '42501';
  end if;
  chapter := private.current_member_chapter();
  if chapter is null then raise exception 'chapter required' using errcode = '42501'; end if;
  return chapter;
end $$;

create or replace function public.update_chapter_space_content(p_id uuid, p_name text, p_description text, p_visibility text, p_archive boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare row public.chapter_spaces%rowtype; chapter text := private.assert_publisher();
begin
  if p_visibility not in ('chapter','staff','private') then raise exception 'invalid visibility' using errcode='22023'; end if;
  update public.chapter_spaces s set name=btrim(p_name), description=coalesce(p_description,''), visibility=p_visibility,
    archived_at=case when p_archive then coalesce(s.archived_at, now()) else null end
  where s.id=p_id and s.chapter_id=chapter returning s.* into row;
  if row.id is null then raise exception 'space unavailable' using errcode='22023'; end if;
  return to_jsonb(row);
end $$;

create or replace function public.update_chapter_document_content(p_id uuid, p_title text, p_document_type text, p_summary text, p_body text, p_visibility text, p_action text default 'save')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare row public.chapter_documents%rowtype; chapter text := private.assert_publisher();
begin
  if p_action not in ('save','republish','archive') then raise exception 'invalid document action' using errcode='22023'; end if;
  if p_document_type not in ('contract','policy','poms','minutes','training','template','other') or p_visibility not in ('chapter','staff') then raise exception 'invalid document fields' using errcode='22023'; end if;
  update public.chapter_documents d set title=btrim(p_title), document_type=p_document_type, summary=coalesce(p_summary,''), body=coalesce(p_body,''), visibility=p_visibility,
    status=case when p_action='archive' then 'archived' when p_action='republish' then 'published' else d.status end,
    version=case when p_action='republish' then d.version+1 else d.version end,
    published_at=case when p_action='republish' then now() else d.published_at end
  where d.id=p_id and d.chapter_id=chapter returning d.* into row;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  return to_jsonb(row);
end $$;

create or replace function public.update_chapter_record_content(p_id uuid, p_record_type text, p_title text, p_body text, p_occurred_at timestamptz, p_archive boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare row public.chapter_records%rowtype; chapter text := private.assert_publisher();
begin
  if p_record_type not in ('minutes','decision','milestone','management_contact','member_contact') then raise exception 'invalid record type' using errcode='22023'; end if;
  update public.chapter_records r set record_type=p_record_type, title=btrim(p_title), body=btrim(p_body), occurred_at=p_occurred_at,
    archived_at=case when p_archive then coalesce(r.archived_at, now()) else null end
  where r.id=p_id and r.chapter_id=chapter returning r.* into row;
  if row.id is null then raise exception 'record unavailable' using errcode='22023'; end if;
  return to_jsonb(row);
end $$;

revoke all on function private.assert_publisher() from public, anon, authenticated;
revoke all on function public.update_chapter_space_content(uuid,text,text,text,boolean) from public,anon,authenticated;
revoke all on function public.update_chapter_document_content(uuid,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.update_chapter_record_content(uuid,text,text,text,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.update_chapter_space_content(uuid,text,text,text,boolean) to authenticated;
grant execute on function public.update_chapter_document_content(uuid,text,text,text,text,text,text) to authenticated;
grant execute on function public.update_chapter_record_content(uuid,text,text,text,timestamptz,boolean) to authenticated;
