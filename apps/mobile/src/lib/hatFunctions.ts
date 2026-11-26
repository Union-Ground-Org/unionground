import { STAFF_DESK_HATS, isSameDeskSection } from '../features/deskJump';
import type { PreviewHatKey } from '../data/preview';

// A demo or preview hat (the preview's own hats are the full set).
export type HatKey = PreviewHatKey;

export type HatFunction = {
  key: string;
  label: string;
  href: string;
  icon: 'briefcase' | 'chatbubbles' | 'calendar' | 'document' | 'megaphone' | 'checkmark' | 'people' | 'home' | 'stats' | 'shield' | 'gift' | 'alert' | 'flag' | 'time' | 'search' | 'settings' | 'notifications' | 'person' | 'business' | 'link' | 'analytics' | 'map' | 'pulse' | 'cash' | 'receipt' | 'folder' | 'mail' | 'help' | 'key' | 'qr' | 'trending' | 'hand' | 'server' | 'puzzle';
  blurb?: string;
};

export type HatFunctionGroup = {
  key: string;
  label: string;
  items: HatFunction[];
};

export type WorkWidgetKey = 'messages' | 'cases' | 'appointments' | 'forms' | 'workload' | 'numbers' | 'actions';

export const WORK_WIDGET_KEYS: WorkWidgetKey[] = ['messages', 'cases', 'appointments', 'forms', 'workload', 'numbers', 'actions'];

const chapterWork: HatFunction = { key: 'tasks', label: 'Campaign work', href: '/feature/tasks', icon: 'checkmark' };
const organize: HatFunction = { key: 'hub', label: 'Campaign hub', href: '/feature/chapter', icon: 'home' };
const eventsDesk: HatFunction = { key: 'events-desk', label: 'Meetings desk', href: '/feature/events-desk', icon: 'calendar' };
const campaigns: HatFunction = { key: 'campaigns', label: 'Issue campaigns', href: '/feature/campaigns', icon: 'flag' };
const integrationControls: HatFunction = { key: 'integrations', label: 'Connected services', href: '/feature/integrations', icon: 'puzzle', blurb: 'Optional connections stay unset until your organization sets them up.' };
const operationsHealth: HatFunction = { key: 'operations', label: 'Operations health', href: '/feature/operations', icon: 'server', blurb: 'Organization audit ledger and job monitors. No invented runs.' };
const organizationAnalytics: HatFunction = { key: 'analytics', label: 'Organization analytics', href: '/feature/analytics', icon: 'analytics', blurb: 'Organization-safe totals. Empty until a snapshot exists.' };
const organizationMap: HatFunction = { key: 'organization-map', label: 'Power map', href: '/feature/organization-map', icon: 'map', blurb: 'Employer structure, decision-makers, relationships, and sourced history.' };
// BUG-UG-HELD-FEATURE-TRACES-PACKET-LIMIT-AND-MAP-SUBTITLE-20261113:
// relationships and topic readiness are the Neuro Map, so the row names them
// only once a read says the Neuro Map is on; held for its release day it reads
// off (docs/contracts/staged-feature-releases.md).
const ORGANIZATION_MAP_BLURB_WITHOUT_NEURO_MAP = 'Employer structure, decision-makers, and sourced history.';
export function hatFunctionBlurb(item: HatFunction, neuroMapOn: boolean): string | undefined {
  return item.key === organizationMap.key && !neuroMapOn ? ORGANIZATION_MAP_BLURB_WITHOUT_NEURO_MAP : item.blurb;
}
const collectiveActions: HatFunction = { key: 'actions', label: 'Collective actions', href: '/feature/actions', icon: 'hand', blurb: 'Join a petition, delegation, meeting, or volunteer action.' };
const memberQuestions: HatFunction = { key: 'qa', label: 'Worker questions', href: '/feature/qa', icon: 'help', blurb: 'Campaign Q&A. Official replies come from an organizer or the committee.' };
const chapterHandshakes: HatFunction = { key: 'partners', label: 'Campaign agreements', href: '/feature/partners', icon: 'link', blurb: 'Two-sided requests between campaigns, signatures, bounded sharing, and closure.' };
const chapterHealth: HatFunction = { key: 'chapter-health', label: 'Health portfolio', href: '/feature/chapter-health', icon: 'pulse', blurb: 'Privacy-safe drivers, dated trends, and coaching follow-up.' };
const chapterMemberships: HatFunction = { key: 'chapter-memberships', label: 'Campaign memberships', href: '/feature/chapter-memberships', icon: 'person', blurb: 'Hold one person in more than one campaign, and scope their roles to the campaign you name.' };
const recognitionPaths: HatFunction = { key: 'recognition', label: 'Recognition paths', href: '/recognition', icon: 'trending', blurb: 'Election and voluntary recognition stay separate. A card majority is not certification.' };

