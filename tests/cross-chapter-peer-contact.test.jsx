// REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109 (#7666), client
// half: Messages offers "Other campaigns" only to someone the server lists as
// holding an enabled access level; one, several or all listed people get the
// same message, each in their own conversation; the person's own mute; the
// organization setting is ticked, not typed. The database half is
// tests/cross-chapter-peer-contact-db.test.js.
import axe from "axe-core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrossChapterPeersSection } from "../src/features/messaging/CrossChapterPeersSection.jsx";
import { crossChapterPeerRole, mergeCrossChapterConversations } from "../src/features/messaging/crossChapterPeers.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { t } from "../src/lib/i18n.js";
import { crossChapterPeersCatalogue } from "../src/lib/i18n/crossChapterPeers.js";
import { listCrossChapterPeers, normalizeCrossChapterPeers, sendCrossChapterPeerMessage, setCrossChapterPeerMute } from "../src/lib/memberApi.js";
import { rpcErrorText } from "../src/lib/rpcErrorText.js";
import { MessagesView } from "../src/views/MessagesView.jsx";

const tEn = (key, vars) => t("en", key, vars);

const PEERS = {
  available: true,
  levels: ["vp"],
  muted: false,
  peers: [
    { id: "u-east", name: "Dana East", title: null, chapters: ["East"], levels: ["vp"] },
    { id: "u-west", name: "Rio West", title: "Chair", chapters: ["West"], levels: ["vp"] },
  ],
};

function sent(ids, body) {
  return {
    created: ids.length,
    conversations: ids.map((id, index) => ({
      id: `peer-${id}`, peerName: PEERS.peers.find((peer) => peer.id === id)?.name ?? "Worker", peerInitials: "P", updatedAt: `2026-11-10T15:0${index}:00.000Z`,
      message: { id: `m-${id}`, sentByMe: true, body, createdAt: `2026-11-10T15:0${index}:00.000Z` },
    })),
  };
}

function api(overrides = {}) {
  return {
    load: vi.fn(async () => PEERS),
    send: vi.fn(async (ids, body) => sent(ids, body)),
    setMute: vi.fn(async (muted) => ({ muted })),
    ...overrides,
  };
}

function section({ lang = "en", peersApi = api(), onSent = vi.fn(), onOpen = vi.fn() } = {}) {
  const view = render(<LanguageProvider lang={lang}><CrossChapterPeersSection api={peersApi} onSent={onSent} onOpen={onOpen} /></LanguageProvider>);
  return { ...view, peersApi, onSent, onOpen };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the server read and write", () => {
  it("keeps only name, title, chapters and levels, and calls the three routes", async () => {
    expect(normalizeCrossChapterPeers({
      available: true, levels: ["vp", 3], muted: "yes",
      peers: [{ id: "u-1", name: "Dana", title: "  ", chapters: ["East", ""], levels: ["vp"], email: "dana@example.invalid" }, { id: 7, name: "Bad" }],
      nextOffset: 50,
    })).toEqual({ available: true, levels: ["vp"], muted: false, peers: [{ id: "u-1", name: "Dana", title: null, chapters: ["East"], levels: ["vp"] }], nextOffset: 50 });
    expect(normalizeCrossChapterPeers(null)).toEqual({ available: false, levels: [], muted: false, peers: [], nextOffset: null });

    const client = { rpc: vi.fn(async () => ({ data: PEERS, error: null })) };
    expect((await listCrossChapterPeers(client)).peers).toHaveLength(2);
    await listCrossChapterPeers(client, { query: "  east ", offset: 50 });
    await sendCrossChapterPeerMessage(client, ["u-east"], "Hello");
    await setCrossChapterPeerMute(client, true);
    expect(client.rpc.mock.calls).toEqual([
      ["list_cross_chapter_peers", { p_query: null, p_offset: 0, p_limit: 50 }],
      ["list_cross_chapter_peers", { p_query: "east", p_offset: 50, p_limit: 50 }],
      ["send_cross_chapter_peer_message", { p_recipient_ids: ["u-east"], p_body: "Hello" }],
      ["set_my_cross_chapter_peer_mute", { p_muted: true }],
    ]);
  });

  it("names a campaign lead through the shared leadership line, and says each refusal plainly", () => {
    expect(crossChapterPeerRole({ title: null, levels: ["vp"] }, tEn)).toBe("Chapter lead");
    expect(crossChapterPeerRole({ title: "Chair", levels: ["vp"] }, tEn)).toBe("Chair");
    expect(crossChapterPeerRole({ title: null, levels: ["steward"] }, tEn)).toBe("Committee member");
    for (const token of ["cross_chapter_peer_unavailable", "cross_chapter_recipients", "cross_chapter_contact_limit"]) {
      expect(rpcErrorText(tEn, { details: token, message: "raw" }, "crossChapter.sendFailed")).toBe(crossChapterPeersCatalogue.en[`rpcError.${token}`]);
    }
    expect(Object.keys(crossChapterPeersCatalogue.es).sort()).toEqual(Object.keys(crossChapterPeersCatalogue.en).sort());
  });

  it("folds each sent conversation into the inbox", () => {
    const workspace = { available: true, canRequest: false, code: "", incoming: [], outgoing: [], conversations: [{ id: "peer-u-east", peerName: "Dana East", peerInitials: "DE", updatedAt: "2026-11-09T10:00:00.000Z", messages: [{ id: "old", body: "Earlier", sentByMe: false }] }] };
    const next = mergeCrossChapterConversations(workspace, sent(["u-east", "u-west"], "Joint meeting?"));
    expect(next.conversations.map((item) => item.id).sort()).toEqual(["peer-u-east", "peer-u-west"]);
    expect(next.conversations.find((item) => item.id === "peer-u-east").messages.map((message) => message.body)).toEqual(["Earlier", "Joint meeting?"]);
  });
});

