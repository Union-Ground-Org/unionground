import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

// BUG-UG-CHAPTER-NOTICE-PUBLISH-NOT-EXACTLY-ONCE-20261119 (#9220): on
// the Steward desk's Broadcasts composer, Send pressed again after a lost reply
// reaches members once. The composer, the real notice service and the shared
// publisher run; the server stands in for one that deduplicates by key, the way
// publish_chapter_office_notice does since 20261119180000, and loses the reply
// to the first try after the notice was published.
const port = vi.hoisted(() => ({
  published: new Map<string, string>(),
  calls: [] as { name: string; key: unknown }[],
  loseNext: 0,
  uuid: 0,
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('../components/CaseRowPressable', () => ({ CaseRowPressable: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++port.uuid).padStart(12, '0')}` }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn() } }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    session: { user: { id: 'admin-a' } },
    dashboard: { member: { id: 'admin-a', chapterID: 'chapter-a', language: 'en' } }, memberLanguage: 'en',
    captureAccountSessionGuard: (userID: string) => () => userID === 'admin-a',
    chosenStaffRole: 'admin', authorizedRoles: ['admin'], chapterMemberships: [{ chapterID: 'chapter-a', selected: true }],
  }),
}));
vi.mock('../services/stewardFormReview', () => ({ formatFormSubmittedAt: () => '', loadStewardFormReviewDetail: vi.fn(), stewardFormApprovalBlock: () => null }));
vi.mock('../services/supabase', () => {
  const clientFactory = () => ({
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      if (name === 'get_chapter_office_access') return { data: { chapterId: 'chapter-a', notices: true, unscopedNotices: true, scopes: [] }, error: null };
      if (name === 'list_steward_broadcasts') return { data: [...port.published.values()].map((id) => ({ id, title: 'Contract vote', published_at: '2026-11-19T17:00:00Z' })), error: null };
      if (name !== 'publish_chapter_office_notice') return { data: null, error: { code: 'PGRST202', message: name } };
      port.calls.push({ name, key: args.p_idempotency_key });
      const key = String(args.p_idempotency_key ?? `no-key-${port.calls.length}`);
      if (!port.published.has(key)) port.published.set(key, `bc-${port.published.size + 1}`);
      if (port.loseNext > 0) {
        port.loseNext -= 1;
        return { data: null, error: { message: 'TypeError: Network request failed', code: '' } };
      }
      return { data: { broadcastId: port.published.get(key) }, error: null };
    },
  });
  return { getSupabaseClient: clientFactory, captureSessionWriter: () => stubSessionWriter(clientFactory) };
});

import { StewardDeskSectionsScreen } from './StewardDeskSectionsScreen';

let screen: Rendered | null = null;
const settle = async () => { for (let index = 0; index < 4; index += 1) await act(async () => { await Promise.resolve(); }); };
beforeEach(() => { port.published.clear(); port.calls = []; port.loseNext = 0; });
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

const PLATFORMS: readonly ('ios' | 'android')[] = ['ios', 'android'];
describe.each(PLATFORMS)('Send pressed again after a lost reply on %s', (os) => {
  it('publishes the notice once, with the first try\'s key on both presses', async () => {
    setPlatform(os);
    screen = await render(h(StewardDeskSectionsScreen, { featureKey: 'steward-broadcasts' }));
    await settle();
    await type(getExposed(screen.container, 'Broadcast title'), 'Contract vote');
    await type(getExposed(screen.container, 'Broadcast message'), 'Polls open at noon in the union hall.');
    port.loseNext = 1;
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    // The reply was lost: the composer keeps the draft, locked and unconfirmed,
    // and Send again retries it with the draft's key (#9099 part 2, #9220).
    expect((getExposed(screen.container, 'Broadcast title') as HTMLInputElement).value).toBe('Contract vote');
    await press(getExposed(screen.container, 'Send again'));
    await settle();
    expect(port.calls).toHaveLength(2);
    const [first, retry] = port.calls.map((call) => call.key);
    expect(first).toMatch(/^00000000-0000-4000-8000-/);
    expect(retry).toBe(first);
    expect(port.published.size).toBe(1);
    // The server answered, so the composer cleared and a new notice starts fresh.
    expect((getExposed(screen.container, 'Broadcast title') as HTMLInputElement).value).toBe('');
  });
});
