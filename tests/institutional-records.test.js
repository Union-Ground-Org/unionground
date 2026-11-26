import { requireRlsTables } from "../scripts/lib/db-contract-tables.mjs";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import sampleBackend from "../config/sample-backend.json" with { type: "json" };
import { deniedHostsIn, deniedTokensIn, digestSet } from "../scripts/lib/denied-identity.mjs";
import {
  loadInstitutionalRecordsWorkspace,
  loadMinutesMeetingCheckins,
  downloadOrganizationExport,
  requestOrganizationExport,
  saveChapterContactLog,
  saveChapterMinutes,
  saveInstitutionalRecord,
  setChapterMinutesApproval,
  serializeOrganizationExport,
} from "../src/lib/institutionalRecordsApi.js";

describe("scoped institutional record requests", () => {
  it("binds an unscoped write to the chapter and organization shown in the workspace", async () => {
    const client = { rpc: vi.fn(async () => ({ data: { saved: true } })) };
    await saveInstitutionalRecord(client, { title: "Minutes", body: "Record", recordType: "minutes", occurredAt: "2026-10-31T12:00:00.000-04:00", expectedChapter: "chapter", expectedOrganization: "org" });
    expect(client.rpc).toHaveBeenCalledWith("save_scoped_institutional_record", expect.objectContaining({ p_expected_chapter: "chapter", p_expected_organization: "org", p_access_unit_id: null, p_access_committee_id: null }));
  });
  it.each([["unit:u", "u", null], ["committee:c", null, "c"], ["", null, null]])("sends an explicit %s scope without changing legacy calls", async (accessScope, unit, committee) => {
    const client = { rpc: vi.fn(async () => ({ data: { saved: true } })) };
    await saveInstitutionalRecord(client, { title: "Minutes", body: "Record", recordType: "minutes", occurredAt: "2026-10-31T12:00:00.000-04:00", accessScope });
    expect(client.rpc).toHaveBeenCalledWith("save_scoped_institutional_record", expect.objectContaining({ p_access_unit_id: unit, p_access_committee_id: committee }));
  });
});
import {
  INSTITUTIONAL_RECORDS_RLS_TABLES,
} from "./helpers/mi1Contract.js";
import {
  fnBody,
  loadMigrationSql,
  migrationFiles,
  stripComments,
} from "./helpers/migration.js";

// The check scripts/lib/sibling-deny-list.mjs siblingIdentityIn makes, built
// from the same digest lists (config/sample-backend.json). That module reads
// the list through `new URL(..., import.meta.url)`, which this file's jsdom
// transform rewrites to a non-file URL, so it cannot be imported here.
const SIBLING_DIGESTS = {
  refs: digestSet(sampleBackend.forbiddenSupabaseRefSha256),
  hosts: digestSet(sampleBackend.forbiddenAppHostSha256),
  tokens: digestSet(sampleBackend.forbiddenIdentityTokenSha256),
};
function siblingIdentityIn(text) {
  const lower = String(text).toLowerCase();
  return [
    ...deniedTokensIn(lower, SIBLING_DIGESTS.refs),
    ...deniedHostsIn(lower, SIBLING_DIGESTS.hosts),
    ...deniedTokensIn(lower, SIBLING_DIGESTS.tokens),
  ];
}

function clientWith(data = {}) {
  return { rpc: vi.fn().mockResolvedValue({ data, error: null }) };
}

