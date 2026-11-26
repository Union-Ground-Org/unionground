import { useCallback, useEffect, useRef, useState } from "react";

const CHANGE_EVENT = "sg-device-parity-change";
const APPLY_EVENT = "sg-device-parity-apply";
const state = new Map();
const consumers = new Map();

function validKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= 180;
}

function initialValue(initialState) {
  return typeof initialState === "function" ? initialState() : initialState;
}

function dispatch(name, detail) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

// Structural, not identity, equality decides whether a refusal needs a
// reconciling echo. Identity cannot work across the frame boundary — every
// postMessage hop clones — and echoing an EQUIVALENT value back would
// ping-pong forever between two consumers refusing each other's clone of the
// same state.
function structurallyEqual(a, b) {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// Shared UI-state primitive for the paired desktop and phone React trees.
// Local changes emit once; remote applications use a separate event and never
// echo. The module store also lets late-mounted screens consume a handshake
// snapshot that arrived before their lazy chunk rendered.
//
// `acceptApplied(incoming, current)` lets one consumer refuse an externally
// applied value for its own key — the narrow escape hatch a destructive
// surface needs so a background application cannot replace it mid-operation.
// A refusal also re-asserts the consumer's current value into the module
// store, so the refused value cannot resurface through a late-mounted
// consumer after the protected operation resolves. Local set calls are not
// filtered: the setter records the value before it dispatches, so the guard
// sees an already-identical pair and passes it through.
export function useDeviceParityState(key, initialState, { acceptApplied } = {}) {
  const fallbacksRef = useRef(new Map());
  if (!fallbacksRef.current.has(key)) fallbacksRef.current.set(key, initialValue(initialState));
  const [value, setValue] = useState(() => state.has(key) ? state.get(key) : fallbacksRef.current.get(key));
  const valueRef = useRef(value);
  valueRef.current = value;
  const acceptAppliedRef = useRef(acceptApplied);
  acceptAppliedRef.current = acceptApplied;

  useEffect(() => {
    if (!validKey(key)) return undefined;
    consumers.set(key, (consumers.get(key) || 0) + 1);
    const next = state.has(key) ? state.get(key) : fallbacksRef.current.get(key);
    valueRef.current = next;
    setValue(next);

    const onApply = (event) => {
      if (event.detail?.key !== key) return;
      const accept = acceptAppliedRef.current;
      if (typeof accept === "function" && !accept(event.detail.value, valueRef.current)) {
        state.set(key, valueRef.current);
        // Reconcile the pair: broadcast the surviving value so the frame
        // that sent the refused application converges back onto it instead
        // of rendering a divergent surface. An equivalent value is refused
        // silently — see structurallyEqual for why echoing it would loop.
        if (!structurallyEqual(event.detail.value, valueRef.current)) {
          dispatch(CHANGE_EVENT, { key, value: valueRef.current });
        }
        return;
      }
      valueRef.current = event.detail.value;
      setValue(event.detail.value);
    };
    window.addEventListener(APPLY_EVENT, onApply);
    return () => {
      window.removeEventListener(APPLY_EVENT, onApply);
      const remaining = (consumers.get(key) || 1) - 1;
      if (remaining > 0) consumers.set(key, remaining);
      else {
        consumers.delete(key);
        state.delete(key);
      }
    };
  }, [key]);

  const setParityValue = useCallback((nextValue) => {
    if (!validKey(key)) return;
    const next = typeof nextValue === "function" ? nextValue(valueRef.current) : nextValue;
    valueRef.current = next;
    state.set(key, next);
    setValue(next);
    dispatch(APPLY_EVENT, { key, value: next });
    dispatch(CHANGE_EVENT, { key, value: next });
  }, [key]);

  return [value, setParityValue];
}

export function applyDeviceParityState(key, value) {
  if (!validKey(key)) return false;
  state.set(key, value);
  dispatch(APPLY_EVENT, { key, value });
  // A guarded consumer may refuse and re-assert its own value during the
  // synchronous dispatch above; report whether THIS value actually took, so
  // bridge callers and snapshot replays never count a refusal as applied.
  return state.get(key) === value;
}

/** Read the current store value imperatively — for guards in event handlers
 * that must consult shared state (e.g. the session destructive hold) without
 * subscribing a component. */
export function deviceParityValue(key) {
  return state.get(key);
}

export function applyDeviceParitySnapshot(entries) {
  if (!Array.isArray(entries)) return 0;
  let applied = 0;
  for (const entry of entries) {
    if (entry && applyDeviceParityState(entry.key, entry.value)) applied += 1;
  }
  return applied;
}

export function deviceParitySnapshot() {
  return Array.from(state, ([key, value]) => ({ key, value }));
}

export function subscribeDeviceParityChanges(listener) {
  if (typeof window === "undefined" || typeof listener !== "function") return () => {};
  const onChange = (event) => {
    if (validKey(event.detail?.key)) listener(event.detail);
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

export function clearDeviceParityState() {
  state.clear();
  consumers.clear();
}

function flushPendingDeviceParity() {
  const queued = typeof window !== "undefined" ? window.__ugPendingDeviceParity : null;
  if (!Array.isArray(queued)) return;
  window.__ugPendingDeviceParity = [];
  for (const entry of queued) {
    if (Array.isArray(entry) && entry.length === 2) applyDeviceParityState(entry[0], entry[1]);
  }
}

// Preview-only seam for Playwright assurance and the local SAMPLE
// visual-audit host. Production never sets these flags, so this hook is
// absent on shipped origins. Init scripts may queue values on
// window.__ugPendingDeviceParity so the first React render already sees them.
if (
  (import.meta.env.VITE_E2E_HARNESS === "1" || import.meta.env.VITE_VISUAL_AUDIT === "1")
  && typeof window !== "undefined"
) {
  window.__ugApplyDeviceParityState = applyDeviceParityState;
  flushPendingDeviceParity();
}
