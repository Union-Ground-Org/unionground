// Email an update (REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118):
// the People waiting panel. requestSend is a fake that answers like
// POST /api/intake-topic-send (the route's `result`, or a rejection
// `{ status, error, reason, missing }`); nothing touches the network and
// nothing is ever sent to a list. Fictional fixtures only.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopicUpdatePanel } from "../src/features/intakeQueue/TopicUpdatePanel.jsx";
import { cleanUpdate, refusalKey, requestTopicSend, updateReady, updateSignature } from "../src/features/intakeQueue/topicSendApi.js";
import { topicUpdateCatalogue } from "../src/lib/i18n/topicUpdate.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

const TEST_ID = "1a7a0000-0000-4000-8000-000000000001";
const SEND_ID = "1a7a0000-0000-4000-8000-000000000002";
const OVERVIEW = {
  today: "2026-11-18",
  topics: [
    { topic: "chapter_updates", recipients: 3, sentToday: false },
    { topic: "public_meetings", recipients: 0, sentToday: false },
    { topic: "union_news", recipients: 5, sentToday: true },
  ],
  sends: [{ id: SEND_ID, kind: "list", topic: "union_news", subject: "Example news", status: "sending", queued: 5, sent: 2, failed: 1, skipped: 0, createdAt: "2026-11-18T15:00:00Z", mine: true }],
  mail: { ready: true, missing: [] },
};

function fake(overrides = {}) {
  return vi.fn(async (action, payload) => {
    if (overrides[action]) return overrides[action](payload);
    if (action === "overview") return OVERVIEW;
    if (action === "preview") return { topic: payload.topic, recipients: 3, sentToday: false, email: { en: { html: "<p>English frame</p>" }, es: { html: "<p>Marco en español</p>" } } };
    if (action === "test") return { delivered: true, send: { id: TEST_ID, sent: 1 } };
    if (action === "send") return { send: { id: SEND_ID, queued: 3 } };
    throw new Error(`unexpected ${action}`);
  });
}

function renderPanel(requestSend, lang = "en") {
  return render(<LanguageProvider lang={lang}><TopicUpdatePanel requestSend={requestSend} /></LanguageProvider>);
}

async function write(subject = "Spring meeting dates", body = "Hello.\n\nThe spring meetings are set.") {
  fireEvent.change(await screen.findByLabelText("Subject"), { target: { value: subject } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: body } });
}

const sendButton = () => screen.getByRole("button", { name: /^Send to \d+ people$/ });

describe("topicSendApi", () => {
  it("throws one plain shape for every failure and returns the route's result", async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: { topics: [] } }) }));
    await expect(requestTopicSend({ fetchImpl: ok, accessToken: "tok", action: "overview" })).resolves.toEqual({ topics: [] });
    expect(ok.mock.calls[0][0]).toBe("/api/intake-topic-send");
    expect(JSON.parse(ok.mock.calls[0][1].body)).toEqual({ action: "overview" });
    expect(ok.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
    const missing = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "mail-unavailable", missing: ["NOTIFY_FROM_ADDRESS", 4] }) }));
    await expect(requestTopicSend({ fetchImpl: missing, accessToken: "tok", action: "test" }))
      .rejects.toEqual({ status: 503, error: "mail-unavailable", reason: null, missing: ["NOTIFY_FROM_ADDRESS"] });
    const down = vi.fn(async () => { throw new Error("offline"); });
    await expect(requestTopicSend({ fetchImpl: down, accessToken: "tok", action: "overview" })).rejects.toMatchObject({ status: 0, error: "unavailable" });
  });

  it("knows when the text on screen is the text it tested", () => {
    const update = { topic: "chapter_updates", subject: " Spring ", body: "Hello.\r\n\r\nSet.\n" };
    expect(cleanUpdate(update)).toEqual({ topic: "chapter_updates", subject: "Spring", body: "Hello.\n\nSet." });
    expect(updateSignature(update)).toBe(updateSignature({ topic: "chapter_updates", subject: "Spring", body: "Hello.\n\nSet." }));
    expect(updateSignature(update)).not.toBe(updateSignature({ ...update, body: "Hello." }));
    expect(updateReady(update)).toBe(true);
    expect(updateReady({ ...update, subject: "x".repeat(151) })).toBe(false);
    expect(updateReady({ ...update, body: " " })).toBe(false);
    expect(updateReady({ ...update, topic: "request_invite" })).toBe(false);
    expect(refusalKey({ status: 409, error: "refused", reason: "already-sent-today" })).toBe("already-sent-today");
    expect(refusalKey({ status: 409, error: "refused", reason: "made-up" })).toBe("generic");
    expect(refusalKey({ status: 503, error: "mail-unavailable" })).toBe("mail-unavailable");
  });

  it("declares every key in both languages", () => {
    expect(Object.keys(topicUpdateCatalogue.es).sort()).toEqual(Object.keys(topicUpdateCatalogue.en).sort());
  });
});

