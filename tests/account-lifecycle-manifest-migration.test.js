// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import * as concurrencyProofModule from "../scripts/account-lifecycle-concurrency-proof.mjs";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const sql = loadMigrationSql("account_lifecycle_manifest");
const localVerifier = readFileSync(new URL("../scripts/verify-account-lifecycle-manifest-local.mjs", import.meta.url), "utf8");
const retentionProof = readFileSync(new URL("../scripts/account-lifecycle-retention-proof.mjs", import.meta.url), "utf8");
const concurrencyProof = readFileSync(new URL("../scripts/account-lifecycle-concurrency-proof.mjs", import.meta.url), "utf8");
const caseGraphReview = JSON.parse(readFileSync(new URL("../scripts/account-case-graph-review.json", import.meta.url), "utf8"));
const finalizationVerifier = readFileSync(new URL("../scripts/verify-account-deletion-finalization-local.mjs", import.meta.url), "utf8");

describe("account lifecycle manifest migration", () => {
  it("orders revocation case locks before grant locks and revisits identity cleanup after FK waits", () => {
    const revoke = fnBody(sql, "public.casework_revoke_access(p_grant_id uuid)");
    expect(revoke.indexOf("public.member_cases where id = v_row.case_id for update")).toBeGreaterThan(-1);
    expect(revoke.indexOf("public.member_cases where id = v_row.case_id for update"))
      .toBeLessThan(revoke.indexOf("where id = p_grant_id for update"));
    expect(sql).toContain("auth_users_finalize_account_lifecycle_scope after delete on auth.users");
    expect(sql).toContain("referencing old table as deleted_identities\nfor each statement");
    const cleanup = fnBody(sql, "private.finalize_account_lifecycle_auth_scope()");
    for (const input of ["owner_id", "steward_user_id", "coordinator_user_id", "grantee_user_id"]) {
      expect(cleanup).toContain(input);
    }
  });
  it("serializes retained inputs and refreshes the final deletion snapshot", () => {
    const capture = fnBody(sql, "private.account_lifecycle_capture_case(p_case public.member_cases)");
    const auth = fnBody(sql, "private.capture_account_lifecycle_auth_scope()");
    expect(auth).toContain("order by id for update");
    expect(auth).not.toContain("perform private.account_lifecycle_capture_case(c)");
    expect(capture.indexOf("order by id for update")).toBeLessThan(capture.indexOf("jsonb_agg"));
    expect(capture).toContain("on conflict (case_id) do update");
    expect(capture).toContain("grants = excluded.grants");
    expect(sql).not.toContain("on conflict (kind, record_id) do nothing");
  });

  it("creates one revoked, schema-wide manifest table for both dimensions of the lifecycle contract", () => {
    expect(sql).toContain("create table private.account_lifecycle_manifest");
    expect(sql).toContain("delete_disposition text not null check (delete_disposition in ('cascade', 'pseudonymize', 'not_applicable'))");
    expect(sql).toContain("export_disposition text not null check (export_disposition in ('included', 'excluded_with_reason', 'not_applicable'))");
    expect(sql).toContain("export_projection text check (export_projection in ('canonical', 'additional_domains'))");
    expect(sql).toContain("export_inventory_basis text check (export_inventory_basis in ('auth_user_fk'))");
    expect(sql).toContain("export_projection_version integer");
    expect(sql).toContain("export_domain text");
    expect(sql).toContain("export_columns text[]");
    expect(sql).toContain("revoke all on private.account_lifecycle_manifest from public, anon, authenticated, service_role");
  });

  it("registers every previously-restrictive auth.users foreign key discovered on the local replica", () => {
    const restrictiveColumns = [
      ["casework_alert_acknowledgements", "acknowledged_by"],
      ["casework_step_transitions", "transitioned_by"],
      ["casework_strength_analyses", "analyzed_by"],
      ["digital_actions", "created_by"],
      ["digital_actions", "updated_by"],
      ["organization_chart_nodes", "created_by"],
      ["organization_relationships", "created_by"],
      ["organization_timeline_events", "updated_by"],
      ["member_case_contacts", "coordinator_id"],
      ["member_case_outcomes", "recorded_by"],
      ["member_welcome_enrollments", "enrolled_by"],
    ];
    for (const [table, column] of restrictiveColumns) {
      expect(sql).toContain(`('public', '${table}', '${column}', 'pseudonymize', 'not_applicable'`);
    }
  });

  it("cascades only the NOT NULL essential-subject columns instead of anonymizing them", () => {
    for (const [table, column] of [
      ["member_steward_relationships", "steward_user_id"],
      ["member_handoffs", "to_steward_id"],
      ["organization_merge_match_reviews", "source_user_id"],
      ["organization_merge_match_reviews", "target_user_id"],
    ]) {
      expect(sql).toContain(`('public', '${table}', '${column}', 'cascade', 'not_applicable'`);
    }
  });

  it("registers the export-blind-spot domains named in the bug report", () => {
    for (const [table, column] of [
      ["member_qa_questions", "author_user_id"],
      ["member_qa_replies", "author_user_id"],
      ["member_qa_votes", "user_id"],
      ["member_weekly_questions", "user_id"],
      ["member_ballot_votes", "user_id"],
      ["chapter_channel_poll_votes", "user_id"],
      ["member_peer_messages", "sender_id"],
      ["member_case_files", "user_id"],
      ["member_form_files", "uploaded_by"],
      ["chapter_task_files", "uploaded_by"],
      ["compass_message_briefings", "requested_by"],
    ]) {
      expect(sql).toContain(`('public', '${table}', '${column}', 'not_applicable', 'included'`);
    }
  });

  it("applies every manifest-reviewed direct FK repair as statically auditable DDL", () => {
    expect(sql).toContain("delete_disposition in ('cascade', 'pseudonymize')");
    expect(sql).toContain("con.confrelid = 'auth.users'::regclass");
    expect(sql).toContain("alter table public.casework_access_grants drop constraint casework_access_grants_granted_by_fkey");
    expect(sql).toContain("alter table public.casework_access_grants alter column granted_by drop not null");
    expect(sql).toContain("references auth.users(id) on delete set null");
    expect(sql).toContain("references auth.users(id) on delete cascade");
    expect(sql).not.toContain("drop constraint %I");
    expect(sql).not.toContain("alter column %I drop not null");
  });

  it("exposes a schema-wide invariant that fails on any unmanaged restrictive FK at every cascade depth", () => {
    const body = fnBody(sql, "private.account_lifecycle_unmanaged_restrictive_fks()");
    expect(sql).toContain("create table private.account_lifecycle_transitive_fk_manifest");
    expect(sql).toContain("with recursive cascade_nodes as");
    expect(body).toContain("reachable.cascade_depth + 1 as cascade_depth");
    expect(body).toContain("private.account_lifecycle_transitive_fk_manifest");
    expect(body).toContain("missing_transitive_reviews");
    expect(body).toContain("catalog.confdeltype in ('a', 'r')");
    expect(body).toContain("'missing-review'::text");
    expect(body).toContain("'stale-review'::text");
    expect(body).toContain("'action-mismatch'::text");
    expect(body).toContain("'duplicate-constraint'::text");
    expect(body).toContain("count(catalog.constraint_name) <> 1");
    expect(sql).toContain("revoke all on function private.account_lifecycle_unmanaged_restrictive_fks() from public, anon, authenticated");
    expect(sql).toContain("grant execute on function private.account_lifecycle_unmanaged_restrictive_fks() to service_role");
  });

  it("classifies and repairs the full transitive closure without deleting retained case history", () => {
    for (const constraint of [
      "casework_audit_events_case_id_organization_id_chapter_id_fkey",
      "casework_deadline_extensions_deadline_id_organization_id_fkey",
      "casework_management_entries_case_id_organization_id_chapte_fkey",
      "member_case_assignment_audit_case_id_fkey",
      "organization_topic_progress_organization_id_member_user_id_fkey",
    ]) expect(sql).toContain(constraint);
    expect(sql).toContain("on delete set null (case_id)");
    expect(sql).toContain("on delete set null (deadline_id) deferrable initially deferred");
    expect(sql).toContain("defer_constraint = true");
    expect(sql).toContain("Assignment audit remains historical evidence");
    expect(sql).toContain("Casework audit evidence survives account deletion");
    expect(sql).toContain("Essential child rows cascade");
  });

  it("permits only nested referential attribution detachment on trigger/CHECK-sensitive histories", () => {
    const detach = fnBody(sql, "private.account_lifecycle_is_nested_auth_detachment(p_old_user_id uuid, p_new_user_id uuid)");
    expect(detach).toContain("pg_catalog.pg_trigger_depth() > 1");
    expect(detach).toContain("not exists");
    expect(detach).toContain("from auth.users");

    const pollIdentity = fnBody(sql, "private.stamp_channel_poll_identity()");
    expect(pollIdentity).toContain("private.account_lifecycle_is_nested_auth_detachment(old.created_by, new.created_by)");
    expect(pollIdentity).toContain("new.updated_at := old.updated_at");

    const caseworkGuard = fnBody(sql, "private.guard_casework_restriction_update()");
    expect(caseworkGuard).toContain("private.account_lifecycle_is_nested_auth_detachment(old.restricted_by, new.restricted_by)");

    const caseTimestamp = fnBody(sql, "private.touch_member_case_updated_at()");
    expect(caseTimestamp).toContain("private.account_lifecycle_is_nested_auth_detachment(old.restricted_by, new.restricted_by)");
    expect(caseTimestamp).toContain("pg_catalog.to_jsonb(new) - 'restricted_by' - 'updated_at'");
    expect(caseTimestamp).toContain("new.updated_at := old.updated_at");
    expect(sql).toContain("for each row execute function private.touch_member_case_updated_at()");

    const attributionGuard = fnBody(sql, "private.guard_casework_historical_attribution()");
    expect(attributionGuard).toContain("case tg_table_name");
    expect(attributionGuard).toContain("casework_access_grants");
    expect(attributionGuard).toContain("casework_deadline_extensions");
    expect(attributionGuard).toContain("casework_checklist_items");
    expect(attributionGuard).toContain("private.account_lifecycle_is_nested_auth_detachment");

    const caseDetach = fnBody(sql, "private.account_lifecycle_is_nested_case_detachment(p_old_case_id uuid, p_new_case_id uuid)");
    expect(caseDetach).toContain("pg_catalog.pg_trigger_depth() > 1");
    expect(caseDetach).toContain("from public.member_cases");
    const assignmentAudit = fnBody(sql, "private.prevent_case_assignment_audit_mutation()");
    expect(assignmentAudit).toContain("private.account_lifecycle_is_nested_case_detachment(old.case_id, new.case_id)");
    expect(assignmentAudit).toContain("pg_catalog.to_jsonb(new) - 'case_id'");
  });

  it("retains authorization inputs and each table's distinct predicate, never reader IDs", () => {
    expect(sql).toContain("create table private.account_lifecycle_case_scope");
    expect(sql).toContain("create table private.account_lifecycle_history_scope");
    expect(sql).not.toContain("reader_ids");
    expect(sql).toContain("before delete on auth.users");
    expect(sql).toContain("retained.coordinator_user_id = old.id then null");
    expect(sql).toContain("jsonb_array_elements(retained.grants)");
    expect(sql).toContain("before delete on public.member_cases");
    const body = fnBody(sql, "private.account_lifecycle_retained_case_scope_allows(");
    expect(body).toContain("p_kind = 'assignment_audit'");
    expect(body).toContain("private.account_lifecycle_staff_can_see_chapter");
    expect(body).toContain("private.actor_has_chapter_staff_role");
    expect(body).toContain("g.revoked_at is null");
    expect(body).toContain("c.steward_user_id = (select auth.uid())");
  });

  it("keeps the retained coordinator predicate identical to the live target-chapter predicate", () => {
    const source = loadMigrationSql("20260822010000_mi1_organization_scope_foundation");
    const live = fnBody(source, "public.staff_can_see_user(p_target uuid, p_role text)")
      .replaceAll("p_target is null", "p_target_chapter is null")
      .replace("from public.member_profiles target\n      join public.chapters target_chapter on target_chapter.id = target.chapter_id\n      where target.id = p_target", "from public.chapters target_chapter\n      where target_chapter.id = p_target_chapter")
      .replaceAll("target.chapter_id", "p_target_chapter");
    expect(fnBody(sql, "private.account_lifecycle_staff_can_see_chapter(p_target_chapter text, p_role text)").split("$function$")[1].trim()).toBe(live.split("$function$")[1].trim());
  });

  it("checks retained entry authorization before a definer addendum or audit insert", () => {
    const rpc = fnBody(sql, "public.casework_add_management_addendum(p_entry_id uuid, p_body text)");
    expect(rpc.indexOf("account_lifecycle_retained_case_scope_allows")).toBeLessThan(rpc.indexOf("insert into public.casework_management_addenda"));
    expect(rpc).toContain("for share");
    expect(rpc).toContain("insert into private.account_lifecycle_history_scope");
  });

  it("inventories exact trigger/rule definitions and indirect helper bodies without lexical exemptions", () => {
    const surface = fnBody(sql, "private.account_lifecycle_trigger_surface()");
    expect(surface).toContain("pg_catalog.pg_trigger");
    expect(surface).toContain("pg_catalog.pg_rewrite");
    expect(surface).toContain("with recursive roots");
    expect(surface).toContain("pg_catalog.pg_get_functiondef");
    const body = fnBody(sql, "private.account_lifecycle_referential_action_trigger_issues()");
    expect(body).toContain("full join private.account_lifecycle_trigger_review");
    expect(body).toContain("c.definition_hash is distinct from r.definition_hash");
    expect(body).not.toContain("raise");
    expect(localVerifier).toContain("proveTriggerNegativeControls");
  });

  it("runs real negative controls for FK action, missing/stale review, duplicates, and ordinary actor clearing", () => {
    for (const needle of [
      "action-mismatch",
      "stale-review",
      "missing-review",
      "duplicate-constraint",
      "casework_audit_events",
      "chapter_channel_polls",
      "member_cases",
      "casework_access_grants",
      "casework_deadline_extensions",
      "casework_checklist_items",
      "ordinary attribution clearing",
      "Actorless restricted state must fail closed",
      "Actorless revocation control",
      "Actorless deadline decision control",
      "Actorless completion control",
      "readSensitiveHistory",
      "isDeepStrictEqual(sensitiveHistoryAfter, sensitiveHistoryBefore)",
      "EXPECTED_TRANSITIVE_RESTRICTIVE_FK_REVIEWS",
      "unmanagedAtEveryDepth",
      "owner-case delete must cascade essential rows",
      "casework_audit_retained",
      "deadline_extension_retained",
      "ownedManagementEntry",
      "ownedRetaliationReport",
      "ownedAssignmentAudit",
      "unauthorized chapter staff before deletion",
      "unauthorized chapter staff after deletion",
      "ordinary assignment-audit UPDATE after detached case",
      "account_lifecycle_referential_action_trigger_issues",
    ]) {
      expect(localVerifier).toContain(needle);
    }
  });

  it("assembles export coverage from static caller-filtered allowlist helpers", () => {
    const body = fnBody(sql, "private.account_lifecycle_export_additional_domains(p_caller uuid)");
    expect(body).toContain("private.account_lifecycle_export_chapter_thread_posts(p_caller)");
    expect(body).toContain("private.account_lifecycle_export_organization_pulse_events(p_caller)");
    expect(sql).toContain("create function private.account_lifecycle_export_chapter_thread_posts(p_caller uuid)");
    expect(sql).toContain("where t.author_id = p_caller");
    expect(sql).toContain("create function private.account_lifecycle_export_organization_pulse_events(p_caller uuid)");
    expect(sql).toContain("where t.user_id = p_caller");
    expect(body).not.toContain("format(");
    expect(body).not.toContain("execute");
    for (const helper of sql.matchAll(/create function private\.account_lifecycle_export_[a-z_]+\(p_caller uuid\)([\s\S]*?)\$export\$;/g)) {
      expect(helper[1]).not.toContain("t.*");
    }
    expect(sql).toContain("revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public, anon, authenticated");
  });

  it("keeps the reviewed ownership inventory bidirectionally exact across every direct auth.users delete action", () => {
    const body = fnBody(sql, "private.account_lifecycle_unmanaged_export_fks()");
    expect(body).toContain("con.confrelid = 'auth.users'::regclass");
    expect(body).not.toContain("con.confdeltype = 'c'");
    expect(body).toContain("n.nspname in ('public', 'private')");
    expect(body).toContain("m.export_disposition in ('included', 'excluded_with_reason')");
    expect(body).toContain("m.export_inventory_basis = 'auth_user_fk'");
    expect(body).toContain("'missing-review'::text as inventory_issue");
    expect(body).toContain("'stale-review'::text as inventory_issue");
    expect(body).toContain("union all");
    expect(sql).toContain("'public.chapter_threads.created_by', 'included', 'additional_domains'");
    expect(sql).toContain("'public.chapter_thread_posts.author_id', 'included', 'additional_domains'");
    expect(sql).toContain("'public.chapter_task_comments.author_id', 'excluded_with_reason'");
    expect(sql).not.toContain("'public.chapter_task_comments.author_id', 'included', 'canonical'");
    expect(localVerifier).toContain("[\"public.chapter_threads.created_by\", [\"id\", \"space_id\", \"chapter_id\", \"title\"");
    expect(localVerifier).toContain("[\"public.chapter_thread_posts.author_id\", [\"id\", \"thread_id\", \"chapter_id\", \"author_id\"");
    expect(localVerifier).toContain("SET NULL ownership-hide regression");
    expect(localVerifier).toContain("table_name = 'chapter_thread_posts'");
    expect(sql).toContain("grant execute on function private.account_lifecycle_unmanaged_export_fks() to service_role");
    expect(caseGraphReview.exceptions["private.account_lifecycle_unmanaged_export_fks"]?.source_sha256)
      .toBe("4d462c414eb5a0af9eef4c27bce4f3b457be78b4b21ffa471e65cfe4d6e1fa7b");
  });

  it("reviews ENC retained-history readers and trigger writer in the installed definer inventory", () => {
    expect(retentionProof).toContain("'sensitive_pattern_source',");
    expect(retentionProof).not.toContain("'sensitive_demo_seed_plan'");
    // The issue-signal aggregate (20261002150000) sorts between these two names.
    expect(retentionProof).toContain("'guard_casework_historical_attribution',");
    expect(retentionProof).toContain("'require_sensitive_envelopes',");
    expect(retentionProof).toContain("public.casework_audit_events");
    expect(retentionProof).toContain("public.member_case_assignment_audit");
    expect(retentionProof).toContain("field: 'subject_label', purpose: 'casework_retaliation_patterns'");
    expect(retentionProof).toContain("'retaliation scan requires ENC ticket'");
    expect(retentionProof).toContain("'casework_withdraw_retaliation_report', argumentsJson, envelopesJson, ticket");
    expect(concurrencyProof).toContain("'public.write_sensitive_content(text,jsonb,jsonb,uuid)'");
    expect(localVerifier).toContain("set_config('app.sensitive_maintenance','on',true)");
    expect(localVerifier).toContain("'[encrypted]', '[encrypted]', '[encrypted]', '[encrypted]'");
  });

  it("records canonical coverage and reviewed exclusions instead of treating absence as coverage", () => {
    expect(sql).toContain("'public.member_profiles.id', 'included', 'canonical'");
    expect(sql).toContain("'public.member_qa_questions.author_user_id', 'included', 'canonical'");
    expect(sql).toContain("'private.member_mfa_reset_boundaries.user_id', 'excluded_with_reason', null");
    expect(sql).toContain("'public.engagement_delivery_outbox.recipient_user_id', 'excluded_with_reason', null");
    expect(sql).toContain("'public.member_calendar_import_events.steward_id', 'excluded_with_reason', null");
  });

  it("mechanically ties every canonical v1 map entry to its exact caller-ownership predicate", () => {
    expect(localVerifier).toContain("mapping.coverageNeedles");
    expect(localVerifier).toContain("installedExportSource.includes(coverageNeedle)");
    expect(localVerifier).not.toContain("exportDefinitions.includes(`${row.schema_name}.${row.table_name}`)");
  });

  it("routes rows with paths, token-like fields, transport internals, or another identity through explicit safe projections", () => {
    for (const key of [
      "public.member_case_files.user_id",
      "public.member_form_files.uploaded_by",
      "public.member_qa_questions.author_user_id",
      "public.member_qa_replies.author_user_id",
      "public.member_scheduled_messages.actor_id",
      "public.member_peer_messages.sender_id",
      "public.meeting_attendance.user_id",
      "public.meeting_minutes_dispatches.recipient_id",
    ]) {
      expect(sql).toContain(`'${key}', 'included', 'canonical'`);
    }
    const body = fnBody(sql, "public.get_member_data_export()");
    expect(body).toContain("'member_case_files'");
    expect(body).toContain("'member_form_files'");
    expect(body).toContain("'member_scheduled_messages'");
    expect(body).not.toContain("'objectName'");
    expect(body).not.toContain("'bucketId'");
    expect(body).not.toContain("'recipientId'");
    expect(body).not.toContain("'idempotencyKey'");
  });

  it("replaces the legacy workload whole-row projection with a versioned hand-shaped response", () => {
    const body = fnBody(sql, "public.get_member_data_export()");
    expect(body).toContain("from public.member_workload_logs workload");
    expect(body).toContain("where workload.user_id = caller");
    expect(body).toContain("jsonb_set(exported, '{activity,workload}', safe_workload, true)");
    expect(body).not.toContain("to_jsonb(workload)");
  });

  it("folds the manifest-driven domains into the caller's export without reintroducing the pre-peer-contact body", () => {
    const body = fnBody(sql, "public.get_member_data_export()");
    // 20260812233000 already turned this into a thin wrapper around the
    // renamed original exporter plus a peerContact section; the fix must
    // build on that wrapper, not resurrect the pre-wrapper implementation
    // and silently drop peer-contact coverage.
    expect(body).toContain("private.member_data_export_without_peer_contact()");
    expect(sql).toContain("create or replace function private.member_data_export_without_peer_contact()");
    expect(sql).toContain("m.user_id = caller or m.sender_id = caller");
    expect(body).toContain("peer_contact");
    expect(body).toContain("private.account_lifecycle_export_additional_domains(caller)");
    expect(body).toContain("jsonb_build_object('additionalDomains', additional)");
    expect(sql).toContain("revoke all on function public.get_member_data_export() from public, anon");
    expect(sql).toContain("grant execute on function public.get_member_data_export() to authenticated");
  });
});

