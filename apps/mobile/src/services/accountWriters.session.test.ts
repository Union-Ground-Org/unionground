import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { processLock } from '@supabase/auth-js';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { exactSessionIdentity, exactSessionIdentityMatches } from './sessionResume';
import { accessTokensShareSessionLineage } from '../lib/sessionLineage';
type SupabaseSdk = typeof import('@supabase/supabase-js');

const port = vi.hoisted(() => ({ shared: null as SupabaseClient | null, fetch: null as typeof globalThis.fetch | null }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { releaseEnvironment: 'development' } } } }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'public-test-key', portalBaseUrl: 'https://app.unionground.example' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
vi.mock('@supabase/supabase-js', async (original) => {
  const sdk = await original<SupabaseSdk>();
  return { ...sdk, createClient: (...args: Parameters<SupabaseSdk['createClient']>) => args[2]?.auth?.storage
    ? port.shared : sdk.createClient(args[0], args[1], { ...args[2], global: { ...args[2]?.global, fetch: (input: RequestInfo | URL, init?: RequestInit) => port.fetch!(input, init) } }) };
});
import { captureSessionWriter, setMobileSmsConsent, updateSignedInPassword, verifyMfaCode, setMobileChapterPin } from './supabase';

import { nativeAuthGate } from '../lib/nativeAuthGate';
const authStorage = new Map<string, string>();
let stopObserving: (() => void) | null = null;
const A = '1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36';
const B = '7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59';
const lineage = '5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10';
const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = (sub: string, nonce = '', session_id = lineage, exp = 9999999999) => `${encode({ alg: 'HS256' })}.${encode({ sub, exp, session_id, nonce, aal: nonce === 'mfa' ? 'aal2' : 'aal1' })}.sig0`;
const aToken = token(A);
const bToken = token(B, "", B);
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let bAsked = deferred<void>();
let bUser = deferred<Response>();
let requests: { path: string; bearer: string | null; body: unknown }[] = [];
let afterPassword: null | (() => Promise<void>) = null;
let refreshes = 0;
let issuedAt: string | null = null;
let afterChallenge: null | (() => Promise<void>) = null;
beforeEach(async () => {
  issuedAt = "2026-11-01T00:00:00Z"; requests = []; afterPassword = null; afterChallenge = null; authStorage.clear(); refreshes = 0; bAsked = deferred<void>(); bUser = deferred<Response>();
  port.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const bearer = new Headers(init?.headers).get('Authorization');
    const user = { user_metadata: issuedAt ? { union_ground_password_issued_at: issuedAt } : {}, id: bearer === `Bearer ${bToken}` ? B : A, aud: 'authenticated', role: 'authenticated', factors: [{ id: lineage, factor_type: 'totp', status: 'verified' }] };
    if (path === '/auth/v1/user' && (!init?.method || init.method === 'GET')) {
      if (user.id === B) { bAsked.resolve(); return bUser.promise; }
      return json(user);
    }
    if (path === '/auth/v1/token') { refreshes += 1; return json({ access_token: token(A, 'refreshed'), refresh_token: 'refreshed-a', token_type: 'bearer', expires_in: 3600, user }); }
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path, bearer, body });
    if (path === '/rest/v1/member_notifications') return json({ id: lineage, title: 'Notice', body: '', kind: 'notice', created_at: '2026-11-01T00:00:00Z' });
    if (path === '/auth/v1/user') {
      if (afterPassword && body && typeof body === 'object' && 'password' in body) { const done = afterPassword; afterPassword = null; await done(); }
      if (body && typeof body === 'object' && 'data' in body && (body as { data: { union_ground_password_issued_at?: unknown } }).data?.union_ground_password_issued_at === null) issuedAt = null;
      return json({ ...user, user_metadata: issuedAt ? { union_ground_password_issued_at: issuedAt } : {} });
    }
    if (path.endsWith('/challenge')) {
      if (afterChallenge) { const next = afterChallenge; afterChallenge = null; await next(); }
      return json({ id: lineage });
    }
    if (path.endsWith('/verify')) return json({ access_token: token(A, 'mfa'), refresh_token: 'mfa-a', token_type: 'bearer', expires_in: 3600, user });
    return json({ phoneE164: '+16175550111', consented: true });
  };
  const sdk = await vi.importActual<SupabaseSdk>('@supabase/supabase-js');
  port.shared ??= sdk.createClient('https://example.supabase.co', 'public-test-key', { auth: { persistSession: true, storageKey: 'native-account-session-test', storage: { getItem: (key: string) => authStorage.get(key) ?? null, setItem: (key: string, value: string) => { if (!nativeAuthGate.canWrite(value)) throw new Error('Retired account operation'); authStorage.set(key, value); }, removeItem: (key: string) => { authStorage.delete(key); } }, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock }, global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => port.fetch!(input, init) } });
  stopObserving = port.shared.auth.onAuthStateChange((_event, session) => { nativeAuthGate.observe(session); }).data.subscription.unsubscribe;
  expect((await port.shared.auth.setSession({ access_token: aToken, refresh_token: 'refresh-a' })).error).toBeNull();
});
afterEach(() => { stopObserving?.(); stopObserving = null; vi.unstubAllGlobals(); });
async function session() { return (await port.shared!.auth.getSession()).data.session!; }
async function replace() {
  const pending = port.shared!.auth.setSession({ access_token: bToken, refresh_token: 'refresh-b' });
  await bAsked.promise;
  return async () => { bUser.resolve(json({ id: B, aud: 'authenticated', role: 'authenticated' })); await pending; };
}
const writers = [
  ['SMS consent', (s: Session) => setMobileSmsConsent('+16175550111', true, captureSessionWriter(s))],
  ['password', (s: Session) => updateSignedInPassword('New-secret-for-test-2026', 'Current-secret-for-test', s)],
  ['MFA verification', (s: Session) => verifyMfaCode('123456', s)],
  ['campaign pin writer binding', (s: Session) => setMobileChapterPin(captureSessionWriter(s), lineage, true)],
] as const;

