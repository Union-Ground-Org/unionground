import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseList, caseListSearch, readCaseListUrl } from "../src/components/CaseList.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const rows = [
  { id: "case-a", memberName: "Ada Stone", memberInitials: "AS", reference: "C-10", title: "Leave denial", caseType: "Grievance", step: "Step 2", status: "active", deadline: "2026-09-18", deadlineLabel: "Sep 18", stewardName: "Sam Okafor", chapterId: "chapter-a" },
  { id: "case-b", memberName: "Bea Wood", memberInitials: "BW", reference: "C-11", title: "Pay issue", caseType: "Contract", step: "Step 1", status: "resolved", deadline: "", deadlineLabel: "", coordinatorName: "Jordan Park", chapterId: "chapter-b" },
];

// Union Ground issues have no grievance procedure (owner decision,
// 2026-10-13): the rows may still carry a stored step, and the list offers no
// step facet, column, sort or filter for it.
const noStepFacet = () => {
  expect(document.getElementById("case-list-facet-step")).toBeNull();
  expect(document.querySelector(".gq-step")).toBeNull();
};

function renderList(props = {}) {
  return render(<LanguageProvider lang="en"><CaseList plane="coordinator" rows={rows} onOpenCase={vi.fn()} {...props} /></LanguageProvider>);
}

afterEach(() => window.history.replaceState({}, "", "/m/coordinator"));

describe("case-list URL state", () => {
  it("round-trips facet filters, sorting, and a deep-linkable saved view", () => {
    const state = {
      filters: { caseType: "Grievance", assignee: "", deadline: "7d", status: "active", chapter: "chapter-a" },
      sorting: [{ id: "member", desc: true }], viewId: "view-1",
    };
    const search = caseListSearch(state);
    expect(readCaseListUrl(`?${search}`)).toEqual(state);
  });

  it("reads no step filter or step sort from a link or a saved definition", () => {
    const read = readCaseListUrl("?step=Step%202&caseSort=step:desc");
    expect(read.filters).not.toHaveProperty("step");
    expect(read.sorting).toEqual([{ id: "deadline", desc: false }]);
    const written = new URLSearchParams(caseListSearch({
      filters: { step: "Step 2", status: "active" }, sorting: [{ id: "step", desc: true }], viewId: "",
    }, ""));
    expect(written.get("step")).toBeNull();
    expect(written.get("caseSort")).toBeNull();
    expect(written.get("status")).toBe("active");
  });

  it("lands a dashboards-lane deep link written with the flat facet names", () => {
    // Lane 5.4 links straight to ?deadline=overdue|7d and ?assignee=; the list
    // must read those names as-is and paint only the matching rows, while an
    // unrelated ?case= deep link survives the facet write-back.
    window.history.replaceState({}, "", "/m/coordinator?case=case-a&deadline=overdue&assignee=Sam%20Okafor");
    const rendered = renderList({ rows: [{ ...rows[0], deadline: "2000-01-01" }, rows[1]] });
    noStepFacet();
    expect(screen.getByLabelText("Deadline window")).toHaveValue("overdue");
    expect(screen.getByLabelText("Assignee")).toHaveValue("Sam Okafor");
    expect(screen.getByRole("button", { name: /Ada Stone/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bea Wood/ })).toBeNull();
    // Clearing the facets rewrites the URL without dropping the unrelated
    // ?case= parameter, and the hidden row comes back.
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("deadline")).toBeNull();
    expect(params.get("assignee")).toBeNull();
    expect(params.get("case")).toBe("case-a");
    expect(screen.getByRole("button", { name: /Bea Wood/ })).toBeInTheDocument();
    expect(readCaseListUrl("?deadline=7days").filters.deadline).toBe("7d");
    rendered.unmount();
  });

  it("ignores a step deep link instead of filtering by it", () => {
    window.history.replaceState({}, "", "/m/coordinator?step=Step%202");
    const rendered = renderList();
    noStepFacet();
    expect(screen.getByRole("button", { name: /Ada Stone/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bea Wood/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 issues shown");
    rendered.unmount();
  });

  it("writes filter and column-sort changes into the current URL", async () => {
    const rendered = renderList();
    fireEvent.change(screen.getByLabelText("Issue type"), { target: { value: "Grievance" } });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("caseType")).toBe("Grievance"));
    // The header offers no step column to sort by, and the row paints no step.
    const headers = [...rendered.container.querySelectorAll("thead th")].map((cell) => cell.textContent);
    for (const header of headers) expect(header).not.toMatch(/step/i);
    expect(rendered.container.querySelector("tbody").textContent).not.toMatch(/Step 2/);
    fireEvent.click(screen.getByRole("button", { name: /Worker/ }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("caseSort")).toBe("member:asc"));
  });
});

