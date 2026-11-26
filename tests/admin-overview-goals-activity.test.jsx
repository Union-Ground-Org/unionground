// REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030 (#6580):
// an administrator had no single list of what needs them (Home said "Nothing
// needs your attention right now" while setup was unfinished), setting changes
// never reached Recent admin activity, the organization ledger named people by
// six-letter codes, and an organizing goal could not be followed by shift and
// classification. One test group per surface.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { AdminAttention, adminAttentionItems } from "../src/features/orgSetup/AdminAttention.jsx";
import { adminAttentionCatalogue } from "../src/lib/i18n/adminAttention.js";
import { auditText } from "../src/views/AdminView.jsx";
import { loadAdminDesk } from "../src/lib/memberApi.js";
import { WhatMattersNowCard } from "../src/features/memberHome/WhatMattersNowCard.jsx";
import { AuditLogPanel, actorReference, auditActorIds } from "../src/features/operations/AuditLogPanel.jsx";
import { OPERATIONS_RPCS, clientMayCallRpc } from "../src/features/operations/operationsAdapter.js";
import { createOperationsApi } from "../src/lib/mi1OperationsWiring.js";
import { GoalBreakdown } from "../src/features/organizationIntelligence/GoalBreakdown.jsx";
import { createOrganizationIntelligenceAdapter } from "../src/features/organizationIntelligence/adapter.js";
import { createWiredOrganizationIntelligenceAdapter } from "../src/lib/organizationIntelligenceWiring.js";
import { canViewCollectiveActionGoalBreakdown } from "../src/features/organizationIntelligence/authorization.js";

const tEn = (key, vars) => t("en", key, vars);
const NOW = Date.parse("2026-10-30T21:00:00Z");

