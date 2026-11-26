-- OPS-UG-FIREWORKS-FAILOVER-GPT-OSS-120B-SERVERLESS-RETIRED-20261022
-- Fireworks retires accounts/fireworks/models/gpt-oss-120b from serverless
-- inference on November 7, 2026. The platform failover's default model becomes
-- Muse Spark Open (US-only serverless, zero data retention by default, open
-- weights; a project decision October 22, 2026). The production row itself changes
-- only through the platform operator's key form
-- (public.configure_compass_platform_fireworks), which also writes the
-- verified attestation that names the model; this migration changes no row.
-- A Meta "contributor" model trains on what it receives (owner instruction,
-- October 2, 2026: public data only), so no contributor model id can ever be
-- stored as the failover model, whatever path writes the row.
begin;

alter table private.compass_platform_fireworks
  alter column model set default 'accounts/fireworks/models/muse-spark-open';
alter table private.compass_platform_fireworks
  add constraint compass_platform_fireworks_no_contributor_model
  check (model !~ 'contributor');

commit;
