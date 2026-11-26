// BUG-UG-CHAPTER-NOTICE-PUBLISH-NOT-EXACTLY-ONCE-20261119 (#9220):
// a notice sent again after a lost reply reaches members once. Every attempt
// of one draft carries that draft's operation key, which the publishers
// deduplicate (tests/notice-publish-idempotency-db.test.js proves the server
// half). The key belongs to the draft, not to the notice's words (#9225).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNoticeDraft, noticeKeyReused, publishNoticeOnce } from "../src/lib/noticePublishKey.js";
import { publishNoticeAudience, publishNoticeForAudience, loadNoticeAudiences } from "../src/lib/noticeAudience.js";
import { createChapterAccessApi } from "../src/lib/chapterAccessApi.js";
import { publishMemberBroadcast } from "../src/lib/memberApi.js";
import { OfficerNoticeDesk } from "../src/features/notices/OfficerNoticeDesk.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

afterEach(cleanup);

// A server that deduplicates as 20261119180000 does: a key's first payload is
// its receipt; a repeat with that payload gets the first notice back, the same
// key with another payload is refused (22023), and receipts belong to the
// signed-in person. It can lose the reply after the notice was published.
function server() {
  const receipts = new Map();
  const notices = [];
  const calls = [];
  let losing = 0;
  let missing = 0;
  let refusing = null;
  let actor = "officer-a";
  const rpc = vi.fn(async (name, args) => {
    if (name === "get_chapter_office_access") return { data: { chapterId: "chapter-a", notices: true, unscopedNotices: true, scopes: [] }, error: null };
    calls.push({ name, actor, key: args.p_idempotency_key });
    if (refusing) { const error = refusing; refusing = null; return { data: null, error }; }
    // A transient 404 from the API in front of the database: nothing ran.
    if (missing > 0) { missing -= 1; return { data: null, status: 404, error: { code: "PGRST202", message: "Could not find the function" } }; }
    const { p_idempotency_key: key, ...payload } = args;
    const receiptKey = `${actor}:${key}`;
    const receipt = key ? receipts.get(receiptKey) : null;
    if (receipt && JSON.stringify(receipt.payload) !== JSON.stringify(payload)) {
      return { data: null, error: { code: "22023", message: "idempotency key reused for a different request" } };
    }
    let answer = receipt?.answer;
    if (!answer) {
      answer = { broadcastId: `bc-${notices.length + 1}` };
      notices.push({ actor, payload });
      if (key) receipts.set(receiptKey, { payload, answer });
    }
    if (losing > 0) { losing -= 1; return { data: null, error: { code: "", message: "TypeError: Failed to fetch" } }; }
    return { data: answer, error: null };
  });
  return {
    client: { rpc }, notices, calls,
    keys: () => calls.map((call) => call.key),
    loseNextReply() { losing += 1; },
    missNext() { missing += 1; },
    refuseNext(error) { refusing = error; },
    signInAs(next) { actor = next; },
  };
}

