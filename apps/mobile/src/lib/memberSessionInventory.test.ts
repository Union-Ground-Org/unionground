import { afterEach, describe, expect, it, vi } from 'vitest';

// REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009: the shape and the words
// of Account > Sessions. The normalizer is the client's half of the server's
// privacy boundary, so the cases below pin what it refuses to carry as much as
// what it keeps.
import {
  MEMBER_SESSIONS_COPY,
  memberSessionAccessibilityLabel,
  memberSessionDetail,
  memberSessionTitle,
  memberSessionsFailureMessage,
  normalizeMemberSessionRows,
} from './memberSessionInventory';

const handleA = 'a'.repeat(64);
const handleB = 'b'.repeat(64);

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handle: handleA,
    deviceLabel: 'apple_mobile',
    browserLabel: 'safari',
    current: true,
    createdAt: '2026-10-09T12:00:00.000Z',
    lastActiveAt: '2026-10-10T01:30:00.000Z',
    ...overrides,
  };
}

describe('normalizeMemberSessionRows', () => {
  it('keeps the five presentable fields and copies nothing else across', () => {
    const rows = normalizeMemberSessionRows([row({
      sessionId: '3f1d9e2c-0000-4000-8000-000000000000',
      accessToken: 'never-render-me',
      refreshToken: 'never-render-me-either',
      ip: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)',
    })]);
    expect(rows).toEqual([{
      handle: handleA,
      deviceLabel: 'apple_mobile',
      browserLabel: 'safari',
      current: true,
      createdAt: '2026-10-09T12:00:00.000Z',
      lastActiveAt: '2026-10-10T01:30:00.000Z',
    }]);
    expect(JSON.stringify(rows)).not.toMatch(/never-render-me|203\.0\.113\.9|Mozilla|3f1d9e2c/);
  });

  it('distinguishes a refused payload from an empty list', () => {
    // An empty array is the only answer that means "no sessions"; anything
    // that is not a list is a service answer the screen must report as a
    // failure instead of drawing as an empty state.
    expect(normalizeMemberSessionRows([])).toEqual([]);
    for (const refusal of [null, undefined, {}, 'null', 0, { sessions: [] }]) {
      expect(normalizeMemberSessionRows(refusal)).toBeNull();
    }
  });

  it('drops a row whose handle is absent, malformed or repeated', () => {
    const rows = normalizeMemberSessionRows([
      row({ handle: handleA }),
      row({ handle: handleA, current: false }),
      row({ handle: undefined }),
      row({ handle: 'A'.repeat(63) }),
      row({ handle: `${'a'.repeat(63)}z` }),
      row({ handle: handleB, current: false }),
      'not-a-row',
      ['not-a-row-either'],
      null,
    ]);
    expect(rows?.map((entry) => entry.handle)).toEqual([handleA, handleB]);
  });

  it('accepts an upper-case handle as the same session', () => {
    const rows = normalizeMemberSessionRows([row({ handle: handleA.toUpperCase() })]);
    expect(rows?.[0]?.handle).toBe(handleA);
  });

  it('falls back to the unlabelled device and browser, and never invents a time', () => {
    const rows = normalizeMemberSessionRows([row({
      deviceLabel: 'quantum_toaster',
      browserLabel: '__proto__',
      current: 'yes',
      createdAt: 'whenever',
      lastActiveAt: null,
    })]);
    expect(rows).toEqual([{
      handle: handleA,
      deviceLabel: 'signed_in_device',
      browserLabel: 'browser',
      current: false,
      createdAt: null,
      lastActiveAt: null,
    }]);
  });

  it('puts the current session first even when the server does not', () => {
    const rows = normalizeMemberSessionRows([
      row({ handle: handleB, current: false, deviceLabel: 'windows_computer' }),
      row({ handle: handleA, current: true }),
    ]);
    expect(rows?.map((entry) => entry.current)).toEqual([true, false]);
    expect(rows?.[0]?.handle).toBe(handleA);
  });
});

describe('session row words', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('keeps visible and spoken last-use times on the Eastern clock with a zone label', () => {
    for (const zone of ['America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']) {
      vi.stubEnv('TZ', zone);
      for (const [instant, expected] of [
        ['2026-11-14T03:43:00Z', 'Nov 13, 2026 · 10:43 PM ET'],
        ['2026-07-14T03:43:00Z', 'Jul 13, 2026 · 11:43 PM ET'],
      ]) {
        const [only] = normalizeMemberSessionRows([row({ lastActiveAt: instant })]) ?? [];
        expect(memberSessionDetail(only!)).toBe(`Safari. Last used ${expected}.`);
        expect(memberSessionAccessibilityLabel(only!)).toContain(`Last used ${expected}.`);
      }
    }
  });

  it('keeps an unavailable line when the Eastern formatter cannot run', () => {
    const [only] = normalizeMemberSessionRows([row()]) ?? [];
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { throw new RangeError('No zone data'); });
    expect(memberSessionDetail(only!)).toContain('Last use unavailable');
  });

  it('names this device on the current session and the device elsewhere', () => {
    const [current, other] = normalizeMemberSessionRows([
      row({ handle: handleA, current: true }),
      row({ handle: handleB, current: false, deviceLabel: 'android_mobile', browserLabel: 'chrome' }),
    ]) ?? [];
    expect(memberSessionTitle(current!)).toBe('iPhone or iPad — this device');
    expect(memberSessionTitle(other!)).toBe('Android phone or tablet, Chrome');
    expect(memberSessionAccessibilityLabel(current!)).toContain('This device.');
    expect(memberSessionAccessibilityLabel(other!)).not.toContain('This device.');
    expect(memberSessionAccessibilityLabel(other!)).toContain('Android phone or tablet, Chrome');
  });

  it('says a missing last use is unavailable instead of guessing one', () => {
    const [only] = normalizeMemberSessionRows([row({ lastActiveAt: 'not a date' })]) ?? [];
    expect(memberSessionDetail(only!)).toContain('Last use unavailable');
    expect(memberSessionAccessibilityLabel(only!)).toContain('Last use unavailable');
  });

  it('never speaks or prints the opaque handle', () => {
    const [only] = normalizeMemberSessionRows([row()]) ?? [];
    for (const text of [memberSessionTitle(only!), memberSessionDetail(only!), memberSessionAccessibilityLabel(only!)]) {
      expect(text).not.toContain(handleA);
    }
  });
});

describe('failure copy', () => {
  it('separates a request that did not arrive from one the service refused', () => {
    expect(memberSessionsFailureMessage('transport')).toContain('did not reach Union Ground');
    expect(memberSessionsFailureMessage('service')).toContain('the service refused the request');
    expect(memberSessionsFailureMessage('service')).toContain('not because of your connection');
    expect(memberSessionsFailureMessage('denied')).toContain('Sign in again');
  });

  it('never reports an unreadable list as an empty one', () => {
    for (const kind of ['transport', 'service', 'denied'] as const) {
      expect(memberSessionsFailureMessage(kind)).not.toMatch(/no sessions|signed out everywhere/i);
    }
  });

  it('promises no session key and no other person in the card body', () => {
    expect(MEMBER_SESSIONS_COPY.body).toContain('never a session key');
    expect(MEMBER_SESSIONS_COPY.confirmBody).toContain('has to sign in again');
  });
});
