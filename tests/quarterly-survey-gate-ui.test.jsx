// REQ-UG-QUARTERLY-SURVEY-GATE-ENFORCED-20261001 (CR-002, "give to view"),
// server-enforced since REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002
// . The web half: the banner, and no page, while the server
// gate is locked or unknown; a failed read is locked with a retry; the page
// itself only once the server says it is open.
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuarterlySurveyGate, gateLocksPage, gateOpensPage, gateStatusFor, quarterLabel } from "../src/features/engagement/QuarterlySurveyGate.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { buildMi1AnalyticsActor } from "../src/lib/mi1AnalyticsWiring.js";
import { AnalyticsCoreView } from "../src/views/AnalyticsCoreView.jsx";

const read = (path) => readFileSync(path, "utf8");

function clientReturning(...results) {
  const queue = [...results];
  return { rpc: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])) };
}

function renderGate({ client, lang = "en", onTakeSurvey = vi.fn(), organizationId = "org-1" } = {}) {
  render(<LanguageProvider lang={lang}>
    <QuarterlySurveyGate client={client} organizationId={organizationId} onTakeSurvey={onTakeSurvey}>
      <button type="button">Build a chart</button>
    </QuarterlySurveyGate>
  </LanguageProvider>);
  return { onTakeSurvey };
}

afterEach(cleanup);

const LOCKED = { periodKey: "2026-Q4", surveyId: "survey-q4", required: true, completed: false, unlocked: false, reason: "incomplete", gateEnabled: true };

describe("quarterly survey gate helpers", () => {
  it("labels a period key and refuses anything else", () => {
    expect(quarterLabel("2026-Q4")).toBe("Q4 2026");
    expect(quarterLabel("2026-Q5")).toBe("");
    expect(quarterLabel(null)).toBe("");
  });

  it("locks only on an explicit server lock that names the survey, and opens only on an explicit unlock", () => {
    expect(gateLocksPage(LOCKED)).toBe(true);
    expect(gateLocksPage({ ...LOCKED, unlocked: true })).toBe(false);
    expect(gateLocksPage({ ...LOCKED, surveyId: null })).toBe(false);
    expect(gateLocksPage(null)).toBe(false);
    expect(gateOpensPage({ ...LOCKED, unlocked: true })).toBe(true);
    expect(gateOpensPage({ ...LOCKED, unlocked: undefined })).toBe(false);
    expect(gateOpensPage([])).toBe(false);
    expect(gateOpensPage(null)).toBe(false);
  });
});

