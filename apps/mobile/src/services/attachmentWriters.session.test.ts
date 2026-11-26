import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { processLock } from '@supabase/auth-js';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
type SupabaseSdk = typeof import('@supabase/supabase-js');

const port = vi.hoisted(() => ({ shared: null as SupabaseClient | null, fetch: null as typeof globalThis.fetch | null }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { releaseEnvironment: 'development' } } } }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://unionground-sample.supabase.co', supabasePublishableKey: 'public-test-key', portalBaseUrl: 'https://sample.unionground.example' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
vi.mock('@supabase/supabase-js', async (original) => {
  const sdk = await original<SupabaseSdk>();
  return { ...sdk, createClient: (...args: Parameters<SupabaseSdk['createClient']>) => args[2]?.auth?.storage
    ? port.shared : sdk.createClient(args[0], args[1], { ...args[2], global: { ...args[2]?.global, fetch: (input: RequestInfo | URL, init?: RequestInit) => port.fetch!(input, init) } }) };
});
import { captureSessionWriter } from './supabase';
import { removeFormFile, recheckFormFile } from './formFiles';
import { beginPendingSharedAttachmentUpload, reconcilePendingSharedAttachmentUploadRecovery, getPendingSharedAttachmentUpload, preparePendingSharedAttachmentUploadForSessionLoss } from './secureShareIntake';
import { uploadAuthorizedAttachment, reconcileAuthorizedAttachmentUpload, removeAuthorizedAttachment, recheckAuthorizedAttachment, type AttachmentTarget } from './attachments';

const A = '1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36';
const B = '7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59';
const lineage = '5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10';
const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = (sub: string, nonce = '', session_id = lineage, exp = 9999999999) => `${encode({ alg: 'HS256' })}.${encode({ sub, exp, session_id, nonce })}.sig0`;
const aToken = token(A);
const bToken = token(B);
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let bAsked = deferred<void>();
let bUser = deferred<Response>();
let requests: { path: string; bearer: string | null; body: unknown }[] = [];
let refreshes = 0;
let afterWrite: null | (() => Promise<void>) = null;
let afterConfirm: null | (() => Promise<void>) = null;
let refuseLateBProof = false;
const share = vi.hoisted(() => ({ storage: new Map<string, string>(), pending: null as null | Record<string, unknown> }));
let target: AttachmentTarget = { kind: 'task', id: B };
const row = () => ({ id: lineage, task_id: B, case_id: B, bucket_id: target.kind === 'case' ? 'case-files' : 'chapter-task-files', object_name: 'private/file', filename: 'note.txt', mime_type: 'text/plain', size_bytes: 3, created_at: '2026-11-19T12:00:00Z', confirmed_at: '2026-11-19T12:01:00Z' });
beforeEach(async () => {
  requests = []; afterWrite = null; afterConfirm = null; refuseLateBProof = false; refreshes = 0; share.storage.clear(); share.pending = { token: B, uri: 'file:///private/staging/payload', filename: 'note.txt', mimeType: 'text/plain', sizeBytes: 3, createdAtMs: Date.now() }; bAsked = deferred<void>(); bUser = deferred<Response>();
  port.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const bearer = new Headers(init?.headers).get('Authorization');
    const user = { id: bearer === `Bearer ${bToken}` ? B : A, aud: 'authenticated', role: 'authenticated' };
    if (path === '/auth/v1/user' && (!init?.method || init.method === 'GET')) {
      if (user.id === B) {
        if (refuseLateBProof) return new Response(JSON.stringify({ error_code: 'session_not_found', msg: 'Session no longer exists' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        bAsked.resolve(); return bUser.promise;
      }
      return json(user);
    }
    if (path === '/auth/v1/token') { refreshes += 1; return json({ access_token: token(A, 'refreshed'), refresh_token: 'refreshed-a', token_type: 'bearer', expires_in: 3600, user }); }
    if (path.startsWith('/rest/v1/') && init?.method === 'GET') return json([row()]);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ path, bearer, body });
    if (afterWrite) { const next = afterWrite; afterWrite = null; await next(); }
    if (path.includes('confirm_') && afterConfirm) { const next = afterConfirm; afterConfirm = null; await next(); }
    if (path.includes('private-file')) return json({ fileId: lineage, status: 'clean' });
    if (path.includes('sensitive-form-files')) return json({ fileId: lineage, status: 'removed', receipt: { id: lineage, deleted: true } });
    if (path.includes('sensitive-case-files')) return json({ fileId: lineage, status: 'uploaded' });
    if (path.includes('/storage/')) return json({ Key: 'private/file' });
    if (path.includes('abort_')) return json({ id: lineage, deleted: true });
    if (path.includes('request_')) return json({ id: lineage, deleted: true, removal_id: lineage });
    return json(row());
  };
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => port.fetch!(input, init));
  const sdk = await vi.importActual<SupabaseSdk>('@supabase/supabase-js');
  port.shared ??= sdk.createClient('https://unionground-sample.supabase.co', 'public-test-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock }, global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => port.fetch!(input, init) } });
  expect((await port.shared.auth.setSession({ access_token: aToken, refresh_token: 'refresh-a' })).error).toBeNull();
});
afterEach(async () => { await preparePendingSharedAttachmentUploadForSessionLoss(A); vi.unstubAllGlobals(); });
async function session() { return (await port.shared!.auth.getSession()).data.session!; }
async function replace() {
  const pending = port.shared!.auth.setSession({ access_token: bToken, refresh_token: 'refresh-b' });
  await bAsked.promise;
  return async () => { bUser.resolve(json({ id: B, aud: 'authenticated', role: 'authenticated' })); await pending; };
}