// Desk sections stay hash targets on their desk, mirroring the web desks: a
// committee section must not alias the worker surface it supervises (Forms
// review is not worker Forms; Broadcasts is not Be heard). Sections whose
// pattern is a shared tool (check-ins, admin meetings) or the same system on
// the organizing side (committee messages) keep that destination. One-on-ones
// is the one exception: the committee-side desk owns its own screen
// (upcoming/recent, outcomes, availability, calendar connections).
export const STAFF_HAT_FUNCTIONS: Record<Exclude<PreviewHatKey, 'member'>, HatFunction[]> = {
  organizer: [
    { key: 'organizer', label: 'Organizing desk', href: '/feature/organizer', icon: 'briefcase', blurb: 'The queue of coworkers to reach next. Names stay inside the campaign.' },
    { key: 'organizer-cards', label: 'Card drive', href: '/feature/organizer', icon: 'checkmark', blurb: 'Cards recorded against the eligible estimate. Not a vote count or certification.' },
    { key: 'organizer-committee', label: 'Committee coverage', href: '/feature/organizer', icon: 'people', blurb: 'Which shifts and units have a committee member.' },
    memberQuestions,
    organizationAnalytics,
    chapterWork,
    recognitionPaths,
    organize,
    eventsDesk,
    campaigns,
    collectiveActions,
    organizationMap,
    chapterHandshakes,
  ],
  steward: [
    { key: 'steward', label: 'Committee desk', href: '/feature/steward', icon: 'briefcase', blurb: 'Committee home for the sections below.' },
    { key: 'steward-caseload', label: 'Your issues', href: '/feature/steward-caseload', icon: 'folder', blurb: 'Issues the campaign lead asked you to follow. Empty until one is assigned.' },
    { key: 'steward-requests', label: 'Worker requests', href: '/feature/steward-requests', icon: 'mail', blurb: 'Coworkers asking for committee support. Acknowledge or close them here.' },
    { key: 'steward-appointments', label: 'One-on-ones', href: '/feature/steward-appointments', icon: 'calendar', blurb: 'Committee-side one-on-one desk, separate from your own list.' },
    { key: 'steward-forms', label: 'Forms review', href: '/feature/steward-forms', icon: 'document', blurb: 'Submitted worker forms waiting for review. Drafts stay with the worker.' },
    { key: 'steward-messages', label: 'Committee messages', href: '/messages?show=steward', icon: 'chatbubbles', blurb: 'Answer private worker conversations as the committee.' },
    { key: 'steward-checkins', label: 'Scan check-ins', href: '/feature/events-desk', icon: 'qr', blurb: 'Scan or enter meeting check-in codes. Attendance is never scored.' },
    { key: 'steward-broadcasts', label: 'Broadcasts', href: '/feature/steward-broadcasts', icon: 'megaphone', blurb: 'Send campaign updates. One-to-many, not a worker inbox thread.' },
    memberQuestions,
    organizationAnalytics,
    chapterWork,
    recognitionPaths,
    organize,
    eventsDesk,
    campaigns,
    collectiveActions,
    organizationMap,
    chapterHandshakes,
  ],
  coordinator: [
    // #8630: the live Case queue shows active cases and upcoming step
    // deadlines; the escalation funnel and by-article grouping are not on the
    // phone until their screens exist, so this row no longer names them.
    { key: 'coordinator', label: 'Issue queue', href: '/feature/coordinator', icon: 'briefcase', blurb: 'Campaign lead home for the issues coworkers raised: active issues and upcoming deadlines.' },
    { key: 'coordinator-cases', label: 'Active issues', href: '/feature/coordinator', icon: 'folder', blurb: 'Assign committee members and open the recorded facts.' },
    { key: 'coordinator-deadlines', label: 'Follow-up dates', href: '/feature/coordinator', icon: 'time', blurb: 'The dated slice of the queue.' },
    { key: 'coordinator-funnel', label: 'Issue progress', href: '/feature/coordinator', icon: 'stats', blurb: 'How issues move from listening to action.' },
    memberQuestions,
    organizationAnalytics,
    chapterWork,
    recognitionPaths,
    organize,
    eventsDesk,
    campaigns,
    collectiveActions,
    organizationMap,
    chapterHandshakes,
  ],
  advisor: [
    { key: 'advisor', label: 'Campaign health', href: '/feature/advisor', icon: 'stats', blurb: 'Advisor home: collective committee workload, the latest vote turnout, at-risk signals, and the leadership team.' },
    { key: 'advisor-workload', label: 'Committee workload', href: '/feature/advisor', icon: 'time', blurb: 'Aggregated committee load without opening every issue.' },
    { key: 'advisor-turnout', label: 'Latest vote turnout', href: '/feature/advisor', icon: 'flag', blurb: 'How the last committee vote went. Counts only, never individual votes.' },
    { key: 'advisor-risks', label: 'At-risk signals', href: '/feature/advisor', icon: 'alert', blurb: 'Campaign-health risk flags that link authorized records.' },
    { key: 'advisor-leadership', label: 'Leadership team', href: '/feature/advisor', icon: 'people', blurb: 'The campaign leadership you can see.' },
    memberQuestions,
    organizationAnalytics,
    chapterWork,
    recognitionPaths,
    chapterHealth,
    organize,
    eventsDesk,
    campaigns,
    collectiveActions,
    organizationMap,
    chapterHandshakes,
  ],
  admin: [
    // UX-UG-NATIVE-ADMIN-FEATURE-ROWS-OPEN-CHAPTER-ADMIN-WITHOUT-THEIR-CONTENT-20261109:
    // every Admin row opens a screen that shows what it promises. Roles & access
    // opens the chapter memberships screen, where chapter roles are granted and
    // revoked. The extra-verification status, form template, rewards
    // administration and recent-activity rows all opened Chapter admin, which
    // shows none of them, so they stay off the native lists until their screens
    // exist (an organization administrator reads the audit ledger under
    // Operations health).
    { key: 'admin', label: 'Campaign admin', href: '/feature/admin', icon: 'key', blurb: 'See your campaign\'s connected services and their setup.' },
    { key: 'admin-access', label: 'Roles & access', href: '/feature/chapter-memberships', icon: 'people', blurb: 'Grant or revoke a person\'s campaign roles.' },
    { key: 'admin-events', label: 'Meetings & check-in codes', href: '/feature/events-desk', icon: 'calendar', blurb: 'Create meetings and check-in codes.' },
    { key: 'chapter-notices', label: 'Campaign notices', href: '/feature/chapter-notices', icon: 'megaphone', blurb: 'Write and send a notice to your campaign. Workers see it in Announcements.' },
    { key: 'chapter-invitations', label: 'Invitations', href: '/feature/chapter-invitations', icon: 'mail', blurb: 'Invite people to your campaign and follow their invitations to membership.' },
    chapterMemberships,
    memberQuestions,
    organizationAnalytics,
    chapterWork,
    recognitionPaths,
    chapterHealth,
    organize,
    campaigns,
    collectiveActions,
    organizationMap,
    chapterHandshakes,
    operationsHealth,
    integrationControls,
  ],
  vp: [
    { key: 'vp', label: 'Campaign overview', href: '/feature/vp', icon: 'stats', blurb: 'Campaign chair home: membership trend, items that need executive attention, the leadership team, and upcoming meetings.' },
    { key: 'vp-trend', label: 'Support trend', href: '/feature/vp', icon: 'trending', blurb: 'Support movement over time. Totals only.' },
    { key: 'vp-attention', label: 'Needs chair attention', href: '/feature/vp', icon: 'alert', blurb: 'Items that need the chair, linking authorized records.' },
    { key: 'vp-leadership', label: 'Leadership team', href: '/feature/vp', icon: 'people', blurb: 'Campaign leadership roster.' },
    { key: 'chapter-notices', label: 'Campaign notices', href: '/feature/chapter-notices', icon: 'megaphone', blurb: 'Write and send a notice to your campaign. Workers see it in Announcements.' },
    { key: 'chapter-invitations', label: 'Invitations', href: '/feature/chapter-invitations', icon: 'mail', blurb: 'Invite people to your campaign and follow their invitations to membership.' },
    { key: 'vp-priorities', label: 'Issue campaigns & priorities', href: '/feature/campaigns', icon: 'flag', blurb: 'Leadership view of issue campaigns. Authoring stays on Issue campaigns.' },
    { key: 'vp-events', label: 'Upcoming meetings', href: '/feature/vp', icon: 'calendar', blurb: 'Agenda of upcoming meetings for leadership, distinct from worker Meetings.' },
    memberQuestions,
    organizationAnalytics,
    chapterWork,
    recognitionPaths,
    chapterHealth,
    organize,
    eventsDesk,
    campaigns,
    collectiveActions,
    organizationMap,
    chapterHandshakes,
    integrationControls,
  ],
};

