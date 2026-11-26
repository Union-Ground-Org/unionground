// REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030 (#6564):
// members could not message an officer or administrator (the administrator
// was text with no button, member contact needed a code and a reward, and the
// steward message was refused with no next step when no steward was
// assigned), and the footer, Messages, Privacy and Profile disagreed about
// who can read what. These pin the officer route, the no-steward fallback,
// the Message button and the one source of every visibility sentence.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { getChapterLeadership, sendRewardPeerMessage, startOfficerConversation } from "../src/lib/memberApi.js";
import { contactableOfficers, mergeOfficerConversation } from "../src/features/messaging/officerContact.js";
import { mergeCrossChapterConversations } from "../src/features/messaging/crossChapterPeers.js";
import {
  CONVERSATION_KINDS,
  PRIVACY_STATEMENT_KEYS,
  VISIBILITY_KEYS,
  conversationAudience,
  conversationVisibility,
  privacyStatements,
} from "../src/features/messaging/visibility.js";
import { messageVisibilityCatalogue } from "../src/lib/i18n/messageVisibility.js";
import { rpcErrorKeyStrict } from "../src/lib/rpcErrorText.js";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";

const tEn = (key, vars) => t("en", key, vars);
const tEs = (key, vars) => t("es", key, vars);

const LEADERSHIP = {
  chapterId: "mwh-main",
  chapterName: "Main Floor",
  people: [
    { id: "u-ruthie", name: "Ruthie Calloway", title: null, president: false, administrator: false, organizationAdministrator: true, canMessage: true, contact: { email: "ruthie@example.invalid", phone: null } },
    { id: "u-sam", name: "Samuel Adeyemi", title: "Secretary", president: false, administrator: false, organizationAdministrator: false, canMessage: true, contact: { email: null, phone: null } },
    { id: "u-me", name: "Leon Haskett", title: "Trustee", president: false, administrator: false, organizationAdministrator: false, canMessage: false, contact: { email: null, phone: null } },
  ],
};

const peerContact = { available: true, code: "UG-ABCD", canRequest: false, incoming: [], outgoing: [], conversations: [] };

function started(officerId, body, { id = `peer-${officerId}`, name = "Ruthie Calloway" } = {}) {
  return {
    created: true,
    message: { id: `m-${officerId}`, sentByMe: true, body, createdAt: "2026-10-30T20:00:00.000Z" },
    conversation: { id, peerName: name, peerInitials: "RC", updatedAt: "2026-10-30T20:00:00.000Z" },
  };
}

function messages({ lang = "en", startOfficer = vi.fn(async (id, body) => started(id, body)), onStartConversation = vi.fn(), focus = null, load = async () => LEADERSHIP, desktop = true, memberId = "member-1", conversations = [], alt = false, onPeerContactChange = vi.fn() } = {}) {
  const officerDirectoryApi = { load: vi.fn(load) };
  const peerContactApi = { request: vi.fn(), respond: vi.fn(), send: vi.fn() };
  render(
    <LanguageProvider lang={lang}>
      <MessagesView
        alt={alt}
        data={{ member: { id: memberId }, conversations, broadcasts: [], product: { spaces: [], documents: [] }, peerContact }}
        desktop={desktop}
        focus={focus}
        onSendMessage={vi.fn().mockResolvedValue({})}
        onReadConversation={vi.fn().mockResolvedValue(null)}
        onReadBroadcast={vi.fn().mockResolvedValue(null)}
        onOpenTopics={vi.fn()}
        onStartConversation={onStartConversation}
        peerContactApi={peerContactApi}
        onPeerContactChange={onPeerContactChange}
        officerDirectoryApi={officerDirectoryApi}
        onStartOfficerConversation={startOfficer}
      />
    </LanguageProvider>,
  );
  return { startOfficer, officerDirectoryApi, onStartConversation, onPeerContactChange };
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/m/messages");
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe.each([
  ["send_reward_peer_message", "p_conversation_id", sendRewardPeerMessage],
  ["start_officer_conversation", "p_officer_user_id", startOfficerConversation],
])("%s rollout on web", (name, targetArg, send) => {
  const legacy = { [targetArg]: "target", p_body: "Hi" };
  const keyed = { ...legacy, p_operation_id: "operation" };
  const signature = Object.keys(keyed).sort().join(", ");
  const missing = {
    code: "PGRST202",
    message: `Could not find the function public.${name}(${signature}) in the schema cache`,
    details: `Searched for the function public.${name} with parameters ${signature} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`,
    hint: null,
  };

  it("uses the legacy signature only after PostgREST rejects the keyed overload", async () => {
    const data = started("target", "Hi");
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, status: 404, error: missing })
      .mockResolvedValueOnce({ data, status: 200, error: null });

    await expect(send({ rpc }, "target", "Hi", "operation")).resolves.toEqual(data);
    expect(rpc.mock.calls).toEqual([[name, keyed], [name, legacy]]);
  });

  it.each([
    [404, { ...missing, code: "" }],
    [404, { code: "PGRST202", message: "Not found" }],
    [404, { ...missing, details: "A different signature was requested" }],
    [500, missing],
    [404, { code: "42883", message: "A function called during the write is missing" }],
    [504, { code: "57014", message: "Timed out" }],
    [0, { code: "", message: "Network request failed" }],
  ])("preserves an unrelated or ambiguous result (status %s)", async (status, error) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, status, error });
    await expect(send({ rpc }, "target", "Hi", "operation")).rejects.toBeTruthy();
    expect(rpc.mock.calls).toEqual([[name, keyed]]);
  });

  it("never falls back after a rejected network request", async () => {
    const failure = new Error("Network request failed");
    const rpc = vi.fn().mockRejectedValue(failure);
    await expect(send({ rpc }, "target", "Hi", "operation")).rejects.toBe(failure);
    expect(rpc.mock.calls).toEqual([[name, keyed]]);
  });
});

