// Pure chapter-administration shaping for the native admin desk: the
// organization structure an administrator may act inside, the member
// directory they name a person from, and the two verification requests the
// portal boundary carries to the service-role RPCs. The service layer owns
// transport; every decision that can be stated without a network call lives
// here so it can be proven without one.

import { WriterSessionChanged } from '../../../../src/lib/sessionBoundWriter.js';
import { businessRpcProvenance } from '../services/businessWriters';

export const MOBILE_CHAPTER_ROLES = ['steward', 'coordinator', 'advisor', 'admin', 'vp'] as const;
export type MobileChapterRole = (typeof MOBILE_CHAPTER_ROLES)[number];

export const MOBILE_CONNECTION_OUTCOMES = ['active', 'error', 'disabled'] as const;
export type MobileConnectionOutcome = (typeof MOBILE_CONNECTION_OUTCOMES)[number];

// Notion sync ships planned and inactive, and enterprise SSO/SCIM are
// organization-wide activations an organization admin sets up on the website
// never a chapter connection; so the request
// control is withheld for both. A verification control left standing would let an
// operator record `active` for a system that does not exist, which is the
// same false operational claim in the other direction.
export type MobilePlannedCapability = 'notion' | 'enterprise';
export const MOBILE_PLANNED_CAPABILITIES: readonly MobilePlannedCapability[] = ['notion', 'enterprise'];

export function isPlannedChapterCapability(capability: string): boolean {
  return MOBILE_PLANNED_CAPABILITIES.some((planned) => planned === capability);
}

// Single sign-on and directory sync (SCIM) are on the release calendar, so the
// Enterprise controls card names each only once its read says it is released:
// single sign-on from the sign-in options read (services/ssoRelease.ts;,
// REQ-UG-NATIVE-CHAPTER-ADMIN-NAMES-SINGLE-SIGN-ON-AFTER-RELEASE-20261113),
// directory sync from its control read (services/scimRelease.ts;). Held,
// unread or failed, a feature is not named; with both held the card names
// neither.
export function enterpriseControlsCopy(ssoReleased: boolean, scimReleased: boolean): string {
  if (ssoReleased && scimReleased) return 'SSO and SCIM are organization-wide activations an organization admin sets up on the website. They never replace provisioned email-and-password access, and nothing is verified per campaign here.';
  if (ssoReleased) return 'SSO is an organization-wide activation an organization admin sets up on the website. It never replaces provisioned email-and-password access, and nothing is verified per campaign here.';
  if (scimReleased) return 'SCIM is an organization-wide activation an organization admin sets up on the website. It never replaces provisioned email-and-password access, and nothing is verified per campaign here.';
  return 'Organization-wide controls are set up by an organization admin on the website. They never replace provisioned email-and-password access, and nothing is verified per campaign here.';
}

// A connection is verifiable only once the chapter has actually asked for it
// and the capability is one the product ships.
export function chapterConnectionIsVerifiable(capability: string, status: string): boolean {
  if (isPlannedChapterCapability(capability)) return false;
  return ['configuring', 'active', 'error', 'disabled'].includes(status);
}

// An operator must not certify a connection they cannot identify. The card
// states the chapter-owned provider the request named, and says so plainly
// when the request carried none.
export function chapterConnectionProviderLine(providerLabel: string): string {
  const label = providerLabel.trim();
  return label
    ? `Campaign-owned provider: ${label}`
    : 'No provider identity was recorded with this request. Confirm it with the campaign before marking the connection active.';
}

export type MobileAdminChapter = {
  id: string;
  name: string;
};

export type MobileChapterUnit = { id: string; name: string };

export function normalizeChapterUnits(value: unknown, chapterID: string): MobileChapterUnit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    return row.chapterId === chapterID && typeof row.id === 'string' && row.id.length > 0
      && typeof row.name === 'string' && row.name.trim().length > 0
      ? [{ id: row.id, name: row.name }] : [];
  });
}

export type MobileAdminScope = {
  scope: 'organization' | 'chapter';
  chapterID: string | null;
  chapters: MobileAdminChapter[];
};

export type MobileDirectoryMember = {
  userID: string;
  fullName: string;
  chapterID: string;
  chapterName: string;
  roles: MobileChapterRole[];
};

export type MobileBindingVerification = {
  action: 'verify-binding';
  chapterId: string;
  unionOrgId: string;
  verified: boolean;
  publicNote: string;
};

export type MobileConnectionVerification = {
  action: 'verify-connection';
  chapterId: string;
  capability: string;
  status: MobileConnectionOutcome;
  publicMessage: string;
};

// The server bounds both operator notes at 500 characters and answers 400 for
// anything longer. The screen must not offer a request the boundary refuses.
export const VERIFICATION_NOTE_LIMIT = 500;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function chapterRoles(value: unknown): MobileChapterRole[] {
  return (Array.isArray(value) ? value as unknown[] : []).flatMap((entry) => (
    typeof entry === 'string' && (MOBILE_CHAPTER_ROLES as readonly string[]).includes(entry)
      ? [entry as MobileChapterRole]
      : []
  ));
}

