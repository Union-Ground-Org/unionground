import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  records: new Map<string, string>(),
  platform: { OS: 'ios' },
  isDevice: true,
  randomUUID: vi.fn(() => '2a2e0fab-98a1-4d60-a07f-a7283c85d532'),
  digestString: vi.fn(),
  apnsEnvironment: vi.fn(),
  getPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  getDevicePushToken: vi.fn(),
  setCategory: vi.fn(),
  setChannel: vi.fn(),
  setBadge: vi.fn(),
  addPushTokenListener: vi.fn(),
  rpc: vi.fn(),
  getSession: vi.fn(),
  getUser: vi.fn(),
  secureGet: vi.fn(),
  secureSet: vi.fn(),
  secureDelete: vi.fn(),
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: mocks.digestString,
  randomUUID: mocks.randomUUID,
}));
vi.mock('expo-application', () => ({
  getIosPushNotificationServiceEnvironmentAsync: mocks.apnsEnvironment,
}));
vi.mock('expo-device', () => ({
  get isDevice() { return mocks.isDevice; },
}));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: mocks.secureGet,
  setItemAsync: mocks.secureSet,
  deleteItemAsync: mocks.secureDelete,
}));
vi.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: mocks.getPermissions,
  requestPermissionsAsync: mocks.requestPermissions,
  getDevicePushTokenAsync: mocks.getDevicePushToken,
  setNotificationCategoryAsync: mocks.setCategory,
  setNotificationChannelAsync: mocks.setChannel,
  setBadgeCountAsync: mocks.setBadge,
  addPushTokenListener: mocks.addPushTokenListener,
}));
vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('./supabase', () => ({
  getSupabaseClient: () => ({
    rpc: mocks.rpc,
    auth: { getSession: mocks.getSession, getUser: mocks.getUser },
  }),
}));

import {
  disableNativePushNotifications,
  deleteNativePushInstallationForSignOut,
  enableNativePushNotifications,
  clearNativePushPreferenceForSignOut,
  clearLocalNotificationPreference,
  pauseNativePushRegistration,
  readNativePushState,
  readLocalNotificationState,
  resumeNativePushRegistration,
  startNativePushTokenRotationListener,
  syncNativePushRegistration,
  setLocalNotificationsEnabled,
} from './notifications';
import { classifySignOutFailure } from './signOutFailure';

const installationKey = 'org.unionground.app.push.installation';
const enabledKey = 'org.unionground.app.push.enabled';
const ownerKey = 'org.unionground.app.push.owner';
const previewEnabledKey = 'org.unionground.app.push.preview.enabled';
const firstToken = 'a'.repeat(64);
const rotatedToken = 'b'.repeat(64);
const userID = '5d93f19d-7d7c-4eeb-95ee-3149f295f489';
const sessionID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionHandle = 'f'.repeat(64);
const accessToken = `header.${btoa(JSON.stringify({ session_id: sessionID }))}.signature`;

