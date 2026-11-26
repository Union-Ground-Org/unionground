// PR1815 wave-A6 focused-page state and bilingual regressions (jsdom).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { MemberSupportView } from "../src/views/MemberSupportView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";
import { CaseworkHubPanel } from "../src/components/CaseworkHubPanel.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { filterCoordinatorFocus, loadMemberApp } from "../src/lib/memberApi.js";

// The protected snapshot read rides the sensitive-content transport; tests
// delegate it to the mocked RPC client (same pin as member-support-view).
vi.mock("../src/lib/sensitiveContentApi.js", () => ({ sensitiveContentRpc: (client, name, args) => client.rpc(name, args) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const staffActor = {
  userId: USER, selectedOrganizationId: ORG, membershipStatus: "active",
  selectedHat: "steward", organizationRoles: ["steward"], mfaSatisfied: true,
};

function supportWorkspace(overrides = {}) {
  return {
    state: "ready", organizationId: ORG, staff: true,
    emergencyChecklists: [], accommodations: [], accommodationSummary: { total: 0, open: 0, approved: 0, denied: 0, withdrawn: 0 },
    hrDirectory: null, hrContacts: [], onboardingProgram: [], onboardingPlan: null, onboardingRoster: [],
    mentorshipPairs: [], mentorshipDirectory: [], handoffs: { items: [], nextCursor: null },
    ...overrides,
  };
}

function supportClient(model) {
  return { rpc: vi.fn(async (name) => {
    if (name === "get_member_support_workspace") return { data: model, error: null };
    if (name === "list_member_handoffs_v2") return { data: { items: [], nextCursor: null }, error: null };
    return { data: { saved: true }, error: null };
  }) };
}

const desk = { queue: [], threads: [], broadcasts: [], formsInbox: [], kpis: { openRequests: 0, membersCovered: 0, awaitingReply: 0, broadcasts30d: 0 } };
function stewardApi(overrides = {}) {
  return { loadDesk: vi.fn().mockResolvedValue(desk), listEmailIntakes: vi.fn().mockResolvedValue([]), ...overrides };
}

describe("FIX-UG-PAGE-SUPPORT-HANDOFFS-20260910", () => {
  it("renders the focused handoffs page in Spanish without changing the English surface", async () => {
    const client = supportClient(supportWorkspace());
    render(<LanguageProvider lang="es"><MemberSupportView actor={staffActor} client={client} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Traspasos" }));
    expect(await screen.findByRole("heading", { name: "Traspasos del comité" })).toBeInTheDocument();
    expect(screen.getByText(/debe confirmar antes de que cambie la relación permanente/)).toBeInTheDocument();
    expect(screen.getByLabelText("Buscar trabajadores para el traspaso")).toBeInTheDocument();
    expect(screen.getByLabelText("Buscar al miembro del comité que recibe")).toBeInTheDocument();
    expect(screen.getByLabelText(/Nota de traspaso/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar traspaso" })).toBeInTheDocument();
    expect(screen.getByLabelText("Estado")).toBeInTheDocument();
    expect(screen.getByText("Sin historial de traspasos")).toBeInTheDocument();
    // 0 pending chip in Spanish.
    expect(screen.getByText("0 pendientes")).toBeInTheDocument();
  });

  it("translates handoff directions in Spanish and keeps the English enum labels", async () => {
    const items = [
      { id: "h-in", memberId: "m1", memberName: "Alex Member", fromStewardName: "Morgan Member", toStewardName: "Taylor Steward", direction: "incoming", status: "pending", createdAt: "2026-08-29T12:00:00.000Z" },
      { id: "h-out", memberId: "m2", memberName: "Jordan Member", fromStewardName: "Sam Steward", toStewardName: "Morgan Member", direction: "outgoing", status: "acknowledged", createdAt: "2026-08-28T12:00:00.000Z" },
      { id: "h-over", memberId: "m3", memberName: "Riley Member", fromStewardName: "Sam Steward", toStewardName: "Taylor Steward", direction: "overseen", status: "declined", createdAt: "2026-08-27T12:00:00.000Z" },
    ];
    const client = () => ({ rpc: vi.fn(async (name) => {
      if (name === "get_member_support_workspace") return { data: supportWorkspace(), error: null };
      if (name === "list_member_handoffs_v2") return { data: { items, nextCursor: null }, error: null };
      return { data: { saved: true }, error: null };
    }) });

    const english = render(<LanguageProvider lang="en"><MemberSupportView actor={staffActor} client={client()} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Handoffs" }));
    expect(await screen.findByText(/Morgan Member → Taylor Steward · Incoming/)).toBeInTheDocument();
    expect(screen.getByText(/Sam Steward → Morgan Member · Outgoing/)).toBeInTheDocument();
    expect(screen.getByText(/Sam Steward → Taylor Steward · Overseen/)).toBeInTheDocument();
    english.unmount();

    render(<LanguageProvider lang="es"><MemberSupportView actor={staffActor} client={client()} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Traspasos" }));
    expect(await screen.findByText(/Morgan Member → Taylor Steward · Entrante/)).toBeInTheDocument();
    expect(screen.getByText(/Sam Steward → Morgan Member · Saliente/)).toBeInTheDocument();
    expect(screen.getByText(/Sam Steward → Taylor Steward · Supervisado/)).toBeInTheDocument();
    expect(screen.queryByText(/\bincoming\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\boutgoing\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\boverseen\b/i)).not.toBeInTheDocument();
  });

  it("keeps the bounded unavailable states bilingual", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "MFA required" } }) };
    render(<LanguageProvider lang="es"><MemberSupportView actor={staffActor} client={client} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Se requiere verificación en dos pasos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeInTheDocument();
  });
});

describe("FIX-UG-PAGE-STEWARD-CASEWORK-HUB-20260910", () => {
  it("names the missing hub backing instead of mounting a bare heading section", async () => {
    // Demo desks (and stewards without a chapter) carry no loadCaseworkHub:
    // the focused page must show an explicit state, not a blank plane.
    // The Lovable audit's P0 APP-STEWARD-12 (REQ-UNIONGROUND-LOVABLE-AUDIT-
    // WEBAPP-FIXES-20261103): a status heading, the dependency, a direct link
    // to the campaign-backed Committee desk, and who can fix it.
    const { unmount } = render(<LanguageProvider lang="en"><StewardView data={{ member: { initials: "SO", chapterId: "chapter-1" } }} api={stewardApi()} onNotice={() => {}} /></LanguageProvider>);
    const heading = await screen.findByRole("heading", { name: "This issue work hub isn't connected to a campaign yet" });
    const state = heading.closest("[data-state-block]");
    expect(state).toHaveAttribute("role", "status");
    expect(within(state).getByRole("link", { name: "Open the Committee desk" })).toHaveAttribute("href", "/m/steward");
    expect(within(state).getByRole("link", { name: "Open your issue list" })).toHaveAttribute("href", "/m/steward/caseload");
    expect(within(state).getByText(/Who can fix this: a campaign administrator/)).toBeInTheDocument();
    unmount();

    render(<LanguageProvider lang="es"><StewardView data={{ member: { initials: "SO", chapterId: "chapter-1" } }} api={stewardApi()} onNotice={() => {}} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "El centro de seguimiento de asuntos necesita un espacio de campaña conectado y aún no está disponible aquí." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir el escritorio de miembro del comité" })).toHaveAttribute("href", "/m/steward");
  });

  it("keeps the response-clock countdown in the selected language", async () => {
    const overdue = new Date(Date.now() - 3 * 3600000).toISOString();
    const remaining = new Date(Date.now() + 30 * 3600000).toISOString();
    const hub = {
      workspaces: [{ id: "ws-1", title: "Bargaining", status: "live", starts_at: null, proposals: [
        { id: "p-1", title: "Wages", side: "Union", body: "3% across the board", status: "proposed", response_due_at: overdue },
        { id: "p-2", title: "Leave", side: "Union", body: "Expanded sick leave", status: "proposed", response_due_at: remaining },
      ], events: [], pulse: null }],
      drafts: [], templates: [], patterns: [],
    };
    const api = { loadCaseworkHub: vi.fn().mockResolvedValue(hub) };
    render(<LanguageProvider lang="es"><CaseworkHubPanel chapterId="chapter-1" caseOptions={[]} api={api} /></LanguageProvider>);
    expect(await screen.findByText(/hace 3 h/)).toBeInTheDocument();
    expect(screen.getByText(/quedan 30 h/)).toBeInTheDocument();

    render(<LanguageProvider lang="en"><CaseworkHubPanel chapterId="chapter-1" caseOptions={[]} api={api} /></LanguageProvider>);
    expect(await screen.findByText(/3h overdue/)).toBeInTheDocument();
    expect(screen.getByText(/30h remaining/)).toBeInTheDocument();
  });
});

describe("FIX-UG-PAGE-COORDINATOR-CASES-QUEUE-20260910", () => {
  function renderCoordinator(overrides = {}) {
    const api = overrides.api || {
      loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.coordinatorDesk))),
      loadCases: vi.fn(async ({ focus = "all" } = {}) => ({
        cases: filterCoordinatorFocus(JSON.parse(JSON.stringify(fallbackData.coordinatorDesk)).cases, focus),
        nextCursor: null,
      })),
      // The desk also mounts the chapter-appointments panel; without a loader
      // it raises its own catalogue alert and hides whether the page itself
      // survived the still-loading profile.
      loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [], nextCursor: null, total: 0 }),
    };
    return render(<LanguageProvider lang="en"><CoordinatorView data={overrides.data ?? { member: { initials: "JP" } }} api={api} onNotice={() => {}} onProfile={() => {}} /></LanguageProvider>);
  }

  it("mounts the queue for a coordinator whose member profile is still loading", async () => {
    // data.member is nullable while the profile resolves; an unguarded read
    // threw before the desk could load and blanked the focused page.
    renderCoordinator({ data: { member: null } });
    expect(await screen.findByRole("button", { name: "? Profile" })).toHaveTextContent("?");
    await waitFor(() => expect(screen.queryByText(/could not be loaded/i)).toBeNull());
  });
});

