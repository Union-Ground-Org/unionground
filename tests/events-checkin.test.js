// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadAuthorizedCalendarEvent, MEMBER_EVENT_COLUMNS } from "../src/lib/memberApi.js";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: the member_action_log action_kind CHECK, which this
// migration wrote with nine values and 20260723140000_member_event_scan_checkin
// (plus the forms and workload migrations) has since widened to twelve; and
// private.award_member_points, redefined six times across the tree.

const sql = loadMigrationSql("member_events_rsvp_checkin");

describe("events migration security invariants", () => {
  it("hides the check-in code from clients via a column-scoped grant", () => {
    expect(sql).toContain("grant select (id, title, starts_at, location, summary, order_index, created_at) on public.member_events to authenticated");
    expect(sql, "check_in_code must not be granted to clients").not.toMatch(/grant select \([^)]*check_in_code[^)]*\) on public\.member_events/);
  });

  it("keeps check-in and rsvp writes definer-only (no client insert grant)", () => {
    for (const table of ["member_event_checkins", "member_event_rsvps"]) {
      expect(sql, `${table} must not be client-writable`).not.toMatch(
        new RegExp(`grant [^;]*(insert|update|delete)[^;]*on public\\.${table}[^;]*to (anon|authenticated)`, "i"),
      );
    }
  });

  it("anchors every action_key prefix in the award trigger (closes the mint hole)", () => {
    const award = fnBody(sql, "private.award_member_points()");
    expect(award).toContain("pg_catalog.left(new.action_key, 5) = 'vote-'");
    expect(award).toContain("pg_catalog.left(new.action_key, 7) = 'survey-'");
    expect(award).toContain("pg_catalog.left(new.action_key, 7) = 'rights-'");
    expect(award).toContain("pg_catalog.left(new.action_key, 5) = 'case-'");
    expect(award).toContain("pg_catalog.left(new.action_key, 5) = 'rsvp-'");
    expect(award).toContain("pg_catalog.left(new.action_key, 8) = 'checkin-'");
    // message/steward stay anchored by their regex
    expect(award).toContain("'^message-(.*)-[0-9]+$'");
    expect(award).toContain("'^steward-(.*)-[0-9]+$'");
  });

  it("backs rsvp and checkin points on owned rows", () => {
    const award = fnBody(sql, "private.award_member_points()");
    expect(award).toContain("from public.member_event_rsvps");
    expect(award).toContain("from public.member_event_checkins");
  });

  it("gates check-in to the event window and validates the code, definer + pinned search_path", () => {
    const checkin = fnBody(sql, "public.check_in_to_event(p_event_id text, p_code text)");
    expect(checkin).toContain("security definer");
    expect(checkin).toContain("set search_path = ''");
    expect(checkin).toContain("ev.starts_at - interval '2 hours'");
    expect(checkin).toContain("ev.starts_at + interval '4 hours'");
    expect(checkin).toContain("invalid check-in code");
  });

  it("logs the rsvp action only when going, atomically in the definer RPC", () => {
    const rsvp = fnBody(sql, "public.rsvp_to_event(p_event_id text, p_status text)");
    expect(rsvp).toContain("security definer");
    expect(rsvp).toContain("if p_status = 'going' then");
    expect(rsvp).toContain("'rsvp-' || p_event_id");
  });

  it("widens the action_kind CHECK to the exact superset", () => {
    expect(sql).toContain("check (action_kind in ('seed', 'vote', 'survey', 'rights', 'case', 'message', 'steward', 'rsvp', 'checkin'))");
  });

  it("seeds the rsvp and checkin point rules at canon values", () => {
    expect(sql).toContain("('rsvp', 'RSVP to an event', 40, null)");
    expect(sql).toContain("('checkin', 'Check in at an event', 50, null)");
  });
});


describe("optional check-in availability", () => {
  it("grants only the generated availability bit and keeps the code denied", () => {
    const optional = loadMigrationSql("20261008235000_event_checkin_code_optional");
    expect(optional).toContain("generated always as (check_in_code is not null) stored");
    expect(optional).toContain("grant select (check_in_offered) on public.member_events to authenticated;");
    expect(optional).not.toMatch(/grant select \([^)]*check_in_code[^)]*\) on public\.member_events/);
  });
});


it.each([true, false, undefined])("maps authorized availability %s without copying the admission code", async (offered) => {
  const select = [];
  const client = { from(table) {
    const query = {
      select(columns) { select.push([table, columns]); return query; },
      eq() { return query; },
      async maybeSingle() { return { error: null, data: table === "member_events" ? {
        id: "event", title: "Event", starts_at: "2026-11-01T17:00:00Z",
        check_in_offered: offered, check_in_code: "SG-SECRET",
      } : null }; },
    };
    return query;
  } };
  const event = await loadAuthorizedCalendarEvent(client, "event", "member");
  expect(event.checkInOffered).toBe(offered === true);
  expect(event).not.toHaveProperty("checkInCode");
  expect(event).not.toHaveProperty("check_in_code");
  expect(select).toContainEqual(["member_events", MEMBER_EVENT_COLUMNS]);
  expect(MEMBER_EVENT_COLUMNS.split(",")).toContain("check_in_offered");
  expect(MEMBER_EVENT_COLUMNS.split(",")).not.toContain("check_in_code");
});

describe('date-only event attendance boundary', () => {
  it('refuses date-only RSVP before writing an attendance row or awarding points', () => {
    const model = loadMigrationSql('20261009002000_event_model');
    const rsvp = fnBody(model, 'public.rsvp_to_event(');
    expect(rsvp.indexOf("ev.event_kind <> 'meeting'")).toBeLessThan(rsvp.indexOf('insert into public.member_event_rsvps'));
    expect(model).toContain('starts_at is null and ends_at is null and check_in_code is null');
    expect(model).toContain('apply event_checkin_code_optional (#4132) first');
  });
});
