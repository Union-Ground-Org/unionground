// Identity and ordering guards for the member app's async loads.
//
// This lives outside App.jsx because it is the subtlest logic in the client and
// it was previously unreachable from tests: App forces demo mode under vitest,
// so every guard written as an inline closure went unexercised. The failures it
// prevents are not cosmetic — one renders one member's cases inside another
// member's session — so they need tests that can actually fail.
//
// Three separate problems, deliberately not conflated:
//
//   1. IDENTITY. Work started for member A must never commit under member B.
//      A generation counter is bumped on every genuine identity change (and
//      NOT on a token refresh, which would clear the screen hourly).
//   2. ORDER. Two loads can be in flight for ONE identity — the initial load
//      and the realtime gap refetch — and they finish in either order. The
//      older response must not overwrite the newer one.
//   3. GAPS. A realtime row that arrives while a load is in flight is not in
//      that load's snapshot, so committing the response verbatim would drop it.
export function createSessionGuard() {
  let generation = 0;
  let currentUserId = null;
  let requestSeq = 0;
  let lastCommitted = 0;
  // id -> row, for rows seen over realtime that a load may not know about yet.
  let pending = new Map();
  let pendingTaskMessages = new Map();
  let boardEventSeq = 0;
  let boardEvents = [];

  return {
    get generation() { return generation; },
    get currentUserId() { return currentUserId; },
    get pendingCount() { return pending.size; },
    get pendingTaskMessageCount() { return pendingTaskMessages.size; },

    // An operation spans multiple reads/writes without participating in the
    // projection ordering clock. Capture once, including for realtime callbacks.
    // wait checks both rejection and success; run silently discards superseded
    // work. Catch/finally handlers must assert before their own side effects.
    captureOperation(forUserId = currentUserId, startedGeneration = generation) {
      const superseded = new Error("Superseded member operation");
      const isCurrent = () => forUserId === currentUserId && startedGeneration === generation;
      const assertCurrent = () => { if (!isCurrent()) throw superseded; };
      return {
        userId: forUserId,
        generation: startedGeneration,
        isCurrent,
        assertCurrent,
        async wait(promise) {
          try { return await promise; } finally { assertCurrent(); }
        },
        async run(work) {
          try { assertCurrent(); const result = await work(); assertCurrent(); return result; }
          catch (error) { if (isCurrent()) throw error; return undefined; }
        },
      };
    },

    // Returns true when the identity actually changed, so the caller knows
    // whether to clear rendered data. A repeat call with the same user id — a
    // token refresh, or getSession resolving after onAuthStateChange already
    // fired — is a no-op.
    beginSession(nextUserId, { newSignIn = false } = {}) {
      if (nextUserId === currentUserId && !newSignIn) return false;
      generation += 1;
      currentUserId = nextUserId;
      requestSeq = 0;
      lastCommitted = 0;
      pending = new Map();
      pendingTaskMessages = new Map();
      boardEventSeq = 0;
      boardEvents = [];
      return true;
    },

    // A same-user token can still cross a security boundary (most importantly
    // aal2 -> aal1). Invalidate in-flight work without pretending the identity
    // changed, so an old assured response cannot repaint after downgrade.
    invalidateSecurityContext(forUserId) {
      if (!forUserId || forUserId !== currentUserId) return false;
      generation += 1;
      requestSeq = 0;
      lastCommitted = 0;
      pending = new Map();
      return true;
    },

    // Call BEFORE starting a load, with the user id that load is FOR. Returns
    // null when that identity is no longer current — which is the case a
    // generation read at call time cannot catch, because a stale caller would
    // read the NEW generation and sail through its own check.
    beginRequest(forUserId) {
      if (forUserId !== currentUserId) return null;
      requestSeq += 1;
      return { userId: forUserId, generation, requestId: requestSeq, boardEventSeq };
    },

    // Call after the await, with the ticket. Commits only if the identity still
    // holds and no newer request has already committed.
    canCommit(ticket) {
      if (!ticket) return false;
      if (ticket.generation !== generation) return false;
      if (ticket.userId !== currentUserId) return false;
      if (ticket.requestId <= lastCommitted) return false;
      lastCommitted = ticket.requestId;
      return true;
    },

    // Buffer unconditionally: if a load is in flight its snapshot predates this
    // row, and if data is still null there is nowhere to merge it yet. Dropping
    // it in either case loses the row, which is the gap the SUBSCRIBED refetch
    // exists to close.
    noteRealtimeRow(row) {
      if (!row?.id) return false;
      pending.set(row.id, row);
      return true;
    },

    noteRealtimeTaskMessage(row) {
      if (!row?.id) return false;
      pendingTaskMessages.set(row.id, row);
      return true;
    },

    noteRealtimeBoardEvent(event) {
      boardEventSeq += 1;
      boardEvents.push({ seq: boardEventSeq, event });
      return boardEventSeq;
    },

    boardEventsSince(ticket) {
      if (!ticket || ticket.generation !== generation || ticket.userId !== currentUserId) return [];
      const through = boardEventSeq;
      const result = boardEvents
        .filter((entry) => entry.seq > ticket.boardEventSeq && entry.seq <= through)
        .map((entry) => entry.event);
      // Once this committed snapshot has replayed through `through`, no older
      // request can commit over it (canCommit rejects older tickets).
      boardEvents = boardEvents.filter((entry) => entry.seq > through);
      return result;
    },

    // Fold buffered rows into a freshly loaded list. Rows the load already
    // knows about are retired from the buffer.
    mergeNotifications(notifications) {
      const list = Array.isArray(notifications) ? notifications : [];
      if (!pending.size) return list;
      const byId = new Map(list.map((row) => [row.id, row]));
      for (const [id, row] of [...pending]) {
        if (byId.has(id)) pending.delete(id);
        else byId.set(id, row);
      }
      return sortNewestFirst([...byId.values()]);
    },

    mergeTaskMessages(messages) {
      const list = Array.isArray(messages) ? messages : [];
      if (!pendingTaskMessages.size) return list;
      const byId = new Map(list.map((row) => [row.id, row]));
      for (const [id, row] of [...pendingTaskMessages]) {
        if (byId.has(id)) pendingTaskMessages.delete(id);
        else byId.set(id, row);
      }
      return sortOldestFirst([...byId.values()]);
    },
  };
}

