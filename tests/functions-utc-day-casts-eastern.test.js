// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

// BUG-UG-FUNCTIONS-CAST-TIMESTAMPS-TO-THE-UTC-DAY-20261115 (#8876).
// The record named 28 functions that cast an instant to the UTC day. This
// pins the decision for every one of them: seventeen read the Eastern
// calendar since this migration, and eleven keep the UTC cast for a reason.
// A later migration that re-emits one of the eleven, or brings a UTC cast
// back into one of the seventeen, fails here and must revisit the decision.
// The behaviour is proved on a disposable database by
// tests/functions-utc-day-casts-eastern-db.test.js.
const MIGRATION = "20261117121800_functions_utc_day_casts_eastern";

// #9279 retains the Eastern decision while narrowing the weekly replay key.
const LATER_EASTERN_DEFINITIONS = {
  "public.submit_weekly_question": "20261120031506_weekly_poll_submission_chapter_scope.sql",
  "public.submit_weekly_poll_question": "20261120031506_weekly_poll_submission_chapter_scope.sql",
};
// #9446 part 4a restates a moved function so a case deadline automation
// counts on the case's own zone; its task branches keep the Eastern day.
const LATER_ZONE_DEFINITIONS = {
  "private.automation_v2_candidates": "20261123104000_case_deadline_time_zones.sql",
};

const MOVED = [
  "private.automation_v2_candidates",
  "private.casework_reminder_next_occurrence",
  "private.chapter_connection_previous_quarter",
  "public.set_chapter_connection_source_tags",
  "private.usage_digest_windows",
  "private.usage_digest_bucket",
  "private.usage_digest_window_publishable",
  "private.generate_analytics_usage_digests",
  "public.submit_weekly_question",
  "public.submit_weekly_poll_question",
  "public.list_weekly_questions",
  "public.boost_weekly_question",
  "public.promote_weekly_question",
  "private.drive_meeting_folder_name",
  "private.route_steward_email_intake",
  "private.engagement_follow_up_sweep",
  "public.record_member_home_return",
];

// name -> [defining migration on Main, UTC casts, why the UTC cast is right]
const KEPT = {
  "private.chapter_leader_active_since": ["20261104075000", 1, "casts a cutoff instant to auth.sessions' UTC-naive refreshed_at: an instant comparison"],
  "private.member_pin_live_restricted_session_exists": ["20261003040000", 1, "reads auth.sessions' UTC-naive refreshed_at as an instant"],
  "public.get_my_member_pin_status": ["20261003040000", 1, "reads auth.sessions' UTC-naive refreshed_at as an instant"],
  "private.native_push_session_eligible": ["20261003045000", 1, "reads auth.sessions' UTC-naive refreshed_at as an instant"],
  "public.list_stale_assurance_accounts": ["20260813131000", 1, "an ISO-8601 instant with a Z suffix, for machines"],
  "public.get_organization_coordination_export_payload": ["20261028080000", 1, "a to-the-second file-name stamp, not a day"],
  "public.record_workspace_page_view": ["20261028080000", 2, "a rate-limit minute key and the UTC page-view day bucket that #8568 part D keeps"],
  "public.get_organization_analytics_snapshot": ["20261123061000", 4, "reads the UTC page-view buckets and their events on the same UTC day"],
  "public.list_chapter_appointment_reassignment_candidates": ["20260925030000", 2, "a day either side of the UTC date already contains the steward's local date"],
  "public.reassign_chapter_appointment": ["20260925030000", 2, "a day either side of the UTC date already contains the steward's local date"],
  "public.reschedule_appointment": ["20261111184200", 2, "a day either side of the UTC date already contains the steward's local date"],
};

const UTC_CAST = /at\s+time\s+zone\s+'utc'|timezone\(\s*'utc'/gi;
const latest = new Map();
const directory = new URL("../supabase/migrations/", import.meta.url);
for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
  for (const fn of parseFunctions(readFileSync(new URL(file, directory), "utf8"), file)) latest.set(fn.name, fn);
}
const utcCasts = (fn) => (fn.source.replace(/--[^\n]*/g, "").match(UTC_CAST) || []).length;