describe("institutional record client boundary", () => {
  it("loads only through the scoped workspace RPC", async () => {
    const client = clientWith({ records: [], contacts: [] });
    await expect(loadInstitutionalRecordsWorkspace(client)).resolves.toEqual({ records: [], contacts: [] });
    expect(client.rpc).toHaveBeenCalledWith("get_institutional_records_workspace");
  });

  it("maps version, lifecycle, curation, and attendance to one guarded write", async () => {
    const client = clientWith({ id: "record-1" });
    await saveInstitutionalRecord(client, {
      recordId: "record-1", expectedVersion: 2, recordType: "minutes", title: "  Minutes  ", body: "  Approved  ",
      occurredAt: "2026-08-30T12:00:00Z", visibility: "chapter", action: "publish", pinned: true,
      gapNote: "  Earlier material is not digitized. ", attendance: [{ userId: "member-1", status: "present" }],
    });
    expect(client.rpc).toHaveBeenCalledWith("save_institutional_record", expect.objectContaining({
      p_record_id: "record-1", p_expected_version: 2, p_title: "Minutes", p_body: "Approved",
      p_action: "publish", p_pinned: true, p_gap_note: "Earlier material is not digitized.",
      p_attendance: [{ userId: "member-1", status: "present" }],
    }));
  });

  // REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030.
  it("saves minutes with their location in one call, trimming a blank or missing location to null", async () => {
    const minimal = { title: " Minutes ", body: " Body ", occurredAt: "2026-11-04T18:00:00Z" };
    for (const [location, expected] of [["  Union hall  ", "Union hall"], ["   ", null], [undefined, null], [null, null]]) {
      const client = clientWith({ id: "minutes-1", version: 3 });
      await expect(saveChapterMinutes(client, { ...minimal, recordId: "minutes-1", expectedVersion: 2, location })).resolves.toEqual({ id: "minutes-1", version: 3 });
      expect(client.rpc).toHaveBeenCalledWith("save_chapter_minutes", {
        p_record_id: "minutes-1", p_title: "Minutes", p_body: "Body", p_occurred_at: "2026-11-04T18:00:00Z",
        p_visibility: "chapter", p_action: "save", p_pinned: false, p_gap_note: null, p_expected_version: 2,
        p_attendance: [], p_location: expected,
      });
    }
    const created = clientWith({ id: "minutes-new" });
    await saveChapterMinutes(created, { ...minimal, location: "Hall" });
    expect(created.rpc.mock.calls[0][1]).toEqual(expect.objectContaining({ p_record_id: null, p_expected_version: null, p_location: "Hall" }));
    expect(created.rpc.mock.calls[0][1]).not.toHaveProperty("p_record_type");
  });

  it("approves the shown version and reads check-ins as a list, never anything else", async () => {
    const approve = clientWith({ id: "minutes-1", approvedVersion: 2 });
    await setChapterMinutesApproval(approve, "minutes-1", 2, 1);
    expect(approve.rpc).toHaveBeenCalledWith("set_chapter_minutes_approval", { p_record_id: "minutes-1", p_expected_version: 2, p_approved: true });
    const withdraw = clientWith({ id: "minutes-1" });
    await setChapterMinutesApproval(withdraw, "minutes-1", 3, undefined);
    expect(withdraw.rpc).toHaveBeenCalledWith("set_chapter_minutes_approval", { p_record_id: "minutes-1", p_expected_version: 3, p_approved: false });

    await expect(loadMinutesMeetingCheckins(clientWith({ eventId: "e", checkedIn: ["u-1", "u-2"] }), "minutes-1")).resolves.toEqual(["u-1", "u-2"]);
    await expect(loadMinutesMeetingCheckins(clientWith({ eventId: null, checkedIn: null }), "minutes-1")).resolves.toEqual([]);
    const nothing = { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
    await expect(loadMinutesMeetingCheckins(nothing, "minutes-1")).resolves.toEqual([]);
    expect(nothing.rpc).toHaveBeenCalledWith("get_minutes_meeting_checkins", { p_record_id: "minutes-1" });
    const refused = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "" } }) };
    await expect(loadMinutesMeetingCheckins(refused, "minutes-1")).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps contact scope server-owned and optional links nullable", async () => {
    const client = clientWith({ id: "contact-1" });
    await saveChapterContactLog(client, {
      contactKind: "community", channel: "phone", purpose: "  Follow up  ", summary: "  Called partner  ",
      outcome: "", occurredAt: "2026-08-30T12:00:00Z", followUpAt: "", subjectUserId: "", caseId: "", taskId: "",
    });
    expect(client.rpc).toHaveBeenCalledWith("save_chapter_contact_log", expect.objectContaining({
      p_contact_kind: "community", p_purpose: "Follow up", p_summary: "Called partner",
      p_subject_user_id: null, p_case_id: null, p_task_id: null,
    }));
  });

  it("requests selected domains and serializes bounded JSON/CSV on-device", async () => {
    const result = { receiptId: "receipt-1", format: "csv", domains: ["members"], rowCount: 1, expiresAt: "2026-08-30T12:15:00Z", rows: [{ domain: "members", occurredAt: "2026-08-30T12:00:00Z", values: { name: "A, B", active: true, note: "=HYPERLINK(\"unsafe\")" } }] };
    const client = clientWith(result);
    await expect(requestOrganizationExport(client, { domains: ["members"], format: "csv", from: null, to: null })).resolves.toEqual(result);
    expect(client.rpc).toHaveBeenCalledWith("request_filtered_organization_export", { p_domains: ["members"], p_format: "csv", p_from: null, p_to: null });
    expect(serializeOrganizationExport(result)).toContain('"A, B"');
    expect(serializeOrganizationExport(result)).toContain('"\'=HYPERLINK(""unsafe"")"');
    expect(JSON.parse(serializeOrganizationExport({ ...result, format: "json" })).rows).toHaveLength(1);
  });

  it("surfaces database errors without leaking a fallback write", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "staff role required", code: "42501" } }) };
    await expect(loadInstitutionalRecordsWorkspace(client)).rejects.toMatchObject({ message: "Load institutional records: staff role required", code: "42501" });
  });

  it.each(["csv", "json"])("downloads %s exports through a short-lived object URL", (format) => {
    const createObjectURL = vi.fn(() => "blob:institutional-export");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    try {
      downloadOrganizationExport({ receiptId: "receipt-1", format, domains: ["members"], rows: [] });
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:institutional-export");
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("institutional migration invariants", () => {
  const sql = readFileSync("supabase/migrations/20260830060000_institutional_records_completion.sql", "utf8");
  const triggerRepairPath = "supabase/migrations/20260830071000_demo_seed_institutional_evidence_trigger_repair.sql";
  const dbContract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
  it("records donor provenance and refuses legacy shortcuts", () => {
    expect(sql).toContain("donor-baseline-20260721");
    expect(sql).toContain("Rejected from that baseline");
    expect(sql).not.toMatch(/insert into public\.(organizations|chapters|member_profiles)\b/i);
  });
  it("enforces version, tenant, RLS, entitlement-spend, and export ceilings", () => {
    for (const needle of ["chapter_record_versions", "member_weekly_question_promotions", "private.current_member_organization()", "enable row level security", "p_expected_version", "limit 10001", "organization export role required"]) expect(sql).toContain(needle);
  });
  it("registers every new catalog object with the platform MFA and DB-contract backstops", () => {
    for (const table of [
      "chapter_record_versions",
      "meeting_attendance",
      "meeting_minutes_dispatches",
      "chapter_contact_log",
      "organization_data_export_runs",
      "member_weekly_question_promotions",
    ]) expect(sql).toContain(`create policy mfa_assurance on public.${table} as restrictive`);
    for (const signature of [
      "private.demo_seed_institutional_records_from_evidence()",
      "private.demo_seed_remove_institutional_records(p_lane text, p_run_id uuid)",
    ]) {
      expect(dbContract.functions.some(({ sig }) => sig === signature)).toBe(false);
      expect(readFileSync("supabase/migrations/20261018064849_retire_pre_bot_seed_functions.sql", "utf8"))
        .toContain(`drop function if exists ${signature} restrict;`);
    }
    requireRlsTables(dbContract, INSTITUTIONAL_RECORDS_RLS_TABLES);
    expect(sql.match(/if not private\.mfa_satisfied\(\) then/g)).toHaveLength(2);
  });

  it("runs the institutional composer only for its canonical evidence and supplies seed identity", () => {
    const repair = readFileSync(triggerRepairPath, "utf8");
    expect(repair).toContain("where evidence.surface = 'memberWeeklyQuestions'");
    expect(repair).toContain("pg_catalog.set_config(");
    expect(repair).toContain("'request.jwt.claims'");
    expect(repair).toContain("'sub', creator");
    expect(repair).toContain("'role', 'service_role'");
    expect(repair).toContain("coalesce(previous_claims, '')");
  });
});

function eventTypes(source) {
  const definitions = [...source.matchAll(
    /add constraint organization_audit_events_event_type_check check \(event_type in \(([\s\S]*?)\)\)/g,
  )];
  expect(definitions.length).toBeGreaterThan(0);
  return [...definitions.at(-1)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function metadataKeys(source) {
  const definitions = [...source.matchAll(
    /add constraint organization_audit_events_metadata_keys check \(\s*metadata - array\[([\s\S]*?)\]\s*=\s*'\{\}'::jsonb/g,
  )];
  expect(definitions.length).toBeGreaterThan(0);
  return [...definitions.at(-1)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function currentExportBody() {
  let body = null;
  for (const file of migrationFiles()) {
    try {
      body = stripComments(fnBody(file.sql, "public.request_filtered_organization_export"));
    } catch {
      // This file does not declare the export function.
    }
  }
  if (!body) throw new Error("public.request_filtered_organization_export is missing from the current tree");
  return body;
}

describe("institutional export durable audit", () => {
  const NAME = "20260924030100_institutional_export_durable_audit";
  const sql = loadMigrationSql(NAME);
  const code = stripComments(sql);
  const original = loadMigrationSql("20260830060000_institutional_records_completion");
  const previousEvents = loadMigrationSql("20260917131000_mi1_dues_oauth_recovery_row_shape");
  const latestMetadata = loadMigrationSql("20260917140000_mi1_dues_oauth_callback_audit_metadata");

  it("applies after the receipt-only export and the current audit CHECKs", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260830060000_institutional_records_completion").toBe(true);
    expect(NAME > "20260917131000_mi1_dues_oauth_recovery_row_shape").toBe(true);
    expect(NAME > "20260917140000_mi1_dues_oauth_callback_audit_metadata").toBe(true);
  });

  it("writes a durable completed-export audit only after every refusal path", () => {
    const body = currentExportBody();
    expect(body).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])");
    expect(body).toContain("private.institutional_context(true)");
    expect(body).toContain("private.has_organization_role(ctx.organization_id, array['admin','vp'])");
    expect(body).toContain("limit 10001");
    expect(body).toContain("pg_catalog.now() + interval '15 minutes'");
    expect([...body.matchAll(/private\.mi1_w2_write_audit/g)]).toHaveLength(1);
    const auditAt = body.indexOf("private.mi1_w2_write_audit");
    expect(body.indexOf("organization export role required")).toBeLessThan(auditAt);
    expect(body.indexOf("invalid export request")).toBeLessThan(auditAt);
    expect(body.indexOf("export exceeds 10000 rows")).toBeLessThan(auditAt);
    expect(body.indexOf("insert into public.organization_data_export_runs")).toBeLessThan(auditAt);
    expect(body.indexOf("return pg_catalog.jsonb_build_object")).toBeGreaterThan(auditAt);
    expect(body).toContain("'organization_export_completed'");
    expect(body).toContain("'exportType', 'filtered'");
    expect(body).toContain("'exportFormat', p_format");
    expect(body).toContain("'rowCount', total");
    expect(body).toContain("'status', 'completed'");
  });

  it("admits organization_export_completed without dropping prior event types", () => {
    expect(sql).toContain("drop constraint organization_audit_events_event_type_check");
    expect(sql).not.toContain("drop constraint organization_audit_events_metadata_keys");
    const before = eventTypes(previousEvents);
    const after = eventTypes(sql);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual(["organization_export_completed"]);
    expect(new Set(after).size).toBe(after.length);
  });

  it("reuses already-admitted metadata keys for export type, format, row count, and status", () => {
    const keys = metadataKeys(latestMetadata);
    for (const key of ["exportType", "exportFormat", "rowCount", "status"]) {
      expect(keys).toContain(key);
    }
  });

  it("leaves organization_audit_events untouched by both receipt purges", () => {
    expect(original).toContain("delete from public.organization_data_export_runs");
    expect(original.match(/delete from public\.organization_data_export_runs/g)).toHaveLength(2);
    expect(original).not.toMatch(/delete from public\.organization_audit_events/i);
    expect(code).not.toMatch(/delete from public\.organization_audit_events/i);
    expect(currentExportBody()).toContain("delete from public.organization_data_export_runs");
    expect(currentExportBody()).not.toMatch(/delete from public\.organization_audit_events/i);
  });
});

const live = process.env.RUN_INSTITUTIONAL_EXPORT_AUDIT_DB_TESTS === "1" ? describe : describe.skip;

live("institutional export durable audit (live)", () => {
  const FIXTURES = Object.freeze({
    org: "02100000-0000-4000-8000-000000000001",
    admin: "02100000-0000-4000-8000-000000000011",
    member: "02100000-0000-4000-8000-000000000012",
    chapter: "export-audit-a",
  });
  // The MFA boundary reads a live auth.sessions row, not the aal claim alone,
  // so each caller carries the id of the aal2 session seeded below.
  const SESSIONS = Object.freeze({
    [FIXTURES.admin]: "02100000-0000-4000-8000-000000000021",
    [FIXTURES.member]: "02100000-0000-4000-8000-000000000022",
  });

  async function asUser(client, userId) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: SESSIONS[userId] }),
    ]);
    await client.query("set local role authenticated");
  }

  it("keeps an accurate durable audit row through success, denial, and receipt expiry", async () => {
    const { default: pg } = await import("pg");
    const url = process.env.INSTITUTIONAL_RECORDS_DB_URL || process.env.SUPABASE_DB_URL;
    expect(url).toBeTruthy();
    const parsed = new URL(url);
    expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
    // The same refusal scripts/verify-institutional-records-local.mjs makes:
    // no hosted Supabase target and nothing on the sibling deny list.
    expect(url).not.toContain("supabase.co");
    expect(siblingIdentityIn(url)).toEqual([]);

    const client = new pg.Client({ connectionString: url, ssl: false });
    await client.connect();
    await client.query("begin");
    await client.query("select pg_catalog.pg_advisory_xact_lock(509, 21000)");
    try {
      await client.query(
        "insert into auth.users (id, email) values ($1, 'export-audit-admin@example.invalid'), ($2, 'export-audit-member@example.invalid')",
        [FIXTURES.admin, FIXTURES.member],
      );
      await client.query(
        "insert into public.organizations (id, slug, name, created_by) values ($1, 'export-audit-a', 'Export Audit A', $2)",
        [FIXTURES.org, FIXTURES.admin],
      );
      await client.query(
        "insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, 'Export Audit A', 'export-audit-a', true, 1, $2)",
        [FIXTURES.chapter, FIXTURES.org],
      );
      await client.query(
        "insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active'), ($1, $3, 'active')",
        [FIXTURES.org, FIXTURES.admin, FIXTURES.member],
      );
      await client.query(
        "insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $3, 'active'), ($2, $3, 'active')",
        [FIXTURES.admin, FIXTURES.member, FIXTURES.chapter],
      );
      await client.query(
        "update public.member_profiles set chapter_id = $1 where id = any($2::uuid[])",
        [FIXTURES.chapter, [FIXTURES.admin, FIXTURES.member]],
      );
      await client.query(
        "insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)",
        [FIXTURES.org, FIXTURES.admin],
      );
      await client.query(
        "insert into public.member_roles (user_id, role, chapter_id, granted_by) values ($1, 'admin', $2, $1)",
        [FIXTURES.admin, FIXTURES.chapter],
      );
      await client.query(
        "insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values ($1, 'admin', $2, $1)",
        [FIXTURES.admin, FIXTURES.chapter],
      );
      await client.query(
        "insert into public.org_security_policy (id, organization_id, require_staff_mfa) values (true, $1, false)",
        [FIXTURES.org],
      );
      await client.query(
        "insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now()), ($3, $4, 'aal2', now(), now())",
        [SESSIONS[FIXTURES.admin], FIXTURES.admin, SESSIONS[FIXTURES.member], FIXTURES.member],
      );
      await client.query(
        "insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())",
        ["02100000-0000-4000-8000-000000000031", FIXTURES.admin],
      );

      await asUser(client, FIXTURES.member);
      await client.query("savepoint denied_export");
      try {
        await client.query("select public.request_filtered_organization_export(array['members'], 'json')");
        throw new Error("member export should have been denied");
      } catch (error) {
        expect(error.code).toBe("42501");
      }
      await client.query("rollback to savepoint denied_export");
      await client.query("release savepoint denied_export");
      await client.query("reset role");
      const denied = await client.query(
        "select count(*)::int as n from public.organization_audit_events where organization_id = $1 and event_type = 'organization_export_completed'",
        [FIXTURES.org],
      );
      expect(denied.rows[0].n).toBe(0);

      await asUser(client, FIXTURES.admin);
      const exported = (await client.query(
        "select public.request_filtered_organization_export(array['members'], 'json') result",
      )).rows[0].result;
      expect(exported.receiptId).toBeTruthy();
      expect(exported.format).toBe("json");

      await client.query("reset role");
      const success = await client.query(
        `select actor_user_id, organization_id, event_type,
                metadata->>'exportType' as export_type,
                metadata->>'exportFormat' as export_format,
                metadata->>'status' as status
           from public.organization_audit_events
          where organization_id = $1
            and event_type = 'organization_export_completed'`,
        [FIXTURES.org],
      );
      expect(success.rows).toEqual([{
        actor_user_id: FIXTURES.admin,
        organization_id: FIXTURES.org,
        event_type: "organization_export_completed",
        export_type: "filtered",
        export_format: "json",
        status: "completed",
      }]);

      await client.query("delete from public.organization_data_export_runs where id = $1", [exported.receiptId]);
      const receipts = await client.query(
        "select count(*)::int as n from public.organization_data_export_runs where id = $1",
        [exported.receiptId],
      );
      expect(receipts.rows[0].n).toBe(0);
      const afterExpiry = await client.query(
        "select count(*)::int as n from public.organization_audit_events where organization_id = $1 and event_type = 'organization_export_completed'",
        [FIXTURES.org],
      );
      expect(afterExpiry.rows[0].n).toBe(1);
    } finally {
      try { await client.query("reset role"); await client.query("rollback"); } catch { /* best effort */ }
      await client.end();
    }
  });
});
