import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { MESSAGE_REACTIONS } from "../src/features/messaging/reactions.js";

const supportGlyph = MESSAGE_REACTIONS.find(entry => entry.kind === "support").glyph;


// Canonical double: tests/helpers/memberBackendHarness.js. These options are
// the confirmed-writes suite's divergences from session-continuation.
const backend = await vi.hoisted(async () => {
  const { createMemberBackendHarness } = await import("./helpers/memberBackendHarness.js");
  return createMemberBackendHarness({
    persistTaskWrites: true,
    messageActions: true,
    captureInserts: true,
  });
});
vi.mock("../src/lib/supabase.js", async original => ({
  ...await original(), appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, appSupabase: backend.client,
  createCapturedAppSessionRpcClient: () => capturedAppClientFixture(backend.client),
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
    loader: null, pending: [], operations: [], hold: false, holdResource: null, fail: null, canEdit: false, failAfterRightsWrite: false, persistTaskWrites: false, holdReply: false, replyPending: null, subscribers: [], namedSubscribers: {}, feeds: [], liveSequences: new Map(),
    rows: {
      "table:member_rights_lessons": [{ id: "lesson", label: "Model lesson", title: "Model lesson", steps: ["One"], order_index: 1 }],
      "table:member_rights_progress": [{ lesson_id: "lesson", completed_steps: [] }],
      "table:member_guide_threads": [{ id: "guide", title: "Retained model conversation" }],
      "table:member_guide_messages": [{ id: "answer", thread_id: "guide", role: "assistant", body: "Retained model answer" }],
      "table:member_notifications": [{ id: "notice", title: "Model notice", read_at: null, created_at: "2026-09-06T12:00:00Z" }],
    },
  });
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });


