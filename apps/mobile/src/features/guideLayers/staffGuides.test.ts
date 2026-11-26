import { stubSessionWriter } from '../../testing/stubSessionWriter';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029 (native): the
// phone reads the staff feature guides from the same server read as the web,
// shows the hat worn its guides through the shared rules and English lines,
// and finishes a guide when its real first action lands here.

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'key-1' }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => {}), deleteItemAsync: vi.fn(async () => {}) }));
vi.mock('../../services/supabase', () => ({ getSupabaseClient: () => ({ rpc: mocks.rpc }) }));

import { STAFF_FEATURE_GUIDES, STAFF_GUIDE_ROLES, staffFeatureGuides } from '../../../../../src/features/onboardingGuideEngine/staffGuides.js';
import { guideEngineCatalogue } from '../../../../../src/lib/i18n/guideEngine.js';
import { GUIDE_COPY_EN } from './guideCopy';
import { guideText } from './guideLayersData';
import { NATIVE_STAFF_FEATURE_NAMES, completeStaffOnboardingStep, finishStaffGuide, liveStaffGuideHat, loadStaffOnboardingGuide, markStaffOnboardingStep } from './staffGuidesData';

const writer = stubSessionWriter(() => ({ rpc: mocks.rpc }), 'owner');
const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');

beforeEach(() => { mocks.rpc.mockReset(); });

describe('native staff guide doors', () => {
  it('calls the same three RPCs as the web', async () => {
    mocks.rpc.mockResolvedValue({ data: { state: 'hidden' }, error: null });
    await expect(loadStaffOnboardingGuide()).resolves.toEqual({ state: 'hidden' });
    await completeStaffOnboardingStep(writer, 'steward.casework');
    await markStaffOnboardingStep(writer, 'steward.casework', 'got');
    expect(mocks.rpc.mock.calls).toEqual([
      ['get_staff_onboarding_guide'],
      ['complete_staff_onboarding_step', { p_step_id: 'steward.casework', p_idempotency_key: 'key-1' }],
      ['mark_staff_onboarding_step', { p_step_id: 'steward.casework', p_mark: 'got' }],
    ]);
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    await expect(loadStaffOnboardingGuide()).rejects.toEqual({ code: '42501' });
  });

  it('works as the picked role, else the only one held, and never in PREVIEW', () => {
    expect(liveStaffGuideHat({ mode: 'authenticated', chosenStaffRole: 'advisor', authorizedRoles: ['steward', 'advisor'] })).toBe('advisor');
    expect(liveStaffGuideHat({ mode: 'authenticated', chosenStaffRole: null, authorizedRoles: ['steward'] })).toBe('steward');
    expect(liveStaffGuideHat({ mode: 'authenticated', chosenStaffRole: null, authorizedRoles: [] })).toBeNull();
    expect(liveStaffGuideHat({ mode: 'preview', chosenStaffRole: 'steward', authorizedRoles: ['steward'] })).toBeNull();
  });

  it('finishes only the worn hat guide for that feature and swallows a refusal', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(finishStaffGuide(writer, 'coordinator', 'messages')).resolves.toBeUndefined();
    await finishStaffGuide(writer, 'steward', 'people');
    await finishStaffGuide(writer, null, 'messages');
    expect(mocks.rpc.mock.calls).toEqual([['complete_staff_onboarding_step', { p_step_id: 'coordinator.messages', p_idempotency_key: 'key-1' }]]);
  });
});

describe('native staff guide lines', () => {
  it('keeps every staff guide line the phone renders equal to the shared English', () => {
    const shared = guideEngineCatalogue.en as Record<string, string>;
    const guides: Record<string, readonly { feature: string; nameKey: string; firstKey: string; can: string[]; never: string[] }[]> = STAFF_FEATURE_GUIDES;
    const keys = STAFF_GUIDE_ROLES.flatMap((role: string) => (guides[role] ?? [])
      .flatMap((entry) => [entry.nameKey, entry.firstKey, ...entry.can, ...entry.never, `guideEngine.sf.ask.${role}`]));
    for (const key of [...keys, 'guideEngine.ring.features', 'guideEngine.sf.yourGuides', 'guideEngine.sf.countsBoth', 'guideEngine.sf.nextWord', 'guideEngine.sf.cardAllDone', 'guideEngine.interstitial', 'guideEngine.interstitial.againGuides', 'guideEngine.role.vpChapter']) {
      expect(GUIDE_COPY_EN[key], key).toBe(shared[key]);
    }
    for (const role of STAFF_GUIDE_ROLES) for (const entry of guides[role] ?? []) expect(NATIVE_STAFF_FEATURE_NAMES[entry.feature], entry.feature).toEqual(expect.any(String));
  });

  it('renders a committee member guide list in English', () => {
    const view = staffFeatureGuides({ payload: { state: 'active', roles: [{ role: 'steward', scope: 'chapter' }], steps: [] }, hat: 'steward' }).view as { ring: { key: string }; items: { firstLabel: { key: string }; askWho: { key: string } }[] };
    const first = view.items[0]!;
    expect(guideText(view.ring)).toBe('0 of 3 feature guides done');
    expect(guideText(first.firstLabel)).toBe('Take a worker request');
    expect(guideText({ key: 'guideEngine.fg.askLine', params: { who: first.askWho } })).toBe('Ask your Campaign lead');
  });
});

// REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109: the chapter lead's units step
// on the phone: the same facts and lines as the web, its parts' state, and no
// button, because both of its screens are on the web.
describe('native units step', () => {
  type Part = { id: string; label: { key: string }; done: boolean; status: { key: string; params?: Record<string, unknown> } };
  type Item = { feature: string; nativeHref: string | null; done: boolean; about: { key: string }[]; parts: Part[] | null };
  const unitsOf = (units: number, stewards: number, without: number) => {
    const { view } = staffFeatureGuides({ payload: { state: 'active', roles: [{ role: 'admin', scope: 'chapter' }], steps: [], chapterUnits: { chapterId: 'c', units, stewards, stewardsWithoutUnit: without } }, hat: 'admin' }) as { view: { items: Item[]; done: Item[] } };
    return [...view.items, ...view.done].find((item) => item.feature === 'units')!;
  };

  it('keeps its lines equal to the shared English', () => {
    const shared = guideEngineCatalogue.en as Record<string, string>;
    const entries = (STAFF_FEATURE_GUIDES as Record<string, readonly { about?: string[]; partLabels?: Record<string, string> }[]>);
    const keys = STAFF_GUIDE_ROLES.flatMap((role: string) => (entries[role] ?? []).flatMap((entry) => [...(entry.about ?? []), ...Object.values(entry.partLabels ?? {})]));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of [...keys, 'guideEngine.sf.units.about', 'guideEngine.sf.units.createStatus', 'guideEngine.sf.units.assignStatus', 'guideEngine.sf.units.webOnly']) {
      expect(GUIDE_COPY_EN[key], key).toBe(shared[key]);
    }
  });

  it('says where each part stands, open and finished, and has no phone screen to open', () => {
    const open = unitsOf(0, 2, 2);
    expect([open.done, open.nativeHref]).toEqual([false, null]);
    expect(open.parts!.map((part) => `${guideText(part.label)}: ${guideText(part.done ? { key: 'guideEngine.row.done' } : part.status)}`))
      .toEqual(["Create your campaign's units: Units so far: 0", 'Place every committee member in one of your units: 0 of 2 committee members are in one of your units']);
    const finished = unitsOf(3, 2, 0);
    expect([finished.done, finished.parts!.every((part) => part.done)]).toEqual([true, true]);
    expect(guideText(finished.about[0]!)).toBe("A committee member with a unit sees worker records, issues and contact notes only for that unit's workers.");
    const screen = read('./StaffGuides.tsx');
    expect(screen).toContain("{!item.done && item.nativeHref ? <Button");
    expect(screen).toContain("guideText({ key: 'guideEngine.sf.units.webOnly' })");
  });
});

describe('native staff guide wiring', () => {
  it('lists the guides on Work and finishes Messages and Settings on their real writes', () => {
    expect(read('../WorkScreen.tsx')).toContain('<NativeStaffGuides />');
    const conversation = read('../../../app/conversation/[id].tsx');
    expect(conversation).toMatch(/await sendMemberMessage\(writer, id, cleanDraft\);\n\s+if \(currentScope !== scope.current\) return;[\s\S]{0,400}finishStaffGuide\(writer, liveStaffGuideHat\(\{ mode, chosenStaffRole, authorizedRoles \}\), 'messages'\)/);
    const card = read('../NotificationPreferencesCard.tsx');
    expect(card).toMatch(/setSaved\(confirmed\);[\s\S]{0,600}finishStaffGuide\(writer, liveStaffGuideHat\(\{ mode, chosenStaffRole, authorizedRoles \}\), 'settings'\)/);
  });
});
