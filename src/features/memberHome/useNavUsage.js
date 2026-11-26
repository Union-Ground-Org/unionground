import { useCallback, useEffect, useMemo, useState } from "react";
import { isFeatureEnabled } from "../../lib/featureSwitches.js";
import {
  NAV_USAGE_SWITCH,
  computeNavWeights,
  emptyNavUsage,
  navPinsKeysForUser,
  navPinsStorageKey,
  navUsageKeysForUser,
  navUsageStorageKey,
  parseNavPins,
  parseNavUsage,
  recordNavVisit,
  serializeNavPins,
  toggleNavPin,
} from "./navUsage.js";

// REQ-UG-USAGE-BASED-NAVIGATION-20261001: the browser half of the
// device-only ranking. Counts live in this browser's localStorage under the
// signed-in member and organization; nothing here ever reaches the server.
// Demo sessions keep their counts in memory for the life of the page, like
// the rest of their state, so nothing about a SAMPLE visit outlives the tab.
export const NAV_USAGE_CHANGED_EVENT = "ug-nav-usage-changed";
// Failed writes still belong to this tab and the exact member/organization.
// Successful writes can go back to reading the shared durable value.
const memoryUsage = new Map();

function storage() {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

function readUsage(key) {
  if (!key) return emptyNavUsage();
  if (memoryUsage.has(key)) return memoryUsage.get(key);
  try { return parseNavUsage(storage()?.getItem(key) ?? null); } catch { return emptyNavUsage(); }
}

function announce(userId) {
  try { window.dispatchEvent(new CustomEvent(NAV_USAGE_CHANGED_EVENT, { detail: { userId } })); } catch { /* same-tab refresh hint only */ }
}

// Member-level reset and sign-out cleanup: every ranking this account left in
// this browser, for every organization (and the in-memory demo ranking).
export function clearNavUsageForUser(userId) {
  const store = storage();
  const keys = new Set(memoryUsage.keys());
  if (store && userId) {
    try {
      for (let index = 0; index < store.length; index += 1) keys.add(store.key(index));
    } catch { /* storage unavailable: nothing was stored */ }
  }
  for (const key of navUsageKeysForUser([...keys], userId)) {
    // Keep an empty fallback if removal is refused, so reset cannot resurrect
    // an older durable value on the next navigation.
    memoryUsage.set(key, emptyNavUsage());
    try {
      if (store) {
        store.removeItem(key);
        memoryUsage.delete(key);
      }
    } catch { /* the reset stays in memory */ }
  }
  announce(userId ?? null);
}

export function navUsageEnabled(configuration) {
  return isFeatureEnabled(configuration, NAV_USAGE_SWITCH, true);
}

// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 89): the
// member's menu pins, kept the same way as the ranking: this browser's
// localStorage under the member and organization, in memory only for demo
// sessions (or when a write is refused). The same changed event refreshes
// every reader in this tab.
const memoryPins = new Map();

// Sign-out forgets the member's pins on this device, with the ranking.
export function clearNavPinsForUser(userId) {
  const store = storage();
  const keys = new Set(memoryPins.keys());
  if (store && userId) {
    try {
      for (let index = 0; index < store.length; index += 1) keys.add(store.key(index));
    } catch { /* storage unavailable: nothing was stored */ }
  }
  for (const key of navPinsKeysForUser([...keys], userId)) {
    memoryPins.set(key, []);
    try {
      if (store) {
        store.removeItem(key);
        memoryPins.delete(key);
      }
    } catch { /* the cleared list stays in memory */ }
  }
  announce(userId ?? null);
}

export function readNavPins(key, persist = true) {
  if (!key) return [];
  if (memoryPins.has(key)) return memoryPins.get(key);
  if (!persist) return [];
  try { return parseNavPins(storage()?.getItem(key) ?? null); } catch { return []; }
}

export function writeNavPins(key, pins, { persist = true, userId = null } = {}) {
  if (!key) return [];
  const next = parseNavPins({ version: 1, pins });
  memoryPins.set(key, next);
  if (persist) {
    try {
      const store = storage();
      if (store) {
        store.setItem(key, serializeNavPins(next));
        memoryPins.delete(key);
      }
    } catch { /* the pins stay in memory */ }
  }
  announce(userId);
  return next;
}

// Pins for one member and organization, with a toggle. `enabled` follows the
// organization's most-used switch, like the ranking itself.
export function useNavPins({ userId = null, organizationId = null, enabled = true, persist = true }) {
  const key = enabled ? navPinsStorageKey(userId, organizationId) : null;
  const [pins, setPins] = useState(() => readNavPins(key, persist));
  useEffect(() => {
    setPins(readNavPins(key, persist));
    if (!key || typeof window === "undefined") return undefined;
    const refresh = (event) => {
      if (event?.type === "storage" && event.key !== null && event.key !== key) return;
      if (event?.type === NAV_USAGE_CHANGED_EVENT && event.detail?.userId && event.detail.userId !== userId) return;
      if (event?.type === "storage") memoryPins.delete(key);
      setPins(readNavPins(key, persist));
    };
    window.addEventListener("storage", refresh);
    window.addEventListener(NAV_USAGE_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(NAV_USAGE_CHANGED_EVENT, refresh);
    };
  }, [key, persist, userId]);
  const togglePin = useCallback((itemKey) => {
    if (!key) return;
    setPins(writeNavPins(key, toggleNavPin(readNavPins(key, persist), itemKey), { persist, userId }));
  }, [key, persist, userId]);
  return { pins: key ? pins : [], togglePin };
}

// `view` is the app view the member is on; `tracking` is false whenever a
// staff hat is worn (only member destinations are ranked); `persist` is false
// for demo sessions.
export function useNavUsage({ userId = null, organizationId = null, configuration = null, view = null, tracking = true, persist = true }) {
  const enabled = navUsageEnabled(configuration);
  const key = enabled ? navUsageStorageKey(userId, organizationId) : null;
  const [usage, setUsage] = useState(() => (persist ? readUsage(key) : emptyNavUsage()));

  useEffect(() => {
    setUsage(persist ? readUsage(key) : emptyNavUsage());
    if (!key || typeof window === "undefined") return undefined;
    const refresh = (event) => {
      if (event?.type === "storage" && event.key !== null && event.key !== key) return;
      if (event?.type === NAV_USAGE_CHANGED_EVENT && event.detail?.userId && event.detail.userId !== userId) return;
      if (event?.type === "storage") {
        if (event.key === null) memoryUsage.clear();
        memoryUsage.set(key, parseNavUsage(event.newValue));
      }
      setUsage(persist ? readUsage(key) : emptyNavUsage());
    };
    window.addEventListener("storage", refresh);
    window.addEventListener(NAV_USAGE_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(NAV_USAGE_CHANGED_EVENT, refresh);
    };
  }, [key, persist, userId]);

  useEffect(() => {
    if (!key || !tracking || typeof view !== "string" || !view) return;
    if (!persist) {
      setUsage((current) => recordNavVisit(current, view));
      return;
    }
    const next = recordNavVisit(readUsage(key), view);
    memoryUsage.set(key, next);
    try {
      const store = storage();
      if (store) {
        store.setItem(key, JSON.stringify(next));
        memoryUsage.delete(key);
      }
    } catch { /* the ranking stays in memory */ }
    setUsage(next);
  }, [key, tracking, view, persist]);

  const weights = useMemo(() => (key ? computeNavWeights(usage) : []), [key, usage]);
  const reset = useCallback(() => clearNavUsageForUser(userId), [userId]);
  const { pins, togglePin } = useNavPins({ userId, organizationId, enabled, persist });
  return { enabled, weights, reset, pins, togglePin };
}
