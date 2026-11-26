import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseworkHubPanel } from "../src/components/CaseworkHubPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const rows = [
  { id: "case-1", reference: "GRV-1", title: "Schedule case", status: "active", case_type: "Scheduling", step: "Intake", is_restricted: false, member: { full_name: "Member Active" } },
  { id: "case-2", reference: "GRV-2", title: "Safety case", status: "resolved", case_type: "Safety", step: "Closed", is_restricted: false, member: { full_name: "Member Resolved" } },
  { id: "case-3", reference: "GRV-3", title: "Private case", status: "active", case_type: "Discipline", step: "Intake", is_restricted: true, member: { full_name: "Member Restricted" } },
  { id: "case-4", reference: "GRV-4", title: "Legacy case", status: "escalated_legacy", case_type: "Pay", step: "Intake", is_restricted: false, member: { full_name: "Member Unknown" } },
];

function chipFor(name) {
  return screen.getByText(name).closest(".cwk-row").querySelector(".cwk-chip");
}

describe("casework hub history status chip", () => {
  for (const [lang, heading, expected] of [
    ["en", "Advanced issue operations", { active: "Active", resolved: "Resolved", restricted: "Restricted", unknown: "Status unavailable" }],
    ["es", "Operaciones avanzadas de asuntos", { active: "Activo", resolved: "Resuelto", restricted: "Restringido", unknown: "Estado no disponible" }],
  ]) {
    it(`shows a singular localized status label, never the raw token (${lang})`, async () => {
      const api = {
        loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [], drafts: [], patterns: [] }),
        loadCaseworkHistory: vi.fn().mockResolvedValue({ rows, total: rows.length, page: 0, pageSize: 50 }),
        bulkUpdateCases: vi.fn(),
      };
      render(<LanguageProvider lang={lang}><CaseworkHubPanel chapterId="ch-1" caseOptions={[]} api={api} /></LanguageProvider>);
      expect(await screen.findByText("Member Active")).toBeInTheDocument();
      expect(chipFor("Member Active")).toHaveTextContent(new RegExp(`^${expected.active}$`));
      expect(chipFor("Member Resolved")).toHaveTextContent(new RegExp(`^${expected.resolved}$`));
      expect(chipFor("Member Restricted")).toHaveTextContent(new RegExp(`^${expected.restricted}$`));
      expect(chipFor("Member Unknown")).toHaveTextContent(new RegExp(`^${expected.unknown}$`));
      const history = screen.getByRole("heading", { name: heading }).closest("article");
      expect(within(history).queryByText(/^(active|resolved|escalated_legacy)$/)).toBeNull();
    });
  }
});

// BUG-UG-WEB-CASEWORK-HUB-RENDERS-EVERY-FORM-OPEN-20261002: the hub
// drew every bargaining workspace with every form open (about 95,000px on
// desktop with 50 workspaces), and the intake and case-search tools sat below
// all of it. Tables are now compact rows that open one at a time, ten to a
// page, under a tool index; typing survives collapsing and paging.
const fiftyWorkspaces = Array.from({ length: 50 }, (_, index) => ({
  id: `ws-${index + 1}`, title: `Table ${String(index + 1).padStart(2, "0")}`, status: index === 0 ? "live" : "planning", starts_at: null,
  proposals: [{ id: `p-${index + 1}`, side: "union", title: `Proposal ${index + 1}`, body: "Initial language for the table.", status: "proposed", response_due_at: new Date(Date.now() - 3600000).toISOString() }],
  events: [],
}));

function hubApi(overrides = {}) {
  return {
    loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: fiftyWorkspaces, drafts: [], patterns: [] }),
    loadCaseworkHistory: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 0, pageSize: 50 }),
    setBargainingStatus: vi.fn().mockResolvedValue({}), transitionBargainingProposal: vi.fn().mockResolvedValue({}),
    addBargainingProposal: vi.fn().mockResolvedValue({}), addBargainingEvent: vi.fn().mockResolvedValue({}),
    createBargainingWorkspace: vi.fn().mockResolvedValue({}), saveIntakeDraft: vi.fn().mockResolvedValue({ id: "d", revision: 1, updated_at: new Date().toISOString() }),
    bulkUpdateCases: vi.fn(),
    ...overrides,
  };
}

