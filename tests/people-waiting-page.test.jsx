// People waiting (REQ-UG-INTAKE-QUEUE-PEOPLE-WAITING-ADMIN-PAGE-20261118):
// the platform operator's intake queue. requestReview is a fake that answers
// like POST /api/intake-review (the route's `result`, or a rejection
// `{ status, error, reason }`); nothing touches the network. Fictional
// fixtures only: Example Workers N, example.org addresses, people surnamed
// Fixtureperson.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PeopleWaitingPage } from "../src/features/intakeQueue/PeopleWaitingPage.jsx";
import { countsByKind, dailyTotals, intakeCsv, intakeFailureKind, intakeFilters, replyHref, requestIntakeReview } from "../src/features/intakeQueue/intakeApi.js";
import { intakeQueueCatalogue } from "../src/lib/i18n/intakeQueue.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const ID = (n) => `1a7a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const INVITE = {
  id: ID(1), kind: "invite", email: "alex@example.org", name: "Alex Fixtureperson", topic: null, locale: "en",
  organizationName: "Example Workers Local 12", role: null, sizeBand: null, state: null, phone: null,
  note: "North site.\nStarting soon.", campaignCode: null, status: "new", operatorNote: null, statusChangedAt: null,
  lastSubmittedAt: "2026-11-18T15:00:00Z", createdAt: "2026-11-17T23:30:00Z",
};
const UPDATES = {
  ...INVITE, id: ID(2), kind: "updates", email: "sam@example.org", name: null, topic: "union_news",
  organizationName: null, note: null, status: "contacted", operatorNote: "Called back.",
  lastSubmittedAt: "2026-11-16T15:00:00Z", createdAt: "2026-11-16T15:00:00Z",
};
const SUMMARY = {
  today: "2026-11-18",
  counts: [
    { kind: "invite", status: "new", count: 2 },
    { kind: "join", status: "closed", count: 1 },
    { kind: "updates", status: "contacted", count: 4 },
    { kind: "tenant", status: "new", count: 9 },
  ],
  topics: [{ topic: "union_news", count: 3 }, { topic: "chapter_updates", count: 1 }],
  updatePeople: 3,
  daily: [
    { day: "2026-11-16", updates: 1, join: 0, invite: 0 },
    { day: "2026-11-17", updates: 0, join: 1, invite: 2 },
    { day: "2026-11-18", updates: 0, join: 0, invite: 0 },
  ],
};

function fake(overrides = {}) {
  return vi.fn(async (action, payload) => {
    if (overrides[action]) return overrides[action](payload);
    if (action === "summary") return SUMMARY;
    if (action === "list") return { requests: [INVITE, UPDATES], hasMore: false, cursorSubmittedAt: UPDATES.lastSubmittedAt, cursorId: UPDATES.id };
    throw new Error(`unexpected ${action}`);
  });
}

function renderPage(requestReview, props = {}, lang = "en") {
  return render(<LanguageProvider lang={lang}><PeopleWaitingPage requestReview={requestReview} {...props} /></LanguageProvider>);
}

