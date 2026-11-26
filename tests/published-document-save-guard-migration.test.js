// SOL-20260813-03 regression pins.
//
// 20260810193000_published_content_lifecycle.sql wrote the content columns for
// every action and moved version/published_at for 'republish' only. A staff
// 'save' on a row with status='published' therefore replaced the text members
// read while leaving the version number and publication date they judge it by
// untouched. 20260813180000_published_document_save_guard.sql closes that:
// 'save' now raises on a published row, so changing member-visible text costs a
// version, and withdrawing it costs an archive.
//
// These are text pins on the LATEST definition, plus the contract needles that
// `npm run verify:db` replays against the live catalog. The text pin alone
// cannot see which generation of the function production actually has.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const guard = readFileSync("supabase/migrations/20260813180000_published_document_save_guard.sql", "utf8").toLowerCase();
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
const fn = contract.functions.find((entry) => entry.sig.startsWith("public.update_chapter_document_content("));

describe("published document save guard migration", () => {
  it("redefines the lifecycle RPC rather than adding a second entry point", () => {
    expect(guard).toContain("create or replace function public.update_chapter_document_content(");
    // Signature must be byte-identical to the one the contract and the client
    // call; a changed arg list would create an overload and leave the old,
    // unguarded function reachable from PostgREST.
    expect(guard).toContain("p_id uuid, p_title text, p_document_type text, p_summary text, p_body text, p_visibility text, p_action text default 'save'");
  });

  it("makes document updates RPC-only instead of leaving a PostgREST bypass", () => {
    expect(guard).toContain("revoke update on table public.chapter_documents from authenticated;");
    expect(guard).toContain("revoke update (title, document_type, summary, body, source_url, version, visibility, status, published_at)");
    const updateGrant = contract.columnGrants.find((entry) =>
      entry.table === "public.chapter_documents" &&
      entry.role === "authenticated" &&
      entry.privilege === "UPDATE"
    );
    expect(updateGrant.columns).toBe("");
    expect(updateGrant.denied).toContain("body");
    expect(updateGrant.denied).toContain("version");
  });

  it("refuses a plain save on a published row with a state errcode", () => {
    expect(guard).toContain("if p_action='save' and row.status='published' then raise exception");
    expect(guard).toContain("errcode='55000'");
    // Not a permission failure and not a bad argument: the caller is allowed
    // and the arguments are well formed, the ROW is in the wrong state.
    expect(guard).not.toMatch(/row\.status='published' then raise exception[^;]*errcode='(42501|22023)'/);
  });

  it("reads the row under a lock so a concurrent republish cannot open a window", () => {
    // Without `for update`, a save could read status='draft', a republish could
    // commit in between, and the save would then overwrite published text with
    // the pre-publication draft body.
    expect(guard).toContain("select d.* into row from public.chapter_documents d where d.id=p_id and d.chapter_id=chapter for update");
  });

  it("keeps every guarantee the original lifecycle migration made", () => {
    expect(guard).toContain("private.assert_publisher()");
    expect(guard).toContain("p_action not in ('save','republish','archive')");
    expect(guard).toContain("when p_action='republish' then d.version+1");
    expect(guard).toContain("when p_action='republish' then now()");
    expect(guard).toContain("when p_action='archive' then 'archived'");
    // Chapter scope survives on both the locking read and the write.
    expect(guard.match(/d\.chapter_id=chapter/g)).toHaveLength(2);
    expect(guard).toContain("security definer set search_path = ''");
  });

  it("re-states the execute grant it replaced, and widens nothing", () => {
    expect(guard).toContain("revoke all on function public.update_chapter_document_content(uuid,text,text,text,text,text,text) from public,anon,authenticated;");
    expect(guard).toContain("grant execute on function public.update_chapter_document_content(uuid,text,text,text,text,text,text) to authenticated;");
    expect(guard).not.toContain("to anon");
    // #6682 (20261102005607) narrows the live grant to authenticated only.
    expect(fn.exec).toBe("authenticated");
  });

  it("pins the guard as a live-catalog needle, not only as migration text", () => {
    expect(fn.bodyContains).toContain("p_action='save' and row.status='published'");
    expect(fn.bodyContains).toContain("d.chapter_id=chapter");
    expect(fn.bodyContains).toContain("for update of d");
    // The needles the earlier generation already carried must not be dropped
    // while adding the new ones.
    // #6682 (20261102005607) replaces the publisher assertion with the chapter
    // role or scoped documents-office check, pinned in its place.
    // #9277 filters the container in SELECT; own-container role refusals stay.
    expect(fn.bodyContains).toContain("private.chapter_officer_can_for_scope(chapter,'documents',row.access_unit_id,row.access_committee_id)");
    expect(fn.bodyContains).toContain("private.chapter_document_container_allows(chapter,d.access_unit_id,d.access_committee_id)");
    expect(fn.bodyContains).toContain("p_action not in ('save','republish','archive')");
  });
});
