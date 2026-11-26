import { beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-UNION-GROUND-MOBILE-NATIVE-CALENDAR-EXPORT-20260825 items 4 and 5: a
// build whose backend is the pinned SAMPLE project refuses the press-time
// export preparation before touching auth, MFA assurance or any RPC, so the
// native composer can never open on fixture data.

const backend = vi.hoisted(() => ({
  auth: {
    getUser: vi.fn(),
    mfa: { getAuthenticatorAssuranceLevel: vi.fn() },
  },
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', async () => {
  const { pinnedSampleSupabaseOrigin } = await import('../../../../src/lib/sampleBackend');
  return {
    mobileConfig: {
      backendConfigured: true,
      supabaseUrl: pinnedSampleSupabaseOrigin(),
      supabasePublishableKey: 'publishable-test-key',
      portalBaseUrl: 'https://sample.unionground.example',
    },
  };
});
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
vi.mock('../../modules/native-calendar-export/src/NativeCalendarExportModule', () => ({ default: null }));

import { prepareAuthorizedEventCalendarExport } from './livedIn';
import { isLiveSampleBackend } from './sampleSession';
import { assertFreshMobileCalendarSession, prepareAuthorizedAppointmentCalendarExport } from './supabase';
import { mobileConfig } from '../lib/config';

const NOW = Date.parse('2026-09-27T06:00:00.000Z');

describe('calendar export on a SAMPLE build', () => {
  beforeEach(() => {
    backend.auth.getUser.mockReset();
    backend.auth.mfa.getAuthenticatorAssuranceLevel.mockReset();
    backend.rpc.mockReset();
    backend.from.mockReset();
  });

  it('is the pinned SAMPLE backend under test', () => {
    expect(isLiveSampleBackend(mobileConfig)).toBe(true);
  });

  it('refuses the session assertion before any auth read', async () => {
    await expect(assertFreshMobileCalendarSession()).rejects.toThrow('Calendar export is not offered on SAMPLE.');
    expect(backend.auth.getUser).not.toHaveBeenCalled();
    expect(backend.auth.mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it('refuses a one-on-one export before any RPC', async () => {
    await expect(prepareAuthorizedAppointmentCalendarExport('a2222222-2222-4222-8222-222222222222', NOW))
      .rejects.toThrow('Calendar export is not offered on SAMPLE.');
    expect(backend.rpc).not.toHaveBeenCalled();
    expect(backend.auth.getUser).not.toHaveBeenCalled();
  });

  it('refuses a chapter-event export before any data read', async () => {
    await expect(prepareAuthorizedEventCalendarExport('event-current', NOW))
      .rejects.toThrow('Calendar export is not offered on SAMPLE.');
    expect(backend.rpc).not.toHaveBeenCalled();
    expect(backend.from).not.toHaveBeenCalled();
    expect(backend.auth.getUser).not.toHaveBeenCalled();
  });
});
