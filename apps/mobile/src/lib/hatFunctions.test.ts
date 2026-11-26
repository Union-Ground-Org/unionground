import { describe, expect, it } from 'vitest';

import { applyWidgetLayout, deriveLiveStaffRoles, explicitLiveStaffHat, hatFunctionBlurb, narrowLiveStaffRoles, selectableLiveStaffRoles, featureGroupsForHat, featureGroupsForRoles, withMyCampaignGroup, functionsForHat, MEMBER_FEATURE_GROUPS, MEMBER_HAT_FUNCTIONS, MEMBER_WORK_WIDGETS, moveVisibleWidgetKey, moveWidgetKey, rightPaneKindForHat, STAFF_HAT_FUNCTIONS, toggleWidgetHidden, widgetSourceFor, WORK_WIDGET_KEYS, workItemsForHat, workItemsForRoles } from './hatFunctions';
import type { HatFunction, LiveStaffRole, LiveStaffScopeInput, WidgetSource } from './hatFunctions';
import type { PreviewHatKey } from '../data/preview';

describe('desktop hat function parity', () => {
  it('puts My campaign first in All tools without changing the authorized destination groups', () => {
    const hats: PreviewHatKey[] = ['member', 'organizer', 'steward', 'coordinator', 'advisor', 'admin', 'vp'];
    const sources = [
      ...hats.map(featureGroupsForHat),
      featureGroupsForRoles([]), featureGroupsForRoles(['steward']), featureGroupsForRoles([], ['admin']),
    ];
    for (const source of sources) {
      const groups = withMyCampaignGroup(source);
      expect(groups[0]).toEqual({ key: 'my-campaign', label: 'My campaign', items: [{ key: 'my-campaign', label: 'Campaign', href: '/campaign', icon: 'people' }] });
      expect(groups.slice(1)).toEqual(source);
    }
  });
  it('lists the desktop worker rail on the left card, grouped like the site', () => {
    expect(MEMBER_FEATURE_GROUPS.map((group) => group.key)).toEqual(['me', 'union', 'account']);
    expect(functionsForHat('member').map((item) => item.label)).toEqual(MEMBER_HAT_FUNCTIONS.map((item) => item.label));
    expect(functionsForHat(null)).toEqual(MEMBER_HAT_FUNCTIONS);
    expect(MEMBER_HAT_FUNCTIONS.map((item) => item.label)).toEqual([
      'My issues',
      'Messages',
      'One-on-ones',
      'Forms',
      'Workplace log',
      'My reports',
      'Pay tools',
      'Votes',
      'Contributions',
      'Organizing rights',
      'Worker support',
      'My campaign',
      'Meetings',
      'Be heard',
      'Worker questions',
      'Recognition paths',
      'Collective actions',
      'Search',
      'Notifications',
      'Profile',
      'Settings',
    ]);
    // Existing-union destinations never reach a worker.
    for (const label of ['Dues', 'Find a chapter', 'My cases', 'Know your rights']) {
      expect(MEMBER_HAT_FUNCTIONS.map((item) => item.label)).not.toContain(label);
    }
  });

  it('matches the site Work card widgets for workers', () => {
    expect(WORK_WIDGET_KEYS).toEqual(['messages', 'cases', 'appointments', 'forms', 'workload', 'numbers', 'actions']);
    expect(workItemsForHat('member').map((item) => item.key)).toEqual(WORK_WIDGET_KEYS);
    expect(MEMBER_WORK_WIDGETS.map((item) => item.label)).toEqual([
      'Messages',
      'My issues',
      'One-on-ones',
      'Forms',
      'Workplace log',
      'My reports',
      'Collective actions',
    ]);
  });

  it('lists the desktop rail functions for every staff hat', () => {
    expect(STAFF_HAT_FUNCTIONS.organizer.map((item) => item.label)).toEqual([
      'Organizing desk',
      'Card drive',
      'Committee coverage',
      'Worker questions',
      'Organization analytics',
      // The shared campaign block leads with dated Campaign work, then the
      // recognition plan and campaign tools, then the map and handshakes.
      'Campaign work',
      'Recognition paths',
      'Campaign hub',
      'Meetings desk',
      'Issue campaigns',
      'Collective actions',
      'Power map',
      'Campaign agreements',
    ]);
    expect(STAFF_HAT_FUNCTIONS.steward.map((item) => item.label)).toEqual([
      'Committee desk',
      'Your issues',
      'Worker requests',
      'One-on-ones',
      'Forms review',
      'Committee messages',
      'Scan check-ins',
      'Broadcasts',
      'Worker questions',
      'Organization analytics',
      'Campaign work',
      'Recognition paths',
      'Campaign hub',
      'Meetings desk',
      'Issue campaigns',
      'Collective actions',
      'Power map',
      'Campaign agreements',
    ]);
    expect(STAFF_HAT_FUNCTIONS.coordinator).toHaveLength(14);
    expect(STAFF_HAT_FUNCTIONS.advisor).toHaveLength(16);
    // Four Admin rows that opened Chapter admin without their content left the
    // list (#7874).
    // Chapter notices (#9099 part 2) and Invitations (#9099 part 4) joined
    // the Admin and President lists.
    expect(STAFF_HAT_FUNCTIONS.admin).toHaveLength(18);
    expect(STAFF_HAT_FUNCTIONS.vp).toHaveLength(20);
    expect(STAFF_HAT_FUNCTIONS.admin.some((item) => item.key === 'integrations')).toBe(true);
    expect(STAFF_HAT_FUNCTIONS.vp.some((item) => item.key === 'integrations')).toBe(true);
    expect(STAFF_HAT_FUNCTIONS.steward.some((item) => item.key === 'integrations')).toBe(false);
    expect(STAFF_HAT_FUNCTIONS.admin.some((item) => item.key === 'operations')).toBe(true);
    expect(STAFF_HAT_FUNCTIONS.vp.some((item) => item.key === 'operations')).toBe(false);
    expect(functionsForHat('vp').some((item) => item.label === 'Needs chair attention')).toBe(true);
    // Grievance-only desk rows are gone from every hat.
    const everyLabel = Object.values(STAFF_HAT_FUNCTIONS).flat().map((item) => item.label);
    for (const label of ['By article cited', 'Casework', 'Case queue', 'Escalation funnel', 'Dues']) {
      expect(everyLabel).not.toContain(label);
    }
  });

  it('gives the Advisor desk and shared health portfolio distinct accessible labels', () => {
    const advisorItems = STAFF_HAT_FUNCTIONS.advisor.filter((item) => item.key === 'advisor' || item.key === 'chapter-health');
    expect(advisorItems.map((item) => [item.label, item.href])).toEqual([
      ['Campaign health', '/feature/advisor'],
      ['Health portfolio', '/feature/chapter-health'],
    ]);
    expect(new Set(advisorItems.map((item) => item.label)).size).toBe(advisorItems.length);
  });

  it('projects only one unambiguous server-confirmed live staff identity', () => {
    const liveGroups = featureGroupsForRoles(['admin']);
    const liveItems = liveGroups.flatMap((group) => group.items);
    expect(liveItems.some((item) => item.key === 'voting')).toBe(true);
    expect(liveItems.some((item) => item.key === 'admin')).toBe(true);
    expect(liveItems.filter((item) => item.key === 'tasks')).toHaveLength(1);
    expect(workItemsForRoles(['admin']).filter((item) => item.key === 'tasks')).toHaveLength(1);
    expect(featureGroupsForRoles(['admin', 'steward'])).toEqual(MEMBER_FEATURE_GROUPS);
    expect(workItemsForRoles(['admin', 'steward'])).toEqual(MEMBER_WORK_WIDGETS);
    expect(explicitLiveStaffHat(['admin'])).toBe('admin');
    expect(explicitLiveStaffHat(['admin', 'steward'])).toBeNull();
    expect(explicitLiveStaffHat([])).toBeNull();
    expect(explicitLiveStaffHat(['nonsense'])).toBeNull();
    expect(explicitLiveStaffHat(['admin', 'admin'])).toBe('admin');
    expect(explicitLiveStaffHat(['admin', 'vp'])).toBeNull();
    expect(featureGroupsForRoles([])).toEqual(MEMBER_FEATURE_GROUPS);
    const organizationOnly = featureGroupsForRoles([], ['advisor']).flatMap((group) => group.items);
    expect(organizationOnly.some((item) => item.key === 'chapter-health')).toBe(true);
    expect(organizationOnly.some((item) => item.key === 'tasks')).toBe(false);
    expect(organizationOnly.some((item) => item.key === 'partners')).toBe(false);
    expect(workItemsForRoles([], ['admin']).some((item) => item.key === 'operations')).toBe(true);
    expect(workItemsForRoles([], ['admin']).some((item) => item.key === 'tasks')).toBe(false);
  });

  // An organization-scoped administrator is the user class the two chapter
  // verification RPCs authorize. Live navigation must carry them to the
  // destinations that hold those decisions — Admin desk, Chapter agreements,
  // Chapter memberships — instead of leaving a typed deep link as the only
  // way in. `admin-events` stays out: it opens the chapter Events desk.
  it('carries an organization-scoped administrator to the destinations their decisions live on', () => {
    const organizationAdmin = featureGroupsForRoles([], ['admin']).flatMap((group) => group.items);
    for (const key of ['admin', 'admin-access', 'partners', 'chapter-memberships', 'operations']) {
      expect(organizationAdmin.some((item) => item.key === key)).toBe(true);
    }
    for (const key of ['admin-events', 'tasks', 'events-desk', 'campaigns']) {
      expect(organizationAdmin.some((item) => item.key === key)).toBe(false);
    }
    expect(workItemsForRoles([], ['admin']).some((item) => item.key === 'chapter-memberships')).toBe(true);
    // The widening is the Admin hat's alone.
    const organizationAdvisor = featureGroupsForRoles([], ['advisor']).flatMap((group) => group.items);
    expect(organizationAdvisor.some((item) => item.key === 'partners')).toBe(false);
    // A chapter-scoped administrator keeps every destination they had.
    const chapterAdmin = featureGroupsForRoles(['admin']).flatMap((group) => group.items);
    for (const key of ['admin', 'admin-events', 'partners', 'chapter-memberships', 'tasks']) {
      expect(chapterAdmin.some((item) => item.key === key)).toBe(true);
    }
    expect(chapterAdmin.some((item) => item.key === 'operations')).toBe(false);
  });

  it('exposes Dues on no hat', () => {
    for (const hat of [null, 'member', 'organizer', 'steward', 'coordinator', 'advisor', 'admin', 'vp'] as const) {
      expect(functionsForHat(hat).filter((item) => item.key === 'dues'), String(hat)).toHaveLength(0);
    }
    expect(featureGroupsForRoles(['admin']).flatMap((group) => group.items).filter((item) => item.key === 'dues')).toHaveLength(0);
  });

  it('gives the Guide to workers and a customizable work pane to every organizing hat', () => {
    expect(rightPaneKindForHat('member')).toBe('compass');
    expect(rightPaneKindForHat(null)).toBe('compass');
    expect(rightPaneKindForHat('organizer')).toBe('work');
    expect(rightPaneKindForHat('steward')).toBe('work');
    expect(rightPaneKindForHat('coordinator')).toBe('work');
    expect(rightPaneKindForHat('advisor')).toBe('work');
    expect(rightPaneKindForHat('admin')).toBe('work');
    expect(rightPaneKindForHat('vp')).toBe('work');
  });

  it('reorders and hides staff work widgets without dropping the catalog', () => {
    const catalog = STAFF_HAT_FUNCTIONS.steward;
    const moved = moveWidgetKey(catalog.map((item) => item.key), 'steward-forms', -1);
    expect(moved[moved.indexOf('steward-forms') + 1]).toBe('steward-appointments');
    const hidden = toggleWidgetHidden({ order: moved, hidden: [] }, catalog, 'steward-broadcasts');
    const visible = applyWidgetLayout(catalog, hidden);
    expect(visible.map((item) => item.key)).not.toContain('steward-broadcasts');
    expect(visible[0]?.key).toBe('steward');
    const restored = applyWidgetLayout(catalog, toggleWidgetHidden(hidden, catalog, 'steward-broadcasts'));
    expect(restored).toHaveLength(catalog.length);
  });

  it('moves visible widgets past hidden neighbors', () => {
    const catalog = MEMBER_WORK_WIDGETS;
    const order = catalog.map((item) => item.key);
    const hidden = toggleWidgetHidden({ order, hidden: [] }, catalog, 'appointments');
    const moved = moveVisibleWidgetKey(hidden.order, hidden.hidden, 'messages', 1);
    const visible = applyWidgetLayout(catalog, { order: moved, hidden: hidden.hidden }).map((item) => item.key);
    expect(visible[0]).toBe('cases');
    expect(visible[1]).toBe('messages');
  });

  it('keeps desk sections on their desk instead of aliasing worker surfaces', () => {
    const href = (hat: keyof typeof STAFF_HAT_FUNCTIONS, key: string) =>
      STAFF_HAT_FUNCTIONS[hat].find((item) => item.key === key)?.href;
    expect(href('steward', 'steward-caseload')).toBe('/feature/steward-caseload');
    expect(href('steward', 'steward-requests')).toBe('/feature/steward-requests');
    expect(href('steward', 'steward-forms')).toBe('/feature/steward-forms');
    expect(href('steward', 'steward-broadcasts')).toBe('/feature/steward-broadcasts');
    expect(href('steward', 'steward-forms')).not.toBe('/feature/forms');
    expect(href('steward', 'steward-broadcasts')).not.toBe('/feature/voice');
    expect(href('advisor', 'advisor-turnout')).toBe('/feature/advisor');
    expect(href('advisor', 'advisor-workload')).toBe('/feature/advisor');
    expect(href('vp', 'vp-events')).toBe('/feature/vp');
    // Same-system-staff-side and shared-tool sections keep their destinations.
    expect(href('steward', 'steward-messages')).toBe('/messages?show=steward');
    expect(href('steward', 'steward-checkins')).toBe('/feature/events-desk');
    expect(href('admin', 'admin-events')).toBe('/feature/events-desk');
    expect(href('vp', 'vp-priorities')).toBe('/feature/campaigns');
  });

  it('opens the committee member One-on-ones row on its own one-on-one desk, not the issue work desk', () => {
    const item = STAFF_HAT_FUNCTIONS.steward.find((entry) => entry.key === 'steward-appointments');
    expect(item?.href).toBe('/feature/steward-appointments');
    const featureKey = item?.href.replace('/feature/', '') ?? '';
    expect(featureKey).toBe('steward-appointments');
    expect(featureKey).not.toBe('steward');
  });

  it('pins a distinct row source for every admin work widget', () => {
    const sources = STAFF_HAT_FUNCTIONS.admin.map((item) => widgetSourceFor(item.key));
    expect(widgetSourceFor('admin-access')).toBe('access');
    expect(widgetSourceFor('admin-events')).toBe('events');
    expect(new Set(sources).size).toBe(sources.length);
    for (const [hat, items] of Object.entries(STAFF_HAT_FUNCTIONS)) {
      for (const item of items) {
        expect(widgetSourceFor(item.key), `${hat}:${item.key}`).not.toBeUndefined();
      }
    }
  });

  // Every key any Work drawer can render, with the row source it must resolve
  // to. The table is the contract: a new widget key fails until it is listed
  // here, and a listed key fails when the source map routes it elsewhere.
  const EXPECTED_WIDGET_SOURCES: Record<string, WidgetSource> = {
    messages: 'messages',
    appointments: 'appointments',
    cases: 'cases',
    forms: 'forms',
    workload: 'workload',
    numbers: 'numbers',
    actions: 'actions',
    organizer: 'queue',
    'organizer-cards': 'kpis',
    'organizer-committee': 'leadership',
    recognition: 'recognition',
    steward: 'queue',
    'steward-caseload': 'cases',
    'steward-requests': 'messages',
    'steward-appointments': 'appointments',
    'steward-forms': 'forms',
    'steward-messages': 'messages',
    'steward-checkins': 'events',
    'steward-broadcasts': 'broadcasts',
    'chapter-notices': 'broadcasts',
    'chapter-invitations': 'invitations',
    coordinator: 'queue',
    'coordinator-cases': 'cases',
    'coordinator-deadlines': 'deadlines',
    'coordinator-funnel': 'kpis',
    advisor: 'kpis',
    'advisor-workload': 'workload',
    'advisor-turnout': 'ballots',
    'advisor-risks': 'risks',
    'advisor-leadership': 'leadership',
    admin: 'kpis',
    'admin-access': 'access',
    'admin-events': 'events',
    vp: 'kpis',
    'vp-trend': 'trend',
    'vp-attention': 'queue',
    'vp-leadership': 'leadership',
    'vp-priorities': 'campaigns',
    'vp-events': 'events',
    qa: 'qa',
    analytics: 'analytics',
    tasks: 'tasks',
    'chapter-health': 'health',
    'chapter-memberships': 'memberships',
    hub: 'hub',
    'events-desk': 'events',
    campaigns: 'campaigns',
    'organization-map': 'organization-map',
    partners: 'handshakes',
    operations: 'operations',
    integrations: 'integrations',
  };

  // The noun a source's rows are made of. A widget's label or blurb has to
  // name that noun, which is what a trend over ballot rows, follow-up dates
  // over campaign tasks and "Broadcasts" over the campaign catalog would not.
  const SOURCE_NOUN: Record<WidgetSource, RegExp> = {
    messages: /\b(messages?|requests?|conversations?)\b/i,
    appointments: /\b(appointments?|one-on-ones?)\b/i,
    cases: /\bissues?\b/i,
    forms: /\bforms?\b/i,
    workload: /\b(workload|workplace log)\b/i,
    numbers: /\breports?\b/i,
    events: /\b(meetings?|check-ins?)\b/i,
    campaigns: /\bcampaigns?\b/i,
    tasks: /\bcampaign work\b/i,
    queue: /\b(queue|attention|desk)\b/i,
    kpis: /\b(health|admin|overview|progress|card drive)\b/i,
    ballots: /\b(ballots?|votes?|turnout)\b/i,
    rewards: /\bcontributions?\b/i,
    access: /\baccess\b/i,
    mfa: /\btwo-step\b/i,
    audit: /\badmin (activity|actions)\b/i,
    leadership: /\b(leadership|coverage)\b/i,
    risks: /\brisks?\b/i,
    hub: /\bhub\b/i,
    pay: /\bpay\b/i,
    qa: /\b(questions?|q&a)\b/i,
    integrations: /\bconnected services\b/i,
    operations: /\boperations\b/i,
    analytics: /\banalytics\b/i,
    'organization-map': /\bpower map\b/i,
    actions: /\bactions?\b/i,
    handshakes: /\bagreements?\b/i,
    memberships: /\bmemberships?\b/i,
    health: /\bhealth\b/i,
    trend: /\btrend\b/i,
    deadlines: /\bfollow-up dates?\b/i,
    // A broadcast row is a chapter notice (member_broadcasts).
    broadcasts: /\b(?:broadcasts?|notices?)\b/i,
    invitations: /\binvitations?\b/i,
    recognition: /\brecognition\b/i,
  };

  function everyWorkWidget(): HatFunction[] {
    const byKey = new Map<string, HatFunction>();
    for (const item of [...MEMBER_WORK_WIDGETS, ...Object.values(STAFF_HAT_FUNCTIONS).flat()]) byKey.set(item.key, item);
    return [...byKey.values()];
  }

  it('resolves every work widget key to the row source the table names for it', () => {
    const widgets = everyWorkWidget();
    expect(widgets.map((item) => item.key).sort()).toEqual(Object.keys(EXPECTED_WIDGET_SOURCES).sort());
    for (const item of widgets) {
      expect(widgetSourceFor(item.key), item.key).toBe(EXPECTED_WIDGET_SOURCES[item.key]);
    }
    expect(widgetSourceFor('vp-trend')).not.toBe('ballots');
    expect(widgetSourceFor('coordinator-deadlines')).not.toBe('tasks');
    expect(widgetSourceFor('steward-broadcasts')).not.toBe('campaigns');
  });

  // No exceptions: a widget whose source is not its own noun fails here.
  it('gives every work widget a source whose rows are the noun its label or blurb names', () => {
    for (const item of everyWorkWidget()) {
      const copy = `${item.label}. ${item.blurb ?? ''}`;
      const agrees = SOURCE_NOUN[widgetSourceFor(item.key)].test(copy);
      expect(agrees, `${item.key} -> ${widgetSourceFor(item.key)}: "${copy}"`).toBe(true);
    }
  });

  it('shares a row source between two widgets on one desk only in the pairs listed here', () => {
    const sharedOnOneDesk: string[] = [];
    for (const [hat, items] of Object.entries(STAFF_HAT_FUNCTIONS)) {
      const bySource = new Map<WidgetSource, string[]>();
      for (const item of items) bySource.set(widgetSourceFor(item.key), [...(bySource.get(widgetSourceFor(item.key)) ?? []), item.key]);
      for (const [source, keys] of bySource) if (keys.length > 1) sharedOnOneDesk.push(`${hat}:${source}:${keys.join('+')}`);
    }
    expect(sharedOnOneDesk).toEqual([
      'steward:messages:steward-requests+steward-messages',
      'steward:events:steward-checkins+events-desk',
      'vp:campaigns:vp-priorities+campaigns',
      'vp:events:vp-events+events-desk',
    ]);
  });
});

