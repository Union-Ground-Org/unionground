import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { MeetingDraft } from './chapterMeeting';
import type { NativeUiKey } from './nativeUiCopy';
import type { ChannelSetting } from './channelControlsShared';
import { heldWorkText, NO_DISPATCH, type HeldDispatch, type HeldWorkText } from './heldWorkText';
import { ReadDeadlineError } from './readDeadline';
import { isAuthoritativeReadRefusal } from './readRefusal';
import { noticeSendOwnTextState, retireInvalidNoticeSends, retireDepartedNoticeSends, retireNoticeSendForOwnTextDiscard, retirePendingNoticeSends } from '../features/noticePendingSend';

// #9240 part 2: only unsent work survives a foreground session check. The
// screens, their context, access gates and fresh reads keep their normal life.
export type MeetingResumeDraft = {
  draft: MeetingDraft;
  defaults: Pick<MeetingDraft, 'startsAt' | 'lengthMinutes' | 'checkIn'>;
  identity: { id: string; code: string; uncertain: boolean } | null;
  warning: NativeUiKey | null;
};
export type NoticeResumeAttempt = { title: string; body: string; locale: 'en' | 'es'; operationKey: string; warning?: NativeUiKey };
export type NoticeResumeDraft = {
  title: string; body: string; locale: 'en' | 'es'; audienceValue: string;
  attempt: NoticeResumeAttempt | null; warning: NativeUiKey | null;
};
export type InvitationResumeDraft = { fullName: string; email: string; locale: 'en' | 'es'; notice: { code: string; retryAt: string | null } | null };
export type WorkflowResumeDraft = { body: string; selected: string[]; open: boolean; attempt: { payload: string; id: string } | null };
export type ReminderResumeDraft = { open: boolean; date: number; chosen: boolean; note: string; step: null | 'date' | 'time' | 'datetime' };
export type ContactResumeDraft = { open: boolean; editing: boolean; picked: string | null; optIn: boolean | null; organizerID: string | null; version: number | null };
type Drafts = { meeting: MeetingResumeDraft; notice: NoticeResumeDraft; invitation: InvitationResumeDraft;
  workflow: WorkflowResumeDraft; workflowSend: { failed: boolean };
  workflowReminder: ReminderResumeDraft; workflowReminderSend: { failed: boolean; saved: boolean };
  workflowContact: ContactResumeDraft; workflowContactSend: { kind: 'organizer' | 'contact'; failed: boolean; saved: boolean };
  // attempted: a keyword save was dispatched and its answer was lost (ledger
  // 680); keywordOperation: which channel operation a send entry belongs to,
  // so a mute or level receipt never hides a typed keyword (ledger 679).
  channelSettings: { keyword: string; duration: string; attempted?: boolean };
  channelSettingSend: { failed: boolean; saved: Required<ChannelSetting> | null; keywordOperation?: boolean; outcomeUnknown?: boolean } };
