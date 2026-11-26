import { stubSessionWriter } from '../testing/stubSessionWriter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MobileConfig } from '../lib/configPolicy';

// SEC-CLEANROOM-UPLOAD-SECURITY-20260904 (inherited from Union Ground): the
// inspection request carries a live member bearer, so it goes only to the
// portal paired with the backend that issued it, and every other configuration
// is refused before the session is read or the network is touched.
//
// Union Ground ships with no trusted pair at all (configPolicy), so the two
// pairs below are fictional and exist only inside this suite's mock of the
// trust table. The refusal matrix also names the sibling product's hosts to
// prove they can never receive a Union Ground token.
//
// The 503 case below is a simulated unavailable scanner. It pins how the
// client behaves when the endpoint cannot answer.

const PAIRS = vi.hoisted(() => ({
  first: { backend: 'https://unionground-first.supabase.co', portal: 'https://first.unionground.example' },
  second: { backend: 'https://unionground-second.supabase.co', portal: 'https://second.unionground.example' },
}));

vi.mock('../lib/configPolicy', async (importOriginal) => {
  type ConfigPolicyModule = typeof import('../lib/configPolicy');
  const actual = await importOriginal<ConfigPolicyModule>();
  const table: Record<string, string> = {
    [PAIRS.first.backend]: PAIRS.first.portal,
    [PAIRS.second.backend]: PAIRS.second.portal,
  };
  return {
    ...actual,
    trustedPortalForBackend: (url: unknown) => (typeof url === 'string' && Object.hasOwn(table, url) ? table[url] : null),
  };
});

const mocks = vi.hoisted(() => ({
  fetchImpl: vi.fn(),
  config: {} as Record<string, unknown>,
}));

vi.mock('../lib/config', () => ({ mobileConfig: mocks.config }));

import { PrivateFileError, privateFileApiOrigin, requestPrivateFileInspection as rawRequestPrivateFileInspection } from './privateFileAccess';

const requestPrivateFileInspection: typeof rawRequestPrivateFileInspection = (client, kind, id, options = {}) => {
  const writer = stubSessionWriter(() => client);
  writer.session = async () => {
    const result = await client.auth.getSession();
    if (result.error || !result.data.session) throw new PrivateFileError('reauth-required');
    return result.data.session;
  };
  return rawRequestPrivateFileInspection(client, kind, id, { ...options, writer });
};

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const KEY = 'sb_publishable_test-key';
type SessionRead = { data: { session: { access_token: string } | null }; error: unknown };
const getSession = vi.fn<() => Promise<SessionRead>>();
// The module only reads client.auth.getSession(); a fake shaped exactly like
// that read is comparable to the real client type without a double assertion.
type SessionReader = { auth: { getSession(): Promise<SessionRead> } };
const sessionReader: SessionReader = { auth: { getSession: () => getSession() } };
const client = sessionReader as Parameters<typeof requestPrivateFileInspection>[0];

function useConfig(config: Partial<MobileConfig>) {
  for (const key of Object.keys(mocks.config)) delete mocks.config[key];
  Object.assign(mocks.config, { supabasePublishableKey: KEY, compassNetworkEnabled: false, previewEnabled: false }, config);
}

function clean() {
  return new Response(JSON.stringify({ fileId: FILE_ID, status: 'clean' }), { status: 200 });
}

type AdmittedPair = { surface: string; backend: string; portal: string; token: string };
const ADMITTED: AdmittedPair[] = [
  { surface: 'first', backend: PAIRS.first.backend, portal: PAIRS.first.portal, token: 'first-session-token' },
  { surface: 'second', backend: PAIRS.second.backend, portal: PAIRS.second.portal, token: 'second-session-token' },
];

function admitted(backend: string, portal: string): Partial<MobileConfig> {
  return { backendConfigured: true, supabaseUrl: backend, portalBaseUrl: portal };
}

