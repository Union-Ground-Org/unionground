import { describe, expect, it } from 'vitest';
import { chapterMembershipCopy, chapterMembershipRoleLabels } from './chapterAdministrationCopy';

import {
  bindingVerificationRequest,
  canAdministerChapterMemberships,
  canVerifyChapterLifecycle,
  chapterConnectionIsVerifiable,
  chapterConnectionProviderLine,
  chapterMembershipTargetReady,
  classifyMembershipFailure,
  completionStillCurrent,
  connectionVerificationRequest,
  describeMembershipOutcome,
  DIRECTORY_MAX_PAGES,
  directoryPageWasTruncated,
  directoryReadIsCurrent,
  enterpriseControlsCopy,
  isPlannedChapterCapability,
  loadMoreIsContinuation,
  membershipRpcFailure,
  mergeDirectoryPages,
  normalizeAdminScope,
  normalizeChapterUnits,
  verifiableConnectionChapter,
  normalizeDirectoryCursor,
  normalizeDirectoryMembers,
  retainedMemberSelection,
  VERIFICATION_NOTE_LIMIT,
} from './chapterAdministration';

describe('native administrator scope', () => {
  it('keeps explicit own-chapter unit choices without selecting a default', () => {
    expect(normalizeChapterUnits(null, 'ch')).toEqual([]);
    expect(normalizeChapterUnits([null, 1, {}, { id: '', name: 'Missing id', chapterId: 'ch' }, { id: 'u', name: '', chapterId: 'ch' }, { id: 'other', name: 'Foreign', chapterId: 'foreign' }, { id: 'default', name: 'Harbor', chapterId: 'ch', isDefault: true }], 'ch')).toEqual([{ id: 'default', name: 'Harbor' }]);
  });
  it('names and explains the chapter-scoped vp access level', () => {
    expect(chapterMembershipCopy.en.roleNames.vp).toBe('Campaign chair');
    expect(chapterMembershipCopy.en.roleBoundary).toContain('every unit, chapter-wide notices and campaign settings');
    expect(chapterMembershipCopy.en.unscopedVpLabel).toBe('Campaign chair');
  });
  it('uses known grant scopes without renaming an organization or merged-directory vp', () => {
    expect(chapterMembershipRoleLabels({ roles: ['steward', 'vp'], chapterRoles: ['vp'], organizationRoles: [] })).toEqual(['Committee', 'Campaign lead']);
    expect(chapterMembershipRoleLabels({ roles: ['vp'], chapterRoles: [], organizationRoles: ['vp'] })).toEqual(['Campaign chair']);
    expect(chapterMembershipRoleLabels({ roles: ['vp'], chapterRoles: ['vp'], organizationRoles: ['vp'] })).toEqual(['Campaign lead', 'Campaign chair']);
    expect(chapterMembershipRoleLabels({ roles: ['vp'] })).toEqual(['Campaign chair']);
    expect(chapterMembershipRoleLabels({ roles: [] })).toEqual([]);
  });
  it('keeps the scope and the campaigns the RPC actually answered with', () => {
    expect(normalizeAdminScope({
      scope: 'organization',
      chapterId: null,
      canCreateChapter: true,
      chapters: [
        { id: 'worcester', name: 'Harborview Care United' },
        { id: 'springfield', name: 'Harborview Care Springfield' },
      ],
    })).toEqual({
      scope: 'organization',
      chapterID: null,
      chapters: [
        { id: 'worcester', name: 'Harborview Care United' },
        { id: 'springfield', name: 'Harborview Care Springfield' },
      ],
    });
  });

  it('reports a campaign administrator as campaign scope rather than widening them', () => {
    const scope = normalizeAdminScope({ scope: 'chapter', chapterId: 'worcester', chapters: [{ id: 'worcester', name: 'Harborview Care United' }] });
    expect(scope?.scope).toBe('chapter');
    expect(scope?.chapterID).toBe('worcester');
  });

  it('refuses a payload that does not name a scope and a campaign list', () => {
    expect(normalizeAdminScope(null)).toBeNull();
    expect(normalizeAdminScope({ scope: 'organization' })).toBeNull();
    expect(normalizeAdminScope({ scope: 'everything', chapters: [] })).toBeNull();
  });

  it('drops a campaign row with no identity instead of rendering a nameless target', () => {
    expect(normalizeAdminScope({ scope: 'organization', chapters: [{ name: 'Nameless' }, { id: 'worcester' }] })?.chapters)
      .toEqual([{ id: 'worcester', name: 'worcester' }]);
  });
});

