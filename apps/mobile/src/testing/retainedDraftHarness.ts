import { retireRefusedResumeDraftScope, syncResumeDraftContext, type ResumeDraftReads } from '../lib/resumeDraftHolder';

// #9240 PR A: the one signed-in fixture for every useRetainedDraft adopter
// test, and the session-check transitions the provider really makes
// (AppProvider: cover, clear protected state, fresh reads, return). Tests mock
// ../state/AppProvider with appProviderStandIn so the holder is synced before
// each render, as the provider does.

export type StaffKind = 'chapter' | 'chapterless';
export type AppFixture = {
  mode: string;
  session: { access_token: string; user: { id: string } } | null;
  organizationID: string | null;
  dashboard: { member: { id: string; chapterID: string | null; language: 'en' | 'es' }; cases: never[]; conversations: never[] } | null;
  chapterMemberships: { chapterID: string; organizationID: string | null; selected: boolean }[];
  authorizedRoles: string[];
  chapterRoles: string[];
  organizationRoles: string[];
  chosenStaffRole: string | null;
  memberLanguage: 'en' | 'es' | null;
  locked: boolean;
  privacyCovered: boolean;
  assuranceUnavailable: boolean;
  refreshing: boolean;
  resumeDraftReads: ResumeDraftReads;
  duesContext: null;
  captureAccountSessionGuard: (userID: string | null) => () => boolean;
  captureAuthenticatedSessionGuard: () => () => boolean;
};

const PERSON = 'officer-a';
let staff: StaffKind = 'chapter';
let person = PERSON;
// A chapter officer who is also an organization administrator.
let organizationAdmin = false;
// One session object per person until the next sign-in, as the provider
// keeps it through a refresh and a session check (#9240 pull request B: the
// learning manager keys its controllers on the session object).
const sessions = new Map<string, { access_token: string; user: { id: string } }>();
function sessionOf(id: string): { access_token: string; user: { id: string } } {
  const known = sessions.get(id);
  if (known) return known;
  const made = { access_token: `token-${id}`, user: { id } };
  sessions.set(id, made);
  return made;
}
let app: AppFixture = signedIn();

function signedIn(): AppFixture {
  const chapter = staff === 'chapter';
  return {
    mode: 'authenticated',
    session: sessionOf(person),
    organizationID: 'org-a',
    dashboard: { member: { id: person, chapterID: chapter ? 'chapter-a' : null, language: 'en' }, cases: [], conversations: [] },
    chapterMemberships: chapter ? [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }] : [],
    authorizedRoles: ['admin'],
    chapterRoles: chapter ? ['admin'] : [],
    organizationRoles: chapter && !organizationAdmin ? [] : ['admin'],
    chosenStaffRole: 'admin',
    memberLanguage: null,
    locked: false,
    privacyCovered: false,
    assuranceUnavailable: false,
    refreshing: false,
    resumeDraftReads: { dashboard: true, memberships: true, staff: true },
    duesContext: null,
    // The account guard the provider hands out: current while this login is.
    captureAccountSessionGuard: (userID) => () => userID !== null && app.session?.user.id === userID && app.mode === 'authenticated',
    // The same guard for the person signed in when it is captured (#9240 PR B).
    captureAuthenticatedSessionGuard: () => {
      const userID = app.session?.user.id ?? null;
      return () => userID !== null && app.session?.user.id === userID && app.mode === 'authenticated';
    },
  };
}

export const harnessApp = (): AppFixture => app;
export const appProviderStandIn = { useApp: () => { syncResumeDraftContext(app); return app; } };

// Before each test: no person, then the chosen staff signed in.
export function signIn(kind: StaffKind = staff, options: { organizationAdmin?: boolean } = {}): void {
  staff = kind; person = PERSON; organizationAdmin = options.organizationAdmin === true;
  sessions.clear();
  syncResumeDraftContext({ mode: 'signedOut', session: null, organizationID: null });
  app = signedIn();
}
// The session check: covered, protected state cleared, reads outstanding.
export function boot(): void {
  app = { ...app, mode: 'booting', privacyCovered: true, dashboard: null, chapterMemberships: [], authorizedRoles: [], chapterRoles: [], organizationRoles: [],
    chosenStaffRole: null, resumeDraftReads: { dashboard: false, memberships: false, staff: false } };
}
// The same person, scope and roles come back.
export function restore(): void { app = signedIn(); }
export function otherAccount(): void { person = 'officer-b'; app = signedIn(); }
// The officer's chapter is gone (another one selected); a chapterless officer
// gains one, which is a confirmed chapter change too.
export function leaveChapter(): void {
  app = { ...signedIn(), chapterMemberships: [{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true }] };
  if (app.dashboard) app.dashboard = { ...app.dashboard, member: { ...app.dashboard.member, chapterID: 'chapter-b' } };
}
export function leaveOrganization(): void {
  app = { ...signedIn(), organizationID: 'org-b', chapterMemberships: staff === 'chapter' ? [{ chapterID: 'chapter-c', organizationID: 'org-b', selected: true }] : [] };
}
// The provider's answer to an authoritative refusal of its own access reads.
export function refuseRead(): void {
  retireRefusedResumeDraftScope(person, { code: '42501' });
}
export function signOut(): void {
  app = { ...signedIn(), mode: 'signedOut', session: null, dashboard: null, organizationID: null, chapterMemberships: [] };
}
// A refresh or rail read in progress (or failed): the provider clears its read
// facts and keeps the dashboard it had (AppProvider fetchDashboard).
export function unconfirmReads(): void { app = { ...signedIn(), resumeDraftReads: { dashboard: false, memberships: false, staff: false } }; }
export function mfa(): void { app = { ...signedIn(), mode: 'mfaRequired', assuranceUnavailable: false }; }

// #9240 PR E: for a screen test that keeps its own app fixture (the case
// screen's), sync that fixture into the holder before each render as the
// provider does, and clear what an earlier test left held.
// Some fixtures are typed loosely (a record); the provider's fields are there.
type HolderContext = Parameters<typeof syncResumeDraftContext>[0];
export function syncedApp<T extends object>(fixture: T): T {
  syncResumeDraftContext(fixture as HolderContext);
  return fixture;
}
export function clearHeldDrafts(): void {
  syncResumeDraftContext({ mode: 'signedOut', session: null, organizationID: null });
}
