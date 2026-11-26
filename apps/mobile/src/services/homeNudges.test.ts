import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
const backend = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
}));
vi.mock('./supabase', () => ({ createCapturedSessionRpcClient: backend.create }));

import { GUIDE_RPC, NUDGES_RPC, chooseHomeNudge } from '../lib/nudgesShared';
import { dismissHomeNudge, dismissPasswordPrompt, forgetHomeNudgeRun, isPasswordPromptDismissed, loadHomeNudges, markHomeNudgeShown, readHomeNudgeHistory } from './homeNudges';

const USER = '5d0a1f0e-1b2c-4d3e-8f90-123456789abc';
const NOW = Date.UTC(2026, 9, 2, 12);

function session(): Session {
  return {
    access_token: 'token-a',
    refresh_token: 'redacted',
    expires_in: 3_600,
    token_type: 'bearer',
    user: { id: USER, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-09-28T12:00:00.000Z' },
  };
}

beforeEach(() => { values.clear(); forgetHomeNudgeRun(); backend.create.mockReset(); });

describe('REQ-UG-HOME-NUDGES-20261001 native', () => {
  it('reads the server answer on a session-captured client', async () => {
    const rpc = vi.fn(async (name: string) => (name === GUIDE_RPC
      ? { data: { state: 'ready', memberOnly: true, programConfigured: true }, error: null }
      : { data: { passkey: true, onboarding: { completed: 0, total: 2 }, guidedFirstRun: false, snoozeDays: 28 }, error: null }));
    backend.create.mockReturnValue({ rpc });
    expect(await loadHomeNudges(session())).toEqual({ passkey: true, onboarding: { completed: 0, total: 2 }, starterList: false, guidedFirstRun: false, snoozeDays: 28 });
    expect(rpc).toHaveBeenCalledWith(NUDGES_RPC);
    expect(rpc).toHaveBeenCalledWith(GUIDE_RPC);
    await expect(loadHomeNudges(session(), { rpc: async () => ({ data: null, error: { code: '42501' } }) })).rejects.toThrow('Home suggestions are unavailable.');
  });

  // REQ-UG-FIRST-RUN-GUIDE-WITHOUT-ORG-CHECKLIST-20261018: the
  // zero-step organization.
  it('offers the starting list to a worker of an organization with no active step, and only then', async () => {
    const nudges = { passkey: false, onboarding: null, guidedFirstRun: false, snoozeDays: 28 };
    const client = (guide: unknown, guideError: unknown = null) => ({
      rpc: async (name: string) => (name === GUIDE_RPC ? { data: guide, error: guideError } : { data: nudges, error: null }),
    });
    const zeroSteps = { state: 'ready', applies: false, memberOnly: true, programConfigured: false, totalSteps: 0 };
    expect(await loadHomeNudges(session(), client(zeroSteps))).toMatchObject({ starterList: true });
    expect(await loadHomeNudges(session(), client({ ...zeroSteps, memberOnly: false }))).toMatchObject({ starterList: false });
    expect(await loadHomeNudges(session(), client({ ...zeroSteps, programConfigured: true }))).toMatchObject({ starterList: false });
    expect(await loadHomeNudges(session(), client(null, { code: '42501' }))).toMatchObject({ starterList: false });
    const base = { welcomeTourActive: false, passkeySupported: false, hasPasskey: null, signedInAt: null, history: {}, now: NOW };
    const server = await loadHomeNudges(session(), client(zeroSteps));
    expect(chooseHomeNudge({ ...base, server })).toEqual({ kind: 'starter' });
    await dismissHomeNudge(USER, 'starter', NOW);
    expect(chooseHomeNudge({ ...base, server, history: await readHomeNudgeHistory(USER) })).toBeNull();
  });

  it('keeps Not now and the weekly shown marker on this phone, per account', async () => {
    await markHomeNudgeShown(USER, 'passkey', NOW);
    await markHomeNudgeShown(USER, 'passkey', NOW + 1000);
    await dismissHomeNudge(USER, 'onboarding', NOW);
    const history = await readHomeNudgeHistory(USER);
    expect(history.passkey).toEqual({ shownAt: NOW, shownThisSession: true });
    expect(history.onboarding).toEqual({ dismissedAt: NOW, shownThisSession: false });
    expect([...values.keys()]).toEqual([`org.unionground.app.home-nudges-v1.${USER}`]);
    await markHomeNudgeShown('../x', 'passkey', NOW);
    expect(values.size).toBe(1);
  });

  it('chooses one nudge with the shared policy and stays silent in the guided first run', () => {
    const server = { passkey: true, onboarding: { completed: 1, total: 3 }, starterList: false, guidedFirstRun: false, snoozeDays: 28 };
    const base = { welcomeTourActive: false, passkeySupported: true, hasPasskey: false, signedInAt: NOW - 86_400_000, history: {}, now: NOW };
    expect(chooseHomeNudge({ ...base, server })).toEqual({ kind: 'onboarding', completed: 1, total: 3 });
    expect(chooseHomeNudge({ ...base, server: { ...server, onboarding: null } })).toEqual({ kind: 'passkey' });
    expect(chooseHomeNudge({ ...base, server: { ...server, guidedFirstRun: true } })).toBeNull();
    expect(chooseHomeNudge({ ...base, server: null })).toBeNull();
  });

  it('places the nudge on live Home and opens the onboarding checklist or Account', () => {
    const home = readFileSync(join(__dirname, '../../app/(tabs)/home.tsx'), 'utf8');
    const liveStart = home.indexOf('function AuthenticatedHome');
    expect(liveStart, 'AuthenticatedHome must exist').toBeGreaterThanOrEqual(0);
    const live = home.slice(liveStart);
    const nudgeIndex = live.indexOf('<HomeNudge />');
    const learningIndex = live.indexOf('<LearningHomeCard />');
    expect(nudgeIndex, 'HomeNudge must exist on live Home').toBeGreaterThanOrEqual(0);
    expect(learningIndex, 'LearningHomeCard must exist on live Home').toBeGreaterThanOrEqual(0);
    expect(nudgeIndex).toBeLessThan(learningIndex);
    const nudge = readFileSync(join(__dirname, '../features/home/HomeNudge.tsx'), 'utf8');
    expect(nudge).toContain("'/feature/member-support?source=onboarding'");
    expect(nudge).toContain("'/account'");
    expect(nudge).toContain('label="Not now"');
    expect(nudge).toContain("'New here? Start with these 4 steps'");
    expect(nudge).toContain("'Your campaign has not added its own onboarding checklist yet, so here is where most new workers start.'");
    expect(nudge).not.toContain('meet the committee and read the worker guide');
    const support = readFileSync(join(__dirname, '../features/MemberSupportScreen.tsx'), 'utf8');
    expect(support).toContain("useBusinessDraftState<TabID>(initialTab ?? 'rights')");
    const feature = readFileSync(join(__dirname, '../features/FeatureScreen.tsx'), 'utf8');
    expect(feature).toContain(`sourceID === 'onboarding' ? <MemberSupportScreen initialTab="onboarding" /> : <MemberSupportScreen />`);
  });

  it('keeps the choose-your-password dismissal on this phone for the issued password only', async () => {
    const issued = '2026-10-19T14:00:00.000Z';
    expect(await isPasswordPromptDismissed(USER, issued)).toBe(false);
    await dismissPasswordPrompt(USER, issued);
    expect(await isPasswordPromptDismissed(USER, issued)).toBe(true);
    // A reissued password carries a new stamp and asks again.
    expect(await isPasswordPromptDismissed(USER, '2026-10-20T09:00:00.000Z')).toBe(false);
    // An unsafe account id never reaches storage and never prompts.
    await dismissPasswordPrompt('../x', issued);
    expect(await isPasswordPromptDismissed('../x', issued)).toBe(true);
    expect([...values.keys()]).toEqual([`org.unionground.app.choose-password-v1.${USER}`]);
  });

  it('shows the choose-your-password card first on live Home, only for a session that carries the stamp', () => {
    const home = readFileSync(join(__dirname, '../../app/(tabs)/home.tsx'), 'utf8');
    const live = home.slice(home.indexOf('function AuthenticatedHome'));
    expect(live.indexOf('<ChoosePasswordNudge>')).toBeGreaterThan(-1);
    expect(live.indexOf('<ChoosePasswordNudge>')).toBeLessThan(live.indexOf('<OnboardingGuideHomeSlot'));
    const card = readFileSync(join(__dirname, '../features/home/ChoosePasswordNudge.tsx'), 'utf8');
    expect(card).toContain('union_ground_password_issued_at');
    expect(card).toContain("router.push('/account'");
    expect(card).toContain('label="Not now"');
    expect(card).toContain('if (dismissed === null) return null');
  });
});