const FIRST = PAIRS.first;
const SECOND = PAIRS.second;
// Configurations that must never post a token anywhere.
const REFUSED: Array<[string, Partial<MobileConfig>]> = [
  ['a backend paired with the other portal', { supabaseUrl: FIRST.backend, portalBaseUrl: SECOND.portal }],
  ['the sibling SAMPLE pair', { supabaseUrl: 'https://unionground-sample.supabase.co', portalBaseUrl: 'https://sibling-product.example' }],
  ['the sibling production pair', { supabaseUrl: 'https://productionprojectref.supabase.co', portalBaseUrl: 'https://sibling-saas.example' }],
  ['an approved backend with a sibling portal', { supabaseUrl: FIRST.backend, portalBaseUrl: 'https://sibling-saas.example' }],
  ['an unknown backend with an approved portal', { supabaseUrl: 'https://attacker.example', portalBaseUrl: FIRST.portal }],
  ['a look-alike backend host', { supabaseUrl: `${FIRST.backend}.attacker.example`, portalBaseUrl: FIRST.portal }],
  ['a look-alike portal host', { supabaseUrl: FIRST.backend, portalBaseUrl: `${FIRST.portal}.attacker.example` }],
  ['credentials in the portal URL', { supabaseUrl: FIRST.backend, portalBaseUrl: 'https://member:secret@first.unionground.example' }],
  ['a portal path', { supabaseUrl: FIRST.backend, portalBaseUrl: `${FIRST.portal}/proxy` }],
  ['a portal trailing slash', { supabaseUrl: FIRST.backend, portalBaseUrl: `${FIRST.portal}/` }],
  ['a portal query', { supabaseUrl: FIRST.backend, portalBaseUrl: `${FIRST.portal}?next=https://attacker.example` }],
  ['a portal fragment', { supabaseUrl: FIRST.backend, portalBaseUrl: `${FIRST.portal}#attacker` }],
  ['a plain-HTTP portal', { supabaseUrl: FIRST.backend, portalBaseUrl: 'http://first.unionground.example' }],
  ['a different port', { supabaseUrl: FIRST.backend, portalBaseUrl: `${FIRST.portal}:8443` }],
  ['a backend path', { supabaseUrl: `${FIRST.backend}/rest`, portalBaseUrl: FIRST.portal }],
  ['a prototype key as the backend', { supabaseUrl: 'constructor', portalBaseUrl: FIRST.portal }],
  ['the unprovisioned placeholder', { supabaseUrl: null, portalBaseUrl: 'https://unionground.invalid' }],
  ['no backend', { supabaseUrl: null, portalBaseUrl: FIRST.portal }],
];

describe('private-file inspection origin', () => {
  beforeEach(() => {
    mocks.fetchImpl.mockReset();
    getSession.mockReset();
    vi.stubGlobal('fetch', mocks.fetchImpl);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(ADMITTED)('posts a $surface inspection only to its own portal, with its own bearer', async ({ backend, portal, token }) => {
    useConfig(admitted(backend, portal));
    getSession.mockResolvedValue({ data: { session: { access_token: token } }, error: null });
    mocks.fetchImpl.mockResolvedValueOnce(clean());

    await expect(requestPrivateFileInspection(client, 'knowledge', FILE_ID)).resolves.toEqual({ fileID: FILE_ID, status: 'clean' });

    expect(getSession).toHaveBeenCalledOnce();
    expect(mocks.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = mocks.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${portal}/api/private-files`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ kind: 'knowledge', fileId: FILE_ID }));
  });

  it('never sends a token to the other surface', async () => {
    for (const { backend, portal, token } of ADMITTED) {
      useConfig(admitted(backend, portal));
      getSession.mockResolvedValue({ data: { session: { access_token: token } }, error: null });
      mocks.fetchImpl.mockResolvedValueOnce(clean());
      await requestPrivateFileInspection(client, 'knowledge', FILE_ID);
      expect(privateFileApiOrigin()).toBe(portal);
    }
    const sent = (mocks.fetchImpl.mock.calls as [string, RequestInit][])
      .map(([url, init]) => [new URL(url).origin, (init.headers as Record<string, string>).Authorization]);
    expect(sent).toEqual([
      [FIRST.portal, 'Bearer first-session-token'],
      [SECOND.portal, 'Bearer second-session-token'],
    ]);
  });

  it.each(REFUSED)('refuses %s before reading the session or the network', async (_label, overrides) => {
    useConfig({ backendConfigured: true, ...overrides });
    getSession.mockResolvedValue({ data: { session: { access_token: 'member-access-token' } }, error: null });

    expect(() => privateFileApiOrigin()).toThrow(PrivateFileError);
    const error = await requestPrivateFileInspection(client, 'knowledge', FILE_ID, { attempts: 1 }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PrivateFileError);
    expect((error as PrivateFileError).code).toBe('unavailable');
    expect(getSession).not.toHaveBeenCalled();
    expect(mocks.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an approved pair the manifest did not configure', async () => {
    // A placeholder or legacy key leaves backendConfigured false.
    useConfig({ ...admitted(FIRST.backend, FIRST.portal), backendConfigured: false });
    await expect(requestPrivateFileInspection(client, 'knowledge', FILE_ID, { attempts: 1 })).rejects.toMatchObject({ code: 'unavailable' });
    expect(getSession).not.toHaveBeenCalled();
    expect(mocks.fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a simulated unavailable scanner (503 file-check-unavailable) as a retryable unavailable check after three attempts, never as a rejection', async () => {
    useConfig(admitted(FIRST.backend, FIRST.portal));
    getSession.mockResolvedValue({ data: { session: { access_token: 'first-session-token' } }, error: null });
    vi.useFakeTimers();
    try {
      mocks.fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ error: 'file-check-unavailable' }), { status: 503 }));
      const pending = requestPrivateFileInspection(client, 'knowledge', FILE_ID);
      const settled = pending.then(() => 'resolved', (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(3000);
      const error = await settled;
      expect(error).toBeInstanceOf(PrivateFileError);
      expect((error as PrivateFileError).code).toBe('unavailable');
      expect((error as PrivateFileError).retryable).toBe(true);
      expect(mocks.fetchImpl).toHaveBeenCalledTimes(3);
      for (const [url] of mocks.fetchImpl.mock.calls as [string][]) expect(url).toBe(`${FIRST.portal}/api/private-files`);
    } finally {
      vi.useRealTimers();
    }
  });
});
