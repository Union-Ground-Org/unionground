import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

function reducedMotionPreferred() {
  try {
    return typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function nextFrame(callback) {
  if (typeof window.requestAnimationFrame === "function") {
    return { kind: "frame", id: window.requestAnimationFrame(callback) };
  }
  return { kind: "timer", id: window.setTimeout(callback, 0) };
}

function cancelFrame(handle) {
  if (!handle) return;
  if (handle.kind === "frame" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(handle.id);
  } else {
    window.clearTimeout(handle.id);
  }
}

/**
 * Retains a surface through its exit transition.
 *
 * A generation invalidates every scheduled frame/timeout when the requested
 * state changes. That is the important bit: a rapid reopen cannot lose to the
 * stale completion callback from the close it interrupted.
 */
export function useTransitionPresence(open, {
  exitMs = 200,
  appear = true,
  onExited = null,
} = {}) {
  const initialPhase = open ? (appear ? "opening" : "open") : "unmounted";
  const [phase, setPhaseState] = useState(initialPhase);
  const phaseRef = useRef(initialPhase);
  const openRef = useRef(open);
  const generationRef = useRef(0);
  const exitTimerRef = useRef(null);
  const firstFrameRef = useRef(null);
  const secondFrameRef = useRef(null);
  const onExitedRef = useRef(onExited);

  useEffect(() => {
    onExitedRef.current = onExited;
  }, [onExited]);

  const setPhase = useCallback((next) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const clearScheduled = useCallback(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    cancelFrame(firstFrameRef.current);
    cancelFrame(secondFrameRef.current);
    firstFrameRef.current = null;
    secondFrameRef.current = null;
  }, []);

  const finishExit = useCallback((generation = generationRef.current) => {
    if (generation !== generationRef.current || openRef.current || phaseRef.current !== "closing") return;
    clearScheduled();
    setPhase("unmounted");
    onExitedRef.current?.();
  }, [clearScheduled, setPhase]);

  useLayoutEffect(() => {
    openRef.current = open;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    clearScheduled();

    if (open) {
      if (phaseRef.current === "open") return undefined;
      setPhase("opening");
      if (reducedMotionPreferred()) {
        firstFrameRef.current = nextFrame(() => {
          if (generation === generationRef.current && openRef.current) setPhase("open");
        });
        return clearScheduled;
      }
      // Two frames guarantee one painted closed frame before the final state.
      // A same-task close/reopen therefore animates again instead of snapping.
      firstFrameRef.current = nextFrame(() => {
        secondFrameRef.current = nextFrame(() => {
          if (generation === generationRef.current && openRef.current) setPhase("open");
        });
      });
      return clearScheduled;
    }

    if (phaseRef.current === "unmounted") return undefined;
    setPhase("closing");
    const wait = reducedMotionPreferred() ? 0 : exitMs + 34;
    exitTimerRef.current = window.setTimeout(() => finishExit(generation), wait);
    return clearScheduled;
  }, [clearScheduled, exitMs, finishExit, open, setPhase]);

  useEffect(() => () => {
    generationRef.current += 1;
    clearScheduled();
  }, [clearScheduled]);

  const onTransitionEnd = useCallback((event) => {
    if (event.target !== event.currentTarget) return;
    finishExit();
  }, [finishExit]);

  return {
    mounted: phase !== "unmounted",
    phase,
    closing: phase === "closing",
    onTransitionEnd,
  };
}

/** Keep the last non-null value available while its surface exits. */
export function useRetainedTransition(value, options = {}) {
  const [retained, setRetained] = useState(value ?? null);
  const onExitedRef = useRef(options.onExited);

  useEffect(() => {
    onExitedRef.current = options.onExited;
  }, [options.onExited]);

  useLayoutEffect(() => {
    if (value !== null && value !== undefined) setRetained(value);
  }, [value]);

  const presence = useTransitionPresence(value !== null && value !== undefined, {
    ...options,
    onExited: () => {
      setRetained(null);
      onExitedRef.current?.();
    },
  });

  return { ...presence, value: value ?? retained };
}

/**
 * A menu or popover that mounts with its trigger's `open` and fades out after
 * it closes, the prototype's `.menu` (an owner decision: opacity
 * and a 6px drop over .18s). `shown` is true from the render that opens it,
 * so the opener's layout effects can place and focus it at once; `state` is
 * "opening" for the painted closed frame, then "open", then "closing" while
 * the menu fades without taking input.
 */
export function useMenuPresence(open, { exitMs = 180 } = {}) {
  const { mounted, phase, onTransitionEnd } = useTransitionPresence(open, { exitMs });
  const state = !open ? "closing" : phase === "open" ? "open" : "opening";
  return { shown: open || mounted, state, closing: !open, onTransitionEnd };
}

/**
 * A modal that mounts open (its entrance is a CSS keyframe) and closes the
 * prototype modal's way:
 * once `request` turns null or false it stays `shown` for the 200 ms scrim
 * fade with `closing` true, so its layer carries data-state="closing" (the
 * fade and the settle-out are in src/popups.css and the alternate shell's
 * popups.css), and it goes when that layer's own transition ends or the
 * fallback timer fires. `value` keeps the last request to draw from while it
 * fades. Reduced motion closes it in the same render. Callers ignore
 * dismissals while `closing` and keep focus inside until it has gone.
 */
export function useModalExit(request, { exitMs = 200 } = {}) {
  const open = request !== null && request !== undefined && request !== false;
  const { mounted, value, onTransitionEnd } = useRetainedTransition(open ? request : null, { exitMs, appear: false });
  const shown = open || (mounted && !reducedMotionPreferred());
  const closing = shown && !open;
  return { shown, closing, state: closing ? "closing" : undefined, value, onTransitionEnd };
}

/**
 * Hand focus back to a modal's opener once the modal has gone. Nothing moves
 * if another surface took focus meanwhile (the task a template created, an
 * editor the modal opened), or if the opener is gone or sits under another
 * modal's inert page. Returns whether focus moved.
 */
export function returnFocusAfterModal(target, focusOptions = undefined) {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return false;
  if (!target?.isConnected || typeof target.focus !== "function" || target.closest?.("[inert]")) return false;
  target.focus(focusOptions);
  return true;
}
