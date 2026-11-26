// REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030:
// a steward preparing a shift bid had nowhere in Steward tools to keep or
// check a seniority list or track the bid, so the deadline passed untracked.
// These pin the staff list, the member picker, the import preview, bids with
// seniority beside them and awards, the bid deadlines, and a member's own
// entry with its question, in English and Spanish.
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { t } from "../src/lib/i18n.js";
import { act } from "@testing-library/react";
import { BIDS_CHANGED_EVENT, bidWindowAcceptsBids, createSeniorityApi, notifyBidsChanged, parseSeniorityFile, upcomingBidDeadlines } from "../src/features/seniority/api.js";
import { BidDeadlines, SeniorityChapterScope, SeniorityPanel, seniorityOrganizationWide } from "../src/features/seniority/SeniorityPanel.jsx";
import { MySeniorityCard } from "../src/features/seniority/MySeniorityCard.jsx";
import { seniorityCatalogue } from "../src/lib/i18n/seniority.js";
import { SettingsView } from "../src/views/SettingsView.jsx";

const tEn = (key, vars) => t("en", key, vars);
const NOW = Date.parse("2026-10-30T22:00:00Z");

const LIST = {
  items: [
    { id: "e1", userId: "u1", name: "Ana Senior", position: 1, seniorityDate: "2008-01-15", classification: "Operator", tieBreakNote: null, question: { status: "open", note: "My start date was January 8." } },
    { id: "e2", userId: "u2", name: "Ben Middle", position: 2, seniorityDate: "2012-06-29", classification: null, tieBreakNote: "Badge 114", question: { status: "answered", note: "?", answer: "Checked." } },
  ],
  nextCursor: { afterDate: "2012-06-29", afterId: "e2" },
  openQuestions: 1,
};
const WINDOWS = {
  total: 2,
  nextOffset: null,
  windows: [
    { id: "w1", subject: "November shift bid", opensAt: "2026-10-29T12:00:00Z", closesAt: "2026-11-02T12:00:00Z", status: "open",
      bids: [{ id: "b1", userId: "u1", name: "Ana Senior", choice: "Day run 12", award: null, seniorityDate: "2008-01-15" }, { id: "b2", userId: "u9", name: "Off List", choice: "Night 4", award: "Night 4", seniorityDate: null }] },
    { id: "w2", subject: "Old bid", opensAt: "2026-09-01T12:00:00Z", closesAt: "2026-09-05T12:00:00Z", status: "awarded", bids: [] },
  ],
};

function fakeApi(overrides = {}) {
  return {
    list: vi.fn(async (_chapter, cursor) => (cursor ? { items: [{ id: "e3", userId: "u3", name: "Cy Junior", position: 3, seniorityDate: "2019-04-01", question: null }], nextCursor: null, openQuestions: 1 } : LIST)),
    searchMembers: vi.fn(async () => [{ userId: "u3", name: "Cy Junior", listed: false }, { userId: "u1", name: "Ana Senior", listed: true }]),
    save: vi.fn(async () => ({ id: "e3" })),
    remove: vi.fn(async () => ({ deleted: true })),
    importRows: vi.fn(async (_chapter, rows, apply) => (apply
      ? { applied: true, saved: 1, rows: [] }
      : { applied: false, saved: 0, rows: [{ row: 1, outcome: "ready", name: "Ana Senior", seniorityDate: "2008-01-15" }, { row: 2, outcome: "no_member", name: null, seniorityDate: "2009-01-01" }] })),
    answer: vi.fn(async () => ({ status: "answered" })),
    listBids: vi.fn(async () => WINDOWS),
    deadlines: vi.fn(async () => WINDOWS.windows.filter((window) => window.status === "open")),
    saveWindow: vi.fn(async () => ({ id: "w3" })),
    recordBid: vi.fn(async () => ({ id: "b3" })),
    award: vi.fn(async () => ({ id: "b1" })),
    mine: vi.fn(async () => ({ entries: [], bids: [] })),
    question: vi.fn(async () => ({ status: "open" })),
    ...overrides,
  };
}

function panel(api = fakeApi(), lang = "en", now = NOW) {
  render(<LanguageProvider lang={lang}><SeniorityPanel api={api} chapterId="main" now={now} /></LanguageProvider>);
  return api;
}

afterEach(cleanup);