it.each(['signout-same-user','rapid-a-b-a','rapid-a-b-c'])('superseded Compass save with %s', async phase=>{
 const state=backend.state;
 state.rows['table:member_guide_threads']=[];state.rows['table:member_guide_messages']=[];
 state.rows['rpc:save_member_guide_exchange']='private-thread';
 render(<App/>);await screen.findByRole('heading',{name:/Model/});
 fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
 const dialog=await screen.findByRole('dialog',{name:'Union Ground Guide'});
 await waitFor(()=>expect(state.loader.inspect().get('table:member_guide_threads')?.status).toBe('loaded'));
 state.holdResource='rpc:save_member_guide_exchange';
 fireEvent.change(within(dialog).getByLabelText('Ask Union Ground Guide a question'),{target:{value:'Private superseded question'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(state.pending.length).toBeGreaterThan(0));
 const old=state.pending.splice(0);const oldLoader=state.loader;state.holdResource=null;
 await flush(()=>{
   if(phase==='signout-same-user'){state.session=null;state.auth('SIGNED_OUT',null);}
   else {state.session={user:backend.user('model-b'),access_token:'b-token'};state.auth('SIGNED_IN',state.session);}
   state.session={user:backend.user(phase==='rapid-a-b-c'?'model-c':'model-a'),access_token:'final-token'};
   state.auth('SIGNED_IN',state.session);
 });
 await waitFor(()=>expect(state.loader!==oldLoader).toBe(true));
 await waitFor(()=>expect(state.loader.stateForRoute('today').status).toBe('loaded'));
 state.fail='table:member_guide_threads';
 await flush(()=>old.forEach(r=>r.resolve({data:'private-thread',error:null})));
 await flush();await flush();
 fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
 const fresh=await screen.findByRole('dialog',{name:'Union Ground Guide'});await within(fresh).findByRole('alert');
 fireEvent.click(within(fresh).getByRole('button',{name:/conversations/i}));
 expect(within(fresh).queryByRole('button',{name:'Private superseded question'})).toBeNull();
 expect(oldLoader.inspect().size).toBe(0);
});

it.each([true, false])("combined reaction aggregation, denial and confirmed tombstone survive projections (desktop=%s)", async desktop => {
  const state = backend.state;
  vi.stubGlobal("matchMedia", query => ({ matches: desktop && query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  const message = { id: "combined-message", conversation_id: "conv", body: "Combined lifecycle content", sender_kind: "member", created_at: "2026-09-06T00:00:00Z" };
  const peerReaction = { id: "peer-reaction", actor_id: "model-peer", source_kind: "private", private_message_id: message.id, reaction: "support" };
  state.rows["table:member_conversations"] = [{ id: "conv", title: "Review Steward", counterpart_name: "Review Steward", counterpart_role: "steward" }];
  state.rows["table:member_messages"] = [message];
  state.rows["rpc:list_member_message_reactions"] = [peerReaction];
  let denied = false;
  let delayActionState = false;
  const rpc = backend.client.rpc;
  vi.spyOn(backend.client, "rpc").mockImplementation((name, args) => {
    if (name === "get_member_message_actions" && delayActionState) {
      return new Promise(resolve => setTimeout(() => resolve(rpc(name, args)), 100));
    }
    if (name === "toggle_member_message_reaction") {
      expect(args).toEqual({ p_source_kind: "private", p_message_id: message.id, p_reaction: "support" });
      if (denied) return Promise.resolve({ data: null, error: { message: "Reaction unavailable" } });
      state.rows["rpc:list_member_message_reactions"] = [peerReaction, { ...peerReaction, id: "confirmed-reaction", actor_id: "model-a" }];
      state.rows[`rpc:${name}`] = { id: "confirmed-reaction", reacted: true };
      state.fail = "rpc:list_member_message_reactions";
    }
    if (name === "redact_member_message") {
      state.rows["table:member_messages"] = [{ ...message, body: "", redacted_at: "2026-09-07T12:00:00Z", redaction_reason: "sender_removed" }];
      state.rows[`rpc:${name}`] = { redacted: true, message: state.rows["table:member_messages"][0] };
      state.fail = "table:member_messages";
    }
    return rpc(name, args);
  });
  render(<App />); await screen.findByRole("heading", { name: /Model/ });
  await flush(() => go("messages"));
  fireEvent.click(await screen.findByRole("button", { name: "Message your committee contact" }));
  await waitFor(() => expect(document.querySelector(".inbox-reactions")).toHaveTextContent(`${supportGlyph} 1`));
  // A pending control stays enabled and focusable (#8435); it is ready once
  // it no longer reads as unavailable.
  await waitFor(() => expect(screen.getByRole('button', { name: /^Support:/ })).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(await screen.findByRole('button', { name: /^Support:/ }));
  await waitFor(() => expect(document.querySelector(".inbox-reactions")).toHaveTextContent(`${supportGlyph} 2`));
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  await flush(() => go("today")); await flush(() => go("messages"));
  // A restored count can render before the fresh action-capability response.
  // Keep that gap observable and wait for the actual control to become usable.
  delayActionState = true;
  fireEvent.click(await screen.findByRole("button", { name: "Message your committee contact" }));
  expect(document.querySelector(".inbox-reactions")).toHaveTextContent(`${supportGlyph} 2`);
  denied = true;
  await waitFor(() => expect(screen.getByRole('button', { name: /^Support:/ })).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(await screen.findByRole('button', { name: /^Support:/ }));
  await waitFor(() => expect(backend.client.rpc.mock.calls.filter(([name]) => name === "toggle_member_message_reaction")).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "React" })).not.toHaveAttribute("aria-disabled"));
  expect(document.querySelector(".inbox-reactions")).toHaveTextContent(`${supportGlyph} 2`);
  expect(screen.getByRole("button", { name: "Support: 2" })).toHaveAttribute("aria-pressed", "true");
  await flush(); await flush();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm removal" }));
  await waitFor(() => expect(document.querySelector(".inbox-thread")).not.toHaveTextContent(message.body));
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  await flush(() => go("today")); await flush(() => go("messages"));
  fireEvent.click(await screen.findByRole("button", { name: "Message your committee contact" }));
  expect(document.querySelector(".inbox-thread")).not.toHaveTextContent(message.body);
  expect(document.querySelector(".inbox-thread")).toHaveTextContent("The sender removed this message.");
  expect(screen.queryByRole("button", { name: "React" })).toBeNull();
  state.fail = null;
  state.rows["rpc:list_member_message_reactions"] = [peerReaction];
  await act(async () => { await state.loader.loadRoute("messages", { force: true }); });
  await waitFor(() => expect(state.loader.inspect().get("rpc:list_member_message_reactions").status).toBe("loaded"));
  expect(screen.queryByRole("button", { name: "React" })).toBeNull();
  expect(document.querySelector(".inbox-thread")).not.toHaveTextContent(message.body);
});

it.each(["edit", "reply"])("confirmed B04 %s survives failed reads and remount, then yields to authoritative deletion", async action => {
  const state = backend.state;
  state.canEdit = true;
  const original = { id: "action-source", conversation_id: "conv", body: "Original action body", sender_kind: "member", created_at: "2026-09-06T00:00:00Z" };
  state.rows["table:member_conversations"] = [{ id: "conv", title: "Review Steward", counterpart_name: "Review Steward", counterpart_role: "steward" }];
  state.rows["table:member_messages"] = [original];
  const rpc = backend.client.rpc;
  vi.spyOn(backend.client, "rpc").mockImplementation((name, args) => {
    if (name === (action === "edit" ? "edit_member_message" : "reply_to_member_message")) {
      const row = { ...original, id: action === "edit" ? original.id : "confirmed-reply", body: args.p_body, created_at: "2026-09-07T00:00:00Z" };
      state.rows["table:member_messages"] = action === "edit" ? [row] : [original, row];
      state.fail = "table:member_messages";
      return Promise.resolve({ data: row, error: null });
    }
    return rpc(name, args);
  });
  render(<App />); await screen.findByRole("heading", { name: /Model/ });
  await flush(() => go("messages"));
  fireEvent.click(await screen.findByRole("button", { name: "Message your committee contact" }));
  fireEvent.click(await screen.findByRole("button", { name: action === "edit" ? "Edit message" : "Reply", exact: true }));
  fireEvent.change(screen.getByRole("textbox", { name: action === "edit" ? "Edit message" : "Reply to message" }), { target: { value: "Confirmed B04 body" } });
  fireEvent.click(screen.getByRole("button", { name: action === "edit" ? "Save edit" : "Send reply" }));
  await screen.findByText("Confirmed B04 body");
  await act(async () => { await state.loader.loadRoute("messages", { force: true }); });
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  await flush(() => go("today")); await flush(() => go("messages"));
  fireEvent.click(await screen.findByRole("button", { name: "Message your committee contact" }));
  expect(document.querySelector(".inbox-thread")).toHaveTextContent("Confirmed B04 body");
  state.fail = null;
  state.rows["table:member_messages"] = [];
  await act(async () => { await state.loader.loadRoute("messages", { force: true }); });
  await waitFor(() => expect(document.querySelector(".inbox-thread")).not.toHaveTextContent("Confirmed B04 body"));
});

it("confirmed task title survives a failed read and route return, then yields to authority", async () => {
  const state = backend.state;
  vi.stubGlobal("matchMedia", query => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  state.rows["table:member_roles"] = [{ role: "steward" }];
  state.rows["table:chapter_workstreams"] = [{ id: "workstream", name: "General" }];
  const task = { id: "task", title: "Original task", created_by: "model-a", workstream: "General", status: "in_progress", assignee_id: "model-a", chapter_id: "chapter-model", created_at: "2026-09-06T12:00:00Z", updated_at: "2026-09-06T12:00:00Z" };
  state.rows["table:chapter_tasks"] = [task];
  const rpc = backend.client.rpc;
  vi.spyOn(backend.client, "rpc").mockImplementation((name, args) => {
    if (name === "update_chapter_task_content") {
      const saved = { ...task, title: args.p_title, updated_at: "2026-09-07T01:00:00Z" };
      state.rows["table:chapter_tasks"] = [saved];
      state.rows["rpc:update_chapter_task_content"] = [saved];
      state.fail = "table:chapter_tasks";
    }
    if (["soft_delete_chapter_task", "restore_chapter_task"].includes(name)) {
      state.rows[`rpc:${name}`] = { success: true };
      state.fail = "table:chapter_tasks";
    }
    return rpc(name, args);
  });
  render(<App />); await screen.findByRole("heading", { name: /Model/ });
  const { applyDeviceParityState } = await import("../src/lib/deviceParity.js");
  await flush(() => applyDeviceParityState("app.selectedStaffHat", "steward"));
  await flush(() => go("tasks"));
  fireEvent.click(await screen.findByRole("button", { name: "Original task" }));
  const title = screen.getByLabelText("Task title");
  fireEvent.change(title, { target: { value: "Confirmed task title" } }); fireEvent.blur(title);
  await waitFor(() => expect(state.rows["table:chapter_tasks"][0].title).toBe("Confirmed task title"));
  await waitFor(() => expect(state.loader.failuresForResources(["table:chapter_tasks"])).toHaveLength(1));
  fireEvent.keyDown(window, { key: "Escape" });
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  expect(await screen.findByText("Confirmed task title")).toBeVisible();
  await flush(() => go("steward")); await flush(() => go("tasks"));
  expect(await screen.findByText("Confirmed task title")).toBeVisible();
  state.fail = null; state.rows["table:chapter_tasks"] = [{ ...task, title: "Authoritative replacement", updated_at: "2026-09-07T02:00:00Z" }];
  await act(async () => { await state.loader.loadRoute("tasks", { force: true }); });
  expect(await screen.findByText("Authoritative replacement")).toBeVisible();
  expect(screen.queryByText("Confirmed task title")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Authoritative replacement" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove it" }));
  await screen.findByRole("button", { name: "Undo" });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Authoritative replacement" })).toBeNull());
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  expect(screen.queryByRole("button", { name: "Authoritative replacement" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByRole("button", { name: "Authoritative replacement" })).toBeVisible();
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  expect(screen.getByRole("button", { name: "Authoritative replacement" })).toBeVisible();
});

it.each([false, true])("confirmed Compass exchange survives failed history (initial failure: %s) and authoritative replacement", async initialFailure => {
  if (initialFailure) backend.state.fail = "table:member_guide_threads";
  const state = backend.state;
  state.rows["rpc:save_member_guide_exchange"] = "confirmed-guide";
  render(<App />); await screen.findByRole("heading", { name: /Model/ });
  fireEvent.click([...document.querySelectorAll(".morehub-row")].find(row => row.textContent.includes("Union Ground Guide")));
  const dialog = await screen.findByRole("dialog", { name: "Union Ground Guide" });
  await flush(); await flush();
  if (initialFailure) expect(state.loader.inspect().get("table:member_guide_threads").snapshot.size).toBe(0);
  state.fail = "table:member_guide_threads";
  fireEvent.change(within(dialog).getByLabelText("Ask Union Ground Guide a question"), { target: { value: "Confirmed Compass question" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  expect(await within(dialog).findByText("Saved model answer")).toBeVisible();
  fireEvent.change(within(dialog).getByLabelText("Ask Union Ground Guide a question"), { target: { value: "Second confirmed question" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(within(dialog).getAllByText("Saved model answer")).toHaveLength(2));
  expect(within(dialog).getAllByText("Confirmed Compass question")[0]).toBeVisible();
  expect(within(dialog).getByText("Second confirmed question")).toBeVisible();
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  await flush(() => go("rights")); await flush(() => go("today"));
  expect(within(dialog).getAllByText("Saved model answer")).toHaveLength(2);
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click([...document.querySelectorAll(".morehub-row")].find(row => row.textContent.includes("Union Ground Guide")));
  const retained = await screen.findByRole("dialog", { name: "Union Ground Guide" });
  expect(await within(retained).findAllByText("Saved model answer")).toHaveLength(2);
  state.rows["table:member_guide_threads"] = [{ id: "confirmed-guide", title: "Confirmed Compass question" }];
  state.rows["table:member_guide_messages"] = [{ id: "authoritative-answer", thread_id: "confirmed-guide", role: "assistant", body: "Authoritative Compass answer" }];
  state.fail = null;
  fireEvent.keyDown(window, { key: "Escape" });
  await act(async () => { await state.loader.loadRoute("voice", { force: true }); });
  fireEvent.click([...document.querySelectorAll(".morehub-row")].find(row => row.textContent.includes("Union Ground Guide")));
  const reopened = await screen.findByRole("dialog", { name: "Union Ground Guide" });
  expect(await within(reopened).findByText("Authoritative Compass answer")).toBeVisible();
  expect(within(reopened).queryByText("Saved model answer")).toBeNull();
  state.rows["table:member_guide_threads"] = []; state.rows["table:member_guide_messages"] = [];
  await act(async () => { await state.loader.loadRoute("voice", { force: true }); });
  await waitFor(() => expect(within(reopened).queryByText("Authoritative Compass answer")).toBeNull());
});

// Round-7 review ordering regressions, using responses frozen at request start.
it('ordering: confirmed message survives failed read', async () => {
 const state=backend.state;
 state.rows['table:member_conversations']=[{id:'conv',title:'Review Steward',counterpart_name:'Review Steward',counterpart_role:'steward',updated_at:'2026-09-06T00:00:00Z'}];
 state.rows['table:member_messages']=[{id:'old-message',conversation_id:'conv',body:'Existing reply',sender_kind:'steward',sender_name:'Review Steward',created_at:'2026-09-06T00:00:00Z'}];
 state.rows['rpc:send_member_message']={messageId:'confirmed-message',awardedPoints:0};
 const rpc=backend.client.rpc;
 vi.spyOn(backend.client,'rpc').mockImplementation((name,args)=>{
   if(name==='send_member_message') state.rows['table:member_messages'].push({id:'confirmed-message',conversation_id:args.p_conversation_id,body:args.p_body,sender_kind:'member',created_at:'2026-09-07T01:00:00Z'});
   return rpc(name,args);
 });
 render(<App/>); await screen.findByRole('heading',{name:/Model/});
 await flush(()=>go('messages'));await waitFor(()=>expect(document.querySelector('.view-loading')).toBeNull());
 await waitFor(()=>expect(state.loader.stateForRoute('messages').status).toBe('loaded'));
 fireEvent.click(await screen.findByRole('button',{name:'Message your committee contact'}));
 await screen.findAllByText('Existing reply');
 await flush();await flush();
 state.holdResource='table:member_messages';
 let staleRead; await flush(()=>{ state.loader.invalidateResources([state.holdResource]);staleRead=state.loader.loadRoute('messages'); });
 await waitFor(()=>expect(state.pending.length).toBeGreaterThan(0));
 const frozen=state.pending.splice(0); state.holdResource=null;
 state.fail='table:member_messages';
 fireEvent.change(document.querySelector('input[name="message"]'),{target:{value:'Confirmed private message'}});
 fireEvent.submit(document.querySelector('.inbox-composer'));
 await waitFor(()=>expect(state.operations.some(x=>x.resource==='rpc:send_member_message')).toBe(true));
 await waitFor(()=>expect(state.loader.failuresForResources(['table:member_messages'])).toHaveLength(1));
 await waitFor(()=>expect(document.querySelector('.inbox-send')).not.toBeDisabled());
 await flush();await flush();
 await flush(()=>frozen.forEach(r=>r.resolve({data:r.data,error:null}))); await act(async()=>{await staleRead;});
 expect(document.querySelector('.inbox-thread').textContent).toContain('Confirmed private message');
 await flush(() => state.namedSubscribers['member-notifications-model-a']('SUBSCRIBED'));
 expect(document.querySelector('.inbox-thread').textContent).toContain('Confirmed private message');
 await flush(() => go('today')); await screen.findByRole('heading', {name:/Model/});
 await flush(() => go('messages')); await screen.findByRole('button', {name:'Message your committee contact'});
 fireEvent.click(screen.getByRole('button', {name:'Message your committee contact'}));
 expect(document.querySelector('.inbox-thread').textContent).toContain('Confirmed private message');
 state.fail = null;
 await act(async()=>{await state.loader.loadRoute('messages',{force:true});});
 await waitFor(()=>expect((document.querySelector('.inbox-thread').textContent.match(/Confirmed private message/g)||[])).toHaveLength(1));
 state.rows['table:member_messages'] = state.rows['table:member_messages'].filter(row => row.id !== 'confirmed-message');
 await act(async () => { await state.loader.loadRoute('messages', {force:true}); });
 await waitFor(() => expect(document.querySelector('.inbox-thread').textContent).not.toContain('Confirmed private message'));
});

it("ordering: confirmed reaction survives failed reads, unrelated projections and remount, then yields to authority", async () => {
  const state = backend.state;
  state.rows["table:member_conversations"] = [{ id: "conv", title: "Review Steward", counterpart_name: "Review Steward", counterpart_role: "steward" }];
  state.rows["table:member_messages"] = [{ id: "old-message", conversation_id: "conv", body: "Existing reply", sender_kind: "steward", sender_name: "Review Steward", created_at: "2026-09-06T00:00:00Z" }];
  state.rows["rpc:toggle_member_message_reaction"] = { id: "server-reaction", reacted: true };
  const rpc = backend.client.rpc;
  vi.spyOn(backend.client, "rpc").mockImplementation((name, args) => {
    if (name === "toggle_member_message_reaction") {
      state.rows["rpc:list_member_message_reactions"] = [{ id: "server-reaction", actor_id: "model-a", source_kind: args.p_source_kind, private_message_id: args.p_message_id, reaction: args.p_reaction }];
      state.fail = "rpc:list_member_message_reactions";
    }
    return rpc(name, args);
  });
  render(<App />); await screen.findByRole("heading", { name: /Model/ });
  await flush(() => go("messages"));
  fireEvent.click(await screen.findByRole("button", { name: "Message your committee contact" }));
  await flush();await flush();
  state.holdResource='rpc:list_member_message_reactions'; let staleRead;
  await flush(()=>{state.loader.invalidateResources([state.holdResource]);staleRead=state.loader.loadRoute('messages');});
  await waitFor(()=>expect(state.pending.length).toBeGreaterThan(0));
  const frozen=state.pending.splice(0); state.holdResource=null;
  fireEvent.click(await screen.findByRole('button', { name: 'React' }));
  fireEvent.click(screen.getByRole('button', { name: 'Care' }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Care: 1" })).toHaveAttribute("aria-pressed", "true"));
  await flush(()=>frozen.forEach(r=>r.resolve({data:r.data,error:null}))); await act(async()=>{await staleRead;});
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  await flush(() => go("today")); await screen.findByRole("heading", { name: /Model/ });
  await flush(() => go("messages"));
  fireEvent.click(await screen.findByRole("button", { name: "Message your committee contact" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Care: 1" })).toHaveAttribute("aria-pressed", "true"));
  state.fail=null; await act(async()=>{await state.loader.loadRoute("messages",{force:true});});
  await waitFor(()=>expect(screen.getByRole("button", { name: "Care: 1" })).toHaveAttribute("aria-pressed", "true"));
  state.rows["rpc:list_member_message_reactions"] = [];
  await act(async () => { await state.loader.loadRoute("messages", { force: true }); });
  await waitFor(() => expect(document.querySelector('.inbox-reactions')).toBeEmptyDOMElement());
});


it("ordering: confirmed Rights progress persists across navigation and is replaced only by a successful read", async () => {
  const state = backend.state;
  render(<App />);
  await screen.findByRole("heading", { name: /Model/ });
  await flush(() => go("rights"));
  await screen.findByRole("heading", { name: "Learn" });
  fireEvent.click(document.querySelector(".learn-hero__cta"));
  state.holdResource="table:member_rights_progress"; let staleRead;
  await flush(()=>{state.loader.invalidateResources([state.holdResource]);staleRead=state.loader.loadRoute("rights");});
  await waitFor(()=>expect(state.pending.length).toBeGreaterThan(0));
  const frozen=state.pending.splice(0); state.holdResource=null;
  state.failAfterRightsWrite = true;
  fireEvent.click(document.querySelector(".learn-step"));
  await screen.findByRole("button", { name: "Try again" });
  await flush(()=>frozen.forEach(r=>r.resolve({data:r.data,error:null}))); await act(async()=>{await staleRead;});
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
  await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
  if (!document.querySelector(".learn-step")) fireEvent.click(document.querySelector(".learn-hero__cta"));
  expect(document.querySelector(".learn-step")).toHaveAttribute("aria-pressed", "false");
});



it("ordering: confirmed task title survives a failed read and route return, then yields to authority", async () => {
  const state = backend.state;
  vi.stubGlobal("matchMedia", query => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  state.rows["table:member_roles"] = [{ role: "steward" }];
  state.rows["table:chapter_workstreams"] = [{ id: "workstream", name: "General" }];
  const task = { id: "task", title: "Original task", created_by: "model-a", workstream: "General", status: "in_progress", assignee_id: "model-a", chapter_id: "chapter-model", created_at: "2026-09-06T12:00:00Z", updated_at: "2026-09-06T12:00:00Z" };
  state.rows["table:chapter_tasks"] = [task];
  const rpc = backend.client.rpc;
  vi.spyOn(backend.client, "rpc").mockImplementation((name, args) => {
    if (name === "update_chapter_task_content") {
      const saved = { ...task, title: args.p_title, updated_at: "2026-09-07T01:00:00Z" };
      state.rows["table:chapter_tasks"] = [saved];
      state.rows["rpc:update_chapter_task_content"] = [saved];
      state.fail = "table:chapter_tasks";
    }
    if (["soft_delete_chapter_task", "restore_chapter_task"].includes(name)) {
      state.rows[`rpc:${name}`] = { success: true };
      state.fail = "table:chapter_tasks";
    }
    return rpc(name, args);
  });
  render(<App />); await screen.findByRole("heading", { name: /Model/ });
  const { applyDeviceParityState } = await import("../src/lib/deviceParity.js");
  await flush(() => applyDeviceParityState("app.selectedStaffHat", "steward"));
  await flush(() => go("tasks"));
  fireEvent.click(await screen.findByRole("button", { name: "Original task" }));
  state.holdResource="table:chapter_tasks"; let staleRead;
  await flush(()=>{state.loader.invalidateResources([state.holdResource]);staleRead=state.loader.loadRoute("tasks");});
  await waitFor(()=>expect(state.pending.length).toBeGreaterThan(0));
  const frozen=state.pending.splice(0); state.holdResource=null;
  const title = screen.getByLabelText("Task title");
  fireEvent.change(title, { target: { value: "Confirmed task title" } }); fireEvent.blur(title);
  await waitFor(() => expect(state.rows["table:chapter_tasks"][0].title).toBe("Confirmed task title"));
  await waitFor(() => expect(state.loader.failuresForResources(["table:chapter_tasks"])).toHaveLength(1));
  await flush(()=>frozen.forEach(r=>r.resolve({data:r.data,error:null}))); await act(async()=>{await staleRead;});
  fireEvent.keyDown(window, { key: "Escape" });
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  expect(await screen.findByText("Confirmed task title")).toBeVisible();
  await flush(() => go("steward")); await flush(() => go("tasks"));
  expect(await screen.findByText("Confirmed task title")).toBeVisible();
  state.fail = null; state.rows["table:chapter_tasks"] = [{ ...task, title: "Authoritative replacement", updated_at: "2026-09-07T02:00:00Z" }];
  await act(async () => { await state.loader.loadRoute("tasks", { force: true }); });
  expect(await screen.findByText("Authoritative replacement")).toBeVisible();
  expect(screen.queryByText("Confirmed task title")).toBeNull();
  state.rows["table:chapter_tasks"]=[]; await act(async()=>{await state.loader.loadRoute("tasks",{force:true});});
 await waitFor(()=>expect(screen.queryByText("Authoritative replacement")).toBeNull());
});

it("ordering: confirmed Compass exchange survives failed history through unrelated projections and successful replacement", async () => {
  const state = backend.state;
  state.rows["rpc:save_member_guide_exchange"] = "confirmed-guide";
  render(<App />); await screen.findByRole("heading", { name: /Model/ });
  fireEvent.click([...document.querySelectorAll(".morehub-row")].find(row => row.textContent.includes("Union Ground Guide")));
  const dialog = await screen.findByRole("dialog", { name: "Union Ground Guide" });
  await flush(); await flush();
  state.holdResource="table:member_guide_threads"; let staleRead;
  await flush(()=>{state.loader.invalidateResources([state.holdResource]);staleRead=state.loader.loadRoute("voice");});
  await waitFor(()=>expect(state.pending.length).toBeGreaterThan(0));
  const frozen=state.pending.splice(0); state.holdResource=null;
  state.fail = "table:member_guide_threads";
  fireEvent.change(within(dialog).getByLabelText("Ask Union Ground Guide a question"), { target: { value: "Confirmed Compass question" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  expect(await within(dialog).findByText("Saved model answer")).toBeVisible();
  await flush(()=>frozen.forEach(r=>r.resolve({data:r.data,error:null}))); await act(async()=>{await staleRead;});
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  await flush(() => go("rights")); await flush(() => go("today"));
  expect(within(dialog).getAllByText("Saved model answer")).toHaveLength(1);
  state.rows["table:member_guide_threads"] = [{ id: "confirmed-guide", title: "Confirmed Compass question" }];
  state.rows["table:member_guide_messages"] = [{ id: "authoritative-answer", thread_id: "confirmed-guide", role: "assistant", body: "Authoritative Compass answer" }];
  state.fail = null;
  fireEvent.keyDown(window, { key: "Escape" });
  await act(async () => { await state.loader.loadRoute("voice", { force: true }); });
  fireEvent.click([...document.querySelectorAll(".morehub-row")].find(row => row.textContent.includes("Union Ground Guide")));
  const reopened = await screen.findByRole("dialog", { name: "Union Ground Guide" });
  expect(await within(reopened).findByText("Authoritative Compass answer")).toBeVisible();
  expect(within(reopened).queryByText("Saved model answer")).toBeNull();
  state.rows["table:member_guide_threads"]=[];state.rows["table:member_guide_messages"]=[];
  await act(async()=>{await state.loader.loadRoute("voice",{force:true});});
  await waitFor(()=>expect(within(reopened).queryByText("Authoritative Compass answer")).toBeNull());
});

it("reaction retained when the first optional reaction read also failed", async () => {
  const state = backend.state;
  state.fail = "rpc:list_member_message_reactions";
  state.rows["table:member_conversations"] = [{ id: "conv", title: "Review Steward", counterpart_name: "Review Steward", counterpart_role: "steward" }];
  state.rows["table:member_messages"] = [{ id: "old-message", conversation_id: "conv", body: "Existing reply", sender_kind: "steward", sender_name: "Review Steward", created_at: "2026-09-06T00:00:00Z" }];
  state.rows["rpc:toggle_member_message_reaction"] = { id: "server-reaction", reacted: true };
  const rpc = backend.client.rpc;
  vi.spyOn(backend.client, "rpc").mockImplementation((name, args) => {
    if (name === "toggle_member_message_reaction") {
      state.rows["rpc:list_member_message_reactions"] = [{ id: "server-reaction", actor_id: "model-a", source_kind: args.p_source_kind, private_message_id: args.p_message_id, reaction: args.p_reaction }];
      state.fail = "rpc:list_member_message_reactions";
    }
    return rpc(name, args);
  });
  render(<App />); await screen.findByRole("heading", { name: /Model/ });
  await flush(() => go("messages"));
  fireEvent.click(await screen.findByRole("button", { name: "Message your committee contact" }));
  expect(state.loader.inspect().get("rpc:list_member_message_reactions").snapshot.size).toBe(0);
  fireEvent.click(await screen.findByRole('button', { name: 'React' }));
  fireEvent.click(screen.getByRole('button', { name: 'Care' }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Care: 1" })).toHaveAttribute("aria-pressed", "true"));
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  await flush(() => go("today")); await screen.findByRole("heading", { name: /Model/ });
  await flush(() => go("messages"));
  fireEvent.click(await screen.findByRole("button", { name: "Message your committee contact" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Care: 1" })).toHaveAttribute("aria-pressed", "true"));
  state.fail = null;
  state.rows["rpc:list_member_message_reactions"][0].reaction = "like";
  await act(async () => { await state.loader.loadRoute("messages", { force: true }); });
  await waitFor(() => expect(document.querySelector('.inbox-reactions')?.textContent).toContain("👍 1"));
  expect(screen.queryByRole("button", { name: "Care: 1" })).toBeNull();
  state.rows["rpc:list_member_message_reactions"] = [];
  await act(async () => { await state.loader.loadRoute("messages", { force: true }); });
  await waitFor(() => expect(document.querySelector('.inbox-reactions')).toBeEmptyDOMElement());
});


// Adapted from the review's delayed-refresh reproduction. Hold the actual
// post-mutation read and assert the same DOM nodes throughout its completion.
it.each(["send", "mark-read"].flatMap(operation => ["success", "failure"].map(outcome => ({ operation, outcome }))))(
  "$operation preserves the selected thread and next draft through delayed $outcome refresh",
  async ({ operation, outcome }) => {
    const state = backend.state;
    state.rows["table:member_conversations"] = [{ id: "conv", title: "Review Steward", counterpart_name: "Review Steward", counterpart_role: "steward" }];
    state.rows["table:member_messages"] = [{ id: "old-message", conversation_id: "conv", body: "Existing reply", sender_kind: "steward", sender_name: "Review Steward", created_at: "2026-09-06T00:00:00Z" }];
    state.rows["rpc:send_member_message"] = { messageId: "confirmed-message", awardedPoints: 0 };
    const rpc = backend.client.rpc;
    vi.spyOn(backend.client, "rpc").mockImplementation((name, args) => {
      if (name === "send_member_message") state.rows["table:member_messages"].push({ id: "confirmed-message", conversation_id: args.p_conversation_id, body: args.p_body, sender_kind: "member", created_at: "2026-09-07T01:00:00Z" });
      return rpc(name, args);
    });
    render(<App />); await screen.findByRole("heading", { name: /Model/ });
    await flush(() => go("messages"));
    const open = await screen.findByRole("button", { name: "Message your committee contact" });
    if (operation === "mark-read") state.holdResource = "table:member_messages";
    fireEvent.click(open);
    await screen.findAllByText("Existing reply");
    const thread = document.querySelector(".inbox-thread");
    const composer = document.querySelector('input[name="message"]');
    expect(thread).not.toBeNull();
    if (operation === "send") {
      await flush(); await flush();
      state.holdResource = "table:member_messages";
      fireEvent.change(document.querySelector('input[name="message"]'), { target: { value: "Confirmed private message" } });
      fireEvent.submit(document.querySelector(".inbox-composer"));
      await waitFor(() => expect(state.operations.some(item => item.resource === "rpc:send_member_message")).toBe(true));
    }
    await waitFor(() => expect(state.pending.some(item => item.resource === "table:member_messages")).toBe(true));
    expect(document.querySelector(".inbox-thread")).toBe(thread);
    expect(document.querySelector('input[name="message"]')).toBe(composer);
    fireEvent.change(composer, { target: { value: "Next unsent draft" } });
    await flush();
    expect(document.querySelector(".inbox-thread")).toBe(thread);
    expect(composer).toHaveValue("Next unsent draft");
    const held = state.pending.splice(0); state.holdResource = null;
    await flush(() => held.forEach(request => request.resolve(outcome === "success"
      ? { data: request.data, error: null } : { data: null, error: { message: "delayed refresh failure" } })));
    await waitFor(() => expect(state.loader.stateForRoute("messages").status).toBe("loaded"));
    await flush(); await flush();
    expect(document.querySelector(".inbox-thread")).toBe(thread);
    expect(document.querySelector('input[name="message"]')).toBe(composer);
    expect(composer).toHaveValue("Next unsent draft");
    expect(thread).toHaveTextContent("Existing reply");
    if (operation === "send") expect(thread).toHaveTextContent("Confirmed private message");
  },
);

// Required initial reads correctly block these routes, so their composer cannot
// initiate a write yet. Model a separately completed save through the real API
// and its registry confirmation, then check the real App's rendering/return.
it.each(["messages", "rights"])("%s represents a completed write with no prior successful read", async kind => {
  const state = backend.state;
  const resource = kind === "messages" ? "table:member_messages" : "table:member_rights_progress";
  state.fail = resource;
  if (kind === "rights") state.rows["table:member_rights_lessons"][0].steps = ["One", "Two"];
  state.rows["table:member_conversations"] = [{ id: "conv", title: "Review Steward", counterpart_name: "Review Steward", counterpart_role: "steward" }];
  state.rows["rpc:send_member_message"] = { messageId: "confirmed-message", awardedPoints: 0 };
  // Start on a route independent of both failed required resources.
  window.history.replaceState({}, "", "/m/events");
  render(<App />);
  await waitFor(() => expect(state.loader?.stateForRoute("events").status).toBe("loaded"));
  await flush(() => go(kind));
  await waitFor(() => expect(state.loader?.inspect().get(resource)?.status).toBe("error"));
  expect(state.loader.inspect().get(resource).snapshot.size).toBe(0);
  expect(state.loader.stateForRoute(kind).status).toBe("error");
  const { sendMemberMessage, saveRightsProgress } = await import("../src/lib/memberApi.js");
  await act(async () => {
    if (kind === "messages") {
      const saved = await sendMemberMessage(backend.client, "conv", "Confirmed first-read message");
      const row = { id: saved.messageId, conversation_id: "conv", body: "Confirmed first-read message", sender_kind: "member", created_at: "2026-09-07T01:00:00Z" };
      state.rows[resource] = [row];
      state.loader.confirmRows(resource, rows => [...rows.filter(item => item.id !== row.id), row]);
    } else {
      state.failAfterRightsWrite = true;
      await saveRightsProgress(backend.client, "model-a", "lesson", [0]);
      state.loader.confirmRightsProgress("lesson", [0]);
    }
    await state.loader.loadRoute(kind);
  });
  const assertConfirmation = async () => {
    if (kind === "messages") {
      fireEvent.click(await screen.findByRole("button", { name: "Message your committee contact" }));
      await waitFor(() => expect(document.querySelector(".inbox-thread")).toHaveTextContent("Confirmed first-read message"));
    } else {
      await screen.findByRole("heading", { name: "Learn" });
      fireEvent.click(document.querySelector(".learn-hero__cta"));
      expect(document.querySelector(".learn-step")).toHaveAttribute("aria-pressed", "true");
    }
  };
  await assertConfirmation();
  expect(state.loader.inspect().get(resource).snapshot.size).toBe(0);
  await flush(() => go("events")); await flush(() => go(kind));
  await assertConfirmation();
  state.fail = null;
  state.rows[resource] = kind === "messages"
    ? [{ ...state.rows[resource][0], body: "Authoritative message" }]
    : [{ lesson_id: "lesson", completed_steps: [1] }];
  await act(async () => { await state.loader.loadRoute(kind, { force: true }); });
  if (kind === "messages") {
    await waitFor(() => expect(document.querySelector(".inbox-thread")).toHaveTextContent("Authoritative message"));
    expect(document.querySelector(".inbox-thread")).not.toHaveTextContent("Confirmed first-read message");
  } else {
    await waitFor(() => expect(document.querySelectorAll(".learn-step")[0]).toHaveAttribute("aria-pressed", "false"));
    expect(document.querySelectorAll(".learn-step")[1]).toHaveAttribute("aria-pressed", "true");
  }
  state.rows[resource] = [];
  await act(async () => { await state.loader.loadRoute(kind, { force: true }); });
  if (kind === "messages") await waitFor(() => expect(document.querySelector(".inbox-thread")).not.toHaveTextContent("Authoritative message"));
  else await waitFor(() => {
    for (const step of document.querySelectorAll(".learn-step")) expect(step).toHaveAttribute("aria-pressed", "false");
  });
});

it("a task created after its initial read fails survives return and yields to replacement and deletion", async () => {
  const state = backend.state;
  state.fail = "table:chapter_tasks";
  vi.stubGlobal("matchMedia", query => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  state.rows["table:member_roles"] = [{ role: "steward" }];
  state.rows["table:chapter_workstreams"] = [{ id: "workstream", name: "General" }];
  state.persistTaskWrites = true;
  render(<App />); await screen.findByRole("heading", { name: /Model/ });
  const { applyDeviceParityState } = await import("../src/lib/deviceParity.js");
  await flush(() => applyDeviceParityState("app.selectedStaffHat", "steward"));
  await flush(() => go("tasks"));
  fireEvent.click((await screen.findAllByRole("button", { name: "New task" }))[0]);
  const input = await screen.findByPlaceholderText("Task title…");
  expect(state.loader.inspect().get("table:chapter_tasks").snapshot.size).toBe(0);
  fireEvent.change(input, { target: { value: "Confirmed first task" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByRole("button", { name: "Confirmed first task" })).toBeVisible();
  expect(state.rows["table:chapter_tasks"][0].title).toBe("Confirmed first task");
  await flush(() => go("steward")); await flush(() => go("tasks"));
  expect(await screen.findByRole("button", { name: "Confirmed first task" })).toBeVisible();
  state.fail = null; state.rows["table:chapter_tasks"][0].title = "Authoritative first task";
  await act(async () => { await state.loader.loadRoute("tasks", { force: true }); });
  expect(await screen.findByRole("button", { name: "Authoritative first task" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Confirmed first task" })).toBeNull();
  state.rows["table:chapter_tasks"] = [];
  await act(async () => { await state.loader.loadRoute("tasks", { force: true }); });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Authoritative first task" })).toBeNull());
});

it.each([false, true].flatMap(initialFailure => [false, true].map(remove => ({ initialFailure, remove }))))(
  "successive task writes retain existence and latest content (initial failure: $initialFailure, delete: $remove)",
  async ({ initialFailure, remove }) => {
    const state = backend.state;
    state.fail = initialFailure ? "table:chapter_tasks" : null;
    vi.stubGlobal("matchMedia", query => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {} }));
    state.rows["table:member_roles"] = [{ role: "steward" }];
    state.rows["table:chapter_workstreams"] = [{ id: "workstream", name: "General" }];
    state.persistTaskWrites = true;
    const rpc = backend.client.rpc;
    let version = 1;
    vi.spyOn(backend.client, "rpc").mockImplementation((name, args) => {
      if (name === "update_chapter_task_content") {
        const saved = { ...state.rows["table:chapter_tasks"][0], title: args.p_title, updated_at: `2026-09-07T0${++version}:00:00Z` };
        state.rows["table:chapter_tasks"] = [saved];
        state.rows[`rpc:${name}`] = [saved];
      }
      if (name === "soft_delete_chapter_task") {
        state.rows["table:chapter_tasks"] = [];
        state.rows[`rpc:${name}`] = { success: true };
      }
      return rpc(name, args);
    });
    render(<App />); await screen.findByRole("heading", { name: /Model/ });
    const { applyDeviceParityState } = await import("../src/lib/deviceParity.js");
    await flush(() => applyDeviceParityState("app.selectedStaffHat", "steward"));
    await flush(() => go("tasks"));
    fireEvent.click((await screen.findAllByRole("button", { name: "New task" }))[0]);
    expect(state.loader.inspect().get("table:chapter_tasks").snapshot.size).toBe(initialFailure ? 0 : 1);
    state.fail = "table:chapter_tasks";
    const input = await screen.findByPlaceholderText("Task title…");
    fireEvent.change(input, { target: { value: "Created before refresh" } });
    fireEvent.keyDown(input, { key: "Enter" });
    let title = "Created before refresh";
    for (const next of remove ? [] : ["First saved edit", "Latest saved edit"]) {
      fireEvent.click(await screen.findByRole("button", { name: title }));
      const field = screen.getByLabelText("Task title");
      fireEvent.change(field, { target: { value: next } }); fireEvent.blur(field);
      await waitFor(() => expect(state.rows["table:chapter_tasks"][0].title).toBe(next));
      await waitFor(() => expect(state.loader.failuresForResources(["table:chapter_tasks"])).toHaveLength(1));
      fireEvent.keyDown(window, { key: "Escape" });
      title = next;
      await flush(() => go("steward")); await flush(() => go("tasks"));
      expect(await screen.findByRole("button", { name: title })).toBeVisible();
    }
    if (remove) {
      fireEvent.click(await screen.findByRole("button", { name: title }));
      fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove it" }));
      await screen.findByRole("button", { name: "Undo" });
      expect(state.rows["table:chapter_tasks"]).toEqual([]);
    }
    await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
    await flush(() => go("steward")); await flush(() => go("tasks"));
    if (remove) expect(screen.queryByRole("button", { name: title })).toBeNull();
    else expect(await screen.findByRole("button", { name: title })).toBeVisible();
    state.fail = null;
    if (!remove) state.rows["table:chapter_tasks"][0].title = "Authoritative task";
    await act(async () => { await state.loader.loadRoute("tasks", { force: true }); });
    expect(screen.queryByRole("button", { name: title })).toBeNull();
    if (!remove) expect(await screen.findByRole("button", { name: "Authoritative task" })).toBeVisible();
    state.rows["table:chapter_tasks"] = [];
    await act(async () => { await state.loader.loadRoute("tasks", { force: true }); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Authoritative task" })).toBeNull());
  },
);
