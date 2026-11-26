// Shared by the three slice-4 provenance pins:
//   tests/knowledge-revision-provenance-migration.test.js   (20260906028000)
//   tests/retirement-candidate-provenance-migration.test.js (20260906029000)
//   tests/knowledge-article-provenance-migration.test.js    (20260906030000)
//
// Each of them used to carry an exhaustive, hand-maintained list of every
// migration that sorted after it, so that no later migration could move a
// definition the pin still claims to describe without a reviewer looking at
// it first. The list is now derived: tests/helpers/migration.js reads every
// later migration's executable SQL and reports the ones that name any object
// the three provenance migrations declare or alter. Only those need a review,
// and only those are recorded below.
//
// To add a migration here: it is one the derived check reported. Read it
// against every pin in the three files above, update any pin it supersedes,
// then add its exact filename with a one-line note of what it does to the
// named objects. A migration that names none of them is not listed anywhere.
import { laterMigrationsNaming, migrationObjects } from "./migration.js";

export const PROVENANCE_MIGRATIONS = [
  "20260906028000_knowledge_revision_provenance.sql",
  "20260906029000_retirement_candidate_provenance.sql",
  "20260906030000_knowledge_article_provenance.sql",
];

// The union of what the three provenance migrations declare or alter: every
// pin in the three files is about one of these objects.
export function provenanceObjects() {
  return [...new Set(PROVENANCE_MIGRATIONS.flatMap((name) => migrationObjects(name)))].sort();
}