describe("the 28 UTC-day functions of #8876", () => {
  it("guards both chapter-scoped weekly restatements by their exact reviewed Eastern bodies", () => {
    const predecessors = parseFunctions(loadMigrationSql(MIGRATION), `${MIGRATION}.sql`);
    const sql = readFileSync(new URL(`../supabase/migrations/${LATER_EASTERN_DEFINITIONS["public.submit_weekly_question"]}`, import.meta.url), "utf8");
    const guard = sql.match(/do \$preflight\$([\s\S]*?)\$preflight\$;/)?.[1];
    expect(guard).toBeTruthy();
    expect(sql.indexOf("do $preflight$")).toBeLessThan(sql.indexOf("alter table public.member_weekly_questions"));
    for (const name of Object.keys(LATER_EASTERN_DEFINITIONS)) {
      const body = predecessors.find((fn) => fn.name === name)?.source;
      expect(body, name).toBeDefined();
      expect(guard, name).toContain(createHash("md5").update(body).digest("hex"));
      expect(guard, name).toContain(`raise exception 'unreviewed predecessor: ${name}' using errcode = '55000'`);
    }
    expect(guard.match(/pg_catalog\.md5\(p\.prosrc\)/g)).toHaveLength(2);
    expect(guard.match(/is distinct from/g)).toHaveLength(2);
  });

  it("decides every one of them, once", () => {
    expect(MOVED).toHaveLength(17);
    expect(Object.keys(KEPT)).toHaveLength(11);
    expect(new Set([...MOVED, ...Object.keys(KEPT)]).size).toBe(28);
  });

  it("moves seventeen to the Eastern calendar in this migration, with no UTC cast left but the legacy bounds", () => {
    // The monthly privacy check also removes a stored week's people on its UTC
    // bounds, because a week stored before this migration was counted on
    // them. Those two casts are the only ones.
    const legacy = { "private.usage_digest_window_publishable": 2 };
    for (const name of MOVED) {
      const fn = latest.get(name);
      expect(fn?.file, name).toBe(LATER_EASTERN_DEFINITIONS[name] ?? LATER_ZONE_DEFINITIONS[name] ?? `${MIGRATION}.sql`);
      expect(utcCasts(fn), name).toBe(legacy[name] ?? 0);
      if (legacy[name]) expect(fn.source).toContain("-- legacy-utc-bounds:");
      expect(fn.source, name).toMatch(/private\.eastern_day\(|at time zone 'America\/New_York'/);
    }
  });

  it("keeps the UTC cast in the other eleven, each from the definition it was reviewed at", () => {
    for (const [name, [stamp, casts]] of Object.entries(KEPT)) {
      const fn = latest.get(name);
      expect(fn?.file.slice(0, 14), name).toBe(stamp);
      expect(utcCasts(fn), name).toBe(casts);
    }
  });

  it("guards every re-emitted body by its reviewed predecessor and changes nothing else", () => {
    const sql = stripComments(loadMigrationSql(MIGRATION));
    const guarded = [...sql.matchAll(/raise exception 'unreviewed predecessor: ([a-z0-9_.]+)'/g)].map((match) => match[1]);
    expect(guarded).toEqual(MOVED);
    expect([...sql.matchAll(/where p\.oid='[^']+'::regprocedure\)\s+is distinct from '([0-9a-f]{32})'/g)]).toHaveLength(17);
    const created = [...sql.matchAll(/create or replace function ([a-z0-9_.]+)\(/g)].map((match) => match[1]);
    expect(created).toEqual(MOVED);
    // Outside the guard and the seventeen function statements there is only the
    // transaction frame: no grant, table, row or schedule changes.
    const outside = sql
      .replace(/do \$preflight\$[\s\S]*?\$preflight\$;/, "")
      .replace(/create or replace function [\s\S]*?\bas\s+(\$[a-z_]*\$)[\s\S]*?\1[^;]*;/gi, "");
    expect(outside.replace(/\s+/g, " ").trim())
      .toBe("begin; set local lock_timeout='5s'; set local statement_timeout='60s'; set local search_path=pg_catalog; commit;");
  });

  it("sorts after #8568 part D, whose helper and decisions it builds on", () => {
    const names = migrationNames();
    expect(names.indexOf(`${MIGRATION}.sql`)).toBeGreaterThan(names.indexOf("20261113145500_visible_days_eastern_day.sql"));
    expect(names.indexOf(`${MIGRATION}.sql`)).toBeGreaterThan(names.indexOf("20261113122500_eastern_day_helper.sql"));
  });
});
