import { beforeEach, describe, expect, it } from 'vitest';
import { emptyMeetingDraft } from './chapterMeeting';
import {
  confirmResumeDraftMemberships, defineRetainedSurface, discardOwnHeldText, noteResumeDraftReadFailure, readOwnHeldText, readResumeDraft, readRetainedDraft, resumeDraftIsCurrent, resumeDraftKey,
  retainedDraftKey, retireRefusedResumeDraftScope, retireResumeDraft, retireResumeDraftScope, settleResumeDraft, settleRetainedDraft,
  syncResumeDraftContext, writeResumeDraft, writeRetainedDraft, type NoticeResumeDraft, type ResumeScopeKind,
} from './resumeDraftHolder';
import { ReadDeadlineError } from './readDeadline';
import { normalizeChannelSetting } from './channelControlsShared';
import { beginNoticeSend, readPendingNoticeSend, retirePendingNoticeSends, updateNoticeSend, type NoticeAttempt } from '../features/noticePendingSend';

const context = () => ({ mode: 'authenticated', session: { user: { id: 'person-a' } }, organizationID: 'org-a',
  chapterMemberships: [{ chapterID: 'chapter-a', selected: true }], authorizedRoles: ['admin', 'vp'], chapterRoles: ['admin'], organizationRoles: ['vp'], chosenStaffRole: 'admin' });
const draft = () => ({ draft: { ...emptyMeetingDraft(new Date('2026-11-20')), title: 'Unsent fixture' }, defaults: emptyMeetingDraft(new Date('2026-11-20')), identity: null, warning: null });
beforeEach(() => { syncResumeDraftContext({ ...context(), mode: 'signedOut', session: null }); syncResumeDraftContext(context()); });

