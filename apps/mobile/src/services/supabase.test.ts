import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

const backend = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  auth: { getSession: vi.fn(), setSession: vi.fn(), dispose: vi.fn(), updateUser: vi.fn(), mfa: { getAuthenticatorAssuranceLevel: vi.fn() } },
}));

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {
  releaseEnvironment: 'development', shareRecoveryTestHook: true,
  supabaseUrl: 'https://unionground-sample.supabase.co',
} } } }));
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

import { captureSessionWriter, loadDashboard, loadMobileBallots, normalizeMobileSmsPhone, setMobileSmsConsent, updateSignedInPassword, sessionNeedsMfa } from './supabase';
import { NEW_PASSWORD_MIN } from '../../../../src/lib/passwordPolicy.js';
import type { ShareRecoveryTestControl } from './shareRecoveryTestHook';

type Call = [string, ...unknown[]];
const accountSession = { access_token: `e30.${btoa(JSON.stringify({ sub: 'member-a', session_id: '5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10' }))}.sig0`, user: { id: 'member-a' } } as Session;
beforeEach(() => {
  backend.auth.getSession.mockResolvedValue({ data: { session: accountSession }, error: null });
  backend.auth.setSession.mockResolvedValue({ data: { session: accountSession }, error: null });
});

it('preserves each vote campaign scope for access labels without inferring one on legacy rows', async () => {
  const calls: Call[] = [];
  backend.from.mockImplementation((table: string) => recordingQuery(calls, table === 'member_ballots' ? [
    { id: 'chapter', title: 'Campaign vote', closes_at: '2099-01-01', chapter_id: 'north' },
    { id: 'union', title: 'Union vote', closes_at: '2099-01-01', chapter_id: null },
    { id: 'legacy', title: 'Legacy vote', closes_at: '2099-01-01' },
  ] : []));
  expect((await loadMobileBallots()).map(({ id, chapterId }) => ({ id, chapterId }))).toEqual([
    { id: 'chapter', chapterId: 'north' }, { id: 'union', chapterId: null }, { id: 'legacy', chapterId: null },
  ]);
  expect(calls.some(([method, columns]) => method === 'select' && typeof columns === 'string' && columns.split(',').includes('chapter_id'))).toBe(true);
});

describe('organization-required two-step', () => {
  it('blocks an unenrolled worker and keeps a satisfied session open', async () => {
    backend.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null });
    backend.rpc.mockResolvedValue({ data: { required: true, enrolled: false }, error: null });
    expect(await sessionNeedsMfa()).toBe(true);
    expect(backend.rpc).toHaveBeenCalledWith('get_my_mfa_requirement');
    backend.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null });
    expect(await sessionNeedsMfa()).toBe(false);
  });
  it('tolerates only an additive RPC missing during rollout', async () => {
    backend.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null });
    backend.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    expect(await sessionNeedsMfa()).toBe(false);
    backend.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(sessionNeedsMfa()).rejects.toMatchObject({ code: '42501' });
  });
});

describe('SMS phone input', () => {
  beforeEach(() => backend.rpc.mockReset().mockResolvedValue({ data: { consented: true }, error: null }));

  it.each(['+1 508 555 0123', '+1 (508) 555-0123', '+1.508.555.0123'])('saves formatted %s as a canonical number', async (input) => {
    expect(normalizeMobileSmsPhone(input)).toBe('+15085550123');
    await setMobileSmsConsent(input, true, captureSessionWriter(accountSession));
    expect(backend.rpc).toHaveBeenCalledWith('set_my_sms_consent', {
      p_phone_e164: '+15085550123', p_consented: true,
    });
  });

  it.each(['++1 508 555 0123', '+1 508/555/0123', '+1 508 555 ABCD', '5085550123', '+0123456789', '+1234567890123456'])('rejects malformed %s before the RPC', async (input) => {
    expect(normalizeMobileSmsPhone(input)).toBeNull();
    await expect(setMobileSmsConsent(input, true, captureSessionWriter(accountSession))).rejects.toThrow('SMS consent was not changed.');
    expect(backend.rpc).not.toHaveBeenCalled();
  });

  it('keeps opting out independent of the phone field', async () => {
    await setMobileSmsConsent('not a number', false, captureSessionWriter(accountSession));
    expect(backend.rpc).toHaveBeenCalledWith('set_my_sms_consent', { p_phone_e164: null, p_consented: false });
  });
});

it('rejects passwords below the shared minimum before Auth and accepts its exact boundary', async () => {
  backend.auth.updateUser.mockReset().mockResolvedValue({ error: null });
  await expect(updateSignedInPassword('a'.repeat(NEW_PASSWORD_MIN - 1), 'old123', accountSession)).rejects.toThrow(`Use at least ${NEW_PASSWORD_MIN} characters.`);
  expect(backend.auth.updateUser).not.toHaveBeenCalled();
  await updateSignedInPassword('a'.repeat(NEW_PASSWORD_MIN), ' old123 ', accountSession);
  expect(backend.auth.updateUser).toHaveBeenNthCalledWith(1, { password: 'a'.repeat(NEW_PASSWORD_MIN), current_password: ' old123 ' });
  expect(backend.auth.updateUser).toHaveBeenNthCalledWith(2, { data: { union_ground_password_issued_at: null } });
});

