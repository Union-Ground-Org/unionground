import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PulseExplorer } from "../src/features/pulse/ui/PulseExplorer.jsx";
import { PulseChartStudio } from "../src/features/pulse/ui/PulseSavedCharts.jsx";
import { PulseChart } from "../src/features/pulse/ui/PulseChart.jsx";
import { createPreviewPulseApi } from "../src/features/pulse/pulsePreview.js";
import { pulseCopy } from "../src/features/pulse/pulseCopy.js";
import { t as translate } from "../src/lib/i18n.js";
import { PulseView } from "../src/views/PulseView.jsx";
import { AnalyticsCoreDesk } from "../src/features/analytics/ui/AnalyticsCoreDesk.jsx";
import { createPreviewAnalyticsSnapshot, createPreviewAnalyticsViewer } from "../src/features/analytics/index.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { showAnalyticsView } from "./helpers/analyticsView.js";

const copyFor = (lang = "en") => pulseCopy((key, vars) => translate(lang, key, vars));
const NOW = () => new Date("2026-11-02T17:40:00Z");
const ID = "0f6b4c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";

afterEach(() => vi.restoreAllMocks());

function previewApi() {
  return createPreviewPulseApi({ now: NOW });
}

async function renderExplorer(props = {}) {
  const { lang = "en", ...rest } = props;
  const api = rest.api || previewApi();
  render(<LanguageProvider lang={lang}><PulseExplorer api={api} hat="member" now={NOW} organizationName="Tamarack Valley Human Services" {...rest} /></LanguageProvider>);
  await screen.findByRole("list", { name: lang === "es" ? "Pulso" : "Pulse" });
  // The list renders before its cards load; the update line appears only once
  // every card has answered, so wait for it rather than for the list.
  await screen.findByText(lang === "es" ? / · Actualizado / : / · Updated /);
  await waitFor(() => expect(screen.queryAllByText(copyFor(lang).cardLoading)).toHaveLength(0));
  return api;
}

