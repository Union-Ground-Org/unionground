import { getSupabaseClient as businessTestClient } from '../../services/supabase';
import { stubSessionWriter } from '../../testing/stubSessionWriter';
const businessWriter = stubSessionWriter(() => businessTestClient());
import * as SecureStore from 'expo-secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029 (native): the
// phone reads the three guidance switches and the org-start guide from the
// server, keeps its guide marks per user on the device, and renders the same
// English lines as the web through the shared rules.

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), store: new Map<string, string>() }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => mocks.store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { mocks.store.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { mocks.store.delete(key); }),
}));
vi.mock('../../services/supabase', () => ({ getSupabaseClient: () => ({ rpc: mocks.rpc }) }));

import { coachMarkDecision, memberFeatureGuides } from '../../../../../src/features/onboardingGuideEngine/memberLayers.js';
import { orgStartGuide } from '../../../../../src/features/onboardingGuideEngine/orgStart.js';
import { guideEngineCatalogue } from '../../../../../src/lib/i18n/guideEngine.js';
import { GUIDE_COPY_EN } from './guideCopy';
import {
  GUIDE_SWITCHES_OFF,
  NO_FEATURE_MARKS,
  acknowledgeOrganizationStartCelebration,
  coachMarkShownThisSession,
  featureMarksKey,
  guideSwitchesFrom,
  guideText,
  loadGuideSwitches,
  loadOrganizationStartGuide,
  noteCoachMarkShown,
  parseFeatureMarks,
  readCoachSeen,
  readFeatureMarks,
  recordFeatureMark,
  reviewOrganizationStartSwitches,
  saveOrganizationStartContacts,
  subscribeFeatureMarks,
  withFeatureMark,
  writeCoachSeen,
  writeFeatureMarks,
} from './guideLayersData';

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.store.clear();
});

describe('native guidance switches', () => {
  it('reads the three switches from the worker configuration and treats absent as off', async () => {
    expect(guideSwitchesFrom(null)).toEqual(GUIDE_SWITCHES_OFF);
    expect(guideSwitchesFrom({ switches: { 'features.guidance_onboarding.feature_guides': true, 'features.guidance_onboarding.coach_marks': false } }))
      .toEqual({ featureGuides: true, coachMarks: false, orgStartGuide: false });
    mocks.rpc.mockResolvedValueOnce({ data: { switches: { 'features.guidance_onboarding.feature_guides': true, 'features.guidance_onboarding.coach_marks': true, 'features.guidance_onboarding.org_start_guide': true } }, error: null });
    await expect(loadGuideSwitches()).resolves.toEqual({ featureGuides: true, coachMarks: true, orgStartGuide: true });
    expect(mocks.rpc).toHaveBeenCalledWith('get_member_organization_configuration');
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    await expect(loadGuideSwitches()).rejects.toEqual({ code: '42501' });
  });
});

describe('native org-start doors', () => {
  it('calls the read and the three writers by name with their arguments', async () => {
    mocks.rpc.mockResolvedValue({ data: { state: 'hidden' }, error: null });
    await loadOrganizationStartGuide();
    await reviewOrganizationStartSwitches(businessWriter);
    await saveOrganizationStartContacts(businessWriter, 'user-b', ['user-a']);
    await acknowledgeOrganizationStartCelebration(businessWriter);
    expect(mocks.rpc.mock.calls).toEqual([
      ['get_organization_start_guide'],
      ['mark_organization_start_switches_reviewed'],
      ['save_organization_start_contacts', { p_backup_user_id: 'user-b', p_spokesperson_user_ids: ['user-a'] }],
      ['acknowledge_organization_start_celebration'],
    ]);
  });

  it('renders the shared org-start view in English', () => {
    const view = orgStartGuide({
      state: 'active',
      organizationName: 'Tamarack Valley',
      viewer: { isAdmin: false },
      adminName: 'Stacy Paquette',
      milestones: [{ id: 'structure', checks: [{ id: 'chapters', done: true, count: 2, adminOnly: true }, { id: 'worksites', done: false, count: 0, adminOnly: true }] }],
    }).view as { title: { key: string }; ring: { text: { key: string } }; milestones: { lock: { key: string } | null }[] };
    expect(guideText(view.title)).toBe('Get Tamarack Valley ready for workers');
    expect(guideText(view.ring.text)).toBe('0 of 7 milestones');
    expect(guideText(view.milestones[0]?.lock)).toBe('Only an administrator can do this. Ask Stacy Paquette.');
  });
});

