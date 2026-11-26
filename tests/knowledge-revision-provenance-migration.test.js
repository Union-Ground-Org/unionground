// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";
import { provenanceTouchesAfter } from "./helpers/knowledge-provenance.js";

// Text pins for 20260906028000, the sixth slice-4 repair.
//
// Round-2 review of d530dada found the quarantine-lifecycle escape still open
// through two revision-history paths:
//
//   * 20260903030000's equality constraint forced every POSITIVE-version
//     revision to knowledge_source_id = NULL, and a null source is read as
//     "authored, nothing to check". So a lapsed source's published text stayed
//     listable and republishable once the article had moved to a clean
//     replacement source, and restore coalesced the null onto that clean
//     source's provenance.
//   * restore_chapter_kb_revision cached to_jsonb(restored) — title,
//     article_ref, body, keywords — and returned it BEFORE any provenance or
//     existence check, so replaying an idempotency key after the source lapsed
//     served the derived text with the ledger never consulted.
//
// The live-database twins are `npm run verify:db` (bodyMd5, bodyContains and
// bodyForbids on every function below, plus the four new constraints) and the
// two proofs added to tests/private-file-workflow-gates-db.test.js. This file
// is what keeps the intent readable and fails first if someone drops a
// conjunct, a column or an ordering.
const NAME = "20260906028000_knowledge_revision_provenance";

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

