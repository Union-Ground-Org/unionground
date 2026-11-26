// REQ-UG-LOVABLE-NATIVE-SCREENS-BATCH-C-PORT-20261103: the Batch C
// role desk card on live Home, and the full role names it and the role picker
// show (copy register 25).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FEATURE_TITLES } from './featureCatalog';
import { LIVE_STAFF_DESK_LINES, LIVE_STAFF_ROLE_LABELS, STAFF_HAT_FUNCTIONS, liveStaffDeskEyebrow, staffDeskHomeRole, workItemsWithRoleDeskFirst } from './hatFunctions';
import type { LiveStaffRole } from './hatFunctions';
import { staffDeskNumberLabels, staffDeskNumbers, staffDeskNumbersRead } from './staffDeskNumbers';

const live = { mode: 'authenticated', sessionRestricted: false, chosenStaffRole: null, authorizedRoles: [] as string[] };

describe('Batch C role desk on live Home', () => {
  it('uses one name for each role, the one the switchers and the pay sentence use (#9529, ledger 794)', () => {
    expect(LIVE_STAFF_ROLE_LABELS).toEqual({
      organizer: 'Organizer',
      steward: 'Committee',
      coordinator: 'Campaign lead',
      advisor: 'Advisor',
      admin: 'Admin',
      vp: 'Campaign chair',
    });
    const pay = readFileSync(new URL('../features/mi1/PayToolsScreen.tsx', import.meta.url), 'utf8');
    const sentence = `the ${LIVE_STAFF_ROLE_LABELS.advisor}, ${LIVE_STAFF_ROLE_LABELS.admin} or ${LIVE_STAFF_ROLE_LABELS.vp} role`;
    expect(pay).toContain(sentence);
    const spanish: Record<string, string> = JSON.parse(readFileSync(new URL('./nativeUiSpanish.json', import.meta.url), 'utf8')) as Record<string, string>;
    expect([spanish.Advisor, spanish.Admin, spanish['Campaign chair']]).toEqual(['Asesor', 'Administrador', 'Presidente']);
  });

  it('names the role over the desk work noun', () => {
    expect(liveStaffDeskEyebrow('steward')).toBe('COMMITTEE DESK');
    expect(liveStaffDeskEyebrow('coordinator')).toBe('CAMPAIGN LEAD DESK');
    expect(FEATURE_TITLES.steward).toBe('Committee desk');
  });

  it('shows the desk of the one staff role an account holds', () => {
    expect(staffDeskHomeRole({ ...live, authorizedRoles: ['steward'] })).toBe('steward');
    expect(staffDeskHomeRole({ ...live, authorizedRoles: ['admin'] })).toBe('admin');
  });

  it('waits for a choice when the account holds several roles, then follows it', () => {
    expect(staffDeskHomeRole({ ...live, authorizedRoles: ['steward', 'coordinator'] })).toBeNull();
    expect(staffDeskHomeRole({ ...live, authorizedRoles: ['steward', 'coordinator'], chosenStaffRole: 'coordinator' })).toBe('coordinator');
  });

  it('shows no desk to a worker, a PIN-restricted session or outside a live session', () => {
    expect(staffDeskHomeRole({ ...live, authorizedRoles: [] })).toBeNull();
    expect(staffDeskHomeRole({ ...live, authorizedRoles: ['steward'], sessionRestricted: true })).toBeNull();
    expect(staffDeskHomeRole({ ...live, mode: 'preview', authorizedRoles: ['steward'] })).toBeNull();
  });

  it('describes each desk without counts', () => {
    for (const line of Object.values(LIVE_STAFF_DESK_LINES)) {
      expect(line).not.toMatch(/\d/);
      expect(line).not.toMatch(/\bhat/i);
    }
  });

  it('places the card under the campaign identity on live Home and opens the desk', () => {
    const home = readFileSync(new URL('../../app/(tabs)/home.tsx', import.meta.url), 'utf8');
    const card = readFileSync(new URL('../features/home/StaffDeskHomeCard.tsx', import.meta.url), 'utf8');
    const live = home.slice(home.indexOf('function AuthenticatedHome'));
    expect(live.indexOf('<StaffDeskHomeCard />')).toBeGreaterThan(live.indexOf('chapterIdentity.title'));
    expect(live.indexOf('<StaffDeskHomeCard />')).toBeLessThan(live.indexOf("accessibilityLabel={t(\"Worker summary\")}"));
    expect(card).toContain('router.push(`/feature/${role}` as never)');
  });
});

