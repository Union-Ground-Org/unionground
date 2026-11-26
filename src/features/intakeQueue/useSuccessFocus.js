import { useCallback, useLayoutEffect, useRef, useState } from "react";

// A successful action can remove the control that started
// it (a confirmation that closes, a form that becomes its result, a row that
// leaves the filtered list), and focus then falls to the page. handOff(control)
// is called once the success is known, after the state that removes the
// control; at the next commit, when that control is gone and focus has gone
// nowhere else, the status line (targetRef, focusable with tabIndex -1) takes
// focus. A control that stays keeps its focus, and so does a person who moved
// on while the action ran. The line keeps its own role and live region, so
// what a screen reader announces is unchanged.
export function focusedElement() {
  return typeof document === "undefined" ? null : document.activeElement;
}

export function useSuccessFocus() {
  const targetRef = useRef(null);
  const pendingRef = useRef(null);
  const [handoffs, setHandoffs] = useState(0);
  useLayoutEffect(() => {
    const control = pendingRef.current;
    pendingRef.current = null;
    if (!control || control.isConnected) return;
    const active = control.ownerDocument.activeElement;
    if (!active || active === control.ownerDocument.body) targetRef.current?.focus();
  }, [handoffs]);
  const handOff = useCallback((control) => {
    if (!control?.ownerDocument || control === control.ownerDocument.body) return;
    pendingRef.current = control;
    setHandoffs((count) => count + 1);
  }, []);
  return { targetRef, handOff };
}