function flushPromises(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

describe('native notification token lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.records.clear();
    mocks.secureGet.mockImplementation(async (key: string) => mocks.records.get(key) ?? null);
    mocks.secureSet.mockImplementation(async (key: string, value: string) => { mocks.records.set(key, value); });
    mocks.secureDelete.mockImplementation(async (key: string) => { mocks.records.delete(key); });
    mocks.platform.OS = 'ios';
    mocks.isDevice = true;
    mocks.apnsEnvironment.mockResolvedValue('development');
    mocks.getPermissions.mockResolvedValue({ granted: true });
    mocks.requestPermissions.mockResolvedValue({ granted: true });
    mocks.getDevicePushToken.mockResolvedValue({ type: 'ios', data: firstToken });
    mocks.setCategory.mockResolvedValue(undefined);
    mocks.setChannel.mockResolvedValue(undefined);
    mocks.setBadge.mockResolvedValue(true);
    mocks.addPushTokenListener.mockReturnValue({ remove: vi.fn() });
    mocks.digestString.mockResolvedValue(sessionHandle);
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: accessToken,
          refresh_token: 'refresh-token',
          user: { id: userID },
        },
      },
      error: null,
    });
    mocks.getUser.mockResolvedValue({ data: { user: { id: userID } }, error: null });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'register_my_native_push_installation') return { data: { registered: true }, error: null };
      if (name === 'delete_my_native_push_installation') return { data: { deleted: true }, error: null };
      if (name === 'list_my_native_push_installations') return { data: [], error: null };
      throw new Error(`unexpected RPC ${name}`);
    });
    resumeNativePushRegistration();
  });

  it('binds an iOS development-build token to APNs sandbox and stores only device preferences locally', async () => {
    await expect(enableNativePushNotifications()).resolves.toEqual({
      enabled: true,
      registered: true,
      provider: 'apns',
    });

    expect(mocks.rpc).toHaveBeenCalledWith('register_my_native_push_installation', {
      p_installation_id: '2a2e0fab-98a1-4d60-a07f-a7283c85d532',
      p_provider: 'apns',
      p_environment: 'sandbox',
      p_device_token: firstToken,
      p_expected_user_id: userID,
      p_expected_session_handle: sessionHandle,
    });
    expect(mocks.records.get(enabledKey)).toBe('1');
    expect(mocks.records.get(installationKey)).toBe('2a2e0fab-98a1-4d60-a07f-a7283c85d532');
    expect([...mocks.records.values()]).not.toContain(firstToken);
  });

  it('maps Android to FCM production without asking an iOS-only native API', async () => {
    mocks.platform.OS = 'android';
    mocks.getDevicePushToken.mockResolvedValue({ type: 'android', data: 'fcm-' + 'x'.repeat(48) });

    await enableNativePushNotifications();

    expect(mocks.apnsEnvironment).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith('register_my_native_push_installation', expect.objectContaining({
      p_provider: 'fcm',
      p_environment: 'production',
    }));
  });

  it('keeps the local opt-in enabled when server deletion fails', async () => {
    mocks.records.set(enabledKey, '1');
    mocks.records.set(installationKey, '2a2e0fab-98a1-4d60-a07f-a7283c85d532');
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });

    await expect(disableNativePushNotifications()).rejects.toThrow('could not securely remove');
    expect(mocks.records.get(enabledKey)).toBe('1');
    expect(mocks.setBadge).not.toHaveBeenCalled();
  });

  it('breaks cross-member device correlation only after server-confirmed sign-out cleanup', async () => {
    mocks.records.set(ownerKey, userID);
    mocks.records.set(enabledKey, '1');
    mocks.records.set(installationKey, '2a2e0fab-98a1-4d60-a07f-a7283c85d532');

    await clearNativePushPreferenceForSignOut(userID);

    expect(mocks.records.has(ownerKey)).toBe(false);
    expect(mocks.records.has(enabledKey)).toBe(false);
    expect(mocks.records.has(installationKey)).toBe(false);
    expect(mocks.setBadge).toHaveBeenCalledWith(0);
  });

  it('refuses to clear live push state without an exact expected owner', async () => {
    mocks.records.set(ownerKey, userID);
    mocks.records.set(enabledKey, '1');
    mocks.records.set(installationKey, '2a2e0fab-98a1-4d60-a07f-a7283c85d532');

    await expect(clearNativePushPreferenceForSignOut('')).rejects.toThrow('notification owner');

    expect(mocks.records.get(ownerKey)).toBe(userID);
    expect(mocks.records.get(enabledKey)).toBe('1');
    expect(mocks.records.get(installationKey)).toBe('2a2e0fab-98a1-4d60-a07f-a7283c85d532');
  });

  it('serializes account replacement so stale signout cleanup cannot delete the new owner state', async () => {
    const nextUserID = '818f6a20-3c7d-48a5-9a65-d66ed8434761';
    const nextSessionID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const nextAccessToken = `header.${btoa(JSON.stringify({ session_id: nextSessionID }))}.signature`;
    const nextSessionHandle = 'e'.repeat(64);
    mocks.records.set(ownerKey, userID);
    mocks.records.set(enabledKey, '1');
    mocks.records.set(installationKey, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    let releaseFirstDelete!: () => void;
    const firstDeletePending = new Promise<void>((resolve) => { releaseFirstDelete = resolve; });
    mocks.secureDelete.mockImplementationOnce(async (key: string) => {
      await firstDeletePending;
      mocks.records.delete(key);
    });
    let signOutCurrent = true;

    const staleCleanup = clearNativePushPreferenceForSignOut(userID, () => signOutCurrent);
    await vi.waitFor(() => expect(mocks.secureDelete).toHaveBeenCalledWith(enabledKey));
    signOutCurrent = false;
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: nextAccessToken,
          refresh_token: 'next-refresh-token',
          user: { id: nextUserID },
        },
      },
      error: null,
    });
    mocks.getUser.mockResolvedValue({ data: { user: { id: nextUserID } }, error: null });
    mocks.digestString.mockResolvedValue(nextSessionHandle);
    const replacementEnable = enableNativePushNotifications();
    releaseFirstDelete();

    await expect(staleCleanup).resolves.toBeUndefined();
    await expect(replacementEnable).resolves.toMatchObject({ enabled: true, registered: true });
    expect(mocks.records.get(ownerKey)).toBe(nextUserID);
    expect(mocks.records.get(enabledKey)).toBe('1');
    expect(mocks.records.get(installationKey)).toBe('2a2e0fab-98a1-4d60-a07f-a7283c85d532');
  });

  it('preserves replacement state by owner even if a stale signout guard still returns true', async () => {
    const nextUserID = '818f6a20-3c7d-48a5-9a65-d66ed8434761';
    const nextInstallationID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    mocks.records.set(ownerKey, nextUserID);
    mocks.records.set(enabledKey, '1');
    mocks.records.set(installationKey, nextInstallationID);

    await clearNativePushPreferenceForSignOut(userID, () => true);

    expect(mocks.records.get(ownerKey)).toBe(nextUserID);
    expect(mocks.records.get(enabledKey)).toBe('1');
    expect(mocks.records.get(installationKey)).toBe(nextInstallationID);
    expect(mocks.secureDelete).not.toHaveBeenCalled();
  });

  it('preserves live preference state when the session changes during the owner read', async () => {
    mocks.records.set(ownerKey, userID);
    mocks.records.set(enabledKey, '1');
    mocks.records.set(installationKey, '2a2e0fab-98a1-4d60-a07f-a7283c85d532');
    let current = true;
    mocks.secureGet.mockImplementationOnce(async (key: string) => { current = false; return mocks.records.get(key) ?? null; });
    await expect(clearNativePushPreferenceForSignOut(userID, () => current)).rejects.toThrow('session changed');
    expect(mocks.records.get(ownerKey)).toBe(userID);
    expect(mocks.records.get(enabledKey)).toBe('1');
    expect(mocks.secureDelete).not.toHaveBeenCalled();
    expect(mocks.setBadge).not.toHaveBeenCalled();
  });

  it('uses the captured-session RPC client for sign-out deletion', async () => {
    const capturedRpc = vi.fn().mockResolvedValue({ data: { deleted: true }, error: null });
    mocks.records.set(installationKey, '2a2e0fab-98a1-4d60-a07f-a7283c85d532');

    await deleteNativePushInstallationForSignOut({ rpc: capturedRpc }, userID, accessToken, () => true);

    expect(capturedRpc).toHaveBeenCalledWith('delete_my_native_push_installation', {
      p_installation_id: '2a2e0fab-98a1-4d60-a07f-a7283c85d532',
      p_expected_user_id: userID,
      p_expected_session_handle: sessionHandle,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('does not issue sign-out deletion after the captured session changes during SecureStore access', async () => {
    mocks.records.set(installationKey, '2a2e0fab-98a1-4d60-a07f-a7283c85d532');
    const capturedRpc = vi.fn();
    let current = true;

    const deletion = deleteNativePushInstallationForSignOut(
      { rpc: capturedRpc },
      userID,
      accessToken,
      () => current,
    );
    current = false;

    await expect(deletion).rejects.toThrow('session changed');
    expect(capturedRpc).not.toHaveBeenCalled();
  });

  it('keeps a failed push-deletion transport distinguishable from a service reply', async () => {
    mocks.records.set(installationKey, '2a2e0fab-98a1-4d60-a07f-a7283c85d532');
    const capturedRpc = vi.fn().mockResolvedValue({ data: null, error: { code: '', message: 'Network request failed' }, status: 0 });
    const error = await deleteNativePushInstallationForSignOut(
      { rpc: capturedRpc }, userID, accessToken, () => true,
    ).catch((error: unknown) => error);
    expect(classifySignOutFailure(error)).toBe('transport');
  });

  it('preserves the RPC rejection provenance so sign-out names a service problem', async () => {
    // Round-2 Codex review, P2-1: the plain-Error rethrow discarded the RPC
    // code/status, so a genuine service rejection during sign-out was classified
    // transport and the member was wrongly told to reconnect. The failing
    // operation now tags its own provenance, and it survives the rethrow
    // regardless of the code the service issued.
    mocks.records.set(installationKey, '2a2e0fab-98a1-4d60-a07f-a7283c85d532');
    const capturedRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'row is locked', code: '55P03', details: null, hint: null },
    });

    const captured = await deleteNativePushInstallationForSignOut(
      { rpc: capturedRpc },
      userID,
      accessToken,
      () => true,
    ).catch((error: unknown) => error);

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain('could not securely remove');
    expect(classifySignOutFailure(captured)).toBe('service');
    // A local session-changed abort on the same path stays local, not service.
    const localAbort = new Error('The secure session changed before notification cleanup.');
    expect(classifySignOutFailure(localAbort)).not.toBe('service');
  });

  it('deletes the backend binding and local opt-in when permission was revoked', async () => {
    mocks.records.set(enabledKey, '1');
    mocks.records.set(installationKey, '2a2e0fab-98a1-4d60-a07f-a7283c85d532');
    mocks.getPermissions.mockResolvedValue({ granted: false });

    await expect(syncNativePushRegistration()).resolves.toEqual({
      enabled: false,
      registered: false,
      provider: null,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('delete_my_native_push_installation', {
      p_installation_id: '2a2e0fab-98a1-4d60-a07f-a7283c85d532',
      p_expected_user_id: userID,
      p_expected_session_handle: sessionHandle,
    });
    expect(mocks.records.has(enabledKey)).toBe(false);
    expect(mocks.getDevicePushToken).not.toHaveBeenCalled();
  });

  it('registers the token supplied by the rotation listener without re-requesting it', async () => {
    mocks.records.set(enabledKey, '1');
    const onFailure = vi.fn();
    startNativePushTokenRotationListener(onFailure);
    const listener = mocks.addPushTokenListener.mock.calls[0]?.[0] as ((token: { type: string; data: string }) => void);

    listener({ type: 'ios', data: rotatedToken });
    await flushPromises();

    expect(mocks.getDevicePushToken).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith('register_my_native_push_installation', expect.objectContaining({
      p_device_token: rotatedToken,
      p_environment: 'sandbox',
    }));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('drains an in-flight registration and blocks later registration before sign-out cleanup', async () => {
    mocks.records.set(enabledKey, '1');
    let releaseRegistration!: () => void;
    const registrationPending = new Promise<void>((resolve) => { releaseRegistration = resolve; });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'register_my_native_push_installation') {
        await registrationPending;
        return { data: { registered: true }, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });

    const sync = syncNativePushRegistration();
    await flushPromises();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    let pauseFinished = false;
    const pause = pauseNativePushRegistration().then(() => { pauseFinished = true; });
    await flushPromises();
    expect(pauseFinished).toBe(false);

    releaseRegistration();
    await Promise.all([sync, pause]);
    expect(pauseFinished).toBe(true);

    await expect(syncNativePushRegistration()).resolves.toEqual({
      enabled: true,
      registered: false,
      provider: null,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    resumeNativePushRegistration();
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
  });

  it('keeps the newest rotated token when an older backend registration finishes late', async () => {
    mocks.records.set(enabledKey, '1');
    let releaseOld!: () => void;
    const oldPending = new Promise<void>((resolve) => { releaseOld = resolve; });
    let backendToken = '';
    mocks.rpc.mockImplementation(async (_name: string, params: { p_device_token: string }) => {
      if (params.p_device_token === firstToken) await oldPending;
      backendToken = params.p_device_token;
      return { data: { registered: true }, error: null };
    });
    const older = syncNativePushRegistration({ type: 'ios', data: firstToken });
    await flushPromises();
    const newer = syncNativePushRegistration({ type: 'ios', data: rotatedToken });
    await flushPromises();
    releaseOld();
    await Promise.all([older, newer]);
    expect(backendToken).toBe(rotatedToken);
  });

  it('preserves rotation order when earlier native token preparation is delayed', async () => {
    mocks.records.set(enabledKey, '1');
    let releaseEnvironment!: () => void;
    mocks.apnsEnvironment.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseEnvironment = resolve; });
      return 'production';
    });
    let backendToken = '';
    mocks.rpc.mockImplementation(async (_name: string, params: { p_device_token: string }) => {
      backendToken = params.p_device_token;
      return { data: { registered: true }, error: null };
    });
    const older = syncNativePushRegistration({ type: 'ios', data: firstToken });
    await flushPromises();
    const newer = syncNativePushRegistration({ type: 'ios', data: rotatedToken });
    await flushPromises();
    releaseEnvironment();
    await Promise.all([older, newer]);
    expect(backendToken).toBe(rotatedToken);
  });

  it('continues with the newest token after an earlier registration fails', async () => {
    mocks.records.set(enabledKey, '1');
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'temporarily unavailable' } });
    const older = syncNativePushRegistration({ type: 'ios', data: firstToken });
    const olderResult = expect(older).rejects.toThrow('could not securely register');
    const newer = syncNativePushRegistration({ type: 'ios', data: rotatedToken });
    await olderResult;
    await expect(newer).resolves.toMatchObject({ registered: true });
    expect(mocks.rpc).toHaveBeenLastCalledWith('register_my_native_push_installation', expect.objectContaining({ p_device_token: rotatedToken }));
  });

  it('holds a queued rotation behind sign-out and replays it only after the barrier releases', async () => {
    mocks.records.set(enabledKey, '1');
    let releaseOld!: () => void;
    const oldPending = new Promise<void>((resolve) => { releaseOld = resolve; });
    mocks.rpc.mockImplementation(async (_name: string, params: { p_device_token: string }) => {
      if (params.p_device_token === firstToken) await oldPending;
      return { data: { registered: true }, error: null };
    });
    const older = syncNativePushRegistration({ type: 'ios', data: firstToken });
    await flushPromises();
    const newer = syncNativePushRegistration({ type: 'ios', data: rotatedToken });
    const pause = pauseNativePushRegistration();
    releaseOld();
    await Promise.all([older, pause]);
    await expect(newer).resolves.toMatchObject({ registered: false });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    resumeNativePushRegistration();
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    expect(mocks.rpc).toHaveBeenLastCalledWith('register_my_native_push_installation', expect.objectContaining({ p_device_token: rotatedToken }));
  });

  it('never adopts a replacement account for a registration that was queued earlier', async () => {
    mocks.records.set(enabledKey, '1');
    let releaseOld!: () => void;
    const oldPending = new Promise<void>((resolve) => { releaseOld = resolve; });
    mocks.rpc.mockImplementationOnce(async () => {
      await oldPending;
      return { data: { registered: true }, error: null };
    });
    const older = syncNativePushRegistration({ type: 'ios', data: firstToken });
    await flushPromises();
    const queued = syncNativePushRegistration({ type: 'ios', data: rotatedToken });
    const queuedResult = expect(queued).rejects.toThrow('secure session changed');
    await flushPromises();
    const replacementUser = '22222222-2222-4222-8222-222222222222';
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: accessToken, user: { id: replacementUser } } }, error: null });
    mocks.getUser.mockResolvedValue({ data: { user: { id: replacementUser } }, error: null });
    releaseOld();
    await older;
    await queuedResult;
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('keeps registration suspended until every overlapping owner releases it', async () => {
    mocks.records.set(enabledKey, '1');

    await pauseNativePushRegistration();
    await pauseNativePushRegistration();
    resumeNativePushRegistration();

    await expect(syncNativePushRegistration()).resolves.toEqual({
      enabled: true,
      registered: false,
      provider: null,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();

    resumeNativePushRegistration();
    await flushPromises();
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('replays a suppressed sync even when the final owner releases before deferral is recorded', async () => {
    mocks.records.set(enabledKey, '1');

    await pauseNativePushRegistration();
    const suppressed = syncNativePushRegistration({ type: 'ios', data: rotatedToken });
    // syncNativePushRegistration has observed the barrier, but its first await
    // has not yet resumed to publish the deferred work item.
    resumeNativePushRegistration();

    await expect(suppressed).resolves.toMatchObject({ enabled: true, registered: false });
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    expect(mocks.rpc).toHaveBeenCalledWith(
      'register_my_native_push_installation',
      expect.objectContaining({ p_device_token: rotatedToken }),
    );
  });

  it('coalesces overlapping suppressed syncs onto the latest provider token', async () => {
    mocks.records.set(enabledKey, '1');

    await pauseNativePushRegistration();
    await Promise.all([
      syncNativePushRegistration({ type: 'ios', data: firstToken }),
      syncNativePushRegistration({ type: 'ios', data: rotatedToken }),
    ]);
    expect(mocks.rpc).not.toHaveBeenCalled();

    resumeNativePushRegistration();
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    expect(mocks.rpc).toHaveBeenCalledWith(
      'register_my_native_push_installation',
      expect.objectContaining({ p_device_token: rotatedToken }),
    );
  });

  it('rechecks the barrier after token acquisition before issuing a registration RPC', async () => {
    mocks.records.set(enabledKey, '1');
    let releaseToken!: () => void;
    mocks.getDevicePushToken.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseToken = resolve; });
      return { type: 'ios', data: firstToken };
    });

    const sync = syncNativePushRegistration();
    await flushPromises();
    const pause = pauseNativePushRegistration();
    releaseToken();

    await expect(sync).rejects.toThrow('paused while this session is closing');
    await expect(pause).resolves.toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
    resumeNativePushRegistration();
  });

  it('bounds a drain whose already-issued backend request never settles', async () => {
    vi.useFakeTimers();
    mocks.records.set(enabledKey, '1');
    let releaseRegistration!: () => void;
    mocks.rpc.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseRegistration = resolve; });
      return { data: { registered: true }, error: null };
    });

    const sync = syncNativePushRegistration();
    await vi.advanceTimersByTimeAsync(0);
    const pause = pauseNativePushRegistration();
    const pauseResult = expect(pause).rejects.toThrow('did not stop in time');
    await vi.advanceTimersByTimeAsync(5_000);
    await pauseResult;

    resumeNativePushRegistration();
    releaseRegistration();
    await expect(sync).resolves.toMatchObject({ registered: true });
    vi.useRealTimers();
  });

  it('reads only server metadata and never exposes the raw provider token in UI state', async () => {
    mocks.records.set(enabledKey, '1');
    mocks.records.set(installationKey, '2a2e0fab-98a1-4d60-a07f-a7283c85d532');
    mocks.rpc.mockResolvedValueOnce({
      data: [{
        installationId: '2a2e0fab-98a1-4d60-a07f-a7283c85d532',
        provider: 'apns',
        environment: 'sandbox',
        currentSession: true,
        tokenFingerprint: 'aaaaaaaaaaaa',
      }],
      error: null,
    });

    const state = await readNativePushState();
    expect(state).toEqual({ enabled: true, registered: true, provider: 'apns' });
    expect(JSON.stringify(state)).not.toMatch(/token|fingerprint/i);
  });

  it('keeps preview notification consent isolated from live registration consent', async () => {
    mocks.records.set(enabledKey, '1');

    await setLocalNotificationsEnabled(false);
    expect(mocks.records.get(enabledKey)).toBe('1');
    expect(mocks.records.has(previewEnabledKey)).toBe(false);

    await setLocalNotificationsEnabled(true);
    expect(mocks.records.get(previewEnabledKey)).toBe('1');
    await expect(readLocalNotificationState()).resolves.toEqual({
      enabled: true,
      registered: false,
      provider: null,
    });
    await expect(readNativePushState()).resolves.toMatchObject({ enabled: true });

    await clearLocalNotificationPreference();
    expect(mocks.records.has(previewEnabledKey)).toBe(false);
    expect(mocks.records.get(enabledKey)).toBe('1');
  });
});
