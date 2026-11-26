import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import { deviceZonedDateTime } from '../lib/evidenceTimestamp';

// The phone Campaigns list printed a close time with no
// zone ("Closes 10/23/2026, 8:00:00 PM"), while the chapter notices name the
// zone ("Aug 5, 12:00 PM EDT"). The list now uses the notices' formatter.
const CLOSES_AT = '2026-10-24T00:00:00+00:00';

const backend = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
}));

// The survey card, the unit editors (#9240 pull request D), the campaign draft and Be heard (pull request C) import the shared draft hook, whose attempt keys come from expo-crypto.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useIsFocused: () => true, useNavigation: () => ({ setOptions: () => {} }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => undefined), select: vi.fn() } }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../lib/hatFunctions', () => ({ STAFF_HAT_FUNCTIONS: { steward: [] } }));
vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    mode: 'authenticated', memberLanguage: 'en', session: { user: { id: 'president-fixture' } },
    dashboard: { member: { id: 'president-fixture', chapterID: 'chapter-fixture', language: 'en' } },
    authorizedRoles: ['vp'], chapterRoles: ['vp'], organizationRoles: [],
  }),
}));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({
    rpc: async (name: string) => (name === 'get_staff_vote_campaigns'
      ? { data: { campaigns: backend.rows, counts: { all: backend.rows.length, draft: 1, open: 1, closed: 1 }, nextCursor: null, canManageChapter: true, canManageUnion: false }, error: null }
      : { data: null, error: { code: 'PGRST202', message: `unexpected ${name}` } }),
  }), session?.user?.id ?? 'member-a'),
  getSupabaseClient: () => ({
    rpc: async (name: string) => (name === 'get_staff_vote_campaigns'
      ? { data: { campaigns: backend.rows, counts: { all: backend.rows.length, draft: 1, open: 1, closed: 1 }, nextCursor: null, canManageChapter: true, canManageUnion: false }, error: null }
      : { data: null, error: { code: 'PGRST202', message: `unexpected ${name}` } }),
  }),
}));
// LiveFeatureScreens also holds Forms and Casework, which reach native modules.
vi.mock('../services/attachments', () => ({ pickAuthorizedDocument: vi.fn() }));
vi.mock('../services/privateFileAccess', () => ({ PrivateFileError: class extends Error {}, requestPrivateFileInspection: vi.fn(), downloadPrivateObjectToFile: vi.fn(), privateFileApiOrigin: () => 'https://sample.unionground.example' }));
vi.mock('../components/SignaturePad', () => ({ SignaturePad: () => null }));
vi.mock('../services/unitSettings', () => ({ loadNativeUnitSettings: vi.fn(), loadNativeUnitEditor: vi.fn(), saveNativeUnitWorkload: vi.fn(), saveNativeUnitOverrides: vi.fn(), saveNativeChapterUnitSettings: vi.fn() }));

import { LiveCampaignsScreen } from './LiveFeatureScreens';

function row(id: string, state: 'draft' | 'open' | 'closed') {
  return { id, kind: 'ballot', state, scope: 'chapter', titleEn: `Vote ${id}`, titleEs: '', bodyEn: '', closesAt: CLOSES_AT, quorumTarget: 1, options: [{}, {}], optionCount: 2 };
}

let view: Rendered | null = null;
afterEach(async () => { await view?.unmount(); view = null; setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('the Campaigns list close time on %s (ledger 526)', (os) => {
  it('names the zone, as the campaign notices do', async () => {
    setPlatform(os);
    backend.rows = [row('d1', 'draft'), row('o1', 'open'), row('c1', 'closed')];
    view = await render(h(LiveCampaignsScreen));
    for (let round = 0; round < 6; round += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const text = view.container.textContent ?? '';
    const zoned = deviceZonedDateTime(CLOSES_AT);
    expect(zoned).toMatch(/[A-Z]{2,5}|GMT[+-]\d+/);
    expect(text).toContain(`Closes ${zoned}`);
    expect(text).toContain(`Closed ${zoned}`);
    // Not the old zone-less form with seconds ("10/23/2026, 8:00:00 PM").
    expect(text).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}/);
  });
});