const meItems: HatFunction[] = [
  { key: 'cases', label: 'My issues', href: '/feature/cases', icon: 'briefcase' },
  { key: 'messages', label: 'Messages', href: '/messages', icon: 'chatbubbles' },
  { key: 'appointments', label: 'One-on-ones', href: '/feature/appointments', icon: 'calendar' },
  { key: 'forms', label: 'Forms', href: '/feature/forms', icon: 'document' },
  { key: 'workload', label: 'Workplace log', href: '/feature/workload', icon: 'time' },
  { key: 'numbers', label: 'My reports', href: '/feature/numbers', icon: 'stats' },
  { key: 'pay', label: 'Pay tools', href: '/feature/pay', icon: 'cash' },
  { key: 'voting', label: 'Votes', href: '/feature/voting', icon: 'flag' },
  { key: 'rewards', label: 'Contributions', href: '/feature/rewards', icon: 'gift' },
];

const unionItems: HatFunction[] = [
  { key: 'rights', label: 'Organizing rights', href: '/feature/rights', icon: 'shield' },
  // UG 5bdd3d3e31: the guided view keeps Worker support as a core
  // destination, so All tools lists it.
  { key: 'member-support', label: 'Worker support', href: '/feature/member-support', icon: 'people' },
  { key: 'hub', label: 'My campaign', href: '/feature/chapter', icon: 'home' },
  { key: 'events', label: 'Meetings', href: '/feature/events', icon: 'calendar' },
  { key: 'voice', label: 'Be heard', href: '/feature/voice', icon: 'megaphone' },
  { key: 'qa', label: 'Worker questions', href: '/feature/qa', icon: 'help' },
  recognitionPaths,
  collectiveActions,
  { key: 'search', label: 'Search', href: '/feature/search', icon: 'search' },
];