describe('native guide marks', () => {
  it('keeps the first seen and acted times, and any later got or reopen', () => {
    const seen = withFeatureMark(NO_FEATURE_MARKS, 'seen', 'events', 10);
    expect(withFeatureMark(seen, 'seen', 'events', 20)).toBe(seen);
    const got = withFeatureMark(seen, 'got', 'events', 30);
    expect(withFeatureMark(got, 'got', 'events', 40).got.events).toBe(40);
    expect(parseFeatureMarks('{"seen":{"events":1,"bad key!":2,"rights":"x"}}').seen).toEqual({ events: 1 });
    expect(parseFeatureMarks('not json')).toEqual(NO_FEATURE_MARKS);
  });

  it('stores marks per user on the device', async () => {
    await writeFeatureMarks('user-a', withFeatureMark(NO_FEATURE_MARKS, 'acted', 'home', 5));
    expect(mocks.store.has(featureMarksKey('user-a'))).toBe(true);
    await expect(readFeatureMarks('user-a')).resolves.toMatchObject({ acted: { home: 5 } });
    await expect(readFeatureMarks('user-b')).resolves.toEqual(NO_FEATURE_MARKS);
    await writeCoachSeen('user-a', { 'next-step:step-1': 7 });
    await expect(readCoachSeen('user-a')).resolves.toEqual({ 'next-step:step-1': 7 });
  });

  // BUG-UG-NATIVE-FEATURE-GUIDE-MARKS-AND-PULSE-20261102.
  it('lands consecutive marks in call order, each merged into the stored record', async () => {
    await writeFeatureMarks('user-q', withFeatureMark(NO_FEATURE_MARKS, 'got', 'rights', 1));
    const writes: string[] = [];
    let releaseFirst!: () => void;
    // The first write is slow; unqueued, the second would land first and then be overwritten.
    vi.mocked(SecureStore.setItemAsync)
      .mockImplementationOnce(async (key: string, value: string) => { await new Promise<void>((done) => { releaseFirst = done; }); writes.push(value); mocks.store.set(key, value); })
      .mockImplementationOnce(async (key: string, value: string) => { writes.push(value); mocks.store.set(key, value); });
    const told: string[] = [];
    const stop = subscribeFeatureMarks((userId, marks) => { told.push(`${userId}:${Object.keys(marks.got).sort().join(',')}`); });
    const first = recordFeatureMark('user-q', 'got', 'events', 10);
    const second = recordFeatureMark('user-q', 'got', 'home', 20);
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    releaseFirst();
    await Promise.all([first, second]);
    stop();
    expect(writes.map((value) => Object.keys((JSON.parse(value) as { got: Record<string, number> }).got).sort())).toEqual([['events', 'rights'], ['events', 'home', 'rights']]);
    await expect(readFeatureMarks('user-q')).resolves.toMatchObject({ got: { rights: 1, events: 10, home: 20 } });
    expect(told).toEqual(['user-q:events,rights', 'user-q:events,home,rights']);
  });

  it('never overwrites a stored record it could not read', async () => {
    await writeFeatureMarks('user-r', withFeatureMark(NO_FEATURE_MARKS, 'got', 'events', 1));
    const before = mocks.store.get(featureMarksKey('user-r'));
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keystore busy'));
    await expect(recordFeatureMark('user-r', 'got', 'home', 2)).resolves.toBeNull();
    expect(mocks.store.get(featureMarksKey('user-r'))).toBe(before);
  });

  it('keeps this session\'s coach mark for its own user only', () => {
    noteCoachMarkShown('user-a', 'next-step:step-1');
    expect(coachMarkShownThisSession('user-a')).toBe('next-step:step-1');
    expect(coachMarkShownThisSession('user-b')).toBeNull();
  });
});

describe('shared rules on the phone', () => {
  it('shows a worker the feature guide the first time and says who to ask', () => {
    const guides = memberFeatureGuides({ on: true, memberHat: true, memberOnly: true, view: 'events', stewardName: 'Rafael Cintrón', marks: NO_FEATURE_MARKS });
    const showing = guides.view?.showing as { feature: string; askWho: { key: string; params: Record<string, string> } };
    expect(showing.feature).toBe('events');
    expect(guideText({ key: 'guideEngine.fg.askLine', params: { who: showing.askWho } })).toBe('Ask Rafael Cintrón, your committee contact');
    expect(memberFeatureGuides({ on: false, memberHat: true, memberOnly: true, view: 'events' }).view).toBeNull();
  });

  it('waits ten seconds and holds the coach mark behind a feature guide', () => {
    const base = { on: true, applies: true, anchor: 'next-step:s1', control: 'Meet the committee', anchorReached: true };
    expect(coachMarkDecision({ ...base, secondsOnScreen: 3 }).show).toBe(false);
    expect(coachMarkDecision({ ...base, secondsOnScreen: 10, featureGuideOpen: true }).show).toBe(false);
    expect(coachMarkDecision({ ...base, secondsOnScreen: 10 }).show).toBe(true);
    expect(coachMarkDecision({ ...base, secondsOnScreen: 10, seen: { 'next-step:s1': 1 } }).show).toBe(false);
  });
});

describe('native guide copy', () => {
  it('keeps every native line equal to the shared English catalogue', () => {
    const shared = guideEngineCatalogue.en as Record<string, string>;
    for (const [key, line] of Object.entries(GUIDE_COPY_EN)) expect(line, key).toBe(shared[key]);
  });

  it('requires native copy for every shared guide key, including future namespaces', () => {
    expect(Object.keys(GUIDE_COPY_EN).sort()).toEqual(Object.keys(guideEngineCatalogue.en).sort());
  });

  it('renders the organization notice action in English instead of its missing key', () => {
    expect(guideText({ key: 'guideEngine.orgPage.open.notice' })).toBe('Post your first notice');
  });
});