describe("TopicUpdatePanel", () => {
  it("shows the count per topic and the recent sends with their counts", async () => {
    renderPanel(fake());
    const topic = await screen.findByLabelText("Topic");
    await waitFor(() => expect(within(topic).getByRole("option", { name: "Campaign updates (3 people)" })).toBeTruthy());
    expect(screen.getByText("Example news")).toBeTruthy();
    expect(screen.getByText("Queued 5 · Sent 2 · Failed 1 · Skipped 0")).toBeTruthy();
    expect(screen.getByText(/Update · Union news · Sending · Nov 18, 2026, 10:00 AM EST · You/)).toBeTruthy();
  });

  it("previews the server's email in a sandboxed frame in either frame language", async () => {
    const requestSend = fake();
    renderPanel(requestSend);
    await write();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const frame = await screen.findByTitle("Preview of the email");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toBe("<p>English frame</p>");
    expect(screen.getByText("Goes to 3 people.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Show the email's frame in"), { target: { value: "es" } });
    expect(screen.getByTitle("Preview of the email").getAttribute("srcdoc")).toBe("<p>Marco en español</p>");
    expect(requestSend).toHaveBeenCalledWith("preview", { topic: "chapter_updates", subject: "Spring meeting dates", body: "Hello.\n\nThe spring meetings are set." });
  });

  it("keeps Send unavailable until a delivered test of exactly this text, asks once more, then queues it with that test", async () => {
    const requestSend = fake();
    renderPanel(requestSend);
    await write();
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText("Send yourself a test of this exact update first.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send a test to me" }));
    expect(await screen.findByText("The test went to your own address. Read it, then send.")).toBeTruthy();
    const [, testPayload] = requestSend.mock.calls.find(([action]) => action === "test");
    expect(testPayload).toMatchObject({ topic: "chapter_updates", subject: "Spring meeting dates" });
    expect(testPayload.key).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(sendButton().disabled).toBe(false));

    // Editing after the test needs a new test.
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Changed." } });
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText("The update changed after your test. Send a new test before you send it.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hello.\n\nThe spring meetings are set.\n" } });
    expect(sendButton().disabled).toBe(false);

    fireEvent.click(sendButton());
    expect(screen.getByText("Send this update to 3 people?")).toBeTruthy();
    expect(requestSend.mock.calls.some(([action]) => action === "send")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Send this update to 3 people?")).toBeNull();
    fireEvent.click(sendButton());
    fireEvent.click(screen.getByRole("button", { name: "Yes, send it" }));
    expect(await screen.findByText(/Queued for 3 people\./)).toBeTruthy();
    const [, sendPayload] = requestSend.mock.calls.find(([action]) => action === "send");
    expect(sendPayload).toMatchObject({ topic: "chapter_updates", subject: "Spring meeting dates", body: "Hello.\n\nThe spring meetings are set.", testSendId: TEST_ID });
    expect(sendPayload.key).not.toBe(testPayload.key);
    await waitFor(() => expect(sendButton().disabled).toBe(true));
  });

  it.each([
    ["to another topic", ["union_news"]],
    ["away and back to the same topic", ["union_news", "chapter_updates"]],
  ])("drops a preview reply that arrives after the topic changed %s", async (_name, topics) => {
    let answer;
    const requestSend = fake({ preview: (payload) => new Promise((resolve) => { answer = () => resolve({ topic: payload.topic, recipients: 3, sentToday: false, email: { en: { html: "<p>Campaign updates frame</p>" }, es: { html: "<p>Marco</p>" } } }); }) });
    renderPanel(requestSend);
    await write();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    // The topic stays usable while a preview is out, as it was before.
    expect(screen.getByLabelText("Topic").disabled).toBe(false);
    for (const topic of topics) fireEvent.change(screen.getByLabelText("Topic"), { target: { value: topic } });
    answer();
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview" }).disabled).toBe(false));
    expect(screen.queryByTitle("Preview of the email")).toBeNull();
    expect(screen.queryByText("Goes to 3 people.")).toBeNull();
    expect(sendButton().disabled).toBe(true);
  });

  it("says why a topic cannot be sent today, has nobody, or mail is not set up", async () => {
    renderPanel(fake({ overview: () => ({ ...OVERVIEW, mail: { ready: false, missing: ["NOTIFY_FROM_ADDRESS"] } }) }));
    expect(await screen.findByText("Email sending is not set up yet. Missing setting: NOTIFY_FROM_ADDRESS.")).toBeTruthy();
    await write();
    expect(screen.getByRole("button", { name: "Send a test to me" }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "union_news" } });
    expect(screen.getByText("This topic already had its update today (Eastern). The next one can go out tomorrow.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "public_meetings" } });
    expect(screen.getByText("Nobody is waiting on this topic yet.")).toBeTruthy();
  });

  it("shows the database's refusal and a failed test plainly", async () => {
    renderPanel(fake({
      test: () => ({ delivered: false, send: { id: TEST_ID } }),
    }));
    await write();
    fireEvent.click(screen.getByRole("button", { name: "Send a test to me" }));
    expect(await screen.findByText("The test could not be sent. Try again in a few minutes.")).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  });

  it("names a refusal from the route", async () => {
    renderPanel(fake({ test: () => { throw { status: 409, error: "refused", reason: "test-limit", missing: [] }; } }));
    await write();
    fireEvent.click(screen.getByRole("button", { name: "Send a test to me" }));
    expect((await screen.findByRole("alert")).textContent).toBe("You have sent ten tests today. Try again tomorrow.");
  });

  it("speaks Spanish", async () => {
    renderPanel(fake(), "es");
    expect(await screen.findByRole("heading", { name: "Enviar una novedad por correo" })).toBeTruthy();
    expect(await screen.findByRole("option", { name: "Novedades de campañas (3 personas)" })).toBeTruthy();
  });
});