export function needsAssuranceRefresh(previousSession, nextSession) {
  if (!nextSession?.user) return false;
  return (
    previousSession?.user?.id !== nextSession.user.id
    || previousSession?.access_token !== nextSession.access_token
  );
}

export function sessionAssuranceLevel(session) {
  const token = session?.access_token;
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload || typeof globalThis.atob !== "function") return null;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(globalThis.atob(padded))?.aal ?? null;
  } catch {
    return null;
  }
}

export function isAssuranceDowngrade(previousSession, nextSession) {
  if (!previousSession?.user || previousSession.user.id !== nextSession?.user?.id) return false;
  if (previousSession.access_token === nextSession.access_token) return false;
  return (
    sessionAssuranceLevel(previousSession) === "aal2"
    && sessionAssuranceLevel(nextSession) !== "aal2"
  );
}

// Commit order is not arrival order — an older transaction can commit after a
// newer one — so realtime rows are sorted rather than blindly prepended. A row
// with an unusable timestamp sorts last rather than poisoning the comparison.
export function sortNewestFirst(rows) {
  return [...rows].sort((a, b) => timeOf(b) - timeOf(a));
}

export function sortOldestFirst(rows) {
  return [...rows].sort((a, b) => timeOf(a) - timeOf(b));
}

function timeOf(row) {
  const value = Date.parse(row?.created_at ?? row?.createdAt ?? "");
  return Number.isNaN(value) ? 0 : value;
}

export function unreadCount(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => !row.read_at).length;
}
