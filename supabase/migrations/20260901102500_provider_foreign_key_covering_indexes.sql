-- Cover provider and retention foreign keys introduced by the MI1 delivery
-- migrations. These indexes keep parent updates/deletes and relationship
-- lookups bounded as organizations begin onboarding; they create no rows.

set local lock_timeout = '5s';

create index if not exists constant_contact_oauth_states_org_idx
  on private.constant_contact_oauth_states (organization_id);
create index if not exists constant_contact_oauth_states_requester_idx
  on private.constant_contact_oauth_states (requested_by);
create index if not exists constant_contact_oauth_tokens_connector_idx
  on private.constant_contact_oauth_tokens (connected_by);

create index if not exists member_sms_preferences_user_idx
  on private.member_sms_preferences (user_id);
create index if not exists twilio_sms_attempts_job_idx
  on private.twilio_sms_attempts (job_id);

create index if not exists constant_contact_sync_requests_org_idx
  on public.constant_contact_sync_requests (organization_id);
create index if not exists constant_contact_sync_requests_requester_idx
  on public.constant_contact_sync_requests (requested_by);
create index if not exists constant_contact_sync_runs_requester_idx
  on public.constant_contact_sync_runs (requested_by);

create index if not exists integration_jobs_chapter_idx
  on public.integration_jobs (chapter_id);
create index if not exists integration_jobs_target_user_idx
  on public.integration_jobs (target_user_id);

create index if not exists organization_retention_policies_updated_by_idx
  on public.organization_retention_policies (updated_by);
create index if not exists organization_retention_runs_authorized_by_idx
  on public.organization_retention_runs (authorized_by);
create index if not exists organization_retention_runs_requested_by_idx
  on public.organization_retention_runs (requested_by);
