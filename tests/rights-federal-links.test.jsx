// REQ-UG-RIGHTS-LIBRARY-FEDERAL-TEXT-TO-OFFICIAL-LINKS-20261110: the
// rights library lists the 13 federal acts and 36 regulation parts one line
// each, with a link to the official text, and no longer carries the text.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { RightsLawLibrary } from "../src/features/rightsLibrary/RightsLawLibrary.jsx";
import { setDisclosureOpen, settleQueuedTasks } from "./helpers/disclosure.js";
import { assertFederalIndex, assertRegulationsIndex } from "../src/features/rightsLibrary/rightsLawLibrary.js";
import { validateDocument } from "../scripts/lib/provenance.mjs";

const dir = "data/reference/labor-rights";
const read = (name) => JSON.parse(readFileSync(resolve(process.cwd(), dir, name), "utf8"));
const agencies = read("agencies.json");
const documents = read("documents.json");
const law = read("federal-law/index.json");
const regulations = read("federal-regulations/index.json");

describe("federal acts and regulation parts as official links", () => {
  it("lists the 13 acts and 36 parts, each with its name, citation and official link", () => {
    expect(assertFederalIndex(law).acts).toHaveLength(13);
    expect(assertRegulationsIndex(regulations).parts).toHaveLength(36);
    for (const item of law.acts) {
      expect(Object.keys(item).sort()).toEqual(["abbreviation", "citation", "id", "name", "provenance", "url"]);
      expect(item.url).toMatch(/^https:\/\/uscode\.house\.gov\/us\/usc\/t\d+\/s[0-9a-z]+\/$/u);
    }
    for (const item of regulations.parts) {
      expect(Object.keys(item).sort()).toEqual(["act", "citation", "heading", "id", "provenance", "url"]);
      expect(item.url).toMatch(/^https:\/\/www\.ecfr\.gov\/current\/title-\d+\/part-\d+$/u);
      expect(law.acts.some((statute) => statute.id === item.act)).toBe(true);
    }
    for (const file of [law, regulations]) expect(validateDocument(file)).toMatchObject({ ok: true, errors: [] });
  });

  it("ships no act or regulation text and no file that only served it", () => {
    expect(readdirSync(resolve(process.cwd(), dir, "federal-law"))).toEqual(["index.json"]);
    expect(readdirSync(resolve(process.cwd(), dir, "federal-regulations"))).toEqual(["index.json"]);
    for (const script of ["scripts/build-federal-law-library.mjs", "scripts/build-federal-regulations-library.mjs"]) {
      expect(existsSync(resolve(process.cwd(), script))).toBe(false);
    }
    const loader = readFileSync(resolve(process.cwd(), "src/features/rightsLibrary/rightsLawLibrary.js"), "utf8");
    expect(loader).not.toMatch(/federal-law\/acts|federal-regulations\/parts/u);
  });
});

function renderLibrary({ lang = "en", loadFederalIndex = vi.fn().mockResolvedValue(law), loadRegulations = vi.fn().mockResolvedValue(regulations) } = {}) {
  render(
    <LanguageProvider lang={lang}>
      <RightsLawLibrary loadAgencies={vi.fn().mockResolvedValue(agencies)} loadDocuments={vi.fn().mockResolvedValue(documents)}
        loadFederalIndex={loadFederalIndex} loadRegulations={loadRegulations} />
    </LanguageProvider>,
  );
  return { loadFederalIndex, loadRegulations };
}

