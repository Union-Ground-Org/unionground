import { boundShareRecoveryTestApi } from '../testing/boundShareRecoveryTestApi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShareRecoveryTestControl } from './shareRecoveryTestHook';

const mocks = vi.hoisted(() => ({
  userID: '',
  accessToken: '',
  activeToken: '',
  createdAt: 0,
  files: new Map<string, string>(),
  storage: new Map<string, string>(),
  upload: vi.fn(),
  reconcile: vi.fn(),
  signOut: vi.fn(),
  refreshSession: vi.fn(),
  getUser: vi.fn(),
  revoked: new Set<string>(),
  signedOutListener: true,
  sessionLost: false,
  uuid: vi.fn(),
  discard: vi.fn(),
}));
const userA = '55555555-5555-4555-8555-555555555555';
const userB = '66666666-6666-4666-8666-666666666666';
const tokenA = '11111111-1111-4111-8111-111111111111';
const tokenB = '88888888-8888-4888-8888-888888888888';
const uploadA = '44444444-4444-4444-8444-444444444444';
const uploadB = '77777777-7777-4777-8777-777777777777';
const target = { kind: 'case' as const, id: '22222222-2222-4222-8222-222222222222' };
const host = globalThis as typeof globalThis & { __unionGroundShareRecoveryTest?: ShareRecoveryTestControl };

vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {
  releaseEnvironment: 'development', shareRecoveryTestHook: true,
  supabaseUrl: 'https://unionground-sample.supabase.co',
} } } }));
vi.mock('../lib/config', () => ({ mobileConfig: { supabaseUrl: 'https://unionground-sample.supabase.co' } }));
vi.mock('expo-crypto', () => ({ randomUUID: mocks.uuid }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => mocks.storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mocks.storage.set(key, value); },
  deleteItemAsync: async (key: string) => { mocks.storage.delete(key); },
}));
vi.mock('../../modules/secure-share-intake/src/SecureShareIntakeModule', () => ({ default: {
  getPendingAsync: async () => mocks.files.has(mocks.activeToken) ? {
    token: mocks.activeToken, createdAtMs: mocks.createdAt, uri: 'file:///private/staging/payload',
    filename: 'flow66.pdf', mimeType: 'application/pdf', sizeBytes: 4,
  } : null,
  captureCleanupTokensAsync: async () => [...mocks.files.keys()],
  discardAsync: mocks.discard,
} }));
vi.mock('./supabase', () => ({ verifyCapturedMobileSession: () => mocks.getUser(), getSupabaseClient: () => ({ auth: {
  getUser: mocks.getUser,
  getSession: async () => ({ data: { session: localSession() }, error: null }),
  admin: { signOut: mocks.signOut },
  refreshSession: mocks.refreshSession,
} }) }));
vi.mock('./attachments', async (importOriginal) => {
  const actual: typeof import('./attachments') = await importOriginal();
  return {
    ...actual,
    uploadAuthorizedAttachment: mocks.upload,
    reconcileAuthorizedAttachmentUpload: mocks.reconcile,
  };
});

let share: typeof import('./secureShareIntake');
function localSession() {
  return mocks.sessionLost ? null : { user: { id: mocks.userID }, access_token: mocks.accessToken };
}
function signIn(userID: string, accessToken: string) {
  mocks.userID = userID;
  mocks.accessToken = accessToken;
  mocks.sessionLost = false;
}
const sessionMissing = { name: 'AuthSessionMissingError', message: 'Auth session missing!' };
function attachment(id: string) {
  return {
    id, targetID: target.id, bucketID: 'case-files', objectName: `private/${id}/flow66.pdf`,
    filename: 'flow66.pdf', mimeType: 'application/pdf', sizeBytes: 4, createdAt: '2026-10-10T20:00:00-04:00',
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('__DEV__', true);
  signIn(userA, 'fictional-captured-access-token');
  mocks.revoked.clear();
  mocks.signedOutListener = true;
  mocks.activeToken = tokenA;
  mocks.createdAt = Date.now();
  mocks.files.clear();
  mocks.files.set(tokenA, 'old exact bytes');
  mocks.storage.clear();
  mocks.uuid.mockReset().mockReturnValueOnce(uploadA).mockReturnValue(uploadB);
  mocks.upload.mockReset().mockResolvedValueOnce(attachment(uploadA)).mockResolvedValue(attachment(uploadB));
  mocks.reconcile.mockReset().mockResolvedValue({ status: 'confirmed', attachment: attachment(uploadA) });
  // POST /logout?scope=local deletes the server session behind exactly this JWT.
  mocks.signOut.mockReset().mockImplementation(async (jwt: string) => {
    mocks.revoked.add(jwt);
    return { error: null };
  });
  // auth-js 2.110.7: a non-retryable refresh failure keeps a session whose
  // access token is unexpired, removes nothing and emits no SIGNED_OUT.
  mocks.refreshSession.mockReset().mockImplementation(async () => {
    const session = localSession();
    if (session && mocks.revoked.has(session.access_token)) {
      return { data: { user: null, session: null }, error: { name: 'AuthApiError', code: 'refresh_token_not_found' } };
    }
    return { data: { user: session?.user ?? null, session }, error: null };
  });
  // auth-js 2.110.7: GET /user with a revoked JWT answers session_not_found, so
  // Auth removes the local session and then emits SIGNED_OUT.
  mocks.getUser.mockReset().mockImplementation(async () => {
    const session = localSession();
    if (!session) return { data: { user: null }, error: sessionMissing };
    if (!mocks.revoked.has(session.access_token)) return { data: { user: { id: session.user.id } }, error: null };
    mocks.sessionLost = true;
    // The mounted AppProvider starts this exact service path on SIGNED_OUT.
    // The test supplies that callback, not a second hook-owned cleanup path.
    if (mocks.signedOutListener) await share.preparePendingSharedAttachmentUploadForSessionLoss(session.user.id);
    return { data: { user: null }, error: sessionMissing };
  });
  mocks.discard.mockReset().mockImplementation(async (token: string) => { mocks.files.delete(token); return true; });
  share = boundShareRecoveryTestApi(await import('./secureShareIntake'), () => ({ auth: { getUser: mocks.getUser } }), () => mocks.userID);
});

