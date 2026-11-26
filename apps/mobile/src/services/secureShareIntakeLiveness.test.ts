import { boundShareRecoveryTestApi } from '../testing/boundShareRecoveryTestApi';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  secureValue: null as string | null,
  keepSecureValueOnDelete: false,
  reconcile: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-device-only',
  getItemAsync: vi.fn(async (key: string) => key.includes('quarantine') ? null : mocks.secureValue),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (!key.includes('quarantine')) mocks.secureValue = value;
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    if (!key.includes('quarantine') && !mocks.keepSecureValueOnDelete) mocks.secureValue = null;
  }),
}));
vi.mock('../../modules/secure-share-intake/src/SecureShareIntakeModule', () => ({
  default: {
    getPendingAsync: vi.fn(async () => null),
    discardAsync: vi.fn(async () => true),
    discardAllAsync: vi.fn(async () => true),
    captureCleanupTokensAsync: vi.fn(async () => []),
  },
}));
vi.mock('../lib/config', () => ({ mobileConfig: { supabaseUrl: 'https://sample-boundary.supabase.co' } }));
vi.mock('./supabase', () => ({
  verifyCapturedMobileSession: () => mocks.getUser(),
  getSupabaseClient: () => ({ auth: {
    getUser: mocks.getUser,
    getSession: async () => ({ data: { session: { access_token: 'fixture-access-token' } }, error: null }),
  } }),
}));
vi.mock('./attachments', () => ({
  reconcileAuthorizedAttachmentUpload: mocks.reconcile,
  uploadAuthorizedAttachment: vi.fn(),
  validateAttachmentCandidate: vi.fn(),
  AttachmentError: class AttachmentError extends Error {},
}));

import * as rawShare from './secureShareIntake';
const secureShareIntake = boundShareRecoveryTestApi(rawShare, () => ({ auth: { getUser: mocks.getUser } }), () => userID);

const userID = '55555555-5555-4555-8555-555555555555';
const uploadID = '44444444-4444-4444-8444-444444444444';
const token = '11111111-1111-4111-8111-111111111111';
const caseID = '22222222-2222-4222-8222-222222222222';

describe('secure share recovery liveness', () => {
  beforeEach(() => {
    mocks.keepSecureValueOnDelete = false;
    mocks.secureValue = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: userID } }, error: null });
    mocks.reconcile.mockReset()
      .mockResolvedValueOnce({ status: 'reauth-required' })
      .mockImplementationOnce(() => new Promise(() => undefined));
  });

  it('terminates session establishment on reauth-required and keeps the marker', async () => {
    const prepare = secureShareIntake.preparePendingSharedAttachmentUploadForSessionEstablishment;
    const result = await Promise.race([
      prepare(userID).then(
        () => ({ kind: 'resolved' as const }),
        (error) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 100)),
    ]);

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.error).toMatchObject({
      name: 'ShareIntakeError',
      code: 'remote-cleanup',
      reauthRequired: true,
    });
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.secureValue).not.toBeNull();
  });

  it('stops after the maximum recovery attempts when an absent result cannot clear its marker', async () => {
    mocks.keepSecureValueOnDelete = true;
    mocks.reconcile.mockReset().mockResolvedValue({ status: 'aborted' });

    await expect(
      secureShareIntake.preparePendingSharedAttachmentUploadForSessionEstablishment(userID),
    ).rejects.toThrow('exceeded its secure recovery attempts');
    expect(mocks.reconcile).toHaveBeenCalledTimes(8);
    expect(mocks.secureValue).not.toBeNull();
  });
});

// Text pins for the route wiring these unit tests cannot reach through a
// render — honest about being tripwires rather than behavioural proof.
describe('secure share re-verification route contract', () => {
  const mobileRoot = fileURLToPath(new URL('../../', import.meta.url));
  const mfaScreen = readFileSync(`${mobileRoot}app/mfa-challenge.tsx`, 'utf8');
  const shareScreen = readFileSync(`${mobileRoot}app/share-intake.tsx`, 'utf8');

  it('honours an explicit force-reverify intent for authenticated sessions', () => {
    expect(mfaScreen).toContain('forceReverify?: string | string[]');
    expect(mfaScreen).toContain('const forceReverificationRequested =');
    expect(mfaScreen).toContain("mode === 'authenticated' && !forceReverificationRequested");
  });

  it('passes the force-reverify intent from the share recovery affordance', () => {
    expect(shareScreen).toContain("pathname: '/mfa-challenge'");
    expect(shareScreen).toContain("forceReverify: '1'");
    expect(shareScreen).toContain("resume: 'share-intake'");
    expect(shareScreen).toContain('Sign out instead');
    expect(shareScreen).toContain('void signOut()');
  });

  it('returns to the mounted share screen after in-flow MFA verification', () => {
    expect(mfaScreen).toContain('const resumeToShareIntake =');
    expect(mfaScreen).toContain("router.dismissTo('/share-intake')");
    expect(mfaScreen).toContain("router.replace(returnDestination as never)");
  });

  it('keeps reauth recovery on the challenge form instead of the assurance retry state', () => {
    const provider = readFileSync(`${mobileRoot}src/state/AppProvider.tsx`, 'utf8');
    expect(provider).toContain('nextError instanceof ShareIntakeError && nextError.reauthRequired');
    expect(provider).toContain('setAssuranceUnavailable(false);');
    expect(mfaScreen).toContain('{signOutError ? <Body style={{ color: theme.destructive }}>{signOutError}</Body> : null}');
  });
});