describe('native worker directory', () => {
  it('maps the directory page and keeps only roles the product defines', () => {
    expect(normalizeDirectoryMembers({
      items: [{
        userId: '11111111-1111-4111-8111-111111111111',
        fullName: 'Ada Ramos',
        chapterId: 'worcester',
        chapterName: 'Harborview Care United',
        roles: ['steward', 'wizard', 'admin'],
      }],
      nextCursor: null,
    })).toEqual([{
      userID: '11111111-1111-4111-8111-111111111111',
      fullName: 'Ada Ramos',
      chapterID: 'worcester',
      chapterName: 'Harborview Care United',
      roles: ['steward', 'admin'],
    }]);
  });

  it('drops a row with no identity rather than offering an unnamed target', () => {
    expect(normalizeDirectoryMembers({ items: [{ fullName: 'No id' }, { userId: 'x' }] })).toEqual([]);
  });

  it('answers with no workers when the payload is not a directory page', () => {
    expect(normalizeDirectoryMembers(null)).toEqual([]);
    expect(normalizeDirectoryMembers([])).toEqual([]);
  });
});

describe('native chapter-administration authorization', () => {
  it('opens membership administration to a campaign or organization administrator only', () => {
    expect(canAdministerChapterMemberships(['admin'], [])).toBe(true);
    expect(canAdministerChapterMemberships([], ['admin'])).toBe(true);
    expect(canAdministerChapterMemberships(['steward', 'vp'], ['vp'])).toBe(false);
    expect(canAdministerChapterMemberships([], [])).toBe(false);
  });

  // The verification RPCs are granted to the service role alone and the
  // portal boundary admits an organization-wide administrator only.
  it('keeps verification off a campaign administrator’s screen', () => {
    expect(canVerifyChapterLifecycle(['admin'])).toBe(true);
    expect(canVerifyChapterLifecycle(['vp'])).toBe(false);
    expect(canVerifyChapterLifecycle([])).toBe(false);
  });

  it('requires both a person and a campaign before any audited action', () => {
    expect(chapterMembershipTargetReady('user', 'worcester')).toBe(true);
    expect(chapterMembershipTargetReady('', 'worcester')).toBe(false);
    expect(chapterMembershipTargetReady('user', '')).toBe(false);
  });

  it('reads the cursor as the signal that the page was cut, and nothing else as one', () => {
    expect(directoryPageWasTruncated({ items: [], nextCursor: { name: 'Ada', id: 'user-1' } })).toBe(true);
    expect(directoryPageWasTruncated({ items: [], nextCursor: null })).toBe(false);
    expect(directoryPageWasTruncated({ items: [] })).toBe(false);
    expect(directoryPageWasTruncated(null)).toBe(false);
    expect(directoryPageWasTruncated([])).toBe(false);
  });

  it('clears the chosen person when a new directory page no longer holds them', () => {
    const members = normalizeDirectoryMembers({ items: [{ userId: 'a', fullName: 'Ada' }] });
    expect(retainedMemberSelection(members, 'a')).toBe('a');
    expect(retainedMemberSelection(members, 'b')).toBe('');
  });
});