// SEC-UG-ACCOUNT-LIFECYCLE-CONCURRENCY-PROOF-MISSING-LOOPBACK-GUARD-20260920
describe("account lifecycle concurrency proof disposable-target guard", () => {
  // Extra positional arguments each entry point needs after (client, databaseUrl).
  const entryPoints = {
    proveConcurrentGrantRevocation: [],
    proveConcurrentActualKeyRotation: [],
    proveMidGrantRevocation: [],
    proveOverlappingIdentityDeletion: [],
    proveCatalogueWriterEntry: [["public.member_profiles"]],
  };
  // Any use of the caller's client, or any pg client construction, is a failure:
  // the target check has to happen before either.
  const poisonedClient = () => new Proxy({}, {
    get(_target, property) {
      throw new Error(`proof touched the caller's client (${String(property)})`);
    },
  });
  const clientConstruction = () => vi.spyOn(pg, "Client").mockImplementation(function ClientProbe() {
    throw new Error("proof constructed a pg client");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses every entry point against a non-loopback, lookalike or tunnelled host before any client work", async () => {
    const constructed = clientConstruction();
    for (const [host, port] of [["hosted.example.invalid", 55432], ["localhost.example.invalid", 55432], ["127.0.0.1.example.invalid", 55432], ["notlocalhost", 55432], ["127.0.0.1", 5432]]) {
      for (const [name, extra] of Object.entries(entryPoints)) {
        const call = concurrencyProofModule[name](poisonedClient(), `postgres://proof:secret-password@${host}:${port}/postgres`, ...extra);
        await expect(call).rejects.toThrow(`Refusing account-lifecycle concurrency proof against non-disposable host ${host}`);
        await call.catch((error) => {
          expect(error.message).not.toContain("secret-password");
          expect(error.message).not.toContain("postgres://");
        });
      }
    }
    expect(constructed).not.toHaveBeenCalled();
  });

  it("admits the loopback hosts the local wrappers use", async () => {
    const constructed = clientConstruction();
    for (const host of ["127.0.0.1", "localhost"]) {
      for (const [name, extra] of Object.entries(entryPoints)) {
        await expect(concurrencyProofModule[name](poisonedClient(), `postgres://proof:secret-password@${host}:55432/postgres`, ...extra))
          .rejects.toThrow("proof constructed a pg client");
      }
    }
    expect(constructed).toHaveBeenCalled();
  });

  it("keeps the wrappers' own disposable-target guard in place", () => {
    for (const wrapper of [localVerifier, finalizationVerifier]) {
      expect(wrapper).toContain("import { assertDisposableProofUrl } from \"./run-required-db-proofs.mjs\";");
      expect(wrapper).toMatch(/assertDisposableProofUrl\(requireDatabaseUrl\(/);
    }
  });
});
