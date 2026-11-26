import NativeQuickActionsModule from '../../modules/native-quick-actions/src/NativeQuickActionsModule';
import { parseNativeQuickActionID, type NativeQuickActionID } from './nativeQuickActionRoutes';

type QuickActionSubscription = { remove(): void };

type NativeQuickActionConsumer = () => Promise<NativeQuickActionID | null>;
type NativeQuickActionRouter = (identifier: NativeQuickActionID) => void;

// `/` is the index Redirect shell. On a cold launch its Redirect to Home is a
// focus effect that can fire after a quick action was pushed, and replace swaps
// whatever is on top, so the action landed on Home (#6482). Wait until the root
// has left the shell; the pending identifier stays staged natively until then.
export function nativeQuickActionCanConsume(state: {
  mode: 'booting' | 'signedOut' | 'mfaRequired' | 'authenticated' | 'preview';
  locked: boolean;
  privacyCovered: boolean;
  pathname: string;
}): boolean {
  return state.mode !== 'booting' && !state.locked && !state.privacyCovered && state.pathname !== '/';
}

export async function consumePendingNativeQuickAction(): Promise<NativeQuickActionID | null> {
  if (!NativeQuickActionsModule) return null;
  try {
    return parseNativeQuickActionID(await NativeQuickActionsModule.consumePendingAsync());
  } catch {
    return null;
  }
}

export function addNativeQuickActionListener(listener: () => void): QuickActionSubscription | null {
  return NativeQuickActionsModule?.addListener('onQuickAction', listener) ?? null;
}

// Native staging is destructive: consumePendingAsync clears the one pending
// identifier before it resolves. Serialize overlapping lifecycle/listener
// requests so a later null result can never cancel an earlier valid action.
export function createNativeQuickActionDrain(
  consume: NativeQuickActionConsumer,
  route: NativeQuickActionRouter,
): () => Promise<void> {
  let running = false;
  let rerunRequested = false;

  return async function drain(): Promise<void> {
    if (running) {
      rerunRequested = true;
      return;
    }

    running = true;
    try {
      do {
        rerunRequested = false;
        const identifier = await consume();
        if (identifier) route(identifier);
      } while (rerunRequested);
    } finally {
      running = false;
    }
  };
}
