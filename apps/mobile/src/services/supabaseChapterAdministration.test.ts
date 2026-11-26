import { getSupabaseClient as businessTestClient } from './supabase';
import { stubSessionWriter } from '../testing/stubSessionWriter';
const businessWriter = stubSessionWriter(() => businessTestClient());
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => backend,
  processLock: vi.fn(),
}));
vi.mock('../lib/config', () => ({
  mobileConfig: {
    backendConfigured: true,
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'publishable-test-key',
  },
}));
vi.mock('../lib/secureSessionStorage', () => ({
  createBackendScopedSessionStorage: () => ({}),
}));

import {
  grantMobileChapterMembership,
  loadMobileAdminChapterScope,
  loadMobileChapterUnits,
  loadMobileStewardUnitAssignment,
  revokeMobileChapterMembership,
  searchMobileAdminMemberDirectory,
  setMobileChapterRole,
} from './supabase';

describe('native chapter-membership administration adapters', () => {
  beforeEach(() => {
    backend.rpc.mockReset();
    backend.from.mockReset();
  });

  it('reads the caller’s own administrator scope instead of assuming one', async () => {
    backend.rpc.mockResolvedValue({
      data: { scope: 'organization', chapterId: null, chapters: [{ id: 'harborview', name: 'Harborview Care United' }] },
      error: null,
    });
    const scope = await loadMobileAdminChapterScope();
    expect(backend.rpc).toHaveBeenCalledWith('get_admin_org_structure');
    expect(scope).toEqual({ scope: 'organization', chapterID: null, chapters: [{ id: 'harborview', name: 'Harborview Care United' }] });
  });

  it('reports a refused scope read rather than rendering an empty organization', async () => {
    backend.rpc.mockResolvedValue({ data: null, error: { message: 'admin role required' } });
    await expect(loadMobileAdminChapterScope()).rejects.toThrow('Your administrator scope could not be confirmed.');
  });

  it('searches the directory with the argument names the migration declares', async () => {
    backend.rpc.mockResolvedValue({ data: { items: [{ userId: 'user-1', fullName: 'Ada Ramos', roles: [] }], nextCursor: null }, error: null });
    const page = await searchMobileAdminMemberDirectory('  Ada  ');
    expect(backend.rpc).toHaveBeenCalledWith('get_admin_member_directory', {
      p_query: 'Ada', p_after_name: null, p_after_id: null, p_limit: 25,
    });
    expect(page.members.map((member) => member.userID)).toEqual(['user-1']);
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  // The cursor the RPC hands back is sent back whole for the next page, so
  // the twenty-sixth person with an identical full name is reachable.
  it('follows the directory cursor page by page with the argument pair the RPC requires', async () => {
    backend.rpc.mockResolvedValue({
      data: { items: [{ userId: 'user-26', fullName: 'Ada Ramos', roles: [] }], nextCursor: null },
      error: null,
    });
    const page = await searchMobileAdminMemberDirectory('Ada', { name: 'Ada Ramos', id: 'user-25' });
    expect(backend.rpc).toHaveBeenCalledWith('get_admin_member_directory', {
      p_query: 'Ada', p_after_name: 'Ada Ramos', p_after_id: 'user-25', p_limit: 25,
    });
    expect(page.members.map((member) => member.userID)).toEqual(['user-26']);
    expect(page.nextCursor).toBeNull();
  });

  // The RPC answers with a cursor when more members match than the page
  // carries. Dropping it left an administrator unable to tell a complete list
  // from one that was cut at twenty-five.
  it('carries the fact that more workers matched than the page holds', async () => {
    backend.rpc.mockResolvedValue({
      data: { items: [{ userId: 'user-1', fullName: 'Ada Ramos', roles: [] }], nextCursor: { name: 'Ada Ramos', id: 'user-1' } },
      error: null,
    });
    await expect(searchMobileAdminMemberDirectory('Ada')).resolves.toMatchObject({ truncated: true, nextCursor: { name: 'Ada Ramos', id: 'user-1' } });
  });

  // The RPC raises `query too short` for a single character. Sending it would
  // turn a typing state into a refusal banner.
  it('never sends a one-character needle the database will refuse', async () => {
    expect(await searchMobileAdminMemberDirectory('A')).toEqual({ members: [], truncated: false, nextCursor: null });
    expect(backend.rpc).not.toHaveBeenCalled();
  });

  it('grants an additional campaign membership for the exact named pair', async () => {
    backend.rpc.mockResolvedValue({ data: { active: true }, error: null });
    await grantMobileChapterMembership(businessWriter, 'user-1', 'springfield');
    expect(backend.rpc).toHaveBeenCalledWith('grant_member_chapter_membership', {
      p_user_id: 'user-1', p_chapter_id: 'springfield',
    });
  });

  it('revokes exactly the named membership and surfaces a refusal', async () => {
    backend.rpc.mockResolvedValue({ data: null, error: null });
    await revokeMobileChapterMembership(businessWriter, 'user-1', 'springfield');
    expect(backend.rpc).toHaveBeenCalledWith('revoke_member_chapter_membership', {
      p_user_id: 'user-1', p_chapter_id: 'springfield',
    });
    backend.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'campaign outside admin scope' } });
    await expect(revokeMobileChapterMembership(businessWriter, 'user-1', 'springfield')).rejects.toThrow('membership-revoke-refused');
  });

  it('scopes a role grant and a role removal to the named campaign', async () => {
    backend.rpc.mockResolvedValue({ data: { enabled: true }, error: null });
    await setMobileChapterRole(businessWriter, 'user-1', 'springfield', 'steward', true, 'unit-1');
    expect(backend.rpc).toHaveBeenLastCalledWith('set_member_access_role', {
      p_user: 'user-1', p_chapter: 'springfield', p_role: 'steward', p_enabled: true, p_unit: 'unit-1', p_committee: null,
    });
    await setMobileChapterRole(businessWriter, 'user-1', 'springfield', 'admin', false);
    expect(backend.rpc).toHaveBeenLastCalledWith('set_member_chapter_role', {
      p_user_id: 'user-1', p_chapter_id: 'springfield', p_role: 'admin', p_enabled: false,
    });
  });

  it('reports a refused membership grant instead of a local success', async () => {
    backend.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'campaign outside admin scope' } });
    await expect(grantMobileChapterMembership(businessWriter, 'user-1', 'other')).rejects.toThrow('membership-grant-refused');
    backend.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'active campaign membership required' } });
    await expect(setMobileChapterRole(businessWriter, 'user-1', 'other', 'vp', true)).rejects.toThrow('chapter-role-refused');
  });

  // A transport failure has no SQLSTATE: the database may have recorded the
  // change before the answer was lost, so it is unconfirmed, not refused.
  it('separates a database refusal from a transport failure whose outcome is unknown', async () => {
    backend.rpc.mockResolvedValue({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' } });
    await expect(grantMobileChapterMembership(businessWriter, 'user-1', 'springfield')).rejects.toThrow('membership-outcome-unconfirmed');
    backend.rpc.mockResolvedValue({ data: null, error: { message: 'network request failed' } });
    await expect(setMobileChapterRole(businessWriter, 'user-1', 'springfield', 'steward', true, 'unit-1')).rejects.toThrow('membership-outcome-unconfirmed');
    await expect(revokeMobileChapterMembership(businessWriter, 'user-1', 'springfield')).rejects.toThrow('membership-outcome-unconfirmed');
  });
});

