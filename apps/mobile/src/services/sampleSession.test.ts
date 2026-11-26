import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Union Ground pins no live SAMPLE project (config/sample-backend.json), so
// the shipped app never opens a persona session. This suite pins a fictional
// project to exercise the flow that would run once one is approved.
vi.mock('../../../../src/lib/sampleBackend', async (importOriginal) => {
  type SampleBackendModule = typeof import('../../../../src/lib/sampleBackend');
  const actual = await importOriginal<SampleBackendModule>();
  return {
    ...actual,
    pinnedSampleSupabaseOrigin: () => 'https://unionground-sample.supabase.co',
    samplePortalOrigin: () => 'https://sample.unionground.example',
  };
});

import { samplePersonaForHat, samplePersonas } from '../../../../src/lib/sampleBackend';
import {
  DEFAULT_SAMPLE_HAT, SAMPLE_HATS, SAMPLE_UNAVAILABLE, openSampleSession, isLiveSampleBackend, sampleHatForSession, switchSampleSession,
} from './sampleSession';

const config = { backendConfigured: true, supabaseUrl: 'https://unionground-sample.supabase.co' };
const auth = {
  getSession: vi.fn(),
  setSession: vi.fn(),
};
const fetchMock = vi.fn();
// The endpoint's success shape (L177, UB-UNIONGROUND-DEMO-STRAIGHT-IN-ENTRY-
// RESTORED-20261107): the persona's session token pair, adopted by the
// pinned Auth client.
const minted = { accessToken: 'test-access-token', refreshToken: 'test-refresh-token' };
const adopted = { access_token: 'test-access-token', refresh_token: 'test-refresh-token' };
function personaEmail(hat: string): string {
  const persona = samplePersonaForHat(hat);
  if (!persona) throw new Error(`No SAMPLE persona for ${hat}`);
  return persona.email;
}

// UB-UG-NATIVE-DEMO-ENTRY-RESTORED-20261107 (owner ruling, Nov 7,
// 2026): the roster the hat switcher offers is the server's persona list, one
// role per seeded account, named with role words only.
describe('SAMPLE demo roster', () => {
  it('offers every role the server mints, in its order, named by role alone', () => {
    // The server's "organize" persona is the app's Organizer hat.
    expect(SAMPLE_HATS.map((hat) => hat.key)).toEqual(samplePersonas().map((persona) => persona.hat === 'organize' ? 'organizer' : persona.hat));
    expect(SAMPLE_HATS.map((hat) => hat.key)).toEqual(['member', 'organizer', 'steward', 'coordinator', 'advisor', 'admin', 'vp']);
    expect(SAMPLE_HATS.map((hat) => hat.label)).toEqual(['Worker', 'Organizer', 'Committee', 'Campaign lead', 'Advisor', 'Admin', 'Campaign chair']);
    for (const hat of SAMPLE_HATS) {
      expect(hat.description.length, hat.key).toBeGreaterThan(10);
      for (const persona of samplePersonas()) {
        expect(hat.description, hat.key).not.toContain(persona.fullName);
        expect(hat.description, hat.key).not.toContain(persona.email);
      }
      // Tamarack is a fictional union with no dues.
      expect(hat.description, hat.key).not.toMatch(/\bdues\b/i);
    }
  });

  it('starts as the worker hat, every other role one switch away', () => {
    expect(DEFAULT_SAMPLE_HAT).toBe('member');
    expect(SAMPLE_HATS[0]?.key).toBe('member');
  });
});