describe("one source for who can read what", () => {
  it("answers a steward thread and a two-person conversation differently, naming the other person", () => {
    expect(CONVERSATION_KINDS).toEqual(["steward", "personal"]);
    expect(conversationVisibility(tEn, { kind: "steward" })).toBe(tEn(VISIBILITY_KEYS.steward));
    expect(conversationVisibility(tEn)).toBe(tEn(VISIBILITY_KEYS.steward));
    expect(conversationVisibility(tEn, { kind: "personal", name: " Ruthie Calloway " }))
      .toBe("A conversation with one officer or worker: only you and Ruthie Calloway can read it. Committee members, other officers and your employer cannot.");
    expect(conversationVisibility(tEn, { kind: "personal", name: "  " })).toContain("only you and the other person can read it");
    expect(conversationAudience(tEn, { kind: "steward" })).toBe("You and your campaign's committee members can read it");
    expect(conversationAudience(tEs, { kind: "personal", name: "Ruthie" })).toBe("Solo la pueden leer tú y Ruthie");
    expect(conversationAudience(tEn, { kind: "personal" })).toBe("Only you and the other person can read it");
  });

  it.each([["en", tEn], ["es", tEs]])("lists every statement on the Privacy page in %s, none of them blaming the union", (_lang, tr) => {
    const rows = privacyStatements(tr);
    expect(rows.map((row) => row.key)).toEqual([...PRIVACY_STATEMENT_KEYS]);
    for (const row of rows) {
      expect(row.text).not.toBe(row.key);
      expect(row.text).not.toMatch(/\{name\}/);
    }
    expect(tr(VISIBILITY_KEYS.footer)).not.toMatch(/your union|tu sindicato/i);
    expect(tr(VISIBILITY_KEYS.qa)).not.toBe(VISIBILITY_KEYS.qa);
  });

  it("declares every key in both languages", () => {
    expect(Object.keys(messageVisibilityCatalogue.es).sort()).toEqual(Object.keys(messageVisibilityCatalogue.en).sort());
    for (const key of Object.keys(messageVisibilityCatalogue.en).filter((name) => !messageVisibilityCatalogue.en[name].includes("{"))) {
      expect(t("en", key), key).toBe(messageVisibilityCatalogue.en[key]);
      expect(t("es", key), key).toBe(messageVisibilityCatalogue.es[key]);
    }
  });

  it("translates the two officer-route refusals the server stamps", () => {
    expect(rpcErrorKeyStrict({ details: "officer_unavailable" }, "x")).toBe("rpcError.officer_unavailable");
    expect(rpcErrorKeyStrict({ details: "officer_contact_limit" }, "x")).toBe("rpcError.officer_contact_limit");
  });
});

