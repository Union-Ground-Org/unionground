import { Component } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { BottomNav, STAFF_PLANE_TABS } from "../src/components/BottomNav.jsx";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { STAFF_ROLE_NAVIGATION, STAFF_ROLE_SECTION_IDS, staffRailGroups, currentStaffSection, focusStaffSection } from "../src/lib/staffNavigation.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";

class HashCrashBoundary extends Component {
  static getDerivedStateFromError(error) {
    return { error };
  }

  state = { error: null };

  render() {
    if (this.state.error) {
      return (
        <main role="alert">
          <h1>Something went wrong</h1>
          <p>{`${this.state.error.name}: ${this.state.error.message}`}</p>
        </main>
      );
    }
    return this.props.children;
  }
}

const roleSources = {
  steward: ["src/views/StewardView.jsx", "src/components/StewardAppointmentsPanel.jsx"],
  coordinator: ["src/views/CoordinatorView.jsx"],
  advisor: ["src/views/AdvisorView.jsx"],
  admin: ["src/views/AdminView.jsx", "src/components/AdminFormTemplateEditor.jsx", "src/components/EventAuthoringCard.jsx", "src/features/operations/AuditLogPanel.jsx", "src/features/operations/JobHealthPanel.jsx"],
  vp: ["src/views/VpView.jsx"],
};

describe("page navigation compatibility", () => {
  it("identifies nested pages and preserves valid legacy anchors", () => {
    for (const [path, section] of [["/m/automations/history", ""], ["/m/admin/evidence/notes", "admin-evidence-operations"], ["/m/admin/member-operations/imports", "admin-member-operations"], ["/m/steward/requests/", "steward-requests"]]) {
      window.history.replaceState({}, "", path);
      expect(currentStaffSection()).toBe(section);
    }
    window.history.replaceState({}, "", "/m/admin#admin-access");
    expect(currentStaffSection()).toBe("admin-access");
    window.history.replaceState({}, "", "/m/admin#%zz");
    expect(currentStaffSection()).toBe("");
    expect(staffRailGroups("unknown", [{ key: "desk" }])[0].labelKey).toBe("shell.groupWork");
  });

  it.each([false, true])("focuses legacy section targets and respects reduced motion (%s)", (reduced) => {
    render(<section id="legacy-focus" tabIndex={-1}>Legacy destination</section>);
    const target = document.getElementById("legacy-focus");
    target.scrollIntoView = vi.fn();
    const original = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: reduced }));
    try {
      window.history.replaceState({}, "", "/m/admin?demo=1");
      expect(focusStaffSection("")).toBe(false);
      expect(focusStaffSection("missing")).toBe(false);
      expect(focusStaffSection("legacy-focus")).toBe(true);
      expect(window.location.hash).toBe("");
      expect(focusStaffSection("legacy-focus", { updateHistory: true })).toBe(true);
      expect(window.location.search).toBe("?demo=1");
      expect(window.location.hash).toBe("#legacy-focus");
      expect(target).toHaveFocus();
      expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: reduced ? "auto" : "smooth", block: "start" });
      window.matchMedia = undefined;
      expect(focusStaffSection("legacy-focus")).toBe(true);
    } finally { window.matchMedia = original; }
  });

  it("keeps browserless imports safe", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    try { expect(currentStaffSection()).toBe(""); expect(focusStaffSection("anything")).toBe(false); }
    finally { vi.unstubAllGlobals(); }
  });

  it("leaves modified phone links native and handles the overview destination", () => {
    window.history.replaceState({}, "", "/m/steward/requests");
    const navigate = vi.fn();
    render(<LanguageProvider lang="en"><BottomNav active="steward" tabs={STAFF_ROLE_NAVIGATION.steward} onNavigate={navigate} /></LanguageProvider>);
    const requests = screen.getByRole("link", { name: "Worker requests" });
    expect(requests).toHaveAttribute("aria-current", "page");
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) fireEvent.click(requests, { [modifier]: true });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Issue work" }));
    expect(navigate).toHaveBeenCalledWith("steward", "/m/steward", undefined);
  });
});

afterEach(() => {
  window.history.replaceState({}, "", "/m");
  window.sessionStorage.clear();
});