// `get_admin_org_structure` answers with the caller's own scope. A payload
// that does not name a scope and a chapter list is not an authorization
// answer, so it is reported as "no admin scope" rather than guessed at.
export function normalizeAdminScope(payload: unknown): MobileAdminScope | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  const scope = text(row.scope);
  if (scope !== 'organization' && scope !== 'chapter') return null;
  if (!Array.isArray(row.chapters)) return null;
  const chapters = (row.chapters as unknown[]).flatMap((entry) => {
    const chapter = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (!text(chapter.id)) return [];
    return [{ id: text(chapter.id), name: text(chapter.name) || text(chapter.id) }];
  });
  return { scope, chapterID: text(row.chapterId) || null, chapters };
}

// `get_admin_member_directory` answers with a `nextCursor` ({ name, id }) when
// more members match than the page carries, and accepts it back as
// (p_after_name, p_after_id) for the next page. The screen follows it rather
// than asking for a narrower name: twenty-six people with one full name
// cannot be narrowed into the next page.
export type MobileDirectoryCursor = { name: string; id: string };

export const DIRECTORY_PAGE_LIMIT = 25;
// Ten pages is two hundred and fifty matches; past that the operator is asked
// to narrow the search rather than paging through the whole organization.
export const DIRECTORY_MAX_PAGES = 10;

export function normalizeDirectoryCursor(payload: unknown): MobileDirectoryCursor | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const cursor = (payload as Record<string, unknown>).nextCursor;
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
  const row = cursor as Record<string, unknown>;
  if (!text(row.name) || !text(row.id)) return null;
  return { name: text(row.name), id: text(row.id) };
}

export function directoryPageWasTruncated(payload: unknown): boolean {
  return normalizeDirectoryCursor(payload) !== null;
}

// Pages are appended in the order the cursor walked them; a person the next
// page repeats (the backend orders by name then id, so it should not) keeps
// their first position rather than moving under a selection.
export function mergeDirectoryPages(
  existing: readonly MobileDirectoryMember[],
  next: readonly MobileDirectoryMember[],
): MobileDirectoryMember[] {
  const seen = new Set(existing.map((member) => member.userID));
  return [...existing, ...next.filter((member) => !seen.has(member.userID) && seen.add(member.userID))];
}

// A mutation adapter names its failure so the screen can tell a refusal the
// database answered from a transport failure whose outcome is unknown.
export type MembershipFailureKind = 'refused' | 'unconfirmed';

// Only the WriterSessionChanged object the session writer itself
// throws before sending (src/lib/sessionBoundWriter.js) proves nothing was
// sent, never an answer that merely carries its 'writer_session_changed'
// marker (as NativeUnitSettings' workload entry decides).
export function classifyMembershipFailure(error: unknown): MembershipFailureKind {
  if (error instanceof WriterSessionChanged && businessRpcProvenance(error) === null) return 'refused';
  const message = error instanceof Error ? error.message : '';
  return message.endsWith('-refused') ? 'refused' : 'unconfirmed';
}

// A PostgREST/PostgreSQL error carries a code (a five-character SQLSTATE or a
// PGRST code): the database answered, so the change was refused. An error with
// no code is the transport's: the request may or may not have reached the
// database, so the outcome is unconfirmed.
export function membershipRpcFailure(error: { code?: unknown } | null | undefined, refusedName: string): Error {
  const code = error && typeof error.code === 'string' ? error.code.trim() : '';
  return new Error(code ? refusedName : 'membership-outcome-unconfirmed');
}

// Every outcome the memberships screen announces, with the person it was for.
// A pure description so the delivered behaviour can be proven without a
// render harness: which outcome, whose name, which tone.
export type MembershipOutcomeKind =
  | 'granted' | 'revoked' | 'role-granted' | 'role-revoked'
  | 'refused-membership' | 'refused-role' | 'unconfirmed-membership' | 'unconfirmed-role'
  | 'stale' | 'refresh-failed' | 'search-error' | 'directory-limit';

export type MembershipOutcomeCopy = {
  membershipGranted(name: string): string;
  membershipRevoked(name: string): string;
  roleGranted(name: string): string;
  roleRevoked(name: string): string;
  membershipError: string;
  roleError: string;
  membershipUnconfirmed(name: string): string;
  roleUnconfirmed(name: string): string;
  staleDirectory: string;
  refreshFailed: string;
  searchError: string;
  directoryLimit: string;
};

export function describeMembershipOutcome(
  kind: MembershipOutcomeKind,
  copy: MembershipOutcomeCopy,
  name: string,
): { tone: 'notice' | 'error'; text: string } {
  switch (kind) {
    case 'granted': return { tone: 'notice', text: copy.membershipGranted(name) };
    case 'revoked': return { tone: 'notice', text: copy.membershipRevoked(name) };
    case 'role-granted': return { tone: 'notice', text: copy.roleGranted(name) };
    case 'role-revoked': return { tone: 'notice', text: copy.roleRevoked(name) };
    case 'refused-membership': return { tone: 'error', text: copy.membershipError };
    case 'refused-role': return { tone: 'error', text: copy.roleError };
    case 'unconfirmed-membership': return { tone: 'error', text: copy.membershipUnconfirmed(name) };
    case 'unconfirmed-role': return { tone: 'error', text: copy.roleUnconfirmed(name) };
    case 'stale': return { tone: 'error', text: copy.staleDirectory };
    case 'refresh-failed': return { tone: 'error', text: copy.refreshFailed };
    case 'search-error': return { tone: 'error', text: copy.searchError };
    case 'directory-limit': return { tone: 'notice', text: copy.directoryLimit };
  }
}