const accountItems: HatFunction[] = [
  { key: 'notifications', label: 'Notifications', href: '/notifications', icon: 'notifications' },
  { key: 'profile', label: 'Profile', href: '/account', icon: 'person' },
  { key: 'settings', label: 'Settings', href: '/account', icon: 'settings' },
];

// Home's All tools drawer keeps this entry ahead of the existing groups.
// Adding a destination grants no organizing role or extra feature permission.
export function withMyCampaignGroup(groups: HatFunctionGroup[]): HatFunctionGroup[] {
  return [
    { key: 'my-campaign', label: 'My campaign', items: [{ key: 'my-campaign', label: 'Campaign', href: '/campaign', icon: 'people' }] },
    ...groups,
  ];
}

export const MEMBER_FEATURE_GROUPS: HatFunctionGroup[] = [
  { key: 'me', label: 'You', items: meItems },
  { key: 'union', label: 'Campaign', items: unionItems },
  { key: 'account', label: 'Account', items: accountItems },
];

export const MEMBER_HAT_FUNCTIONS: HatFunction[] = MEMBER_FEATURE_GROUPS.flatMap((group) => group.items);

export const MEMBER_WORK_WIDGETS: HatFunction[] = [
  { key: 'messages', label: 'Messages', href: '/messages', icon: 'chatbubbles' },
  { key: 'cases', label: 'My issues', href: '/feature/cases', icon: 'briefcase' },
  { key: 'appointments', label: 'One-on-ones', href: '/feature/appointments', icon: 'calendar' },
  { key: 'forms', label: 'Forms', href: '/feature/forms', icon: 'document' },
  { key: 'workload', label: 'Workplace log', href: '/feature/workload', icon: 'time' },
  { key: 'numbers', label: 'My reports', href: '/feature/numbers', icon: 'stats' },
  collectiveActions,
];

const SHARED_CHAPTER_KEYS = new Set([recognitionPaths.key, organize.key, eventsDesk.key, campaigns.key, chapterWork.key, organizationMap.key, collectiveActions.key, chapterHandshakes.key, chapterHealth.key]);
const ORGANIZATION_ONLY_FUNCTION_KEYS = new Set([organizationAnalytics.key, organizationMap.key, integrationControls.key, operationsHealth.key]);
// Destinations whose own route gate (featureCatalog.canOpenFeature) admits an
// organization-scoped administrator as well as a chapter-scoped one: the
// Admin desk sections, chapter-membership administration, and the chapter
// handshakes card that carries the binding decision. Without this the live
// navigation would omit, for the one user class the verification RPCs
// authorize, the destinations that hold their decisions — reachable only by
// typing a deep link. `admin-events` stays out: it opens the chapter Events
// desk, which is still chapter-scoped.
const EITHER_ADMIN_SCOPE_FUNCTION_KEYS = new Set([
  'admin', 'admin-access',
  chapterMemberships.key, chapterHandshakes.key,
]);
// BUG-UG-NATIVE-COORDINATOR-ROLE-SHOWS-NO-CASE-QUEUE-20261118 (#9098):
// the coordinator desk (Case queue and its section rows) opens for a
// coordinator grant at either scope, as featureCatalog.canOpenFeature does. The
// server reads the chapter's cases and step deadlines for an
// organization-wide coordinator too (staff_can_see_user and
// actor_role_covers_member honour has_organization_role), and the website
// lists them for the same person. Only the Case queue rows widen: Escalation
// funnel and By article cited have no view on /feature/coordinator, so they
// and the chapter tools below the desk stay chapter-scoped.
const COORDINATOR_EITHER_SCOPE_KEYS: ReadonlySet<string> = new Set(['coordinator', 'coordinator-cases', 'coordinator-deadlines']);
function isCoordinatorDeskKey(key: string): boolean {
  return COORDINATOR_EITHER_SCOPE_KEYS.has(key);
}
const STAFF_ROLE_ORDER: LiveStaffRole[] = ['organizer', 'steward', 'coordinator', 'advisor', 'admin', 'vp'];

