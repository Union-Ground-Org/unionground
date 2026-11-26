// @vitest-environment jsdom
// #9460 M2-16: each phone Questions field says what it needs, under it and as its hint.
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../../testing/reactNativeStandIn';
import { stubSessionWriter } from '../../testing/stubSessionWriter';
import palette from '../../theme/palette.json';
import { syncResumeDraftContext } from '../../lib/resumeDraftHolder';
import { buildNativeQaActor, QA_MIN_BODY_LENGTH as BODY, QA_MIN_TITLE_LENGTH as TITLE, qaText } from '../../lib/mi1QaShared';

const question = { id: '11111111-1111-4111-8111-111111111111', title: 'Overtime pay', body: 'A body', status: 'open', authoredByMe: true, replies: [] };
const client = { rpc: async (name: string) => ({ data: name.startsWith('get') ? question : [question], error: null }) };
const app = () => ({ mode: 'authenticated', session: { user: { id: 'p' }, access_token: 'fixture' }, organizationID: 'o' });
vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../components/ui', () => import('../../testing/uiStandIn'));
const say = vi.hoisted(() => vi.fn((_: string) => () => {}));
vi.mock('../../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => say }));
vi.mock('../../state/AppProvider', () => ({ useApp: () => app() }));
vi.mock('../../services/haptics', () => ({ haptics: {} }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../../services/supabase', () => ({ getSupabaseClient: () => client,
  captureSessionWriter: () => ({ ...stubSessionWriter(() => client, 'p'), check: async () => 'current' }) }));
vi.mock('../ContextualPulseCard', () => ({ ContextualPulseCard: () => null, useNativeContextualPulse: () => ({}) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => question.id }));
import { MemberQaScreen } from './MemberQaScreen';

const need = (min: number, short: number) => `At least ${min} characters: ${short} more needed.`;
let view: Rendered;
let lang: 'en' | 'es' = 'en';
async function open(language: 'en' | 'es' = 'en') {
  lang = language;
  syncResumeDraftContext(app());
  const actor = buildNativeQaActor({ userId: 'p', organizationId: 'o', chapterId: 'c', authenticated: true, mfaSatisfied: true });
  view = await render(h(MemberQaScreen, { actor, live: true, language }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
const field = (label: string) => view.container.querySelector<HTMLElement>(`:is(input, textarea)[aria-label="${qaText(lang, label)}"]`)!;
const hint = (label: string) => field(label).getAttribute('aria-description');
const text = () => view.container.textContent;
const muted = (label: string) => getExposed(view.container, qaText('en', label)).getAttribute('aria-disabled') === 'true';
afterEach(async () => { await view.unmount(); syncResumeDraftContext({ ...app(), mode: 'signed-out', session: null }); });

describe.each(['ios', 'android'] as const)('phone Questions say what each field needs (%s)', platform => {
  it('names both minimums, counts down, and opens Post once both are met', async () => {
    setPlatform(platform); say.mockClear(); await open();
    expect(text()).toContain(`At least ${TITLE} characters.`); // empty: the plain rule, no count
    expect(text()).not.toContain('more needed');
    expect(hint('bodyLabel')).toBe(`At least ${BODY} characters.`);
    await type(field('titleLabel'), 'Leave?'); await type(field('bodyLabel'), 'Is it owed?');
    expect(hint('titleLabel')).toBe(need(TITLE, TITLE - 6));
    expect(text()).toContain(need(BODY, BODY - 11));
    expect(muted('post')).toBe(true);
    await type(field('titleLabel'), 'Leave on a holiday?'); await type(field('bodyLabel'), 'Is a holiday paid?');
    expect(text()).not.toContain('more needed');
    expect(hint('titleLabel')).toBeNull();
    expect(muted('post')).toBe(false);
    await type(field('titleLabel'), 'Leave on a paid holiday?');
    // Each field's minimum is announced once, when reached; not per keystroke.
    expect(say.mock.calls.filter(([m]) => m === 'Long enough.')).toHaveLength(2);
  });

  it('says the rule and the minimum reached in Spanish', async () => {
    setPlatform(platform); say.mockClear(); await open('es');
    expect(text()).toContain(`Al menos ${TITLE} caracteres.`);
    await type(field('titleLabel'), 'Leave?');
    expect(text()).toContain(`Al menos ${TITLE} caracteres: faltan ${TITLE - 6}.`);
    await type(field('titleLabel'), 'Leave on a holiday?');
    expect(say).toHaveBeenCalledWith('Longitud suficiente.');
  });

  it('counts a follow-up to QA_MIN_BODY_LENGTH', async () => {
    setPlatform(platform); say.mockClear(); await open();
    await press(getExposed(view.container, question.title)); await act(async () => {});
    await type(field('replyFollowUp'), 'Any update?');
    expect(hint('replyFollowUp')).toBe(need(BODY, BODY - 11));
    expect(muted('sendReply')).toBe(true);
    await type(field('replyFollowUp'), 'Thanks, done');
    expect(muted('sendReply')).toBe(false);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('Long enough.');
  });
});