vi.mock('expo-crypto', () => ({ randomUUID: () => lineage }));
vi.mock('expo-file-system', () => ({
  File: class { exists = true; size = 3; constructor(public uri: string) {} async arrayBuffer() { return new Uint8Array([65, 66, 67]).buffer; } delete() { this.exists = false; } },
  Directory: class { uri = 'file:///cache/ug-attachment-cache-v1'; exists = true; }, Paths: { cache: { uri: 'file:///cache/' } },
}));
vi.mock('./lifecycleDiagnostics', () => ({ recordLifecycleEvent: () => undefined }));
const candidate = { uri: 'file:///cache/note.txt', filename: 'note.txt', mimeType: 'text/plain', sizeBytes: 3, cacheOwned: true } as const;
const writers = [
  ['upload', (s: Session) => uploadAuthorizedAttachment(target, candidate, { fileID: lineage, cleanupCandidate: false, writer: captureSessionWriter(s) })],
  ['recovery', (s: Session) => reconcileAuthorizedAttachmentUpload(target, lineage, { writer: captureSessionWriter(s) })],
  ['removal', (s: Session) => removeAuthorizedAttachment(target, lineage, captureSessionWriter(s))],
  ['inspection', (s: Session) => recheckAuthorizedAttachment(target, lineage, captureSessionWriter(s))],
] as const;
for (const kind of ['task', 'case'] as const) {
  it.each(writers)(`${kind} %s refuses a real replacement held across dispatch`, async (_name, write) => {
    target = { kind, id: B }; const composing = await session(); const release = await replace();
    const pending = write(composing); void pending.catch(() => undefined);
    await release(); await pending.catch(() => undefined);
    expect(requests).toEqual([]);
  });
  it.each(writers)(`${kind} %s completes for the composing person`, async (_name, write) => {
    target = { kind, id: B }; await write(await session());
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.bearer === `Bearer ${aToken}`)).toBe(true);
  });
  it.each(writers)(`${kind} %s accepts same-person renewed sign-in`, async (_name, write) => {
    target = { kind, id: B }; const composing = await session(); const renewed = token(A, 'renewed');
    await port.shared!.auth.setSession({ access_token: renewed, refresh_token: 'renewed-a' });
    await write(composing);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.bearer === `Bearer ${renewed}`)).toBe(true);
  });
  it.each(writers)(`${kind} %s refreshes an expiring token before dispatch`, async (_name, write) => {
    target = { kind, id: B }; const composing = await session();
    await port.shared!.auth.setSession({ access_token: token(A, 'expiring', lineage, Math.floor(Date.now() / 1000) + 30), refresh_token: 'refresh-a' });
    await write(composing);
    expect(refreshes).toBe(1); expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.bearer === `Bearer ${token(A, 'refreshed')}`)).toBe(true);
  });
  it(`${kind} upload never sends bytes, inspection, confirmation or abort as B after registration`, async () => {
    target = { kind, id: B }; const composing = await session();
    afterWrite = async () => { const release = await replace(); await release(); };
    await expect(uploadAuthorizedAttachment(target, candidate, { fileID: lineage, cleanupCandidate: false, writer: captureSessionWriter(composing) })).rejects.toBeDefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ bearer: `Bearer ${aToken}` });
    expect(requests[0]!.path).toContain('begin_');
  });
}
it('unbound attachment uploads never dispatch', async () => {
  await expect(uploadAuthorizedAttachment(target, candidate, { fileID: lineage, cleanupCandidate: false })).rejects.toBeDefined();
  expect(requests).toEqual([]);
});

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => share.storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { share.storage.set(key, value); },
  deleteItemAsync: async (key: string) => { share.storage.delete(key); },
}));
vi.mock('../../modules/secure-share-intake/src/SecureShareIntakeModule', () => ({ default: {
  getPendingAsync: async () => share.pending,
  captureCleanupTokensAsync: async () => share.pending ? [share.pending.token] : [],
  discardAsync: async () => { share.pending = null; return true; },
  discardAllAsync: async () => { share.pending = null; return true; },
} }));