type Surface = keyof Drafts;
// #9240 PR A: a new editor names its own surface with a typed token instead of
// adding a field to Drafts. Token entries share the map, the scope checks and
// every retirement below; the identity check in readEntry keeps two
// tokens apart even if they share a name.
declare const retainedValue: unique symbol;
export type RetainedSurface<T> = { readonly name: string; readonly [retainedValue]?: T };
// Each token gets its own storage id, so two tokens with one name never share,
// overwrite or block an entry (#9375 r2s3). Memory only: nothing was ever
// stored under an older id form outside this running app.
let surfaces = 0;
export function defineRetainedSurface<T>(name: string): RetainedSurface<T> {
  surfaces += 1;
  return Object.freeze({ name: `retained:${name}#${surfaces}` }) as RetainedSurface<T>;
}
// 'chapter' is the original key. 'organization' keeps the organization and
// drops the chapter slot; 'platform' keeps only the person and roles. Both
// still carry every role set and the chosen hat, and a confirmed chapter or
// organization change clears every kind.
export type ResumeScopeKind = 'chapter' | 'organization' | 'platform';
const SCOPE_KINDS: readonly ResumeScopeKind[] = ['chapter', 'organization', 'platform'];
export type ResumeDraftReads = { dashboard: boolean; memberships: boolean; staff: boolean };
type DraftContext = {
  mode: string;
  session: { user: { id: string } } | null;
  organizationID: string | null;
  dashboard?: { member: { chapterID?: string | null } } | null;
  chapterMemberships?: readonly { chapterID: string; organizationID?: string | null; selected: boolean }[];
  authorizedRoles?: readonly string[];
  chapterRoles?: readonly string[];
  organizationRoles?: readonly string[];
  chosenStaffRole?: string | null;
  assuranceUnavailable?: boolean;
  refreshing?: boolean;
  resumeDraftReads?: ResumeDraftReads;
};
export type ResumeDraftKey<S extends Surface> = { id: string; scope: string; surface: S };
export type ResumeDraftEntry<S extends Surface> = { key: ResumeDraftKey<S>; value: Drafts[S]; pending: boolean };
export type RetainedDraftKey<T> = { id: string; scope: string; surface: RetainedSurface<T> };
export type RetainedDraftEntry<T> = { key: RetainedDraftKey<T>; value: T; pending: boolean };
type Entry = ResumeDraftEntry<'meeting'> | ResumeDraftEntry<'notice'> | ResumeDraftEntry<'invitation'> | ResumeDraftEntry<'workflow'> | ResumeDraftEntry<'workflowSend'> | ResumeDraftEntry<'channelSettings'> | ResumeDraftEntry<'channelSettingSend'> | ResumeDraftEntry<'workflowReminder'> | ResumeDraftEntry<'workflowReminderSend'> | ResumeDraftEntry<'workflowContact'> | ResumeDraftEntry<'workflowContactSend'> | RetainedDraftEntry<unknown>;

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let person: string | null = null;
let boundScope: string | null = null;
// A bound chapter or organization scope; a person alone (organization not yet
// read) binds neither, so a membership answer then is a first answer.
let boundPlace = false;
// A bound chapter scope: the only move the provider answers with a reload.
let boundChapterScope = false;
// The active scope of every kind, or null while a check is unresolved.
let activeScopes: readonly (string | null)[] | null = null;
const isActive = (scope: string) => activeScopes?.includes(scope) === true;
let boundOrganization: string | null = null;
let boundChapter: string | null = null;
// #9369 NO-ANSWER latch: set (own text hidden) until a confirmed full answer
// clears it. A failure that got any answer at all sets it again and can only
// add concealment; the two client-made failures below never set it and never
// clear it. Clearing happens only in syncResumeDraftContext on a confirmed,
// non-checking context, which the provider publishes only for its current
// generation and login, so a late answer from a gone instance clears nothing.
let ownTextLatched = true;
let ownTextNoAnswer = false;
// #9459 M1-21, display only: a concealing read failed since the reads were last
// confirmed, with no reply or with a reply that could not be used. A refusal
// that retired the current person's held work stays said through later failures
// (ledger 724) until a confirmed context or another person; one that retired
// nothing gives way to a later failure. It never decides concealment, scope or retirement.
export type ResumeDraftReadFailure = false | 'no-answer' | 'answered' | 'refused';
let readsFailed: ResumeDraftReadFailure = false;
let refusalRetired = false;
export const resumeDraftReadsFailed = (): ResumeDraftReadFailure => readsFailed;

export function noteResumeDraftReadFailure(error: unknown): void {
  const noAnswer = error instanceof ReadDeadlineError
    || (error !== null && typeof error === 'object' && (error as { status?: unknown }).status === 0);
  const nextLatched = noAnswer ? ownTextLatched : true;
  const nextNoAnswer = noAnswer ? true : false;
  const nextFailed: ResumeDraftReadFailure = isAuthoritativeReadRefusal(error) || (readsFailed === 'refused' && refusalRetired) ? 'refused' : noAnswer ? 'no-answer' : 'answered';
  if (nextLatched === ownTextLatched && nextNoAnswer === ownTextNoAnswer && readsFailed === nextFailed) return;
  ownTextLatched = nextLatched;
  ownTextNoAnswer = nextNoAnswer;
  readsFailed = nextFailed;
  publish();
}
let boundMembershipOrganization: string | null | undefined;
const sorted = (roles: readonly string[] = []) => [...new Set(roles)].sort();
const chapterOf = (context: DraftContext) => {
  const selected = context.chapterMemberships?.find((row) => row.selected)?.chapterID ?? null;
  // A confirmed empty membership result is absence, never permission to use
  // the profile's previous chapter. Legacy callers without read facts retain
  // their existing projection; the provider always supplies those facts.
  return context.resumeDraftReads?.memberships === true ? selected : selected ?? context.dashboard?.member.chapterID ?? null;
};

