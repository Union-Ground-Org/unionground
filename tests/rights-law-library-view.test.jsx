// REQ-UG-RIGHTS-LAW-LIBRARY-20261012: the laws and agencies library on
// the Rights page renders only behind features.rights.law_library, shows a
// source line on every item, routes the member to a committee contact, and fetches the
// large documents file only when the member opens an agency's pages or the
// guides.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { RightsView } from "../src/views/RightsView.jsx";
import { RightsLawLibrary } from "../src/features/rightsLibrary/RightsLawLibrary.jsx";
import { forbiddenIdentityTokensIn } from "../scripts/lib/sibling-deny-list.mjs";
import { setDisclosureOpen, settleQueuedTasks } from "./helpers/disclosure.js";
import { RIGHTS_LIBRARY_SWITCH, assertAgencies, assertDocuments, demoteMailboxLinks, markdownBlocks, rightsLibraryEnabled } from "../src/features/rightsLibrary/rightsLawLibrary.js";

const read = (name) => JSON.parse(readFileSync(resolve(process.cwd(), "data/reference/labor-rights", name), "utf8"));
const agencies = read("agencies.json");
const sharedDocuments = read("documents.json");

// The authored guides (documents with no agency) were removed from the shipped
// documents file with the Union Ground identity. The view still renders them,
// so the guide tests feed it these two guides through the same loader seam.
const GUIDE_BODY = [
  "# Organizing rights: a worker's guide",
  "",
  "| Situation | First step |",
  "|---|---|",
  "| A manager asks about the campaign | Say you would like to think about it |",
  "| You are disciplined | Write down what was said and when |",
  "",
  "| Deadline | Where |",
  "|---|---|",
  "| Six months | Labor board |",
  "",
  "1. Write down what happened.",
  "- Keep copies off the work system.",
  "4. Talk to your committee contact.",
  "",
  "See [the board](https://example.gov/board \"Board title\") for the filing form.",
].join("\n");

function guide(id, title, body) {
  const base = sharedDocuments.documents[0];
  return { ...base, id, agency_id: null, kind: "guide", title, url: `https://example.gov/${id}`, body_md: body };
}

const documents = {
  ...sharedDocuments,
  documents: [
    ...sharedDocuments.documents,
    guide("worker-guide", "Organizing rights: a worker's guide", GUIDE_BODY),
    guide("committee-cheatsheet", "Committee cheat sheet", "# Committee cheat sheet\n\nKeep notes factual."),
  ],
};

function renderRights({ on, desktop = true, lang = "en", onMessageSteward = vi.fn() }) {
  const data = { ...fallbackData, organizationConfiguration: { switches: { [RIGHTS_LIBRARY_SWITCH]: on } } };
  return render(
    <LanguageProvider lang={lang}>
      <RightsView data={data} desktop={desktop} stewardRequests={[]} onAssistant={vi.fn()} onMessageSteward={onMessageSteward}
        onSaveProgress={vi.fn().mockResolvedValue(undefined)} onRequestSteward={vi.fn().mockResolvedValue(undefined)} />
    </LanguageProvider>,
  );
}

function renderLibrary(props = {}) {
  const loadAgencies = props.loadAgencies ?? vi.fn().mockResolvedValue(agencies);
  const loadDocuments = props.loadDocuments ?? vi.fn().mockResolvedValue(documents);
  const view = render(
    <LanguageProvider lang={props.lang ?? "en"}>
      <RightsLawLibrary onAskSteward={props.onAskSteward ?? null} loadAgencies={loadAgencies} loadDocuments={loadDocuments} />
    </LanguageProvider>,
  );
  return { ...view, loadAgencies, loadDocuments };
}

