import { useSyncExternalStore } from 'react';
import type { NativeUiKey } from '../lib/nativeUiCopy';
import type { NoticeAudience, NoticeLocale } from '../services/stewardDeskSections';

export type NoticeAttempt = { title: string; body: string; locale: NoticeLocale; operationKey: string; warning?: NativeUiKey };
type NoticeWork = { title: string; body: string; locale: NoticeLocale; postingRole: string | null; organizationID?: string | null };
type NoticeLogin = { userID: string; isCurrent: () => boolean };
type HeldSend = NoticeWork & {
  owner: string;
  login: NoticeLogin;
  ticket: object;
  audience: NoticeAudience;
  attempt: NoticeAttempt | null;
  // An attempt was dispatched and its outcome is unknown. Holding an
  // operation key is not that fact: a key kept from a try that was never
  // dispatched proves nothing was published (gate r1s2/r2s2 of #9361).
  outcomeUnknown: boolean;
  busy: boolean;
  confirmed: boolean;
  alreadyPosted: boolean;
  retryError: NativeUiKey | null;
  error: NativeUiKey | null;
};

// Only attempted sends live here, in memory, across route unmounts (#9258).
// The owner includes the composing account and chapter; the original login
// guard also binds every ticket through token refresh, never a later login. The exact
// audience travels with the key; a remount never substitutes its first option.
// No persistence, analytics or content matching: identical new notices remain
// distinct operations after confirmation or an explicit Cancel.
// Held sends are not retired by role or grant views or by read refusals;
// this departs from resume-draft retirement on purpose. Only this composing
// login can see its memory-only work, after fresh reads; no content is logged.
const sends = new Map<string, HeldSend>();
const retirements = new Map<string, number>();
const listeners = new Set<() => void>();
function changed() { for (const listener of listeners) listener(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function readPendingNoticeSend(owner: string) {
  const held = sends.get(owner);
  return held?.login.isCurrent() ? held : null;
}
export function noticeSendIsCurrent(held: HeldSend): boolean {
  return held.login.isCurrent() && sends.get(held.owner)?.ticket === held.ticket;
}
export function useNoticeSendRetirement(owner: string) {
  return useSyncExternalStore(subscribe, () => retirements.get(owner) ?? 0, () => 0);
}
function retired(owner: string) { retirements.set(owner, (retirements.get(owner) ?? 0) + 1); }
// The provider calls these silently during render, before any composer reads.
// Only login loss, confirmed departure and explicit consumption retire sends;
// a read refusal retires resume drafts alone.
export function retirePendingNoticeSends(userID: string, notify = true): void {
  for (const [owner, held] of sends) if (held.login.userID === userID) { sends.delete(owner); retired(owner); }
  if (notify) changed();
}
export function retireInvalidNoticeSends(): { userID: string; chapterID: string }[] {
  const removed: { userID: string; chapterID: string }[] = [];
  for (const [owner, held] of sends) {
    if (held.login.isCurrent()) continue;
    sends.delete(owner); retired(owner); removed.push({ userID: held.login.userID, chapterID: held.audience.chapterId });
  }
  return removed;
}
export function retireDepartedNoticeSends(userID: string, memberships: readonly { chapterID: string; organizationID?: string | null }[], onDeparture?: (chapters: readonly string[]) => void): string[] {
  const departed = new Set<string>();
  for (const [owner, held] of sends) {
    if (held.login.userID !== userID) continue;
    const chapterLeft = !memberships.some(row => row.chapterID === held.audience.chapterId);
    const organizationLeft = Boolean(held.organizationID) && memberships.every(row => row.organizationID != null)
      && !memberships.some(row => row.organizationID === held.organizationID);
    if (!chapterLeft && !organizationLeft) continue;
    sends.delete(owner); retired(owner); departed.add(held.audience.chapterId);
  }
  const chapters = [...departed];
  if (chapters.length && onDeparture) { onDeparture(chapters); changed(); }
  return chapters;
}
export function usePendingNoticeSend(owner: string) {
  return useSyncExternalStore(subscribe, () => readPendingNoticeSend(owner), () => null);
}

export function beginNoticeSend(owner: string, work: NoticeWork, audience: NoticeAudience, attempt: NoticeAttempt | null, login: NoticeLogin): HeldSend | null {
  const previous = readPendingNoticeSend(owner);
  if (!owner || !login.isCurrent() || (previous && (previous.busy || previous.confirmed || !attempt
    || previous.attempt?.operationKey !== attempt.operationKey))) return null;
  const held: HeldSend = previous ? { ...previous, ticket: {}, busy: true, retryError: null }
    : { ...work, owner, login, ticket: {}, audience, attempt, outcomeUnknown: false, busy: true, confirmed: false, alreadyPosted: false, retryError: null, error: null };
  sends.set(owner, held);
  changed();
  return held;
}

export function updateNoticeSend(held: HeldSend, patch: Partial<Pick<HeldSend, 'attempt' | 'outcomeUnknown' | 'busy' | 'confirmed' | 'alreadyPosted' | 'retryError' | 'error'>>) {
  const current = sends.get(held.owner);
  // An inactive original login may retain its own uncertain outcome, never
  // confirm it. This cannot authorize a replacement login: reads, retries and
  // consumption require the original guard, and provider retirement removes
  // this exact ticket before a replacement scope can use either holder.
  if (current?.ticket !== held.ticket || (patch.confirmed && !held.login.isCurrent())) return;
  sends.set(held.owner, { ...current, ...patch });
  changed();
}

// #9417 gate r1s1/r2s1: the own-text panel (#9369) discards a notice through
// the resume holder, so it must settle this holder too, by the exact operation
// key the composer gave the attempt. A busy ticket is never retired here: the
// composer's own Cancel refuses while a request is in flight, and so does the
// panel. A key that matches nothing retires nothing.
export type NoticeSendOwnTextState = { busy: boolean; outcomeUnknown: boolean; confirmed: boolean };
export function noticeSendOwnTextState(userID: string, chapterID: string | null, operationKey: string | null): NoticeSendOwnTextState | null {
  if (!operationKey || !chapterID) return null;
  const held = readPendingNoticeSend(`${userID}|${chapterID}`);
  if (!held || held.attempt?.operationKey !== operationKey) return null;
  return { busy: held.busy, outcomeUnknown: held.outcomeUnknown, confirmed: held.confirmed };
}
export function retireNoticeSendForOwnTextDiscard(userID: string, chapterID: string | null, operationKey: string | null): boolean {
  if (!operationKey || !chapterID) return true;
  const owner = `${userID}|${chapterID}`;
  const held = readPendingNoticeSend(owner);
  if (!held || held.attempt?.operationKey !== operationKey) return true;
  if (held.busy) return false;
  return forgetNoticeSend(owner, held.ticket, true);
}

export function forgetNoticeSend(owner: string, ticket: object, discard = false): boolean {
  const held = readPendingNoticeSend(owner);
  if (!held || held.ticket !== ticket) return false;
  sends.delete(owner);
  if (discard) retired(owner);
  changed();
  return true;
}
