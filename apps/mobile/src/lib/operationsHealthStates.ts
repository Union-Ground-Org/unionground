// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103 (audit
// MOB-ADMIN-12; #7001 gate round 1, r1s2 and r1g3): Operations health decides
// what its two panels say from the load itself, never from the derived job
// desk. buildJobHealthDesk returns the whole job catalog even with no recorded
// runs, so its length cannot tell loading, a failed read and "never run" apart.

import { nativeCatalogLabel, readableRecordKey, type NativeLanguage } from './nativeUiCopy';

export type OperationsLoadInput = {
  authorized: boolean;
  live: boolean;
  loading: boolean;
  // A failed read of the ledger and job health. An acknowledgement or retry
  // request that fails is a separate notice and never lands here.
  loadError: string | null;
};

export type OperationsPanelState = 'loading' | 'unavailable' | 'not_loaded' | 'ready';

export function operationsPanelState({ authorized, live, loading, loadError }: OperationsLoadInput): OperationsPanelState {
  if (!authorized || !live) return 'unavailable';
  if (loading) return 'loading';
  if (loadError) return 'not_loaded';
  return 'ready';
}

export function auditLedgerReason(state: OperationsPanelState): string | null {
  if (state === 'unavailable') return 'The audit ledger opens for an active organization administrator after two-step.';
  if (state === 'not_loaded') return 'The audit ledger could not be loaded. Try again below.';
  return null;
}

// BUG-UG-LEDGER-SAYS-KNOWLEDGE-FILE-UPLOADED-BEFORE-ANY-BYTES-ARRIVE-20261112
// (#8545): the knowledge_file_uploaded row is written when a steward library
// upload is prepared (reviewStatus pending_scan), before any bytes arrive or
// the scanner runs, and no later row records them. Same label as the web ledger.
const AUDIT_EVENTS: Readonly<Record<string, string>> = {
  analytics_snapshot_read: 'Analytics snapshot read',
  'message.react': 'Message reaction',
  'settings.changed': 'Settings changed',
  'case.status_changed': 'Issue status changed',
  knowledge_file_uploaded: 'Knowledge file uploaded',
};

export function auditEventLabel(eventType: string, reviewStatus: string | null, language: NativeLanguage = 'en'): string {
  const label = eventType === 'knowledge_file_uploaded' && reviewStatus === 'pending_scan'
    ? 'Knowledge file upload started'
    : Object.hasOwn(AUDIT_EVENTS, eventType) ? AUDIT_EVENTS[eventType]! : readableRecordKey(eventType) || 'Unknown meeting';
  return nativeCatalogLabel(language, label);
}

export function auditDomainLabel(domain: string, language: NativeLanguage): string {
  return nativeCatalogLabel(language, readableRecordKey(domain) || 'Unknown category');
}

// "No recent activity" is true only after a read that succeeded.
export function auditLedgerEmpty(state: OperationsPanelState, eventCount: number): boolean {
  return state === 'ready' && eventCount === 0;
}

export type JobsPanelMessage = { title: string; body: string } | null;

// The recorded-run count is the raw row count from list_organization_job_health,
// not the catalog: a successful read with no rows means no job has run yet.
export function jobsPanelMessage(state: OperationsPanelState, recordedRunRows: number): JobsPanelMessage {
  if (state === 'loading') return { title: 'Loading job health', body: 'Reading the scheduled work recorded for this organization.' };
  if (state === 'unavailable') return { title: 'Job health unavailable', body: 'Job health opens for an active organization administrator after two-step.' };
  if (state === 'not_loaded') return { title: 'Job health not loaded', body: 'Try again above. Nothing was changed.' };
  if (recordedRunRows === 0) return { title: 'No recorded runs yet', body: 'The scheduled jobs below appear with a status after their first recorded run.' };
  return null;
}

// Job cards are drawn only from a read that succeeded, so a pending or failed
// read never shows the catalog as if every job had simply never run.
export function showJobCards(state: OperationsPanelState): boolean {
  return state === 'ready';
}
