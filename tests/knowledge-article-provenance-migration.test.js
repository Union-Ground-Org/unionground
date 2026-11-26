// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";
import { provenanceTouchesAfter } from "./helpers/knowledge-provenance.js";

// Text pins for 20260906030000, the eighth slice-4 repair.
//
// An adversarial red-team pass over d5adc33c found the provenance repair was
// REVISION-ONLY. 20260906028000 and 20260906029000 gave
// public.member_kb_article_revisions an explicit content origin and withheld
// every row whose true source this schema cannot prove; neither of them — nor
// any of the other ten migrations of this record — contains a single top-level
// statement against public.member_kb_articles. The base-head coalescing restore
// (20260903030000:868) had already been able to put one source's TEXT on the
// article row under another source's id, and every article-level gate read that
// id, answered true, and served the first source's text once it lapsed. The
// revision table declared the same text unattributable while the article row
// served it.
//
// This migration applies the record's own "withhold rather than guess" rule at
// the article level. The live-database twins are `npm run verify:db` (bodyMd5
// plus the new column, constraints, index and policies) and the two proofs in
// tests/private-file-workflow-gates-db.test.js, which build the legacy laundered
// state through the PRE-BRANCH RPCs and then re-apply 028000/029000/030000
// verbatim. This file keeps the intent readable and fails first if a conjunct, a
// column, a refusal shape or an ordering is dropped.
const NAME = "20260906030000_knowledge_article_provenance";

