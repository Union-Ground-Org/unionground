// The alternate shell's toast (an owner decision: popups behave as
// in the prototype's Work page). The prototype's UG.toast (core.js) drops a
// forest pill into one `.toasts` stack at the foot of the content column; it
// rises in with ug-tin (.35s), stays 4.2 s, then fades out over .3s and is
// removed at 320 ms. App keeps the notice state and its Undo action; this
// component only draws it the prototype's way. Two accessibility keeps from
// the app's own ActionToast: a toast with an action holds while the pointer
// or keyboard focus is on it, and a timed-out action toast that held focus
// hands it to the main landmark instead of dropping it on the body.
import { useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { rpcErrorTextAtRender } from "../../lib/rpcErrorText.js";

const TOAST_MS = 4200;
const TOAST_FADE_MS = 320;

export function AltToast({ notice = "", noticeId = notice, action = null, onDismiss, onAction }) {
  const { t } = useLang();
  const toastRef = useRef(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const [held, setHeld] = useState({ hover: false, focus: false });
  // The notice that has started to fade; a newer notice is never "leaving".
  const [leavingId, setLeavingId] = useState(null);
  const leaving = Boolean(notice) && leavingId === noticeId;
  const hasAction = Boolean(action);
  const paused = hasAction && (held.hover || held.focus);
  // A changed text node alone is not a new live-region message; alternate an
  // invisible mark so a repeated confirmation is announced again.
  const mark = typeof noticeId === "number" ? (noticeId % 2 ? "\u200B" : "\u200C") : "";

  useEffect(() => { setHeld({ hover: false, focus: false }); }, [notice, noticeId]);

  useEffect(() => {
    if (!notice || paused || leaving) return undefined;
    const timer = window.setTimeout(() => setLeavingId(noticeId), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [notice, noticeId, paused, leaving]);

  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => {
      const hadFocus = Boolean(toastRef.current?.contains(document.activeElement));
      onDismissRef.current?.();
      if (hadFocus) document.getElementById("main-content")?.focus();
    }, TOAST_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, noticeId]);

  const leaves = (event) => !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget));

  return (
    <div className="ug-toasts" role="status" aria-live="polite">
      {notice ? (
        <div
          ref={toastRef}
          key={noticeId}
          className="ug-toast"
          style={leaving ? { transition: "opacity .3s", opacity: 0 } : undefined}
          onMouseEnter={() => setHeld((current) => ({ ...current, hover: true }))}
          onMouseLeave={(event) => { if (leaves(event)) setHeld((current) => ({ ...current, hover: false })); }}
          onFocusCapture={() => setHeld((current) => ({ ...current, focus: true }))}
          onBlurCapture={(event) => { if (leaves(event)) setHeld((current) => ({ ...current, focus: false })); }}
        >
          <span className="ug-tx">{rpcErrorTextAtRender(t, notice)}</span>
          {mark ? <span className="ug-sr">{mark}</span> : null}
          {action ? <button type="button" onClick={onAction}>{action.label}</button> : null}
        </div>
      ) : null}
    </div>
  );
}