describe("QuarterlySurveyGate", () => {
  it("shows the banner instead of the page while locked, and the banner opens the survey", async () => {
    const client = clientReturning({ data: LOCKED, error: null });
    const { onTakeSurvey } = renderGate({ client });
    expect(screen.getByTestId("quarterly-gate-checking")).toHaveAttribute("role", "status");
    expect(screen.queryByText("Build a chart")).toBeNull();
    const banner = await screen.findByTestId("quarterly-survey-banner");
    expect(client.rpc).toHaveBeenCalledWith("get_quarterly_survey_gate", {});
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveAttribute("data-quarterly-gate", "locked");
    expect(banner.textContent).toContain("Unlock your Q4 2026 stats and charts");
    // The locked page is not rendered at all.
    expect(screen.queryByText("Build a chart")).toBeNull();
    expect(screen.queryByTestId("quarterly-gate-content")).toBeNull();
    expect(screen.queryByTestId("quarterly-survey-banner-retry")).toBeNull();
    fireEvent.click(screen.getByTestId("quarterly-survey-banner-cta"));
    expect(onTakeSurvey).toHaveBeenCalledWith("survey-q4");
  });

  it("speaks Spanish when the member reads Spanish", async () => {
    renderGate({ client: clientReturning({ data: LOCKED, error: null }), lang: "es" });
    const banner = await screen.findByTestId("quarterly-survey-banner");
    expect(banner.textContent).toContain(catalogue.es["quarterlyGate.cta"]);
    expect(banner.textContent).toContain("Q4 2026");
  });

  it.each([
    ["the survey is completed", { ...LOCKED, completed: true, unlocked: true, reason: "completed" }],
    ["the caller is an admin", { ...LOCKED, unlocked: true, reason: "admin" }],
    ["the organization switch is off", { ...LOCKED, unlocked: true, reason: "disabled", gateEnabled: false }],
    ["no quarterly survey exists", { periodKey: "2026-Q4", surveyId: null, required: false, completed: false, unlocked: true, reason: "no_survey" }],
  ])("shows the page when %s", async (_label, gate) => {
    const client = clientReturning({ data: gate, error: null });
    renderGate({ client });
    const content = await screen.findByTestId("quarterly-gate-content");
    expect(content).toHaveAttribute("data-quarterly-gate", "open");
    expect(content.textContent).toContain("Build a chart");
    expect(screen.queryByTestId("quarterly-survey-banner")).toBeNull();
  });

  it.each([
    ["a refused read", { data: null, error: { code: "42501", message: "denied" } }],
    ["an empty answer", { data: null, error: null }],
    ["a malformed answer", { data: { unlocked: false }, error: null }],
  ])("treats %s as locked with a retry, never showing the page", async (_label, failure) => {
    const client = clientReturning(failure, { data: { ...LOCKED, unlocked: true, reason: "completed" }, error: null });
    const { onTakeSurvey } = renderGate({ client });
    const banner = await screen.findByTestId("quarterly-survey-banner");
    expect(banner).toHaveAttribute("data-quarterly-gate", "error");
    expect(banner.textContent).toContain("We couldn’t check this quarter’s survey");
    expect(screen.queryByText("Build a chart")).toBeNull();
    fireEvent.click(screen.getByTestId("quarterly-survey-banner-cta"));
    expect(onTakeSurvey).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByTestId("quarterly-survey-banner-retry"));
    expect(await screen.findByText("Build a chart")).toBeTruthy();
    expect(client.rpc).toHaveBeenCalledTimes(2);
  });

  it("never shows the page on the previous organization's or account's answer while the new check runs", async () => {
    let finishB;
    const client = { rpc: vi.fn()
      .mockResolvedValueOnce({ data: { ...LOCKED, unlocked: true, reason: "completed" }, error: null })
      .mockReturnValueOnce(new Promise((resolve) => { finishB = resolve; }))
      .mockReturnValueOnce(new Promise(() => {})) };
    // Counts every render of the gated page, including a render that an
    // effect replaces before the browser paints.
    const renders = [];
    function Page({ organizationId }) {
      renders.push(organizationId);
      return <button type="button">Build a chart</button>;
    }
    const gate = (organizationId, sessionKey = "user-1") => <LanguageProvider lang="en">
      <QuarterlySurveyGate client={client} organizationId={organizationId} sessionKey={sessionKey} onTakeSurvey={vi.fn()}>
        <Page organizationId={organizationId} />
      </QuarterlySurveyGate>
    </LanguageProvider>;
    const { rerender } = render(gate("org-a"));
    expect(await screen.findByText("Build a chart")).toBeTruthy();
    expect(renders).toContain("org-a");
    // Organization B: the first render with the new context is already
    // checking, before any effect runs; organization A's unlock does not carry.
    rerender(gate("org-b"));
    expect(renders).not.toContain("org-b");
    expect(screen.queryByText("Build a chart")).toBeNull();
    expect(screen.getByTestId("quarterly-gate-checking")).toBeTruthy();
    finishB({ data: LOCKED, error: null });
    expect(await screen.findByTestId("quarterly-survey-banner")).toHaveAttribute("data-quarterly-gate", "locked");
    // Another account in the same organization starts from checking too.
    rerender(gate("org-b", "user-2"));
    expect(screen.queryByTestId("quarterly-survey-banner")).toBeNull();
    expect(screen.getByTestId("quarterly-gate-checking")).toBeTruthy();
    expect(client.rpc).toHaveBeenCalledTimes(3);
  });

  it("renders a stored result only in the context it was read for", () => {
    const context = { enforced: true, client: "c", organizationId: "org-a", sessionKey: "user-1" };
    const open = { status: "open", gate: null, client: "c", organizationId: "org-a", sessionKey: "user-1" };
    expect(gateStatusFor(open, context)).toBe("open");
    expect(gateStatusFor(open, { ...context, organizationId: "org-b" })).toBe("checking");
    expect(gateStatusFor(open, { ...context, sessionKey: "user-2" })).toBe("checking");
    expect(gateStatusFor(open, { ...context, client: "other" })).toBe("checking");
    expect(gateStatusFor({ ...open, status: "locked" }, { ...context, organizationId: "org-b" })).toBe("checking");
    expect(gateStatusFor(null, context)).toBe("checking");
    expect(gateStatusFor(null, { ...context, enforced: false })).toBe("open");
  });

  it("shows the page without a check in a fixture preview (no client) or without an organization", () => {
    renderGate({ client: null });
    expect(screen.getByTestId("quarterly-gate-content")).toHaveAttribute("data-quarterly-gate", "open");
    cleanup();
    const unused = clientReturning({ data: LOCKED, error: null });
    renderGate({ client: unused, organizationId: null });
    expect(unused.rpc).not.toHaveBeenCalled();
    expect(screen.getByText("Build a chart")).toBeTruthy();
  });
});

