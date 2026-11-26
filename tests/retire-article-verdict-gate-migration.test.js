// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

// Text pins for 20260906027000, the fifth slice-4 repair.
//
// 20260906024000 and 20260906026000 bound the write half, the staff half and
// the member-facing half of the storage-derived knowledge lifecycle. An
// independent round-2 verification then found the last reader carrying no
// provenance conjunct at all: public.retire_chapter_kb_article is granted to
// `authenticated`, is declared `returns public.member_kb_articles`, and handed
// a staff caller the whole row — including the derived clause `body` — for an
// article whose originating object had been deleted and whose ledger row was
// tombstoned. The table's new read policies do not constrain it, because the
// body runs security definer as a BYPASSRLS role.
//
// The decision this file pins is shape (b) of the two the verifier offered:
// retirement is REMOVAL-shaped, the same class as the collection REMOVE path
// 20260906026000 deliberately left reachable, so it stays callable during a
// lapse — refusing it outright would strand a published clause nobody can take
// off the shelf for exactly as long as its source is untrustworthy — and what
// goes away is the derived text in the RETURN.
//
// The live-database twins are `npm run verify:db` (bodyMd5 + bodyContains) and
// the extended lifecycle proof in tests/private-file-workflow-gates-db.test.js.
// This file is what keeps the intent readable and fails first if someone drops
// the suppression or converts it into a refusal.
const NAME = "20260906027000_retire_article_verdict_gate";
const SIG = "public.retire_chapter_kb_article(p_article_id uuid, p_chapter_id text)";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const squash = (text) => text.replace(/\s+/g, " ").trim();
const retire = squash(stripComments(fnBody(code, "public.retire_chapter_kb_article")));
const entry = (() => {
  const found = contract.functions.find((candidate) => candidate.sig === SIG);
  expect(found, `${SIG} must be registered in the DB contract`).toBeTruthy();
  return found;
})();

