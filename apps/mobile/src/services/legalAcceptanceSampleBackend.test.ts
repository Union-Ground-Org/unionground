import type { Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// BUG-UG-SAMPLE-ACCOUNTS-ASKED-TO-ACCEPT-TERMS-20261029. Owner ruling,
// October 29, 2026: "NO TERMS FOR SAMPLE. SAMPLE HAS NO REAL USERS". A build
// pinned to the SAMPLE project never reads or records a legal acceptance, so
// the Home card stays unrendered; a live build still reads and records.

const backend = vi.hoisted(() => ({
  config: { backendConfigured: true, supabaseUrl: '', supabasePublishableKey: 'publishable-test-key' },
  calls: [] as { name: string; token: string }[],
}));

vi.mock('../lib/config', async () => {
  const { pinnedSampleSupabaseOrigin } = await import('../../../../src/lib/sampleBackend');
  backend.config.supabaseUrl = pinnedSampleSupabaseOrigin();
  return { mobileConfig: backend.config };
});
vi.mock('./supabase', () => {
  const clientFor = (token: string) => ({
    rpc: async (name: string) => {
      backend.calls.push({ name, token });
      return name === 'record_legal_acceptance'
        ? { data: { recorded: true }, error: null }
        : { data: { versions: {}, acceptedAt: null }, error: null };
    },
  });
  return {
    getSupabaseClient: () => clientFor('shared-token'),
    createCapturedSessionRpcClient: (session: Session) => clientFor(session.access_token),
  };
});

import { pinnedSampleSupabaseOrigin } from '../../../../src/lib/sampleBackend';
import { legalAcceptanceVersions } from '../lib/legalAcceptance';
import { loadLegalAcceptance, recordLegalAcceptance } from './legalAcceptance';
import { bundledLegalReleaseFiles } from '../../../../src/lib/legalReleaseBundle.js';

// Since the first legal release, a live backend records an acceptance only
// with the proof the configured portal's /api/legal-pack?publication=1 returns
// once that release is live and its pack verified. Stand in for it here; every
// other request goes to the fetch the test already had.
const releaseStamp = bundledLegalReleaseFiles().stampText ?? '';
const parsedStamp: unknown = JSON.parse(releaseStamp || '{}');
const stampRelease: unknown = parsedStamp && typeof parsedStamp === 'object' ? Reflect.get(parsedStamp, 'release') : undefined;
const stampMigration: unknown = stampRelease && typeof stampRelease === 'object' ? Reflect.get(stampRelease, 'migrationId') : undefined;
const releaseId = typeof stampMigration === 'string' ? stampMigration : undefined;
let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => (
    String(input).endsWith('/api/legal-pack?publication=1')
      ? new Response(JSON.stringify({ stampJson: releaseStamp, liveReleaseIds: releaseId ? [releaseId] : [], verifiedPackReleaseIds: releaseId ? [releaseId] : [] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
      : realFetch(input, init)
  ));
});
afterEach(() => vi.unstubAllGlobals());


const session: Session = {
  access_token: 'fictional-token', refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer',
  user: { id: 'tamarack-member', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-29' },
};

describe('legal acceptance by backend', () => {
  beforeEach(() => {
    backend.calls.length = 0;
    backend.config.supabaseUrl = pinnedSampleSupabaseOrigin();
  });

  it('never reads or records an acceptance on the SAMPLE backend', async () => {
    expect(await loadLegalAcceptance()).toBeNull();
    expect(await recordLegalAcceptance(legalAcceptanceVersions(), 'TX', true, session)).toBe(false);
    expect(backend.calls).toEqual([]);
  });

  it('still reads and records on a live backend', async () => {
    backend.config.supabaseUrl = 'https://live-project.example.test';
    expect(await loadLegalAcceptance()).toEqual({ versions: {}, acceptedAt: null });
    expect(await recordLegalAcceptance(legalAcceptanceVersions(), 'TX', true, session)).toBe(true);
    expect(backend.calls).toEqual([
      { name: 'get_my_legal_acceptance_state', token: 'shared-token' },
      { name: 'record_legal_acceptance', token: 'fictional-token' },
    ]);
  });
});
