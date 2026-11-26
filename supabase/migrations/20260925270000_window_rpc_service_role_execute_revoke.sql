begin;

-- (2026-09-24). Hosted postgres/public default privileges
-- grant service_role EXECUTE when a function is created. The migrations that
-- define these 14 caller-authorized RPCs revoked PUBLIC and anon but kept that
-- direct grant, so the 09-24 hosted window left them wider than their
-- authenticated-only contract. Narrow them to the contract without rewriting
-- their bodies, historical migrations, or shared defaults (same shape as
-- 20260909060128). No caller runs any of them as service_role. REVOKE is a
-- no-op where the grant is already absent.
revoke execute on function public.list_case_note_mention_candidates(uuid) from service_role;
revoke execute on function public.casework_add_case_note(uuid, text, uuid[]) from service_role;
revoke execute on function public.casework_save_macro(uuid, text, text, jsonb, boolean) from service_role;
revoke execute on function public.casework_list_macros() from service_role;
revoke execute on function public.casework_apply_macro(uuid, uuid[], uuid) from service_role;
revoke execute on function public.casework_record_case_export(uuid[], text, text[]) from service_role;
revoke execute on function public.list_member_saved_views(text) from service_role;
revoke execute on function public.save_member_saved_view(uuid, text, text, jsonb, boolean) from service_role;
revoke execute on function public.delete_member_saved_view(uuid) from service_role;
revoke execute on function public.get_member_organization_structure() from service_role;
revoke execute on function public.get_member_chapter_stewards() from service_role;
revoke execute on function public.get_my_steward_contact_visibility() from service_role;
revoke execute on function public.set_my_steward_contact_visibility(boolean, boolean, text, text) from service_role;
revoke execute on function public.start_member_steward_conversation(uuid, text) from service_role;

notify pgrst, 'reload schema';

commit;
