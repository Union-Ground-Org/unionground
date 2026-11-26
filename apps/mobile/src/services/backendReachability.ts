// A fast answer to "is there any network path to the auth backend at all?".
// Offline, a request fails at once (no route or no DNS), while Supabase's own
// refresh keeps retrying with backoff for up to 30 seconds. Any HTTP answer,
// even an error status, proves a path exists; only a transport failure means
// the device is offline. A probe that ends by its own abort proves nothing
// either way (`silent`); the session deadline decides what to tell the member.
export type ReachabilityFetch = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<unknown>;

const defaultSend: ReachabilityFetch = (url, init) => fetch(url, init);

// UX-UG-NATIVE-BLACKHOLED-NETWORK-SHOWN-AS-SECURITY-CHECK-20261020:
// a radio that is up but passes no traffic (no route, captive portal, a
// blackholed network) answers nothing at all, so the probe ends by its own
// abort. That is not proof of a path: `silent` lets the session deadline tell
// the member they are offline instead of describing a security check, while
// work that answers before the deadline still takes the normal path.
export type BackendReachability = 'reachable' | 'offline' | 'silent';

export async function backendReachable(
  supabaseUrl: string,
  publishableKey: string,
  send: ReachabilityFetch = defaultSend,
  timeoutMs = 3000,
): Promise<BackendReachability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await send(`${supabaseUrl}/auth/v1/health`, { method: 'GET', headers: { apikey: publishableKey }, signal: controller.signal });
    return 'reachable';
  } catch {
    return controller.signal.aborted ? 'silent' : 'offline';
  } finally {
    clearTimeout(timer);
  }
}
