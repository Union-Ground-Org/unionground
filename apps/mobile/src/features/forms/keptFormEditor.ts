import { useMemo, useRef } from 'react';

// The open Forms editor, kept across a return to the foreground (#8724, gate
// stage 172 r1s1 and r2s1). Every return re-checks the session: the app goes
// to booting and drops the dashboard, so FeatureScreen's gates unmount the
// Forms screen and a new one mounts once the dashboard is back. The feature
// route stays mounted through that, so it keeps the editor here and the new
// Forms screen takes it back.
//
// The editor is kept for one member in one settled scope (the dashboard
// member, organization, selected chapter and roles once the app is
// authenticated again). It is dropped on sign-out, on any mode other than
// authenticated or the temporary booting (a refused resume lands on
// mfaRequired), for a different member, and when the settled scope differs.
//
// A save, signature or submission that was running when its screen unmounted
// still finishes there (gate stage 176, r3s1 and r4s1). Its changes to the
// editor and its notice are relayed to the kept editor, or to the screen
// mounted now, and until it ends that screen starts no save of its own. A
// drop starts a new lineage: work from before it reaches nothing, so a save
// from before a sign-out never lands in the next sign-in's editor.
export type KeptFormEditor<T, N> = {
  read: () => T | null;
  write: (editing: T | null) => void;
  // The lineage a screen belongs to, read when it mounts.
  lineage: () => number;
  // From the screen that started the work, once it has unmounted.
  relay: (lineage: number, ownerID: string, update: (editing: T | null) => T | null) => void;
  relayNotice: (lineage: number, ownerID: string, notice: N) => void;
  // A notice relayed while no screen was mounted, taken once.
  takeNotice: (ownerID: string) => N | null;
  // Marks work running for the member; the returned function ends it.
  hold: (ownerID: string) => () => void;
  busy: (ownerID: string) => boolean;
  // The mounted screen; returns its unsubscribe.
  listen: (ownerID: string, listener: KeptFormListener<T, N>) => () => void;
};

export type KeptFormListener<T, N> = {
  update: (update: (editing: T | null) => T | null) => void;
  notice: (notice: N) => void;
  // The member's last held work ended.
  idle: () => void;
};

type Kept<T> = { ownerID: string; scope: string; editing: T };
type Store<T, N> = {
  kept: Kept<T> | null;
  notice: { ownerID: string; notice: N } | null;
  lineage: number;
  // Who the lineage belongs to, kept apart from the editor, which a screen
  // can clear: the member while signed in (null otherwise) and the last scope
  // the app settled on for them.
  identity: string | null;
  scope: string | null;
  holds: Map<number, { ownerID: string; lineage: number }>;
  nextHold: number;
  listener: { ownerID: string; listener: KeptFormListener<T, N> } | null;
};

export function useKeptFormEditor<T, N>(ownerID: string | null, mode: string, settledScope: string | null): KeptFormEditor<T, N> {
  const store = useRef<Store<T, N>>({ kept: null, notice: null, lineage: 0, identity: null, scope: null, holds: new Map(), nextHold: 0, listener: null });

  // Retired here, while the route renders and before any Forms screen it
  // renders mounts, so that screen always takes the new lineage (gate stage
  // 179, r5s1 and r6s2). It follows the member and the settled scope, never
  // the kept editor: a screen that clears its editor must not hide a change.
  // The same values leave everything as it is, so a repeated render is safe.
  const state = store.current;
  const identity = ownerID && (mode === 'authenticated' || mode === 'booting') ? ownerID : null;
  if (identity !== state.identity || (settledScope !== null && state.scope !== null && settledScope !== state.scope)) {
    state.kept = null;
    state.notice = null;
    state.lineage += 1;
    state.identity = identity;
    state.scope = null;
  }
  if (identity !== null && settledScope !== null) state.scope = settledScope;

  return useMemo(() => {
    const current = store.current;
    const listenerFor = (owner: string) => (current.listener?.ownerID === owner ? current.listener.listener : null);
    const held = (owner: string) => [...current.holds.values()].some((hold) => hold.ownerID === owner && hold.lineage === current.lineage);
    return {
      // Only for the same member in the same settled scope, so a screen that
      // mounts before the effect above drops a torn-down editor never takes it.
      read: () => {
        const entry = current.kept;
        return entry && ownerID && settledScope !== null && entry.ownerID === ownerID && entry.scope === settledScope ? entry.editing : null;
      },
      write: (editing) => {
        current.kept = editing !== null && ownerID && settledScope !== null ? { ownerID, scope: settledScope, editing } : null;
      },
      lineage: () => current.lineage,
      relay: (lineage, owner, update) => {
        if (lineage !== current.lineage) return;
        const listener = listenerFor(owner);
        if (listener) {
          listener.update(update);
          return;
        }
        const entry = current.kept;
        if (!entry || entry.ownerID !== owner) return;
        const next = update(entry.editing);
        current.kept = next === null ? null : { ...entry, editing: next };
      },
      relayNotice: (lineage, owner, notice) => {
        if (lineage !== current.lineage) return;
        const listener = listenerFor(owner);
        // Kept even when the same work just closed the editor (a submission).
        if (listener) listener.notice(notice);
        else current.notice = { ownerID: owner, notice };
      },
      takeNotice: (owner) => {
        const kept = current.notice;
        current.notice = null;
        return kept && kept.ownerID === owner ? kept.notice : null;
      },
      hold: (owner) => {
        const id = current.nextHold += 1;
        const lineage = current.lineage;
        current.holds.set(id, { ownerID: owner, lineage });
        return () => {
          if (!current.holds.delete(id) || lineage !== current.lineage) return;
          if (!held(owner)) listenerFor(owner)?.idle();
        };
      },
      busy: held,
      listen: (owner, listener) => {
        const entry = { ownerID: owner, listener };
        current.listener = entry;
        return () => { if (current.listener === entry) current.listener = null; };
      },
    };
  }, [ownerID, settledScope]);
}
