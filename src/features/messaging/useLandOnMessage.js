import { useEffect, useRef } from "react";

// Lands on the exact message a link named: scrolls it into view and focuses it,
// once. Three thread renderers (the private conversation, the steward dialog and
// the task conversation) share it, each giving its message rows the element id
// `${prefix}-message-${id}` and a tabIndex of -1 for the named row.
//
// `rows` is whatever the renderer lists, so the effect re-checks when the row
// arrives later (a paged window, a hydrated message); `landedOn` makes that
// re-check a no-op once the row has been reached, so a later refresh of the same
// thread never pulls the reader back. The work is deferred one task because a
// surrounding Dialog focuses its own heading in a parent effect that runs after
// this one, and would otherwise take the focus straight back.
export function useLandOnMessage(messageId, prefix, rows) {
  const landedOn = useRef(null);
  useEffect(() => {
    if (!messageId || landedOn.current === messageId) return undefined;
    const timer = setTimeout(() => {
      const target = document.getElementById(`${prefix}-message-${messageId}`);
      if (!target) return;
      landedOn.current = messageId;
      target.scrollIntoView?.({ block: "center" });
      target.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [messageId, prefix, rows]);
}