async function renderHub(api = hubApi(), lang = "en") {
  const view = render(<LanguageProvider lang={lang}><CaseworkHubPanel chapterId="ch-1" caseOptions={[]} api={api} /></LanguageProvider>);
  await screen.findByRole("heading", { name: lang === "es" ? "Negociación" : "Bargaining" });
  return { api, view, bargaining: screen.getByRole("heading", { name: lang === "es" ? "Negociación" : "Bargaining" }).closest("article") };
}

const workspaceSection = (title) => screen.getByText(title).closest("section");
const toggleFor = (title) => within(workspaceSection(title)).getByRole("button", { name: /workspace$/ });
const shownTitles = (bargaining) => [...bargaining.querySelectorAll("section.cwk-hub-workspace strong[id]")].map((node) => node.textContent);

describe("casework hub with many bargaining workspaces", () => {
  it("renders a bounded page of compact rows with at most one workspace's forms open", async () => {
    const { bargaining } = await renderHub();
    expect(shownTitles(bargaining)).toHaveLength(10);
    expect(within(bargaining).getByText("Showing 1–10 of 50 workspaces")).toBeInTheDocument();
    expect(within(bargaining).queryAllByLabelText("Session status")).toHaveLength(0);
    expect(within(workspaceSection("Table 01")).getByText("1 proposal · 1 overdue")).toBeInTheDocument();
    fireEvent.click(toggleFor("Table 03"));
    expect(toggleFor("Table 03")).toHaveAttribute("aria-expanded", "true");
    expect(within(bargaining).getAllByLabelText("Session status")).toHaveLength(1);
    expect(within(workspaceSection("Table 03")).getByLabelText("Session status")).toBeInTheDocument();
    fireEvent.click(toggleFor("Table 05"));
    expect(within(bargaining).getAllByLabelText("Session status")).toHaveLength(1);
    expect(within(workspaceSection("Table 05")).getByLabelText("Session status")).toBeInTheDocument();
    expect(toggleFor("Table 03")).toHaveAttribute("aria-expanded", "false");
    expect(within(bargaining).getAllByRole("heading", { name: "New proposal" })).toHaveLength(1);
  });

  it("indexes every tool before the first workspace and moves focus to the one chosen", async () => {
    await renderHub();
    const index = screen.getByRole("navigation", { name: "Jump to a tool" });
    const links = within(index).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Bargaining", "Intake draft autosave", "Advanced issue operations"]);
    const firstWorkspace = workspaceSection("Table 01");
    for (const link of links) expect(link.compareDocumentPosition(firstWorkspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(index).getByRole("link", { name: "Intake draft autosave" }));
    expect(screen.getByRole("heading", { name: "Intake draft autosave" }).closest("article")).toHaveFocus();
    fireEvent.click(within(index).getByRole("link", { name: "Advanced issue operations" }));
    expect(screen.getByRole("heading", { name: "Advanced issue operations" }).closest("article")).toHaveFocus();
  });

  it("reaches every workspace through the pager and puts focus on the new page's range", async () => {
    const { bargaining } = await renderHub();
    const seen = new Set(shownTitles(bargaining));
    const previous = within(bargaining).getByRole("button", { name: "Previous" });
    expect(previous).toBeDisabled();
    for (let page = 2; page <= 5; page += 1) {
      fireEvent.click(within(bargaining).getByRole("button", { name: "Next" }));
      const range = within(bargaining).getByText(`Showing ${(page - 1) * 10 + 1}–${page * 10} of 50 workspaces`).closest("p");
      await waitFor(() => expect(range).toHaveFocus());
      for (const title of shownTitles(bargaining)) seen.add(title);
    }
    expect(seen.size).toBe(50);
    expect(within(bargaining).getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(within(bargaining).getByRole("button", { name: "Previous" }));
    expect(within(bargaining).getByText("Showing 31–40 of 50 workspaces")).toBeInTheDocument();
  });

  it("keeps unsaved typing through collapse, another workspace and paging, and drops it after a save", async () => {
    const { api, bargaining } = await renderHub();
    fireEvent.click(toggleFor("Table 02"));
    const section = () => workspaceSection("Table 02");
    fireEvent.change(within(section()).getByLabelText("Proposal title"), { target: { value: "Article 9 overtime" } });
    fireEvent.change(within(section()).getByLabelText("Live timeline update"), { target: { value: "Caucus ran long" } });
    fireEvent.change(within(section()).getAllByLabelText("Proposal status")[0], { target: { value: "countered" } });

    fireEvent.click(toggleFor("Table 02"));
    expect(within(section()).queryByLabelText("Proposal title")).toBeNull();
    fireEvent.click(toggleFor("Table 04"));
    fireEvent.click(within(bargaining).getByRole("button", { name: "Next" }));
    fireEvent.click(within(bargaining).getByRole("button", { name: "Previous" }));
    fireEvent.click(toggleFor("Table 02"));
    expect(within(section()).getByLabelText("Proposal title")).toHaveValue("Article 9 overtime");
    expect(within(section()).getByLabelText("Live timeline update")).toHaveValue("Caucus ran long");
    expect(within(section()).getAllByLabelText("Proposal status")[0]).toHaveValue("countered");

    fireEvent.change(within(section()).getByLabelText("Team pulse"), { target: { value: "watch" } });
    fireEvent.click(within(section()).getByRole("button", { name: "Add update" }));
    await waitFor(() => expect(api.addBargainingEvent).toHaveBeenCalledWith("ws-2", "pulse", "Caucus ran long", "watch"));
    await waitFor(() => expect(api.loadCaseworkHub).toHaveBeenCalledTimes(2));
    fireEvent.click(toggleFor("Table 02"));
    fireEvent.click(toggleFor("Table 02"));
    expect(within(section()).getByLabelText("Live timeline update")).toHaveValue("");
    // The proposal draft was not saved, so it is still there.
    expect(within(section()).getByLabelText("Proposal title")).toHaveValue("Article 9 overtime");
  });

  it("keeps the typing when the save is refused", async () => {
    const api = hubApi({ addBargainingEvent: vi.fn().mockRejectedValue(new Error("offline")) });
    await renderHub(api);
    fireEvent.click(toggleFor("Table 06"));
    const section = () => workspaceSection("Table 06");
    fireEvent.change(within(section()).getByLabelText("Live timeline update"), { target: { value: "Management walked out" } });
    fireEvent.click(within(section()).getByRole("button", { name: "Add update" }));
    await waitFor(() => expect(api.addBargainingEvent).toHaveBeenCalled());
    fireEvent.click(toggleFor("Table 06"));
    fireEvent.click(toggleFor("Table 06"));
    expect(within(section()).getByLabelText("Live timeline update")).toHaveValue("Management walked out");
  });

  it("keeps a chapter's only workspace open with no toggle", async () => {
    await renderHub(hubApi({ loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [fiftyWorkspaces[0]], drafts: [], patterns: [] }) }));
    expect(within(workspaceSection("Table 01")).getByLabelText("Session status")).toBeInTheDocument();
    expect(within(workspaceSection("Table 01")).queryByRole("button", { name: /workspace$/ })).toBeNull();
    expect(screen.queryByText(/^Showing .* workspaces$/)).toBeNull();
  });

  it("pins 48px targets for the index, the row toggles and the pager", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/caseworkHubPanel.css"), "utf8").replace(/\s+/g, " ");
    expect(css).toContain(".cwk-hub-tools .cwk-btn, .cwk-hub-toggle, .cwk-hub-pager .cwk-btn { min-height: 48px; }");
  });
});

