import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VpView } from "../src/views/VpView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { StaffSwitcher } from "../src/components/StaffSwitcher.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { downloadEventIcs } from "../src/lib/ics.js";
import { t } from "../src/lib/i18n.js";
import { MemberApiError } from "../src/lib/memberApi.js";
import { declaredFor, mediaRule, mountStylesheets } from "./helpers/appStylesheet.js";
import { expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

const observabilityStubs = vi.hoisted(() => ({
  captureSanitizedDiagnostic: vi.fn(() => true),
}));

vi.mock("../src/lib/ics.js", () => ({ downloadEventIcs: vi.fn() }));

vi.mock("../src/lib/deferredObservability.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, captureSanitizedDiagnostic: observabilityStubs.captureSanitizedDiagnostic };
});

function renderVp(lang = "en", overrides = {}) {
  const api = overrides.api || {
    loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.vpOverview))),
    markReviewed: vi.fn().mockResolvedValue({ caseId: "att-case-1" }),
  };
  render(
    <LanguageProvider lang={lang}>
      <VpView
        data={{ member: { initials: "TM" } }}
        api={api}
        automationControl={overrides.automationControl}
      />
    </LanguageProvider>,
  );
  return api;
}


// Mark reviewed opens a confirmation first (Lovable audit APP-VP-01).
async function reviewFirst(name = "Mark reviewed") {
  fireEvent.click((await screen.findAllByRole("button", { name }))[0]);
  const dialog = await screen.findByTestId("confirm-action");
  fireEvent.click(within(dialog).getByRole("button", { name }));
}
describe("vp view", () => {
  beforeEach(() => {
    observabilityStubs.captureSanitizedDiagnostic.mockClear();
  });

  // BUG-UG-STAFF-DESK-FAILED-LOAD-STICKS-ACROSS-PAGES-20261106: the
  // President desk reads its desk again when another of its pages opens after
  // a failed read, and never re-reads a desk that loaded.
  function renderVpPages(path, api) {
    window.history.replaceState({}, "", path);
    const tree = (location) => (
      <LanguageProvider lang="en">
        <WorkspacePages view="vp" hat="vp" location={location} navigate={vi.fn()}>
          <VpView data={{ member: { initials: "TM" } }} api={api} />
        </WorkspacePages>
      </LanguageProvider>
    );
    const view = render(tree(window.location.href));
    return (next) => {
      window.history.replaceState({}, "", next);
      view.rerender(tree(window.location.href));
    };
  }

  it("reads a failed President desk again when another President page opens", async () => {
    const loadDesk = vi.fn()
      .mockRejectedValueOnce(new MemberApiError("VP overview", { message: "statement timeout" }))
      .mockResolvedValueOnce(JSON.parse(JSON.stringify(fallbackData.vpOverview)));
    try {
      const open = renderVpPages("/m/vp/trend", { loadDesk, markReviewed: vi.fn() });
      expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
      expect(loadDesk).toHaveBeenCalledTimes(1);
      await act(async () => open("/m/vp/attention"));
      expect(await screen.findAllByRole("button", { name: "Mark reviewed" })).not.toHaveLength(0);
      expect(loadDesk).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("does not read a loaded President desk again when another page opens", async () => {
    const loadDesk = vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.vpOverview)));
    try {
      const open = renderVpPages("/m/vp/trend", { loadDesk, markReviewed: vi.fn() });
      await screen.findByText("2026");
      await act(async () => open("/m/vp/attention"));
      expect(await screen.findAllByRole("button", { name: "Mark reviewed" })).not.toHaveLength(0);
      expect(loadDesk).toHaveBeenCalledTimes(1);
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("records nothing when the review confirmation is cancelled", async () => {
    const api = renderVp();
    fireEvent.click((await screen.findAllByRole("button", { name: "Mark reviewed" }))[0]);
    const dialog = await screen.findByTestId("confirm-action");
    fireEvent.click(within(dialog).getByRole("button", { name: t("en", "confirmAction.cancel") }));
    expect(screen.queryByTestId("confirm-action")).toBeNull();
    expect(api.markReviewed).not.toHaveBeenCalled();
  });

  // UB-UG-STAFF-DESK-TITLE-TREATMENT-PER-HAT-20261106: the President
  // desk used a small sans ScreenHeader while every other staff desk renders
  // the shared 28 px serif PageHeader title.
  it("titles the desk with the shared serif page header, the desk line as its purpose", async () => {
    renderVp();
    const title = await screen.findByRole("heading", { level: 1, name: "Leadership overview" });
    expect(title).toHaveClass("phead__title");
    expect(title.closest("header")).toHaveClass("sg-page-header");
    expect(within(title.closest("header")).getByText("Campaign leadership")).toHaveClass("phead__sub");
  });

  it("keeps the automation control room reachable for an authorized VP", () => {
    renderVp("en", { automationControl: <div data-testid="vp-automation-control">Automation controls</div> });
    expect(screen.getByTestId("vp-automation-control")).toBeInTheDocument();
  });

  it.each([
    ["en", "Open campaign issues you can see"],
    ["es", "Quejas abiertas de la campaña que puedes ver"],
  ])("names the President's chapter and access scope in %s", async (lang, label) => {
    renderVp(lang);
    const kpi = (await screen.findByText(label)).closest(".pkpi");
    expect(within(kpi).getByText(String(fallbackData.vpOverview.overview.activeGrievances))).toBeVisible();
  });

  it("renders chapter aggregates, quorum-based turnout, and the join-year trend", async () => {
    renderVp();
    expect(await screen.findByText("Campaign workers")).toBeInTheDocument();
    expect(screen.getAllByText("812").length).toBeGreaterThan(0);
    // 213 votes / 300 quorum = 71%.
    expect(screen.getByText("71")).toBeInTheDocument();
    expect(screen.getByText("213 of 300 votes needed for quorum")).toBeInTheDocument();
    expect(screen.getByText("% of quorum")).toBeInTheDocument();
    // Years also appear as roster member-since values — assert presence, not uniqueness.
    expect(screen.getAllByText("2021").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026").length).toBeGreaterThan(0);
  });

  // BUG-UG-WEB-PRESIDENT-TREND-BARS-WRAP-20261002: the chart used
  // repeat(auto-fit, minmax(64px, 1fr)), which fits four columns at phone
  // width and wrapped 2025-2026 onto a second row with its own baseline, so
  // bar heights stopped comparing on one scale.
  it("lays the join-year trend out as one row with one equal column per year", async () => {
    const unmountStyles = mountStylesheets();
    try {
      renderVp();
      await screen.findByText("Campaign workers");
      const chart = document.querySelector(".vp-trend-chart");
      const columns = chart.querySelectorAll(":scope > .vp-trend-chart__column");
      expect([...columns].map((column) => column.querySelector("small").textContent)).toEqual(["2021", "2022", "2023", "2024", "2025", "2026"]);
      const style = getComputedStyle(chart);
      expect(style.display).toBe("grid");
      expect(style.gridAutoFlow).toBe("column");
      expect(style.gridAutoColumns).toBe("minmax(0px, 1fr)");
      // No explicit track list, so nothing can auto-fit or auto-fill and wrap.
      expect(declaredFor(".vp-trend-chart")).not.toMatch(/auto-fit|auto-fill|grid-template-columns/);
      expect(mediaRule("(max-width", ".vp-trend-chart")).toBeNull();
    } finally {
      unmountStyles();
    }
  });

  // BUG-UG-VP-DESK-REPEATED-TITLES-AND-SQUEEZED-TURNOUT-NOTE-20261106:
  // a focused President page named its section twice, once as the page
  // heading and again as a section heading directly under it.
  it.each([
    ["/m/vp/trend", "Participation trend", "vp.trendSub"],
    ["/m/vp/attention", "Needs exec attention", "vp.attentionSub"],
    ["/m/vp/events", "Upcoming meetings", "vp.agendaSub"],
  ])("shows the title of %s once and keeps its explanatory line", async (path, title, subKey) => {
    window.history.replaceState({}, "", path);
    try {
      render(
        <LanguageProvider lang="en">
          <WorkspacePages view="vp" hat="vp" location={window.location.href} navigate={vi.fn()}>
            <VpView data={{ member: { initials: "TM" } }} api={{ loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.vpOverview))), markReviewed: vi.fn() }} />
          </WorkspacePages>
        </LanguageProvider>,
      );
      expect(await screen.findByText(t("en", subKey))).toBeTruthy();
      expect(screen.getAllByRole("heading", { name: title })).toHaveLength(1);
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("cancelling the review confirmation records nothing", async () => {
    const api = renderVp();
    fireEvent.click((await screen.findAllByRole("button", { name: "Mark reviewed" }))[0]);
    const dialog = await screen.findByTestId("confirm-action");
    fireEvent.click(within(dialog).getByRole("button", { name: t("en", "confirmAction.cancel") }));
    expect(screen.queryByTestId("confirm-action")).toBeNull();
    expect(api.markReviewed).not.toHaveBeenCalled();
  });

  it("keeps the section headings when there is no page heading", async () => {
    renderVp();
    await screen.findByText("Campaign workers");
    expect(screen.getByRole("heading", { name: "Participation trend" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Upcoming meetings" })).toBeTruthy();
  });

  // UB-UG-STAFF-DESK-STAT-CARDS-THREE-TREATMENTS-20261108: the
  // President's headline numbers used the member StatCard (letterspaced caps,
  // no edge) flush against the header rule, with a section list wider than
  // the cards. They now use the staff-desk tile inside the same inset column
  // as Advisor and Admin.
  it("draws its headline numbers with the shared staff-desk tile in the shared inset column", async () => {
    renderVp();
    await screen.findByText("Campaign workers");
    const body = document.querySelector(".screen > .vp-body");
    expect(body).not.toBeNull();
    expect(body.querySelectorAll(".pkpi-grid > .pkpi")).toHaveLength(4);
    expect(document.querySelector(".stat-card")).toBeNull();
    expect(screen.getByText("213 of 300 votes needed for quorum")).toHaveClass("pkpi__sub");
    expect(screen.getByText("% of quorum")).toHaveClass("pkpi__suffix");

    const unmountStyles = mountStylesheets();
    try {
      expect(declaredFor(".vp-body")).toMatch(/padding: 22px 28px 28px/);
      expect(declaredFor(".ach-body")).toMatch(/padding: 22px 28px 28px/);
      expect(declaredFor(".vp-body .message-section")).toMatch(/padding-inline: 0/);
      expect(mediaRule("(max-width: 900px)", ".vp-body")?.cssText).toMatch(/padding: 12px 16px 24px/);
      // A wide figure and unit ("138% of quorum") must wrap inside its tile,
      // not widen its column past a 320 px screen.
      expect(declaredFor(".pkpi-grid")).toMatch(/repeat\(4, minmax\(0(px)?, 1fr\)\)/);
      expect(mediaRule("(max-width: 900px)", ".pkpi-grid")?.cssText).toMatch(/repeat\(2, minmax\(0(px)?, 1fr\)\)/);
      expect(declaredFor(".pkpi__value--suffixed")).toMatch(/flex-wrap: wrap/);
      expect(declaredFor(".pkpi__value")).toMatch(/overflow-wrap: anywhere/);
    } finally {
      unmountStyles();
    }
  });

  it("persists an attention review and keeps the server marker after reload", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.vpOverview));
    const api = {
      loadDesk: vi.fn()
        .mockResolvedValueOnce(seed)
        .mockResolvedValueOnce({ ...seed, reviews: [{ caseId: "att-case-1", reviewedAt: "2026-08-10T15:00:00Z", reviewerName: "Taylor Morgan" }] }),
      markReviewed: vi.fn().mockResolvedValue({ caseId: "att-case-1" }),
    };
    renderVp("en", { api });
    expect(await screen.findByText("Evening-shift card count still short")).toBeInTheDocument();
    const button = screen.getAllByRole("button", { name: "Mark reviewed" })[0];
    expect(button).toHaveStyle({ minHeight: "44px" });
    fireEvent.click(button);
    // The tap opens a confirmation that says what is recorded (APP-VP-01).
    expect(api.markReviewed).not.toHaveBeenCalled();
    const confirm = await screen.findByTestId("confirm-action");
    expect(within(confirm).getByText("The issue, its deadline and its step do not change.")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Mark reviewed" }));
    expect(api.markReviewed).toHaveBeenCalledWith("att-case-1");
    expect(await screen.findByRole("button", { name: "Reviewed ✓" })).toBeDisabled();
    expect(api.loadDesk).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Reviewed by Taylor Morgan/)).toBeInTheDocument();
  });

  it("records nothing when the review confirmation is cancelled", async () => {
    const api = renderVp();
    fireEvent.click((await screen.findAllByRole("button", { name: "Mark reviewed" }))[0]);
    const confirm = await screen.findByTestId("confirm-action");
    fireEvent.click(within(confirm).getByRole("button", { name: t("en", "confirmAction.cancel") }));
    expect(screen.queryByTestId("confirm-action")).toBeNull();
    expect(api.markReviewed).not.toHaveBeenCalled();
  });

  // BUG-UG-DESK-COUNTS-NO-THOUSANDS-SEPARATOR-20261106
  it("writes large chapter counts with a thousands separator", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.vpOverview));
    seed.overview.memberCount = 1506;
    renderVp("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed), markReviewed: vi.fn() } });
    const card = (await screen.findByText("Campaign workers")).closest(".pkpi");
    expect(card.querySelector(".pkpi__value")).toHaveTextContent("1,506");
  });

  it("reports a persistence failure without claiming the case is reviewed", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.vpOverview))),
      markReviewed: vi.fn().mockRejectedValue(new Error("write denied")),
    };
    renderVp("en", { api });
    await reviewFirst("Mark reviewed");
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "vp.reviewFailed"));
    expect(document.body.textContent).not.toContain("write denied");
    expect(screen.getAllByRole("button", { name: "Mark reviewed" }).length).toBeGreaterThan(0);
    expect(observabilityStubs.captureSanitizedDiagnostic).toHaveBeenCalledWith({
      kind: "vp_mark_reviewed_failure",
      code: null,
      name: "Error",
      label: null,
      details: null,
      hint: null,
    });
    expect(JSON.stringify(observabilityStubs.captureSanitizedDiagnostic.mock.calls)).not.toContain("write denied");
  });

  it("logs a nameless rejection with a null name", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.vpOverview))),
      markReviewed: vi.fn().mockRejectedValue({ code: "57014" }),
    };
    renderVp("en", { api });
    await reviewFirst("Mark reviewed");
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "vp.reviewFailed"));
    expect(observabilityStubs.captureSanitizedDiagnostic).toHaveBeenCalledWith({
      kind: "vp_mark_reviewed_failure", code: "57014", name: null, label: null, details: null, hint: null,
    });
  });

  describe("mark-reviewed MemberApiError copy and placement", () => {
    beforeEach(() => {
      observabilityStubs.captureSanitizedDiagnostic.mockClear();
    });

    function rejectWithMemberApiError() {
      return new MemberApiError("Leadership review", {
        message: "permission denied",
        code: "42501",
        details: "RPC mark_vp_case_reviewed refused",
        hint: "check grants",
      });
    }

    async function expectFailedCaseAAlert(lang) {
      const copy = t(lang, "vp.reviewFailed");
      const alerts = await screen.findAllByRole("alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toHaveTextContent(copy);
      expect(document.body.textContent).not.toContain("Leadership review");
      expect(document.body.textContent).not.toContain("mark_vp_case_reviewed");
      expect(document.body.textContent).not.toContain("permission denied");
      expect(document.body.textContent).not.toContain("RPC mark_vp_case_reviewed refused");
      expect(document.body.textContent).not.toContain("check grants");
      const attention = document.querySelector("#vp-attention");
      expect(attention).not.toBeNull();
      expect(attention.contains(alerts[0])).toBe(true);
      expect(document.querySelector(".vp-trend-card")?.contains(alerts[0])).toBe(false);
      const caseA = document.querySelector('[data-attention-case="att-case-1"]');
      const caseB = document.querySelector('[data-attention-case="att-case-2"]');
      expect(caseA.contains(alerts[0])).toBe(true);
      expect(caseB.querySelector("[role='alert']")).toBeNull();
      expect(observabilityStubs.captureSanitizedDiagnostic).toHaveBeenCalledWith({
        kind: "vp_mark_reviewed_failure",
        code: "42501",
        name: "MemberApiError",
        label: "Leadership review",
        details: "RPC mark_vp_case_reviewed refused",
        hint: "check grants",
      });
      const logged = JSON.stringify(observabilityStubs.captureSanitizedDiagnostic.mock.calls);
      expect(logged).toContain("Leadership review");
      expect(logged).toContain("RPC mark_vp_case_reviewed refused");
      expect(logged).toContain("check grants");
      expect(logged).not.toContain("permission denied");
    }

    it("shows translated EN copy in the failing attention row only", async () => {
      const api = {
        loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.vpOverview))),
        markReviewed: vi.fn().mockRejectedValue(rejectWithMemberApiError()),
      };
      renderVp("en", { api });
      await reviewFirst(t("en", "vp.markReviewed"));
      await expectFailedCaseAAlert("en");
      expect(screen.getAllByRole("button", { name: t("en", "vp.markReviewed") }).length).toBeGreaterThan(0);
    });

    it("shows translated ES copy in the failing attention row only", async () => {
      const api = {
        loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.vpOverview))),
        markReviewed: vi.fn().mockRejectedValue(rejectWithMemberApiError()),
      };
      renderVp("es", { api });
      await reviewFirst(t("es", "vp.markReviewed"));
      await expectFailedCaseAAlert("es");
      expect(screen.getAllByRole("button", { name: t("es", "vp.markReviewed") }).length).toBeGreaterThan(0);
    });

    it("disables every attention row while one review is in flight so a later success cannot erase an earlier failure", async () => {
      let rejectA;
      const markReviewed = vi.fn((id) => {
        if (id === "att-case-1") {
          return new Promise((_, reject) => {
            rejectA = reject;
          });
        }
        return Promise.resolve({ caseId: id });
      });
      const seed = JSON.parse(JSON.stringify(fallbackData.vpOverview));
      const api = {
        loadDesk: vi.fn()
          .mockResolvedValueOnce(seed)
          .mockResolvedValueOnce({
            ...seed,
            reviews: [{ caseId: "att-case-2", reviewedAt: "2026-08-10T15:00:00Z", reviewerName: "Taylor Morgan" }],
          }),
        markReviewed,
      };
      renderVp("en", { api });
      await reviewFirst(t("en", "vp.markReviewed"));
      expect(await screen.findByRole("button", { name: t("en", "vp.reviewing") })).toHaveAttribute("aria-disabled", "true");
      const idleButtons = screen.getAllByRole("button", { name: t("en", "vp.markReviewed") });
      expect(idleButtons.length).toBeGreaterThan(0);
      idleButtons.forEach((button) => expect(button).toHaveAttribute("aria-disabled", "true"));
      fireEvent.click(idleButtons[0]);
      expect(markReviewed).toHaveBeenCalledTimes(1);
      expect(markReviewed).toHaveBeenCalledWith("att-case-1");

      await act(async () => {
        rejectA(rejectWithMemberApiError());
      });
      await expectFailedCaseAAlert("en");

      const retryButtons = screen.getAllByRole("button", { name: t("en", "vp.markReviewed") });
      expect(retryButtons).toHaveLength(2);
      retryButtons.forEach((button) => expect(button).toBeEnabled());
      fireEvent.click(retryButtons[1]);
      fireEvent.click(within(await screen.findByTestId("confirm-action")).getByRole("button", { name: t("en", "vp.markReviewed") }));
      expect(markReviewed).toHaveBeenCalledTimes(2);
      expect(markReviewed).toHaveBeenNthCalledWith(2, "att-case-2");
      expect(await screen.findByRole("button", { name: t("en", "vp.reviewed") })).toBeDisabled();
      expect(document.querySelector('[data-attention-case="att-case-1"]')?.querySelector("[role='alert']")).toBeNull();
    });
  });

  it("renders the live staff roster with localized role chips", async () => {
    renderVp();
    expect(await screen.findByText("Taylor Morgan")).toBeInTheDocument();
    expect(screen.getByText("Campaign chair")).toBeInTheDocument(); // vp role chip label
    expect(screen.getByText("Campaign lead")).toBeInTheDocument();
  });

  it("surfaces open ballots and surveys as priorities and real events with ICS download", async () => {
    renderVp();
    expect(await screen.findByText("Should we file the representation petition this month?")).toBeInTheDocument();
    expect(screen.getByText("Weekly pulse — mandated overtime")).toBeInTheDocument();
    expect(screen.getByText("Recognition strategy session")).toBeInTheDocument();
    const calendarButtons = screen.getAllByRole("button", { name: "Add to calendar" });
    expect(calendarButtons).toHaveLength(3);
    fireEvent.click(calendarButtons[0]);
    expect(downloadEventIcs).toHaveBeenCalledWith(expect.objectContaining({ id: fallbackData.vpOverview.overview.upcomingEvents[0].id }));
  });

  it("keeps backed empty states honest when trend, priorities, and events are absent", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.vpOverview));
    seed.overview.membershipTrend = null;
    seed.overview.turnout = null;
    seed.overview.priorities = [];
    seed.overview.upcomingEvents = [];
    renderVp("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });

    expect(await screen.findByText("No closed vote yet")).toBeInTheDocument();
    expect(screen.getByText("No open votes or surveys right now.")).toBeInTheDocument();
    expect(screen.getByText("No upcoming meetings scheduled.")).toBeInTheDocument();
    // #8216: an absent trend says so instead of drawing an empty chart.
    expect(document.querySelector(".vp-trend-chart")).toBeNull();
    expect(screen.getByText("No worker records carry a join year from the last five years yet, so there is no trend to draw.")).toBeInTheDocument();
  });

  // #10025: the Leadership team is the open chapter's, and its line says so.
  it.each([
    ["en", "Leadership team", "Everyone holding a staff role in this campaign right now."],
    ["es", "Equipo de liderazgo", "Quienes tienen un rol de personal en esta campaña ahora mismo."],
  ])("says the Leadership team is this campaign's in %s", async (lang, title, sub) => {
    renderVp(lang);
    const roster = (await screen.findAllByText(title)).map((node) => node.closest("#vp-leadership")).find(Boolean);
    expect(roster).toBeTruthy();
    expect(within(roster).getByText(sub)).toBeInTheDocument();
  });

  it("renders fully in Spanish", async () => {
    renderVp("es");
    expect(await screen.findByText("Panorama de liderazgo")).toBeInTheDocument();
    expect(screen.getByText("Trabajadores de la campaña")).toBeInTheDocument();
    expect(screen.getByText("Equipo de liderazgo")).toBeInTheDocument();
  });

  // E1 card layer. The plane surface is the .plane-card CSS class now, not a
  // spread style object. `{...undefined}` is legal JavaScript, so dropping the
  // export or the className would strip the background, radius and shadow with
  // no error and no lint warning. Anchored on a roster row because the roster
  // is the consumer that has no plane-card ancestor to mask a regression.
  it("keeps the .plane-card surface on the roster and the plane sections", async () => {
    renderVp();
    const rosterRow = await screen.findByText("Taylor Morgan");
    expect(rosterRow.closest(".plane-card")).not.toBeNull();
    // Trend, attention, priorities and the agenda cards are plane surfaces too.
    expect(document.querySelectorAll(".plane-card").length).toBeGreaterThan(1);
  });

  it("reads a desk that omits priorities and an attention case with no member name", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.vpOverview));
    delete seed.overview.priorities;
    const [first] = seed.overview.attention;
    seed.overview.attention = [{ ...first, memberName: "" }];
    renderVp("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    expect(await screen.findByText("No open votes or surveys right now.")).toBeInTheDocument();
    const row = document.querySelector(`[data-attention-case="${first.id}"]`);
    expect(row).not.toBeNull();
    expect(row.textContent).toContain(first.reference);
    if (first.memberName) expect(row.textContent).not.toContain(`${first.memberName} · `);
  });

  it("shows the calm empty state when nothing is overdue", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.vpOverview));
    seed.overview.attention = [];
    renderVp("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    expect(await screen.findByText("Nothing overdue — every active issue is inside its window.")).toBeInTheDocument();
  });
});

