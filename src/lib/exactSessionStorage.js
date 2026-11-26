const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DURABLE_CLOSED_SESSIONS = 64;

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    __unionGroundIsolated: true,
  };
}

function unavailableStorage(cause) {
  const error = new Error(
    "Persistent browser authentication storage is unavailable; the existing session cannot be verified or cleared safely.",
    { cause },
  );
  const failClosed = () => { throw error; };
  return {
    getItem: failClosed,
    setItem: failClosed,
    removeItem: failClosed,
    __unionGroundUnavailable: true,
  };
}

export function availableBrowserAuthStorage(target = globalThis) {
  let storage;
  try {
    storage = target?.localStorage;
  } catch (error) {
    // A denied browser storage realm may still contain a durable auth tuple
    // that becomes readable again later. Do not substitute an empty in-memory
    // store and present a false signed-out state; make initialization fail
    // visibly until the persistent session can be inspected.
    return unavailableStorage(error);
  }
  if (!storage?.getItem || !storage?.setItem || !storage?.removeItem) return memoryStorage();
  // Do not capability-probe by writing a disposable key. A quota- or
  // policy-denied remove would accumulate an undeletable sentinel, and using
  // an empty fallback after any failed probe could strand a real auth tuple.
  // Keep the persistent adapter: readable state stays visible, while a denied
  // operation fails at the exact auth action that requires it.
  return storage;
}

