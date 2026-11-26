-- Preserve every reviewed provider job kind after Constant Contact and Twilio migrations.
set local lock_timeout = '5s';

alter table public.integration_jobs
  drop constraint if exists integration_jobs_job_kind_check;

alter table public.integration_jobs
  add constraint integration_jobs_job_kind_check check (job_kind in (
    'provider_health',
    'connection_probe',
    'webhook_deliver',
    'webhook_retry',
    'constant_contact_sync',
    'sms_send',
    'sms_status',
    'sms_consent'
  ));

notify pgrst, 'reload schema';
