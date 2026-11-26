// UX-UG-COORDINATOR-NEXT-ACTIONS-SPAN-THE-ORGANIZATION-WHILE-THE-QUEUE-SHOWS-ONE-CHAPTER-20261124
// (#9794): under an organization-level coordinator grant the server reads the
// Coordinator's next actions across every chapter, while the Case queue,
// deadlines and funnel on the same page read the open chapter. The demo's
// "What to do next" listed three other chapters' Step 2 cases beside a funnel
// with no Step 2, and "Open issue" on one of them did nothing. The panel now
// says what it covers, and an item outside the loaded queue says why it does
// not open.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NextActionsPanel } from "../src/features/caseSignals/CaseSignals.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

const SCOPE_EN = "This role covers the whole organization, so this list looks for next actions across all campaigns. The Active issues, Upcoming deadlines and Escalation funnel pages show the open campaign, and any issue from another campaign this role was granted.";
const SCOPE_ES = "Este rol abarca toda la organización, así que esta lista busca próximas acciones en todos las campañas. Las páginas Asuntos activos, Próximos plazos y Embudo de escalamiento muestran la campaña abierto y cualquier asunto de otra campaña que se haya concedido a este rol.";
const OUTSIDE_EN = "That issue is not in the issue queue loaded for the open campaign. It may belong to another campaign of the organization, or come after the issues loaded here.";

const desk = () => JSON.parse(JSON.stringify(fallbackData.coordinatorDesk));
const inQueue = desk().cases.find((item) => item.status === "active");

function signals(items) {
  const client = { rpc: vi.fn(async (name) => (name === "get_case_queue_next_actions"
    ? { data: { enabled: true, items, summary: { total: items.length, urgent: 0, missingOwner: 0 } }, error: null }
    : { data: null, error: null })) };
  return { client, scopeKey: "coordinator-test" };
}

const otherChapterItem = { id: "deadline_risk:other-1", kind: "deadline_risk", severity: "medium", caseId: "case-in-another-chapter", reference: "GR-2026-30993", step: "Step 2", memberId: "m-other", memberName: "Aisha Alvarado", dueDate: "2026-12-10", days: 16 };
const ownItem = { id: "deadline_risk:own", kind: "deadline_risk", severity: "medium", caseId: inQueue.id, reference: inQueue.reference, step: inQueue.step, memberId: "m-own", memberName: inQueue.memberName, dueDate: "2026-12-11", days: 17 };

function renderCoordinator({ organizationRoles = [], items = [otherChapterItem, ownItem], onNotice = vi.fn(), lang = "en" } = {}) {
  const api = { loadDesk: vi.fn().mockResolvedValue(desk()), loadCases: vi.fn(async () => ({ cases: [], nextCursor: null })) };
  const { container } = render(
    <LanguageProvider lang={lang}>
      <CoordinatorView data={{ member: { initials: "TH", organizationRoles } }} api={api} onNotice={onNotice} caseSignals={signals(items)} />
    </LanguageProvider>,
  );
  return { onNotice, container };
}

describe("What to do next says what it covers (#9794)", () => {
  it("names the organization-wide scope in English and Spanish when asked to", async () => {
    const { unmount } = render(<LanguageProvider lang="en"><NextActionsPanel caseSignals={signals([])} hat="coordinator" scope="organization" /></LanguageProvider>);
    expect(await screen.findByTestId("next-actions-scope")).toHaveTextContent(SCOPE_EN);
    unmount();
    render(<LanguageProvider lang="es"><NextActionsPanel caseSignals={signals([])} hat="coordinator" scope="organization" /></LanguageProvider>);
    expect(await screen.findByTestId("next-actions-scope")).toHaveTextContent(SCOPE_ES);
  });

  it("says nothing about scope by default", async () => {
    render(<LanguageProvider lang="en"><NextActionsPanel caseSignals={signals([])} hat="coordinator" /></LanguageProvider>);
    expect(await screen.findByText("Nothing needs action right now.")).toBeInTheDocument();
    expect(screen.queryByTestId("next-actions-scope")).not.toBeInTheDocument();
  });

  it("shows the line on the Issue queue page for a Campaign lead with an organization-level grant", async () => {
    renderCoordinator({ organizationRoles: ["coordinator"] });
    expect(await screen.findByTestId("next-actions-scope")).toHaveTextContent(SCOPE_EN);
  });

});

