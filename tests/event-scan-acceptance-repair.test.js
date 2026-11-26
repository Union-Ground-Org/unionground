// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import { t } from "../src/lib/i18n.js";
import { TRANSLATED_RPC_TOKENS } from "../src/lib/rpcErrorText.js";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260812231000_event_scan_acceptance_repair.sql");
const scan = fnBody(sql, "public.scan_event_checkin(p_event_id text, p_token text)");

const MEMBER_REFUSALS = [
  "scan_code_missing",
  "scan_event_cancelled",
  "scan_code_invalid",
  "scan_code_used",
  "scan_code_expired",
  "scan_code_self",
];

describe("UB-EVT-05 final scan emitter", () => {
  it("re-emits chapter-scoped steward authorization and all six stable member refusal details", () => {
    expect(scan).toContain("not public.member_has_role(array['steward'])");
    expect(scan).toContain("e.chapter_id = caller_chapter");
    for (const token of MEMBER_REFUSALS) {
      expect(scan, `${token} must be attached to the raised exception`).toMatch(
        new RegExp(`raise exception[^;]*detail = '${token}'`),
      );
    }
    const found = [...stripComments(scan).matchAll(/detail = '([a-z_]+)'/g)].map((match) => match[1]);
    expect(found).toEqual(expect.arrayContaining(["scan_not_steward", ...MEMBER_REFUSALS]));
  });

  it("resolves and returns the scanned member's name from the final function body", () => {
    expect(scan).toContain("select p.full_name into scanned_name");
    expect(scan).toMatch(/from public\.member_profiles p\s+where p\.id = tok\.user_id[\s\S]*?for update of p/);
    expect(scan).toContain("'memberName', scanned_name");
    expect(scan).not.toMatch(/member_profiles p where p\.id = caller/);
  });

  it("serializes role revocation, event availability, and profile deletion before consuming a token", () => {
    const callerProfileLock = scan.indexOf("from public.member_profiles cp");
    const roleLock = scan.indexOf("from public.member_roles r");
    const mfaRoleRecheck = scan.indexOf("not public.member_has_role(array['steward'])", roleLock);
    const eventLock = scan.indexOf("from public.member_events e", mfaRoleRecheck);
    const tokenLock = scan.indexOf("from private.member_event_checkin_tokens", eventLock);
    const profileLock = scan.indexOf("from public.member_profiles p", tokenLock);
    const consume = scan.indexOf("set consumed_at = now()", profileLock);

    expect(scan).toContain("where r.user_id = caller and r.role = 'steward'");
    expect(scan).toContain("and (r.chapter_id = caller_chapter or r.chapter_id is null)");
    expect(scan).toContain("order by case when r.chapter_id = caller_chapter then 0 else 1 end");
    expect(scan).toContain("limit 1");
    expect(scan).toContain("for update of r");
    expect(scan).toContain("for update of e");
    expect(scan).toContain("e.chapter_id = caller_chapter");
    expect(scan).toContain("ev.starts_at - interval '2 hours'");
    expect(scan).toContain("ev.starts_at + interval '4 hours'");
    expect([callerProfileLock, roleLock, mfaRoleRecheck, eventLock, tokenLock, profileLock, consume].every((index) => index >= 0)).toBe(true);
    expect(callerProfileLock).toBeLessThan(roleLock);
    expect(roleLock).toBeLessThan(mfaRoleRecheck);
    expect(mfaRoleRecheck).toBeLessThan(eventLock);
    expect(eventLock).toBeLessThan(tokenLock);
    expect(tokenLock).toBeLessThan(profileLock);
    expect(profileLock).toBeLessThan(consume);
  });

  it("rechecks the locked token owner's eligibility after a chapter move", () => {
    expect(scan).toContain("p.chapter_id is not null");
    expect(scan).toContain("p.chapter_id = caller_chapter");
    expect(scan).toContain("ev.is_public_across_agencies");
    expect(scan).toContain("event_chapter.region = member_chapter.region");
  });

  it("reaches every refusal before the first token or check-in mutation", () => {
    const firstMutation = scan.indexOf("update private.member_event_checkin_tokens");
    expect(firstMutation).toBeGreaterThan(-1);
    for (const token of ["scan_not_steward", ...MEMBER_REFUSALS]) {
      expect(scan.lastIndexOf(`detail = '${token}'`), `${token} must not be raised after token consumption`)
        .toBeLessThan(firstMutation);
    }
    expect(scan.slice(0, firstMutation)).not.toMatch(/\b(update|insert|delete)\s+(?:into\s+)?(?:public|private)\./i);
  });

  it("keeps every stable refusal allowlisted and translated in English and Spanish", () => {
    for (const token of ["scan_not_steward", ...MEMBER_REFUSALS]) {
      expect(TRANSLATED_RPC_TOKENS.has(token)).toBe(true);
    }
    for (const token of TRANSLATED_RPC_TOKENS) {
      const key = `rpcError.${token}`;
      for (const lang of ["en", "es"]) {
        const resolved = t(lang, key);
        expect(resolved, `${lang} ${key}`).toBeTypeOf("string");
        expect(resolved.length, `${lang} ${key} empty`).toBeGreaterThan(0);
        expect(resolved, `${lang} ${key} still the raw key`).not.toBe(key);
      }
      expect(t("es", key), `${key} es still English`).not.toBe(t("en", key));
    }
  });

  it("retains authenticated-only execution and a pinned empty search path", () => {
    expect(scan).toContain("security definer");
    expect(scan).toContain("set search_path = ''");
    expect(sql).toContain("revoke all on function public.scan_event_checkin(text, text) from public, anon");
    expect(sql).toContain("grant execute on function public.scan_event_checkin(text, text) to authenticated");
  });

  it("ships a local-only two-connection race proof for every locked decision", () => {
    const proof = readFileSync("scripts/verify-event-scan-concurrency-local.mjs", "utf8");
    expect(proof).toContain("assertDisposableProofUrl(");
    expect(proof).toContain('label: "role revocation"');
    expect(proof).toContain('label: "event cancellation"');
    expect(proof).toContain('label: "event reschedule"');
    expect(proof).toContain('label: "member profile move"');
    expect(proof).toContain('label: "member profile deletion"');
    expect(proof).toContain("consumed_at is null");
    expect(proof).toContain("must not expose the member name");
    expect(proof).toContain("drop database if exists");
  });
});
