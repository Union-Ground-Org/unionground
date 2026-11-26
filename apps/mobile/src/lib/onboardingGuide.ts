// REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001 (native).
//
// The worker onboarding guide, decided on the server by
// public.get_member_onboarding_guide() from the organization's real onboarding
// checklist and its five guidance switches. This module only normalizes the
// payload (failing closed to "no guide") and applies it to the native
// destination lists. Route guards are unchanged; the reduced list always comes
// with a visible "Show everything" control.

import type { HatFunctionGroup } from './hatFunctions';
import { nativeUiText } from './nativeUiCopy';

export type OnboardingGuideStage = 'welcome' | 'activate' | 'complete';
export type OnboardingGuideBadge = 'new_member' | 'momentum' | 'ready_to_roll';
export type OnboardingGuideSpotlight = 'member-support' | 'events';

export type OnboardingGuide = {
  ready: boolean;
  applies: boolean;
  onboardingComplete: boolean | null;
  progressiveDisclosureActive: boolean;
  showHud: boolean;
  featureDrip: boolean;
  spotlight: OnboardingGuideSpotlight | null;
  badge: OnboardingGuideBadge | null;
  stage: OnboardingGuideStage | null;
  nextStep: { id: string; title: string } | null;
  totalSteps: number;
  completedSteps: number;
  enrolled: boolean;
  progressiveNavigationOn: boolean;
};

export const INACTIVE_ONBOARDING_GUIDE: OnboardingGuide = Object.freeze({
  ready: false,
  applies: false,
  onboardingComplete: null,
  progressiveDisclosureActive: false,
  showHud: false,
  featureDrip: false,
  spotlight: null,
  badge: null,
  stage: null,
  nextStep: null,
  totalSteps: 0,
  completedSteps: 0,
  enrolled: false,
  progressiveNavigationOn: false,
});

// Native destinations kept while the guided view is active: the checklist
// itself (worker support), the worker's own work and messages, organizing
// rights guidance through the Guide, and activity.
export const ONBOARDING_CORE_NATIVE_HREFS: readonly string[] = Object.freeze([
  '/campaign',
  '/feature/member-support',
  '/work',
  '/feature/cases',
  '/messages',
  '/feature/rights',
  '/compass',
  '/notifications',
  '/account',
]);

const SPOTLIGHT_HREFS: Record<OnboardingGuideSpotlight, string> = {
  'member-support': '/feature/member-support',
  events: '/feature/events',
};

