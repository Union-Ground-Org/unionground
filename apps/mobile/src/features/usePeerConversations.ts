import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import type { PeerConversation } from '../lib/peerConversations';
import { LOW_DATA_POLL_INTERVAL_MS } from '../lib/lowDataPolicy';
import { loadMyPeerConversations, subscribePeerConversations } from '../services/peerConversations';
import { getSupabaseClient, watchMemberNotificationInserts } from '../services/supabase';

export type PeerConversationsState = { items: PeerConversation[]; failed: boolean };

const NONE: PeerConversationsState = { items: [], failed: false };

// The Messages tab's private two-person conversations (#9162), kept fresh the
// way useTaskDiscussions keeps task discussions, plus recipient notice INSERTs
// and foreground pushes: read on open, on every poll tick while the app is
// active and the device is connected, at once on return
// to the foreground or on reconnect, on a manual refresh (reloadKey), and
// after a send from the conversation screen. A failed read keeps the last good
// list. `scope` is taskDiscussionScope(...): a list is shown only for the
// person, organization and chapter it was read for, and a read still in flight
// for an old scope is dropped. Nothing is written to device storage.
export function usePeerConversations(scope: string | null, reloadKey: number, pollIntervalMs: number, connected = true): PeerConversationsState {
  const [state, setState] = useState<PeerConversationsState & { scope: string | null }>({ scope: null, ...NONE });
  useEffect(() => {
    if (scope === null) {
      setState({ scope: null, ...NONE });
      return undefined;
    }
    let current = true;
    let inFlight = false;
    let again = false;
    let activityGeneration = 0;
    let socketRetired = false;
    // AppProvider can ignore a staged/native auth event and keep this scope.
    // Retire its socket, not Main's poll. After retirement, only reads whose
    // session still belongs to this scope may run or publish.
    const [userID] = JSON.parse(scope) as [string, string | null, string];
    const ownsScope = async () => {
      if (!socketRetired) return true;
      try {
        const result = await getSupabaseClient()?.auth.getSession();
        return !result?.error && result?.data.session?.user.id === userID;
      } catch {
        return false; // swallow-ok: an unconfirmed scope skips this poll; the timer remains available for recovery
      }
    };
    const load = () => {
      if (!current || AppState.currentState !== 'active' || !connected) return;
      if (inFlight) { again = true; return; }
      inFlight = true;
      const generation = activityGeneration;
      const canPublish = () => current && generation === activityGeneration && AppState.currentState === 'active';
      void (async () => {
        if (!await ownsScope() || !canPublish()) return;
        try {
          const items = await loadMyPeerConversations();
          if (await ownsScope() && canPublish()) setState({ scope, items, failed: false });
        } catch {
          if (await ownsScope() && canPublish()) setState((previous) => ({ scope, items: previous.scope === scope ? previous.items : [], failed: true }));
        }
      })().finally(() => {
        inFlight = false;
        // A send while a read was in flight reads once more, so the list
        // never settles on the answer from before the send.
        if (again && current) { again = false; load(); }
      });
    };
    const poll = load;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (timer === null && pollIntervalMs > 0) timer = setInterval(poll, pollIntervalMs); };
    const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
    const notices = watchMemberNotificationInserts(userID, load, () => {
      socketRetired = true;
      activityGeneration += 1;
      again = false;
    });
    // AppProvider supplies 120 seconds in Low data (30 seconds otherwise).
    // Honour that same policy without opening a second native network monitor.
    const syncNotices = () => notices.setActive(AppState.currentState === 'active' && connected && pollIntervalMs < LOW_DATA_POLL_INTERVAL_MS);
    syncNotices();
    // Push remains optional and generic. Its payload is deliberately ignored.
    let push: { remove(): void } | null = null;
    void import('expo-notifications').then((notifications) => {
      if (!current) return;
      push = notifications.addNotificationReceivedListener(() => {
        if (notices.isCurrent()) load();
      });
    }).catch(() => undefined); // swallow-ok: push is optional; realtime and polling remain available
    load();
    if (AppState.currentState === 'active') start();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') { poll(); if (current) start(); } else {
        activityGeneration += 1;
        again = false;
        stop();
      }
      syncNotices();
    });
    const unsubscribe = subscribePeerConversations(load);
    return () => {
      current = false;
      stop();
      subscription.remove();
      unsubscribe();
      push?.remove();
      notices.remove();
    };
  }, [scope, reloadKey, pollIntervalMs, connected]);
  return scope !== null && state.scope === scope ? state : NONE;
}
