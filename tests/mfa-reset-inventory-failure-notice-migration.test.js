// @vitest-environment node
//
// BUG-UG-MFA-RESET-FOURTH-EXIT-NO-NOTICE-NO-DEBT-20260918 — offline pins
// for 20260924150400, anchored on the LATEST declaration of the authority so a
// later migration that re-emits it without its guard or with the wrong copy
// fails here.
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const SIGNATURE = "public.notify_member_mfa_reset_incomplete(p_user_id uuid)";
const sql = stripComments(loadMigrationSql("20260924150400_mfa_reset_inventory_failure_member_notice"));

function body() {
  const migration = [...migrationFiles()].reverse().find(({ sql: text }) => (
    stripComments(text).toLowerCase().includes(`function ${SIGNATURE.toLowerCase()}`)
  ));
  expect(migration, `missing migration for ${SIGNATURE}`).toBeTruthy();
  return stripComments(fnBody(migration.sql, SIGNATURE));
}

describe("the inventory-failure notice tells the truth", () => {
  it("never says the authenticator was removed, in either language", () => {
    // Break caught: reusing the drain/notify copy on this exit would tell a
    // member whose authenticator still works that an administrator removed it.
    const text = body();
    expect(text).not.toContain("removed the authenticator from your account");
    expect(text).not.toContain("quitó el autenticador de tu cuenta");
    expect(text).toContain("Your authenticator was not removed and still works");
    expect(text).toContain("Tu autenticador no se quitó y sigue funcionando");
    expect(text).toContain("signed out your open sessions");
    expect(text).toContain("cerró tus sesiones abiertas");
    expect(text).toContain("if member_lang = 'es' then");
  });

  it("does not mark the pending-notice debt, which drains with the removed copy", () => {
    const text = body();
    expect(text).not.toContain("notice_owed_at");
    expect(text).not.toContain("notice_sent_at");
  });

  it("writes at most one notice per reset, across all four reset-notice titles", () => {
    const text = body();
    expect(text).toContain("n.created_at >= reset_at");
    for (const title of [
      "Two-step sign-in was reset by an administrator",
      "Un administrador restableció la verificación en dos pasos",
      "Two-step sign-in reset did not finish",
      "El restablecimiento de la verificación en dos pasos no terminó",
    ]) expect(text).toContain(`'${title}'`);
    expect(text.indexOf("n.created_at >= reset_at"))
      .toBeLessThan(text.indexOf("insert into public.member_notifications"));
  });

  it("is bound to a recent reset this caller began", () => {
    const text = body();
    expect(text).toContain("and b.reset_by = caller");
    expect(text).toContain("b.invalid_before >= pg_catalog.clock_timestamp() - interval '15 minutes'");
  });

  it("is gated like the other reset authorities", () => {
    const text = body();
    expect(text).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])");
    expect(text).toContain("public.member_has_role(array['admin'])");
    expect(text).toContain("p_user_id is null or p_user_id = caller");
    expect(text).toContain("c.organization_id = private.current_member_organization()");
    // The sibling chapter-scope predicate from 20260924100000.
    expect(text).toContain("m.status = 'active'");
    expect(text).toContain("private.has_organization_role(c.organization_id, array['admin'])");
    expect(text).toContain("private.member_has_chapter_role(m.chapter_id, array['admin'])");
    expect(text).toContain("security definer");
    expect(text).toContain("set search_path = ''");
    expect(text.indexOf("private.lock_case_graph")).toBeLessThan(text.indexOf("public.member_has_role"));
    expect([...text.matchAll(/errcode = '(\w+)'/g)].map((match) => match[1]))
      .toEqual(Array(text.match(/errcode = '\w+'/g).length).fill("42501"));
  });

  it("revokes from everyone, re-grants only authenticated, and re-declares nothing", () => {
    const name = "public.notify_member_mfa_reset_incomplete(uuid)";
    expect(sql).toContain(`revoke all on function ${name}\n  from public, anon, authenticated, service_role;`);
    expect(sql).toContain(`grant execute on function ${name} to authenticated;`);
    for (const existing of ["begin_mfa_reset", "record_mfa_reset", "notify_member_mfa_reset", "authorize_mfa_reset",
      "queue_member_mfa_reset_notice", "drain_member_mfa_reset_notice"]) {
      expect(sql).not.toMatch(new RegExp(`function\\s+public\\.${existing}\\s*\\(`, "i"));
    }
  });
});