// BUG-UG-WEB-CASEWORK-HUB-TIMELINE-RAW-EVENT-TYPES-20261002, a
// recurrence of UX-UG-CASEWORK-PANEL-CHIPS-EXPOSE-RAW-ENUMS-20260920: a
// timeline update with no pulse printed its stored event_type (shown in caps
// as SESSION_STATUS). Chips now carry a localized label, with the stored code
// kept in the chip's title for operators.
describe("casework hub timeline chips", () => {
  const events = [
    { id: "e-1", event_type: "session_status", pulse: null, body: "planning → live", created_at: "2026-08-28T15:00:00Z" },
    { id: "e-2", event_type: "proposal_status", pulse: null, body: "Proposal created as draft", created_at: "2026-08-28T15:05:00Z" },
    { id: "e-3", event_type: "pulse", pulse: "urgent", body: "Caucus complete", created_at: "2026-08-28T15:10:00Z" },
    { id: "e-4", event_type: "retired_kind", pulse: null, body: "Older row", created_at: "2026-08-28T15:15:00Z" },
  ];
  const workspace = { id: "ws-1", title: "2027 bargaining", status: "live", starts_at: null, proposals: [], events };
  for (const [lang, labels] of [
    ["en", ["Session change", "Proposal change", "Urgent", "Update"]],
    ["es", ["Cambio de sesión", "Cambio de propuesta", "Urgente", "Actualización"]],
  ]) {
    it(`labels each event in ${lang} and never prints the stored token`, async () => {
      const api = { loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [workspace], drafts: [], patterns: [] }) };
      render(<LanguageProvider lang={lang}><CaseworkHubPanel chapterId="ch-1" caseOptions={[]} api={api} /></LanguageProvider>);
      const chips = await waitFor(() => {
        const found = events.map((event) => screen.getByText(event.body).closest("p").querySelector(".cwk-chip"));
        return found;
      });
      expect(chips.map((chip) => chip.textContent)).toEqual(labels);
      expect(chips.map((chip) => chip.getAttribute("title"))).toEqual(["session_status", "proposal_status", "pulse · urgent", "retired_kind"]);
      for (const [index, chip] of chips.entries()) {
        const event = events[index];
        expect(chip.textContent).not.toBe(event.pulse || event.event_type);
        expect(chip.textContent).not.toMatch(/session_status|proposal_status|retired_kind|session status|proposal status|retired kind/i);
      }
    });
  }
});

