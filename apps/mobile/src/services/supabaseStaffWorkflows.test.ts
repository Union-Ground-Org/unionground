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
  addMobileHealthCoaching,
  closeMobileHandshake,
  countersignMobileHandshake,
  loadMobileHandshakes,
  loadMobileHandshakeTargets,
  loadMobileHealthPortfolio,
  loadMobileStaffScope,
  loadMobileChapterMemberships,
  recordMobileHealthSnapshot,
  requestMobileHandshake,
  respondMobileHandshake,
  searchMobileUnionOrganizations,
} from './supabase';

describe('native handshake and chapter-health adapters', () => {
  beforeEach(() => {
    backend.rpc.mockReset();
    backend.from.mockReset();
  });

  it('uses the nationwide catalog query for binding lookup by local number and city', async () => {
    const filters: unknown[][] = [];
    const query = {
      select: vi.fn(() => query),
      or: vi.fn((value: string) => { filters.push(['or', value]); return query; }),
      eq: vi.fn((...args: unknown[]) => { filters.push(['eq', ...args]); return query; }),
      order: vi.fn(() => query),
      range: vi.fn(async () => ({ data: [{ id: 'local-one', name: 'Example Workers', designation: 'Local', local_number: '1', city: 'Boston', state: 'MA' }], error: null })),
    };
    backend.from.mockReturnValue(query);
    await expect(searchMobileUnionOrganizations('Local 1 Boston')).resolves.toEqual([{ id: 'local-one', name: 'Example Workers · Local 1', location: 'Boston, MA', affiliation: '' }]);
    expect(backend.from).toHaveBeenCalledWith('union_orgs');
    expect(filters).toEqual([
      ['or', 'local_number.eq."1",name.ilike."%Local 1 Boston%"'],
      ['or', 'name.ilike."%Boston%",city.ilike."%Boston%",affiliation.ilike."%Boston%"'],
    ]);
    expect(query.range).toHaveBeenCalledWith(0, 19);
    backend.from.mockClear();
    await expect(searchMobileUnionOrganizations('a')).resolves.toEqual([]);
    expect(backend.from).not.toHaveBeenCalled();
  });

  it('maps incoming and outgoing handshake rows against the verified-binding filter without widening partner identity', async () => {
    const handshakeSelectCalls: unknown[][] = [];
    const bindingEqCalls: unknown[][] = [];
    const bindingInCalls: unknown[][] = [];
    const bindingSelectCalls: unknown[][] = [];
    backend.from.mockImplementation((table: string) => {
      if (table === 'chapter_handshakes') {
        return {
          select: (...selectArgs: unknown[]) => {
            handshakeSelectCalls.push(selectArgs);
            return { order: () => ({ limit: async () => ({
              data: [
                { id: 'incoming', chapter_id: 'chapter-a', receiving_chapter_id: 'chapter-current', title: 'Training', purpose: 'Share training', data_scope: 'docs_only', status: 'requested', updated_at: '2026-09-01T00:00:00Z', union_orgs: { name: 'Current organization' } },
                { id: 'outgoing', chapter_id: 'chapter-current', receiving_chapter_id: 'chapter-b', title: 'Research', purpose: 'Compare aggregates', data_scope: 'aggregate_only', status: 'accepted', updated_at: '2026-08-31T00:00:00Z', union_orgs: { name: 'Partner B' } },
              ], error: null,
            }) }) };
          },
        };
      }
      return {
        select: (...selectArgs: unknown[]) => {
          bindingSelectCalls.push(selectArgs);
          return { eq: (...eqArgs: unknown[]) => {
            bindingEqCalls.push(eqArgs);
            return { in: async (...inArgs: unknown[]) => {
              bindingInCalls.push(inArgs);
              return { data: [{ chapter_id: 'chapter-a', union_orgs: { name: 'Partner A' } }], error: null };
            } };
          } };
        },
      };
    });

    const rows = await loadMobileHandshakes('chapter-current');
    // A mock that ignored these arguments would still pass even if the
    // verified-status filter or the chapter scoping were dropped from
    // loadMobileHandshakes, so the filter itself must be asserted.
    expect(handshakeSelectCalls).toEqual([['id,chapter_id,receiving_chapter_id,title,purpose,data_scope,status,updated_at,union_orgs(name)']]);
    expect(bindingEqCalls).toEqual([['status', 'verified']]);
    expect(bindingInCalls).toEqual([['chapter_id', ['chapter-a', 'chapter-current']]]);
    expect(bindingSelectCalls).toEqual([['chapter_id,union_orgs(name)']]);
    // toEqual (not toMatchObject) so a future field added to MobileHandshake
    // without updating this test fails instead of passing silently.
    expect(rows).toEqual([
      {
        id: 'incoming', title: 'Training', purpose: 'Share training', dataScope: 'docs_only',
        status: 'requested', direction: 'incoming', partnerName: 'Partner A', updatedAt: '2026-09-01T00:00:00Z',
      },
      {
        id: 'outgoing', title: 'Research', purpose: 'Compare aggregates', dataScope: 'aggregate_only',
        status: 'accepted', direction: 'outgoing', partnerName: 'Partner B', updatedAt: '2026-08-31T00:00:00Z',
      },
    ]);
  });

  it('falls back to "Sister campaign" when no verified binding names the incoming partner', async () => {
    backend.from.mockImplementation((table: string) => {
      if (table === 'chapter_handshakes') {
        return {
          select: () => ({ order: () => ({ limit: async () => ({
            data: [
              { id: 'incoming', chapter_id: 'chapter-unverified', receiving_chapter_id: 'chapter-current', title: 'Training', purpose: 'Share training', data_scope: 'docs_only', status: 'requested', updated_at: '2026-09-01T00:00:00Z', union_orgs: null },
            ], error: null,
          }) }) }),
        };
      }
      return { select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }) };
    });

    const rows = await loadMobileHandshakes('chapter-current');
    expect(rows).toEqual([
      {
        id: 'incoming', title: 'Training', purpose: 'Share training', dataScope: 'docs_only',
        status: 'requested', direction: 'incoming', partnerName: 'Sister campaign', updatedAt: '2026-09-01T00:00:00Z',
      },
    ]);
  });

  it('excludes the current campaign and requires a verified binding for handshake targets', async () => {
    const eqCalls: unknown[][] = [];
    const selectCalls: unknown[][] = [];
    backend.from.mockImplementation((table: string) => {
      expect(table).toBe('chapter_union_org_bindings');
      return {
        select: (...selectArgs: unknown[]) => {
          selectCalls.push(selectArgs);
          return { eq: (...eqArgs: unknown[]) => {
            eqCalls.push(eqArgs);
            return { limit: async () => ({
              data: [
                { chapter_id: 'chapter-current', union_orgs: { id: 'org-current', name: 'Current organization', city: 'Here', state: 'ST', affiliation: 'Local 1' } },
                { chapter_id: 'chapter-a', union_orgs: { id: 'org-a', name: 'Partner A', city: 'Elsewhere', state: 'OT', affiliation: 'Local 2' } },
                { chapter_id: 'chapter-b', union_orgs: null },
              ], error: null,
            }) };
          } };
        },
      };
    });

    const targets = await loadMobileHandshakeTargets('chapter-current');
    expect(eqCalls).toEqual([['status', 'verified']]);
    expect(selectCalls).toEqual([['chapter_id,union_orgs(id,name,city,state,affiliation)']]);
    expect(targets).toEqual([
      { id: 'org-a', name: 'Partner A', location: 'Elsewhere, OT', affiliation: 'Local 2' },
    ]);
  });

  it('binds every lifecycle write to its audited RPC and idempotency key', async () => {
    backend.rpc.mockResolvedValue({ data: {}, error: null });
    await requestMobileHandshake(businessWriter, { partnerOrgID: 'org-b', title: ' Training ', purpose: ' Share ', dataScope: 'docs_only', idempotencyKey: 'key-request' });
    await respondMobileHandshake(businessWriter, 'handshake-a', 'accept', 'key-accept');
    await respondMobileHandshake(businessWriter, 'handshake-b', 'decline', 'key-decline');
    await countersignMobileHandshake(businessWriter, 'handshake-c', 'key-sign');
    await closeMobileHandshake(businessWriter, 'handshake-d', 'key-close');
    expect(backend.rpc.mock.calls).toEqual([
      ['request_chapter_handshake', { p_partner_org_id: 'org-b', p_title: 'Training', p_purpose: 'Share', p_data_scope: 'docs_only', p_idempotency_key: 'key-request' }],
      ['respond_chapter_handshake', { p_handshake_id: 'handshake-a', p_decision: 'accept', p_idempotency_key: 'key-accept' }],
      ['respond_chapter_handshake', { p_handshake_id: 'handshake-b', p_decision: 'decline', p_idempotency_key: 'key-decline' }],
      ['countersign_chapter_handshake', { p_handshake_id: 'handshake-c', p_idempotency_key: 'key-sign' }],
      ['close_chapter_handshake', { p_handshake_id: 'handshake-d', p_idempotency_key: 'key-close' }],
    ]);
  });

  it('loads the privacy-safe portfolio and preserves every coaching attention level', async () => {
    const portfolio = [{ chapterId: 'chapter-a', chapterName: 'A', databaseDate: '2026-09-02', measuredOn: null, cohortProtected: true, memberCount: null, score: null, drivers: null, trend: [], coaching: [] }];
    backend.rpc
      .mockResolvedValueOnce({ data: portfolio, error: null })
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: {}, error: null });
    await expect(loadMobileHealthPortfolio()).resolves.toEqual(portfolio);
    await addMobileHealthCoaching(businessWriter, 'chapter-a', ' Capacity follow-up ', ' Review seats ', 'urgent');
    expect(backend.rpc).toHaveBeenLastCalledWith('add_chapter_health_coaching', {
      p_chapter_id: 'chapter-a',
      p_summary: 'Capacity follow-up',
      p_next_action: 'Review seats',
      p_attention_level: 'urgent',
    });
    await recordMobileHealthSnapshot(businessWriter, 'chapter-a', '2026-09-01', {
      participation: 81,
      caseTimeliness: 76,
      stewardCapacity: 68,
      trainingCoverage: 73,
      communicationReach: 85,
      governanceReadiness: 79,
    });
    expect(backend.rpc).toHaveBeenLastCalledWith('record_chapter_health_snapshot', {
      p_chapter_id: 'chapter-a',
      p_measured_on: '2026-09-01',
      p_participation: 81,
      p_case_timeliness: 76,
      p_steward_capacity: 68,
      p_training_coverage: 73,
      p_communication_reach: 85,
      p_governance_readiness: 79,
    });
  });

  it('fails closed when the portfolio omits the database calendar date', async () => {
    backend.rpc.mockResolvedValue({
      data: [{ chapterId: 'chapter-a', chapterName: 'A' }],
      error: null,
    });
    await expect(loadMobileHealthPortfolio()).rejects.toThrow('Campaign health dates could not be verified.');
  });

  it('projects server-confirmed organization and selected-chapter staff scope', async () => {
    backend.rpc.mockResolvedValue({
      data: {
        organizationId: 'organization-a',
        roles: ['advisor', 'bogus', 'advisor'],
        chapterRoles: ['steward', 'bogus', 'steward'],
        staffAuthorized: true,
      },
      error: null,
    });
    await expect(loadMobileStaffScope()).resolves.toEqual({
      organizationID: 'organization-a',
      roles: ['advisor'],
      chapterRoles: ['steward'],
      staffAuthorized: true,
    });
    expect(backend.rpc).toHaveBeenCalledWith('get_my_mobile_staff_scope');
  });
  it('distinguishes an unconfirmed staff projection from confirmed empty grants without changing the projection', async () => {
    const availability = vi.fn();
    for (const data of [null, {}, { organizationId: null, roles: [], staffAuthorized: false },
      { organizationId: 'org-a', roles: [17], chapterRoles: [], staffAuthorized: true }]) {
      backend.rpc.mockResolvedValue({ data, error: null });
      const scope = await loadMobileStaffScope(availability);
      expect(scope.roles).toEqual([]); expect(scope.chapterRoles).toEqual([]);
      expect(availability).toHaveBeenLastCalledWith(false);
    }
    backend.rpc.mockResolvedValue({ data: { organizationId: null, roles: [], chapterRoles: [], staffAuthorized: false }, error: null });
    await expect(loadMobileStaffScope(availability)).resolves.toEqual({ organizationID: null, roles: [], chapterRoles: [], staffAuthorized: false });
    expect(availability).toHaveBeenLastCalledWith(true);
    backend.rpc.mockResolvedValue({ data: null, error: new TypeError('Network failure') });
    await expect(loadMobileStaffScope(availability)).rejects.toThrow('Network failure');
  });
  it('distinguishes dropped or incomplete membership rows from confirmed empty membership', async () => {
    const availability = vi.fn();
    for (const data of [[{}], [{ chapterId: 'a', name: 'Campaign A', joinedAt: '2026-01-01' }]]) {
      backend.rpc.mockResolvedValue({ data, error: null });
      await loadMobileChapterMemberships(undefined, availability);
      expect(availability).toHaveBeenLastCalledWith(false);
    }
    backend.rpc.mockResolvedValue({ data: [], error: null });
    await expect(loadMobileChapterMemberships(undefined, availability)).resolves.toEqual([]);
    expect(availability).toHaveBeenLastCalledWith(true);
    backend.rpc.mockResolvedValue({ data: [{ chapterId: 'a', organizationId: 'org-a', name: 'Campaign A', joinedAt: '2026-01-01', selected: true }], error: null });
    expect((await loadMobileChapterMemberships(undefined, availability))[0]?.chapterID).toBe('a');
    expect(availability).toHaveBeenLastCalledWith(true);
  });
  it('preserves top-level refusal status for both scope reads', async () => {
    for (const read of [loadMobileStaffScope, loadMobileChapterMemberships]) {
      backend.rpc.mockResolvedValue({ data: null, error: new Error('Forbidden'), status: 403 });
      await expect(read()).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
    }
  });
  it('confirms an organization-only selection without adding it to campaign navigation', async () => {
    const selected = vi.fn();
    const availability = vi.fn();
    backend.rpc.mockResolvedValue({ data: [{ chapterId: null, organizationId: 'org-a', name: 'Organization A', joinedAt: '2026-01-01', selected: true }], error: null });
    await expect(loadMobileChapterMemberships(selected, availability)).resolves.toEqual([]);
    expect(selected).toHaveBeenLastCalledWith([{ chapterID: null, organizationID: 'org-a' }]);
    expect(availability).toHaveBeenLastCalledWith(true);
  });

  it('returns concise native errors when a lifecycle transition is rejected', async () => {
    backend.rpc.mockResolvedValue({ data: null, error: new Error('denied') });
    await expect(respondMobileHandshake(businessWriter, 'handshake-a', 'accept', 'key')).rejects.toThrow('The request changed or is no longer authorized.');
    await expect(addMobileHealthCoaching(businessWriter, 'chapter-a', 'Capacity follow-up', '', 'support')).rejects.toThrow('The coaching note was not confirmed.');
    await expect(recordMobileHealthSnapshot(businessWriter, 'chapter-a', '2026-09-01', {
      participation: 80, caseTimeliness: 80, stewardCapacity: 80,
      trainingCoverage: 80, communicationReach: 80, governanceReadiness: 80,
    })).rejects.toThrow('The health snapshot was not confirmed.');
  });
});
