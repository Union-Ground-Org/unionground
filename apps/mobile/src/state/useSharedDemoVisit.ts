import { useMemo, useState } from 'react';
import type { HatKey } from '../lib/hatFunctions';
import type { AppMode } from './AppProvider';

type Visit = {
  owner: { userID: string; hat: HatKey };
  dismissed: readonly string[];
};

// Lives in AppProvider so Home route and dashboard remounts cannot erase a
// visitor's read marks. This state is only for Home and Messages presentation.
export function useSharedDemoVisit(mode: AppMode, userID: string | undefined, sampleHat: HatKey | null) {
  const [visit, setVisit] = useState<Visit | null>(null);
  // A challenge or an unavailable assurance check can pause the same visit.
  const awaitingAuthentication = mode === 'booting' || mode === 'mfaRequired';
  let current = visit;
  if (mode === 'authenticated' && userID && sampleHat) {
    if (visit?.owner.userID !== userID || visit.owner.hat !== sampleHat) {
      current = { owner: { userID, hat: sampleHat }, dismissed: [] };
    }
  } else if (!awaitingAuthentication || visit?.owner.userID !== userID) {
    current = null;
  }
  if (current !== visit) setVisit(current);

  return useMemo(() => {
    if (!current) return null;
    const { owner, dismissed } = current;
    return {
      key: JSON.stringify([owner.userID, owner.hat]),
      dismissed,
      dismiss(key: string) {
        setVisit((latest) => {
          // An old press cannot carry a mark into another visit, even when
          // the same person signs in again.
          if (latest?.owner !== owner || latest.dismissed.includes(key)) return latest;
          return { owner, dismissed: [...latest.dismissed, key] };
        });
      },
    };
  }, [current]);
}
