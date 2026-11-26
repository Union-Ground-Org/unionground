// @vitest-environment jsdom
// BUG-UG-PHONE-CHANNEL-REMINDERS-AND-QUESTION-QUEUE-FAILED-READ-LOOKS-EMPTY-20261125
// (#9941, carved from #9465): when the officer question queue failed to load,
// a steward read "No open questions in your scope." as if the queue were empty.
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, type Rendered } from '../../testing/reactNativeStandIn';
import { stubSessionWriter } from '../../testing/stubSessionWriter';
import palette from '../../theme/palette.json';
import { syncResumeDraftContext } from '../../lib/resumeDraftHolder';
import { buildNativeQaActor, qaText } from '../../lib/mi1QaShared';
import { nativeUiText } from '../../lib/nativeUiCopy';

const question = { id: '22222222-2222-4222-8222-222222222222', title: 'Fictional break room question', body: 'A body', status: 'open', authoredByMe: false, replies: [] };
const queue = vi.hoisted(() => ({ fail: 0, empty: false, calls: 0, hold: null as Promise<void> | null }));
const client = { rpc: async (name: string) => {
  if (name === 'list_member_qa_officer_queue') {
    queue.calls += 1;
    if (queue.hold) await queue.hold;
    if (queue.fail > 0) { queue.fail -= 1; return { data: null, error: { code: 'XX000', message: 'fixture queue offline' } }; }
    return { data: { questions: queue.empty ? [] : [question] }, error: null };
  }
  return { data: name.startsWith('get') ? question : [], error: null };
} };
const app = () => ({ mode: 'authenticated', session: { user: { id: 'steward-1' }, access_token: 'fixture' }, organizationID: 'o' });
vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../components/ui', () => import('../../testing/uiStandIn'));
vi.mock('../../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => () => () => {} }));
vi.mock('../../state/AppProvider', () => ({ useApp: () => app() }));
vi.mock('../../services/haptics', () => ({ haptics: {} }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../../services/supabase', () => ({ getSupabaseClient: () => client,
  captureSessionWriter: () => ({ ...stubSessionWriter(() => client, 'steward-1'), check: async () => 'current' }) }));
vi.mock('../ContextualPulseCard', () => ({ ContextualPulseCard: () => null, useNativeContextualPulse: () => ({}) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => question.id }));
import { MemberQaScreen } from './MemberQaScreen';

let view: Rendered | null = null;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
async function open(language: 'en' | 'es') {
  syncResumeDraftContext(app());
  const actor = buildNativeQaActor({ userId: 'steward-1', organizationId: 'o', chapterId: 'c', organizationRoles: ['steward'], authenticated: true, mfaSatisfied: true });
  view = await render(h(MemberQaScreen, { actor, live: true, language }));
  await settle();
}
const text = () => view?.container.textContent ?? '';
afterEach(async () => { await view?.unmount(); view = null; queue.fail = 0; queue.empty = false; queue.calls = 0; queue.hold = null; syncResumeDraftContext({ ...app(), mode: 'signed-out', session: null }); });

const QUEUE_LANGUAGES: Array<'en' | 'es'> = ['en', 'es'];
describe.each(QUEUE_LANGUAGES)('the officer question queue, in %s', (language) => {
  it('says the waiting questions could not be loaded, not that none are open, and loads them on Try again', async () => {
    const failed = nativeUiText(language)('The waiting questions could not be loaded.');
    queue.fail = 1;
    await open(language);
    expect(text()).toContain(qaText(language, 'queueTitle'));
    expect(text()).toContain(failed);
    // The member list loaded: nothing says the whole page is unavailable.
    expect(text()).not.toContain(qaText(language, 'unavailable'));
    expect(text()).not.toContain(qaText(language, 'queueEmpty'));
    // While the retry is pending, the old failure line is gone and no second read starts.
    let release = () => {};
    queue.hold = new Promise<void>((resolve) => { release = resolve; });
    const before = queue.calls;
    await press(getExposed(view!.container, qaText(language, 'retry')));
    expect(text()).not.toContain(failed);
    expect(queue.calls).toBe(before + 1);
    release();
    queue.hold = null;
    await settle();
    expect(text()).toContain(question.title);
    expect(text()).not.toContain(failed);
  });

  it('keeps the empty sentence for a queue that answers with none', async () => {
    queue.empty = true;
    await open(language);
    expect(text()).toContain(qaText(language, 'queueEmpty'));
    expect(text()).not.toContain(qaText(language, 'unavailable'));
  });
});
