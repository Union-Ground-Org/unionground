// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const sql = loadMigrationSql("account_deletion_finalization_reconciliation");
const localProof = readFileSync(new URL("../scripts/verify-account-deletion-finalization-local.mjs", import.meta.url), "utf8");
const fingerprintUpgradeProof = readFileSync(new URL("../scripts/account-deletion-fingerprint-upgrade-proof.mjs", import.meta.url), "utf8");
const dbContract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("account deletion finalization reconciliation migration", () => {
  it("adds a token-independent durability marker column, constrained to a claimed request", () => {
    expect(sql).toContain("add column auth_deleted_at timestamptz");
    expect(sql).toContain("check (auth_deleted_at is null or claimed_at is not null)");
  });

  it("never lets the stale-processing sweep relabel a durably auth-deleted request as failed", () => {
    const body = fnBody(sql, "public.authorize_member_account_deletion(p_confirmation text)");
    expect(body).toContain("and auth_deleted_at is null");
  });

  it("marks durability without ever requiring the ephemeral plaintext deletion token", () => {
    const body = fnBody(sql, "public.mark_member_account_deletion_auth_completed(p_request_id uuid)");
    expect(body).not.toMatch(/p_token/);
    expect(body).toContain("auth.role()) <> 'service_role'");
    expect(body).toContain("status = 'processing'");
    expect(body).toContain("and auth_deleted_at is null");
    expect(sql).toContain("revoke all on function public.mark_member_account_deletion_auth_completed(uuid) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.mark_member_account_deletion_auth_completed(uuid) to service_role");
  });

  it("exposes reconciliation through public (never private) so a service-role scheduled job can reach it via PostgREST", () => {
    expect(sql).toContain("create function public.reconcile_pending_account_deletions(p_limit integer default 25)");
    const body = fnBody(sql, "public.reconcile_pending_account_deletions(p_limit integer default 25)");
    expect(body).toContain("auth.role()) <> 'service_role'");
    expect(body).toContain("status = 'processing'");
    expect(body).toContain("auth_deleted_at is not null");
    expect(body).toContain("for update skip locked");
    expect(body).toContain("least(greatest(coalesce(p_limit, 25), 0), 25)");
    expect(body).toContain("'completed'");
    expect(body).toContain("'deletion_completed'");
    expect(sql).toContain("('public.reconcile_pending_account_deletions(integer)', 'c5c4e532cfe04a4eba04c2f524ca755c9f6ddd57d24a7b9b901c62107451a4d3')");
    expect(sql).toContain("revoke all on function public.reconcile_pending_account_deletions(integer) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.reconcile_pending_account_deletions(integer) to service_role");
  });

  it("proves terminal audit durability for the exact request after either finalization path", () => {
    const body = fnBody(sql, "public.member_account_deletion_has_terminal_audit(p_request_id uuid)");
    expect(body).toContain("auth.role()) <> 'service_role'");
    expect(body).toContain("select exists (");
    expect(body).not.toContain("pg_catalog.exists");
    expect(body).toContain("audit.created_at = request.finalized_at");
    expect(body).toContain("when 'completed' then 'deletion_completed'");
    expect(body).toContain("when 'failed' then 'deletion_failed'");
    expect(sql).toContain("revoke all on function public.member_account_deletion_has_terminal_audit(uuid) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.member_account_deletion_has_terminal_audit(uuid) to service_role");
  });

  it("records bounded redacted platform job health for the periodic reconciler", () => {
    const body = fnBody(sql, "public.record_account_deletion_reconcile_job_run(p_run_id text, p_status text, p_failure_class text default null)");
    expect(body).toContain("auth.role()) <> 'service_role'");
    expect(body).toContain("'account-deletion-reconcile-tick'");
    expect(body).toContain("p_run_id is null");
    expect(body).toContain("p_status is null");
    expect(body).toContain("p_failure_class not in ('reconcile_unavailable', 'contract_drift')");
    expect(body).not.toContain("subject_hash");
    expect(body).not.toContain("deletionToken");
    expect(sql).toContain("grant execute on function public.record_account_deletion_reconcile_job_run(text, text, text) to service_role");
  });

  it("recovers a processing request when both post-delete RPCs missed but auth.users proves the subject is gone", () => {
    const body = fnBody(sql, "public.reconcile_pending_account_deletions(p_limit integer default 25)");
    expect(body).toContain("not exists (");
    expect(body).toContain("from auth.users u");
    expect(body).toContain("pg_catalog.convert_to(u.id::text, 'UTF8'), key_snapshot");
    expect(body).toContain("auth_deleted_at = coalesce(request.auth_deleted_at, now())");
  });

  it("fails closed if the per-request HMAC key or installed subject-hash routine drifts", () => {
    expect(sql).toContain("add column subject_hash_key_fingerprint text");
    expect(sql).toContain("subject_hash_key_fingerprint = current_key_fingerprint");
    const authorizeBody = fnBody(sql, "public.authorize_member_account_deletion(p_confirmation text)");
    expect(authorizeBody).toContain("pg_catalog.md5(p.prosrc)");
    expect(authorizeBody).toContain("raise exception 'account lifecycle subject-hash contract unavailable or changed'");
    const body = fnBody(sql, "public.reconcile_pending_account_deletions(p_limit integer default 25)");
    const reconcilerContract = dbContract.functions.find(
      (entry) => entry.sig === "public.reconcile_pending_account_deletions(p_limit integer)",
    );
    // #8605 re-emitted the reconciler (inside the same case-graph gate) so its
    // two parking updates pick their rows once; the live definition moved.
    // This edition's copy words one body comment without the private runbook
    // path, so its replayed body hash differs from upstream's.
    expect(reconcilerContract?.bodyMd5).toBe("7ec658729bddb181c51a4528ba3b64b2");
    expect(body).toContain("private.member_account_lifecycle_secret");
    expect(body).toContain("pg_catalog.md5(p.prosrc)");
    expect(body).toContain("pg_catalog.to_regprocedure('private.member_lifecycle_subject_hash(uuid)')");
    expect(body).toContain("raise exception 'account lifecycle subject-hash contract unavailable or changed'");

    const hashContract = dbContract.functions.find(
      (entry) => entry.sig === "private.member_lifecycle_subject_hash(p_user_id uuid)",
    );
    expect(hashContract?.sourceMd5).toMatch(/^[0-9a-f]{32}$/);
  });

  it("stamps only migration-time legacy rows verified against a live identity under the installed key", () => {
    expect(sql).toContain("where request.subject_hash_key_fingerprint is null");
    expect(sql).toContain("from auth.users u");
    expect(sql).toContain("installed.key_snapshot");
    expect(sql).toContain("= request.subject_hash");
    expect(sql).not.toContain("alter column subject_hash_key_fingerprint set not null");
    expect(sql).toContain("set failure_code = 'subject-key-rotated'");
    expect(sql).toContain("or failure_code is not distinct from 'subject-key-rotated'");
    expect(localProof).toContain("proveLegacyFingerprintUpgrade");
    expect(fingerprintUpgradeProof).toContain("migration-time legacy fingerprint backfill stamps only live identities verified under the installed key");
  });

  it("uses one immutable key snapshot for authorization and every absence comparison", () => {
    const authorize = fnBody(sql, "public.authorize_member_account_deletion(p_confirmation text)");
    const reconcile = fnBody(sql, "public.reconcile_pending_account_deletions(p_limit integer default 25)");
    for (const body of [authorize, reconcile]) {
      expect(body).toContain("select secret.secret, pg_catalog.encode(extensions.digest(secret.secret, 'sha256'), 'hex')");
      expect(body).toContain("into key_snapshot");
      expect(body).toContain("key_snapshot, 'sha256'");
      expect(body).not.toMatch(/private\.member_lifecycle_subject_hash\((caller|u\.id)\)/);
    }
  });

  it("strands a rotated-key request per row instead of aborting every future run", () => {
    const body = fnBody(sql, "public.reconcile_pending_account_deletions(p_limit integer default 25)");
    // The removed whole-table guard used this alias. If it ever returns, one
    // stale row disables reconciliation fleet-wide again.
    expect(body).not.toContain("active_request");
    expect(body).toContain("set failure_code = 'subject-key-rotated'");
    expect(body).toContain("stranded.subject_hash_key_fingerprint is distinct from current_key_fingerprint");
    expect(body).toContain("for update skip locked");
    // Parked, never completed: the row keeps its processing status and gains
    // no finalized_at, and the marker is withdrawn when the key returns.
    expect(body).toContain("stranded.status in ('authorized', 'processing')");
    expect(body).toContain("stranded.auth_deleted_at is null");
    expect(body).toContain("recovered.subject_hash_key_fingerprint = current_key_fingerprint");
    // The global arms stay global: a missing secret or a drifted installed
    // routine still fails the whole run closed.
    expect(body).toContain("if key_snapshot is null");
    expect(body).toContain("raise exception 'account lifecycle subject-hash contract unavailable or changed'");
  });

  it("proves per-row parking on a live database, not only in the migration text", () => {
    expect(localProof).toContain("proveStrandedRequestIsParkedPerRow");
    expect(localProof).toContain("subject-key-rotated");
    expect(localProof).toContain("a stranded request must not abort the run");
    expect(localProof).toContain("the healthy request must still reach a terminal state alongside a stranded row");
    expect(localProof).toContain("restoring the key must withdraw the stale park marker");
  });

  it("proves the absence arm never finalizes a processing request for a live Auth identity", () => {
    expect(localProof).toContain("living:");
    expect(localProof).toContain("liveRequest.status === \"processing\"");
    expect(localProof).toContain("liveCompletedEvents.rows[0].n === 0");
  });

  it("proves capped concurrent reconciliation and exactly-once completion audit", () => {
    expect(localProof).toContain("Promise.all");
    expect(localProof).toContain("concurrent reconciliation");
    expect(localProof).toContain("deletion_completed");
    expect(localProof).toContain("exactly once");
  });

  it("proves monitoring is closed-class, redacted, idempotent, and terminal-first", () => {
    expect(localProof).toContain("expectInvalidMonitoringFailureClass");
    expect(localProof).toContain("monitoring.row_count === 1");
    expect(localProof).toContain('monitoring.status === "completed"');
    expect(localProof).toContain('monitoring.failure_code === null');
    expect(localProof).toContain("Account deletion reconciliation recorded.");
  });
});