export function resumeDraftReadsConfirmed(context: Pick<DraftContext, 'resumeDraftReads'>): boolean {
  const reads = context.resumeDraftReads;
  return !reads || (reads.dashboard && reads.memberships && reads.staff);
}

function scopeOf(context: DraftContext, kind: ResumeScopeKind = 'chapter'): string | null {
  const chapter = chapterOf(context);
  if (context.mode !== 'authenticated' || !context.session) return null;
  const roles = [sorted(context.authorizedRoles), sorted(context.chapterRoles), sorted(context.organizationRoles), context.chosenStaffRole ?? null];
  if (kind === 'chapter') return context.organizationID && chapter ? JSON.stringify([context.session.user.id, context.organizationID, chapter, ...roles]) : null;
  // A selected chapter of another organization is a stale projection, never
  // an organization scope. The trailing kind keeps every tuple distinct.
  const selectedOrganization = context.chapterMemberships?.find(row => row.selected)?.organizationID;
  if (kind === 'organization' && (!context.organizationID || (selectedOrganization && selectedOrganization !== context.organizationID))) return null;
  return JSON.stringify([context.session.user.id, kind === 'organization' ? context.organizationID : null, null, ...roles, kind]);
}
const scopesOf = (context: DraftContext) => SCOPE_KINDS.map(kind => scopeOf(context, kind));
// One string for the whole bound identity; null when no kind has a scope.
const boundOf = (scopes: readonly (string | null)[]) => scopes.some(scope => scope !== null) ? JSON.stringify(scopes) : null;

// AppProvider calls this before its children render. Do not notify React from
// that render: all owners also consume the changed context. Clearing here
// invalidates old pending tickets before any new owner can read or write.
export function syncResumeDraftContext(context: DraftContext): void {
  // Original-login guards invalidate attempted sends even if a sign-out and
  // replacement login happened while every composer was unmounted. Discard
  // the duplicate resume copy at the same boundary.
  for (const { userID, chapterID } of retireInvalidNoticeSends()) retireNoticeResumeDrafts(userID, chapterID, false);
  const nextPerson = context.session?.user.id ?? null;
  const nextScopes = scopesOf(context);
  const nextScope = boundOf(nextScopes);
  const reads = context.resumeDraftReads;
  if (context.mode === 'authenticated' && nextPerson !== null && nextPerson === person && reads?.memberships === true && context.chapterMemberships) {
    for (const chapter of retireDepartedNoticeSends(nextPerson, context.chapterMemberships)) retireNoticeResumeDrafts(nextPerson, chapter, false);
  }
  const unresolved = !resumeDraftReadsConfirmed(context);
  // AppProvider also uses its MFA screen for a temporary, recoverable check
  // outage. That is not a confirmed scope change; an actual MFA challenge
  // (without this unavailable flag) still retires unsent resume drafts.
  // Attempted notices follow their independent outcome/login/departure rule.
  // establishSession sets authenticated before its dashboard read completes.
  // An absent dashboard still means no access read has succeeded, even when
  // refreshing settled on a failure. A loaded but missing scope still retires.
  const checking = context.mode === 'booting' || (context.mode === 'mfaRequired' && context.assuranceUnavailable === true)
    || (context.mode === 'authenticated' && (context.dashboard === null || unresolved));
  const checkingSamePerson = checking && nextPerson !== null && nextPerson === person;
  const chapter = chapterOf(context);
  const organizationConfirmed = !reads || (reads.staff && reads.memberships);
  const chapterConfirmed = reads?.memberships !== false;
  const knownScopeChange = (organizationConfirmed && context.organizationID !== null && boundOrganization !== null && context.organizationID !== boundOrganization)
    || (chapterConfirmed && chapter !== null && boundChapter !== null && chapter !== boundChapter)
    || (reads?.memberships === true && chapter === null && boundChapter !== null)
    // A confirmed first chapter after a bound chapterless place (#9375 r1s3).
    || (reads?.memberships === true && chapter !== null && boundChapter === null && boundPlace)
    || (reads !== undefined && organizationConfirmed && context.organizationID === null && boundOrganization !== null);
  if (person && (nextPerson !== person)) {
    retirePendingNoticeSends(person, false);
  }
  if (nextPerson !== person) { ownTextLatched = true; ownTextNoAnswer = false; readsFailed = false; refusalRetired = false; }
  if (!unresolved && !checking && nextPerson !== null) { ownTextLatched = false; ownTextNoAnswer = false; readsFailed = false; refusalRetired = false; }
  if (knownScopeChange || (!checkingSamePerson && (!nextScope || nextPerson !== person || nextScope !== boundScope))) entries.clear();
  person = nextPerson;
  activeScopes = checking ? null : nextScopes;
  if (!checkingSamePerson) {
    boundScope = nextScope;
    boundPlace = nextScopes[0] !== null || nextScopes[1] !== null;
    boundChapterScope = nextScopes[0] !== null;
    boundOrganization = context.organizationID;
    boundChapter = chapter;
    boundMembershipOrganization = context.chapterMemberships?.find(row => row.selected)?.organizationID;
  }
}

