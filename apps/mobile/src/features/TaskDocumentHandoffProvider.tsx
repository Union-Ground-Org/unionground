import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { useIsFocused } from 'expo-router';

import { canOpenFeature } from '../lib/featureCatalog';
import { sessionIDFromAccessToken } from '../lib/sessionLineage';
import { registerTaskAttachmentOwner, TaskCameraPermissionError, TaskDocumentHandoff, type TaskDocumentPhase } from '../lib/taskDocumentHandoff';
import { captureAuthorizedScan, cleanupAttachmentCandidate, pickAuthorizedDocument, type AttachmentCandidate } from '../services/attachments';
import { recordLifecycleEvent } from '../services/lifecycleDiagnostics';
import { useApp } from '../state/AppProvider';

const TaskDocumentContext = createContext<{
  store: TaskDocumentHandoff<AttachmentCandidate>;
  active: boolean;
} | null>(null);

/** Remains mounted above FeatureScreen's fail-closed bootstrap/role branches. */
export function TaskDocumentHandoffProvider({ children }: PropsWithChildren) {
  const { session, mode, privacyCovered, locked, dashboard, chapterMemberships, chapterRoles, organizationRoles } = useApp();
  const focused = useIsFocused();
  const [store] = useState(() => new TaskDocumentHandoff<AttachmentCandidate>(cleanupAttachmentCandidate, recordLifecycleEvent));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const sessionID = session ? sessionIDFromAccessToken(session.access_token) : null;
  const identity = session && sessionID ? `${session.user.id}:${sessionID}` : null;
  const chapterID = chapterMemberships.find((entry) => entry.selected)?.chapterID
    ?? dashboard?.member.chapterID ?? null;
  const phase: TaskDocumentPhase = !focused || !identity || mode === 'signedOut' || mode === 'mfaRequired' || mode === 'preview'
    ? 'denied'
    : mode === 'booting' || privacyCovered || locked
      ? 'checking'
      : canOpenFeature(mode, 'tasks', null, chapterRoles, organizationRoles) ? 'authorized' : 'denied';

  useEffect(() => { store.observe(identity, chapterID, phase); }, [store, identity, chapterID, phase]);
  useEffect(() => {
    const unregister = registerTaskAttachmentOwner(store);
    return () => { store.dispose(); unregister(); };
  }, [store]);
  // A newly rendered identity/scope cannot consume the previous effect's state.
  const active = phase === 'authorized' && snapshot.phase === 'authorized'
    && snapshot.identity === identity && snapshot.chapterID === chapterID;
  const value = useMemo(() => ({ store, active }), [store, active]);
  return <TaskDocumentContext.Provider value={value}>{children}</TaskDocumentContext.Provider>;
}

export function useTaskDocumentHandoff() {
  const context = useContext(TaskDocumentContext);
  // A fallback is used only when a feature is embedded outside its routed host.
  const [fallback] = useState(() => new TaskDocumentHandoff<AttachmentCandidate>(cleanupAttachmentCandidate, recordLifecycleEvent));
  const store = context?.store ?? fallback;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const active = context?.active === true;
  return {
    active,
    query: active ? snapshot.query : '',
    openTaskIDs: active ? snapshot.openTaskIDs : [],
    pending: active ? snapshot.pending : null,
    failed: active && snapshot.failed,
    failure: active ? snapshot.failure : null,
    discardedKind: active ? snapshot.discardedKind : null,
    store,
    scan: (taskID: string) => {
      if (!active) return;
      void store.choose(taskID, async (progress) => {
        const result = await captureAuthorizedScan({
          onPhase: progress,
        });
        if (result.status === 'permission-denied') throw new TaskCameraPermissionError(result.canAskAgain);
        return result.status === 'selected' ? result.candidate : null;
      }, 'scan');
    },
    choose: (taskID: string) => {
      if (!active) return;
      void store.choose(taskID, (progress) => pickAuthorizedDocument({
        onPhase: progress,
      }));
    },
  };
}
