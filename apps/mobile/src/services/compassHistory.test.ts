import { stubSessionWriter } from '../testing/stubSessionWriter';
import { getSupabaseClient as protocolTestClient } from './supabase';
const testWriter = stubSessionWriter(protocolTestClient);
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompassMessage } from '../models/member';

const backend = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn(),
  },
}));

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => backend,
  processLock: vi.fn(),
}));
vi.mock('../lib/config', () => ({
  mobileConfig: {
    backendConfigured: true,
    supabaseUrl: 'https://unionground-sample.supabase.co',
    supabasePublishableKey: 'publishable-test-key',
    compassNetworkEnabled: true,
    portalBaseUrl: 'https://sample.unionground.example',
  },
}));
vi.mock('../lib/secureSessionStorage', () => ({
  createBackendScopedSessionStorage: () => ({}),
}));

import { askCompass, compactCompassHistory } from './supabase';

function readRepositorySource(path: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../..', path), 'utf8');
}

function alternatingTranscript(count: number): CompassMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const turn = Math.floor(index / 2) + 1;
    const isUser = index % 2 === 0;
    return {
      id: `m${index + 1}`,
      role: isUser ? 'user' : 'assistant',
      body: isUser ? `member-turn-${turn}` : `assistant-unique-body-${turn}`,
    };
  });
}

function capturedHistory() {
  const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  const payload = JSON.parse(String(init.body)) as {
    question: string;
    history: { role: string; body: string }[];
  };
  return { raw: String(init.body), payload };
}

describe('mobile Guide history compaction', () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ answer: 'ok', sources: [] }),
    });
    backend.auth.getSession.mockReset();
    backend.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'test-token' } },
      error: null,
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('sends the five worker turns from a ten-message alternating transcript', async () => {
    const transcript = alternatingTranscript(10);
    await askCompass(testWriter, 'Follow up', transcript);
    const { payload } = capturedHistory();
    expect(payload.history).toEqual([
      { role: 'user', body: 'member-turn-1' },
      { role: 'user', body: 'member-turn-2' },
      { role: 'user', body: 'member-turn-3' },
      { role: 'user', body: 'member-turn-4' },
      { role: 'user', body: 'member-turn-5' },
    ]);
    expect(compactCompassHistory(transcript)).toEqual(payload.history);
  });

  it('sends the six most recent worker turns from a sixteen-message transcript', async () => {
    const transcript = alternatingTranscript(16);
    await askCompass(testWriter, 'Follow up', transcript);
    const { payload } = capturedHistory();
    expect(payload.history).toEqual([
      { role: 'user', body: 'member-turn-3' },
      { role: 'user', body: 'member-turn-4' },
      { role: 'user', body: 'member-turn-5' },
      { role: 'user', body: 'member-turn-6' },
      { role: 'user', body: 'member-turn-7' },
      { role: 'user', body: 'member-turn-8' },
    ]);
    expect(compactCompassHistory(transcript)).toEqual(payload.history);
  });

  it('never serializes an assistant role or assistant body', async () => {
    const transcript = alternatingTranscript(16);
    await askCompass(testWriter, 'Follow up', transcript);
    const { raw, payload } = capturedHistory();
    expect(payload.history.every((item) => item.role === 'user')).toBe(true);
    expect(raw).not.toContain('"assistant"');
    expect(raw).not.toMatch(/assistant-unique-body-\d+/);
  });

  // The web client stopped forwarding history and api/guide.js discards any
  // client history (older native builds included), because saved conversations
  // carry no organization binding. The bounded member-only payload above is
  // therefore never forwarded to a model.
  // PHASE-2-WEB-PARITY: compares with the web Guide client, which is synced
  // from Union Ground in the web phase. Re-enable with that change.
  it.skip('relies on the server discarding client history, as the web client does', () => {
    const web = readRepositorySource('src/lib/guideApi.js');
    expect(web).not.toContain('compactHistory');
    expect(web).not.toMatch(/\bhistory:/);
    const server = readRepositorySource('api/guide.js');
    expect(server).toContain('buildGuideMessages(question, portalContext, [], grounded, reader)');
    expect(server).not.toContain('request.body?.history');
  });
});