describe('required committee member unit adapters', () => {
  beforeEach(() => { backend.rpc.mockReset(); });
  it('refuses a missing unit before any request', async () => {
    await expect(setMobileChapterRole(businessWriter, 'user-1', 'springfield', 'steward', true)).rejects.toThrow('steward-unit-required');
    expect(backend.rpc).not.toHaveBeenCalled();
  });
  it('keeps only units of the chosen campaign and confirms the selected committee member mark', async () => {
    backend.rpc.mockResolvedValueOnce({ data: [{ id: 'u1', chapterId: 'springfield', name: 'Harbor' }, { id: 'u2', chapterId: 'other', name: 'Other' }], error: null });
    expect(await loadMobileChapterUnits('springfield')).toEqual([{ id: 'u1', name: 'Harbor' }]);
    backend.rpc.mockResolvedValueOnce({ data: { userId: 'user-1', chapterId: 'springfield', legacyChapterCoverage: true }, error: null });
    expect(await loadMobileStewardUnitAssignment('user-1', 'springfield')).toEqual({ legacyChapterCoverage: true });
    expect(backend.rpc).toHaveBeenLastCalledWith('get_steward_unit_assignment', { p_user: 'user-1', p_chapter: 'springfield' });
  });
  it('does not treat failed or mismatched reads as no carry-over coverage', async () => {
    backend.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(loadMobileChapterUnits('springfield')).rejects.toThrow('could not be confirmed');
    await expect(loadMobileStewardUnitAssignment('user-1', 'springfield')).rejects.toThrow('could not be confirmed');
    for (const data of [null, {}, { userId: 'user-1', chapterId: 'other', legacyChapterCoverage: false }, { userId: 'user-1', chapterId: 'springfield', legacyChapterCoverage: 'false' }]) {
      backend.rpc.mockResolvedValue({ data, error: null });
      await expect(loadMobileStewardUnitAssignment('user-1', 'springfield')).rejects.toThrow('could not be confirmed');
    }
  });
});