describe("opening a next action outside the loaded queue (#9794)", () => {
  it("tells the Campaign lead why instead of doing nothing", async () => {
    const { onNotice } = renderCoordinator({ organizationRoles: ["coordinator"] });
    const panel = await screen.findByTestId("next-actions-panel");
    fireEvent.click(await within(panel).findByRole("button", { name: "Open issue GR-2026-30993" }));
    expect(onNotice).toHaveBeenCalledWith(OUTSIDE_EN);
  });

  it("still opens a issue that is in the queue, with no notice", async () => {
    const { onNotice, container } = renderCoordinator({ organizationRoles: ["coordinator"] });
    const panel = await screen.findByTestId("next-actions-panel");
    const queueRow = () => [...container.querySelectorAll(".gq-row__btn")].find((row) => row.textContent.includes(inQueue.memberName));
    await waitFor(() => expect(queueRow()).toHaveAttribute("aria-expanded", "false"));
    fireEvent.click(await within(panel).findByRole("button", { name: `Open issue ${inQueue.reference}` }));
    await waitFor(() => expect(queueRow()).toHaveAttribute("aria-expanded", "true"));
    expect(onNotice).not.toHaveBeenCalled();
  });
});

// Gate read of #9815: the panel renders only on the Case queue
// overview (/m/coordinator); Active issues, Upcoming deadlines and Escalation
// funnel are other pages of the same desk. The sentence names them as pages
// and is shown on the overview only.
describe("the scope sentence on the Campaign lead's pages (#9794)", () => {
  function renderAt(path) {
    window.history.replaceState({}, "", path);
    const api = { loadDesk: vi.fn().mockResolvedValue(desk()), loadCases: vi.fn(async () => ({ cases: [], nextCursor: null })) };
    return render(
      <LanguageProvider lang="en">
        <WorkspacePages view="coordinator" hat="coordinator" location={window.location.href} navigate={() => {}}>
          <CoordinatorView data={{ member: { initials: "TH", organizationRoles: ["coordinator"] } }} api={api} onNotice={vi.fn()} caseSignals={signals([otherChapterItem])} />
        </WorkspacePages>
      </LanguageProvider>,
    );
  }

  it("shows the sentence on the overview, /m/coordinator", async () => {
    renderAt("/m/coordinator");
    expect(await screen.findByTestId("next-actions-scope")).toHaveTextContent(SCOPE_EN);
    window.history.replaceState({}, "", "/m");
  });

  it.each([
    ["/m/coordinator/cases", "#coordinator-cases"],
    ["/m/coordinator/deadlines", "#coordinator-deadlines"],
  ])("leaves it out on %s", async (path, section) => {
    const { container } = renderAt(path);
    // The page's own section is on screen, so the absence below is not an empty render.
    await waitFor(() => expect(container.querySelector(section)).not.toBeNull());
    expect(screen.queryByTestId("next-actions-panel")).toBeNull();
    expect(screen.queryByTestId("next-actions-scope")).toBeNull();
    window.history.replaceState({}, "", "/m");
  });
});

// PERF-UG-DEMO-ROLE-SWITCH-STAFF-DESK-READS-START-LATE-20261124 (#9840):
// next actions waited for the whole desk (case list, its enrichment and the
// KPIs) before the panel mounted and read; on the hosted demo that put
// get_case_queue_next_actions 12 s after the role switch. They now read beside
// the desk and show in place while the queue loads.
describe("next actions beside the loading queue (#9840)", () => {

  it("takes a read the shell already started instead of reading again", async () => {
    const source = signals([ownItem]);
    const started = Promise.resolve({ enabled: true, items: [], summary: { total: 0, urgent: 0, missingOwner: 0 } });
    const takeNextActions = vi.fn((hat, read) => (hat === "coordinator" && takeNextActions.mock.calls.length === 1 ? started : read()));
    render(<LanguageProvider lang="en"><NextActionsPanel caseSignals={{ ...source, takeNextActions }} hat="coordinator" /></LanguageProvider>);
    expect(await screen.findByText("Nothing needs action right now.")).toBeInTheDocument();
    expect(takeNextActions).toHaveBeenCalledWith("coordinator", expect.any(Function));
    expect(source.client.rpc).not.toHaveBeenCalled();
  });

  //  on #9840: a started read that failed is not the panel's answer.
});
