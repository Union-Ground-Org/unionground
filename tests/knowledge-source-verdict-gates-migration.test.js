// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

// Text pins for 20260906024000, the third slice-4 repair.
//
// 20260906020000 exempted `public.search_member_kb` and the review snapshot as
// "not Storage-backed". 20260903030000 had already given
// `public.member_kb_articles` and `public.member_kb_article_revisions` a
// `knowledge_source_id` pointing at an `organization-knowledge` object, so an
// imported CBA clause IS Storage-derived text: once the extractor had run,
// nothing consulted the ledger again and a stale, failed, blocked or deleted
// source stayed indexed, reviewable, publishable and retrievable.
//
// The live-database twins are `npm run verify:db` (bodyMd5 + bodyContains on
// every function below) and the two proofs added to
// tests/private-file-workflow-gates-db.test.js. This file is what keeps the
// intent readable and fails first if someone drops a conjunct.
const NAME = "20260906024000_knowledge_source_verdict_gates";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const body = (name) => stripComments(fnBody(code, name));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const entry = (sig) => {
  const found = contract.functions.find((candidate) => candidate.sig === sig);
  expect(found, `${sig} must be registered in the DB contract`).toBeTruthy();
  return found;
};

describe("knowledge source verdict gates migration", () => {
  it("runs as one forward-only transaction after every gate it completes", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    const names = migrationNames();
    for (const earlier of [
      "20260903030000_cba_ingestion_completion.sql",
      "20260903040000_knowledge_collection_chapter_snapshot.sql",
      "20260904223603_compass_private_source_minimization.sql",
      "20260906020000_private_upload_workflow_gates.sql",
      "20260906023000_gate_legacy_registration_rpcs.sql",
    ]) {
      expect(names.indexOf(`${NAME}.sql`), `${NAME} must apply after ${earlier}`)
        .toBeGreaterThan(names.indexOf(earlier));
    }
  });

  it("keeps private.private_upload_is_current the only predicate either helper consults", () => {
    // Invariant 7. A second expression for "is this file safe" is how the two
    // answers start disagreeing, which is the defect this whole record exists
    // to close. Neither helper may read the retired scan_status column either.
    for (const helper of [
      "private.knowledge_source_verdict_current",
      "private.knowledge_source_object_verdict_locked",
    ]) {
      const definition = body(helper);
      expect(definition).toContain("private.private_upload_is_current('organization-knowledge', file.storage_path)");
      expect(definition).not.toContain("scan_status");
      expect(definition).toContain("security definer");
      expect(definition).toContain("set search_path = ''");
    }
  });

  it("fails closed on unresolvable provenance and leaves non-Storage sources alone", () => {
    // Invariant 6. external_url rows, inline `source_kind = 'text'` sources and
    // Google Drive bytes are not in this ledger's scope; an authored article
    // has no provenance at all. Anything the helper cannot resolve is a
    // refusal, never a pass.
    const read = body("private.knowledge_source_verdict_current");
    expect(squash(read)).toContain("if p_source_id is null then return true; end if;");
    expect(squash(read)).toContain("if not found then return false; end if;");
    expect(squash(read)).toContain("if file.storage_kind is distinct from 'organization_storage' then return true; end if;");
    expect(squash(read)).toContain("if file.storage_path is null then return false; end if;");
  });

  it("locks the owning Storage row before the write-side recheck reads the verdict", () => {
    // The lock ordering IS the fix for the authorization-versus-completion
    // race: reading the predicate first and locking afterwards would leave the
    // same TOCTOU window that authorize_knowledge_ingest already had.
    const write = squash(body("private.knowledge_source_object_verdict_locked"));
    const lockAt = write.indexOf("from storage.objects o");
    const forUpdateAt = write.indexOf("for update");
    const predicateAt = write.indexOf("return private.private_upload_is_current(");
    expect(lockAt).toBeGreaterThan(-1);
    expect(forUpdateAt).toBeGreaterThan(lockAt);
    expect(predicateAt).toBeGreaterThan(forUpdateAt);
    expect(write).toContain("if locked_object_id is null then return false; end if;");
  });

  it("rechecks the verdict inside both service-role completion RPCs before anything is written", () => {
    for (const [rpc, writeMarker] of [
      ["public.replace_knowledge_source_chunks", "delete from public.organization_knowledge_chunks"],
      ["public.replace_cba_knowledge_drafts", "pg_catalog.pg_advisory_xact_lock"],
    ]) {
      const definition = squash(body(rpc));
      const gateAt = definition.indexOf("if not private.knowledge_source_object_verdict_locked(p_organization_id, source.id) then");
      expect(gateAt, `${rpc} must recheck the verdict`).toBeGreaterThan(-1);
      expect(definition.slice(gateAt)).toContain("file inspection required");
      expect(definition.indexOf(writeMarker), `${rpc} must recheck BEFORE it writes`)
        .toBeGreaterThan(gateAt);
      // The caller never names the file: it is derived from p_source_id.
      expect(definition).not.toContain("p_bucket_id");
      expect(definition).not.toContain("p_object_name");
      expect(definition).not.toContain("p_storage_path");
    }
  });

  it("gates every storage-derived snapshot, review, publication and retrieval surface", () => {
    expect(body("public.list_knowledge_review_articles_snapshot"))
      .toContain("private.knowledge_source_verdict_current(article.knowledge_source_id)");
    const revisions = body("public.list_chapter_kb_revisions");
    expect(revisions).toContain("private.knowledge_source_verdict_current(article.knowledge_source_id)");
    expect(revisions).toContain("private.knowledge_source_verdict_current(source.knowledge_source_id)");
    const restore = squash(body("public.restore_chapter_kb_revision"));
    expect(restore).toContain("if not private.knowledge_source_verdict_current(article.knowledge_source_id) or not private.knowledge_source_verdict_current(revision.knowledge_source_id) then");
    expect(restore).toContain("file inspection required");
  });

  it("binds Compass retrieval to provenance without disturbing anything else it already scoped", () => {
    const search = body("public.search_member_kb");
    expect(squash(search)).toContain("and private.knowledge_source_verdict_current(a.knowledge_source_id)");
    // The conjunct belongs to the member_kb_articles branch alone. Rights
    // lessons and chapter documents have no Storage provenance.
    expect(search).not.toContain("knowledge_source_verdict_current(l.");
    expect(search).not.toContain("knowledge_source_verdict_current(d.");
    // Every earlier scope survives, and it stays security INVOKER (UB-RGT-01/02).
    expect(squash(search)).toContain("security invoker");
    expect(search).not.toMatch(/security\s+definer/i);
    expect(search).toContain("a.chapter_id = private.current_member_chapter()");
    expect(search).toContain("d.chapter_id = private.current_member_chapter()");
    expect(search).not.toContain("from public.member_cases");
    expect(squash(search)).toContain("least(greatest(coalesce(p_limit, 4), 1), 6) as lim");
  });

  it("does not resurrect the paginated review reader 20260903040000 deliberately dropped", () => {
    // Its statement-consistent snapshot replacement is the live reader, and the
    // contract records the paginated signature as absent. Re-creating it while
    // adding a conjunct would have silently reopened a cursor a concurrent CBA
    // reconciliation can move between pages.
    expect(code).not.toContain("list_knowledge_review_articles_page");
    expect(contract.functionsAbsent.some((absent) =>
      absent.sig === "public.list_knowledge_review_articles_page(text, integer, uuid)")).toBe(true);
  });

  it("separates a stale session from a row it will not talk about, without widening the oracle", () => {
    // The row-shaped refusals MUST stay merged: unknown, foreign, removed and
    // unauthorized all answer one 42501, or the endpoint becomes a
    // file-existence oracle. The session refusal is not row-shaped at all — it
    // is decided before p_file_id is read — so answering it distinctly leaks
    // nothing and is what lets native durable recovery stop treating a deleted
    // row as a reason to reauthenticate forever.
    const authorize = squash(body("public.authorize_private_upload_inspection"));
    const sessionAt = authorize.indexOf("if not private.mfa_satisfied() then return pg_catalog.jsonb_build_object('reauthRequired', true); end if;");
    expect(sessionAt).toBeGreaterThan(-1);
    // Before the file lookup, before the Storage lock, before the quota charge.
    for (const later of [
      "if p_kind = 'case' then",
      "select * into object from storage.objects",
      "insert into private.private_upload_inspection_limits",
    ]) {
      expect(authorize.indexOf(later), `${later} must come after the session answer`).toBeGreaterThan(sessionAt);
    }
    // A caller that is not an authenticated end user is still refused outright.
    expect(authorize).toContain("if (select auth.role()) is distinct from 'authenticated' or actor is null then raise exception 'file unavailable' using errcode = '42501'; end if;");
    // And exactly one merged refusal still covers every row-shaped case.
    expect(authorize).toContain("if target is null or allowed is distinct from true then raise exception 'file unavailable' using errcode = '42501'; end if;");
    expect(authorize.match(/raise exception 'file unavailable'/g)).toHaveLength(3);
  });

  it("re-states every grant it touches and pins each body in the DB contract", () => {
    for (const [signature, grantee] of [
      ["private.knowledge_source_verdict_current(uuid)", "authenticated, service_role"],
      ["private.knowledge_source_object_verdict_locked(uuid, uuid)", "service_role"],
      ["public.replace_knowledge_source_chunks(uuid, uuid, uuid, jsonb, text)", "service_role"],
      ["public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)", "service_role"],
      ["public.list_knowledge_review_articles_snapshot(text)", "authenticated"],
      ["public.list_chapter_kb_revisions(uuid, text)", "authenticated"],
      ["public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text)", "authenticated"],
      ["public.authorize_private_upload_inspection(text, uuid)", "authenticated"],
    ]) {
      expect(squash(code), `${signature} must be revoked before it is granted`)
        .toContain(`revoke all on function ${signature} from public, anon, authenticated, service_role;`);
      expect(squash(code), `${signature} must be granted to ${grantee}`)
        .toContain(`grant execute on function ${signature} to ${grantee};`);
    }
    expect(squash(code)).toContain("revoke all on function public.search_member_kb(text, integer) from public, anon;");
    expect(squash(code)).toContain("grant execute on function public.search_member_kb(text, integer) to authenticated;");

    for (const sig of [
      "private.knowledge_source_verdict_current(p_source_id uuid)",
      "private.knowledge_source_object_verdict_locked(p_organization_id uuid, p_source_id uuid)",
      "public.replace_knowledge_source_chunks(p_organization_id uuid, p_source_id uuid, p_actor_user_id uuid, p_chunks jsonb, p_error_code text)",
      "public.replace_cba_knowledge_drafts(p_organization_id uuid, p_source_id uuid, p_actor_user_id uuid, p_chapter_id text, p_articles jsonb)",
      "public.list_knowledge_review_articles_snapshot(p_chapter_id text)",
      "public.list_chapter_kb_revisions(p_article_id uuid, p_chapter_id text)",
      "public.restore_chapter_kb_revision(p_article_id uuid, p_revision_id bigint, p_confirm_verified boolean, p_idempotency_key uuid, p_chapter_id text)",
      "public.search_member_kb(p_query text, p_limit integer)",
      "public.authorize_private_upload_inspection(p_kind text, p_file_id uuid)",
    ]) {
      expect(entry(sig).bodyMd5, `${sig} must carry a refreshed bodyMd5`).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(entry("public.replace_knowledge_source_chunks(p_organization_id uuid, p_source_id uuid, p_actor_user_id uuid, p_chunks jsonb, p_error_code text)").bodyForbids)
      .toContain("scan_status");
  });

  it("reloads the PostgREST schema cache so the replaced RPCs are reachable", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});
