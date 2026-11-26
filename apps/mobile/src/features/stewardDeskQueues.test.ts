import { stubSessionWriter } from '../testing/stubSessionWriter';
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => null, captureSessionWriter: () => ({ ...stubSessionWriter(() => null), check: async () => runtime.proof, isCurrent: async () => runtime.proof === 'current' }) }));
// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StewardFormReviewRow } from '../services/stewardDeskSections';

const runtime = vi.hoisted(() => ({
  userID: 'steward-1',
  role: 'steward' as string | null,
  authorizedRoles: ['steward'] as string[],
  chapterID: 'chapter-a',
  language: 'en',
  platform: 'ios',
  proof: 'current' as 'current' | 'changed' | 'unavailable',
  loadCases: vi.fn(),
  loadRequests: vi.fn(),
  loadForms: vi.fn(),
  loadBroadcasts: vi.fn(),
  loadAudiences: vi.fn(),
  triage: vi.fn(),
  review: vi.fn(),
  send: vi.fn(),
  // One operation key per notice draft (#9220).
  newKey: vi.fn(async () => 'draft-key'),
  detail: vi.fn(),
  block: vi.fn((): string | null => null),
  push: vi.fn(),
  Changed: class StewardFormChangedError extends Error {},
  ReturnBlocked: class StewardFormReturnBlockedError extends Error {},
}));

vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    session: { user: { id: runtime.userID } },
    dashboard: { member: { id: runtime.userID } },
    chosenStaffRole: runtime.role,
    authorizedRoles: runtime.authorizedRoles,
    chapterMemberships: [{ chapterID: runtime.chapterID, selected: true }],
    memberLanguage: runtime.language,
    captureAccountSessionGuard: (userID: string) => () => runtime.userID === userID,
  }),
}));
vi.mock('../theme/ThemeProvider', () => ({
  useTheme: () => ({
    primary: '#4c1d4e', mutedForeground: '#5c4a3a', foreground: '#24160f', input: '#fffaf3',
    border: '#c4b2a1', destructive: '#8f1d1d', appearance: 'light',
  }),
}));
vi.mock('../services/haptics', () => ({ haptics: { select: async () => {}, success: async () => {} } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: runtime.push }) }));
vi.mock('../services/stewardDeskSections', () => ({
  loadStewardCaseload: runtime.loadCases,
  loadStewardRequests: runtime.loadRequests,
  loadStewardFormsForReview: runtime.loadForms,
  loadStewardBroadcasts: runtime.loadBroadcasts,
  loadStewardNoticeAudiences: runtime.loadAudiences,
  triageStewardRequest: runtime.triage,
  reviewStewardForm: runtime.review,
  sendChapterBroadcast: runtime.send,
  newNoticeOperationKey: runtime.newKey,
  StewardFormChangedError: runtime.Changed,
  StewardFormReturnBlockedError: runtime.ReturnBlocked,
}));
vi.mock('../services/stewardFormReview', () => ({
  loadStewardFormReviewDetail: runtime.detail,
  formatFormSubmittedAt: () => 'Submitted Jan 2, 2026 ET',
  stewardFormApprovalBlock: () => runtime.block(),
}));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    Platform: { get OS() { return runtime.platform; } },
    View: text,
    Text: text,
    TextInput: ({ accessibilityLabel, value, onChangeText }: { accessibilityLabel?: string; value?: string; onChangeText?: (value: string) => void }) => h('input', {
      'aria-label': accessibilityLabel, value, onChange: () => {},
      onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText?.(event.currentTarget.value),
    }),
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string }) => (
      h('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, children)
    ),
    StyleSheet: { create: <T,>(value: T) => value },
  };
});
vi.mock('../components/ui', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    Body: text,
    Heading: text,
    Card: text,
    Screen: text,
    Button: ({ label, onPress, disabled, accessibilityLabel }: { label: string; onPress?: () => void; disabled?: boolean; accessibilityLabel?: string }) => (
      h('button', { type: 'button', onClick: onPress, disabled, 'aria-label': accessibilityLabel ?? label }, label)
    ),
    StateMessage: ({ title, body }: { title: string; body: string }) => h('div', null, title, body),
  };
});

import { StewardDeskSectionsScreen } from './StewardDeskSectionsScreen';
import { nativeUiText } from '../lib/nativeUiCopy';

let root: Root;
let host: HTMLDivElement;
const unitAudience = { value: 'unit:unit-a', kind: 'unit', chapterId: 'chapter-a', unitId: 'unit-a', name: 'Unit A' };

function listPage<T, C>(rows: T[], total: number | null, nextCursor: C | null) {
  return { rows, total, nextCursor };
}

function formRow(id: string, memberName: string): StewardFormReviewRow {
  return {
    id,
    memberName,
    userID: 'member-1',
    templateKey: 'grievance',
    templateLabel: 'Workplace issue report',
    templateVersion: 1,
    submittedAt: '2026-01-02T15:00:00Z',
    status: 'submitted',
    answers: { what: 'A fictional schedule change' },
    protectedAnswers: false,
    answersHidden: false,
  };
}

async function render(featureKey: 'steward-caseload' | 'steward-requests' | 'steward-forms' | 'steward-broadcasts') {
  await act(async () => { root.render(createElement(StewardDeskSectionsScreen, { featureKey })); });
}