describe('native verification requests', () => {
  it('builds the exact binding decision the portal boundary accepts', () => {
    expect(bindingVerificationRequest({ chapterID: 'worcester', unionOrgID: 'org-1', verified: true, publicNote: '  Reviewed  ' }))
      .toEqual({ action: 'verify-binding', chapterId: 'worcester', unionOrgId: 'org-1', verified: true, publicNote: 'Reviewed' });
  });

  it('records a rejection as a decision, not as a missing approval', () => {
    expect(bindingVerificationRequest({ chapterID: 'worcester', unionOrgID: 'org-1', verified: false })?.verified).toBe(false);
  });

  it('refuses a binding decision with no campaign, no organization, or an over-long note', () => {
    expect(bindingVerificationRequest({ chapterID: '', unionOrgID: 'org-1', verified: true })).toBeNull();
    expect(bindingVerificationRequest({ chapterID: 'worcester', unionOrgID: '', verified: true })).toBeNull();
    expect(bindingVerificationRequest({
      chapterID: 'worcester', unionOrgID: 'org-1', verified: true, publicNote: 'x'.repeat(VERIFICATION_NOTE_LIMIT + 1),
    })).toBeNull();
  });

  it('builds the exact connection outcome the portal boundary accepts', () => {
    expect(connectionVerificationRequest({ chapterID: 'worcester', capability: 'sms', status: 'active', publicMessage: ' Live ' }))
      .toEqual({ action: 'verify-connection', chapterId: 'worcester', capability: 'sms', status: 'active', publicMessage: 'Live' });
  });

  it('refuses a status the database does not define', () => {
    expect(connectionVerificationRequest({ chapterID: 'worcester', capability: 'sms', status: 'configuring' })).toBeNull();
    expect(connectionVerificationRequest({ chapterID: 'worcester', capability: '', status: 'active' })).toBeNull();
  });

  // Gate round 1 on #8641: the readiness row is the server's current chapter,
  // which another session can switch, while the phone still shows the chapter
  // it loaded. A decision names the row's chapter, and only while they agree.
  it('records a connection decision only against the readiness row’s own campaign, while it is the one shown', () => {
    expect(verifiableConnectionChapter('worcester', 'worcester')).toBe('worcester');
    expect(verifiableConnectionChapter('springfield', 'worcester')).toBeNull();
    expect(verifiableConnectionChapter(null, 'worcester')).toBeNull();
    expect(verifiableConnectionChapter(undefined, 'worcester')).toBeNull();
    expect(verifiableConnectionChapter('worcester', null)).toBeNull();
    expect(verifiableConnectionChapter('', '')).toBeNull();
  });
});

describe('which campaign connections may be certified', () => {
  // Notion and enterprise SSO/SCIM ship planned: the request control is
  // withheld for them, so the verification control must be withheld too.
  // Otherwise an operator can mark a system that does not exist "active".
  it('never offers verification for a capability that ships planned', () => {
    expect(isPlannedChapterCapability('notion')).toBe(true);
    expect(isPlannedChapterCapability('enterprise')).toBe(true);
    expect(isPlannedChapterCapability('sms')).toBe(false);
    for (const status of ['configuring', 'active', 'error', 'disabled']) {
      expect(chapterConnectionIsVerifiable('notion', status)).toBe(false);
      expect(chapterConnectionIsVerifiable('enterprise', status)).toBe(false);
    }
  });

  // REQ-UG-NATIVE-CHAPTER-ADMIN-NAMES-SINGLE-SIGN-ON-AFTER-RELEASE-20261113
  // (#8611): Enterprise controls names single sign-on only once the sign-in
  // options read says it is released (services/ssoRelease.test.tsx covers
  // the read's fail-closed states); otherwise it names directory sync alone.
  // REQ-UG-HOLD-DIRECTORY-SYNC-WITH-SINGLE-SIGN-ON-20261117 (#9037):
  // directory sync (SCIM) is held too and is named only once its own read
  // says it is released; with both held the card names neither.
  it('names single sign-on and directory sync on Enterprise controls only once each read says it is released', () => {
    const named = /\bSSO\b|single[\s-]*sign|\bSCIM\b|directory[\s-]*sync/i;
    expect(enterpriseControlsCopy(false, false)).toBe('Organization-wide controls are set up by an organization admin on the website. They never replace provisioned email-and-password access, and nothing is verified per campaign here.');
    expect(enterpriseControlsCopy(false, false)).not.toMatch(named);
    expect(enterpriseControlsCopy(false, true)).toBe('SCIM is an organization-wide activation an organization admin sets up on the website. It never replaces provisioned email-and-password access, and nothing is verified per campaign here.');
    expect(enterpriseControlsCopy(false, true)).not.toMatch(/\bSSO\b|single[\s-]*sign/i);
    expect(enterpriseControlsCopy(true, false)).toBe('SSO is an organization-wide activation an organization admin sets up on the website. It never replaces provisioned email-and-password access, and nothing is verified per campaign here.');
    expect(enterpriseControlsCopy(true, false)).not.toMatch(/\bSCIM\b|directory[\s-]*sync/i);
    expect(enterpriseControlsCopy(true, true)).toBe('SSO and SCIM are organization-wide activations an organization admin sets up on the website. They never replace provisioned email-and-password access, and nothing is verified per campaign here.');
  });

  it('offers verification only once a shipped capability has been requested', () => {
    expect(chapterConnectionIsVerifiable('sms', 'configuring')).toBe(true);
    expect(chapterConnectionIsVerifiable('calendar_google', 'active')).toBe(true);
    expect(chapterConnectionIsVerifiable('cba', 'error')).toBe(true);
    expect(chapterConnectionIsVerifiable('cba', 'disabled')).toBe(true);
    expect(chapterConnectionIsVerifiable('sms', 'unset')).toBe(false);
  });

  it('names the chapter-owned provider, and says plainly when the request named none', () => {
    expect(chapterConnectionProviderLine('  Twilio · +1 508 555 0143  '))
      .toBe('Campaign-owned provider: Twilio · +1 508 555 0143');
    expect(chapterConnectionProviderLine('   ')).toContain('No provider identity');
    expect(chapterConnectionProviderLine('')).toContain('No provider identity');
  });
});