describe("the federal law section", () => {
  it("loads nothing until opened, then shows one linked line per act with its regulation parts", async () => {
    const { loadFederalIndex, loadRegulations } = renderLibrary();
    expect(await screen.findByRole("heading", { name: "Federal laws and regulations" })).toBeInTheDocument();
    expect(loadFederalIndex).not.toHaveBeenCalled();
    await setDisclosureOpen(screen.getByText("Open the federal laws", { selector: "summary" }).closest("details"), true);
    const nlra = (await screen.findByText("National Labor Relations Act (NLRA), 29 U.S.C. §§ 151–169.")).closest("li");
    expect(within(nlra).getByRole("link", { name: "Read it in the official U.S. Code" })).toHaveAttribute("href", "https://uscode.house.gov/us/usc/t29/s151/");
    const parts = await within(nlra).findByRole("list", { name: "Regulations" });
    const part101 = within(parts).getByText(/^29 CFR part 101, /u).closest("li");
    expect(within(part101).getByRole("link", { name: "Read it in the official eCFR" })).toHaveAttribute("href", "https://www.ecfr.gov/current/title-29/part-101");
    expect(screen.getAllByRole("link", { name: "Read it in the official U.S. Code" })).toHaveLength(13);
    expect(screen.getAllByRole("link", { name: "Read it in the official eCFR" })).toHaveLength(36);
    expect(loadFederalIndex).toHaveBeenCalledTimes(1);
    expect(loadRegulations).toHaveBeenCalledTimes(1);
  });

  // G7 review of #8085 (P2): an act is never listed with an empty part list
  // while the regulations index is loading or after it failed.
  it("stays on the loading line until the regulations index is in, then lists everything", async () => {
    let resolveRegulations;
    const loadRegulations = vi.fn(() => new Promise((resolve) => { resolveRegulations = resolve; }));
    const { loadFederalIndex } = renderLibrary({ loadRegulations });
    await screen.findByRole("heading", { name: "Federal laws and regulations" });
    const panel = screen.getByText("Open the federal laws", { selector: "summary" }).closest("details");
    await setDisclosureOpen(panel, true);
    await waitFor(() => expect(loadFederalIndex).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(within(panel).getByText("Loading the library…")).toHaveAttribute("aria-busy", "true");
    expect(within(panel).queryByRole("link")).toBeNull();
    await act(async () => { resolveRegulations(regulations); });
    expect(await within(panel).findAllByRole("link", { name: "Read it in the official eCFR" })).toHaveLength(36);
    expect(within(panel).getAllByRole("link", { name: "Read it in the official U.S. Code" })).toHaveLength(13);
  });

  it("says the library could not be loaded when the regulations index fails, and retries on reopening", async () => {
    const loadRegulations = vi.fn().mockRejectedValue(new Error("chunk failed"));
    renderLibrary({ loadRegulations });
    await screen.findByRole("heading", { name: "Federal laws and regulations" });
    const panel = screen.getByText("Open the federal laws", { selector: "summary" }).closest("details");
    await setDisclosureOpen(panel, true);
    const alert = await within(panel).findByText(/^The library could not be loaded\./u, {}, { timeout: 4000 });
    expect(alert).toHaveAttribute("role", "alert");
    expect(within(panel).queryByRole("link")).toBeNull();
    const failedCalls = loadRegulations.mock.calls.length;
    loadRegulations.mockResolvedValue(regulations);
    await setDisclosureOpen(panel, false);
    await setDisclosureOpen(panel, true);
    expect(await within(panel).findAllByRole("link", { name: "Read it in the official eCFR" })).toHaveLength(36);
    expect(loadRegulations.mock.calls.length).toBeGreaterThan(failedCalls);
  });

  it("starts one load per open, and a failed load keeps its alert until the member reopens", async () => {
    const loadRegulations = vi.fn().mockRejectedValue(new Error("chunk failed"));
    const { loadFederalIndex } = renderLibrary({ loadRegulations });
    await screen.findByRole("heading", { name: "Federal laws and regulations" });
    const panel = screen.getByText("Open the federal laws", { selector: "summary" }).closest("details");
    await setDisclosureOpen(panel, true);
    // A second toggle event used to start a second load here and flip the
    // failure paragraph back to loading, dropping role="alert" (#8315 CI).
    await settleQueuedTasks();
    expect(loadFederalIndex).toHaveBeenCalledTimes(1);
    expect(loadRegulations).toHaveBeenCalledTimes(1);
    expect(within(panel).getByText(/^The library could not be loaded\./u)).toHaveAttribute("role", "alert");
  });

  it("names the section in Spanish", async () => {
    renderLibrary({ lang: "es" });
    expect(await screen.findByRole("heading", { name: "Leyes y reglamentos federales" })).toBeInTheDocument();
  });
});