const DESK = {
  invitations: { items: [
    { id: "i1", status: "pending", expiresAt: "2026-11-02T00:00:00Z" },
    { id: "i2", status: "pending", expiresAt: "2026-11-03T00:00:00Z" },
    { id: "i3", status: "pending", expiresAt: "2026-10-29T00:00:00Z" },
    { id: "i4", status: "delivery_failed", expiresAt: "2026-11-03T00:00:00Z" },
    { id: "i5", status: "accepted" },
  ] },
  failedLoginInbox: { items: [{ id: "f1", status: "open" }, { id: "f2", status: "dismissed" }] },
  mfaPolicy: { requireStaffMfa: true, staffTotal: 4, staffEnrolled: 3, callerEnrolled: true },
  governance: [{ id: "g1", status: "submitted" }, { id: "g2", status: "reviewing" }, { id: "g3", status: "fulfilled" }],
  rewardQueue: [],
};

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("Needs your attention on the admin overview", () => {
  // BUG-UG-INVITATION-SUGGESTIONS-HIDDEN-FROM-ADMIN-DESK-20261102
  describe("worker requests", () => {
    const REQUESTS = { items: [
      { id: "q1", kind: "invitation_suggestion", status: "pending" },
      { id: "q2", kind: "invitation_suggestion", status: "pending" },
      { id: "q3", kind: "access_request", status: "pending" },
    ], hasMore: false };
    const page = { path: "/m/settings/requests", view: "settings" };

    it("counts the pending suggestions and role requests the server lists for this viewer, and links them to Requests", () => {
      expect(adminAttentionItems({ memberRequests: REQUESTS }, NOW).items).toEqual([
        { key: "invitationSuggestions", count: 2, page, atLeast: false },
        { key: "accessRequests", count: 1, page, atLeast: false },
      ]);
      // A request the viewer may not decide is never in the server's page, so nothing is counted.
      expect(adminAttentionItems({ memberRequests: { items: [], hasMore: false } }, NOW)).toEqual({ items: [], unreadable: [] });
      expect(adminAttentionItems({ memberRequests: null }, NOW).unreadable).toEqual(["memberRequests"]);
      expect(adminAttentionItems({ memberRequests: { ...REQUESTS, hasMore: true } }, NOW).items[0]).toMatchObject({ count: 2, atLeast: true });
    });

    it("names Requests in both languages and opens the Requests page from the admin desk", () => {
      window.history.replaceState({}, "", "/m/admin");
      const navigate = vi.fn();
      render(
        <LanguageProvider lang="en">
          <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={navigate} menu={false}>
            <AdminAttention desk={{ memberRequests: REQUESTS }} now={NOW} />
          </WorkspacePages>
        </LanguageProvider>,
      );
      expect(screen.queryByText(tEn("adminAttention.none"))).toBeNull();
      expect(screen.getByRole("link", { name: "1 staff role request to approve or decline under Requests" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("link", { name: "2 invitation suggestions to approve or decline under Requests" }));
      expect(navigate).toHaveBeenCalledWith("settings", expect.stringContaining("/m/settings/requests"), null, { replace: false });
      cleanup();
      render(<LanguageProvider lang="es"><AdminAttention desk={{ memberRequests: { ...REQUESTS, hasMore: true } }} now={NOW} /></LanguageProvider>);
      expect(screen.getByText("Al menos 2 sugerencias de invitación por aprobar o rechazar en Solicitudes")).toBeInTheDocument();
    });

    it("reads the pending requests the admin may decide with the desk, and never turns a failed read into nothing waiting", async () => {
      const client = (requests) => ({
        rpc: vi.fn(async (name) => {
          if (name === "get_staff_roster" || name === "get_admin_events") return { data: [], error: null };
          if (name === "list_member_requests") return requests;
          return { data: null, error: { message: "optional unavailable" } };
        }),
      });
      const ok = client({ data: REQUESTS, error: null });
      expect((await loadAdminDesk(ok)).memberRequests).toEqual(REQUESTS);
      expect(ok.rpc).toHaveBeenCalledWith("list_member_requests", { p_status: "pending", p_limit: 50 });
      // Refused (no second factor, nothing this caller may decide): nothing to decide here.
      expect((await loadAdminDesk(client({ data: null, error: { code: "42501", message: "authentication required" } }))).memberRequests).toEqual({ items: [], hasMore: false });
      expect((await loadAdminDesk(client({ data: null, error: { code: "XX000", message: "boom" } }))).memberRequests).toBeNull();
      expect((await loadAdminDesk(client({ data: { items: "nope" }, error: null }))).memberRequests).toBeNull();
    });
  });

  it("lists only what is waiting, from the desk the overview already loaded", () => {
    expect(adminAttentionItems(DESK, NOW)).toEqual({
      items: [
        { key: "invitationsFailed", count: 1, sectionId: "admin-invitations" },
        { key: "invitationsPending", count: 2, sectionId: "admin-invitations" },
        { key: "failedLogins", count: 1, sectionId: "admin-failed-logins" },
        { key: "staffTwoStep", count: 1, sectionId: "admin-mfa" },
        { key: "governance", count: 2, sectionId: "admin-governance" },
      ],
      unreadable: [],
    });
  });

  it("counts every open sign-in report and only rewards still waiting (gate r1)", () => {
    const desk = {
      invitations: { items: [] }, mfaPolicy: { staffTotal: 1, staffEnrolled: 1 }, governance: [],
      // The page holds only reviewed reports; the uncapped count says one is open.
      failedLoginInbox: { openCount: 1, items: Array.from({ length: 50 }, (_, index) => ({ id: `f${index}`, status: "reviewed" })) },
      rewardQueue: [{ id: "r1", status: "claimed" }, { id: "r2", status: "delivered" }, { id: "r3", status: "revoked" }, { id: "r4", status: "shipped" }],
    };
    expect(adminAttentionItems(desk, NOW).items).toEqual([
      { key: "failedLogins", count: 1, sectionId: "admin-failed-logins" },
      { key: "rewardClaims", count: 2, sectionId: "admin-rewards" },
    ]);
    expect(adminAttentionItems({ ...desk, failedLoginInbox: { openCount: 0, items: [{ id: "x", status: "open" }] }, rewardQueue: [{ id: "r2", status: "delivered" }] }, NOW).items).toEqual([]);
  });

  it("never reads an unreadable list as nothing waiting", () => {
    const result = adminAttentionItems({ invitations: null, failedLoginInbox: null, mfaPolicy: null, governance: null, rewardQueue: null }, NOW);
    expect(result).toEqual({ items: [], unreadable: ["invitations", "failedLogins", "staffTwoStep", "governance", "rewardClaims"] });
    render(<LanguageProvider lang="en"><AdminAttention desk={{ invitations: null }} now={NOW} /></LanguageProvider>);
    expect(screen.getByRole("status")).toHaveTextContent(tEn("adminAttention.unreadable"));
    expect(screen.queryByText(tEn("adminAttention.none"))).toBeNull();
  });

  it("says plainly when nothing is waiting, and counts in both languages", () => {
    render(<LanguageProvider lang="en"><AdminAttention desk={{ invitations: { items: [] }, failedLoginInbox: { items: [] }, mfaPolicy: { staffTotal: 2, staffEnrolled: 2 }, governance: [], rewardQueue: [] }} now={NOW} /></LanguageProvider>);
    expect(screen.getByText(tEn("adminAttention.none"))).toBeInTheDocument();
    cleanup();
    render(<LanguageProvider lang="es"><AdminAttention desk={{ ...DESK, rewardQueue: [{ id: "r1", status: "claimed" }] }} now={NOW} /></LanguageProvider>);
    const list = screen.getByRole("heading", { name: t("es", "adminAttention.title") }).closest("section");
    expect(within(list).getByText("2 invitaciones esperan ser aceptadas")).toBeInTheDocument();
    expect(within(list).getByText("1 solicitud de recompensa por revisar")).toBeInTheDocument();
  });

  it("opens the page for an item when the workspace has it", () => {
    window.history.replaceState({}, "", "/m/admin");
    const navigate = vi.fn();
    render(
      <LanguageProvider lang="en">
        <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={navigate} menu={false}>
          <AdminAttention desk={DESK} now={NOW} />
        </WorkspacePages>
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "1 staff member has not turned on two-step sign-in" }));
    expect(navigate).toHaveBeenCalledWith("admin", expect.stringContaining("/m/admin"), null, { replace: false });
  });

  it("declares every key in both languages", () => {
    expect(Object.keys(adminAttentionCatalogue.es).sort()).toEqual(Object.keys(adminAttentionCatalogue.en).sort());
  });
});

