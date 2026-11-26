import type { Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => {
  const writes: { token: string; state: unknown; attested: unknown }[] = [];
  return {
    writes,
    clientFor: (token: string) => ({
      rpc: async (_name: string, args: Record<string, unknown>) => {
        writes.push({ token, state: args.p_residence_state, attested: args.p_age_attested });
        return { data: { recorded: true }, error: null };
      },
    }),
  };
});
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://live-project.example.test' } }));
vi.mock('./supabase', () => ({
  getSupabaseClient: () => auth.clientFor('replacement-token'),
  createCapturedSessionRpcClient: (session: Session) => auth.clientFor(session.access_token),
}));

import { recordLegalAcceptance } from './legalAcceptance';
import { legalAcceptanceVersions } from '../lib/legalAcceptance';
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


beforeEach(() => { auth.writes.length = 0; });

it('dispatches consent with the initiating credential even if shared Auth changes after the card guard', async () => {
  const initiatingSession: Session = {
    access_token: 'initiating-token', refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer',
    user: { id: 'member-a', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-20' },
  };
  expect(await recordLegalAcceptance(legalAcceptanceVersions(), 'TX', true, initiatingSession)).toBe(true);
  expect(auth.writes).toEqual([{ token: 'initiating-token', state: 'TX', attested: true }]);
});
