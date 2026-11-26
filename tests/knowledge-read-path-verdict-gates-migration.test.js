// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

// Text pins for 20260906026000, the fourth slice-4 repair.
//
// 20260906024000 bound the WRITE side of the storage-derived knowledge
// lifecycle and four of its read/publication surfaces. An independent
// verification round then drove one real contract file through
// prepare -> inspect clean -> complete -> replace_cba_knowledge_drafts ->
// restore(publish) on a live disposable database, quarantined it and then
// deleted the object, and found the MEMBER-facing half still open: the article
// snapshot that carries the clause body, the table's own read policies (which
// `authenticated` selects directly, and both clients do), the second
// publication route, and the collection surfaces.
//
// The live-database twins are `npm run verify:db` (bodyMd5 + bodyContains +
// qualContains on everything below) and the extended lifecycle proof in
// tests/private-file-workflow-gates-db.test.js. This file is what keeps the
// intent readable and fails first if someone drops a conjunct.
const NAME = "20260906026000_knowledge_read_path_verdict_gates";
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
const policy = (name) => {
  const found = contract.policies.find(
    (candidate) => candidate.table === "member_kb_articles" && candidate.name === name,
  );
  expect(found, `${name} must be registered in the DB contract`).toBeTruthy();
  return found;
};

describe("knowledge read-path verdict gates migration", () => {
  it("runs as one forward-only transaction after every migration it replaces", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    const names = migrationNames();
    for (const earlier of [
      "20260812110000_chapter_compass_knowledge.sql",
      "20260903034000_knowledge_selected_chapter_scope.sql",
      "20260903040000_knowledge_collection_chapter_snapshot.sql",
      "20260906020000_private_upload_workflow_gates.sql",
      "20260906024000_knowledge_source_verdict_gates.sql",
    ]) {
      expect(names.indexOf(`${NAME}.sql`), `${NAME} must apply after ${earlier}`)
        .toBeGreaterThan(names.indexOf(earlier));
    }
  });

  it("keeps private.private_upload_is_current the only predicate either helper consults", () => {
    // Invariant 7 survives the hardening below: coalescing the ANSWER is not a
    // second expression for "is this file safe", and neither helper may read
    // the retired scan_status column.
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

  it("removes the fail-open NULL shape from both provenance wrappers", () => {
    // private.private_upload_is_current evaluates to NULL, not false, for a
    // session carrying no request.jwt.claims at all, and a guard written
    // `if not <predicate> then raise` does NOT fire on NULL. That was
    // unreachable through every granted entry point, but this migration adds
    // guards in exactly that shape, so the shape goes rather than the audit.
    for (const helper of [
      "private.knowledge_source_verdict_current",
      "private.knowledge_source_object_verdict_locked",
    ]) {
      expect(squash(body(helper)), `${helper} must coalesce the ledger answer`).toContain(
        "return coalesce(private.private_upload_is_current('organization-knowledge', file.storage_path), false);",
      );
    }
    // And the lock still comes before the write-side read.
    const write = squash(body("private.knowledge_source_object_verdict_locked"));
    expect(write.indexOf("for update")).toBeGreaterThan(write.indexOf("from storage.objects o"));
    expect(write.indexOf("return coalesce(private.private_upload_is_current("))
      .toBeGreaterThan(write.indexOf("for update"));
  });

  it("gates the member-facing corpus that actually carries the clause body", () => {
    // p_published_only = true is the Member/Library read and requires no staff
    // role, so this is the surface that was handing quarantined contract text
    // to every member of the chapter. One conjunct covers both branches.
    const snapshot = squash(body("public.list_accessible_knowledge_articles_snapshot"));
    expect(snapshot).toContain("'body', article.body");
    expect(snapshot).toContain("and private.knowledge_source_verdict_current(article.knowledge_source_id)");
    // Every scope it already had survives.
    expect(snapshot).toContain("article.chapter_id = target_chapter");
    expect(snapshot).toContain("not article.is_sample");
    expect(snapshot).toContain("article.status = 'published'");
    expect(snapshot).toContain("private.mi1_w2_same_org_chapter(org, target_chapter)");
  });

  it("puts the same conjunct on the table, because authenticated selects it directly", () => {
    // public.member_kb_articles carries a direct select grant to authenticated
    // and both clients read `body` straight through PostgREST, so gating only
    // the security-definer readers left the gate walkable by the ordinary
    // query the apps already issue.
    for (const name of ["member_kb_articles_member_read", "member_kb_articles_staff_read"]) {
      const created = squash(code).slice(squash(code).indexOf(`create policy ${name}`));
      expect(created.slice(0, 600), `${name} must carry the provenance conjunct`)
        .toContain("and private.knowledge_source_verdict_current(knowledge_source_id)");
      expect(squash(code)).toContain(`drop policy if exists ${name} on public.member_kb_articles;`);
      // The CONTRACT pins the LIVE policy, and 20260906030000 re-created both
      // with the article-level withholding predicate wrapped around the same
      // wrapper: a legacy article whose text cannot be proved to have come from
      // the source it names must not come back through this select either. The
      // conjunct above is still what THIS migration says; the live one is
      // strictly stronger, and dropping it entirely would be caught here.
    }
    // Since 20261028210000 both live reads are OR branches of
    // member_kb_articles_select; each branch keeps the predicate.
    expect(policy("member_kb_articles_select").qual.split("private.knowledge_article_content_current(member_kb_articles.*)"))
      .toHaveLength(3);
    // The member branch keeps its verified-publication boundary and the staff
    // branch keeps its role check: this adds a conjunct, it does not replace one.
    // Both reads are OR branches of the merged policy since 20261028210000.
    const memberPolicy = policy("member_kb_articles_select").qual;
    expect(memberPolicy).toContain("status = 'published'::text");
    expect(memberPolicy).toContain("verified_at IS NOT NULL");
    expect(policy("member_kb_articles_select").qual).toContain(
      "member_has_role(ARRAY['steward'::text, 'coordinator'::text, 'advisor'::text, 'admin'::text, 'vp'::text])",
    );
  });

  it("makes the second publication route refuse exactly what the first one refuses", () => {
    // restore_chapter_kb_revision refused a lapsed article; save_chapter_kb_article
    // updated the same row and set status='published', verified_by and
    // verified_at with no verdict check at all.
    const save = squash(body("public.save_chapter_kb_article"));
    const gateAt = save.indexOf("if not private.knowledge_source_verdict_current(saved.knowledge_source_id) then");
    expect(gateAt, "the update branch must recheck the verdict").toBeGreaterThan(-1);
    expect(save.slice(gateAt)).toContain("file inspection required");
    // Before the update, and after the row is locked, so a concurrent verdict
    // change cannot be published around.
    expect(save.indexOf("update public.member_kb_articles set kind = clean_kind")).toBeGreaterThan(gateAt);
    expect(save.indexOf("for update")).toBeLessThan(gateAt);
    // The insert branch is untouched: a new article has no provenance.
    expect(save.indexOf("insert into public.member_kb_articles (")).toBeLessThan(gateAt);
  });

  it("drops a lapsed article from the collection projection and refuses to add one", () => {
    expect(squash(body("public.list_knowledge_collections")))
      .toContain("and private.knowledge_source_verdict_current(article.knowledge_source_id)");
    // Removal deliberately stays reachable, or a lapse would strand a placement
    // row nobody can see in the projection any more.
    const place = squash(body("public.set_knowledge_collection_item"));
    expect(place).toContain(
      "and ( not coalesce(p_include, false) or private.knowledge_source_verdict_current(article.knowledge_source_id) )",
    );
    expect(place).toContain("delete from public.knowledge_collection_items item");
  });

  it("leaves non-Storage knowledge semantics alone", () => {
    // Invariant 6. Every gate here is the one predicate, which answers true for
    // a null knowledge_source_id and for any source that is not
    // organization_storage. Nothing in this migration touches rights lessons,
    // chapter documents, external_url rows or Drive bytes.
    for (const forbidden of ["member_rights_lessons", "chapter_documents", "external_url", "scan_status"]) {
      expect(code, `${forbidden} must not appear in this migration`).not.toContain(forbidden);
    }
    expect(code).not.toContain("search_member_kb");
  });

  it("re-states every grant it touches and pins each body in the DB contract", () => {
    for (const [signature, grantee] of [
      ["private.knowledge_source_verdict_current(uuid)", "authenticated, service_role"],
      ["private.knowledge_source_object_verdict_locked(uuid, uuid)", "service_role"],
      ["public.list_accessible_knowledge_articles_snapshot(boolean, text)", "authenticated"],
      ["public.save_chapter_kb_article( uuid, text, text, text, text, text[], text, boolean, text )", "authenticated"],
      ["public.list_knowledge_collections(text)", "authenticated"],
      ["public.set_knowledge_collection_item( uuid, text, uuid, boolean, integer, text )", "authenticated"],
    ]) {
      const squashed = squash(code);
      expect(squashed, `${signature} must be revoked before it is granted`).toContain(
        `revoke all on function ${signature} from public, anon, authenticated, service_role;`,
      );
      expect(squashed, `${signature} must be granted to ${grantee}`).toContain(
        `grant execute on function ${signature} to ${grantee};`,
      );
    }

    // The two wrappers pin the coalesced ledger answer; the four gated surfaces
    // pin the conjunct that calls the wrapper. Every one carries a refreshed
    // md5, so a later edit to any of them fails until this contract moves too.
    const needles = [
      ["private.knowledge_source_verdict_current(p_source_id uuid)",
        "coalesce(private.private_upload_is_current('organization-knowledge', file.storage_path), false)"],
      ["private.knowledge_source_object_verdict_locked(p_organization_id uuid, p_source_id uuid)",
        "coalesce(private.private_upload_is_current('organization-knowledge', file.storage_path), false)"],
      // The four article-level gates below reach the wrapper THROUGH
      // private.knowledge_article_content_current since 20260906030000, which
      // is false for a withheld article as well as for a lapsed source. The
      // needle pinned here is the live one; the conjunct this migration itself
      // wrote is pinned as migration text above.
      ["public.list_accessible_knowledge_articles_snapshot(p_published_only boolean, p_chapter_id text)",
        "private.knowledge_article_content_current(article)"],
      ["public.save_chapter_kb_article(p_article_id uuid, p_kind text, p_title text, p_article_ref text, p_body text, p_keywords text[], p_status text, p_confirm_verified boolean, p_chapter_id text)",
        "private.knowledge_article_content_current(saved)"],
      ["public.list_knowledge_collections(p_chapter_id text)",
        "private.knowledge_article_content_current(article)"],
      ["public.set_knowledge_collection_item(p_collection_id uuid, p_item_kind text, p_item_id uuid, p_include boolean, p_sort_order integer, p_chapter_id text)",
        "private.knowledge_article_content_current(article)"],
    ];
    for (const [sig, needle] of needles) {
      expect(entry(sig).bodyMd5, `${sig} must carry a refreshed bodyMd5`).toMatch(/^[0-9a-f]{32}$/);
      expect(entry(sig).bodyContains, `${sig} must pin ${needle} as a contract needle`).toContain(needle);
    }
    expect(entry("public.save_chapter_kb_article(p_article_id uuid, p_kind text, p_title text, p_article_ref text, p_body text, p_keywords text[], p_status text, p_confirm_verified boolean, p_chapter_id text)").bodyContains)
      .toContain("file inspection required");
  });

  it("reloads the PostgREST schema cache so the replaced RPCs are reachable", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});