it('hands the real staged AAL2 installation to the provider before establishing MFA success', async () => {
  const source = readFileSync(new URL('../state/AppProvider.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('AppProvider.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let verify = ''; let listener = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'verifyMfa' && node.initializer && ts.isCallExpression(node.initializer)) verify = node.initializer.arguments[0]!.getText(tree);
    if (ts.isCallExpression(node) && node.expression.getText(tree).endsWith('.onAuthStateChange')) listener = node.arguments[0]!.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const composing = await session();
  const observedAuthIdentity = { current: exactSessionIdentity(composing) };
  const establishSession = vi.fn(async (installed: Session) => {
    expect(exactSessionIdentityMatches(observedAuthIdentity.current, exactSessionIdentity(installed))).toBe(true);
    expect((await port.shared!.auth.mfa.getAuthenticatorAssuranceLevel()).data?.currentLevel).toBe('aal2');
  });
  const env = {
    active: true, deletionReceipt: { current: false }, nativeAuthGate,
    providerMounted: { current: true }, session: composing, observedAuthIdentity,
    authIdentityFor: exactSessionIdentity, accessTokensShareSessionLineage,
    authIdentityMatches: (identity: ReturnType<typeof exactSessionIdentity>, next: Session) => exactSessionIdentityMatches(identity, exactSessionIdentity(next)),
    pendingAuthTransition: { current: null }, verifyMfaCode, establishSession,
    setError: vi.fn(), haptics: { success: vi.fn(), warning: vi.fn() },
  };
  const authEvent = runInNewContext(ts.transpile(`(${listener})`, { target: ts.ScriptTarget.ES2022 }), env) as (event: string, next: Session | null) => void;
  const subscription = port.shared!.auth.onAuthStateChange(authEvent).data.subscription;
  try {
    const verifyMfa = runInNewContext(ts.transpile(`(${verify})`, { target: ts.ScriptTarget.ES2022 }), env) as (code: string) => Promise<void>;
    await expect(verifyMfa('123456')).resolves.toBeUndefined();
    expect(establishSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ access_token: token(A, 'mfa'), refresh_token: 'mfa-a' }));
    expect(env.haptics.success).toHaveBeenCalledOnce();
    expect(env.haptics.warning).not.toHaveBeenCalled();
  } finally { subscription.unsubscribe(); }
});
it.each(writers)('%s refuses a real replacement held on the Auth lock', async (_name, write) => {
  const composing = await session(); const release = await replace();
  const pending = write(composing); void pending.catch(() => undefined);
  await release(); await pending.catch(() => undefined);
  expect(requests).toEqual([]);
});
it.each(writers)('%s preserves a legitimate same-session operation', async (_name, write) => {
  await write(await session());
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.bearer === `Bearer ${aToken}`)).toBe(true);
});
it.each(writers)('%s uses the renewed token within the same lineage', async (_name, write) => {
  const composing = await session(); const renewed = token(A, 'renewed');
  await port.shared!.auth.setSession({ access_token: renewed, refresh_token: 'renewed-a' });
  await write(composing);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.bearer === `Bearer ${renewed}`)).toBe(true);
});
it('a password acknowledgement never updates replacement-account metadata', async () => {
  const composing = await session(); const asked = deferred<void>(); const response = deferred<void>();
  afterPassword = async () => { asked.resolve(); await response.promise; };
  const changing = updateSignedInPassword('New-secret-for-test-2026', 'Current-secret-for-test', composing);
  await asked.promise;
  const replacing = port.shared!.auth.setSession({ access_token: bToken, refresh_token: 'refresh-b' });
  response.resolve();
  await bAsked.promise; bUser.resolve(json({ id: B, aud: 'authenticated', role: 'authenticated' }));
  await replacing; await changing;
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ path: '/auth/v1/user', bearer: `Bearer ${aToken}` });
  expect((await session()).user.id).toBe(B);
});
it('password proof from a different same-person session is refused', async () => {
  const composing = await session();
  await port.shared!.auth.setSession({ access_token: token(A, 'again', B), refresh_token: 'again-a' });
  await expect(updateSignedInPassword('New-secret-for-test-2026', 'Current-secret-for-test', composing)).rejects.toBeDefined();
  expect(requests).toEqual([]);
});
it('unbound account writes fail closed', async () => {
  for (const run of [() => setMobileSmsConsent(null, false), () => updateSignedInPassword('New-secret-for-test-2026', 'Current-secret-for-test')]) await expect(run()).rejects.toBeDefined();
  expect(requests).toEqual([]);
});