describe("the seniority list in Committee worker tools", () => {
  it("shows workers in seniority order with the visibility rule, open questions and more pages", async () => {
    const api = panel();
    expect(screen.getByText(tEn("seniority.rule"))).toBeInTheDocument();
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").slice(0, 3).map((cell) => cell.textContent))).toEqual([
      ["1", "Ana Senior", "Jan 15, 2008"],
      ["2", "Ben Middle", "Jun 29, 2012"],
    ]);
    expect(screen.getByText(tEn("seniority.openQuestions.one"))).toBeInTheDocument();
    expect(screen.getByText(tEn("seniority.questionAnswered", { answer: "Checked." }))).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: tEn("seniority.showMore") })[0]);
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith("main", LIST.nextCursor));
    expect(await screen.findByText("Cy Junior", { selector: "td" })).toBeInTheDocument();
  });

  it("answers a question and removes an entry", async () => {
    const api = panel();
    const answer = await screen.findByLabelText(tEn("seniority.answerLabel", { name: "Ana Senior" }));
    fireEvent.change(answer, { target: { value: "Corrected to January 8." } });
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.answerSave") }));
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith("e1", "Corrected to January 8."));
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.removeNamed", { name: "Ben Middle" }) }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("e2"));
  });

  // Record 8435, Nov 24 triage: the answer's Save was natively
  // disabled by its own write, so a keyboard user who pressed it lost focus.
  it("keeps focus on the answer's Save while it sends, and a second press sends nothing", async () => {
    const api = panel();
    const answer = await screen.findByLabelText(tEn("seniority.answerLabel", { name: "Ana Senior" }));
    fireEvent.change(answer, { target: { value: "Corrected to January 8." } });
    await expectHeldWriteFocus(api.answer, within(answer.closest("form")).getByRole("button", { name: tEn("seniority.answerSave") }));
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith("e1", "Corrected to January 8."));
  });

  it.each([
    ["en", "seniority.addTitle", "Worker search could not be loaded.", "No workers match this search."],
    ["es", "seniority.bidRecordTitle", "No se pudo cargar la búsqueda de trabajadores.", "Ningún trabajador coincide con esta búsqueda."],
  ])("explains a failed %s worker search and retries the same query", async (lang, heading, failure, empty) => {
    const searchMembers = vi.fn(async () => []);
    panel(fakeApi({ searchMembers }), lang);
    const form = within((await screen.findByRole("heading", { name: t(lang, heading) })).closest("form"));
    const input = form.getByRole("searchbox", { name: t(lang, "seniority.findMember") });
    const picker = form.getByRole("combobox", { name: t(lang, "seniority.member") });
    await waitFor(() => expect(input).not.toHaveAccessibleDescription());
    expect(form.queryByText(empty)).not.toBeInTheDocument();

    let offline = true;
    let noMatchResponse;
    searchMembers.mockImplementation(async (_chapterId, query) => {
      if (query === "No match") return noMatchResponse ?? [];
      if (query !== "Sam") return [];
      if (offline) throw new Error("offline fixture");
      return [{ userId: "sam", name: "Sam Rivera", listed: false }];
    });
    fireEvent.change(input, { target: { value: "Sam" } });

    expect(await form.findByText(failure)).toHaveAttribute("role", "status");
    expect(input).toHaveAccessibleDescription(failure);
    expect(form.queryByText(empty)).not.toBeInTheDocument();

    offline = false;
    const retry = form.getByRole("button", { name: t(lang, "seniority.retry") });
    retry.focus();
    fireEvent.click(retry);
    expect(input).toHaveFocus();
    expect(await within(picker).findByRole("option", { name: "Sam Rivera" })).toBeInTheDocument();
    expect(searchMembers).toHaveBeenLastCalledWith("main", "Sam");
    expect(input).toHaveValue("Sam");
    expect(form.queryByText(failure)).not.toBeInTheDocument();

    fireEvent.change(picker, { target: { value: "sam" } });
    let rejectSearch;
    noMatchResponse = new Promise((_, reject) => { rejectSearch = reject; });
    fireEvent.change(input, { target: { value: "No match" } });
    expect(await form.findByText(t(lang, "seniority.memberSearchLoading"))).toBeInTheDocument();
    expect(picker).toHaveValue("sam");
    expect(form.queryByText(empty)).not.toBeInTheDocument();
    rejectSearch(new Error("offline fixture"));
    noMatchResponse = null;
    expect(await form.findByText(failure)).toBeInTheDocument();
    expect(within(picker).queryByRole("option", { name: "Sam Rivera" })).not.toBeInTheDocument();

    fireEvent.click(form.getByRole("button", { name: t(lang, "seniority.retry") }));
    expect(await form.findByText(empty)).toBeInTheDocument();
    expect(form.queryByRole("button", { name: t(lang, "seniority.retry") })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(input).not.toHaveAccessibleDescription());
    expect(form.queryByText(empty)).not.toBeInTheDocument();
  });

  it("adds an entry for a worker picked by name", async () => {
    const api = panel();
    fireEvent.change(screen.getByLabelText(tEn("seniority.findMember")), { target: { value: "cy" } });
    await waitFor(() => expect(api.searchMembers).toHaveBeenLastCalledWith("main", "cy"));
    const form = screen.getByRole("heading", { name: tEn("seniority.addTitle") }).closest("form");
    const picker = within(form).getByLabelText(tEn("seniority.member"));
    await waitFor(() => expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toContain(`Ana Senior ${tEn("seniority.listed")}`));
    fireEvent.change(picker, { target: { value: "u3" } });
    fireEvent.change(screen.getByLabelText(tEn("seniority.date")), { target: { value: "2019-04-01" } });
    fireEvent.change(screen.getByLabelText(tEn("seniority.classification")), { target: { value: "Operator" } });
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.save") }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith("main", { userId: "u3", seniorityDate: "2019-04-01", classification: "Operator", tieBreakNote: "" }));
    expect(await screen.findByText(tEn("seniority.saved"))).toBeInTheDocument();
  });

  it("re-reads the bids after a seniority change, so bid cards follow the new order (gate r2)", async () => {
    const api = panel();
    await screen.findByText("November shift bid");
    const reads = api.listBids.mock.calls.length;
    fireEvent.click(await screen.findByRole("button", { name: tEn("seniority.removeNamed", { name: "Ben Middle" }) }));
    await waitFor(() => expect(api.listBids.mock.calls.length).toBeGreaterThan(reads));
  });

  it("keeps the newer bid read when an older one lands later (gate r3)", async () => {
    let releaseOld;
    const stale = { windows: [{ ...WINDOWS.windows[0], bids: [{ ...WINDOWS.windows[0].bids[0], name: "Stale Order" }] }], nextOffset: null };
    const api = fakeApi({
      listBids: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { releaseOld = () => resolve(stale); }))
        .mockImplementation(async () => WINDOWS),
    });
    panel(api);
    fireEvent.click(await screen.findByRole("button", { name: tEn("seniority.removeNamed", { name: "Ben Middle" }) }));
    expect(await screen.findByText("November shift bid")).toBeInTheDocument();
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale Order")).toBeNull();
  });

  it("shows a worker's own seniority in the alternate shell's Settings too (gate r2)", async () => {
    const api = fakeApi({ mine: vi.fn(async () => ({ entries: [{ id: "e1", chapterName: "Kinsey Central", seniorityDate: "2008-01-15", question: null }], bids: [] })) });
    window.history.replaceState({}, "", "/m/settings/profile");
    render(
      <LanguageProvider lang="en">
        <SettingsView alt data={{ member: { id: "u1", fullName: "Ana Senior", initials: "AS", chapterName: "Kinsey Central" }, roles: [], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } }}
          onNavigate={vi.fn()} onProfile={vi.fn()} onAssistant={vi.fn()} lang="en" onLanguage={vi.fn()} seniorityApi={api} />
      </LanguageProvider>,
    );
    expect(await screen.findByText(tEn("seniority.myEntry", { chapter: "Kinsey Central", date: "Jan 15, 2008" }))).toBeInTheDocument();
    window.history.replaceState({}, "", "/");
  });

  it("says so when a save is refused or the list cannot load", async () => {
    panel(fakeApi({ save: vi.fn(async () => { throw new Error("no"); }) }));
    const picker = within(screen.getByRole("heading", { name: tEn("seniority.addTitle") }).closest("form")).getByLabelText(tEn("seniority.member"));
    await waitFor(() => expect(within(picker).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(picker, { target: { value: "u3" } });
    fireEvent.change(screen.getByLabelText(tEn("seniority.date")), { target: { value: "2019-04-01" } });
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.save") }));
    expect(await screen.findByText(tEn("seniority.saveError"))).toBeInTheDocument();
    cleanup();
    panel(fakeApi({ list: vi.fn(async () => { throw new Error("down"); }), listBids: vi.fn(async () => { throw new Error("down"); }) }));
    expect((await screen.findAllByText(tEn("seniority.error"), { exact: false, selector: "p" })).length).toBe(2);
  });

  it("previews an import, lists each row's outcome, and saves only after confirming", async () => {
    const api = panel();
    const file = new File(["Email,Seniority date,Classification\nana@example.invalid,2008-01-15,Operator\nnobody@example.invalid,2009-01-01,\n"], "list.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => "Email,Seniority date,Classification\nana@example.invalid,2008-01-15,Operator\nnobody@example.invalid,2009-01-01,\n" });
    fireEvent.change(screen.getByLabelText(tEn("seniority.importFile")), { target: { files: [file] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.importPreview") }));
    await waitFor(() => expect(api.importRows).toHaveBeenCalledWith("main", [
      { email: "ana@example.invalid", seniorityDate: "2008-01-15", classification: "Operator", tieBreakNote: "" },
      { email: "nobody@example.invalid", seniorityDate: "2009-01-01", classification: "", tieBreakNote: "" },
    ], false));
    expect(await screen.findByText(tEn("seniority.outcome.no_member"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.importApply") }));
    expect(await screen.findByText(tEn("seniority.importApplied.one"))).toBeInTheDocument();
    expect(api.importRows).toHaveBeenLastCalledWith("main", expect.any(Array), true);
  });

  it("refuses a file over 500 rows instead of cutting it short (gate r1)", async () => {
    const api = panel();
    const body = ["Email,Seniority date", ...Array.from({ length: 501 }, (_, index) => `m${index}@example.invalid,2010-01-01`)].join("\n");
    expect(parseSeniorityFile(body)).toHaveLength(501);
    const file = new File([body], "big.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => body });
    fireEvent.change(screen.getByLabelText(tEn("seniority.importFile")), { target: { files: [file] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.importPreview") }));
    expect(await screen.findByText(tEn("seniority.importTooMany", { count: 501, max: 500 }))).toBeInTheDocument();
    expect(api.importRows).not.toHaveBeenCalled();
  });

  it("saves exactly the previewed rows, even if another file was chosen afterwards (review P2)", async () => {
    const api = panel();
    const pick = async (body) => {
      const file = new File([body], "list.csv", { type: "text/csv" });
      Object.defineProperty(file, "text", { value: async () => body });
      fireEvent.change(screen.getByLabelText(tEn("seniority.importFile")), { target: { files: [file] } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await pick("Email,Seniority date\na@example.invalid,2008-01-15\n");
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.importPreview") }));
    const confirm = await screen.findByRole("button", { name: tEn("seniority.importApply") });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.importRows).toHaveBeenLastCalledWith("main", [{ email: "a@example.invalid", seniorityDate: "2008-01-15", classification: "", tieBreakNote: "" }], true));
    // A file chosen while a preview is loading never borrows that preview.
    let release;
    api.importRows.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ applied: false, saved: 0, rows: [{ row: 1, outcome: "ready", name: "A", seniorityDate: "2008-01-15" }] }); }));
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.importPreview") }));
    await pick("Email,Seniority date\nb@example.invalid,2009-01-01\n");
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: tEn("seniority.importApply") })).toBeNull();
  });

  it("refuses an empty file before asking the server", async () => {
    const api = panel();
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.importPreview") }));
    expect(await screen.findByText(tEn("seniority.importEmpty"))).toBeInTheDocument();
    expect(api.importRows).not.toHaveBeenCalled();
  });
});

describe("bids", () => {
  //  (carved from): Show more bids was natively disabled while its own read
  // ran, so a keyboard user who pressed it lost focus to the page.
  it("keeps focus on Show more bids while the next bids load, and a second press reads nothing", async () => {
    const windows = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3 }, WINDOWS.windows[1]] };
    const bidPage = vi.fn(async () => ({ total: 3, nextOffset: null, bids: [{ id: "b501", userId: "u501", name: "Late Bidder", choice: "Weekend 2", award: null, seniorityDate: "2024-02-02" }] }));
    panel(fakeApi({ listBids: vi.fn(async () => structuredClone(windows)), bidPage }));
    const bid = (await screen.findByText("November shift bid")).closest("article");
    await expectHeldWriteFocus(bidPage, within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    await waitFor(() => expect(within(bid).getByText("Late Bidder", { selector: "strong" })).toBeInTheDocument());
  });

  // BUG-UG-BID-RECORDS-STALE-AWARD-AND-500-CAP-20261102 .
  it("pages a window's bids past the first page and awards a later bid where it is shown", async () => {
    const first = WINDOWS.windows[0].bids;
    const later = { id: "b501", userId: "u501", name: "Late Bidder", choice: "Weekend 2", award: null, seniorityDate: "2024-02-02" };
    const windows = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3 }, WINDOWS.windows[1]] };
    let awarded = false;
    const bidPage = vi.fn(async () => ({ total: 3, nextOffset: null, bids: [awarded ? { ...later, award: "Weekend 2" } : later] }));
    // Each read returns fresh objects, as the server does.
    const api = panel(fakeApi({ listBids: vi.fn(async () => structuredClone(windows)), bidPage, award: vi.fn(async () => { awarded = true; return { id: "b501" }; }) }));
    const bid = (await screen.findByText("November shift bid")).closest("article");
    expect(within(bid).getByText(tEn("seniority.bidsShown", { shown: first.length, count: 3 }))).toHaveAttribute("role", "status");
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    await waitFor(() => expect(within(bid).getByText("Late Bidder", { selector: "strong" })).toBeInTheDocument());
    expect(bidPage).toHaveBeenLastCalledWith("w1", first.length, 100);
    expect(within(bid).queryByRole("button", { name: tEn("seniority.bidsMore") })).toBeNull();
    fireEvent.change(within(bid).getByLabelText(tEn("seniority.awardLabel", { name: "Late Bidder" })), { target: { value: "Weekend 2" } });
    fireEvent.click(within(bid).getAllByRole("button", { name: tEn("seniority.awardSave") })[2]);
    await waitFor(() => expect(api.award).toHaveBeenCalledWith("b501", "Weekend 2"));
    // The refreshed first page re-reads the later page already shown.
    await waitFor(() => expect(bidPage).toHaveBeenLastCalledWith("w1", first.length, 1));
    expect(await within(bid).findByText(tEn("seniority.awarded", { award: "Weekend 2" }), { exact: false })).toBeInTheDocument();
  });

  // TEST-UG-CHAPTER-SENIORITY-BIDS-FLAKE-20261102: under the coverage
  // shard findByText resolved after the first page rendered but before the
  // window's mount effect ran, and that effect dropped the page Show more had
  // asked for. Click in that gap every time: a DOM observer runs before React
  // flushes the effects of a commit from a resolved read.
  it("keeps a page asked for before the window's mount effect runs", async () => {
    const later = { id: "b3", userId: "u3", name: "Cy Junior", choice: "Night 9", award: null, seniorityDate: "2019-04-01" };
    const windows = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3 }] };
    const bidPage = vi.fn(async () => ({ bids: [later] }));
    panel(fakeApi({ listBids: vi.fn(async () => structuredClone(windows)), bidPage }));
    const moreButton = () => [...document.querySelectorAll("article button")].find((button) => button.textContent === tEn("seniority.bidsMore"));
    await new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!moreButton()) return;
        observer.disconnect();
        fireEvent.click(moreButton());
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    expect(bidPage).toHaveBeenCalledWith("w1", 2, 100);
    const bid = screen.getByText("November shift bid").closest("article");
    await waitFor(() => expect(within(bid).getByText("Cy Junior", { selector: "strong" })).toBeInTheDocument());
    expect(moreButton()).toBeUndefined();
  });

  it("re-reads later pages from the new first page's end when a refresh reorders the bids (gate r1s1)", async () => {
    const [b1, b2] = WINDOWS.windows[0].bids;
    const b3 = { id: "b3", userId: "u3", name: "Cy Junior", choice: "Night 9", award: null, seniorityDate: "2019-04-01" };
    // Before: first page b1, b2 and b3 later. After a seniority change b3
    // sorts first, so the first page is b3, b1 and b2 moves to the later page.
    const before = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3, bids: [b1, b2] }] };
    const after = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3, bids: [b3, b1] }] };
    let reordered = false;
    const listBids = vi.fn(async () => structuredClone(reordered ? after : before));
    const bidPage = vi.fn(async () => ({ total: 3, nextOffset: null, bids: [reordered ? b2 : b3] }));
    panel(fakeApi({ listBids, bidPage }));
    const bid = (await screen.findByText("November shift bid")).closest("article");
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    await waitFor(() => expect(within(bid).getByText("Cy Junior", { selector: "strong" })).toBeInTheDocument());
    reordered = true;
    act(() => notifyBidsChanged("main"));
    await waitFor(() => expect(bidPage).toHaveBeenLastCalledWith("w1", 2, 1));
    await waitFor(() => expect(within(bid).getAllByRole("listitem").map((row) => row.querySelector("strong").textContent))
      .toEqual(["Cy Junior", "Ana Senior", "Off List"]));
  });

  it("keeps Show more off while a refresh re-reads later pages (gate r2s1)", async () => {
    const [b1, b2] = WINDOWS.windows[0].bids;
    const b3 = { id: "b3", userId: "u3", name: "Cy Junior", choice: "Night 9", award: null, seniorityDate: "2019-04-01" };
    const b4 = { id: "b4", userId: "u4", name: "Di Fourth", choice: "Day 2", award: null, seniorityDate: "2020-01-01" };
    const windows = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 4, bids: [b1, b2] }] };
    let release;
    const bidPage = vi.fn()
      .mockResolvedValueOnce({ bids: [b3] })
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ bids: [b3] }); }))
      .mockResolvedValue({ bids: [b4] });
    panel(fakeApi({ listBids: vi.fn(async () => structuredClone(windows)), bidPage }));
    const bid = (await screen.findByText("November shift bid")).closest("article");
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    await waitFor(() => expect(within(bid).getByText("Cy Junior", { selector: "strong" })).toBeInTheDocument());
    act(() => notifyBidsChanged("main"));
    await waitFor(() => expect(bidPage).toHaveBeenCalledTimes(2));
    const more = within(bid).getByRole("button", { name: tEn("seniority.bidsMore") });
    //  (carved from): unavailable while it reads, but still focusable (pending).
    expect(more).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(more);
    expect(bidPage).toHaveBeenCalledTimes(2);
    await act(async () => release());
    await waitFor(() => { expect(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") })).not.toBeDisabled(); expect((within(bid).getByRole("button", { name: tEn("seniority.bidsMore") })).closest('[aria-disabled="true"]')).toBeNull(); });
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    await waitFor(() => expect(within(bid).getByText("Di Fourth", { selector: "strong" })).toBeInTheDocument());
    expect(bidPage).toHaveBeenLastCalledWith("w1", 3, 100);
  });

  it("drops a later page that was requested before the first page refreshed (gate r2s2)", async () => {
    const [b1, b2] = WINDOWS.windows[0].bids;
    const b3 = { id: "b3", userId: "u3", name: "Cy Junior", choice: "Night 9", award: null, seniorityDate: "2019-04-01" };
    const before = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3, bids: [b1, b2] }] };
    const after = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3, bids: [b3, b1] }] };
    let reordered = false;
    let release;
    const bidPage = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ bids: [b3] }); }))
      .mockResolvedValue({ bids: [b2] });
    panel(fakeApi({ listBids: vi.fn(async () => structuredClone(reordered ? after : before)), bidPage }));
    const bid = (await screen.findByText("November shift bid")).closest("article");
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    await waitFor(() => expect(bidPage).toHaveBeenCalledTimes(1));
    reordered = true;
    act(() => notifyBidsChanged("main"));
    await waitFor(() => expect(within(bid).getAllByRole("listitem")[0]).toHaveTextContent("Cy Junior"));
    // The stale page (b3 again) settles after the refresh and is ignored.
    await act(async () => release());
    expect(within(bid).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    await waitFor(() => expect(within(bid).getAllByRole("listitem").map((row) => row.querySelector("strong").textContent))
      .toEqual(["Cy Junior", "Ana Senior", "Off List"]));
    expect(bidPage).toHaveBeenLastCalledWith("w1", 2, 100);
  });

  // TEST-UG-CHAPTER-SENIORITY-BIDS-REFRESH-GAP-FLAKE-20261107: under the
  // coverage shard the test above released the stale page after the refreshed
  // first page reached the DOM but before the window's refresh effect started
  // a new generation, so the stale page landed, hid as a duplicate of Cy Junior
  // and turned Show more off. Settle it in that gap every time: a DOM observer
  // runs before React flushes the passive effects of a commit from a resolved read.
  it("drops a later page that settles between the refreshed first page and its effects", async () => {
    const [b1, b2] = WINDOWS.windows[0].bids;
    const b3 = { id: "b3", userId: "u3", name: "Cy Junior", choice: "Night 9", award: null, seniorityDate: "2019-04-01" };
    const before = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3, bids: [b1, b2] }] };
    const after = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3, bids: [b3, b1] }] };
    let reordered = false;
    let release;
    const bidPage = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ bids: [b3] }); }))
      .mockResolvedValue({ bids: [b2] });
    panel(fakeApi({ listBids: vi.fn(async () => structuredClone(reordered ? after : before)), bidPage }));
    const bid = (await screen.findByText("November shift bid")).closest("article");
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    await waitFor(() => expect(bidPage).toHaveBeenCalledTimes(1));
    reordered = true;
    await new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (bid.querySelector("li strong")?.textContent !== "Cy Junior") return;
        observer.disconnect();
        release();
        resolve();
      });
      observer.observe(bid, { childList: true, subtree: true });
      notifyBidsChanged("main");
    });
    await waitFor(() => { expect(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") })).not.toBeDisabled(); expect((within(bid).getByRole("button", { name: tEn("seniority.bidsMore") })).closest('[aria-disabled="true"]')).toBeNull(); });
    expect(within(bid).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    await waitFor(() => expect(within(bid).getAllByRole("listitem").map((row) => row.querySelector("strong").textContent))
      .toEqual(["Cy Junior", "Ana Senior", "Off List"]));
    expect(bidPage).toHaveBeenLastCalledWith("w1", 2, 100);
  });

  it("drops the earlier later pages when their re-read fails, so paging restarts at the new first page's end (gate r3s1)", async () => {
    const [b1, b2] = WINDOWS.windows[0].bids;
    const b3 = { id: "b3", userId: "u3", name: "Cy Junior", choice: "Night 9", award: null, seniorityDate: "2019-04-01" };
    const before = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3, bids: [b1, b2] }] };
    const after = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3, bids: [b3, b1] }] };
    let reordered = false;
    const bidPage = vi.fn()
      .mockResolvedValueOnce({ bids: [b3] })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ bids: [b2] });
    panel(fakeApi({ listBids: vi.fn(async () => structuredClone(reordered ? after : before)), bidPage }));
    const bid = (await screen.findByText("November shift bid")).closest("article");
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    await waitFor(() => expect(within(bid).getByText("Cy Junior", { selector: "strong" })).toBeInTheDocument());
    reordered = true;
    act(() => notifyBidsChanged("main"));
    expect(await within(bid).findByRole("alert")).toHaveTextContent(tEn("seniority.bidsMoreError"));
    expect(within(bid).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    await waitFor(() => expect(within(bid).getAllByRole("listitem").map((row) => row.querySelector("strong").textContent))
      .toEqual(["Cy Junior", "Ana Senior", "Off List"]));
    expect(bidPage).toHaveBeenLastCalledWith("w1", 2, 100);
  });

  it("does not re-read later pages on unrelated form edits (gate r4s1)", async () => {
    const windows = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 3 }] };
    const later = { id: "b3", userId: "u3", name: "Cy Junior", choice: "Night 9", award: null, seniorityDate: "2019-04-01" };
    const bidPage = vi.fn(async () => ({ bids: [later] }));
    panel(fakeApi({ listBids: vi.fn(async () => structuredClone(windows)), bidPage }));
    const bid = (await screen.findByText("November shift bid")).closest("article");
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidsMore") }));
    const names = () => within(bid).getAllByRole("listitem").map((row) => row.querySelector("strong").textContent);
    await waitFor(() => expect(names()).toContain("Cy Junior"));
    fireEvent.change(screen.getByLabelText(tEn("seniority.bidSubject")), { target: { value: "December bid" } });
    fireEvent.change(within(bid).getByLabelText(tEn("seniority.bidChoice")), { target: { value: "Night 5" } });
    await act(async () => {});
    expect(bidPage).toHaveBeenCalledTimes(1);
    expect(names()).toEqual(["Ana Senior", "Off List", "Cy Junior"]);
  });

  it("re-reads more than 500 later bids in pages of at most 500 and keeps every row (gate r1s2)", async () => {
    const rows = (from, count) => Array.from({ length: count }, (_, index) => ({ id: `x${from + index}`, userId: `y${from + index}`, name: `Bidder ${from + index}`, choice: "Run", award: null, seniorityDate: null }));
    const windows = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 2 + 600 }] };
    const bidPage = vi.fn(async (_window, offset, limit) => ({ bids: rows(offset, Math.min(limit, 500, 602 - offset)) }));
    const api = panel(fakeApi({ listBids: vi.fn(async () => structuredClone(windows)), bidPage }));
    const bid = (await screen.findByText("November shift bid")).closest("article");
    // Plain DOM reads: role and label queries over 600 rows are too slow.
    const rowsShown = () => bid.querySelectorAll("ol > li").length;
    const moreButton = () => [...bid.querySelectorAll("button")].find((button) => button.textContent === tEn("seniority.bidsMore"));
    for (let index = 0; index < 6; index += 1) {
      fireEvent.click(moreButton());
      await waitFor(() => expect(rowsShown()).toBe(2 + (index + 1) * 100));
    }
    expect(moreButton()).toBeUndefined();
    bidPage.mockClear();
    const last = bid.querySelectorAll("ol > li")[601];
    expect(last.querySelector("strong").textContent).toBe("Bidder 601");
    fireEvent.change(last.querySelector("input"), { target: { value: "Run" } });
    fireEvent.submit(last.querySelector("form"));
    await waitFor(() => expect(api.award).toHaveBeenCalledWith("x601", "Run"));
    await waitFor(() => expect(bidPage.mock.calls).toEqual([["w1", 2, 500], ["w1", 502, 100]]));
    await waitFor(() => expect(rowsShown()).toBe(602));
    expect(bid.querySelectorAll("ol > li")[601].querySelector("strong").textContent).toBe("Bidder 601");
  }, 60_000);

  it("says when more bids cannot load, and tells the committee worker a changed choice cleared the award", async () => {
    const windows = { ...WINDOWS, windows: [{ ...WINDOWS.windows[0], bidCount: 9 }, WINDOWS.windows[1]] };
    const api = panel(fakeApi({
      listBids: vi.fn(async () => windows),
      bidPage: vi.fn(async () => { throw new Error("down"); }),
      recordBid: vi.fn(async () => ({ id: "b2", awardCleared: true })),
    }), "es");
    const bid = (await screen.findByText("November shift bid")).closest("article");
    fireEvent.click(within(bid).getByRole("button", { name: t("es", "seniority.bidsMore") }));
    expect(await within(bid).findByRole("alert")).toHaveTextContent(t("es", "seniority.bidsMoreError"));
    const bidder = within(bid).getByLabelText(t("es", "seniority.member"));
    await waitFor(() => expect(within(bidder).getAllByRole("option").map((option) => option.value)).toContain("u3"));
    fireEvent.change(bidder, { target: { value: "u3" } });
    fireEvent.change(within(bid).getByLabelText(t("es", "seniority.bidChoice")), { target: { value: "Night 5" } });
    fireEvent.click(within(bid).getByRole("button", { name: t("es", "seniority.bidRecord") }));
    await waitFor(() => expect(api.recordBid).toHaveBeenCalled());
    expect(await within(bid).findByText(t("es", "seniority.bidAwardCleared"))).toBeInTheDocument();
  });

  it("lists each bid beside the bidder's seniority, records bids and awards, and opens a new bid", async () => {
    const api = panel();
    const bid = (await screen.findByText("November shift bid")).closest("article");
    expect(within(bid).getByText(/Day run 12/).textContent).toContain(tEn("seniority.bidOnList", { date: "Jan 15, 2008" }));
    expect(within(bid).getByText(/Night 4 ·/).textContent).toContain(tEn("seniority.bidNotOnList"));
    expect(within(bid).getByText(tEn("seniority.awarded", { award: "Night 4" }), { exact: false })).toBeInTheDocument();

    fireEvent.change(within(bid).getByLabelText(tEn("seniority.awardLabel", { name: "Ana Senior" })), { target: { value: "Day run 12" } });
    fireEvent.click(within(bid).getAllByRole("button", { name: tEn("seniority.awardSave") })[0]);
    await waitFor(() => expect(api.award).toHaveBeenCalledWith("b1", "Day run 12"));

    // Any active member of the chapter can bid, listed or not (gate r1).
    const bidder = within(bid).getByLabelText(tEn("seniority.member"));
    await waitFor(() => expect(within(bidder).getAllByRole("option").map((option) => option.value)).toContain("u3"));
    fireEvent.change(bidder, { target: { value: "u3" } });
    fireEvent.change(within(bid).getByLabelText(tEn("seniority.bidChoice")), { target: { value: "Night run 4" } });
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidRecord") }));
    await waitFor(() => expect(api.recordBid).toHaveBeenCalledWith("w1", "u3", "Night run 4"));

    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidMarkAwarded") }));
    await waitFor(() => expect(api.saveWindow).toHaveBeenCalledWith("main", expect.objectContaining({ id: "w1", status: "awarded" })));
    fireEvent.click(within(bid).getByRole("button", { name: tEn("seniority.bidCancel") }));
    await waitFor(() => expect(api.saveWindow).toHaveBeenCalledWith("main", expect.objectContaining({ id: "w1", status: "cancelled" })));

    fireEvent.change(screen.getByLabelText(tEn("seniority.bidSubject")), { target: { value: "December bid" } });
    fireEvent.change(screen.getByLabelText(tEn("seniority.bidOpens")), { target: { value: "2026-11-01T08:00" } });
    fireEvent.change(screen.getByLabelText(tEn("seniority.bidCloses")), { target: { value: "2026-11-05T17:00" } });
    fireEvent.click(screen.getAllByRole("button", { name: tEn("seniority.bidCreate") }).at(-1));
    await waitFor(() => expect(api.saveWindow).toHaveBeenLastCalledWith("main", expect.objectContaining({ subject: "December bid", status: "open" })));
  });

  it("says when a bid window is refused and when there are none", async () => {
    panel(fakeApi({ listBids: vi.fn(async () => ({ windows: [], nextOffset: null })), saveWindow: vi.fn(async () => { throw new Error("bad"); }) }));
    expect(await screen.findByText(tEn("seniority.bidsEmpty"))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(tEn("seniority.bidSubject")), { target: { value: "Bad bid" } });
    fireEvent.change(screen.getByLabelText(tEn("seniority.bidOpens")), { target: { value: "2026-11-05T08:00" } });
    fireEvent.change(screen.getByLabelText(tEn("seniority.bidCloses")), { target: { value: "2026-11-01T17:00" } });
    fireEvent.click(screen.getAllByRole("button", { name: tEn("seniority.bidCreate") }).at(-1));
    expect(await screen.findByText(tEn("seniority.bidSaveError"))).toBeInTheDocument();
  });

  it("lists open bid deadlines within 30 days on the committee worker desk, soonest first, and refreshes after a bid change (gate r1)", async () => {
    expect(upcomingBidDeadlines(WINDOWS.windows, NOW).map((window) => window.id)).toEqual(["w1"]);
    expect(upcomingBidDeadlines(null, NOW)).toEqual([]);
    const api = fakeApi();
    render(<LanguageProvider lang="es"><BidDeadlines api={api} chapterId="main" now={NOW} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: t("es", "seniority.deadlinesTitle") })).toBeInTheDocument();
    expect(screen.getByText(/November shift bid cierra/)).toBeInTheDocument();
    expect(api.deadlines).toHaveBeenCalledWith("main");
    act(() => notifyBidsChanged("other-chapter"));
    expect(api.deadlines).toHaveBeenCalledTimes(1);
    act(() => notifyBidsChanged("main"));
    await waitFor(() => expect(api.deadlines).toHaveBeenCalledTimes(2));
    expect(BIDS_CHANGED_EVENT).toBe("seniority:bids-changed");
    cleanup();
    //: a refusal for role or scope still shows nothing; any other failed
    // read says so (tests/steward-bid-deadlines-load-failure.test.jsx).
    const { container } = render(<LanguageProvider lang="en"><BidDeadlines api={fakeApi({ deadlines: vi.fn(async () => { throw Object.assign(new Error("not authorized"), { code: "42501" }); }) })} chapterId="main" now={NOW} /></LanguageProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("takes bids only while a window is open by the clock, and says how many bids are shown (gate r1)", async () => {
    expect(bidWindowAcceptsBids(WINDOWS.windows[0], NOW)).toBe(true);
    expect(bidWindowAcceptsBids(WINDOWS.windows[0], Date.parse("2026-11-03T00:00:00Z"))).toBe(false);
    expect(bidWindowAcceptsBids(WINDOWS.windows[1], NOW)).toBe(false);
    expect(bidWindowAcceptsBids(null, NOW)).toBe(false);
    const future = { ...WINDOWS.windows[0], id: "w9", opensAt: "2026-11-10T12:00:00Z", closesAt: "2026-11-12T12:00:00Z", bids: [], bidCount: 0 };
    const crowded = { ...WINDOWS.windows[0], bidCount: 750 };
    panel(fakeApi({ listBids: vi.fn(async () => ({ windows: [crowded, future], nextOffset: null })) }));
    const crowdedCard = (await screen.findAllByText("November shift bid"))[0].closest("article");
    expect(within(crowdedCard).getByText(tEn("seniority.bidsShown", { shown: 2, count: 750 }))).toBeInTheDocument();
    const futureCard = screen.getAllByText("November shift bid")[1].closest("article");
    expect(within(futureCard).getByText(tEn("seniority.bidNotOpenYet"))).toBeInTheDocument();
    expect(within(futureCard).queryByRole("button", { name: tEn("seniority.bidRecord") })).toBeNull();
    cleanup();
    panel(fakeApi(), "en", Date.parse("2026-11-03T00:00:00Z"));
    const closed = (await screen.findByText("November shift bid")).closest("article");
    expect(within(closed).getByText(tEn("seniority.bidClosedTime"))).toBeInTheDocument();
  });
});