async function clickLabel(label: string, index = 0) {
  const buttons = Array.from(host.querySelectorAll('button')).filter((item) => item.getAttribute('aria-label') === label || item.textContent === label);
  const button = buttons[index];
  expect(button, label).toBeTruthy();
  await act(async () => { button?.click(); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.userID = 'steward-1';
  runtime.role = 'steward';
  runtime.authorizedRoles = ['steward'];
  runtime.chapterID = 'chapter-a';
  runtime.language = 'en';
  runtime.platform = 'ios';
  runtime.proof = 'current';
  runtime.loadCases.mockReset();
  runtime.loadRequests.mockReset();
  runtime.loadForms.mockReset();
  runtime.loadBroadcasts.mockReset();
  runtime.loadAudiences.mockReset().mockResolvedValue([unitAudience]);
  runtime.triage.mockReset().mockResolvedValue(undefined);
  runtime.review.mockReset().mockResolvedValue(undefined);
  runtime.send.mockReset().mockResolvedValue(undefined);
  runtime.detail.mockReset().mockResolvedValue({
    templateLabel: 'Workplace issue report',
    templateVersion: 1,
    submittedAt: '2026-01-02T15:00:00Z',
    lines: [{ label: 'What happened', value: 'A fictional schedule change' }],
    answersUnavailable: false,
    filingUnavailable: false,
    filerSigned: true,
    attachments: [],
    cosigners: [],
    cosignersUnavailable: false,
    expectation: { answers: { what: 'A fictional schedule change' }, attachmentIds: [], cosignerIds: [] },
  });
  runtime.push.mockReset();
  runtime.block.mockReset().mockReturnValue(null);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function fillNotice() {
  await act(async () => {
    for (const [label, value] of [['Broadcast title', 'Unit meeting'], ['Broadcast message', 'For our unit']]) {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      input.value = value!;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

describe('native notice audience form', () => {
  beforeEach(() => { runtime.loadBroadcasts.mockResolvedValue(listPage([], 0, null)); });

  it('names and sends to the actual granted unit', async () => {
    await render('steward-broadcasts');
    expect(runtime.loadAudiences).toHaveBeenCalledWith('chapter-a', 'steward');
    expect(host.textContent).toContain('Unit: Unit A');
    await fillNotice();
    await clickLabel('Send unit notice');
    expect(runtime.send).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'Unit meeting', 'For our unit', unitAudience, 'en', 'draft-key');
  });

  //  on #8713: a single-role account is offered no hat choice, so
  // chosenStaffRole stays null and its sole confirmed role is the desk role.
  it('loads and sends the granted unit for a single-role committee member with no chosen hat', async () => {
    runtime.role = null;
    await render('steward-broadcasts');
    expect(runtime.loadAudiences).toHaveBeenCalledWith('chapter-a', 'steward');
    expect(host.textContent).toContain('Unit: Unit A');
    await fillNotice();
    await clickLabel('Send unit notice');
    expect(runtime.send).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'Unit meeting', 'For our unit', unitAudience, 'en', 'draft-key');
  });

  it('loads no audience while a several-role account has not chosen a hat', async () => {
    runtime.role = null;
    runtime.authorizedRoles = ['steward', 'vp'];
    await render('steward-broadcasts');
    expect(runtime.loadAudiences).not.toHaveBeenCalledWith('chapter-a', 'steward');
    expect(runtime.send).not.toHaveBeenCalled();
  });

  it('preserves broad campaign publication for a leader', async () => {
    runtime.role = 'vp';
    const chapter = { value: 'chapter', kind: 'chapter', chapterId: 'chapter-a', name: '' };
    runtime.loadAudiences.mockResolvedValue([chapter]);
    await render('steward-broadcasts');
    expect(host.textContent).toContain('My campaign');
    await fillNotice();
    await clickLabel('Send notice');
    expect(runtime.send).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'Unit meeting', 'For our unit', chapter, 'en', 'draft-key');
  });

  it('disables sends while checking or missing a grant, then preserves text across an audience reload', async () => {
    let resolve!: (value: unknown[]) => void;
    runtime.loadAudiences.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await render('steward-broadcasts');
    await fillNotice();
    expect(host.textContent).toContain('Checking notice audience');
    await clickLabel('Send notice');
    expect(runtime.send).not.toHaveBeenCalled();
    await act(async () => { resolve([]); });
    expect(host.textContent).toContain('No notice audience is available');
    await clickLabel('Send notice');
    expect(runtime.send).not.toHaveBeenCalled();
    await clickLabel('Reload audiences');
    await clickLabel('Send unit notice');
    expect(runtime.send).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'Unit meeting', 'For our unit', unitAudience, 'en', 'draft-key');
  });

  it('drops old campaign audience answers and draft text after switching campaigns', async () => {
    let resolve!: (value: unknown[]) => void;
    runtime.loadAudiences.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await render('steward-broadcasts');
    await fillNotice();
    runtime.chapterID = 'chapter-b';
    runtime.loadAudiences.mockResolvedValue([{ ...unitAudience, chapterId: 'chapter-b', name: 'Unit B' }]);
    await render('steward-broadcasts');
    await act(async () => { resolve([unitAudience]); });
    expect(host.textContent).toContain('Unit: Unit B');
    expect(host.textContent).not.toContain('Unit: Unit A');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Broadcast title"]')?.value).toBe('');
    await clickLabel('Send unit notice');
    expect(runtime.send).not.toHaveBeenCalled();
  });

  it('requires a fresh audience after server revocation without retrying a broader send', async () => {
    runtime.send.mockRejectedValueOnce(Object.assign(new Error('Reload audiences before sending.'), { code: 'notice_audience_unavailable' }));
    await render('steward-broadcasts');
    await fillNotice();
    await clickLabel('Send unit notice');
    expect(host.textContent).toContain('Reload audiences before sending.');
    await clickLabel('Send notice');
    expect(runtime.send).toHaveBeenCalledTimes(1);
    await clickLabel('Reload audiences');
    await clickLabel('Send unit notice');
    expect(runtime.send).toHaveBeenCalledTimes(2);
  });

  // #9117: the notice carries the language it is written in, starting at the
  // account's language, as the website's notice desk does.
  it('sends an English account notice as English unless Español is chosen', async () => {
    await render('steward-broadcasts');
    expect(host.textContent).toContain('Notice language');
    await fillNotice();
    await clickLabel('Español');
    await clickLabel('Send unit notice');
    expect(runtime.send).toHaveBeenLastCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'Unit meeting', 'For our unit', unitAudience, 'es', 'draft-key');
    await fillNotice();
    await clickLabel('Send unit notice');
    expect(runtime.send).toHaveBeenLastCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'Unit meeting', 'For our unit', unitAudience, 'en', 'draft-key');
  });
});

// The audience controls and the recovery
// messages follow the member's saved language.
describe('native notice audience form in Spanish (ledger 207)', () => {
  const es = nativeUiText('es');
  beforeEach(() => {
    runtime.language = 'es';
    runtime.loadBroadcasts.mockResolvedValue(listPage([{ id: 'b-1', title: 'Reunión de la unidad', retracted: true }], 1, null));
  });

  it('shows the audience controls, the form and a retracted broadcast in Spanish', async () => {
    await render('steward-broadcasts');
    const text = host.textContent ?? '';
    expect(text).toContain(es('Send a notice to your granted audience. Workers there see it in Announcements.'));
    expect(text).toContain(es('Retracted'));
    expect(text).toContain(es('Unit: {name}', { name: 'Unit A' }));
    expect(host.querySelector(`input[aria-label="${es('Broadcast title')}"]`)).toBeTruthy();
    expect(host.querySelector(`input[aria-label="${es('Broadcast message')}"]`)).toBeTruthy();
    expect(Array.from(host.querySelectorAll('button')).map((button) => button.textContent)).toContain(es('Send unit notice'));
    for (const english of ['Send a notice to your granted audience', 'Unit: Unit A', 'Send unit notice', 'Retracted']) expect(text).not.toContain(english);
  });

  it('says in Spanish when the audience is missing, could not be checked, or was revoked on send, and when a broadcast failed', async () => {
    runtime.loadAudiences.mockResolvedValueOnce([]);
    await render('steward-broadcasts');
    expect(host.textContent).toContain(es('No notice audience is available for this role. Ask your campaign lead to check your unit assignment.'));
    await clickLabel(es('Reload audiences'));
    runtime.send.mockRejectedValueOnce(Object.assign(new Error('Your notice audience is unavailable. Reload audiences before sending.'), { code: 'notice_audience_unavailable' }));
    await fillNoticeIn(es('Broadcast title'), es('Broadcast message'));
    await clickLabel(es('Send unit notice'));
    expect(host.textContent).toContain(es('Your notice audience is unavailable. Reload audiences before sending.'));
    await clickLabel(es('Try again'));
    await clickLabel(es('Reload audiences'));
    // A refusal the server answered (sendChapterBroadcast marks it, #9099
    // part 2); a send with no answer locks the notice instead.
    runtime.send.mockRejectedValueOnce(Object.assign(new Error('The broadcast was not sent. Try again.'), { serverAnswered: true }));
    await clickLabel(es('Send unit notice'));
    expect(host.textContent).toContain(es('The broadcast was not sent. Try again.'));
    runtime.loadAudiences.mockRejectedValueOnce(new Error('offline'));
    runtime.chapterID = 'chapter-b';
    await render('steward-broadcasts');
    expect(host.textContent).toContain(es('Your notice audience could not be checked.'));
    expect(host.textContent).not.toMatch(/notice audience|broadcast was not sent|Try again/u);
  });
});

// #9117: a Spanish-language officer's notice is stored as Spanish by default,
// and as English once the officer chooses English.
// #9609: the demo's Broadcasts list showed the same title several times with
// nothing to tell the copies apart. Each sent row now says when it went out,
// in the member's language, on the group clock of the zone module.
describe('sent broadcasts say when they were sent (#9609)', () => {
  const rows = [
    { id: 'b-1', title: 'Relief coverage notes are ready', publishedAt: '2026-11-13T19:00:00+00:00', retracted: false },
    { id: 'b-2', title: 'Relief coverage notes are ready', publishedAt: '2026-11-07T19:00:00+00:00', retracted: false },
    { id: 'b-3', title: 'Heat alert', publishedAt: '2026-07-01T13:05:00+00:00', retracted: true },
    { id: 'b-4', title: 'No stamp', publishedAt: null, retracted: false },
  ];
  beforeEach(() => { runtime.loadBroadcasts.mockResolvedValue(listPage(rows, 4, null)); });

  it('shows each row its own send date and time, with the zone named', async () => {
    await render('steward-broadcasts');
    const text = host.textContent ?? '';
    expect(text).toContain('Sent Nov 13, 2026, 2:00 PM EST');
    expect(text).toContain('Sent Nov 7, 2026, 2:00 PM EST');
    expect(text).toContain('Sent Jul 1, 2026, 9:05 AM EDT');
    expect(text.match(/Sent /gu)).toHaveLength(3);
  });

  // Sol on 90834b69: a stamp the formatter cannot read shows no bare "Sent",
  // and each label sits on its own row.
  it('puts each send time on its own row and shows no bare label for an unreadable stamp', async () => {
    runtime.loadBroadcasts.mockResolvedValue(listPage([
      ...rows.slice(0, 2),
      { id: 'b-5', title: 'Unreadable stamp', publishedAt: 'not-a-date', retracted: false },
    ], 3, null));
    await render('steward-broadcasts');
    // The row's heading is a leaf holding the title; its card is the parent.
    const card = (title: string, index = 0) => Array.from(host.querySelectorAll('div'))
      .filter((node) => node.children.length === 0 && node.textContent === title)[index]?.parentElement?.textContent ?? '';
    expect(card('Relief coverage notes are ready', 0)).toBe('Relief coverage notes are readySent Nov 13, 2026, 2:00 PM EST');
    expect(card('Relief coverage notes are ready', 1)).toBe('Relief coverage notes are readySent Nov 7, 2026, 2:00 PM EST');
    expect(card('Unreadable stamp')).toBe('Unreadable stamp');
    expect(host.textContent).not.toMatch(/Sent (?!Nov)/u);
  });

  it('writes the send date in Spanish for a Spanish-speaking worker', async () => {
    runtime.language = 'es';
    await render('steward-broadcasts');
    const text = host.textContent ?? '';
    expect(text).toContain('Enviado 13 nov 2026, 2:00 p. m. EST');
    expect(text).toContain('Enviado 7 nov 2026, 2:00 p. m. EST');
    expect(text).toContain('Enviado 1 jul 2026, 9:05 a. m. EDT');
    expect(text).not.toContain('Sent ');
  });
});

describe('native notice language (#9117)', () => {
  const es = nativeUiText('es');
  beforeEach(() => {
    runtime.language = 'es';
    runtime.loadBroadcasts.mockResolvedValue(listPage([], 0, null));
  });

  it('sends in Spanish by default for a Spanish account, and in English after choosing English', async () => {
    await render('steward-broadcasts');
    expect(host.textContent).toContain(es('Notice language'));
    await fillNoticeIn(es('Broadcast title'), es('Broadcast message'));
    await clickLabel(es('Send unit notice'));
    expect(runtime.send).toHaveBeenLastCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'Reunión', 'Para la unidad', unitAudience, 'es', 'draft-key');
    await fillNoticeIn(es('Broadcast title'), es('Broadcast message'));
    await clickLabel('English');
    await clickLabel(es('Send unit notice'));
    expect(runtime.send).toHaveBeenLastCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'Reunión', 'Para la unidad', unitAudience, 'en', 'draft-key');
  });

  it('keeps the chosen language after a failed send and returns to the account language on a new campaign', async () => {
    // A refusal the server answered (sendChapterBroadcast marks it, #9099
    // part 2); a send with no answer locks the notice instead.
    runtime.send.mockRejectedValueOnce(Object.assign(new Error('The broadcast was not sent. Try again.'), { serverAnswered: true }));
    await render('steward-broadcasts');
    await fillNoticeIn(es('Broadcast title'), es('Broadcast message'));
    await clickLabel('English');
    await clickLabel(es('Send unit notice'));
    expect(runtime.send).toHaveBeenLastCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'Reunión', 'Para la unidad', unitAudience, 'en', 'draft-key');
    await clickLabel(es('Send unit notice'));
    expect(runtime.send).toHaveBeenLastCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'Reunión', 'Para la unidad', unitAudience, 'en', 'draft-key');
    runtime.chapterID = 'chapter-b';
    runtime.loadAudiences.mockResolvedValue([{ ...unitAudience, chapterId: 'chapter-b' }]);
    await render('steward-broadcasts');
    await fillNoticeIn(es('Broadcast title'), es('Broadcast message'));
    await clickLabel(es('Send unit notice'));
    expect(runtime.send).toHaveBeenLastCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'Reunión', 'Para la unidad', { ...unitAudience, chapterId: 'chapter-b' }, 'es', 'draft-key');
  });
});

