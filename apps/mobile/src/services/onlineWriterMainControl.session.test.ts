import { processLock, type SupabaseClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';

// Copy this file unchanged onto Main to run the historical negative control.
// Only the exported call shape differs: Main takes (id, body); #9254 takes
// (writer, id, body). Both invoke the real production sendMemberMessage and
// the real pinned SDK/Auth lock, with a replacement held at its user read.
type Sdk = typeof import('@supabase/supabase-js');
const port = vi.hoisted(() => ({ shared: null as SupabaseClient | null }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { releaseEnvironment: 'development' } } } }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://main-control.invalid', supabasePublishableKey: 'sb_publishable_test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
vi.mock('@supabase/supabase-js', async (original) => {
  const sdk = await original<Sdk>();
  return { ...sdk, createClient: (...args: Parameters<typeof sdk.createClient>) => args[2]?.accessToken ? sdk.createClient(...args) : port.shared };
});
import * as production from './supabase';

it('the production worker send never dispatches A’s draft with B’s token across the real Auth lock', async () => {
  const sdk = await vi.importActual<Sdk>('@supabase/supabase-js');
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = (id: string) => `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, exp: 9999999999, role: 'authenticated' })}.sig0`;
  const a = token('member-a'), b = token('member-b');
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const dispatchedAs: string[] = [];
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('Authorization');
    if (String(input).endsWith('/auth/v1/user')) {
      const id = authorization === `Bearer ${b}` ? 'member-b' : 'member-a';
      if (id === 'member-b') { entered(); await held; }
      return json({ id, aud: 'authenticated', role: 'authenticated' });
    }
    if (String(input).includes('/rpc/send_member_message')) dispatchedAs.push(authorization === `Bearer ${a}` ? 'A' : authorization === `Bearer ${b}` ? 'B' : 'other');
    return json({ id: 'accepted-message' });
  };
  port.shared = sdk.createClient('https://main-control.invalid', 'sb_publishable_test', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock }, global: { fetch: transport },
  });
  vi.stubGlobal('fetch', transport);
  try {
    const signedIn = await port.shared.auth.setSession({ access_token: a, refresh_token: 'synthetic-a' });
    expect(signedIn.error).toBeNull();
    const writer = 'captureSessionWriter' in production ? production.captureSessionWriter(signedIn.data.session!) : null;
    const signingInB = port.shared.auth.setSession({ access_token: b, refresh_token: 'synthetic-b' });
    await started;
    const args = writer ? [writer, 'conversation-a', 'A draft'] : ['conversation-a', 'A draft'];
    const sending = Reflect.apply(production.sendMemberMessage, undefined, args) as Promise<void>;
    const settled = sending.catch(() => undefined);
    release();
    await signingInB;
    await settled;
    expect(dispatchedAs, 'the actual request must retain A or be refused; historical Main emits B').not.toContain('B');
    expect(dispatchedAs).not.toContain('other');
  } finally { release?.(); vi.unstubAllGlobals(); }
});