describe("What matters now for an administrator with setup unfinished", () => {
  const data = { cases: [], planItems: [], events: [], organizationConfiguration: null };

  it("is caught up again once every milestone is done, or with no guide", () => {
    render(<LanguageProvider lang="en"><WhatMattersNowCard data={data} orgSetup={{ done: 7, total: 7, nextKey: null }} /></LanguageProvider>);
    expect(screen.getByText(tEn("whatMatters.lineCaughtUp"))).toBeInTheDocument();
    cleanup();
    render(<LanguageProvider lang="en"><WhatMattersNowCard data={data} /></LanguageProvider>);
    expect(screen.getByText(tEn("whatMatters.lineCaughtUp"))).toBeInTheDocument();
  });
});

describe("Recent admin activity lists setting changes", () => {
  it("names the setting by its translated label, its registry label, or its key", () => {
    const base = { actorName: "Callum Reyes", targetName: null, detail: {} };
    const known = "features.home.steward_ambient_hints";
    expect(auditText({ ...base, action: "organization_setting_updated", detail: { item: known, label: "Registry label" } }, tEn))
      .toBe(`Callum Reyes changed the organization setting “${tEn(`settings.def.${known}.label`)}”`);
    expect(auditText({ ...base, action: "organization_setting_reset", detail: { item: "limits.unknown_key", label: "Worksites" } }, tEn))
      .toBe("Callum Reyes reset the organization setting “Worksites” to its default");
    expect(auditText({ ...base, action: "organization_setting_updated", detail: { item: "limits.unknown_key" } }, tEn))
      .toContain("“limits.unknown_key”");
    expect(auditText({ ...base, action: "organization_setting_updated", detail: { item: known } }, (key, vars) => t("es", key, vars)))
      .toMatch(/^Callum Reyes cambió el ajuste de la organización «/);
  });
});