describe('deriveLiveStaffRoles', () => {
  const previewRoles: LiveStaffRole[] = ['vp'];
  const populated: NonNullable<LiveStaffScopeInput> = {
    roles: ['admin', 'steward'],
    chapterRoles: ['steward', 'advisor'],
  };
  const empty: ReturnType<typeof deriveLiveStaffRoles> = {
    organizationRoles: [],
    chapterRoles: [],
    authorizedRoles: [],
  };
  const authorizedUnion: LiveStaffRole[] = ['admin', 'steward', 'advisor'];
  const staffAuthorizedValues: LiveStaffScopeInput[] = [
    { ...populated, staffAuthorized: true },
    { ...populated, staffAuthorized: false },
    populated,
    null,
  ];

  it('keeps every role list empty while signed out, even when a leftover scope claims staffAuthorized', () => {
    for (const organizationStaffScope of staffAuthorizedValues) {
      expect(deriveLiveStaffRoles({ mode: 'signedOut', previewRoles, organizationStaffScope })).toEqual(empty);
    }
  });

  it('projects the preview hat as organization and authorized roles and never campaign roles', () => {
    const previewExpected: ReturnType<typeof deriveLiveStaffRoles> = {
      organizationRoles: previewRoles,
      chapterRoles: [],
      authorizedRoles: previewRoles,
    };
    for (const organizationStaffScope of staffAuthorizedValues) {
      expect(deriveLiveStaffRoles({ mode: 'preview', previewRoles, organizationStaffScope })).toEqual(previewExpected);
    }
  });

  it('projects the scope roles only for authenticated sessions with staffAuthorized strictly true', () => {
    expect(deriveLiveStaffRoles({
      mode: 'authenticated',
      previewRoles,
      organizationStaffScope: { ...populated, staffAuthorized: true },
    })).toEqual({
      organizationRoles: populated.roles,
      chapterRoles: populated.chapterRoles,
      authorizedRoles: authorizedUnion,
    });
    expect(deriveLiveStaffRoles({
      mode: 'authenticated',
      previewRoles,
      organizationStaffScope: { ...populated, staffAuthorized: false },
    })).toEqual(empty);
    expect(deriveLiveStaffRoles({
      mode: 'authenticated',
      previewRoles,
      organizationStaffScope: populated,
    })).toEqual(empty);
    expect(deriveLiveStaffRoles({
      mode: 'authenticated',
      previewRoles,
      organizationStaffScope: null,
    })).toEqual(empty);
  });
});