describe('the memory-only resume draft boundary', () => {
  it('hides work while checking and restores only the identical full scope', () => {
    const key = resumeDraftKey(context(), 'meeting', 'new')!;
    writeResumeDraft(key, draft());
    syncResumeDraftContext({ ...context(), mode: 'booting', organizationID: null, chapterMemberships: [], authorizedRoles: [], chapterRoles: [], organizationRoles: [] });
    expect(readResumeDraft(key)).toBeNull();
    expect(writeResumeDraft(key, draft())).toBeNull();
    syncResumeDraftContext(context());
    expect(readResumeDraft(key)?.value.draft.title).toBe('Unsent fixture');
    expect(readResumeDraft(resumeDraftKey(context(), 'meeting', 'other-item'))).toBeNull();
    expect(readResumeDraft(resumeDraftKey(context(), 'notice', 'new'))).toBeNull();
  });
  const changes: readonly ('sign-out' | 'checking-other-person' | 'person' | 'organization' | 'chapter' | 'role' | 'chosen-role' | 'missing-scope')[] = ['sign-out', 'checking-other-person', 'person', 'organization', 'chapter', 'role', 'chosen-role', 'missing-scope'];
  for (const change of changes) {
    it(`permanently retires tickets and text after ${change}`, () => {
      const key = resumeDraftKey(context(), 'meeting', 'new')!;
      const pending = writeResumeDraft(key, draft(), true)!;
      const next = context();
      if (change === 'sign-out') Object.assign(next, { mode: 'signedOut', session: null });
      if (change === 'checking-other-person') { next.mode = 'booting'; next.session.user.id = 'person-b'; }
      if (change === 'person') next.session.user.id = 'person-b';
      if (change === 'organization') next.organizationID = 'org-b';
      if (change === 'chapter') next.chapterMemberships[0]!.chapterID = 'chapter-b';
      if (change === 'role') next.authorizedRoles = ['vp'];
      if (change === 'chosen-role') next.chosenStaffRole = 'vp';
      if (change === 'missing-scope') Object.assign(next, { organizationID: null });
      syncResumeDraftContext(next);
      syncResumeDraftContext(context());
      expect(readResumeDraft(key)).toBeNull();
      expect(settleResumeDraft(pending, draft())).toBe(false);
      expect(resumeDraftIsCurrent(pending)).toBe(false);
    });
  }
  it('normalizes role order without treating it as a new grant', () => {
    const key = resumeDraftKey(context(), 'meeting', 'new')!;
    writeResumeDraft(key, draft());
    syncResumeDraftContext({ ...context(), authorizedRoles: ['vp', 'admin', 'vp'] });
    expect(readResumeDraft(key)).not.toBeNull();
  });
  it('keeps an incomplete authenticated bootstrap concealed until a complete scope returns', () => {
    const key = resumeDraftKey(context(), 'meeting', 'new')!;
    const pending = writeResumeDraft(key, draft(), true)!;
    syncResumeDraftContext({ ...context(), mode: 'booting', organizationID: null, chapterMemberships: [] });
    syncResumeDraftContext({ ...context(), refreshing: true, dashboard: null, organizationID: null, chapterMemberships: [], authorizedRoles: [] });
    expect(readResumeDraft(key)).toBeNull(); expect(writeResumeDraft(key, draft())).toBeNull();
    expect(resumeDraftIsCurrent(pending)).toBe(true);
    syncResumeDraftContext(context()); expect(readResumeDraft(key)?.pending).toBe(true);
  });
  it.each(['organization', 'chapter', 'account'])('retires a known %s change even during incomplete bootstrap', (changed) => {
    const key = resumeDraftKey(context(), 'meeting', 'new')!;
    const pending = writeResumeDraft(key, draft(), true)!;
    const next = { ...context(), refreshing: true, dashboard: null };
    if (changed === 'organization') next.organizationID = 'org-b';
    if (changed === 'chapter') next.chapterMemberships = [{ chapterID: 'chapter-b', selected: true }];
    if (changed === 'account') next.session = { user: { id: 'person-b' } };
    syncResumeDraftContext(next); syncResumeDraftContext(context());
    expect(readResumeDraft(key)).toBeNull(); expect(settleResumeDraft(pending, draft())).toBe(false);
  });
  it('conceals work through a temporary check outage but retires it for a real MFA challenge', () => {
    const key = resumeDraftKey(context(), 'meeting', 'new')!;
    const pending = writeResumeDraft(key, draft(), true)!;
    syncResumeDraftContext({ ...context(), mode: 'booting' });
    syncResumeDraftContext({ ...context(), mode: 'mfaRequired', assuranceUnavailable: true, organizationID: null, chapterMemberships: [] });
    expect(readResumeDraft(key)).toBeNull();
    expect(resumeDraftIsCurrent(pending)).toBe(true);
    syncResumeDraftContext(context());
    expect(readResumeDraft(key)?.pending).toBe(true);
    syncResumeDraftContext({ ...context(), mode: 'mfaRequired', assuranceUnavailable: false });
    syncResumeDraftContext(context());
    expect(readResumeDraft(key)).toBeNull();
    expect(settleResumeDraft(pending, draft())).toBe(false);
  });
  it('settles confirmed work during booting without restoring or offering it again', () => {
    const key = resumeDraftKey(context(), 'meeting', 'new')!;
    const pending = writeResumeDraft(key, draft(), true)!;
    syncResumeDraftContext({ ...context(), mode: 'booting' });
    expect(resumeDraftIsCurrent(pending)).toBe(true);
    expect(resumeDraftIsCurrent(pending, true)).toBe(false);
    expect(settleResumeDraft(pending, null)).toBe(true);
    syncResumeDraftContext(context());
    expect(readResumeDraft(key)).toBeNull();
  });
  it('returns failed work but refuses overlapping writes while the acknowledgement is pending', () => {
    const key = resumeDraftKey(context(), 'meeting', 'new')!;
    const pending = writeResumeDraft(key, draft(), true)!;
    expect(writeResumeDraft(key, draft())).toBeNull();
    expect(settleResumeDraft(pending, draft())).toBe(true);
    expect(readResumeDraft(key)?.pending).toBe(false);
    expect(resumeDraftIsCurrent(pending)).toBe(false);
  });
  it('an authoritative retirement prevents an old continuation from clearing replacement work', () => {
    const key = resumeDraftKey(context(), 'meeting', 'new')!;
    const old = writeResumeDraft(key, draft(), true)!;
    retireResumeDraft(key);
    const next = draft(); next.draft.title = 'Replacement';
    writeResumeDraft(key, next);
    expect(settleResumeDraft(old, null)).toBe(false);
    expect(settleResumeDraft(old, draft())).toBe(false);
    expect(readResumeDraft(key)?.value.draft.title).toBe('Replacement');
  });
});