async function fillNoticeIn(titleLabel: string, messageLabel: string) {
  await act(async () => {
    for (const [label, value] of [[titleLabel, 'Reunión'], [messageLabel, 'Para la unidad']]) {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      input.value = value!;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

describe('committee member desk queue paging', () => {
  it.each([['en', 'Dismiss'], ['es', 'Descartar']])('dismisses a refused request without sending it again (%s)', async (language, dismiss) => {
    runtime.language = language;
    runtime.loadRequests.mockResolvedValue(listPage([{ id: 'request-1', memberName: 'Fictional Worker', topic: 'Support', status: 'requested' }], 1, null));
    runtime.triage.mockRejectedValueOnce(new Error('Fixture refusal'));
    await render('steward-requests');
    await clickLabel('Close request');
    expect(host.textContent).toContain('Fixture refusal');
    await clickLabel(dismiss);
    expect(host.textContent).not.toContain('Fixture refusal');
    expect(runtime.triage).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['en', 'Showing 1 of 1,001 requests (open and closed)'],
    ['es', 'Mostrando 1 de 1.001 solicitudes (abiertas y cerradas)'],
  ])('names the all-status request total and groups counts in %s', async (lang, label) => {
    runtime.language = lang;
    runtime.loadRequests.mockResolvedValue(listPage([{ id: 'request-1', memberName: 'Fictional Worker', topic: 'Support', status: 'requested' }], 1001, null));
    await render('steward-requests');
    expect(host.textContent).toContain(label);
  });
  it.each(['en', 'es'])('hides the previous request footer during a campaign fetch in %s', async (lang) => {
    runtime.language = lang;
    let answer!: (page: ReturnType<typeof listPage>) => void;
    runtime.loadRequests
      .mockResolvedValueOnce(listPage([{ id: 'request-1', memberName: 'Fictional Worker', topic: 'Support', status: 'requested' }], 418, null))
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await render('steward-requests');
    expect(host.textContent).toContain(lang === 'es' ? 'Mostrando 1 de 418 solicitudes (abiertas y cerradas)' : 'Showing 1 of 418 requests (open and closed)');
    runtime.chapterID = 'chapter-b';
    await render('steward-requests');
    expect(host.textContent).toContain('Loading worker requests');
    expect(host.textContent).not.toContain('418');
    await act(async () => { answer(listPage([{ id: 'request-2', memberName: 'Other fictional worker', topic: 'Support', status: 'closed' }], 406, null)); });
    expect(host.textContent).toContain(lang === 'es' ? 'Mostrando 1 de 406 solicitudes (abiertas y cerradas)' : 'Showing 1 of 406 requests (open and closed)');
  });
  it.each(['en', 'es'])('keeps the confirmed request footer while refreshing after triage in %s', async (lang) => {
    runtime.language = lang;
    let answer!: (page: ReturnType<typeof listPage>) => void;
    runtime.loadRequests
      .mockResolvedValueOnce(listPage([{ id: 'request-1', memberName: 'Fictional Worker', topic: 'Support', status: 'requested' }], 418, null))
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await render('steward-requests');
    await clickLabel('Close request');
    expect(host.textContent).toContain('Fictional Worker');
    expect(host.textContent).toContain(lang === 'es' ? 'Mostrando 1 de 418 solicitudes (abiertas y cerradas)' : 'Showing 1 of 418 requests (open and closed)');
    await act(async () => { answer(listPage([{ id: 'request-1', memberName: 'Fictional Worker', topic: 'Support', status: 'closed' }], 418, null)); });
    expect(host.textContent).toContain(lang === 'es' ? 'Mostrando 1 de 418 solicitudes (abiertas y cerradas)' : 'Showing 1 of 418 requests (open and closed)');
  });
  it.each(['en', 'es'])('keeps the all-status footer while another request page is pending in %s', async (lang) => {
    runtime.language = lang;
    let answer!: (page: ReturnType<typeof listPage>) => void;
    runtime.loadRequests
      .mockResolvedValueOnce(listPage([{ id: 'request-1', memberName: 'Fictional Worker', topic: 'Support', status: 'requested' }], 418, { id: 'request-1', createdAt: '2026-01-02T15:00:00Z' }))
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await render('steward-requests');
    await clickLabel('Load more');
    expect(host.textContent).toContain(lang === 'es' ? 'Mostrando 1 de 418 solicitudes (abiertas y cerradas)' : 'Showing 1 of 418 requests (open and closed)');
    await act(async () => { answer(listPage([{ id: 'request-2', memberName: 'Other fictional worker', topic: 'Support', status: 'closed' }], 418, null)); });
    expect(host.textContent).toContain(lang === 'es' ? 'Mostrando 2 de 418 solicitudes (abiertas y cerradas)' : 'Showing 2 of 418 requests (open and closed)');
  });
  it('keeps the first issues when the next page fails, then opens the last issue', async () => {
    runtime.loadCases
      .mockResolvedValueOnce(listPage(
        [{ id: 'case-1', reference: 'C-1', title: 'First issue', status: 'active' }],
        101,
        { updatedAt: '2026-01-02T15:00:00Z', id: 'case-1' },
      ))
      .mockRejectedValueOnce(new Error('Your caseload did not load. Try again.'))
      .mockResolvedValueOnce(listPage(
        [{ id: 'case-101', reference: 'C-101', title: 'Final issue', status: 'active' }],
        null,
        null,
      ));
    await render('steward-caseload');
    expect(host.textContent).toContain('Showing 1 of 101');
    expect(host.textContent).toContain('First issue');
    await clickLabel('Load more');
    expect(host.textContent).toContain('First issue');
    expect(host.textContent).toContain('Your caseload did not load. Try again.');
    expect(runtime.loadCases).toHaveBeenLastCalledWith('steward-1', { updatedAt: '2026-01-02T15:00:00Z', id: 'case-1' });
    await clickLabel('Try again');
    expect(host.textContent).toContain('First issue');
    expect(host.textContent).toContain('Final issue');
    expect(host.textContent).toContain('Showing 2 of 101');
    expect(host.textContent).toContain('End of the list.');
    expect(host.textContent).not.toContain('Load more');
    // The row is named by its visible reference, title and status (#7816).
    await clickLabel('C-101, Final issue, Active');
    expect(runtime.push).toHaveBeenCalledWith('/issue/case-101');
  });

  it('drops the loaded page when the worn role or campaign changes', async () => {
    runtime.loadCases
      .mockResolvedValueOnce(listPage(
        [{ id: 'case-1', reference: 'C-1', title: 'First issue', status: 'active' }],
        1,
        null,
      ))
      .mockResolvedValueOnce(listPage(
        [{ id: 'case-b', reference: 'C-B', title: 'Other campaign', status: 'active' }],
        1,
        null,
      ));
    await render('steward-caseload');
    expect(host.textContent).toContain('First issue');
    runtime.chapterID = 'chapter-b';
    runtime.role = 'coordinator';
    await render('steward-caseload');
    expect(host.textContent).toContain('Other campaign');
    expect(host.textContent).not.toContain('First issue');
    expect(runtime.loadCases).toHaveBeenLastCalledWith('steward-1', null);
  });

  it('acknowledges the request that arrives on the page after the first 50', async () => {
    runtime.loadRequests
      .mockResolvedValueOnce(listPage(
        [{ id: 'request-1', memberName: 'Ada', topic: '', status: 'acknowledged' }],
        51,
        { createdAt: '2026-01-02T15:00:00Z', id: 'request-1' },
      ))
      .mockResolvedValueOnce(listPage(
        [{ id: 'request-51', memberName: 'Final worker', topic: 'Overtime', status: 'requested' }],
        null,
        null,
      ))
      .mockResolvedValue(listPage([], 0, null));
    await render('steward-requests');
    await clickLabel('Load more');
    expect(host.textContent).toContain('Final worker');
    expect(host.textContent).toContain('End of the list.');
    await clickLabel('Acknowledge');
    expect(runtime.triage).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'request-51', 'acknowledge');
  });

  it('starts review on the form that arrives after the first page', async () => {
    runtime.loadForms
      .mockResolvedValueOnce(listPage([formRow('form-1', 'Ada')], 51, { submittedAt: '2026-01-02T15:00:00Z', id: 'form-1' }))
      .mockResolvedValueOnce(listPage([formRow('form-51', 'Final person')], null, null))
      .mockResolvedValue(listPage([], 0, null));
    await render('steward-forms');
    await clickLabel('Load more');
    expect(host.textContent).toContain('Final person');
    await clickLabel('Review', 1);
    expect(host.textContent).toContain('A fictional schedule change');
    await clickLabel('Start review');
    expect(runtime.review).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'form-51', 'start', '', null);
  });

  it('shows the broadcast that arrives after the first 20', async () => {
    runtime.loadBroadcasts
      .mockResolvedValueOnce(listPage(
        [{ id: 'broadcast-1', title: 'First notice', retracted: false }],
        21,
        { publishedAt: '2026-01-02T15:00:00Z', id: 'broadcast-1' },
      ))
      .mockResolvedValueOnce(listPage(
        [{ id: 'broadcast-21', title: 'Final notice', retracted: false }],
        null,
        null,
      ));
    await render('steward-broadcasts');
    await clickLabel('Load more');
    expect(host.textContent).toContain('First notice');
    expect(host.textContent).toContain('Final notice');
    expect(host.textContent).toContain('Showing 2 of 21');
    expect(host.textContent).toContain('End of the list.');
    expect(runtime.loadBroadcasts).toHaveBeenLastCalledWith({ publishedAt: '2026-01-02T15:00:00Z', id: 'broadcast-1' });
  });
});

describe.each<'ios' | 'android'>(['ios', 'android'])('round 1 committee member recovery on %s', os => {
  beforeEach(() => { runtime.platform = os; });
  it.each<'en' | 'es'>(['en', 'es'])('keeps a refused filing disabled until its queue and detail refresh in %s', async language => {
    runtime.language = language;
    const before = formRow('form-1', 'Ada');
    const after = { ...before, answers: { what: 'Current filing' } };
    runtime.loadForms.mockResolvedValueOnce(listPage([before], 1, null)).mockResolvedValue(listPage([after], 1, null));
    runtime.review.mockRejectedValueOnce(new runtime.Changed('form_changed_since_review'));
    await render('steward-forms'); await clickLabel(language === 'es' ? 'Revisar' : 'Review');
    runtime.proof = 'unavailable'; await clickLabel('Approve');
    const approve = host.querySelector<HTMLButtonElement>('button[aria-label="Approve"]');
    expect(approve?.disabled).toBe(true);
    expect(host.textContent).not.toContain(nativeUiText(language)('This filing changed after you opened it (it was resubmitted, or a co-signer joined or withdrew), so it was not approved. What is on file now is shown; review it again before approving.'));
    expect(host.textContent).toContain(nativeUiText(language)('This filing changed after you opened it, so it was not approved. Refresh it before reviewing again.'));
    await clickLabel('Approve'); expect(runtime.review).toHaveBeenCalledTimes(1);
    const refresh = nativeUiText(language)('Refresh');
    expect([...host.querySelectorAll('button')].some(button => button.textContent === refresh)).toBe(true);
    runtime.proof = 'current';
    let finish!: (detail: unknown) => void;
    runtime.detail.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await clickLabel(refresh);
    expect([...host.querySelectorAll('button')].some(button => button.textContent === refresh)).toBe(true);
    expect(host.querySelector('button[aria-label="Approve"]')).toBeNull();
    const detail = { templateLabel: 'Workplace issue report', templateVersion: 1, submittedAt: '2026-01-02T15:00:00Z',
      lines: [{ label: 'What happened', value: 'Current filing' }], answersUnavailable: false, filingUnavailable: false,
      filerSigned: true, attachments: [], cosigners: [], cosignersUnavailable: false,
      expectation: { answers: after.answers, attachmentIds: [], cosignerIds: [] } };
    await act(async () => { finish(detail); });
    expect(host.textContent).toContain('Current filing');
    expect([...host.querySelectorAll('button')].some(button => button.textContent === refresh)).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Approve"]')?.disabled).toBe(false);
    expect(runtime.review).toHaveBeenCalledTimes(1);
  });

  it.each<'normal' | 'failure'>(['normal', 'failure'])('generic reread keeps the loaded page and stops at its extent (%s)', async kind => {
    const row = (index: number) => ({ id: `request-${index}`, memberName: `Worker ${index}`, topic: 'Support', status: 'requested' });
    let readingAgain = false;
    runtime.loadRequests.mockImplementation(async (cursor: { id: string } | null) => {
      const page = cursor ? Number(cursor.id.split('-')[1]) + 1 : 0;
      if (readingAgain && (kind === 'failure' || page > 0)) throw new Error('Page unavailable');
      return listPage(Array.from({ length: Math.min(50, 151 - page) }, (_, index) => row(page + index)), 151,
        page + 50 < 151 ? { id: `request-${page + 49}`, createdAt: '2026-01-01' } : null);
    });
    await render('steward-requests');
    readingAgain = true;
    await clickLabel('Acknowledge');
    expect(host.textContent).toContain('Worker 49');
    expect(host.textContent).toContain('Showing 50 of 151');
    expect(runtime.loadRequests).toHaveBeenCalledTimes(2);
    expect(runtime.triage).toHaveBeenCalledTimes(1);
  });
});

describe('native forms review approval (#8728)', () => {
  const changed = {
    en: 'This filing changed after you opened it (it was resubmitted, or a co-signer joined or withdrew), so it was not approved. What is on file now is shown; review it again before approving.',
    es: 'Esta presentación cambió después de que la abriste (se volvió a enviar, o un cofirmante se unió o se retiró), así que no se aprobó. Se muestra lo que está guardado ahora; revísalo de nuevo antes de aprobar.',
  };

  it('approves with what the review showed, including the co-signers', async () => {
    runtime.loadForms.mockResolvedValue(listPage([formRow('form-1', 'Ada')], 1, null));
    const shown = { answers: { what: 'A fictional schedule change' }, attachmentIds: ['file-1'], cosignerIds: ['cosigner-1'] };
    runtime.detail.mockResolvedValue({
      ...(await runtime.detail()),
      cosigners: [{ id: 'cosigner-1', name: 'Naomi Brooks' }],
      expectation: shown,
    });
    await render('steward-forms');
    await clickLabel('Review');
    expect(host.textContent).toContain('Co-signed by Naomi Brooks.');
    await clickLabel('Approve');
    expect(runtime.review).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'form-1', 'approve', '', shown);
  });

  it.each(['en', 'es'] as const)('shows the stored form and says why in %s when the filing changed, approving nothing', async (lang) => {
    runtime.language = lang;
    const before = formRow('form-1', 'Ada');
    const after = { ...before, answers: { what: 'The resubmitted schedule change' } };
    runtime.loadForms
      .mockResolvedValueOnce(listPage([before], 1, null))
      .mockResolvedValue(listPage([after], 1, null));
    runtime.detail.mockImplementation(async (item: StewardFormReviewRow) => ({
      templateLabel: 'Workplace issue report', templateVersion: 1, submittedAt: '2026-01-02T15:00:00Z',
      lines: [{ label: 'What happened', value: String(item.answers.what) }],
      answersUnavailable: false, filingUnavailable: false, filerSigned: true, attachments: [],
      cosigners: [], cosignersUnavailable: false,
      expectation: { answers: item.answers, attachmentIds: [], cosignerIds: [] },
    }));
    runtime.review.mockRejectedValueOnce(new runtime.Changed('form-changed-since-review'));
    await render('steward-forms');
    await clickLabel(lang === 'es' ? 'Revisar' : 'Review');
    expect(host.textContent).toContain('A fictional schedule change');
    await clickLabel('Approve');
    expect(runtime.review).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(changed[lang]);
    expect(host.textContent).toContain('The resubmitted schedule change');
    expect(host.textContent).not.toContain('A fictional schedule change');
    expect(runtime.detail).toHaveBeenLastCalledWith(after);
  });
});

// #9158: on both phones a return the server refused (the member already had a
// draft of the form open) left the form In review with only a generic line at
// the top of the list, off screen on the iPhone. The refusal says why, inside
// the open review beside its buttons, and offers no retry that cannot work.
describe('native forms review, a refused return (#9158)', () => {
  const blocked = {
    en: 'This worker already has a draft of this form open, so it was not returned. Approve it, or ask them to finish that draft first.',
    es: 'Este trabajador ya tiene abierto un borrador de este formulario, así que no se devolvió. Apruébalo o pídele que primero termine ese borrador.',
  };

  it.each<'en' | 'es'>(['en', 'es'])('says why in %s inside the open review, returning nothing', async (lang) => {
    runtime.language = lang;
    runtime.loadForms.mockResolvedValue(listPage([formRow('form-1', 'Ada'), formRow('form-2', 'Bea')], 2, null));
    runtime.review.mockRejectedValueOnce(new runtime.ReturnBlocked('form-return-blocked-by-open-draft'));
    await render('steward-forms');
    await clickLabel(lang === 'es' ? 'Revisar' : 'Review');
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Note for the worker"]')!;
      input.value = 'Please add the date.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickLabel('Return with note');
    expect(runtime.review).toHaveBeenCalledTimes(1);
    expect(runtime.review).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'form-1', 'return', 'Please add the date.', null);
    const text = host.textContent ?? '';
    expect(text).toContain(blocked[lang]);
    expect(text).not.toContain('That form was not updated');
    // Inside Ada's open review, after its note and before Bea's card.
    expect(text.indexOf(blocked[lang])).toBeGreaterThan(text.indexOf('Ada'));
    expect(text.indexOf(blocked[lang])).toBeLessThan(text.indexOf('Bea'));
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Note for the worker"]')?.value).toBe('Please add the date.');
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Try again')).toBe(false);
  });

  // #9199 F1 and F2: a refusal is about the form it came from. While an
  // action is pending no other review opens, so its reply lands in its own
  // review; no failure is ever dropped, and one whose review is gone shows at
  // the top with the member named.
  function adaAndBea() {
    runtime.loadForms.mockResolvedValue(listPage([formRow('form-1', 'Ada'), { ...formRow('form-2', 'Bea'), userID: 'member-2' }], 2, null));
  }

  async function returnAda() {
    await render('steward-forms');
    await clickLabel('Review');
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Note for the worker"]')!;
      input.value = 'Please add the date.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickLabel('Return with note');
  }

  function reviewButton() {
    return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Review');
  }

  function openReviewText() {
    return host.querySelector<HTMLInputElement>('input[aria-label="Note for the worker"]')!.parentElement!.textContent ?? '';
  }

  it('keeps Ada\'s refusal out of Bea\'s review once Bea is opened', async () => {
    adaAndBea();
    runtime.review.mockRejectedValueOnce(new runtime.ReturnBlocked('form-return-blocked-by-open-draft'));
    await returnAda();
    expect(openReviewText()).toContain(blocked.en);
    await clickLabel('Review');
    expect(runtime.review).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Note for the worker"]')?.value).toBe('');
    expect(openReviewText()).not.toContain(blocked.en);
  });

  it('opens no other review while a return is pending, so its refusal lands in Ada\'s review', async () => {
    adaAndBea();
    let reject!: (reason: unknown) => void;
    runtime.review.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    await returnAda();
    expect(reviewButton()?.disabled).toBe(true);
    await clickLabel('Review');
    expect(host.querySelectorAll('input[aria-label="Note for the worker"]')).toHaveLength(1);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Note for the worker"]')?.value).toBe('Please add the date.');
    await act(async () => { reject(new runtime.ReturnBlocked('form-return-blocked-by-open-draft')); });
    expect(runtime.review).toHaveBeenCalledTimes(1);
    const text = host.textContent ?? '';
    expect(openReviewText()).toContain(blocked.en);
    expect(text.indexOf(blocked.en)).toBeGreaterThan(text.indexOf('Ada'));
    expect(text.indexOf(blocked.en)).toBeLessThan(text.indexOf('Bea'));
    expect(reviewButton()?.disabled).toBe(false);
  });

  it('opens no other review while a return is pending, so its success cannot close Bea\'s review (#9200 on the phone)', async () => {
    adaAndBea();
    let resolve!: (value: unknown) => void;
    runtime.review.mockReturnValueOnce(new Promise((ok) => { resolve = ok; }));
    await returnAda();
    expect(reviewButton()?.disabled).toBe(true);
    await act(async () => { resolve(undefined); });
    expect(runtime.review).toHaveBeenCalledTimes(1);
    expect(host.querySelector('input[aria-label="Note for the worker"]')).toBeNull();
    expect(reviewButton()?.disabled).toBe(false);
  });

  it('names the worker when a refusal\'s review left the list', async () => {
    const bea = { ...formRow('form-2', 'Bea'), userID: 'member-2' };
    runtime.loadForms.mockResolvedValueOnce(listPage([formRow('form-1', 'Ada'), bea], 2, null))
      .mockResolvedValueOnce(listPage([bea], 1, null));
    runtime.review.mockRejectedValueOnce(new runtime.Changed('form-changed-since-review'));
    await render('steward-forms');
    await clickLabel('Review');
    await clickLabel('Approve');
    const text = host.textContent ?? '';
    expect(text).toContain("Ada's form: This filing changed after you opened it");
    expect(text.indexOf('This filing changed')).toBeLessThan(text.indexOf('Bea'));
  });
});

