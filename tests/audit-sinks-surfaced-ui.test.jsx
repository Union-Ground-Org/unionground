// REQ-UG-DORMANT-68-AUDIT-SINKS-SURFACED-20260917
//
// Five audit tables were written by SQL and read by nothing. These tests cover
// the browser half of surfacing them: the panel's source/kind/date controls,
// the row projection into the CR-106 envelope, and the per-source read gate.
// The database half lives in tests/audit-sinks-surfaced-db.test.js.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { migrationFiles } from "./helpers/migration.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SINK_KINDS,
  AUDIT_SINK_RPCS,
  AUDIT_SOURCE_READER_ROLES,
  AUTOMATION_DEFINITION_REVIEW_PROJECTION,
  CASEWORK_AUDIT_EVENT_PROJECTION,
  COORDINATOR_CASE_AUDIT_PROJECTION,
  MEMBER_CASE_ASSIGNMENT_AUDIT_PROJECTION,
  MEMBER_INVITATION_AUDIT_PROJECTION,
  AUDIT_SINK_SOURCES,
  AUDIT_SOURCES,
  AuditLogPanel,
  auditSinkIsCaseScoped,
  auditSinkRpc,
  auditSourcesForViewer,
  authorizeAuditSinkQuery,
  canReadAuditSource,
  clientMayCallRpc,
  isAuditSinkKind,
  isOperationsRpc,
  projectAuditSinkRow,
  projectAuditSinkRows,
  shapeAuditSinkRequest,
} from "../src/features/operations/index.js";
import { createOperationsApi } from "../src/lib/mi1OperationsWiring.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEMBER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function session(overrides = {}) {
  return {
    authenticated: true,
    mfaSatisfied: true,
    membershipStatus: "active",
    organizationStatus: "active",
    selectedOrganizationId: ORG_A,
    role: "admin",
    actorKind: "definer",
    ...overrides,
  };
}

function panel(props = {}, lang = "en") {
  return render(
    <LanguageProvider lang={lang}>
      <AuditLogPanel state="ready" events={[]} filters={{}} {...props} />
    </LanguageProvider>,
  );
}