describe("intakeApi", () => {
  it("throws one plain shape for every failure and returns the route's result", async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: { requests: [] } }) }));
    await expect(requestIntakeReview({ fetchImpl: ok, accessToken: "tok", action: "list", payload: { kind: "invite" } })).resolves.toEqual({ requests: [] });
    expect(JSON.parse(ok.mock.calls[0][1].body)).toEqual({ kind: "invite", action: "list" });
    expect(ok.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
    const refused = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: "not-permitted" }) }));
    await expect(requestIntakeReview({ fetchImpl: refused, accessToken: "t", action: "summary" })).rejects.toEqual({ status: 403, error: "not-permitted", reason: null });
    await expect(requestIntakeReview({ fetchImpl: async () => { throw new Error("offline"); }, accessToken: "t", action: "summary" })).rejects.toEqual({ status: 0, error: "unavailable", reason: null });
    const noJson = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } }));
    await expect(requestIntakeReview({ fetchImpl: noJson, accessToken: "t", action: "summary" })).rejects.toMatchObject({ error: "unavailable" });
    const noResult = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await expect(requestIntakeReview({ fetchImpl: noResult, accessToken: "t", action: "summary" })).rejects.toMatchObject({ error: "unavailable" });
    const badJsonError = vi.fn(async () => ({ ok: false, status: 503, json: async () => { throw new Error("bad"); } }));
    await expect(requestIntakeReview({ fetchImpl: badJsonError, accessToken: "t", action: "summary" })).rejects.toEqual({ status: 503, error: "unavailable", reason: null });
  });

  it("names each failure kind", () => {
    expect(intakeFailureKind({ status: 404, error: "not-available" })).toBe("demo");
    expect(intakeFailureKind({ status: 401 })).toBe("mfa");
    expect(intakeFailureKind({ status: 403, error: "mfa-required" })).toBe("mfa");
    expect(intakeFailureKind({ status: 403, error: "not-permitted" })).toBe("forbidden");
    expect(intakeFailureKind({ status: 409, error: "refused" })).toBe("refused");
    expect(intakeFailureKind({ status: 503 })).toBe("unavailable");
    expect(intakeFailureKind({ status: 0 })).toBe("unavailable");
    expect(intakeFailureKind({ status: 500 })).toBe("generic");
  });

  it("sends only the filters that are set, and builds a safe reply link and CSV", () => {
    expect(intakeFilters({ kind: "tenant", status: "", search: "  " })).toEqual({});
    expect(intakeFilters({ kind: "join", status: "closed", search: ` ${"x".repeat(130)} ` })).toEqual({ kind: "join", status: "closed", search: "x".repeat(120) });
    expect(replyHref({ email: "alex@example.org" }, "Your request & more")).toBe("mailto:alex@example.org?subject=Your%20request%20%26%20more");
    expect(replyHref({ email: "not an address" }, "x")).toBeNull();
    // An address that could smuggle a second header or recipient gets no link.
    expect(replyHref({ email: "a@b.c?cc=evil@example.org" }, "x")).toBeNull();
    expect(replyHref({ email: "a+b?c@example.org" }, "x")).toBe("mailto:a%2Bb%3Fc@example.org?subject=x");
    const csv = intakeCsv([{ kind: "invite", name: "=SUM(A1)", note: "a, \"b\"\nc" }]);
    expect(csv.split("\r\n")[0]).toMatch(/^kind,status,name,email,/);
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain("\"a, \"\"b\"\"\nc\"");
    expect(intakeCsv(null)).toMatch(/^kind,/);
  });

  it("totals counts per kind and the trend per day, ignoring what it does not know", () => {
    const byKind = countsByKind(SUMMARY.counts);
    expect(byKind.invite).toMatchObject({ total: 2, new: 2 });
    expect(byKind.updates).toMatchObject({ total: 4, contacted: 4 });
    expect(byKind).not.toHaveProperty("tenant");
    expect(countsByKind(null).join.total).toBe(0);
    expect(dailyTotals([...SUMMARY.daily, { day: "bad" }]).map((d) => d.total)).toEqual([1, 3, 0]);
    expect(dailyTotals(undefined)).toEqual([]);
  });
});

