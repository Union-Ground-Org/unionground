import { explicitLiveStaffHat } from './hatFunctions';

export const FEATURE_KEYS = [
  'voting',
  'rewards',
  'cases',
  'forms',
  'workload',
  'numbers',
  'appointments',
  'steward-appointments',
  'steward-caseload',
  'steward-requests',
  'steward-forms',
  'steward-broadcasts',
  'chapter-notices',
  'chapter-invitations',
  'rights',
  'member-support',
  'chapter',
  'voice',
  'events',
  'search',
  'organizer',
  'steward',
  'coordinator',
  'advisor',
  'admin',
  'vp',
  'events-desk',
  'campaigns',
  'tasks',
  'chapters',
  'chapter-health',
  'partners',
  'chapter-memberships',
  'pay',
  'integrations',
  'operations',
  'analytics',
  'organization-map',
  'actions',
  'qa',
  // The worker-facing read-only workplace structure: who decides what at the
  // employer, and who is on the committee. A feature screen reachable from the
  // Campaign tab, so the five-tab dock is unchanged.
  'org-structure',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_TITLES: Record<FeatureKey, string> = {
  voting: 'Votes',
  rewards: 'Contributions',
  cases: 'My issues',
  forms: 'Forms',
  workload: 'Workplace log',
  numbers: 'My reports',
  appointments: 'One-on-ones',
  'steward-appointments': 'One-on-one desk',
  'steward-caseload': 'Your issues',
  'steward-requests': 'Worker requests',
  'steward-forms': 'Forms review',
  'steward-broadcasts': 'Broadcasts',
  'chapter-notices': 'Campaign notices',
  'chapter-invitations': 'Invitations',
  rights: 'Organizing rights',
  'member-support': 'Worker support',
  chapter: 'My campaign',
  voice: 'Be heard',
  events: 'Meetings',
  search: 'Search',
  organizer: 'Organizing desk',
  steward: 'Committee desk',
  coordinator: 'Issue queue',
  advisor: 'Campaign health',
  admin: 'Workspace admin',
  vp: 'Campaign overview',
  'events-desk': 'Meetings desk',
  campaigns: 'Issue campaigns',
  tasks: 'Campaign work',
  chapters: 'Campaigns',
  'chapter-health': 'Health portfolio',
  partners: 'Campaign agreements',
  'chapter-memberships': 'Campaign memberships',
  pay: 'Pay tools',
  integrations: 'Connected services',
  operations: 'Operations health',
  analytics: 'Organization analytics',
  'organization-map': 'Power map',
  actions: 'Collective actions',
  qa: 'Worker questions',
  'org-structure': 'Workplace structure',
}

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

export const STAFF_DESK_FEATURE_KEYS = ['organizer', 'steward', 'coordinator', 'advisor', 'admin', 'vp'] as const;
export type StaffDeskFeatureKey = (typeof STAFF_DESK_FEATURE_KEYS)[number];

export function isStaffDeskFeatureKey(value: string): value is StaffDeskFeatureKey {
  return (STAFF_DESK_FEATURE_KEYS as readonly string[]).includes(value);
}

// Organizing tools open on any organizing hat (web parity: the Worker hat never
// mounts the Campaign work, Meetings desk, or Issue campaigns authoring tools),
// unlike desks which need the exact hat. Workers read meetings on
// /feature/events and vote on /feature/voting.
const STAFF_TOOL_FEATURE_KEYS = ['tasks', 'events-desk', 'campaigns', 'analytics', 'organization-map', 'partners'] as const;
const ORGANIZATION_STAFF_TOOL_FEATURE_KEYS = new Set<FeatureKey>(['analytics', 'organization-map']);
const LEADERSHIP_FEATURE_KEYS: readonly FeatureKey[] = ['chapter-health'];
// #9099 parts 2 and 4: Chapter Administrator or President with that chapter
// (or the organization): chapter notices (the website's notice-desk hats apart
// from the steward) and invitations (the website's invitation desk).
const CHAPTER_ADMIN_OR_PRESIDENT_FEATURE_KEYS: readonly FeatureKey[] = ['chapter-notices', 'chapter-invitations'];
// Campaign-membership administration follows its RPCs exactly: an
// organization administrator acts anywhere in the organization, a campaign
// administrator inside their own campaign. No other hat, and no scope-free
// admin grant, opens it.
const CHAPTER_ADMIN_FEATURE_KEYS = ['chapter-memberships'] as const;
const CHAPTER_ADMIN_FEATURE_KEY_SET: ReadonlySet<string> = new Set(CHAPTER_ADMIN_FEATURE_KEYS);

export function isChapterAdminFeatureKey(value: string): boolean {
  return CHAPTER_ADMIN_FEATURE_KEY_SET.has(value);
}
const INTEGRATION_FEATURE_KEYS = ['integrations'] as const;
const OPERATIONS_FEATURE_KEYS = ['operations'] as const;

// The committee's one-on-one desk is an organizing surface on its own key: it
// needs the exact Committee hat (campaign scope when authenticated), so it
// belongs to none of the lists above. The coverage census subtracts it from
// the worker group.
// The four Work-desk rows that each open their own steward screen. They are
// steward-only, like the appointment desk, and never a member surface.
export type StewardDeskSectionKey = 'steward-caseload' | 'steward-requests' | 'steward-forms' | 'steward-broadcasts';
const STEWARD_DESK_SECTION_KEY_SET: ReadonlySet<string> = new Set<StewardDeskSectionKey>([
  'steward-caseload',
  'steward-requests',
  'steward-forms',
  'steward-broadcasts',
]);

export function isStewardDeskSectionKey(value: string): boolean {
  return STEWARD_DESK_SECTION_KEY_SET.has(value);
}

export const STEWARD_DESK_TOOL_FEATURE_KEYS: readonly FeatureKey[] = [
  'steward-appointments',
  'steward-caseload',
  'steward-requests',
  'steward-forms',
  'steward-broadcasts',
];

export function isStaffOnlyFeatureKey(value: string): boolean {
  return isStaffDeskFeatureKey(value)
    || (STAFF_TOOL_FEATURE_KEYS as readonly string[]).includes(value)
    || (LEADERSHIP_FEATURE_KEYS as readonly string[]).includes(value)
    || isChapterAdminFeatureKey(value)
    || (INTEGRATION_FEATURE_KEYS as readonly string[]).includes(value)
    || (OPERATIONS_FEATURE_KEYS as readonly string[]).includes(value)
    // The one-on-one desk is Committee-only on its own key, so notification
    // routing must refuse it the same way it refuses the other desks rather
    // than emitting a worker-reachable feature route.
    || (STEWARD_DESK_TOOL_FEATURE_KEYS as readonly string[]).includes(value)
    || (CHAPTER_ADMIN_OR_PRESIDENT_FEATURE_KEYS as readonly string[]).includes(value);
}

export function canOpenFeature(
  mode: string,
  featureKey: FeatureKey,
  hat: string | null,
  chapterRoles: readonly string[] = [],
  organizationRoles: readonly string[] = [],
): boolean {
  if (mode === 'preview') {
    if (isStaffDeskFeatureKey(featureKey)) return hat === featureKey;
    if ((LEADERSHIP_FEATURE_KEYS as readonly string[]).includes(featureKey)) return hat === 'advisor' || hat === 'admin' || hat === 'vp';
    if (isChapterAdminFeatureKey(featureKey)) return hat === 'admin';
    if ((INTEGRATION_FEATURE_KEYS as readonly string[]).includes(featureKey)) return hat === 'admin' || hat === 'vp';
    if ((OPERATIONS_FEATURE_KEYS as readonly string[]).includes(featureKey)) return hat === 'admin';
    if ((STAFF_TOOL_FEATURE_KEYS as readonly string[]).includes(featureKey)) return hat !== null && hat !== 'member';
    // The one-on-one desk owns its own screen; only the Committee hat opens
    // it, in preview and live alike.
    if (STEWARD_DESK_TOOL_FEATURE_KEYS.includes(featureKey)) return hat === 'steward';
    // Campaign notices and Invitations sit on the Admin and Campaign chair
    // lists only, so a deep link opens them for those preview hats alone.
    if (CHAPTER_ADMIN_OR_PRESIDENT_FEATURE_KEYS.includes(featureKey)) return hat === 'admin' || hat === 'vp';
    return true;
  }
  if (mode !== 'authenticated') return false;
  const activeRole = explicitLiveStaffHat([...new Set([...chapterRoles, ...organizationRoles])]);
  const hasChapterScope = activeRole !== null && chapterRoles.includes(activeRole);
  const hasOrganizationScope = activeRole !== null && organizationRoles.includes(activeRole);
  if (isStaffDeskFeatureKey(featureKey)) {
    if (activeRole !== featureKey) return false;
    // Advisor, Campaign chair, and Admin desks read organization-wide records,
    // and the Admin desk is where a campaign's requested connections are
    // verified — a decision `verify_chapter_connection_setup` grants to an
    // organization administrator alone. Requiring a duplicate campaign
    // assignment there would lock the only authorized reviewer out of their
    // own decision. The coordinator's Case queue reads the chapter's cases and
    // step deadlines, which the server shows an organization-wide coordinator
    // too (#9098). The Steward desk still needs its chapter.
    if (featureKey === 'advisor' || featureKey === 'vp' || featureKey === 'admin' || featureKey === 'coordinator') {
      return hasChapterScope || hasOrganizationScope;
    }
    return hasChapterScope;
  }
  // The one-on-one desk is a desk in everything but name: it loads the
  // committee member's own one-on-ones, outcomes, availability, and calendar
  // connections, so it needs the Committee hat with campaign scope. Anything
  // else gets the standard refusal instead of a desk that would 404 its RPCs.
  if (STEWARD_DESK_TOOL_FEATURE_KEYS.includes(featureKey)) return activeRole === 'steward' && hasChapterScope;
  // #9099 part 2: Chapter Administrator and President write chapter notices
  // (the website's notice desk hats, apart from the steward, whose composer
  // is on the Steward desk's Broadcasts). The audience RPC and the publish
  // RPCs check the role and the chapter again.
  if (CHAPTER_ADMIN_OR_PRESIDENT_FEATURE_KEYS.includes(featureKey)) return (activeRole === 'admin' || activeRole === 'vp') && (hasChapterScope || hasOrganizationScope);
  if ((LEADERSHIP_FEATURE_KEYS as readonly string[]).includes(featureKey)) {
    return activeRole === 'advisor' || activeRole === 'admin' || activeRole === 'vp';
  }
  if (isChapterAdminFeatureKey(featureKey)) {
    return activeRole === 'admin' && (hasChapterScope || hasOrganizationScope);
  }
  if ((INTEGRATION_FEATURE_KEYS as readonly string[]).includes(featureKey)) {
    return hasOrganizationScope && (activeRole === 'admin' || activeRole === 'vp');
  }
  if ((OPERATIONS_FEATURE_KEYS as readonly string[]).includes(featureKey)) return hasOrganizationScope && activeRole === 'admin';
  if (ORGANIZATION_STAFF_TOOL_FEATURE_KEYS.has(featureKey)) return hasOrganizationScope;
  // Campaign agreements carries the organization binding decision, which is
  // the organization administrator's alone. Every other organizing hat still
  // reaches this tool through its own campaign.
  if (featureKey === 'partners') return hasChapterScope || (hasOrganizationScope && activeRole === 'admin');
  if ((STAFF_TOOL_FEATURE_KEYS as readonly string[]).includes(featureKey)) return hasChapterScope;
  return true;
}

export function featurePath(key: FeatureKey): string {
  return `/feature/${key}`;
}

// Keys stay on the shared form_templates registry; titles match the web's
// organizing labels (forms.tpl.* in src/lib/i18n.js). Record facts, not
// legal conclusions: no template asks a worker to cite a contract.
export type FormTemplate = { key: string; title: string; blurb: string };

export const FORM_TEMPLATES: readonly FormTemplate[] = [
  { key: 'grievance', title: 'Workplace issue report', blurb: 'Write down what happened, when, and who saw it, so the committee can follow up.' },
  { key: 'fmla_self', title: 'FMLA · my own health', blurb: 'Request job-protected leave for your own serious health condition.' },
  { key: 'fmla_family', title: 'FMLA · family care', blurb: 'Request leave to care for a family member.' },
  { key: 'alliance_grievance', title: 'Group workplace issue', blurb: 'Raise an issue that affects a group of coworkers.' },
  { key: 'non_selection', title: 'Non-selection appeal', blurb: 'Record being passed over for a posting.' },
  { key: 'alt_work', title: 'Alternative work arrangement', blurb: 'Request a schedule change or other arrangement.' },
  { key: 'service_request', title: 'Committee help request', blurb: 'Ask the committee for help with a question or a next step.' },
];

// Union Ground has no points economy: the database retired point minting
// (supabase/migrations/20261014003000_unionground_safe_recognition.sql) and
// the web's Contributions view (src/views/RewardsView.jsx) shows no points,
// tiers, perk claims or ledger. Contributions are acknowledged, never scored or
// spent. The rungs, rule kinds and boundary copy below match that view and the
// recognition migration, so the preview and a live session say the same thing.
export type RecognitionRung = 'learn' | 'attend' | 'volunteer' | 'organize' | 'lead';
// BUG-UG-SERVICE-REQUEST-DUES-CATEGORY-WITHOUT-DUES-20261108: an
// organization that runs no dues (runsDues === false, the web rule in
// src/lib/duesNavigation.js) never sees dues in a form description; unknown
// keeps the description. As on the web (formTemplatesForDues in
// src/lib/formTemplates.js), only the default description is replaced; one the
// organization wrote itself is kept. The live Forms screen passes the member's
// language (REQ-UG-NATIVE-FMLA-FORMS-SHOW-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261113, #8694).
const DEFAULT_SERVICE_REQUEST_BLURBS: ReadonlySet<string> = new Set([
  'Ask the campaign for help with dues, benefits, or training.',
  'Pide ayuda a la campaña con cuotas, beneficios o capacitación.',
]);

export function formTemplateBlurb(template: { key: string; blurb: string }, runsDues: boolean | null | undefined, language: 'en' | 'es' = 'en'): string {
  if (template.key !== 'service_request' || runsDues !== false || !DEFAULT_SERVICE_REQUEST_BLURBS.has(template.blurb)) return template.blurb;
  return language === 'es'
    ? 'Pide ayuda a la campaña con beneficios, capacitación o cualquier otra cosa.'
    : 'Ask the campaign for help with benefits, training, or anything else.';
}

export const RECOGNITION_RUNGS: readonly { key: RecognitionRung; label: string }[] = [
  { key: 'learn', label: 'Learn' },
  { key: 'attend', label: 'Attend' },
  { key: 'volunteer', label: 'Volunteer' },
  { key: 'organize', label: 'Organize' },
  { key: 'lead', label: 'Lead' },
];

export function recognitionRung(value: unknown): RecognitionRung {
  return RECOGNITION_RUNGS.find((rung) => rung.key === value)?.key ?? 'learn';
}

export type RecognitionRule = { recognitionKind: string; label: string; description: string };

// The preview's copy of member_recognition_rules, in organizing words.
export const PREVIEW_RECOGNITION_RULES: readonly RecognitionRule[] = [
  { recognitionKind: 'training_complete', label: 'Completed training', description: 'A facilitator verified completion of a campaign-approved training.' },
  { recognitionKind: 'orientation_complete', label: 'Completed orientation', description: 'A facilitator verified completion of worker or volunteer orientation.' },
  { recognitionKind: 'peer_outreach_complete', label: 'Completed peer outreach', description: 'An assigned, consensual outreach commitment was completed and verified.' },
  { recognitionKind: 'committee_commitment_complete', label: 'Completed committee commitment', description: 'A voluntary committee commitment was completed and verified.' },
  { recognitionKind: 'commitment_complete', label: 'Completed voluntary commitment', description: 'A specific, voluntary campaign commitment was completed and verified.' },
];

export const CONTRIBUTIONS_COPY = {
  title: 'Contributions',
  eyebrow: 'Verified, voluntary work',
  boundaryTitle: 'How recognition works',
  boundarySub: 'Recognition records contribution. It does not rank workers.',
  noEffect: 'Recognition has no effect on representation, issues, voting, services, benefits, access, standing, discipline, assigned roles, or leadership eligibility.',
  currentPath: 'Current path',
  catalogTitle: 'Eligible recognition',
  catalogSub: 'Only completed, consensual, capacity-building commitments verified by another person.',
  verified: 'verified',
  recentTitle: 'Last 90 days',
  recentSub: 'No quota. No streak penalty.',
  emptyRules: 'Recognition details could not load — try again shortly.',
  emptyAcknowledgements: 'No private acknowledgements recorded yet.',
  notRecognizedTitle: 'Never recognized or scored',
  notRecognizedSub: 'Help-seeking, protected activity, and democratic choices stay outside recognition.',
  notRecognizedList: 'Issues; retaliation reports; evidence uploads; committee requests; private messages; workplace logs; votes or surveys; RSVPs or attendance; support position; cards or signatures; outcomes or remedies.',
};

export type PreviewCampaign = { id: string; title: string; status: string; summary: string };

export const CAMPAIGNS: readonly PreviewCampaign[] = [
  { id: 'staffing', title: 'Overnight staffing', status: 'Active', summary: 'Write down short-staffed shifts and gather coworker signatures before the September delegation.' },
  { id: 'notice', title: 'Schedule notice', status: 'Worker action', summary: 'Save every late schedule change. The committee is building the record together.' },
  { id: 'budget', title: 'Campaign priorities vote', status: 'Up for a vote', summary: 'Vote on the Harborview Care United priorities before Tuesday 7:59 PM.' },
];
