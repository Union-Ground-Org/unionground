import * as Crypto from 'expo-crypto';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { SupabaseClient } from '@supabase/supabase-js';

import { sessionIDFromAccessToken } from '../lib/sessionLineage';
import { classifySignOutFailure, SignOutRpcRejectionError, tagSignOutProvenance } from './signOutFailure';
import { getSupabaseClient } from './supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

export type NativePushRegistration = {
  provider: 'apns' | 'fcm';
  environment: 'sandbox' | 'production';
  token: string;
};

export type NativePushState = {
  enabled: boolean;
  registered: boolean;
  provider: NativePushRegistration['provider'] | null;
};

type NativeInstallationRow = {
  installationId: string;
  provider: NativePushRegistration['provider'];
  currentSession: boolean;
};

type NotificationSessionIdentity = {
  userID: string;
  sessionHandle: string;
};

const installationKey = 'org.unionground.app.push.installation';
const enabledKey = 'org.unionground.app.push.enabled';
const ownerKey = 'org.unionground.app.push.owner';
const previewEnabledKey = 'org.unionground.app.push.preview.enabled';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionHandlePattern = /^[0-9a-f]{64}$/i;
const registrationDrainTimeoutMilliseconds = 5_000;
let registrationSuspendDepth = 0;
const activeRegistrationTasks = new Set<Promise<unknown>>();
let registrationTail: Promise<void> = Promise.resolve();
let livePushStateTail: Promise<void> = Promise.resolve();
let deferredNativePushSync = false;
let deferredNativePushToken: Notifications.DevicePushToken | undefined;
let deferredNativePushReplayScheduled = false;

function withLivePushStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const active = livePushStateTail.then(operation, operation);
  livePushStateTail = active.then(() => undefined, () => undefined);
  return active;
}

function registrationSuspended(): boolean {
  return registrationSuspendDepth > 0;
}

async function trackedRegistration<T>(task: (identity: NotificationSessionIdentity) => Promise<T>): Promise<T | null> {
  if (registrationSuspended()) return null;
  // Capture the caller's identity now, while serializing the whole token
  // operation in observation order. An older native lookup or backend write
  // must finish before a newer rotation can become the stored token.
  const identity = currentNotificationIdentity();
  // A predecessor may still be pending when identity verification rejects.
  // Observe that rejection immediately; the queued task still propagates it.
  void identity.catch(() => undefined);
  const activeTask = registrationTail.then(async () => {
    // A sign-out barrier also owns work queued before it was raised.
    if (registrationSuspended()) return null;
    return task(await identity);
  });
  registrationTail = activeTask.then(() => undefined, () => undefined);
  activeRegistrationTasks.add(activeTask);
  try {
    return await activeTask;
  } finally {
    activeRegistrationTasks.delete(activeTask);
  }
}

export async function pauseNativePushRegistration(): Promise<void> {
  // A depth counter makes concurrent owners independent: an Account disable
  // cannot release the sign-out barrier, and a session refresh cannot reopen
  // registration while cleanup is in progress.
  registrationSuspendDepth += 1;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (activeRegistrationTasks.size > 0) {
          await Promise.allSettled([...activeRegistrationTasks]);
        }
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Notification registration did not stop in time.')),
          registrationDrainTimeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function replayDeferredNativePushSyncIfReady(): void {
  if (registrationSuspended() || !deferredNativePushSync || deferredNativePushReplayScheduled) return;
  deferredNativePushReplayScheduled = true;
  // Publish through a microtask so every suppressed caller in the current turn
  // can coalesce onto the latest token before one retry consumes the work.
  void Promise.resolve().then(async () => {
    deferredNativePushReplayScheduled = false;
    if (registrationSuspended() || !deferredNativePushSync) return;
    const token = deferredNativePushToken;
    deferredNativePushSync = false;
    deferredNativePushToken = undefined;
    await syncNativePushRegistration(token);
  }).catch(() => undefined);
}

export function resumeNativePushRegistration(): void {
  const wasSuspended = registrationSuspendDepth > 0;
  registrationSuspendDepth = Math.max(0, registrationSuspendDepth - 1);
  if (!wasSuspended || registrationSuspendDepth > 0) return;
  // A replacement session can become authenticated while an older sign-out
  // owns the barrier. Re-run the suppressed sync once the last owner releases
  // it so that replacement does not stay silently unregistered.
  replayDeferredNativePushSyncIfReady();
}

async function sessionHandleFromAccessToken(accessToken: string): Promise<string> {
  const sessionID = sessionIDFromAccessToken(accessToken);
  if (!sessionID) throw new Error('Union Ground could not verify the notification session.');
  const sessionHandle = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, sessionID);
  if (!sessionHandlePattern.test(sessionHandle)) {
    throw new Error('Union Ground could not verify the notification session.');
  }
  return sessionHandle.toLowerCase();
}

