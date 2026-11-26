// REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109 (#7666), Sol early
// read B1: the App built the cross-chapter API before the session was restored
// and kept that signed-out guard, so Send never reached the server and said
// nothing. The real App here mounts signed out, restores the session, opens
// Messages → Other campaigns and sends.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { createResponseQueue } from "./helpers/responseQueue.js";

const backend = vi.hoisted(() => {
  const state = { calls: [], capturedFor: [], boundedFor: [], rows: {}, chapter: "chapter-1", chapterOptions: null };
  const respond = (resource) => {
    const data = resource === "table:member_profiles"
      ? { id: "lead-1", first_name: "Lena", full_name: "Lena Main", initials: "LM", language: "en", chapter_id: state.chapter }
      : (typeof state.rows[resource] === "function" ? state.rows[resource]() : state.rows[resource]) ?? (resource.startsWith("rpc:") ? null : []);
    return Promise.resolve(data).then((value) => ({ data: structuredClone(value), error: null }));
  };
  const client = {
    from(table) {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => respond(`table:${table}`).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    rpc: (name, args) => {
      state.calls.push([name, args]);
      if (name === "switch_my_chapter") {
        state.chapter = args.p_chapter_id;
        return Promise.resolve({ data: { chapterId: state.chapter }, error: null });
      }
      return respond(`rpc:${name}`);
    },
    auth: {
      // Resolved after the first render: the App starts signed out.
      getSession: () => new Promise((resolve) => setTimeout(() => resolve({ data: { session: state.session }, error: null }), 20)),
      onAuthStateChange(callback) { state.auth = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null }) },
    },
    channel() {
      const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
      return channel;
    },
    removeChannel() {}, realtime: { setAuth() {} },
  };
  return { state, client };
});
vi.mock("../src/lib/supabase.js", async (original) => ({
  ...await original(), appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, appSupabase: backend.client,
  // #9203: a private two-person write goes through a client fixed to the
  // session that started it; the stand-in records whose session that was,
  // and (#9229 r2s2) which clients asked for the shared client's deadline.
  createCapturedAppSessionRpcClient: (session, options) => {
    backend.state.capturedFor.push(session?.user?.id);
    if (options?.boundedTransport === true) backend.state.boundedFor.push(session?.user?.id);
    return backend.client;
  },
}));
// Exercise App's real chapter-switch and committed refresh callbacks through
// the same public selector boundary the rail and Hub use.
vi.mock("../src/lib/chapterRail.js", async (original) => {
  const implementation = await original();
  return { ...implementation, createLiveChapterSelector(readOptions) {
    backend.state.chapterOptions = readOptions;
    return implementation.createLiveChapterSelector(readOptions);
  } };
});

const SLOW = { timeout: 15000 };
const PEERS = {
  available: true, levels: ["vp"], muted: false, nextOffset: null,
  peers: [{ id: "lead-east", name: "Dana East", title: null, chapters: ["East"], levels: ["vp"] }],
};

beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert backend")));
  vi.stubGlobal("matchMedia", (query) => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); sessionStorage.clear();
  window.scrollTo = vi.fn(); window.history.replaceState({}, "", "/m/messages");
  Object.assign(backend.state, {
    session: { user: { id: "lead-1", email: "lead-1@example.test" }, access_token: "token" },
    calls: [], capturedFor: [], boundedFor: [], chapter: "chapter-1", chapterOptions: null,
    rows: {
      "rpc:get_my_chapter_memberships": [{ chapterId: "chapter-1", organizationId: "org-1", name: "Main", selected: true, roles: ["vp"], organizationRoles: [], chapterRoles: ["vp"] }],
      "rpc:get_member_rewards_summary": { totalPoints: 0 },
      "rpc:list_reward_peer_contact": { available: true, canRequest: false, code: "UG-ABCD", incoming: [], outgoing: [], conversations: [] },
      "rpc:list_cross_chapter_peers": PEERS,
      "rpc:send_cross_chapter_peer_message": {
        created: 1,
        conversations: [{ id: "peer-lead-east", peerName: "Dana East", peerInitials: "DE", updatedAt: "2026-11-10T15:00:00.000Z",
          message: { id: "m-1", sentByMe: true, body: "Joint meeting?", createdAt: "2026-11-10T15:00:00.000Z" } }],
      },
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("sends to another chapter's lead after the session is restored", { timeout: 60000 }, async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Other campaigns" }, SLOW));
  const dialog = await screen.findByRole("dialog", { name: /Other campaigns/ }, SLOW);
  fireEvent.click(await within(dialog).findByRole("checkbox", { name: /Dana East/ }, SLOW));
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Message" }), { target: { value: "Joint meeting?" } });
  const boundedBeforeSend = backend.state.boundedFor.length;
  fireEvent.click(within(dialog).getByRole("button", { name: "Send to Dana East" }));
  await waitFor(() => expect(backend.state.calls.filter(([name]) => name === "send_cross_chapter_peer_message")).toEqual([
    ["send_cross_chapter_peer_message", { p_recipient_ids: ["lead-east"], p_body: "Joint meeting?" }],
  ]), SLOW);
  expect(await within(dialog).findByText("Sent. The conversation is in your messages.", {}, SLOW)).toBeInTheDocument();
  // The send went through a client fixed to the session of the person who
  // pressed it (#9203); other captured readers of the page share that session.
  expect(new Set(backend.state.capturedFor)).toEqual(new Set(["lead-1"]));
  // The one write's client has the shared client's request deadline (#9229 r2s2).
  expect(backend.state.boundedFor.slice(boundedBeforeSend)).toEqual(["lead-1"]);
});

const peerReads = () => backend.state.calls.filter(([name]) => name === "list_cross_chapter_peers").length;
async function navigate(path) {
  await act(async () => { window.history.pushState({}, "", path); window.dispatchEvent(new PopStateEvent("popstate")); });
}

// on #8095 at d7349923 (member-boot-round1 counted one read too many):
// a returning lead reuses the list, and a member who is not a lead or steward
// never sends the read.
it("reads the list once for a lead who leaves Messages and comes back", { timeout: 60000 }, async () => {
  render(<App />);
  await screen.findByRole("button", { name: "Other campaigns" }, SLOW);
  expect(peerReads()).toBe(1);
  await navigate("/m");
  await navigate("/m/messages");
  await screen.findByRole("button", { name: "Other campaigns" }, SLOW);
  fireEvent.click(screen.getByRole("button", { name: "Other campaigns" }));
  await within(await screen.findByRole("dialog", { name: /Other campaigns/ }, SLOW)).findByRole("checkbox", { name: /Dana East/ }, SLOW);
  expect(peerReads()).toBe(1);
});

it("sends no cross-chapter read for a member who holds no lead or steward role", { timeout: 60000 }, async () => {
  backend.state.rows["rpc:get_my_chapter_memberships"] = [{ chapterId: "chapter-1", organizationId: "org-1", name: "Main", selected: true, roles: [], organizationRoles: [], chapterRoles: [] }];
  render(<App />);
  await screen.findByRole("heading", { name: /Messages|Inbox/ }, SLOW).catch(() => null);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  expect(screen.queryByRole("button", { name: "Other campaigns" })).toBeNull();
  expect(peerReads()).toBe(0);
});

function chapterPeers() {
  return {
    ...PEERS,
    peers: [{ id: "lead-new", name: "Sky New Chapter", title: null, chapters: ["North"], levels: ["vp"] }],
  };
}

function chapters(roles = { "chapter-1": ["vp"], "chapter-2": ["vp"] }) {
  backend.state.rows["rpc:get_my_chapter_memberships"] = () => Object.entries(roles).map(([chapterId, chapterRoles]) => ({
    chapterId, organizationId: "org-1", name: chapterId,
    selected: backend.state.chapter === chapterId,
    roles: chapterRoles, organizationRoles: [], chapterRoles,
  }));
  return roles;
}

async function switchChapter(chapterId) {
  await waitFor(() => expect(backend.state.chapterOptions).toBeTypeOf("function"), SLOW);
  const options = backend.state.chapterOptions();
  await act(async () => { await options.switchChapter(chapterId); await options.reload(); });
  await waitFor(() => expect(backend.state.chapterOptions().currentChapterId).toBe(chapterId), SLOW);
}

it.each(["vp", "steward"])("replaces the cached peer directory after an eligible chapter switch to %s", { timeout: 60000 }, async (nextRole) => {
  chapters({ "chapter-1": ["vp"], "chapter-2": [nextRole] });
  backend.state.rows["rpc:list_cross_chapter_peers"] = () => backend.state.chapter === "chapter-1" ? PEERS : chapterPeers();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Other campaigns" }, SLOW));
  let dialog = await screen.findByRole("dialog", { name: /Other campaigns/ }, SLOW);
  await within(dialog).findByRole("checkbox", { name: /Dana East/ }, SLOW);
  fireEvent.click(within(dialog).getByRole("button", { name: /close/i }));
  expect(peerReads()).toBe(1);

  await switchChapter("chapter-2");
  fireEvent.click(await screen.findByRole("button", { name: "Other campaigns" }, SLOW));
  dialog = await screen.findByRole("dialog", { name: /Other campaigns/ }, SLOW);
  await within(dialog).findAllByRole("checkbox");
  expect(within(dialog).queryByRole("checkbox", { name: /Dana East/ })).toBeNull();
  expect(within(dialog).getByRole("checkbox", { name: /Sky New Chapter/ })).toBeInTheDocument();
  expect(peerReads()).toBe(2);
});


it("keeps the first-page cache when the same eligible roles are merely reordered", { timeout: 60000 }, async () => {
  const roles = chapters({ "chapter-1": ["vp", "steward"] });
  render(<App />);
  await screen.findByRole("button", { name: "Other campaigns" }, SLOW);
  expect(peerReads()).toBe(1);
  roles["chapter-1"] = ["steward", "vp"];
  await switchChapter("chapter-1");
  fireEvent.click(await screen.findByRole("button", { name: "Other campaigns" }, SLOW));
  await within(await screen.findByRole("dialog", { name: /Other campaigns/ }, SLOW)).findByRole("checkbox", { name: /Dana East/ }, SLOW);
  expect(peerReads()).toBe(1);
});

it.each([false, true])("retires the previous chapter's pending first page (failure: %s)", { timeout: 60000 }, async (fail) => {
  chapters();
  const responses = createResponseQueue();
  const oldPage = responses.request("old chapter");
  backend.state.rows["rpc:list_cross_chapter_peers"] = () => backend.state.chapter === "chapter-1" ? oldPage : chapterPeers();
  render(<App />);
  await waitFor(() => expect(peerReads()).toBe(1), SLOW);
  await switchChapter("chapter-2");
  fireEvent.click(await screen.findByRole("button", { name: "Other campaigns" }, SLOW));
  const dialog = await screen.findByRole("dialog", { name: /Other campaigns/ }, SLOW);
  await within(dialog).findByRole("checkbox", { name: /Sky New Chapter/ }, SLOW);
  await act(async () => {
    if (fail) responses.reject("old chapter", new Error("retired chapter read failed"));
    else responses.resolve("old chapter", PEERS);
  });
  expect(within(dialog).getByRole("checkbox", { name: /Sky New Chapter/ })).toBeInTheDocument();
  expect(within(dialog).queryByRole("checkbox", { name: /Dana East/ })).toBeNull();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(peerReads()).toBe(2);
});