function decodeBase64UrlAscii(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!normalized || /[^A-Za-z0-9+/]/.test(normalized)) return null;
  let bits = 0;
  let bitCount = 0;
  let decoded = "";
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) return null;
    bits = (bits << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      decoded += String.fromCharCode((bits >> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  return decoded;
}

// The email claim carried by the access token itself, or null when the token
// is not a readable JWT or carries no email. Lets a host decide on the
// credential rather than on the editable user object stored beside it.
export function emailFromAccessToken(accessToken) {
  if (typeof accessToken !== "string") return null;
  const encodedPayload = accessToken.split(".")[1];
  if (!encodedPayload) return null;
  const decodedPayload = decodeBase64UrlAscii(encodedPayload);
  if (!decodedPayload) return null;
  try {
    const email = JSON.parse(decodedPayload)?.email;
    return typeof email === "string" && email ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function sessionIDFromAccessToken(accessToken) {
  if (typeof accessToken !== "string") return null;
  const encodedPayload = accessToken.split(".")[1];
  if (!encodedPayload) return null;
  const decodedPayload = decodeBase64UrlAscii(encodedPayload);
  if (!decodedPayload) return null;
  try {
    const sessionID = JSON.parse(decodedPayload)?.session_id;
    return typeof sessionID === "string" && SESSION_ID_PATTERN.test(sessionID)
      ? sessionID.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

// Active auth lineage from the storage adapter Supabase actually persists
// through. Absent key -> null; missing/unreadable adapter -> undefined. A
// durable closed-session fence makes that lineage inert so cold-start cleanup
// can still erase the departed session's device residue.
export function readAuthStorageSessionLineage(storage, authStorageKey) {
  if (!authStorageKey) return undefined;
  try {
    if (!storage?.getItem) return undefined;
    const raw = storage.getItem(authStorageKey);
    if (raw === null) return null;
    const lineage = sessionIDFromAccessToken(JSON.parse(raw)?.access_token);
    // Without Web Locks, exact-session cleanup deliberately leaves the raw
    // tuple in place after publishing its durable closed-lineage fence. That
    // tuple is inert: do not let it masquerade as an active replacement and
    // shield the departed session's device residue from cold-start cleanup.
    if (lineage && storage.getItem(`${authStorageKey}.closed-session.${lineage}`) !== null) {
      return null;
    }
    return lineage || undefined;
  } catch {
    return undefined;
  }
}

// auth-js 2.118 PKCE storage (lib/helpers.js): one verifier slot per pending
// flow, an index of their ids, and the newest verifier mirrored at the legacy
// `<key>-code-verifier` that a callback without sb_flow_id redeems.
const PKCE_VERIFIER_SUFFIX = "-code-verifier";
const PKCE_FLOW_ID = /^[a-zA-Z0-9_-]{8,64}$/;
const pkceIndexKey = (key) => `${key}-flows${PKCE_VERIFIER_SUFFIX}`;
const pkceSlotKey = (key, flowId) => `${key}-flow-${flowId}${PKCE_VERIFIER_SUFFIX}`;

// Which PKCE key a storage key is: a flow's slot, the flow index or the
// legacy mirror, and the auth key it belongs to; null for any other key.
function pkceKeyKind(key) {
  if (typeof key !== "string" || !key.endsWith(PKCE_VERIFIER_SUFFIX)) return null;
  const base = key.slice(0, -PKCE_VERIFIER_SUFFIX.length);
  const slot = /^(.+)-flow-([a-zA-Z0-9_-]{8,64})$/u.exec(base);
  if (slot) return { key: slot[1], kind: "slot" };
  if (base.endsWith("-flows")) return { key: base.slice(0, -"-flows".length), kind: "index" };
  return { key: base, kind: "legacy" };
}

function readPkceFlowIndex(storage, key) {
  let index;
  try { index = JSON.parse(storage.getItem(pkceIndexKey(key)) ?? "null"); } catch { return []; }
  return Array.isArray(index) ? index.filter((flowId) => typeof flowId === "string" && PKCE_FLOW_ID.test(flowId)) : [];
}

// This app never appends sb_flow_id (src/lib/supabase.js), so every callback is
// redeemed from the legacy key and auth-js then removes only that key, leaving
// the redeemed flow's slot and index entry behind. Removing the legacy key also
// removes the slot holding the verifier the exchange used and its index entry,
// so a redeemed flow leaves nothing (#6206). Slots holding other verifiers are
// other pending flows and stay.
function retireMirroredPkceSlot(storage, legacyKey, legacyRaw) {
  if (!legacyRaw || !legacyKey.endsWith(PKCE_VERIFIER_SUFFIX)) return;
  const key = legacyKey.slice(0, -PKCE_VERIFIER_SUFFIX.length);
  const index = readPkceFlowIndex(storage, key);
  const remaining = index.filter((flowId) => {
    const slot = pkceSlotKey(key, flowId);
    if (storage.getItem(slot) !== legacyRaw) return true;
    storage.removeItem(slot);
    return false;
  });
  if (remaining.length === index.length) return;
  if (remaining.length > 0) storage.setItem(pkceIndexKey(key), JSON.stringify(remaining));
  else storage.removeItem(pkceIndexKey(key));
}

function closedSessionKey(key, sessionID) {
  return `${key}.closed-session.${sessionID}`;
}

function closedSessionIndexKey(key) {
  return `${key}.closed-session-index`;
}

function parseClosedSessionIndex(raw) {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(
      (sessionID) => typeof sessionID === "string" && SESSION_ID_PATTERN.test(sessionID),
    ).map((sessionID) => sessionID.toLowerCase()))];
  } catch {
    return [];
  }
}

export function storageEventClosesAuthSession(event, authStorageKey, session) {
  const sessionID = sessionIDFromAccessToken(session?.access_token);
  return Boolean(
    sessionID
    && event?.key === closedSessionKey(authStorageKey, sessionID)
    && event.newValue !== null
  );
}

export function storageEventExplicitlySignsOutSession(event, authStorageKey, sessionID) {
  return Boolean(typeof sessionID === "string" && SESSION_ID_PATTERN.test(sessionID) && event?.key === `${authStorageKey}.explicit-sign-out`
    && event.newValue === sessionID);
}

function parseStoredSession(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function exactSessionMatch(stored, expected) {
  return Boolean(
    stored
    && expected
    && typeof expected.access_token === "string"
    && expected.access_token
    && typeof expected.refresh_token === "string"
    && expected.refresh_token
    && typeof expected.user?.id === "string"
    && expected.user.id
    && stored.access_token === expected.access_token
    && stored.refresh_token === expected.refresh_token
    && stored.user?.id === expected.user.id
  );
}

export function sameAuthSessionLineage(left, right) {
  if (!left || !right || left.user?.id !== right.user?.id) return false;
  const leftSessionID = sessionIDFromAccessToken(left.access_token);
  const rightSessionID = sessionIDFromAccessToken(right.access_token);
  return Boolean(leftSessionID && rightSessionID && leftSessionID === rightSessionID);
}

/**
 * Supabase's browser auth adapter, extended with an exact-session CAS.
 *
 * The backing store is deliberately required to be synchronous (the browser's
 * Storage contract): comparison and removal then happen in one JavaScript
 * turn, with no await point where a replacement login can occupy the slot.
 * A session-id tombstone also rejects a late token-refresh write from the
 * session that was just closed while allowing a new login/session id.
 */
export function createExactSessionStorage(storage) {
  if (!storage?.getItem || !storage?.setItem || !storage?.removeItem) {
    throw new Error("Exact browser session storage is unavailable.");
  }
  const revokedSessionIDs = new Set();
  // Auth-js' storage contract does not pass the session it intends to remove.
  // Remember the lineage this adapter actually returned so an older tab's
  // delayed remove cannot erase a replacement written by another adapter.
  const observedSessionIDs = new Map();
  // #6261: the legacy PKCE verifier this tab last read, which auth-js reads
  // right before a code exchange's token request and removes right after it.
  // Another tab can start a flow in between and replace the mirror; the
  // removal then retires the slot of the verifier this exchange used and
  // keeps the new mirror. Any write of that auth key's slots, index or mirror
  // in this tab, or removal of a slot or the index, ends the read's claim, so
  // a read auth-js did not follow with a removal is never applied to a later
  // one; removing the mirror itself keeps it.
  const exchangedPkceVerifiers = new Map();
  const forgetExchangedPkce = (key) => {
    const pkce = pkceKeyKind(key);
    if (pkce) exchangedPkceVerifiers.delete(`${pkce.key}${PKCE_VERIFIER_SUFFIX}`);
  };
  let lockManager = null;
  try {
    // Node also exposes a global Navigator/LockManager. It is not a shared
    // browser storage realm, so using it here only makes SSR and node tests
    // asynchronous without adding any cross-tab serialization. Restrict Web
    // Locks to an actual Window realm.
    lockManager = globalThis.window?.navigator?.locks?.request
      ? globalThis.window.navigator.locks
      : null;
  } catch {
    lockManager = null;
  }
  const withStorageLock = (key, operation) => (lockManager
    ? lockManager.request(`union-ground-auth-storage:${key}`, { mode: "exclusive" }, operation)
    : operation());

  const memoryFenceKey = (key, sessionID) => `${key}\0${sessionID}`;

  function writeClosedSessionFence(key, sessionID) {
    const indexKey = closedSessionIndexKey(key);
    const retained = parseClosedSessionIndex(storage.getItem(indexKey))
      .filter((indexedSessionID) => indexedSessionID !== sessionID);
    while (retained.length >= MAX_DURABLE_CLOSED_SESSIONS) {
      const retiredSessionID = retained.shift();
      const retiredKey = closedSessionKey(key, retiredSessionID);
      storage.removeItem(retiredKey);
      if (storage.getItem(retiredKey) !== null) {
        throw new Error("Closed browser session history could not be pruned safely.");
      }
      revokedSessionIDs.delete(memoryFenceKey(key, retiredSessionID));
    }

    // Index before publishing the terminal fence. An index-write failure must
    // not leave an untracked tombstone that can never be pruned. If the later
    // fence write fails, the bounded index may contain an inert entry; only
    // the actual tombstone marks a session closed.
    const nextIndex = JSON.stringify([...retained, sessionID]);
    storage.setItem(indexKey, nextIndex);
    if (storage.getItem(indexKey) !== nextIndex) {
      throw new Error("Closed browser session history could not be indexed durably.");
    }

    const tombstoneKey = closedSessionKey(key, sessionID);
    storage.setItem(tombstoneKey, "closed");
    if (storage.getItem(tombstoneKey) !== "closed") {
      throw new Error("The closed browser session could not be fenced durably.");
    }

    revokedSessionIDs.add(memoryFenceKey(key, sessionID));
    return tombstoneKey;
  }

  function sessionIsClosed(key, sessionID) {
    if (!sessionID) return false;
    const fenceKey = memoryFenceKey(key, sessionID);
    if (revokedSessionIDs.has(fenceKey)) return true;
    const closed = storage.getItem(closedSessionKey(key, sessionID)) !== null;
    if (closed) revokedSessionIDs.add(fenceKey);
    return closed;
  }

  return {
    isSessionClosed(key, session) {
      const sessionID = sessionIDFromAccessToken(session?.access_token);
      if (!sessionID) return false;
      try {
        return sessionIsClosed(key, sessionID);
      } catch {
        // A storage realm that becomes unreadable after boot cannot prove an
        // incoming BroadcastChannel session is open. Refuse publication.
        return true;
      }
    },

    getItem(key) {
      return withStorageLock(key, () => {
        const raw = storage.getItem(key);
        if (pkceKeyKind(key)?.kind === "legacy") exchangedPkceVerifiers.set(key, raw);
        const sessionID = sessionIDFromAccessToken(parseStoredSession(raw)?.access_token);
        if (sessionID) observedSessionIDs.set(key, sessionID);
        else observedSessionIDs.delete(key);
        return sessionIsClosed(key, sessionID) ? null : raw;
      });
    },

    setItem(key, value) {
      return withStorageLock(key, () => {
        forgetExchangedPkce(key);
        const storedSession = parseStoredSession(value);
        const sessionID = sessionIDFromAccessToken(storedSession?.access_token);
        if (sessionIsClosed(key, sessionID)) {
          throw new Error("A closed browser session cannot replace auth storage.");
        }
        const displacedRaw = storage.getItem(key);
        const displacedSessionID = sessionIDFromAccessToken(parseStoredSession(displacedRaw)?.access_token);
        // Commit the replacement before closing the old lineage. A rejected
        // main-key write must leave the only persisted, live session usable.
        storage.setItem(key, value);
        if (sessionID && displacedSessionID && displacedSessionID !== sessionID
          && !sessionIsClosed(key, displacedSessionID)) {
          try {
            // Fence before the locked operation returns and auth-js publishes
            // the replacement, rejecting delayed refreshes from older tabs.
            writeClosedSessionFence(key, displacedSessionID);
          } catch (error) {
            // If no fence committed, restore the still-open old tuple under
            // the same lock. Do not roll back over a newer legacy writer or
            // restore a closed lineage after a partial fence/index failure.
            if (!sessionIsClosed(key, displacedSessionID) && storage.getItem(key) === value) {
              storage.setItem(key, displacedRaw);
            }
            throw error;
          }
        }
        // A legacy tab can close this lineage outside the shared Web Lock
        // after the pre-check. Re-read its durable tombstone before auth-js
        // can publish TOKEN_REFRESHED.
        if (sessionIsClosed(key, sessionID)) {
          throw new Error("A closed browser session cannot replace auth storage.");
        }
      });
    },

    removeItem(key) {
      return withStorageLock(key, () => {
        const raw = storage.getItem(key);
        const storedSessionID = sessionIDFromAccessToken(
          parseStoredSession(raw)?.access_token,
        );
        // PKCE/user helper slots and malformed or empty values have no auth
        // lineage to protect. Preserve their existing remove semantics.
        if (!storedSessionID) {
          const claimed = pkceKeyKind(key)?.kind === "legacy" && exchangedPkceVerifiers.has(key);
          const exchanged = claimed ? exchangedPkceVerifiers.get(key) : raw;
          // The claim outlives its own removal: auth-js removes the mirror again
          // when saving the exchanged session throws (#6287 r1), and that repeat
          // must keep another flow's mirror too.
          if (!claimed) forgetExchangedPkce(key);
          // A mirror another flow wrote after this tab's read is that flow's.
          if (!claimed || raw === exchanged) storage.removeItem(key);
          observedSessionIDs.delete(key);
          retireMirroredPkceSlot(storage, key, exchanged);
          return;
        }

        if (sessionIsClosed(key, storedSessionID)) {
          // A durable fence already makes this exact tuple inert. Physical
          // cleanup is safe because the current slot still names that fence.
          if (storage.getItem(key) === raw) storage.removeItem(key);
          observedSessionIDs.delete(key);
          return;
        }

        const observedSessionID = observedSessionIDs.get(key);
        if (!observedSessionID || observedSessionID !== storedSessionID) {
          // The caller last observed another lineage (or none). Fence that
          // stale lineage when known, but never consume the current slot.
          if (observedSessionID && !sessionIsClosed(key, observedSessionID)) {
            writeClosedSessionFence(key, observedSessionID);
          }
          // Auth-js emits SIGNED_OUT only after this hook resolves. Rejecting
          // the stale cleanup therefore preserves both the durable tuple and
          // the current protected UI instead of manufacturing a sign-out.
          throw new Error("A stale browser auth operation cannot remove a newer session lineage.");
        }

        writeClosedSessionFence(key, observedSessionID);
        // Browser Storage is synchronous. Recheck the exact raw tuple in the
        // same locked turn so a non-cooperating legacy writer is preserved.
        if (storage.getItem(key) === raw) storage.removeItem(key);
        observedSessionIDs.delete(key);
      });
    },

    // Refusal-only cleanup for a stored tuple whose access token carries no
    // session id (a hand-set or malformed tuple). The ordinary compare-and-
    // swap has no lineage to fence, so it answers false and the tuple would
    // stay for the client's refresh to exchange later (gate round 3 on
    // #5285). Under the same lock, the slot is removed only while
    // its raw value still holds the refused tuple's identity (access token,
    // refresh token and user id); a changed token, user or a replacement
    // lineage is preserved, and no fence is written for a lineage that does
    // not exist. Lineage-bearing tokens stay with removeSessionIfMatches.
    removeRefusedSessionExactly(key, refusedSession) {
      return withStorageLock(key, () => {
        if (typeof refusedSession?.access_token !== "string" || !refusedSession.access_token) return false;
        if (sessionIDFromAccessToken(refusedSession.access_token)) return false;
        const raw = storage.getItem(key);
        const stored = parseStoredSession(raw);
        if (!stored
          || stored.access_token !== refusedSession.access_token
          || (stored.refresh_token ?? null) !== (refusedSession.refresh_token ?? null)
          || (stored.user?.id ?? null) !== (refusedSession.user?.id ?? null)) return false;
        if (storage.getItem(key) !== raw) return false;
        storage.removeItem(key);
        observedSessionIDs.delete(key);
        return storage.getItem(key) === null;
      });
    },

    // `onMatched` runs in the clear's locked turn once the stored session is
    // the expected one, before its fence is published: the boundary a
    // sign-out's PKCE cleanup snapshots its verifiers at (#6262). A
    // replacement session installed before it makes the clear refuse, so no
    // replacement flow can be captured (#6290 r1); the snapshot counts only
    // when the clear then returns true.
    // Without Web Locks another tab can install a replacement session between
    // the read below and that snapshot, and start a flow under it. A
    // synchronous recheck after `onMatched` calls `onReplaced` whenever the
    // stored session is no longer the departing lineage, so the caller
    // discards the snapshot and removes nothing it captured (#6293). A
    // departing lineage already fenced at the recheck means a replacement
    // closed it, even when a stale refresh of that lineage was written back
    // after the replacement and its flow (#6367), so that also calls it.
    // Web Locks serialize the clear against both, so that path is unchanged.
    removeSessionIfMatches(key, expectedSession, { explicitSignOut = false, onMatched = null, onReplaced = null } = {}) {
      return withStorageLock(key, () => {
        const raw = storage.getItem(key);
        const storedSession = parseStoredSession(raw);
        const sessionID = sessionIDFromAccessToken(expectedSession.access_token);
        if (!sessionID) return false;
        if (!exactSessionMatch(storedSession, expectedSession)
          && !sameAuthSessionLineage(storedSession, expectedSession)) return false;
        onMatched?.();
        const current = storage.getItem(key);
        if ((current !== raw && !sameAuthSessionLineage(parseStoredSession(current), expectedSession))
          || (!lockManager && sessionIsClosed(key, sessionID))) onReplaced?.();
        // Persist before removing the shared slot. Every tab's adapter checks
        // this marker, and its storage event clears that exact lineage's UI.
        const tombstoneKey = writeClosedSessionFence(key, sessionID);
        if (explicitSignOut) {
          // One bounded signal, separate from expiry/revocation tombstones.
          // Publish only after the exact lineage is durably closed. Receivers
          // also check their current/persisted lineage before changing URLs.
          const explicitKey = `${key}.explicit-sign-out`;
          storage.setItem(explicitKey, sessionID);
          if (storage.getItem(explicitKey) !== sessionID) {
            throw new Error("Explicit browser sign-out could not be announced durably.");
          }
        }
        // Current browser clients serialize this compare/remove through a
        // cross-tab Web Lock. Without that primitive, the durable tombstone is
        // still authoritative; retain the inert raw tuple rather than risk
        // deleting a concurrently installed replacement session.
        if ((lockManager || storage.__unionGroundIsolated === true)
          && storage.getItem(key) === raw) {
          try {
            storage.removeItem(key);
          } catch (error) {
            // Physical removal is optional once the exact lineage has a
            // verified durable fence. If that proof becomes unreadable too,
            // cleanup is no longer trustworthy and must remain an error.
            if (storage.getItem(tombstoneKey) !== "closed") throw error;
          }
        }
        return true;
      });
    },

    // The departing session's PKCE verifiers as they stand at its clear: every
    // indexed slot, the index and the legacy mirror, raw. Synchronous, so it
    // can run inside removeSessionIfMatches' locked turn.
    snapshotPkceVerifiers(key) {
      const legacyKey = `${key}${PKCE_VERIFIER_SUFFIX}`;
      const slots = new Map(readPkceFlowIndex(storage, key).map((flowId) => [flowId, storage.getItem(pkceSlotKey(key, flowId))]));
      return { slots, legacy: storage.getItem(legacyKey) };
    },

    // Application sign-out clears the session through removeSessionIfMatches,
    // not auth-js signOut, so auth-js's own teardown (removeAllPKCEVerifiers)
    // never runs. This is that teardown (#6206), limited to the snapshot taken
    // at the clear (#6262): a captured slot or mirror is removed only while it
    // still holds the captured value, and only removed flows leave the index,
    // so flows a replacement login started after the clear survive.
    removePkceVerifiers(key, snapshot) {
      return withStorageLock(`${key}${PKCE_VERIFIER_SUFFIX}`, () => {
        exchangedPkceVerifiers.delete(`${key}${PKCE_VERIFIER_SUFFIX}`);
        const removed = new Set();
        for (const [flowId, raw] of snapshot?.slots ?? []) {
          const slot = pkceSlotKey(key, flowId);
          if (raw !== null && storage.getItem(slot) === raw) { storage.removeItem(slot); removed.add(flowId); }
        }
        const index = readPkceFlowIndex(storage, key);
        const remaining = index.filter((flowId) => !removed.has(flowId));
        if (remaining.length === 0) storage.removeItem(pkceIndexKey(key));
        else if (remaining.length !== index.length) storage.setItem(pkceIndexKey(key), JSON.stringify(remaining));
        const legacyKey = `${key}${PKCE_VERIFIER_SUFFIX}`;
        if (snapshot && snapshot.legacy !== null && storage.getItem(legacyKey) === snapshot.legacy) storage.removeItem(legacyKey);
      });
    },
  };
}
