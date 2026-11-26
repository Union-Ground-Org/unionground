//  W2-1 (split from; its final r3s1/r4s1): a shared save that fails
// with a network error once the request may have left says it could not be
// confirmed and asks the person to check before sending again. It never says
// "not saved" (a committed reply would then be sent twice) and never shows the
// browser's "Failed to fetch".
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isUnconfirmedWrite, mutationFailureNotice } from "../src/App.jsx";
import { catalogue, t } from "../src/lib/i18n.js";
import { sendMemberMessage, startMemberConversation } from "../src/lib/memberApi.js";
import { MemberApiError } from "../src/lib/memberApiError.js";
import { isOfflineError, isRequestTimeoutError } from "../src/lib/outbox.js";
import { memberMutationResources } from "../src/lib/memberSessionLoader.js";
import { createSessionBoundDataClient } from "../src/lib/sessionBoundDataClient.js";
// Union Ground has no member PIN step-up; the extracted handlers still take the slot.
const isStepUpRequired = () => false;

const { en, es } = catalogue;
const tr = (key, vars) => t("en", key, vars);
afterEach(() => { vi.restoreAllMocks(); });

describe("the save-failure sentence", () => {
  it("says the save could not be confirmed, in English and Spanish, never the driver's text", () => {
    const lost = new MemberApiError("Send message", { message: "TypeError: Failed to fetch" });
    expect(mutationFailureNotice(tr, lost, null)).toBe(en["offline.unconfirmed"]);
    expect(mutationFailureNotice((key, vars) => t("es", key, vars), lost, "toast.saveFailed")).toBe(es["offline.unconfirmed"]);
    expect(en["offline.unconfirmed"]).not.toMatch(/not saved/i);
  });

  it("keeps the sentences of an answer that came back (even while the browser says offline) and of a timeout", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    expect(mutationFailureNotice(tr, new MemberApiError("Book", { message: "conflict", code: "409" }), "toast.saveFailed")).toBe(en["toast.saveFailed"]);
    expect(mutationFailureNotice(tr, Object.assign(new Error("x"), { name: "TimeoutError" }), null)).toBe(en["error.requestTimedOut"]);
  });

  it("the banner no longer promises that every save will sync", () => {
    expect(en["offline.banner"]).toMatch(/Some changes will sync .*others need a connection/);
    expect(es["offline.banner"]).toMatch(/Algunos cambios .*otros necesitan conexión/);
  });
});

// The production write path from src/App.jsx (mutate/mutateWithOutcome) with
// the real sendMemberMessage over the real session-bound data client.
describe("a reply sent while offline, reconnecting during the session check", () => {
  const source = readFileSync("src/App.jsx", "utf8");
  const start = source.indexOf("  async function mutate(");
  const mutation = source.slice(start, source.indexOf("\n  function handlePlanAction", start));
  const names = ["memberOperation", "demoActive", "sessionRef", "isOfflineError", "enqueueOffline", "isStepUpRequired", "setSessionRestricted",
    "setStepUpOpen", "setNotice", "mutationFailureNotice", "tr", "refresh", "captureProductAction", "captureSanitizedDiagnostic", "setDataError",
    "isRequestTimeoutError", "learningToastAction", "learningPeriod", "captureDemoAction", "view"];

  it("says it could not be confirmed, not that it was not saved", async () => {
    const online = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    let finishCheck;
    const checking = new Promise((resolve) => { finishCheck = resolve; });
    const rpc = vi.fn(async () => ({ data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } }));
    // The writer's session check is still running when the device reconnects;
    // the reply then leaves, may be stored, and its answer is lost.
    const writer = { client: async () => { await checking; return { rpc }; }, session: async () => ({}) };
    const data = createSessionBoundDataClient(writer, null);
    const notices = [];
    // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
    const mutateWithOutcome = new Function(...names, `${mutation}\nreturn mutateWithOutcome;`)(
      { run: (fn) => fn(), wait: (value) => value, assertCurrent: () => {} }, false, { current: { user: { id: "member" } } },
      isOfflineError, async () => false, isStepUpRequired, () => {}, () => {}, (notice) => notices.push(notice), mutationFailureNotice,
      tr, async () => {}, () => {}, () => {}, () => {}, isRequestTimeoutError, () => null, null, () => {}, "messages");
    const sending = mutateWithOutcome(["conversations"], () => sendMemberMessage(data, "conversation-1", "See you at the meeting"), "Sent");
    online.mockReturnValue(true);
    finishCheck();
    await expect(sending).rejects.toThrow();
    expect(rpc).toHaveBeenCalledWith("send_member_message", { p_conversation_id: "conversation-1", p_body: "See you at the meeting" });
    expect(notices.at(-1)).toBe(en["offline.unconfirmed"]);
    expect(notices.at(-1)).not.toMatch(/Failed to fetch/);
  });
});