// Gate stage 187 on #8739: the refusal recovery keeps a review opened past the
// first page (r1s1), and the co-signer lines are in the Spanish catalogue
// (r1s2, r2s2).
describe('native forms review, stage 187', () => {
  const detailFor = (item: StewardFormReviewRow) => ({
    templateLabel: 'Workplace issue report', templateVersion: 1, submittedAt: '2026-01-02T15:00:00Z',
    lines: [{ label: 'What happened', value: String(item.answers.what) }],
    answersUnavailable: false, filingUnavailable: false, filerSigned: true, attachments: [],
    cosigners: [], cosignersUnavailable: false,
    expectation: { answers: item.answers, attachmentIds: [], cosignerIds: [] },
  });

  it('keeps a review opened past the first page open on its re-read row after a refusal', async () => {
    const first = formRow('form-1', 'Ada');
    const before = formRow('form-51', 'Final person');
    const after = { ...before, answers: { what: 'The resubmitted schedule change' } };
    const cursor = { submittedAt: '2026-01-02T15:00:00Z', id: 'form-1' };
    runtime.loadForms
      .mockResolvedValueOnce(listPage([first], 51, cursor))
      .mockResolvedValueOnce(listPage([before], null, null))
      .mockResolvedValueOnce(listPage([first], 51, cursor))
      .mockResolvedValueOnce(listPage([after], null, null));
    runtime.detail.mockImplementation(async (item: StewardFormReviewRow) => detailFor(item));
    runtime.review.mockRejectedValueOnce(new runtime.Changed('form-changed-since-review'));
    await render('steward-forms');
    await clickLabel('Load more');
    await clickLabel('Review', 1);
    expect(host.textContent).toContain('A fictional schedule change');
    await clickLabel('Approve');
    expect(runtime.review).toHaveBeenCalledTimes(1);
    expect(runtime.loadForms).toHaveBeenLastCalledWith(cursor);
    expect(host.textContent).toContain('Final person');
    expect(host.textContent).toContain('The resubmitted schedule change');
    expect(host.textContent).not.toContain('A fictional schedule change');
    expect(runtime.detail).toHaveBeenLastCalledWith(after);
  });

  // A resubmitted form sorts later, past the rows
  // loaded before the refusal, and the re-read still reaches it.
  it('keeps the review open when the resubmitted form moved past the loaded rows', async () => {
    const first = formRow('form-1', 'Ada');
    const before = formRow('form-51', 'Final person');
    const other = formRow('form-60', 'Other person');
    const after = { ...before, answers: { what: 'The resubmitted schedule change' } };
    const c1 = { submittedAt: '2026-01-02T15:00:00Z', id: 'form-1' };
    const c2 = { submittedAt: '2026-01-03T15:00:00Z', id: 'form-60' };
    runtime.loadForms
      .mockResolvedValueOnce(listPage([first], 51, c1))
      .mockResolvedValueOnce(listPage([before], null, null))
      .mockResolvedValueOnce(listPage([first], 51, c1))
      .mockResolvedValueOnce(listPage([other], null, c2))
      .mockResolvedValueOnce(listPage([after], null, null));
    runtime.detail.mockImplementation(async (item: StewardFormReviewRow) => detailFor(item));
    runtime.review.mockRejectedValueOnce(new runtime.Changed('form-changed-since-review'));
    await render('steward-forms');
    await clickLabel('Load more');
    await clickLabel('Review', 1);
    await clickLabel('Approve');
    expect(runtime.loadForms).toHaveBeenLastCalledWith(c2);
    expect(host.textContent).toContain('Other person');
    expect(host.textContent).toContain('The resubmitted schedule change');
    expect(runtime.detail).toHaveBeenLastCalledWith(after);
  });

  it('runs the failed re-read again from the footer after a refusal', async () => {
    const first = formRow('form-1', 'Ada');
    const before = formRow('form-51', 'Final person');
    const after = { ...before, answers: { what: 'The resubmitted schedule change' } };
    const cursor = { submittedAt: '2026-01-02T15:00:00Z', id: 'form-1' };
    runtime.loadForms
      .mockResolvedValueOnce(listPage([first], 51, cursor))
      .mockResolvedValueOnce(listPage([before], null, null))
      .mockRejectedValueOnce(new Error('The forms list did not load.'))
      .mockResolvedValueOnce(listPage([first], 51, cursor))
      .mockResolvedValueOnce(listPage([after], null, null));
    runtime.detail.mockImplementation(async (item: StewardFormReviewRow) => detailFor(item));
    runtime.review.mockRejectedValueOnce(new runtime.Changed('form-changed-since-review'));
    await render('steward-forms');
    await clickLabel('Load more');
    await clickLabel('Review', 1);
    await clickLabel('Approve');
    expect(host.textContent).toContain('The forms list did not load.');
    expect(runtime.loadForms).toHaveBeenCalledTimes(3);
    // The refusal sits inside the open review with no retry of its own
    // (#9158), so the footer's re-read is the only Try again.
    expect(Array.from(host.querySelectorAll('button')).filter((button) => button.textContent === 'Try again')).toHaveLength(1);
    await clickLabel('Try again');
    expect(runtime.loadForms).toHaveBeenCalledTimes(5);
    expect(runtime.loadForms).toHaveBeenLastCalledWith(cursor);
    expect(host.textContent).toContain('The resubmitted schedule change');
    expect(host.textContent).not.toContain('The forms list did not load.');
  });

  it('shows the co-signer line and the co-signer read failure in Spanish', async () => {
    runtime.language = 'es';
    runtime.loadForms.mockResolvedValue(listPage([formRow('form-1', 'Ada')], 1, null));
    runtime.detail.mockResolvedValue({ ...detailFor(formRow('form-1', 'Ada')), cosigners: [{ id: 'cosigner-1', name: 'Naomi Brooks' }] });
    runtime.block.mockReturnValue('The co-signers could not be read right now, so this form cannot be approved.');
    await render('steward-forms');
    expect(host.textContent).toContain('Informe de asunto laboral');
    await clickLabel('Revisar');
    expect(host.textContent).toContain('Co-firmado por Naomi Brooks.');
    expect(host.textContent).toContain('No se pudieron leer los cofirmantes en este momento, así que este formulario no se puede aprobar.');
    expect(host.textContent).not.toContain('Co-signed by');
  });
});
