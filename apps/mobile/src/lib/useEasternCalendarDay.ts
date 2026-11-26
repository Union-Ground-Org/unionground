import { useEffect, useState } from 'react';
import { nextEasternMidnight } from './easternTime';
import { useAppActive } from '../state/useAppActive';

// Native consumers of the shared Home ranking follow the same Eastern day.
// Suspend the timer in the background; the foreground render catches up after
// sleep without treating a 23/25-hour day as an elapsed 24 hours.
export function useEasternCalendarDay(): Date {
  const active = useAppActive();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule(): void {
      clearTimeout(timer);
      const now = new Date();
      timer = setTimeout(refresh, nextEasternMidnight(now).getTime() - now.getTime());
    }
    function refresh(): void {
      setTick((tick) => tick + 1);
      schedule();
    }
    schedule();
    return () => clearTimeout(timer);
  }, [active]);
  return new Date();
}
