// Record 8435 on People waiting: each row write control (Save status, Save
// note, Pass to this organization, Send founder invitation) is pending while
// its own write runs, so it keeps keyboard focus and refuses a second press.
// Its siblings in the row (the status choice, Pass to an organization, Invite
// the founder, Cancel) start no write and are natively unavailable only while
// another control's write runs, which is why config/busy-control-exemptions.json
// lists them. requestReview is a fake that answers like POST /api/intake-review.
// Fictional fixtures only.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PeopleWaitingPage } from "../src/features/intakeQueue/PeopleWaitingPage.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

const ID = (n) => `1a7a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = "2b8b0000-0000-4000-8000-000000000001";
const INVITE = {
  id: ID(1), kind: "invite", email: "alex@example.org", name: "Alex Fixtureperson", topic: null, locale: "en",
  organizationName: "Example Workers Local 12", role: null, sizeBand: null, state: null, phone: null,
  note: null, campaignCode: null, status: "new", operatorNote: null, statusChangedAt: null,
  lastSubmittedAt: "2026-11-18T15:00:00Z", createdAt: "2026-11-17T23:30:00Z",
};
const JOIN = { ...INVITE, id: ID(2), kind: "join", email: "founder@example.org", name: "Jo Fixtureperson", organizationName: "Example Intake Union" };

function fake() {
  return vi.fn(async (action, payload) => {
    if (action === "summary") return { counts: [], topics: [], daily: [], updatePeople: 0 };
    if (action === "list") return { requests: [INVITE, JOIN], hasMore: false };
    if (action === "passes") return { passes: [] };
    if (action === "organizations") return { organizations: [{ id: ORG, name: "Example Workers Local 12" }] };
    if (action === "status") return { updated: true, request: { ...(payload.id === JOIN.id ? JOIN : INVITE), status: payload.status } };
    if (action === "note") return { updated: true, request: { ...INVITE, operatorNote: payload.note } };
    if (action === "pass") return { passed: true, pass: { submissionId: INVITE.id, organizationId: ORG, organizationName: "Example Workers Local 12", chapterName: "Main chapter", status: "pending", passedAt: "2026-11-18T21:00:00Z" } };
    if (action === "founder") return { invited: true, delivery: "sent", invitationId: JOIN.id, request: { ...JOIN, status: "invited", founderInvitation: { id: JOIN.id, status: "pending" } } };
    throw new Error(`unexpected ${action}`);
  });
}

async function row(name) {
  return (await screen.findByText(name)).closest("li");
}

describe("People waiting keeps focus on the row control whose write runs (record 8435)", () => {
  it("holds focus on Save status and Save note while each save is held; the status choice waits natively", async () => {
    const review = fake();
    render(<LanguageProvider lang="en"><PeopleWaitingPage requestReview={review} /></LanguageProvider>);
    const item = await row("Alex Fixtureperson");
    await waitFor(() => expect(review).toHaveBeenCalledWith("passes", expect.anything()));
    const choice = within(item).getByLabelText("Status");
    fireEvent.change(choice, { target: { value: "contacted" } });
    const saveStatus = within(item).getByRole("button", { name: "Save status" });
    let choiceDuringSave = null;
    await expectHeldWriteFocus(review, saveStatus, () => {
      fireEvent.click(saveStatus);
      queueMicrotask(() => { choiceDuringSave = choice.disabled; });
    });
    expect(choiceDuringSave).toBe(true);
    expect(await screen.findByText("Status saved for Alex Fixtureperson.")).toBeInTheDocument();
    fireEvent.change(within(item).getByLabelText(/Private note/), { target: { value: "Called back." } });
    await expectHeldWriteFocus(review, within(item).getByRole("button", { name: "Save note" }));
    expect(await screen.findByText("Note saved for Alex Fixtureperson.")).toBeInTheDocument();
  });

  it("holds focus on the pass confirm while the pass is held", async () => {
    const review = fake();
    render(<LanguageProvider lang="en"><PeopleWaitingPage requestReview={review} /></LanguageProvider>);
    const item = await row("Alex Fixtureperson");
    fireEvent.click(within(item).getByRole("button", { name: /Pass to an organization/ }));
    fireEvent.click(within(item).getByRole("button", { name: /Find/ }));
    fireEvent.click(await within(item).findByRole("radio", { name: "Example Workers Local 12" }));
    await expectHeldWriteFocus(review, within(item).getByRole("button", { name: /^Pass / }));
    expect(review.mock.calls.filter(([action]) => action === "pass")).toHaveLength(1);
  });

  it("holds focus on Send founder invitation while the invitation is held", async () => {
    const review = fake();
    render(<LanguageProvider lang="en"><PeopleWaitingPage requestReview={review} /></LanguageProvider>);
    const item = await row("Jo Fixtureperson");
    fireEvent.click(within(item).getByRole("button", { name: "Invite the founder" }));
    fireEvent.change(within(item).getByLabelText("Founder's full name"), { target: { value: "Jo Fixtureperson" } });
    const send = within(item).getByRole("button", { name: "Send founder invitation" });
    let cancelDuringSend = null;
    await expectHeldWriteFocus(review, send, () => {
      fireEvent.click(send);
      queueMicrotask(() => { cancelDuringSend = within(item).getByRole("button", { name: "Cancel" }).disabled; });
    });
    expect(cancelDuringSend).toBe(true);
    expect(review.mock.calls.filter(([action]) => action === "founder")).toHaveLength(1);
  });
});

// A successful action that removes the control the
// operator pressed (the pass form closes, the founder form becomes its linked
// invitation, a saved status moves the row out of the status filter) hands
// focus to the page's status line instead of letting it fall to the page. The
// browser's focus fixup is on, as in a real browser.
describe("People waiting moves focus to its status line when a success removes the pressed control (ledger 621)", () => {
  it("after a pass closes the pass form", async () => {
    enableFocusFixup();
    const review = fake();
    render(<LanguageProvider lang="en"><PeopleWaitingPage requestReview={review} /></LanguageProvider>);
    const item = await row("Alex Fixtureperson");
    fireEvent.click(within(item).getByRole("button", { name: /Pass to an organization/ }));
    fireEvent.click(within(item).getByRole("button", { name: /Find/ }));
    fireEvent.click(await within(item).findByRole("radio", { name: "Example Workers Local 12" }));
    const submit = within(item).getByRole("button", { name: "Pass the request" });
    submit.focus();
    fireEvent.click(submit);
    const done = await screen.findByText("Alex Fixtureperson's request is now with Example Workers Local 12's administrators.");
    await act(async () => { await afterRenderingUpdate(); });
    expect(submit.isConnected).toBe(false);
    expect(done).toHaveFocus();
  });

  it("after the founder form becomes its linked invitation", async () => {
    enableFocusFixup();
    const review = fake();
    render(<LanguageProvider lang="en"><PeopleWaitingPage requestReview={review} /></LanguageProvider>);
    const item = await row("Jo Fixtureperson");
    fireEvent.click(within(item).getByRole("button", { name: "Invite the founder" }));
    fireEvent.change(within(item).getByLabelText("Founder's full name"), { target: { value: "Jo Fixtureperson" } });
    const send = within(item).getByRole("button", { name: "Send founder invitation" });
    send.focus();
    fireEvent.click(send);
    const done = await screen.findByText("Founder invitation sent. The request is now Invited.");
    await act(async () => { await afterRenderingUpdate(); });
    expect(send.isConnected).toBe(false);
    expect(done).toHaveFocus();
  });

  it("after a saved status moves the row out of the status filter, and not when focus went elsewhere", async () => {
    enableFocusFixup();
    const review = fake();
    render(<LanguageProvider lang="en"><PeopleWaitingPage requestReview={review} /></LanguageProvider>);
    const filters = await screen.findByRole("form", { name: "Filter the list" });
    fireEvent.change(within(filters).getByLabelText("Status"), { target: { value: "new" } });
    fireEvent.click(within(filters).getByRole("button", { name: "Show" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("list", expect.objectContaining({ status: "new" })));
    const item = await row("Alex Fixtureperson");
    fireEvent.change(within(item).getByLabelText("Status"), { target: { value: "contacted" } });
    const save = within(item).getByRole("button", { name: "Save status" });
    save.focus();
    fireEvent.click(save);
    const done = await screen.findByText("Status saved for Alex Fixtureperson.");
    await act(async () => { await afterRenderingUpdate(); });
    expect(save.isConnected).toBe(false);
    expect(done).toHaveFocus();

    // An operator who moved on while the save ran keeps their place.
    const other = await row("Jo Fixtureperson");
    fireEvent.change(within(other).getByLabelText("Status"), { target: { value: "contacted" } });
    const search = within(filters).getByRole("searchbox");
    const saveOther = within(other).getByRole("button", { name: "Save status" });
    saveOther.focus();
    fireEvent.click(saveOther);
    search.focus();
    expect(await screen.findByText("Status saved for Jo Fixtureperson.")).toBeInTheDocument();
    await act(async () => { await afterRenderingUpdate(); });
    expect(saveOther.isConnected).toBe(false);
    expect(search).toHaveFocus();
  });
});