describe("officer contact helpers", () => {
  it("keeps only the people the server says the member may write to", () => {
    expect(contactableOfficers(LEADERSHIP.people).map((person) => person.id)).toEqual(["u-ruthie", "u-sam"]);
    expect(contactableOfficers(null)).toEqual([]);
    expect(contactableOfficers([{ canMessage: true }, null])).toEqual([]);
  });

  it("folds a new and a reused conversation into the member-contact projection", () => {
    const first = mergeOfficerConversation(null, started("u-ruthie", "Hello"));
    expect(first).toMatchObject({ available: true, conversations: [{ id: "peer-u-ruthie", peerName: "Ruthie Calloway", messages: [{ body: "Hello" }] }] });
    const other = { id: "peer-other", peerName: "Other", messages: [] };
    const workspace = { ...peerContact, conversations: [other, first.conversations[0]] };
    const again = mergeOfficerConversation(workspace, { ...started("u-ruthie", "Again"), message: { id: "m-2", sentByMe: true, body: "Again", createdAt: "2026-10-30T21:00:00.000Z" } });
    expect(again.conversations.map((item) => item.id)).toEqual(["peer-u-ruthie", "peer-other"]);
    expect(again.conversations[0].messages.map((message) => message.body)).toEqual(["Hello", "Again"]);
    expect(again.conversations[0].updatedAt).toBe("2026-10-30T21:00:00.000Z");
    // The same message twice is kept once; a result without a conversation changes nothing.
    expect(mergeOfficerConversation(again, { ...started("u-ruthie", "Again"), message: again.conversations[0].messages[1] }).conversations[0].messages).toHaveLength(2);
    expect(mergeOfficerConversation(workspace, { created: false })).toBe(workspace);
    expect(mergeOfficerConversation(workspace, { conversation: { id: "peer-x" } }).conversations[0]).toMatchObject({ id: "peer-x", peerName: "", messages: [] });
  });

  // #9189 round 1 (r1s1/r2s2): an officer or cross-chapter send the server
  // accepted into a closed conversation re-opened it, so the thread shows the
  // composer again instead of the closed note.
  it("marks a conversation open when a send into it succeeded, and leaves the state alone without a message", () => {
    const closed = { ...peerContact, conversations: [{ id: "peer-u-ruthie", peerName: "Ruthie Calloway", peerInitials: "RC", state: "closed", messages: [] }] };
    expect(mergeOfficerConversation(closed, started("u-ruthie", "Back again")).conversations[0]).toMatchObject({ state: "open", messages: [{ body: "Back again" }] });
    const sent = { conversations: [{ id: "peer-u-ruthie", peerName: "Ruthie Calloway", peerInitials: "RC", message: { id: "m-x", sentByMe: true, body: "Across", createdAt: "2026-10-30T21:00:00.000Z" } }] };
    expect(mergeCrossChapterConversations(closed, sent).conversations[0].state).toBe("open");
    expect(mergeOfficerConversation(closed, { conversation: { id: "peer-u-ruthie" } }).conversations[0].state).toBe("closed");
  });

  // Ledger 519: a send accepted before the viewer blocked can land after the
  // block; the viewer's own block stays, and the accepted message is kept.
  it("keeps the viewer's own block when a send lands after it", () => {
    const blocked = { ...peerContact, conversations: [{ id: "peer-u-ruthie", peerName: "Ruthie Calloway", peerInitials: "RC", state: "blocked_by_viewer", messages: [] }] };
    expect(mergeOfficerConversation(blocked, started("u-ruthie", "Sent before the block")).conversations[0]).toMatchObject({ state: "blocked_by_viewer", messages: [{ body: "Sent before the block" }] });
    const sent = { conversations: [{ id: "peer-u-ruthie", peerName: "Ruthie Calloway", peerInitials: "RC", message: { id: "m-y", sentByMe: true, body: "Across", createdAt: "2026-10-30T21:00:00.000Z" } }] };
    expect(mergeCrossChapterConversations(blocked, sent).conversations[0].state).toBe("blocked_by_viewer");
  });
});

