-- CR-069 / CR-090 are shipped product paths with optional customer activation,
-- not missing schemas and not SAMPLE provider seeds. Extend the parity ledger
-- so an intentionally unset provider can be evidenced without inventing an
-- OAuth identity, credential, agreement, or customer tenant.

set local lock_timeout = '5s';

alter table private.demo_seed_function_catalog
  drop constraint demo_seed_function_catalog_coverage_check,
  drop constraint demo_seed_function_catalog_evidence_complete,
  add constraint demo_seed_function_catalog_coverage_check
    check (coverage in ('seeded', 'schema-not-yet-landed', 'activation-unset')),
  add constraint demo_seed_function_catalog_evidence_complete check (
    (coverage = 'seeded' and evidence_key is not null and gate_relation is null)
    or (coverage = 'activation-unset' and evidence_key is not null and gate_relation is null)
    or (coverage = 'schema-not-yet-landed' and evidence_key is null)
  );

alter table private.demo_seed_function_evidence
  drop constraint demo_seed_function_evidence_status_check,
  add constraint demo_seed_function_evidence_status_check
    check (status in ('seeded', 'schema-not-yet-landed', 'activation-unset'));

update private.demo_seed_function_catalog
set coverage = 'activation-unset',
    evidence_key = case function_id
      when 'CR-069' then 'cba-ingestion-activation-unset'
      when 'CR-090' then 'calendar-import-activation-unset'
    end,
    gate_relation = null
where function_id in ('CR-069', 'CR-090');

update private.demo_seed_function_evidence evidence
set status = catalog.coverage,
    evidence_key = catalog.evidence_key
from private.demo_seed_function_catalog catalog
where evidence.function_id = catalog.function_id
  and catalog.function_id in ('CR-069', 'CR-090');