describe("audit sink panel controls", () => {
  it("offers every previously dormant sink alongside the ledger", () => {
    panel();
    const source = screen.getByLabelText("Source");
    for (const option of AUDIT_SOURCES) {
      expect(source.querySelector(`option[value="${option}"]`), option).not.toBeNull();
    }
    expect(within(source).getAllByRole("option")).toHaveLength(AUDIT_SOURCES.length + 1);
    expect(screen.getByRole("option", { name: "Campaign lead issue changes" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Worker invitations" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Automation definition reviews" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Issue assignments" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Issue work events" })).toBeInTheDocument();
  });

  it("drops ledger-only filters when a sink is selected and refuses a sink kind on the ledger", () => {
    const onFilterChange = vi.fn();
    panel({ filters: { domain: "casework", action: "update" }, onFilterChange });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "casework_audit_events" } });
    expect(onFilterChange).toHaveBeenCalledWith({
      source: "casework_audit_events",
      domain: null,
      action: null,
      kind: null,
    });
  });

  it("enables the kind filter only for a sink and lists that sink's kinds", () => {
    const { unmount } = panel();
    expect(screen.getByLabelText("Kind")).toBeDisabled();
    expect(screen.getByLabelText("Domain")).not.toBeDisabled();
    unmount();

    const onFilterChange = vi.fn();
    panel({ filters: { source: "member_invitation_audit" }, onFilterChange });
    const kind = screen.getByLabelText("Kind");
    expect(kind).not.toBeDisabled();
    expect(screen.getByLabelText("Domain")).toBeDisabled();
    for (const option of AUDIT_SINK_KINDS.member_invitation_audit) {
      expect(kind.querySelector(`option[value="${option}"]`), option).not.toBeNull();
    }
    expect(kind.querySelector('option[value="strength_scored"]')).toBeNull();
    fireEvent.change(kind, { target: { value: "invite_revoked" } });
    expect(onFilterChange).toHaveBeenCalledWith({
      source: "member_invitation_audit",
      kind: "invite_revoked",
    });
  });

  it("turns the date controls into a whole-day bounded range and flags an inverted one", () => {
    const onFilterChange = vi.fn();
    const { unmount } = panel({ filters: { source: "coordinator_case_audit" }, onFilterChange });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    expect(onFilterChange).toHaveBeenLastCalledWith({
      source: "coordinator_case_audit",
      since: "2026-09-01T00:00:00.000Z",
    });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-02" } });
    expect(onFilterChange).toHaveBeenLastCalledWith({
      source: "coordinator_case_audit",
      until: "2026-09-02T23:59:59.999Z",
    });
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();

    panel({
      filters: {
        source: "coordinator_case_audit",
        since: "2026-09-09T00:00:00.000Z",
        until: "2026-09-02T23:59:59.999Z",
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("The end date comes before the start date.");
  });

  it("names the source of each rendered row without printing a translation key", () => {
    panel({
      events: [{
        id: 12,
        organizationId: ORG_A,
        domain: "casework",
        eventType: "case.note_added",
        actorUserId: ACTOR,
        entityType: "case",
        entityId: CASE,
        occurredAt: "2026-09-01T12:00:00.000Z",
        source: "coordinator_case_audit",
      }, {
        id: 13,
        organizationId: ORG_A,
        domain: "membership",
        eventType: "role.granted",
        actorUserId: ACTOR,
        entityType: "role_grant",
        entityId: MEMBER,
        occurredAt: "2026-09-01T11:00:00.000Z",
        source: "member_admin_audit",
      }],
    });
    expect(screen.getByText(/Campaign lead issue changes ·/)).toBeInTheDocument();
    expect(screen.getByText(/member admin audit ·/)).toBeInTheDocument();
    expect(screen.queryByText(/operations\.audit\.source\./)).toBeNull();
  });

  it("renders the new controls in Spanish", () => {
    panel({ filters: { source: "member_case_assignment_audit" } }, "es");
    expect(screen.getByLabelText("Origen")).toBeInTheDocument();
    expect(screen.getByLabelText("Tipo")).toBeInTheDocument();
    expect(screen.getByLabelText("Desde")).toBeInTheDocument();
    expect(screen.getByLabelText("Hasta")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Asignaciones de asuntos" })).toBeInTheDocument();
  });

  it("shows only the sources the caller's role may read", () => {
    panel({ sources: auditSourcesForViewer(session({ role: "coordinator" })) });
    const source = screen.getByLabelText("Source");
    expect(source.querySelector('option[value="casework_audit_events"]')).not.toBeNull();
    expect(source.querySelector('option[value="member_invitation_audit"]')).toBeNull();
    expect(source.querySelector('option[value="organization_audit_ledger"]')).toBeNull();
  });
});

describe("audit sink projection", () => {
  it("projects one row per sink into the CR-106 envelope", () => {
    const rows = {
      coordinator_case_audit: {
        id: 7,
        source: "coordinator_case_audit",
        organizationId: ORG_A,
        chapterId: "wor",
        kind: "note_added",
        caseId: CASE,
        entityId: CASE,
        memberUserId: MEMBER,
        actorUserId: ACTOR,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
      member_invitation_audit: {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        organizationId: ORG_A,
        chapterId: "wor",
        kind: "invite_revoked",
        entityId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        actorUserId: ACTOR,
        createdAt: "2026-09-01T11:00:00.000Z",
      },
      organization_automation_definition_reviews: {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
        organizationId: ORG_A,
        kind: "changes_requested",
        entityId: "ffffffff-ffff-4fff-8fff-fffffffffff1",
        actorUserId: ACTOR,
        createdAt: "2026-09-01T10:00:00.000Z",
      },
      member_case_assignment_audit: {
        id: 9,
        organizationId: ORG_A,
        chapterId: "wor",
        kind: "reassigned",
        caseId: CASE,
        entityId: CASE,
        memberUserId: MEMBER,
        actorUserId: ACTOR,
        createdAt: "2026-09-01T09:00:00.000Z",
      },
      casework_audit_events: {
        id: 11,
        organizationId: ORG_A,
        chapterId: "wor",
        kind: "alert_acknowledged",
        caseId: CASE,
        entityId: CASE,
        actorUserId: null,
        createdAt: "2026-09-01T08:00:00.000Z",
      },
    };
    const expected = {
      coordinator_case_audit: ["casework", "case.note_added", "create", "case"],
      member_invitation_audit: ["administration", "invitation.revoked", "revoke", "invitation"],
      organization_automation_definition_reviews: [
        "administration", "automation_definition.changes_requested", "update", "automation_definition",
      ],
      member_case_assignment_audit: ["casework", "case.reassigned", "update", "case"],
      casework_audit_events: ["casework", "case.alert_acknowledged", "acknowledge", "case"],
    };
    for (const source of AUDIT_SINK_SOURCES) {
      const event = projectAuditSinkRow(source, rows[source]);
      const [domain, eventType, action, entityType] = expected[source];
      expect(event, source).toMatchObject({ domain, eventType, action, entityType, source });
      expect(Object.isFrozen(event), source).toBe(true);
      expect(Object.keys(event.metadata).sort(), source).toEqual(
        source === "organization_automation_definition_reviews"
          ? ["organizationId"]
          : (auditSinkIsCaseScoped(source) && rows[source].memberUserId
            ? ["chapterId", "organizationId", "userId"]
            : ["chapterId", "organizationId"]),
      );
    }
  });

  it("derives the offered kinds from the projection maps themselves", () => {
    const maps = {
      coordinator_case_audit: COORDINATOR_CASE_AUDIT_PROJECTION,
      member_invitation_audit: MEMBER_INVITATION_AUDIT_PROJECTION,
      organization_automation_definition_reviews: AUTOMATION_DEFINITION_REVIEW_PROJECTION,
      member_case_assignment_audit: MEMBER_CASE_ASSIGNMENT_AUDIT_PROJECTION,
      casework_audit_events: CASEWORK_AUDIT_EVENT_PROJECTION,
    };
    for (const source of AUDIT_SINK_SOURCES) {
      expect(Object.keys(maps[source]), source).toEqual(AUDIT_SINK_KINDS[source]);
      expect(Object.isFrozen(maps[source]), source).toBe(true);
      for (const mapped of Object.values(maps[source])) {
        expect(Object.keys(mapped).sort(), source).toEqual(["action", "domain", "eventType"]);
      }
    }
  });

  it("never lets a source's browser roles exceed the roles its reader admits", () => {
    expect(Object.keys(AUDIT_SOURCE_READER_ROLES).sort()).toEqual([...AUDIT_SOURCES].sort());
    for (const [source, roles] of Object.entries(AUDIT_SOURCE_READER_ROLES)) {
      expect(roles.length, source).toBeGreaterThan(0);
      for (const role of roles) {
        expect(["coordinator", "advisor", "admin", "vp"], `${source}/${role}`).toContain(role);
      }
    }
    expect(AUDIT_SOURCE_READER_ROLES.organization_audit_ledger).toEqual(["admin"]);
    expect(AUDIT_SOURCE_READER_ROLES.member_invitation_audit).toEqual(["admin"]);
  });

  it("covers every kind the database will accept and nothing else", () => {
    expect(Object.keys(AUDIT_SINK_KINDS).sort()).toEqual([...AUDIT_SINK_SOURCES].sort());
    expect(AUDIT_SINK_KINDS.member_case_assignment_audit).toEqual(["assigned", "reassigned", "unassigned"]);
    // 30 since SEC-UG-CASEWORK-DEADLINES-ALERTS-INSERT-MISSING-EVENT-ROW-20260920
    // named deadline creation; 31 since REQ-UG-GRIEVANCE-PROCEDURE-STARTER-
    // TEMPLATE-20261001 audits loading the starter procedure; 32 since
    // REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006
    // audits a case rename.
    expect(AUDIT_SINK_KINDS.casework_audit_events).toHaveLength(32);
    expect(isAuditSinkKind("casework_audit_events", "pattern_reviewed")).toBe(true);
    expect(isAuditSinkKind("casework_audit_events", "macro_saved")).toBe(true);
    expect(isAuditSinkKind("casework_audit_events", "invite_sent")).toBe(false);
    expect(isAuditSinkKind("not_a_sink", "assigned")).toBe(false);
    // SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917: the export
    // receipt is only reviewable if the surfaced sink can filter for it, so the
    // projection, the envelope vocabulary and the RPC's p_kind array all have
    // to name it. The migration carries the third one.
    expect(isAuditSinkKind("casework_audit_events", "cases_exported")).toBe(true);
    expect(CASEWORK_AUDIT_EVENT_PROJECTION.cases_exported)
      .toEqual({ domain: "casework", eventType: "case.cases_exported", action: "export" });
    expect(AUDIT_EVENT_TYPES.casework).toContain("case.cases_exported");
    expect(readFileSync(resolve(process.cwd(), "supabase/migrations/20260918202000_casework_case_export_audit.sql"), "utf8"))
      .toContain("'behavior_addendum_added', 'pattern_reviewed',\n       'cases_exported'");
  });

  it("maps every casework_audit_events CHECK member, so a new CHECK token fails here", () => {
    let latest = [];
    for (const { sql } of migrationFiles()) {
      const named = sql.match(/casework_audit_events_event_type_check check \(event_type in \(([\s\S]*?)\)\)/);
      const inline = sql.match(/create table public\.casework_audit_events \([\s\S]*?event_type text not null check \(event_type in \(([\s\S]*?)\)\)/);
      const body = named?.[1] ?? inline?.[1];
      if (body) latest = [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    }
    expect(latest.length, "casework_audit_events CHECK members").toBeGreaterThan(0);
    const projected = Object.keys(CASEWORK_AUDIT_EVENT_PROJECTION);
    for (const kind of latest) {
      expect(projected, `projection missing CHECK member ${kind}`).toContain(kind);
    }
    expect(projectAuditSinkRow("casework_audit_events", {
      id: 21,
      organizationId: ORG_A,
      kind: "macro_saved",
      entityId: CASE,
      actorUserId: ACTOR,
      createdAt: "2026-09-18T12:00:00.000Z",
    })).toMatchObject({
      domain: "casework",
      eventType: "case.macro_saved",
      action: "create",
    });
  });

  it("drops an unknown kind, a foreign organization, and a malformed row", () => {
    const base = {
      id: 1,
      organizationId: ORG_A,
      kind: "note_added",
      entityId: CASE,
      actorUserId: ACTOR,
      createdAt: "2026-09-01T12:00:00.000Z",
    };
    expect(projectAuditSinkRow("coordinator_case_audit", { ...base, kind: "exported" })).toBeNull();
    expect(projectAuditSinkRow("coordinator_case_audit", { ...base, organizationId: "not-a-uuid" })).toBeNull();
    expect(projectAuditSinkRow("not_a_sink", base)).toBeNull();
    expect(projectAuditSinkRow("coordinator_case_audit", null)).toBeNull();
    expect(projectAuditSinkRows("coordinator_case_audit", [base, { ...base, id: 2, organizationId: ORG_B }], ORG_A))
      .toHaveLength(1);
    expect(projectAuditSinkRows("coordinator_case_audit", [base], null)).toEqual([]);
    expect(projectAuditSinkRows("coordinator_case_audit", "rows", ORG_A)).toEqual([]);
  });

  it("keeps a non-uuid actor and an oversized entity link out of the envelope", () => {
    const event = projectAuditSinkRow("casework_audit_events", {
      id: 3,
      organizationId: ORG_A,
      kind: "draft_saved",
      entityId: "x".repeat(129),
      actorUserId: "system",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    expect(event.actorUserId).toBeNull();
    expect(event.entityId).toBeNull();
  });
});

describe("audit sink read authorization", () => {
  it("gives each source no more reach than its database gate", () => {
    expect(auditSourcesForViewer(session())).toEqual([
      "organization_audit_ledger",
      "coordinator_case_audit",
      "member_invitation_audit",
      "organization_automation_definition_reviews",
      "member_case_assignment_audit",
      "casework_audit_events",
    ]);
    expect(auditSourcesForViewer(session({ role: "coordinator" }))).toEqual([
      "coordinator_case_audit",
      "member_case_assignment_audit",
      "casework_audit_events",
    ]);
    expect(auditSourcesForViewer(session({ role: "member" }))).toEqual([]);
    expect(auditSourcesForViewer(session({ mfaSatisfied: false }))).toEqual([]);
    expect(canReadAuditSource(session({ role: "vp" }), "member_invitation_audit")).toBe(false);
    expect(canReadAuditSource(session({ role: "vp" }), "organization_automation_definition_reviews")).toBe(true);
  });

  it("refuses an unknown source, an unknown kind, a broken range, and a case filter the sink has no case for", () => {
    expect(authorizeAuditSinkQuery(session(), "organization_audit_ledger").reason).toBe("unknown_source");
    expect(authorizeAuditSinkQuery(session(), "casework_audit_events", { kind: "invite_sent" }).reason)
      .toBe("unknown_kind");
    expect(authorizeAuditSinkQuery(session(), "casework_audit_events", {
      since: "2026-09-09T00:00:00.000Z",
      until: "2026-09-02T00:00:00.000Z",
    }).reason).toBe("invalid_date_range");
    expect(authorizeAuditSinkQuery(session(), "casework_audit_events", { since: "yesterday" }).reason)
      .toBe("invalid_date_range");
    expect(authorizeAuditSinkQuery(session(), "member_invitation_audit", { caseId: CASE }).reason)
      .toBe("case_scope_unavailable");
    expect(authorizeAuditSinkQuery(session(), "casework_audit_events", { caseId: "nope" }).reason)
      .toBe("case_scope_unavailable");
    expect(authorizeAuditSinkQuery(session({ role: "member" }), "casework_audit_events").reason)
      .toBe("role_denied");
    expect(authorizeAuditSinkQuery(session({ membershipStatus: "revoked" }), "casework_audit_events").reason)
      .toBe("session_inactive");
    expect(authorizeAuditSinkQuery(session(), "casework_audit_events", {
      kind: "alert_created",
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-02T23:59:59.999Z",
      caseId: CASE,
    })).toEqual({ ok: true, organizationId: ORG_A, source: "casework_audit_events" });
  });

  it("shapes a clamped keyset page and never sends a tenant key or a half cursor", () => {
    expect(shapeAuditSinkRequest(session(), "casework_audit_events", {
      limit: 999,
      before: { occurredAt: "2026-09-01T12:00:00.000Z", id: 11 },
      kind: "alert_created",
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-02T23:59:59.999Z",
      caseId: CASE,
    })).toEqual({
      p_limit: 200,
      p_before: "2026-09-01T12:00:00.000Z",
      p_before_id: 11,
      p_kind: "alert_created",
      p_since: "2026-09-01T00:00:00.000Z",
      p_until: "2026-09-02T23:59:59.999Z",
      p_case_id: CASE,
      source: "casework_audit_events",
      organizationId: ORG_A,
    });
    const half = shapeAuditSinkRequest(session(), "member_invitation_audit", {
      before: { occurredAt: "2026-09-01T12:00:00.000Z", id: null },
    });
    expect(half.p_before).toBeNull();
    expect(half.p_before_id).toBeNull();
    expect(half.p_limit).toBe(50);
    expect(half).not.toHaveProperty("p_case_id");
  });

  it("registers the five readers as client-callable operations RPCs", () => {
    for (const source of AUDIT_SINK_SOURCES) {
      const rpc = auditSinkRpc(source);
      expect(rpc, source).toBe(AUDIT_SINK_RPCS[source]);
      expect(isOperationsRpc(rpc), rpc).toBe(true);
      expect(clientMayCallRpc(rpc), rpc).toBe(true);
    }
    expect(auditSinkRpc("record_organization_audit_event")).toBeNull();
    expect(clientMayCallRpc("record_organization_audit_event")).toBe(false);
  });
});

describe("audit sink page reads", () => {
  it.each([
    ["reinvite_requested", "invitation.reinvite_requested", "create"],
    ["reinvite_accepted", "invitation.reinvite_accepted", "update"],
    ["invite_role_cleared", "invitation.role_cleared", "update"],
  ])("projects the recorded member invitation kind %s", async (kind, eventType, action) => {
    const api = createOperationsApi({
      rpc: async () => ({ data: [{
        id: 12,
        organizationId: ORG_A,
        kind,
        entityId: CASE,
        actorUserId: ACTOR,
        createdAt: "2026-09-01T08:00:00.000Z",
      }] }),
    });
    await expect(api.listAuditSource(session(), "member_invitation_audit", { kind })).resolves.toMatchObject({
      state: "ready",
      events: [{ domain: "administration", eventType, action, organizationId: ORG_A, entityId: CASE }],
    });
  });

  it("calls the sink reader, projects its rows, and reports another page", async () => {
    const calls = [];
    const api = createOperationsApi({
      rpc: async (name, args) => {
        calls.push([name, args]);
        return { data: [{
          id: 11,
          organizationId: ORG_A,
          chapterId: "wor",
          kind: "alert_created",
          caseId: CASE,
          entityId: CASE,
          actorUserId: ACTOR,
          createdAt: "2026-09-01T08:00:00.000Z",
        }] };
      },
    });
    const page = await api.listAuditSource(session(), "casework_audit_events", { limit: 1, kind: "alert_created" });
    expect(calls).toEqual([["list_casework_audit_events", {
      p_limit: 1,
      p_before: null,
      p_before_id: null,
      p_kind: "alert_created",
      p_since: null,
      p_until: null,
    }]]);
    expect(page.state).toBe("ready");
    expect(page.hasOlder).toBe(true);
    expect(page.events[0]).toMatchObject({
      domain: "casework",
      eventType: "case.alert_created",
      source: "casework_audit_events",
    });
  });

  it("reports an unset reader, a refused role, and a foreign-organization page honestly", async () => {
    const missing = createOperationsApi({
      rpc: async () => ({ error: { code: "PGRST202", message: "Could not find the function" } }),
    });
    expect(await missing.listAuditSource(session(), "member_invitation_audit")).toEqual({
      state: "unset", events: [], hasOlder: false,
    });

    const refused = createOperationsApi({
      rpc: async () => ({ error: { code: "42501", message: "organization admin role required" } }),
    });
    expect(await refused.listAuditSource(session(), "member_invitation_audit")).toMatchObject({
      state: "unauthorized", reason: "authorization_required",
    });

    const foreign = createOperationsApi({
      rpc: async () => ({ data: [{
        id: 1,
        organizationId: ORG_B,
        kind: "invite_sent",
        entityId: CASE,
        createdAt: "2026-09-01T08:00:00.000Z",
      }] }),
    });
    expect(await foreign.listAuditSource(session(), "member_invitation_audit")).toMatchObject({
      state: "empty", events: [],
    });

    const denied = createOperationsApi({ rpc: async () => ({ data: [] }) });
    expect(await denied.listAuditSource(session({ role: "coordinator" }), "member_invitation_audit")).toMatchObject({
      state: "unauthorized", reason: "role_denied",
    });
  });
});
