// Unsent connected-record message drafts (the "Message…" composer in the
// record actions sheet), kept in memory only so a draft survives closing the
// sheet or leaving the screen and coming back
// (BUG-UG-NATIVE-IOS-TASK-DISCUSSION-KEYBOARD-COVERS-SEND-20261111).
// Drafts belong to the signed-in scope that wrote them (the sheet's scopeKey:
// user, organization, chapter and roles); a new scope drops them all, nothing
// is written to disk, and a sheet without a scope keeps none.
import type { ConnectedSourceRef } from './connectedWorkflows';

const MAX_DRAFTS = 20;
const drafts = new Map<string, string>();
let draftScope: string | null = null;

function draftKey(reference: Pick<ConnectedSourceRef, 'kind' | 'id'>): string {
  return `${reference.kind}:${reference.id}`;
}

function inScope(scope: string | undefined): boolean {
  if (!scope) return false;
  if (draftScope !== scope) {
    drafts.clear();
    draftScope = scope;
  }
  return true;
}

export function readUnsentDraft(scope: string | undefined, reference: Pick<ConnectedSourceRef, 'kind' | 'id'>): string {
  return inScope(scope) ? drafts.get(draftKey(reference)) ?? '' : '';
}

export function keepUnsentDraft(scope: string | undefined, reference: Pick<ConnectedSourceRef, 'kind' | 'id'>, text: string): void {
  if (!inScope(scope)) return;
  const key = draftKey(reference);
  drafts.delete(key);
  if (!text.trim()) return;
  drafts.set(key, text);
  while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value as string);
}

export function clearUnsentDraft(scope: string | undefined, reference: Pick<ConnectedSourceRef, 'kind' | 'id'>): void {
  if (inScope(scope)) drafts.delete(draftKey(reference));
}
