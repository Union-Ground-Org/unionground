// UX-UG-NATIVE-STAFF-WORK-TAB-BURIES-DESKS-UNDER-MEMBER-QUICK-CAPTURE-20261108:
// a staff role's Home summary shows that role's desk numbers, the ones its web
// desk leads with, instead of the member strip ("0 Open cases" for a steward
// whose desk holds a dozen open requests). Each role reads one existing desk
// RPC under the same permissions as its desk; a number the read does not
// supply stays null and is shown as a dash, never invented.

import type { LiveStaffRole } from './hatFunctions';
import { pulseCount, pulseObject, pulseRows } from './pulseCatalog';

export type StaffDeskNumber = { label: string; value: number | null };

type DeskNumbersSpec = {
  /** The one desk read this role's numbers come from. */
  read: string;
  labels: readonly string[];
  numbers: (data: unknown) => (number | null)[];
};

const SPECS: Record<LiveStaffRole, DeskNumbersSpec> = {
  // The organizing desk has no figures read of its own yet.
  organizer: { read: '', labels: [], numbers: () => [] },
  steward: {
    read: 'get_steward_desk_kpis',
    labels: ['Open requests', 'Awaiting reply'],
    numbers: (data) => {
      const row = pulseRows(data)[0] ?? {};
      return [pulseCount(row.open_requests), pulseCount(row.awaiting_reply)];
    },
  },
  coordinator: {
    read: 'get_coordinator_kpis',
    labels: ['Open issues', 'Due this week', 'In arbitration'],
    numbers: (data) => {
      const kpis = pulseObject(data);
      return [pulseCount(kpis.openCases), pulseCount(kpis.dueThisWeek), pulseCount(kpis.inArbitration)];
    },
  },
  advisor: {
    read: 'get_advisor_overview',
    labels: ['Open issues', 'Workers covered'],
    numbers: (data) => {
      const overview = pulseObject(data);
      return [pulseCount(overview.openGrievances), pulseCount(overview.membersCovered)];
    },
  },
  admin: {
    read: 'get_staff_roster',
    labels: ['Staff seats', 'Assigned roles'],
    numbers: (data) => {
      if (!Array.isArray(data)) return [null, null];
      const roster = pulseRows(data);
      return [roster.length, roster.reduce((sum, person) => sum + (Array.isArray(person.roles) ? person.roles.length : 0), 0)];
    },
  },
  vp: {
    read: 'get_vp_overview',
    labels: ['Active issues', 'Campaign workers'],
    numbers: (data) => {
      const overview = pulseObject(data);
      return [pulseCount(overview.activeGrievances), pulseCount(overview.memberCount)];
    },
  },
};

// Where a Home desk number opens. A number whose desk has its own section
// screen opens that section; the rest open the role's desk, which is the
// screen that number summarizes
// (BUG-UG-NATIVE-STAFF-AND-NOTICE-LINKS-OPEN-GENERIC-SCREENS-20261111).
const NUMBER_DESTINATIONS: Readonly<Record<string, { href: string; name: string }>> = {
  'Open requests': { href: '/feature/steward-requests', name: 'Worker requests' },
  // The desk's "Awaiting reply" count is its unread member threads.
  'Awaiting reply': { href: '/messages', name: 'Messages' },
  'Staff seats': { href: '/feature/chapter-memberships', name: 'Roles & access' },
  'Assigned roles': { href: '/feature/chapter-memberships', name: 'Roles & access' },
};

/** The screen a desk number opens; `name` is null when it is the role's own desk. */
export function staffDeskNumberDestination(role: LiveStaffRole, label: string): { href: string; name: string | null } {
  return NUMBER_DESTINATIONS[label] ?? { href: `/feature/${role}`, name: null };
}

export function staffDeskNumbersRead(role: LiveStaffRole): string {
  return SPECS[role].read;
}

export function staffDeskNumberLabels(role: LiveStaffRole): readonly string[] {
  return SPECS[role].labels;
}

/** The role's desk numbers from its read; every value is null while loading or after a failed read. */
export function staffDeskNumbers(role: LiveStaffRole, read: { data: unknown; error: unknown } | null): StaffDeskNumber[] {
  const spec = SPECS[role];
  const values = read && !read.error ? spec.numbers(read.data) : spec.labels.map(() => null);
  return spec.labels.map((label, index) => ({ label, value: values[index] ?? null }));
}
