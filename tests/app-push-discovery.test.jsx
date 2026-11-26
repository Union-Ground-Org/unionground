import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
// Authenticated App regression: observing an already-owned push endpoint must
// not renew its server registration. Enable and explicit refresh own that write.
import React from 'react';
import {render, screen, waitFor, act, cleanup, fireEvent} from '@testing-library/react';
import {it, expect, vi, beforeEach, afterEach} from 'vitest';
import {App} from '../src/App.jsx';

const harness = vi.hoisted(() => {
  const user = { id: "member-1", email: "member@example.test" };
  const session = { user, access_token: "fictional-test-token" };
  const state = { rows: {}, rpcArgs: [], authChanged: null };
  const execute = async resource => {
    if (resource === "rpc:upsert_push_subscription" && state.pushWrite) return state.pushWrite();
    if (resource === "table:member_profiles") return { data: { id: user.id, first_name: "Darnell", full_name: "Darnell Foster", initials: "DF", language: "en", chapter_id: "chapter-1" }, error: null };
    if (resource in state.rows) return { data: structuredClone(state.rows[resource]), error: null };
    if (resource === "rpc:get_member_rewards_summary") return { data: { totalPoints: 100 }, error: null };
    return { data: resource.startsWith("rpc:") ? null : [], error: null };
  };
  const client = {
    rpc(name, args) { state.rpcArgs.push({ name, args }); return execute(`rpc:${name}`); },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange(fn) { state.authChanged = fn; return { data: { subscription: { unsubscribe() {} } } }; },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
    },
    channel() { const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} }; return channel; },
    removeChannel() {}, realtime: { setAuth() {} },
  };
  // Exercise the real member API with Supabase-shaped thenable queries.
  client.from = table => {
    const query = new Proxy({}, { get(_target, key) {
      return key === "then" ? (resolve, reject) => execute(`table:${table}`).then(resolve, reject) : () => query;
    } });
    return query;
  };
  return { state, client, session };
});

vi.mock("../src/lib/supabase.js", async importOriginal => ({ ...await importOriginal(), appBackendKind: "live", hasAppBackend: true, appAuthStorageUnavailable: false, createCapturedAppSessionRpcClient: () => capturedAppClientFixture(harness.client), appSupabase: harness.client }));
beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-test");
  harness.state.rows = {}; harness.state.rpcArgs = []; harness.state.pushWrite = null;
  localStorage.clear(); sessionStorage.clear();
  window.history.replaceState({}, "", "/m"); window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});
const originalWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
afterEach(()=>{
  cleanup();vi.unstubAllEnvs();vi.unstubAllGlobals();
  if(originalWorker)Object.defineProperty(navigator,'serviceWorker',originalWorker);
  else delete navigator.serviceWorker;
});
async function navigate(path){await act(async()=>{window.history.pushState({},'',path);window.dispatchEvent(new PopStateEvent('popstate'));});}


function pushDevice({ existing = true } = {}) {
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY", "AQID");
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn(async () => "granted") });
  vi.stubGlobal("PushManager", function PushManager() {});
  const subscription = {
    endpoint: "https://fcm.googleapis.com/test-device",
    options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint: "https://fcm.googleapis.com/test-device", keys: { p256dh: "test-key", auth: "test-auth" } }),
  };
  const manager = {
    getSubscription: vi.fn(async () => existing ? subscription : null),
    subscribe: vi.fn(async () => subscription),
  };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve({ pushManager: manager }) } });
  return { subscription, manager };
}

it("keeps an owned endpoint subscribed through mount and token refresh without renewing it on view", async () => {
  const { subscription, manager } = pushDevice();
  harness.state.rows['table:member_push_subscriptions'] = { id: 'existing-owned-row' };
  render(<App />);
  await screen.findByRole('heading', { name: /Darnell/ });
  await navigate('/m/settings/notifications');
  const toggle = await screen.findByRole('switch', { name: 'Push notifications' });
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  expect(manager.getSubscription).toHaveBeenCalled();
  expect(harness.state.rpcArgs.filter(call => call.name === 'upsert_push_subscription')).toEqual([]);
  await act(async () => harness.state.authChanged('TOKEN_REFRESHED', { ...harness.session, access_token: 'refreshed-fictional-token' }));
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(harness.state.rpcArgs.filter(call => call.name === 'upsert_push_subscription')).toEqual([]);
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
});

it("registers the endpoint only after the member explicitly enables push", async () => {
  const { manager } = pushDevice({ existing: false });
  render(<App />);
  await screen.findByRole('heading', { name: /Darnell/ });
  await navigate('/m/settings/notifications');
  const toggle = await screen.findByRole('switch', { name: 'Push notifications' });
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(harness.state.rpcArgs.filter(call => call.name === 'upsert_push_subscription')).toEqual([]);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  expect(manager.subscribe).toHaveBeenCalledOnce();
  expect(harness.state.rpcArgs.filter(call => call.name === 'upsert_push_subscription')).toEqual([
    { name: 'upsert_push_subscription', args: { p_endpoint: 'https://fcm.googleapis.com/test-device', p_p256dh: 'test-key', p_auth: 'test-auth' } },
  ]);
});