describe('directory paging', () => {
  const member = (userID: string, fullName = 'Ada Ramos') => ({ userID, fullName, chapterID: 'c', chapterName: 'C', roles: [] });

  it('reads the cursor pair the RPC hands back, and nothing incomplete', () => {
    expect(normalizeDirectoryCursor({ items: [], nextCursor: { name: 'Ada Ramos', id: 'user-25' } })).toEqual({ name: 'Ada Ramos', id: 'user-25' });
    for (const bad of [null, {}, { nextCursor: null }, { nextCursor: { name: 'x' } }, { nextCursor: { id: 'y' } }, { nextCursor: 'str' }, []]) {
      expect(normalizeDirectoryCursor(bad)).toBeNull();
    }
  });

  it('appends the next page without moving anyone who was already listed', () => {
    const merged = mergeDirectoryPages([member('1'), member('2')], [member('2'), member('3')]);
    expect(merged.map((row) => row.userID)).toEqual(['1', '2', '3']);
    expect(mergeDirectoryPages([], [])).toEqual([]);
    expect(DIRECTORY_MAX_PAGES).toBe(10);
  });
});

describe('membership outcomes the screen announces', () => {
  const copy = {
    membershipGranted: (name: string) => `granted ${name}`,
    membershipRevoked: (name: string) => `revoked ${name}`,
    roleGranted: (name: string) => `role on ${name}`,
    roleRevoked: (name: string) => `role off ${name}`,
    membershipError: 'refused membership',
    roleError: 'refused role',
    membershipUnconfirmed: (name: string) => `unconfirmed membership ${name}`,
    roleUnconfirmed: (name: string) => `unconfirmed role ${name}`,
    staleDirectory: 'stale',
    searchError: 'search failed',
    directoryLimit: 'limit',
    refreshFailed: 'could not re-read',
  };

  it('names the person in every success and every unconfirmed outcome, and keeps refusals as errors', () => {
    expect(describeMembershipOutcome('granted', copy, 'Ada')).toEqual({ tone: 'notice', text: 'granted Ada' });
    expect(describeMembershipOutcome('revoked', copy, 'Ada')).toEqual({ tone: 'notice', text: 'revoked Ada' });
    expect(describeMembershipOutcome('role-granted', copy, 'Ada')).toEqual({ tone: 'notice', text: 'role on Ada' });
    expect(describeMembershipOutcome('role-revoked', copy, 'Ada')).toEqual({ tone: 'notice', text: 'role off Ada' });
    expect(describeMembershipOutcome('refused-membership', copy, 'Ada')).toEqual({ tone: 'error', text: 'refused membership' });
    expect(describeMembershipOutcome('refused-role', copy, 'Ada')).toEqual({ tone: 'error', text: 'refused role' });
    expect(describeMembershipOutcome('unconfirmed-membership', copy, 'Ada')).toEqual({ tone: 'error', text: 'unconfirmed membership Ada' });
    expect(describeMembershipOutcome('unconfirmed-role', copy, 'Ada')).toEqual({ tone: 'error', text: 'unconfirmed role Ada' });
    expect(describeMembershipOutcome('stale', copy, '')).toEqual({ tone: 'error', text: 'stale' });
    expect(describeMembershipOutcome('search-error', copy, '')).toEqual({ tone: 'error', text: 'search failed' });
    expect(describeMembershipOutcome('refresh-failed', copy, 'Ada')).toEqual({ tone: 'error', text: 'could not re-read' });
    expect(describeMembershipOutcome('directory-limit', copy, '')).toEqual({ tone: 'notice', text: 'limit' });
  });

  it('tells a database refusal from a transport failure whose outcome is unknown', () => {
    expect(membershipRpcFailure({ code: '42501' }, 'membership-grant-refused').message).toBe('membership-grant-refused');
    expect(membershipRpcFailure({ code: 'PGRST301' }, 'chapter-role-refused').message).toBe('chapter-role-refused');
    expect(membershipRpcFailure({ code: '' }, 'membership-grant-refused').message).toBe('membership-outcome-unconfirmed');
    expect(membershipRpcFailure({}, 'membership-grant-refused').message).toBe('membership-outcome-unconfirmed');
    expect(membershipRpcFailure(null, 'membership-grant-refused').message).toBe('membership-outcome-unconfirmed');
    expect(classifyMembershipFailure(new Error('membership-grant-refused'))).toBe('refused');
    expect(classifyMembershipFailure(new WriterSessionChanged())).toBe('refused');
    expect(classifyMembershipFailure(new Error('membership-outcome-unconfirmed'))).toBe('unconfirmed');
    expect(classifyMembershipFailure(new TypeError('Failed to fetch'))).toBe('unconfirmed');
    expect(classifyMembershipFailure('not an error')).toBe('unconfirmed');
  });

  // A membership or role change whose answer only copies the
  // writer's marker may have landed, so it is unconfirmed (the directory is
  // re-read), never announced as refused.
  it('treats an error that only copies the writer marker as unconfirmed', () => {
    expect(classifyMembershipFailure({ code: '', message: 'The account changed before this was sent.', details: 'writer_session_changed', hint: null })).toBe('unconfirmed');
    expect(classifyMembershipFailure(Object.assign(new Error('The account changed before this was sent.'), { details: 'writer_session_changed' }))).toBe('unconfirmed');
    expect(classifyMembershipFailure(attachBusinessRpcProvenance(new WriterSessionChanged(), 502))).toBe('unconfirmed');
  });

  it('announces a completion only for the target it was started for, on a screen still present', () => {
    const startedFor = { userID: 'u1', chapterID: 'c1' };
    expect(completionStillCurrent({ startedFor, current: { userID: 'u1', chapterID: 'c1' }, mounted: true })).toBe(true);
    expect(completionStillCurrent({ startedFor, current: { userID: 'u2', chapterID: 'c1' }, mounted: true })).toBe(false);
    expect(completionStillCurrent({ startedFor, current: { userID: 'u1', chapterID: 'c2' }, mounted: true })).toBe(false);
    expect(completionStillCurrent({ startedFor, current: { userID: 'u1', chapterID: 'c1' }, mounted: false })).toBe(false);
  });
});