it('a durable share captures its composing owner before the Auth lock', async () => {
  target = { kind: 'task', id: B }; const composing = await session(); const release = await replace();
  const operation = beginPendingSharedAttachmentUpload(target, B, captureSessionWriter(composing));
  await release(); expect((await operation.settlement).status).toBe('failed');
  expect(requests).toEqual([]); expect(share.storage.size).toBe(0);
  expect(getPendingSharedAttachmentUpload(B)).toBeNull();
});
it('a legitimate durable share carries A through confirmation and retains the exact owner receipt', async () => {
  target = { kind: 'task', id: B };
  const operation = beginPendingSharedAttachmentUpload(target, B, captureSessionWriter(await session()));
  expect(await operation.settlement).toMatchObject({ status: 'uploaded', attachmentID: lineage });
  expect(requests.length).toBeGreaterThan(2);
  expect(requests.every((r) => r.bearer === `Bearer ${aToken}`)).toBe(true);
  expect(JSON.parse(share.storage.get('union-ground.secure-share-upload.v1')!)).toMatchObject({ userID: A, attachmentID: lineage, status: 'uploaded' });
  expect(getPendingSharedAttachmentUpload(A)).toBe(operation);
  expect(getPendingSharedAttachmentUpload(B)).toBeNull();
});
it('cold recovery refuses B and retains A exact recovery', async () => {
  share.storage.set('union-ground.secure-share-upload.v1', JSON.stringify({ version: 1, backend: 'https://unionground-sample.supabase.co', userID: A, attachmentID: lineage, token: B, target: { kind: 'task', id: B }, status: 'uploading' }));
  const writer = captureSessionWriter(await session()); const release = await replace();
  const pending = reconcilePendingSharedAttachmentUploadRecovery(writer); void pending.catch(() => undefined);
  await release(); await expect(pending).rejects.toBeDefined();
  expect(requests).toEqual([]);
  expect(JSON.parse(share.storage.get('union-ground.secure-share-upload.v1')!)).toMatchObject({ userID: A, status: 'uploading' });
});
it('cold recovery completes with A renewed token', async () => {
  target = { kind: 'task', id: B };
  share.storage.set('union-ground.secure-share-upload.v1', JSON.stringify({ version: 1, backend: 'https://unionground-sample.supabase.co', userID: A, attachmentID: lineage, token: B, target, status: 'uploading' }));
  const writer = captureSessionWriter(await session()); const renewed = token(A, 'recovered');
  await port.shared!.auth.setSession({ access_token: renewed, refresh_token: 'recovered-a' });
  expect(await reconcilePendingSharedAttachmentUploadRecovery(writer)).toMatchObject({ status: 'uploaded', attachmentID: lineage });
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.bearer === `Bearer ${renewed}`)).toBe(true);
});
it('late A upload finalization never lets an Auth refusal clear replacement B', async () => {
  target = { kind: 'task', id: B };
  const writer = captureSessionWriter(await session());
  afterConfirm = async () => { await (await replace())(); refuseLateBProof = true; };
  const operation = beginPendingSharedAttachmentUpload(target, B, writer);
  expect((await operation.settlement).status).toBe('failed');
  expect((await port.shared!.auth.getSession()).data.session?.user.id).toBe(B);
  expect(requests.every((request) => request.bearer === `Bearer ${aToken}`)).toBe(true);
  expect(JSON.parse(share.storage.get('union-ground.secure-share-upload.v1')!)).toMatchObject({ userID: A, attachmentID: lineage });
});

const form = { formID: B, templateKey: 'grievance', ownerID: A };
it.each([['removal', () => removeFormFile(form, lineage)], ['inspection', () => recheckFormFile(form, lineage)]] as const)('form %s refuses replacement after its original owner pin', async (_name, write) => {
  const getSession = port.shared!.auth.getSession.bind(port.shared!.auth);
  let first = true; let replacement: Promise<unknown> | null = null;
  port.shared!.auth.getSession = async () => {
    const observed = await getSession();
    if (first) { first = false; replacement = port.shared!.auth.setSession({ access_token: bToken, refresh_token: 'b' }); await bAsked.promise; }
    return observed;
  };
  try {
    const pending = write(); void pending.catch(() => undefined);
    await bAsked.promise; bUser.resolve(json({ id: B, aud: 'authenticated', role: 'authenticated' }));
    await replacement; await pending.catch(() => undefined);
    expect(requests).toEqual([]);
  } finally { port.shared!.auth.getSession = getSession; }
});
it.each([['removal', () => removeFormFile(form, lineage)], ['inspection', () => recheckFormFile(form, lineage)]] as const)('form %s succeeds for A', async (_name, write) => {
  await write(); expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.bearer === `Bearer ${aToken}`)).toBe(true);
});
