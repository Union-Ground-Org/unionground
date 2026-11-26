// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import {
  fnBody,
  loadMigrationSql,
  migrationFiles,
  stripComments,
} from "./helpers/migration.js";

const NAME = "20260925030100_emergency_steward_alert_bounds";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const signature = "public.alert_member_emergency_steward";

function latestFunction(name) {
  const migration = [...migrationFiles()].reverse().find(({ sql: text }) => (
    stripComments(text).toLowerCase().includes(`function ${name.toLowerCase()}(`)
  ));
  expect(migration, `missing migration for ${name}`).toBeTruthy();
  return {
    file: migration.name,
    body: stripComments(fnBody(migration.sql, name)),
    raw: fnBody(migration.sql, name),
  };
}

describe("emergency steward alert bounds migration", () => {
  it("runs as one forward-only transaction after the original admission RPC", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260829030000_member_support_programs").toBe(true);
    expect(NAME > "20260907151000_account_deletion_finalization_reconciliation").toBe(true);
    expect(NAME > "20260924200000_member_support_chapterless_org_resolution").toBe(true);
  });

  it("is the live definition and is not superseded later", () => {
    const latest = latestFunction(signature);
    expect(latest.file).toBe(`${NAME}.sql`);
  });

  it("keeps the installed case-graph wrapper as the first statement", () => {
    const fn = parseFunctions(sql, `${NAME}.sql`)
      .find((entry) => entry.name === signature);
    expect(fn).toBeTruthy();
    expect(fn.source).toMatch(
      /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/,
    );
  });

  it("keeps the chapterless organization resolver from 20260924200000", () => {
    const { body } = latestFunction(signature);
    expect(body).toContain("org uuid := private.member_support_selected_organization()");
    expect(body).not.toContain("mi1_require_selected_organization");
  });

  it("coalesces an unresolved organization/member/scenario alert", () => {
    const { body } = latestFunction(signature);
    expect(body).toContain("checklist.organization_id = org");
    expect(body).toContain("checklist.member_user_id = caller");
    expect(body).toContain("checklist.scenario = p_scenario");
    expect(body).toContain("prior_status is distinct from 'alerted'");
    expect(body).toContain("resolved_at = null");
  });

  it("mints the steward request and alerted event only on the first-alert branch", () => {
    const { body } = latestFunction(signature);
    const guardAt = body.indexOf("prior_status is distinct from 'alerted'");
    const requestAt = body.indexOf("insert into public.member_steward_requests");
    const eventAt = body.indexOf("member_support_record_event");
    expect(guardAt).toBeGreaterThan(-1);
    expect(requestAt).toBeGreaterThan(guardAt);
    expect(eventAt).toBeGreaterThan(requestAt);
    expect(body.slice(0, guardAt)).not.toContain("insert into public.member_steward_requests");
    expect(body.slice(0, guardAt)).not.toContain("on conflict (id) do nothing");
    expect(body).toContain("on conflict (id) do nothing");
  });

  it("enforces the documented per-member rolling-hour bound with errcode 22023", () => {
    const { body, raw } = latestFunction(signature);
    expect(raw).toContain("emergency_alert_hour_limit constant integer := 5");
    expect(body).toContain("emergency_alert_hour_limit constant integer := 5");
    expect(body).toContain("interval '1 hour'");
    expect(body).toContain("events.organization_id = org");
    expect(body).toContain("events.member_user_id = caller");
    expect(body).toContain("events.event_type = 'alerted'");
    expect(body).toMatch(/raise exception 'emergency steward alert rate limited'\s+using errcode = '22023'/);
    expect(body.indexOf("recent_alerts >= emergency_alert_hour_limit"))
      .toBeGreaterThan(body.indexOf("prior_status is distinct from 'alerted'"));
  });

  it("refuses an idempotency key already bound to a different support event", () => {
    const { body } = latestFunction(signature);
    const guardAt = body.indexOf("where used.id = p_idempotency_key");
    expect(guardAt).toBeGreaterThan(body.indexOf("prior_status is distinct from 'alerted'"));
    expect(guardAt).toBeLessThan(body.indexOf("insert into public.member_steward_requests"));
    expect(body).toContain(
      "is distinct from (org, caller, 'emergency_checklist', row_out.id, 'alerted')",
    );
    expect(body).toMatch(/raise exception 'emergency steward alert key already used'\s+using errcode = '22023'/);
  });

  it("refuses an idempotency key already bound to a steward request outside a replay", () => {
    const { body } = latestFunction(signature);
    const guardAt = body.indexOf("where request.id = p_idempotency_key");
    expect(guardAt).toBeGreaterThan(body.indexOf("where used.id = p_idempotency_key"));
    expect(guardAt).toBeLessThan(body.indexOf("insert into public.member_steward_requests"));
    const guard = body.slice(guardAt, body.indexOf("insert into public.member_steward_requests"));
    expect(guard).toMatch(/and not exists \(\s*select 1\s+from public\.member_support_events own\s+where own\.id = p_idempotency_key\s*\)/);
    expect(guard).toMatch(/raise exception 'emergency steward alert key already used'\s+using errcode = '22023'/);
  });

  it("indexes the rolling-hour first-alert lookup", () => {
    expect(code).toMatch(
      /create index if not exists member_support_events_emergency_alert_idx\s+on public\.member_support_events \(organization_id, member_user_id, occurred_at\)\s+where entity_type = 'emergency_checklist' and event_type = 'alerted';/,
    );
  });

  it("keeps the existing scenario, step, and notes validation", () => {
    const { body } = latestFunction(signature);
    expect(body).toContain("'disciplinary_meeting', 'pre_discipline_response', 'unsafe_work'");
    expect(body).toContain("pg_catalog.cardinality(p_completed_steps), 0) > 16");
    expect(body).toContain("step not between 0 and 3");
    expect(body).toContain("pg_catalog.char_length(coalesce(p_notes, '')) > 4000");
    expect(body).toContain("raise exception 'invalid emergency alert' using errcode = '22023'");
    expect(body).toContain("jsonb_build_object('id', row_out.id, 'status', 'alerted', 'alertedAt', row_out.alerted_at)");
  });

  it("reissues the original EXECUTE grants", () => {
    expect(code).toContain(
      "revoke all on function public.alert_member_emergency_steward(text, integer[], text, uuid) from public, anon;",
    );
    expect(code).toContain(
      "grant execute on function public.alert_member_emergency_steward(text, integer[], text, uuid) to authenticated;",
    );
    expect(parseFunctions(sql, `${NAME}.sql`).map((entry) => entry.name)).toEqual([signature]);
  });
});