describe("PeopleWaitingPage", () => {
  it("shows the operator counts, the trend sentence and every request with Eastern dates", async () => {
    const review = fake();
    renderPage(review);
    expect(await screen.findByText("Alex Fixtureperson")).toBeInTheDocument();
    expect(review).toHaveBeenCalledWith("summary", {});
    expect(review).toHaveBeenCalledWith("list", { limit: 25 });
    expect(screen.getByRole("img", { name: /4 new requests in the last 90 days; the busiest day was Nov 17, 2026 with 3\./ })).toBeInTheDocument();
    expect(screen.getByText("3 different addresses")).toBeInTheDocument();
    expect(screen.getByText(/Updates by topic:/).textContent).toContain("Union news 3 · Campaign updates 1");
    // The 7:30 PM ET request on the 17th stays on the 17th.
    expect(screen.getByText(/Nov 17, 2026, 6:30\s?PM EST/)).toBeInTheDocument();
    const item = screen.getByText("Alex Fixtureperson").closest("li");
    expect(within(item).getByText("Example Workers Local 12")).toBeInTheDocument();
    expect(within(item).getByRole("link", { name: "Reply by email" })).toHaveAttribute("href", "mailto:alex@example.org?subject=Your%20Union%20Ground%20invite%20request");
    // A row with no name is headed by its address.
    expect(screen.getByRole("heading", { name: "sam@example.org" })).toBeInTheDocument();
  });

  it("saves a status and a note, and the row shows the saved values at once", async () => {
    const saved = { ...INVITE, status: "contacted", statusChangedAt: "2026-11-18T16:00:00Z" };
    const review = fake({
      status: async () => ({ updated: true, request: saved }),
      note: async () => ({ updated: true, request: { ...saved, operatorNote: "Sent the founder link." } }),
    });
    renderPage(review);
    const item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "contacted" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    expect(await screen.findByText("Status saved for Alex Fixtureperson.")).toBeInTheDocument();
    expect(review).toHaveBeenCalledWith("status", { id: INVITE.id, status: "contacted", expectedStatus: "new" });
    expect(within(item).getByText(/Invite requests · Contacted/)).toBeInTheDocument();
    fireEvent.change(within(item).getByLabelText(/Private note/), { target: { value: "Sent the founder link." } });
    fireEvent.click(within(item).getByRole("button", { name: "Save note" }));
    expect(await screen.findByText("Note saved for Alex Fixtureperson.")).toBeInTheDocument();
    expect(review).toHaveBeenCalledWith("note", { id: INVITE.id, note: "Sent the founder link." });
    expect(within(item).getByRole("button", { name: "Save note" })).toBeDisabled();
  });

  it("holds the note read-only and the status still while its save runs", async () => {
    let finish;
    const review = fake({
      note: () => new Promise((resolve) => { finish = () => resolve({ updated: true, request: { ...INVITE, operatorNote: "First draft." } }); }),
    });
    renderPage(review);
    const item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    const note = within(item).getByLabelText(/Private note/);
    fireEvent.change(note, { target: { value: "First draft." } });
    fireEvent.click(within(item).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(note).toHaveAttribute("readonly"));
    finish();
    expect(await screen.findByText("Note saved for Alex Fixtureperson.")).toBeInTheDocument();
    expect(note).not.toHaveAttribute("readonly");
    expect(note).toHaveValue("First draft.");
  });

  it("reads the counts again after a saved status, and drops a row that leaves the status filter", async () => {
    const review = fake({ status: async () => ({ updated: true, request: { ...INVITE, status: "contacted" } }) });
    renderPage(review);
    await screen.findByText("Alex Fixtureperson");
    fireEvent.change(screen.getByLabelText("Status", { selector: "select:not([id])" }), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("list", { status: "new", limit: 25 }));
    const item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "contacted" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    expect(await screen.findByText("Status saved for Alex Fixtureperson.")).toBeInTheDocument();
    expect(screen.queryByText("Alex Fixtureperson")).not.toBeInTheDocument();
    await waitFor(() => expect(review.mock.calls.filter(([action]) => action === "summary")).toHaveLength(2));
  });

  it("reconciles a late save against the filters on screen now, not the ones it began with", async () => {
    let finish;
    const review = fake({
      list: async (payload) => ({ requests: payload.status === "new" ? [INVITE] : [{ ...INVITE, status: "contacted" }, UPDATES], hasMore: false }),
      status: () => new Promise((resolve) => { finish = () => resolve({ updated: true, request: { ...INVITE, status: "contacted" } }); }),
    });
    renderPage(review);
    await screen.findByText("Alex Fixtureperson");
    const statusFilter = screen.getByLabelText("Status", { selector: "select:not([id])" });
    fireEvent.change(statusFilter, { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("list", { status: "new", limit: 25 }));
    await waitFor(() => expect(screen.queryByText("sam@example.org", { selector: "h4 span" })).not.toBeInTheDocument());
    const item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "contacted" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("status", expect.objectContaining({ status: "contacted" })));
    fireEvent.change(statusFilter, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText("sam@example.org", { selector: "h4 span" })).toBeInTheDocument();
    finish();
    expect(await screen.findByText("Status saved for Alex Fixtureperson.")).toBeInTheDocument();
    expect(screen.getByText("Alex Fixtureperson")).toBeInTheDocument();
  });

  it("says a row someone else changed has left the filtered list", async () => {
    const review = fake({ status: async () => ({ updated: false, refusal: "changed", request: { ...INVITE, status: "invited" } }) });
    renderPage(review);
    await screen.findByText("Alex Fixtureperson");
    fireEvent.change(screen.getByLabelText("Status", { selector: "select:not([id])" }), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("list", { status: "new", limit: 25 }));
    const item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "closed" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("It is now Invited, so it left this filtered list.");
    expect(screen.queryByText("Alex Fixtureperson")).not.toBeInTheDocument();
  });

  it("reads the page again when saves move every row on it out of the filter while more pages remain", async () => {
    const OLDER = { ...INVITE, id: ID(9), name: "Robin Fixtureperson", email: "robin@example.org", lastSubmittedAt: "2026-11-10T15:00:00Z" };
    let saved = false;
    const review = fake({
      list: async (payload) => (payload.status !== "new" ? { requests: [INVITE, UPDATES], hasMore: false }
        : saved ? { requests: [OLDER], hasMore: false } : { requests: [INVITE], hasMore: true, cursorSubmittedAt: INVITE.lastSubmittedAt, cursorId: INVITE.id }),
      status: async () => { saved = true; return { updated: true, request: { ...INVITE, status: "contacted" } }; },
    });
    renderPage(review);
    await screen.findByText("Alex Fixtureperson");
    fireEvent.change(screen.getByLabelText("Status", { selector: "select:not([id])" }), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("list", { status: "new", limit: 25 }));
    await waitFor(() => expect(screen.queryByText("sam@example.org", { selector: "h4 span" })).not.toBeInTheDocument());
    const item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "contacted" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    expect(await screen.findByText("Robin Fixtureperson")).toBeInTheDocument();
    expect(screen.queryByText("No request matches these filters.")).not.toBeInTheDocument();
  });

  it("keeps a saved status when a list answer that left before the save arrives after it", async () => {
    let finishSave;
    let finishList;
    let lists = 0;
    const review = fake({
      list: () => {
        lists += 1;
        if (lists === 1) return Promise.resolve({ requests: [INVITE, UPDATES], hasMore: false });
        return new Promise((resolve) => { finishList = () => resolve({ requests: [INVITE, UPDATES], hasMore: false }); });
      },
      status: () => new Promise((resolve) => { finishSave = () => resolve({ updated: true, request: { ...INVITE, status: "contacted" } }); }),
    });
    renderPage(review);
    const item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "contacted" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    await waitFor(() => expect(finishSave).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(finishList).toBeTypeOf("function"));
    finishSave();
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishList();
    const row = (await screen.findByText("Alex Fixtureperson")).closest("li");
    expect(within(row).getByText(/Invite requests · Contacted/)).toBeInTheDocument();
  });

  it("goes back to the filter's first page when saves empty a later page", async () => {
    const OLDER = { ...INVITE, id: ID(9), name: "Robin Fixtureperson", email: "robin@example.org", lastSubmittedAt: "2026-11-10T15:00:00Z" };
    const review = fake({
      list: async (payload) => (payload.before
        ? { requests: [OLDER], hasMore: false }
        : { requests: [INVITE], hasMore: true, cursorSubmittedAt: INVITE.lastSubmittedAt, cursorId: INVITE.id }),
      status: async () => ({ updated: true, request: { ...OLDER, status: "contacted" } }),
    });
    renderPage(review);
    await screen.findByText("Alex Fixtureperson");
    fireEvent.change(screen.getByLabelText("Status", { selector: "select:not([id])" }), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("list", { status: "new", limit: 25 }));
    fireEvent.click(await screen.findByRole("button", { name: "Older" }));
    const item = (await screen.findByText("Robin Fixtureperson")).closest("li");
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "contacted" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    expect(await screen.findByText("Alex Fixtureperson")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.queryByText("No request matches these filters.")).not.toBeInTheDocument();
  });

  it("does not bring back a request that is gone when a list answer from before arrives", async () => {
    let finishSave;
    let finishList;
    let lists = 0;
    const review = fake({
      list: () => {
        lists += 1;
        if (lists === 1) return Promise.resolve({ requests: [INVITE, UPDATES], hasMore: false });
        return new Promise((resolve) => { finishList = () => resolve({ requests: [INVITE, UPDATES], hasMore: false }); });
      },
      status: () => new Promise((resolve) => { finishSave = () => resolve({ updated: false, refusal: "not-found" }); }),
    });
    renderPage(review);
    const item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "closed" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    await waitFor(() => expect(finishSave).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(finishList).toBeTypeOf("function"));
    finishSave();
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishList();
    expect(await screen.findByText("sam@example.org", { selector: "h4 span" })).toBeInTheDocument();
    expect(screen.queryByText("Alex Fixtureperson")).not.toBeInTheDocument();
  });

  it("reads the counts again when a request is gone", async () => {
    const review = fake({ status: async () => ({ updated: false, refusal: "not-found" }) });
    renderPage(review);
    const item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "closed" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    expect(await screen.findByText(/no longer on file/)).toBeInTheDocument();
    await waitFor(() => expect(review.mock.calls.filter(([action]) => action === "summary")).toHaveLength(2));
  });

  it("never downloads an export that finishes after the page has left the screen", async () => {
    let finish;
    const saveCsv = vi.fn();
    const review = fake({ export: () => new Promise((resolve) => { finish = () => resolve({ requests: [INVITE], truncated: false }); }) });
    const view = renderPage(review, { saveCsv });
    await screen.findByText("Alex Fixtureperson");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("export", {}));
    view.unmount();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveCsv).not.toHaveBeenCalled();
  });

  it("keeps the list and unsaved edits when the language changes", async () => {
    const review = fake();
    const view = renderPage(review);
    const item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    fireEvent.change(within(item).getByLabelText(/Private note/), { target: { value: "Unsaved draft" } });
    view.rerender(<LanguageProvider lang="es"><PeopleWaitingPage requestReview={review} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Personas en espera" })).toBeInTheDocument();
    expect(review.mock.calls.filter(([action]) => action === "list")).toHaveLength(1);
    expect(within(screen.getByText("Alex Fixtureperson").closest("li")).getByLabelText(/Nota privada/)).toHaveValue("Unsaved draft");
  });

  it("says when someone else changed the row first, when it is gone, and when nothing changed", async () => {
    const answers = [
      { updated: false, refusal: "changed", request: { ...INVITE, status: "invited" } },
      { updated: false, refusal: "unchanged", request: { ...INVITE, status: "invited" } },
      { updated: false, refusal: "not-found" },
    ];
    const review = fake({ status: async () => answers.shift() });
    renderPage(review);
    let item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "closed" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    expect(await screen.findByText(/Someone else changed this request first/)).toBeInTheDocument();
    expect(within(item).getByText(/Invite requests · Invited/)).toBeInTheDocument();
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "closed" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    expect(await screen.findByText("Nothing changed.")).toBeInTheDocument();
    item = screen.getByText("Alex Fixtureperson").closest("li");
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "closed" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save status" }));
    expect(await screen.findByText(/no longer on file/)).toBeInTheDocument();
    expect(screen.queryByText("Alex Fixtureperson")).not.toBeInTheDocument();
  });

  it("filters, pages to older requests and back, and exports the filtered list", async () => {
    const pages = [
      { requests: [INVITE], hasMore: true, cursorSubmittedAt: INVITE.lastSubmittedAt, cursorId: INVITE.id },
      { requests: [UPDATES], hasMore: false, cursorSubmittedAt: null, cursorId: null },
    ];
    const saveCsv = vi.fn();
    const review = fake({
      list: async (payload) => (payload.before ? pages[1] : pages[0]),
      export: async () => ({ requests: [INVITE], truncated: false }),
    });
    renderPage(review, { saveCsv });
    await screen.findByText("Alex Fixtureperson");
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "invite" } });
    fireEvent.change(screen.getByLabelText("Status", { selector: "select:not([id])" }), { target: { value: "new" } });
    fireEvent.change(screen.getByLabelText(/Search name/), { target: { value: " alex " } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("list", { kind: "invite", status: "new", search: "alex", limit: 25 }));
    fireEvent.click(await screen.findByRole("button", { name: "Older" }));
    expect(await screen.findByText("sam@example.org", { selector: "h4 span" })).toBeInTheDocument();
    expect(review).toHaveBeenCalledWith("list", { kind: "invite", status: "new", search: "alex", limit: 25, before: INVITE.lastSubmittedAt, beforeId: INVITE.id });
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Older" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Newer" }));
    expect(await screen.findByText("Alex Fixtureperson")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Exported 1 requests.")).toBeInTheDocument();
    expect(review).toHaveBeenCalledWith("export", { kind: "invite", status: "new", search: "alex" });
    expect(saveCsv.mock.calls[0][0]).toContain("alex@example.org");
  });

  it("says when the export stopped at its limit, and when a write fails", async () => {
    const review = fake({
      export: async () => ({ requests: [INVITE, UPDATES], truncated: true }),
      note: async () => { throw { status: 409, error: "refused", reason: "invalid-note" }; },
    });
    renderPage(review, { saveCsv: vi.fn() });
    const item = (await screen.findByText("Alex Fixtureperson")).closest("li");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText(/Exported the first 2 requests/)).toBeInTheDocument();
    fireEvent.change(within(item).getByLabelText(/Private note/), { target: { value: "x" } });
    fireEvent.click(within(item).getByRole("button", { name: "Save note" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That change was refused.");
  });

  it("shows the empty states, and keeps the list when only the counts fail", async () => {
    const review = fake({
      summary: async () => { throw { status: 503, error: "review-unavailable" }; },
      list: async () => ({ requests: [], hasMore: false }),
    });
    renderPage(review);
    expect(await screen.findByText("Nobody is waiting yet.")).toBeInTheDocument();
    expect(screen.getByText(/The counts could not be loaded/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "join" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText("No request matches these filters.")).toBeInTheDocument();
  });

  it("shows a failed list without hiding the page", async () => {
    const review = fake({ list: async () => { throw { status: 0, error: "unavailable" }; } });
    renderPage(review);
    expect(await screen.findByText(/not available right now/)).toBeInTheDocument();
    expect(screen.getByText("Updates sign-ups", { selector: ".xus-intake-statname" })).toBeInTheDocument();
  });

  it.each([
    [{ status: 403, error: "not-permitted" }, "This page is for Union Ground's intake reviewers.", "alert"],
    [{ status: 403, error: "mfa-required" }, "Sign in again with two-step verification to open this page.", "alert"],
    [{ status: 404, error: "not-available" }, "People waiting isn't available in the demo.", "status"],
  ])("refuses with one neutral sentence and no data (%o)", async (error, sentence, role) => {
    const review = vi.fn(async () => { throw error; });
    renderPage(review);
    expect(await screen.findByRole(role)).toHaveTextContent(sentence);
    expect(screen.queryByText("Updates sign-ups")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("renders in Spanish with the same keys in both tables", async () => {
    expect(Object.keys(intakeQueueCatalogue.es).sort()).toEqual(Object.keys(intakeQueueCatalogue.en).sort());
    renderPage(fake(), {}, "es");
    expect(await screen.findByText("Alex Fixtureperson")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Personas en espera" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exportar CSV" })).toBeInTheDocument();
  });

  it("shows the Email an update panel only when the page is given its route (REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118)", async () => {
    const { unmount } = renderPage(fake());
    expect(await screen.findByText("Alex Fixtureperson")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Email an update" })).toBeNull();
    unmount();
    const requestTopicSend = vi.fn(async (action) => {
      if (action === "overview") return { topics: [{ topic: "union_news", recipients: 3, sentToday: false }], sends: [], mail: { ready: true, missing: [] } };
      throw new Error(`unexpected ${action}`);
    });
    renderPage(fake(), { requestTopicSend });
    expect(await screen.findByRole("heading", { name: "Email an update" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Union news (3 people)" })).toBeInTheDocument();
    expect(requestTopicSend).toHaveBeenCalledWith("overview", {});
  });
});