describe("staff switcher", () => {
  it("renders one chip per granted real plane plus Member, and navigates", () => {
    const onNavigate = vi.fn();
    render(
      <LanguageProvider lang="en">
        <StaffSwitcher roles={["coordinator"]} activeView="today" onNavigate={onNavigate} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("button", { name: "Worker" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Committee" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Campaign lead" }));
    expect(onNavigate).toHaveBeenCalledWith("coordinator", "/m/coordinator");
  });

  it("renders nothing for plain members", () => {
    const { container } = render(
      <LanguageProvider lang="en">
        <StaffSwitcher roles={[]} activeView="today" onNavigate={vi.fn()} />
      </LanguageProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows advisor and admin chips now those planes are real (PR4b)", () => {
    render(
      <LanguageProvider lang="en">
        <StaffSwitcher roles={["admin", "advisor"]} activeView="today" onNavigate={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("button", { name: "Advisor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Admin" })).toBeInTheDocument();
  });
});

// Record 8435 (and #8903's review, P2-2): Mark reviewed keeps focus while the
// review is saved, and the review lock refuses a second save in the same tick.
describe("vp view while a review is saved", () => {
  it("returns focus to Mark reviewed, which stays focused and pending while the review is saved", async () => {
    enableFocusFixup();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const markReviewed = vi.fn(async () => { await held; return { caseId: "att-case-1" }; });
    renderVp("en", { api: { loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.vpOverview))), markReviewed } });
    const row = (await screen.findAllByRole("button", { name: t("en", "vp.markReviewed") }))[0];
    row.focus();
    fireEvent.click(row);
    const dialog = await screen.findByTestId("confirm-action");
    fireEvent.click(within(dialog).getByRole("button", { name: t("en", "vp.markReviewed") }));
    await act(async () => { await afterRenderingUpdate(); });
    expect(markReviewed).toHaveBeenCalledTimes(1);
    expect(row).toHaveTextContent(t("en", "vp.reviewing"));
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toBeEnabled();
    expect(row).toHaveFocus();
    fireEvent.click(row);
    expect(screen.queryByTestId("confirm-action")).not.toBeInTheDocument();
    await act(async () => { release(); });
    expect(markReviewed).toHaveBeenCalledTimes(1);
  });

  it("saves one review when the confirmation is activated twice in one tick", async () => {
    const markReviewed = vi.fn(async () => ({ caseId: "att-case-1" }));
    renderVp("en", { api: { loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.vpOverview))), markReviewed } });
    fireEvent.click((await screen.findAllByRole("button", { name: t("en", "vp.markReviewed") }))[0]);
    const confirm = within(await screen.findByTestId("confirm-action")).getByRole("button", { name: t("en", "vp.markReviewed") });
    await expectOneWriteFromOneTick(markReviewed, [() => fireEvent.click(confirm), () => fireEvent.click(confirm)]);
  });
});

