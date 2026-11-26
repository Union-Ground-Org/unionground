import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { NumbersView } from "../src/views/NumbersView.jsx";
import { WORKLOAD_CATEGORY_KEYS } from "../src/lib/workloadCategories.js";

const DATA = {
  member: { initials: "DF" },
  metrics: {
    casesHandled: 4,
    tasksDone: 3,
    openCases: 1,
    resolvedCases: 3,
    caseTypes: [{ label: "Discipline", value: 2 }, { label: "Pay", value: 1 }],
    weeks: [0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1],
  },
};

function renderNumbers() {
  render(<LanguageProvider lang="en"><NumbersView data={DATA} /></LanguageProvider>);
}

function renderEditable(props = {}) {
  const data = { ...DATA, reportPreferences: { order: ["actions", "cases"], hidden: [], custom: [] } };
  render(<LanguageProvider lang="en"><NumbersView data={data} {...props} /></LanguageProvider>);
}

describe("numbers view", () => {
  it.each([1, 2])("localizes the Spanish case breakdown and %s open cases", (openCases) => {
    const types = ["Discipline", "Scheduling", "Telework", "Safety", "Pay", "Other", "Tamarack custom"];
    render(<LanguageProvider lang="es"><NumbersView data={{ ...DATA, metrics: { ...DATA.metrics, openCases, caseTypes: types.map(label => ({ label, value: 1 })) } }} /></LanguageProvider>);
    expect(screen.getByText(`${openCases} ${openCases === 1 ? "abierto" : "abiertos"}`)).toBeInTheDocument();
    ["Disciplina", "Horarios", "Teletrabajo", "Seguridad", "Salario", "Otro", "Tamarack custom"].forEach(label => expect(screen.getByText(label)).toBeInTheDocument());
  });
  const workloadCounts = value => Object.fromEntries(WORKLOAD_CATEGORY_KEYS.map(key => [key, value]));
  it.each([null, undefined, '7', NaN, Infinity])("omits workload reports without complete finite counts (%s)", value => {
    render(<LanguageProvider lang="en"><NumbersView data={{ workload: { entries: [{ counts: { ...workloadCounts(7), priority: value } }] } }} /></LanguageProvider>);
    expect(screen.queryByText('Logged workload')).toBeNull();
  });
  it("renders the real metrics from the member's own counts", () => {
    renderNumbers();
    expect(screen.getByRole("heading", { name: "My reports" })).toBeInTheDocument();
    // The cases card: open/resolved/handled figures straight from metrics,
    // with the by-type breakdown bars valued at the real counts.
    expect(screen.getByText("My issues")).toBeInTheDocument();
    expect(screen.getByText("1 open")).toBeInTheDocument();
    expect(screen.getByText("3 resolved")).toBeInTheDocument();
    expect(screen.getByText("4 handled all time")).toBeInTheDocument();
    const discipline = screen.getByText("Discipline").closest(".reports-row");
    expect(discipline.querySelector(".reports-row__val").textContent).toBe("2");
    // The actions card: tasksDone under the honest 7-day tag — this payload
    // carries no YTD figure, so none may be shown.
    const actions = screen.getByText("Actions completed").closest(".reports-card");
    expect(actions.querySelector(".reports-card__big strong").textContent).toBe("3");
    expect(actions.textContent).toContain("7 days");
  });

  it("uses a real button for each report-card drill-in", () => {
    renderNumbers();
    const actions = screen.getByText("Actions completed").closest(".reports-card");

    expect(actions).not.toHaveAttribute("role");
    fireEvent.click(screen.getByRole("button", { name: "Actions completed" }));
    expect(screen.getByRole("button", { name: /All reports/ })).toBeInTheDocument();
  });

  // The removed chart was six bars drawn from the literal array [0,0,1,1,1,1],
  // scaled by the bar's own index, under a "Cases handled by month" label and
  // inches away from real counts. The rebuilt reports grid keeps the same
  // guarantee structurally: a card only materializes when its backing data
  // exists, and a spark series only renders from a real per-period series.
  // This payload backs exactly two cards and carries no series at all.
  it("renders no fabricated data series against the reports grid", () => {
    renderNumbers();
    expect(document.querySelectorAll(".reports-card")).toHaveLength(2);
    for (const title of ["Points earned", "Weekly goal", "Action streak", "Voting record", "Logged workload", "Learning progress"]) {
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    }
    // No time-series bars anywhere: drawing one here would require inventing
    // the series (the old month chart stays gone in any spelling).
    expect(document.querySelector(".reports-spark")).toBeNull();
    expect(document.querySelector(".month-bars")).toBeNull();
    expect(document.querySelector(".month-labels")).toBeNull();
    for (const month of ["Feb", "Mar", "Apr", "May", "Jun", "Jul"]) {
      expect(screen.queryByText(month)).not.toBeInTheDocument();
    }
    // Every breakdown value on screen is one of the member's real counts.
    const vals = [...document.querySelectorAll(".reports-row__val")].map((el) => el.textContent);
    expect(vals).toEqual(["2", "1"]);
  });

  it("reorders accessibly and persists the member-owned layout", async () => {
    const onSavePreferences = vi.fn().mockResolvedValue({});
    renderEditable({ onSavePreferences });
    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move My issues up" }));
    await waitFor(() => expect(onSavePreferences).toHaveBeenCalledWith(expect.objectContaining({ order: ["cases", "actions"] })));
  });

  // BUG-UG-WEB-MY-REPORTS-ORDER-NOT-KEPT-20261003: the layout was read
  // into state only on first mount, so a newer saved layout never showed.
  it("shows a newer saved order when the preferences change, and after a remount", () => {
    const titles = () => [...document.querySelectorAll(".reports-card")].map((card) => (card.textContent.includes("Actions completed") ? "Actions completed" : card.textContent.includes("My issues") ? "My issues" : "")).filter(Boolean);
    const view = (order) => <LanguageProvider lang="en"><NumbersView data={{ ...DATA, member: { id: "member-1", initials: "DF" }, reportPreferences: { order, hidden: [], custom: [] } }} /></LanguageProvider>;
    const { rerender, unmount } = render(view(["actions", "cases"]));
    const before = titles();
    expect(before.indexOf("Actions completed")).toBeLessThan(before.indexOf("My issues"));
    rerender(view(["cases", "actions"]));
    const after = titles();
    expect(after.indexOf("My issues")).toBeLessThan(after.indexOf("Actions completed"));
    unmount();
    render(view(["cases", "actions"]));
    const remounted = titles();
    expect(remounted.indexOf("My issues")).toBeLessThan(remounted.indexOf("Actions completed"));
  });

  it("keeps edits made while an older save is still in flight when that save's echo arrives", async () => {
    const order = () => [...document.querySelectorAll(".reports-card")].map((card) => (card.textContent.includes("Actions completed") ? "actions" : card.textContent.includes("My issues") ? "cases" : "")).filter(Boolean);
    const pending = [];
    function Harness() {
      const [prefs, setPrefs] = useState({ order: ["actions", "cases"], hidden: [], custom: [] });
      // Like the App: a successful save writes the saved layout back into data.
      const onSavePreferences = (config) => new Promise((resolve) => { pending.push(() => { setPrefs(config); resolve(config); }); });
      return <LanguageProvider lang="en"><NumbersView data={{ ...DATA, member: { id: "member-1", initials: "DF" }, reportPreferences: prefs }} onSavePreferences={onSavePreferences} /></LanguageProvider>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move My issues up" }));
    expect(order()).toEqual(["cases", "actions"]);
    // A second edit while the first save is still in flight.
    fireEvent.click(screen.getByRole("button", { name: "Move My issues down" }));
    expect(order()).toEqual(["actions", "cases"]);
    await waitFor(() => expect(pending).toHaveLength(1));
    // The first save completes and its (older) layout comes back as data.
    await act(async () => { pending[0](); });
    expect(order()).toEqual(["actions", "cases"]);
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[1](); });
    expect(order()).toEqual(["actions", "cases"]);
  });

  it("never adopts another member's fallback report layout on a shared browser", () => {
    window.localStorage.clear();
    const memberA = { ...DATA, member: { ...DATA.member, id: "member-a" } };
    const memberB = { ...DATA, member: { ...DATA.member, id: "member-b" } };
    const first = render(<LanguageProvider lang="en"><NumbersView data={memberA} /></LanguageProvider>);

    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    const cases = screen.getByText("My issues").closest(".reports-card");
    fireEvent.click(cases.querySelector('[aria-label="Hide this card"]'));
    first.unmount();

    render(<LanguageProvider lang="en"><NumbersView data={memberB} /></LanguageProvider>);
    expect(screen.getByText("My issues")).toBeVisible();
  });

  it("does not persist report state under a shared null member key", () => {
    window.localStorage.clear();
    renderNumbers();
    expect(window.localStorage.getItem("null")).toBeNull();
  });

  it("does not overwrite server report preferences when their read soft-fails", async () => {
    window.localStorage.clear();
    const onSavePreferences = vi.fn().mockResolvedValue({});
    const deviceCustom = [{ id: "device-custom", metric: "actions", kind: "stat", range: "recent" }];
    window.localStorage.setItem("sg:member:member-c:reports:custom", JSON.stringify(deviceCustom));
    render(
      <LanguageProvider lang="en">
        <NumbersView
          data={{
            ...DATA,
            member: { ...DATA.member, id: "member-c" },
            reportPreferences: null,
            reportPreferencesUnavailable: true,
          }}
          onSavePreferences={onSavePreferences}
        />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    const cases = screen.getByText("My issues").closest(".reports-card");
    fireEvent.click(cases.querySelector('[aria-label="Hide this card"]'));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The report layout could not be saved."));
    expect(onSavePreferences).not.toHaveBeenCalled();
    expect(onSavePreferences).not.toHaveBeenCalledWith(expect.objectContaining({ order: [], custom: deviceCustom }));
  });

  it("serializes rapid layout saves so an older request cannot land last", async () => {
    let releaseFirst;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    const onSavePreferences = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({});
    renderEditable({ onSavePreferences });
    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move My issues up" }));
    await waitFor(() => expect(onSavePreferences).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Move Actions completed up" }));
    expect(onSavePreferences).toHaveBeenCalledTimes(1);
    releaseFirst({});
    await waitFor(() => expect(onSavePreferences).toHaveBeenCalledTimes(2));
  });

  it("hides and restores a custom chart without deleting its definition", async () => {
    const custom = [{ id: "c-one", metric: "actions", kind: "stat", range: "recent" }];
    const onSavePreferences = vi.fn().mockResolvedValue({});
    render(<LanguageProvider lang="en"><NumbersView data={{ ...DATA, reportPreferences: { order: ["c-one"], hidden: [], custom } }} onSavePreferences={onSavePreferences} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    const customCard = screen.getByText("custom chart — kept in this browser only, yours to keep or remove").closest(".reports-card");
    fireEvent.click(customCard.querySelector('[aria-label="Hide this card"]'));
    expect(screen.queryByText("custom chart — kept in this browser only, yours to keep or remove")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Restore Actions completed/ }));
    expect(screen.getByText("custom chart — kept in this browser only, yours to keep or remove")).toBeInTheDocument();
    await waitFor(() => expect(onSavePreferences).toHaveBeenCalledTimes(2));
    expect(onSavePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ custom }));
  });

  // SEC-UG-NUMBERSVIEW-CSV-FORMULA-GUARD-DIVERGENCE-20260920. The reports
  // download carried its own formula guard anchored at the first character,
  // while the casework and analytics exports neutralize a payload that hides
  // behind leading whitespace. Spreadsheet programs trim that whitespace before
  // they decide a cell is a formula, so this export now uses the same shared
  // escape instead of a weaker private copy.
  it("neutralizes a formula payload that hides behind leading whitespace in the downloaded file", async () => {
    const blobs = [];
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const node = Document.prototype.createElement.call(document, tag);
      if (tag === "a") node.click = () => {};
      return node;
    });
    vi.stubGlobal("URL", { ...URL, createObjectURL: (blob) => { blobs.push(blob); return "blob:x"; }, revokeObjectURL: () => {} });
    // The actions card's value is the server's year-to-date count, the one
    // remaining report value that comes straight from a loaded field.
    const data = { ...DATA, rewards: { actionsYtd: " =1+1" }, reportPreferences: { order: ["actions"], hidden: [], custom: [] } };
    render(<LanguageProvider lang="en"><NumbersView data={data} /></LanguageProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Export reports" }));

    expect(blobs).toHaveLength(1);
    const csv = await blobs[0].text();
    const valueCell = csv.split("\r\n")[1].split(",")[3];
    expect(valueCell).toBe("' =1+1");
    // A cell with no formula trigger is written as-is.
    expect(csv.split("\r\n")[0]).toBe("key,title,period,value,detail");
    expect(csv.split("\r\n")[1].split(",")[0]).toBe("actions");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exports visible reports in their current order", () => {
    const onExport = vi.fn();
    renderEditable({ onExport });
    fireEvent.click(screen.getByRole("button", { name: "Export reports" }));
    expect(onExport).toHaveBeenCalledWith([
      expect.objectContaining({ key: "actions", title: "Actions completed" }),
      expect.objectContaining({ key: "cases", title: "My issues" }),
    ]);
  });
  // The card and the detail view both used to branch on a ▼ delta and paint it
  // destructive, but no builder here can produce one: every delta is a catalogue
  // string, a percentage, an empty string, or the ▲ weekly form, and a custom
  // card only forwards a base card's delta. These two cases hold the reachable
  // ▲ form to the styling it has today and fail if a delta branch — or the CSS
  // class it would need — comes back for a glyph nothing in the module emits.
  it("renders the weekly ▲ delta in the card's own delta colour", () => {
    renderNumbers();
    const actions = screen.getByText("Actions completed").closest(".reports-card");
    const delta = actions.querySelector(".reports-card__big span");
    expect(delta.textContent).toBe("▲ 3");
    expect(delta.className).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Actions completed" }));
    const detailDelta = document.querySelector(".reports-detail__big span");
    expect(detailDelta.textContent).toBe("▲ 3");
    expect(detailDelta.className).toBe("");
    expect(document.querySelector(".is-down")).toBeNull();

    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).not.toMatch(/\.reports-(?:card|detail)__big[^{]*\.is-down/);
  });

  it("tests a delta against no glyph its own card builders can never emit", () => {
    const source = readFileSync(resolve(process.cwd(), "src/views/NumbersView.jsx"), "utf8");
    const symbolsOf = (text) => text.match(/\p{S}/gu) ?? [];

    // Everything a delta producer in this module can put on screen: the string
    // and template literals written on the `delta:` line itself, plus every
    // language of each catalogue key that line passes through t().
    const producers = [...source.matchAll(/^\s*delta: (.*),$/gm)].map(([, expression]) => expression);
    // Seven builders remain once the points and streak cards were removed
    // (Union Ground has no points economy): weekly, votes, actions, cases,
    // workload, learning, and the custom-card forwarder.
    expect(producers.length).toBeGreaterThanOrEqual(7);
    const produced = new Set();
    for (const expression of producers) {
      for (const [, , literal] of expression.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
        for (const glyph of symbolsOf(literal)) produced.add(glyph);
      }
      for (const [, key] of expression.matchAll(/\bt\(\s*"([^"]+)"/g)) {
        for (const lang of Object.keys(catalogue)) {
          for (const glyph of symbolsOf(catalogue[lang]?.[key] ?? "")) produced.add(glyph);
        }
      }
    }
    expect(produced.has("▲")).toBe(true);

    // Everything the views compare a delta against. A custom card forwards a
    // base card's delta untouched, so the producer set above is the whole set.
    const compared = [];
    const comparisons = [
      /\.delta\s*\??\.\s*(?:startsWith|endsWith|includes|indexOf|lastIndexOf|search|match)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g,
      /\.delta(?:\s*\??\.\s*charAt\(\s*\d+\s*\)|\s*\[\s*\d+\s*\])?\s*[=!]==?\s*(["'`])((?:\\.|(?!\1).)*)\1/g,
      /(["'`])((?:\\.|(?!\1).)*)\1\s*[=!]==?\s*\w+\.delta\b/g,
      /\/((?:\\.|[^/\n])+)\/[a-z]*\s*\.test\(\s*\w+\.delta\b/g,
    ];
    for (const comparison of comparisons) {
      for (const match of source.matchAll(comparison)) compared.push(match[2] ?? match[1]);
    }
    const unproducible = [...new Set(compared.flatMap(symbolsOf))].filter((glyph) => !produced.has(glyph));
    expect(unproducible).toEqual([]);
  });
});

// A11Y-UG-LEARN-BACK-CHEVRON-ACCESSIBLE-NAME-20260920: the report-detail
// back control carried its chevron as a text node inside the button, so the
// accessible name was "‹ All reports" instead of the destination alone.
describe("report detail back control", () => {
  it("names the back control with the destination alone", () => {
    renderNumbers();
    fireEvent.click(screen.getByRole("button", { name: "Actions completed" }));
    const back = document.querySelector(".reports-detail__back");

    expect(back).toHaveAccessibleName("All reports");
    expect(screen.getByRole("button", { name: "All reports" })).toBe(back);
    // The chevron still shows, hidden from the accessibility tree.
    expect(back.textContent).toContain("\u2039");
    expect(back.querySelector("[aria-hidden='true']").textContent).toContain("\u2039");
  });
});

// PERF-UG-WEB-SHELL-AND-PER-LANGUAGE-BUNDLES-20261011: the report card
// keeps its own label table, so it must follow the language the shell actually
// loaded (LanguageProvider's lang), not the member's saved language. A Spanish
// member whose Spanish chunk failed sees an English shell; the card stays
// English with it.
describe("member report card language", () => {
  const spanishMember = { ...DATA, member: { id: "member-es", initials: "AR", language: "es" } };

  it("stays English inside an English shell when the member's Spanish chunk failed", () => {
    render(<LanguageProvider lang="en"><NumbersView data={spanishMember} /></LanguageProvider>);
    expect(screen.getByRole("heading", { name: "My reports" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Participation report card" })).toBeInTheDocument();
    expect(screen.queryByText("Reporte de participación")).not.toBeInTheDocument();
  });

  it("is Spanish when the shell has Spanish loaded", () => {
    render(<LanguageProvider lang="es"><NumbersView data={spanishMember} /></LanguageProvider>);
    expect(screen.getByRole("heading", { name: catalogue.es["reports.title"] })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reporte de participación" })).toBeInTheDocument();
    expect(screen.queryByText("Participation report card")).not.toBeInTheDocument();
  });
});

// Union Ground sets no weekly action goal: participation is voluntary and
// never scored, so the loader and the demo carry `goal: null`. That must drop
// the goal card rather than render a "3/0" goal nobody set.
describe("numbers view without a weekly goal", () => {
  it("renders no weekly-goal card when the goal is null", () => {
    const data = {
      ...DATA,
      weekly: { done: 3, goal: null, streakDays: 0 },
      weekDays: [{ label: "M", active: true }, { label: "T", active: false }],
    };
    render(<LanguageProvider lang="en"><NumbersView data={data} /></LanguageProvider>);
    expect(screen.queryByText("Weekly goal")).not.toBeInTheDocument();
    expect(screen.queryByText("3/0")).not.toBeInTheDocument();
  });
});

// Union Ground has no points economy: no Points or streak card, and no
// points metric in the build-a-chart composer, even when a rewards summary
// with points, tiers, and a streak is loaded.
describe("numbers view without points", () => {
  const withRewards = {
    ...DATA,
    rewards: { totalPoints: 640, tierNumber: 2, tierName: "Builder", weekStreak: 4, pointsToGo: 60, nextTierName: "Anchor", actionsYtd: 12 },
    rewardsCatalog: { tiers: [{ tier: 2, minPoints: 500, name: "Builder" }, { tier: 3, minPoints: 700, name: "Anchor" }] },
  };

  it("renders no Points or streak card and keeps the real actions figure", () => {
    render(<LanguageProvider lang="en"><NumbersView data={withRewards} /></LanguageProvider>);
    expect(screen.queryByText("Points earned")).not.toBeInTheDocument();
    expect(screen.queryByText("Action streak")).not.toBeInTheDocument();
    expect(screen.queryByText("640")).not.toBeInTheDocument();
    expect(screen.queryByText(/to go/)).not.toBeInTheDocument();
    const actions = screen.getByText("Actions completed").closest(".reports-card");
    expect(actions.querySelector(".reports-card__big strong").textContent).toBe("12");
  });

  it("exports no points row", () => {
    const onExport = vi.fn();
    render(<LanguageProvider lang="en"><NumbersView data={withRewards} onExport={onExport} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Export reports" }));
    const keys = onExport.mock.calls[0][0].map((row) => row.key);
    expect(keys).toContain("actions");
    expect(keys).not.toContain("pts");
    expect(keys).not.toContain("streak");
  });

  it("keeps no points card, streak card, or points chart metric in the module", () => {
    const source = readFileSync(resolve(process.cwd(), "src/views/NumbersView.jsx"), "utf8");
    expect(source).not.toMatch(/key: "pts"/);
    expect(source).not.toMatch(/key: "streak"/);
    expect(source).not.toContain("reports.mPoints");
    expect(source).not.toContain("reports.pointsTitle");
  });
});
