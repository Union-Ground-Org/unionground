// REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118 (owner
// option b): on People waiting, an invite request is passed to an existing
// organization's administrators, found by the start of its name and
// confirmed; the row then names where it went and how it was decided.
// requestReview is a fake that answers like POST /api/intake-review.
// Fictional fixtures only.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PeopleWaitingPage } from "../src/features/intakeQueue/PeopleWaitingPage.jsx";
import { inviteRowIds, passOrganizations, passesBySubmission, withPass } from "../src/features/intakeQueue/intakeApi.js";
import { intakeQueueCatalogue } from "../src/lib/i18n/intakeQueue.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const ID = (n) => `1a7a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = (n) => `2b8b0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const INVITE = {
  id: ID(1), kind: "invite", email: "alex@example.org", name: "Alex Fixtureperson", topic: null, locale: "en",
  organizationName: "Example Workers Local 12", role: null, sizeBand: null, state: null, phone: null,
  note: "North site.", campaignCode: null, status: "new", operatorNote: null, statusChangedAt: null,
  lastSubmittedAt: "2026-11-18T15:00:00Z", createdAt: "2026-11-17T23:30:00Z",
};
const UPDATES = { ...INVITE, id: ID(2), kind: "updates", name: null, email: "sam@example.org", topic: "union_news", organizationName: null, note: null };
const PASS = { submissionId: ID(1), organizationId: ORG(1), organizationName: "Example Workers Local 12", chapterName: "Main chapter", status: "pending", passedAt: "2026-11-18T21:00:00Z", decidedAt: null };

function fake(overrides = {}) {
  return vi.fn(async (action, payload) => {
    if (overrides[action]) return overrides[action](payload);
    if (action === "summary") return { counts: [], topics: [], daily: [], updatePeople: 0 };
    if (action === "list") return { requests: [INVITE, UPDATES], hasMore: false };
    if (action === "passes") return { passes: [] };
    if (action === "organizations") return { organizations: [{ id: ORG(1), name: "Example Workers Local 12" }, { id: ORG(2), name: "Example Workers Local 120" }] };
    throw new Error(`unexpected ${action}`);
  });
}

function renderPage(requestReview, lang = "en") {
  return render(<LanguageProvider lang={lang}><PeopleWaitingPage requestReview={requestReview} /></LanguageProvider>);
}

async function inviteRow() {
  const heading = await screen.findByText("Alex Fixtureperson");
  return heading.closest("li");
}

describe("pass helpers", () => {
  it("orders pass instants across fractional timestamp forms, preserving equal or invalid input order", () => {
    const later = { ...PASS, organizationId: ORG(2), passedAt: "2026-11-18T21:00:00.100Z" };
    expect(withPass({ [ID(1)]: [later] }, PASS)[ID(1)].map((entry) => entry.organizationId)).toEqual([ORG(2), ORG(1)]);
    const equal = { ...later, passedAt: "2026-11-18T21:00:00.000Z" };
    expect(withPass({ [ID(1)]: [equal] }, PASS)[ID(1)].map((entry) => entry.organizationId)).toEqual([ORG(1), ORG(2)]);
    const invalid = { ...later, passedAt: "unknown" };
    expect(withPass({ [ID(1)]: [invalid] }, PASS)[ID(1)].map((entry) => entry.organizationId)).toEqual([ORG(1), ORG(2)]);
    expect(withPass({ [ID(1)]: [later] }, { ...PASS, passedAt: null })[ID(1)].map((entry) => entry.organizationId)).toEqual([ORG(1), ORG(2)]);
  });

  it("asks only for invite rows, groups passes per request and keeps only known values", () => {
    expect(inviteRowIds([INVITE, UPDATES, { kind: "invite" }])).toEqual([ID(1)]);
    const grouped = passesBySubmission({ passes: [PASS, { ...PASS, organizationId: ORG(2), passedAt: "2026-11-18T22:00:00Z", status: "weird" }, { bad: true }] });
    expect(grouped[ID(1)].map((p) => [p.organizationId, p.status])).toEqual([[ORG(2), null], [ORG(1), "pending"]]);
    const replaced = withPass(grouped, { ...PASS, status: "approved" })[ID(1)];
    expect(replaced.map((entry) => entry.organizationId)).toEqual([ORG(2), ORG(1)]);
    expect(replaced[1]).toMatchObject({ organizationId: ORG(1), status: "approved" });
    expect(withPass({}, null)).toEqual({});
    expect(passOrganizations({ organizations: [{ id: ORG(1), name: "A", extra: 1 }, { id: 5 }] })).toEqual([{ id: ORG(1), name: "A" }]);
  });
});

