// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";
import { provenanceTouchesAfter } from "./helpers/knowledge-provenance.js";

// Text pins for 20260906029000, the seventh slice-4 repair.
//
// Round-3 review of 99e26d26 found ONE path still open. When a replacement
// agreement B omits a published clause, replace_cba_knowledge_drafts stages a
// version-zero retirement candidate by COPYING THE ARTICLE'S OWN TEXT — text
// derived from source A — and 20260906028000 stamped that copy
// knowledge_source_id = p_source_id, i.e. B. Confirming it wrote A's language
// onto the article under B's provenance and minted a canonical retirement
// revision naming B, so once A lapsed while B stayed current the A-derived
// history remained listable and restorable through the very gates that were
// added to stop exactly that.
//
// The repair separates CONTENT provenance (knowledge_source_id — where the
// bytes came from) from DECISION provenance (reconciled_by_source_id — which
// reconciliation staged the candidate). The live-database twins are
// `npm run verify:db` (bodyMd5 plus the new column, constraints and index) and
// the omitted-clause proof in tests/private-file-workflow-gates-db.test.js.
// This file keeps the intent readable and fails first if a conjunct, a column
// or an ordering is dropped.
const NAME = "20260906029000_retirement_candidate_provenance";

const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
// Section 1 verbatim and then comment-free: the column, the drop, the three
// backfill UPDATEs and the replacement constraints. The round-4 pins below read
// THIS, not the whole file, because the file is allowed to DISCUSS changed_at
// in its header and the executable classifier is not allowed to touch it.
const classification = stripComments(sql.slice(
  sql.indexOf("alter table public.member_kb_article_revisions\n  add column reconciled_by_source_id"),
  sql.indexOf("-- 2. CBA reconciliation"),
));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const body = (name) => stripComments(fnBody(code, name));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const header = sql.slice(0, sql.indexOf("set local lock_timeout"));
const entry = (sig) => {
  const found = contract.functions.find((candidate) => candidate.sig === sig);
  expect(found, `${sig} must be registered in the DB contract`).toBeTruthy();
  return found;
};

