import * as Crypto from 'expo-crypto';
import { useCallback, useSyncExternalStore } from 'react';
import { isAuthoritativeReadRefusal } from './readRefusal';
import {
  readRetainedDraft, resumeDraftReadsConfirmed, resumeDraftReadsFailed, retainedDraftScopeIsActive, retireRetainedDraft, settleRetainedDraft,
  subscribeResumeDrafts, useRetainedDraftKey, writeRetainedDraft,
  type RetainedDraftEntry, type RetainedSurface, type ResumeScopeKind, type ResumeDraftReadFailure,
} from './resumeDraftHolder';
import { useApp } from '../state/AppProvider';

export { defineRetainedSurface, type RetainedSurface } from './resumeDraftHolder';

// #9240 PR A (design R-9240D): one hook for every remaining phone editor. A
// screen keeps its normal unmount and fresh read through a session check; only
// the typed, unsent value waits in memory (never on disk) for the same person
// in the same scope. The holder decides scope and retirement; this hook adds
// what each editor used to repeat: concealment until the editor's own read is
// back, one attempt at a time, and the three outcomes of a write.

export type RetainedDraftOptions<T> = {
  surface: RetainedSurface<Held<T>>;
  item: string;
  empty: T;
  // The editor's own read for this item succeeded since this mount.
  fresh: boolean;
  scope?: ResumeScopeKind;
  // The server revision the draft is typed against, when there is one.
  basis?: string | null;
};
export type RetainedPending = false | 'sending' | 'uncertain';
export type RetainedDraft<T> = {
  // false: render the editor's loading state, with no inputs and no held text.
  shown: boolean;
  // Concealed because a session read failed (#9459 M1-21): say so, offer Try again.
  checkFailed: boolean;
  value: T;
  // Ignored while concealed, sending or uncertain.
  set(patch: Partial<T> | ((value: T) => T)): void;
  // Works in every shown state but sending: a send in flight is decided by its
  // own answer. An adopter whose write can hang (a network call without a
  // deadline) must not refuse Discard while sending: give it a deadline first.
  discard(): void;
  // The basis changed since typing: the text stays; the editor says so.
  stale: boolean;
  pending: RetainedPending;
  // The copy key of a definite failure, for the editor's own message. After an
  // unknown outcome it is the latest retry's failure, shown beside the warning.
  failed: string | null;
  // null while concealed, sending or empty. From 'uncertain' it is the
  // deliberate retry and carries the same attempt key.
  begin(): RetainedAttempt<T> | null;
  refused(error: unknown): void;
};
export type RetainedOutcome = 'done' | 'uncertain' | { failed: string };
export type RetainedAttempt<T> = {
  value: T;
  key: string;
  // Works after unmount; a no-op once the scope or the draft has retired.
  settle(outcome: RetainedOutcome): boolean;
};

// What the holder keeps for one editor item.
export type Held<T> = { value: T; uncertain: boolean; failed: string | null; attempt: string | null; basis: string | null };

const INACTIVE: unique symbol = Symbol('inactive');
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function useRetainedDraft<T>({ surface, item, empty, fresh, scope = 'chapter', basis }: RetainedDraftOptions<T>): RetainedDraft<T> {
  const app = useApp();
  const key = useRetainedDraftKey(app, surface, item, scope);
  const snapshot = useCallback(() => (retainedDraftScopeIsActive(key) ? readRetainedDraft(key) : INACTIVE), [key]);
  const read = useSyncExternalStore(subscribeResumeDrafts, snapshot, (): typeof INACTIVE => INACTIVE);
  const shown = read !== INACTIVE && fresh && resumeDraftReadsConfirmed(app);
  const failure = useSyncExternalStore(subscribeResumeDrafts, resumeDraftReadsFailed, (): ResumeDraftReadFailure => false);
  const checkFailed = (failure === 'no-answer' || failure === 'answered') && !resumeDraftReadsConfirmed(app);
  const entry = shown ? read : null;
  const pending: RetainedPending = entry?.pending ? 'sending' : entry?.value.uncertain ? 'uncertain' : false;
  const value = entry?.value.value ?? empty;

  function current(): RetainedDraftEntry<Held<T>> | null {
    return shown ? readRetainedDraft(key) : null;
  }
  function set(patch: Partial<T> | ((previous: T) => T)) {
    const held = current();
    if (!shown || held?.pending || held?.value.uncertain) return;
    const previous = held?.value.value ?? empty;
    const next = typeof patch === 'function' ? patch(previous) : { ...previous, ...patch };
    if (same(next, empty)) { retireRetainedDraft(key); return; }
    writeRetainedDraft(key, { value: next, uncertain: false, failed: null, attempt: null, basis: held ? held.value.basis : basis ?? null });
  }
  function discard() {
    if (!shown || current()?.pending) return;
    retireRetainedDraft(key);
  }
  function begin(): RetainedAttempt<T> | null {
    const held = current();
    if (!held || held.pending || same(held.value.value, empty)) return null;
    const attempt = held.value.uncertain && held.value.attempt ? held.value.attempt : Crypto.randomUUID();
    const ticket = writeRetainedDraft(key, { ...held.value, failed: null, attempt }, true);
    if (!ticket) return null;
    return {
      value: ticket.value.value,
      key: attempt,
      settle(outcome) {
        if (outcome === 'done') return settleRetainedDraft(ticket, null);
        if (outcome === 'uncertain') return settleRetainedDraft(ticket, { ...ticket.value, uncertain: true, failed: null, attempt });
        // A definite failure of a retry (a 429, a 5xx, a timeout, a refusal
        // made before the server's duplicate check) does not prove the first
        // attempt did not land: an unknown outcome stays unknown, locked, with
        // its key. Only 'done' for that key, Discard or a retirement clear it.
        const unknown = ticket.value.uncertain;
        return settleRetainedDraft(ticket, { ...ticket.value, uncertain: unknown, failed: outcome.failed, attempt: unknown ? attempt : null });
      },
    };
  }
  function refused(error: unknown) {
    if (isAuthoritativeReadRefusal(error)) retireRetainedDraft(key);
  }
  const stale = entry !== null && basis !== undefined && entry.value.basis !== (basis ?? null);
  return { shown, checkFailed, value, set, discard, stale, pending, failed: entry?.value.failed ?? null, begin, refused };
}