afterEach(() => {
  const control = host.__unionGroundShareRecoveryTest;
  const status = control?.status();
  if (status) control?.reset(status.run);
  delete host.__unionGroundShareRecoveryTest;
  vi.unstubAllGlobals();
});

describe('flow 66 using the installed device test hook', () => {
  it('pauses session-loss recovery after exact scope capture and resumes the real cleanup', async () => {
    await share.readPendingSharedAttachment();
    const point = host.__unionGroundShareRecoveryTest!.boundaries['session-loss-recovery'];
    const run = point.arm();
    let settled = false;
    const cleanup = share.preparePendingSharedAttachmentUploadForSessionLoss(userA)
      .then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(point.status()?.phase).toBe('held'));
    expect(settled).toBe(false);
    expect(mocks.files.get(tokenA)).toBe('old exact bytes');
    expect(mocks.discard).not.toHaveBeenCalled();
    point.release(run);
    await expect(cleanup).resolves.toBe('ready');
    expect(mocks.files.size).toBe(0);
    expect(mocks.discard).toHaveBeenCalledWith(tokenA);
    point.reset(run);
  });

  it('runs delayed captured-sibling cleanup after B stages without selecting B bytes', async () => {
    const sibling = '99999999-9999-4999-8999-999999999999';
    mocks.files.set(sibling, 'old sibling bytes');
    const control = host.__unionGroundShareRecoveryTest!;
    const run = control.arm();
    const cleanup = control.startCleanup(run);
    await vi.waitFor(() => expect(control.status()?.phase).toBe('held'));
    await control.loseSession(run);
    signIn(userB, 'fictional-next-access-token');
    await share.preparePendingSharedAttachmentUploadForSessionEstablishment(userB);
    mocks.activeToken = tokenB;
    mocks.files.set(tokenB, 'new exact bytes');
    const newer = await share.readPendingSharedAttachment();
    control.release(run);
    await cleanup;
    expect(mocks.files.get(tokenB)).toBe('new exact bytes');
    expect(await share.readPendingSharedAttachment()).toEqual(newer);
    expect(mocks.discard).not.toHaveBeenCalledWith(tokenB);
    expect(new Set(mocks.discard.mock.calls.map((call: unknown[]) => call[0])))
      .toEqual(new Set([tokenA, sibling]));
    await share.discardPendingSharedAttachment(tokenB);
    expect(mocks.files.size).toBe(0);
    expect(mocks.storage.size).toBe(0);
  });

  it('lets B establish while A is held and preserves B exact staged bytes after A completes late', async () => {
    const control = host.__unionGroundShareRecoveryTest!;
    const run = control.arm();
    const old = share.beginPendingSharedAttachmentUpload(target, tokenA);
    await vi.waitFor(() => expect(control.status()?.phase).toBe('held'));
    await control.loseSession(run);
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith('fictional-captured-access-token', 'local');
    expect(share.getPendingSharedAttachmentUpload()).toBeNull();
    expect(mocks.files.has(tokenA)).toBe(false);
    expect(mocks.storage.get('union-ground.secure-share-upload-quarantine.v1')).toContain(uploadA);

    signIn(userB, 'fictional-next-access-token');
    await share.preparePendingSharedAttachmentUploadForSessionEstablishment(userB);
    mocks.activeToken = tokenB;
    mocks.files.set(tokenB, 'new exact bytes');
    const newer = await share.readPendingSharedAttachment();
    control.release(run);
    await expect(old.settlement).resolves.toMatchObject({ status: 'failed', attachmentID: uploadA });
    expect(mocks.files.get(tokenB)).toBe('new exact bytes');
    expect(await share.readPendingSharedAttachment()).toEqual(newer);
    expect(mocks.discard).not.toHaveBeenCalledWith(tokenB);

    await share.uploadPendingSharedAttachment(target, tokenB);
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(mocks.upload.mock.calls.map((call: unknown[]) => call[2])).toEqual([
      { fileID: uploadA, writer: expect.objectContaining({ userId: userA }) }, { fileID: uploadB, writer: expect.objectContaining({ userId: userB }) },
    ]);
    expect(mocks.files.size).toBe(0);
    signIn(userA, 'fictional-renewed-access-token');
    await share.preparePendingSharedAttachmentUploadForSessionEstablishment(userA);
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(target, uploadA, { writer: expect.objectContaining({ userId: userA }) });
    expect(mocks.storage.size).toBe(0);
    expect(control.status()).toMatchObject({ phase: 'released', sessionLoss: 'complete' });
    control.reset(run);
    expect(control.status()).toBeNull();
  });

  it('refuses session loss after the held upload owner has changed', async () => {
    const control = host.__unionGroundShareRecoveryTest!;
    const run = control.arm();
    const old = share.beginPendingSharedAttachmentUpload(target, tokenA);
    await vi.waitFor(() => expect(control.status()?.phase).toBe('held'));
    signIn(userB, 'fictional-next-access-token');
    await expect(control.loseSession(run)).rejects.toThrow(/session loss failed/);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(control.status()?.sessionLoss).toBe('failed');
    control.release(run);
    await expect(old.settlement).resolves.toMatchObject({ status: 'failed' });
    expect(mocks.storage.get('union-ground.secure-share-upload.v1')).toContain(uploadA);
  });

  it('revokes only the captured A session if B arrives during the revoke request', async () => {
    mocks.signOut.mockImplementation(async (jwt: string) => {
      mocks.revoked.add(jwt);
      signIn(userB, 'fictional-next-access-token');
      mocks.activeToken = tokenB;
      mocks.files.set(tokenB, 'new exact bytes');
      return { error: null };
    });
    const control = host.__unionGroundShareRecoveryTest!;
    const run = control.arm();
    const old = share.beginPendingSharedAttachmentUpload(target, tokenA);
    await vi.waitFor(() => expect(control.status()?.phase).toBe('held'));
    await expect(control.loseSession(run)).rejects.toThrow(/session loss failed/);
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith('fictional-captured-access-token', 'local');
    expect(localSession()).toEqual({ user: { id: userB }, access_token: 'fictional-next-access-token' });
    expect(mocks.files.get(tokenB)).toBe('new exact bytes');
    expect(mocks.discard).not.toHaveBeenCalledWith(tokenB);
    control.release(run);
    await expect(old.settlement).resolves.toMatchObject({ status: 'failed' });
  });

  it('clears the revoked local session that a failed refresh keeps while its token is unexpired', async () => {
    const control = host.__unionGroundShareRecoveryTest!;
    const run = control.arm();
    const old = share.beginPendingSharedAttachmentUpload(target, tokenA);
    await vi.waitFor(() => expect(control.status()?.phase).toBe('held'));
    const outcome = await control.loseSession(run).then(() => 'complete', () => 'failed');
    expect({ outcome, localSession: localSession(), sessionLoss: control.status()?.sessionLoss })
      .toEqual({ outcome: 'complete', localSession: null, sessionLoss: 'complete' });
    expect(mocks.storage.get('union-ground.secure-share-upload-quarantine.v1')).toContain(uploadA);
    control.release(run);
    await expect(old.settlement).resolves.toMatchObject({ status: 'failed', attachmentID: uploadA });
  });

  it('does not bypass a refused auth sign-out or discard its durable recovery', async () => {
    mocks.signOut.mockResolvedValue({ error: new Error('refused') });
    const control = host.__unionGroundShareRecoveryTest!;
    const run = control.arm();
    const old = share.beginPendingSharedAttachmentUpload(target, tokenA);
    await vi.waitFor(() => expect(control.status()?.phase).toBe('held'));
    await expect(control.loseSession(run)).rejects.toThrow(/session loss failed/);
    expect(share.getPendingSharedAttachmentUpload()).toBe(old);
    expect(mocks.storage.get('union-ground.secure-share-upload.v1')).toContain(uploadA);
    expect(mocks.files.get(tokenA)).toBe('old exact bytes');
    control.release(run);
    await expect(old.settlement).resolves.toMatchObject({ status: 'uploaded' });
  });

  it('refuses to claim session loss when no auth listener quarantined the held upload', async () => {
    mocks.signedOutListener = false;
    const control = host.__unionGroundShareRecoveryTest!;
    const run = control.arm();
    const old = share.beginPendingSharedAttachmentUpload(target, tokenA);
    await vi.waitFor(() => expect(control.status()?.phase).toBe('held'));
    await expect(control.loseSession(run)).rejects.toThrow(/session loss failed/);
    expect(mocks.storage.get('union-ground.secure-share-upload.v1')).toContain(uploadA);
    expect(mocks.storage.has('union-ground.secure-share-upload-quarantine.v1')).toBe(false);
    control.release(run);
    // Auth removed A's session, so the held upload cannot finish as A, and
    // its durable recovery stays for A's next sign-in.
    await expect(old.settlement).resolves.toMatchObject({ status: 'failed', attachmentID: uploadA });
    expect(mocks.storage.get('union-ground.secure-share-upload.v1')).toContain(uploadA);
  });
});