describe("officer contact API", () => {
  it("reads canMessage and shared channels, and starts a conversation by officer id", async () => {
    const client = { rpc: vi.fn(async (name) => name === "get_chapter_leadership"
      ? { data: { ...LEADERSHIP, people: [{ ...LEADERSHIP.people[0], contact: { email: "  ruthie@example.invalid ", phone: "" } }] }, error: null }
      : { data: started("u-ruthie", "Hi"), error: null }) };
    const roster = await getChapterLeadership(client);
    expect(roster.people[0]).toMatchObject({ canMessage: true, contact: { email: "ruthie@example.invalid", phone: null } });
    await expect(startOfficerConversation(client, "u-ruthie", "Hi")).resolves.toMatchObject({ conversation: { id: "peer-u-ruthie" } });
    expect(client.rpc).toHaveBeenLastCalledWith("start_officer_conversation", { p_officer_user_id: "u-ruthie", p_body: "Hi" });
  });

  it("rejects a refusal with its translated token intact", async () => {
    const client = { rpc: vi.fn(async () => ({ data: null, error: { message: "officer unavailable", code: "42501", details: "officer_unavailable" } })) };
    const failure = await startOfficerConversation(client, "u-x", "Hi").catch((error) => error);
    expect(rpcErrorKeyStrict(failure, "x")).toBe("rpcError.officer_unavailable");
  });
});

