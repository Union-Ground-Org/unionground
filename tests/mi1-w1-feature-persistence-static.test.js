// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import {
  findMigrationName,
  fnBody,
  loadMigrationSql,
  migrationFiles,
  migrationNames,
  stripComments,
} from "./helpers/migration.js";
import {
  expectMi1OrganizationRlsContract,
  MI1_W1_FEATURE_PERSISTENCE_RLS_TABLES,
} from "./helpers/mi1Contract.js";

const FRAGMENT = "20260822020000_mi1_w1_feature_persistence";
const DIRECTORY_RPC = "public.get_public_directory";
const SITE_CONTENT_RPC = "public.get_public_site_content";
const DIRECTORY_WINDOW_MIGRATION = "20260924150200_public_directory_upcoming_events_window.sql";
const DIRECTORY_VISIBILITY_MIGRATION = "20261023050348_bot_organization_directory_visibility.sql";
const RECENCY_PREDICATE = /coalesce\s*\(\s*r\.ends_at\s*,\s*r\.starts_at\s*\+\s*interval\s+'2 hours'\s*\)\s*>=\s*(?:pg_catalog\.)?now\s*\(\s*\)/i;
const DIRECTORY_UPCOMING_PREDICATE = "coalesce(r.ends_at, r.starts_at + interval '2 hours') >= pg_catalog.now()";
const DIRECTORY_LIMIT = 12;
const sql = loadMigrationSql(FRAGMENT);
const directoryWindowSql = loadMigrationSql("20260924150200_public_directory_upcoming_events_window");
const code = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

function body(name) {
  return stripComments(fnBody(sql, name));
}

function lastDefinition(fnName) {
  const definitions = migrationFiles()
    .filter(({ sql: source }) => new RegExp(`function\\s+${fnName.replaceAll(".", "\\.")}\\s*\\(`, "i").test(source))
    .map((entry) => ({
      name: entry.name,
      body: stripComments(fnBody(entry.sql, fnName)),
    }));
  expect(definitions.length, `${fnName} must be declared in at least one migration`).toBeGreaterThan(0);
  return { definitions, last: definitions.at(-1) };
}

function namedBlock(rpc, key) {
  const start = rpc.indexOf(`'${key}'`);
  expect(start, `${key} block`).toBeGreaterThan(-1);
  return rpc.slice(start);
}

function compareMeetings(left, right) {
  const startDelta = left.starts_at - right.starts_at;
  if (startDelta !== 0) return startDelta;
  const sortDelta = (left.sort_order ?? 0) - (right.sort_order ?? 0);
  if (sortDelta !== 0) return sortDelta;
  return left.id.localeCompare(right.id);
}

function oldestUnfilteredWindow(meetings) {
  return [...meetings].sort(compareMeetings);
}

function upcomingDirectoryWindow(meetings, now, limit = DIRECTORY_LIMIT) {
  const twoHours = 2 * 60 * 60 * 1000;
  return meetings
    .filter((meeting) => (meeting.ends_at ?? (meeting.starts_at + twoHours)) >= now)
    .sort(compareMeetings)
    .slice(0, limit);
}

const SESSION_RPCS = [
  "public.list_member_qa_questions",
  "public.search_member_qa_history",
  "public.get_member_qa_question",
  "public.ask_member_qa_question",
  "public.reply_member_qa_official",
  "public.reply_member_qa_follow_up",
  "public.toggle_member_qa_vote",
  "public.accept_member_qa_answer",
  "public.edit_member_qa_question",
  "public.delete_member_qa_question",
  "public.edit_member_qa_reply",
  "public.delete_member_qa_reply",
  "public.list_member_qa_officer_queue",
  "public.get_organization_analytics_snapshot",
  "public.request_organization_analytics_export",
  "public.list_pay_scale_grades",
  "public.list_pay_scale_steps",
  "public.upsert_pay_scale_grade",
  "public.upsert_pay_scale_step",
  "public.list_organization_integrations",
  "public.upsert_organization_integration",
  "public.list_chapter_integration_overrides",
  "public.upsert_chapter_integration_override",
  "public.list_integration_jobs",
  "public.list_integration_webhooks",
  "public.create_integration_webhook",
  "public.set_integration_webhook_active",
  "public.delete_integration_webhook",
  "public.list_integration_api_keys",
  "public.create_integration_api_key",
  "public.revoke_integration_api_key",
  "public.list_organization_audit_ledger",
  "public.list_organization_job_health",
  "public.acknowledge_organization_job_run",
  "public.request_organization_job_retry",
];

