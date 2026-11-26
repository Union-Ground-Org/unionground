import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CASE_SEARCH_RPC } from "../src/features/cases/caseSearchApi.js";
import { SearchView } from "../src/views/SearchView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function renderSearch(overrides = {}) {
  const props = {
    data: fallbackData,
    onProfile: vi.fn(),
    onAssistant: vi.fn(),
    onOpenResult: vi.fn(),
    onAskCompass: vi.fn(),
    ...overrides,
  };
  const view = render(
    <LanguageProvider lang={overrides.lang || "en"}>
      <SearchView {...props} />
    </LanguageProvider>,
  );
  props.unmount = view.unmount;
  return props;
}

describe("SearchView", () => {
  const member = { id: "member-1", organizationId: "org-1", chapterId: "chapter-1" };
  const structure = {
    organizationId: "org-1", chapterId: "chapter-1", charts: [{ chartKind: "union", nodes: [
      { id: "officer-1", nodeKind: "person", label: "Dolores Whitcombe", subtitle: "President", chapterId: "chapter-1" },
    ], edges: [] }],
  };

  it.each([
    ["en", "overtime", "Overtime"],
    ["es", "reunion", "Reunión"],
  ])("shows a whole-word excerpt around a late broadcast match in %s", (lang, query, match) => {
    const broadcast = {
      id: "fictional-briefing",
      title: "Fictional chapter briefing",
      body: "Earlier context. ".repeat(20) + "The committee released a summary after the vote. "
        + match + " for the chapter. " + "Later context. ".repeat(20),
    };
    const { onOpenResult } = renderSearch({ lang, data: { broadcasts: [broadcast] } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
    const result = screen.getByRole("button", { name: /Fictional chapter briefing/ });
    const excerpt = within(result).getByText(match, { selector: "mark" }).closest("small");
    expect(excerpt.textContent).toMatch(/^…\S.*\S…$/);
    const words = excerpt.textContent.slice(1, -1);
    const start = broadcast.body.indexOf(words);
    expect(start).toBeGreaterThan(0);
    expect(broadcast.body[start - 1]).toMatch(/\s/);
    expect(broadcast.body[start + words.length]).toMatch(/\s/);
    expect(excerpt).toHaveStyle({ whiteSpace: "normal" });
    fireEvent.click(result);
    expect(onOpenResult).toHaveBeenCalledWith(expect.objectContaining({ broadcastId: broadcast.id }));
  });

  it("caps one oversized token around a late accented match", () => {
    const body = "á".repeat(600) + "Reunión" + "é".repeat(600);
    renderSearch({ data: { broadcasts: [{ id: "long", title: "Long chapter briefing", body }] } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "reunion" } });
    const result = screen.getByRole("button", { name: /Long chapter briefing/ });
    const excerpt = result.querySelector("small");
    expect(excerpt.textContent).toMatch(/^…[^…]+…$/);
    expect(Array.from(excerpt.textContent).length).toBeLessThanOrEqual(240);
    expect(excerpt.querySelector("mark")).toHaveTextContent("Reunión");
  });

  it("keeps a short excerpt whole without ellipses", () => {
    const body = "Overtime applies on Saturday.";
    renderSearch({ data: { broadcasts: [{ id: "short", title: "Short chapter briefing", body }] } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "overtime" } });
    const excerpt = screen.getByRole("button", { name: /Short chapter briefing/ }).querySelector("small");
    expect(excerpt.textContent).toBe(body);
  });

  it("shows a title-only result without an absent excerpt", () => {
    renderSearch({ data: { broadcasts: [{ id: "missing", title: "Title-only briefing" }] } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "briefing" } });
    const result = screen.getByRole("button", { name: "Title-only briefing" });
    expect(result.querySelector("small")).toBeNull();
  });

  it.each([
    ["en", ["Draft", "Submitted — in review", "In review", "Approved", "Returned"]],
    ["es", ["Borrador", "Enviado — en revisión", "En revisión", "Aprobado", "Devuelto"]],
  ])("shows each form status once in %s", (lang, labels) => {
    const states = ["draft", "submitted", "in_review", "approved", "returned"];
    const forms = states.map(status => ({
      id: status, templateKey: "fictional_grievance", status,
      reviewNote: lang === "es" && status === "submitted" ? status : "",
    }));
    renderSearch({ lang, data: { forms } });
    for (const [index, status] of states.entries()) {
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: status } });
      const result = screen.getByRole("button", { name: /fictional grievance/ });
      expect(within(result).getByText(labels[index], { exact: true })).toBeVisible();
      expect(result.querySelector("small")).toBeNull();
    }
  });

  it("keeps a reviewer’s distinct note next to the form status", () => {
    const form = { id: "fictional-form", templateKey: "fictional_grievance", status: "returned", reviewNote: "Please check the schedule." };
    renderSearch({ data: { forms: [form] } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "schedule" } });
    const result = screen.getByRole("button", { name: /fictional grievance/ });
    expect(within(result).getByText("schedule.", { selector: "mark" })).toBeVisible();
    expect(within(result).getByText("Returned", { exact: true })).toBeVisible();
  });

  // REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030: the
  // Requests page is a result only where its panel is drawn.
  it("offers the Requests page only when the panel is available", () => {
    const props = renderSearch({ data: { ...fallbackData, member }, memberRequestsAvailable: true });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "suggest an invitation" } });
    fireEvent.click(screen.getByRole("button", { name: /Requests/ }));
    expect(props.onOpenResult).toHaveBeenCalledWith({ view: "settings", path: "/m/settings/requests" });
    props.unmount();
    renderSearch({ data: { ...fallbackData, member } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "suggest an invitation" } });
    expect(screen.queryByRole("button", { name: /Requests/ })).toBeNull();
  });

  it.each([["fails", false], ["arrives", true]])("ignores a people or leadership load that %s after the page closed", async (_label, succeeds) => {
    const people = deferred();
    const leadership = deferred();
    const peopleRpc = vi.fn(() => people.promise);
    const leadershipRpc = vi.fn(() => leadership.promise);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const props = renderSearch({
      data: { ...fallbackData, member },
      organizationStructureClient: { rpc: peopleRpc },
      chapterLeadershipClient: { rpc: leadershipRpc },
    });
    await waitFor(() => expect(peopleRpc).toHaveBeenCalled());
    await waitFor(() => expect(leadershipRpc).toHaveBeenCalled());
    props.unmount();
    if (succeeds) {
      people.resolve({ data: structure, error: null });
      leadership.resolve({ data: [], error: null });
    } else {
      people.reject(new Error("offline"));
      leadership.reject(new Error("offline"));
    }
    await new Promise((settle) => setTimeout(settle, 0));
    // A closed page sets no state, so React reports no update on an unmounted view.
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("opens Voting from a keyboard-accessible page result", () => {
    const props = renderSearch();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "voting" } });
    const result = screen.getByRole("button", { name: /Voting/ });
    result.focus();
    expect(result).toHaveFocus();
    fireEvent.click(result);
    expect(props.onOpenResult).toHaveBeenCalledWith({ view: "voting", path: "/m/voting" });
  });

  // Union Ground has no contract yet: search offers no contract clauses,
  // dues, civic action or union catalog page.
  it.each(["contract clauses", "clauses", "dues", "civic", "find your union", "procedures", "arbitration"])("offers no removed page for %s", (query) => {
    const props = renderSearch();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
    expect(screen.queryByRole("button", { name: /^(Contract clauses|Cláusulas|Dues|Civic|Find your union|Procedures|Arbitration)/i })).not.toBeInTheDocument();
    for (const button of screen.queryAllByRole("button")) fireEvent.click(button);
    for (const [target] of props.onOpenResult.mock.calls) {
      expect(target.path ?? "").not.toMatch(/^\/m\/(clauses|dues|civic|unions|procedures|arbitration)\b/);
      expect(["clauses", "dues", "civic", "unionCatalog", "procedures"]).not.toContain(target.view);
    }
  });

  it.each([["en", "People"], ["es", "Personas"]])("loads and labels the member-visible officer projection in %s", async (lang, label) => {
    const rpc = vi.fn().mockResolvedValue({ data: structure, error: null });
    const props = renderSearch({ lang, data: { ...fallbackData, member }, organizationStructureClient: { rpc } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "dolores" } });
    const result = await screen.findByRole("button", { name: /Dolores Whitcombe/ });
    expect(rpc).toHaveBeenCalledWith("get_member_organization_structure");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
    fireEvent.click(result);
    expect(props.onOpenResult).toHaveBeenCalledWith({ view: "orgStructure", path: "/m/org-structure", nodeId: "officer-1" });
  });

  it.each([
    ["en", "Pages", "Searching people visible to you…", "People search could not be completed. Other results are still available."],
    ["es", "Páginas", "Buscando personas visibles para ti…", "No se pudo completar la búsqueda de personas. Los demás resultados siguen disponibles."],
  ])("translates page groups and accessible people loading/error states in %s", async (lang, pages, loading, error) => {
    let failLookup;
    const rpc = vi.fn(() => new Promise((_resolve, reject) => { failLookup = reject; }));
    renderSearch({ lang, data: { ...fallbackData, member }, organizationStructureClient: { rpc } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "vot" } });
    expect(screen.getByRole("heading", { name: pages })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(loading);
    failLookup(new Error("lookup unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent(error);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps page results usable and reports an officer lookup failure without a false empty result", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "lookup unavailable", code: "08006" } });
    renderSearch({ data: { ...fallbackData, member }, organizationStructureClient: { rpc } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "dolores" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("People search could not be completed");
    expect(screen.queryByText(/No matches for/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "voting" } });
    expect(screen.getByRole("button", { name: /Voting/ })).toBeEnabled();
  });

  it("retries a failed officer lookup on the next query and clears the error when it succeeds", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "lookup unavailable", code: "08006" } })
      .mockResolvedValueOnce({ data: structure, error: null });
    renderSearch({ data: { ...fallbackData, member }, organizationStructureClient: { rpc } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "dolo" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("People search could not be completed");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "dolores" } });
    expect(await screen.findByRole("button", { name: /Dolores Whitcombe/ })).toBeEnabled();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // REQ-UG-PAGE-LOADING-STALLS-20261030: a failed officer lookup now
  // offers Try again beside its error, without waiting for a query edit.
  it("retries a failed officer lookup from its Try again button", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "lookup unavailable", code: "08006" } })
      .mockResolvedValueOnce({ data: structure, error: null });
    renderSearch({ data: { ...fallbackData, member }, organizationStructureClient: { rpc } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "dolores" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("People search could not be completed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: /Dolores Whitcombe/ })).toBeEnabled();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // The complete chapter knowledge index has the same Try again.

  it("discards an old chapter's in-flight officer lookup before rendering another chapter", async () => {
    let finishOld;
    const rpc = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce({ data: { ...structure, chapterId: "chapter-2", charts: [] }, error: null });
    const client = { rpc };
    const props = { data: { ...fallbackData, member }, organizationStructureClient: client, onOpenResult: vi.fn(), onAskCompass: vi.fn() };
    const view = render(<LanguageProvider lang="en"><SearchView {...props} /></LanguageProvider>);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "dolores" } });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    view.rerender(<LanguageProvider lang="en"><SearchView {...props} data={{ ...fallbackData, member: { ...member, chapterId: "chapter-2" } }} /></LanguageProvider>);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    finishOld({ data: structure, error: null });
    await waitFor(() => expect(screen.getByText(/No matches for/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Dolores/ })).not.toBeInTheDocument();
  });
  it("shows the coverage hint until the member types", () => {
    renderSearch();
    expect(screen.getByText(/Search everything you have/)).toBeInTheDocument();
    expect(screen.queryByText(/No matches/)).not.toBeInTheDocument();
  });

  it("shows grouped results and hands the deep-link payload to the parent", () => {
    const props = renderSearch();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "card majority" } });
    // The seeded notification about the authorization-card majority matches.
    expect(screen.getByText("Notifications")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Authorization card majority/ }));
    expect(props.onOpenResult).toHaveBeenCalledWith(expect.objectContaining({ notifications: true }));
  });

  it("expands a knowledge-base article inline instead of navigating", () => {
    const props = renderSearch();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "non-work time" } });
    const group = screen.getByText("Knowledge base").closest("section");
    const kbResult = within(group).getByRole("button", { name: /You can talk about forming a union/ });
    fireEvent.click(kbResult);
    expect(document.querySelector(".search-article")).toHaveTextContent(/cannot legally spy/);
    expect(props.onOpenResult).not.toHaveBeenCalledWith(expect.objectContaining({ kb: expect.anything() }));
    // A second tap folds it back up.
    fireEvent.click(kbResult);
    expect(document.querySelector(".search-article")).toBeNull();
  });

  it("offers the Union Ground Guide hand-off with the member's query", () => {
    const props = renderSearch();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "telework schedule" } });
    fireEvent.click(screen.getByRole("button", { name: /Ask Union Ground Guide about/ }));
    expect(props.onAskCompass).toHaveBeenCalledWith("telework schedule");
  });

  it("says so when nothing matches", () => {
    renderSearch();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzznothing" } });
    expect(screen.getByText(/No matches for/)).toBeInTheDocument();
  });

  it("renders fully in Spanish", () => {
    renderSearch({ lang: "es" });
    expect(screen.getByText(/Busca en todo lo tuyo/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "section 7" } });
    expect(screen.getByText("Base de conocimiento")).toBeInTheDocument();
  });

  // #7015: search_member_cases returns the neutral type and step line in title
  // and no articles or headline; the case topic stays in the case record.
  it("merges a server-ranked case, shows it by reference and type, and deep-links with ?case=", async () => {
    const rpc = vi.fn((name) => {
      const builder = {
        abortSignal: vi.fn(() => builder),
        then(resolve, reject) {
          const result = name === CASE_SEARCH_RPC
            ? {
              data: [{
                case_id: "server-case-1",
                reference: "SG-2026-0101",
                title: "Grievance · Intake",
                case_type: "Grievance",
                articles: null,
                step: "Intake",
                status: "active",
                deadline: "2026-07-24",
                rank: 0.9,
                headline: null,
                headline_source: "update",
              }],
              error: null,
            }
            : { data: [], error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    });
    // The member's own case: only own cases open on /m/cases.
    const ownCase = { id: "server-case-1", reference: "SG-2026-0101", title: "Overtime pay withheld", type: "Grievance", step: "Intake", status: "active", updates: [] };
    const props = renderSearch({ caseSearchClient: { rpc }, data: { ...fallbackData, cases: [...fallbackData.cases, ownCase] } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "filing" } });
    expect(await screen.findByRole("status")).toHaveTextContent("Searching every issue you can access");
    expect(screen.queryByText(/No matches for/)).not.toBeInTheDocument();
    const result = await screen.findByRole("button", { name: /SG-2026-0101 · Grievance/ });
    expect(result.querySelector("mark")).toBeNull();
    expect(screen.queryByText(/Overtime pay withheld/)).not.toBeInTheDocument();
    fireEvent.click(result);
    expect(props.onOpenResult).toHaveBeenCalledWith(expect.objectContaining({
      view: "cases",
      path: "/m/cases?case=server-case-1",
      caseId: "server-case-1",
    }));
  });

  // Until 20261104080000 is applied (a web deploy can land before the
  // database's), the RPC still sends the topic as title and a marked headline.
  // The row is still named by reference and type, and the snippet stays
  // React text and marks, never HTML.
  it("names a row from a not-yet-migrated search by type, and renders its snippet as text marks", async () => {
    const rpc = vi.fn((name) => {
      const builder = {
        abortSignal: vi.fn(() => builder),
        then(resolve, reject) {
          const data = name === CASE_SEARCH_RPC ? [{
            case_id: "legacy-case-1", reference: "SG-2026-0301", title: "Overtime pay withheld",
            case_type: "Discipline", articles: "Article 12 overtime", step: "Step 1", status: "active",
            deadline: null, rank: 0.9, headline: "The steward [[filed]] <b>the</b> paperwork.", headline_source: "update",
          }] : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    });
    const ownCase = { id: "legacy-case-1", reference: "SG-2026-0301", title: "Overtime pay withheld", type: "Discipline", step: "Step 1", status: "active", updates: [] };
    renderSearch({ caseSearchClient: { rpc }, data: { ...fallbackData, cases: [...fallbackData.cases, ownCase] } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "filing" } });
    const result = await screen.findByRole("button", { name: /SG-2026-0301 · Discipline/ });
    await waitFor(() => expect(result.querySelector("mark")).toHaveTextContent("filed"));
    expect(result.querySelector("b")).toBeNull();
    expect(result).toHaveTextContent("<b>the</b> paperwork.");
    expect(screen.queryByText(/Overtime pay withheld/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Article 12 overtime|Discipline · Step 1/)).not.toBeInTheDocument();
  });

  it("reports a case-search failure without claiming that the query has no matches", async () => {
    const rpc = vi.fn(() => {
      const builder = {
        abortSignal: vi.fn(() => builder),
        then(resolve, reject) {
          return Promise.resolve({ data: null, error: { message: "search unavailable", code: "08006" } }).then(resolve, reject);
        },
      };
      return builder;
    });
    renderSearch({ caseSearchClient: { rpc }, data: { ...fallbackData, cases: [] } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing grievance" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Issue search could not be completed");
    expect(screen.queryByText(/No matches for/)).not.toBeInTheDocument();
  });

  it("retains local destinations during a case-search failure and recovers without exposing unopenable cases", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "temporarily unavailable", code: "08006" } })
      .mockResolvedValueOnce({ data: [
        { case_id: "own-contract", reference: "SG-1", title: "Grievance · Intake", case_type: "Grievance", step: "Intake", headline: null, headline_source: "update" },
        { case_id: "other-case", reference: "SG-2", title: "Grievance · Intake", case_type: "Grievance", step: "Intake", headline: null, headline_source: "update" },
      ], error: null });
    const props = renderSearch({ caseSearchClient: { rpc }, data: { ...fallbackData, cases: [
      { id: "own-contract", reference: "SG-1", title: "Contract overtime", type: "Grievance", step: "Intake", updates: [] },
    ] } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "contract" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Local results are still available");
    expect(screen.queryByRole("button", { name: /Contract clauses/ })).not.toBeInTheDocument();
    // The owner's own topic still finds the case locally; the row shows only
    // reference and type.
    fireEvent.click(screen.getByRole("button", { name: /SG-1 · Grievance/ }));
    expect(props.onOpenResult).toHaveBeenCalledWith(expect.objectContaining({ path: "/m/cases?case=own-contract" }));
    // This stemmed note query cannot match the local snapshot. Recovery must
    // come through the server, and still respect the member destination set.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "filing" } });
    const recovered = await screen.findByRole("button", { name: /SG-1 · Grievance/ });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /SG-2 ·/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Contract overtime|Grievance · Intake/)).not.toBeInTheDocument();
    fireEvent.click(recovered);
    expect(props.onOpenResult).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/m/cases?case=own-contract" }));
  });

  // BUG-UG-WEB-MEMBER-SEARCH-LISTS-UNOPENABLE-CASES-20261003: a steward
  // on the member hat saw caseload cases that then opened as unavailable,
  // because search_member_cases also returns staff-visible cases.
  it("lists only the member's own server cases, so every listed case opens", async () => {
    const row = (caseId, reference) => ({
      case_id: caseId, reference, title: "Grievance · Intake", case_type: "Grievance", articles: null,
      step: "Intake", status: "active", deadline: null, rank: 0.5,
      headline: null, headline_source: "update",
    });
    const rpc = vi.fn((name) => {
      const builder = {
        abortSignal: vi.fn(() => builder),
        then(resolve, reject) {
          const data = name === CASE_SEARCH_RPC
            // Better-ranked caseload rows come first; the member's own case
            // must still be found behind them.
            ? [row("caseload-case-9", "SG-2026-0909"), row("own-case-1", "SG-2026-0201")]
            : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    });
    const ownCase = { id: "own-case-1", reference: "SG-2026-0201", title: "My overtime claim", type: "Grievance", step: "Intake", status: "active", updates: [] };
    const props = renderSearch({ caseSearchClient: { rpc }, data: { ...fallbackData, cases: [ownCase] } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "overtime" } });
    const own = await screen.findByRole("button", { name: /SG-2026-0201 · Grievance/ });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith(CASE_SEARCH_RPC, expect.anything()));
    expect(screen.queryByRole("button", { name: /SG-2026-0909/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/My overtime claim/)).not.toBeInTheDocument();
    // The search asks for the RPC's full 50 rows, so staff rows cannot crowd
    // an own case out of a small page before it is filtered.
    expect(rpc).toHaveBeenCalledWith(CASE_SEARCH_RPC, expect.objectContaining({ p_limit: 50 }));
    fireEvent.click(own);
    expect(props.onOpenResult).toHaveBeenCalledWith(expect.objectContaining({ path: "/m/cases?case=own-case-1", caseId: "own-case-1" }));
  });
});