describe("the organization ledger names people", () => {
  const event = { id: "e1", domain: "administration", eventType: "settings.changed", actorUserId: "11111111-2222-3333-4444-5555558a3dfb", entityType: "organization", occurredAt: "2026-10-30T20:00:00Z", source: "member_admin_audit" };

  it("uses a name when the reader found one, and the short reference otherwise", () => {
    expect(actorReference(event, "en", { [event.actorUserId]: "Gwen Okafor" })).toBe(`${tEn("operations.audit.actor")} · Gwen Okafor`);
    expect(actorReference(event, "en", {})).toBe(`${tEn("operations.audit.actor")} · 8A3DFB`);
    const scheduled = { ...event, actorUserId: null, metadata: { mode: "scheduled", userId: "aaaa-bbbb" } };
    expect(actorReference(scheduled, "en", { "aaaa-bbbb": "Gwen Okafor" })).toBe(tEn("operations.audit.schedulerStanding", { actor: "Gwen Okafor" }));
    expect(auditActorIds([event, scheduled, { ...event, id: "e2" }, { actorUserId: null }])).toEqual([event.actorUserId, "aaaa-bbbb"]);
  });

  it("renders the names it is given", () => {
    render(<LanguageProvider lang="en"><AuditLogPanel state="ready" events={[event]} actorNames={{ [event.actorUserId]: "Gwen Okafor" }} /></LanguageProvider>);
    expect(screen.getByText(/Gwen Okafor/)).toBeInTheDocument();
    expect(screen.queryByText(/8A3DFB/)).toBeNull();
  });

  it("asks the name reader for at most 200 distinct ids and names nobody on failure", async () => {
    expect(clientMayCallRpc(OPERATIONS_RPCS.listActorNames)).toBe(true);
    const client = { rpc: vi.fn(async () => ({ data: { a: "Gwen Okafor", b: "  ", z: "Not asked" }, error: null })) };
    await expect(createOperationsApi(client).listActorNames(["a", "b", "a", "", null])).resolves.toEqual({ a: "Gwen Okafor" });
    expect(client.rpc).toHaveBeenCalledWith("list_organization_audit_actor_names", { p_user_ids: ["a", "b"] });
    await expect(createOperationsApi(client).listActorNames([])).resolves.toEqual({});
    const many = Array.from({ length: 250 }, (_, index) => `id-${index}`);
    await createOperationsApi(client).listActorNames(many);
    expect(client.rpc.mock.calls.at(-1)[1].p_user_ids).toHaveLength(200);
    const failing = { rpc: vi.fn(async () => ({ data: null, error: { code: "42501", message: "not authorized" } })) };
    await expect(createOperationsApi(failing).listActorNames(["a"])).resolves.toEqual({});
  });
});

