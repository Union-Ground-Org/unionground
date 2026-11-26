import { useEffect, useState } from "react";
import { nextEasternMidnight } from "./easternCalendar.js";

// Refresh date-based UI at the viewer's next midnight, including 23/25-hour
// DST days. Focus/visibility also catch up after sleep or a clock change.
function useCalendarDay(nextMidnight) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let timer;
    function schedule() {
      clearTimeout(timer);
      const now = new Date();
      const midnight = nextMidnight(now);
      timer = setTimeout(refresh, midnight.getTime() - now.getTime());
    }
    function refresh() {
      setTick((tick) => tick + 1);
      schedule();
    }
    function onVisible() {
      if (document.visibilityState === "visible") refresh();
    }
    schedule();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [nextMidnight]);
  // Read again on ordinary renders too: a cached server day count is not a
  // current calendar date, and a render may follow a system-clock change.
  return new Date();
}

export function useEasternCalendarDay() {
  return useCalendarDay(nextEasternMidnight);
}
