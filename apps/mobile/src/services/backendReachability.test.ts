import { describe, expect, it } from 'vitest';

import { backendReachable, type ReachabilityFetch } from './backendReachability';

describe('backendReachable', () => {
  it('reports offline on a transport failure', async () => {
    const send: ReachabilityFetch = async () => { throw new TypeError('Network request failed'); };
    await expect(backendReachable('https://example.supabase.co', 'sb_publishable_x', send)).resolves.toBe('offline');
  });

  it('treats any HTTP answer, even an error status, as reachable', async () => {
    const send: ReachabilityFetch = async () => ({ ok: false, status: 503 });
    await expect(backendReachable('https://example.supabase.co', 'sb_publishable_x', send)).resolves.toBe('reachable');
  });

  // UX-UG-NATIVE-BLACKHOLED-NETWORK-SHOWN-AS-SECURITY-CHECK-20261020:
  // a probe that got no answer before its own abort is neither proof of a path
  // nor proof of none; the session deadline decides what the member is told.
  it('answers silent when its own abort ends a probe that got no HTTP answer', async () => {
    const send: ReachabilityFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    await expect(backendReachable('https://example.supabase.co', 'sb_publishable_x', send, 5)).resolves.toBe('silent');
  });

  it('does not mistake a rejection raised before the abort for silence', async () => {
    const send: ReachabilityFetch = async () => { throw new Error('DNS lookup failed'); };
    await expect(backendReachable('https://example.supabase.co', 'sb_publishable_x', send, 5)).resolves.toBe('offline');
  });
});