it('rejects missing current-password proof before Auth', async () => {
  backend.auth.updateUser.mockReset();
  await expect(updateSignedInPassword('a'.repeat(NEW_PASSWORD_MIN), '')).rejects.toThrow('Enter your current password');
  expect(backend.auth.updateUser).not.toHaveBeenCalled();
});

it.each([
  ['current_password_required', 'Check your current password'],
  ['current_password_invalid', 'Check your current password'],
  ['current_password_mismatch', 'Check your current password'],
  ['reauthentication_needed', 'sign out, sign in again'],
  ['reauthentication_not_valid', 'sign out, sign in again'],
  ['unexpected_failure', 'could not be confirmed'],
])('handles %s without clearing the issued-password prompt', async (code, message) => {
  backend.auth.updateUser.mockReset().mockResolvedValue({ error: { code } });
  await expect(updateSignedInPassword('a'.repeat(NEW_PASSWORD_MIN), 'old123', accountSession)).rejects.toThrow(message);
  expect(backend.auth.updateUser).toHaveBeenCalledTimes(1);
});

it('holds only an explicit refresh after every read, while bootstrap and the next account can complete', async () => {
  vi.stubGlobal('__DEV__', true);
  const { installShareRecoveryTestHook } = await import('./shareRecoveryTestHook');
  installShareRecoveryTestHook(async () => undefined);
  const host = globalThis as typeof globalThis & { __unionGroundShareRecoveryTest?: ShareRecoveryTestControl };
  const point = host.__unionGroundShareRecoveryTest!.boundaries.notifications;
  const run = point.arm();
  try {
    let user = 'account-a';
    backend.rpc.mockResolvedValue({ data: [], error: null });
    backend.from.mockImplementation((table: string) => {
      const data = table === 'member_profiles'
        ? { id: user, first_name: user, full_name: user, language: 'en' }
        : table === 'member_notifications'
          ? [{ id: `${user}-notification`, title: user, body: '', kind: 'info', read_at: null, created_at: '2026-10-11' }]
          : table === 'member_conversations'
            ? [{ id: `${user}-conversation`, title: 'Fictional thread', created_at: '2026-10-11', updated_at: '2026-10-11' }]
            : table === 'member_conversation_summaries'
              ? [{ conversation_id: `${user}-conversation`, latest_message: '', unread_count: 0 }]
              : [];
      const query = Object.assign(Promise.resolve({ data, error: null }), {
        select: () => query, eq: () => query, order: () => query,
        limit: () => query, gte: () => query, single: () => query, in: () => query,
      });
      return query;
    });
    await loadDashboard(user);
    expect(point.status()?.phase).toBe('armed');
    backend.from.mockClear();
    let oldSettled = false;
    const old = loadDashboard(user, undefined, 'user-refresh').then((result) => { oldSettled = true; return result; });
    await vi.waitFor(() => expect(point.status()?.phase).toBe('held'));
    expect(backend.from).toHaveBeenCalledWith('member_conversation_summaries');
    user = 'account-b';
    const current = await loadDashboard(user);
    expect(current.notifications.map((row) => row.title)).toEqual(['account-b']);
    expect(oldSettled).toBe(false);
    const readsBeforeRelease = backend.from.mock.calls.length;
    point.release(run);
    expect((await old).notifications.map((row) => row.title)).toEqual(['account-a']);
    expect(backend.from).toHaveBeenCalledTimes(readsBeforeRelease);
  } finally {
    point.reset(run);
    delete host.__unionGroundShareRecoveryTest;
    vi.unstubAllGlobals();
  }
});

function recordingQuery(calls: Call[], data: unknown[]) {
  const query = {
    select: (...args: unknown[]) => { calls.push(['select', ...args]); return query; },
    eq: (...args: unknown[]) => { calls.push(['eq', ...args]); return query; },
    in: (...args: unknown[]) => { calls.push(['in', ...args]); return query; },
    order: (...args: unknown[]) => { calls.push(['order', ...args]); return query; },
    limit: async (...args: unknown[]) => { calls.push(['limit', ...args]); return { data, error: null }; },
  };
  return query;
}

describe('feature evidence subtitle honesty', () => {
  it('keeps engineering wording out of the member-facing subtitles', () => {
    const feature = readFileSync(new URL('../features/FeatureScreen.tsx', import.meta.url), 'utf8');
    const livedIn = readFileSync(new URL('../features/LiveLivedInScreens.tsx', import.meta.url), 'utf8');
    for (const screen of [feature, livedIn]) expect(screen).not.toContain('protected offline snapshot');
  });
});