const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
// Section 1 verbatim and then comment-free: the column, the two backfill
// UPDATEs, the shape constraints, the comment and the index. The pins below
// read THIS, not the whole file, because the file is allowed to DISCUSS the
// article's current source in its header and the executable classifier is not
// allowed to consult it.
const classification = stripComments(sql.slice(
  sql.indexOf("alter table public.member_kb_articles\n  add column content_origin text;"),
  sql.indexOf("-- 2. The two predicates"),
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

describe("knowledge article provenance migration", () => {
  it("runs as one forward-only transaction after every migration it supersedes", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    const names = migrationNames();
    for (const earlier of [
      "20260722130441_member_compass_kb_retrieval.sql",
      "20260829044000_mi1_knowledge_library_sample_activation.sql",
      "20260903030000_cba_ingestion_completion.sql",
      "20260906024000_knowledge_source_verdict_gates.sql",
      "20260906026000_knowledge_read_path_verdict_gates.sql",
      "20260906027000_retire_article_verdict_gate.sql",
      "20260906028000_knowledge_revision_provenance.sql",
      "20260906029000_retirement_candidate_provenance.sql",
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
    // No shipped migration's executable content is edited: this is the only
    // file the repair touches, and it is a new one.
    expect(names.filter((name) => name.startsWith("2026090603"))).toEqual([`${NAME}.sql`]);
  });

  it("adds the article discriminator with no default that could imply authored", () => {
    expect(squash(code)).toContain("alter table public.member_kb_articles add column content_origin text;");
    // A default is exactly how a future writer would classify Storage-derived
    // text as authored by omission, which is the mistake being repaired.
    expect(code).not.toMatch(/content_origin\s+text[^;]*default/i);
    expect(squash(code)).toContain(
      "alter table public.member_kb_articles alter column content_origin set not null,");
    expect(squash(code)).toContain(
      "add constraint member_kb_articles_content_origin_known"
      + " check (content_origin in ('authored', 'derived', 'unresolved'))");
    // The two shape constraints mirror the revision table's exactly.
    expect(squash(code)).toContain(
      "add constraint member_kb_articles_derived_names_its_source"
      + " check (content_origin <> 'derived' or knowledge_source_id is not null)");
    expect(squash(code)).toContain(
      "add constraint member_kb_articles_authored_has_no_source"
      + " check (content_origin <> 'authored' or knowledge_source_id is null)");
    for (const name of [
      "member_kb_articles_content_origin_known",
      "member_kb_articles_derived_names_its_source",
      "member_kb_articles_authored_has_no_source",
    ]) {
      expect(contract.constraints.some((pinned) =>
        pinned.table === "member_kb_articles" && pinned.name === name), `${name} must be pinned`).toBe(true);
    }
    expect(contract.indexes.some((pinned) => pinned.name === "member_kb_articles_chapter_origin_idx")).toBe(true);
  });

  // Statement ORDER, not just statement presence — the lesson 20260906029000
  // learned the hard way. `set not null` and every shape constraint describe a
  // table the backfill has not finished writing yet, so on an empty database
  // the order is invisible and on real history it is the difference between a
  // clean cutover and an aborted one. The live twin is the verbatim replay in
  // tests/private-file-workflow-gates-db.test.js.
  it("widens before it withholds, and constrains only after both backfills", () => {
    const addColumn = code.indexOf("add column content_origin text;");
    const authored = code.indexOf("set content_origin = 'authored'");
    const withheld = code.indexOf("set content_origin = 'unresolved'");
    const notNull = code.indexOf("alter column content_origin set not null");
    expect(addColumn).toBeGreaterThan(-1);
    expect(authored).toBeGreaterThan(addColumn);
    expect(withheld).toBeGreaterThan(authored);
    expect(notNull).toBeGreaterThan(withheld);
    for (const added of [
      "add constraint member_kb_articles_content_origin_known",
      "add constraint member_kb_articles_derived_names_its_source",
      "add constraint member_kb_articles_authored_has_no_source",
    ]) {
      expect(code.indexOf(added), `${added} must be added after the backfill`).toBeGreaterThan(withheld);
    }
    // Exactly two UPDATEs against the article table, so no third statement can
    // quietly re-attribute what these two withheld.
    expect(squash(classification).split("update public.member_kb_articles")).toHaveLength(3);
  });

  it("classifies only what article-level monotonicity proves, and withholds the rest", () => {
    const squashed = squash(classification);
    // Authored: no source today, no import key today, and no revision that ever
    // recorded a source. The third conjunct is the same belt-and-braces the
    // 20260906028000 revision backfill uses.
    expect(squashed).toContain(
      "update public.member_kb_articles article"
      + " set content_origin = 'authored'"
      + " where article.content_origin is null"
      + " and article.knowledge_source_id is null"
      + " and article.import_key is null"
      + " and not exists ( select 1"
      + " from public.member_kb_article_revisions revision"
      + " where revision.article_id = article.id"
      + " and revision.knowledge_source_id is not null );",
    );
    // Everything else is withheld, and NOTHING is called derived: there is no
    // fact on any row that would prove a legacy article's text came out of the
    // file it names.
    expect(squashed).toContain(
      "update public.member_kb_articles article"
      + " set content_origin = 'unresolved'"
      + " where article.content_origin is null;",
    );
    // Nothing is CALLED derived by the backfill: no fact on any row proves a
    // legacy article's text came out of the file it names. The two UPDATEs are
    // the only place that could have claimed it, and they do not.
    const backfill = squashed.slice(
      squashed.indexOf("update public.member_kb_articles"),
      squashed.indexOf("alter table public.member_kb_articles alter column"),
    );
    expect(backfill).not.toContain("'derived'");
    // The source value STAYS on a withheld row. Nulling it would make the row
    // MORE visible, because a null source answers true by design (invariant 6).
    expect(squashed).not.toContain("knowledge_source_id = null");
    // And no ordering fact takes part, for the reason 20260906029000 records:
    // now() is transaction-start time, not serialization order.
    for (const forbidden of [
      "changed_at", "updated_at", "created_at", "verified_at",
      "now(", "clock_timestamp", "xmin", "ctid", "interval",
    ]) {
      expect(classification, `the classifier must not read ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("states the predicate, the deliberate breadth and the hosted consequence in the header", () => {
    expect(header).toContain("THE EXACT BACKFILL PREDICATE.");
    expect(header).toContain("THIS IS DELIBERATELY EVERY LEGACY DERIVED ARTICLE, NOT A SUBSET.");
    expect(header).toContain("NULLING knowledge_source_id INSTEAD WOULD BE THE OPPOSITE OF A REPAIR:");
    expect(header).toContain("NO REFUSAL IS AN ORACLE.");
    expect(header).toContain("HOSTED FIRST APPLY.");
    expect(header).toContain("THE COST, STATED RATHER THAN DISCOVERED.");
    // The enumeration is claimed to come from the catalog, not from a scan of
    // migration files — the standard the round-2 census established.
    expect(header).toContain("enumerated from the live catalog rather than from a scan of");
    for (const surface of [
      "public.list_accessible_knowledge_articles_snapshot",
      "member_kb_articles_member_read",
      "member_kb_articles_staff_read",
      "public.search_member_kb",
      "public.list_knowledge_collections",
      "public.set_knowledge_collection_item",
      "public.list_knowledge_review_articles_snapshot",
      "public.save_chapter_kb_article",
      "public.retire_chapter_kb_article",
      "public.list_chapter_kb_revisions",
      "public.restore_chapter_kb_revision",
      "private.knowledge_revision_restore_receipt",
      "public.replace_cba_knowledge_drafts",
      "private.demo_seed_apply_knowledge_library",
      "private.demo_seed_knowledge_library_status",
      "private.demo_seed_remove_knowledge_library",
    ]) {
      expect(header, `${surface} must appear in the article-gate enumeration`).toContain(surface);
    }
  });

  it("routes every article-level gate through the one withholding predicate", () => {
    // The predicate itself is fail-closed on a row that is not there, and it is
    // the only remaining route from an article row to the ledger wrapper.
    const predicate = squash(body("private.knowledge_article_content_current"));
    expect(predicate).toContain("when p_article.id is null then false");
    expect(predicate).toContain("when p_article.content_origin is null then false");
    expect(predicate).toContain("when p_article.content_origin = 'unresolved' then false");
    expect(predicate).toContain(
      "else private.knowledge_source_verdict_current(p_article.knowledge_source_id)");
    for (const [name, needle] of [
      ["public.list_accessible_knowledge_articles_snapshot", "private.knowledge_article_content_current(article)"],
      ["public.search_member_kb", "private.knowledge_article_content_current(a)"],
      ["public.list_knowledge_collections", "private.knowledge_article_content_current(article)"],
      ["public.set_knowledge_collection_item", "private.knowledge_article_content_current(article)"],
      ["public.list_knowledge_review_articles_snapshot", "private.knowledge_article_content_current(article)"],
      ["public.list_chapter_kb_revisions", "private.knowledge_article_content_current(article)"],
      ["public.restore_chapter_kb_revision", "private.knowledge_article_content_current(article)"],
      ["public.save_chapter_kb_article", "private.knowledge_article_content_current(saved)"],
      ["public.retire_chapter_kb_article", "private.knowledge_article_content_current(saved)"],
      ["private.knowledge_revision_restore_receipt", "private.knowledge_article_content_current(article)"],
    ]) {
      const definition = body(name);
      expect(definition, `${name} must read the withholding predicate`).toContain(needle);
      // ...and none of them may still reach the ledger wrapper directly from an
      // ARTICLE row, which is the conjunct the finding was about.
      for (const bypass of [
        "knowledge_source_verdict_current(article.knowledge_source_id)",
        "knowledge_source_verdict_current(a.knowledge_source_id)",
        "knowledge_source_verdict_current(saved.knowledge_source_id)",
      ]) {
        expect(definition, `${name} must not bypass the predicate with ${bypass}`).not.toContain(bypass);
      }
    }
    // Both read policies carry the same whole-row predicate, because
    // `authenticated` holds a direct select grant on the table.
    for (const policy of ["member_kb_articles_member_read", "member_kb_articles_staff_read"]) {
      expect(squash(code)).toContain(`drop policy if exists ${policy} on public.member_kb_articles;`);
      const at = code.indexOf(`create policy ${policy}`);
      expect(at).toBeGreaterThan(-1);
      expect(squash(code.slice(at, code.indexOf(");", at))))
        .toContain("private.knowledge_article_content_current(member_kb_articles)");
    }
    // Since 20261028210000 both are OR branches of member_kb_articles_select,
    // pinned exactly in the contract; each branch keeps the predicate.
    const merged = contract.policies.find((pinned) => pinned.table === "member_kb_articles" && pinned.name === "member_kb_articles_select");
    expect(merged.qual.split("private.knowledge_article_content_current(member_kb_articles.*)"), "both branches pinned in the DB contract")
      .toHaveLength(3);
    // The per-revision gate is untouched: this repair is about the article row.
    expect(body("public.list_chapter_kb_revisions"))
      .toContain("private.knowledge_source_verdict_current(source.knowledge_source_id)");
    expect(body("public.restore_chapter_kb_revision"))
      .toContain("private.knowledge_source_verdict_current(revision.knowledge_source_id)");
  });

  it("refuses a withheld article with the shape an absent one already gets", () => {
    // save and retire: the absent shape, never 'file inspection required',
    // which would report the existence of content being withheld.
    for (const name of ["public.save_chapter_kb_article", "public.retire_chapter_kb_article"]) {
      const definition = squash(body(name));
      expect(definition).toContain("content_origin = 'unresolved' then");
      expect(definition).toContain(
        "raise exception 'knowledge article is not available in this chapter' using errcode = '42501'");
    }
    // ...and save keeps the lapsed-verdict shape it already had, so the two
    // cases stay distinguishable from each other and neither is invented.
    expect(squash(body("public.save_chapter_kb_article")))
      .toContain("raise exception 'file inspection required' using errcode = '42501'");
    // retire still never refuses on a lapse: removal stays reachable and the
    // returned row is body-free.
    const retire = squash(body("public.retire_chapter_kb_article"));
    expect(retire).not.toContain("'file inspection required'");
    expect(retire).toContain("derived_lapsed := not private.knowledge_article_content_current(saved);");
    expect(retire).toContain("saved.body := null;");
    // list_chapter_kb_revisions and restore: the P0002 an absent row gets.
    for (const name of ["public.list_chapter_kb_revisions", "public.restore_chapter_kb_revision"]) {
      expect(squash(body(name))).toContain("raise exception 'not found' using errcode = 'P0002'");
    }
    // The replay reconstructor answers the same two ways as the primary path.
    const receipt = squash(body("private.knowledge_revision_restore_receipt"));
    expect(receipt).toContain("if article.content_origin = 'unresolved' then raise exception 'not found' using errcode = 'P0002'");
    expect(receipt).toContain("raise exception 'file inspection required' using errcode = '42501'");
  });

  it("opens exactly one door out of withholding, and only for an inspected source's own bytes", () => {
    const door = squash(body("private.knowledge_article_reestablishment_candidate"));
    expect(door).toContain("p_article.content_origin = 'unresolved'");
    expect(door).toContain("candidate.version = 0");
    expect(door).toContain("candidate.import_candidate_key is not null");
    // The CHANGED-CLAUSE shape only. A retirement candidate copies the
    // ARTICLE's text, which on a withheld article is the withheld text itself,
    // so it may never open the door.
    expect(door).toContain("candidate.status = 'draft'");
    expect(door).not.toContain("'retired'");
    expect(door).toContain("candidate.content_origin = 'derived'");
    expect(door).toContain("private.knowledge_source_verdict_current(candidate.knowledge_source_id)");
    // Only the two staff review surfaces and restore consult it.
    for (const name of [
      "public.list_knowledge_review_articles_snapshot",
      "public.list_chapter_kb_revisions",
      "public.restore_chapter_kb_revision",
    ]) {
      expect(body(name), `${name} must consult the one door`)
        .toContain("private.knowledge_article_reestablishment_candidate(");
    }
    for (const name of [
      "public.list_accessible_knowledge_articles_snapshot",
      "public.search_member_kb",
      "public.list_knowledge_collections",
      "public.set_knowledge_collection_item",
      "public.save_chapter_kb_article",
      "public.retire_chapter_kb_article",
    ]) {
      expect(body(name), `${name} must NOT open the door`)
        .not.toContain("knowledge_article_reestablishment_candidate");
    }
    // A withheld article listed for review carries THE CANDIDATE's naming, not
    // its own, so no withheld text crosses the boundary to make the pending
    // decision reachable.
    const review = squash(body("public.list_knowledge_review_articles_snapshot"));
    expect(review).toContain(
      "'title', case when candidate.id is null then article.title else candidate.title end");
    expect(review).toContain(
      "'articleRef', case when candidate.id is null then article.article_ref else candidate.article_ref end");
    expect(review).toContain("'contentWithheld', candidate.id is not null");
    // Restore accepts that exact revision and nothing else.
    expect(squash(body("public.restore_chapter_kb_revision"))).toContain(
      "if revision.id is distinct from"
      + " (private.knowledge_article_reestablishment_candidate(article)).id then");
  });

  it("makes every writer state the origin it creates, and never write a withheld one", () => {
    const cba = squash(body("public.replace_cba_knowledge_drafts"));
    // The create branch and the update branch both state 'derived' beside the
    // source, in the same statement.
    expect(cba).toContain("p_source_id, item_key, 'derived' );");
    expect(cba).toContain("knowledge_source_id = p_source_id, content_origin = 'derived',");
    // Canonical snapshots take the article's STATED origin rather than
    // re-deriving it from the source column.
    expect(cba).toContain("article.content_origin, article.knowledge_source_id");
    expect(cba).not.toContain("case when article.knowledge_source_id is null then 'authored' else 'derived' end");
    // RE-ESTABLISHMENT: a withheld article is always treated as changed, and a
    // withheld draft is never skipped as an identical retry. Byte-identity
    // proves nothing about where the withheld bytes came from.
    expect(cba).toContain("if current_article.content_origin = 'unresolved' or current_article.title is distinct from clean_title");
    expect(cba).toContain("and current_article.content_origin <> 'unresolved' and current_article.title is not distinct from clean_title");
    // ...and a withheld article stages no retirement candidate and is not swept
    // into 'retired': both would re-assert the withdrawn provenance claim.
    expect(cba.split("and article.content_origin <> 'unresolved'")).toHaveLength(3);
    // restore writes the article's origin from the revision it restored, so it
    // can only ever resolve a withheld row, never create one.
    const restore = squash(body("public.restore_chapter_kb_revision"));
    expect(restore).toContain(
      "restored_origin := case when restored_source is null then 'authored' else 'derived' end;");
    expect(restore).toContain("content_origin = restored_origin,");
    expect(restore).toContain("restored.content_origin, restored.knowledge_source_id );");
    // save and retire preserve the origin: neither names the column in its
    // UPDATE, and both append a revision carrying the article's own value.
    for (const name of ["public.save_chapter_kb_article", "public.retire_chapter_kb_article"]) {
      expect(squash(body(name))).toContain("saved.content_origin, saved.knowledge_source_id );");
    }
    // A new staff-typed article states 'authored' explicitly.
    expect(squash(body("public.save_chapter_kb_article")))
      .toContain("verified_by, verified_at, updated_at, content_origin )");
    // The SAMPLE seed states it too, rather than leaning on a default.
    const seed = squash(body("private.demo_seed_apply_knowledge_library"));
    expect(seed).toContain("verified_by, verified_at, updated_at, content_origin ) values (");
    expect(seed).toContain("content_origin = excluded.content_origin,");
  });

  it("re-states every grant it touches and pins each replaced body in the DB contract", () => {
    for (const [signature, grantee] of [
      ["public.list_accessible_knowledge_articles_snapshot(boolean, text)", "authenticated"],
      ["public.list_knowledge_collections(text)", "authenticated"],
      ["public.list_knowledge_review_articles_snapshot(text)", "authenticated"],
      ["public.list_chapter_kb_revisions(uuid, text)", "authenticated"],
      ["public.restore_chapter_kb_revision(uuid, bigint, boolean, uuid, text)", "authenticated"],
      ["public.retire_chapter_kb_article(uuid, text)", "authenticated"],
      ["public.replace_cba_knowledge_drafts(uuid, uuid, uuid, text, jsonb)", "service_role"],
    ]) {
      expect(squash(code), `${signature} must be revoked before it is granted`)
        .toContain(`revoke all on function ${signature} from public, anon, authenticated, service_role;`);
      expect(squash(code), `${signature} must be granted to ${grantee}`)
        .toContain(`grant execute on function ${signature} to ${grantee};`);
    }
    // search_member_kb keeps its own narrower revoke, because it is security
    // INVOKER and service_role legitimately holds execute on it.
    expect(squash(code)).toContain("revoke all on function public.search_member_kb(text, integer) from public, anon;");
    // The two new predicates are private, reachable by the roles the gates run
    // as, and never by anon.
    for (const signature of [
      "private.knowledge_article_content_current(public.member_kb_articles)",
      "private.knowledge_article_reestablishment_candidate(public.member_kb_articles)",
    ]) {
      expect(squash(code)).toContain(`revoke all on function ${signature} from public, anon, authenticated, service_role;`);
      expect(squash(code)).toContain(`grant execute on function ${signature} to authenticated, service_role;`);
    }
    for (const sig of [
      "private.knowledge_article_content_current(p_article member_kb_articles)",
      "private.knowledge_article_reestablishment_candidate(p_article member_kb_articles)",
      "public.list_accessible_knowledge_articles_snapshot(p_published_only boolean, p_chapter_id text)",
      "public.search_member_kb(p_query text, p_limit integer)",
      "public.list_knowledge_collections(p_chapter_id text)",
      "public.set_knowledge_collection_item(p_collection_id uuid, p_item_kind text, p_item_id uuid, p_include boolean, p_sort_order integer, p_chapter_id text)",
      "public.list_knowledge_review_articles_snapshot(p_chapter_id text)",
      "public.list_chapter_kb_revisions(p_article_id uuid, p_chapter_id text)",
      "public.restore_chapter_kb_revision(p_article_id uuid, p_revision_id bigint, p_confirm_verified boolean, p_idempotency_key uuid, p_chapter_id text)",
      "public.save_chapter_kb_article(p_article_id uuid, p_kind text, p_title text, p_article_ref text, p_body text, p_keywords text[], p_status text, p_confirm_verified boolean, p_chapter_id text)",
      "public.retire_chapter_kb_article(p_article_id uuid, p_chapter_id text)",
      "public.replace_cba_knowledge_drafts(p_organization_id uuid, p_source_id uuid, p_actor_user_id uuid, p_chapter_id text, p_articles jsonb)",
      "private.knowledge_revision_restore_receipt(p_chapter_id text, p_receipt jsonb)",
    ]) {
      expect(entry(sig).bodyMd5, `${sig} must carry a refreshed bodyMd5`).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(entry("private.knowledge_article_reestablishment_candidate(p_article member_kb_articles)").bodyForbids)
      .toContain("'retired'");
  });

  it("reloads the PostgREST schema cache so the replaced RPCs are reachable", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});