function uniqueFunctions(items: HatFunction[]): HatFunction[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

export function featureGroupsForHat(hat: PreviewHatKey | null): HatFunctionGroup[] {
  if (!hat || hat === 'member') return MEMBER_FEATURE_GROUPS;
  const items = STAFF_HAT_FUNCTIONS[hat];
  return [
    { key: 'desk', label: 'Your desk', items: items.filter((item) => !SHARED_CHAPTER_KEYS.has(item.key)) },
    { key: 'chapter', label: 'Campaign', items: items.filter((item) => SHARED_CHAPTER_KEYS.has(item.key)) },
    { key: 'account', label: 'Account', items: accountItems },
  ];
}

function staffItemsForScopes(
  chapterRoles: readonly Exclude<PreviewHatKey, 'member'>[],
  organizationRoles: readonly Exclude<PreviewHatKey, 'member'>[],
): { items: HatFunction[]; organizationOnly: boolean } {
  const activeRole = explicitLiveStaffHat([...new Set([...chapterRoles, ...organizationRoles])]);
  if (!activeRole) return { items: [], organizationOnly: false };
  const chapterAuthorized = chapterRoles.includes(activeRole);
  const organizationAuthorized = organizationRoles.includes(activeRole);
  const healthAuthorized = ['advisor', 'admin', 'vp'].includes(activeRole) && (chapterAuthorized || organizationAuthorized);
  const items = STAFF_HAT_FUNCTIONS[activeRole].filter((item) => {
    if (ORGANIZATION_ONLY_FUNCTION_KEYS.has(item.key)) return organizationAuthorized;
    if (activeRole === 'admin' && EITHER_ADMIN_SCOPE_FUNCTION_KEYS.has(item.key)) {
      return chapterAuthorized || organizationAuthorized;
    }
    if (activeRole === 'coordinator' && isCoordinatorDeskKey(item.key)) return chapterAuthorized || organizationAuthorized;
    if (item.key === chapterHealth.key || item.key === 'advisor' || item.key.startsWith('advisor-') || item.key === 'vp' || item.key.startsWith('vp-')) return healthAuthorized;
    return chapterAuthorized;
  });
  return { items, organizationOnly: organizationAuthorized && !chapterAuthorized };
}

// Home and Work share the authorized staff projection, including grants
// held only at organization scope. The Guide itself is available to every hat.
export function staffAuthorizedForScopes(
  chapterRoles: readonly Exclude<PreviewHatKey, 'member'>[],
  organizationRoles: readonly Exclude<PreviewHatKey, 'member'>[] = [],
): boolean {
  return staffItemsForScopes(chapterRoles, organizationRoles).items.length > 0;
}

export function featureGroupsForRoles(
  chapterRoles: readonly Exclude<PreviewHatKey, 'member'>[],
  organizationRoles: readonly Exclude<PreviewHatKey, 'member'>[] = [],
): HatFunctionGroup[] {
  const { items: authorizedItems, organizationOnly } = staffItemsForScopes(chapterRoles, organizationRoles);
  const activeRole = explicitLiveStaffHat([...new Set([...chapterRoles, ...organizationRoles])]);
  if (!activeRole) return MEMBER_FEATURE_GROUPS;
  // UX-UG-NATIVE-DESK-SECTION-ROWS-REOPEN-THEIR-DESK-20261111: a row
  // that names a section of a desk but only reopens that desk is left out of
  // the drawer; its desk row's description names what the desk holds. The rows
  // stay in STAFF_HAT_FUNCTIONS for the desk screen's own section labels.
  const staffItems = authorizedItems.filter((item) => !STAFF_DESK_HATS.some((hat) => isSameDeskSection(item, hat)));
  const organizationItems = staffItems.filter((item) => ORGANIZATION_ONLY_FUNCTION_KEYS.has(item.key) || (organizationOnly && (item.key === chapterHealth.key || item.key === 'advisor' || item.key.startsWith('advisor-') || item.key === 'vp' || item.key.startsWith('vp-'))));
  const deskItems = staffItems.filter((item) => !SHARED_CHAPTER_KEYS.has(item.key) && !organizationItems.includes(item));
  const chapterItems = staffItems.filter((item) => SHARED_CHAPTER_KEYS.has(item.key) && !organizationItems.includes(item));
  return [
    ...MEMBER_FEATURE_GROUPS.filter((group) => group.key !== 'account'),
    ...(deskItems.length ? [{ key: 'staff', label: 'Organizing desks', items: deskItems }] : []),
    ...(chapterItems.length ? [{ key: 'chapter-work', label: 'Campaign work', items: chapterItems }] : []),
    ...(organizationItems.length ? [{ key: 'organization', label: 'Organization', items: organizationItems }] : []),
    ...MEMBER_FEATURE_GROUPS.filter((group) => group.key === 'account'),
  ];
}

// BUG-UG-DUES-NAV-SHOWN-WITHOUT-DUES-20261108: an organization that
// runs no dues (runsDues === false, the web rule in src/lib/duesNavigation.js)
// lists no Dues anywhere; unknown (null) keeps it.
export function withoutDuesGroups(groups: HatFunctionGroup[], runsDues: boolean | null | undefined): HatFunctionGroup[] {
  // Union Ground runs no dues, so there is never a Dues item to hide.
  void runsDues;
  return groups;
}

export function functionsForHat(hat: PreviewHatKey | null): HatFunction[] {
  return featureGroupsForHat(hat).flatMap((group) => group.items);
}

export function workItemsForHat(hat: PreviewHatKey | null): HatFunction[] {
  if (!hat || hat === 'member') return MEMBER_WORK_WIDGETS;
  return STAFF_HAT_FUNCTIONS[hat];
}

export function workItemsForRoles(
  chapterRoles: readonly Exclude<PreviewHatKey, 'member'>[],
  organizationRoles: readonly Exclude<PreviewHatKey, 'member'>[] = [],
): HatFunction[] {
  const { items } = staffItemsForScopes(chapterRoles, organizationRoles);
  if (!items.length) return MEMBER_WORK_WIDGETS;
  return uniqueFunctions([
    ...MEMBER_WORK_WIDGETS,
    ...items,
  ]);
}

// Live accounts never receive the SAMPLE hat switcher. A sole server-confirmed
// assignment is therefore the only unambiguous staff identity the client may
// project. Multiple eligible roles remain in the member identity until the
// person picks one (narrowLiveStaffRoles); route order and deep links must
// never guess which hat the person meant to wear.
export function explicitLiveStaffHat(
  roles: readonly string[],
): Exclude<PreviewHatKey, 'member'> | null {
  const authorized = STAFF_ROLE_ORDER.filter((role) => roles.includes(role));
  return authorized.length === 1 ? authorized[0]! : null;
}

export type LiveStaffRole = Exclude<PreviewHatKey, 'member'>;

export type LiveStaffScopeInput = {
  roles: LiveStaffRole[];
  chapterRoles: LiveStaffRole[];
  staffAuthorized?: boolean;
} | null;

// Live staff roles fail closed: only an authenticated session with
// staffAuthorized === true may project organization or chapter roles. Preview
// uses the explicit hat's roles and never a chapter assignment. Signed-out
// and every other mode stay empty even when a leftover scope object is present.
export function deriveLiveStaffRoles({
  mode,
  previewRoles,
  organizationStaffScope,
}: {
  mode: string;
  previewRoles: LiveStaffRole[];
  organizationStaffScope?: LiveStaffScopeInput;
}): {
  organizationRoles: LiveStaffRole[];
  chapterRoles: LiveStaffRole[];
  authorizedRoles: LiveStaffRole[];
} {
  const organizationRoles = mode === 'preview'
    ? previewRoles
    : mode === 'authenticated'
      ? organizationStaffScope?.staffAuthorized === true ? organizationStaffScope.roles : []
      : [];
  const chapterRoles = mode === 'preview'
    ? []
    : mode === 'authenticated'
      ? organizationStaffScope?.staffAuthorized === true ? organizationStaffScope.chapterRoles : []
      : [];
  const authorizedRoles: LiveStaffRole[] = mode === 'preview'
    ? previewRoles
    : mode === 'authenticated'
      ? organizationStaffScope?.staffAuthorized === true
        ? [...new Set([...organizationRoles, ...chapterRoles])]
        : []
      : [];
  return { organizationRoles, chapterRoles, authorizedRoles };
}

export type LiveStaffRoles = {
  organizationRoles: LiveStaffRole[];
  chapterRoles: LiveStaffRole[];
  authorizedRoles: LiveStaffRole[];
};

// Role names a person can confirm the role they switch to by (Batch C copy
// register 25, REQ-UG-LOVABLE-NATIVE-SCREENS-BATCH-C-PORT-20261103).
// Advisor, Admin and President are the names the role switchers, the website
// and the pay sentences use for the same keys (#9529, a review note): one
// name for one role. The picker also lists organization-wide roles, so a
// "Chapter" prefix would be wrong for them.
export const LIVE_STAFF_ROLE_LABELS: Record<LiveStaffRole, string> = {
  organizer: 'Organizer',
  steward: 'Committee',
  coordinator: 'Campaign lead',
  advisor: 'Advisor',
  admin: 'Admin',
  vp: 'Campaign chair',
};

// Batch C role desk card: the eyebrow names the role, the line says what the
// desk holds. No counts: the live desk supplies none here, and the card never
// invents them.
export function liveStaffDeskEyebrow(role: LiveStaffRole): string {
  return `${LIVE_STAFF_ROLE_LABELS[role].toUpperCase()} DESK`;
}

// The role whose desk live Home leads with: the role chosen for this session,
// else the one staff role the account holds. A PIN-restricted session, or an
// account with several roles and none chosen yet, gets no desk card.
export function staffDeskHomeRole(input: {
  mode: string;
  sessionRestricted: boolean;
  chosenStaffRole: LiveStaffRole | null;
  authorizedRoles: readonly string[];
}): LiveStaffRole | null {
  if (input.mode !== 'authenticated' || input.sessionRestricted) return null;
  return input.chosenStaffRole ?? explicitLiveStaffHat(input.authorizedRoles);
}

// Batch C role Work leads with the desk of the role in use; every other row
// keeps its order. No role, or a role whose desk is not listed, changes nothing.
export function workItemsWithRoleDeskFirst<T extends { key: string }>(items: readonly T[], role: LiveStaffRole | null): T[] {
  const desk = role ? items.find((item) => item.key === role) : undefined;
  return desk ? [desk, ...items.filter((item) => item !== desk)] : [...items];
}

export const LIVE_STAFF_DESK_LINES: Record<LiveStaffRole, string> = {
  organizer: 'Coworkers to reach next, the card drive and committee coverage.',
  steward: 'Your caseload, worker requests, one-on-ones and forms to review.',
  coordinator: 'The campaign issue load and its deadlines.',
  advisor: 'Turnout, workload and risk across the campaign.',
  // What Chapter admin shows (UX-UG-NATIVE-CHAPTER-ADMIN-SHOWS-RAW-CAPABILITY-KEYS-20261109).
  admin: 'See your campaign\'s connected services and their setup.',
  vp: 'Trend, items needing attention, roster and agenda.',
};

// The server-confirmed staff roles a person may choose between, in desk order.
// Fewer than two means there is nothing to choose.
export function selectableLiveStaffRoles(roles: LiveStaffRoles): LiveStaffRole[] {
  const choices = STAFF_ROLE_ORDER.filter((role) => roles.authorizedRoles.includes(role));
  return choices.length > 1 ? choices : [];
}

// A person holding more than one server-confirmed staff role picks which one
// the app works as, for this session only. The pick narrows what the client
// projects; it never adds a role, and every server check still runs on the
// real assignments. A pick that is not currently authorized is ignored, so a
// stale choice can never open a desk.
export function narrowLiveStaffRoles(roles: LiveStaffRoles, chosenRole: LiveStaffRole | null): LiveStaffRoles {
  if (!chosenRole || !selectableLiveStaffRoles(roles).includes(chosenRole)) return roles;
  return {
    organizationRoles: roles.organizationRoles.filter((role) => role === chosenRole),
    chapterRoles: roles.chapterRoles.filter((role) => role === chosenRole),
    authorizedRoles: [chosenRole],
  };
}

export type RightPaneKind = 'compass' | 'work';

export type WidgetLayout = {
  order: string[];
  hidden: string[];
};

export function rightPaneKindForHat(hat: PreviewHatKey | null): RightPaneKind {
  return !hat || hat === 'member' ? 'compass' : 'work';
}

export function applyWidgetLayout(catalog: HatFunction[], layout?: WidgetLayout | null): HatFunction[] {
  const hidden = new Set(layout?.hidden ?? []);
  const byKey = new Map(catalog.map((item) => [item.key, item]));
  const ordered: HatFunction[] = [];
  for (const key of layout?.order ?? catalog.map((item) => item.key)) {
    const item = byKey.get(key);
    if (item && !hidden.has(item.key)) ordered.push(item);
  }
  for (const item of catalog) {
    if (!hidden.has(item.key) && !ordered.some((visible) => visible.key === item.key)) {
      ordered.push(item);
    }
  }
  return ordered;
}

export function hiddenWidgetItems(catalog: HatFunction[], layout?: WidgetLayout | null): HatFunction[] {
  const hidden = new Set(layout?.hidden ?? []);
  return catalog.filter((item) => hidden.has(item.key));
}

export function moveWidgetKey(order: string[], key: string, direction: -1 | 1): string[] {
  const next = [...order];
  const index = next.indexOf(key);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.length) return order;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

export function moveVisibleWidgetKey(order: string[], hidden: string[], key: string, direction: -1 | 1): string[] {
  const hiddenSet = new Set(hidden);
  const visible = order.filter((item) => !hiddenSet.has(item));
  const index = visible.indexOf(key);
  const neighbor = visible[index + direction];
  if (index < 0 || !neighbor) return order;
  const from = order.indexOf(key);
  const to = order.indexOf(neighbor);
  if (from < 0 || to < 0) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

export type WidgetSource =
  | 'messages'
  | 'appointments'
  | 'cases'
  | 'forms'
  | 'workload'
  | 'numbers'
  | 'events'
  | 'campaigns'
  | 'tasks'
  | 'queue'
  | 'kpis'
  | 'ballots'
  | 'rewards'
  | 'access'
  | 'mfa'
  | 'audit'
  | 'leadership'
  | 'risks'
  | 'hub'
  | 'pay'
  | 'qa'
  | 'integrations'
  | 'operations'
  | 'analytics'
  | 'organization-map'
  | 'actions'
  | 'handshakes'
  | 'memberships'
  | 'health'
  | 'trend'
  | 'deadlines'
  | 'broadcasts'
  | 'recognition'
  | 'invitations';

// A widget source names the dataset its rows come from, so it has to be the
// widget's own noun. "By article cited" used to borrow forms and "Membership
// trend" borrowed ballots, and each widget listed another feature's records
// under its title. The workspace holds no collection of cited articles or of
// membership movement, so those two keys pin sources of their own and render
// no rows until such a dataset exists. "Upcoming deadlines" borrowed the
// chapter tasks and "Broadcasts" borrowed the campaign catalog, so each
// repeated a sibling widget's rows on its own desk: deadlines are the dated
// slice of the desk queue, and sent broadcasts are a collection the workspace
// does not enumerate.
const WIDGET_SOURCE_BY_KEY: Record<string, WidgetSource> = {
  messages: 'messages',
  appointments: 'appointments',
  cases: 'cases',
  forms: 'forms',
  workload: 'workload',
  numbers: 'numbers',
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
  // #9099 part 2: chapter notices are member_broadcasts rows too.
  'chapter-notices': 'broadcasts',
  // #9099 part 4: the chapter's invitations, listed on the full screen.
  'chapter-invitations': 'invitations',
  qa: 'qa',
  hub: 'hub',
  'events-desk': 'events',
  campaigns: 'campaigns',
  tasks: 'tasks',
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
  operations: 'operations',
  vp: 'kpis',
  'vp-trend': 'trend',
  'vp-attention': 'queue',
  'vp-leadership': 'leadership',
  'vp-priorities': 'campaigns',
  'vp-events': 'events',
  pay: 'pay',
  integrations: 'integrations',
  analytics: 'analytics',
  'organization-map': 'organization-map',
  actions: 'actions',
  partners: 'handshakes',
  'chapter-health': 'health',
  'chapter-memberships': 'memberships',
};

export function widgetSourceFor(key: string): WidgetSource {
  const pinned = WIDGET_SOURCE_BY_KEY[key];
  if (pinned) return pinned;
  if (key.includes('messages') || key.includes('requests')) return 'messages';
  if (key.includes('appointments')) return 'appointments';
  if (key.includes('caseload') || key.includes('cases')) return 'cases';
  if (key.includes('form')) return 'forms';
  if (key.includes('workload')) return 'workload';
  if (key.includes('events') || key.includes('checkins')) return 'events';
  if (key.includes('campaign') || key.includes('priorities') || key.includes('broadcasts')) return 'campaigns';
  if (key === 'tasks' || key.includes('chapter')) return 'tasks';
  if (key.includes('queue') || key.includes('attention') || key.includes('steward') || key.includes('coordinator')) return 'queue';
  return 'kpis';
}

export function toggleWidgetHidden(layout: WidgetLayout, catalog: HatFunction[], key: string): WidgetLayout {
  const hidden = new Set(layout.hidden);
  if (hidden.has(key)) hidden.delete(key);
  else hidden.add(key);
  const order = layout.order.length ? layout.order : catalog.map((item) => item.key);
  return { order, hidden: catalog.map((item) => item.key).filter((item) => hidden.has(item)) };
}

// BUG-UG-NATIVE-FEATURE-SEARCH-MISSES-EXISTING-FEATURES-20261111: All
// features search matched only the row label, so people searching for a
// feature by the name its own screen or its parent screen uses ("Civic" inside
// My union, "Org structure", "Compass" inside Know your rights, "Activity" for
// Notifications) were told nothing matched. These are the other names each row
// answers to. A term only finds a row the person can already see; it never adds
// a destination. The civic entry keeps its own two languages.
export const FEATURE_SEARCH_TERMS: Readonly<Record<string, readonly string[]>> = {
  'my-campaign': [
    'campaign', 'my campaign',
    'org structure', 'organization structure', 'employer', 'chapters', 'partners', 'handshakes',
  ],
  rights: ['compass'],
  notifications: ['activity', 'notice', 'notices', 'alerts'],
  settings: ['account', 'sign out', 'log out', 'preferences', 'biometric'],
  profile: ['account', 'my details'],
  tasks: ['task', 'tasks', 'to do', 'to-do'],
  voting: ['ballot', 'ballots', 'vote', 'survey', 'surveys', 'poll'],
  voice: ['feedback', 'committee member request'],
  messages: ['inbox', 'chat', 'conversation', 'conversations'],
  cases: ['grievance', 'grievances'],
  hub: ['meetings'],
};

// Case and accent folding, so "accion civica" finds "Acción cívica".
export function normalizeFeatureSearch(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function featureMatchesSearch(item: HatFunction, query: string): boolean {
  const needle = normalizeFeatureSearch(query);
  if (!needle) return true;
  return [item.label, ...(FEATURE_SEARCH_TERMS[item.key] ?? [])]
    .some((name) => normalizeFeatureSearch(name).includes(needle));
}
