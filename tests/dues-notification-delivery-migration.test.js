import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const sql = readFileSync("supabase/migrations/20260831205804_mi1_dues_notification_delivery.sql", "utf8");

describe("Dues notification delivery migration", () => {
  it("uses the canonical delivery trigger and the member preference key", () => {
    expect(sql).toContain("create or replace function private.enqueue_notification_deliveries()");
    expect(sql).toContain("'appointments', 'workload', 'dues'");
    expect(sql).toContain("pref_value := prefs -> new.kind");
    expect(sql).toContain("from private.member_stress_ledger l");
    expect(sql).toContain("revoke all on function private.enqueue_notification_deliveries()");
  });

  it("does not let the expiry sweep discard Dues deliveries as ineligible", () => {
    expect(sql).toContain("create or replace function public.expire_notification_deliveries()");
    expect(sql).toContain("'appointments', 'workload', 'dues'");
    expect(sql).toContain("'kind is not outbound-eligible'");
    expect(sql).toContain("grant execute on function public.expire_notification_deliveries()\n  to service_role");
  });

  it("backfills the new preference for synthetic identities without rewriting deployed seeds", () => {
    expect(sql).toContain("update public.member_profiles p");
    expect(sql).toContain("private.member_stress_ledger l where l.user_id = p.id");
    expect(sql).toContain("'{\"dues\": false}'::jsonb");
  });
});

// I18N-UG-DISPATCH-DUES-REMINDER-ATTEMPT-WRITES-HARD-CODED-ENGLISH-DUES-20260921
//
// The delivery path above is localized end to end only if the row it enqueues
// carries the member's own language. public.dispatch_dues_reminder_attempt used
// to render two English literals inline, so a member whose
// member_profiles.language is 'es' read English in the app while the outbound
// email for the same notification was Spanish.
//
// These pins are written against the LATEST definition of the function in the
// migration directory rather than one named file: a later migration that
// re-emits the function with English literals again is the exact regression,
// and a pin bound to one filename would stay green through it.
const dispatcher = migrationFiles()
  .filter((entry) => /create\s+or\s+replace\s+function\s+public\.dispatch_dues_reminder_attempt\s*\(/i
    .test(stripComments(entry.sql)))
  .at(-1);
const dispatcherBody = stripComments(fnBody(dispatcher.sql, "public.dispatch_dues_reminder_attempt"));
const copyMigration = loadMigrationSql("dues_reminder_localized_notification");

describe("Dues reminder notification copy", () => {
  it("adds the dues.reminder pair to the shared copy catalogue in both languages", () => {
    const copy = stripComments(copyMigration);
    expect(copy).toContain("insert into private.notification_copy (key, lang, title, body) values");
    expect(copy).toContain(
      "('dues.reminder', 'en', 'Account update',\n"
      + "   'An account update needs your attention. Open Dues to review it.')");
    expect(copy).toContain(
      "('dues.reminder', 'es', 'Novedad en tu cuenta',\n"
      + "   'Una novedad de tu cuenta requiere tu atención. Abre Cuotas para revisarla.')");
    expect(copy).toContain("on conflict (key, lang) do update");
    // Both rows are the catalogue's shoulder-test shape: no amount, no due
    // date, no chapter, and the Spanish row is a translation rather than a
    // copy of the English one.
    for (const forbidden of [/\{amount\}/, /\{due/i, /\$/, /chapter/i]) {
      expect(copy.slice(copy.indexOf("('dues.reminder'"), copy.indexOf("on conflict (key, lang)")))
        .not.toMatch(forbidden);
    }
  });

  it("renders the member's own language instead of hard-coded English", () => {
    // The regression itself: the literals the member used to read are gone
    // from the executable body.
    expect(dispatcherBody).not.toContain("'Account update'");
    expect(dispatcherBody).not.toContain("'An account update needs your attention. Open Dues to review it.'");
    // Resolution follows private.notify_member's rule: the recipient's
    // language, English when the profile carries none, and a raise rather than
    // a silent blank when the key is missing from the catalogue.
    expect(dispatcherBody).toContain("from private.notification_copy entry");
    expect(dispatcherBody).toContain("where entry.key = 'dues.reminder'");
    expect(dispatcherBody).toContain(
      "and entry.lang = coalesce(\n"
      + "          (select profile.language from public.member_profiles profile\n"
      + "            where profile.id = recipient), 'en')");
    expect(dispatcherBody).toContain("where entry.key = 'dues.reminder' and entry.lang = 'en'");
    expect(dispatcherBody).toContain("raise exception 'unknown notification copy key: dues.reminder'");
    // The row that reaches the member, and the id the delivery row records.
    expect(dispatcherBody).toContain("insert into public.member_notifications (user_id, title, body, kind)");
    expect(dispatcherBody).toContain("copy_row.title,");
    expect(dispatcherBody).toContain("copy_row.body,");
    expect(dispatcherBody).toContain(") returning id into notification;");
  });

  it("keeps the case-graph transaction entry the re-emitted definer inherited", () => {
    // 20260907151000 wrapped this definer so the gate runs before any row is
    // acquired; re-emitting the body is exactly how that gate gets dropped by
    // accident. It must be the first statement, ahead of every assignment.
    expect(dispatcherBody).toMatch(
      /\$function\$\s*declare[\s\S]*?\bbegin\n\s*perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/);
    expect(dispatcherBody).not.toMatch(/declare[\s\S]*?:=[\s\S]*?\bbegin\b/);
    // Still service-role only, and still the same outcome vocabulary.
    expect(dispatcherBody).toContain("raise exception 'service role required'");
    expect(dispatcherBody).toContain("if p_outcome not in ('sent', 'deferred', 'failed', 'blocked')");
  });

  it("is the newest definition of the dispatcher, so the pins above describe what applies", () => {
    // 20261106220000 re-declares it verbatim with its stale-lease refusal on
    // PT409 instead of 40001 (PostgREST 14 retries 40001 without limit).
    expect(dispatcher.name).toBe("20261106220000_conflict_refusals_not_retried.sql");
    const installed = fnBody(copyMigration, "public.dispatch_dues_reminder_attempt");
    expect(fnBody(dispatcher.sql, "public.dispatch_dues_reminder_attempt"))
      .toBe(installed.replace(/^create\s+function/i, "create or replace function").replace("errcode = '40001'", "errcode = 'PT409'"));
  });
});
