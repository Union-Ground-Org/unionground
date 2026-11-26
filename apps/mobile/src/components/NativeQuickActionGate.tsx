import { usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import {
  addNativeQuickActionListener,
  consumePendingNativeQuickAction,
  createNativeQuickActionDrain,
  nativeQuickActionCanConsume,
} from '../services/nativeQuickActions';
import { nativeQuickActionGatePath } from '../services/nativeQuickActionRoutes';
import { useApp } from '../state/AppProvider';

export function NativeQuickActionGate() {
  const router = useRouter();
  const pathname = usePathname();
  const { locked, mode, privacyCovered } = useApp();
  const routerRef = useRef(router);
  routerRef.current = router;
  const drainRef = useRef<ReturnType<typeof createNativeQuickActionDrain> | null>(null);

  if (!drainRef.current) {
    drainRef.current = createNativeQuickActionDrain(
      consumePendingNativeQuickAction,
      (identifier) => {
        const path = nativeQuickActionGatePath(identifier);
        if (path) routerRef.current.push(path as never);
      },
    );
  }

  const consume = useCallback(async () => {
    if (!nativeQuickActionCanConsume({ mode, locked, privacyCovered, pathname })) return;
    await drainRef.current?.();
  }, [locked, mode, pathname, privacyCovered]);

  useEffect(() => {
    void consume();
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void consume();
    });
    const nativeSubscription = addNativeQuickActionListener(() => {
      void consume();
    });
    return () => {
      appStateSubscription.remove();
      nativeSubscription?.remove();
    };
  }, [consume]);

  return null;
}
