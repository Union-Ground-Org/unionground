import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MemberConversation } from '../models/member';
import { conversationUnreadStore, createConversationUnreadPoller } from './conversationUnread';
import { LOW_DATA_POLL_INTERVAL_MS, NORMAL_POLL_INTERVAL_MS, resolveLowDataPolicy, UNKNOWN_NETWORK_SIGNALS } from './lowDataPolicy';

const conversations: MemberConversation[] = [{
  id: 'fixture-conversation', title: 'Preview campaign contact', counterpartRole: 'steward',
  initials: 'PC', createdAt: '2026-09-28T12:00:00-04:00', updatedAt: '2026-09-28T12:00:00-04:00',
  unreadCount: 1, latestMessage: 'A fictional learning reminder.',
}];
const payload = JSON.stringify(conversations);
let server: Server | undefined;
afterEach(async () => {
  vi.useRealTimers();
  conversationUnreadStore.reset();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  }
});

async function fixture() {
  let requests = 0;
  let bytes = 0;
  let interrupted = false;
  let revoked = false;
  server = createServer((request, response) => {
    requests += 1;
    if (interrupted) { request.socket.destroy(); return; }
    const body = revoked ? '[]' : payload;
    bytes += Buffer.byteLength(body);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/summaries`;
  let lastLoad: Promise<readonly MemberConversation[]> = Promise.resolve([]);
  const load = () => {
    lastLoad = (async () => {
      const response = await fetch(url);
      return JSON.parse(await response.text()) as MemberConversation[];
    })();
    return lastLoad;
  };
  return {
    load, settle: () => lastLoad.catch(() => undefined), counts: () => ({ requests, bytes }),
    interrupt: (value: boolean) => { interrupted = value; }, revoke: () => { revoked = true; },
  };
}

describe('same foreground unread journey over real local HTTP', () => {
  it('measures Off and On with the same payload, 5 minutes and one explicit mid-journey Refresh', async () => {
    const network = await fixture();
    // Keep HTTP, fetch and socket timers real. Only the application's interval
    // and clock advance, and each actual response is awaited before continuing.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    const measurements = [];
    for (const mode of ['off', 'on'] as const) {
      const before = network.counts();
      const policy = resolveLowDataPolicy(mode, UNKNOWN_NETWORK_SIGNALS);
      const poller = createConversationUnreadPoller('fixture-account', {
        load: network.load,
        intervalMs: policy.enabled ? LOW_DATA_POLL_INTERVAL_MS : NORMAL_POLL_INTERVAL_MS,
      });
      await poller.tick(); // Opening the same journey.
      poller.start();
      for (let elapsed = 30_000; elapsed <= 300_000; elapsed += 30_000) {
        await vi.advanceTimersByTimeAsync(30_000);
        await network.settle();
        if (elapsed === 150_000) expect(await poller.tick()).toEqual(conversations);
      }
      poller.stop();
      const after = network.counts();
      measurements.push({ mode, requests: after.requests - before.requests, bytes: after.bytes - before.bytes });
    }
    expect(measurements[0]).toEqual({ mode: 'off', requests: 12, bytes: 12 * Buffer.byteLength(payload) });
    expect(measurements[1]).toEqual({ mode: 'on', requests: 4, bytes: 4 * Buffer.byteLength(payload) });
    console.info('LOW_DATA_MEASUREMENT', JSON.stringify({ journey: '5-minute foreground unread summaries; open + explicit Refresh at 150 seconds', payloadBytes: Buffer.byteLength(payload), measurements, scope: 'local HTTP response-body bytes; not full-app, compressed transport or physical-device radio bytes' }));
  });

  it('recovers after an interrupted connection, clears revoked rows, and stops after account changes', async () => {
    const network = await fixture();
    const poller = createConversationUnreadPoller('fixture-account', { load: network.load, intervalMs: LOW_DATA_POLL_INTERVAL_MS });
    expect(await poller.tick()).toEqual(conversations);
    network.interrupt(true);
    expect(await poller.tick()).toBeNull();
    network.interrupt(false);
    network.revoke();
    expect(await poller.tick()).toEqual([]);
    expect(conversationUnreadStore.conversations()).toEqual([]);
    let complete!: (value: readonly MemberConversation[]) => void;
    const oldAccount = createConversationUnreadPoller('old-account', { load: () => new Promise((resolve) => { complete = resolve; }) });
    const pending = oldAccount.tick();
    oldAccount.stop();
    complete(conversations);
    expect(await pending).toBeNull();
    expect(conversationUnreadStore.conversations()).toEqual([]);
  });
});