describe("rights law library switch", () => {
  it("reads only an explicit true from the member configuration", () => {
    expect(rightsLibraryEnabled(null)).toBe(false);
    expect(rightsLibraryEnabled({ switches: {} })).toBe(false);
    expect(rightsLibraryEnabled({ switches: { [RIGHTS_LIBRARY_SWITCH]: "true" } })).toBe(false);
    expect(rightsLibraryEnabled({ switches: { [RIGHTS_LIBRARY_SWITCH]: true } })).toBe(true);
  });

  it.each([true, false])("renders nothing while the switch is off (desktop %s)", (desktop) => {
    renderRights({ on: false, desktop });
    expect(screen.queryByRole("heading", { name: "Laws and agencies" })).not.toBeInTheDocument();
    expect(screen.queryByText("Loading the library…")).not.toBeInTheDocument();
  });

  it.each([true, false])("renders the library below the lessons when on (desktop %s)", async (desktop) => {
    const onMessageSteward = vi.fn();
    renderRights({ on: true, desktop, onMessageSteward });
    const heading = await screen.findByRole("heading", { name: "Laws and agencies" });
    expect(screen.getByRole("heading", { name: "Agencies" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Talk to your committee contact" }));
    expect(onMessageSteward).toHaveBeenCalledTimes(1);
    // Below the lessons: the library follows the lesson list in document order.
    const lessons = document.querySelector(desktop ? ".learn-articles" : ".learn-rows");
    expect(lessons.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("rights law library content", () => {
  it("puts a resolvable source line on every agency, deadline, situation and concept", async () => {
    const { container } = renderLibrary({ onAskSteward: vi.fn() });
    await screen.findByRole("heading", { name: "Laws and agencies" });
    const cards = container.querySelectorAll(".rights-library__agency");
    expect(cards).toHaveLength(agencies.agencies.length);
    const deadlines = container.querySelectorAll(".rights-library__deadline");
    expect(deadlines).toHaveLength(agencies.agencies.flatMap((agency) => agency.deadlines).length);
    for (const item of cards) {
      expect(item.querySelector(":scope > .rights-library__agency-body > .source-line"), item.textContent.slice(0, 60)).not.toBeNull();
    }
    for (const item of deadlines) {
      expect(item.querySelector(":scope > .source-line"), item.textContent.slice(0, 60)).not.toBeNull();
    }
    for (const item of container.querySelectorAll(".rights-library__situations > li, .rights-library__concepts > li")) {
      expect(item.querySelector(".source-line")).not.toBeNull();
    }
    expect(container.querySelector(".source-line--missing")).toBeNull();
    const dlr = within(container.querySelector("#rights-agency-ma-dlr"));
    expect(dlr.getByText("within six months")).toBeInTheDocument();
    expect(dlr.getByText("456 CMR 15.04 (Six-month Limitation)")).toBeInTheDocument();
  });

  // BUG-UG-RIGHTS-PAGE-RENDERS-WHOLE-LIBRARY-20261106: every agency
  // and concept opened in full made the page about 14,600 px tall. Each card
  // now starts collapsed to its name, and every entry stays one tap away.
  it("opens with every agency and concept collapsed to its name and every entry reachable", async () => {
    const { container } = renderLibrary();
    await screen.findByRole("heading", { name: "Laws and agencies" });
    const cards = [...container.querySelectorAll(".rights-library__agency")];
    expect(cards).toHaveLength(agencies.agencies.length);
    for (const [index, card] of cards.entries()) {
      const agency = agencies.agencies[index];
      expect(card.tagName).toBe("DETAILS");
      expect(card.open).toBe(false);
      const name = `${agency.name}${agency.abbreviation ? ` (${agency.abbreviation})` : ""}`;
      expect(card.querySelector(":scope > summary").textContent).toBe(name);
      expect(within(card.querySelector(":scope > summary")).getByRole("heading", { level: 4, name })).toBeInTheDocument();
      // The deadlines and contacts sit inside the disclosure, not beside it.
      expect(card.querySelector(":scope > .rights-library__agency-body .rights-library__deadlines, :scope > .rights-library__agency-body p")).not.toBeNull();
    }
    const concepts = [...container.querySelectorAll(".rights-library__concepts > li > details")];
    expect(concepts).toHaveLength(agencies.concepts.length);
    for (const [index, concept] of concepts.entries()) {
      expect(concept.open).toBe(false);
      expect(concept.querySelector(":scope > summary").textContent).toBe(agencies.concepts[index].name);
      expect(concept.querySelector(":scope > p").textContent).toBe(agencies.concepts[index].summary);
    }
    await setDisclosureOpen(cards[0], true);
    expect(cards[0].open).toBe(true);
  });

  it("opens the agency a situation names when the member follows its jump link", async () => {
    const { container } = renderLibrary();
    await screen.findByRole("heading", { name: "Laws and agencies" });
    const scenario = agencies.scenarios.find((item) => agencies.agencies.some((agency) => agency.id === item.primary_agency));
    const card = container.querySelector(`#rights-agency-${scenario.primary_agency}`);
    expect(card.open).toBe(false);
    const jump = container.querySelector(`.rights-library__situations a[href="#rights-agency-${scenario.primary_agency}"]`);
    fireEvent.click(jump);
    expect(card.open).toBe(true);
    // Only the named card opens; the rest of the library stays collapsed.
    expect([...container.querySelectorAll(".rights-library__agency")].filter((item) => item.open)).toEqual([card]);
  });

  it("states that it is general information and routes to a committee contact", async () => {
    const onAskSteward = vi.fn();
    renderLibrary({ onAskSteward });
    expect(await screen.findByText("General information, not legal advice")).toBeInTheDocument();
    expect(screen.getByText(agencies.disclaimer)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Talk to your committee contact" }));
    expect(onAskSteward).toHaveBeenCalledTimes(1);
  });

  it("loads the documents file only when the member opens agency pages or the guides", async () => {
    const { container, loadAgencies, loadDocuments } = renderLibrary();
    await screen.findByRole("heading", { name: "Laws and agencies" });
    expect(loadAgencies).toHaveBeenCalledTimes(1);
    expect(loadDocuments).not.toHaveBeenCalled();
    const dlrPages = container.querySelector("#rights-agency-ma-dlr .rights-library__pages");
    await setDisclosureOpen(dlrPages, true);
    expect(loadDocuments).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(dlrPages.querySelectorAll(".rights-library__page")).toHaveLength(3));
    for (const page of dlrPages.querySelectorAll(".rights-library__page")) expect(page.querySelector(".source-line")).not.toBeNull();
    const guides = screen.getByText("Open the guides").closest("details");
    await setDisclosureOpen(guides, true);
    expect(loadDocuments).toHaveBeenCalledTimes(1);
    expect(within(guides).getByText("Organizing rights: a worker's guide", { selector: "summary" })).toBeInTheDocument();
    expect(guides.querySelectorAll(".source-line").length).toBeGreaterThanOrEqual(2);
    // The guides live on this page, so they carry no "Read the page" link back to it.
    expect(within(guides).queryByRole("link", { name: "Read the page" })).toBeNull();
    expect(within(dlrPages).getAllByRole("link", { name: "Read the page" })).toHaveLength(3);
  });

  it("renders the guides' tables as tables and titled links as links", async () => {
    const { container } = renderLibrary();
    await screen.findByRole("heading", { name: "Laws and agencies" });
    await setDisclosureOpen(screen.getByText("Open the guides").closest("details"), true);
    await waitFor(() => expect(container.querySelectorAll(".rights-library__table table").length).toBeGreaterThanOrEqual(2));
    const guide = container.querySelector("#rights-doc-worker-guide");
    expect(guide.querySelector("table thead th")).not.toBeNull();
    expect(guide.textContent).not.toMatch(/\|\s*-{3,}/);
    expect(markdownBlocks('See [the form](https://example.gov/f "Form title").')).toEqual([{ kind: "markdown", text: "See [the form](https://example.gov/f)." }]);
    expect(markdownBlocks("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual([{ kind: "table", rows: [["a", "b"], ["1", "2"]] }]);
    expect(markdownBlocks("| lone |")).toEqual([{ kind: "markdown", text: "| lone |" }]);
    expect(guide.querySelector("ol li")).not.toBeNull();
    // A step after interleaved bullets keeps its source number.
    for (const item of guide.querySelectorAll("ol li")) expect(Number(item.getAttribute("value"))).toBeGreaterThan(0);
    expect([...guide.querySelectorAll("ol li")].some((item) => item.getAttribute("value") === "4")).toBe(true);
    expect(markdownBlocks("1. One\n- note\n2. Two")).toEqual([
      { kind: "ordered", items: [{ number: 1, text: "One" }] },
      { kind: "markdown", text: "- note" },
      { kind: "ordered", items: [{ number: 2, text: "Two" }] },
    ]);
    expect(markdownBlocks("Steps:\n1. File the charge.\n\n2) Serve it.\nDone.")).toEqual([
      { kind: "markdown", text: "Steps:" },
      { kind: "ordered", items: [{ number: 1, text: "File the charge." }, { number: 2, text: "Serve it." }] },
      { kind: "markdown", text: "Done." },
    ]);
  });

  it("never prints the source library's repository coordinates in a source line", async () => {
    const { container } = renderLibrary();
    await screen.findByRole("heading", { name: "Laws and agencies" });
    await setDisclosureOpen(screen.getByText("Open the guides").closest("details"), true);
    await waitFor(() => expect(container.querySelector("#rights-doc-worker-guide")).not.toBeNull());
    for (const details of container.querySelectorAll("details")) if (!details.open) await setDisclosureOpen(details, true);
    expect(container.querySelectorAll(".source-line").length).toBeGreaterThan(50);
    expect(container.textContent).not.toMatch(/solidground\//i);
    expect(forbiddenIdentityTokensIn(container.textContent)).toEqual([]);
  });

  // UX-UG-RIGHTS-LIBRARY-AGENCY-EXCERPT-DEADLINE-NOTE-20261022
  it("shows the library's own labelled note beside OSHA's verbatim excerpt, linking the corrected cards", async () => {
    const { container } = renderLibrary();
    await screen.findByRole("heading", { name: "Laws and agencies" });
    const oshaPages = container.querySelector("#rights-agency-osha .rights-library__pages");
    await setDisclosureOpen(oshaPages, true);
    await waitFor(() => expect(container.querySelector("#rights-doc-10-osha")).not.toBeNull());
    const page = container.querySelector("#rights-doc-10-osha");
    const note = within(page).getByRole("complementary", { name: "Note from the Union Ground library" });
    expect(note).toHaveTextContent("This is OSHA's own page, shown as OSHA publishes it.");
    expect(note).toHaveTextContent("within 30 days of when you are told of the action");
    expect(note.querySelector(".source-line")).not.toBeNull();
    const links = within(note.querySelector("ul")).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["#rights-deadline-osha-whistleblower", "#rights-deadline-osha-safety-complaint"]);
    expect(links.map((link) => link.textContent)).toEqual([
      "Safety retaliation complaint to OSHA (OSH Act section 11(c))",
      "Limit on OSHA citations: six months after the violation",
    ]);
    for (const link of links) expect(container.querySelector(link.getAttribute("href"))).not.toBeNull();
    // The agency's own text is unchanged, and the note sits outside it.
    const body = page.querySelector(".rights-library__doc");
    expect(body).toHaveTextContent("Filing deadline is 30-180 days (deadlines vary with each statute)");
    expect(body.contains(note)).toBe(false);
    // Only the excerpt that needs it carries a note.
    expect(container.querySelectorAll(".rights-library__note")).toHaveLength(1);
  });

  it("renders a mailbox split into an https link as plain text and keeps the verified mailbox on the card", async () => {
    expect(demoteMailboxLinks("email [box@](mailto:box@mass.gov) [mass.gov](https://www.mass.gov/box%40mass.gov) or [form](https://www.mass.gov/forms/x)"))
      .toBe("email [box@](mailto:box@mass.gov) mass.gov or [form](https://www.mass.gov/forms/x)");
    expect(demoteMailboxLinks(null)).toBe("");
    const { container } = renderLibrary();
    await screen.findByRole("heading", { name: "Laws and agencies" });
    await setDisclosureOpen(container.querySelector("#rights-agency-ma-dls .rights-library__pages"), true);
    await waitFor(() => expect(container.querySelector("#rights-doc-04-dls-report-public-worksite-accident")).not.toBeNull());
    const page = container.querySelector("#rights-doc-04-dls-report-public-worksite-accident");
    expect(page.querySelector('a[href*="%40"], a[href^="https://"][href*="@"]')).toBeNull();
    expect(page.querySelector(".rights-library__doc")).toHaveTextContent("safepublicworkplacemailbox@");
    expect(container.querySelector('#rights-agency-ma-dls a[href="mailto:safepublicworkplacemailbox@mass.gov"]')).not.toBeNull();
  });

  it("dials the base number and keeps an extension in the visible text", async () => {
    const { container } = renderLibrary();
    await screen.findByRole("heading", { name: "Laws and agencies" });
    const link = screen.getByRole("link", { name: "(508) 616-0461 ext. 1" });
    expect(link).toHaveAttribute("href", "tel:5086160461");
    for (const tel of container.querySelectorAll('a[href^="tel:"]')) expect(tel.getAttribute("href")).toMatch(/^tel:\+?\d{10,11}$/);
  });

  it("says so when the documents cannot load, and lets the member try again", async () => {
    const loadDocuments = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(documents);
    const { container } = renderLibrary({ loadDocuments });
    await screen.findByRole("heading", { name: "Laws and agencies" });
    const guides = container.querySelectorAll(".rights-library__pages");
    const last = guides[guides.length - 1];
    await setDisclosureOpen(last, true);
    await waitFor(() => expect(last.querySelector("[role=alert]")?.textContent).toBe("The library could not be loaded. Try again later or talk to your committee contact. Try again"));
    await setDisclosureOpen(last, false);
    await setDisclosureOpen(last, true);
    await waitFor(() => expect(loadDocuments).toHaveBeenCalledTimes(2));
    expect(await within(last).findByText("Committee cheat sheet", { selector: "summary" })).toBeInTheDocument();
  });

  // #9890 (W5-15 of #9459): the failures said so with no way to try again
  // short of closing the panel or reloading the page.

  it("offers Try again when the agencies cannot load, in English and Spanish, and reruns the read", async () => {
    const loadAgencies = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(agencies);
    renderLibrary({ loadAgencies });
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Laws and agencies" })).toBeInTheDocument();
    expect(loadAgencies).toHaveBeenCalledTimes(2);
    renderLibrary({ lang: "es", loadAgencies: vi.fn().mockRejectedValue(new Error("offline")) });
    expect(await screen.findByRole("button", { name: "Intentar de nuevo" })).toBeInTheDocument();
  });

  it("starts one load per open, and a failed load keeps its alert until the member reopens", async () => {
    const loadDocuments = vi.fn().mockRejectedValue(new Error("offline"));
    const { container } = renderLibrary({ loadDocuments });
    await screen.findByRole("heading", { name: "Laws and agencies" });
    const guides = container.querySelectorAll(".rights-library__pages");
    const last = guides[guides.length - 1];
    await setDisclosureOpen(last, true);
    // A second toggle event used to start a second load after the failure.
    await settleQueuedTasks();
    expect(loadDocuments).toHaveBeenCalledTimes(1);
    expect(within(last).getByText(/^The library could not be loaded\./u)).toHaveAttribute("role", "alert");
  });

  it("refuses a file of the wrong shape and shows the failure", async () => {
    expect(() => assertAgencies({ ...agencies, schema: "other" })).toThrow(/refused/);
    expect(() => assertDocuments({ schema: documents.schema, documents: null, source_records: [] })).toThrow(/refused/);
    renderLibrary({ loadAgencies: vi.fn().mockRejectedValue(new Error("refused")) });
    expect(await screen.findByRole("alert")).toHaveTextContent("The library could not be loaded.");
  });

  it("keeps Spanish chrome and says the content is in English", async () => {
    renderLibrary({ lang: "es", onAskSteward: vi.fn() });
    expect(await screen.findByRole("heading", { name: "Leyes y agencias" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Habla con tu contacto del comité" })).toBeInTheDocument();
    expect(screen.getByText("El contenido de esta biblioteca solo está disponible en inglés por ahora.")).toBeInTheDocument();
    // Spanish headings are not marked English; the English content is.
    expect(screen.getByRole("heading", { name: "Agencias" }).closest("[lang='en']")).toBeNull();
    expect(screen.getByText(agencies.disclaimer)).toHaveAttribute("lang", "en");
    expect(screen.getByRole("heading", { name: new RegExp(agencies.agencies[0].name) })).toHaveAttribute("lang", "en");
  });
});
