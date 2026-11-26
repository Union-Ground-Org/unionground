import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { memberResourcesForRoute } from "../src/lib/memberSessionLoader.js";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

// Canonical double: tests/helpers/memberBackendHarness.js. Session continuation
// leaves task persistence, message-action routing, and insert capture off.
const backend = await vi.hoisted(async () => {
  const { createMemberBackendHarness } = await import("./helpers/memberBackendHarness.js");
  return createMemberBackendHarness({
    persistTaskWrites: false,
    messageActions: false,
    captureInserts: false,
  });
});
vi.mock("../src/lib/supabase.js", async original => ({
  ...await original(), appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, createCapturedAppSessionRpcClient: () => capturedAppClientFixture(backend.client), appSupabase: backend.client,
}));
vi.mock("../src/lib/memberSessionLoader.js", async original => {
  const implementation = await original();
  return { ...implementation, createMemberSessionLoader(...args) {
    let loader;
    loader = implementation.createMemberSessionLoader(backend.scopedClient(args[1], () => loader), args[1], { ...args[2], concurrency: 8 });
    backend.state.loader = loader;
    return loader;
  } };
});

vi.mock("../src/lib/guideApi.js", () => ({ requestGuideReply: async () => {
  if (backend.state.holdReply) return new Promise(resolve => { backend.state.replyPending = resolve; });
  return { answer: "Saved model answer", sources: [] };
} }));
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
async function flush(work = () => {}) { await act(async () => { work(); await pause(); }); }
function go(view) {
  window.history.pushState({}, "", view === "today" ? "/m" : `/m/${view}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert model backend")));
  localStorage.clear(); sessionStorage.clear();
  window.scrollTo = vi.fn(); window.history.replaceState({}, "", "/m");
  Object.assign(backend.state, {
    session: { user: backend.user("model-a"), access_token: "model-token" },
    loader: null, pending: [], operations: [], hold: false, holdResource: null, fail: null, failAfterRightsWrite: false, holdReply: false, replyPending: null, subscribers: [], namedSubscribers: {}, feeds: [], liveSequences: new Map(),
    rows: {
      "table:member_rights_lessons": [{ id: "lesson", label: "Model lesson", title: "Model lesson", steps: ["One"], order_index: 1 }],
      "table:member_rights_progress": [{ lesson_id: "lesson", completed_steps: [] }],
      "table:member_guide_threads": [{ id: "guide", title: "Retained model conversation" }],
      "table:member_guide_messages": [{ id: "answer", thread_id: "guide", role: "assistant", body: "Retained model answer" }],
      "table:member_notifications": [{ id: "notice", title: "Model notice", read_at: null, created_at: "2026-09-06T12:00:00Z" }],
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });


it.each([false, true])('old Compass save cannot cross identity; failed history=%s', async (failedHistory) => {
  const state = backend.state;
  state.rows['table:member_guide_threads']=[];
  state.rows['table:member_guide_messages']=[];
  state.rows['rpc:save_member_guide_exchange']='old-private-thread';
  render(<App/>);
  await screen.findByRole('heading',{name:/Model/});
  fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
  let dialog=await screen.findByRole('dialog',{name:'Union Ground Guide'});
  await waitFor(()=>expect(state.loader.inspect().get('table:member_guide_threads')?.status).toBe('loaded'));
  state.holdResource='rpc:save_member_guide_exchange';
  fireEvent.change(within(dialog).getByLabelText('Ask Union Ground Guide a question'),{target:{value:'Private old user question'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'Send'}));
  await waitFor(()=>expect(state.pending.some(r=>r.resource==='rpc:save_member_guide_exchange')).toBe(true));
  const old=state.pending.find(r=>r.resource==='rpc:save_member_guide_exchange');
  await flush(()=>{
    state.session={user:backend.user('model-b'),access_token:'new-test-token'};
    state.auth('SIGNED_IN',state.session);
  });
  await waitFor(()=>expect(state.loader.userId).toBe('model-b'));
  await screen.findByRole('heading',{name:/NewIdentity/});
  state.fail=failedHistory ? 'table:member_guide_threads' : null;
  state.holdResource=null;
  await flush(()=>old.resolve({data:'old-private-thread',error:null}));
  await flush(); await flush();
  if(!screen.queryByRole('dialog',{name:'Union Ground Guide'})) fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
  dialog=await screen.findByRole('dialog',{name:'Union Ground Guide'});
  if (failedHistory) await within(dialog).findByRole('alert');
  else await waitFor(() => expect(state.loader.inspect().get('table:member_guide_threads')?.status).toBe('loaded'));
  fireEvent.click(within(dialog).getByRole('button',{name:/conversations/i}));
  expect(within(dialog).queryByRole('button',{name:'Private old user question'})).toBeNull();
});

it('R5 adversarial: retained Rights data and a failed refresh expose a retry together', async()=>{
 const state=backend.state;
 render(<App/>);await screen.findByRole('heading',{name:/Model/});
 await flush(()=>go('rights'));
 await screen.findByRole('heading',{name:'Learn'});
 state.fail='table:member_rights_lessons';
 await act(async()=>{await state.loader.loadRoute('rights',{force:true});});
 expect(state.loader.failuresForResources(['table:member_rights_lessons'])).toHaveLength(1);
 expect(screen.getByRole('heading',{name:'Learn'})).toBeVisible();
 expect(screen.queryByRole('button',{name:'Try again'})).not.toBeNull();
});

it('R5 adversarial: saved Rights progress survives a failed read and offers retry', async()=>{
 const state=backend.state;
 render(<App/>);await screen.findByRole('heading',{name:/Model/});
 await flush(()=>go('rights'));
 await screen.findByRole('heading',{name:'Learn'});
 const start=document.querySelector('.learn-hero__cta');if(start)fireEvent.click(start);
 await waitFor(()=>expect(document.querySelector('.learn-step')).not.toBeNull());
 state.failAfterRightsWrite=true;
 fireEvent.click(document.querySelector('.learn-step'));
 await waitFor(()=>expect(state.loader.failuresForResources(['table:member_rights_progress'])).toHaveLength(1));
 await flush(); await flush();
 expect(state.rows['table:member_rights_progress'][0].completed_steps).toEqual([0]);
 // Write succeeded on the server; stale retained data is not proof it failed.
 expect(document.querySelector('.learn-step').getAttribute('aria-pressed')).toBe('true');
 expect(screen.queryByRole('button',{name:'Try again'})).not.toBeNull();
});


it.each([false, true])("old forced refresh is retired before completion; failure=%s", async fail => {
  const state = backend.state;
  render(<App />);
  await screen.findByRole("heading", { name: /Model/ });
  const oldLoader = state.loader;
  state.holdResource = "table:member_rights_progress";
  let refresh;
  await flush(() => { refresh = oldLoader.loadRoute("rights", { force: true }); });
  await waitFor(() => expect(state.pending.length).toBeGreaterThan(0));
  const oldRequests = state.pending.splice(0);
  state.holdResource = null;
  await flush(() => {
    state.session = { user: backend.user("model-b"), access_token: "new-token" };
    state.auth("SIGNED_IN", state.session);
  });
  await screen.findByRole("heading", { name: /NewIdentity/ });
  const newLoader = state.loader;
  const before = state.operations.length;
  await act(async () => {
    for (const request of oldRequests) request.resolve({ data: fail ? null : request.data, error: fail ? { message: "Private old failure" } : null });
    await refresh;
  });
  await flush();
  expect(state.loader).toBe(newLoader);
  expect(oldLoader.inspect().size).toBe(0);
  expect(state.operations.slice(before).some(op => op.loader === oldLoader)).toBe(false);
  expect(screen.queryByText("Private old failure")).toBeNull();
  expect(screen.getByRole("heading", { name: /NewIdentity/ })).toBeVisible();
});

it("old realtime inserts and SUBSCRIBED callbacks cannot mutate the next identity", async () => {
  const state = backend.state;
  render(<App />);
  await screen.findByRole("heading", { name: /Model/ });
  const oldLoader = state.loader;
  const feeds = [...state.feeds];
  const subscribers = [...state.subscribers];
  await flush(() => {
    state.session = { user: backend.user("model-b"), access_token: "new-token" };
    state.auth("SIGNED_IN", state.session);
  });
  await screen.findByRole("heading", { name: /NewIdentity/ });
  await waitFor(() => expect(memberResourcesForRoute("today").every(name => state.loader.inspect().get(name)?.status === "loaded")).toBe(true));
  const before = state.operations.length;
  const revision = state.loader.revision;
  await flush(() => {
    for (const feed of feeds) feed.callback({ new: { id: "private-old-event", title: "Private old notification", body: "Private old task message", created_at: "2026-09-07T00:00:00Z" } });
    for (const subscriber of subscribers) subscriber?.("SUBSCRIBED");
  });
  expect(state.operations.length).toBe(before);
  expect(state.loader.revision).toBe(revision);
  expect(oldLoader.inspect().size).toBe(0);
  expect(screen.queryByText(/Private old/)).toBeNull();
});


it.each(["reply", "history", "same-user-new-generation", "same-user-new-login"])("Compass continuation stops at the %s boundary", async phase => {
  const state = backend.state;
  state.rows["table:member_guide_threads"] = [];
  state.rows["table:member_guide_messages"] = [];
  state.rows["rpc:save_member_guide_exchange"] = "private-thread";
  render(<App />);
  await screen.findByRole("heading", { name: /Model/ });
  fireEvent.click([...document.querySelectorAll(".morehub-row")].find(row => row.textContent.includes("Union Ground Guide")));
  const dialog = await screen.findByRole("dialog", { name: "Union Ground Guide" });
  await waitFor(() => expect(state.loader.inspect().get("table:member_guide_threads")?.status).toBe("loaded"));
  state.holdReply = phase === "reply";
  state.holdResource = phase === "history" ? "table:member_guide_threads" : "rpc:save_member_guide_exchange";
  fireEvent.change(within(dialog).getByLabelText("Ask Union Ground Guide a question"), { target: { value: "Private old question" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(phase === "reply" ? state.replyPending : state.pending.length).toBeTruthy());
  const oldRequests = state.pending.splice(0);
  const oldLoader = state.loader;
  state.holdResource = null;
  await flush(() => {
    state.session = { user: backend.user(phase === "same-user-new-login" ? "model-a" : "model-b"), access_token: "new-token" };
    state.auth("SIGNED_IN", state.session);
  });
  await screen.findByRole("heading", { name: phase === "same-user-new-login" ? /Model/ : /NewIdentity/ });
  await waitFor(() => expect(state.loader).not.toBe(oldLoader));
  if (phase === "same-user-new-generation") {
    await flush(() => {
      state.session = { user: backend.user("model-a"), access_token: "new-a-token" };
      state.auth("SIGNED_IN", state.session);
    });
    await screen.findByRole("heading", { name: /Model/ });
  }
  const operationCount = state.operations.length;
  await flush(() => {
    state.replyPending?.({ answer: "Private old answer", sources: [] });
    for (const request of oldRequests) request.resolve({ data: request.data, error: null });
  });
  await flush();
  expect(state.operations.slice(operationCount).filter(op => op.resource === "rpc:save_member_guide_exchange")).toHaveLength(0);
  expect(oldLoader.inspect().size).toBe(0);
  fireEvent.click([...document.querySelectorAll(".morehub-row")].find(row => row.textContent.includes("Union Ground Guide")));
  const fresh = await screen.findByRole("dialog", { name: "Union Ground Guide" });
  await waitFor(() => expect(state.loader.inspect().get("table:member_guide_threads")?.status).toBe("loaded"));
  fireEvent.click(within(fresh).getByRole("button", { name: /conversations/i }));
  expect(within(fresh).queryByRole("button", { name: "Private old question" })).toBeNull();
  expect(within(fresh).getByLabelText("Ask Union Ground Guide a question")).toHaveValue("");
});

it("confirmed Rights progress persists across navigation and is replaced only by a successful read", async () => {
  const state = backend.state;
  render(<App />);
  await screen.findByRole("heading", { name: /Model/ });
  await flush(() => go("rights"));
  await screen.findByRole("heading", { name: "Learn" });
  fireEvent.click(document.querySelector(".learn-hero__cta"));
  state.failAfterRightsWrite = true;
  fireEvent.click(document.querySelector(".learn-step"));
  await screen.findByRole("button", { name: "Try again" });
  expect(document.querySelector(".learn-step")).toHaveAttribute("aria-pressed", "true");
  await flush(() => go("today"));
  await screen.findByRole("heading", { name: /Model/ });
  await flush(() => go("rights"));
  await screen.findByRole("heading", { name: "Learn" });
  fireEvent.click(document.querySelector(".learn-hero__cta"));
  expect(document.querySelector(".learn-step")).toHaveAttribute("aria-pressed", "true");
  const before = state.operations.length;
  await flush(); await flush();
  expect(state.operations.length).toBe(before); // no automatic retry loop
  state.fail = null;
  state.rows["table:member_rights_progress"] = [{ lesson_id: "lesson", completed_steps: [] }];
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(state.loader.inspect().get("table:member_rights_progress")?.status).toBe("loaded"));
  // Refresh retains the open lesson instead of returning to the Learn index.
  await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
  if (!document.querySelector(".learn-step")) fireEvent.click(document.querySelector(".learn-hero__cta"));
  expect(document.querySelector(".learn-step")).toHaveAttribute("aria-pressed", "false");
});

it("palette hydration cannot publish the old identity's private search rows", async () => {
  const state = backend.state;
  state.rows['table:member_kb_articles'] = [{ id: 'private-kb', title: 'Private old search row', body: 'Private old body' }];
  render(<App />);
  await screen.findByRole('heading', { name: /Model/ });
  state.holdResource = 'table:member_kb_articles';
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  await waitFor(() => expect(state.pending.length).toBeGreaterThan(0));
  const requests = state.pending.splice(0);
  state.holdResource = null;
  state.rows['table:member_kb_articles'] = [];
  await flush(() => {
    state.session = { user: backend.user('model-b'), access_token: 'new-token' };
    state.auth('SIGNED_IN', state.session);
  });
  await screen.findByRole('heading', { name: /NewIdentity/ });
  await flush(() => { for (const request of requests) request.resolve({ data: request.data, error: null }); });
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const palette = await screen.findByRole('dialog', { name: 'Command palette' });
  // A palette that rendered no options would still satisfy the stale-row
  // absence check below. Compass is a static command on every member identity.
  expect(within(palette).getByRole('option', { name: 'Union Ground Guide' })).toBeInTheDocument();
  const input = within(palette).getByRole('combobox');
  fireEvent.change(input, { target: { value: 'Private old search row' } });
  await waitFor(() => expect(state.loader.inspect().get('table:member_kb_articles')?.status).toBe('loaded'));
  expect(within(palette).queryByRole('option', { name: /Private old search row/ })).toBeNull();
  fireEvent.change(input, { target: { value: '' } });
  expect(within(palette).getByRole('option', { name: 'Union Ground Guide' })).toBeInTheDocument();
});

it("old board callbacks cannot publish or reconcile under a new member", async () => {
  const state = backend.state;
  vi.stubGlobal('matchMedia', query => ({ matches: query.includes('min-width'), media: query, addEventListener() {}, removeEventListener() {} }));
  state.rows['table:member_roles'] = [{ role: 'steward' }];
  state.rows['table:chapter_workstreams'] = [{ id: 'stream', name: 'General' }];
  state.rows['table:chapter_tasks'] = [{ id: 'task', title: 'Shared task', workstream: 'General', status: 'in_progress', assignee_id: 'model-a', chapter_id: 'chapter-model', created_at: '2026-09-06T12:00:00Z', updated_at: '2026-09-06T12:00:00Z' }];
  render(<App />);
  await screen.findByRole('heading', { name: /Model/ });
  const { applyDeviceParityState } = await import('../src/lib/deviceParity.js');
  await flush(() => applyDeviceParityState('app.selectedStaffHat', 'steward'));
  await flush(() => go('tasks'));
  await screen.findByText('Shared task');
  const feed = state.feeds.findLast(item => item.name === 'chapter-tasks:chapter-model' && item.filter.event === 'UPDATE');
  const subscribed = state.namedSubscribers['chapter-tasks:chapter-model'];
  expect(feed).toBeDefined();
  expect(subscribed).toBeTypeOf('function');
  await flush(() => {
    state.session = { user: backend.user('model-b'), access_token: 'new-token' };
    state.auth('SIGNED_IN', state.session);
    go('today');
  });
  await screen.findByRole('heading', { name: /NewIdentity/ });
  await waitFor(() => expect(state.loader.stateForRoute('today').status).toBe('loaded'));
  const revision = state.loader.revision;
  await flush(() => {
    feed.callback({ payload: { table: 'chapter_tasks', operation: 'UPDATE', record: { id: 'task', title: 'Private old board change', updated_at: '2026-09-07T00:00:00Z' } } });
    subscribed('SUBSCRIBED');
  });
  expect(state.loader.revision).toBe(revision);
  expect(screen.queryByText('Private old board change')).toBeNull();
});