async function capturedNotificationIdentity(
  expectedUserIDValue: string,
  accessToken: string,
): Promise<NotificationSessionIdentity> {
  const userID = expectedUserIDValue.trim().toLowerCase();
  if (!userIdPattern.test(userID)) {
    throw new Error('Union Ground could not verify the notification owner.');
  }
  return { userID, sessionHandle: await sessionHandleFromAccessToken(accessToken) };
}

async function currentNotificationIdentity(): Promise<NotificationSessionIdentity> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const session = sessionData.session;
  const sessionUserID = session?.user?.id?.trim().toLowerCase() ?? '';
  if (sessionError || !session?.access_token || !userIdPattern.test(sessionUserID)) {
    throw new Error('Union Ground could not verify the notification owner.');
  }
  const { data, error } = await supabase.auth.getUser(session.access_token);
  const userID = data.user?.id?.trim().toLowerCase() ?? '';
  if (error || userID !== sessionUserID || !userIdPattern.test(userID)) {
    throw new Error('Union Ground could not verify the notification owner.');
  }
  return {
    userID,
    sessionHandle: await sessionHandleFromAccessToken(session.access_token),
  };
}

async function currentNotificationUserID(): Promise<string> {
  return (await currentNotificationIdentity()).userID;
}

async function assertCurrentNotificationUser(expectedUserID: string): Promise<void> {
  if (await currentNotificationUserID() !== expectedUserID) {
    throw new Error('The secure session changed during notification cleanup.');
  }
}

