import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { TaskDiscussion } from '../lib/taskDiscussions';
import { loadMyTaskDiscussions } from '../services/livedIn';

export type TaskDiscussionsState = { items: TaskDiscussion[]; failed: boolean };

// The Messages tab's task discussions, kept fresh the way its conversations
// are (AppProvider's conversation poller): read on open, again on every
// interval tick while the app is active, at once when it returns to the
// foreground, and on a manual refresh (reloadKey). A failed read keeps the last
// good list; `failed` is shown only while there is nothing to show
// (BUG-UG-NATIVE-CASE-ROWS-AND-TASK-TITLES-DO-NOT-OPEN-20261111, gate
// G6-8264-1: a first incoming discussion stayed absent until a manual refresh).
const NONE: TaskDiscussionsState = { items: [], failed: false };

// `scope` is taskDiscussionScope(...): null while signed out or reloading. A
// list is shown only for the scope it was read for, so after a chapter switch
// no title or preview from the old chapter renders, not even for the one render
// before the reset, and a read that was still in flight for the old scope is
// dropped (gate G6-8264 FINAL P1).
//
// `connected` is the device network signal the conversation poller reads
// (lowData.signals.connected !== false). While it is false the interval and
// foreground reads are skipped, as the conversation poller skips its ticks;
// opening the tab and a manual refresh still read, and one read catches up when
// the device reconnects
// (A11Y-UG-FOCUS-AND-ACCESSIBLE-NAME-GAPS-FROM-REVIEWS-20261117).
export function useTaskDiscussions(scope: string | null, reloadKey: number, pollIntervalMs: number, connected = true): TaskDiscussionsState {
  const [state, setState] = useState<TaskDiscussionsState & { scope: string | null }>({ scope: null, ...NONE });
  const connectedRef = useRef(connected);
  const catchUpRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (scope === null) {
      setState({ scope: null, ...NONE });
      return undefined;
    }
    let current = true;
    // One read at a time per effect; a manual refresh or a new scope starts a
    // new effect, so it is never swallowed by a tick still in flight.
    let inFlight = false;
    const load = () => {
      if (inFlight) return;
      inFlight = true;
      void loadMyTaskDiscussions().then(
        (items) => { if (current) setState({ scope, items, failed: false }); },
        () => { if (current) setState((previous) => ({ scope, items: previous.scope === scope ? previous.items : [], failed: true })); },
      ).finally(() => { inFlight = false; });
    };
    const poll = () => { if (connectedRef.current) load(); };
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (timer === null && pollIntervalMs > 0) timer = setInterval(poll, pollIntervalMs); };
    const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
    load();
    if (AppState.currentState === 'active') start();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') { poll(); start(); } else stop();
    });
    catchUpRef.current = () => { if (AppState.currentState === 'active') load(); };
    return () => {
      current = false;
      catchUpRef.current = null;
      stop();
      subscription.remove();
    };
  }, [scope, reloadKey, pollIntervalMs]);
  // Reconnecting reads once at once rather than waiting for the next tick.
  useEffect(() => {
    const reconnected = connected && !connectedRef.current;
    connectedRef.current = connected;
    if (reconnected) catchUpRef.current?.();
  }, [connected]);
  return scope !== null && state.scope === scope ? state : NONE;
}
