import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
let backend: { rpc: typeof rpc } | null = { rpc };
vi.mock('./supabase', () => ({ getSupabaseClient: () => backend }));
vi.mock('../lib/config', () => ({ mobileConfig: { portalBaseUrl: 'https://sample.unionground.example', supabaseUrl: null, backendConfigured: false } }));

import { parseMobileConfig } from '../lib/configPolicy';
import { TEST_BACKENDS } from '../test/backends';
import { staffTwoStepPaused, staffTwoStepSettings } from '../lib/staffTwoStepNotice';
import { loadStaffTwoStepPaused } from './staffTwoStepStanding';

// This edition ships no hosted pair; the test setup trusts two fictional ones.
const SAMPLE_SUPABASE_ORIGIN = TEST_BACKENDS.sample.supabaseUrl;
const UNION_GROUND_PORTAL_ORIGIN = TEST_BACKENDS.live.portal;
const UNION_GROUND_SUPABASE_ORIGIN = TEST_BACKENDS.live.supabaseUrl;

const home = readFileSync(new URL('../../app/(tabs)/home.tsx', import.meta.url), 'utf8');
const card = readFileSync(new URL('../components/ChapterLeadershipCard.tsx', import.meta.url), 'utf8');
const notice = readFileSync(new URL('../components/StaffTwoStepNotice.tsx', import.meta.url), 'utf8');

describe('REQ-UG-NATIVE-AUTHENTICATOR-SETUP-20261018 paused-staff notice', () => {
  beforeEach(() => {
    rpc.mockReset();
    backend = { rpc };
  });

  it('shows only for an explicit blocked answer from an account that holds a staff role', () => {
    expect(staffTwoStepPaused({ blocked: true, holdsStaffRole: true })).toBe(true);
    expect(staffTwoStepPaused({ blocked: true, holdsStaffRole: false })).toBe(false);
    expect(staffTwoStepPaused({ blocked: false, holdsStaffRole: true })).toBe(false);
    expect(staffTwoStepPaused({ blocked: 'true', holdsStaffRole: true })).toBe(false);
    expect(staffTwoStepPaused(null)).toBe(false);
    expect(staffTwoStepPaused([])).toBe(false);
  });

  it('reads the same self-only standing the website reads and treats every failure as not paused', async () => {
    rpc.mockResolvedValueOnce({ data: { blocked: true, holdsStaffRole: true, enrolled: false }, error: null });
    await expect(loadStaffTwoStepPaused()).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('get_staff_mfa_standing');
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(loadStaffTwoStepPaused()).resolves.toBe(false);
    rpc.mockResolvedValueOnce({ data: { blocked: false, holdsStaffRole: true }, error: null });
    await expect(loadStaffTwoStepPaused()).resolves.toBe(false);
    backend = null;
    await expect(loadStaffTwoStepPaused()).resolves.toBe(false);
  });

  it('puts the notice on Home and links to the page that exists', () => {
    expect(home).toContain('<StaffTwoStepNotice />');
    expect(notice).toContain('Linking.openURL(twoStep.url)');
    expect(notice).toContain("mode !== 'authenticated'");
    // A pull to refresh replaces the dashboard; the standing is read again then.
    expect(notice).toContain('}, [mode, userID, dashboard]);');
    expect(staffTwoStepSettings().body).not.toMatch(/in Account/);
  });

  it('no longer points the leadership claim at an Account control that does not exist', () => {
    expect(card).not.toContain('Turn it on in Account');
    expect(card).not.toContain("router.push('/account'");
    expect(card).toContain('Linking.openURL(twoStep.url)');
  });
});

// BUG-UG-NATIVE-SAMPLE-TWO-STEP-SETUP-LINK-OPENS-PRODUCTION-20261106
// (#7231): the setup link follows the build's pinned backend.
describe('two-step setup link per build kind', () => {
  const key = 'sb_publishable_test';
  const mfa = readFileSync(new URL('../../app/mfa-challenge.tsx', import.meta.url), 'utf8');

  it('sends a SAMPLE-pinned build to the SAMPLE web host and names it', () => {
    const sample = staffTwoStepSettings(parseMobileConfig({ supabaseUrl: SAMPLE_SUPABASE_ORIGIN, supabasePublishableKey: key }));
    expect(sample.url).toBe('https://sample.unionground.example/m/settings/security');
    expect(sample.host).toBe('sample.unionground.example');
    expect(sample.action).toBe('Set up two-step on sample.unionground.example');
    expect(sample.body).toContain('Set it up on sample.unionground.example,');
    expect(sample.openFailed).toBe('The page could not be opened. Visit sample.unionground.example/m/settings/security in a browser.');
    expect(Object.values(sample).join(' ')).not.toContain('app.unionground.example');
  });

  it('keeps a Union Ground production build on app.unionground.example', () => {
    const production = staffTwoStepSettings(parseMobileConfig({ supabaseUrl: UNION_GROUND_SUPABASE_ORIGIN, supabasePublishableKey: key, portalBaseUrl: UNION_GROUND_PORTAL_ORIGIN }));
    expect(production.url).toBe('https://app.unionground.example/m/settings/security');
    expect(production.action).toBe('Set up two-step on app.unionground.example');
    expect(production.openFailed).toBe('The page could not be opened. Visit app.unionground.example/m/settings/security in a browser.');
    expect(Object.values(production).join(' ')).not.toContain('sample.unionground.example');
  });

  it('names the unprovisioned placeholder for a build with no approved backend', () => {
    expect(staffTwoStepSettings(parseMobileConfig({})).url).toBe('https://unionground.invalid/m/settings/security');
    expect(staffTwoStepSettings(parseMobileConfig({ supabaseUrl: SAMPLE_SUPABASE_ORIGIN, supabasePublishableKey: 'replace-me' })).url)
      .toBe('https://unionground.invalid/m/settings/security');
  });

  it('has no fixed host left on any two-step setup control', () => {
    for (const source of [mfa, card, notice]) {
      expect(source).not.toContain('Set up two-step on app.unionground.example');
      expect(source).not.toContain('Set it up on app.unionground.example');
      expect(source).toContain('staffTwoStepSettings()');
    }
    expect(mfa.match(/Linking\.openURL\(twoStep\.url\)/g)).toHaveLength(2);
  });
});
