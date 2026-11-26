import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isFeatureKey } from './featureCatalog';
import { STAFF_HAT_FUNCTIONS, type LiveStaffRole } from './hatFunctions';
import { staffDeskNumberDestination } from './staffDeskNumbers';

// BUG-UG-NATIVE-STAFF-AND-NOTICE-LINKS-OPEN-GENERIC-SCREENS-20261111:
// staff and Home links that opened a generic parent screen instead of what
// they name.
const home = readFileSync(fileURLToPath(new URL('../../app/(tabs)/home.tsx', import.meta.url)), 'utf8');

// That every desk number and staff row reaches a screen of its own, and not
// the generic one a registered key falls back to, is checked by running the
// route table in src/features/featureRouteTable.test.ts (#8324).

describe('Home desk numbers open the screen they count', () => {
  it('opens the committee member request queue and unread threads, not the generic Issue work desk', () => {
    expect(staffDeskNumberDestination('steward', 'Open requests')).toEqual({ href: '/feature/steward-requests', name: 'Worker requests' });
    expect(staffDeskNumberDestination('steward', 'Awaiting reply')).toEqual({ href: '/messages', name: 'Messages' });
  });

  it('opens Roles & access for the admin numbers, not the "No campaign admin yet" desk', () => {
    expect(staffDeskNumberDestination('admin', 'Assigned roles')).toEqual({ href: '/feature/chapter-memberships', name: 'Roles & access' });
    expect(staffDeskNumberDestination('admin', 'Staff seats')).toEqual({ href: '/feature/chapter-memberships', name: 'Roles & access' });
  });

  it('keeps the numbers that summarize a whole desk on that desk', () => {
    expect(staffDeskNumberDestination('coordinator', 'Open issues')).toEqual({ href: '/feature/coordinator', name: null });
    expect(staffDeskNumberDestination('vp', 'Active issues')).toEqual({ href: '/feature/vp', name: null });
  });

  it('Home uses the destination for the press and for the spoken hint', () => {
    expect(home).toContain('const destination = staffDeskNumberDestination(deskRole, item.label);');
    expect(home).toContain('onPress={() => router.push(destination.href as never)}');
    expect(home).toContain("hint={destination.name ? t('Opens {name}.', { name: catalogLabel(destination.name) }) : t('Opens the {role} desk.', { role: catalogLabel(LIVE_STAFF_ROLE_LABELS[deskRole]) })}");
    expect(home).not.toContain('onPress={() => router.push(`/feature/${deskRole}` as never)}');
  });
});

describe('worker Home "Open issues" opens the issue list', () => {
  it('opens My issues, not the Work tab or its role chooser', () => {
    expect(isFeatureKey('cases')).toBe(true);
    expect(home).toContain("const MY_CASES_PATH = '/feature/cases';");
    expect(home).toContain("<Metric value={metrics.openCases} label={t(\"Open issues\")} width={summaryWidth} onPress={() => router.push(MY_CASES_PATH)} />");
    expect(home).toContain("const STAT_ROUTES = [MY_CASES_PATH, '/work', '/messages', '/work'] as const;");
    expect(home).toContain('onPress: () => router.push(MY_CASES_PATH),');
  });
});

describe('staff desk rows', () => {
  it('opens each row that has its own screen there (fixed by #7760 and #7913, rechecked on this head)', () => {
    const href = (role: LiveStaffRole, label: string) => STAFF_HAT_FUNCTIONS[role].find((item) => item.label === label)?.href;
    expect(href('steward', 'Your issues')).toBe('/feature/steward-caseload');
    expect(href('steward', 'Worker requests')).toBe('/feature/steward-requests');
    expect(href('steward', 'Forms review')).toBe('/feature/steward-forms');
    expect(href('steward', 'Broadcasts')).toBe('/feature/steward-broadcasts');
    expect(href('admin', 'Roles & access')).toBe('/feature/chapter-memberships');
    // Removed rows that had no screen of their own stay removed.
    expect(href('admin', 'Two-step sign-in status')).toBeUndefined();
    expect(href('admin', 'Recent admin activity')).toBeUndefined();
  });
});