// #9240 PR A: typed surfaces and the organization/platform scope kinds.
describe('retained surfaces and scope kinds', () => {
  const surface = defineRetainedSurface<{ text: string }>('holder-unit');
  const chapterless = () => ({ ...context(), chapterMemberships: [] as { chapterID: string; organizationID?: string; selected: boolean }[], chapterRoles: [] as string[],
    dashboard: { member: { chapterID: null } }, resumeDraftReads: { dashboard: true, memberships: true, staff: true } });
  const kinds: readonly ResumeScopeKind[] = ['chapter', 'organization', 'platform'];
  beforeEach(() => { syncResumeDraftContext({ ...context(), mode: 'signedOut', session: null }); syncResumeDraftContext(context()); });

  it('keeps the campaign key exactly as before', () => {
    expect(resumeDraftKey(context(), 'meeting', 'new')?.scope).toBe(JSON.stringify(['person-a', 'org-a', 'chapter-a', ['admin', 'vp'], ['admin'], ['vp'], 'admin']));
    expect(retainedDraftKey(context(), surface, 'item', 'chapter')?.scope).toBe(resumeDraftKey(context(), 'meeting', 'new')?.scope);
  });
  it('gives every kind a distinct scope and refuses a chapterless campaign key', () => {
    const scopes = kinds.map(kind => retainedDraftKey(context(), surface, 'item', kind)?.scope);
    expect(new Set(scopes).size).toBe(3);
    expect(retainedDraftKey(chapterless(), surface, 'item', 'chapter')).toBeNull();
    expect(retainedDraftKey(chapterless(), surface, 'item', 'organization')).not.toBeNull();
    expect(retainedDraftKey({ ...context(), organizationID: null }, surface, 'item', 'organization')).toBeNull();
    expect(retainedDraftKey({ ...context(), organizationID: null }, surface, 'item', 'platform')).not.toBeNull();
    expect(retainedDraftKey({ ...context(), mode: 'booting' }, surface, 'item', 'platform')).toBeNull();
  });
  it('refuses an organization key while a campaign of another organization is selected', () => {
    const stale = { ...context(), chapterMemberships: [{ chapterID: 'chapter-a', organizationID: 'org-b', selected: true }] };
    expect(retainedDraftKey(stale, surface, 'item', 'organization')).toBeNull();
  });
  it('keeps a chapterless officer\'s organization work through the check, hidden while checking', () => {
    syncResumeDraftContext(chapterless());
    const key = retainedDraftKey(chapterless(), surface, 'note', 'organization')!;
    expect(writeRetainedDraft(key, { text: 'Unsent' })).not.toBeNull();
    syncResumeDraftContext({ ...chapterless(), mode: 'booting', organizationID: null, dashboard: null, authorizedRoles: [], organizationRoles: [], resumeDraftReads: { dashboard: false, memberships: false, staff: false } });
    expect(readRetainedDraft(key)).toBeNull();
    expect(writeRetainedDraft(key, { text: 'Overwrite' })).toBeNull();
    syncResumeDraftContext(chapterless());
    expect(readRetainedDraft(key)?.value.text).toBe('Unsent');
  });
  it('keeps two surfaces with the same name apart', () => {
    const twin = defineRetainedSurface<{ text: string }>('holder-unit');
    const key = retainedDraftKey(context(), surface, 'item', 'organization')!;
    const twinKey = retainedDraftKey(context(), twin, 'item', 'organization')!;
    expect(twinKey.id).not.toBe(key.id);
    writeRetainedDraft(key, { text: 'First' }, true);
    expect(readRetainedDraft(twinKey)).toBeNull();
    // Neither token overwrites or blocks the other's draft.
    expect(writeRetainedDraft(twinKey, { text: 'Second' })).not.toBeNull();
    expect(readRetainedDraft(key)?.value.text).toBe('First');
    expect(readRetainedDraft(twinKey)?.value.text).toBe('Second');
  });
  const chapterMoves: readonly ('gained' | 'changed')[] = ['gained', 'changed'];
  const placeKinds: readonly ResumeScopeKind[] = ['organization', 'platform'];
  for (const move of chapterMoves) {
    for (const kind of placeKinds) {
      it(`retires ${kind} work when a campaign is ${move} while the staff read is unresolved`, () => {
        const start = move === 'gained' ? chapterless() : { ...context(), resumeDraftReads: { dashboard: true, memberships: true, staff: true } };
        syncResumeDraftContext(start);
        const key = retainedDraftKey(start, surface, 'item', kind)!;
        const ticket = writeRetainedDraft(key, { text: 'Unsent' }, true)!;
        syncResumeDraftContext({ ...start, chapterMemberships: [{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true }],
          dashboard: { member: { chapterID: 'chapter-b' } }, resumeDraftReads: { dashboard: true, memberships: true, staff: false } });
        syncResumeDraftContext(start);
        expect(readRetainedDraft(key)).toBeNull();
        expect(settleRetainedDraft(ticket, { text: 'Back' })).toBe(false);
      });
    }
  }
  for (const kind of kinds) {
    const moves: readonly ('another-chapter' | 'gained-chapter' | 'organization' | 'role' | 'hat' | 'staff-dropped' | 'account' | 'sign-out' | 'mfa' | 'refusal' | 'local-retire')[] =
      ['another-chapter', 'gained-chapter', 'organization', 'role', 'hat', 'staff-dropped', 'account', 'sign-out', 'mfa', 'refusal', 'local-retire'];
    for (const move of moves) {
      it(`retires ${kind} work and its pending ticket after ${move}`, () => {
        const start = move === 'gained-chapter' ? chapterless() : context();
        syncResumeDraftContext(start);
        const key = retainedDraftKey(start, surface, 'item', kind);
        if (!key) { expect(kind).toBe('chapter'); expect(move).toBe('gained-chapter'); return; }
        const ticket = writeRetainedDraft(key, { text: 'Unsent' }, true)!;
        const next: Record<string, unknown> = { ...start };
        if (move === 'another-chapter') next.chapterMemberships = [{ chapterID: 'chapter-b', selected: true }];
        if (move === 'gained-chapter') next.chapterMemberships = [{ chapterID: 'chapter-b', selected: true }];
        if (move === 'organization') next.organizationID = 'org-b';
        if (move === 'role') next.authorizedRoles = ['vp'];
        if (move === 'hat') next.chosenStaffRole = 'vp';
        if (move === 'staff-dropped') Object.assign(next, { authorizedRoles: [], chapterRoles: [], organizationRoles: [], chosenStaffRole: null });
        if (move === 'account') next.session = { user: { id: 'person-b' } };
        if (move === 'sign-out') Object.assign(next, { mode: 'signedOut', session: null });
        if (move === 'mfa') Object.assign(next, { mode: 'mfaRequired', assuranceUnavailable: false });
        if (move === 'refusal') retireRefusedResumeDraftScope('person-a', { code: '42501' });
        else if (move === 'local-retire') retireResumeDraftScope('person-a');
        else syncResumeDraftContext(next as never);
        syncResumeDraftContext(start);
        expect(readRetainedDraft(key)).toBeNull();
        expect(settleRetainedDraft(ticket, { text: 'Back' })).toBe(false);
      });
    }
  }
  it('retires organization work when a standalone membership answer selects a first campaign, without reporting a change the provider cannot reload', () => {
    syncResumeDraftContext(chapterless());
    const key = retainedDraftKey(chapterless(), surface, 'item', 'organization')!;
    writeRetainedDraft(key, { text: 'Unsent' });
    expect(confirmResumeDraftMemberships('person-a', [{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true }])).toBe(false);
    expect(readRetainedDraft(key)).toBeNull();
  });
  it('still reports a standalone change from a bound campaign, which the provider reloads', () => {
    const key = retainedDraftKey(context(), surface, 'item', 'organization')!;
    writeRetainedDraft(key, { text: 'Unsent' });
    expect(confirmResumeDraftMemberships('person-a', [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }])).toBe(false);
    expect(readRetainedDraft(key)?.value.text).toBe('Unsent');
    expect(confirmResumeDraftMemberships('person-a', [{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true }])).toBe(true);
    expect(readRetainedDraft(key)).toBeNull();
  });
  it('keeps the first membership answer of a cold start from retiring anything', () => {
    syncResumeDraftContext({ ...context(), mode: 'signedOut', session: null });
    syncResumeDraftContext({ mode: 'authenticated', session: { user: { id: 'person-a' } }, organizationID: null, dashboard: null });
    expect(confirmResumeDraftMemberships('person-a', [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }])).toBe(false);
  });
  it('settles typed work after an unmount and refuses an overlapping write', () => {
    const key = retainedDraftKey(context(), surface, 'item', 'organization')!;
    const ticket = writeRetainedDraft(key, { text: 'Unsent' }, true)!;
    expect(writeRetainedDraft(key, { text: 'Second' })).toBeNull();
    expect(settleRetainedDraft(ticket, null)).toBe(true);
    expect(readRetainedDraft(key)).toBeNull();
    expect(resumeDraftIsCurrent(ticket as never)).toBe(false);
  });
});