describe("a worker's own entry", () => {
  it("shows only the worker's own entry and bids, and sends a question", async () => {
    const api = fakeApi({
      mine: vi.fn(async () => ({
        entries: [{ id: "e1", chapterName: "Kinsey Central", seniorityDate: "2008-01-15", classification: "Operator", question: { status: "answered", answer: "Checked." } }],
        bids: [{ id: "b1", subject: "November shift bid", choice: "Day run 12", award: "Day run 12" }],
      })),
    });
    render(<LanguageProvider lang="en"><MySeniorityCard api={api} /></LanguageProvider>);
    expect(await screen.findByText(tEn("seniority.myEntry", { chapter: "Kinsey Central", date: "Jan 15, 2008" }))).toBeInTheDocument();
    expect(screen.getByText(tEn("seniority.myRule"))).toBeInTheDocument();
    expect(screen.getByText(tEn("seniority.questionAnswered", { answer: "Checked." }))).toBeInTheDocument();
    expect(screen.getByText(/November shift bid: Day run 12/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(tEn("seniority.myQuestionLabel")), { target: { value: "My start date was January 8." } });
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.myQuestionSend") }));
    await waitFor(() => expect(api.question).toHaveBeenCalledWith("e1", "My start date was January 8."));
    expect(await screen.findByText(tEn("seniority.myQuestionSent"))).toBeInTheDocument();
  });

  it("shows nothing without an entry, and says when a question fails", async () => {
    const { container } = render(<LanguageProvider lang="en"><MySeniorityCard api={fakeApi()} /></LanguageProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const failing = fakeApi({
      mine: vi.fn(async () => ({ entries: [{ id: "e1", chapterName: "Kinsey Central", seniorityDate: "2008-01-15", question: { status: "open", note: "Why?" } }], bids: [] })),
      question: vi.fn(async () => { throw new Error("no"); }),
    });
    render(<LanguageProvider lang="es"><MySeniorityCard api={failing} /></LanguageProvider>);
    fireEvent.change(await screen.findByLabelText(t("es", "seniority.myQuestionLabel")), { target: { value: "¿Por qué?" } });
    fireEvent.click(screen.getByRole("button", { name: t("es", "seniority.myQuestionSend") }));
    expect(await screen.findByText(t("es", "seniority.myQuestionError"))).toBeInTheDocument();
  });

  //  (audit W5-11): on Main an empty press did nothing at all and
  // a send showed no busy state, so a second press sent the question twice.
  it.each(["en", "es"])("says an empty question is missing and sends a question once while busy (%s)", async (lang) => {
    let finish;
    const api = fakeApi({
      mine: vi.fn(async () => ({ entries: [{ id: "e1", chapterName: "Kinsey Central", seniorityDate: "2008-01-15", question: null }], bids: [] })),
      question: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
    });
    render(<LanguageProvider lang={lang}><MySeniorityCard api={api} /></LanguageProvider>);
    const box = await screen.findByLabelText(t(lang, "seniority.myQuestionLabel"));
    const send = screen.getByRole("button", { name: t(lang, "seniority.myQuestionSend") });
    fireEvent.click(send);
    expect(await screen.findByRole("alert")).toHaveTextContent(t(lang, "seniority.myQuestionEmpty"));
    expect(api.question).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "My start date was January 8." } });
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(send).toHaveAttribute("aria-busy", "true"));
    fireEvent.click(send);
    // The box refuses edits while the question is sending (BusyTextarea).
    expect(box).toHaveAttribute("readonly");
    fireEvent.change(box, { target: { value: "Changed while sending" } });
    expect(box).toHaveValue("My start date was January 8.");
    expect(api.question).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(t(lang, "seniority.myQuestionEmpty"))).toBeNull();
    await act(async () => { finish({ status: "open" }); });
    expect(await screen.findByText(t(lang, "seniority.myQuestionSent"))).toBeInTheDocument();
    expect(send).not.toHaveAttribute("aria-busy");
  });
});

