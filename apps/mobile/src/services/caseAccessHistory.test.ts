import { stubSessionWriter } from '../testing/stubSessionWriter';
import { getSupabaseClient as protocolTestClient } from './supabase';
const testWriter = stubSessionWriter(protocolTestClient, 'steward-a');
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #9120: the phone's staff case access-history write is the website's
// record_member_access_event call, and it reports whether the entry is in place.
const backend = vi.hoisted(() => ({
  configured: true,
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>>(),
}));
vi.mock('./supabase', () => ({ getSupabaseClient: () => (backend.configured ? { rpc: backend.rpc } : null) }));

import { recordCaseAccess } from './caseAccessHistory';

const target = { caseID: 'case-1', subjectUserID: 'member-b', actorUserID: 'steward-a', organizationID: 'org-tamarack' };

beforeEach(() => {
  backend.configured = true;
  backend.rpc.mockReset().mockResolvedValue({ data: 'event-1', error: null });
});

describe('recordCaseAccess', () => {
  it.each<'viewed_case' | 'updated_case'>(['viewed_case', 'updated_case'])('writes %s for another worker\'s issue in the session organization', async (action) => {
    expect(await recordCaseAccess(testWriter, action, target)).toBe(true);
    expect(backend.rpc.mock.calls).toEqual([['record_member_access_event', {
      p_expected_organization_id: 'org-tamarack', p_subject_user_id: 'member-b', p_action: action, p_entity_type: 'case', p_entity_id: 'case-1',
    }]]);
  });

  it('writes nothing for the staff member\'s own issue and counts it as in place', async () => {
    expect(await recordCaseAccess(testWriter, 'viewed_case', { ...target, subjectUserID: 'steward-a' })).toBe(true);
    expect(backend.rpc).not.toHaveBeenCalled();
  });

  it('reports a refusal, a thrown call, a missing organization, worker or backend as not in place', async () => {
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    expect(await recordCaseAccess(testWriter, 'updated_case', target)).toBe(false);
    backend.rpc.mockRejectedValueOnce(new Error('offline'));
    expect(await recordCaseAccess(testWriter, 'updated_case', target)).toBe(false);
    expect(await recordCaseAccess(testWriter, 'viewed_case', { ...target, organizationID: null })).toBe(false);
    expect(await recordCaseAccess(testWriter, 'viewed_case', { ...target, subjectUserID: undefined })).toBe(false);
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    backend.configured = false;
    expect(await recordCaseAccess(testWriter, 'viewed_case', target)).toBe(false);
    expect(backend.rpc).toHaveBeenCalledTimes(2);
  });
});