export function resumeDraftKey<S extends Surface>(context: DraftContext, surface: S, itemID: string): ResumeDraftKey<S> | null {
  const scope = scopeOf(context);
  return scope ? { id: JSON.stringify([scope, surface, itemID]), scope, surface } : null;
}

export function useResumeDraftKey<S extends Surface>(context: DraftContext, surface: S, itemID: string): ResumeDraftKey<S> | null {
  const scope = scopeOf(context);
  return useMemo(() => scope ? { id: JSON.stringify([scope, surface, itemID]), scope, surface } : null, [scope, surface, itemID]);
}

function publish() { for (const listener of listeners) listener(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

// Local role choice and a confirmed chapter switch are answers even while a
// sibling read is unavailable. Retire at that intent boundary, before another
// event or continuation can write through the previous scope.
export function retireResumeDraftScope(userID: string): void {
  if (person !== userID) return;
  entries.clear(); activeScopes = null;
  publish();
}

// A standalone membership answer cannot authorize a new scope using dashboard
// and staff reads from the previous one. Compare with the last bound identity,
// never with a public membership projection that may itself be a fallback.
export function confirmResumeDraftMemberships(userID: string, memberships: NonNullable<DraftContext['chapterMemberships']>): boolean {
  if (person !== userID) return false;
  const selected = memberships.find(row => row.selected);
  const moved = (selected?.chapterID ?? null) !== boundChapter
    || (boundMembershipOrganization !== undefined && selected?.organizationID !== undefined
      && selected.organizationID !== boundMembershipOrganization);
  // Any confirmed move from a bound chapter or organization place retires
  // every draft, a chapterless officer's first chapter included (#9375 r1s3).
  if (boundPlace && moved) retireResumeDraftScope(userID);
  // A change is reported only from a bound chapter scope, as on Main: the
  // provider answers a report by clearing its read facts and reloads only from
  // a previous chapter, so a first chapter reported here would leave every
  // editor hidden with no read in flight (#9375 r3s2).
  return boundChapterScope && moved;
}

export function retireRefusedResumeDraftScope(userID: string, error: unknown): void {
  if (!isAuthoritativeReadRefusal(error)) return;
  if (person === userID) { readsFailed = 'refused'; refusalRetired = true; }
  retireResumeDraftScope(userID);
}

// A complete, successful membership answer can retire attempted work even
// if another read fails. Selection changes and read refusals cannot.
export function confirmPendingNoticeMemberships(userID: string, memberships: NonNullable<DraftContext['chapterMemberships']>): void {
  if (person !== userID) return;
  retireDepartedNoticeSends(userID, memberships, chapters => {
    for (const chapter of chapters) retireNoticeResumeDrafts(userID, chapter, false);
    publish();
  });
}

// One read, write and settle path for named and token surfaces alike.
type AnyKey = { id: string; scope: string; surface: Surface | RetainedSurface<unknown> };
function readEntry(key: AnyKey | null): Entry | null {
  if (!key || !isActive(key.scope)) return null;
  const entry = entries.get(key.id);
  // The surface is part of the key and checked here before narrowing the map.
  return entry?.key.surface === key.surface ? entry : null;
}
function canWrite(key: AnyKey): boolean {
  return isActive(key.scope) && !entries.get(key.id)?.pending;
}
function store(entry: Entry): void {
  entries.set(entry.key.id, entry);
  publish();
}
function settleEntry(current: Entry, next: Entry | null): boolean {
  if (entries.get(current.key.id) !== current) return false;
  if (next) entries.set(current.key.id, next);
  else entries.delete(current.key.id);
  publish();
  return true;
}

export function readResumeDraft<S extends Surface>(key: ResumeDraftKey<S> | null): ResumeDraftEntry<S> | null {
  return readEntry(key) as ResumeDraftEntry<S> | null;
}

export function useResumeDraft<S extends Surface>(key: ResumeDraftKey<S> | null, fresh: boolean): ResumeDraftEntry<S> | null {
  const snapshot = useCallback(() => fresh ? readResumeDraft(key) : null, [key, fresh]);
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

export function writeResumeDraft<S extends Surface>(key: ResumeDraftKey<S> | null, value: Drafts[S], pending = false): ResumeDraftEntry<S> | null {
  if (!key || !canWrite(key)) return null;
  const entry: ResumeDraftEntry<S> = { key, value, pending };
  store(entry as Entry);
  return entry;
}

export function retireResumeDraft(key: AnyKey | null): void {
  if (key && entries.delete(key.id)) publish();
}

export function retireNoticeResumeDrafts(userID: string, chapterID: string, notify = true): void {
  let removed = false;
  for (const [id, entry] of entries) {
    if (entry.key.surface !== 'notice') continue;
    const scope = JSON.parse(entry.key.scope) as readonly unknown[];
    if (scope[0] === userID && scope[2] === chapterID) removed = entries.delete(id) || removed;
  }
  if (removed && notify) publish();
}

export function resumeDraftIsCurrent(entry: ResumeDraftEntry<Surface>, requireActive = false): boolean {
  return entries.get(entry.key.id) === entry && (!requireActive || isActive(entry.key.scope));
}

// #9369: the shell panel's only reader. It returns typed words only while the
// holder is concealing for this same signed-in person after a no-answer
// failure, and it restores no access fact: activeScopes stay null and every
// composer keeps waiting for confirmed reads.
export type OwnHeldText = HeldWorkText & { entry: ResumeDraftEntry<Surface>; canDiscard: boolean };
const NO_OWN_TEXT: readonly OwnHeldText[] = [];
let ownTextCache: { userID: string | null; held: readonly Entry[]; dispatch: string; result: readonly OwnHeldText[] } | null = null;

// #9417 gate r1s2/r2s2: some surfaces keep dispatch in a companion send entry
// under the same scope and item (workflowSend, workflowReminderSend,
// channelSettingSend) and a notice keeps its ticket in noticePendingSend.
// The panel derives its uncertainty line and its receipts from those records,
// never from the text entry alone, and exposes none of their identifiers.
const COMPANION_SEND: Readonly<Record<string, string>> = {
  workflow: 'workflowSend', workflowReminder: 'workflowReminderSend', channelSettings: 'channelSettingSend',
};
const entryFields = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
type OwnTextCompanion = { dispatch: HeldDispatch; sendEntry: Entry | null; notice: { userID: string; chapterID: string | null; operationKey: string | null } | null };
function ownTextCompanion(entry: Entry): OwnTextCompanion {
  const none: OwnTextCompanion = { dispatch: NO_DISPATCH, sendEntry: null, notice: null };
  if (typeof entry.key.surface !== 'string') return none;
  if (entry.key.surface === 'notice') {
    let scope: readonly unknown[];
    try { scope = JSON.parse(entry.key.scope) as readonly unknown[]; } catch { return none; } // swallow-ok: holder-made scope key; a malformed one fails closed to no own text
    const userID = typeof scope[0] === 'string' ? scope[0] : null;
    const chapterID = typeof scope[2] === 'string' ? scope[2] : null;
    const operationKey = entryFields(entryFields(entry.value).attempt).operationKey;
    if (!userID || typeof operationKey !== 'string') return none;
    const notice = { userID, chapterID, operationKey };
    const state = noticeSendOwnTextState(userID, chapterID, operationKey);
    if (!state) return { dispatch: NO_DISPATCH, sendEntry: null, notice };
    return { dispatch: { pending: state.busy, attempted: state.busy || state.outcomeUnknown, receipt: state.confirmed }, sendEntry: null, notice };
  }
  const sendSurface = COMPANION_SEND[entry.key.surface];
  if (!sendSurface) return none;
  let idParts: readonly unknown[];
  try { idParts = JSON.parse(entry.key.id) as readonly unknown[]; } catch { return none; } // swallow-ok: holder-made entry key; a malformed one fails closed to no own text
  if (idParts.length !== 3 || typeof idParts[2] !== 'string') return none;
  const sendEntry = entries.get(JSON.stringify([entry.key.scope, sendSurface, idParts[2]])) ?? null;
  if (!sendEntry || sendEntry.key.surface !== sendSurface || sendEntry.key.scope !== entry.key.scope) return none;
  const sent = entryFields(sendEntry.value);
  // One channel companion serves mute, level and keyword saves; only a send
  // marked as the keyword operation belongs to the keyword row (ledger 679).
  if (entry.key.surface === 'channelSettings' && sent.keywordOperation !== true) return none;
  const receipt = entry.key.surface === 'workflowReminder' ? sent.saved === true
    : entry.key.surface === 'channelSettings' ? sent.saved !== null && sent.saved !== undefined : false;
  // A channel failure the server explicitly answered (or one that never
  // dispatched) settles with outcomeUnknown false and carries no line
  // (#9426 round 1); other companions keep the failed-means-attempted rule.
  const attempted = entry.key.surface === 'channelSettings'
    ? sendEntry.pending || (sent.failed === true && sent.outcomeUnknown === true)
    : sendEntry.pending || sent.failed === true;
  return { dispatch: { pending: sendEntry.pending, attempted, receipt }, sendEntry, notice: null };
}

export function readOwnHeldText(sessionUserID: string | null): readonly OwnHeldText[] {
  if (!sessionUserID || sessionUserID !== person || activeScopes !== null || ownTextLatched || !ownTextNoAnswer) return NO_OWN_TEXT;
  const held = [...entries.values()];
  const companions = held.map(ownTextCompanion);
  const dispatch = JSON.stringify(companions.map(row => row.dispatch));
  if (ownTextCache && ownTextCache.userID === sessionUserID && ownTextCache.dispatch === dispatch && ownTextCache.held.length === held.length
    && ownTextCache.held.every((entry, index) => entry === held[index])) return ownTextCache.result;
  const result: OwnHeldText[] = [];
  held.forEach((entry, index) => {
    if (typeof entry.key.surface !== 'string') return;
    let owner: unknown;
    try { owner = (JSON.parse(entry.key.scope) as readonly unknown[])[0]; } catch { return; } // swallow-ok: holder-made scope key; a malformed one fails closed to no own text
    if (owner !== sessionUserID) return;
    const shown = heldWorkText(entry.key.surface, entry.value, entry.pending, companions[index]!.dispatch);
    // Ledger 681: the panel disables Discard exactly while discardOwnHeldText
    // would refuse it (the entry's own send or its companion is in flight).
    if (shown) result.push({ ...shown, entry: entry as ResumeDraftEntry<Surface>, canDiscard: !entry.pending && !companions[index]!.dispatch.pending });
  });
  const frozen = result.length ? result : NO_OWN_TEXT;
  ownTextCache = { userID: sessionUserID, held, dispatch, result: frozen };
  return frozen;
}

export function useOwnHeldText(sessionUserID: string | null): readonly OwnHeldText[] {
  const snapshot = useCallback(() => readOwnHeldText(sessionUserID), [sessionUserID]);
  return useSyncExternalStore(subscribe, snapshot, () => NO_OWN_TEXT);
}

// Discard from the own-text view deletes only the exact entry that was
// rendered, never a replacement draft written under the same key, and it
// retires every holder record of that entry with it (#9417 gate r1s1/r2s1):
// the companion send entry here and, for a notice, its noticePendingSend
// ticket by exact operation key. A send still in flight refuses the whole
// discard, as each composer's own Discard does.
export function discardOwnHeldText(entry: ResumeDraftEntry<Surface>): boolean {
  if (entries.get(entry.key.id) !== entry) return false;
  const companion = ownTextCompanion(entry as Entry);
  if (entry.pending || companion.dispatch.pending) return false;
  if (companion.notice && !retireNoticeSendForOwnTextDiscard(companion.notice.userID, companion.notice.chapterID, companion.notice.operationKey)) return false;
  if (entries.get(entry.key.id) !== entry) return false;
  entries.delete(entry.key.id);
  if (companion.sendEntry && entries.get(companion.sendEntry.key.id) === companion.sendEntry) entries.delete(companion.sendEntry.key.id);
  publish();
  return true;
}

// An acknowledgement belongs to this exact attempt, even while the tree is
// gone. A scope change or authoritative retirement makes it a permanent no-op;
// it can neither resurrect old text nor clear a replacement draft.
export function settleResumeDraft<S extends Surface>(entry: ResumeDraftEntry<S>, failed: Drafts[S] | null): boolean {
  return settleEntry(entry as Entry, failed ? { key: entry.key, value: failed, pending: false } as Entry : null);
}

// Typed doors for token surfaces (src/lib/retainedDraft.ts). They use the same
// read, write and settle path as the named surfaces above; no separate rule.
export function useRetainedDraftKey<T>(context: DraftContext, surface: RetainedSurface<T>, itemID: string, kind: ResumeScopeKind): RetainedDraftKey<T> | null {
  const scope = scopeOf(context, kind);
  return useMemo(() => scope ? { id: JSON.stringify([scope, surface.name, itemID]), scope, surface } : null, [scope, surface, itemID]);
}
export function retainedDraftKey<T>(context: DraftContext, surface: RetainedSurface<T>, itemID: string, kind: ResumeScopeKind): RetainedDraftKey<T> | null {
  const scope = scopeOf(context, kind);
  return scope ? { id: JSON.stringify([scope, surface.name, itemID]), scope, surface } : null;
}
export function retainedDraftScopeIsActive(key: RetainedDraftKey<unknown> | null): boolean {
  return key !== null && isActive(key.scope);
}
// Ledger 612: whether a named key's scope is active, so an owner can tell an
// entry that was retired (absent while active) from one the holder only
// conceals while a check is unresolved.
export function resumeDraftScopeIsActive(key: { scope: string } | null): boolean {
  return key !== null && isActive(key.scope);
}
export function readRetainedDraft<T>(key: RetainedDraftKey<T> | null): RetainedDraftEntry<T> | null {
  return readEntry(key) as RetainedDraftEntry<T> | null;
}
export function writeRetainedDraft<T>(key: RetainedDraftKey<T> | null, value: T, pending = false): RetainedDraftEntry<T> | null {
  if (!key || !canWrite(key)) return null;
  const entry: RetainedDraftEntry<T> = { key, value, pending };
  store(entry);
  return entry;
}
export function settleRetainedDraft<T>(entry: RetainedDraftEntry<T>, failed: T | null): boolean {
  return settleEntry(entry, failed === null ? null : { key: entry.key, value: failed, pending: false });
}
export function retireRetainedDraft(key: RetainedDraftKey<unknown> | null): void {
  retireResumeDraft(key);
}
export function subscribeResumeDrafts(listener: () => void): () => void {
  return subscribe(listener);
}
