import * as ScreenCapture from 'expo-screen-capture';
import { AppState, Platform, type AppStateStatus } from 'react-native';

const authenticatedSessionKey = 'authenticated-session';
let protectionTransition: Promise<unknown> = Promise.resolve();

function enqueueProtectionTransition<T>(operation: () => Promise<T>): Promise<T> {
  const next = protectionTransition.catch(() => undefined).then(operation);
  protectionTransition = next.then(() => undefined, () => undefined);
  return next;
}

export async function enableAuthenticatedScreenProtection(): Promise<boolean> {
  return enqueueProtectionTransition(async () => {
    if (!await ScreenCapture.isAvailableAsync()) return false;

    await ScreenCapture.preventScreenCaptureAsync(authenticatedSessionKey);
    if (Platform.OS === 'ios') {
      await ScreenCapture.enableAppSwitcherProtectionAsync(1);
    }
    return true;
  });
}

export async function disableAuthenticatedScreenProtection(): Promise<void> {
  return enqueueProtectionTransition(async () => {
    const operations: Promise<void>[] = [
      ScreenCapture.allowScreenCaptureAsync(authenticatedSessionKey),
    ];
    if (Platform.OS === 'ios') {
      operations.push(ScreenCapture.disableAppSwitcherProtectionAsync());
    }

    const results = await Promise.allSettled(operations);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  });
}

export function startAuthenticatedScreenProtection(): () => void {
  let disposed = false;
  let retryUsed = false;
  let retrySubscription: ReturnType<typeof AppState.addEventListener> | null = null;

  const scheduleRetry = () => {
    if (disposed || retryUsed || retrySubscription) return;
    retrySubscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (disposed || nextState !== 'active') return;
      retryUsed = true;
      retrySubscription?.remove();
      retrySubscription = null;
      void enableAuthenticatedScreenProtection().catch(() => undefined);
    });
  };

  void enableAuthenticatedScreenProtection().then((enabled) => {
    if (!enabled) scheduleRetry();
  }, scheduleRetry);

  return () => {
    disposed = true;
    retrySubscription?.remove();
    retrySubscription = null;
    void disableAuthenticatedScreenProtection().catch(() => undefined);
  };
}
