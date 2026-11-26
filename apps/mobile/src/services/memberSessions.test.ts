import { beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009: the native read of
// `public.list_my_sessions()`. The server is the authority, so the cases below
// pin that an answer which is not a list is a refusal, and that the three
// failure kinds a member can read are told apart by what actually failed.
const backend = vi.hoisted(() => ({ rpc: vi.fn(), client: null as unknown }));

vi.mock('./supabase', () => ({ getSupabaseClient: () => backend.client }));

const {
  MemberSessionsUnavailableError,
  classifyMemberSessionsFailure,
  loadMemberSessions,
} = await import('./memberSessions');

const handle = 'c'.repeat(64);

beforeEach(() => {
  backend.rpc.mockReset();
  backend.client = { rpc: backend.rpc };
});

describe('classifyMemberSessionsFailure', () => {
  it('reads the server 42501 as a session no longer accepted', () => {
    // list_my_sessions raises 42501 when the JWT names a session that is no
    // longer in auth.sessions: revoked elsewhere, expired, or reset. That is
    // the one failure the member can act on, and it is not a service fault.
    expect(classifyMemberSessionsFailure({ code: '42501', message: 'worker session required' })).toBe('denied');
  });

  it('reads an answered status or a PostgREST code as the service', () => {
    expect(classifyMemberSessionsFailure({ status: 502 })).toBe('service');
    expect(classifyMemberSessionsFailure({ code: 'PGRST202' })).toBe('service');
    expect(classifyMemberSessionsFailure({ code: 'pgrst116', status: 0 })).toBe('service');
  });

  it('keeps everything unproven on the connection, including a request that never arrived', () => {
    expect(classifyMemberSessionsFailure({ status: 0, code: '' })).toBe('transport');
    expect(classifyMemberSessionsFailure({ code: 'ENOTFOUND' })).toBe('transport');
    expect(classifyMemberSessionsFailure(new Error('Network request failed'))).toBe('transport');
    expect(classifyMemberSessionsFailure(null)).toBe('transport');
  });
});

describe('loadMemberSessions', () => {
  it('returns the server rows, current first, with nothing added locally', async () => {
    backend.rpc.mockResolvedValue({
      data: [
        { handle: 'd'.repeat(64), deviceLabel: 'windows_computer', browserLabel: 'edge', current: false, createdAt: '2026-10-01T10:00:00.000Z', lastActiveAt: '2026-10-09T10:00:00.000Z' },
        { handle, deviceLabel: 'apple_mobile', browserLabel: 'safari', current: true, createdAt: '2026-10-09T10:00:00.000Z', lastActiveAt: '2026-10-10T02:00:00.000Z' },
      ],
      error: null,
    });
    const rows = await loadMemberSessions();
    expect(backend.rpc).toHaveBeenCalledWith('list_my_sessions');
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    expect(rows.map((row) => [row.handle, row.current])).toEqual([[handle, true], ['d'.repeat(64), false]]);
  });

  it('returns an empty list only when the server sent one', async () => {
    backend.rpc.mockResolvedValue({ data: [], error: null });
    await expect(loadMemberSessions()).resolves.toEqual([]);
  });

  it('refuses an answer that is not a list instead of showing an empty state', async () => {
    backend.rpc.mockResolvedValue({ data: { handle }, error: null });
    await expect(loadMemberSessions()).rejects.toMatchObject({
      name: 'MemberSessionsUnavailableError',
      kind: 'service',
    });
  });

  it('reads an answered 502 whose status sits only on the response as the service', async () => {
    // postgrest-js answers a non-JSON gateway error with an error that holds
    // only a message; the HTTP status stays on the response.
    backend.rpc.mockResolvedValue({ data: null, error: { message: 'Bad Gateway' }, status: 502 });
    await expect(loadMemberSessions()).rejects.toMatchObject({ kind: 'service' });
    backend.rpc.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' }, status: 0 });
    await expect(loadMemberSessions()).rejects.toMatchObject({ kind: 'transport' });
  });

  it('carries the classified kind out of an errored call', async () => {
    backend.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'worker session required' } });
    await expect(loadMemberSessions()).rejects.toMatchObject({ kind: 'denied' });
    backend.rpc.mockResolvedValue({ data: null, error: { status: 0, code: '', message: 'TypeError: Network request failed' } });
    await expect(loadMemberSessions()).rejects.toMatchObject({ kind: 'transport' });
  });

  it('lets a transport rejection escape unclassified rather than reporting a list', async () => {
    backend.rpc.mockRejectedValue(new Error('Network request failed'));
    await expect(loadMemberSessions()).rejects.toThrow('Network request failed');
  });

  it('refuses when no backend is configured', async () => {
    backend.client = null;
    await expect(loadMemberSessions()).rejects.toBeInstanceOf(MemberSessionsUnavailableError);
    expect(backend.rpc).not.toHaveBeenCalled();
  });
});