describe('live staff role choice (multi-role accounts)', () => {
  const twoRoles = deriveLiveStaffRoles({
    mode: 'authenticated',
    previewRoles: [],
    organizationStaffScope: { roles: ['admin'], chapterRoles: ['admin', 'steward'], staffAuthorized: true },
  });

  it('offers a choice only when the server confirmed more than one staff role, in desk order', () => {
    expect(selectableLiveStaffRoles(twoRoles)).toEqual(['steward', 'admin']);
    expect(selectableLiveStaffRoles({ organizationRoles: [], chapterRoles: ['admin'], authorizedRoles: ['admin'] })).toEqual([]);
    expect(selectableLiveStaffRoles({ organizationRoles: [], chapterRoles: [], authorizedRoles: [] })).toEqual([]);
  });

  it('keeps both roles unprojected until one is chosen, then projects exactly the chosen one', () => {
    expect(explicitLiveStaffHat(narrowLiveStaffRoles(twoRoles, null).authorizedRoles)).toBeNull();
    const steward = narrowLiveStaffRoles(twoRoles, 'steward');
    expect(steward).toEqual({ organizationRoles: [], chapterRoles: ['steward'], authorizedRoles: ['steward'] });
    expect(explicitLiveStaffHat(steward.authorizedRoles)).toBe('steward');
    const admin = narrowLiveStaffRoles(twoRoles, 'admin');
    expect(admin).toEqual({ organizationRoles: ['admin'], chapterRoles: ['admin'], authorizedRoles: ['admin'] });
  });

  it('ignores a pick that is not an authorized role and never adds a role', () => {
    expect(narrowLiveStaffRoles(twoRoles, 'vp')).toBe(twoRoles);
    const single: ReturnType<typeof deriveLiveStaffRoles> = { organizationRoles: [], chapterRoles: ['admin'], authorizedRoles: ['admin'] };
    expect(narrowLiveStaffRoles(single, 'steward')).toBe(single);
    expect(narrowLiveStaffRoles(single, 'admin')).toBe(single);
  });
});

// BUG-UG-HELD-FEATURE-TRACES-PACKET-LIMIT-AND-MAP-SUBTITLE-20261113
// (#8598): the Power map row names relationships
// (the Neuro Map) only once a read says it is on; held, it reads off.
describe('Power map row while the Neuro Map is held', () => {
  const map = workItemsForRoles([], ['admin']).find((item) => item.key === 'organization-map');

  it('names neither relationships nor topic readiness while it is held, off or unread', () => {
    expect(map).toBeDefined();
    expect(hatFunctionBlurb(map as HatFunction, false)).toBe('Employer structure, decision-makers, and sourced history.');
    expect(hatFunctionBlurb(map as HatFunction, false)).not.toMatch(/relationship|topic readiness/i);
  });

  it('reads exactly as before once released', () => {
    expect(hatFunctionBlurb(map as HatFunction, true)).toBe('Employer structure, decision-makers, relationships, and sourced history.');
  });

  it('leaves every other row as it is', () => {
    for (const item of workItemsForRoles([], ['admin']).filter((candidate) => candidate.key !== 'organization-map')) {
      expect(hatFunctionBlurb(item, false), item.key).toBe(item.blurb);
    }
  });
});