describe("MI1 W1 feature persistence reserved migration", () => {
  it("is the only 20260822020000 file and records the reserved CLI name", () => {
    const matches = migrationNames().filter((name) => name.startsWith("20260822020000"));
    expect(matches).toEqual(["20260822020000_mi1_w1_feature_persistence.sql"]);
    expect(sql).toContain("npx supabase migration new mi1_w1_feature_persistence");
    expect(sql).toContain("CLI 2.109.1");
  });

  it("does not replay donor migrations or seed an organization", () => {
    for (const rejected of [
      "0304",
      "0311",
      "0633",
      "0752",
      "audit_log",
      "cron_runs",
      "public.members",
      "public.branches",
    ]) {
      expect(code).not.toContain(rejected);
    }
    expect(code).not.toMatch(/insert into public\.organizations\b/i);
    expect(code).not.toMatch(/insert into auth\.users\b/i);
  });

  it("creates every first-wave table with RLS, revoke-all, and no anon grants", () => {
    for (const table of MI1_W1_FEATURE_PERSISTENCE_RLS_TABLES) {
      expect(code).toContain(`create table public.${table}`);
      expect(code).toContain(`alter table public.${table} enable row level security`);
      expect(code).toContain(`revoke all on public.${table} from public, anon, authenticated`);
    }
    expect(code).toContain("grant select on public.pay_scale_grades to authenticated");
    expect(code).toContain("grant select on public.pay_scale_steps to authenticated");
    expect(code).toContain("grant select on public.organization_audit_ledger to authenticated");
    expect(code).not.toMatch(/grant (select|insert|update|delete) on public\.\w+ to anon/i);
  });

  it("uses empty-search_path catalog forms instead of SQL-keyword function calls", () => {
    expect(code).not.toMatch(/pg_catalog\.extract\s*\(/i);
    expect(code).not.toMatch(/pg_catalog\.substring\s*\([^)]*\bfrom\b/i);
    expect(body("public.list_pay_scale_steps")).toContain("pg_catalog.date_part('year', s.effective_on)");
    expect(body("public.create_integration_webhook")).toContain("pg_catalog.regexp_match(p_url, '^https://([^/]+)')");
    expect(body("public.get_organization_analytics_snapshot")).toContain("pg_catalog.count(*) as event_count");
    expect(body("public.get_organization_analytics_snapshot")).toContain("'count', counted.event_count");
  });

  it("keeps organization_job_runs organization_id nullable only for platform ticks", () => {
    const start = code.indexOf("create table public.organization_job_runs (");
    const end = code.indexOf("create table public.organization_job_acknowledgements (");
    const table = code.slice(start, end);
    expect(table).toContain("organization_id uuid references public.organizations(id)");
    expect(table).not.toContain("organization_id uuid not null");
    expect(table).toContain("unique nulls not distinct (job_name, run_id, organization_id)");
    expect(body("public.list_organization_job_health")).toContain("notifications-dispatch-tick");
  });

  it("binds altered public records and historical cases to immutable tenants", () => {
    for (const policy of ["read", "create", "update", "delete"]) {
      expect(code).toContain(`create policy public_site_records_staff_${policy}`);
    }
    expect(code).toMatch(/private\.has_organization_role\(\s*organization_id/);
    expect(code).toContain("create trigger member_cases_bind_organization");
    expect(body("private.mi1_bind_case_owner")).toContain("case organization and chapter are immutable");
    expect(body("private.mi1_bind_case_owner")).toContain("legacy case ownership requires an explicit backfill");
    expect(body("private.mi1_bind_case_owner")).toContain("new.organization_id := owner_organization");
  });

  it("redacts deleted replies and bounds Q&A aggregation before projection", () => {
    const projector = body("private.mi1_qa_project_question");
    expect(projector).toContain("limited.deleted_at is null");
    expect(projector).toContain("limit 100");
    const list = body("public.list_member_qa_questions");
    expect(list).toMatch(/select candidate\.id[\s\S]*limit 50\s*\) q/);
    expect(body("public.list_member_qa_officer_queue")).toContain("limit 50");
    const ask = body("public.ask_member_qa_question");
    expect(ask).toContain("existing_deleted_at");
    expect(ask).toContain("'deleted', true");
  });

  it("suppresses low-N analytics, uses immutable case ownership, and audits reads", () => {
    const analytics = body("public.get_organization_analytics_snapshot");
    expect(analytics).toContain("privacy_threshold integer := 5");
    expect(analytics).toContain("cs.organization_id = org");
    expect(analytics).toContain("having pg_catalog.count(*) >= privacy_threshold");
    expect(analytics).toContain("'analytics_snapshot_read'");
    expect(analytics).not.toContain("'id', cs.id");
    expect(analytics).not.toContain("join public.member_profiles");
  });

  it("keeps audit replay append-only and audit pagination complete", () => {
    const writer = body("public.record_organization_audit_event");
    expect(writer).toContain("on conflict (idempotency_key) do nothing");
    expect(writer).toContain("audit idempotency key payload mismatch");
    expect(writer).not.toContain("do update");
    const reader = body("public.list_organization_audit_ledger");
    expect(reader).toContain("'actorUserId'");
    expect(reader).toContain("when e.event_type like 'qa_%' then 'knowledge'");
    expect(reader).toContain("when a.action ~ 'grant' then 'grant'");
    expect(reader).toContain("(normalized.occurred_at, normalized.id) <");
    expect(reader).toContain("normalized.domain = p_domain");
    expect(code).toContain("public.list_organization_audit_ledger(integer, timestamptz, uuid, text, text)");
  });

  it("enforces same-tenant public associations and prevalidates bounded RSVP input", () => {
    expect(body("public.get_public_chapter_microsite")).toContain("e.organization_id = r.organization_id");
    expect(body("private.mi1_forbid_ownerless_public_publish")).toContain("meeting chapter must belong to the same organization");
    const rsvp = body("public.submit_public_event_rsvp");
    expect(rsvp).toContain("pg_catalog.char_length(normalized_email) not between 3 and 254");
    expect(rsvp).toContain("pg_catalog.char_length(normalized_name) > 100");
    expect(rsvp.indexOf("normalized_email !~")).toBeLessThan(rsvp.indexOf("network_allowed :="));
    expect(body("public.upsert_pay_scale_step")).toContain("p_step_number > declared_step_count");
    expect(body("public.upsert_pay_scale_step")).toContain("for update");
    expect(body("public.upsert_pay_scale_grade")).toContain("for update");
    expect(body("public.upsert_pay_scale_grade")).toContain("step count is below an existing scale step");
  });
});

describe("SECURITY DEFINER persistence", () => {
  it("pins every new public definer to an empty search_path and revokes PUBLIC execute", () => {
    for (const name of [
      ...SESSION_RPCS,
      "public.get_public_directory",
      "public.get_public_event_detail",
      "public.get_public_chapter_microsite",
      "public.submit_public_event_rsvp",
      "public.record_organization_audit_event",
    ]) {
      const fn = body(name);
      expect(fn, name).toMatch(/set search_path = ''/i);
      expect(fn, name).toMatch(/security definer/i);
    }
    expect(code).toContain("revoke all on function public.list_member_qa_questions(text, text, text) from public, anon, authenticated, service_role");
    expect(code).toContain("revoke all on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text) from public, anon, authenticated, service_role");
    expect(code).toContain("grant execute on function public.record_organization_audit_event(uuid, text, text, text, text, text, uuid, jsonb) to service_role");
    expect(code).not.toMatch(/grant execute on function public\.record_organization_audit_event\([^)]*\) to authenticated/);
  });

  it("derives tenant authority from the session and never from a caller organization argument", () => {
    for (const name of SESSION_RPCS) {
      expect(body(name), name).not.toMatch(/\bp_organization_id\b/);
      expect(body(name), name).toContain("private.mfa_satisfied()");
    }
    expect(code).not.toMatch(/member_roles\.chapter_id is null/i);
    const recorder = body("public.record_organization_audit_event");
    expect(recorder).toContain("audit organization is derived from the session");
    expect(recorder).toContain("p_organization_id is distinct from org");
  });

  it("keeps SCIM disabled and omits secret hashes from list projections", () => {
    const upsert = body("public.upsert_organization_integration");
    expect(upsert).toContain("SCIM stays disabled until the enterprise-later gate");
    expect(upsert).toContain("next_status := 'disabled'");
    expect(body("public.list_organization_integrations")).toContain("hasCredentialRef");
    expect(body("public.list_organization_integrations")).not.toContain("credential_ref,");
    expect(body("public.list_integration_webhooks")).toContain("lastDeliveryStatus");
    expect(body("public.list_integration_webhooks")).not.toContain("secret_hash");
    expect(body("public.list_integration_api_keys")).toContain("keyPrefix");
    expect(body("public.list_integration_api_keys")).not.toContain("key_hash");
  });

  it("keeps public RSVP service-role-only with a uniform accepted response", () => {
    const rsvp = body("public.submit_public_event_rsvp");
    expect(rsvp).toContain("service role required");
    expect(rsvp).toContain("jsonb_build_object('accepted', true)");
    expect(code).toContain("grant execute on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text) to service_role");
    expect(code).not.toMatch(/grant execute on function public\.submit_public_event_rsvp\([^)]*\) to (anon|authenticated)/);
    expect(body("public.get_public_directory")).toContain("r.organization_id is not null");
    expect(body("public.get_public_event_detail")).toContain("kind = 'meeting'");
    expect(body("public.get_public_chapter_microsite")).toContain("kind = 'chapter'");
  });
});