describe("the API and the file", () => {
  it("calls each RPC by name with the campaign's arguments", async () => {
    const client = { rpc: vi.fn(async () => ({ data: { ok: true }, error: null })) };
    const api = createSeniorityApi(client);
    await api.list("main", { afterDate: "2012-06-29", afterId: "e2" }, 25);
    expect(client.rpc).toHaveBeenLastCalledWith("list_chapter_seniority", { p_chapter_id: "main", p_after_date: "2012-06-29", p_after_id: "e2", p_limit: 25 });
    await api.searchMembers("main");
    expect(client.rpc).toHaveBeenLastCalledWith("search_chapter_seniority_members", { p_chapter_id: "main", p_query: "" });
    await api.save("main", { userId: "u1", seniorityDate: "2008-01-15" });
    expect(client.rpc).toHaveBeenLastCalledWith("save_chapter_seniority_entry", { p_chapter_id: "main", p_user_id: "u1", p_seniority_date: "2008-01-15", p_classification: null, p_tie_break_note: null });
    await api.remove("e1");
    await api.importRows("main", [], 1);
    expect(client.rpc).toHaveBeenLastCalledWith("import_chapter_seniority", { p_chapter_id: "main", p_rows: [], p_apply: true });
    await api.answer("e1", "Yes");
    await api.deadlines("main");
    expect(client.rpc).toHaveBeenLastCalledWith("list_chapter_bid_deadlines", { p_chapter_id: "main" });
    await api.bidPage("w1", 500);
    expect(client.rpc).toHaveBeenLastCalledWith("list_chapter_bid_window_bids", { p_window_id: "w1", p_offset: 500, p_limit: 100 });
    await api.listBids("main");
    expect(client.rpc).toHaveBeenLastCalledWith("list_chapter_bid_windows", { p_chapter_id: "main", p_limit: 20, p_offset: 0 });
    await api.saveWindow("main", { subject: "S", opensAt: "a", closesAt: "b" });
    expect(client.rpc).toHaveBeenLastCalledWith("save_chapter_bid_window", { p_id: null, p_chapter_id: "main", p_subject: "S", p_opens_at: "a", p_closes_at: "b", p_status: "open" });
    await api.recordBid("w1", "u1", "Day");
    await api.award("b1", "");
    expect(client.rpc).toHaveBeenLastCalledWith("award_chapter_bid", { p_bid_id: "b1", p_award: null });
    await api.mine();
    await api.question("e1", "Why?");
    expect(client.rpc).toHaveBeenLastCalledWith("question_my_seniority_entry", { p_entry_id: "e1", p_note: "Why?" });
    await expect(createSeniorityApi({ rpc: async () => ({ data: null, error: { code: "42501" } }) }).mine()).rejects.toMatchObject({ code: "42501" });
    await expect(createSeniorityApi(null).mine()).rejects.toThrow("seniority is unavailable");
  });

  it("reads a CSV in any column order, with quotes and a byte-order mark, and refuses one without the key columns", () => {
    expect(parseSeniorityFile("﻿Classification,Seniority date,Email,Tie-break note\n\"Operator, Day\",2008-01-15,ana@example.invalid,\"Badge \"\"114\"\"\"\n")).toEqual([
      { email: "ana@example.invalid", seniorityDate: "2008-01-15", classification: "Operator, Day", tieBreakNote: "Badge \"114\"" },
    ]);
    expect(parseSeniorityFile("Correo,Fecha de antigüedad\nana@example.invalid,2008-01-15")).toEqual([{ email: "ana@example.invalid", seniorityDate: "2008-01-15", classification: "", tieBreakNote: "" }]);
    expect(parseSeniorityFile("Name,Date\nAna,2008-01-15")).toEqual([]);
    expect(parseSeniorityFile("")).toEqual([]);
  });

  it("declares every key in both languages", () => {
    expect(Object.keys(seniorityCatalogue.es).sort()).toEqual(Object.keys(seniorityCatalogue.en).sort());
  });
});