// Union Ground issues have no grievance procedure and no legal filing
// deadline (owner decision, 2026-10-13): even when the api still carries the
// step checklist-template writer and the retaliation timing scan, the hub
// offers neither, and the case history has no step filter.
describe("casework hub offers no removed procedure or filing-deadline tools", () => {
  it("shows no checklist templates, no timing scan and no step filter", async () => {
    const api = hubApi({
      loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [], drafts: [], patterns: [], templates: [{ id: "t-1", title: "Intake checklist", case_type: "Pay", step: "Step 1", items: [{ label: "Collect pay stubs" }] }] }),
      loadCaseworkHistory: vi.fn().mockResolvedValue({ rows, total: rows.length, page: 0, pageSize: 50 }),
      createChecklistTemplate: vi.fn().mockResolvedValue({}),
      scanRetaliationTiming: vi.fn().mockResolvedValue(0),
      scanRetaliationPatterns: vi.fn().mockResolvedValue({}),
      reviewRetaliationPattern: vi.fn().mockResolvedValue({}),
    });
    const { view } = await renderHub(api);
    expect(await screen.findByText("Member Active")).toBeInTheDocument();

    // The kept tools are still indexed and drawn.
    const tools = screen.getByRole("navigation", { name: "Jump to a tool" });
    expect(within(tools).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "#casework-hub-bargaining", "#casework-hub-intake", "#casework-hub-patterns", "#casework-hub-history",
    ]);
    expect(screen.getByRole("heading", { name: "Retaliation pattern review" })).toBeInTheDocument();

    expect(view.container.querySelector("#casework-hub-templates")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Checklist templates" })).toBeNull();
    expect(screen.queryByText("Intake checklist")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create template" })).toBeNull();
    expect(screen.queryAllByRole("button").filter((button) => /timing/i.test(button.textContent))).toEqual([]);
    expect(screen.queryByRole("heading", { name: /timing/i })).toBeNull();
    expect(api.createChecklistTemplate).not.toHaveBeenCalled();
    expect(api.scanRetaliationTiming).not.toHaveBeenCalled();

    const history = screen.getByRole("heading", { name: "Advanced issue operations" }).closest("article");
    expect(within(history).queryByLabelText(/Step/)).toBeNull();
    expect(history.querySelector("[name='step']")).toBeNull();
  });
});