describe("Pass to an organization", () => {
  it("finds the organization from the name the person typed, confirms, passes it and shows where it went", async () => {
    const review = fake({ pass: () => ({ passed: true, repeated: false, pass: PASS, request: { ...INVITE, status: "contacted" } }) });
    renderPage(review);
    const row = await inviteRow();
    await waitFor(() => expect(review).toHaveBeenCalledWith("passes", { ids: [ID(1)] }));
    // Only the invite row offers it.
    expect(screen.getAllByRole("button", { name: "Pass to an organization" })).toHaveLength(1);
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    expect(within(row).getByLabelText("Organization name starts with")).toHaveValue("Example Workers Local 12");
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("organizations", { search: "Example Workers Local 12" }));
    fireEvent.click(await within(row).findByRole("radio", { name: "Example Workers Local 12" }));
    expect(within(row).getByText(/Pass Alex Fixtureperson's request to Example Workers Local 12\?/)).toBeVisible();
    fireEvent.click(within(row).getByRole("button", { name: "Pass the request" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("pass", { id: ID(1), organizationId: ORG(1) }));
    expect(await screen.findByText("Alex Fixtureperson's request is now with Example Workers Local 12's administrators.")).toBeVisible();
    expect(within(row).getByText(/Example Workers Local 12 \(Main chapter\), .*: waiting for their decision/)).toBeVisible();
    expect(within(row).getByText("Invite requests · Contacted")).toBeVisible();
    expect(within(row).queryByRole("button", { name: "Pass the request" })).toBeNull();
  });

  it.each([["en", "approved"], ["es", "aprobada"]])("shows only the known approval decision in %s, without claiming email delivery", async (lang, label) => {
    renderPage(fake({ passes: () => ({ passes: [{ ...PASS, status: "approved" }] }) }), lang);
    const row = await inviteRow();
    const entry = await within(row).findByText(/Example Workers Local 12 \(Main chapter\),/);
    expect(entry.textContent).toMatch(new RegExp(`: ${label}$`));
  });

  it("keeps a newer successful pass when a delayed history response arrives", async () => {
    let resolveHistory;
    const newer = { ...PASS, organizationId: ORG(2), organizationName: "Example Workers Local 120" };
    const review = fake({
      passes: () => new Promise((resolve) => { resolveHistory = resolve; }),
      pass: () => ({ passed: true, pass: newer, request: { ...INVITE, status: "contacted" } }),
    });
    renderPage(review);
    const row = await inviteRow();
    await waitFor(() => expect(resolveHistory).toBeTypeOf("function"));
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    fireEvent.click(await within(row).findByRole("radio", { name: newer.organizationName }));
    fireEvent.click(within(row).getByRole("button", { name: "Pass the request" }));
    expect(await within(row).findByText(/Example Workers Local 120 \(Main chapter\),/)).toBeVisible();
    await act(async () => resolveHistory({ passes: [PASS] }));
    expect(within(row).getByText(/Example Workers Local 120 \(Main chapter\),/)).toBeVisible();
    expect(within(row).getByText(/Example Workers Local 12 \(Main chapter\),/)).toBeVisible();
  });

  it("keeps history that arrives while a pass is in flight instead of using its captured list", async () => {
    let resolveHistory, resolvePass;
    const newer = { ...PASS, organizationId: ORG(2), organizationName: "Example Workers Local 120" };
    renderPage(fake({
      passes: () => new Promise((resolve) => { resolveHistory = resolve; }),
      pass: () => new Promise((resolve) => { resolvePass = resolve; }),
    }));
    const row = await inviteRow();
    await waitFor(() => expect(resolveHistory).toBeTypeOf("function"));
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    fireEvent.click(await within(row).findByRole("radio", { name: newer.organizationName }));
    fireEvent.click(within(row).getByRole("button", { name: "Pass the request" }));
    await waitFor(() => expect(resolvePass).toBeTypeOf("function"));
    await act(async () => resolveHistory({ passes: [PASS] }));
    expect(within(row).getByText(/Example Workers Local 12 \(Main chapter\),/)).toBeVisible();
    await act(async () => resolvePass({ passed: true, pass: newer, request: { ...INVITE, status: "contacted" } }));
    expect(within(row).getByText(/Example Workers Local 12 \(Main chapter\),/)).toBeVisible();
    expect(within(row).getByText(/Example Workers Local 120 \(Main chapter\),/)).toBeVisible();
  });

  it("keeps the server's decision when delayed history already includes the newer local pass", async () => {
    let resolveHistory;
    const newer = { ...PASS, organizationId: ORG(2), organizationName: "Example Workers Local 120" };
    renderPage(fake({
      passes: () => new Promise((resolve) => { resolveHistory = resolve; }),
      pass: () => ({ passed: true, pass: newer, request: { ...INVITE, status: "contacted" } }),
    }));
    const row = await inviteRow();
    await waitFor(() => expect(resolveHistory).toBeTypeOf("function"));
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    fireEvent.click(await within(row).findByRole("radio", { name: newer.organizationName }));
    fireEvent.click(within(row).getByRole("button", { name: "Pass the request" }));
    expect(await within(row).findByText(/Example Workers Local 120 \(Main chapter\), .*waiting for their decision/)).toBeVisible();
    await act(async () => resolveHistory({ passes: [{ ...newer, status: "approved" }] }));
    expect(within(row).getByText(/Example Workers Local 120 \(Main chapter\), .*: approved$/)).toBeVisible();
  });

  it("keeps a newer server pass above an older local pass added after the history request", async () => {
    let resolveHistory;
    const local = { ...PASS, organizationId: ORG(2), organizationName: "Example Workers Local 120" };
    renderPage(fake({
      passes: () => new Promise((resolve) => { resolveHistory = resolve; }),
      pass: () => ({ passed: true, pass: local, request: { ...INVITE, status: "contacted" } }),
    }));
    const row = await inviteRow();
    await waitFor(() => expect(resolveHistory).toBeTypeOf("function"));
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    fireEvent.click(await within(row).findByRole("radio", { name: local.organizationName }));
    fireEvent.click(within(row).getByRole("button", { name: "Pass the request" }));
    expect(await within(row).findByText(/Example Workers Local 120 \(Main chapter\),/)).toBeVisible();
    await act(async () => resolveHistory({ passes: [{ ...PASS, passedAt: "2026-11-18T22:00:00Z" }] }));
    const history = within(row).getByText(/Example Workers Local 12 \(Main chapter\),/).closest("ul");
    const entries = within(history).getAllByRole("listitem");
    expect(entries[0]).toHaveTextContent(/^Example Workers Local 12 \(Main chapter\),/);
    expect(entries[1]).toHaveTextContent(/^Example Workers Local 120 \(Main chapter\),/);
  });

  it("refreshes counts from the click-time row instead of an older saved status", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    let reads = 0;
    const review = fake({
      list: () => { reads += 1; return { requests: [INVITE], hasMore: false }; },
      status: () => ({ updated: true, request: { ...INVITE, status: "contacted" } }),
      pass: () => ({ passed: true, pass: PASS, request: { ...INVITE, status: "contacted" } }),
    });
    try {
      renderPage(review);
      const row = await inviteRow();
      fireEvent.change(within(row).getByLabelText("Status"), { target: { value: "contacted" } });
      fireEvent.click(within(row).getByRole("button", { name: "Save status" }));
      expect(await within(row).findByText("Invite requests · Contacted")).toBeVisible();
      await waitFor(() => expect(review.mock.calls.filter(([action]) => action === "summary")).toHaveLength(2));
      now.mockReturnValue(2000);
      fireEvent.click(screen.getByRole("button", { name: "Show", exact: true }));
      await waitFor(() => expect(reads).toBe(2));
      const clicked = await inviteRow();
      expect(await within(clicked).findByText("Invite requests · New")).toBeVisible();
      fireEvent.click(within(clicked).getByRole("button", { name: "Pass to an organization" }));
      fireEvent.click(within(clicked).getByRole("button", { name: "Find" }));
      fireEvent.click(await within(clicked).findByRole("radio", { name: PASS.organizationName }));
      fireEvent.click(within(clicked).getByRole("button", { name: "Pass the request" }));
      expect(await within(clicked).findByText("Invite requests · Contacted")).toBeVisible();
      await waitFor(() => expect(review.mock.calls.filter(([action]) => action === "summary")).toHaveLength(3));
    } finally { now.mockRestore(); }
  });

  it("keeps where a request went on its row when its status is saved", async () => {
    const review = fake({
      passes: () => ({ passes: [PASS] }),
      status: () => ({ updated: true, request: { ...INVITE, status: "closed" } }),
    });
    renderPage(review);
    const row = await inviteRow();
    expect(await within(row).findByText(/waiting for their decision/)).toBeVisible();
    fireEvent.change(within(row).getByLabelText("Status"), { target: { value: "closed" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save status" }));
    expect(await within(row).findByText("Invite requests · Closed")).toBeVisible();
    expect(within(row).getByText(/Example Workers Local 12 \(Main chapter\), .*: waiting for their decision/)).toBeVisible();
  });

  it("asks for two letters, says when nothing matches, and names each refusal without changing the row", async () => {
    const answers = ["stopped", "no-administrator", "privacy-not-released", "changed", "something-new"];
    const review = fake({
      organizations: ({ search }) => ({ organizations: search === "Zz" ? [] : [{ id: ORG(3), name: "Example Workers Local 3" }] }),
      pass: () => ({ passed: false, refusal: answers.shift() }),
    });
    renderPage(review);
    const row = await inviteRow();
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    const search = within(row).getByLabelText("Organization name starts with");
    fireEvent.change(search, { target: { value: " E " } });
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    expect(await within(row).findByText("Type at least two letters of the organization's name.")).toBeVisible();
    expect(review).not.toHaveBeenCalledWith("organizations", expect.anything());
    fireEvent.change(search, { target: { value: "Zz" } });
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    expect(await within(row).findByText("No active organization starts with that.")).toBeVisible();
    fireEvent.change(search, { target: { value: "Example" } });
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    fireEvent.click(await within(row).findByRole("radio", { name: "Example Workers Local 3" }));
    for (const text of [
      "This address asked to stop hearing from Union Ground, so it can't be passed on.",
      "That organization has nobody who can decide invitations yet. Choose another.",
      "Passing requests is waiting for the privacy notice to be updated. You can still reply by email.",
      "That request changed. Reload it before passing it on.",
      "The request could not be passed on. Try again.",
    ]) {
      fireEvent.click(within(row).getByRole("button", { name: "Pass the request" }));
      expect(await screen.findByText(text)).toBeVisible();
    }
    expect(within(row).getByText("Invite requests · New")).toBeVisible();
  });

  it("says a repeat pass was already made, and drops a row that is gone", async () => {
    const review = fake({ pass: () => ({ passed: true, repeated: true, pass: PASS, request: INVITE }) });
    renderPage(review);
    let row = await inviteRow();
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    fireEvent.click(await within(row).findByRole("radio", { name: "Example Workers Local 12" }));
    fireEvent.click(within(row).getByRole("button", { name: "Pass the request" }));
    expect(await screen.findByText("Alex Fixtureperson's request was already passed to Example Workers Local 12.")).toBeVisible();

    const gone = fake({ pass: () => ({ passed: false, refusal: "not-found" }) });
    document.body.innerHTML = "";
    renderPage(gone);
    row = await inviteRow();
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    fireEvent.click(await within(row).findByRole("radio", { name: "Example Workers Local 12" }));
    fireEvent.click(within(row).getByRole("button", { name: "Pass the request" }));
    expect(await screen.findByText("That request is no longer on file. The person may have asked to stop.")).toBeVisible();
    expect(screen.queryByText("Alex Fixtureperson")).toBeNull();
  });

  it("shows a committed pass as passed when the reply is lost", async () => {
    let committed = false;
    const review = fake({
      passes: () => ({ passes: committed ? [PASS] : [] }),
      pass: () => { committed = true; return Promise.reject(new Error("timeout")); },
    });
    renderPage(review);
    const row = await inviteRow();
    await waitFor(() => expect(review).toHaveBeenCalledWith("passes", { ids: [ID(1)] }));
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    fireEvent.click(await within(row).findByRole("radio", { name: "Example Workers Local 12" }));
    fireEvent.click(within(row).getByRole("button", { name: "Pass the request" }));
    expect(await screen.findByText("Alex Fixtureperson's request is now with Example Workers Local 12's administrators.")).toBeVisible();
    expect(within(row).getByText(/Example Workers Local 12 \(Main chapter\), .*: waiting for their decision/)).toBeVisible();
    expect(screen.queryByText("The request could not be passed on. Try again.")).toBeNull();
    expect(review.mock.calls.filter(([action]) => action === "passes")).toHaveLength(2);
  });

  it("says already passed when the reply is lost and the organization was in the row's history", async () => {
    const review = fake({
      passes: () => ({ passes: [{ ...PASS, status: "declined" }] }),
      pass: () => Promise.reject(new Error("timeout")),
    });
    renderPage(review);
    const row = await inviteRow();
    expect(await within(row).findByText(/Example Workers Local 12 \(Main chapter\), .*: declined/)).toBeVisible();
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    fireEvent.click(await within(row).findByRole("radio", { name: "Example Workers Local 12" }));
    fireEvent.click(within(row).getByRole("button", { name: "Pass the request" }));
    expect(await screen.findByText("Alex Fixtureperson's request was already passed to Example Workers Local 12.")).toBeVisible();
    expect(screen.queryByText(/request is now with/)).toBeNull();
    expect(review.mock.calls.filter(([action]) => action === "passes")).toHaveLength(2);
  });

  it.each([
    ["the history lacks the pass", () => ({ passes: [{ ...PASS, organizationId: ORG(2), organizationName: "Example Workers Local 120" }] })],
    ["the history read fails too", () => Promise.reject(new Error("offline"))],
  ])("says not confirmed when the reply is lost and %s", async (_case, reread) => {
    let lost = false;
    const review = fake({
      passes: () => (lost ? reread() : { passes: [] }),
      pass: () => { lost = true; return Promise.reject(new Error("timeout")); },
    });
    renderPage(review);
    const row = await inviteRow();
    await waitFor(() => expect(review).toHaveBeenCalledWith("passes", { ids: [ID(1)] }));
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    fireEvent.click(await within(row).findByRole("radio", { name: "Example Workers Local 12" }));
    fireEvent.click(within(row).getByRole("button", { name: "Pass the request" }));
    expect(await screen.findByText(intakeQueueCatalogue.en["intakeQueue.pass.unconfirmed"])).toBeVisible();
    expect(screen.queryByText("The request could not be passed on. Try again.")).toBeNull();
    expect(screen.queryByText(/request is now with/)).toBeNull();
    expect(review.mock.calls.filter(([action]) => action === "passes")).toHaveLength(2);
  });

  it("replaces the page when the server says the caller is no longer an intake reviewer", async () => {
    renderPage(fake({ organizations: () => Promise.reject({ status: 403, error: "not-permitted", reason: null }) }));
    const row = await inviteRow();
    fireEvent.click(within(row).getByRole("button", { name: "Pass to an organization" }));
    fireEvent.click(within(row).getByRole("button", { name: "Find" }));
    expect(await screen.findByText("This page is for Union Ground's intake reviewers.")).toBeVisible();
  });

  it("speaks Spanish, with every pass key in both tables", async () => {
    const en = Object.keys(intakeQueueCatalogue.en).filter((key) => key.startsWith("intakeQueue.pass."));
    const es = Object.keys(intakeQueueCatalogue.es).filter((key) => key.startsWith("intakeQueue.pass."));
    expect(es.sort()).toEqual(en.sort());
    renderPage(fake(), "es");
    const row = await inviteRow();
    fireEvent.click(within(row).getByRole("button", { name: "Enviar a una organización" }));
    expect(within(row).getByLabelText("El nombre de la organización empieza con")).toBeVisible();
  });
});