describe("db-contract lockstep", () => {
  it("records the first-wave tables, policies, MFA exemptions, and RLS count", () => {
    expectMi1OrganizationRlsContract(contract);
    expect(contract.policies.some((entry) => entry.name === "pay_scale_grades_select_member")).toBe(true);
    expect(contract.policies.some((entry) => entry.name === "organization_audit_ledger_select_admin")).toBe(true);
    expect(contract.mfaCoverage.exempt).toHaveProperty("get_public_directory");
    expect(contract.mfaCoverage.exempt).toHaveProperty("get_public_event_detail");
    expect(contract.mfaCoverage.exempt).toHaveProperty("get_public_chapter_microsite");
    expect(contract.functions.some((entry) => entry.sig.startsWith("public.list_member_qa_questions("))).toBe(true);
    expect(contract.functions.some((entry) => entry.sig.startsWith("public.submit_public_event_rsvp("))).toBe(true);
    expect(contract.functions.some((entry) => (
      entry.sig.startsWith("public.record_organization_audit_event(") && entry.exec === "service_role"
    ))).toBe(true);
    expect(contract.functions.some((entry) => (
      entry.sig.startsWith("private.mi1_require_selected_organization(") && entry.exec === ""
    ))).toBe(true);
    expect(contract.functions.some((entry) => (
      entry.sig === "private.mi1_bind_case_owner()" && entry.exec === ""
    ))).toBe(true);
    expect(contract.triggers).toContainEqual(expect.objectContaining({
      table: "member_cases",
      name: "member_cases_bind_organization",
      function: "private.mi1_bind_case_owner",
      timing: "BEFORE",
      events: "INSERT,UPDATE",
    }));
    for (const expected of [
      ["public_site_records", "public_site_records_require_organization", "private.mi1_forbid_ownerless_public_publish", "INSERT,UPDATE"],
      ["member_qa_replies", "member_qa_replies_same_organization", "private.mi1_qa_reply_same_organization", "INSERT,UPDATE"],
      ["organization_audit_ledger", "organization_audit_ledger_append_only", "private.mi1_audit_ledger_append_only", "DELETE,UPDATE"],
    ]) {
      expect(contract.triggers).toContainEqual(expect.objectContaining({
        table: expected[0],
        name: expected[1],
        function: expected[2],
        timing: "BEFORE",
        events: expected[3],
      }));
    }
    const directory = contract.functions.find((entry) => entry.sig === "public.get_public_directory(p_locale text)");
    expect(directory?.bodyContains).toContain(DIRECTORY_UPCOMING_PREDICATE);
    expect(directory?.bodyContains).toContain("limit 12");
  });
});