describe("retirement candidate provenance migration", () => {
  it("runs as one forward-only transaction after every migration it supersedes", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    const names = migrationNames();
    for (const earlier of [
      "20260903030000_cba_ingestion_completion.sql",
      "20260906024000_knowledge_source_verdict_gates.sql",
      "20260906027000_retire_article_verdict_gate.sql",
      "20260906028000_knowledge_revision_provenance.sql",
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

  it("adds the decision-source column with a real FK and no default", () => {
    expect(squash(code)).toContain(
      "alter table public.member_kb_article_revisions add column reconciled_by_source_id uuid"
      + " references public.organization_knowledge_sources(id) on delete restrict;",
    );
    // A default is exactly how a future writer would let a candidate inherit
    // somebody else's reconciliation, which is the mistake being repaired.
    expect(code).not.toMatch(/reconciled_by_source_id\s+uuid[^;]*default/i);
  });

  it("makes the decision column an iff over version-zero candidates", () => {
    const squashed = squash(code);
    expect(squashed).toContain(
      "add constraint member_kb_article_revisions_reconciled_by_is_candidate check ("
      + " (reconciled_by_source_id is not null) = (import_candidate_key is not null) )",
    );
    // Only candidates may carry it, and every candidate must: a canonical
    // revision naming a reconciliation would be a second content-ish source on
    // a row that already states its own, and a candidate without one loses the
    // fact this migration exists to record.
    expect(contract.constraints.some((pinned) =>
      pinned.table === "member_kb_article_revisions"
      && pinned.name === "member_kb_article_revisions_reconciled_by_is_candidate")).toBe(true);
  });

  it("widens the candidate shape so an unprovable origin can be withheld, not called derived", () => {
    const squashed = squash(code);
    expect(squashed).toContain("drop constraint member_kb_article_revisions_candidate_is_derived");
    expect(squashed).toContain(
      "add constraint member_kb_article_revisions_candidate_origin_known check ("
      + " import_candidate_key is null"
      + " or (content_origin = 'derived' and knowledge_source_id is not null)"
      + " or (content_origin = 'unresolved' and knowledge_source_id is null) )",
    );
    // An unresolved row names NO source at all, at any version. Naming one is
    // how a guess re-enters, and a null source keeps the row inert.
    expect(squashed).toContain(
      "add constraint member_kb_article_revisions_unresolved_names_no_source"
      + " check (content_origin <> 'unresolved' or knowledge_source_id is null)",
    );
    for (const name of [
      "member_kb_article_revisions_candidate_origin_known",
      "member_kb_article_revisions_unresolved_names_no_source",
    ]) {
      expect(contract.constraints.some((pinned) =>
        pinned.table === "member_kb_article_revisions" && pinned.name === name), `${name} must be pinned`).toBe(true);
    }
    expect(contract.constraintsAbsent.some((absent) =>
      absent.table === "member_kb_article_revisions"
      && absent.name === "member_kb_article_revisions_candidate_is_derived")).toBe(true);
  });

  // Statement ORDER, not just statement presence. The backfill writes
  // ('unresolved', null) onto rows that carry an import_candidate_key, which is
  // exactly what 20260906028000's member_kb_article_revisions_candidate_is_derived
  // forbids, so the drop has to happen first or the migration aborts on the
  // first candidate it cannot attribute — on a database with real history, and
  // only there, which is why no gate in this repository saw it. The live twin
  // is the backfill replay in tests/private-file-workflow-gates-db.test.js.
  it("drops the old candidate check before the backfill and adds the new ones after it", () => {
    const dropAt = code.indexOf("drop constraint member_kb_article_revisions_candidate_is_derived");
    const firstWithholding = code.indexOf("content_origin = 'unresolved'");
    // The residue UPDATE is the last of the three; its coalesce is unique.
    const lastBackfill = code.indexOf(
      "coalesce(revision.reconciled_by_source_id, revision.knowledge_source_id)",
    );
    expect(dropAt, "the pre-repair candidate check must be dropped").toBeGreaterThan(-1);
    expect(firstWithholding, "the backfill must withhold what it cannot place").toBeGreaterThan(-1);
    expect(lastBackfill, "the residue UPDATE must still be the last backfill statement").toBeGreaterThan(-1);
    expect(dropAt, "the drop must precede every statement that writes 'unresolved'")
      .toBeLessThan(firstWithholding);
    // ...and the three replacements must land only once the backfill has given
    // every candidate its decision source: reconciled_by_is_candidate is false
    // of every pre-existing candidate until then.
    for (const added of [
      "add constraint member_kb_article_revisions_candidate_origin_known",
      "add constraint member_kb_article_revisions_unresolved_names_no_source",
      "add constraint member_kb_article_revisions_reconciled_by_is_candidate",
    ]) {
      expect(code.indexOf(added), `${added} must be added after the backfill`).toBeGreaterThan(lastBackfill);
    }
    // The drop stands alone rather than riding the ALTER TABLE that adds them.
    expect(squash(code)).toContain(
      "alter table public.member_kb_article_revisions"
      + " drop constraint member_kb_article_revisions_candidate_is_derived;",
    );
    expect(squash(code)).not.toContain(
      "drop constraint member_kb_article_revisions_candidate_is_derived,",
    );
    // And the reason is written where the operator reads it.
    expect(header).toContain("the old constraint is dropped BEFORE the first");
  });

  // ROUND 4. The predicate this file used to pin — "no positive-version
  // revision with changed_at >= the candidate's changed_at" — was not a proof
  // of anything. changed_at defaults to now(), which PostgreSQL fixes at
  // TRANSACTION START, so a source-moving transaction (restore of a positive
  // revision) can begin first, block on the article row, and commit after the
  // candidate transaction, leaving a canonical revision with an EARLIER
  // changed_at. The predicate would then have stamped text copied under source
  // A with the article's later source C. The repair is conservative rather
  // than cleverer: no timestamp participates at all.
  it("keeps every timestamp out of the backfill's classification", () => {
    for (const forbidden of [
      "changed_at", "updated_at", "created_at", "verified_at",
      "now(", "clock_timestamp", "transaction_timestamp", "statement_timestamp",
      "xmin", "ctid", "interval",
    ]) {
      expect(classification, `the classifier must not read ${forbidden}`).not.toContain(forbidden);
    }
    // Nor may it reach the article at all: the article's CURRENT source is the
    // guess that had to be justified by an ordering, and there is no ordering.
    expect(classification).not.toContain("member_kb_articles");
    expect(classification).not.toContain("attributable");
    expect(classification).not.toContain("import_key");
    // The whole classifier is four columns of the row itself.
    for (const column of ["version", "status", "import_candidate_key", "knowledge_source_id"]) {
      expect(classification).toContain(column);
    }
  });

  it("withholds every legacy retirement candidate and keeps only its decision source", () => {
    const squashed = squash(classification);
    // version 0 + status 'retired' is the retirement shape, and ALL of it is
    // withheld. The value the pre-repair writer left in the content column is
    // the RECONCILING agreement, so it moves; the content column is cleared.
    expect(squashed).toContain(
      "update public.member_kb_article_revisions revision"
      + " set reconciled_by_source_id = revision.knowledge_source_id,"
      + " knowledge_source_id = null,"
      + " content_origin = 'unresolved'"
      + " where revision.version = 0 and revision.status = 'retired'"
      + " and revision.import_candidate_key is not null"
      + " and revision.knowledge_source_id is not null;",
    );
    // The md5 shape test is gone with the inference it served: a
    // retirement-shaped row and a row of unrecognised shape now land in the
    // same place, so there is nothing left for it to decide.
    expect(squashed).not.toContain("md5");
    expect(squashed).not.toContain("'retire:'");
    // A changed-clause candidate carries the replacement's OWN text — the
    // writer inserted p_source_id's normalized clause, not the article's — so
    // it stays derived on its own source and only gains the decision column.
    expect(squashed).toContain(
      "update public.member_kb_article_revisions revision"
      + " set reconciled_by_source_id = revision.knowledge_source_id"
      + " where revision.version = 0 and revision.status = 'draft'"
      + " and revision.import_candidate_key is not null"
      + " and revision.knowledge_source_id is not null"
      + " and revision.reconciled_by_source_id is null;",
    );
    // Everything else is withheld on the same terms.
    expect(squashed).toContain(
      "set reconciled_by_source_id = coalesce(revision.reconciled_by_source_id, revision.knowledge_source_id),"
      + " knowledge_source_id = null, content_origin = 'unresolved'"
      + " where revision.version = 0 and revision.reconciled_by_source_id is null;",
    );
    // Exactly three UPDATEs, so no fourth statement can quietly re-attribute
    // what these three withheld.
    expect(squashed.split("update public.member_kb_article_revisions")).toHaveLength(4);
  });

  it("states the round-4 correction and the conservative repair in the header", () => {
    expect(header).toContain("THE EXACT BACKFILL PREDICATE");
    expect(header).toContain("A TIMESTAMP IS NOT SERIALIZATION ORDER.");
    expect(header).toContain("PostgreSQL fixes now() at TRANSACTION START");
    expect(header).toContain("EVERY LEGACY RETIREMENT-SHAPED CANDIDATE IS WITHHELD");
    expect(header).toContain("EVERY REMAINING VERSION-ZERO ROW IS WITHHELD ON THE SAME TERMS.");
    expect(header).toContain("THE WRITER INSERTED p_source_id'S OWN");
    // The in-place edit is a controller ruling, not an accident, and the reason
    // a follow-on 030000 was refused is written where the operator reads it.
    expect(header).toContain("ROUND-4 EDITED THIS FILE IN PLACE.");
    expect(header).toContain("applied to no database");
    // And the constraints are claimed to admit exactly this shape.
    expect(header).toContain("NO CONSTRAINT IS LOOSENED TO ALLOW THIS.");
  });

  it("stamps the retirement candidate with the ARTICLE's source and B only as the reconciler", () => {
    const cba = squash(body("public.replace_cba_knowledge_drafts"));
    // The defect, pinned out by name: the retirement insert may not name
    // p_source_id as where the text came from.
    expect(cba).toContain(
      "import_candidate_key, knowledge_source_id, reconciled_by_source_id, content_origin ) values ("
      + " current_article.id, current_article.chapter_id, 0, 'retired', current_article.kind,"
      + " current_article.title, current_article.article_ref, current_article.body,"
      + " current_article.keywords, p_actor_user_id, null, null,"
      + " candidate_key, current_article.knowledge_source_id, p_source_id, 'derived' )",
    );
    expect(cba).not.toContain("candidate_key, p_source_id, 'derived'");
    // The changed-clause candidate is unchanged apart from recording the
    // reconciler: it really does carry the replacement's own text.
    expect(cba).toContain(
      "clean_keywords, p_actor_user_id, null, null, candidate_key, p_source_id, p_source_id, 'derived' )",
    );
    // Both upserts rewrite the decision column, so a re-ingest overwrites the
    // single version-zero slot completely whatever it held before.
    expect(cba.split("reconciled_by_source_id = excluded.reconciled_by_source_id,")).toHaveLength(3);
    // ...and the stale-candidate cleanup is still keyed by article, so a
    // withheld 'unresolved' candidate never blocks the next reconciliation.
    expect(cba).toContain(
      "delete from public.member_kb_article_revisions revision"
      + " where revision.article_id = current_article.id and revision.version = 0"
      + " and revision.import_candidate_key is not null;",
    );
    // Canonical snapshots keep taking the article's own origin, untouched.
    expect(cba.split("case when article.knowledge_source_id is null then 'authored' else 'derived' end"))
      .toHaveLength(3);
  });

  // These two pins read THIS FILE's text, which is what the file is for. The
  // LIVE definitions of both functions moved on in 20260906030000, which routes
  // their article-level checks through private.knowledge_article_content_current
  // and adds the one re-establishment door; scripts/db-contract.json pins the
  // live bodies, and tests/knowledge-article-provenance-migration.test.js pins
  // that file's text.
  it("projects the decision source without moving the gate off content provenance", () => {
    const revisions = squash(body("public.list_chapter_kb_revisions"));
    expect(revisions).toContain("'reconciledBySourceId', revision.reconciled_by_source_id");
    // The gate is unchanged: each row on its own content source, unresolved
    // rows excluded outright, article-level check retained.
    expect(revisions).toContain(
      "and source.content_origin <> 'unresolved'"
      + " and private.knowledge_source_verdict_current(source.knowledge_source_id)",
    );
    expect(revisions).toContain("private.knowledge_source_verdict_current(article.knowledge_source_id)");
    expect(revisions).toContain("'contentOrigin', revision.content_origin");
    expect(revisions).not.toContain("reconciled_by_source_id)");
  });

  it("leaves restore_chapter_kb_revision alone, deliberately and in writing", () => {
    // The confirmation path needs no change once the candidate names A: it
    // already gates on revision.knowledge_source_id and already sets
    // restored_source from the revision's own content source. Re-emitting it
    // would move a live definition for no reason.
    expect(code).not.toContain("function public.restore_chapter_kb_revision");
    expect(code).not.toContain("function public.save_chapter_kb_article");
    expect(code).not.toContain("function public.retire_chapter_kb_article");
    expect(sql).toContain("it is deliberately NOT re-emitted here");
    // The behaviour that falls out of the repair is stated where an operator
    // will look for it, because "confirmation is refused after A lapses" is a
    // deliberate outcome and not an oversight.
    expect(header).toContain("CONFIRMATION SEMANTICS");
    expect(header).toContain("42501 'file inspection required'");
    expect(header).toContain("public.retire_chapter_kb_article remains reachable during a lapse");
  });

  it("records the audit of every reader that treated the candidate's source as the reconciler", () => {
    for (const reader of [
      "public.list_chapter_kb_revisions",
      "public.restore_chapter_kb_revision",
      "public.list_knowledge_review_articles_snapshot",
      "public.retry_knowledge_ingest_source",
      "public.clear_knowledge_ingest_source_chunks",
    ]) {
      expect(header, `${reader} must appear in the version-zero reader audit`).toContain(reader);
    }
    expect(header).toContain("There is no source-deletion RPC at this");
    expect(header).toContain("The set of undeletable sources is therefore unchanged.");
  });

  it("re-states every grant it touches and pins each body in the DB contract", () => {
    for (const [signature, grantee] of [
      ["public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)", "service_role"],
      ["public.list_chapter_kb_revisions(uuid, text)", "authenticated"],
    ]) {
      expect(squash(code), `${signature} must be revoked before it is granted`)
        .toContain(`revoke all on function ${signature} from public, anon, authenticated, service_role;`);
      expect(squash(code), `${signature} must be granted to ${grantee}`)
        .toContain(`grant execute on function ${signature} to ${grantee};`);
    }
    for (const sig of [
      "public.replace_cba_knowledge_drafts(p_organization_id uuid, p_source_id uuid, p_actor_user_id uuid, p_chapter_id text, p_articles jsonb)",
      "public.list_chapter_kb_revisions(p_article_id uuid, p_chapter_id text)",
    ]) {
      expect(entry(sig).bodyMd5, `${sig} must carry a refreshed bodyMd5`).toMatch(/^[0-9a-f]{32}$/);
    }
    const cba = entry("public.replace_cba_knowledge_drafts(p_organization_id uuid, p_source_id uuid, p_actor_user_id uuid, p_chapter_id text, p_articles jsonb)");
    expect(cba.bodyContains).toContain("candidate_key, current_article.knowledge_source_id, p_source_id,");
    expect(cba.bodyForbids).toContain("candidate_key, p_source_id, 'derived'");
    expect(cba.note).toContain("DECISION provenance");
    expect(entry("public.list_chapter_kb_revisions(p_article_id uuid, p_chapter_id text)").bodyContains)
      .toContain("'reconciledbysourceid', revision.reconciled_by_source_id");
  });

  it("reloads the PostgREST schema cache so the replaced RPCs are reachable", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});
