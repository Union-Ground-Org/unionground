-- Cover the referencing side of both seed-evidence foreign keys. These tables
-- are small today, but verification and reversible cleanup join/filter on the
-- FK columns and should not degrade into sequential scans as manifests grow.

create index if not exists demo_seed_function_evidence_function_id_idx
  on private.demo_seed_function_evidence (function_id);

create index if not exists demo_seed_page_evidence_surface_idx
  on private.demo_seed_page_evidence (surface);