describe('password-free native SAMPLE entry', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    auth.setSession.mockResolvedValue({ error: null });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => minted });
  });

  it('signs the worker persona in through the SAMPLE endpoint and adopts its session through ordinary Auth', async () => {
    await openSampleSession(config, auth);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('https://sample.unionground.example/api/demo-session', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ hat: 'member' }), redirect: 'error',
    }));
    expect(auth.setSession).toHaveBeenCalledOnce();
    expect(auth.setSession).toHaveBeenCalledWith(adopted);
  });

  it.each(['steward', 'coordinator', 'advisor', 'admin', 'vp'])('signs the %s persona in on request', async (hat) => {
    await openSampleSession(config, auth, () => true, hat);
    expect(fetchMock).toHaveBeenCalledWith('https://sample.unionground.example/api/demo-session', expect.objectContaining({ body: JSON.stringify({ hat }) }));
    expect(auth.setSession).toHaveBeenCalledOnce();
  });

  it('sends the hat and nothing else: no account, password or key leaves the app', async () => {
    await openSampleSession(config, auth);
    expect(fetchMock).toHaveBeenCalledWith('https://sample.unionground.example/api/demo-session', expect.objectContaining({
      body: '{"hat":"member"}', headers: { 'Content-Type': 'application/json' },
    }));
  });

  it.each([
    { ...config, backendConfigured: false },
    { ...config, supabaseUrl: 'https://unionground-live.supabase.co' },
    { ...config, supabaseUrl: 'https://unapproved.supabase.co' },
    { ...config, supabaseUrl: config.supabaseUrl + '/auth/v1' },
  ])('refuses an unconfigured or non-SAMPLE client before any request', async (candidate) => {
    expect(isLiveSampleBackend(candidate)).toBe(false);
    await expect(openSampleSession(candidate, auth)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it.each(['president', 'public', 'worker ', 'toString', ''])('refuses a hat the server does not mint before any request: %j', async (hat) => {
    await expect(openSampleSession(config, auth, () => true, hat)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it('does not replace a restored session', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'existing' } } }, error: null });
    await expect(openSampleSession(config, auth)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not continue after storage recovery fails', async () => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: new Error('private detail') });
    await expect(openSampleSession(config, auth)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {}, { tokenHash: 'the pre-#4696 shape' }, { accessToken: 'a' }, { refreshToken: 'r' },
    { accessToken: '', refreshToken: 'r' }, { accessToken: 'a', refreshToken: ' ' }, { accessToken: 42, refreshToken: 'r' },
    { accessToken: 'x'.repeat(16385), refreshToken: 'r' }, { accessToken: 'a', refreshToken: 'x'.repeat(1025) }, null, 'token',
  ])('rejects a missing or malformed session answer: %j', async (payload) => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    await expect(openSampleSession(config, auth)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it.each([400, 404, 405, 410])('treats a %s from the endpoint as final: no retry, nothing adopted', async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ error: 'private detail' }) });
    await expect(openSampleSession(config, auth)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it('retries a 503 (persona busy or taken by another visitor) once, then gives up', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'persona-unavailable' }) });
    await expect(openSampleSession(config, auth)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it('enters on the second request when the first answered 503', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'persona-unavailable' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => minted });
    await expect(openSampleSession(config, auth)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.setSession).toHaveBeenCalledOnce();
  });

  it('does not retry when Auth refuses the returned session', async () => {
    auth.setSession.mockResolvedValue({ error: new Error('provider private detail') });
    await expect(openSampleSession(config, auth)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.setSession).toHaveBeenCalledOnce();
  });

  it('does not adopt a session after the caller abandons entry', async () => {
    let wanted = true;
    fetchMock.mockImplementation(async () => {
      wanted = false;
      return { ok: true, status: 200, json: async () => minted };
    });
    await expect(openSampleSession(config, auth, () => wanted)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it('does not replace a session restored during the network request', async () => {
    auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'restored' } } }, error: null });
    await expect(openSampleSession(config, auth)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it('reports endpoint failures in product words without provider details', async () => {
    fetchMock.mockRejectedValue(new Error('private response token'));
    await expect(openSampleSession(config, auth)).rejects.toThrow(/^The demo is unavailable right now\. Try again\.$/);
    expect(auth.setSession).not.toHaveBeenCalled();
  });
});

describe('live SAMPLE identity switching', () => {
  const member = { user: { email: personaEmail('member') } };
  const steward = { user: { email: personaEmail('steward') } };
  afterEach(() => vi.unstubAllGlobals());

  it('recognizes only the seeded personas on the pinned SAMPLE backend', () => {
    expect(sampleHatForSession(config, member)).toBe('member');
    expect(sampleHatForSession(config, steward)).toBe('steward');
    expect(sampleHatForSession(config, { user: { email: personaEmail('vp').toUpperCase() } })).toBe('vp');
    expect(sampleHatForSession(config, { user: { email: 'real@example.com' } })).toBeNull();
    // A fictional SAMPLE organization account that is not a persona signs in
    // with its own password and gets no switcher.
    expect(sampleHatForSession(config, { user: { email: 'someone.else@loadtest.example.com' } })).toBeNull();
    expect(sampleHatForSession({ ...config, supabaseUrl: 'https://other.supabase.co' }, steward)).toBeNull();
    expect(sampleHatForSession(config, null)).toBeNull();
    expect(sampleHatForSession(config, { user: { email: 42 } })).toBeNull();
    expect(sampleHatForSession(config, { user: null })).toBeNull();
  });

  it('finishes ordinary sign-out before minting the requested persona', async () => {
    const events: string[] = [];
    let session: typeof member | null = member;
    const client = {
      getSession: async () => ({ data: { session }, error: null }),
      setSession: async () => { events.push('adopt'); return { error: null }; },
    };
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      expect(JSON.parse(String(options.body))).toEqual({ hat: 'steward' });
      events.push('mint');
      return { ok: true, status: 200, json: async () => minted };
    });
    await switchSampleSession(config, client, 'member', 'steward', async () => {
      events.push('cleanup'); session = null;
    });
    expect(events).toEqual(['cleanup', 'mint', 'adopt']);
  });

  it('does not mint if sign-out leaves the original session intact', async () => {
    const client = { getSession: async () => ({ data: { session: steward }, error: null }), setSession: vi.fn() };
    vi.stubGlobal('fetch', vi.fn());
    await expect(switchSampleSession(config, client, 'steward', 'member', async () => {})).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(client.setSession).not.toHaveBeenCalled();
  });

  it('keeps the session and push installation when selecting the active hat', async () => {
    const cleanup = vi.fn();
    const client = { getSession: async () => ({ data: { session: steward }, error: null }), setSession: vi.fn() };
    await expect(switchSampleSession(config, client, 'steward', 'steward', cleanup)).resolves.toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
    expect(client.setSession).not.toHaveBeenCalled();
  });

  it('refuses switching when the identity changed or the target is not allowlisted', async () => {
    const cleanup = vi.fn();
    const client = { getSession: async () => ({ data: { session: steward }, error: null }), setSession: vi.fn() };
    await expect(switchSampleSession(config, client, 'member', 'admin', cleanup)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    await expect(switchSampleSession(config, client, 'steward', 'unknown', cleanup)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    await expect(switchSampleSession(config, client, 'steward', 'member', cleanup, () => false)).rejects.toThrow(SAMPLE_UNAVAILABLE);
    expect(cleanup).not.toHaveBeenCalled();
    expect(client.setSession).not.toHaveBeenCalled();
  });
});