it('MFA never verifies or adopts a replacement after the challenge acknowledgement', async () => {
  const composing = await session(); afterChallenge = async () => { const release = await replace(); await release(); };
  await expect(verifyMfaCode('123456', composing)).rejects.toBeDefined();
  expect(requests.map((r) => r.path)).toEqual([`/auth/v1/factors/${lineage}/challenge`]);
  expect((await session()).user.id).toBe(B);
});

it('native MFA adoption cannot overwrite B when B wins the real Auth install lock', async () => {
  const composing = await session();
  const install = port.shared!.auth.setSession.bind(port.shared!.auth);
  port.shared!.auth.setSession = async (candidate) => {
    const replacing = install({ access_token: bToken, refresh_token: 'replacement-b' });
    await bAsked.promise;
    const pending = install(candidate);
    bUser.resolve(json({ id: B, aud: 'authenticated', role: 'authenticated' }));
    await replacing;
    return pending;
  };
  try {
    await expect(verifyMfaCode('123456', composing)).rejects.toBeDefined();
    expect((await session()).user.id).toBe(B);
  } finally { port.shared!.auth.setSession = install; }
});

it.each(writers)('%s refreshes an expiring token within the composing lineage', async (_name, write) => {
  const composing = await session();
  await port.shared!.auth.setSession({ access_token: token(A, 'expiring', lineage, Math.floor(Date.now() / 1000) + 30), refresh_token: 'refresh-a' });
  await write(composing);
  expect(refreshes).toBe(1); expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.bearer === `Bearer ${token(A, 'refreshed')}`)).toBe(true);
});
it('a refresh during password acknowledgement supplies the metadata continuation current token', async () => {
  const composing = await session(); const renewed = token(A, 'after-password');
  afterPassword = async () => { await port.shared!.auth.setSession({ access_token: renewed, refresh_token: 'after-password' }); };
  await updateSignedInPassword('New-secret-for-test-2026', 'Current-secret-for-test', composing);
  expect(requests.map((r) => r.bearer)).toEqual([`Bearer ${aToken}`, `Bearer ${renewed}`]);
});
it('a refresh during the MFA challenge supplies the verification current token', async () => {
  const composing = await session(); const renewed = token(A, 'after-challenge');
  afterChallenge = async () => { await port.shared!.auth.setSession({ access_token: renewed, refresh_token: 'after-challenge' }); };
  await verifyMfaCode('123456', composing);
  expect(requests.map((r) => r.bearer)).toEqual([`Bearer ${aToken}`, `Bearer ${renewed}`]);
  expect((await port.shared!.auth.mfa.getAuthenticatorAssuranceLevel()).data?.currentLevel).toBe('aal2');
});


it('an accepted native password change clears the live and durable Home prompt immediately', async () => {
  const composing = await session();
  const beforeMetadata: Record<string, unknown> = composing.user.user_metadata;
  expect(beforeMetadata.union_ground_password_issued_at).toBeTruthy();
  await updateSignedInPassword('New-secret-for-test-2026', 'Current-secret-for-test', composing);
  expect(issuedAt).toBeNull();
  const liveMetadata: Record<string, unknown> = (await session()).user.user_metadata;
  const durable: { user: { user_metadata: Record<string, unknown> } } = JSON.parse(authStorage.get('native-account-session-test')!);
  expect(liveMetadata.union_ground_password_issued_at).toBeUndefined();
  expect(durable.user.user_metadata.union_ground_password_issued_at).toBeUndefined();
});

it('accepted native password metadata never installs A over B at the real Auth lock', async () => {
  const composing = await session(); const install = port.shared!.auth.setSession.bind(port.shared!.auth);
  port.shared!.auth.setSession = async (candidate) => {
    const replacing = install({ access_token: bToken, refresh_token: 'replacement-b' });
    await bAsked.promise; const pending = install(candidate);
    bUser.resolve(json({ id: B, aud: 'authenticated', role: 'authenticated' }));
    await replacing; return pending;
  };
  try {
    await updateSignedInPassword('New-secret-for-test-2026', 'Current-secret-for-test', composing);
    expect((await session()).user.id).toBe(B);
  } finally { port.shared!.auth.setSession = install; }
});