// Each write control here is pending while its own write runs, so
// it keeps keyboard focus and refuses a second press. Its siblings (and Send to
// N and Cancel, which start no write) are natively unavailable only while
// another control's write runs, which is why config/busy-control-exemptions.json
// lists them.
describe("TopicUpdatePanel keeps focus on the control whose write runs (record 8435)", () => {
  it("holds focus on Preview, Send a test, Refresh and Yes, send it while each one's request is held", async () => {
    const requestSend = fake();
    renderPanel(requestSend);
    await write();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send a test to me" }).disabled).toBe(false));
    const preview = screen.getByRole("button", { name: "Preview" });
    const refresh = screen.getByRole("button", { name: "Refresh" });
    let siblingsDuringPreview = null;
    await expectHeldWriteFocus(requestSend, preview, () => {
      fireEvent.click(preview);
      queueMicrotask(() => { siblingsDuringPreview = [screen.getByRole("button", { name: "Send a test to me" }).disabled, refresh.disabled]; });
    });
    expect(siblingsDuringPreview).toEqual([true, true]);
    await waitFor(() => expect(refresh.disabled).toBe(false));
    await expectHeldWriteFocus(requestSend, refresh);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send a test to me" }).disabled).toBe(false));
    await expectHeldWriteFocus(requestSend, screen.getByRole("button", { name: "Send a test to me" }));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await expectHeldWriteFocus(requestSend, screen.getByRole("button", { name: "Yes, send it" }));
    expect(await screen.findByText(/Queued for 3 people\./)).toBeTruthy();
  });
});

// Yes, send it is removed as soon as the send is queued,
// before the list of sends is read again. Focus goes to the status line that
// says it was queued, not to the page, unless the reviewer moved on meanwhile.
describe("TopicUpdatePanel moves focus to its status line when a queued send removes Yes, send it (ledger 621)", () => {
  async function confirmShown(requestSend) {
    renderPanel(requestSend);
    await write();
    fireEvent.click(screen.getByRole("button", { name: "Send a test to me" }));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    return screen.getByRole("button", { name: "Yes, send it" });
  }

  it("focuses the queued line, and the line keeps its polite announcement", async () => {
    enableFocusFixup();
    const yes = await confirmShown(fake());
    yes.focus();
    fireEvent.click(yes);
    const queued = await screen.findByText(/Queued for 3 people\./);
    await act(async () => { await afterRenderingUpdate(); });
    expect(yes.isConnected).toBe(false);
    expect(queued).toHaveFocus();
    expect(queued).toHaveAttribute("role", "status");
    expect(queued).toHaveAttribute("aria-live", "polite");
  });

  it("leaves focus where the reviewer moved it while the send ran", async () => {
    enableFocusFixup();
    let answer;
    const requestSend = fake({ send: () => new Promise((resolve) => { answer = () => resolve({ send: { id: SEND_ID, queued: 3 } }); }) });
    const yes = await confirmShown(requestSend);
    yes.focus();
    fireEvent.click(yes);
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    const subject = screen.getByLabelText("Subject");
    subject.focus();
    await act(async () => { answer(); });
    await screen.findByText(/Queued for 3 people\./);
    await act(async () => { await afterRenderingUpdate(); });
    expect(yes.isConnected).toBe(false);
    expect(subject).toHaveFocus();
  });
});
