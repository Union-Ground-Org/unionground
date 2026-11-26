-- Supabase's project default privileges grant service_role EXECUTE on newly
-- created functions. These browser RPCs are intentionally callable only with
-- an authenticated member session; server workers have separate lease-bound
-- RPCs where service_role access is required.

revoke execute on function public.list_contract_clauses() from service_role;
revoke execute on function public.list_contract_clause_grievance_counts() from service_role;
revoke execute on function public.create_contract_clause(uuid, text, text, text, text, text, text, text[], integer) from service_role;
revoke execute on function public.update_contract_clause(uuid, uuid, text, text, text, text, text, text, text[], integer) from service_role;
revoke execute on function public.set_contract_clause_status(uuid, uuid, text) from service_role;

revoke execute on function public.list_my_access_history(integer) from service_role;
revoke execute on function public.record_member_access_event(uuid, uuid, text, text, text) from service_role;

revoke execute on function public.configure_organization_survey_operations(uuid, jsonb) from service_role;
revoke execute on function public.prepare_organization_survey_distribution(uuid, uuid[]) from service_role;
revoke execute on function public.queue_organization_survey_reminders(uuid) from service_role;
revoke execute on function public.update_organization_survey_task(uuid, text, uuid, timestamptz) from service_role;
revoke execute on function public.update_organization_survey_review(uuid, text, uuid, text, timestamptz) from service_role;
revoke execute on function public.get_organization_survey_review_detail(uuid) from service_role;
revoke execute on function public.get_quarterly_survey_gate() from service_role;
revoke execute on function public.get_organization_survey_report(uuid) from service_role;
revoke execute on function public.export_organization_survey_results(uuid) from service_role;
revoke execute on function public.save_organization_pulse_prompt(jsonb) from service_role;
revoke execute on function public.evaluate_contextual_pulse(text, text) from service_role;
revoke execute on function public.respond_contextual_pulse(uuid, jsonb, boolean) from service_role;
revoke execute on function public.save_organization_live_poll(jsonb) from service_role;
revoke execute on function public.transition_organization_live_poll(uuid, text) from service_role;
revoke execute on function public.set_organization_live_poll_roster(uuid, uuid[]) from service_role;
revoke execute on function public.rsvp_organization_live_poll(uuid, text) from service_role;
revoke execute on function public.check_in_organization_live_poll(uuid, uuid) from service_role;
revoke execute on function public.cast_organization_live_poll_vote(uuid, uuid) from service_role;
revoke execute on function public.heartbeat_member_presence(text) from service_role;
revoke execute on function public.set_chapter_space_controls(uuid, text, integer, boolean) from service_role;
revoke execute on function public.set_chapter_space_preference(uuid, boolean, text) from service_role;
revoke execute on function public.propose_compass_workspace_action(text, text, text) from service_role;
revoke execute on function public.decide_compass_workspace_action(uuid, text) from service_role;
revoke execute on function public.get_message_briefing_context(text, uuid) from service_role;
revoke execute on function public.save_chapter_space_keyword_monitor(uuid, text, boolean) from service_role;
revoke execute on function public.mark_chapter_space_keyword_hit_read(uuid) from service_role;
revoke execute on function public.save_compass_workspace_preferences(jsonb, jsonb) from service_role;
revoke execute on function public.persist_compass_message_briefing(text, uuid, text, jsonb) from service_role;
revoke execute on function public.get_member_engagement_snapshot() from service_role;
revoke execute on function public.get_staff_engagement_snapshot() from service_role;

notify pgrst, 'reload schema';