async function installationID(
  create: boolean,
  expectedUserID: string,
  isCurrent?: () => boolean,
): Promise<string | null> {
  return withLivePushStateLock(async () => {
    if (isCurrent) {
      if (!isCurrent()) throw tagSignOutProvenance(new Error('The secure session changed before notification cleanup.'), 'local');
    } else {
      await assertCurrentNotificationUser(expectedUserID);
    }
    const storedOwner = (await SecureStore.getItemAsync(ownerKey))?.trim().toLowerCase() ?? '';
    if (storedOwner && storedOwner !== expectedUserID) {
      if (!create) return null;
      await SecureStore.deleteItemAsync(enabledKey);
      await SecureStore.deleteItemAsync(installationKey);
    }
    const existing = await SecureStore.getItemAsync(installationKey);
    if (existing && uuidPattern.test(existing)) {
      if (storedOwner !== expectedUserID) {
        await SecureStore.setItemAsync(ownerKey, expectedUserID, {
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        });
      }
      return existing;
    }
    if (!create) return null;
    const created = Crypto.randomUUID();
    await SecureStore.setItemAsync(ownerKey, expectedUserID, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(installationKey, created, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    return created;
  });
}

async function preferenceEnabled(expectedUserID: string): Promise<boolean> {
  return withLivePushStateLock(async () => {
    await assertCurrentNotificationUser(expectedUserID);
    const storedOwner = (await SecureStore.getItemAsync(ownerKey))?.trim().toLowerCase() ?? '';
    if (storedOwner && storedOwner !== expectedUserID) return false;
    return await SecureStore.getItemAsync(enabledKey) === '1';
  });
}

async function savePreference(enabled: boolean, expectedUserID: string): Promise<void> {
  await withLivePushStateLock(async () => {
    await assertCurrentNotificationUser(expectedUserID);
    const storedOwner = (await SecureStore.getItemAsync(ownerKey))?.trim().toLowerCase() ?? '';
    if (storedOwner && storedOwner !== expectedUserID) {
      if (!enabled) return;
      await SecureStore.deleteItemAsync(enabledKey);
      await SecureStore.deleteItemAsync(installationKey);
    }
    if (enabled) {
      await SecureStore.setItemAsync(ownerKey, expectedUserID, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
      await SecureStore.setItemAsync(enabledKey, '1', {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    } else {
      await SecureStore.deleteItemAsync(enabledKey);
    }
  });
}

async function previewPreferenceEnabled(): Promise<boolean> {
  return await SecureStore.getItemAsync(previewEnabledKey) === '1';
}

async function savePreviewPreference(enabled: boolean): Promise<void> {
  if (enabled) {
    await SecureStore.setItemAsync(previewEnabledKey, '1', {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  } else {
    await SecureStore.deleteItemAsync(previewEnabledKey);
  }
}

async function registrationFromToken(token: Notifications.DevicePushToken): Promise<NativePushRegistration> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new Error('Native notifications are available on iPhone and Android phones.');
  }
  if (typeof token.data !== 'string' || token.data.length < 20 || /\s/.test(token.data)) {
    throw new Error('The device notification service returned an unusable token.');
  }
  if (Platform.OS === 'android') {
    return { provider: 'fcm', environment: 'production', token: token.data };
  }
  const apnsEnvironment = await Application.getIosPushNotificationServiceEnvironmentAsync();
  if (apnsEnvironment !== 'development' && apnsEnvironment !== 'production') {
    throw new Error('The Apple notification environment is unavailable. Unlock the phone and try again.');
  }
  return {
    provider: 'apns',
    environment: apnsEnvironment === 'development' ? 'sandbox' : 'production',
    token: token.data,
  };
}

async function registerWithBackend(
  registration: NativePushRegistration,
  expectedIdentity: NotificationSessionIdentity,
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const currentInstallationID = await installationID(true, expectedIdentity.userID);
  // Token acquisition and SecureStore both yield. A sign-out may have raised
  // the barrier in between, so check again immediately before issuing the RPC.
  if (registrationSuspended()) {
    throw new Error('Notification registration is paused while this session is closing.');
  }
  const { data, error } = await supabase.rpc('register_my_native_push_installation', {
    p_installation_id: currentInstallationID,
    p_provider: registration.provider,
    p_environment: registration.environment,
    p_device_token: registration.token,
    p_expected_user_id: expectedIdentity.userID,
    p_expected_session_handle: expectedIdentity.sessionHandle,
  });
  const result = data as { registered?: boolean } | null;
  if (error || result?.registered !== true) {
    throw new Error('Union Ground could not securely register notifications. Try again shortly.');
  }
}

async function deleteFromBackend(options: {
  rpcClient?: Pick<SupabaseClient, 'rpc'>;
  expectedIdentity?: NotificationSessionIdentity;
  isCurrent?: () => boolean;
} = {}): Promise<void> {
  const isCurrent = options.isCurrent ?? (() => true);
  const supabase = options.rpcClient ?? getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const expectedIdentity = options.expectedIdentity ?? await currentNotificationIdentity();
  if (!userIdPattern.test(expectedIdentity.userID)
    || !sessionHandlePattern.test(expectedIdentity.sessionHandle)
    || !isCurrent()) {
    throw tagSignOutProvenance(new Error('The secure session changed before notification cleanup.'), 'local');
  }
  const currentInstallationID = await installationID(
    false,
    expectedIdentity.userID,
    options.isCurrent,
  );
  if (!currentInstallationID) return;
  if (!isCurrent()) throw tagSignOutProvenance(new Error('The secure session changed before notification cleanup.'), 'local');
  const response = await supabase.rpc('delete_my_native_push_installation', {
    p_installation_id: currentInstallationID,
    p_expected_user_id: expectedIdentity.userID,
    p_expected_session_handle: expectedIdentity.sessionHandle,
  });
  // PostgREST also returns an error envelope for a failed fetch (status 0).
  // Preserve that distinction while keeping backend detail out of UI copy.
  if (response.error) {
    throw tagSignOutProvenance(
      new Error('Union Ground could not securely remove this notification registration.'),
      classifySignOutFailure(new SignOutRpcRejectionError(response)),
    );
  }
}

export async function deleteNativePushInstallationForSignOut(
  rpcClient: Pick<SupabaseClient, 'rpc'>,
  expectedUserID: string,
  expectedAccessToken: string,
  isCurrent: () => boolean,
): Promise<void> {
  // This exact installation id survives token rotation and session refreshes.
  // Delete it after the registration barrier drains, before broader session
  // cleanup, so an older-but-still-live session handle cannot orphan the row.
  const expectedIdentity = await capturedNotificationIdentity(expectedUserID, expectedAccessToken);
  if (!isCurrent()) throw tagSignOutProvenance(new Error('The secure session changed before notification cleanup.'), 'local');
  await deleteFromBackend({ rpcClient, expectedIdentity, isCurrent });
}

export async function configureNotificationCategories(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(
    'UNION_UPDATE',
    [{
      identifier: 'OPEN',
      buttonTitle: 'Open Union Ground',
      options: { opensAppToForeground: true, isAuthenticationRequired: true },
    }],
    { previewPlaceholder: 'Union Ground update', showTitle: false, showSubtitle: false },
  );

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('union-updates', {
      name: 'Campaign updates',
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      vibrationPattern: [0, 180],
      enableVibrate: true,
      enableLights: false,
    });
  }
}

export async function requestNativePushRegistration(): Promise<NativePushRegistration> {
  if (!Device.isDevice) throw new Error('Push notifications require a physical device.');
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted
    ? current
    : await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: false },
    });
  if (!permission.granted) throw new Error('Notification permission was not granted.');

  await configureNotificationCategories();
  const result = await Notifications.getDevicePushTokenAsync();
  return await registrationFromToken(result);
}

export async function enableNativePushNotifications(): Promise<NativePushState> {
  const state = await trackedRegistration(async (expectedIdentity) => {
    const registration = await requestNativePushRegistration();
    await registerWithBackend(registration, expectedIdentity);
    await savePreference(true, expectedIdentity.userID);
    return { enabled: true, registered: true, provider: registration.provider } satisfies NativePushState;
  });
  if (!state) throw new Error('Notification registration is paused while this session is closing.');
  return state;
}

export async function disableNativePushNotifications(): Promise<NativePushState> {
  // Server deletion precedes the local preference change. A transient network
  // failure therefore leaves the device visibly enabled and retryable instead
  // of claiming success while a live token remains attached to the member.
  let pauseOwned = true;
  try {
    await pauseNativePushRegistration();
    const expectedIdentity = await currentNotificationIdentity();
    await deleteFromBackend({ expectedIdentity });
    await savePreference(false, expectedIdentity.userID);
    await clearAppBadge();
    return { enabled: false, registered: false, provider: null };
  } finally {
    // Ordinary disable keeps the authenticated app usable. Once the local
    // preference is false, resumed background sync cannot recreate the row.
    if (pauseOwned) {
      resumeNativePushRegistration();
      pauseOwned = false;
    }
  }
}

export async function clearNativePushPreferenceForSignOut(
  expectedUserIDValue: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  // prepare_my_signout removes the server row first. Clearing this flag before
  // Supabase Auth sign-out prevents a later user on the shared phone from
  // inheriting automatic token registration. Removing the installation id as
  // well prevents the audit ledger from linking successive members who use the
  // same shared phone; ordinary disable/re-enable deliberately retains it.
  const expectedUserID = expectedUserIDValue.trim().toLowerCase();
  if (!userIdPattern.test(expectedUserID)) {
    throw new Error('Union Ground could not verify the notification owner.');
  }
  const cleared = await withLivePushStateLock(async () => {
    if (!isCurrent()) throw tagSignOutProvenance(new Error('The secure session changed before notification cleanup.'), 'local');
    const storedOwner = (await SecureStore.getItemAsync(ownerKey))?.trim().toLowerCase() ?? '';
    if (!isCurrent()) throw tagSignOutProvenance(new Error('The secure session changed during notification cleanup.'), 'local');
    if (storedOwner && storedOwner !== expectedUserID) return false;
    await SecureStore.deleteItemAsync(enabledKey);
    await SecureStore.deleteItemAsync(installationKey);
    await SecureStore.deleteItemAsync(ownerKey);
    return true;
  });
  if (cleared && isCurrent()) await clearAppBadge();
}

export async function readNativePushState(): Promise<NativePushState> {
  const expectedIdentity = await currentNotificationIdentity();
  if (!(await preferenceEnabled(expectedIdentity.userID))) return { enabled: false, registered: false, provider: null };
  const currentInstallationID = await installationID(false, expectedIdentity.userID);
  if (!currentInstallationID) return { enabled: true, registered: false, provider: null };
  const supabase = getSupabaseClient();
  if (!supabase) return { enabled: true, registered: false, provider: null };
  const { data, error } = await supabase.rpc('list_my_native_push_installations');
  if (error) throw new Error('Union Ground could not verify this notification registration.');
  const rows = Array.isArray(data) ? data as NativeInstallationRow[] : [];
  const current = rows.find((row) => row.installationId === currentInstallationID && row.currentSession === true);
  return {
    enabled: true,
    registered: Boolean(current),
    provider: current?.provider === 'apns' || current?.provider === 'fcm' ? current.provider : null,
  };
}

export async function syncNativePushRegistration(token?: Notifications.DevicePushToken): Promise<NativePushState> {
  const state = await trackedRegistration(async (expectedIdentity) => {
    if (!(await preferenceEnabled(expectedIdentity.userID))) return { enabled: false, registered: false, provider: null } satisfies NativePushState;
    if (!Device.isDevice) return { enabled: true, registered: false, provider: null } satisfies NativePushState;
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) {
      await deleteFromBackend({ expectedIdentity });
      await savePreference(false, expectedIdentity.userID);
      return { enabled: false, registered: false, provider: null } satisfies NativePushState;
    }
    await configureNotificationCategories();
    const registration = await registrationFromToken(token ?? await Notifications.getDevicePushTokenAsync());
    await registerWithBackend(registration, expectedIdentity);
    return { enabled: true, registered: true, provider: registration.provider } satisfies NativePushState;
  });
  if (state) return state;
  deferredNativePushSync = true;
  deferredNativePushToken = token;
  // The final barrier owner can release after trackedRegistration observes the
  // suspension but before this continuation records its deferred work.
  replayDeferredNativePushSyncIfReady();
  const expectedUserID = await currentNotificationUserID();
  return {
    enabled: await preferenceEnabled(expectedUserID),
    registered: false,
    provider: null,
  };
}