describe('Batch C role Work (part 2)', () => {
  const rows = [{ key: 'tasks' }, { key: 'events-desk' }, { key: 'coordinator' }, { key: 'search' }];

  it('leads with the desk of the role in use and keeps the rest in order', () => {
    expect(workItemsWithRoleDeskFirst(rows, 'coordinator').map((item) => item.key))
      .toEqual(['coordinator', 'tasks', 'events-desk', 'search']);
  });

  it('changes nothing without a role or when the role desk is not listed', () => {
    expect(workItemsWithRoleDeskFirst(rows, null)).toEqual(rows);
    expect(workItemsWithRoleDeskFirst(rows, 'admin')).toEqual(rows);
  });

  it('finds each role desk among that role\'s own work rows', () => {
    const roles: LiveStaffRole[] = ['steward', 'coordinator', 'advisor', 'admin', 'vp'];
    for (const role of roles) {
      expect(workItemsWithRoleDeskFirst(STAFF_HAT_FUNCTIONS[role], role)[0]?.key).toBe(role);
    }
  });

  it('names the role in use on live Work unless the role picker already does', () => {
    const work = readFileSync(new URL('../features/WorkScreen.tsx', import.meta.url), 'utf8');
    expect(work).toContain('const workRole = staffDeskHomeRole({ mode, sessionRestricted, chosenStaffRole, authorizedRoles });');
    expect(work).toContain("{workRole && staffRoleChoices.length < 2 ? <Body muted>{t('Working as {role}', { role: catalogLabel(LIVE_STAFF_ROLE_LABELS[workRole]) })}</Body> : null}");
    expect(work).toContain('workItemsWithRoleDeskFirst(workItems.filter((item) => !MEMBER_WORK_WIDGET_KEYS.has(item.key)), workRole)');
  });

  it('opens live Work on the staff desks, with quick capture and the guides after the work', () => {
    // UX-UG-NATIVE-STAFF-WORK-TAB-BURIES-DESKS-UNDER-MEMBER-QUICK-CAPTURE-20261108.
    const work = readFileSync(new URL('../features/WorkScreen.tsx', import.meta.url), 'utf8');
    const live = work.slice(work.indexOf("if (mode !== 'preview') {"), work.indexOf('\n  return (', work.indexOf("if (mode !== 'preview') {")));
    const at = (marker: string) => {
      const index = live.indexOf(marker);
      expect(index, marker).toBeGreaterThan(-1);
      return index;
    };
    expect(at('{headerRow}')).toBeLessThan(at('Your staff desks'));
    expect(at('Working as ')).toBeLessThan(at('Your staff desks'));
    expect(at('Your staff desks')).toBeLessThan(at('Only records you can open appear here.'));
    expect(at('Only records you can open appear here.')).toBeLessThan(at('<StaffQuickCapture />'));
    expect(at('<StaffQuickCapture />')).toBeLessThan(at('<NativeOrgStartGuide />'));
    expect(at('<NativeOrgStartGuide />')).toBeLessThan(at('<NativeStaffGuides />'));
    expect(live.match(/<StaffQuickCapture \/>/g)).toHaveLength(1);
  });
});

