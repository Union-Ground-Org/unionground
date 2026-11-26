-- Reconcile the integrated feature migrations with the database security
-- contract. Supabase's default privileges keep service_role EXECUTE/table
-- grants unless it is named explicitly, and tables created after the original
-- MFA sweep need the same restrictive policy as every earlier RLS table.

set local lock_timeout = '5s';

revoke execute on function public.create_admin_chapter(text, text, text, integer) from service_role;
revoke execute on function public.get_admin_member_directory(text, text, uuid, integer) from service_role;
revoke execute on function public.get_admin_org_structure() from service_role;
revoke execute on function public.update_admin_chapter(text, text, text, integer) from service_role;
revoke execute on function public.create_member_invitation(text, text, text, text, text, text) from service_role;
revoke execute on function public.get_member_invitations(integer) from service_role;
revoke execute on function public.get_steward_workload_intelligence(integer) from service_role;
revoke execute on function public.get_workload_stats() from service_role;
revoke execute on function public.get_workload_reminder_preferences() from service_role;
revoke execute on function public.record_member_invitation_delivery(uuid, integer, text) from service_role;
revoke execute on function public.resend_member_invitation(uuid, text) from service_role;
revoke execute on function public.revoke_member_invitation(uuid) from service_role;
revoke execute on function public.submit_workload_log(
  integer, integer, integer, integer, integer, integer, integer, integer,
  integer, text, integer, boolean, boolean, integer, text, text, boolean,
  boolean, text, jsonb
) from service_role;
revoke execute on function public.set_workload_reminder_preferences(boolean, text, integer, integer, text) from service_role;
revoke execute on function public.get_admin_governance_requests() from service_role;
revoke execute on function public.close_admin_governance_request(uuid, text, text) from service_role;

revoke all on table public.member_invitations from service_role;
revoke all on table public.member_invitation_audit from service_role;

do $mfa$
declare
  table_name text;
begin
  foreach table_name in array array[
    'member_report_preferences',
    'member_case_assignment_audit',
    'member_weekly_questions',
    'member_weekly_question_supports',
    'member_peer_contact_keys',
    'member_peer_contact_requests',
    'member_peer_conversations',
    'member_peer_messages',
    'member_experimental_content'
  ]
  loop
    execute format('drop policy if exists mfa_assurance on public.%I', table_name);
    execute format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated '
      || 'using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      table_name
    );
  end loop;
end
$mfa$;
