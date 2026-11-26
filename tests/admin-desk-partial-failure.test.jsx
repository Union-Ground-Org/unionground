import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAdminDesk } from "../src/lib/memberApi.js";
import { AdminView } from "../src/views/AdminView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// BUG-UG-ADMIN-DESK-FAILS-WHOLE-WHEN-ONE-READ-FAILS-20261006: one
// failed desk read must leave every unrelated panel usable, and a failed
// roster or event list must say so instead of rendering as zero.

const seed = fallbackData.adminDesk;
const healthy = {
  get_staff_roster: () => seed.roster,
  get_admin_events: () => seed.events,
  get_admin_audit: () => seed.audit.map((row) => ({ ...row, createdAt: "2026-07-20T16:00:00Z" })),
  get_admin_mfa_status: () => seed.mfa,
  get_admin_governance_requests: () => [],
  list_vp_case_reviews: () => [],
  get_member_invitations: () => ({ chapter: null, items: [] }),
};

// The real loader over a scripted client. `faults` maps an RPC name to how it
// fails: an error envelope (resolved), a rejected promise, or malformed data.
function deskClient(faults = {}) {
  const calls = [];
  return {
    calls,
    faults,
    rpc(name) {
      calls.push(name);
      const fault = this.faults[name];
      if (fault === "reject") return Promise.reject(new Error("network down"));
      if (fault === "malformed") return Promise.resolve({ data: { rows: "not an array" }, error: null });
      if (fault) return Promise.resolve({ data: null, error: typeof fault === "object" ? fault : { message: "read failed", code: "57014" } });
      const value = healthy[name];
      return Promise.resolve({ data: value ? JSON.parse(JSON.stringify(value())) : null, error: null });
    },
  };
}

function viewApi(client) {
  return {
    loadDesk: vi.fn(() => loadAdminDesk(client, "en")),
    revokeRole: vi.fn().mockResolvedValue({ revoked: true }),
    grantRole: vi.fn().mockResolvedValue({ granted: true }),
    searchMembers: vi.fn().mockResolvedValue([]),
    createEvent: vi.fn().mockResolvedValue({ created: true }),
    loadFormTemplates: vi.fn().mockResolvedValue([]),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }),
    loadAdministrativeEvidence: vi.fn().mockResolvedValue({ fieldNoteBlocks: [], packets: [], actions: [], history: [] }),
  };
}

const member = (overrides = {}) => ({
  member: { id: "admin-1", organizationId: "org-a", chapterId: "wor", initials: "AR", chapterName: "Harborview Care United", organizationRoles: ["admin"], ...overrides },
});

function adminAt(path, api, data = member(), onNotice = vi.fn()) {
  window.history.replaceState({}, "", path);
  return (
    <LanguageProvider lang="en">
      <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={vi.fn()}>
        <AdminView data={data} api={api} onNotice={onNotice} />
      </WorkspacePages>
    </LanguageProvider>
  );
}

// KPI label -> rendered value, read from the real PlaneKpi tiles.
const kpis = () => Object.fromEntries([...document.querySelectorAll(".pkpi-grid .pkpi__label")]
  .map((label) => [label.textContent, label.nextElementSibling?.textContent]));

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
});