describe("knowledge revision provenance migration", () => {
  it("runs as one forward-only transaction after every migration it supersedes", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    const names = migrationNames();
    for (const earlier of [
      "20260829044000_mi1_knowledge_library_sample_activation.sql",
      "20260903030000_cba_ingestion_completion.sql",
      "20260906024000_knowledge_source_verdict_gates.sql",
      "20260906026000_knowledge_read_path_verdict_gates.sql",
      "20260906027000_retire_article_verdict_gate.sql",
    ]) {
      expect(names.indexOf(`${NAME}.sql`), `${NAME} must apply after ${earlier}`)
        .toBeGreaterThan(names.indexOf(earlier));
    }
    // Every later migration whose executable SQL names an object the three
    // provenance migrations declare or alter must be one a reviewer checked
    // against the pins in this file (tests/helpers/knowledge-provenance.js).
    // Derived rather than hand-listed, so a migration that names none of them
    // needs no edit here; see that helper for how to add one that does.
    const { actual, reviewed } = provenanceTouchesAfter(`${NAME}.sql`);
    expect(actual, "a later migration names a knowledge provenance object; review it against these pins and record it in tests/helpers/knowledge-provenance.js").toEqual(reviewed);
  });

  it("adds an explicit content-origin discriminator with no default that could imply authored", () => {
    expect(squash(code)).toContain("alter table public.member_kb_article_revisions add column content_origin text;");
    // A DEFAULT is precisely the mechanism by which a future writer would
    // classify Storage-derived text as authored by omission.
    expect(code).not.toMatch(/content_origin\s+text\s+(not null\s+)?default/i);
    expect(squash(code)).toContain("alter column content_origin set not null");
  });

  it("replaces the equality constraint that erased per-revision provenance", () => {
    expect(squash(code)).toContain("drop constraint member_kb_article_revisions_import_candidate_complete");
    const squashed = squash(code);
    expect(squashed).toContain("add constraint member_kb_article_revisions_content_origin_known check (content_origin in ('authored', 'derived', 'unresolved'))");
    // A version-zero candidate is derived and names its exact source.
    expect(squashed).toContain("add constraint member_kb_article_revisions_candidate_is_derived check ( import_candidate_key is null or (content_origin = 'derived' and knowledge_source_id is not null) )");
    // The point of the repair: a DERIVED revision of ANY version must name the
    // source it came out of, so each row is gated on its own provenance.
    expect(squashed).toContain("add constraint member_kb_article_revisions_derived_names_its_source check (content_origin <> 'derived' or knowledge_source_id is not null)");
    expect(squashed).toContain("add constraint member_kb_article_revisions_authored_has_no_source check (content_origin <> 'authored' or knowledge_source_id is null)");
    // ...and the retired constraint is recorded as absent so it cannot return.
    expect(contract.constraintsAbsent.some((absent) =>
      absent.table === "member_kb_article_revisions"
      && absent.name === "member_kb_article_revisions_import_candidate_complete")).toBe(true);
    for (const name of [
      "member_kb_article_revisions_content_origin_known",
      "member_kb_article_revisions_derived_names_its_source",
      "member_kb_article_revisions_authored_has_no_source",
    ]) {
      expect(contract.constraints.some((pinned) =>
        pinned.table === "member_kb_article_revisions" && pinned.name === name), `${name} must be pinned`).toBe(true);
    }
    // member_kb_article_revisions_candidate_is_derived is the one shape this
    // migration wrote that 20260906029000 had to widen: a version-zero
    // candidate whose ORIGIN could not be proved must be allowed to exist as
    // 'unresolved' so it can be withheld instead of being called derived. The
    // live catalog therefore carries the successor constraint, and this one is
    // recorded as absent rather than silently dropped from the contract.
    expect(contract.constraints.some((pinned) =>
      pinned.table === "member_kb_article_revisions"
      && pinned.name === "member_kb_article_revisions_candidate_is_derived")).toBe(false);
    expect(contract.constraintsAbsent.some((absent) =>
      absent.table === "member_kb_article_revisions"
      && absent.name === "member_kb_article_revisions_candidate_is_derived")).toBe(true);
    expect(contract.constraints.some((pinned) =>
      pinned.table === "member_kb_article_revisions"
      && pinned.name === "member_kb_article_revisions_candidate_origin_known")).toBe(true);
  });

  it("backfills authored only where it is provable and leaves everything else unresolved", () => {
    const squashed = squash(code);
    // Version zero records its own source on the row. Provable.
    expect(squashed).toContain("set content_origin = 'derived' where revision.content_origin is null and revision.import_candidate_key is not null;");
    // Authored requires article-level monotonicity: no source now (so none
    // ever), no import_key, and no revision of that article that ever recorded
    // one. Anything weaker would call a lapsed source's text "authored", which
    // is the escape itself.
    expect(squashed).toContain("set content_origin = 'authored' where revision.content_origin is null and revision.version > 0");
    expect(squashed).toContain("and article.knowledge_source_id is null and article.import_key is null");
    expect(squashed).toContain("where sibling.article_id = revision.article_id and sibling.knowledge_source_id is not null");
    // The residue is withheld, never guessed.
    expect(squashed).toContain("set content_origin = 'unresolved' where revision.content_origin is null;");
    // The predicate is stated in the migration header, not left to be derived.
    expect(sql).toContain("THE EXACT BACKFILL PREDICATE.");
    expect(sql).toContain("MONOTONE");
  });

  it("makes every canonical writer state the origin of the article it snapshots", () => {
    // A staff edit or retirement of derived text does not launder it into
    // authored text: each writer takes the ARTICLE's own current provenance.
    const articleOrigin = "case when article.knowledge_source_id is null then 'authored' else 'derived' end";
    const savedOrigin = "case when saved.knowledge_source_id is null then 'authored' else 'derived' end";
    const cba = body("public.replace_cba_knowledge_drafts");
    expect(cba.split(articleOrigin)).toHaveLength(3);
    expect(cba).toContain("import_candidate_key, knowledge_source_id, content_origin");
    expect(cba.split("candidate_key, p_source_id, 'derived'")).toHaveLength(2);
    expect(cba.split("candidate_key, p_source_id,\n            'derived'")).toHaveLength(2);
    expect(body("public.save_chapter_kb_article")).toContain(savedOrigin);
    expect(body("public.retire_chapter_kb_article")).toContain(savedOrigin);
    expect(body("public.restore_chapter_kb_revision"))
      .toContain("case when restored.knowledge_source_id is null then 'authored' else 'derived' end");
    // The SAMPLE seed writes literal strings shipped in a migration file, so it
    // is authored — stated explicitly rather than inherited from a default.
    expect(body("private.demo_seed_apply_knowledge_library")).toContain("'authored'");
    expect(body("private.demo_seed_apply_knowledge_library")).toContain("content_origin");
  });

  it("covers every insert into member_kb_article_revisions that this head can still execute", () => {
    // The census the reviewer asked for. Each live writer appears here with the
    // column present; if a later migration adds a sixth, this pin is where the
    // omission surfaces.
    for (const writer of [
      "public.replace_cba_knowledge_drafts",
      "public.restore_chapter_kb_revision",
      "public.save_chapter_kb_article",
      "public.retire_chapter_kb_article",
      "private.demo_seed_apply_knowledge_library",
    ]) {
      const definition = body(writer);
      expect(definition, `${writer} must write revisions`).toContain("insert into public.member_kb_article_revisions");
      const inserts = definition.split("insert into public.member_kb_article_revisions").length - 1;
      expect(definition.split("content_origin").length - 1, `${writer} must set content_origin on every insert`)
        .toBeGreaterThanOrEqual(inserts);
    }
  });

  it("gates each derived revision on its own source and hides unresolved history", () => {
    const revisions = squash(body("public.list_chapter_kb_revisions"));
    expect(revisions).toContain("and source.content_origin <> 'unresolved' and private.knowledge_source_verdict_current(source.knowledge_source_id)");
    expect(revisions).toContain("'contentOrigin', revision.content_origin");
    // The article-level conjunct 20260906024000 added is untouched.
    expect(revisions).toContain("private.knowledge_source_verdict_current(article.knowledge_source_id)");
  });

  it("restores a revision onto its own content source and never coalesces onto an unrelated one", () => {
    const restore = squash(body("public.restore_chapter_kb_revision"));
    expect(restore).toContain("if revision.content_origin = 'unresolved' then raise exception 'not found' using errcode = 'P0002'; end if;");
    expect(restore).toContain("restored_source := case when revision.content_origin = 'derived' then revision.knowledge_source_id else null end;");
    expect(restore).toContain("knowledge_source_id = restored_source,");
    expect(restore).toContain("if (restored_source is null) is distinct from (article.knowledge_source_id is null) then");
    // The defect, pinned out by name.
    expect(restore).not.toContain("coalesce(revision.knowledge_source_id, article.knowledge_source_id)");
    // Both verdicts still checked, and the revision's is now meaningful.
    expect(restore).toContain("if not private.knowledge_source_verdict_current(article.knowledge_source_id) or not private.knowledge_source_verdict_current(revision.knowledge_source_id) then");
  });

  it("caches lifecycle metadata only and revalidates the replay BEFORE it answers", () => {
    const restore = body("public.restore_chapter_kb_revision");
    const squashed = squash(restore);
    // ORDER, not presence. The idempotency branch's only return statement is
    // the gated reconstructor, so no cached value can precede a check.
    expect(squashed).toContain("if cached_request is distinct from request_payload then raise exception 'idempotency key reused for a different request' using errcode = '22023'; end if; return private.knowledge_revision_restore_receipt(chapter, cached);");
    expect(restore).not.toContain("return cached;");
    // Nothing content-bearing is ever written into a receipt.
    expect(restore).not.toContain("cached := pg_catalog.to_jsonb");
    for (const stored of ["'articleId'", "'newVersion'", "'status'", "'restoredRevisionId'", "'action'"]) {
      expect(restore, `the lifecycle receipt must carry ${stored}`).toContain(stored);
    }
    expect(squashed.indexOf("insert into private.mi1_w2_operation_receipts"))
      .toBeGreaterThan(squashed.indexOf("lifecycle := pg_catalog.jsonb_build_object("));
    expect(restore).toContain("p_idempotency_key, request_payload, lifecycle");
    // The receipt is bound to the actor.
    expect(squashed).toContain("'actorId', actor");
  });

  it("makes the replay reconstructor refuse content and re-read through the gate", () => {
    const replay = squash(body("private.knowledge_revision_restore_receipt"));
    for (const contentKey of ["'title'", "'article_ref'", "'body'", "'keywords'"]) {
      expect(replay, `a receipt carrying ${contentKey} must be refused`).toContain(`or p_receipt ? ${contentKey}`);
    }
    expect(replay).toContain("and source.chapter_id = p_chapter_id and not source.is_sample");
    expect(replay).toContain("if not private.knowledge_source_verdict_current(article.knowledge_source_id) then raise exception 'file inspection required' using errcode = '42501'; end if;");
    expect(replay).toContain("return pg_catalog.to_jsonb(article);");
    // It reads no receipt of its own: the caller hands it the stored value.
    expect(replay).not.toContain("mi1_w2_operation_receipts");
    expect(squash(code)).toContain("revoke all on function private.knowledge_revision_restore_receipt(text, jsonb) from public, anon, authenticated, service_role;");
    expect(code).not.toContain("grant execute on function private.knowledge_revision_restore_receipt");
  });

  it("corrects the retirement comment that claimed the article-row lock serialized verdict changes", () => {
    const retirement = fnBody(sql, "public.retire_chapter_kb_article");
    expect(retirement).not.toContain("so a concurrent\n  -- verdict change cannot land between the answer and the projection below");
    expect(retirement).toContain("It does NOT serialize this");
    expect(retirement).toContain("ordinary statement-snapshot behaviour");
    expect(retirement).toContain("private.knowledge_source_object_verdict_locked");
  });

  it("re-states every grant it touches and pins each body in the DB contract", () => {
    for (const [signature, grantee] of [
      ["public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)", "service_role"],
      ["public.list_chapter_kb_revisions(uuid, text)", "authenticated"],
      ["public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text)", "authenticated"],
      ["public.retire_chapter_kb_article(uuid, text)", "authenticated"],
    ]) {
      expect(squash(code), `${signature} must be revoked before it is granted`)
        .toContain(`revoke all on function ${signature} from public, anon, authenticated, service_role;`);
      expect(squash(code), `${signature} must be granted to ${grantee}`)
        .toContain(`grant execute on function ${signature} to ${grantee};`);
    }
    expect(squash(code)).toContain("revoke all on function public.save_chapter_kb_article( uuid, text, text, text, text, text[], text, boolean, text ) from public, anon, authenticated, service_role;");
    expect(squash(code)).toContain("grant execute on function public.save_chapter_kb_article( uuid, text, text, text, text, text[], text, boolean, text ) to authenticated;");
    expect(squash(code)).toContain("revoke all on function private.demo_seed_apply_knowledge_library(text, uuid) from public, anon, authenticated, service_role;");

    for (const sig of [
      "private.knowledge_revision_restore_receipt(p_chapter_id text, p_receipt jsonb)",
      "public.replace_cba_knowledge_drafts(p_organization_id uuid, p_source_id uuid, p_actor_user_id uuid, p_chapter_id text, p_articles jsonb)",
      "public.list_chapter_kb_revisions(p_article_id uuid, p_chapter_id text)",
      "public.restore_chapter_kb_revision(p_article_id uuid, p_revision_id bigint, p_confirm_verified boolean, p_idempotency_key uuid, p_chapter_id text)",
      "public.save_chapter_kb_article(p_article_id uuid, p_kind text, p_title text, p_article_ref text, p_body text, p_keywords text[], p_status text, p_confirm_verified boolean, p_chapter_id text)",
      "public.retire_chapter_kb_article(p_article_id uuid, p_chapter_id text)",
    ]) {
      expect(entry(sig).bodyMd5, `${sig} must carry a refreshed bodyMd5`).toMatch(/^[0-9a-f]{32}$/);
    }
    // The order pin lives in the contract too, not only in this file.
    const restore = entry("public.restore_chapter_kb_revision(p_article_id uuid, p_revision_id bigint, p_confirm_verified boolean, p_idempotency_key uuid, p_chapter_id text)");
    expect(restore.bodyForbids).toContain("return cached;");
    expect(restore.bodyForbids).toContain("knowledge_source_id = coalesce(revision.knowledge_source_id, article.knowledge_source_id)");
    expect(restore.bodyContains).toContain("return private.knowledge_revision_restore_receipt(chapter, cached);");
    expect(restore.note).toContain("ORDER");
    expect(entry("private.knowledge_revision_restore_receipt(p_chapter_id text, p_receipt jsonb)").exec).toBe("");
  });

  it("reloads the PostgREST schema cache so the replaced RPCs are reachable", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});
