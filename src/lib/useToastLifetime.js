import { useEffect, useRef, useState } from "react";

// The prototype's toast clock (an owner decision, core.js
// UG.toast): a toast stays 4.2 s, then fades over .3s and is removed at
// 320 ms. The classic shell's toasts share it; the alternate shell's
// AltToast keeps the same numbers on its own markup.
export const TOAST_LIFETIME_MS = 4200;
export const TOAST_LEAVE_MS = 320;

/**
 * Runs one toast's lifetime. `noticeId` names the notice: a newer one restarts
 * the clock, even mid-fade, and is never "leaving". While `paused` (an action
 * toast under the pointer or keyboard focus) the clock does not start the
 * fade. `onExpire` runs when the fade has finished.
 */
export function useToastLifetime({ notice, noticeId = notice, paused = false, onExpire }) {
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const [leavingId, setLeavingId] = useState(null);
  const leaving = Boolean(notice) && leavingId === noticeId;

  useEffect(() => {
    if (!notice || paused || leaving) return undefined;
    const timer = window.setTimeout(() => setLeavingId(noticeId), TOAST_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [notice, noticeId, paused, leaving]);

  // A pause that starts during the fade (the pointer or focus reaching Undo
  // after the lifetime) brings the toast back; the clock starts again once
  // the interaction ends.
  useEffect(() => {
    if (leaving && paused) setLeavingId(null);
  }, [leaving, paused]);

  useEffect(() => {
    if (!leaving || paused) return undefined;
    const timer = window.setTimeout(() => {
      setLeavingId(null);
      onExpireRef.current?.();
    }, TOAST_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, noticeId, paused]);

  return { leaving };
}
