-- REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113 (#8627); placeholder
-- stamp from , renamed to the real stamp at its turn in the migration line.
-- The owner chose (Nov 13, 2026, decision 3 of the Union Ground theme guide)
-- that a chapter's notices carry the tile's soft glow in a colour the chapter
-- picks: green, blue, gold or violet. Amber (due soon) and red (urgent) keep
-- their meaning and are never a chapter's choice.
--
-- public.chapters.notice_glow holds the choice. It defaults to green, so a
-- chapter that has not chosen shows green, and a check refuses any other name.
-- The column is read through the existing chapters_select_all policy, the same
-- rows and grant as the chapter's name: a member sees the colour only of the
-- chapters of their own organization, which already see that chapter's
-- organization-wide notices. There is no direct write grant on public.chapters;
-- public.set_chapter_notice_glow is the one way to change the colour, for the
-- roles that can publish that chapter's announcements
-- (public.publish_member_broadcast: a steward, admin or vp of the chapter, or
-- a chapter officer whose office posts notices), after the two-step check.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.chapters
  add column notice_glow text not null default 'green'
  constraint chapters_notice_glow_choice check (notice_glow in ('green', 'blue', 'gold', 'violet'));

comment on column public.chapters.notice_glow is
  'REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113: the glow colour of this chapter''s notices: green, blue, gold or violet (amber and red are kept for due soon and urgent). Set only through public.set_chapter_notice_glow.';

create function public.set_chapter_notice_glow(p_chapter_id text, p_colour text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  caller_org uuid;
  clean_chapter text;
  clean_colour text;
  stored text;
begin
  -- The case-graph gate comes first, as in every writer of public.chapters
  -- (scripts/account-case-graph-inventory.mjs helperFirst).
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  clean_chapter := pg_catalog.btrim(coalesce(p_chapter_id, ''));
  clean_colour := pg_catalog.lower(pg_catalog.btrim(coalesce(p_colour, '')));
  if caller is null or not (select private.mfa_satisfied()) then
    raise exception 'chapter notice role required' using errcode = '42501';
  end if;
  caller_org := private.current_member_organization();
  -- One refusal for a chapter that is missing, in another organization or not
  -- the caller's to publish for, so the answer says nothing about the chapter.
  if caller_org is null
     or not exists (select 1 from public.chapters c where c.id = clean_chapter and c.organization_id = caller_org)
     or not (private.member_has_chapter_role(clean_chapter, array['steward', 'admin', 'vp'])
       or private.chapter_officer_can(clean_chapter, 'notices')) then
    raise exception 'chapter notice role required' using errcode = '42501';
  end if;
  if clean_colour not in ('green', 'blue', 'gold', 'violet') then
    raise exception 'notice glow must be green, blue, gold or violet' using errcode = '22023';
  end if;
  update public.chapters c
     set notice_glow = clean_colour
   where c.id = clean_chapter and c.organization_id = caller_org
  returning c.notice_glow into stored;
  return stored;
end;
$function$;

comment on function public.set_chapter_notice_glow(text, text) is
  'REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113: set the glow colour (green, blue, gold or violet) of a chapter''s notices; only the roles that can publish that chapter''s announcements, in the caller''s organization, after the two-step check.';

revoke all on function public.set_chapter_notice_glow(text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_chapter_notice_glow(text, text) to authenticated;

-- The chapter's colour and whether the caller may change it, so the settings
-- control is offered only to the people the setter accepts (a visible control
-- works or is not shown). A chapter outside the caller's organization gets the
-- same refusal as a missing one.
create function public.get_chapter_notice_glow(p_chapter_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid;
  clean_chapter text := pg_catalog.btrim(coalesce(p_chapter_id, ''));
  colour text;
begin
  if caller is null or not (select private.mfa_satisfied()) then
    raise exception 'chapter notice role required' using errcode = '42501';
  end if;
  caller_org := private.current_member_organization();
  select c.notice_glow into colour
    from public.chapters c
   where caller_org is not null and c.id = clean_chapter and c.organization_id = caller_org;
  if colour is null then
    raise exception 'chapter notice role required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'chapterId', clean_chapter,
    'glow', colour,
    'canChange', private.member_has_chapter_role(clean_chapter, array['steward', 'admin', 'vp'])
      or private.chapter_officer_can(clean_chapter, 'notices'));
end;
$function$;

comment on function public.get_chapter_notice_glow(text) is
  'REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113: a chapter''s notice glow colour in the caller''s organization, and whether the caller may change it (the same roles public.set_chapter_notice_glow accepts).';

revoke all on function public.get_chapter_notice_glow(text) from public, anon, authenticated, service_role;
grant execute on function public.get_chapter_notice_glow(text) to authenticated;

commit;
