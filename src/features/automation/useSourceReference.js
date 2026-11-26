import { useEffect, useRef } from "react";
import { validAutomationSource } from "./links.js";

// References only select rows already returned by the destination's normal
// authorization boundary. They never fetch with elevated permissions.
export function useSourceReference(kind, rows) {
  const requested = new URLSearchParams(window.location.search).get(kind);
  const valid = validAutomationSource(kind, requested);
  const found = valid && rows.some((row) => row.id === requested);
  const focused = useRef(null);
  useEffect(() => {
    if (!found || focused.current === requested) return;
    const frame = requestAnimationFrame(() => {
      const target = [...document.querySelectorAll("[data-automation-source-id]")].find((node) => node.dataset.automationSourceId === requested);
      if (!target) return;
      focused.current = requested;
      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: "center", behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [found, requested]);
  return { requestedId: found ? requested : null, missing: Boolean(requested) && !found };
}