describe("case-list rendering", () => {
  it.each(["default", "empty", "error"])("exposes the saved-view %s outcome only after the deferred read settles", async (outcome) => {
    let resolve, reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const api = { listSavedViews: vi.fn(() => pending), saveSavedView: vi.fn(), deleteSavedView: vi.fn() };
    const rendered = renderList({ savedViewsApi: api });
    const views = rendered.container.querySelector('.case-list__views');
    expect(views).toHaveAttribute('data-load-state', 'loading');
    expect(views).not.toHaveAttribute('aria-busy');
    if (outcome === 'error') reject(new Error('read failed'));
    else resolve(outcome === 'empty' ? [] : [{ id: 'default', name: 'Active', isDefault: true, definition: { filters: { ...readCaseListUrl('').filters, status: 'active' }, sorting: [] } }]);
    await waitFor(() => expect(views).toHaveAttribute('data-load-state', outcome === 'error' ? 'error' : 'ready'));
    expect(views).not.toHaveAttribute('aria-busy');
    if (outcome === 'default') {
      expect(screen.getByLabelText('Saved views')).toHaveValue('default');
      expect(screen.queryByRole('button', { name: /Bea Wood/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(screen.getByLabelText('Saved views')).toHaveValue('');
      expect(screen.getByRole('button', { name: /Bea Wood/ })).toBeInTheDocument();
    }
    rendered.unmount();
  });

  it.each(["coordinator", "steward"])("renders a keyboard-operable %s case list", (plane) => {
    const onOpenCase = vi.fn();
    render(<LanguageProvider lang="es"><CaseList plane={plane} rows={rows} onOpenCase={onOpenCase} /></LanguageProvider>);
    const first = screen.getByRole("button", { name: /Ada Stone/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = screen.getByRole("button", { name: /Bea Wood/ });
    expect(second).toHaveFocus();
    // Enter/Space activation is native button behavior once focus lands; the
    // list itself owns the arrow/Home/End roving above.
    fireEvent.click(second);
    expect(onOpenCase).toHaveBeenCalledWith(rows[1], false);
  });

  it("applies the definition of a view deep-linked by id", async () => {
    const api = {
      listSavedViews: vi.fn().mockResolvedValue([{ id: "view-9", name: "Open only", isDefault: false, definition: { filters: { ...readCaseListUrl("").filters, status: "active" }, sorting: [{ id: "member", desc: false }] } }]),
      saveSavedView: vi.fn(), deleteSavedView: vi.fn(),
    };
    window.history.replaceState({}, "", "/m/coordinator?caseView=view-9");
    renderList({ savedViewsApi: api });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("status")).toBe("active"));
    expect(screen.queryByRole("button", { name: /Bea Wood/ })).toBeNull();
    window.history.replaceState({}, "", "/m/coordinator");
  });

  it("loads and applies a saved view through the private API adapter", async () => {
    const api = {
      listSavedViews: vi.fn().mockResolvedValue([{ id: "view-1", name: "Urgent", isDefault: false, definition: { filters: { ...readCaseListUrl("").filters, status: "active" }, sorting: [{ id: "member", desc: false }] } }]),
      saveSavedView: vi.fn(), deleteSavedView: vi.fn(),
    };
    renderList({ savedViewsApi: api });
    const select = await screen.findByRole("combobox", { name: "Saved views" });
    fireEvent.change(select, { target: { value: "view-1" } });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("caseView")).toBe("view-1"));
    expect(screen.queryByRole("button", { name: /Bea Wood/ })).toBeNull();
  });
});

describe("case-list row identity", () => {
  it("paints the initials avatar and the urgency reason the plane computes", () => {
    const rendered = renderList({ urgencyOf: (row) => (row.id === "case-a" ? { tone: "danger", label: "Overdue" } : null) });
    // The stylesheet draws the initials from data-initials (.case-list__av::before).
    expect(rendered.container.querySelector(".case-list__av")).toHaveAttribute("data-initials", "AS");
    expect(rendered.container.querySelectorAll(".case-list__av")).toHaveLength(2);
    const chips = rendered.container.querySelectorAll(".gq-reason");
    expect(chips).toHaveLength(1);
    expect(chips[0].className).toContain("gq-reason--danger");
    expect(chips[0].textContent).toBe("Overdue");
    rendered.unmount();
  });
});

describe("case-list assignee facet", () => {
  // Lane 5.4 deep-links ?assignee=<id>. Keying on the display name collapses
  // two people who share one, so the facet keys on the id the loader exposes
  // and shows the name.
  it("keys the facet on the assignee user id and labels the option with the name", () => {
    const shared = [
      { ...rows[0], id: "case-c", memberName: "Cy Reed", assigneeId: "user-1", assigneeName: "J. Rivera" },
      { ...rows[1], id: "case-d", memberName: "Dee Lang", status: "active", assigneeId: "user-2", assigneeName: "J. Rivera" },
    ];
    window.history.replaceState({}, "", "/m/coordinator?assignee=user-1");
    const rendered = renderList({ rows: shared });
    const facet = screen.getByLabelText("Assignee");
    expect(facet).toHaveValue("user-1");
    expect([...facet.options].map((option) => `${option.value}=${option.textContent}`)).toEqual([
      "=All", "user-1=J. Rivera (1)", "user-2=J. Rivera (1)",
    ]);
    expect(screen.getByRole("button", { name: /Cy Reed/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dee Lang/ })).toBeNull();
    fireEvent.change(facet, { target: { value: "user-2" } });
    expect(new URLSearchParams(window.location.search).get("assignee")).toBe("user-2");
    rendered.unmount();
  });

  it("falls back to the display name when the loader exposes no id", () => {
    window.history.replaceState({}, "", "/m/coordinator?assignee=Sam%20Okafor");
    const rendered = renderList();
    expect(screen.getByLabelText("Assignee")).toHaveValue("Sam Okafor");
    rendered.unmount();
  });

  // The steward desk's window is exactly the reader's own cases and the only
  // name on the row is the case's COORDINATOR. The facet hides rather than
  // offer a filter named after the wrong person.
  it("hides the facet on a plane whose rows carry no assignee", () => {
    const deskRows = [{ id: "case-s", memberName: "Ada Stone", memberInitials: "AS", reference: "C-20", title: "Leave denial", caseType: "Grievance", step: "Step 1", status: "active", deadline: "", coordinatorName: "Jordan Park", chapterId: "chapter-a" }];
    const rendered = render(<LanguageProvider lang="en"><CaseList plane="steward" rows={deskRows} onOpenCase={vi.fn()} /></LanguageProvider>);
    expect(screen.queryByLabelText("Assignee")).toBeNull();
    expect(screen.queryByText(/Jordan Park/)).toBeNull();
    expect(screen.getByLabelText("Issue type")).toBeInTheDocument();
    noStepFacet();
    rendered.unmount();
  });
});

describe("case-list count honesty", () => {
  // Facets and counts run over the rows the plane has loaded. Lane 5.4 links
  // dashboards straight at these filters, so a windowed count says so.
  it("labels the counts as a loaded window when the plane has not loaded everything", () => {
    const rendered = renderList({ countsWindowed: true });
    expect(screen.getByRole("status")).toHaveTextContent("2 issues shown from the loaded window");
    const note = screen.getByText(/Filter counts describe the 2 issues loaded here/);
    expect(screen.getByRole("group", { name: "Issue list filters" })).toHaveAttribute("aria-describedby", note.id);
    rendered.unmount();
  });

  it("keeps the plain count when the loaded rows are the whole set", () => {
    const rendered = renderList();
    expect(screen.getByRole("status")).toHaveTextContent("2 issues shown");
    expect(screen.queryByText(/Filter counts describe/)).toBeNull();
    rendered.unmount();
  });
});

describe("case-list loaded-window facet count labels", () => {
  const stewardRows = [
    { id: "case-a", memberName: "Ada Stone", memberInitials: "AS", reference: "C-10", title: "Leave denial", caseType: "Grievance", step: "Step 2", status: "active", deadline: "2026-09-18", deadlineLabel: "Sep 18", chapterId: "chapter-a", chapterName: "North warehouse campaign" },
    { id: "case-b", memberName: "Bea Wood", memberInitials: "BW", reference: "C-11", title: "Pay issue", caseType: "Contract", step: "Step 1", status: "resolved", deadline: "", deadlineLabel: "", chapterId: "chapter-b", chapterName: "South warehouse campaign" },
  ];

  function optionLabels(name) {
    return [...screen.getByLabelText(name).options].map((option) => option.textContent);
  }

  function renderPlane(plane, props = {}) {
    const planeRows = plane === "steward" ? stewardRows : rows;
    return render(<LanguageProvider lang="en"><CaseList plane={plane} rows={planeRows} onOpenCase={vi.fn()} {...props} /></LanguageProvider>);
  }

  it.each(["coordinator", "steward"])("qualifies every counted %s facet option and the results line while the plane is windowed", (plane) => {
    const rendered = renderPlane(plane, { countsWindowed: true });
    expect(screen.getByRole("status")).toHaveTextContent("2 issues shown from the loaded window");
    noStepFacet();
    expect(optionLabels("Issue type")).toEqual(["All", "Contract (1 in the loaded window)", "Grievance (1 in the loaded window)"]);
    expect(optionLabels("Status")).toEqual(["All", "active (1 in the loaded window)", "resolved (1 in the loaded window)"]);
    // The qualifier is the option's ACCESSIBLE NAME, not a visual marker: an
    // option inside a native select carries no tooltip and no description, so
    // whatever a screen reader announces is the label itself.
    expect(within(screen.getByLabelText("Issue type")).getByRole("option", { name: "Grievance (1 in the loaded window)" })).toBeInTheDocument();
    expect(screen.getByText(/Filter counts describe the 2 issues loaded here/)).toHaveTextContent(/issue dashboards/);
    // On the gap-2 tree the case dashboards (5.4, #2109) ARE registered: the
    // coordinator's routed tab exists, so its list links there; the steward
    // tiles mount inside this same caseload page and the steward keeps the
    // pending copy until its own binding lands (recorded on the record).
    if (plane === "coordinator") {
      expect(screen.getByRole("link", { name: "Open the issue dashboards" })).toHaveAttribute("href", expect.stringContaining("/m/coordinator/cases/dashboards"));
      expect(screen.queryByText(/not on this build yet/)).toBeNull();
    } else {
      expect(screen.queryByRole("link", { name: "Open the issue dashboards" })).toBeNull();
      expect(screen.getByText(/not on this build yet/)).toBeInTheDocument();
    }
    rendered.unmount();
  });

  it.each(["coordinator", "steward"])("keeps %s facet option labels clean when every row is loaded", (plane) => {
    const rendered = renderPlane(plane);
    expect(screen.getByRole("status")).toHaveTextContent("2 issues shown");
    noStepFacet();
    expect(optionLabels("Issue type")).toEqual(["All", "Contract (1)", "Grievance (1)"]);
    expect(screen.queryByText(/loaded window/)).toBeNull();
    expect(screen.queryByText(/issue dashboards/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Open the issue dashboards" })).toBeNull();
    rendered.unmount();
  });

  it("keeps the window qualifier on the first paint of a facet deep link", () => {
    window.history.replaceState({}, "", "/m/coordinator?caseType=Grievance");
    const rendered = renderList({ countsWindowed: true });
    expect(screen.getByLabelText("Issue type")).toHaveValue("Grievance");
    expect(optionLabels("Issue type")).toEqual(["All", "Contract (1 in the loaded window)", "Grievance (1 in the loaded window)"]);
    expect(optionLabels("Status")).toEqual(["All", "active (1 in the loaded window)"]);
    expect(screen.getByRole("status")).toHaveTextContent("1 issues shown from the loaded window");
    rendered.unmount();
  });

  it("keeps the window qualifier after a saved view reproduces the filters", async () => {
    const api = {
      listSavedViews: vi.fn().mockResolvedValue([{
        id: "view-window",
        name: "Open only",
        isDefault: false,
        definition: { filters: { ...readCaseListUrl("").filters, status: "active" }, sorting: [{ id: "member", desc: false }] },
      }]),
      saveSavedView: vi.fn(),
      deleteSavedView: vi.fn(),
    };
    window.history.replaceState({}, "", "/m/coordinator?caseView=view-window");
    const rendered = renderList({ countsWindowed: true, savedViewsApi: api });
    expect(optionLabels("Issue type")).toEqual(["All", "Contract (1 in the loaded window)", "Grievance (1 in the loaded window)"]);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("status")).toBe("active"));
    expect(screen.getByRole("combobox", { name: "Saved views" })).toHaveAttribute("aria-describedby", "case-list-counts-coordinator");
    expect(optionLabels("Status")).toEqual(["All", "active (1 in the loaded window)", "resolved (1 in the loaded window)"]);
    expect(optionLabels("Issue type")).toEqual(["All", "Grievance (1 in the loaded window)"]);
    expect(screen.getByRole("status")).toHaveTextContent("1 issues shown from the loaded window");
    // The caveat and the coordinator's link both name the dashboards.
    expect(screen.getAllByText(/issue dashboards/).length).toBeGreaterThan(0);
    rendered.unmount();
  });

  it("qualifies windowed option labels in Spanish", () => {
    const rendered = render(<LanguageProvider lang="es"><CaseList plane="coordinator" rows={rows} onOpenCase={vi.fn()} countsWindowed /></LanguageProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("2 asuntos mostrados de la ventana cargada");
    expect(optionLabels("Tipo de asunto")).toEqual(["Todos", "Contract (1 en la ventana cargada)", "Grievance (1 en la ventana cargada)"]);
    noStepFacet();
    expect(screen.getAllByText(/paneles de asuntos/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Abrir los paneles de asuntos" })).toBeInTheDocument();
    rendered.unmount();
  });
});
