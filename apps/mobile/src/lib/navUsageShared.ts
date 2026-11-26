// Typed seam over the shared usage-based navigation model
// (REQ-UG-USAGE-BASED-NAVIGATION-20261001) plus the native destination
// catalogue. Counts stay on the phone; nothing here talks to a server.
import type { Ionicons } from '@expo/vector-icons';

import {
  NAV_USAGE_SWITCH as SHARED_SWITCH,
  computeNavWeights as sharedWeights,
  emptyNavUsage as sharedEmpty,
  parseNavUsage as sharedParse,
  personalizeNavOrder as sharedOrder,
  primaryNavKeys as sharedPrimary,
  recordNavVisit as sharedRecord,
} from '../../../../src/features/memberHome/navUsage.js';

export type NavUsage = { version: 1; visits: Record<string, Record<string, number>> };
export type NavWeight = { key: string; weight: number };

export const NAV_USAGE_SWITCH: string = SHARED_SWITCH;
// Secure storage favours small values: a dozen destinations, ten days each.
export const NATIVE_NAV_USAGE_BOUNDS = { maxDestinations: 12, maxDaysPerKey: 10 };

export function emptyNavUsage(): NavUsage {
  const value: NavUsage = sharedEmpty();
  return value;
}

export function parseNavUsage(raw: unknown): NavUsage {
  const value: NavUsage = sharedParse(raw);
  return value;
}

export function recordNavVisit(usage: NavUsage, key: string, now: Date = new Date()): NavUsage {
  const value: NavUsage = sharedRecord(usage, key, now, NATIVE_NAV_USAGE_BOUNDS);
  return value;
}

export function computeNavWeights(usage: NavUsage, now: Date = new Date()): NavWeight[] {
  const value: NavWeight[] = sharedWeights(usage, now);
  return value;
}

export function primaryNavKeys(weights: readonly NavWeight[], allowed: readonly string[]): string[] {
  const value: string[] = sharedPrimary(weights, { allowed, exclude: ['today'] });
  return value;
}

export function orderByUsage<T extends { key: string }>(items: readonly T[], weights: readonly NavWeight[]): T[] {
  const value: T[] = sharedOrder(items, weights, { keepFirst: false });
  return value;
}

export type NativeDestination = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href: string;
};

// Worker destinations only: staff desks and tools never enter the ranking.
export const NATIVE_DESTINATIONS: readonly NativeDestination[] = [
  { key: 'messages', label: 'Messages', icon: 'chatbubbles-outline', href: '/messages' },
  { key: 'compass', label: 'Ask the Guide', icon: 'navigate-outline', href: '/compass' },
  { key: 'union', label: 'Campaign', icon: 'flag-outline', href: '/campaign' },
  { key: 'account', label: 'Account', icon: 'person-circle-outline', href: '/account' },
  { key: 'notifications', label: 'Activity', icon: 'notifications-outline', href: '/notifications' },
  { key: 'work', label: 'My work', icon: 'briefcase-outline', href: '/work' },
  { key: 'pulse', label: 'Polls & surveys', icon: 'bar-chart-outline', href: '/pulse' },
  { key: 'voting', label: 'Votes', icon: 'checkbox-outline', href: '/feature/voting' },
  { key: 'events', label: 'Meetings', icon: 'calendar-outline', href: '/feature/events' },
  { key: 'rights', label: 'Organizing rights', icon: 'document-text-outline', href: '/feature/rights' },
  { key: 'cases', label: 'My issues', icon: 'folder-outline', href: '/feature/cases' },
  { key: 'forms', label: 'Forms', icon: 'create-outline', href: '/feature/forms' },
  { key: 'appointments', label: 'One-on-ones', icon: 'time-outline', href: '/feature/appointments' },
  { key: 'rewards', label: 'Contributions', icon: 'star-outline', href: '/feature/rewards' },
  { key: 'numbers', label: 'My reports', icon: 'stats-chart-outline', href: '/feature/numbers' },
  { key: 'workload', label: 'Workplace log', icon: 'timer-outline', href: '/feature/workload' },
  { key: 'member-support', label: 'Worker support', icon: 'help-buoy-outline', href: '/feature/member-support' },
  { key: 'chapter', label: 'My campaign', icon: 'home-outline', href: '/feature/chapter' },
  { key: 'voice', label: 'Be heard', icon: 'megaphone-outline', href: '/feature/voice' },
  { key: 'qa', label: 'Worker questions', icon: 'chatbox-ellipses-outline', href: '/feature/qa' },
  { key: 'org-structure', label: 'Workplace structure', icon: 'git-network-outline', href: '/feature/org-structure' },
];

const TRACKED = new Set(NATIVE_DESTINATIONS.map((item) => item.key));

// BUG-UG-DUES-NAV-SHOWN-WITHOUT-DUES-20261108: an organization that
// runs no dues never ranks Dues among the most-used places; unknown keeps it.
export function rankedDestinations(runsDues: boolean | null | undefined): readonly NativeDestination[] {
  return runsDues === false ? NATIVE_DESTINATIONS.filter((item) => item.key !== 'dues') : NATIVE_DESTINATIONS;
}

// expo-router pathname -> destination key, or null for anything not ranked.
export function destinationForPath(pathname: string | null | undefined): string | null {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  const [first, second] = pathname.slice(1).split('/');
  if (first === 'home') return 'today';
  if (first === 'conversation' || first === 'channel') return 'messages';
  if (first === 'issue' || first === 'case') return 'cases';
  if (first === 'feature' && second) return TRACKED.has(second) ? second : null;
  return first && TRACKED.has(first) && first !== 'feature' ? first : null;
}