// BUG-UG-WEB-ANALYTICS-ERROR-INERT-UNDER-SURVEY-GATE-20261002: a failed
// analytics load is never dimmed or inert. Since the server-enforced gate
// (REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002,) the locked
// page is not rendered at all, so there is no inert region for an error to fall
// into. These cases pin that, and that the error with its Try again is usable
// in place whenever the page renders.
describe("a failed analytics load and the survey gate", () => {
  const ORG_A = "11111111-1111-4111-8111-111111111111";
  const COMPLETED = { ...LOCKED, completed: true, unlocked: true, reason: "completed" };
  const ERROR_COPY = catalogue.en["analytics.error"];

  function analyticsTree({ gateClient, adapter }) {
    return <LanguageProvider lang="en">
      <QuarterlySurveyGate client={gateClient} organizationId={ORG_A} onTakeSurvey={vi.fn()}>
        <AnalyticsCoreView
          viewer={buildMi1AnalyticsActor({ userId: "admin-a", organizationId: ORG_A, roles: ["admin"], mfaSatisfied: true, selectedHat: "admin" })}
          client={null}
          api={adapter}
        />
      </QuarterlySurveyGate>
    </LanguageProvider>;
  }

  function failingThenReady() {
    let fail = true;
    const adapter = {
      loadDesk: vi.fn(async () => {
        if (fail) throw new Error("analytics snapshot failed");
        return { state: "unset", reason: "unset" };
      }),
      exportDesk: vi.fn(),
    };
    return { adapter, recover: () => { fail = false; } };
  }

  it("renders nothing dimmed or inert while the gate is locked: the page and its load wait for the gate", async () => {
    const { adapter } = failingThenReady();
    render(analyticsTree({ gateClient: clientReturning({ data: LOCKED, error: null }), adapter }));
    const banner = await screen.findByTestId("quarterly-survey-banner");
    expect(banner).toHaveAttribute("data-quarterly-gate", "locked");
    expect(document.querySelector("[inert]")).toBeNull();
    expect(document.querySelector("[aria-disabled='true']")).toBeNull();
    expect(screen.queryByTestId("quarterly-gate-content")).toBeNull();
    expect(screen.queryByText(ERROR_COPY)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(adapter.loadDesk).not.toHaveBeenCalled();
    // The only controls are the banner's, and every one of them works.
    for (const button of screen.getAllByRole("button")) expect(button).toBeEnabled();
  });

  it("shows the error and a working Try again in place, outside any inert subtree, once the gate is open", async () => {
    const { adapter, recover } = failingThenReady();
    render(analyticsTree({ gateClient: clientReturning({ data: COMPLETED, error: null }), adapter }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    const message = screen.getByText(ERROR_COPY);
    expect(message.closest("[inert]")).toBeNull();
    expect(retry.closest("[inert]")).toBeNull();
    expect(screen.getByTestId("quarterly-gate-content")).toContainElement(retry);
    expect(screen.queryByTestId("quarterly-survey-banner")).toBeNull();
    const calls = adapter.loadDesk.mock.calls.length;
    recover();
    retry.focus();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(adapter.loadDesk.mock.calls.length).toBe(calls + 1);
    await waitFor(() => expect(screen.queryByText(ERROR_COPY)).toBeNull());
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Organization analytics" })).toHaveFocus());
  });

  it("after a failed gate check, the banner's own retry re-reads the gate, and then the page's error is usable in place", async () => {
    const { adapter } = failingThenReady();
    const gateClient = clientReturning({ data: null, error: { code: "42501", message: "denied" } }, { data: COMPLETED, error: null });
    render(analyticsTree({ gateClient, adapter }));
    const banner = await screen.findByTestId("quarterly-survey-banner");
    expect(banner).toHaveAttribute("data-quarterly-gate", "error");
    expect(adapter.loadDesk).not.toHaveBeenCalled();
    expect(document.querySelector("[inert]")).toBeNull();
    fireEvent.click(screen.getByTestId("quarterly-survey-banner-retry"));
    await waitFor(() => expect(screen.queryByTestId("quarterly-survey-banner")).toBeNull());
    expect(gateClient.rpc).toHaveBeenCalledTimes(2);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(retry.closest("[inert]")).toBeNull();
    expect(screen.getByTestId("quarterly-gate-content")).toContainElement(retry);
    expect(screen.getByText(ERROR_COPY).closest("[inert]")).toBeNull();
  });
});

describe("give-to-view wiring", () => {
  it("gates reports, workload and the analytics desk in the web shell and links to the survey", () => {
    const app = read("src/App.jsx");
    expect(app).toContain("numbers: quarterlySurveyGate(<NumbersView");
    // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: on
    // the web the gate covers the workload stats it unlocks; the log, its
    // history and reminders stay usable.
    expect(app).toContain("statsGate={quarterlySurveyGate}");
    // The organization-role check comes first
    // (REQ-UG-ROLE-WORKSPACE-REFUSALS-20261030); the desk itself is
    // still behind the survey gate.
    expect(app).toContain('views.analytics = organizationWorkspace("analytics", "nav.analytics", () => quarterlySurveyGate(<AnalyticsCoreView');
    expect(app).toContain("sessionKey={session?.user?.id ?? null}");
    expect(app).toMatch(/navigate\("voice", surveyId \? `\/m\/voice\?survey=\$\{encodeURIComponent\(surveyId\)\}`/);
  });

  it("gates the native reports, workload and analytics screens", () => {
    const lived = read("apps/mobile/src/features/LiveLivedInScreens.tsx");
    const workload = lived.slice(lived.indexOf("function LiveWorkloadScreen"), lived.indexOf("function LiveRightsScreen"));
    const reports = lived.slice(lived.indexOf("function LiveReportsScreen"), lived.indexOf("const REPORT_CARD_COPY"));
    expect(workload).toContain("<QuarterlySurveyGate>");
    expect(reports).toContain("<QuarterlySurveyGate>");
    expect(read("apps/mobile/src/features/mi1/AnalyticsCoreScreen.tsx")).toContain("<QuarterlySurveyGate>");
    const nativeGate = read("apps/mobile/src/components/QuarterlySurveyGate.tsx");
    expect(nativeGate).toContain("router.push('/feature/voting' as never)");
    // Children render only when the server says the page is open.
    expect(nativeGate).toContain("if (mode !== 'authenticated' || status === 'open') {");
    expect(nativeGate).not.toContain("pointerEvents={locked ? 'none' : 'auto'}");
    expect(nativeGate).toContain("label={t('Try again')}");
  });

  it("registers the switch with the old default and EN + ES copy", () => {
    const migration = read("supabase/migrations/20261002100000_quarterly_survey_gate_enforced.sql");
    expect(migration).toMatch(/\('features\.engagement_voice\.quarterly_survey_gate', 'boolean'[\s\S]*?'true', null, null, null, \d+, 'engagement_voice', true\)\non conflict \(key\) do nothing;/);
    expect(migration).toContain("private.organization_feature_enabled(org, 'features.engagement_voice.quarterly_survey_gate')");
    expect(migration).toContain("private.has_organization_role(org, array['admin'])");
    for (const lang of ["en", "es"]) {
      for (const key of ["quarterlyGate.title", "quarterlyGate.titleNoQuarter", "quarterlyGate.body", "quarterlyGate.cta",
        "quarterlyGate.checking", "quarterlyGate.errorTitle", "quarterlyGate.errorBody", "quarterlyGate.retry",
        "settings.def.features.engagement_voice.quarterly_survey_gate.label",
        "settings.def.features.engagement_voice.quarterly_survey_gate.description"]) {
        expect(catalogue[lang][key], `${lang} ${key}`).toBeTruthy();
      }
    }
  });

  it("enforces the same gate on the member report reads on the server", () => {
    const migration = read("supabase/migrations/20261002135600_restore_review_hotfixes.sql");
    for (const reader of ["public.get_workload_stats()", "public.get_chapter_standing()", "public.get_my_analytics_report_card()"]) {
      const body = migration.slice(migration.indexOf(`create or replace function ${reader}`));
      expect(body.slice(0, body.indexOf("\n$"))).toContain("if private.quarterly_survey_gate_locks_caller() then");
    }
    expect(migration).toContain("return private.quarterly_survey_gate_state(org);");
  });
});