describe("the Other campaigns dialog", () => {
  it("sends one message to everyone chosen and says each got their own conversation", async () => {
    const { peersApi, onSent } = section();
    expect(await screen.findByText("Dana East")).toBeInTheDocument();
    expect(screen.getByText("Chapter lead · East")).toBeInTheDocument();
    expect(screen.getByText("Chair · West")).toBeInTheDocument();
    const send = screen.getByRole("button", { name: /^Send/ });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Everyone shown (2)" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "  Joint meeting Thursday?  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send to 2 people" }));
    await waitFor(() => expect(peersApi.send).toHaveBeenCalledWith(["u-east", "u-west"], "Joint meeting Thursday?"));
    expect(await screen.findByText("Sent to 2 people, each in their own conversation in your messages.")).toBeInTheDocument();
    expect(onSent).toHaveBeenCalledWith(sent(["u-east", "u-west"], "Joint meeting Thursday?"));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  });

  it("opens the one conversation after writing to one person", async () => {
    const { peersApi, onOpen } = section();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Rio West/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Rio West" }));
    await waitFor(() => expect(peersApi.send).toHaveBeenCalledWith(["u-west"], "Hello"));
    fireEvent.click(await screen.findByRole("button", { name: "Open the conversation" }));
    expect(onOpen).toHaveBeenCalledWith("peer-u-west");
  });

  it("caps a send at twenty people", async () => {
    const many = { ...PEERS, peers: Array.from({ length: 25 }, (_, index) => ({ id: `u-${index}`, name: `Lead ${String(index).padStart(2, "0")}`, title: null, chapters: [`Chapter ${index}`], levels: ["vp"] })) };
    section({ peersApi: api({ load: vi.fn(async () => many) }) });
    fireEvent.click(await screen.findByRole("checkbox", { name: "The first 20" }));
    expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(20);
    expect(screen.getByRole("checkbox", { name: /Lead 24/ })).toBeDisabled();
    expect(screen.getByText("Up to 20 people at a time.")).toBeInTheDocument();
  });

  it("reaches everyone through more pages and search, keeping who was chosen", async () => {
    const people = Array.from({ length: 3 }, (_, index) => ({ id: `u-${index}`, name: `Lead ${index}`, title: null, chapters: [`Chapter ${index}`], levels: ["vp"] }));
    const load = vi.fn(async ({ query = "", offset = 0 } = {}) => {
      const matched = people.filter((peer) => !query || peer.name.toLowerCase().includes(query.toLowerCase()) || peer.chapters[0].toLowerCase().includes(query.toLowerCase()));
      return { ...PEERS, peers: matched.slice(offset, offset + 2), nextOffset: offset + 2 < matched.length ? offset + 2 : null };
    });
    const { peersApi } = section({ peersApi: api({ load }) });
    fireEvent.click(await screen.findByRole("checkbox", { name: /Lead 0/ }));
    expect(screen.queryByText("Lead 2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Lead 2/ }));
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(load).toHaveBeenLastCalledWith({ query: "", offset: 2 });

    fireEvent.change(screen.getByRole("searchbox", { name: "Find by name or campaign" }), { target: { value: "chapter 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("checkbox", { name: /Lead 1/ })).not.toBeChecked();
    expect(load).toHaveBeenLastCalledWith({ query: "chapter 1" });
    expect(screen.getByText("Chosen: Lead 0, Lead 2")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Find by name or campaign" }), { target: { value: "nobody" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Nobody matches “nobody”.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to 2 people" }));
    await waitFor(() => expect(peersApi.send).toHaveBeenCalledWith(["u-0", "u-2"], "Hello"));
  });

  // Sol final G6-8095-2: a Show more page that answers after a newer search
  // is dropped, so it never lands under the search's results.
  it("drops a Show more page that arrives after a newer search", async () => {
    let releaseMore;
    const pendingMore = new Promise((resolve) => { releaseMore = resolve; });
    const load = vi.fn(async ({ query = "", offset = 0 } = {}) => {
      if (offset > 0) {
        await pendingMore;
        return { ...PEERS, peers: [{ id: "u-sky", name: "Sky South", title: null, chapters: ["South"], levels: ["vp"] }], nextOffset: 4 };
      }
      if (query) return { ...PEERS, peers: [PEERS.peers[0]], nextOffset: null };
      return { ...PEERS, nextOffset: 2 };
    });
    section({ peersApi: api({ load }) });
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Find by name or campaign" }), { target: { value: "east" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("checkbox", { name: /Dana East/ })).toBeInTheDocument();
    releaseMore();
    await act(async () => { await pendingMore; await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByText("Sky South")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Rio West/ })).toBeNull();
  });

  // Grok delta P3 on #8095: replacing the api while Show more is in flight
  // leaves Show more usable for the new list.
  it("enables Show more again when the api changes during a Show more", async () => {
    const stuck = new Promise(() => {});
    const first = api({ load: vi.fn(async ({ offset = 0 } = {}) => (offset > 0 ? stuck : { ...PEERS, nextOffset: 2 })) });
    const second = api({ load: vi.fn(async () => ({ ...PEERS, nextOffset: 2 })) });
    const view = render(<LanguageProvider lang="en"><CrossChapterPeersSection api={first} onSent={vi.fn()} onOpen={vi.fn()} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("button", { name: "Loading more…" })).toBeDisabled();
    view.rerender(<LanguageProvider lang="en"><CrossChapterPeersSection api={second} onSent={vi.fn()} onOpen={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByRole("button", { name: "Show more" })).toBeEnabled();
    expect(second.load).toHaveBeenCalledWith({ query: "" });
  });

  // Grok delta P2 on #8095: after the api changes, the old search's rows and
  // next page are gone, so Show more can only fetch the new list's next page.
  it("starts the list over when the api changes, so Show more never reaches the old search", async () => {
    const person = (id, name) => ({ id, name, title: null, chapters: ["East"], levels: ["vp"] });
    const first = api({ load: vi.fn(async ({ query = "", offset = 0 } = {}) => {
      if (offset > 0) return new Promise(() => {});
      return { ...PEERS, peers: [person(query ? "u-east" : "u-dana", query ? "Old East" : "Old List")], nextOffset: 1 };
    }) });
    const second = api({ load: vi.fn(async ({ query = "", offset = 0 } = {}) => {
      if (query) return { ...PEERS, peers: [person("u-mixed", "Mixed East")], nextOffset: null };
      return { ...PEERS, peers: [person(offset ? "u-page" : "u-new", offset ? "New Page" : "New List")], nextOffset: offset ? null : 1 };
    }) });
    const view = render(<LanguageProvider lang="en"><CrossChapterPeersSection api={first} onSent={vi.fn()} onOpen={vi.fn()} /></LanguageProvider>);
    await screen.findByText("Old List");
    fireEvent.change(screen.getByRole("searchbox", { name: "Find by name or campaign" }), { target: { value: "east" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Old East");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    view.rerender(<LanguageProvider lang="en"><CrossChapterPeersSection api={second} onSent={vi.fn()} onOpen={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByText("New List")).toBeInTheDocument();
    expect(screen.queryByText("Old East")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Find by name or campaign" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("New Page")).toBeInTheDocument();
    expect(screen.queryByText("Mixed East")).toBeNull();
    expect(second.load).not.toHaveBeenCalledWith(expect.objectContaining({ query: "east" }));
  });

  it("keeps the message and explains a refusal, and retries a failed load", async () => {
    const refusal = Object.assign(new Error("peer unavailable"), { details: "cross_chapter_peer_unavailable" });
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(PEERS);
    section({ peersApi: api({ load, send: vi.fn().mockRejectedValue(refusal) }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("The other campaigns could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Dana East/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Dana East" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Nothing was sent: at least one person can no longer be reached/);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Hello");
  });

  it("keeps the mute switch focused while the mute is saved, and saves it once (#8435)", async () => {
    const { peersApi } = section();
    const mute = await screen.findByRole("checkbox", { name: "Mute new messages from other campaigns" });
    await expectHeldWriteFocus(peersApi.setMute, mute);
    await waitFor(() => expect(peersApi.setMute).toHaveBeenCalledWith(true));
    expect(peersApi.setMute).toHaveBeenCalledTimes(1);
  });

  it("mutes and unmutes new messages from other chapters", async () => {
    const { peersApi } = section();
    const mute = await screen.findByRole("checkbox", { name: "Mute new messages from other campaigns" });
    expect(mute).not.toBeChecked();
    fireEvent.click(mute);
    await waitFor(() => expect(mute).toBeChecked());
    expect(peersApi.setMute).toHaveBeenCalledWith(true);
    fireEvent.click(mute);
    await waitFor(() => expect(mute).not.toBeChecked());
    expect(peersApi.setMute).toHaveBeenLastCalledWith(false);
  });

  it("reads in Spanish and has no axe violations in either language", async () => {
    section({ lang: "es" });
    expect(await screen.findByText("Líder de la campaña · East")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Silenciar mensajes nuevos de otros campañas" })).toBeInTheDocument();
    cleanup();
    for (const lang of ["en", "es"]) {
      const view = section({ lang });
      await screen.findAllByRole("checkbox");
      const results = await axe.run(view.container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, rules: { "color-contrast": { enabled: false } } });
      expect(results.violations.map((violation) => violation.id)).toEqual([]);
      view.unmount();
    }
  });
});

describe("Messages", () => {
  function messages(crossChapterApi) {
    const onPeerContactChange = vi.fn();
    render(
      <LanguageProvider lang="en">
        <MessagesView
          data={{ member: { id: "member-1" }, conversations: [], broadcasts: [], product: { spaces: [], documents: [] }, peerContact: { available: true, code: "UG-ABCD", canRequest: false, incoming: [], outgoing: [], conversations: [] } }}
          desktop
          onSendMessage={vi.fn().mockResolvedValue({})}
          onReadConversation={vi.fn().mockResolvedValue(null)}
          onReadBroadcast={vi.fn().mockResolvedValue(null)}
          onOpenTopics={vi.fn()}
          peerContactApi={{ request: vi.fn(), respond: vi.fn(), send: vi.fn() }}
          onPeerContactChange={onPeerContactChange}
          crossChapterApi={crossChapterApi}
        />
      </LanguageProvider>,
    );
    return { onPeerContactChange };
  }

  it("offers Other campaigns only when the server lists the person, and puts sent conversations in the inbox", async () => {
    const peersApi = api();
    const { onPeerContactChange } = messages(peersApi);
    fireEvent.click(await screen.findByRole("button", { name: "Other campaigns" }));
    const dialog = await screen.findByRole("dialog", { name: /Other campaigns/ });
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /Dana East/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Message" }), { target: { value: "Hello" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to Dana East" }));
    await waitFor(() => expect(onPeerContactChange).toHaveBeenCalled());
    expect(onPeerContactChange.mock.lastCall[0].conversations.map((item) => item.id)).toEqual(["peer-u-east"]);
  });

  // An Other campaigns send still in flight when the
  // viewer blocks the person lands afterwards; the thread must keep the
  // viewer's own block (Unblock, no composer), as the server still does.
  it("keeps the viewer's block when an Other campaigns send lands after it", async () => {
    let land;
    const peersApi = api({ send: vi.fn((ids, body) => new Promise((resolve) => { land = () => resolve(sent(ids, body)); })) });
    const conversation = { id: "peer-u-east", peerName: "Dana East", peerInitials: "DE", state: "open", updatedAt: "2026-11-10T14:00:00.000Z",
      messages: [{ id: "m-old", sentByMe: false, body: "Earlier note", createdAt: "2026-11-10T14:00:00.000Z" }] };
    const peerContactApi = { request: vi.fn(), respond: vi.fn(), send: vi.fn(), setBlock: vi.fn().mockResolvedValue({ id: "peer-u-east", state: "blocked_by_viewer" }) };
    render(
      <LanguageProvider lang="en">
        <MessagesView
          data={{ member: { id: "member-1" }, conversations: [], broadcasts: [], product: { spaces: [], documents: [] }, peerContact: { available: true, code: "UG-ABCD", canRequest: false, incoming: [], outgoing: [], conversations: [conversation] } }}
          desktop
          onSendMessage={vi.fn().mockResolvedValue({})}
          onReadConversation={vi.fn().mockResolvedValue(null)}
          onReadBroadcast={vi.fn().mockResolvedValue(null)}
          onOpenTopics={vi.fn()}
          peerContactApi={peerContactApi}
          onPeerContactChange={vi.fn()}
          crossChapterApi={peersApi}
        />
      </LanguageProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Dana East/ }));
    await screen.findByLabelText("Write a private message to a coworker…");
    fireEvent.click(screen.getByRole("button", { name: "Other campaigns" }));
    const dialog = await screen.findByRole("dialog", { name: /Other campaigns/ });
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /Dana East/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Message" }), { target: { value: "Joint meeting?" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to Dana East" }));
    expect(peersApi.send).toHaveBeenCalledTimes(1);
    // The viewer closes the dialog while the send is still running, then blocks.
    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Other campaigns/ })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Block Dana East" }));
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    expect(await screen.findByText("You blocked Dana East. Neither of you can send messages here.")).toBeInTheDocument();
    await act(async () => { land(); });
    expect(screen.getByText("You blocked Dana East. Neither of you can send messages here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unblock" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Write a private message to a coworker…")).toBeNull();
    // The accepted message itself is still kept in the thread.
    expect(screen.getByText("Joint meeting?", { selector: ".inbox-msg p" })).toBeInTheDocument();
  });

  it("opens the one conversation from the dialog, closes the dialog, and hides the entry when the list cannot be read", async () => {
    const peersApi = api();
    messages(peersApi);
    fireEvent.click(await screen.findByRole("button", { name: "Other campaigns" }));
    let dialog = await screen.findByRole("dialog", { name: /Other campaigns/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Other campaigns/ })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Other campaigns" }));
    dialog = await screen.findByRole("dialog", { name: /Other campaigns/ });
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /Dana East/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Message" }), { target: { value: "Hello" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to Dana East" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Open the conversation" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Other campaigns/ })).toBeNull());
    cleanup();
    const failing = api({ load: vi.fn().mockRejectedValue(new Error("offline")) });
    messages(failing);
    await waitFor(() => expect(failing.load).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Other campaigns" })).toBeNull();
  });

  it("hides the entry without an enabled level or a backend", async () => {
    const unavailable = api({ load: vi.fn(async () => ({ available: false, levels: [], muted: false, peers: [] })) });
    messages(unavailable);
    await waitFor(() => expect(unavailable.load).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Other campaigns" })).toBeNull();
    cleanup();
    messages(null);
    expect(screen.queryByRole("button", { name: "Other campaigns" })).toBeNull();
  });
});

// Sending keeps its button focused under pending and
// sends one message from one tick.
describe("cross-chapter send while it runs (record 8435)", () => {
  async function ready() {
    const view = section();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Rio West/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Hello" } });
    return { ...view, send: screen.getByRole("button", { name: "Send to Rio West" }) };
  }

  it("keeps Send focused while the message is sent, and sends it once", async () => {
    const { peersApi, send } = await ready();
    await expectHeldWriteFocus(peersApi.send, send);
    expect(peersApi.send).toHaveBeenCalledTimes(1);
  });

  it("sends one message when Send is activated twice in one tick", async () => {
    const { peersApi, send } = await ready();
    await expectOneWriteFromOneTick(peersApi.send, [() => fireEvent.click(send), () => fireEvent.click(send)]);
  });
});