// After a lost answer the person is told to check, so
// the real handlers reload what the write would have changed before the error
// reaches the dialog (the draft stays). An answer that came back reloads nothing.
describe("the message handlers after a lost answer", () => {
  const source = readFileSync("src/App.jsx", "utf8");
  const slice = (from, to) => { const at = source.indexOf(from); return source.slice(at, source.indexOf(to, at)); };
  const mutation = slice("  async function mutate(", "\n  function handlePlanAction");
  const handlers = slice("  async function handleSendMemberMessage(", "\n  const demoStewardContactRef");
  const names = ["memberOperation", "demoActive", "sessionRef", "isOfflineError", "enqueueOffline", "isStepUpRequired", "setSessionRestricted",
    "setStepUpOpen", "setNotice", "mutationFailureNotice", "tr", "refresh", "captureProductAction", "captureSanitizedDiagnostic", "setDataError",
    "isRequestTimeoutError", "learningToastAction", "learningPeriod", "captureDemoAction", "view", "session", "data", "patchConversation",
    "conversationDateLabel", "lang", "memberMutationResources", "sendMemberMessage", "startMemberConversation", "sessionDataClient",
    "memberLoaderRef", "setData", "isUnconfirmedWrite"];
  function build(answer, { enqueued = false } = {}) {
    const state = { notices: [], refreshes: [], conversation: { id: "c1", preview: "Hello", messages: [{ id: "m0", body: "Hello", created_at: "2026-11-22T12:00:00Z" }] } };
    const rpc = vi.fn(async () => answer);
    const client = createSessionBoundDataClient({ client: async () => ({ rpc }), session: async () => ({}) }, null);
    const refresh = vi.fn(async (_session, resources) => { state.refreshes.push({ resources, bubbles: state.conversation.messages.length }); });
    // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
    const made = new Function(...names, `${mutation}\n${handlers}\nreturn { handleSendMemberMessage, handleStartMemberConversation, mutateWithOutcome };`)(
      { run: (fn) => fn(), wait: (value) => value, assertCurrent: () => {} }, false, { current: { user: { id: "member" } } },
      isOfflineError, async () => enqueued, isStepUpRequired, () => {}, () => {}, (notice) => state.notices.push(notice), mutationFailureNotice,
      tr, refresh, () => {}, () => {}, () => {}, isRequestTimeoutError, () => null, null, () => {}, "messages", { user: { id: "member" } },
      { member: { fullName: "Member" } }, (_id, change) => { state.conversation = change(state.conversation); }, () => "now", "en",
      memberMutationResources, sendMemberMessage, startMemberConversation, client, { current: null }, () => {}, isUnconfirmedWrite);
    return { state, rpc, refresh, ...made };
  }
  const lost = { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } };

  it("a reply whose answer was lost: says to check, and reloads the thread after dropping the pending bubble", async () => {
    const { state, refresh, handleSendMemberMessage } = build(lost);
    await expect(handleSendMemberMessage("c1", "See you at the meeting")).rejects.toThrow();
    expect(state.notices.at(-1)).toBe(en["offline.unconfirmed"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(state.refreshes[0]).toEqual({ resources: memberMutationResources("sendMemberMessage"), bubbles: 1 });
  });

  it("a reply the server refused: no reload, the refusal stands", async () => {
    const { refresh, handleSendMemberMessage } = build({ data: null, error: { message: "not permitted", details: "", hint: "", code: "42501" } });
    await expect(handleSendMemberMessage("c1", "See you at the meeting")).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a new conversation whose answer was lost: reloads the inbox", async () => {
    const { state, refresh, handleStartMemberConversation } = build(lost);
    await expect(handleStartMemberConversation("First question")).rejects.toThrow();
    expect(state.notices.at(-1)).toBe(en["offline.unconfirmed"]);
    expect(refresh).toHaveBeenCalledWith(expect.anything(), memberMutationResources("startMemberConversation"));
  });

  it("a queueable write kept on the device keeps the queued notice", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const { state, mutateWithOutcome } = build(lost, { enqueued: true });
    const outcome = await mutateWithOutcome([], () => Promise.reject(new TypeError("Failed to fetch")), "Saved", { kind: "rsvp", args: ["event-1", "going"] });
    expect(outcome.status).toBe("queued");
    expect(state.notices.at(-1)).toBe(en["offline.queued"]);
    expect(state.notices).not.toContain(en["offline.unconfirmed"]);
  });
});
