import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { groupReferralCode, normalizeReferralSummary, recruitedYtdFrom, REFERRAL_COPY, referralTermsText } from './memberReferral';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

// REQ-UG-NATIVE-MEMBER-REFERRAL-CODE-20261111 (#8175).
describe('native worker referral code', () => {
  it('keeps only a well-formed code and a non-negative recruited count', () => {
    expect(normalizeReferralSummary({ code: '0A1B2C3D4E5F', recruitedYtd: 2 })).toEqual({ code: '0A1B2C3D4E5F', recruitedYtd: 2 });
    expect(normalizeReferralSummary({ code: '0a1b2c3d4e5f', recruitedYtd: 0 })).toEqual({ code: null, recruitedYtd: 0 });
    expect(normalizeReferralSummary({ code: '0A1B2C3D4E5F', recruitedYtd: -1 })).toEqual({ code: '0A1B2C3D4E5F', recruitedYtd: null });
    // Nothing shows when the server returns no code and no count.
    for (const value of [null, undefined, [], 'code', { code: null }, { code: 'short', recruitedYtd: 1.5 }]) {
      expect(normalizeReferralSummary(value)).toBeNull();
    }
  });

  it('groups the code as the web does', () => {
    expect(groupReferralCode('0A1B2C3D4E5F')).toBe('0A1B-2C3D-4E5F');
  });

  it('takes the Home count only from a rewards summary that returned it', () => {
    expect(recruitedYtdFrom({ totalPoints: 40, recruitedYtd: 3 })).toBe(3);
    expect(recruitedYtdFrom({ totalPoints: 40, recruitedYtd: 0 })).toBe(0);
    for (const value of [null, {}, { recruitedYtd: null }, { recruitedYtd: '3' }, { recruitedYtd: -2 }, [3]]) {
      expect(recruitedYtdFrom(value)).toBeNull();
    }
  });

  it('states the live referral rule in the web English copy, never fixed figures', () => {
    // This edition has no dues locale; the phone copy is pinned here in the
    // edition's vocabulary (meetings, workers).
    const intro = 'When someone you bring in accepts their invitation from an administrator, they can enter this code.';
    const off = 'When someone you bring in accepts their invitation from an administrator, they can enter this code, and they count toward the workers you recruited. Referral points are off right now.';
    expect(referralTermsText({ points: 50, weeklyCap: 2 })).toBe(`${intro} You earn 50 points when they first check in at a meeting, up to 2 a week.`);
    expect(referralTermsText({ points: 75, weeklyCap: null })).toBe(`${intro} You earn 75 points when they first check in at a meeting.`);
    expect(referralTermsText(null)).toBe(off);
    expect(referralTermsText({ points: 0, weeklyCap: 2 })).toBe(off);
    // An unreadable rule states only how the code is used.
    expect(referralTermsText(undefined)).toBe(intro);
  });

  it('keeps the referral labels in this edition\'s words', () => {
    expect(REFERRAL_COPY.title).toBe('Your referral code');
    expect(REFERRAL_COPY.codeLabel('0A1B-2C3D-4E5F')).toBe('Referral code 0A1B-2C3D-4E5F');
    expect(REFERRAL_COPY.count(4)).toBe('Workers recruited this year: 4');
    expect(REFERRAL_COPY.fieldLabel).toBe('Referral code (optional)');
    expect(REFERRAL_COPY.fieldHint).toBe('If a worker of this organization brought you in, enter their code so they get credit.');
  });

  it('shows the recruited count on live Home only when the summary returned it', () => {
    const home = read('../../app/(tabs)/home.tsx');
    expect(home).toContain('const recruitedYtd = useMemberRecruitedCount(deskRole === null);');
    expect(home).toMatch(/\{recruitedYtd !== null \? \(\s*<Metric value=\{recruitedYtd\} label=\{t\(REFERRAL_COPY\.homeLabel\)\}/);
    expect(home).toContain("hint={t('Opens Contributions.')} width={summaryWidth}");
    const hook = read('../features/home/useMemberRecruitedCount.ts');
    expect(hook).toContain("rpc('get_member_rewards_summary')");
    expect(hook).toContain('reply.error ? null : recruitedYtdFrom(reply.data)');
    expect(hook).toContain("mode === 'authenticated'");
  });

});