// BUG-UG-SENIORITY-PANEL-PROFILE-CHAPTER-ONLY-20261102
describe("the campaign the seniority tools open", () => {
  const CHAPTERS = [{ id: "ch-a", name: "Campaign A" }, { id: "ch-b", name: "Campaign B" }];
  function scope(props, lang = "en") {
    const api = fakeApi({ chapters: vi.fn(async () => CHAPTERS) });
    const seen = vi.fn();
    render(<LanguageProvider lang={lang}><SeniorityChapterScope api={api} organizationId="org-1" {...props}>{(chapterId) => { seen(chapterId); return <p>{`open:${chapterId}`}</p>; }}</SeniorityChapterScope></LanguageProvider>);
    return { api, seen };
  }

  it("lets organization-wide staff with no campaign of their own choose one of their organization's campaigns", async () => {
    const { api } = scope({ defaultChapterId: null, organizationWide: true });
    const select = await screen.findByRole("combobox", { name: "Campaign" });
    expect(api.chapters).toHaveBeenCalledWith("org-1");
    expect(screen.queryByText(/^open:/)).toBeNull();
    fireEvent.change(select, { target: { value: "ch-b" } });
    expect(screen.getByText("open:ch-b")).toBeInTheDocument();
  });


  it("keeps a campaign committee worker on their own campaign without listing the organization", () => {
    const { api } = scope({ defaultChapterId: "ch-a", organizationWide: false });
    expect(screen.getByText("open:ch-a")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(api.chapters).not.toHaveBeenCalled();
  });

  it("says so when the organization's campaigns cannot be read", async () => {
    const api = fakeApi({ chapters: vi.fn(async () => { throw new Error("offline"); }) });
    render(<LanguageProvider lang="en"><SeniorityChapterScope api={api} organizationId="org-1" organizationWide>{() => null}</SeniorityChapterScope></LanguageProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(seniorityCatalogue.en["seniority.chaptersError"]);
  });

  it("treats only organization-level committee worker or campaign lead grants as organization-wide", () => {
    expect(seniorityOrganizationWide({ organizationRoles: ["coordinator"] })).toBe(true);
    expect(seniorityOrganizationWide({ organizationRoles: ["steward"] })).toBe(true);
    expect(seniorityOrganizationWide({ organizationRoles: ["admin"] })).toBe(false);
    expect(seniorityOrganizationWide({})).toBe(false);
  });

  it("lists only the staff worker's own organization's campaigns", async () => {
    const calls = [];
    const chain = { select: (...args) => { calls.push(["select", ...args]); return chain; }, eq: (...args) => { calls.push(["eq", ...args]); return chain; },
      order: (...args) => { calls.push(["order", ...args]); return chain; }, then: (resolve) => resolve({ data: CHAPTERS, error: null }) };
    const client = { rpc: vi.fn(), from: vi.fn((table) => { calls.push(["from", table]); return chain; }) };
    await expect(createSeniorityApi(client).chapters("org-1")).resolves.toEqual(CHAPTERS);
    expect(calls).toContainEqual(["from", "chapters"]);
    expect(calls).toContainEqual(["eq", "organization_id", "org-1"]);
  });

  it("mounts the tools through the campaign scope on both staff desks", () => {
    for (const file of ["src/views/CoordinatorView.jsx", "src/views/StewardView.jsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain("<SeniorityChapterScope api={seniorityApi} defaultChapterId={data.member?.chapterId || null} organizationId={data.member?.organizationId || null} organizationWide={seniorityOrganizationWide(data.member)}>");
      expect(source, file).not.toContain("chapterId={data.member.chapterId} />");
    }
  });
});

// BUG-UG-FAILURE-SHOWS-NO-MESSAGE-20261122: every
// steward write on the desk said nothing when it failed. An answered refusal
// says "not saved"; a lost reply says it could not be confirmed.
describe("a failed seniority or bid write says so beside its control (#9463)", () => {
  const refuse = vi.fn(async () => { throw Object.assign(new Error("no open question"), { code: "22023" }); });
  const lost = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
  const bidCard = async () => (await screen.findByText("November shift bid")).closest("article");

  it("keeps a refused answer and says so beside it", async () => {
    panel(fakeApi({ answer: refuse }));
    const answer = await screen.findByLabelText(tEn("seniority.answerLabel", { name: "Ana Senior" }));
    fireEvent.change(answer, { target: { value: "Corrected." } });
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.answerSave") }));
    expect(await within(answer.closest("form")).findByRole("alert")).toHaveTextContent(tEn("seniority.answerError"));
    expect(answer).toHaveValue("Corrected.");
  });

  it.each(["en", "es"])("says an answer or award with no reply could not be confirmed, and reads the list again (%s)", async (lang) => {
    const api = panel(fakeApi({ answer: lost, award: lost }), lang);
    const answer = await screen.findByLabelText(t(lang, "seniority.answerLabel", { name: "Ana Senior" }));
    fireEvent.change(answer, { target: { value: "Corrected." } });
    fireEvent.click(screen.getByRole("button", { name: t(lang, "seniority.answerSave") }));
    expect(await within(answer.closest("form")).findByRole("alert")).toHaveTextContent(t(lang, "seniority.writeUnconfirmed"));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    const award = within(await bidCard()).getAllByRole("button", { name: t(lang, "seniority.awardSave") })[0].closest("form");
    fireEvent.click(within(award).getByRole("button"));
    expect(await within(award).findByRole("alert")).toHaveTextContent(t(lang, "seniority.writeUnconfirmed"));
    expect(screen.queryByText(t(lang, "seniority.awardError"))).toBeNull();
  });

  it.each(["en", "es"])("says when a bid, an award or a window change is refused, and when the bid form is incomplete (%s)", async (lang) => {
    const tr = (key) => t(lang, key);
    panel(fakeApi({ award: refuse, recordBid: refuse, saveWindow: refuse }), lang);
    const bid = await bidCard();
    const award = within(bid).getAllByRole("button", { name: tr("seniority.awardSave") })[0].closest("form");
    fireEvent.click(within(award).getByRole("button"));
    expect(await within(award).findByRole("alert")).toHaveTextContent(tr("seniority.awardError"));
    // The member box is required, so the browser itself names it; a picked
    // member with no choice used to submit nothing and say nothing.
    const record = within(bid).getByRole("button", { name: tr("seniority.bidRecord") });
    const bidder = within(bid).getByLabelText(tr("seniority.member"));
    await waitFor(() => expect(within(bidder).getAllByRole("option").map((option) => option.value)).toContain("u3"));
    fireEvent.change(bidder, { target: { value: "u3" } });
    fireEvent.click(record);
    expect(await within(record.closest("form")).findByRole("alert")).toHaveTextContent(tr("seniority.bidIncomplete"));
    fireEvent.change(within(bid).getByLabelText(tr("seniority.bidChoice")), { target: { value: "Night run 4" } });
    fireEvent.click(record);
    expect(await within(record.closest("form")).findByText(tr("seniority.bidRecordError"))).toHaveAttribute("role", "alert");
    expect(within(bid).getByLabelText(tr("seniority.bidChoice"))).toHaveValue("Night run 4");
    // Each window button has its own line, and a new press replaces the old one.
    const marked = within(bid).getByRole("button", { name: tr("seniority.bidMarkAwarded") });
    const cancel = within(bid).getByRole("button", { name: tr("seniority.bidCancel") });
    fireEvent.click(marked);
    await waitFor(() => expect(marked.nextElementSibling).toHaveTextContent(tr("seniority.bidWindowError")));
    fireEvent.click(cancel);
    await waitFor(() => expect(cancel.nextElementSibling).toHaveTextContent(tr("seniority.bidWindowError")));
    expect(marked.nextElementSibling).toBe(cancel);
  });

  it("keeps the rows, the typed text and the sentence when the re-read after an unconfirmed write fails too", async () => {
    let reads = 0;
    let bidReads = 0;
    const api = panel(fakeApi({
      answer: lost, award: lost,
      list: vi.fn(async () => { reads += 1; if (reads > 1) throw new TypeError("Failed to fetch"); return LIST; }),
      listBids: vi.fn(async () => { bidReads += 1; if (bidReads > 1) throw new TypeError("Failed to fetch"); return WINDOWS; }),
    }));
    const answer = await screen.findByLabelText(tEn("seniority.answerLabel", { name: "Ana Senior" }));
    fireEvent.change(answer, { target: { value: "Corrected to January 8." } });
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.answerSave") }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(await within(answer.closest("form")).findByRole("alert")).toHaveTextContent(tEn("seniority.writeUnconfirmed"));
    expect(screen.getByLabelText(tEn("seniority.answerLabel", { name: "Ana Senior" }))).toHaveValue("Corrected to January 8.");
    expect(screen.getAllByText(tEn("seniority.error"), { exact: false, selector: "p" }).length).toBeGreaterThan(0);
    const field = within(await bidCard()).getByLabelText(tEn("seniority.awardLabel", { name: "Ana Senior" }));
    fireEvent.change(field, { target: { value: "Day run 12" } });
    fireEvent.click(within(field.closest("form")).getByRole("button"));
    expect(await within(field.closest("form")).findByRole("alert")).toHaveTextContent(tEn("seniority.writeUnconfirmed"));
    await waitFor(() => expect(api.listBids.mock.calls.length).toBeGreaterThan(2));
    expect(within(await bidCard()).getByLabelText(tEn("seniority.awardLabel", { name: "Ana Senior" }))).toHaveValue("Day run 12");
    expect(within(await bidCard()).getByText(tEn("seniority.writeUnconfirmed"))).toBeInTheDocument();
  });

  it("treats an answered PostgREST refusal as not saved, and ignores a superseded award reply", async () => {
    let failLate;
    const award = vi.fn().mockReturnValueOnce(new Promise((_, reject) => { failLate = reject; })).mockResolvedValueOnce({ id: "b1" });
    panel(fakeApi({ answer: vi.fn(async () => { throw Object.assign(new Error("JWT expired"), { code: "PGRST301" }); }), award }));
    const answer = await screen.findByLabelText(tEn("seniority.answerLabel", { name: "Ana Senior" }));
    fireEvent.change(answer, { target: { value: "Checked." } });
    fireEvent.click(screen.getByRole("button", { name: tEn("seniority.answerSave") }));
    expect(await within(answer.closest("form")).findByRole("alert")).toHaveTextContent(tEn("seniority.answerError"));
    const form = within(await bidCard()).getAllByRole("button", { name: tEn("seniority.awardSave") })[0].closest("form");
    fireEvent.click(within(form).getByRole("button"));
    fireEvent.click(within(form).getByRole("button"));
    await waitFor(() => expect(award).toHaveBeenCalledTimes(2));
    await act(async () => { failLate(new TypeError("Failed to fetch")); });
    expect(within(form).queryByRole("alert")).toBeNull();
  });

  it("keeps one row's refused award when another row's award saves", async () => {
    const api = panel(fakeApi({ award: vi.fn(async (bidId) => { if (bidId === "b1") throw Object.assign(new Error("closed"), { code: "P0001" }); return { id: bidId }; }) }));
    const [first, second] = within(await bidCard()).getAllByRole("button", { name: tEn("seniority.awardSave") }).map((button) => button.closest("form"));
    fireEvent.click(within(first).getByRole("button"));
    expect(await within(first).findByRole("alert")).toHaveTextContent(tEn("seniority.awardError"));
    fireEvent.click(within(second).getByRole("button"));
    await waitFor(() => expect(api.award).toHaveBeenCalledWith("b2", "Night 4"));
    expect(within(first).getByRole("alert")).toHaveTextContent(tEn("seniority.awardError"));
    expect(within(second).queryByRole("alert")).toBeNull();
  });
});

// UX-UG-REWARDS-AWARD-HISTORY-AND-SENIORITY-DATES-SHOWN-RAW-20261125
//: a seniority date is a
// calendar day, so the list, the "on the list since" line beside each bid and
// the member's own card print it the way the rest of the website prints a day
// (formatCalendarDay), never as the stored "2008-01-15". A value that is not
// a calendar day still shows as stored.
describe("seniority dates read as dates (#10026)", () => {
  for (const [lang, first, second] of [["en", "Jan 15, 2008", "Jun 29, 2012"], ["es", "15 ene 2008", "29 jun 2012"]]) {
    it(`prints the list and each bid's seniority date as a day in ${lang}`, async () => {
      panel(fakeApi(), lang);
      const table = await screen.findByRole("table");
      expect(within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[2].textContent)).toEqual([first, second]);
      expect(table).not.toHaveTextContent("2008-01-15");
      const bid = (await screen.findByText("November shift bid")).closest("article");
      expect(within(bid).getByText(/Day run 12/).textContent).toContain(t(lang, "seniority.bidOnList", { date: first }));
      expect(bid).not.toHaveTextContent("2008-01-15");
    });

    it(`prints the worker's own seniority date as a day in ${lang}`, async () => {
      const api = fakeApi({ mine: vi.fn(async () => ({ entries: [{ id: "e1", chapterName: "Kinsey Central", seniorityDate: "2008-01-15", question: null }], bids: [] })) });
      render(<LanguageProvider lang={lang}><MySeniorityCard api={api} /></LanguageProvider>);
      expect(await screen.findByText(t(lang, "seniority.myEntry", { chapter: "Kinsey Central", date: first }))).toBeInTheDocument();
    });
  }

  it("keeps a value that is not a calendar day as stored", async () => {
    const api = fakeApi({ mine: vi.fn(async () => ({ entries: [{ id: "e1", chapterName: "Kinsey Central", seniorityDate: "pending review", question: null }], bids: [] })) });
    render(<LanguageProvider lang="en"><MySeniorityCard api={api} /></LanguageProvider>);
    expect(await screen.findByText(tEn("seniority.myEntry", { chapter: "Kinsey Central", date: "pending review" }))).toBeInTheDocument();
  });
});
