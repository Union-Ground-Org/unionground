-- SOL-20260813-03: a published chapter document cannot be edited silently.
--
-- 20260810193000_published_content_lifecycle.sql applied the content columns
-- (title, document_type, summary, body, visibility) unconditionally while only
-- p_action='republish' moved version and published_at. chapter_documents rows
-- with status='published' are the member-visible library, so a staff 'save' on
-- one shipped half-finished text to members under the OLD version number and
-- the OLD publication date — the two fields members use to decide whether they
-- are reading current language.
--
-- The honest minimum: 'save' is for drafts and archived documents. Changing
-- what members see requires the explicit versioned action ('republish') or
-- withdrawal ('archive'). The row is locked before the status test so a
-- concurrent republish cannot slip a save through the gap.

-- Content and lifecycle updates are RPC-only. The original table migration
-- granted these columns directly to authenticated, which let a caller bypass
-- every check below through PostgREST even though RLS still scoped the row.
revoke update on table public.chapter_documents from authenticated;
revoke update (title, document_type, summary, body, source_url, version, visibility, status, published_at)
  on table public.chapter_documents from authenticated;

create or replace function public.update_chapter_document_content(p_id uuid, p_title text, p_document_type text, p_summary text, p_body text, p_visibility text, p_action text default 'save')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare row public.chapter_documents%rowtype; chapter text := private.assert_publisher();
begin
  if p_action not in ('save','republish','archive') then raise exception 'invalid document action' using errcode='22023'; end if;
  if p_document_type not in ('contract','policy','poms','minutes','training','template','other') or p_visibility not in ('chapter','staff') then raise exception 'invalid document fields' using errcode='22023'; end if;
  select d.* into row from public.chapter_documents d where d.id=p_id and d.chapter_id=chapter for update;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  if p_action='save' and row.status='published' then raise exception 'published document requires a new version or archive' using errcode='55000'; end if;
  update public.chapter_documents d set title=btrim(p_title), document_type=p_document_type, summary=coalesce(p_summary,''), body=coalesce(p_body,''), visibility=p_visibility,
    status=case when p_action='archive' then 'archived' when p_action='republish' then 'published' else d.status end,
    version=case when p_action='republish' then d.version+1 else d.version end,
    published_at=case when p_action='republish' then now() else d.published_at end
  where d.id=p_id and d.chapter_id=chapter returning d.* into row;
  if row.id is null then raise exception 'document unavailable' using errcode='22023'; end if;
  return to_jsonb(row);
end $$;

revoke all on function public.update_chapter_document_content(uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.update_chapter_document_content(uuid,text,text,text,text,text,text) to authenticated;