// Chainable stand-in for the Supabase builder. Awaiting any shape resolves the
// canned { data, error } once; relocating the workload mapping inside
// memberApi.js does not change which table this client serves.
function chainable(result) {
  const proxy = new Proxy(function query() {}, {
    get(_target, property) {
      if (property === "then") return (...args) => Promise.resolve(result).then(...args);
      return () => proxy;
    },
  });
  return proxy;
}

function workloadHistoryClient(language, row) {
  const tables = {
    member_profiles: {
      data: {
        id: "user-workload-history",
        first_name: "Ada",
        full_name: "Ada Member",
        initials: "AM",
        language,
      },
      error: null,
    },
    member_workload_logs: { data: [row], error: null },
  };
  return {
    from(table) { return chainable(tables[table] ?? { data: [], error: null }); },
    rpc() { return Promise.resolve({ data: null, error: { message: "unused in this fixture" } }); },
  };
}

// weekly_assigned, pt_hours, and ot_hours are pairwise distinct so swapping any
// one into a sibling translate() argument changes the produced meta string.
const WORKLOAD_HISTORY_ROW = {
  id: "wl-history-1",
  priority: 1,
  pending: 2,
  unread_docs: 3,
  todos: 5,
  referrals: 6,
  ce_activities: 8,
  assistance_requests: 9,
  aged_cases: 11,
  weekly_assigned: 4,
  employment: "part_time",
  pt_hours: 20,
  ot_worked: true,
  ot_hours: 7,
  on_plan: true,
  half_day: true,
  no_intake: true,
  leave_type: "medical",
  leave_timing: "afternoon",
  note: "",
  receipt_code: "WL-HISTORY-1",
  created_at: "2026-09-20T15:00:00.000Z",
};