let uuid = 0;
const draft = () => createNoticeDraft(() => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`);

describe("a notice draft's operation key", () => {
  it("is the same on every try until the notice is confirmed posted or the draft is cancelled", () => {
    const notice = draft();
    const first = notice.start("officer-a");
    expect(notice.start("officer-a")).toBe(first);
    notice.confirm();
    const second = notice.start("officer-a");
    expect(second).not.toBe(first);
    notice.cancel();
    expect(notice.held()).toBeNull();
    expect(notice.start("officer-a")).not.toBe(second);
  });

  it("starts a new key when another person signs in on the same page", () => {
    const notice = draft();
    const mine = notice.start("officer-a");
    expect(notice.start("officer-b")).not.toBe(mine);
  });

  it("gives a write with no draft a key of its own, so nothing is matched to an earlier notice", async () => {
    const sent = [];
    const send = async (args) => { sent.push(args.p_idempotency_key); return { data: { broadcastId: "bc" }, error: null }; };
    await publishNoticeOnce({ p_title: "Same words" }, send);
    await publishNoticeOnce({ p_title: "Same words" }, send);
    expect(new Set(sent).size).toBe(2);
  });

  it("marks the publishers' refusal of a key that already posted a different notice", async () => {
    const result = await publishNoticeOnce({ p_title: "Edited" }, async () => ({ data: null, error: { code: "22023", message: "idempotency key reused for a different request" } }), "key-1");
    expect(result.keyReused).toBe(true);
    expect(noticeKeyReused({ code: "22023", message: "Publish broadcast: idempotency key reused for a different request" })).toBe(true);
    expect(noticeKeyReused({ code: "22023", message: "title must be between 1 and 120 characters" })).toBe(false);
  });

  // #9225 round 1 r1s1: a draft kept in the form without a time limit still
  // retries with its first key, however long the officer waits.
  it("sends the draft's key again when Post is pressed 45 minutes after a lost reply", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-19T19:00:00Z"));
      const backend = server();
      const notice = draft();
      backend.loseNextReply();
      await expect(publishMemberBroadcast(backend.client, "Late retry", "Polls open at noon.", "en", "chapter", notice.start("officer-a"))).rejects.toThrow();
      vi.setSystemTime(new Date("2026-11-19T19:45:00Z"));
      await expect(publishMemberBroadcast(backend.client, "Late retry", "Polls open at noon.", "en", "chapter", notice.start("officer-a"))).resolves.toEqual({ broadcastId: "bc-1" });
      expect(new Set(backend.keys()).size).toBe(1);
      expect(backend.notices).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  // #9225 round 1 r1s2: lost reply, then a refused retry (57014, a statement
  // timeout while the first try still held the lock), then another press.
  it("keeps the draft's key through a refused retry after a lost reply, so the third press posts once", async () => {
    const backend = server();
    const office = createChapterAccessApi(backend.client);
    const notice = draft();
    backend.loseNextReply();
    await expect(office.publishNotice("chapter-a", "Refused retry", "Body", "en", "", notice.start("officer-a"))).rejects.toThrow();
    backend.refuseNext({ code: "57014", message: "canceling statement due to statement timeout" });
    await expect(office.publishNotice("chapter-a", "Refused retry", "Body", "en", "", notice.start("officer-a"))).rejects.toThrow();
    await expect(office.publishNotice("chapter-a", "Refused retry", "Body", "en", "", notice.start("officer-a"))).resolves.toEqual({ broadcastId: "bc-1" });
    expect(new Set(backend.keys()).size).toBe(1);
    expect(backend.notices).toHaveLength(1);
  });

  // 20261119180000 is applied on SAMPLE and Production, so
  // a 404, PGRST202 or 42883 answer to the keyed call is a failure like any
  // other, never an older database. Nothing is sent again without the key:
  // that send could post the notice a second time, and no retry could match it.
  it.each([
    ["a bare 404", { status: 404, error: { code: "", message: "" } }],
    ["PGRST202", { status: 404, error: { code: "PGRST202", message: "Could not find the function" } }],
    ["42883", { status: 400, error: { code: "42883", message: "function does not exist" } }],
  ])("answers %s with the failure and sends nothing without the key", async (_answer, missing) => {
    const calls = [];
    const send = async (sentArgs) => { calls.push(sentArgs); return { data: null, ...missing }; };
    await expect(publishNoticeOnce({ p_title: "T" }, send, "key-1")).resolves.toEqual({ data: null, ...missing });
    expect(calls).toEqual([{ p_title: "T", p_idempotency_key: "key-1" }]);
    // Both website publishers raise it after the one keyed call.
    const chapter = { value: "chapter", kind: "chapter", chapterId: "chapter-a", name: "" };
    const client = { rpc: vi.fn(async () => ({ data: null, ...missing })) };
    const shared = await publishNoticeAudience(client, "T", "B", "en", chapter, "key-2").catch((error) => error);
    expect(shared).toMatchObject({ message: "Notice was not published" });
    expect(shared).not.toHaveProperty("withoutKey");
    const steward = await publishMemberBroadcast(client, "T", "B", "en", "chapter", "key-3").catch((error) => error);
    expect(steward).toMatchObject({ code: missing.error.code || "PGRST202" });
    expect(steward).not.toHaveProperty("withoutKey");
    expect(client.rpc.mock.calls.map(([, args]) => args.p_idempotency_key)).toEqual(["key-2", "key-3"]);
  });

  it("does not resend a refusal", async () => {
    const refused = [];
    await publishNoticeOnce({ p_title: "T" }, async (sentArgs) => {
      refused.push(sentArgs);
      return { data: null, error: { code: "54000", message: "broadcast limit reached" } };
    }, "key-1");
    expect(refused).toEqual([{ p_title: "T", p_idempotency_key: "key-1" }]);
  });
});

// The real website notice desk over that server, as the app wires it.
function desk(backend) {
  const context = { chapterId: "chapter-a", role: "admin", canPostOrganization: false };
  const onNotice = vi.fn();
  const api = {
    loadAudiences: () => loadNoticeAudiences(backend.client, context),
    publish: (title, body, locale, audience, operationKey) => publishNoticeForAudience(backend.client, title, body, locale, audience, context, operationKey),
    listMine: vi.fn().mockResolvedValue({ notices: [], hasMore: false }),
    listDrafts: vi.fn().mockResolvedValue([]),
  };
  const element = (props = {}) => <LanguageProvider lang="en"><OfficerNoticeDesk api={props.api ?? api} onNotice={onNotice} /></LanguageProvider>;
  const fill = async (title, body = "Polls open at noon in the union hall.") => {
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: title } });
    fireEvent.change(screen.getByLabelText("Notice"), { target: { value: body } });
  };
  const post = async (count) => {
    const button = screen.getByRole("button", { name: "Post notice" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(count));
  };
  const said = (index) => onNotice.mock.calls[index][0];
  return { api, element, fill, post, said };
}

describe("the website notice desk", () => {
  it("posts one notice when Post notice is pressed again after a lost reply", async () => {
    const backend = server();
    const view = desk(backend);
    render(view.element());
    await view.fill("Contract vote this Thursday");
    backend.loseNextReply();
    await view.post(1);
    expect(view.said(0)).toBe("The notice could not be posted. Check it and try again.");
    expect(screen.getByLabelText("Title")).toHaveValue("Contract vote this Thursday");
    await view.post(2);
    expect(new Set(backend.keys()).size).toBe(1);
    expect(backend.notices).toHaveLength(1);
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });

  // A transient 404 shows the desk's failure line, sends
  // nothing without the key, and Post notice again reuses the draft's key.
  it("says the notice could not be posted after a 404 and posts it once on the next press with the same key", async () => {
    const backend = server();
    const view = desk(backend);
    render(view.element());
    await view.fill("Transient 404");
    backend.missNext();
    await view.post(1);
    expect(view.said(0)).toBe("The notice could not be posted. Check it and try again.");
    expect(backend.notices).toHaveLength(0);
    expect(screen.getByLabelText("Title")).toHaveValue("Transient 404");
    await view.post(2);
    expect(view.said(1)).toBe("Notice posted. Workers see it under Announcements.");
    expect(backend.keys()).toHaveLength(2);
    expect(backend.keys().every(Boolean)).toBe(true);
    expect(new Set(backend.keys()).size).toBe(1);
    expect(backend.notices).toHaveLength(1);
  });

  it("starts a new notice when the desk is left and opened again, even with the same words", async () => {
    const backend = server();
    const view = desk(backend);
    render(view.element());
    await view.fill("Abandoned draft");
    backend.loseNextReply();
    await view.post(1);
    cleanup();
    render(view.element());
    await view.fill("Abandoned draft");
    await view.post(2);
    const [abandoned, fresh] = backend.keys();
    expect(fresh).not.toBe(abandoned);
    expect(backend.notices).toHaveLength(2);
    expect(view.said(1)).toBe("Notice posted. Workers see it under Announcements.");
  });

  it("posts the same words again as a new notice once the first was confirmed", async () => {
    const backend = server();
    const view = desk(backend);
    render(view.element());
    await view.fill("Weekly reminder");
    await view.post(1);
    await view.fill("Weekly reminder");
    await view.post(2);
    expect(new Set(backend.keys()).size).toBe(2);
    expect(backend.notices).toHaveLength(2);
  });

  it("says the first version was already posted when an edit follows a lost reply, and posts the edit next", async () => {
    const backend = server();
    const view = desk(backend);
    render(view.element());
    await view.fill("Edited draft", "Polls open at noon.");
    backend.loseNextReply();
    await view.post(1);
    await view.fill("Edited draft", "Polls open at one.");
    await view.post(2);
    expect(view.said(1)).toBe("The first version of this notice was already posted. See Your notices. Post again to send this version as a new notice.");
    // The composer stays usable, with the edit still in it.
    expect(screen.getByLabelText("Notice")).toHaveValue("Polls open at one.");
    expect(backend.notices).toHaveLength(1);
    await view.post(3);
    expect(backend.notices.map((notice) => notice.payload.p_body)).toEqual(["Polls open at noon.", "Polls open at one."]);
    expect(view.said(2)).toBe("Notice posted. Workers see it under Announcements.");
  });

  it("drops the draft's key when the signed-in person changes on the same page", async () => {
    const backend = server();
    const view = desk(backend);
    const { rerender } = render(view.element());
    await view.fill("Sign-out draft");
    backend.loseNextReply();
    await view.post(1);
    // Another account signs in on the same page: the app builds a new notice api.
    backend.signInAs("officer-b");
    rerender(view.element({ api: { ...view.api } }));
    await view.fill("Sign-out draft");
    await view.post(2);
    const [before, after] = backend.keys();
    expect(after).not.toBe(before);
    expect(backend.notices.map((notice) => notice.actor)).toEqual(["officer-a", "officer-b"]);
  });
});