describe("public directory upcoming events window", () => {
  it.each([
    [DIRECTORY_RPC, "20260924150200_public_directory_upcoming_events_window", 2],
    [SITE_CONTENT_RPC, "20260925620500_public_site_content_organization_quarantine", 3],
  ])("preserves the preceding %s body except for visibility filters", (fn, predecessor, count) => {
    const previous = parseFunctions(loadMigrationSql(predecessor)).find((entry) => entry.name === fn).source;
    const current = parseFunctions(loadMigrationSql(DIRECTORY_VISIBILITY_MIGRATION.replace(/\.sql$/, "")))
      .find((entry) => entry.name === fn).source;
    const added = /^[ \t]*and private\.organization_visible_in_directory\(r\.organization_id\)\n/gm;
    expect([...current.matchAll(added)]).toHaveLength(count);
    expect(stripComments(current.replace(added, ""))).toBe(stripComments(previous));
  });

  it("keeps the last directory events aggregation upcoming, soonest-first, and limited", () => {
    const { definitions, last } = lastDefinition(DIRECTORY_RPC);
    expect(definitions.map((entry) => entry.name)).toEqual([
      "20260822020000_mi1_w1_feature_persistence.sql",
      DIRECTORY_WINDOW_MIGRATION,
      DIRECTORY_VISIBILITY_MIGRATION,
      "20261028080000_platform_organization_boundary.sql",
      findMigrationName("own_member_fictional_chapter_directory"),
    ]);
    expect(last?.name).toBe(findMigrationName("own_member_fictional_chapter_directory"));
    expect(last.body).toBe(definitions.at(-2).body.replace(
      "private.organization_visible_in_directory(r.organization_id)",
      "private.organization_chapters_visible_in_directory(r.organization_id)",
    ));
    expect(definitions.at(-2).body.replace(/\n[ \t]*and private\.organization_is_union\(r\.organization_id\)/g, ""))
      .toBe(definitions.at(-3).body);
    expect(definitions.at(-3).name).toBe(DIRECTORY_VISIBILITY_MIGRATION);
    const events = namedBlock(last.body, "events");
    expect(events).toContain(DIRECTORY_UPCOMING_PREDICATE);
    expect(events).toMatch(RECENCY_PREDICATE);
    expect(events).toMatch(/order by r\.starts_at, r\.sort_order, r\.id\s+limit 12/);
    expect(events).toMatch(/jsonb_agg\(item\.payload order by item\.starts_at, item\.sort_order, item\.id\)/);
    expect(last.body).toMatch(/security definer/i);
    expect(last.body).toMatch(/set search_path = ''/i);
    expect(stripComments(directoryWindowSql)).toMatch(
      /grant execute on function public\.get_public_directory\(text\)\s+to anon, authenticated, service_role/i,
    );
  });

  it("keeps get_public_site_content meetings and get_public_directory events recency-bounded", () => {
    const directory = lastDefinition(DIRECTORY_RPC).last;
    const site = lastDefinition(SITE_CONTENT_RPC).last;
    const directoryEvents = namedBlock(directory.body, "events");
    const siteMeetings = namedBlock(site.body, "meetings");
    expect(directoryEvents).toMatch(RECENCY_PREDICATE);
    expect(directoryEvents).toMatch(/\blimit\s+\d+/i);
    expect(siteMeetings).toMatch(RECENCY_PREDICATE);
    expect(siteMeetings).toMatch(/\blimit\s+\d+/i);
    // The fictional-organization exclusion preserves the quarantine and
    // meeting recency bounds; the platform boundary then adds only its
    // organization-kind predicate to that landing reader. The own-member
    // exception changes only its chapter predicate, not meetings or wins.
    const definitions = lastDefinition(SITE_CONTENT_RPC).definitions;
    expect(site.name).toBe(findMigrationName("own_member_fictional_chapter_directory"));
    expect(site.body).toBe(definitions.at(-2).body.replace(
      "private.organization_visible_in_directory(r.organization_id)",
      "private.organization_chapters_visible_in_directory(r.organization_id)",
    ));
    expect(definitions.at(-3).name).toBe(DIRECTORY_VISIBILITY_MIGRATION);
    expect(definitions.at(-2).body.replace(/\n[ \t]*and private\.organization_is_union\(r\.organization_id\)/g, ""))
      .toBe(definitions.at(-3).body);
  });

  it("surfaces a future meeting after historical meetings fill the old unbounded window", () => {
    const now = Date.parse("2026-09-21T16:00:00-04:00");
    const hour = 60 * 60 * 1000;
    const past = Array.from({ length: 15 }, (_, index) => ({
      id: `past-${String(index).padStart(3, "0")}`,
      sort_order: index,
      starts_at: now - ((16 - index) * hour),
      ends_at: now - ((16 - index) * hour) + hour / 2,
    }));
    const lingering = {
      id: "lingering-001",
      sort_order: 0,
      starts_at: now - hour,
      ends_at: null,
    };
    const future = Array.from({ length: 14 }, (_, index) => ({
      id: `future-${String(index).padStart(3, "0")}`,
      sort_order: index,
      starts_at: now + ((index + 1) * hour),
      ends_at: now + ((index + 1) * hour) + hour,
    }));
    const fixtures = [...past, lingering, ...future];

    const oldWindow = oldestUnfilteredWindow(fixtures);
    expect(oldWindow[0].id).toBe("past-000");
    expect(oldWindow.some((meeting) => meeting.id.startsWith("future-"))).toBe(true);

    const nextWindow = upcomingDirectoryWindow(fixtures, now);
    expect(nextWindow).toHaveLength(DIRECTORY_LIMIT);
    expect(nextWindow[0].id).toBe(lingering.id);
    expect(nextWindow.map((meeting) => meeting.id)).toEqual([
      lingering.id,
      ...future.slice(0, DIRECTORY_LIMIT - 1).map((meeting) => meeting.id),
    ]);
    expect(nextWindow.some((meeting) => meeting.id.startsWith("past-"))).toBe(false);
    expect(nextWindow.some((meeting) => meeting.id === "future-013")).toBe(false);
  });
});
