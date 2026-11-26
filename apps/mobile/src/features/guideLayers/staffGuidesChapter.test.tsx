// @vitest-environment jsdom
// a review note and 353 (after #8760, REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109):
// the native staff guide's units facts belong to the selected chapter. A
// chapter switch drops the cached answer and reads again, an answer for the
// previous chapter that lands late is ignored, and an undo of a role, scope or
// membership change reads the guide again, as on the web.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { session: { access_token: 'token' } as unknown, dashboard: { member: { chapterID: 'chapter-a' } } as unknown },
  load: vi.fn(),
}));

vi.mock('../../lib/useBusinessWriter', () => ({ useBusinessWriter: () => ({ userId: 'member-a' }) }));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Pressable: () => null, Text: () => null, View: () => null,
  StyleSheet: { create: <T,>(value: T) => value },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../components/ui', () => ({ Body: () => null, Button: () => null, Card: () => null, Heading: () => null }));
vi.mock('../../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('../../state/AppProvider', () => ({ useApp: () => mocks.app }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('./guideLayersData', () => ({ guideText: () => '' }));
vi.mock('./staffGuidesData', () => ({
  NATIVE_STAFF_FEATURE_NAMES: {}, completeStaffOnboardingStep: vi.fn(), markStaffOnboardingStep: vi.fn(),
  liveStaffGuideHat: () => 'admin', loadStaffOnboardingGuide: mocks.load,
}));

import { announceLearningUndone } from '../../../../../src/features/learningPeriod/undoneSignal.js';
import { useStaffGuidePayload } from './StaffGuides';

type Latest = { payload: unknown };
let root: Root;
let container: HTMLDivElement;
const latest: Latest = { payload: undefined };
function Probe() {
  latest.payload = useStaffGuidePayload(true).payload;
  return null;
}
const answer = (chapterId: string) => ({ state: 'shown', chapterUnits: { chapterId, units: 0, stewards: 1, stewardsWithoutUnit: 1 } });
async function mount() { await act(async () => { root.render(createElement(Probe)); }); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.app = { session: { access_token: 'token' }, dashboard: { member: { chapterID: 'chapter-a' } } };
  mocks.load.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('native staff guide follows the selected campaign', () => {
  it('drops the answer on a campaign switch, ignores a late answer for the previous campaign, and reads again', async () => {
    let landA: (value: unknown) => void = () => {};
    mocks.load.mockImplementationOnce(() => new Promise((resolve) => { landA = resolve; }));
    mocks.load.mockImplementationOnce(async () => answer('chapter-b'));
    await mount();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    mocks.app = { session: mocks.app.session, dashboard: { member: { chapterID: 'chapter-b' } } };
    await mount();
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(latest.payload).toEqual(answer('chapter-b'));
    await act(async () => { landA(answer('chapter-a')); });
    expect(latest.payload).toEqual(answer('chapter-b'));
  });

  it('reads again after an undo of a role, scope or membership change, and not after other undos', async () => {
    mocks.load.mockResolvedValue(answer('chapter-a'));
    await mount();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    await act(async () => { announceLearningUndone(['unit_settings']); });
    expect(mocks.load).toHaveBeenCalledTimes(1);
    await act(async () => { announceLearningUndone(['chapter_role_scope']); });
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it('names the selected campaign to the shared guide engine', () => {
    const source = readFileSync(fileURLToPath(new NodeURL('./StaffGuides.tsx', import.meta.url)), 'utf8');
    expect(source).toContain('staffFeatureGuides({ payload, hat, chapterId })');
  });
});