describe("retire article verdict gate migration", () => {
  it("runs as one forward-only transaction after every migration it replaces", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    const names = migrationNames();
    for (const earlier of [
      "20260812110000_chapter_compass_knowledge.sql",
      "20260903030000_cba_ingestion_completion.sql",
      "20260903034000_knowledge_selected_chapter_scope.sql",
      "20260906024000_knowledge_source_verdict_gates.sql",
      "20260906026000_knowledge_read_path_verdict_gates.sql",
    ]) {
      expect(names.indexOf(`${NAME}.sql`), `${NAME} must apply after ${earlier}`)
        .toBeGreaterThan(names.indexOf(earlier));
    }
    // Forward-only: this migration replaces one function and nothing else.
    expect(code).not.toContain("drop function");
    expect(code).not.toContain("alter table");
  });

  it("decides the verdict under the row lock, before anything is written", () => {
    const lockAt = retire.indexOf("for update");
    const decisionAt = retire.indexOf(
      "derived_lapsed := not private.knowledge_source_verdict_current(saved.knowledge_source_id);",
    );
    expect(decisionAt, "the lapse must be decided from the locked row's provenance").toBeGreaterThan(-1);
    expect(decisionAt).toBeGreaterThan(lockAt);
    expect(retire.indexOf("update public.member_kb_articles set status = 'retired'"))
      .toBeGreaterThan(decisionAt);
  });

  it("keeps staff cleanup reachable rather than refusing a lapsed article", () => {
    // Shape (a) — `raise exception 'file inspection required'`, the answer the
    // two publication routes give — is deliberately NOT what this migration
    // does. A lapse must not strand a published clause nobody can retire.
    expect(retire, "retirement must not be converted into a refusal")
      .not.toContain("file inspection required");
    expect(retire).toContain("set status = 'retired'");
    expect(retire).toContain("version = version + 1");
    // The immutable revision is still appended: it is the history of what was
    // retired, and every reader of member_kb_article_revisions is already gated.
    expect(retire).toContain("insert into public.member_kb_article_revisions (");
  });

  it("returns no derived article content once the source verdict has lapsed", () => {
    const suppressionAt = retire.indexOf("if derived_lapsed then");
    expect(suppressionAt, "the return must be suppressed for a lapsed source").toBeGreaterThan(-1);
    const suppression = retire.slice(suppressionAt, retire.indexOf("return saved;"));
    for (const field of ["title", "article_ref", "body", "keywords"]) {
      expect(suppression, `${field} must be nulled in the returned composite`)
        .toContain(`saved.${field} := null;`);
    }
    // It suppresses the RETURN, not the stored row: a re-inspection that
    // restores the verdict must restore the article intact.
    expect(retire).not.toContain("set body = null");
    expect(suppression).not.toContain("update public.member_kb_articles");
    expect(retire.indexOf("insert into public.member_kb_article_revisions ("))
      .toBeLessThan(suppressionAt);
  });

  it("leaves authored, null-provenance articles exactly as they were", () => {
    // Invariant 6. knowledge_source_verdict_current answers true for a null
    // knowledge_source_id and for any source that is not organization_storage,
    // so the suppression is unreachable for authored content, rights lessons,
    // chapter documents, external_url rows and Drive bytes.
    for (const forbidden of ["member_rights_lessons", "chapter_documents", "external_url", "scan_status"]) {
      expect(code, `${forbidden} must not appear in this migration`).not.toContain(forbidden);
    }
    // Every scope, role and error shape 20260903034000 established survives.
    for (const preserved of [
      "private.mi1_w2_same_org_chapter(org, caller_chapter)",
      "private.mi1_knowledge_collection_staff(org)",
      "public.member_has_role(array['steward','coordinator','advisor','admin','vp'])",
      "caller_chapter is not distinct from home_chapter",
      "not article.is_sample",
      "knowledge article is not available in this chapter",
    ]) {
      expect(retire, `${preserved} must survive the replacement`).toContain(preserved);
    }
  });

  it("keeps private.private_upload_is_current the only predicate it consults", () => {
    // Invariant 7: the gate is reached through the same wrapper every other
    // knowledge surface uses, and no second notion of "is this file safe" is
    // introduced here.
    expect(retire).toContain("private.knowledge_source_verdict_current(");
    expect(retire).not.toContain("private.private_upload_is_current(");
    expect(retire).not.toContain("private_upload_scans");
    expect(retire).toContain("security definer");
    expect(retire).toContain("set search_path = ''");
  });

  it("re-states its grant and pins the replaced body in the DB contract", () => {
    expect(squash(code)).toContain(
      "revoke all on function public.retire_chapter_kb_article(uuid, text) from public, anon, authenticated, service_role;",
    );
    expect(squash(code)).toContain(
      "grant execute on function public.retire_chapter_kb_article(uuid, text) to authenticated;",
    );
    expect(entry.exec).toBe("authenticated");
    expect(entry.bodyMd5, `${SIG} must carry a refreshed bodyMd5`).toMatch(/^[0-9a-f]{32}$/);
    for (const needle of [
      // The live body reaches the wrapper through the article-level
      // withholding predicate since 20260906030000, which is false for a
      // withheld article as well as for a lapsed source; the conjunct this
      // migration itself wrote is pinned as migration text above.
      "private.knowledge_article_content_current(saved)",
      "saved.body := null;",
      "status = 'retired'",
    ]) {
      expect(entry.bodyContains, `${SIG} must pin ${needle} as a contract needle`).toContain(needle);
    }
    // The negative half of the decision, so a later edit cannot quietly turn
    // the suppression into a refusal without moving this contract too.
    expect(entry.bodyForbids, `${SIG} must forbid the refusal shape`)
      .toContain("file inspection required");
  });

  it("reloads the PostgREST schema cache so the replaced RPC is reachable", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});