describe("Write to an officer in Messages", () => {

  it("keeps one operation ID when the first message's reply is lost", async () => {
    const { startOfficer } = messages({
      memberId: "member-lost-reply",
      focus: { view: "messages", startOfficerUserId: "u-ruthie", officerName: "Ruthie Calloway" },
      startOfficer: vi.fn(async (id, body) => started(id, body)).mockRejectedValueOnce(new Error("Network request failed")),
    });
    const section = (await screen.findByRole("heading", { name: "First message to Ruthie Calloway" })).closest("section");
    const box = within(section).getByLabelText(tEn("inbox.firstMessageLabel"));
    const submit = within(section).getByRole("button", { name: tEn("inbox.startConversation") });
    fireEvent.change(box, { target: { value: "Did the meeting move?" } });
    fireEvent.click(submit);
    expect(await within(section).findByRole("alert")).toHaveTextContent("We could not confirm that your message was sent.");
    expect(box).toHaveValue("Did the meeting move?");
    fireEvent.click(submit);
    expect(await screen.findByRole("textbox", { name: tEn("inbox.peerComposer") })).toBeInTheDocument();
    expect(startOfficer.mock.calls[0][2]).toMatch(/^[\da-f-]{36}$/i);
    expect(startOfficer.mock.calls[1]).toEqual(startOfficer.mock.calls[0]);
  });

  it("says so when the officers cannot be loaded or none can be messaged", async () => {
    messages({ load: async () => { throw new Error("offline"); } });
    fireEvent.click(screen.getByRole("button", { name: "Write to an officer" }));
    expect(await screen.findByText(tEn("officerContact.error"))).toBeInTheDocument();
    cleanup();
    messages({ load: async () => ({ people: [LEADERSHIP.people[2]] }) });
    fireEvent.click(screen.getByRole("button", { name: "Write to an officer" }));
    expect(await screen.findByText(tEn("officerContact.empty"))).toBeInTheDocument();
  });

  it("keeps the text and explains a refusal, and lets the member choose someone else", async () => {
    const refusal = Object.assign(new Error("officer unavailable"), { details: "officer_unavailable" });
    messages({ startOfficer: vi.fn(async () => { throw refusal; }), focus: { view: "messages", startOfficerUserId: "u-sam", officerName: "Samuel Adeyemi" } });
    const officerForm = (await screen.findByRole("heading", { name: "First message to Samuel Adeyemi" })).closest("section");
    const box = within(officerForm).getByLabelText(tEn("inbox.firstMessageLabel"));
    fireEvent.change(box, { target: { value: "Hello Samuel" } });
    fireEvent.click(within(officerForm).getByRole("button", { name: tEn("inbox.startConversation") }));
    expect(await within(officerForm).findByRole("alert")).toHaveTextContent(tEn("rpcError.officer_unavailable"));
    expect(box).toHaveValue("Hello Samuel");
    fireEvent.click(screen.getByRole("button", { name: tEn("officerContact.cancel") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("offers the chapter's officers when no steward is assigned, carrying the message over", async () => {
    const noSteward = Object.assign(new Error("no steward assigned"), { details: "no_steward_assigned" });
    // Its own member: a draft another test left for the same officer is never overwritten.
    const { startOfficer } = messages({ lang: "es", memberId: "member-no-steward", onStartConversation: vi.fn(async () => { throw noSteward; }) });
    const box = screen.getByLabelText(tEs("inbox.firstMessageLabel"));
    fireEvent.change(box, { target: { value: "Necesito ayuda con mi horario" } });
    fireEvent.click(screen.getByRole("button", { name: tEs("inbox.startConversation") }));

    expect(await screen.findByRole("heading", { name: tEs("officerContact.noStewardTitle") })).toBeInTheDocument();
    expect(screen.getByText(tEs("officerContact.noStewardBody"))).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Escribir a Samuel Adeyemi" }));

    const officerHeading = await screen.findByRole("heading", { name: "Primer mensaje a Samuel Adeyemi" });
    const officerForm = officerHeading.closest("section");
    const officerBox = within(officerForm).getByLabelText(tEs("inbox.firstMessageLabel"));
    expect(officerBox).toHaveValue("Necesito ayuda con mi horario");
    fireEvent.click(within(officerForm).getByRole("button", { name: tEs("inbox.startConversation") }));
    await waitFor(() => expect(startOfficer).toHaveBeenCalledWith("u-sam", "Necesito ayuda con mi horario", expect.any(String)));
  });

  it("never folds a start the session guard superseded into the inbox (gate r1s1)", async () => {
    // App's memberOperation.run resolves a superseded start to undefined.
    const { startOfficer, onPeerContactChange } = messages({ startOfficer: vi.fn(async () => undefined), memberId: "member-superseded" });
    fireEvent.click(screen.getByRole("button", { name: "Write to an officer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Write to Ruthie Calloway" }));
    const officerForm = (await screen.findByRole("heading", { name: "First message to Ruthie Calloway" })).closest("section");
    fireEvent.change(within(officerForm).getByLabelText(tEn("inbox.firstMessageLabel")), { target: { value: "Late reply" } });
    fireEvent.click(within(officerForm).getByRole("button", { name: tEn("inbox.startConversation") }));
    await waitFor(() => expect(startOfficer).toHaveBeenCalled());
    expect(await within(officerForm).findByRole("alert")).toHaveTextContent(tEn("inbox.peerMessageUnconfirmed"));
    expect(onPeerContactChange).not.toHaveBeenCalled();
  });

  it("closes an open thread when an officer is chosen so the form shows in the narrow alternate shell (gate r1s2)", async () => {
    const conversation = { id: "c-1", sender: "Chapter Steward", initials: "CS", preview: "Hi", dateLabel: "Now", unread: 0, messages: [] };
    // The selection the narrow alternate shell hides the list behind is shared
    // state; the classic desktop view shows it plainly.
    window.history.replaceState({}, "", "/m/messages?conversation=c-1");
    messages({ conversations: [conversation], memberId: "member-alt" });
    expect(await screen.findByRole("textbox", { name: tEn("inbox.composerPlaceholder") })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Write to an officer" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Write to Samuel Adeyemi" }));
    expect(await screen.findByRole("heading", { name: "First message to Samuel Adeyemi" })).toBeInTheDocument();
    // The steward thread that was open is closed, so nothing hides the form.
    expect(screen.queryByRole("textbox", { name: tEn("inbox.composerPlaceholder") })).toBeNull();
  });

  it("offers no officer route where none is wired", () => {
    render(
      <LanguageProvider lang="en">
        <MessagesView data={{ member: { id: "member-1" }, conversations: [], broadcasts: [], product: { spaces: [], documents: [] } }} onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.queryByRole("button", { name: "Write to an officer" })).toBeNull();
  });
});

describe("Who runs this campaign", () => {
  function settings(props) {
    return render(
      <LanguageProvider lang="en">
        <SettingsView
          data={{ member: { id: "u-me", fullName: "Leon Haskett", initials: "LH", chapterName: "Main Floor" }, roles: [], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } }}
          onNavigate={vi.fn()}
          onProfile={vi.fn()}
          onAssistant={vi.fn()}
          lang="en"
          onLanguage={vi.fn()}
          {...props}
        />
      </LanguageProvider>,
    );
  }

  it("gives each officer the member may write to a Message button and shows only what they shared", async () => {
    const onMessageOfficer = vi.fn();
    settings({ chapterLeadershipApi: { load: async () => LEADERSHIP }, onMessageOfficer });
    const card = (await screen.findByRole("heading", { name: "Who runs this campaign" })).closest("section");
    await within(card).findAllByRole("listitem");
    expect(within(card).getByRole("link", { name: "ruthie@example.invalid" })).toHaveAttribute("href", "mailto:ruthie@example.invalid");
    expect(within(card).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Message Ruthie Calloway", "Message Samuel Adeyemi"]);
    fireEvent.click(within(card).getByRole("button", { name: "Message Ruthie Calloway" }));
    expect(onMessageOfficer).toHaveBeenCalledWith(expect.objectContaining({ id: "u-ruthie", name: "Ruthie Calloway" }));
  });

  it("lets a listed administrator share contact details, and not a role the server does not list (Sol final P2)", async () => {
    const api = { load: vi.fn(async () => ({ shareEmail: false, sharePhone: false, contactEmail: null, contactPhone: null })), save: vi.fn() };
    const ruthie = { member: { id: "u-ruthie", fullName: "Ruthie Calloway", initials: "RC", chapterName: "Main Floor" }, roles: ["admin"], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } };
    settings({ data: ruthie, chapterLeadershipApi: { load: async () => LEADERSHIP }, stewardContactApi: api });
    expect(await screen.findByText(tEn("settings.contactSharingBody"))).toBeInTheDocument();
    cleanup();
    // An organization-wide President grant is not on the chapter's list, so
    // the editor whose save the server would refuse is not offered.
    const statewide = { ...ruthie, member: { ...ruthie.member, id: "u-statewide" }, roles: ["vp"] };
    settings({ data: statewide, chapterLeadershipApi: { load: async () => LEADERSHIP }, stewardContactApi: api });
    await screen.findByRole("heading", { name: "Who runs this campaign" });
    await waitFor(() => expect(screen.queryByText(tEn("settings.contactSharingBody"))).toBeNull());
    cleanup();
    // Without the server's answer (no leadership reader), a role name alone offers nothing.
    settings({ data: statewide, stewardContactApi: api });
    expect(screen.queryByText(tEn("settings.contactSharingBody"))).toBeNull();
  });

  it("offers contact sharing to an officer known only by a display title, once the server lists them (gate r1s3)", async () => {
    const api = { load: vi.fn(async () => ({ shareEmail: false, sharePhone: false, contactEmail: null, contactPhone: null })), save: vi.fn() };
    settings({
      data: { member: { id: "u-sam", fullName: "Samuel Adeyemi", initials: "SA", chapterName: "Main Floor" }, roles: [], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } },
      chapterLeadershipApi: { load: async () => LEADERSHIP },
      stewardContactApi: api,
    });
    expect(await screen.findByText(tEn("settings.contactSharingBody"))).toBeInTheDocument();
    cleanup();
    // A plain member, not on the list, gets no editor.
    settings({ chapterLeadershipApi: { load: async () => LEADERSHIP }, stewardContactApi: api });
    await screen.findByRole("heading", { name: "Who runs this campaign" });
    expect(screen.queryByText(tEn("settings.contactSharingBody"))).toBeNull();
  });

  it("offers that editor on a Privacy page opened directly, where the Profile card is not mounted (gate r2s2)", async () => {
    window.history.replaceState({}, "", "/m/settings/privacy");
    const api = { load: vi.fn(async () => ({ shareEmail: false, sharePhone: false, contactEmail: null, contactPhone: null })), save: vi.fn() };
    const leadership = { load: vi.fn(async () => LEADERSHIP) };
    render(
      <LanguageProvider lang="en">
        <WorkspacePages view="settings" hat="member" location={window.location.href} navigate={vi.fn()}>
          <SettingsView
            data={{ member: { id: "u-sam", fullName: "Samuel Adeyemi", initials: "SA", chapterName: "Main Floor" }, roles: [], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } }}
            onNavigate={vi.fn()} onProfile={vi.fn()} onAssistant={vi.fn()} lang="en" onLanguage={vi.fn()}
            chapterLeadershipApi={leadership}
            stewardContactApi={api}
          />
        </WorkspacePages>
      </LanguageProvider>,
    );
    expect(await screen.findByText(tEn("settings.contactSharingBody"))).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Who runs this campaign" })).toBeNull();
    expect(leadership.load).toHaveBeenCalled();
  });

  it("asks nothing in a restricted PIN session", async () => {
    const leadership = { load: vi.fn(async () => LEADERSHIP) };
    settings({ sessionRestricted: true, chapterLeadershipApi: leadership, stewardContactApi: { load: vi.fn(), save: vi.fn() } });
    await Promise.resolve();
    expect(leadership.load).not.toHaveBeenCalled();
  });

  it("lists the same who-can-read sentences on the Privacy card", () => {
    settings({});
    for (const row of privacyStatements(tEn)) expect(screen.getAllByText(row.text).length).toBeGreaterThan(0);
  });
});
