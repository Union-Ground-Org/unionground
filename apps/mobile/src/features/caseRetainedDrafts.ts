import { useEffect, useRef } from 'react';
import { defineRetainedSurface, type Held, type RetainedSurface } from '../lib/retainedDraft';
import { resumeDraftReadsConfirmed, retainedDraftKey, retireRetainedDraft, type ResumeScopeKind } from '../lib/resumeDraftHolder';
import { useApp } from '../state/AppProvider';
import { WriterSessionChanged } from '../../../../src/lib/sessionBoundWriter.js';
// The deadline kinds a retained deadline draft may carry.
type DeadlineKind = string;
import type { ContactDirection, ContactType } from '../services/coordinatorCaseWrites';

// #9240 pull request E (design R-9240D, row E): the case cards' unsent text
// waits in memory through a session check for the same person in the same
// place, hat and roles, keyed by the case. The case screen keys each card on
// its route-authorization generation (app/issue/[id].tsx, the R-9228 boundary),
// so a card always remounts and reads afresh; only the typed value waits here.
//
// Scope: organization, so a chapterless coordinator keeps a draft too. Any
// confirmed chapter or organization change, another account, another role or
// hat, sign-out and an MFA challenge still clear every entry (the holder).
export const CASE_DRAFT_SCOPE: ResumeScopeKind = 'organization';

// A keyed write's retry key, held with the text it was made for: a retry of
// the same payload after a lost reply reuses it, as before, also after the
// card remounted.
export type CaseRetry = { key: string; payload: string } | null;

export type CaseNoteDraft = { body: string };
export type CaseStepDraft = { nextStep: string; outcome: string; retry: CaseRetry };
export type CaseDeadlineDraft = { label: string; kind: DeadlineKind; dueAt: Date | null; reminderAt: Date | null };
export type CaseExtensionDraft = { deadlineID: string; date: Date | null; reason: string; retry: CaseRetry };
export type CoordinatorNoteDraft = { note: string };
export type CoordinatorContactDraft = { contactType: ContactType; direction: ContactDirection; contactedAt: Date | null; summary: string };
export type CoordinatorDeadlineDraft = { deadline: Date | null; reason: string };

export const caseNoteSurface = defineRetainedSurface<Held<CaseNoteDraft>>('case-steward-note');
export const caseStepSurface = defineRetainedSurface<Held<CaseStepDraft>>('case-step-advance');
export const caseDeadlineSurface = defineRetainedSurface<Held<CaseDeadlineDraft>>('case-deadline-add');
export const caseExtensionSurface = defineRetainedSurface<Held<CaseExtensionDraft>>('case-deadline-extension');
export const coordinatorNoteSurface = defineRetainedSurface<Held<CoordinatorNoteDraft>>('case-coordinator-note');
export const coordinatorContactSurface = defineRetainedSurface<Held<CoordinatorContactDraft>>('case-coordinator-contact');
export const coordinatorDeadlineSurface = defineRetainedSurface<Held<CoordinatorDeadlineDraft>>('case-coordinator-deadline');

const CASE_SURFACES: readonly RetainedSurface<unknown>[] = [
  caseNoteSurface, caseStepSurface, caseDeadlineSurface, caseExtensionSurface,
  coordinatorNoteSurface, coordinatorContactSurface, coordinatorDeadlineSurface,
];

type DraftContext = Parameters<typeof retainedDraftKey>[0];

// Loss of access to one case retires every held draft and attempt for it:
// the steward's assignment read answering that the case is not theirs, or a
// card's own case read refused (refused, or the case no longer visible).
export function retireCaseDrafts(context: DraftContext, caseID: string): void {
  for (const surface of CASE_SURFACES) retireRetainedDraft(retainedDraftKey(context, surface, caseID, CASE_DRAFT_SCOPE));
}

// A card's own case read that shows the case is no longer this person's to
// work: a permission refusal, or the case no longer visible. Two-step
// verification and password step-up are the provider's (an MFA challenge
// retires everything there); a lost or failed read keeps the draft concealed.
export function caseAccessLost(reason: string): boolean {
  return reason === 'refused' || reason === 'notFound';
}

// One case at a time (#9440 round 1): a case card shown for another case, in
// a confirmed scope, retires everything held for the case before it, so
// leaving a case for another and coming back starts blank. A session check,
// or the case list and back to the same case, keeps it.
let heldCase: { person: string; caseID: string } | null = null;
export function useCaseDraftOwner(caseID: string): void {
  const app = useApp();
  const context = useRef(app);
  context.current = app;
  const person = app.mode === 'authenticated' && resumeDraftReadsConfirmed(app) ? app.session?.user.id ?? null : null;
  useEffect(() => {
    if (!person) return;
    if (heldCase && heldCase.person === person && heldCase.caseID !== caseID) retireCaseDrafts(context.current, heldCase.caseID);
    heldCase = { person, caseID };
  }, [person, caseID]);
}

// Whether an unkeyed case write that failed is known not to have been saved
// (#9440 round 1; its successor, after Sol's final): only the
// WriterSessionChanged object the session writer itself throws before it
// sends anything (src/lib/sessionBoundWriter.js), never an answer that merely
// carries its 'writer_session_changed' marker, a mapped code (a bare 22023 or
// 42501) or mapped text: a gateway can answer with any of those after the
// write committed. The card checks its input before it begins an attempt, so
// the service's own checks never refuse a write in flight. Everything else
// (no answer, the 20-second deadline, any answer) may have saved: the form
// stays locked as unconfirmed, with Save again and Discard, and nothing is
// sent again on its own.
export function caseWriteRefusedBeforeSending(error: unknown): boolean {
  return error instanceof WriterSessionChanged;
}

// #9443 round 1: a pre-send refusal proves only that THIS attempt was not
// sent. A first attempt that is still unconfirmed may have committed, so a
// refused Save again keeps the lock (the holder keeps an unknown outcome
// unknown) and names the refusal beside Save again and Discard; only a
// confirmed save or Discard releases it. A refused first attempt comes back
// editable.
export const CASE_RETRY_REFUSED = 'retry-refused';
export function caseRefusalOutcome(retrying: boolean): { failed: string } {
  return { failed: retrying ? CASE_RETRY_REFUSED : 'failed' };
}
