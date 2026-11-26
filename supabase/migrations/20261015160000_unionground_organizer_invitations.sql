-- Union Ground: an administrator may invite someone as an Organizer
-- (: Organizers are campaign staff).
--
-- 20261014001000 let the Organizer hat (internal id 'organizer') be held in
-- member_roles and member_role_chapters, and set_member_chapter_role already
-- grants it after someone joins. The invitation path still named only the
-- steward, coordinator, advisor and vp hats, so an Organizer had to join as a
-- worker and be granted the hat afterwards.
--
--   * public.member_invitations.initial_role may now be 'organizer'.
--   * public.create_member_invitation accepts 'organizer' wherever it accepts
--     a starting hat. The live definition is patched in place, so every later
--     wrapper (the case-graph lock and the administrator-only rule for any
--     starting access) is kept exactly as it is; the migration refuses to run
--     if the role list it patches is not there.
--
-- No new access path: finalize_member_invitation (20260821011000) already turns
-- initial_role into the member_roles and member_role_chapters rows for the
-- invitation's chapter, which is what the chapter's administrator can already
-- grant with set_member_chapter_role(..., 'organizer', true). Admin is still
-- never a starting hat.

begin;
set local lock_timeout = '5s';

alter table public.member_invitations
  drop constraint member_invitations_initial_role_check;
alter table public.member_invitations
  add constraint member_invitations_initial_role_check
  check (initial_role is null or initial_role in ('steward', 'organizer', 'coordinator', 'advisor', 'vp'));

do $patch$
declare
  target regprocedure := 'public.create_member_invitation(text, text, text, text, text, text)'::regprocedure;
  old_list constant text := $list$clean_role not in ('steward', 'coordinator', 'advisor', 'vp')$list$;
  new_list constant text := $list$clean_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'vp')$list$;
  definition text := pg_catalog.pg_get_functiondef(target);
begin
  if (length(definition) - length(replace(definition, old_list, ''))) / length(old_list) <> 1 then
    raise exception 'create_member_invitation role list not found exactly once';
  end if;
  execute replace(definition, old_list, new_list);
end;
$patch$;

commit;