it("still invalidates another member's endpoint on a shared device without adopting its row", async () => {
  const { subscription } = pushDevice();
  harness.state.rows['table:member_push_subscriptions'] = null;
  render(<App />);
  await screen.findByRole('heading', { name: /Darnell/ });
  await waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalledOnce());
  expect(harness.state.rpcArgs.filter(call => call.name === 'upsert_push_subscription')).toEqual([]);
});

it.each([null, 'prior-login-handle'])("offers an explicit refresh for an owned endpoint with binding %s", async sessionHandle => {
  const { subscription, manager } = pushDevice();
  harness.state.rows['table:member_push_subscriptions'] = { id: 'owned-row', session_handle: sessionHandle };
  render(<App />);
  await screen.findByRole('heading', { name: /Darnell/ });
  await navigate('/m/settings/notifications');
  const refresh = await screen.findByRole('button', { name: 'Refresh push registration' });
  expect(refresh).toHaveAccessibleDescription("Link this device's push registration to your current login.");
  expect(screen.getByRole('switch', { name: 'Push notifications' })).toHaveAttribute('aria-checked', 'true');
  expect(harness.state.rpcArgs.filter(call => call.name === 'upsert_push_subscription')).toEqual([]);
  fireEvent.click(refresh);
  await screen.findByText('Push registration linked to this login');
  expect(harness.state.rpcArgs.filter(call => call.name === 'upsert_push_subscription')).toEqual([
    { name: 'upsert_push_subscription', args: { p_endpoint: 'https://fcm.googleapis.com/test-device', p_p256dh: 'test-key', p_auth: 'test-auth' } },
  ]);
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
  expect(manager.subscribe).not.toHaveBeenCalled();
});

it("keeps an existing registration enabled when refresh fails and allows a deliberate retry", async () => {
  const { subscription, manager } = pushDevice();
  harness.state.rows['table:member_push_subscriptions'] = { id: 'owned-row' };
  let finish;
  harness.state.pushWrite = () => new Promise(resolve => { finish = resolve; });
  render(<App />);
  await screen.findByRole('heading', { name: /Darnell/ });
  await navigate('/m/settings/notifications');
  const refresh = await screen.findByRole('button', { name: 'Refresh push registration' });
  const toggle = screen.getByRole('switch', { name: 'Push notifications' });
  fireEvent.click(refresh);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect((refresh).closest('[aria-disabled="true"]')).not.toBeNull();
  await expectPendingFocus(refresh);
  expect((toggle).closest('[aria-disabled="true"]')).not.toBeNull();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
  expect(manager.subscribe).not.toHaveBeenCalled();
  fireEvent.click(refresh);
  expect(harness.state.rpcArgs.filter(call => call.name === 'upsert_push_subscription')).toHaveLength(1);
  await act(async () => finish({ data: null, error: { message: 'offline' } }));
  await screen.findByText("Couldn't update push — try again");
  expect(refresh).toBeEnabled();
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
  expect(manager.subscribe).not.toHaveBeenCalled();
  harness.state.pushWrite = async () => ({ data: null, error: null });
  fireEvent.click(refresh);
  await screen.findByText('Push registration linked to this login');
  expect(harness.state.rpcArgs.filter(call => call.name === 'upsert_push_subscription')).toHaveLength(2);
});

it.each(['missing', 'stale'])("reports push off when a %s browser endpoint cannot be replaced during refresh", async state => {
  const { subscription, manager } = pushDevice();
  harness.state.rows['table:member_push_subscriptions'] = { id: 'owned-row' };
  render(<App />);
  await screen.findByRole('heading', { name: /Darnell/ });
  await navigate('/m/settings/notifications');
  const refresh = await screen.findByRole('button', { name: 'Refresh push registration' });
  if (state === 'missing') manager.getSubscription.mockResolvedValue(null);
  else subscription.options.applicationServerKey = new Uint8Array([9]).buffer;
  manager.subscribe.mockRejectedValue(new Error('browser registration failed'));
  fireEvent.click(refresh);
  await screen.findByText("Couldn't update push — try again");
  expect(screen.getByRole('switch', { name: 'Push notifications' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.queryByRole('button', { name: 'Refresh push registration' })).not.toBeInTheDocument();
  expect(harness.state.rpcArgs.filter(call => call.name === 'upsert_push_subscription')).toHaveLength(0);
});

// #9462 (W2-12): a refused permission, or one not given ("default"), said
// "try again", which cannot help; the toast now says why push stayed off.
it.each([
  ["denied", "Notifications are blocked for this site in your browser settings."],
  ["default", "Push was not turned on because this browser has not been given permission to show notifications."],
])("says why push stayed off when the browser permission is %s", async (permission, sentence) => {
  const { manager } = pushDevice({ existing: false });
  Notification.requestPermission = vi.fn(async () => permission);
  render(<App />);
  await screen.findByRole('heading', { name: /Darnell/ });
  await navigate('/m/settings/notifications');
  fireEvent.click(await screen.findByRole('switch', { name: 'Push notifications' }));
  await waitFor(() => expect(document.querySelector('.toast[role="status"]')).toHaveTextContent(sentence));
  expect(screen.queryByText("Couldn't update push — try again")).toBeNull();
  expect(manager.subscribe).not.toHaveBeenCalled();
});
