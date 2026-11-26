import { usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  discardAllPendingSharedAttachments,
  isSecureShareStagingCleanupRequired,
  readPendingSharedAttachment,
  retryPendingSharedAttachmentCleanup,
  subscribeSecureShareStagingCleanup,
} from '../services/secureShareIntake';
import { useApp } from '../state/AppProvider';

export function SecureShareIntakeGate() {
  const router = useRouter();
  const pathname = usePathname();
  const { locked, mode, privacyCovered, session } = useApp();
  const checkSequence = useRef(0);
  const observedUserID = useRef<string | null>(null);
  const routedToken = useRef<string | null>(null);
  const [cleanupRequired, setCleanupRequired] = useState(isSecureShareStagingCleanupRequired());

  useEffect(() => subscribeSecureShareStagingCleanup(setCleanupRequired), []);

  const check = useCallback(async () => {
    const sequence = ++checkSequence.current;
    const checkStillCurrent = () => sequence === checkSequence.current;
    if (cleanupRequired) {
      try {
        await retryPendingSharedAttachmentCleanup(checkStillCurrent);
      } catch {
        return;
      }
      // The cleanup latch publishes a new render. End this captured check so
      // it cannot continue into a different auth identity after the await.
      return;
    }
    if (mode === 'preview' || mode === 'signedOut') {
      observedUserID.current = null;
      routedToken.current = null;
      try {
        await discardAllPendingSharedAttachments(checkStillCurrent);
      } catch {
        // Retry on the next root lifecycle check. Never route while cleanup is unconfirmed.
      }
      return;
    }
    const userID = mode === 'authenticated' ? session?.user.id ?? null : null;
    if (!userID || locked || privacyCovered || pathname === '/share-intake') return;
    if (observedUserID.current && observedUserID.current !== userID) {
      observedUserID.current = userID;
      routedToken.current = null;
    }
    observedUserID.current = userID;
    try {
      const pending = await readPendingSharedAttachment();
      if (sequence !== checkSequence.current) return;
      if (!pending || routedToken.current === pending.token) return;
      routedToken.current = pending.token;
      router.push('/share-intake' as never);
    } catch {
      // The service retains only an exact failed-cleanup token. Never surface
      // provider metadata from an unactionable OS handoff.
    }
  }, [cleanupRequired, locked, mode, pathname, privacyCovered, router, session?.user.id]);

  useEffect(() => {
    void check();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
    });
    return () => subscription.remove();
  }, [check]);

  return null;
}