const WORKLOAD_HISTORY_META = {
  en: "4 new this week · part-time 20h · 7h OT · improvement plan · half day · no intake · medical · afternoon",
  es: "4 nuevos esta semana · tiempo parcial 20 h · 7 h de horas extra · plan de mejora · medio día · sin admisión · medical · afternoon",
};

describe("FIX-UG-PAGE-WORKLOAD-HISTORY-20260910 / WORKLOAD-SUBMIT", () => {
  it("localizes the history meta segments in both catalogue languages", async () => {
    expect(t("en", "workload.metaNewThisWeek", { count: 4 })).toBe("4 new this week");
    expect(t("es", "workload.metaNewThisWeek", { count: 4 })).toBe("4 nuevos esta semana");
    expect(t("en", "workload.metaFullTime")).toBe("full-time");
    expect(t("es", "workload.metaFullTime")).toBe("tiempo completo");
    expect(t("en", "workload.metaPartTime", { hours: 20 })).toBe("part-time 20h");
    expect(t("es", "workload.metaPartTime", { hours: 20 })).toBe("tiempo parcial 20 h");
    expect(t("en", "workload.metaOt", { hours: 3 })).toBe("3h OT");
    expect(t("es", "workload.metaOt", { hours: 3 })).toBe("3 h de horas extra");
    expect(t("en", "workload.metaOnPlan")).toBe("improvement plan");
    expect(t("es", "workload.metaOnPlan")).toBe("plan de mejora");
    expect(t("en", "workload.metaHalfDay")).toBe("half day");
    expect(t("es", "workload.metaHalfDay")).toBe("medio día");
    expect(t("en", "workload.metaNoIntake")).toBe("no intake");
    expect(t("es", "workload.metaNoIntake")).toBe("sin admisión");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const user = { id: "user-workload-history", email: "ada@example.test" };
      const english = await loadMemberApp(workloadHistoryClient("en", WORKLOAD_HISTORY_ROW), user);
      const spanish = await loadMemberApp(workloadHistoryClient("es", WORKLOAD_HISTORY_ROW), user);
      expect(english.workload.entries.map((entry) => entry.meta)).toEqual([WORKLOAD_HISTORY_META.en]);
      expect(spanish.workload.entries.map((entry) => entry.meta)).toEqual([WORKLOAD_HISTORY_META.es]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("UX-UG-STEWARD-CASEWORK-HUB-OFFERS-RETALIATION-PATTERN-SCAN-CHECKLIST-20260921", () => {
  // casework_scan_retaliation_patterns and casework_review_retaliation_pattern
  // demand a coordinator/advisor/admin/vp hat. A pure steward used to get the
  // control anyway, and the first click answered with a 42501 the
  // sensitive-content client rewrites as an outage. Union Ground left stage
  // checklists out, so no hat is offered checklist-template authoring.
  const hub = { workspaces: [], drafts: [], templates: [], patterns: [] };
  function refusal() {
    return Object.assign(new Error("Sensitive content is unavailable. Contact your administrator."), { code: "SENSITIVE_DATA_UNAVAILABLE" });
  }
  function hubApi(overrides = {}) {
    return {
      loadDesk: vi.fn().mockResolvedValue(desk),
      listEmailIntakes: vi.fn().mockResolvedValue([]),
      loadCaseworkHub: vi.fn().mockResolvedValue(hub),
      saveIntakeDraft: vi.fn(),
      createBargainingWorkspace: vi.fn(),
      addBargainingProposal: vi.fn(),
      addBargainingEvent: vi.fn(),
      setBargainingStatus: vi.fn(),
      transitionBargainingProposal: vi.fn(),
      createChecklistTemplate: vi.fn().mockRejectedValue(refusal()),
      scanRetaliationPatterns: vi.fn().mockRejectedValue(refusal()),
      reviewRetaliationPattern: vi.fn().mockRejectedValue(refusal()),
      ...overrides,
    };
  }

  it("withholds the pattern scan and template authoring from a steward without a coordinator hat", async () => {
    const api = hubApi();
    render(<LanguageProvider lang="en"><StewardView data={{ roles: ["steward"], member: { initials: "SO", chapterId: "chapter-1" } }} api={api} onNotice={() => {}} /></LanguageProvider>);
    // The hub itself still serves the steward: bargaining and intake drafts
    // admit a steward on the server.
    expect(await screen.findByRole("heading", { name: "Intake draft autosave" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bargaining" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Retaliation pattern review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scan reports" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Checklist templates" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create template" })).toBeNull();
    expect(api.scanRetaliationPatterns).not.toHaveBeenCalled();
    expect(api.createChecklistTemplate).not.toHaveBeenCalled();
  });

  it("keeps the pattern scan for a steward who also holds a coordinator hat", async () => {
    const api = hubApi();
    render(<LanguageProvider lang="en"><StewardView data={{ roles: ["steward", "coordinator"], member: { initials: "SO", chapterId: "chapter-1" } }} api={api} onNotice={() => {}} /></LanguageProvider>);
    expect(await screen.findByRole("button", { name: "Scan reports" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Retaliation pattern review" })).toBeInTheDocument();
    // Stage checklists are not part of Union Ground under any hat.
    expect(screen.queryByRole("heading", { name: "Checklist templates" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create template" })).toBeNull();
    expect(api.createChecklistTemplate).not.toHaveBeenCalled();
  });

  it("gives coordinators the hub page their RPC hats admit", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.coordinatorDesk))),
      loadCases: vi.fn(async () => ({ cases: [], nextCursor: null })),
      ...hubApi(),
    };
    window.history.replaceState({}, "", "/m/coordinator/casework-hub");
    render(<LanguageProvider lang="en"><CoordinatorView data={{ roles: ["coordinator"], member: { initials: "JP", chapterId: "chapter-1" } }} api={api} onNotice={() => {}} onProfile={() => {}} /></LanguageProvider>);
    expect(await screen.findByRole("button", { name: "Scan reports" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Retaliation pattern review" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Checklist templates" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create template" })).toBeNull();
    expect(api.createChecklistTemplate).not.toHaveBeenCalled();
    window.history.replaceState({}, "", "/m");
  });
});