describe('a staff role\'s Home summary is its desk numbers', () => {
  // UX-UG-NATIVE-STAFF-WORK-TAB-BURIES-DESKS-UNDER-MEMBER-QUICK-CAPTURE-20261108.
  const ok = (data: unknown) => ({ data, error: null });

  it('reads each role\'s own desk numbers, with the labels its web desk leads with', () => {
    expect(staffDeskNumbers('steward', ok([{ open_requests: 12, awaiting_reply: 4 }]))).toEqual([
      { label: 'Open requests', value: 12 }, { label: 'Awaiting reply', value: 4 },
    ]);
    expect(staffDeskNumbers('coordinator', ok({ openCases: 31, dueThisWeek: 5, inArbitration: 2 }))).toEqual([
      { label: 'Open issues', value: 31 }, { label: 'Due this week', value: 5 }, { label: 'In arbitration', value: 2 },
    ]);
    expect(staffDeskNumbers('advisor', ok({ openGrievances: 18, membersCovered: 255 }))).toEqual([
      { label: 'Open issues', value: 18 }, { label: 'Workers covered', value: 255 },
    ]);
    expect(staffDeskNumbers('admin', ok([{ roles: ['steward'] }, { roles: ['admin', 'advisor'] }, {}]))).toEqual([
      { label: 'Staff seats', value: 3 }, { label: 'Assigned roles', value: 3 },
    ]);
    expect(staffDeskNumbers('vp', ok({ activeGrievances: 9, memberCount: 1001 }))).toEqual([
      { label: 'Active issues', value: 9 }, { label: 'Campaign workers', value: 1001 },
    ]);
    expect(['steward', 'coordinator', 'advisor', 'admin', 'vp'].map((role) => staffDeskNumbersRead(role as LiveStaffRole))).toEqual([
      'get_steward_desk_kpis', 'get_coordinator_kpis', 'get_advisor_overview', 'get_staff_roster', 'get_vp_overview',
    ]);
  });

  it('never invents a number: loading, a failed read or a missing field stays empty', () => {
    const roles: LiveStaffRole[] = ['steward', 'coordinator', 'advisor', 'admin', 'vp'];
    for (const role of roles) {
      const labels = staffDeskNumberLabels(role);
      expect(labels.length).toBeGreaterThanOrEqual(2);
      for (const read of [null, { data: null, error: new Error('denied') }, ok({}), ok(null)]) {
        expect(staffDeskNumbers(role, read)).toEqual(labels.map((label) => ({ label, value: null })));
      }
    }
    expect(staffDeskNumbers('steward', ok([{ open_requests: '7', awaiting_reply: -1 }]))).toEqual([
      { label: 'Open requests', value: 7 }, { label: 'Awaiting reply', value: null },
    ]);
  });

  it('replaces the worker strip on live Home for a staff role whose desk opens', () => {
    const home = readFileSync(new URL('../../app/(tabs)/home.tsx', import.meta.url), 'utf8');
    expect(home).toContain('const deskRole = staffRole && canOpenFeature(mode, staffRole, null, chapterRoles, organizationRoles) ? staffRole : null;');
    expect(home).toContain('const deskNumbers = useStaffDeskNumbers(deskRole);');
    expect(home).toContain('{deskRole && deskNumbers ? (');
    // A missing value is spoken as loading or unavailable, never as a dash,
    // a failed read says so once, and each number names where it goes.
    // In the saved member language (#8302): the label, its spoken state and its hint.
    expect(home).toContain("label={catalogLabel(item.label)}");
    expect(home).toContain("spokenLabel={item.value === null ? t(deskNumbers.status === 'failed' ? '{label}, unavailable' : '{label}, loading', { label: catalogLabel(item.label) }) : undefined}");
    expect(home).toContain("{deskNumbers.status === 'failed' ? <Body muted>{t(\"Your desk numbers could not load. Pull down to try again.\")}</Body> : null}");
    expect(home).toContain("hint={destination.name ? t('Opens {name}.', { name: catalogLabel(destination.name) }) : t('Opens the {role} desk.', { role: catalogLabel(LIVE_STAFF_ROLE_LABELS[deskRole]) })}");
    expect(home).toContain("accessibilityLabel={t('{role} desk summary', { role: catalogLabel(LIVE_STAFF_ROLE_LABELS[deskRole]) })}");
    expect(home).toContain("value={item.value ?? '—'}");
    // Two or three desk numbers share the row rather than sitting in quarter columns.
    expect(home).toContain('width={summaryWidth}');
    expect(home).not.toContain("summaryWidth === '25%' ?");
    // Each number opens its own section where one exists (staffDeskLinks.test.ts).
    expect(home).toContain('onPress={() => router.push(destination.href as never)}');
    // Members keep their own strip.
    expect(home).toContain("accessibilityLabel={t(\"Worker summary\")}");
    const hook = readFileSync(new URL('../features/home/useStaffDeskNumbers.ts', import.meta.url), 'utf8');
    expect(hook).toContain('createCapturedSessionRpcClient(session).rpc(staffDeskNumbersRead(role))');
    expect(hook).toContain('const current = read && read.key === key ? read.result : null;');
    expect(hook).toContain("status: current === null ? 'loading' : current.error ? 'failed' : 'ready'");
  });
});