describe("website Pulse explorer", () => {

  it("opens a card's table view and downloads a CSV of the cleared rows", async () => {
    const created = [];
    globalThis.URL.createObjectURL = vi.fn((blob) => { created.push(blob); return "blob:pulse"; });
    globalThis.URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await renderExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Open details · Campaign action sign-ups" }));
    const detail = screen.getByRole("region", { name: "Campaign action sign-ups" });
    expect(within(detail).getByText(/Recorded sign-ups to published collective actions/)).toBeInTheDocument();
    expect(document.activeElement).toBe(within(detail).getByRole("heading", { level: 2 }));
    fireEvent.click(within(detail).getByRole("button", { name: "Table view" }));
    const table = within(detail).getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(13);
    expect(within(table).getByRole("rowheader", { name: "Nov 2026" })).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "Chart view" }));
    fireEvent.click(within(detail).getByRole("button", { name: "Download CSV" }));
    expect(within(detail).getByText("CSV downloaded.")).toBeInTheDocument();
    expect(click).toHaveBeenCalledTimes(1);
    const body = await created[0].text();
    expect(body.split("\r\n")[0]).toBe("Period or group,Count");
    expect(body).toContain("2026-11,148");

    fireEvent.click(within(detail).getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("region", { name: "Campaign action sign-ups" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open details · Your action sign-ups" }));
    expect(screen.getByText("Your own figures. Unit and level filters do not apply.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close details · Your action sign-ups" }));
  });

  it("reports a failed download without offering a file", async () => {
    globalThis.URL.createObjectURL = undefined;
    await renderExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Open details · Meeting check-ins" }));
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(screen.getByText("The CSV could not be downloaded.")).toBeInTheDocument();
  });

  it("gives an admin unit and level filters and withholds the small unit as a whole", async () => {
    await renderExplorer({ hat: "admin" });
    expect(screen.getByText(/^Tamarack Valley Human Services · Admin · Updated/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Issue work" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "local" } });
    await waitFor(() => expect(screen.getAllByText("444").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "7a1c0b52-0d5e-4c1f-9a51-3f0c2d6b1a03" } });
    await waitFor(() => expect(screen.getAllByText("Withheld as a whole: a group is below the floor of 25 people.")).toHaveLength(3));
    // The person's own card ignores the unit filter.
    const cards = within(screen.getByRole("list", { name: "Pulse" })).getAllByRole("listitem");
    expect(within(cards[0]).getByRole("img")).toBeInTheDocument();
    fireEvent.click(within(cards[1]).getByRole("button", { name: /Open details/ }));
    expect(screen.getByText("No download: these figures are withheld or could not be verified.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    expect(screen.queryByRole("table")).toBeNull();
  });


  it("says when Pulse or a card cannot be verified, and retries", async () => {
    const api = previewApi();
    const options = vi.spyOn(api, "options").mockRejectedValueOnce(new Error("denied"));
    vi.spyOn(api, "preview").mockImplementation(async (hat, spec) => {
      if (spec.measure === "meeting_turnout") throw new Error("timeout");
      if (spec.measure === "published_actions") return { locked: true, rows: [], withheld: false, unavailable: false, floor: 10, person: false, countedFrom: "" };
      return { rows: [], withheld: false, locked: false, unavailable: false, floor: 10, person: true, countedFrom: "x" };
    });
    render(<PulseExplorer api={api} hat="member" now={NOW} />);
    expect(await screen.findByText(/Pulse could not be verified for your current role/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("list", { name: "Pulse" });
    await waitFor(() => expect(screen.getByText("These figures could not be verified. Refresh to try again.")).toBeInTheDocument());
    expect(screen.getByText("Complete the quarterly survey to see aggregate figures.")).toBeInTheDocument();
    expect(screen.getByText("No recorded figures in this period.")).toBeInTheDocument();
    expect(options).toHaveBeenCalledTimes(2);
  });
});

describe("website Pulse saved charts and builder", () => {
  it("builds a chart with a live preview, saves it, edits it, removes it and undoes", async () => {
    const api = await renderExplorer();
    const saved = screen.getByRole("region", { name: "Your charts" });
    const list = within(saved).getByRole("list", { name: "Your charts" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("★ Pinned: Chapter sign-ups");

    fireEvent.click(within(saved).getByRole("button", { name: "+ Build a chart" }));
    const builder = within(saved).getByRole("form", { name: "Chart builder" });
    expect(within(builder).getByLabelText("Who can see it")).toHaveValue("personal");
    expect(within(within(builder).getByLabelText("Who can see it")).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(within(builder).getByRole("button", { name: "Save chart" }));
    expect(within(builder).getByText("Give the chart a title.")).toBeInTheDocument();

    fireEvent.change(within(builder).getByLabelText("Chart title"), { target: { value: "Turnout by meeting" } });
    fireEvent.change(within(builder).getByLabelText("Measure"), { target: { value: "meeting_turnout" } });
    fireEvent.change(within(builder).getByLabelText("Breakdown"), { target: { value: "meeting" } });
    fireEvent.change(within(builder).getByLabelText("Chart form"), { target: { value: "line" } });
    fireEvent.change(within(builder).getByLabelText("Who can see it"), { target: { value: "campaign" } });
    fireEvent.click(within(builder).getByLabelText("Pin to the top of Pulse"));
    await waitFor(() => expect(within(builder).getByRole("img").getAttribute("aria-label")).toBe("Line chart of Turnout by meeting: 4 values, latest Contract town hall 46"));
    const save = vi.spyOn(api, "save");
    fireEvent.click(within(builder).getByRole("button", { name: "Save chart" }));
    await waitFor(() => expect(within(saved).getByText("Chart saved.")).toBeInTheDocument());
    expect(save).toHaveBeenCalledWith("member", expect.objectContaining({ title: "Turnout by meeting", scope: "personal", pinned: true,
      spec: { version: 1, measure: "meeting_turnout", breakdown: "meeting", period: "12m", form: "line" } }));
    await waitFor(() => expect(within(saved).getAllByRole("listitem")).toHaveLength(3));

    fireEvent.click(within(saved).getByRole("button", { name: "Edit My sign-ups" }));
    const editor = within(saved).getByRole("form", { name: "Chart builder" });
    expect(within(editor).getByLabelText("Chart title")).toHaveValue("My sign-ups");
    fireEvent.change(within(editor).getByLabelText("Chart form"), { target: { value: "table" } });
    await waitFor(() => expect(within(editor).getByRole("table")).toBeInTheDocument());
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    expect(within(saved).queryByRole("form")).toBeNull();

    fireEvent.click(within(saved).getByRole("button", { name: "Remove My sign-ups" }));
    await waitFor(() => expect(within(saved).getByText("Removed “My sign-ups”.")).toBeInTheDocument());
    expect(within(saved).queryByText("My sign-ups")).toBeNull();
    fireEvent.click(within(saved).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(within(saved).getByText("Chart restored.")).toBeInTheDocument());
    expect(within(saved).getByRole("heading", { name: "My sign-ups" })).toBeInTheDocument();
  });

  it("reports save, remove, undo and list failures, and keeps an unavailable chart removable", async () => {
    const api = previewApi();
    vi.spyOn(api, "list").mockResolvedValueOnce([
      { id: ID, title: "Old staff chart", scope: "personal", spec: null, pinned: false, home: false, owned: true, figures: { unavailable: true, rows: [] } },
    ]).mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(api, "remove").mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce().mockRejectedValueOnce(new Error("expired"));
    vi.spyOn(api, "save").mockRejectedValueOnce(new Error("denied"));
    render(<PulseChartStudio api={api} hat="steward" onOpenPulse={vi.fn()} />);
    expect(await screen.findByText("This chart is unavailable for your current role. You can still remove it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove Old staff chart" }));
    expect(await screen.findByText("The chart could not be removed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Old staff chart" }));
    expect(await screen.findByText("These figures could not be verified. Refresh to try again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("The undo window has closed.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "+ Build a chart" }));
    const builder = screen.getByRole("form", { name: "Chart builder" });
    expect(within(within(builder).getByLabelText("Who can see it")).getAllByRole("option")).toHaveLength(1);
    fireEvent.change(within(builder).getByLabelText("Measure"), { target: { value: "visible_cases" } });
    expect(within(within(builder).getByLabelText("Who can see it")).getAllByRole("option")).toHaveLength(3);
    fireEvent.change(within(builder).getByLabelText("Issue type"), { target: { value: "Pay" } });
    fireEvent.change(within(builder).getByLabelText("Chart title"), { target: { value: "Pay cases" } });
    fireEvent.click(within(builder).getByRole("button", { name: "Save chart" }));
    expect(await within(builder).findByText("The chart could not be saved. Check the title and try again.")).toBeInTheDocument();
  });

  it("offers an admin the unit breakdown, unit narrowing and the local level", async () => {
    const api = previewApi();
    render(<PulseChartStudio api={api} hat="admin" />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Build a chart" }));
    const builder = screen.getByRole("form", { name: "Chart builder" });
    expect(within(builder).queryByLabelText("Unit")).toBeNull();
    fireEvent.change(within(builder).getByLabelText("Measure"), { target: { value: "published_actions" } });
    fireEvent.change(within(builder).getByLabelText("Level"), { target: { value: "local" } });
    fireEvent.change(within(builder).getByLabelText("Unit"), { target: { value: "7a1c0b52-0d5e-4c1f-9a51-3f0c2d6b1a01" } });
    fireEvent.change(within(builder).getByLabelText("Breakdown"), { target: { value: "unit" } });
    await waitFor(() => expect(within(builder).getByText("Withheld as a whole: a group is below the floor of 25 people.")).toBeInTheDocument());
  });

  it("says the studio is unavailable when the role cannot be verified", async () => {
    const api = previewApi();
    vi.spyOn(api, "options").mockRejectedValue(new Error("denied"));
    render(<LanguageProvider lang="es"><PulseChartStudio api={api} hat="vp" /></LanguageProvider>);
    expect(await screen.findByText("No se pudo verificar Pulso para tu rol actual.")).toBeInTheDocument();
  });

  it("draws nothing it cannot verify", () => {
    const copy = copyFor("en");
    const { container } = render(<PulseChart figures={null} spec={null} title="x" copy={copy} lang="en" />);
    expect(container).toHaveTextContent(copy.unavailable);
  });
});

describe("website Pulse wiring", () => {
  it("renders the preview fixture through PulseView and refuses a live page with no client", async () => {
    const { unmount } = render(<LanguageProvider lang="en"><PulseView preview hat="advisor" /></LanguageProvider>);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Pulse");
    expect(screen.getByText(/^Tamarack Valley Human Services · /)).toHaveClass("pulse-note");
    unmount();
    render(<LanguageProvider lang="en"><PulseView hat="root" /></LanguageProvider>);
    expect(await screen.findByText(/Pulse could not be verified for your current role/)).toBeInTheDocument();
    expect(screen.queryByText(/PREVIEW/)).toBeNull();
  });

});

// Record 8435, slice 7: saving a chart keeps Save focused under pending, saves
// once from one tick, and holds Cancel until the save answers.
describe("saving a chart while it runs (record 8435)", () => {
  async function builderReady() {
    const api = await renderExplorer();
    const saved = screen.getByRole("region", { name: "Your charts" });
    fireEvent.click(within(saved).getByRole("button", { name: "+ Build a chart" }));
    const builder = within(saved).getByRole("form", { name: "Chart builder" });
    fireEvent.change(within(builder).getByLabelText("Chart title"), { target: { value: "Turnout by meeting" } });
    const save = vi.spyOn(api, "save");
    return { save, builder, button: within(builder).getByRole("button", { name: "Save chart" }) };
  }

  it("saves one chart when Save chart is activated twice in one tick", async () => {
    const { save, button } = await builderReady();
    await expectOneWriteFromOneTick(save, [() => fireEvent.click(button), () => fireEvent.click(button)]);
  });

  it("keeps Save chart focused and Cancel pending while the chart is saved", async () => {
    const { save, builder, button } = await builderReady();
    const original = save.getMockImplementation();
    let release;
    save.mockImplementation((...args) => new Promise((resolve) => { release = () => resolve(original?.(...args)); }));
    button.focus();
    fireEvent.click(button);
    try {
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(button).toHaveFocus();
      expect(button).toHaveAttribute("aria-disabled", "true");
      const cancel = within(builder).getByRole("button", { name: "Cancel" });
      expect(cancel).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(cancel);
      expect(screen.getByRole("form", { name: "Chart builder" })).toBeInTheDocument();
    } finally {
      await act(async () => { release(); });
    }
  });
});

// Record 8435, slice 7: a chart save that answers after another chart's
// editor opened still refreshes the list, and closes only its own editor.
describe("a chart save answering after another editor opened (record 8435)", () => {
  it("refreshes the list and leaves the other chart's editor open", async () => {
    const api = await renderExplorer();
    const saved = screen.getByRole("region", { name: "Your charts" });
    fireEvent.click(within(saved).getByRole("button", { name: "+ Build a chart" }));
    const builder = within(saved).getByRole("form", { name: "Chart builder" });
    fireEvent.change(within(builder).getByLabelText("Chart title"), { target: { value: "Turnout by meeting" } });
    const original = api.save.bind(api);
    let release;
    vi.spyOn(api, "save").mockImplementation((...args) => new Promise((resolve) => { release = () => resolve(original(...args)); }));
    const list = vi.spyOn(api, "list");
    fireEvent.click(within(builder).getByRole("button", { name: "Save chart" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    fireEvent.click(within(saved).getByRole("button", { name: "Edit My sign-ups" }));
    expect(within(saved).getByLabelText("Chart title")).toHaveValue("My sign-ups");
    const reads = list.mock.calls.length;
    await act(async () => { release(); });
    await waitFor(() => expect(list.mock.calls.length).toBe(reads + 1));
    expect(within(saved).getByRole("form", { name: "Chart builder" })).toBeInTheDocument();
    expect(within(saved).getByLabelText("Chart title")).toHaveValue("My sign-ups");
  });
});

describe("a chart save answering after the hat changed (record 8435)", () => {
  it("does not reload the list for the earlier hat", async () => {
    const api = previewApi();
    const explorer = (hat) => <LanguageProvider lang="en"><PulseExplorer api={api} hat={hat} now={NOW} organizationName="Tamarack Valley Human Services" /></LanguageProvider>;
    const view = render(explorer("member"));
    const saved = await screen.findByRole("region", { name: "Your charts" });
    fireEvent.click(await within(saved).findByRole("button", { name: "+ Build a chart" }));
    const builder = within(saved).getByRole("form", { name: "Chart builder" });
    fireEvent.change(within(builder).getByLabelText("Chart title"), { target: { value: "Turnout by meeting" } });
    const original = api.save.bind(api);
    let release;
    vi.spyOn(api, "save").mockImplementation((...args) => new Promise((resolve) => { release = () => resolve(original(...args)); }));
    const list = vi.spyOn(api, "list");
    fireEvent.click(within(builder).getByRole("button", { name: "Save chart" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    view.rerender(explorer("committee member"));
    await waitFor(() => expect(list).toHaveBeenCalledWith("committee member"));
    const memberReads = () => list.mock.calls.filter(([hat]) => hat === "member").length;
    const before = memberReads();
    await act(async () => { release(); });
    expect(memberReads()).toBe(before);
  });

  it("names the page Pulse in Spanish too, with the organization in the line below", async () => {
    render(<LanguageProvider lang="es"><PulseView preview hat="member" /></LanguageProvider>);
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe(translate("es", "nav.pulse"));
    expect(screen.getByText(/^Tamarack Valley Human Services · /)).toHaveClass("pulse-note");
  });
});
