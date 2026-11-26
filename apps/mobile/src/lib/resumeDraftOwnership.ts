// Shared by retained drafts and business continuations: a checking projection
// is not a new owner. Confirmed scope facts still retire the previous owner.
export type ResumeDraftReads = { dashboard: boolean; memberships: boolean; staff: boolean };
export type DraftContext = {
  mode: string;
  session: { user: { id: string } } | null;
  organizationID: string | null;
  dashboard?: { member: { chapterID?: string | null } } | null;
  chapterMemberships?: readonly { chapterID: string; organizationID?: string | null; selected: boolean }[];
  authorizedRoles?: readonly string[];
  chapterRoles?: readonly string[];
  organizationRoles?: readonly string[];
  chosenStaffRole?: string | null;
  assuranceUnavailable?: boolean;
  refreshing?: boolean;
  resumeDraftReads?: ResumeDraftReads;
};
export type ResumeDraftOwner = { person: string | null; scope: string | null; organization: string | null; chapter: string | null };
const sorted = (roles: readonly string[] = []) => [...new Set(roles)].sort();
function chapterOf(context: DraftContext) {
  const selected = context.chapterMemberships?.find((row) => row.selected)?.chapterID ?? null;
  // A confirmed empty membership result is absence, never the old profile.
  return context.resumeDraftReads?.memberships === true ? selected : selected ?? context.dashboard?.member.chapterID ?? null;
}
export function resumeDraftReadsConfirmed(context: Pick<DraftContext, 'resumeDraftReads'>): boolean {
  const reads = context.resumeDraftReads;
  return !reads || (reads.dashboard && reads.memberships && reads.staff);
}
export function resumeDraftScopeOf(context: DraftContext): string | null {
  const chapter = chapterOf(context);
  if (context.mode !== 'authenticated' || !context.session || !context.organizationID || !chapter) return null;
  return JSON.stringify([context.session.user.id, context.organizationID, chapter,
    sorted(context.authorizedRoles), sorted(context.chapterRoles), sorted(context.organizationRoles), context.chosenStaffRole ?? null]);
}
export function resumeDraftOwnerFacts(context: DraftContext, previous: ResumeDraftOwner | null) {
  const person = context.session?.user.id ?? null;
  const scope = resumeDraftScopeOf(context);
  const reads = context.resumeDraftReads;
  const unresolved = !resumeDraftReadsConfirmed(context);
  const checking = context.mode === 'booting' || (context.mode === 'mfaRequired' && context.assuranceUnavailable === true)
    || (context.mode === 'authenticated' && (context.dashboard === null || unresolved));
  const checkingSamePerson = checking && person !== null && person === previous?.person;
  const chapter = chapterOf(context);
  const organizationConfirmed = !reads || (reads.staff && reads.memberships);
  const chapterConfirmed = reads?.memberships !== false;
  const boundOrganization = previous?.organization ?? null;
  const boundChapter = previous?.chapter ?? null;
  const knownScopeChange = (organizationConfirmed && context.organizationID !== null && boundOrganization !== null && context.organizationID !== boundOrganization)
    || (chapterConfirmed && chapter !== null && boundChapter !== null && chapter !== boundChapter)
    || (reads?.memberships === true && chapter === null && boundChapter !== null)
    || (reads !== undefined && organizationConfirmed && context.organizationID === null && boundOrganization !== null);
  return { person, scope, organization: context.organizationID, chapter, checking, checkingSamePerson, knownScopeChange };
}