const LEFT_OUT_KEYS = [
  "clauses", "civic", "dues", "admin-rewards", "admin-reward-economy",
  "admin-catalog-verification", "admin-catalog-vouch", "admin-catalog-verifier",
  "coordinator-funnel", "coordinator-articles", "coordinator-settings",
];
const LEFT_OUT_PATHS = [
  "/m/clauses", "/m/civic", "/m/dues", "/m/admin/rewards", "/m/admin/reward-economy",
  "/m/admin/catalog-verification", "/m/admin/catalog-vouch", "/m/admin/catalog-verifier",
  "/m/coordinator/settings", "/m/coordinator/funnel", "/m/coordinator/articles", "/m/integrations/sso",
];

describe("complete staff role navigation contract", () => {
  it("covers all five hats from one shared desktop/mobile table", () => {
    expect(Object.keys(STAFF_ROLE_NAVIGATION)).toEqual(["steward", "coordinator", "advisor", "admin", "vp"]);
    expect(STAFF_PLANE_TABS).toBe(STAFF_ROLE_NAVIGATION);
    expect(Object.fromEntries(Object.entries(STAFF_ROLE_NAVIGATION).map(([role, items]) => [role, items.length])))
      // The full staff table, less what Union Ground leaves out: Contract
      // clauses (every hat), the civic officer desk (every hat but advisor),
      // dues (admin, VP), the points economy's admin rewards queue and reward
      // economy editor, the three union catalog verification pages (admin),
      // and the grievance procedure's step funnel, contract articles and
      // procedure settings (coordinator). Advisor, admin and VP keep the pay
      // row (UX-UG-WEB-PAY-CATALOG-PUBLISHER-UNREACHABLE-WRITE-HATS-CANNOT-OPEN-M-PAY-20260921),
      // and admin keeps the organization setup review page.
      .toEqual({ steward: 24, coordinator: 18, advisor: 19, admin: 43, vp: 23 });

    for (const [role, items] of Object.entries(STAFF_ROLE_NAVIGATION)) {
      expect(items[0]).toMatchObject({ key: role, viewKey: role, path: `/m/${role}` });
      expect(items.at(-1)).toMatchObject({ key: "tasks", viewKey: "tasks", path: "/m/tasks" });
      // Union Ground's staff Organize row opens the organizing lifecycle tab
      // of the hub, its core plane, rather than the hub's landing.
      expect(items).toContainEqual({ key: "hub", viewKey: "hub", labelKey: "hub.title", path: "/m/organize/organize", icon: "⌂" });
      expect(items).toContainEqual({ key: "campaigns", viewKey: "campaigns", labelKey: "nav.campaigns", path: "/m/campaigns", icon: "C" });
      expect(items).toContainEqual({ key: "coordination", viewKey: "coordination", labelKey: "nav.coordination", path: "/m/coordination", icon: "◎" });
      expect(items).toContainEqual({ key: "member-support", viewKey: "memberSupport", labelKey: "nav.memberSupport", path: "/m/support", icon: "🤝" });
      expect(items).toContainEqual({ key: "analytics", viewKey: "analytics", labelKey: "nav.analytics", path: "/m/analytics", icon: "📊" });
      expect(items).toContainEqual({ key: "organization-map", viewKey: "organizationMap", labelKey: "nav.organizationMap", path: "/m/organization-map", icon: "◎" });
      expect(items).toContainEqual({ key: "actions", viewKey: "actions", labelKey: "nav.collectiveActions", path: "/m/actions", icon: "✊" });
      expect(items).toContainEqual({ key: "qa-queue", viewKey: "qaQueue", labelKey: "nav.qaQueue", path: "/m/qa-queue", icon: "❓" });
      expect(items).toContainEqual({ key: "messages", viewKey: "messages", labelKey: "nav.inbox", path: "/m/messages", icon: "💬" });
      expect(items).toContainEqual({ key: "automations", viewKey: "automations", labelKey: "workspace.automations", path: "/m/automations", icon: "⚙" });
      if (role !== "admin") {
        expect(items).toContainEqual({ key: "events-desk", viewKey: "eventsDesk", labelKey: "eventsDesk.navLabel", path: "/m/events-desk", icon: "📅" });
      }
      expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
      // Left-out destinations are offered on no hat, by key or by path.
      for (const key of LEFT_OUT_KEYS) expect(items.map((item) => item.key), `${role} ${key}`).not.toContain(key);
      for (const item of items) {
        expect(LEFT_OUT_PATHS.some((path) => item.path === path || item.path.startsWith(`${path}/`)), `${role} ${item.path}`).toBe(false);
      }
    }
  });

  it("freezes the Purple route/icon order consumed by every rail", () => {
    expect(Object.fromEntries(Object.entries(STAFF_ROLE_NAVIGATION).map(([role, items]) => [
      role,
      items.filter((item) => item.icon !== "◦").map(({ key, icon }) => [key, icon]),
    ]))).toEqual({
      steward: [["steward", "📁"], ["steward-caseload", "⚖"], ["steward-requests", "📨"], ["steward-appointments", "📅"], ["steward-forms", "🖊"], ["steward-messages", "💬"], ["steward-checkins", "✓"], ["steward-broadcasts", "📣"], ["steward-qa", "❓"], ["messages", "💬"], ["hub", "⌂"], ["events-desk", "📅"], ["campaigns", "C"], ["coordination", "◎"], ["member-support", "🤝"], ["analytics", "📊"], ["organization-map", "◎"], ["actions", "✊"], ["qa-queue", "❓"], ["automations", "⚙"], ["tasks", "☑"]],
      coordinator: [["coordinator", "📋"], ["coordinator-cases", "📁"], ["coordinator-deadlines", "⏰"], ["messages", "💬"], ["hub", "⌂"], ["events-desk", "📅"], ["campaigns", "C"], ["coordination", "◎"], ["member-support", "🤝"], ["analytics", "📊"], ["organization-map", "◎"], ["actions", "✊"], ["qa-queue", "❓"], ["automations", "⚙"], ["tasks", "☑"]],
      advisor: [["advisor", "🧭"], ["advisor-workload", "⏲"], ["advisor-turnout", "🗳"], ["advisor-risks", "⚠"], ["advisor-leadership", "👥"], ["messages", "💬"], ["hub", "⌂"], ["events-desk", "📅"], ["campaigns", "C"], ["coordination", "◎"], ["member-support", "🤝"], ["analytics", "📊"], ["organization-map", "◎"], ["actions", "✊"], ["qa-queue", "❓"], ["pay", "💲"], ["automations", "⚙"], ["tasks", "☑"]],
      admin: [["admin", "🛡"], ["admin-access", "👥"], ["admin-mfa", "🔐"], ["admin-events", "📅"], ["admin-form-templates", "🧾"], ["admin-audit", "📋"], ["admin-organization-audit", "📜"], ["admin-job-health", "⏱"], ["messages", "💬"], ["requests", "📨"], ["hub", "⌂"], ["campaigns", "C"], ["coordination", "◎"], ["member-support", "🤝"], ["analytics", "📊"], ["organization-map", "◎"], ["actions", "✊"], ["qa-queue", "❓"], ["integrations", "🔌"], ["pay", "💲"], ["automations", "⚙"], ["tasks", "☑"]],
      vp: [["vp", "🏛"], ["vp-trend", "📈"], ["vp-attention", "⚖"], ["vp-leadership", "👥"], ["vp-priorities", "🎯"], ["vp-events", "📅"], ["messages", "💬"], ["requests", "📨"], ["hub", "⌂"], ["events-desk", "📅"], ["campaigns", "C"], ["coordination", "◎"], ["member-support", "🤝"], ["analytics", "📊"], ["organization-map", "◎"], ["actions", "✊"], ["qa-queue", "❓"], ["integrations", "🔌"], ["pay", "💲"], ["automations", "⚙"], ["tasks", "☑"]],
    });
  });

  it("groups each staff hat rail the way the shared site design does", () => {
    expect(staffRailGroups("steward", STAFF_ROLE_NAVIGATION.steward).map((group) => [group.labelKey, group.items.map((item) => item.key)])).toEqual([
      ["shell.groupSteward", ["steward"]],
      ["workspace.pages", ["steward-caseload", "steward-requests", "steward-appointments", "steward-forms", "steward-messages", "steward-checkins", "steward-broadcasts", "steward-qa", "steward-email-intake", "steward-workload", "steward-casework-hub"]],
      ["shell.groupWorkspace", ["messages", "hub", "events-desk", "campaigns", "coordination", "member-support", "analytics", "organization-map", "actions", "qa-queue", "automations", "tasks"]],
    ]);
    expect(staffRailGroups("coordinator", STAFF_ROLE_NAVIGATION.coordinator)[0].labelKey).toBe("shell.groupCasework");
    expect(staffRailGroups("advisor", STAFF_ROLE_NAVIGATION.advisor)[0].labelKey).toBe("shell.groupField");
    expect(staffRailGroups("admin", STAFF_ROLE_NAVIGATION.admin)[0].labelKey).toBe("shell.groupAdmin");
    expect(staffRailGroups("vp", STAFF_ROLE_NAVIGATION.vp)[0].labelKey).toBe("shell.groupLeadership");
    expect(staffRailGroups("steward", STAFF_ROLE_NAVIGATION.steward, "tasks")[1].labelKey)
      .toBe("workspace.pages");
  });

  it.each(["desktop", "tablet"])("labels role links as desk destinations from shared Work in %s mode", (renderMode) => {
    if (renderMode === "desktop") window.sessionStorage.setItem("sg:demo:desktop-main-rail:collapsed", "true");
    const onNavigate = vi.fn();
    render(
      <LanguageProvider lang="en">
        <DesktopRail
          active="tasks"
          activeHat="steward"
          demo
          renderMode={renderMode}
          staffPlanes={[{ key: "steward", view: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]}
          onSwitchHat={vi.fn(() => true)}
          onNavigate={onNavigate}
          onAsk={vi.fn()}
          user={{ name: "Sam Okafor", initials: "SO", onProfile: vi.fn() }}
        />
      </LanguageProvider>,
    );

    expect(screen.getByText("Pages")).toBeInTheDocument();
    expect(screen.queryByText("On this page")).not.toBeInTheDocument();
    const requests = screen.getByRole("link", { name: "Worker requests" });
    requests.focus();
    expect(requests).toHaveFocus();
    fireEvent.click(requests, { detail: 0 });
    expect(onNavigate).toHaveBeenCalledWith("steward", "/m/steward/requests", "steward-requests");
    if (renderMode === "desktop") expect(document.querySelector(".desktop-rail")).toHaveAttribute("data-collapsed", "true");
    else expect(document.querySelector(".desktop-rail")).not.toHaveAttribute("data-collapsed");
  });

  it("labels destinations as pages even while the matching role overview is active", () => {
    render(
      <LanguageProvider lang="en">
        <DesktopRail
          active="steward"
          activeHat="steward"
          demo
          renderMode="desktop"
          staffPlanes={[{ key: "steward", view: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]}
          onSwitchHat={vi.fn(() => true)}
          onNavigate={vi.fn()}
          onAsk={vi.fn()}
          user={{ name: "Sam Okafor", initials: "SO", onProfile: vi.fn() }}
        />
        <section id="steward-requests" tabIndex="-1">Request queue target</section>
      </LanguageProvider>,
    );
    expect(screen.getByText("Pages")).toBeInTheDocument();
    expect(screen.queryByText("On this page")).not.toBeInTheDocument();
    expect(screen.queryByText("Desk destinations")).not.toBeInTheDocument();
  });

  it("gives admins none of Union Ground's union catalog verification pages", () => {
    // Organization claims, vouching and platform verification belong to the
    // public union catalog, which Union Ground leaves out.
    for (const page of ["catalog-verification", "catalog-vouch", "catalog-verifier"]) {
      expect(STAFF_ROLE_NAVIGATION.admin.map((item) => item.key)).not.toContain(`admin-${page}`);
      expect(STAFF_ROLE_NAVIGATION.admin.map((item) => item.path)).not.toContain(`/m/admin/${page}`);
      expect(STAFF_ROLE_SECTION_IDS.has(`admin-${page}`)).toBe(false);
    }
  });

  it("gives admins the People waiting page for the platform operator's intake queue", () => {
    expect(STAFF_ROLE_NAVIGATION.admin).toContainEqual({
      key: "admin-people-waiting",
      sectionId: "admin-people-waiting",
      viewKey: "admin",
      labelKey: "admin.peopleWaitingTitle",
      path: "/m/admin/people-waiting",
      icon: "◦",
    });
  });

  it("gives admins a direct destination for the backed template registry", () => {
    expect(STAFF_ROLE_NAVIGATION.admin).toContainEqual({
      key: "admin-form-templates",
      viewKey: "admin",
      labelKey: "admin.templates.title",
      path: "/m/admin/form-templates",
      sectionId: "admin-form-templates",
      icon: "🧾",
    });
  });

  it("maps every page destination to an explicit mounted-section boundary", () => {
    const contractIds = Object.values(STAFF_ROLE_NAVIGATION).flat().map((item) => item.sectionId).filter(Boolean);
    expect(STAFF_ROLE_SECTION_IDS.size).toBe(contractIds.length);

    for (const [role, files] of Object.entries(roleSources)) {
      const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
      for (const item of STAFF_ROLE_NAVIGATION[role].filter((entry) => entry.sectionId)) {
        expect(source).toContain(`"${item.sectionId}"`);
        expect(item.path).not.toBe(`/m/${role}`);
        expect(item.path).not.toContain("#");
      }
    }
  });

  it("opens a separate page instead of scrolling a same-role dashboard", () => {
    window.history.replaceState({}, "", "/m/steward");
    const onNavigate = vi.fn();
    render(
      <LanguageProvider lang="en">
        <BottomNav active="steward" tabs={STAFF_ROLE_NAVIGATION.steward} onNavigate={onNavigate} />
        <section id="steward-requests" tabIndex="-1">Request queue target</section>
      </LanguageProvider>,
    );
    const target = document.getElementById("steward-requests");
    target.scrollIntoView = vi.fn();

    fireEvent.click(screen.getByRole("link", { name: "Worker requests" }));

    expect(onNavigate).toHaveBeenCalledWith("steward", "/m/steward/requests", "steward-requests");
    expect(window.location.pathname).toBe("/m/steward");
    expect(window.location.hash).toBe("");
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Worker requests" })).toHaveAttribute("href", "/m/steward/requests");
  });
});

describe("staff-section hash decode", () => {
  it("treats a malformed fragment as no section, matching currentStaffSection", () => {
    for (const href of ["/m#%", "/m#%E0%A4%A", "/m#100%", "/m#50%-raise", "/m/admin#%zz"]) {
      window.history.replaceState({}, "", href);
      expect(currentStaffSection()).toBe("");
    }
    window.history.replaceState({}, "", "/m#steward-caseload");
    expect(currentStaffSection()).toBe("steward-caseload");
  });

  it("wraps MemberApp's hash-focus decode so URIError cannot escape the effect", () => {
    const source = readFileSync("src/App.jsx", "utf8");
    const start = source.indexOf("Role links are real deep links");
    const end = source.indexOf("const [guideOpen, setGuideOpen]");
    const effect = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(effect).toMatch(/try\s*\{[\s\S]*decodeURIComponent\(window\.location\.hash\.replace\(\/\^#\/, ""\)\)/);
    expect(effect).toMatch(/catch\s*\{/);
    expect(effect).not.toMatch(/^\s*const sectionId = decodeURIComponent\(window\.location\.hash/m);
  });

  it.each(["#%", "#%E0%A4%A", "#100%", "#50%-raise"])(
    "keeps the member shell mounted when the fragment is malformed (%s)",
    (hash) => {
      primeDemoHat("member");
      window.scrollTo = vi.fn();
      window.history.replaceState({}, "", `/m${hash}`);
      render(
        <HashCrashBoundary>
          <App />
        </HashCrashBoundary>,
      );
      expect(screen.queryByRole("heading", { name: "Something went wrong" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    },
  );

  it("keeps a staff desk mounted when the fragment is malformed", async () => {
    primeDemoHat("steward");
    window.scrollTo = vi.fn();
    window.history.replaceState({}, "", "/m/steward?demo=1#%");
    render(
      <HashCrashBoundary>
        <App />
      </HashCrashBoundary>,
    );
    expect(screen.queryByRole("heading", { name: "Something went wrong" })).not.toBeInTheDocument();
    // This assertion exercises malformed hashes, not lazy bundle latency.
    // Give the Steward import scheduling headroom on a loaded runner.
    expect(await screen.findByRole("heading", { level: 1, name: "Committee desk" }, { timeout: 15_000 })).toBeInTheDocument();
  });
});