describe("loadAdminDesk partial failure", () => {
  // The launch checklist's welcome-checklist step reads a count of the
  // organization's onboarding steps; unreadable is unknown, never "none".
  it.each([
    ["a count", () => ({ select: () => Promise.resolve({ count: 3, error: null }) }), 3],
    ["zero steps", () => ({ select: () => Promise.resolve({ count: 0, error: null }) }), 0],
    ["a refused read", () => ({ select: () => Promise.resolve({ count: null, error: { code: "42501" } }) }), null],
    ["a rejected read", () => ({ select: () => Promise.reject(new Error("offline")) }), null],
  ])("reads the onboarding-step count as %s", async (_label, table, expected) => {
    const client = deskClient();
    client.from = table;
    expect((await loadAdminDesk(client)).onboardingStepCount).toBe(expected);
  });

  it("reports the onboarding-step count as unknown when the client cannot read tables", async () => {
    const client = deskClient();
    delete client.from;
    expect((await loadAdminDesk(client)).onboardingStepCount).toBeNull();
  });

  it.each([401, 503])("preserves nested lifecycle HTTP %s while another panel is unavailable", async status => {
    const client = deskClient({ get_staff_roster: "reject" });
    const rpc = client.rpc.bind(client);
    client.rpc = name => name === "get_my_chapter_memberships"
      ? Promise.resolve({ data: null, error: { code: "42501", message: "request refused" }, status })
      : rpc(name);
    if (status === 401) await expect(loadAdminDesk(client)).rejects.toMatchObject({ name: "MemberApiError" });
    else {
      const desk = await loadAdminDesk(client);
      expect(desk.chapterLifecycle).toBeNull();
      expect(desk.roster).toBeNull();
      expect(desk.events).toHaveLength(seed.events.length);
    }
  });

  it.each([401, 503])("honors envelope-level status %s independently of the SQL error code", async (status) => {
    const client = deskClient();
    const rpc = client.rpc.bind(client);
    client.rpc = (name) => name === "get_admin_audit"
      ? Promise.resolve({ data: null, error: { code: "42501", message: "request refused" }, status })
      : rpc(name);
    if (status === 401) await expect(loadAdminDesk(client)).rejects.toMatchObject({ name: "MemberApiError" });
    else {
      const desk = await loadAdminDesk(client);
      expect(desk.audit).toBeNull();
      expect(desk.events).toHaveLength(seed.events.length);
    }
  });
  it("keeps the desk when the roster read resolves with an error envelope", async () => {
    const desk = await loadAdminDesk(deskClient({ get_staff_roster: true }));
    expect(desk.roster).toBeNull();
    expect(desk.events).toHaveLength(seed.events.length);
    expect(desk.audit).toHaveLength(seed.audit.length);
    expect(desk.mfa).not.toBeNull();
  });

  it("keeps the desk when one read's promise rejects, for required and additive reads alike", async () => {
    const eventsRejected = await loadAdminDesk(deskClient({ get_admin_events: "reject" }));
    expect(eventsRejected.events).toBeNull();
    expect(eventsRejected.roster).toHaveLength(seed.roster.length);

    const auditRejected = await loadAdminDesk(deskClient({ get_admin_audit: "reject" }));
    expect(auditRejected.audit).toBeNull();
    expect(auditRejected.roster).toHaveLength(seed.roster.length);
    expect(auditRejected.events).toHaveLength(seed.events.length);
  });

  it("treats a malformed roster or event list as unavailable, never as empty", async () => {
    const desk = await loadAdminDesk(deskClient({ get_staff_roster: "malformed", get_admin_events: "malformed" }));
    expect(desk.roster).toBeNull();
    expect(desk.events).toBeNull();
    const nullData = { rpc: (name) => Promise.resolve({ data: name === "get_admin_events" ? null : healthy[name]?.() ?? null, error: null }) };
    expect((await loadAdminDesk(nullData)).events).toBeNull();
  });

  it("treats any malformed row as an unreadable list, and keeps a valid empty list empty", async () => {
    const rowsClient = (roster, events) => ({
      rpc: (name) => Promise.resolve({
        data: name === "get_staff_roster" ? roster : name === "get_admin_events" ? events : healthy[name]?.() ?? null,
        error: null,
      }),
    });
    const onlyNull = await loadAdminDesk(rowsClient([null], [null]));
    expect(onlyNull.roster).toBeNull();
    expect(onlyNull.events).toBeNull();
    const mixed = await loadAdminDesk(rowsClient([...seed.roster, "x"], [...seed.events, 7]));
    expect(mixed.roster).toBeNull();
    expect(mixed.events).toBeNull();
    const nested = await loadAdminDesk(rowsClient([[]], []));
    expect(nested.roster).toBeNull();
    const empty = await loadAdminDesk(rowsClient([], []));
    expect(empty.roster).toEqual([]);
    expect(empty.events).toEqual([]);
  });

  it("keeps the whole-desk failure for a lost session, lost admin authorization, or nothing readable", async () => {
    await expect(loadAdminDesk(deskClient({ get_admin_audit: { code: "PGRST303", message: "JWT expired" } })))
      .rejects.toThrow("Admin desk: JWT expired");
    await expect(loadAdminDesk(deskClient({ get_admin_governance_requests: Object.assign(new Error("unauthorized"), { status: 401 }) })))
      .rejects.toMatchObject({ name: "MemberApiError" });
    const rejected401 = deskClient();
    rejected401.faults = { get_staff_roster: "reject" };
    const original = rejected401.rpc.bind(rejected401);
    rejected401.rpc = (name) => (name === "get_admin_mfa_status" ? Promise.reject(Object.assign(new Error("401"), { status: 401 })) : original(name));
    await expect(loadAdminDesk(rejected401)).rejects.toThrow();

    const denied = { code: "42501", message: "staff role required" };
    await expect(loadAdminDesk(deskClient({ get_staff_roster: denied, get_admin_events: denied })))
      .rejects.toThrow("Staff roster: staff role required");

    const everything = { rpc: () => Promise.resolve({ data: null, error: { message: "down" } }) };
    await expect(loadAdminDesk(everything)).rejects.toThrow("Staff roster: down");
  });
});