describe('result sets belong to the query that was searched', () => {
  it('lets Load more continue only the submitted query with its own cursor', () => {
    const cursor = { name: 'Ada Ramos', id: 'user-25' };
    expect(loadMoreIsContinuation({ draft: 'Ada', submitted: 'Ada', cursor })).toBe(true);
    expect(loadMoreIsContinuation({ draft: '  Ada ', submitted: 'Ada', cursor })).toBe(true);
    // Edited before Load more: Beatrice must not continue Ada's cursor.
    expect(loadMoreIsContinuation({ draft: 'Beatrice', submitted: 'Ada', cursor })).toBe(false);
    expect(loadMoreIsContinuation({ draft: 'Ada', submitted: null, cursor })).toBe(false);
    expect(loadMoreIsContinuation({ draft: 'Ada', submitted: 'Ada', cursor: null })).toBe(false);
  });

  it('installs a read only if no newer read started while it was in flight', () => {
    expect(directoryReadIsCurrent({ startedSequence: 3, currentSequence: 3 })).toBe(true);
    // Edited and re-searched during the request: the older read is dropped.
    expect(directoryReadIsCurrent({ startedSequence: 3, currentSequence: 4 })).toBe(false);
  });
});
import { WriterSessionChanged } from '../../../../src/lib/sessionBoundWriter.js';
import { attachBusinessRpcProvenance } from '../services/businessWriters';