// A page of results belongs to the query that was submitted for it. A read
// that finishes after another read started, or after the submitted query
// changed, must not install its rows or cursor over the newer result set.
export function directoryReadIsCurrent(input: { startedSequence: number; currentSequence: number }): boolean {
  return input.startedSequence === input.currentSequence;
}

// Load more may only continue the result set it belongs to: the submitted
// query with the cursor that query produced. A draft the operator is typing
// is not a submitted query.
export function loadMoreIsContinuation(input: { draft: string; submitted: string | null; cursor: MobileDirectoryCursor | null }): boolean {
  return input.submitted !== null && input.cursor !== null && input.draft.trim() === input.submitted;
}

// An outcome is announced only for the target it was started for, on a screen
// that is still mounted. The chips freeze while a request runs, but the guard
// is what makes that a property rather than a hope.
export function completionStillCurrent(input: {
  startedFor: { userID: string; chapterID: string };
  current: { userID: string; chapterID: string };
  mounted: boolean;
}): boolean {
  return input.mounted
    && input.startedFor.userID === input.current.userID
    && input.startedFor.chapterID === input.current.chapterID;
}

export function normalizeDirectoryMembers(payload: unknown): MobileDirectoryMember[] {
  const items = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).items
    : null;
  return (Array.isArray(items) ? items as unknown[] : []).flatMap((entry) => {
    const row = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (!text(row.userId) || !text(row.fullName)) return [];
    return [{
      userID: text(row.userId),
      fullName: text(row.fullName),
      chapterID: text(row.chapterId),
      chapterName: text(row.chapterName),
      roles: chapterRoles(row.roles),
    }];
  });
}

// The membership RPCs authorize an organization administrator anywhere in the
// organization and a chapter administrator inside their own chapter. The
// screen offers exactly that and nothing wider.
export function canAdministerChapterMemberships(
  chapterRoleList: readonly string[],
  organizationRoleList: readonly string[],
): boolean {
  return organizationRoleList.includes('admin') || chapterRoleList.includes('admin');
}

// The connection verification RPC is granted to the service role alone and the
// portal boundary admits only a caller whose `get_admin_org_structure` scope is
// organization-wide. A chapter administrator requests; they never verify. A
// union office binding is decided by a platform operator only, so the app
// offers no binding decision at all.
export function canVerifyChapterLifecycle(organizationRoleList: readonly string[]): boolean {
  return organizationRoleList.includes('admin');
}

// The body the portal accepts from a platform operator. The app itself no
// longer offers the decision (SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101).
export function bindingVerificationRequest(fields: {
  chapterID: string;
  unionOrgID: string;
  verified: boolean;
  publicNote?: string;
}): MobileBindingVerification | null {
  const publicNote = (fields.publicNote ?? '').trim();
  if (!fields.chapterID || !fields.unionOrgID || publicNote.length > VERIFICATION_NOTE_LIMIT) return null;
  return {
    action: 'verify-binding',
    chapterId: fields.chapterID,
    unionOrgId: fields.unionOrgID,
    verified: fields.verified === true,
    publicNote,
  };
}

// The chapter a connection decision may be recorded against: the readiness
// row's own chapter, and only while it is the chapter this phone has selected.
// The row comes from the server's current chapter, which another session can
// switch, so a decision never names a chapter the row did not come from
export function verifiableConnectionChapter(rowChapterID: string | null | undefined, selectedChapterID: string | null | undefined): string | null {
  return rowChapterID && selectedChapterID && rowChapterID === selectedChapterID ? rowChapterID : null;
}

export function connectionVerificationRequest(fields: {
  chapterID: string;
  capability: string;
  status: string;
  publicMessage?: string;
}): MobileConnectionVerification | null {
  const publicMessage = (fields.publicMessage ?? '').trim();
  if (!fields.chapterID || !fields.capability) return null;
  if (!(MOBILE_CONNECTION_OUTCOMES as readonly string[]).includes(fields.status)) return null;
  if (publicMessage.length > VERIFICATION_NOTE_LIMIT) return null;
  return {
    action: 'verify-connection',
    chapterId: fields.chapterID,
    capability: fields.capability,
    status: fields.status as MobileConnectionOutcome,
    publicMessage,
  };
}

// After a directory search, keep the administrator's chosen person when the
// new page still holds them. Silently retargeting an audited membership
// change at whoever happens to be first would be the worst possible default.
export function retainedMemberSelection(members: readonly MobileDirectoryMember[], current: string): string {
  return members.some((member) => member.userID === current) ? current : '';
}

export function chapterMembershipTargetReady(userID: string, chapterID: string): boolean {
  return userID !== '' && chapterID !== '';
}