describe("a collective action's goal by shift and classification", () => {
  const payload = {
    targetCount: 221,
    participantCount: 4,
    byShift: [{ label: "Night", count: 2 }, { label: null, count: 2 }],
    byClassification: [{ label: "Picker", count: 1 }, { label: " ", count: 1 }, { label: null, count: 2 }, { label: "Bad", count: 0 }],
  };

  async function open(load, lang = "en") {
    render(<GoalBreakdown actionId="a1" load={load} lang={lang} />);
    const details = screen.getByText(t(lang, "goalBreakdown.open")).closest("details");
    // Setting open fires the element's own toggle event, as a click on its summary does.
    details.open = true;
    await waitFor(() => expect(load).toHaveBeenCalled());
    return details;
  }

  it("reads the live count when opened and labels unshared details", async () => {
    const load = vi.fn(async () => payload);
    const details = await open(load);
    expect(load).toHaveBeenCalledWith({ actionId: "a1" });
    expect(await within(details).findByText(tEn("goalBreakdown.total", { count: 4, target: 221 }))).toBeInTheDocument();
    const shift = within(details).getByText(tEn("goalBreakdown.shift")).closest("div");
    expect(within(shift).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Night2", `${tEn("goalBreakdown.notShared")}2`]);
    const classification = within(details).getByText(tEn("goalBreakdown.classification")).closest("div");
    expect(within(classification).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Picker1", `${tEn("goalBreakdown.notShared")}1`, `${tEn("goalBreakdown.notShared")}2`]);
    expect(within(details).getByText(tEn("goalBreakdown.note"))).toBeInTheDocument();
  });

  it("says so when nobody has joined, when refused, and when the read fails", async () => {
    await open(vi.fn(async () => ({ targetCount: 10, participantCount: 0, byShift: [], byClassification: [] })), "es");
    expect(await screen.findByText(t("es", "goalBreakdown.none"))).toBeInTheDocument();
    cleanup();
    await open(vi.fn(async () => { throw Object.assign(new Error("no"), { code: "42501" }); }));
    expect(await screen.findByText(tEn("goalBreakdown.denied"))).toBeInTheDocument();
    cleanup();
    const flaky = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(payload);
    await open(flaky);
    expect(await screen.findByRole("alert")).toHaveTextContent(tEn("goalBreakdown.error"));
    fireEvent.click(screen.getByRole("button", { name: tEn("goalBreakdown.retry") }));
    await waitFor(() => expect(screen.getByText(tEn("goalBreakdown.total", { count: 4, target: 221 }))).toBeInTheDocument());
  });

  it("keeps the newest count when an older read lands later (final P2)", async () => {
    let releaseOld;
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOld = () => resolve({ ...payload, participantCount: 4 }); }))
      .mockImplementationOnce(async () => ({ ...payload, participantCount: 5 }));
    const details = await open(load);
    details.open = false;
    details.open = true;
    expect(await screen.findByText(tEn("goalBreakdown.total", { count: 5, target: 221 }))).toBeInTheDocument();
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText(tEn("goalBreakdown.total", { count: 5, target: 221 }))).toBeInTheDocument();
    expect(screen.queryByText(tEn("goalBreakdown.total", { count: 4, target: 221 }))).toBeNull();
  });

  it("is offered only to an organization administrator wearing the Admin hat (review P2)", () => {
    const base = { userId: "u", organizationId: "o", membershipStatus: "active", mfaSatisfied: true };
    expect(canViewCollectiveActionGoalBreakdown({ ...base, selectedHat: "admin", organizationRoles: ["admin"] })).toBe(true);
    expect(canViewCollectiveActionGoalBreakdown({ ...base, selectedHat: "coordinator", organizationRoles: ["coordinator"] })).toBe(false);
    expect(canViewCollectiveActionGoalBreakdown({ ...base, selectedHat: "vp", organizationRoles: ["vp", "admin"] })).toBe(false);
    expect(canViewCollectiveActionGoalBreakdown({ ...base, selectedHat: "admin", organizationRoles: [], chapterRoles: ["admin"] })).toBe(false);
    expect(canViewCollectiveActionGoalBreakdown({ ...base, mfaSatisfied: false, selectedHat: "admin", organizationRoles: ["admin"] })).toBe(false);
  });

  it("is wired only where the reader exists", async () => {
    expect(createOrganizationIntelligenceAdapter().goalBreakdown).toBeNull();
    const client = { rpc: vi.fn(async () => ({ data: payload, error: null })) };
    await expect(createWiredOrganizationIntelligenceAdapter(client).goalBreakdown({ actionId: "a1" })).resolves.toEqual(payload);
    expect(client.rpc).toHaveBeenCalledWith("get_digital_action_goal_breakdown", { p_action_id: "a1" });
  });
});