export function startNativePushTokenRotationListener(onFailure: () => void): { remove(): void } {
  return Notifications.addPushTokenListener((token) => {
    void syncNativePushRegistration(token).catch(onFailure);
  });
}

export async function clearAppBadge(): Promise<void> {
  await Notifications.setBadgeCountAsync(0).catch(() => false);
}

// Preview-safe local notification controls: OS permission plus the local
// preference only — no backend registration, so the demo account can exercise
// the full enable/disable/test flow without a live session.
export async function requestLocalNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const next = await Notifications.requestPermissionsAsync();
  return next.granted;
}

export async function setLocalNotificationsEnabled(enabled: boolean): Promise<NativePushState> {
  if (enabled) {
    const granted = await requestLocalNotificationPermission();
    if (!granted) throw new Error('Notification permission was not granted.');
  }
  await savePreviewPreference(enabled);
  if (!enabled) await clearAppBadge();
  return { enabled, registered: false, provider: null };
}

export async function readLocalNotificationState(): Promise<NativePushState> {
  return { enabled: await previewPreferenceEnabled(), registered: false, provider: null };
}

export async function clearLocalNotificationPreference(): Promise<void> {
  await savePreviewPreference(false);
  await clearAppBadge();
}

export async function sendTestNotification(): Promise<boolean> {
  const granted = await requestLocalNotificationPermission();
  if (!granted) return false;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Union Ground test',
      body: 'Notifications are working. Protected worker details never appear in previews.',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 2,
    },
  });
  return true;
}