describe("AdminView with one failed desk read", () => {
  it("keeps an evidence draft through a language-only adapter change but clears it for another chapter", async () => {
    window.history.replaceState({}, "", "/m/admin/evidence/notes");
    const firstApi = viewApi(deskClient());
    const nextApi = viewApi(deskClient());
    const onNotice = vi.fn();
    const tree = (lang, api, chapterId = "wor") => <LanguageProvider lang={lang}>
      <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={vi.fn()}>
        <AdminView data={member({ chapterId })} api={api} onNotice={onNotice} />
      </WorkspacePages>
    </LanguageProvider>;
    const view = render(tree("en", firstApi));
    fireEvent.change(await screen.findByLabelText("Source title"), { target: { value: "Private field notes draft" } });
    view.rerender(tree("es", nextApi));
    await waitFor(() => expect(nextApi.loadAdministrativeEvidence).toHaveBeenCalled());
    expect(screen.getByLabelText("Título de la fuente")).toHaveValue("Private field notes draft");
    view.rerender(tree("es", nextApi, "chapter-b"));
    expect(screen.queryByDisplayValue("Private field notes draft")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Título de la fuente")).toHaveValue("");
  });

  it.each(["grant", "search", "rejected grant"])("retires an old-scope %s before it can change new-scope search or notices", async (kind) => {
    const client = deskClient();
    const api = viewApi(client);
    const onNotice = vi.fn();
    const oldPerson = { userId: "old-person", fullName: "Old chapter person", initials: "OP", roles: [] };
    const newPerson = { userId: "new-person", fullName: "New chapter person", initials: "NP", roles: [] };
    let resolveOld, rejectOld;
    const pending = new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    api.searchMembers.mockResolvedValue([oldPerson]);
    if (kind === "search") api.searchMembers.mockReturnValueOnce(pending);
    else api.grantRole.mockReturnValueOnce(pending);
    const view = render(adminAt("/m/admin#admin-access", api, member(), onNotice));
    await screen.findByText("Alex Rivera");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Old" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    if (kind !== "search") fireEvent.click(await screen.findByRole("button", { name: /Grant organization-wide Committee to Old chapter person/ }));

    view.rerender(adminAt("/m/admin#admin-access", api, member({ chapterId: "boston" }), onNotice));
    await screen.findByText("Alex Rivera");
    api.searchMembers.mockResolvedValue([newPerson]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("New chapter person")).toBeVisible();
    const readsBefore = api.loadDesk.mock.calls.length;
    await act(async () => {
      if (kind === "rejected grant") rejectOld(new Error("old chapter refused"));
      else resolveOld(kind === "search" ? [oldPerson] : { granted: true });
    });
    expect(screen.queryByText("Old chapter person")).toBeNull();
    expect(screen.getByText("New chapter person")).toBeVisible();
    expect(onNotice).not.toHaveBeenCalled();
    expect(api.loadDesk).toHaveBeenCalledTimes(readsBefore);
  });
  it("overview: a failed roster shows dashes, not zero, while the event and audit KPIs stay real", async () => {
    render(adminAt("/m/admin", viewApi(deskClient({ get_staff_roster: true }))));
    await waitFor(() => expect(document.querySelector(".pkpi-grid")).not.toBeNull());
    expect(kpis()).toEqual({
      "Staff seats": "—",
      "Role grants": "—",
      Meetings: String(seed.events.length),
      "Recent actions": String(seed.audit.length),
    });
    expect(screen.queryByText("Load failed")).toBeNull();
  });

  it("roles page: a failed roster is an honest unavailable state with no role writes, and Try again recovers it", async () => {
    const client = deskClient({ get_staff_roster: "reject" });
    const api = viewApi(client);
    render(adminAt("/m/admin#admin-access", api));
    expect(await screen.findByText("The staff roster could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("Alex Rivera")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /Remove .* for/i })).toHaveLength(0);
    // The member search beside the roster does not depend on it and stays usable.
    expect(screen.getByRole("searchbox", { name: /search/i })).toBeEnabled();

    client.faults = {};
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Alex Rivera")).toBeInTheDocument();
    expect(screen.queryByText("The staff roster could not be loaded.")).toBeNull();
    expect(api.loadDesk).toHaveBeenCalledTimes(2);
    expect(api.revokeRole).not.toHaveBeenCalled();
  });

  it("events page: a failed event list hides authoring instead of showing no events, and Try again recovers it", async () => {
    const client = deskClient({ get_admin_events: { message: "events down" } });
    render(adminAt("/m/admin#admin-events", viewApi(client)));
    expect(await screen.findByText(/Meetings could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New meeting" })).toBeNull();
    expect(screen.queryByText("SG-MEET7")).toBeNull();

    client.faults = {};
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("SG-MEET7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New meeting" })).toBeInTheDocument();
  });

  it("unrelated pages stay usable while roster and events are both unavailable", async () => {
    const api = viewApi(deskClient({ get_staff_roster: true, get_admin_events: "reject" }));
    const view = render(adminAt("/m/admin#admin-audit", api));
    // The audit trail still lists its rows, and the KPI tiles stay off this page.
    expect(await screen.findByText(/Jordan Patel/)).toBeInTheDocument();
    expect(screen.queryByText("Load failed")).toBeNull();
    expect(screen.queryByText("The audit trail couldn't be loaded.")).toBeNull();
    view.unmount();

    render(adminAt("/m/admin#admin-mfa", api));
    expect(await screen.findAllByText("Alex Rivera")).not.toHaveLength(0);
    expect(screen.queryByText("Two-step status could not be loaded.")).toBeNull();
  });

  it("a lost session still fails the whole desk rather than showing a usable one", async () => {
    render(adminAt("/m/admin", viewApi(deskClient({ get_staff_roster: { code: "PGRST303", message: "JWT expired" } }))));
    expect(await screen.findByText("Load failed")).toBeInTheDocument();
    expect(document.querySelector(".pkpi-grid")).toBeNull();
  });

  it("clears a stale failure when the organization, chapter or session scope changes", async () => {
    const client = deskClient({ get_staff_roster: true });
    const api = viewApi(client);
    const view = render(adminAt("/m/admin#admin-access", api));
    expect(await screen.findByText("The staff roster could not be loaded.")).toBeInTheDocument();

    client.faults = {};
    view.rerender(adminAt("/m/admin#admin-access", api, member({ chapterId: "boston" })));
    expect(await screen.findByText("Alex Rivera")).toBeInTheDocument();
    expect(screen.queryByText("The staff roster could not be loaded.")).toBeNull();

    // A whole-desk failure (lost session) is cleared by the next scope too.
    client.faults = { get_admin_audit: { code: "PGRST301", message: "JWT invalid" } };
    view.rerender(adminAt("/m/admin#admin-access", api, member({ chapterId: "boston", organizationId: "org-b" })));
    expect(await screen.findByText("Load failed")).toBeInTheDocument();
    client.faults = {};
    await act(async () => {
      view.rerender(adminAt("/m/admin#admin-access", api, member({ id: "admin-2", chapterId: "boston", organizationId: "org-b" })));
    });
    expect(await screen.findByText("Alex Rivera")).toBeInTheDocument();
    expect(screen.queryByText("Load failed")).toBeNull();
    expect(api.loadDesk).toHaveBeenCalledTimes(4);
  });

  it("ignores a late failed desk from the old scope once the new scope has loaded", async () => {
    let settleOld;
    const client = deskClient();
    const api = viewApi(client);
    api.loadDesk
      .mockImplementationOnce(() => new Promise((resolve) => { settleOld = resolve; }))
      .mockImplementation(() => loadAdminDesk(client, "en"));
    const view = render(adminAt("/m/admin#admin-access", api));
    view.rerender(adminAt("/m/admin#admin-access", api, member({ organizationId: "org-b" })));
    expect(await screen.findByText("Alex Rivera")).toBeInTheDocument();

    await act(async () => {
      settleOld(await loadAdminDesk(deskClient({ get_staff_roster: true }), "en"));
    });
    expect(screen.getByText("Alex Rivera")).toBeInTheDocument();
    expect(screen.queryByText("The staff roster could not be loaded.")).toBeNull();
  });

  it("never shows or acts on the previous scope's desk while the new scope loads, fails, or retries", async () => {
    const client = deskClient();
    const api = viewApi(client);
    const view = render(adminAt("/m/admin#admin-events", api));
    expect(await screen.findByText("SG-MEET7")).toBeInTheDocument();

    const pending = [];
    api.loadDesk.mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    view.rerender(adminAt("/m/admin#admin-events", api, member({ chapterId: "boston" })));
    expect(screen.getByText("Loading campaign admin…")).toBeInTheDocument();
    expect(screen.queryByText("SG-MEET7")).toBeNull();
    expect(screen.queryByRole("button", { name: "New meeting" })).toBeNull();

    await act(async () => { pending[0].reject(new Error("deadline")); });
    expect(await screen.findByText("Load failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Loading campaign admin…")).toBeInTheDocument();
    expect(screen.queryByText("SG-MEET7")).toBeNull();
    expect(screen.queryByRole("button", { name: "New meeting" })).toBeNull();

    await act(async () => { pending[1].resolve(await loadAdminDesk(client, "en")); });
    expect(await screen.findByText("SG-MEET7")).toBeInTheDocument();
  });

  it("a chapter-card switch keeps its controls off the old chapter until the new chapter's desk is shown, then refocuses the card", async () => {
    const lifecycleFor = (chapterId) => ({
      chapterId, chapterName: chapterId === "a" ? "Chapter A" : "Chapter B",
      memberships: [{ chapterId: "a", name: "Chapter A" }, { chapterId: "b", name: "Chapter B" }],
      binding: null, connections: [], handshakes: [], documents: [], events: [], sharedDocuments: [], latestHealth: null,
    });
    const client = deskClient();
    const pendingB = [];
    let setChapter;
    const api = viewApi(client);
    api.loadDesk.mockImplementation(async () => ({ ...await loadAdminDesk(client, "en"), chapterLifecycle: lifecycleFor("a") }));
    // As App does: the switch commits on the server, the member's chapter
    // changes, and only then does the card's own awaited reload run.
    api.switchMyChapter = vi.fn(async (chapterId) => {
      api.loadDesk.mockImplementation(() => new Promise((resolve) => pendingB.push(resolve)));
      await act(async () => { setChapter(chapterId); });
      return { chapterId };
    });
    function Shell() {
      const [chapterId, set] = useState("a");
      setChapter = set;
      window.history.replaceState({}, "", "/m/admin#admin-chapter-handshake");
      return (
        <LanguageProvider lang="en">
          <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={vi.fn()}>
            <AdminView data={member({ chapterId })} api={api} railChapter={{ id: "b", name: "Chapter B" }} onNotice={vi.fn()} />
          </WorkspacePages>
        </LanguageProvider>
      );
    }
    render(<Shell />);
    const switchButton = await screen.findByRole("button", { name: "Manage Chapter B instead" });
    switchButton.focus();
    await act(async () => { fireEvent.click(switchButton); });

    // Both the card's reload and the scope remount are waiting on chapter B.
    expect(api.switchMyChapter).toHaveBeenCalledWith("b");
    expect(screen.getByText("Loading campaign admin…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage Chapter B instead" })).toBeNull();
    expect(screen.queryByText("Changes on this page apply to Chapter A.")).toBeNull();

    for (const resolve of pendingB) await act(async () => { resolve({ ...await loadAdminDesk(client, "en"), chapterLifecycle: lifecycleFor("b") }); });
    expect(await screen.findByText("Changes on this page apply to Chapter B.")).toBeInTheDocument();
    expect(screen.queryByText("Changes on this page apply to Chapter A.")).toBeNull();
    await waitFor(() => expect(document.getElementById("admin-chapter-handshake")).toHaveFocus());
  });

  it("gives each new per-panel Try again the 48px touch target", async () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toMatch(/\.admin-panel-retry\.xus-btn\s*\{\s*min-height:\s*48px;\s*\}/);
    render(adminAt("/m/admin#admin-access", viewApi(deskClient({ get_staff_roster: true, get_admin_events: true }))));
    await screen.findByText("The staff roster could not be loaded.");
    for (const button of screen.getAllByRole("button", { name: "Try again" })) {
      expect(button).toHaveClass("xus-btn", "admin-panel-retry");
    }
  });
});