// #9369: after a read that got no answer at all, the same person may read and
// discard only the words they typed. Nothing here restores an access fact.
describe('own held text after a no-answer read (#9369)', () => {
  const confirmed = () => ({ ...context(), dashboard: { member: { chapterID: 'chapter-a' } }, resumeDraftReads: { dashboard: true, memberships: true, staff: true } });
  const checking = () => ({ ...confirmed(), resumeDraftReads: { dashboard: false, memberships: false, staff: false } });
  const notice = (): NoticeResumeDraft => ({ title: 'My title', body: 'My own words', locale: 'en', audienceValue: 'chapter:chapter-a', warning: null,
    attempt: { title: 'My title', body: 'My own words', locale: 'en', operationKey: 'secret-operation-key' } });
  beforeEach(() => { retirePendingNoticeSends('person-a', false); syncResumeDraftContext({ ...context(), mode: 'signedOut', session: null }); syncResumeDraftContext(confirmed()); });

  const noAnswerCases: readonly (readonly [string, unknown])[] = [
    ['status 0', { status: 0, message: 'Failed to fetch' }],
    ['the read deadline', new ReadDeadlineError()],
  ];
  it.each(noAnswerCases)('shows only typed words after %s, with no access fact restored', (_label, failure) => {
    const key = resumeDraftKey(confirmed(), 'notice', 'chapter-notices')!;
    writeResumeDraft(key, notice());
    expect(readOwnHeldText('person-a')).toEqual([]);
    noteResumeDraftReadFailure(failure);
    syncResumeDraftContext(checking());
    expect(readResumeDraft(key)).toBeNull();
    const shown = readOwnHeldText('person-a');
    expect(shown).toHaveLength(1);
    expect(shown[0]!.lines).toEqual(['My title', 'My own words']);
    expect(shown[0]!.uncertain).toBe(true);
    const rendered = JSON.stringify(shown.map(row => ({ label: row.label, lines: row.lines })));
    expect(rendered).not.toContain('secret-operation-key');
    expect(rendered).not.toContain('chapter:chapter-a');
    expect(readOwnHeldText('person-b')).toEqual([]);
    expect(discardOwnHeldText(shown[0]!.entry)).toBe(true);
    expect(readOwnHeldText('person-a')).toEqual([]);
    syncResumeDraftContext(confirmed());
    expect(readResumeDraft(key)).toBeNull();
  });

  const answeredCases: readonly (readonly [string, unknown])[] = [
    ['a 401 whose body says Failed to fetch', { status: 401, code: '', message: 'Failed to fetch' }],
    ['a 42501 refusal', { status: 403, code: '42501', message: 'permission denied' }],
    ['a server error', { status: 500, message: 'Internal server error' }],
    ['an error whose status was lost', { code: '', message: 'Failed to fetch' }],
    ['an availability-false answer', undefined],
    ['an unknown thrown error', new Error('boom')],
  ];
  it.each(answeredCases)('stays hidden after %s', (_label, failure) => {
    const key = resumeDraftKey(confirmed(), 'notice', 'chapter-notices')!;
    writeResumeDraft(key, notice());
    noteResumeDraftReadFailure(failure);
    syncResumeDraftContext(checking());
    expect(readOwnHeldText('person-a')).toEqual([]);
  });

  it('a later refusal hides text a no-answer failure had shown, and a late status 0 cannot bring it back', () => {
    const key = resumeDraftKey(confirmed(), 'notice', 'chapter-notices')!;
    writeResumeDraft(key, notice());
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    expect(readOwnHeldText('person-a')).toHaveLength(1);
    noteResumeDraftReadFailure({ status: 500 });
    expect(readOwnHeldText('person-a')).toEqual([]);
    noteResumeDraftReadFailure({ status: 0 });
    expect(readOwnHeldText('person-a')).toEqual([]);
    syncResumeDraftContext(confirmed());
    expect(readResumeDraft(key)?.value.body).toBe('My own words');
  });

  it('discard refuses a stale entry and never deletes its replacement', () => {
    const key = resumeDraftKey(confirmed(), 'notice', 'chapter-notices')!;
    writeResumeDraft(key, notice());
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    const shown = readOwnHeldText('person-a')[0]!;
    syncResumeDraftContext(confirmed());
    retireResumeDraft(key);
    writeResumeDraft(key, { ...notice(), body: 'Replacement words', attempt: null });
    expect(discardOwnHeldText(shown.entry)).toBe(false);
    expect(readResumeDraft(key)?.value.body).toBe('Replacement words');
  });

  // Gate r1s1/r2s1 of #9417: an attempted notice lives in two holders.
  const attemptedNotice = (operationKey: string) => {
    const attempt: NoticeAttempt = { title: 'My title', body: 'My own words', locale: 'en', operationKey };
    const held = beginNoticeSend('person-a|chapter-a',
      { title: 'My title', body: 'My own words', locale: 'en', postingRole: 'admin', organizationID: 'org-a' },
      { value: 'chapter', kind: 'chapter', chapterId: 'chapter-a', name: '' },
      { ...attempt }, { userID: 'person-a', isCurrent: () => true })!;
    const key = resumeDraftKey(confirmed(), 'notice', 'chapter-notices')!;
    writeResumeDraft(key, { ...notice(), attempt: { ...attempt } });
    return { held, key };
  };

  it('discarding an attempted notice retires its pending-send ticket too, so the composer opens clean', () => {
    const { held, key } = attemptedNotice('op-key-1');
    updateNoticeSend(held, { busy: false, outcomeUnknown: true });
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    const shown = readOwnHeldText('person-a');
    expect(shown).toHaveLength(1);
    expect(shown[0]!.uncertain).toBe(true);
    expect(discardOwnHeldText(shown[0]!.entry)).toBe(true);
    // NoticeComposer reads exactly this record on its own (its line 97);
    // nothing in either holder means nothing returns and nothing stays locked.
    expect(readPendingNoticeSend('person-a|chapter-a')).toBeNull();
    syncResumeDraftContext(confirmed());
    expect(readResumeDraft(key)).toBeNull();
  });

  it('refuses to discard a notice whose send is still in flight, in both holders', () => {
    const { held, key } = attemptedNotice('op-key-2');
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    const shown = readOwnHeldText('person-a');
    expect(shown).toHaveLength(1);
    expect(discardOwnHeldText(shown[0]!.entry)).toBe(false);
    expect(readPendingNoticeSend('person-a|chapter-a')).not.toBeNull();
    updateNoticeSend(held, { busy: false, outcomeUnknown: true });
    expect(discardOwnHeldText(shown[0]!.entry)).toBe(true);
    expect(readPendingNoticeSend('person-a|chapter-a')).toBeNull();
    syncResumeDraftContext(confirmed());
    expect(readResumeDraft(key)).toBeNull();
  });

  it('does not offer a notice whose send already has a receipt', () => {
    const { held } = attemptedNotice('op-key-3');
    updateNoticeSend(held, { busy: false, confirmed: true });
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    expect(readOwnHeldText('person-a')).toEqual([]);
  });

  // Gate r1s2/r2s2 of #9417: companion send entries decide the line.
  it.each<'pending' | 'failed'>(['pending', 'failed'])('a reminder shows the uncertainty line while its send is %s', (state) => {
    const key = resumeDraftKey(confirmed(), 'workflowReminder', 'task:task-a')!;
    const sendKey = resumeDraftKey(confirmed(), 'workflowReminderSend', 'task:task-a')!;
    writeResumeDraft(key, { open: true, date: 0, chosen: true, note: 'Call the committee member', step: null });
    const send = writeResumeDraft(sendKey, { failed: false, saved: false }, true)!;
    if (state === 'failed') settleResumeDraft(send, { failed: true, saved: false });
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    const shown = readOwnHeldText('person-a');
    expect(shown.map(row => row.lines)).toEqual([['Call the committee member']]);
    expect(shown[0]!.uncertain).toBe(true);
  });

  it('a reminder with a saved receipt is not offered as unsent', () => {
    const key = resumeDraftKey(confirmed(), 'workflowReminder', 'task:task-a')!;
    const sendKey = resumeDraftKey(confirmed(), 'workflowReminderSend', 'task:task-a')!;
    writeResumeDraft(key, { open: true, date: 0, chosen: true, note: 'Call the committee member', step: null });
    const send = writeResumeDraft(sendKey, { failed: false, saved: false }, true)!;
    settleResumeDraft(send, { failed: false, saved: true });
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    expect(readOwnHeldText('person-a')).toEqual([]);
  });

  it('discarding a failed reminder retires its send entry with it', () => {
    const key = resumeDraftKey(confirmed(), 'workflowReminder', 'task:task-a')!;
    const sendKey = resumeDraftKey(confirmed(), 'workflowReminderSend', 'task:task-a')!;
    writeResumeDraft(key, { open: true, date: 0, chosen: true, note: 'Call the committee member', step: null });
    const send = writeResumeDraft(sendKey, { failed: false, saved: false }, true)!;
    settleResumeDraft(send, { failed: true, saved: false });
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    const shown = readOwnHeldText('person-a');
    expect(discardOwnHeldText(shown[0]!.entry)).toBe(true);
    syncResumeDraftContext(confirmed());
    expect(readResumeDraft(key)).toBeNull();
    expect(readResumeDraft(sendKey)).toBeNull();
  });

  it('refuses to discard while a companion send is in flight', () => {
    const key = resumeDraftKey(confirmed(), 'workflowReminder', 'task:task-a')!;
    const sendKey = resumeDraftKey(confirmed(), 'workflowReminderSend', 'task:task-a')!;
    writeResumeDraft(key, { open: true, date: 0, chosen: true, note: 'Call the committee member', step: null });
    writeResumeDraft(sendKey, { failed: false, saved: false }, true);
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    const shown = readOwnHeldText('person-a');
    expect(discardOwnHeldText(shown[0]!.entry)).toBe(false);
    syncResumeDraftContext(confirmed());
    expect(readResumeDraft(key)).not.toBeNull();
    expect(readResumeDraft(sendKey)).not.toBeNull();
  });

  it.each<'pending' | 'failed'>(['pending', 'failed'])('a channel keyword shows the uncertainty line while its save is %s', (state) => {
    const key = resumeDraftKey(confirmed(), 'channelSettings', 'space-a')!;
    const sendKey = resumeDraftKey(confirmed(), 'channelSettingSend', 'space-a')!;
    writeResumeDraft(key, { keyword: 'walkout', duration: '8h' });
    const send = writeResumeDraft(sendKey, { failed: false, saved: null, keywordOperation: true }, true)!;
    if (state === 'failed') settleResumeDraft(send, { failed: true, saved: null, keywordOperation: true, outcomeUnknown: true });
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    const shown = readOwnHeldText('person-a');
    expect(shown.map(row => row.lines)).toEqual([['walkout']]);
    expect(shown[0]!.uncertain).toBe(true);
  });

  // #9426 round 1: a failed companion whose outcome is known (a confirmed
  // rejection) does not carry the uncertainty line either.
  it('a channel keyword whose save failed with a known outcome shows no uncertainty line', () => {
    const key = resumeDraftKey(confirmed(), 'channelSettings', 'space-a')!;
    const sendKey = resumeDraftKey(confirmed(), 'channelSettingSend', 'space-a')!;
    writeResumeDraft(key, { keyword: 'walkout', duration: '8h' });
    const send = writeResumeDraft(sendKey, { failed: false, saved: null, keywordOperation: true }, true)!;
    settleResumeDraft(send, { failed: true, saved: null, keywordOperation: true, outcomeUnknown: false });
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    const shown = readOwnHeldText('person-a');
    expect(shown.map(row => row.lines)).toEqual([['walkout']]);
    expect(shown[0]!.uncertain).toBe(false);
  });

  it('a channel keyword with a keyword-save receipt is not offered as unsent', () => {
    const key = resumeDraftKey(confirmed(), 'channelSettings', 'space-a')!;
    const sendKey = resumeDraftKey(confirmed(), 'channelSettingSend', 'space-a')!;
    writeResumeDraft(key, { keyword: 'walkout', duration: '8h' });
    const send = writeResumeDraft(sendKey, { failed: false, saved: null, keywordOperation: true }, true)!;
    settleResumeDraft(send, { failed: false, saved: normalizeChannelSetting({ keywords: ['walkout'] }, 'space-a'), keywordOperation: true });
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    expect(readOwnHeldText('person-a')).toEqual([]);
  });

  // Ledger 679: one companion serves mute, level and keyword saves; only a
  // keyword receipt may hide the keyword row.
  it.each<'pending' | 'receipt'>(['pending', 'receipt'])('an unrelated channel save (%s) does not suppress or mark a typed keyword', (state) => {
    const key = resumeDraftKey(confirmed(), 'channelSettings', 'space-a')!;
    const sendKey = resumeDraftKey(confirmed(), 'channelSettingSend', 'space-a')!;
    writeResumeDraft(key, { keyword: 'walkout', duration: '8h' });
    const send = writeResumeDraft(sendKey, { failed: false, saved: null, keywordOperation: false }, true)!;
    if (state === 'receipt') settleResumeDraft(send, { failed: false, saved: normalizeChannelSetting({ muted: true }, 'space-a'), keywordOperation: false });
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    const shown = readOwnHeldText('person-a');
    expect(shown.map(row => row.lines)).toEqual([['walkout']]);
    expect(shown[0]!.uncertain).toBe(false);
    expect(shown[0]!.canDiscard).toBe(true);
  });

  // Ledger 680: the mounted settings panel consumes the failed companion;
  // the attempt survives on the keyword draft itself.
  it('a keyword draft stamped attempted shows the uncertainty line with no companion left', () => {
    const key = resumeDraftKey(confirmed(), 'channelSettings', 'space-a')!;
    writeResumeDraft(key, { keyword: 'walkout', duration: '8h', attempted: true });
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    const shown = readOwnHeldText('person-a');
    expect(shown.map(row => row.lines)).toEqual([['walkout']]);
    expect(shown[0]!.uncertain).toBe(true);
  });

  // Ledger 681: the row says whether Discard can run right now.
  it('a row whose send is pending reports canDiscard false; a settled row reports true', () => {
    const key = resumeDraftKey(confirmed(), 'workflowReminder', 'task:task-a')!;
    const sendKey = resumeDraftKey(confirmed(), 'workflowReminderSend', 'task:task-a')!;
    writeResumeDraft(key, { open: true, date: 0, chosen: true, note: 'Call the committee member', step: null });
    const send = writeResumeDraft(sendKey, { failed: false, saved: false }, true)!;
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    expect(readOwnHeldText('person-a')[0]!.canDiscard).toBe(false);
    settleResumeDraft(send, { failed: true, saved: false });
    expect(readOwnHeldText('person-a')[0]!.canDiscard).toBe(true);
  });

  const invitationCases: readonly (readonly [string, boolean])[] = [['failed', true], ['not-permitted', false]];
  it.each(invitationCases)('an invitation attempted with outcome code %s shows uncertainty=%s', (code, uncertain) => {
    const key = resumeDraftKey(confirmed(), 'invitation', 'member-invitation')!;
    writeResumeDraft(key, { fullName: 'Sam Worker', email: 'sam@example.org', locale: 'en', notice: { code, retryAt: null } });
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext(checking());
    const shown = readOwnHeldText('person-a');
    expect(shown.map(row => row.lines)).toEqual([['Sam Worker', 'sam@example.org']]);
    expect(shown[0]!.uncertain).toBe(uncertain);
  });

  it('an account change shows nothing of the previous person', () => {
    const key = resumeDraftKey(confirmed(), 'notice', 'chapter-notices')!;
    writeResumeDraft(key, notice());
    noteResumeDraftReadFailure({ status: 0 });
    syncResumeDraftContext({ ...checking(), session: { user: { id: 'person-b' } } });
    expect(readOwnHeldText('person-b')).toEqual([]);
    expect(readOwnHeldText('person-a')).toEqual([]);
  });
});
