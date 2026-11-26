// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMigrationSql } from "./helpers/migration.js";

const sql = loadMigrationSql("20260821015000_mobile_event_cancellation_visibility.sql");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("mobile event cancellation visibility", () => {
  it("restores only the cancellation columns removed by the chapter-scoped regrant", () => {
    expect(sql).toContain(
      "grant select (cancelled_at, cancelled_reason) on public.member_events to authenticated;",
    );
    expect(sql).not.toMatch(/grant select \([^)]*(check_in_code|reminder_notice_sent_at)[^)]*\)/i);
    expect(sql).not.toMatch(/grant\s+(all|insert|update|delete)[^;]*public\.member_events[^;]*authenticated/i);
  });

  it("keeps anonymous clients outside the event table", () => {
    expect(sql).toContain("revoke select (cancelled_at, cancelled_reason) on public.member_events from anon;");
  });

  it("pins the final live column grant in the database contract", () => {
    const grant = contract.columnGrants.find((entry) => (
      entry.table === "public.member_events"
      && entry.role === "authenticated"
      && entry.privilege === "SELECT"
    ));
    expect(grant.columns.split(",")).toEqual(expect.arrayContaining([
      "cancelled_at",
      "cancelled_reason",
    ]));
    expect(grant.denied).toEqual(expect.arrayContaining([
      "check_in_code",
      "reminder_notice_sent_at",
    ]));
  });
});
