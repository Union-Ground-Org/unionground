-- SEC-UG-PUBLIC-CHAPTER-MICROSITE-DIRECT-DML-20260919
--
-- The editor already writes through three SECURITY DEFINER routines:
-- upsert_public_chapter_microsite_section, upsert_public_chapter_microsite_page,
-- and take_over_public_chapter_page. Direct authenticated table DML bypassed
-- their selected-organization, ownership-preservation, publication-stamp and
-- takeover-ledger controls. Keep the staff read policy and SELECT privilege;
-- remove every direct authenticated write policy and table privilege.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke insert, update, delete on public.public_chapter_sections from authenticated;
revoke insert, update, delete on public.public_chapter_pages from authenticated;

drop policy if exists public_chapter_sections_staff_create on public.public_chapter_sections;
drop policy if exists public_chapter_sections_staff_update on public.public_chapter_sections;
drop policy if exists public_chapter_sections_staff_delete on public.public_chapter_sections;
drop policy if exists public_chapter_pages_staff_create on public.public_chapter_pages;
drop policy if exists public_chapter_pages_staff_update on public.public_chapter_pages;
drop policy if exists public_chapter_pages_staff_delete on public.public_chapter_pages;

notify pgrst, 'reload schema';

commit;
