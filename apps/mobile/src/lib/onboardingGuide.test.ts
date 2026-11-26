import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MEMBER_FEATURE_GROUPS } from './hatFunctions';
import {
  INACTIVE_ONBOARDING_GUIDE,
  ONBOARDING_CHECKLIST_HREF,
  guidedDestinations,
  hiddenDestinationCount,
  isSpotlitHref,
  normalizeOnboardingGuide,
  onboardingHudCopy,
  spotlitDestinationHref,
} from './onboardingGuide';

const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const READY = {
  state: 'ready',
  applies: true,
  enrolled: true,
  totalSteps: 6,
  completedSteps: 2,
  onboardingComplete: false,
  progressiveDisclosureActive: true,
  stage: 'activate',
  nextStep: { id: 'step-3', title: 'Read your contract basics' },
  featureDrip: true,
  showHud: true,
  spotlight: 'member-support',
  badge: 'momentum',
  switches: { progressiveDisclosure: true },
};

describe('native onboarding guide (REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001)', () => {
  it('fails closed to no guide and keeps the onboardingComplete signal honest', () => {
    expect(normalizeOnboardingGuide(null)).toEqual(INACTIVE_ONBOARDING_GUIDE);
    expect(normalizeOnboardingGuide({ state: 'ready', applies: false, onboardingComplete: false })).toMatchObject({ applies: false, onboardingComplete: false, progressiveDisclosureActive: false });
    expect(normalizeOnboardingGuide({ ...READY, badge: 'gold', spotlight: '/admin' })).toMatchObject({ badge: null, spotlight: null });
    expect(normalizeOnboardingGuide({ ...READY, onboardingComplete: true }).progressiveDisclosureActive).toBe(false);
  });

  it('stages the card copy with feature drip and names the real next step', () => {
    const guide = normalizeOnboardingGuide(READY);
    expect(onboardingHudCopy(guide)).toEqual({
      title: 'Keep the momentum going',
      body: 'You have finished 2 of 6 steps. The next step keeps your most useful tools front and center.',
      cta: 'Open onboarding',
      href: '/feature/member-support?source=onboarding',
    });
    // BUG-UG-NATIVE-START-ONBOARDING-OPENS-RIGHTS-20261018: Start
    // onboarding opens the checklist tab, never the Rights default.
    expect(onboardingHudCopy({ ...guide, featureDrip: false, stage: 'welcome', enrolled: false })).toMatchObject({ title: 'Your onboarding is ready', cta: 'Start onboarding', href: '/feature/member-support?source=onboarding' });
    expect(onboardingHudCopy(guide)?.href).toBe(ONBOARDING_CHECKLIST_HREF);
    expect(onboardingHudCopy({ ...guide, stage: 'complete' })).toMatchObject({ title: 'Onboarding complete', href: '/feature/events' });
    expect(onboardingHudCopy({ ...guide, showHud: false })).toBeNull();
  });

  it('keeps only core destinations while guided and everything on request', () => {
    const guide = normalizeOnboardingGuide(READY);
    const items = [
      { href: '/feature/member-support' }, { href: '/feature/pay' }, { href: '/messages' }, { href: '/feature/voting' },
    ];
    expect(guidedDestinations(items, guide, false).map((item) => item.href)).toEqual(['/feature/member-support', '/messages']);
    expect(guidedDestinations(items, guide, true)).toHaveLength(4);
    expect(guidedDestinations(items, INACTIVE_ONBOARDING_GUIDE, false)).toHaveLength(4);
    expect(hiddenDestinationCount(items, guide)).toBe(2);
    expect(isSpotlitHref('/feature/member-support', guide)).toBe(true);
    expect(isSpotlitHref('/messages', guide)).toBe(false);
  });

  // BUG-UG-SPOTLIT-MEMBER-SUPPORT-OPENS-RIGHTS-20261018: the spotlit
  // Worker support row opened the Rights tab, and All features had no Member
  // support at all (UG 5bdd3d3e31).
  it('opens the checklist from the spotlit Worker support row and lists Worker support in All tools', () => {
    const guide = normalizeOnboardingGuide(READY);
    expect(ONBOARDING_CHECKLIST_HREF).toBe('/feature/member-support?source=onboarding');
    expect(spotlitDestinationHref('/feature/member-support', guide)).toBe(ONBOARDING_CHECKLIST_HREF);
    expect(spotlitDestinationHref('/feature/member-support', INACTIVE_ONBOARDING_GUIDE)).toBe('/feature/member-support');
    expect(spotlitDestinationHref('/messages', guide)).toBe('/messages');
    const events = normalizeOnboardingGuide({ ...READY, spotlight: 'events' });
    expect(spotlitDestinationHref('/feature/events', events)).toBe('/feature/events');
    expect(spotlitDestinationHref('/feature/member-support', events)).toBe('/feature/member-support');
    const campaign = source('../../app/(tabs)/campaign.tsx');
    expect(campaign).toContain('router.push(spotlitDestinationHref(item.href, guide) as never)');
    const unionGroup = MEMBER_FEATURE_GROUPS.find((group) => group.key === 'union');
    expect(unionGroup?.items.map((item) => item.href)).toContain('/feature/member-support');
    expect(guidedDestinations(unionGroup?.items ?? [], guide, false).map((item) => item.href)).toContain('/feature/member-support');
  });

  it('wires the guide into the Campaign tab and the All tools drawer with a visible escape hatch', () => {
    const campaign = source('../../app/(tabs)/campaign.tsx');
    expect(campaign).toContain('<OnboardingGuideCard guide={guide} />');
    expect(campaign).toContain('guidedDestinations(visible, guide, showAll)');
    expect(campaign).toContain('<GuidedListToggle');
    const carousel = source('../components/HomeCarousel.tsx');
    expect(carousel).toContain('guidedDestinationGroups(allGroups, guide, guideShowAll)');
    expect(carousel).toContain('footer={guideFooter}');
    const card = source('../features/onboardingGuide/OnboardingGuideCard.tsx');
    expect(card).toContain("accessibilityRole=\"progressbar\"");
    expect(card).toContain('Show everything (');
    const hook = source('../features/onboardingGuide/useOnboardingGuide.ts');
    expect(hook).toContain("client.rpc('get_member_onboarding_guide')");
    expect(hook).toContain("mode === 'authenticated'");
  });
});