export const ONBOARDING_BADGE_LABELS: Record<OnboardingGuideBadge, string> = {
  new_member: 'New Worker',
  momentum: 'Momentum',
  ready_to_roll: 'Ready to Roll',
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function stageOf(value: unknown): OnboardingGuideStage | null {
  return value === 'welcome' || value === 'activate' || value === 'complete' ? value : null;
}

function badgeOf(value: unknown): OnboardingGuideBadge | null {
  return value === 'new_member' || value === 'momentum' || value === 'ready_to_roll' ? value : null;
}

function spotlightOf(value: unknown): OnboardingGuideSpotlight | null {
  return value === 'member-support' || value === 'events' ? value : null;
}

export function normalizeOnboardingGuide(payload: unknown): OnboardingGuide {
  const data = record(payload);
  const ready = Boolean(data && data.state === 'ready' && typeof data.applies === 'boolean');
  if (!ready || data?.applies !== true) {
    return {
      ...INACTIVE_ONBOARDING_GUIDE,
      ready,
      onboardingComplete: ready && typeof data?.onboardingComplete === 'boolean' ? data.onboardingComplete : null,
    };
  }
  const totalSteps = count(data.totalSteps);
  const next = record(data.nextStep);
  const onboardingComplete = data.onboardingComplete === true;
  return {
    ready: true,
    applies: true,
    onboardingComplete,
    progressiveDisclosureActive: data.progressiveDisclosureActive === true && !onboardingComplete,
    showHud: data.showHud === true,
    featureDrip: data.featureDrip === true,
    spotlight: spotlightOf(data.spotlight),
    badge: badgeOf(data.badge),
    stage: stageOf(data.stage) ?? (onboardingComplete ? 'complete' : 'welcome'),
    nextStep: next && typeof next.id === 'string' && typeof next.title === 'string'
      ? { id: next.id, title: next.title.slice(0, 160) }
      : null,
    totalSteps,
    completedSteps: Math.min(count(data.completedSteps), totalSteps),
    enrolled: data.enrolled === true,
    progressiveNavigationOn: record(data.switches)?.progressiveDisclosure === true,
  };
}

export type OnboardingHudCopy = { title: string; body: string; cta: string; href: string };

const english = nativeUiText('en');

// The HUD copy, staged by feature drip.
export function onboardingHudCopy(guide: OnboardingGuide, t = english): OnboardingHudCopy | null {
  if (!guide.applies || !guide.showHud) return null;
  const progress = { done: guide.completedSteps, total: guide.totalSteps };
  if (guide.stage === 'complete') {
    return {
      title: t('Onboarding complete'),
      body: t(guide.progressiveNavigationOn
        ? 'Your full worker navigation is now available. Next up: meetings and campaign activity.'
        : 'You have the basics in place. Explore meetings and the knowledge library next.'),
      cta: t('See meetings'),
      href: '/feature/events',
    };
  }
  const early = guide.stage === 'welcome';
  return {
    title: t(early
      ? (guide.featureDrip ? 'Start with one clear next step' : 'Your onboarding is ready')
      : (guide.featureDrip ? 'Keep the momentum going' : 'Continue onboarding')),
    body: t(early
      ? 'You have finished {done} of {total} onboarding steps so far.'
      : 'You have finished {done} of {total} steps. The next step keeps your most useful tools front and center.', progress),
    cta: t(guide.enrolled ? 'Open onboarding' : 'Start onboarding'),
    // The checklist tab, not the Rights default (BUG-UG-NATIVE-START-ONBOARDING-OPENS-RIGHTS-20261018).
    href: ONBOARDING_CHECKLIST_HREF,
  };
}

// BUG-UG-NATIVE-HOME-HIDES-ONBOARDING-GUIDE-20261018: the compact
// Home entry into the checklist. It stands in for the stage card whenever the
// guide applies but the organization keeps the HUD switch off (the server
// suppresses the Home onboarding nudge in exactly that state), so Home always
// shows one way into the guide. Nothing once onboarding is complete.
export type OnboardingEntryCopy = { title: string; body: string; cta: string; accessibilityLabel: string; href: string };

export const ONBOARDING_CHECKLIST_HREF = '/feature/member-support?source=onboarding';

export function onboardingEntryCopy(guide: OnboardingGuide, t = english): OnboardingEntryCopy | null {
  if (!guide.applies || guide.stage === 'complete' || guide.onboardingComplete === true) return null;
  const remaining = Math.max(guide.totalSteps - guide.completedSteps, 0);
  const body = !guide.enrolled
    ? t('Your organization set up a short checklist to help you get started.')
    : guide.nextStep
      ? t('Next step: {title}.', { title: guide.nextStep.title })
      : remaining > 0
        ? t(remaining === 1 ? '{count} step left.' : '{count} steps left.', { count: remaining })
        : t('Pick up your checklist where you left off.');
  const cta = t(guide.enrolled ? 'Continue onboarding' : 'Start onboarding');
  return {
    title: t('Getting started'),
    body,
    cta,
    accessibilityLabel: `${cta}. ${body}`,
    href: ONBOARDING_CHECKLIST_HREF,
  };
}

// Which guide object Home shows: the stage card while the HUD switch is on,
// the compact entry otherwise, nothing once onboarding is complete (the
// completion card belongs to the Union screen; Home goes back to its nudges).
// Home also keeps HomeNudge off the screen while a guide object is shown, so
// the one-nudge policy holds for the switch combinations the server does not
// treat as a guided first run (feature drip or spotlight alone).
export type HomeOnboardingGuidePresentation = 'card' | 'entry' | null;

export function homeOnboardingGuidePresentation(guide: OnboardingGuide): HomeOnboardingGuidePresentation {
  if (!guide.applies || guide.stage === 'complete' || guide.onboardingComplete === true) return null;
  if (onboardingHudCopy(guide)) return 'card';
  return onboardingEntryCopy(guide) ? 'entry' : null;
}

export function guidedDestinations<T extends { href: string }>(items: readonly T[], guide: OnboardingGuide, showAll: boolean): T[] {
  if (!guide.progressiveDisclosureActive || showAll) return [...items];
  return items.filter((item) => ONBOARDING_CORE_NATIVE_HREFS.includes(item.href));
}

export function hiddenDestinationCount(items: readonly { href: string }[], guide: OnboardingGuide): number {
  if (!guide.progressiveDisclosureActive) return 0;
  return items.filter((item) => !ONBOARDING_CORE_NATIVE_HREFS.includes(item.href)).length;
}

export function isSpotlitHref(href: string, guide: OnboardingGuide): boolean {
  return guide.spotlight !== null && SPOTLIGHT_HREFS[guide.spotlight] === href;
}

// BUG-UG-SPOTLIT-MEMBER-SUPPORT-OPENS-RIGHTS-20261018: the spotlit
// "Next step" row opens the step itself. Member support lands on its Rights
// tab unless the route carries source=onboarding, so its spotlit row opens the
// checklist.
export function spotlitDestinationHref(href: string, guide: OnboardingGuide): string {
  if (!isSpotlitHref(href, guide)) return href;
  return guide.spotlight === 'member-support' ? ONBOARDING_CHECKLIST_HREF : href;
}

// FunctionDeck uses each item's href for both directory rows and shortcuts.
// Resolve after filtering so the core-destination check still sees base URLs.
export function guidedDestinationGroups(groups: readonly HatFunctionGroup[], guide: OnboardingGuide, showAll: boolean): HatFunctionGroup[] {
  return groups.map((group) => ({
    ...group,
    items: guidedDestinations(group.items, guide, showAll).map((item) => ({
      ...item, href: spotlitDestinationHref(item.href, guide),
    })),
  })).filter((group) => group.items.length > 0);
}
