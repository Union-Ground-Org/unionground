import { useEffect } from 'react';
import { AppState } from 'react-native';

export const SESSION_CHECK_RETRY_INTERVAL_MS = 30_000;

/** One foreground retry at a time, owned by this exact session render. */
export function useSessionCheckRecovery(enabled: boolean, owner: object | null, retry: () => Promise<boolean>): void {
  useEffect(() => {
    if (!enabled || !owner) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!active || AppState.currentState !== 'active') return;
      timer = setTimeout(() => {
        if (!active || AppState.currentState !== 'active') return;
        void retry().catch(() => false).finally(schedule);
      }, SESSION_CHECK_RETRY_INTERVAL_MS);
    };
    const subscription = AppState.addEventListener('change', schedule);
    schedule();
    return () => { active = false; clearTimeout(timer); subscription.remove(); };
  }, [enabled, owner, retry]);
}