// Every later migration whose executable SQL names a provenance object, with
// the reviewer's note. Apply order.
export const REVIEWED_PROVENANCE_TOUCHES = {
  "20260906029000_retirement_candidate_provenance.sql": "Slice-4 repair 2 of 3: re-emits the CBA draft writer and revision lister and adds the retirement-candidate provenance; pinned by its own test.",
  "20260906030000_knowledge_article_provenance.sql": "Slice-4 repair 3 of 3: article-level content_origin; re-emits the revision and article writers; pinned by its own test.",
  "20260907111000_knowledge_workflow_conversion_provenance.sql": "Conversion provenance: adds a corrected_article_id FK to member_kb_articles and re-emits public.save_chapter_kb_article and public.restore_chapter_kb_revision; reviewed against all three pins when it landed.",
  "20260907122000_retire_dormant_channel_controls.sql": "Names private.demo_seed_apply_knowledge_library only as a data row in a definition-digest table; no knowledge definition changed.",
  "20260907150000_account_lifecycle_manifest.sql": "Adds the case-graph lock/key triggers on member_kb_articles and member_kb_article_revisions; no provenance column, constraint or routine changed.",
  "20260907151000_account_deletion_finalization_reconciliation.sql": "Names knowledge routines only as rows in a definition-digest table; no knowledge definition changed.",
  "20260907152000_sensitive_content_lock_order.sql": "Reads member_kb_articles for existence inside a sensitive-content routine; no knowledge definition changed.",
  "20260930030000_compass_hybrid_retrieval_pgvector.sql": "Adds an embedding side table with a cascading article FK and reads member_kb_articles through knowledge_article_content_current in both RLS and hybrid search; no article/revision provenance column, constraint, writer, or withholding predicate changed.",
  "20261001002000_compass_platform_fireworks_failover.sql": "The invoker context wrapper calls existing lexical and hybrid search under the member role and an identity lock; it changes no provenance writers, revision gates or source predicates.",
  "20261003020000_compass_document_ingestion_classification.sql": "Adds ingestion classification columns and an article trigger plus a bounded backfill; trusted context and vector RLS require classification alongside the existing knowledge_article_content_current gate. Publication writers, revision provenance and source-verdict predicates are unchanged.",
  "20261003033000_remind_here_and_steward_email_routing.sql": "REQ-UG-STEWARD-EMAIL-AUTO-ROUTING-20261001: private.route_steward_email_intake creates one staff-authored DRAFT article (content_origin 'authored', no knowledge_source_id, no import key, no verifier) and its version-1 revision copying the article's own origin, exactly as save_chapter_kb_article does for a new draft; it adds a SET NULL steward_email_intakes.knowledge_article_id FK. No provenance column, constraint, existing writer or withholding predicate changed.",
  "20261003050000_automation_minutes_exports_retention_sources.sql": "Restore lane L7b reads member_kb_articles, organization_knowledge_files and organization_knowledge_sources for counts, export column allowlists and the trusted-source health roll-up, always excluding content_origin 'unresolved' and sample rows; it writes none of them and changes no provenance column, constraint, writer or withholding predicate.",
  "20261003065000_compass_scope_path_resolver.sql": "Binds articles and chunks to explicit organization/chapter/agency/unit scope and filters retrieval from active memberships; preserves classification and source-verdict predicates and publication/revision provenance writers.",
  "20261004020000_compass_hybrid_retrieval_hygiene.sql": "REQ-UG-COMPASS-HYBRID-RETRIEVAL-HYGIENE-20261004: sets hnsw.iterative_scan on the existing hybrid search and adds a read-only hybrid_ready kind to the invoker context wrapper, reading member_kb_articles under the same knowledge_article_content_current, classification and scope gates as the semantic lane; no provenance column, constraint, writer or withholding predicate changed.",
  "20261013040000_compass_source_organization_scope.sql": "SEC-UG-COMPASS-SOURCE-ORGANIZATION-SCOPE-20261012: re-creates the invoker context wrapper with a source-organization check on the briefing and civic kinds only; the lexical, hybrid and hybrid_ready kinds and their member_kb_articles gates are copied unchanged. No provenance column, constraint, writer or withholding predicate changed.",
  "20261015130000_unionground_rights_guidance_before_recognition.sql": "Union Ground D4: rewrites the nine retired sample rows' title, article_ref, body, keywords and kind (contract to rights) by slug so they assume no existing union; is_sample, status, content_origin, knowledge_source_id, import_key, verifier and every writer, constraint and withholding predicate are unchanged.",
  "20261018060300_retire_legacy_agency_chapters.sql": "Checks incoming chapter references, including member_kb_articles, and refuses any attached rows before deleting the exact legacy seed chapters. It changes no knowledge row, provenance column, constraint, writer or withholding predicate.",
  "20261018064849_retire_pre_bot_seed_functions.sql": "Removes pre-bot seed routines and exact manifest-bound unowned placeholder articles. Existing article/revision provenance columns, constraints, publication writers and withholding predicates remain unchanged; retirement and neighbor-preservation are exercised by the disposable database tests.",
  "20261028080000_platform_organization_boundary.sql": "#4807 filters platform organizations from the Compass alternative-scope notice while preserving the existing article scope, published/verified, content-current and classification-current predicates byte-for-byte. It neither writes knowledge rows nor changes provenance columns, constraints or writers; database tests retain the same verified article as a positive union control and exclude it only when its organization is platform.",
  "20261028210000_rls_merge_multiple_permissive_select_policies.sql": "PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: replaces member_kb_articles_member_read and member_kb_articles_staff_read with one permissive SELECT policy, member_kb_articles_select, whose predicate is the OR of the two catalog predicates byte for byte (md5-guarded). The withholding predicate knowledge_article_content_current stays in both branches; no provenance column, constraint or writer changed.",
  "20261107153700_knowledge_articles_scope_once_per_statement.sql": "#7361: alters member_kb_articles_select so the caller's scope paths, chapter and staff role resolve once per statement; both branches keep private.knowledge_article_content_current(member_kb_articles.*) and the member branch keeps the classification, scope-current, publication and verification predicates. No knowledge row, provenance column, constraint, writer or withholding predicate changes.",
  "20261117121800_functions_utc_day_casts_eastern.sql": "#8876: re-emits private.route_steward_email_intake from its live body with only the date in a knowledge draft's title and reference read on the Eastern calendar (America/New_York instead of UTC). The draft stays authored, unverified and a draft; no provenance column, constraint, writer or withholding predicate changes.",
  "20261125120300_client_default_table_privileges_revoke.sql": "Schema-wide ALTER DEFAULT PRIVILEGES for tables created later; no existing knowledge table, grant, column, constraint or routine changes.",
};

// The derived tail from `name` and the reviewed subset it must equal.
export function provenanceTouchesAfter(name) {
  const actual = laterMigrationsNaming(name, provenanceObjects()).map((entry) => entry.name);
  const reviewed = Object.keys(REVIEWED_PROVENANCE_TOUCHES).filter((entry) => entry > name);
  return { actual, reviewed };
}
