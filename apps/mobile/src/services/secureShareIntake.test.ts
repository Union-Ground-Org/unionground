import { stubAttachmentWriter } from '../testing/stubAttachmentWriter';
import { boundShareRecoveryTestApi } from '../testing/boundShareRecoveryTestApi';
import * as rawShare from './secureShareIntake';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { Session } from '@supabase/supabase-js';
import { createSessionSignOutAttemptCoordinator, exactSessionIdentity, exactSessionIdentityMatches } from './sessionResume';
import { createNativeAuthGate } from '../lib/nativeAuthGate';
import { accessTokensShareSessionLineage } from '../lib/sessionLineage';
import { redeemMfaRecoveryCode } from '../lib/mfaRecovery';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: null as Record<string, unknown> | null,
  cryptoUUID: vi.fn(() => '44444444-4444-4444-8444-444444444444'),
  secureValue: null as string | null,
  quarantineValue: null as string | null,
  secureStore: {
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
  },
  native: {
    getPendingAsync: vi.fn(),
    captureCleanupTokensAsync: vi.fn(),
    discardAsync: vi.fn(),
    discardAllAsync: vi.fn(),
  },
  upload: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-crypto', () => ({ randomUUID: mocks.cryptoUUID }));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-device-only',
  ...mocks.secureStore,
}));

vi.mock('../../modules/secure-share-intake/src/SecureShareIntakeModule', () => ({
  default: mocks.native,
}));

vi.mock('./supabase', () => ({
  verifyCapturedMobileSession: () => (mocks.client?.auth as { getUser: () => unknown }).getUser(),
  getSupabaseClient: () => mocks.client && { ...mocks.client, auth: {
    getSession: async () => ({ data: { session: { access_token: 'fixture-access-token' } }, error: null }),
    ...(mocks.client.auth as object),
  } },
}));
vi.mock('../lib/config', () => ({
  mobileConfig: { supabaseUrl: 'https://sample-boundary.supabase.co' },
}));

vi.mock('./attachments', async (importOriginal) => {
  type AttachmentModule = typeof import('./attachments');
  const actual = await importOriginal<AttachmentModule>();
  return {
    ...actual,
    uploadAuthorizedAttachment: mocks.upload,
    reconcileAuthorizedAttachmentUpload: mocks.reconcile,
  };
});

import {
  SHARE_INTAKE_MAX_AGE_MS,
  ShareIntakeError,
  acknowledgePendingSharedAttachmentUpload,
  captureSecureShareCleanupBoundary,
  createShareUploadPresentationGate,
  discardAllPendingSharedAttachments,
  discardPendingSharedAttachment,
  discardPendingSharedAttachmentCreatedAtOrBefore,
  isSecureShareStagingCleanupRequired,
  isStaffTaskAttachmentRole,
  loadAuthorizedShareTargets,
  markSecureShareStagingCleanupRequired,
  pendingShareStagingCanBeDiscarded,
  preparePendingSharedAttachmentStagingForPreviewExit,
  preparePendingSharedAttachmentUploadForSessionLoss,
  readPendingSharedAttachment,
  readPendingSharedAttachmentUploadRecovery,
  retryPendingSharedAttachmentCleanup,
  shareUploadAllowsReshare,
  subscribeSecureShareStagingCleanup,
  validateNativePendingShare,
  withDistinctGuidance,
} from './secureShareIntake';
import { AttachmentError } from './attachments';
const { beginPendingSharedAttachmentUpload, uploadPendingSharedAttachment, reconcilePendingSharedAttachmentUploadRecovery, preparePendingSharedAttachmentUploadForSessionEstablishment, preparePendingSharedAttachmentUploadForSignOut, getPendingSharedAttachmentUpload } = boundShareRecoveryTestApi(rawShare, () => mocks.client, () => userID);

const token = '11111111-1111-4111-8111-111111111111';
const caseID = '22222222-2222-4222-8222-222222222222';
const taskID = '33333333-3333-4333-8333-333333333333';
const uploadID = '44444444-4444-4444-8444-444444444444';
const userID = '55555555-5555-4555-8555-555555555555';
const now = Date.parse('2026-08-25T20:00:00Z');
const require = createRequire(import.meta.url);
const { ALLOWED_TYPE_IDENTIFIERS, buildActivationRule, setExtensionTargetDeviceFamily } = require(
  '../../modules/secure-share-intake/app.plugin.js',
) as {
  ALLOWED_TYPE_IDENTIFIERS: readonly string[];
  buildActivationRule: () => string;
  setExtensionTargetDeviceFamily: (project: {
    pbxXCBuildConfigurationSection: () => Record<string, {
      buildSettings?: Record<string, string>;
    }>;
  }, extensionBundleId: string) => void;
};

function pending(overrides: Record<string, unknown> = {}) {
  return {
    token,
    uri: 'file:///private/staging/payload',
    filename: 'evidence.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4,
    createdAtMs: now - 1_000,
    ...overrides,
  };
}

function uploadedAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: uploadID,
    targetID: caseID,
    bucketID: 'case-files' as const,
    objectName: `private/${uploadID}/evidence.pdf`,
    filename: 'evidence.pdf',
    mimeType: 'application/pdf' as const,
    sizeBytes: 4,
    createdAt: '2026-08-25T20:00:00Z',
    ...overrides,
  };
}

type TestUploadSettlement =
  | { status: 'uploaded'; attachmentID: string; attachment: ReturnType<typeof uploadedAttachment> }
  | { status: 'failed'; attachmentID: string; error: ShareIntakeError };

function xcodeConfiguration(bundleIdentifier: string) {
  return {
    buildSettings: {
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}"`,
    } as Record<string, string>,
  };
}

function query(result: { data: unknown[]; error: unknown }) {
  const value: Record<string, unknown> = {};
  for (const method of ['select', 'order', 'limit', 'eq', 'is', 'returns']) {
    value[method] = vi.fn(() => value);
  }
  value.then = (resolve: (next: unknown) => unknown, reject: (error: unknown) => unknown) => (
    Promise.resolve(result).then(resolve, reject)
  );
  return value;
}

describe('privacy-safe native share intake', () => {
  it('does not repeat guidance already present in an upload error', () => {
    const reshare = 'Share the item to Union Ground again before retrying.';
    expect(withDistinctGuidance(`The upload could not be completed. ${reshare}`, reshare))
      .toBe(`The upload could not be completed. ${reshare}`);
    expect(withDistinctGuidance('The upload failed.', reshare))
      .toBe(`The upload failed. ${reshare}`);
  });

  beforeEach(() => {
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userID } }, error: null }) },
    };
    mocks.cryptoUUID.mockReset().mockReturnValue(uploadID);
    mocks.secureValue = null;
    mocks.quarantineValue = null;
    mocks.secureStore.getItemAsync.mockReset().mockImplementation(async (key: string) => (
      key.includes('quarantine') ? mocks.quarantineValue : mocks.secureValue
    ));
    mocks.secureStore.setItemAsync.mockReset().mockImplementation(async (key: string, value: string) => {
      if (key.includes('quarantine')) mocks.quarantineValue = value;
      else mocks.secureValue = value;
    });
    mocks.secureStore.deleteItemAsync.mockReset().mockImplementation(async (key: string) => {
      if (key.includes('quarantine')) mocks.quarantineValue = null;
      else mocks.secureValue = null;
    });
    mocks.native.getPendingAsync.mockReset();
    mocks.native.captureCleanupTokensAsync.mockReset().mockImplementation(async () => {
      const row: unknown = await mocks.native.getPendingAsync();
      const capturedToken = row && typeof row === 'object' ? (row as { token?: unknown }).token : null;
      return typeof capturedToken === 'string' ? [capturedToken] : [];
    });
    mocks.native.discardAsync.mockReset().mockResolvedValue(true);
    mocks.native.discardAllAsync.mockReset().mockResolvedValue(true);
    mocks.upload.mockReset().mockResolvedValue(uploadedAttachment());
    mocks.reconcile.mockReset().mockResolvedValue({ status: 'uncertain' });
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
  });

  afterEach(async () => {
    const activeUpload = getPendingSharedAttachmentUpload();
    if (activeUpload) {
      await acknowledgePendingSharedAttachmentUpload(activeUpload.attachmentID);
    }
    mocks.native.discardAsync.mockResolvedValue(true);
    await retryPendingSharedAttachmentCleanup().catch(() => undefined);
    await discardAllPendingSharedAttachments().catch(() => undefined);
  });

  it('accepts one exact, fresh, app-owned payload and rejects stale or untrusted records', () => {
    expect(validateNativePendingShare(pending(), now)).toMatchObject({
      token,
      candidate: { filename: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: 4, cacheOwned: true },
    });
    for (const invalid of [
      pending({ createdAtMs: now - SHARE_INTAKE_MAX_AGE_MS - 1 }),
      pending({ token: '../staging' }),
      pending({ uri: 'content://provider/evidence' }),
      pending({ filename: '../evidence.pdf' }),
      pending({ mimeType: 'application/zip' }),
      pending({ sizeBytes: 0 }),
    ]) {
      expect(() => validateNativePendingShare(invalid, now)).toThrow();
    }
  });

  it('deletes malformed native staging by its exact token before returning control to the UI', async () => {
    mocks.native.getPendingAsync.mockResolvedValue(pending({ uri: 'content://provider/evidence' }));
    await expect(readPendingSharedAttachment()).rejects.toMatchObject({ code: 'invalid' });
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
  });

  it('reports malformed staging as a cleanup failure when exact deletion cannot be confirmed', async () => {
    mocks.native.getPendingAsync.mockResolvedValue(pending({ uri: 'content://provider/evidence' }));
    mocks.native.discardAsync.mockResolvedValue(false);

    await expect(readPendingSharedAttachment()).rejects.toMatchObject({ code: 'cleanup' });
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
  });

  it('requires native deletion to confirm the requested staged token is absent', async () => {
    mocks.native.discardAsync.mockResolvedValue(false);

    await expect(discardPendingSharedAttachment(token)).rejects.toMatchObject({ code: 'cleanup' });
  });

  it('publishes failed unmount cleanup through a shared latch and clears it after retry', async () => {
    const observed: boolean[] = [];
    const unsubscribe = subscribeSecureShareStagingCleanup((required) => observed.push(required));
    mocks.native.discardAsync.mockResolvedValueOnce(false);

    await expect(discardPendingSharedAttachment(token)).rejects.toMatchObject({ code: 'cleanup' });
    expect(isSecureShareStagingCleanupRequired()).toBe(true);
    expect(observed).toEqual([true]);

    await expect(retryPendingSharedAttachmentCleanup()).resolves.toBeUndefined();
    expect(isSecureShareStagingCleanupRequired()).toBe(false);
    expect(observed).toEqual([true, false]);
    expect(mocks.native.discardAsync).toHaveBeenCalledTimes(2);
    expect(mocks.native.discardAsync).toHaveBeenNthCalledWith(1, token);
    expect(mocks.native.discardAsync).toHaveBeenNthCalledWith(2, token);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('retries a captured token without deleting a next-session staged share', async () => {
    const nextToken = '66666666-6666-4666-8666-666666666666';
    let releaseSnapshot!: (value: ReturnType<typeof pending>) => void;
    mocks.native.getPendingAsync.mockReturnValueOnce(new Promise((resolve) => {
      releaseSnapshot = resolve;
    }));

    const cleanup = discardAllPendingSharedAttachments();
    releaseSnapshot(pending());
    await vi.waitFor(() => expect(mocks.native.discardAsync).toHaveBeenCalledWith(token));

    // A newer account may stage a different exact token while the older
    // deletion is completing. Cleanup must never fall back to the native
    // account-global root delete.
    mocks.native.getPendingAsync.mockResolvedValue(pending({ token: nextToken }));
    await expect(cleanup).resolves.toBeUndefined();
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    expect(mocks.native.discardAsync).not.toHaveBeenCalledWith(nextToken);
  });

  it('rejects a stale continuation when identity changes during exact native deletion', async () => {
    let current = true;
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending());
    mocks.native.discardAsync.mockImplementationOnce(async () => {
      current = false;
      return true;
    });

    await expect(discardAllPendingSharedAttachments(
      () => current,
      captureSecureShareCleanupBoundary(),
    )).rejects.toMatchObject({ code: 'authorization' });

    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
  });

  it('captures retry tokens before a stalled upload and never absorbs later cleanup work', async () => {
    const begin = beginPendingSharedAttachmentUpload;
    const uploadToken = '66666666-6666-4666-8666-666666666666';
    const nextSessionToken = '77777777-7777-4777-8777-777777777777';
    let finishUpload: ((attachment: ReturnType<typeof uploadedAttachment>) => void) | undefined;
    mocks.native.getPendingAsync.mockResolvedValue(pending({ token: uploadToken }));
    mocks.upload.mockImplementationOnce(() => new Promise((resolve) => {
      finishUpload = resolve;
    }));

    const operation = begin({ kind: 'case', id: caseID }, uploadToken);
    await vi.waitFor(() => expect(finishUpload).toBeTypeOf('function'));
    markSecureShareStagingCleanupRequired(token);
    const retry = retryPendingSharedAttachmentCleanup();
    markSecureShareStagingCleanupRequired(nextSessionToken);

    finishUpload?.(uploadedAttachment());
    await expect(operation.settlement).resolves.toMatchObject({ status: 'uploaded' });
    await expect(retry).resolves.toBeUndefined();
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.native.discardAsync).not.toHaveBeenCalledWith(nextSessionToken);
  });

  it('uses an exact token to reject malformed staging without a global delete', async () => {
    mocks.native.getPendingAsync.mockResolvedValue(pending({ uri: 'content://provider/evidence' }));

    await expect(readPendingSharedAttachment()).rejects.toMatchObject({ code: 'invalid' });
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
  });

  it('lets an unmount catch mark an otherwise unobservable native read failure for retry', () => {
    const observed: boolean[] = [];
    const unsubscribe = subscribeSecureShareStagingCleanup((required) => observed.push(required));

    markSecureShareStagingCleanupRequired(token);

    expect(isSecureShareStagingCleanupRequired()).toBe(true);
    expect(observed).toEqual([true]);
    unsubscribe();
  });

  it('scopes delayed lifecycle cleanup to the exact native token snapshot', async () => {
    const nextToken = '66666666-6666-4666-8666-666666666666';
    mocks.native.captureCleanupTokensAsync.mockResolvedValueOnce([token]);
    const oldBoundary = captureSecureShareCleanupBoundary();
    await discardPendingSharedAttachmentCreatedAtOrBefore(oldBoundary);
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);

    mocks.native.captureCleanupTokensAsync.mockResolvedValueOnce([]);
    const emptyBoundary = captureSecureShareCleanupBoundary();
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending({ token: nextToken }));
    await discardPendingSharedAttachmentCreatedAtOrBefore(emptyBoundary);
    expect(mocks.native.discardAsync).toHaveBeenCalledTimes(1);
    expect(mocks.native.discardAsync).not.toHaveBeenCalledWith(nextToken);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
  });

  it('accepts ordinary fractional monotonic progress inside one wall-clock millisecond', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(500.1);
    mocks.native.captureCleanupTokensAsync.mockResolvedValueOnce([token]);
    const boundary = captureSecureShareCleanupBoundary();
    vi.spyOn(performance, 'now').mockReturnValue(500.2);
    vi.spyOn(Date, 'now').mockReturnValue(now);

    await expect(discardPendingSharedAttachmentCreatedAtOrBefore(boundary)).resolves.toBeUndefined();

    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
  });

  it('fails closed when the native token snapshot cannot be read', async () => {
    mocks.native.captureCleanupTokensAsync.mockRejectedValueOnce(new Error('native storage unavailable'));
    const boundary = captureSecureShareCleanupBoundary();

    await expect(discardAllPendingSharedAttachments(
      () => true,
      boundary,
    )).rejects.toMatchObject({ code: 'cleanup' });

    expect(mocks.native.discardAsync).not.toHaveBeenCalled();
  });

  it('rejects a stale lifecycle continuation while an atomic native snapshot is pending', async () => {
    let current = true;
    let releaseSnapshot: ((tokens: string[]) => void) | undefined;
    mocks.native.captureCleanupTokensAsync.mockReturnValueOnce(new Promise((resolve) => {
      releaseSnapshot = resolve;
    }));
    const boundary = captureSecureShareCleanupBoundary();
    const cleanup = discardAllPendingSharedAttachments(() => current, boundary);

    current = false;
    releaseSnapshot?.([token]);

    await expect(cleanup).rejects.toMatchObject({ code: 'authorization' });
    expect(mocks.native.discardAsync).not.toHaveBeenCalled();
  });

  it('latches every captured native token before the first exact deletion can fail', async () => {
    const secondToken = '66666666-6666-4666-8666-666666666666';
    mocks.native.captureCleanupTokensAsync.mockResolvedValueOnce([token, secondToken]);
    mocks.native.discardAsync.mockResolvedValueOnce(false);
    const boundary = captureSecureShareCleanupBoundary();

    await expect(discardAllPendingSharedAttachments(() => true, boundary))
      .rejects.toMatchObject({ code: 'cleanup' });
    mocks.native.discardAsync.mockResolvedValue(true);
    await expect(retryPendingSharedAttachmentCleanup()).resolves.toBeUndefined();

    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(secondToken);
    expect(isSecureShareStagingCleanupRequired()).toBe(false);
  });

  it('delegates one-shot payload deletion to the attachment transaction before clearing its manifest', async () => {
    mocks.native.getPendingAsync.mockResolvedValue(pending());
    await expect(uploadPendingSharedAttachment({ kind: 'case', id: caseID }, token)).resolves.toBeUndefined();
    expect(mocks.upload).toHaveBeenCalledWith(
      { kind: 'case', id: caseID },
      expect.objectContaining({ uri: 'file:///private/staging/payload' }),
      { fileID: uploadID, writer: expect.objectContaining({ userId: userID }) },
    );
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
  });

  it('retries only native cleanup after a confirmed upload instead of uploading again', async () => {
    mocks.native.getPendingAsync.mockResolvedValue(pending());
    mocks.native.discardAsync
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await expect(uploadPendingSharedAttachment({ kind: 'case', id: caseID }, token)).rejects.toMatchObject({
      code: 'cleanup',
    });
    expect(isSecureShareStagingCleanupRequired()).toBe(true);
    await expect(retryPendingSharedAttachmentCleanup()).resolves.toBeUndefined();

    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.native.discardAsync).toHaveBeenCalledTimes(3);
    expect(mocks.native.discardAsync.mock.calls).toEqual([[token], [token], [token]]);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    expect(isSecureShareStagingCleanupRequired()).toBe(false);
  });

  it('does not report upload success until native staging deletion is confirmed', async () => {
    mocks.native.getPendingAsync.mockResolvedValue(pending());
    mocks.native.discardAsync.mockResolvedValue(false);
    mocks.native.discardAllAsync.mockResolvedValue(false);

    await expect(uploadPendingSharedAttachment({ kind: 'case', id: caseID }, token)).rejects.toMatchObject({
      code: 'cleanup',
    });
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.native.discardAsync.mock.calls).toEqual([[token], [token]]);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    expect(isSecureShareStagingCleanupRequired()).toBe(true);
  });

  it('blocks a duplicate retry when attachment rollback cannot confirm remote cleanup', async () => {
    mocks.native.getPendingAsync.mockResolvedValue(pending());
    mocks.upload.mockRejectedValue(new AttachmentError(
      'cleanup',
      'The upload did not complete and cleanup could not be confirmed. Refresh this record before trying again.',
    ));

    await expect(uploadPendingSharedAttachment({ kind: 'case', id: caseID }, token)).rejects.toMatchObject({
      code: 'remote-cleanup',
    });
    expect(mocks.native.discardAsync).not.toHaveBeenCalled();
  });

  it('preserves one exact deferred upload while lifecycle cleanup waits for its settlement', async () => {
    const begin = beginPendingSharedAttachmentUpload;
    const current = getPendingSharedAttachmentUpload;
    const canDiscard = pendingShareStagingCanBeDiscarded;

    let resolveUpload: ((attachment: ReturnType<typeof uploadedAttachment>) => void) | undefined;
    mocks.native.getPendingAsync.mockResolvedValue(pending());
    mocks.upload.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));

    const operation = begin({ kind: 'case', id: caseID }, token);
    const sameOperation = begin({ kind: 'case', id: caseID }, token);
    expect(operation).toBe(sameOperation);
    expect(operation.attachmentID).toBe(uploadID);
    expect(current()).toBe(operation);
    expect(canDiscard()).toBe(false);

    const lifecycleCleanup = discardAllPendingSharedAttachments();
    await vi.waitFor(() => expect(resolveUpload).toBeTypeOf('function'));
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();

    resolveUpload?.(uploadedAttachment());
    await expect(operation.settlement).resolves.toMatchObject({
      status: 'uploaded',
      attachmentID: uploadID,
      attachment: { id: uploadID },
    });
    await expect(lifecycleCleanup).resolves.toBeUndefined();
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.upload).toHaveBeenCalledWith(
      { kind: 'case', id: caseID },
      expect.objectContaining({ uri: 'file:///private/staging/payload' }),
      { fileID: uploadID, writer: expect.objectContaining({ userId: userID }) },
    );
    expect(mocks.native.discardAsync.mock.calls).toEqual([[token], [token]]);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
  });

  it('durably binds the exact operation to its authenticated user and backend before remote upload', async () => {
    const begin = beginPendingSharedAttachmentUpload;
    const readRecovery = readPendingSharedAttachmentUploadRecovery;
    const acknowledge = acknowledgePendingSharedAttachmentUpload;

    let resolveUpload: ((attachment: ReturnType<typeof uploadedAttachment>) => void) | undefined;
    mocks.native.getPendingAsync.mockResolvedValue(pending());
    mocks.upload.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));

    const operation = begin({ kind: 'case', id: caseID }, token);
    await vi.waitFor(() => expect(resolveUpload).toBeTypeOf('function'));
    expect(mocks.secureStore.setItemAsync).toHaveBeenCalledOnce();
    expect(mocks.secureStore.setItemAsync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.upload.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(JSON.parse(mocks.secureValue ?? '{}')).toEqual({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    await expect(readRecovery()).resolves.toMatchObject({ attachmentID: uploadID, userID, status: 'uploading' });

    (mocks.client?.auth as { getUser: ReturnType<typeof vi.fn> }).getUser
      .mockResolvedValue({ data: { user: { id: '66666666-6666-4666-8666-666666666666' } }, error: null });
    await expect(readRecovery()).rejects.toMatchObject({ code: 'authorization' });
    expect(mocks.secureStore.deleteItemAsync).not.toHaveBeenCalled();

    (mocks.client?.auth as { getUser: ReturnType<typeof vi.fn> }).getUser
      .mockResolvedValue({ data: { user: { id: userID } }, error: null });
    resolveUpload?.(uploadedAttachment());
    await expect(operation.settlement).resolves.toMatchObject({ status: 'uploaded', attachmentID: uploadID });
    expect(JSON.parse(mocks.secureValue ?? '{}')).toMatchObject({
      attachmentID: uploadID,
      status: 'uploaded',
    });
    expect(mocks.secureStore.setItemAsync.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.native.discardAsync.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );

    await expect(acknowledge(uploadID)).resolves.toBe(true);
    expect(mocks.secureValue).toBeNull();
    expect(mocks.secureStore.deleteItemAsync).toHaveBeenCalledOnce();
  });

  it('quarantines another account cold marker before starting a new exact operation', async () => {
    const begin = beginPendingSharedAttachmentUpload;
    const priorMarker = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID: '66666666-6666-4666-8666-666666666666',
      attachmentID: '77777777-7777-4777-8777-777777777777',
      token: '88888888-8888-4888-8888-888888888888',
      target: { kind: 'task', id: taskID },
      status: 'uploading',
    });
    mocks.secureValue = priorMarker;
    mocks.native.getPendingAsync.mockResolvedValue(pending());

    const operation = begin({ kind: 'case', id: caseID }, token);
    await expect(operation.settlement).resolves.toMatchObject({
      status: 'uploaded',
      attachmentID: uploadID,
    });
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.quarantineValue ?? '{}')).toMatchObject({
      version: 1,
      recoveries: [expect.objectContaining({
        userID: '66666666-6666-4666-8666-666666666666',
        attachmentID: '77777777-7777-4777-8777-777777777777',
      })],
    });
    await acknowledgePendingSharedAttachmentUpload(uploadID);
    expect(mocks.secureValue).toBeNull();
  });

  it('clears a cold foreign-account staged payload before establishing the current account', async () => {
    const prepareSession = preparePendingSharedAttachmentUploadForSessionEstablishment;
    const otherUserID = '66666666-6666-4666-8666-666666666666';
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: otherUserID } }, error: null }) },
    };
    mocks.secureValue = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending());

    await expect(prepareSession(otherUserID)).resolves.toBeUndefined();
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.secureValue).toBeNull();
    expect(JSON.parse(mocks.quarantineValue ?? '{}')).toMatchObject({
      recoveries: [expect.objectContaining({ userID, attachmentID: uploadID })],
    });
  });

  it('reconciles a cold exact-ID marker without ever treating ambiguity as permission to reshare', async () => {
    const reconcileRecovery = reconcilePendingSharedAttachmentUploadRecovery;
    const acknowledge = acknowledgePendingSharedAttachmentUpload;

    const marker = {
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    };
    mocks.secureValue = JSON.stringify(marker);
    mocks.reconcile.mockResolvedValueOnce({ status: 'confirmed', attachment: uploadedAttachment() });

    await expect(reconcileRecovery()).resolves.toMatchObject({
      status: 'uploaded',
      attachmentID: uploadID,
      attachment: { id: uploadID },
    });
    expect(mocks.reconcile).toHaveBeenCalledWith({ kind: 'case', id: caseID }, uploadID, { writer: expect.objectContaining({ userId: userID }) });
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(JSON.parse(mocks.secureValue ?? '{}')).toMatchObject({ status: 'uploaded' });
    await expect(acknowledge(uploadID)).resolves.toBe(true);

    mocks.secureValue = JSON.stringify(marker);
    mocks.reconcile.mockResolvedValueOnce({ status: 'aborted' });
    await expect(reconcileRecovery()).resolves.toEqual({ status: 'absent', attachmentID: uploadID });
    expect(mocks.secureValue).toBeNull();

    mocks.secureValue = JSON.stringify(marker);
    mocks.reconcile.mockResolvedValueOnce({ status: 'uncertain' });
    await expect(reconcileRecovery()).resolves.toEqual({ status: 'uncertain', attachmentID: uploadID });
    expect(mocks.secureValue).toBe(JSON.stringify(marker));
  });

  it('reports a refused shared file as rejected and clears its marker on the durable cleanup path', async () => {
    const reconcileRecovery = reconcilePendingSharedAttachmentUploadRecovery;

    const marker = {
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    };
    mocks.secureValue = JSON.stringify(marker);
    // reconcileAuthorizedAttachmentUpload only answers 'rejected' after an exact
    // abort receipt, so the rollback is already proven when this arrives.
    mocks.reconcile.mockResolvedValueOnce({ status: 'rejected' });

    await expect(reconcileRecovery()).resolves.toEqual({ status: 'rejected', attachmentID: uploadID });
    expect(mocks.secureValue).toBeNull();
    expect(mocks.quarantineValue).toBeNull();
  });

  it('clears the recovery marker once a queued cleanup becomes a proven service deletion', async () => {
    // rejected -> cleanupQueued -> service deletion -> next recovery clears the
    // marker. The first pass is genuinely unresolved: a real rejected upload
    // still has bytes, so its abort can only queue cleanup and the marker is
    // deliberately retained. The pass after the service reconciler removes the
    // object and the row must NOT be mistaken for a stale MFA session, or the
    // member reauthenticates forever while share intake stays blocked.
    const reconcileRecovery = reconcilePendingSharedAttachmentUploadRecovery;

    const marker = {
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    };

    mocks.secureValue = JSON.stringify(marker);
    mocks.reconcile.mockResolvedValueOnce({ status: 'uncertain' });
    await expect(reconcileRecovery()).resolves.toEqual({ status: 'uncertain', attachmentID: uploadID });
    expect(mocks.secureValue).toBe(JSON.stringify(marker));
    expect(mocks.native.discardAsync).not.toHaveBeenCalled();

    // reconcileAuthorizedAttachmentUpload answers 'aborted' only after an exact
    // absent/deleted receipt for this file id, so the row and its bytes are
    // provably gone by the time this arrives.
    mocks.reconcile.mockResolvedValueOnce({ status: 'aborted' });
    await expect(reconcileRecovery()).resolves.toEqual({ status: 'absent', attachmentID: uploadID });
    expect(mocks.secureValue).toBeNull();
    expect(mocks.quarantineValue).toBeNull();
  });

  it('surfaces a stale-session inspection refusal as re-auth without confirming or discarding the upload', async () => {
    const reconcileRecovery = reconcilePendingSharedAttachmentUploadRecovery;

    // DECISIONS E4: MFA stays required on inspection for every kind, so the
    // share sheet must prompt re-auth rather than retry a call that fails
    // identically every time. Fail-closed: nothing confirmed, nothing aborted,
    // and the durable recovery marker is KEPT so the same exact upload is
    // reconciled once the member verifies.
    const marker = {
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    };
    mocks.secureValue = JSON.stringify(marker);
    mocks.reconcile.mockResolvedValueOnce({ status: 'reauth-required' });

    await expect(reconcileRecovery()).resolves.toEqual({ status: 'reauth-required', attachmentID: uploadID });
    expect(mocks.secureValue).toBe(JSON.stringify(marker));
    expect(mocks.native.discardAsync).not.toHaveBeenCalled();
  });

  it('clears the marker for a cleanup-queued upload instead of asking the worker to verify again', async () => {
    const reconcileRecovery = reconcilePendingSharedAttachmentUploadRecovery;

    // #6270 acc 3: a share the safety check refused was aborted by its own
    // upload, so the row is hidden and queued for the service reconciler. The
    // abort that answered proved the session, so this is not a reauth case:
    // nothing was attached, the marker is cleared and sharing is unblocked.
    const marker = {
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    };
    mocks.secureValue = JSON.stringify(marker);
    mocks.reconcile.mockResolvedValueOnce({ status: 'cleanup-queued' });

    await expect(reconcileRecovery()).resolves.toEqual({ status: 'cleanup-queued', attachmentID: uploadID });
    expect(mocks.secureValue).toBeNull();
    expect(mocks.quarantineValue).toBeNull();
  });

  it('maps a 403 inspection during a shared upload to a re-auth error that blocks reshare', async () => {
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending());
    mocks.upload.mockRejectedValueOnce(new AttachmentError(
      'cleanup',
      'Verify it is you before this file can be checked. Nothing was attached yet.',
      { reauthRequired: true },
    ));

    await expect(uploadPendingSharedAttachment({ kind: 'case', id: caseID }, token))
      .rejects.toMatchObject({
        code: 'remote-cleanup',
        reauthRequired: true,
        message: 'Verify it is you before this file can be checked. Nothing was attached yet.',
      });
    // A session refusal is not a reshare: the marker stays for the reconciler.
    expect(mocks.secureValue).not.toBeNull();
  });

  // Text pin for the screen wiring this file cannot reach through a render —
  // honest about being a tripwire rather than behavioural proof.
  it('routes a share-sheet inspection re-auth to the MFA challenge instead of a generic retry', () => {
    const screen = readFileSync(fileURLToPath(new URL('../../app/share-intake.tsx', import.meta.url)), 'utf8');
    // DECISIONS E4 assigns the re-auth prompt to this entry point specifically.
    expect(screen).toContain('const [reauthRequired, setReauthRequired] = useState(false);');
    expect(screen).toContain("if (recovered.status === 'reauth-required') {");
    expect(screen).toContain('setReauthRequired(error.reauthRequired);');
    expect(screen).toContain("pathname: '/mfa-challenge'");
    expect(screen).toContain("forceReverify: '1'");
    expect(screen).toContain("resume: 'share-intake'");
    expect(screen).toContain('<StateMessage\n              title="Verify it is you"');
    // The re-auth state must win over the generic interrupted-upload copy.
    expect(screen.indexOf(') : reauthRequired ? (')).toBeLessThan(
      screen.indexOf('remoteCleanupUnconfirmed && recoveredUpload.current && !pending ? ('),
    );
    // Fail closed: the recovery marker is never acknowledged on this path.
    const recoveryBranch = screen.slice(
      screen.indexOf("if (recovered.status === 'reauth-required') {"),
      screen.indexOf("if (recovered.status === 'uncertain') {"),
    );
    expect(recoveryBranch).not.toContain('acknowledgePendingSharedAttachmentUpload');
  });

  it('does not leave a refused shared upload confirmed, and allows a fresh share afterwards', async () => {
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending());
    // uploadAuthorizedAttachment surfaces a safety-check refusal only after its
    // own abort succeeded, so an 'upload' failure here means nothing was
    // attached and nothing is left behind.
    mocks.upload.mockRejectedValueOnce(new AttachmentError(
      'upload',
      'This file was rejected by the safety check and was not attached.',
      { rejected: true },
    ));

    await expect(uploadPendingSharedAttachment({ kind: 'case', id: caseID }, token))
      .rejects.toMatchObject({
        code: 'upload',
        message: 'This file was rejected by the safety check and was not attached.',
      });
    expect(mocks.secureValue).toBeNull();
    expect(mocks.quarantineValue).toBeNull();

    mocks.native.getPendingAsync.mockResolvedValueOnce(pending());
    mocks.upload.mockResolvedValueOnce(uploadedAttachment());
    await expect(uploadPendingSharedAttachment({ kind: 'case', id: caseID }, token)).resolves.toBeUndefined();
  });

  it('treats a cold uploaded checkpoint as terminal after its account boundary even if target access was revoked', async () => {
    const reconcileRecovery = reconcilePendingSharedAttachmentUploadRecovery;
    const acknowledge = acknowledgePendingSharedAttachmentUpload;
    mocks.secureValue = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploaded',
    });
    mocks.reconcile.mockRejectedValue(new Error('target authorization revoked after exact upload'));

    await expect(reconcileRecovery()).resolves.toEqual({ status: 'uploaded', attachmentID: uploadID });
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(JSON.parse(mocks.secureValue ?? '{}')).toMatchObject({ status: 'uploaded' });
    await expect(acknowledge(uploadID)).resolves.toBe(true);
    expect(mocks.secureValue).toBeNull();
  });

  it('clears an uploaded checkpoint and every pre-sign-out staged sibling without re-reading a revoked target', async () => {
    const prepareSignOut = preparePendingSharedAttachmentUploadForSignOut;
    const capturedSibling = '66666666-6666-4666-8666-666666666666';
    const latchedSibling = '77777777-7777-4777-8777-777777777777';
    mocks.native.captureCleanupTokensAsync.mockResolvedValueOnce([token, capturedSibling]);
    markSecureShareStagingCleanupRequired(latchedSibling);
    mocks.secureValue = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'task', id: taskID },
      status: 'uploaded',
    });
    mocks.reconcile.mockRejectedValue(new Error('target authorization revoked after exact upload'));

    await expect(prepareSignOut(userID)).resolves.toBeUndefined();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(capturedSibling);
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(latchedSibling);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    expect(mocks.secureValue).toBeNull();
  });

  it('blocks sign-out rather than discarding an ambiguous uploading checkpoint', async () => {
    const prepareSignOut = preparePendingSharedAttachmentUploadForSignOut;
    const marker = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    mocks.secureValue = marker;
    mocks.reconcile.mockResolvedValue({ status: 'uncertain' });

    await expect(prepareSignOut(userID)).rejects.toMatchObject({ code: 'remote-cleanup' });
    expect(mocks.secureValue).toBe(marker);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
  });

  it('clears a recovery-free sign-out payload by exact token instead of a device-global delete', async () => {
    const prepareSignOut = preparePendingSharedAttachmentUploadForSignOut;
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending());

    await expect(prepareSignOut(userID)).resolves.toBeUndefined();

    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
  });

  it('clears recovery-free local staging without waiting for unreachable Auth', async () => {
    mocks.client = {
      auth: { getUser: vi.fn(() => new Promise(() => undefined)) },
    };
    mocks.native.getPendingAsync.mockResolvedValue(pending());

    const result = await Promise.race([
      preparePendingSharedAttachmentUploadForSignOut(userID).then(() => 'cleared'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);

    expect(result).toBe('cleared');
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
  });

  it('keeps an interrupted upload when Auth cannot verify its account at sign-out', async () => {
    const marker = JSON.stringify({
      version: 1, backend: 'https://sample-boundary.supabase.co', userID,
      attachmentID: uploadID, token, target: { kind: 'case', id: caseID }, status: 'uploading',
    });
    mocks.secureValue = marker;
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('offline') }) },
    };

    await expect(preparePendingSharedAttachmentUploadForSignOut(userID))
      .rejects.toMatchObject({ code: 'authorization' });
    expect(mocks.secureValue).toBe(marker);
    expect(mocks.native.discardAsync).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('lets B sign out with A quarantined and later recovers A without another upload', async () => {
    const otherUserID = '66666666-6666-4666-8666-666666666666';
    const otherUploadID = '77777777-7777-4777-8777-777777777777';
    const otherToken = '88888888-8888-4888-8888-888888888888';
    mocks.secureValue = JSON.stringify({
      version: 1, backend: 'https://sample-boundary.supabase.co', userID,
      attachmentID: uploadID, token, target: { kind: 'case', id: caseID }, status: 'uploading',
    });
    await expect(preparePendingSharedAttachmentUploadForSessionLoss(userID))
      .resolves.toBe('recovery-required');
    const quarantine = mocks.quarantineValue;
    expect(quarantine).not.toBeNull();
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: otherUserID } }, error: null }) },
    };
    await preparePendingSharedAttachmentUploadForSessionEstablishment(otherUserID);
    mocks.cryptoUUID.mockReturnValueOnce(otherUploadID);
    mocks.native.getPendingAsync.mockResolvedValue(pending({ token: otherToken }));
    mocks.upload.mockResolvedValueOnce(uploadedAttachment({ id: otherUploadID }));
    await uploadPendingSharedAttachment({ kind: 'task', id: taskID }, otherToken, stubAttachmentWriter(() => mocks.client, otherUserID));
    expect(mocks.secureValue).toBeNull();

    mocks.native.discardAsync.mockClear();
    const offlineAuth = vi.fn().mockRejectedValue(new Error('offline'));
    mocks.client = { auth: { getUser: offlineAuth } };
    await expect(preparePendingSharedAttachmentUploadForSignOut(otherUserID))
      .resolves.toBeUndefined();
    expect(mocks.native.discardAsync.mock.calls).toEqual([[otherToken]]);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    expect(mocks.quarantineValue).toBe(quarantine);
    expect(mocks.secureValue).toBeNull();
    expect(offlineAuth).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();

    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userID } }, error: null }) },
    };
    mocks.reconcile.mockResolvedValueOnce({ status: 'uploaded', attachment: uploadedAttachment() });
    await expect(preparePendingSharedAttachmentUploadForSessionEstablishment(userID))
      .resolves.toBeUndefined();
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith({ kind: 'case', id: caseID }, uploadID, { writer: expect.objectContaining({ userId: userID }) });
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.secureValue).toBeNull();
    expect(mocks.quarantineValue).toBeNull();
  });

  it('leaves the same user quarantine on another backend untouched at sign-out', async () => {
    const quarantine = JSON.stringify({
      version: 1,
      recoveries: [{
        version: 1, backend: 'https://other-boundary.supabase.co', userID,
        attachmentID: uploadID, token, target: { kind: 'case', id: caseID }, status: 'uploading',
      }],
    });
    mocks.quarantineValue = quarantine;
    const currentToken = '88888888-8888-4888-8888-888888888888';
    mocks.native.getPendingAsync.mockResolvedValue(pending({ token: currentToken }));
    const offlineAuth = vi.fn().mockRejectedValue(new Error('offline'));
    mocks.client = { auth: { getUser: offlineAuth } };

    await expect(preparePendingSharedAttachmentUploadForSignOut(userID))
      .resolves.toBeUndefined();
    expect(mocks.native.discardAsync.mock.calls).toEqual([[currentToken]]);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    expect(mocks.quarantineValue).toBe(quarantine);
    expect(mocks.secureValue).toBeNull();
    expect(offlineAuth).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('still requires authenticated recovery for the signing-out account quarantine', async () => {
    const recovery = {
      version: 1, backend: 'https://sample-boundary.supabase.co', userID,
      attachmentID: uploadID, token, target: { kind: 'case', id: caseID }, status: 'uploading',
    };
    mocks.quarantineValue = JSON.stringify({ version: 1, recoveries: [recovery] });

    await expect(preparePendingSharedAttachmentUploadForSignOut(userID))
      .rejects.toMatchObject({ code: 'remote-cleanup' });
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith({ kind: 'case', id: caseID }, uploadID, { writer: expect.objectContaining({ userId: userID }) });
    expect(JSON.parse(mocks.secureValue ?? '{}')).toEqual(recovery);
    expect(mocks.native.discardAsync).not.toHaveBeenCalled();
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
  });

  it('cannot reserve an upload between the empty recovery check and exact-token sign-out discard', async () => {
    let staged = true;
    let releaseCapture!: (tokens: string[]) => void;
    let releaseUpload: ((attachment: ReturnType<typeof uploadedAttachment>) => void) | undefined;
    let recoveryRead!: () => void;
    const recoveryObserved = new Promise<void>((resolve) => { recoveryRead = resolve; });
    mocks.native.getPendingAsync.mockImplementation(async () => staged ? pending() : null);
    mocks.native.captureCleanupTokensAsync.mockImplementationOnce(() => new Promise<string[]>((resolve) => { releaseCapture = resolve; }));
    mocks.native.discardAsync.mockImplementation(async () => { staged = false; return true; });
    mocks.upload.mockImplementation(() => new Promise((resolve) => { releaseUpload = resolve; }));
    mocks.secureStore.getItemAsync.mockImplementation(async (key: string) => {
      if (key.includes('quarantine')) { recoveryRead(); return mocks.quarantineValue; }
      return mocks.secureValue;
    });
    const cleanup = preparePendingSharedAttachmentUploadForSignOut(userID);
    let operation: ReturnType<typeof beginPendingSharedAttachmentUpload> | undefined;
    try {
      await recoveryObserved;
      await new Promise((resolve) => setTimeout(resolve, 0));
      operation = beginPendingSharedAttachmentUpload({ kind: 'case', id: caseID }, token);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mocks.secureStore.setItemAsync).not.toHaveBeenCalled();
      expect(mocks.upload).not.toHaveBeenCalled();
      releaseCapture([token]);
      await cleanup;
      await expect(operation.settlement).resolves.toMatchObject({ status: 'failed', error: { code: 'expired' } });
      expect(mocks.secureValue).toBeNull();
      expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    } finally {
      releaseCapture([token]);
      releaseUpload?.(uploadedAttachment());
      await cleanup.catch(() => undefined);
      if (operation) {
        await operation.settlement;
        await acknowledgePendingSharedAttachmentUpload(operation.attachmentID);
      }
    }
  });

  it('stops sign-out staging cleanup when exact auth ownership changes during the native read', async () => {
    const prepareSignOut = preparePendingSharedAttachmentUploadForSignOut;
    let current = true;
    let finishRead: ((value: ReturnType<typeof pending>) => void) | undefined;
    mocks.native.getPendingAsync.mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = resolve;
    }));

    const staleCleanup = prepareSignOut(userID, () => current);
    await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
    current = false;
    finishRead?.(pending());

    await expect(staleCleanup).rejects.toMatchObject({ code: 'authorization' });
    expect(mocks.native.discardAsync).not.toHaveBeenCalled();
  });

  it('keeps a next-session share intact when a delayed preview exit loses its boundary', async () => {
    const preparePreviewExit = preparePendingSharedAttachmentStagingForPreviewExit;
    const prepareSession = preparePendingSharedAttachmentUploadForSessionEstablishment;
    const otherUserID = '66666666-6666-4666-8666-666666666666';
    const otherToken = '88888888-8888-4888-8888-888888888888';
    let finishPreviewRead: ((value: ReturnType<typeof pending>) => void) | undefined;
    mocks.native.getPendingAsync.mockImplementationOnce(() => new Promise((resolve) => {
      finishPreviewRead = resolve;
    }));

    const stalePreviewExit = preparePreviewExit();
    await vi.waitFor(() => expect(mocks.native.getPendingAsync).toHaveBeenCalledOnce());
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: otherUserID } }, error: null }) },
    };
    await expect(prepareSession(otherUserID)).resolves.toBeUndefined();
    mocks.native.getPendingAsync.mockResolvedValue(pending({ token: otherToken }));
    finishPreviewRead?.(pending());

    await expect(stalePreviewExit).rejects.toMatchObject({ code: 'authorization' });
    expect(mocks.native.discardAsync).not.toHaveBeenCalled();
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    await expect(readPendingSharedAttachment()).resolves.toMatchObject({ token: otherToken });
  });

  it('settles a terminal uploaded checkpoint and its staged siblings on involuntary session loss without requiring live auth', async () => {
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    const siblingToken = '66666666-6666-4666-8666-666666666666';
    mocks.native.captureCleanupTokensAsync.mockResolvedValueOnce([token, siblingToken]);
    const getUser = vi.fn().mockRejectedValue(new Error('session already revoked'));
    mocks.client = { auth: { getUser } };
    mocks.secureValue = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'task', id: taskID },
      status: 'uploaded',
    });

    await expect(prepareSessionLoss(userID)).resolves.toBe('ready');
    expect(getUser).not.toHaveBeenCalled();
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(siblingToken);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    expect(mocks.secureValue).toBeNull();
  });

  it('finishes accepted MFA recovery with a revoked-session uploading marker quarantined, without an authenticated recovery probe', async () => {
    const source = readFileSync(new URL('../state/AppProvider.tsx', import.meta.url), 'utf8');
    const tree = ts.createSourceFile('AppProvider.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const callbacks = new Map<string, string>();
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) callbacks.set(node.name.getText(tree), node.initializer.arguments[0]?.getText(tree) ?? '');
      ts.forEachChild(node, visit);
    }
    visit(tree);
    const captured = { user: { id: userID }, access_token: `header.${btoa(JSON.stringify({ session_id: caseID }))}.signature`, refresh_token: 'captured-refresh' } as Session;
    let stored: Session | null = captured;
    const getUser = vi.fn(async () => ({ data: { user: null }, error: { code: 'session_not_found', status: 403 } }));
    mocks.client = { auth: { getUser } };
    mocks.secureValue = JSON.stringify({ version: 1, backend: 'https://sample-boundary.supabase.co', userID,
      attachmentID: uploadID, token, target: { kind: 'task', id: taskID }, status: 'uploading' });
    mocks.native.getPendingAsync.mockResolvedValue(pending());
    const noOp = vi.fn(async () => undefined);
    const clear = vi.fn(async (session: Session) => {
      if (!stored || !exactSessionIdentityMatches(exactSessionIdentity(stored), exactSessionIdentity(session))) return false;
      stored = null; return true;
    });
    const environment = {
      mode: 'mfaRequired', session: captured, providerMounted: { current: true },
      activeUserID: { current: userID as string | null }, observedAuthIdentity: { current: exactSessionIdentity(captured) },
      authIdentityMatches: (identity: ReturnType<typeof exactSessionIdentity>, session: Session) => exactSessionIdentityMatches(identity, exactSessionIdentity(session)),
      accessTokensShareSessionLineage, exactSessionIdentity, exactSessionIdentityMatches,
      sessionSignOutAttempts: createSessionSignOutAttemptCoordinator(), nativeAuthGate: createNativeAuthGate(),
      pendingAuthTransition: { current: null }, sessionTransition: { current: 0 }, sessionResumeGuard: { invalidate: vi.fn() },
      sessionRetryOwner: { current: null }, setSessionRetryInFlight: vi.fn(),
      sessionResumeAttempts: { hasActive: () => false }, deferredForegroundResume: { current: false },
      shareIsolationBlocked: { current: false }, blockedShareIsolation: { current: null },
      captureSessionWriter: () => ({ userId: userID, session: async () => captured }),
      recordLifecycleEvent: vi.fn(),
      purgeHomeWidgets: vi.fn(), purgeAttachmentCacheForSignOut: noOp,
      preparePendingSharedAttachmentUploadForSignOut: rawShare.preparePendingSharedAttachmentUploadForSignOut,
      preparePendingSharedAttachmentUploadForSessionLoss, captureSecureShareCleanupBoundary,
      clearCapturedMobileSessionLocally: clear, signInCompletion: { settle: vi.fn() }, setSignInNotice: vi.fn(),
      accountLocalTeardown: { request: vi.fn(async () => true) }, requestOfflineSignOutCleanup: noOp,
      purgeAttachmentCacheForSessionLoss: vi.fn(async () => true), clearLocalNotificationPreference: noOp,
      clearProtectedState: vi.fn(), setSession: vi.fn(), setMode: vi.fn(), setLocked: vi.fn(), setPrivacyCovered: vi.fn(),
      setAssuranceUnavailable: vi.fn(), setError: vi.fn(), setSignOutError: vi.fn(),
      setGlobalSignOutIncompleteSignedOut: vi.fn(), globalSignOutIncompleteRef: { current: false },
      lastAuthenticatedUserIDRef: { current: userID }, lastAuthenticatedSessionIDRef: { current: caseID },
      haptics: { warning: noOp },
    };
    // The old screen calls ordinary signOut. Running that real callback at
    // the parent reproduces its authenticated-share prerequisite refusal.
    const finish = runInNewContext(ts.transpile(`(${callbacks.get('finishMfaRecovery') ?? callbacks.get('signOut')})`, { target: ts.ScriptTarget.ES2022 }), environment) as (attempt: { userID: string; session: Session; latch: null }) => Promise<void | boolean>;
    const outcome = await redeemMfaRecoveryCode('UG-1A2B-3C4D-5E6F-7089', {
      apiOrigin: () => 'https://sample.unionground.example', accessToken: async () => captured.access_token,
      request: async () => ({ ok: true, status: 200, json: async () => ({ recovered: true, sessionsRevoked: true }) }),
      signOutLocally: () => finish({ userID, session: captured, latch: null }),
    });
    expect(stored, `revoked-session probes: ${getUser.mock.calls.length}`).toBeNull();
    expect(outcome).toBe('recovered');
    expect(environment.setMode).toHaveBeenLastCalledWith('signedOut');
    expect(clear).toHaveBeenCalledExactlyOnceWith(captured);
    expect(getUser).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.secureValue).toBeNull();
    expect(mocks.quarantineValue).toContain(uploadID);
    expect(mocks.quarantineValue).toContain('uploading');
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
  });

  it('preserves a next-session share staged after a recovery-free loss boundary', async () => {
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    const nextSessionToken = '66666666-6666-4666-8666-666666666666';
    let finishRecoveryRead: ((value: null) => void) | undefined;
    mocks.secureStore.getItemAsync.mockImplementationOnce(() => new Promise((resolve) => {
      finishRecoveryRead = resolve;
    }));

    mocks.native.captureCleanupTokensAsync.mockResolvedValueOnce([]);
    const loss = prepareSessionLoss(userID, captureSecureShareCleanupBoundary());
    await vi.waitFor(() => expect(finishRecoveryRead).toBeTypeOf('function'));
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending({
      token: nextSessionToken,
      createdAtMs: now + 1,
    }));
    finishRecoveryRead?.(null);

    await expect(loss).resolves.toBe('ready');
    expect(mocks.native.discardAsync).not.toHaveBeenCalledWith(nextSessionToken);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
  });

  it('cleans a share included in the native loss-boundary snapshot', async () => {
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    mocks.native.captureCleanupTokensAsync.mockResolvedValueOnce([token]);

    await expect(prepareSessionLoss(
      userID,
      captureSecureShareCleanupBoundary(),
    )).resolves.toBe('ready');

    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
  });

  it('keeps an ambiguous checkpoint recoverable after involuntary session loss', async () => {
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    const siblingToken = '66666666-6666-4666-8666-666666666666';
    mocks.native.captureCleanupTokensAsync.mockResolvedValueOnce([token, siblingToken]);
    const marker = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    mocks.secureValue = marker;

    await expect(prepareSessionLoss(userID)).resolves.toBe('recovery-required');
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(siblingToken);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    expect(mocks.secureValue).toBeNull();
    expect(JSON.parse(mocks.quarantineValue ?? '{}')).toMatchObject({
      version: 1,
      recoveries: [expect.objectContaining({ userID, attachmentID: uploadID, status: 'uploading' })],
    });
    const quarantineWrite = mocks.secureStore.setItemAsync.mock.invocationCallOrder.find((_, index) => (
      String(mocks.secureStore.setItemAsync.mock.calls[index]?.[0]).includes('quarantine')
    ));
    const activeDelete = mocks.secureStore.deleteItemAsync.mock.invocationCallOrder.find((_, index) => (
      !String(mocks.secureStore.deleteItemAsync.mock.calls[index]?.[0]).includes('quarantine')
    ));
    const stagingDelete = mocks.native.discardAsync.mock.invocationCallOrder[0];
    expect(quarantineWrite).toBeDefined();
    expect(stagingDelete).toBeDefined();
    expect(activeDelete).toBeDefined();
    if (quarantineWrite === undefined || stagingDelete === undefined || activeDelete === undefined) return;
    expect(quarantineWrite).toBeLessThan(stagingDelete);
    expect(stagingDelete).toBeLessThan(activeDelete);
  });

  it('leaves the active exact marker intact when quarantine persistence fails', async () => {
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    const marker = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    mocks.secureValue = marker;
    mocks.secureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
      if (key.includes('quarantine')) throw new Error('secure storage unavailable');
      mocks.secureValue = value;
    });

    await expect(prepareSessionLoss(userID)).rejects.toMatchObject({ code: 'remote-cleanup' });
    expect(mocks.secureValue).toBe(marker);
    expect(mocks.quarantineValue).toBeNull();
    expect(mocks.secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('lets a different account share while preserving the original account exact recovery', async () => {
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    const prepareSession = preparePendingSharedAttachmentUploadForSessionEstablishment;
    const otherUserID = '66666666-6666-4666-8666-666666666666';
    mocks.secureValue = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });

    await expect(prepareSessionLoss(userID)).resolves.toBe('recovery-required');
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: otherUserID } }, error: null }) },
    };
    await expect(prepareSession(otherUserID)).resolves.toBeUndefined();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.secureValue).toBeNull();

    const otherUploadID = '77777777-7777-4777-8777-777777777777';
    mocks.cryptoUUID.mockReturnValueOnce(otherUploadID);
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending());
    mocks.upload.mockResolvedValueOnce(uploadedAttachment({ id: otherUploadID }));
    await expect(uploadPendingSharedAttachment({ kind: 'task', id: taskID }, token, stubAttachmentWriter(() => mocks.client, otherUserID))).resolves.toBeUndefined();
    expect(mocks.upload).toHaveBeenCalledWith(
      { kind: 'task', id: taskID },
      expect.objectContaining({ uri: 'file:///private/staging/payload' }),
      { fileID: otherUploadID, writer: expect.objectContaining({ userId: otherUserID }) },
    );
    expect(mocks.secureValue).toBeNull();
    expect(mocks.quarantineValue).not.toBeNull();

    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userID } }, error: null }) },
    };
    mocks.reconcile.mockResolvedValueOnce({ status: 'uploaded', attachment: uploadedAttachment() });
    await expect(prepareSession(userID)).resolves.toBeUndefined();
    expect(mocks.reconcile).toHaveBeenCalledWith({ kind: 'case', id: caseID }, uploadID, { writer: expect.objectContaining({ userId: userID }) });
    expect(mocks.secureValue).toBeNull();
    expect(mocks.quarantineValue).toBeNull();
  });

  it('detaches a never-settling upload so the next account can establish and share', async () => {
    const begin = beginPendingSharedAttachmentUpload;
    const current = getPendingSharedAttachmentUpload;
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    const prepareSession = preparePendingSharedAttachmentUploadForSessionEstablishment;

    const otherUserID = '66666666-6666-4666-8666-666666666666';
    const otherUploadID = '77777777-7777-4777-8777-777777777777';
    const otherToken = '88888888-8888-4888-8888-888888888888';
    mocks.native.getPendingAsync.mockResolvedValue(pending());
    mocks.upload.mockImplementationOnce(() => new Promise(() => undefined));

    const stalledOperation = begin({ kind: 'case', id: caseID }, token);
    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    expect(stalledOperation.attachmentID).toBe(uploadID);

    await expect(prepareSessionLoss(userID)).resolves.toBe('recovery-required');
    expect(current()).toBeNull();
    expect(JSON.parse(mocks.quarantineValue ?? '{}')).toMatchObject({
      recoveries: [expect.objectContaining({ userID, attachmentID: uploadID })],
    });

    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: otherUserID } }, error: null }) },
    };
    await expect(prepareSession(otherUserID)).resolves.toBeUndefined();

    mocks.cryptoUUID.mockReturnValueOnce(otherUploadID);
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending({ token: otherToken }));
    mocks.upload.mockResolvedValueOnce(uploadedAttachment({ id: otherUploadID }));
    await expect(uploadPendingSharedAttachment({ kind: 'task', id: taskID }, otherToken, stubAttachmentWriter(() => mocks.client, otherUserID))).resolves.toBeUndefined();
    expect(mocks.upload).toHaveBeenLastCalledWith(
      { kind: 'task', id: taskID },
      expect.objectContaining({ uri: 'file:///private/staging/payload' }),
      { fileID: otherUploadID, writer: expect.objectContaining({ userId: otherUserID }) },
    );

    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userID } }, error: null }) },
    };
    mocks.reconcile.mockResolvedValueOnce({ status: 'confirmed', attachment: uploadedAttachment() });
    await expect(prepareSession(userID)).resolves.toBeUndefined();
    expect(mocks.reconcile).toHaveBeenCalledWith({ kind: 'case', id: caseID }, uploadID, { writer: expect.objectContaining({ userId: userID }) });
    expect(mocks.secureValue).toBeNull();
    expect(mocks.quarantineValue).toBeNull();
  });

  it('stops a delayed sign-out before it can discard the next account staged share', async () => {
    const begin = beginPendingSharedAttachmentUpload;
    const prepareSignOut = preparePendingSharedAttachmentUploadForSignOut;
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    const prepareSession = preparePendingSharedAttachmentUploadForSessionEstablishment;

    const otherUserID = '66666666-6666-4666-8666-666666666666';
    const otherToken = '88888888-8888-4888-8888-888888888888';
    let finishUpload: ((attachment: ReturnType<typeof uploadedAttachment>) => void) | undefined;
    mocks.native.getPendingAsync.mockResolvedValue(pending());
    mocks.upload.mockImplementationOnce(() => new Promise((resolve) => {
      finishUpload = resolve;
    }));

    const stalledOperation = begin({ kind: 'case', id: caseID }, token);
    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    const staleSignOut = prepareSignOut(userID);

    await expect(prepareSessionLoss(userID)).resolves.toBe('recovery-required');
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: otherUserID } }, error: null }) },
    };
    await expect(prepareSession(otherUserID)).resolves.toBeUndefined();
    mocks.native.getPendingAsync.mockResolvedValue(pending({ token: otherToken }));
    mocks.native.discardAsync.mockClear();
    mocks.native.discardAllAsync.mockClear();

    finishUpload?.(uploadedAttachment());
    await expect(stalledOperation.settlement).resolves.toMatchObject({ status: 'failed' });
    await expect(staleSignOut).rejects.toMatchObject({ code: 'authorization' });
    expect(mocks.native.discardAsync).not.toHaveBeenCalledWith(otherToken);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    await expect(readPendingSharedAttachment()).resolves.toMatchObject({ token: otherToken });
    expect(JSON.parse(mocks.quarantineValue ?? '{}')).toMatchObject({
      recoveries: [expect.objectContaining({ userID, attachmentID: uploadID })],
    });
  });

  it.each(['aborted', 'confirmed'] as const)(
    'stops a delayed %s establishment before it can discard the next account staged share',
    async (lateStatus) => {
      const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
      const prepareSession = preparePendingSharedAttachmentUploadForSessionEstablishment;

      const otherUserID = '66666666-6666-4666-8666-666666666666';
      const otherToken = '88888888-8888-4888-8888-888888888888';
      mocks.secureValue = JSON.stringify({
        version: 1,
        backend: 'https://sample-boundary.supabase.co',
        userID,
        attachmentID: uploadID,
        token,
        target: { kind: 'case', id: caseID },
        status: 'uploading',
      });
      let finishReconcile: ((result:
        | { status: 'aborted' }
        | { status: 'confirmed'; attachment: ReturnType<typeof uploadedAttachment> }
      ) => void) | undefined;
      mocks.reconcile.mockImplementationOnce(() => new Promise((resolve) => {
        finishReconcile = resolve;
      }));

      const staleEstablishment = prepareSession(userID);
      await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce());
      await expect(prepareSessionLoss(userID)).resolves.toBe('recovery-required');
      mocks.client = {
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: otherUserID } }, error: null }) },
      };
      await expect(prepareSession(otherUserID)).resolves.toBeUndefined();
      mocks.native.getPendingAsync.mockResolvedValue(pending({ token: otherToken }));
      mocks.native.discardAsync.mockClear();
      mocks.native.discardAllAsync.mockClear();

      finishReconcile?.(lateStatus === 'aborted'
        ? { status: 'aborted' }
        : { status: 'confirmed', attachment: uploadedAttachment() });
      await expect(staleEstablishment).rejects.toMatchObject({ code: 'authorization' });
      expect(mocks.native.discardAsync).not.toHaveBeenCalledWith(otherToken);
      expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
      await expect(readPendingSharedAttachment()).resolves.toMatchObject({ token: otherToken });
      expect(JSON.parse(mocks.quarantineValue ?? '{}')).toMatchObject({
        recoveries: [expect.objectContaining({ userID, attachmentID: uploadID })],
      });
    },
  );

  it('detaches a never-settling reconcile so the next account can establish and share', async () => {
    const reconcileRecovery = reconcilePendingSharedAttachmentUploadRecovery;
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    const prepareSession = preparePendingSharedAttachmentUploadForSessionEstablishment;

    const otherUserID = '66666666-6666-4666-8666-666666666666';
    const otherUploadID = '77777777-7777-4777-8777-777777777777';
    const otherToken = '88888888-8888-4888-8888-888888888888';
    mocks.secureValue = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    mocks.reconcile.mockImplementationOnce(() => new Promise(() => undefined));

    const stalledReconcile = reconcileRecovery();
    await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce());
    expect(stalledReconcile).toBeInstanceOf(Promise);

    await expect(prepareSessionLoss(userID)).resolves.toBe('recovery-required');
    expect(JSON.parse(mocks.quarantineValue ?? '{}')).toMatchObject({
      recoveries: [expect.objectContaining({ userID, attachmentID: uploadID })],
    });

    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: otherUserID } }, error: null }) },
    };
    await expect(prepareSession(otherUserID)).resolves.toBeUndefined();

    mocks.cryptoUUID.mockReturnValueOnce(otherUploadID);
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending({ token: otherToken }));
    mocks.upload.mockResolvedValueOnce(uploadedAttachment({ id: otherUploadID }));
    await expect(uploadPendingSharedAttachment({ kind: 'task', id: taskID }, otherToken, stubAttachmentWriter(() => mocks.client, otherUserID))).resolves.toBeUndefined();

    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userID } }, error: null }) },
    };
    mocks.reconcile.mockResolvedValueOnce({ status: 'confirmed', attachment: uploadedAttachment() });
    await expect(prepareSession(userID)).resolves.toBeUndefined();
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    expect(mocks.secureValue).toBeNull();
    expect(mocks.quarantineValue).toBeNull();
  });

  it('keeps the recovery lock available when an exact-boundary user lookup never settles', async () => {
    const reconcileRecovery = reconcilePendingSharedAttachmentUploadRecovery;
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    const prepareSession = preparePendingSharedAttachmentUploadForSessionEstablishment;

    const otherUserID = '66666666-6666-4666-8666-666666666666';
    const otherUploadID = '77777777-7777-4777-8777-777777777777';
    const otherToken = '88888888-8888-4888-8888-888888888888';
    const getUser = vi.fn()
      .mockResolvedValueOnce({ data: { user: { id: userID } }, error: null })
      .mockImplementationOnce(() => new Promise(() => undefined));
    mocks.client = { auth: { getUser } };
    mocks.secureValue = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    mocks.reconcile.mockResolvedValueOnce({ status: 'confirmed', attachment: uploadedAttachment() });

    const stalledRecovery = reconcileRecovery();
    await vi.waitFor(() => expect(getUser).toHaveBeenCalledTimes(2));
    expect(stalledRecovery).toBeInstanceOf(Promise);

    await expect(prepareSessionLoss(userID)).resolves.toBe('recovery-required');
    expect(JSON.parse(mocks.quarantineValue ?? '{}')).toMatchObject({
      recoveries: [expect.objectContaining({ userID, attachmentID: uploadID })],
    });

    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: otherUserID } }, error: null }) },
    };
    await expect(prepareSession(otherUserID)).resolves.toBeUndefined();
    mocks.cryptoUUID.mockReturnValueOnce(otherUploadID);
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending({ token: otherToken }));
    mocks.upload.mockResolvedValueOnce(uploadedAttachment({ id: otherUploadID }));
    await expect(uploadPendingSharedAttachment({ kind: 'task', id: taskID }, otherToken, stubAttachmentWriter(() => mocks.client, otherUserID))).resolves.toBeUndefined();

    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userID } }, error: null }) },
    };
    mocks.reconcile.mockResolvedValueOnce({ status: 'confirmed', attachment: uploadedAttachment() });
    await expect(prepareSession(userID)).resolves.toBeUndefined();
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    expect(mocks.secureValue).toBeNull();
    expect(mocks.quarantineValue).toBeNull();
  });

  it('does not hold the recovery lock while an initial upload user lookup never settles', async () => {
    const begin = beginPendingSharedAttachmentUpload;
    const current = getPendingSharedAttachmentUpload;
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    const prepareSession = preparePendingSharedAttachmentUploadForSessionEstablishment;

    const otherUserID = '66666666-6666-4666-8666-666666666666';
    const otherUploadID = '77777777-7777-4777-8777-777777777777';
    const otherToken = '88888888-8888-4888-8888-888888888888';
    const stalledGetUser = vi.fn(() => new Promise(() => undefined));
    mocks.client = { auth: { getUser: stalledGetUser } };
    mocks.native.getPendingAsync.mockResolvedValue(pending());

    const stalledOperation = begin({ kind: 'case', id: caseID }, token);
    await vi.waitFor(() => expect(stalledGetUser).toHaveBeenCalledOnce());
    expect(stalledOperation.attachmentID).toBe(uploadID);

    await expect(prepareSessionLoss(userID)).resolves.toBe('ready');
    expect(current()).toBeNull();
    expect(mocks.secureValue).toBeNull();
    expect(mocks.native.discardAsync).toHaveBeenCalledWith(token);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();

    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: otherUserID } }, error: null }) },
    };
    await expect(prepareSession(otherUserID)).resolves.toBeUndefined();
    mocks.cryptoUUID.mockReturnValueOnce(otherUploadID);
    mocks.native.getPendingAsync.mockResolvedValueOnce(pending({ token: otherToken }));
    mocks.upload.mockResolvedValueOnce(uploadedAttachment({ id: otherUploadID }));
    await expect(uploadPendingSharedAttachment({ kind: 'task', id: taskID }, otherToken, stubAttachmentWriter(() => mocks.client, otherUserID))).resolves.toBeUndefined();
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.secureValue).toBeNull();
  });

  it('queues distinct-user session loss instead of reusing the first account result', async () => {
    const prepareSessionLoss = preparePendingSharedAttachmentUploadForSessionLoss;
    const otherUserID = '66666666-6666-4666-8666-666666666666';
    const otherUploadID = '77777777-7777-4777-8777-777777777777';
    const otherToken = '88888888-8888-4888-8888-888888888888';
    const markerFor = (markerUserID: string, markerUploadID: string, markerToken: string) => JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID: markerUserID,
      attachmentID: markerUploadID,
      token: markerToken,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    mocks.secureValue = markerFor(userID, uploadID, token);
    let releaseFirstCleanup: (() => void) | undefined;
    mocks.native.discardAsync
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
        releaseFirstCleanup = () => resolve(true);
      }))
      .mockResolvedValue(true);

    const first = prepareSessionLoss(userID);
    const installSecondMarker = first.then(() => {
      mocks.secureValue = markerFor(otherUserID, otherUploadID, otherToken);
    });
    const second = prepareSessionLoss(otherUserID);
    await vi.waitFor(() => expect(releaseFirstCleanup).toBeTypeOf('function'));
    releaseFirstCleanup?.();

    await expect(Promise.all([first, second, installSecondMarker])).resolves.toEqual([
      'recovery-required',
      'recovery-required',
      undefined,
    ]);
    expect(mocks.native.discardAsync.mock.calls).toEqual([[token], [otherToken]]);
    expect(mocks.native.discardAllAsync).not.toHaveBeenCalled();
    expect(mocks.secureValue).toBeNull();
    expect(JSON.parse(mocks.quarantineValue ?? '{}')).toMatchObject({
      recoveries: expect.arrayContaining([
        expect.objectContaining({ userID, attachmentID: uploadID }),
        expect.objectContaining({ userID: otherUserID, attachmentID: otherUploadID }),
      ]),
    });
  });

  it('never lets a delayed reconcile overwrite another account promoted exact marker', async () => {
    const reconcileRecovery = reconcilePendingSharedAttachmentUploadRecovery;
    const readRecovery = readPendingSharedAttachmentUploadRecovery;
    const otherUserID = '66666666-6666-4666-8666-666666666666';
    const otherUploadID = '77777777-7777-4777-8777-777777777777';
    const otherToken = '88888888-8888-4888-8888-888888888888';
    mocks.secureValue = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    mocks.quarantineValue = JSON.stringify({
      version: 1,
      recoveries: [{
        version: 1,
        backend: 'https://sample-boundary.supabase.co',
        userID: otherUserID,
        attachmentID: otherUploadID,
        token: otherToken,
        target: { kind: 'task', id: taskID },
        status: 'uploading',
      }],
    });
    let signalReconcileStarted: (() => void) | undefined;
    const reconcileStarted = new Promise<void>((resolve) => { signalReconcileStarted = resolve; });
    let finishReconcile: ((value: { status: 'uploaded'; attachment: ReturnType<typeof uploadedAttachment> }) => void) | undefined;
    const delayedReconcile = new Promise<{ status: 'uploaded'; attachment: ReturnType<typeof uploadedAttachment> }>((resolve) => {
      finishReconcile = resolve;
    });
    mocks.reconcile.mockImplementationOnce(async () => {
      signalReconcileStarted?.();
      return delayedReconcile;
    });

    const originalRecovery = reconcileRecovery();
    await reconcileStarted;
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: otherUserID } }, error: null }) },
    };
    await expect(readRecovery()).resolves.toMatchObject({
      userID: otherUserID,
      attachmentID: otherUploadID,
    });
    finishReconcile?.({ status: 'uploaded', attachment: uploadedAttachment() });

    await expect(originalRecovery).rejects.toMatchObject({ code: 'authorization' });
    expect(JSON.parse(mocks.secureValue ?? '{}')).toMatchObject({
      userID: otherUserID,
      attachmentID: otherUploadID,
    });
    expect(JSON.parse(mocks.quarantineValue ?? '{}')).toMatchObject({
      recoveries: [expect.objectContaining({ userID, attachmentID: uploadID })],
    });
  });

  it('coalesces concurrent foreground recovery of the same durable exact operation', async () => {
    const reconcileRecovery = reconcilePendingSharedAttachmentUploadRecovery;
    mocks.secureValue = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    let resolveReconciliation: ((value: { status: 'uncertain' }) => void) | undefined;
    mocks.reconcile.mockImplementation(() => new Promise((resolve) => {
      resolveReconciliation = resolve;
    }));

    const first = reconcileRecovery();
    const second = reconcileRecovery();
    await vi.waitFor(() => expect(resolveReconciliation).toBeTypeOf('function'));
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    resolveReconciliation?.({ status: 'uncertain' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'uncertain', attachmentID: uploadID },
      { status: 'uncertain', attachmentID: uploadID },
    ]);
  });

  it('retains a confirmed cold marker until exact native staging cleanup can be retried', async () => {
    const reconcileRecovery = reconcilePendingSharedAttachmentUploadRecovery;
    mocks.secureValue = JSON.stringify({
      version: 1,
      backend: 'https://sample-boundary.supabase.co',
      userID,
      attachmentID: uploadID,
      token,
      target: { kind: 'case', id: caseID },
      status: 'uploading',
    });
    mocks.reconcile.mockResolvedValue({ status: 'confirmed', attachment: uploadedAttachment() });
    mocks.native.discardAsync.mockResolvedValue(false);

    await expect(reconcileRecovery()).rejects.toMatchObject({ code: 'cleanup' });
    expect(JSON.parse(mocks.secureValue ?? '{}')).toMatchObject({
      attachmentID: uploadID,
      status: 'uploaded',
    });
    expect(mocks.secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('defers exact success and ambiguous settlements until the foreground is safe to present', async () => {
    const createGate = createShareUploadPresentationGate;
    const allowsReshare = shareUploadAllowsReshare;

    let resolveSettlement: ((settlement: TestUploadSettlement) => void) | undefined;
    const deferredSettlement = new Promise<TestUploadSettlement>((resolve) => { resolveSettlement = resolve; });
    const gate = createGate(true);
    const presentation = gate.waitForSettlement(deferredSettlement);
    let presented = false;
    void presentation.then(() => { presented = true; });

    gate.setReady(false);
    resolveSettlement?.({
      status: 'uploaded',
      attachmentID: uploadID,
      attachment: uploadedAttachment(),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(presented).toBe(false);

    gate.setReady(true);
    await expect(presentation).resolves.toMatchObject({ status: 'uploaded', attachmentID: uploadID });

    const ambiguous = new ShareIntakeError(
      'remote-cleanup',
      'The upload may have completed. Refresh the record before retrying.',
    );
    expect(allowsReshare(ambiguous)).toBe(false);
    expect(allowsReshare(new ShareIntakeError('cleanup', 'Local cleanup is required.'))).toBe(false);
    expect(allowsReshare(new ShareIntakeError('upload', 'Remote absence was confirmed.'))).toBe(true);
    expect(allowsReshare(new Error('unknown settlement'))).toBe(false);
  });

  it('loads only fresh RLS-scoped destinations and never asks for task rows for a worker hat', async () => {
    const caseQuery = query({ data: [{ id: caseID, user_id: 'user', reference: 'CASE-1', title: 'Current issue', status: 'active' }], error: null });
    const from = vi.fn(() => caseQuery);
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null });
    mocks.client = { auth: { getUser }, from };
    await expect(loadAuthorizedShareTargets({ coordinatorAccess: false, staffTaskAccess: false })).resolves.toEqual([
      { kind: 'case', id: caseID, label: 'CASE-1', title: 'Current issue', meta: 'active' },
    ]);
    expect(getUser).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledTimes(1);
    expect(caseQuery.eq).toHaveBeenCalledWith('user_id', 'user');
  });

  it('uses bounded issue RPC plus exact staff task destinations, ignoring malformed rows', async () => {
    const rpc = vi.fn().mockReturnValue(query({ data: [
      { id: caseID, reference: 'CASE-1', title: 'Resolved issue', status: 'resolved' },
      { id: 'invalid', reference: 'INVALID', title: 'Malformed' },
    ], error: null }));
    const taskQuery = query({ data: [
      { id: taskID, chapter_id: 'harrow-bay', task_number: 42, title: 'Review packet', status: 'in_progress' },
      { id: 'not-a-uuid', task_number: 43, title: 'Malformed', status: 'todo' },
    ], error: null });
    const from = vi.fn().mockReturnValue(taskQuery);
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      from, rpc,
    };
    await expect(loadAuthorizedShareTargets({ coordinatorAccess: true, staffTaskAccess: true })).resolves.toEqual([
      { kind: 'case', id: caseID, label: 'CASE-1', title: 'Resolved issue', meta: 'resolved' },
      { kind: 'task', id: taskID, label: 'HARROW-BAY-42', title: 'Review packet', meta: 'in progress' },
    ]);
    expect(rpc).toHaveBeenCalledWith('list_share_case_destinations', { p_limit: 100 });
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('chapter_tasks');
    expect(taskQuery.is).toHaveBeenCalledWith('deleted_at', null);
    expect(isStaffTaskAttachmentRole(['steward'])).toBe(true);
    expect(isStaffTaskAttachmentRole(['member'])).toBe(false);
  });

  it('refuses failed campaign lead RPC without a broad table fallback', async () => {
    const from = vi.fn();
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc: vi.fn().mockReturnValue(query({ data: [], error: { message: 'missing migration' } })), from,
    };
    await expect(loadAuthorizedShareTargets({ coordinatorAccess: true, staffTaskAccess: false }))
      .rejects.toThrow('Authorized attachment destinations could not be refreshed.');
    expect(from).not.toHaveBeenCalled();
  });

  it('refuses a non-array campaign lead payload instead of presenting an empty destination list', async () => {
    const from = vi.fn();
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc: vi.fn().mockReturnValue({ returns: vi.fn().mockResolvedValue({ data: { unexpected: true }, error: null }) }), from,
    };
    await expect(loadAuthorizedShareTargets({ coordinatorAccess: true, staffTaskAccess: false }))
      .rejects.toThrow('Authorized attachment destinations could not be refreshed.');
    expect(from).not.toHaveBeenCalled();
  });

  // Text pins over native Kotlin/Swift/plugin sources vitest cannot execute —
  // honest about being tripwires rather than behavioural proof. A guard
  // hidden behind a comment or an always-false condition in the native
  // source would still satisfy these substring checks.
  it('keeps the native boundary bounded, silent, protected, and single-item', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const manifest = readFileSync(`${root}modules/secure-share-intake/android/src/main/AndroidManifest.xml`, 'utf8');
    const androidStorage = readFileSync(`${root}modules/secure-share-intake/android/src/main/java/expo/modules/secureshareintake/SecureShareStorage.kt`, 'utf8');
    const androidReceiver = readFileSync(`${root}modules/secure-share-intake/android/src/main/java/expo/modules/secureshareintake/SecureShareReceiverActivity.kt`, 'utf8');
    const androidModule = readFileSync(`${root}modules/secure-share-intake/android/src/main/java/expo/modules/secureshareintake/SecureShareIntakeModule.kt`, 'utf8');
    const iosExtension = readFileSync(`${root}modules/secure-share-intake/plugin/ShareIntakeViewController.swift`, 'utf8');
    const iosStorage = readFileSync(`${root}modules/secure-share-intake/ios/SecureShareIntakeModule.swift`, 'utf8');
    const plugin = readFileSync(`${root}modules/secure-share-intake/app.plugin.js`, 'utf8');
    const appConfig = readFileSync(`${root}app.config.ts`, 'utf8');
    const gate = readFileSync(`${root}src/components/SecureShareIntakeGate.tsx`, 'utf8');
    const rootLayout = readFileSync(`${root}app/_layout.tsx`, 'utf8');
    const tabsLayout = readFileSync(`${root}app/(tabs)/_layout.tsx`, 'utf8');
    const appProvider = readFileSync(`${root}src/state/AppProvider.tsx`, 'utf8');
    const screen = readFileSync(`${root}app/share-intake.tsx`, 'utf8');
    const androidSuccessPath = androidReceiver.match(/private fun openUnionGround\([^)]*\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const androidCancelPath = androidReceiver.slice(
      androidReceiver.indexOf('private fun cancelShare()'),
      androidReceiver.indexOf('private fun discardStaged', androidReceiver.indexOf('private fun cancelShare()')),
    );
    const androidDiscardPath = androidReceiver.slice(
      androidReceiver.indexOf('private fun discardStaged'),
      androidReceiver.indexOf('private fun showCleanupFailure', androidReceiver.indexOf('private fun discardStaged')),
    );

    expect(manifest).toContain('android.intent.action.SEND');
    expect(manifest).not.toContain('SEND_MULTIPLE');
    expect(manifest).not.toMatch(/READ_(?:EXTERNAL_STORAGE|MEDIA_)/);
    expect(androidStorage).toContain('Intent.FLAG_GRANT_READ_URI_PERMISSION');
    expect(androidStorage).toContain('if (providerMime != declaredMime) return null');
    expect(androidStorage).toContain('if (total > MAX_BYTES) return null');
    expect(androidStorage).toContain('if (!manifestFile.isFile || !payload.isFile) return null');
    expect(androidStorage).toContain('PendingShareStageOutcome(null, if (deleteVerified(entry)) emptyList() else listOf(token))');
    expect(androidStorage).toContain('fun captureCleanupTokens(context: Context): List<String>');
    expect(androidStorage).toContain('val cleanupTokens = captureCleanupTokens(context)');
    expect(androidStorage).not.toContain('discardAll(context)');
    expect(androidStorage).not.toMatch(/printStackTrace|Log\./);
    expect(androidSuccessPath).toContain('startActivity(launch)');
    expect(androidSuccessPath).toContain('finish()');
    expect(androidSuccessPath).not.toContain('finishAndRemoveTask()');
    expect(androidReceiver).toContain('override fun onStop()');
    expect(androidReceiver).toContain('cancelled = true');
    expect(androidReceiver).toContain('handoffCommitted = true');
    expect(androidReceiver).toContain('stagedTokens.addAll(outcome.cleanupTokens)');
    expect(androidReceiver).toContain('if (pending != null) stagedTokens.add(pending.token)');
    expect(androidReceiver).toContain('if (outcome != null && !outcome.cleanupConfirmed) showCleanupFailure() else showFailure()');
    expect(androidCancelPath).toContain('SecureShareStorage.discard(applicationContext, token)');
    expect(androidCancelPath).not.toContain('discardAll');
    expect(androidCancelPath.indexOf('SecureShareStorage.discard(applicationContext, token)')).toBeLessThan(
      androidCancelPath.indexOf('stagedTokens.remove(token)'),
    );
    expect(androidDiscardPath).toContain('SecureShareStorage.discard(applicationContext, pending.token)');
    expect(androidDiscardPath).not.toContain('discardAll');
    expect(androidDiscardPath.indexOf('SecureShareStorage.discard(applicationContext, pending.token)')).toBeLessThan(
      androidDiscardPath.indexOf('stagedTokens.remove(pending.token)'),
    );
    expect(androidModule).not.toContain('AsyncFunction("discardAllAsync")');
    expect(androidModule).toContain('AsyncFunction("captureCleanupTokensAsync")');
    expect(iosExtension).toContain('FileProtectionType.complete');
    expect(iosExtension).toContain('isExcludedFromBackup = true');
    expect(iosExtension).toContain('override func viewWillDisappear');
    expect(iosExtension).toContain('private var stagedTokens = Set<String>()');
    expect(iosExtension).toContain('handoffCommitted = readyForHandoff');
    expect(iosStorage).not.toContain('AsyncFunction("discardAllAsync")');
    const providerLoad = iosExtension.indexOf('provider.loadFileRepresentation');
    const providerStage = iosExtension.indexOf('let outcome = self.stage', providerLoad);
    const providerResult = iosExtension.indexOf('DispatchQueue.main.async', providerStage);
    expect(providerLoad).toBeGreaterThan(-1);
    expect(providerStage).toBeGreaterThan(providerLoad);
    expect(providerResult).toBeGreaterThan(providerStage);
    expect(iosExtension).not.toContain('DispatchQueue.global');
    expect(iosExtension).not.toMatch(/UIApplication|openURL\(|print\(|URLSession/);
    expect(plugin).toContain('NSExtensionActivationRule');
    expect(plugin).toContain('UTI-EQUALS');
    expect(plugin).toContain("TARGETED_DEVICE_FAMILY = '\"1\"'");
    expect(plugin).toContain("APPLICATION_EXTENSION_API_ONLY = 'YES'");
    expect(iosExtension).toContain('$0.identifier == registeredIdentifier');
    expect(iosExtension).not.toContain('registeredType.conforms');
    const swiftAllowedTypeIdentifiers = [...iosExtension.matchAll(/AllowedType\(identifier: "([^"]+)"/g)]
      .map((match) => match[1]);
    expect(swiftAllowedTypeIdentifiers).toEqual(ALLOWED_TYPE_IDENTIFIERS);
    expect(iosExtension).not.toContain('allowedTypes[$0]');
    const stageStart = iosExtension.indexOf('private func stage(');
    const stageEnd = iosExtension.indexOf('private func copyBounded', stageStart);
    const stagePath = iosExtension.slice(stageStart, stageEnd);
    expect(stagePath).not.toContain('removeItem(at: root)');
    expect(stagePath).toContain('removeAndVerify(entry, manager: manager)');
    expect(stagePath.indexOf('withStagingLock(in: container)')).toBeLessThan(
      stagePath.indexOf('manager.createDirectory('),
    );
    expect(stagePath.indexOf('data.write(to: manifest')).toBeLessThan(
      stagePath.indexOf('removeOtherStagedEntries(in: root, keeping: token,'),
    );
    expect(stagePath.indexOf('removeOtherStagedEntries(in: root, keeping: token,')).toBeLessThan(
      stagePath.indexOf('guard manager.fileExists(atPath: payload.path)'),
    );
    const extensionLockName = iosExtension.match(/private let lockName = "([^"]+)"/)?.[1];
    const storageLockName = iosStorage.match(/private static let lockName = "([^"]+)"/)?.[1];
    expect(extensionLockName).toBe('.SecureShareIntake.lock');
    expect(storageLockName).toBe(extensionLockName);
    for (const lockedProcess of [iosExtension, iosStorage]) {
      expect(lockedProcess).toContain('Darwin.open($0, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC');
      expect(lockedProcess).toContain('Darwin.lockf(descriptor, F_LOCK, 0)');
      expect(lockedProcess).toContain('Darwin.lockf(descriptor, F_ULOCK, 0)');
      expect(lockedProcess).toContain('Darwin.fchmod(descriptor, mode_t(S_IRUSR | S_IWUSR))');
      expect(lockedProcess).toContain('FileProtectionType.complete');
      expect(lockedProcess).toContain('excludeFromBackup(lockURL)');
    }
    expect(iosStorage.match(/try withStagingLock/g)).toHaveLength(3);
    expect(iosStorage).toContain('AsyncFunction("captureCleanupTokensAsync")');
    expect(iosStorage).toContain('attributesOfItem(atPath: payloadURL.path)');
    const siblingCleanupStart = iosExtension.indexOf('private func removeOtherStagedEntries');
    const siblingCleanupEnd = iosExtension.indexOf('private func showReady()', siblingCleanupStart);
    const siblingCleanup = iosExtension.slice(siblingCleanupStart, siblingCleanupEnd);
    expect(siblingCleanup).toContain(').filter { $0.lastPathComponent != token }');
    expect(siblingCleanup).toContain('for sibling in siblings {');
    expect(siblingCleanup).not.toContain('standardizedFileURL');
    const failureStart = iosExtension.indexOf('private func showFailure()');
    const failureEnd = iosExtension.indexOf('@objc private func closeExtension', failureStart);
    const failurePath = iosExtension.slice(failureStart, failureEnd);
    expect(failurePath).not.toContain('removeItem');
    expect(iosExtension).not.toContain('purgeStaging()');
    expect(appConfig).not.toContain('expo-sharing');
    expect(gate).toContain("mode === 'preview' || mode === 'signedOut'");
    expect(gate).toContain('observedUserID.current !== userID');
    expect(gate).toContain("mode === 'preview'");
    expect(rootLayout).toContain('<SecureShareIntakeGate />');
    expect(tabsLayout).not.toContain('SecureShareIntakeGate');
    expect(appProvider).toContain('const purgeSecureShareStaging = useCallback');
    // BUG-UG-ACCOUNT-DELETION-COMPLETION-CONFIRMATION-20261011
    // adds local cleanup after deletion as well as ordinary sign-out cleanup.
    expect(appProvider.match(/discardAllPendingSharedAttachments\(/g)).toHaveLength(2);
    const signOutPurge = appProvider.slice(appProvider.indexOf('const purgeSecureShareStaging'), appProvider.indexOf('useEffect(() => subscribeSecureShareStagingCleanup'));
    expect(signOutPurge).toContain('() => sessionTransition.current === cleanupTransition,\n      cleanupBoundary,');
    const deletionCleanup = appProvider.slice(appProvider.indexOf('const deleteAccount ='), appProvider.indexOf('const signOut ='));
    // Deletion owns its receipt across background/auth-loss transitions;
    // an accepted replacement retires the receipt and cancels old cleanup.
    expect(deletionCleanup).toContain('const stillDeleted = () => deletionReceipt.current && deletedUserID.current === userID\n      && activeUserID.current === null;');
    expect(deletionCleanup).toContain('discardAllPendingSharedAttachments(stillDeleted)');
    expect(appProvider).toContain('void retryPendingSharedAttachmentCleanup(');
    expect(appProvider).toContain('preparePendingSharedAttachmentUploadForSignOut');
    expect(appProvider).toContain('await preparePendingSharedAttachmentUploadForSignOut(expectedUserID, signOutStillCurrent, captureSessionWriter(capturedSession));');
    expect(appProvider).toContain('await preparePendingSharedAttachmentStagingForPreviewExit(signOutStillCurrent);');
    expect(appProvider).toContain('preparePendingSharedAttachmentUploadForSessionLoss');
    expect(appProvider).toContain('preparePendingSharedAttachmentUploadForSessionEstablishment');
    expect(appProvider).toContain('isolationBoundary.previousUserID,\n          isolationBoundary.cleanupBoundary,');
    const establishSessionStart = appProvider.indexOf('const establishSession');
    const reauthorizationStart = appProvider.indexOf('const previousUserID = activeUserID.current;', establishSessionStart);
    const isolationBoundaryStart = appProvider.indexOf('const isolationBoundary = blockedShareIsolation.current', reauthorizationStart);
    const isolationBoundaryEnd = appProvider.indexOf('activeUserID.current = userID;', isolationBoundaryStart);
    const reauthorizationBoundary = appProvider.slice(reauthorizationStart, isolationBoundaryStart);
    const accountSwitch = appProvider.slice(isolationBoundaryStart, isolationBoundaryEnd);
    expect(reauthorizationBoundary).toContain('setPrivacyCovered(true);');
    expect(reauthorizationBoundary).toContain('clearProtectedState();');
    expect(accountSwitch).toContain('sessionTransition.current !== transition');
    expect(accountSwitch).toContain('!authIdentityMatches(observedAuthIdentity.current, nextSession)');
    expect(appProvider.indexOf('clearProtectedState();', reauthorizationStart)).toBeLessThan(
      appProvider.indexOf('await preparePendingSharedAttachmentUploadForSessionLoss(', reauthorizationStart),
    );
    const establishSessionEnd = appProvider.indexOf('const revalidateAuthenticatedSession', isolationBoundaryStart);
    const establishSession = appProvider.slice(establishSessionStart, establishSessionEnd);
    expect(establishSession).not.toContain('previousUserID !== userID) setPrivacyCovered(false)');
    expect(establishSession).not.toContain('await purgeSecureShareStaging()');
    expect(establishSession.match(/setPrivacyCovered\(false\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(appProvider).toContain('await preparePendingSharedAttachmentUploadForSessionEstablishment(userID, captureSessionWriter(nextSession));');
    expect(appProvider).toContain('coveredSession.user.id,\n            shareCleanupBoundary,');
    const authLossStart = appProvider.indexOf('const lostUserID = activeUserID.current;');
    expect(authLossStart).toBeGreaterThan(-1);
    expect(appProvider.indexOf('preparePendingSharedAttachmentUploadForSessionLoss(', authLossStart)).toBeLessThan(
      appProvider.indexOf('activeUserID.current = null;', authLossStart),
    );
    expect(appProvider).toContain('subscribeSecureShareStagingCleanup');
    expect(appProvider).toContain('isSecureShareStagingCleanupRequired()');
    expect(appProvider).not.toContain('nativeStagingCleanupRequired');
    expect(gate).toContain('subscribeSecureShareStagingCleanup');
    expect(gate).toContain('isSecureShareStagingCleanupRequired()');
    expect(gate).toContain('const { locked, mode, privacyCovered, session } = useApp();');
    expect(gate).toContain('if (!userID || locked || privacyCovered || pathname === \'/share-intake\') return;');
    expect(screen).toContain('markSecureShareStagingCleanupRequired(current.token)');
    expect(screen).toContain("AppState.addEventListener('change'");
    expect(screen).not.toContain("committed.current || !pendingRef.current");
    expect(screen).toContain('if (interrupted.current)');
    expect(screen).not.toContain("AppState.currentState !== 'active'");
    expect(screen).toContain("const observedActive = useRef(AppState.currentState === 'active');");
    expect(screen).toContain('const [foregroundReady, setForegroundReady] = useState(observedActive.current);');
    expect(screen).toContain('const [foregroundEpoch, setForegroundEpoch] = useState(0);');
    expect(screen).toContain('const interruptedCleanupBoundary = useRef<SecureShareCleanupBoundary | null>(null);');
    expect(screen).toContain('pendingRef.current = next;');
    expect(screen).toContain('setPendingState(next);');
    expect(screen).toContain('const { authorizedRoles, locked, mode, privacyCovered, signOut, session } = useApp();');
    expect(screen).toContain("mode !== 'authenticated' || locked || privacyCovered || !foregroundReady || interrupted.current");
    expect(screen).toContain('function observeAppState(state: AppStateStatus | null)');
    expect(screen).toContain('const returningToForeground = !observedActive.current;');
    expect(screen).toContain('if (returningToForeground) {');
    expect(screen).toContain('discardPendingSharedAttachmentCreatedAtOrBefore(cleanupBoundary)');
    expect(screen).toContain('shareUploadAllowsReshare(error)');
    expect(screen).toContain('disabled={busy || !selected || remoteCleanupUnconfirmed}');
    expect(screen).toContain('interrupted.current = false;');
    expect(screen).toContain('setForegroundEpoch((current) => current + 1);');
    expect(screen).toContain('const leavingForeground = observedActive.current;');
    expect(screen).toContain('observedActive.current = false;');
    expect(screen).toContain('setForegroundReady(false);');
    expect(screen).toContain('if (!leavingForeground || committed.current) return;');
    expect(screen).toContain('loadGeneration.current += 1;');
    expect(screen).toContain('AppState.addEventListener(\'change\', observeAppState)');
    expect(screen).toContain('observeAppState(AppState.currentState);');
    expect(screen.indexOf("AppState.addEventListener('change', observeAppState)")).toBeLessThan(
      screen.indexOf('observeAppState(AppState.currentState);'),
    );
    expect(screen).toContain(': discardPendingSharedAttachmentCreatedAtOrBefore(lifecycleCleanupBoundary)).catch');
    expect(screen).toContain('loadAuthorizedShareTargets');

    const loadStart = screen.indexOf('const generation = ++loadGeneration.current;');
    const loadEnd = screen.indexOf('function observeAppState', loadStart);
    const loadEffect = screen.slice(loadStart, loadEnd);
    expect(loadStart).toBeGreaterThan(-1);
    expect(loadEnd).toBeGreaterThan(loadStart);
    expect(loadEffect.match(/if \(generation !== loadGeneration\.current\) return;/g)).toHaveLength(5);
    expect(loadEffect).not.toContain('AppState.currentState');
    expect(loadEffect).not.toContain('interrupted.current = false');
    expect(loadEffect).not.toContain('let active');
    expect(loadEffect).not.toContain('if (!active)');
    expect(screen).toContain('useBusinessOperation<boolean>(setBusy, false)');
    expect(screen).toContain('if (busy || !loadRequested) return;');
    expect(loadEffect).toContain('void runOperation(true, async () => {');
    expect(loadEffect).toContain('setCurrentPending(null);');
    expect(loadEffect).toContain('setCurrentPending(nextPending);');
    expect(loadEffect).toContain('setSelectedKey(null);');
    expect(loadEffect).toContain("setQuery('');");
    expect(screen).toContain('loadGeneration.current += 1;');
    expect(screen).toContain('setLoadRequested(true);');
    const staleSuccess = loadEffect.slice(
      loadEffect.indexOf('const [nextPending, nextTargets] = await Promise.all(['),
      loadEffect.indexOf('if (interrupted.current)'),
    );
    const staleRejection = loadEffect.slice(
      loadEffect.indexOf('let message = error instanceof Error'),
      loadEffect.indexOf('} finally {'),
    );
    const loadCleanup = screen.slice(screen.indexOf('loadGeneration.current += 1;'), screen.indexOf('setLoadRequested(true);'));
    for (const stalePath of [staleSuccess, loadCleanup]) {
      expect(stalePath).not.toContain('discardPendingSharedAttachment');
      expect(stalePath).not.toContain('discardAllPendingSharedAttachments');
    }
    expect(staleRejection).toContain('discardPendingSharedAttachmentCreatedAtOrBefore(loadCleanupBoundary)');
    expect(staleRejection).not.toContain('discardAllPendingSharedAttachments');
    const foregroundLoss = loadEffect.slice(
      loadEffect.indexOf('if (interrupted.current)'),
      loadEffect.indexOf('setCurrentPending(nextPending);'),
    );
    const abandonPath = screen.slice(
      screen.indexOf('const abandon = useCallback'),
      screen.indexOf('useFocusEffect', screen.indexOf('const abandon = useCallback')),
    );
    const appStatePath = screen.slice(
      screen.indexOf('function observeAppState'),
      screen.indexOf('mounted.current = true;'),
    );
    const unmountPath = screen.slice(
      screen.lastIndexOf('useEffect(() => {', screen.indexOf('mounted.current = true;')),
      screen.indexOf('const filteredTargets'),
    );
    for (const lifecycleCleanup of [foregroundLoss, abandonPath, appStatePath, unmountPath]) {
      expect(lifecycleCleanup).toContain('discardPendingSharedAttachment');
    }
    for (const lifecycleCleanup of [abandonPath, appStatePath, unmountPath]) {
      expect(lifecycleCleanup).toContain('captureSecureShareCleanupBoundary()');
      expect(lifecycleCleanup).toContain('discardPendingSharedAttachmentCreatedAtOrBefore(');
      expect(lifecycleCleanup).not.toContain('Date.now()');
      expect(lifecycleCleanup).not.toContain('discardAllPendingSharedAttachments');
    }
    const previewCleanup = screen.slice(
      screen.indexOf("if (mode === 'preview')"),
      screen.indexOf("if (mode !== 'authenticated'"),
    );
    expect(previewCleanup.match(/loadGeneration\.current === previewCleanupGeneration/g)).toHaveLength(4);
    expect(previewCleanup.indexOf('loadGeneration.current === previewCleanupGeneration', previewCleanup.indexOf('.then')))
      .toBeLessThan(previewCleanup.indexOf("router.replace('/(tabs)/home'", previewCleanup.indexOf('.then')));
    expect(foregroundLoss).not.toContain('discardAllPendingSharedAttachments');
    const uploadPath = screen.slice(
      screen.indexOf('async function upload()'),
      screen.indexOf("if (mode === 'signedOut')"),
    );
    expect(uploadPath).toContain('beginPendingSharedAttachmentUpload(');
    expect(uploadPath).toContain('observeUploadOperation(operation);');
    expect(uploadPath).not.toContain('generation !== loadGeneration.current || interrupted.current');
    expect(screen).toContain('uploadPresentationGate.waitForSettlement(operation.settlement)');
  });

  it('cleans only the exact iOS extension tokens captured by a failed or cancelled share', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const source = readFileSync(
      `${root}modules/secure-share-intake/plugin/ShareIntakeViewController.swift`,
      'utf8',
    );
    const stagePath = source.slice(
      source.indexOf('private func stage('),
      source.indexOf('private func withStagingLock'),
    );
    const discardPath = source.slice(
      source.indexOf('private func discardStagedEntries()'),
      source.indexOf('private func removeAndVerify'),
    );
    const cancelledResultPath = source.slice(
      source.indexOf('if self.cancelled {'),
      source.indexOf('} else if let outcome, outcome.ready'),
    );
    const readyResultPath = source.slice(
      source.indexOf('} else if let outcome, outcome.ready'),
      source.indexOf('} else {', source.indexOf('} else if let outcome, outcome.ready')),
    );
    const viewDisappearancePath = source.slice(
      source.indexOf('override func viewWillDisappear'),
      source.indexOf('deinit'),
    );
    const deinitPath = source.slice(
      source.indexOf('deinit'),
      source.indexOf('private func configureView'),
    );
    const closePath = source.slice(source.indexOf('@objc private func closeExtension()'));

    expect(stagePath).toContain('cleanupTokens: &cleanupTokens');
    expect(stagePath).toContain('return StageOutcome(token: token, ready: false, cleanupTokens: cleanupTokens)');
    expect(stagePath).not.toContain('removeAndVerify(root, manager: manager)');
    expect(discardPath.indexOf('withStagingLock(in: container)')).toBeGreaterThan(-1);
    expect(discardPath.indexOf('withStagingLock(in: container)')).toBeLessThan(
      discardPath.indexOf('removeAndVerify(entry)'),
    );
    expect(discardPath).toContain('let entry = root.appendingPathComponent(parsed.uuidString.lowercased(), isDirectory: true)');
    expect(discardPath).not.toContain('removeAndVerify(root)');
    expect(cancelledResultPath).toContain('discardStagedEntries()');
    expect(viewDisappearancePath).toContain('discardStagedEntries()');
    expect(deinitPath).toContain('discardStagedEntries()');
    expect(readyResultPath).not.toContain('discardStagedEntries()');
    expect(closePath).toContain('if !readyForHandoff && !discardStagedEntries()');
    expect(closePath.indexOf('if !readyForHandoff && !discardStagedEntries()')).toBeLessThan(
      closePath.indexOf('extensionContext?.completeRequest(returningItems: nil)'),
    );
  });

  it('retains exact native sibling cleanup obligations when replacement staging cannot delete an older share', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const iosExtension = readFileSync(
      `${root}modules/secure-share-intake/plugin/ShareIntakeViewController.swift`,
      'utf8',
    );
    const androidStorage = readFileSync(
      `${root}modules/secure-share-intake/android/src/main/java/expo/modules/secureshareintake/SecureShareStorage.kt`,
      'utf8',
    );
    const androidReceiver = readFileSync(
      `${root}modules/secure-share-intake/android/src/main/java/expo/modules/secureshareintake/SecureShareReceiverActivity.kt`,
      'utf8',
    );
    const iosStage = iosExtension.slice(
      iosExtension.indexOf('private func stage('),
      iosExtension.indexOf('private func withStagingLock'),
    );
    const iosDiscard = iosExtension.slice(
      iosExtension.indexOf('private func discardStagedEntries()'),
      iosExtension.indexOf('private func removeAndVerify'),
    );
    const androidStage = androidStorage.slice(
      androidStorage.indexOf('fun stageFromIntent'),
      androidStorage.indexOf('fun captureCleanupTokens'),
    );
    const androidCancel = androidReceiver.slice(
      androidReceiver.indexOf('private fun cancelShare()'),
      androidReceiver.indexOf('private fun discardStaged'),
    );

    expect(iosExtension).toContain('private var stagedTokens = Set<String>()');
    expect(iosExtension).toContain('stagedTokens.formUnion(outcome.cleanupTokens)');
    expect(iosStage).toContain('cleanupTokens: &cleanupTokens');
    expect(iosStage).toContain('return StageOutcome(token: token, ready: false, cleanupTokens: cleanupTokens)');
    expect(iosDiscard).toContain('for token in stagedTokens.sorted()');
    expect(iosDiscard).toContain('remaining.remove(token)');

    expect(androidStage).toContain('val cleanupTokens = captureCleanupTokens(context)');
    expect(androidStage).toContain('return PendingShareStageOutcome(null, cleanupTokens)');
    expect(androidStage).not.toContain('discardAll(context)');
    expect(androidReceiver).toContain('private val stagedTokens = linkedSetOf<String>()');
    expect(androidReceiver).toContain('stagedTokens.addAll(outcome.cleanupTokens)');
    expect(androidCancel).toContain('for (token in stagedTokens.toList())');
    expect(androidCancel).toContain('stagedTokens.remove(token)');
  });

  it('keeps an exact in-flight upload intact across background and resumes presentation only when safe', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const screen = readFileSync(`${root}app/share-intake.tsx`, 'utf8');
    const appStatePath = screen.slice(
      screen.indexOf('function observeAppState'),
      screen.indexOf('mounted.current = true;'),
    );
    const backgroundPath = appStatePath.slice(appStatePath.indexOf('const leavingForeground'));
    const uploadPath = screen.slice(
      screen.indexOf('async function upload()'),
      screen.indexOf("if (mode === 'signedOut')"),
    );

    expect(screen).toContain('createShareUploadPresentationGate(');
    expect(screen).toContain('getPendingSharedAttachmentUpload(session?.user.id)');
    expect(screen).toContain('readPendingSharedAttachmentUploadRecovery(captureSessionWriter(session))');
    expect(screen).toContain('reconcilePendingSharedAttachmentUploadRecovery(captureSessionWriter(session))');
    expect(screen).toContain('cleanupRequired && recoveredUpload.current && !pending');
    expect(screen).toContain("error instanceof ShareIntakeError && error.code === 'cleanup' && recoveredUpload.current");
    expect(screen).toContain('await discardPendingSharedAttachment(completion.token);');
    expect(screen).toContain('remoteCleanupUnconfirmed && recoveredUpload.current && !pending');
    expect(screen).toContain('recoveredUpload.current = operation;');
    expect(screen).toContain('activeUpload && recoveredUpload.current?.attachmentID !== activeUpload.attachmentID');
    expect(screen).toContain('await acknowledgePendingSharedAttachmentUpload(recovery.attachmentID);');
    expect(screen).toContain("label={busy ? t('Checking…') : 'Check exact upload again'} disabled={busy}");
    expect(screen).toContain('beginPendingSharedAttachmentUpload(');
    expect(screen).toContain('uploadPresentationGate.waitForSettlement(operation.settlement)');
    expect(screen).toContain('acknowledgePendingSharedAttachmentUpload(operation.attachmentID)');
    expect(screen).toContain('shareUploadAllowsReshare(error)');
    expect(uploadPath).not.toContain('await uploadPendingSharedAttachment(');

    expect(backgroundPath).toContain('uploadPresentationGate.setReady(false);');
    expect(backgroundPath).toContain('if (getPendingSharedAttachmentUpload(session?.user.id) || recoveryInFlight.current || recoveryBlocked.current) return;');
    expect(backgroundPath.indexOf('uploadPresentationGate.setReady(false);')).toBeLessThan(
      backgroundPath.indexOf('if (getPendingSharedAttachmentUpload(session?.user.id) || recoveryInFlight.current || recoveryBlocked.current) return;'),
    );
    expect(backgroundPath.indexOf('if (getPendingSharedAttachmentUpload(session?.user.id) || recoveryInFlight.current || recoveryBlocked.current) return;')).toBeLessThan(
      backgroundPath.indexOf('interrupted.current = true;'),
    );
  });

  // Text pin for the screen wiring this file cannot reach through a render —
  // honest about being a tripwire rather than behavioural proof.
  it('never offers or executes a second upload after the one-shot candidate may have been deleted', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const screen = readFileSync(`${root}app/share-intake.tsx`, 'utf8');
    const uploadStart = screen.indexOf('async function upload()');
    const uploadEnd = screen.indexOf("if (mode === 'signedOut')", uploadStart);
    const uploadPath = screen.slice(uploadStart, uploadEnd);

    expect(screen).toContain('const uploadAttempted = useRef(false);');
    expect(uploadPath).toContain('if (!pending || !selected || busy || uploadAttempted.current) return;');
    expect(uploadPath).toContain('uploadAttempted.current = true;');
    expect(uploadPath.indexOf('uploadAttempted.current = true;')).toBeLessThan(
      uploadPath.indexOf('beginPendingSharedAttachmentUpload('),
    );
    expect(uploadPath).not.toContain('uploadPendingSharedAttachment(');
    expect(screen).not.toContain('Try upload again');
    expect(screen).not.toContain('The local copy remains only while this screen stays active');
    expect(screen).toContain('Share the item to Union Ground again before retrying.');
    expect(screen).toContain("retryRequiresReshare ? 'Discard and share again'");
    expect(screen).toContain("retryRequiresReshare ? () => { void abandon(); } : () => { void upload(); }");
  });

  it('targets only the generated share extension Debug and Release configurations', () => {
    const configurations = {
      APP_DEBUG: xcodeConfiguration('org.example.unionground'),
      APP_RELEASE: xcodeConfiguration('org.example.unionground'),
      EXTENSION_DEBUG: xcodeConfiguration('org.example.unionground.secure-share-intake'),
      EXTENSION_RELEASE: xcodeConfiguration('org.example.unionground.secure-share-intake'),
    };

    setExtensionTargetDeviceFamily({
      pbxXCBuildConfigurationSection: () => configurations,
    }, 'org.example.unionground.secure-share-intake');

    expect(configurations.EXTENSION_DEBUG.buildSettings.TARGETED_DEVICE_FAMILY).toBe('"1"');
    expect(configurations.EXTENSION_RELEASE.buildSettings.TARGETED_DEVICE_FAMILY).toBe('"1"');
    expect(configurations.EXTENSION_DEBUG.buildSettings.APPLICATION_EXTENSION_API_ONLY).toBe('YES');
    expect(configurations.EXTENSION_RELEASE.buildSettings.APPLICATION_EXTENSION_API_ONLY).toBe('YES');
    expect(configurations.APP_DEBUG.buildSettings).not.toHaveProperty('TARGETED_DEVICE_FAMILY');
    expect(configurations.APP_RELEASE.buildSettings).not.toHaveProperty('TARGETED_DEVICE_FAMILY');
    expect(configurations.APP_DEBUG.buildSettings).not.toHaveProperty('APPLICATION_EXTENSION_API_ONLY');
    expect(configurations.APP_RELEASE.buildSettings).not.toHaveProperty('APPLICATION_EXTENSION_API_ONLY');
  });

  it('stages only MIME types the foreground can consume on both native platforms', () => {
    const root = fileURLToPath(new URL('../../modules/secure-share-intake/', import.meta.url));
    const android = readFileSync(`${root}android/src/main/java/expo/modules/secureshareintake/SecureShareStorage.kt`, 'utf8');
    const ios = readFileSync(`${root}plugin/ShareIntakeViewController.swift`, 'utf8');
    const androidTypes = [...android.matchAll(/"([^"\n]+)" to "([a-z0-9]+)"/g)].map((match) => [match[1], match[2]]);
    const iosTypes = [...ios.matchAll(/AllowedType\(identifier: "[^"]+", mime: "([^"]+)", extensions: \["([^"]+)"/g)].map((match) => [match[1], match[2]]);
    expect(androidTypes.length).toBeGreaterThan(0);
    expect(iosTypes.length).toBeGreaterThan(0);
    for (const [mimeType, extension] of [...androidTypes, ...iosTypes]) {
      expect(validateNativePendingShare(pending({ filename: `evidence.${extension}`, mimeType }), now).candidate.mimeType).toBe(mimeType);
    }
    expect(androidTypes.map(([mime]) => mime).sort()).toEqual(iosTypes.map(([mime]) => mime).sort());
    const iosStorage = readFileSync(`${root}ios/SecureShareIntakeModule.swift`, 'utf8');
    const iosStoredTypes = [...iosStorage.matchAll(/"([^"\n]+)": \["([a-z0-9]+)"/g)].map((match) => match[1]);
    expect(iosStoredTypes.sort()).toEqual(androidTypes.map(([mime]) => mime).sort());
    const manifest = readFileSync(`${root}android/src/main/AndroidManifest.xml`, 'utf8');
    const advertised = [...manifest.matchAll(/android:mimeType="([^"]+)"/g)].map((match) => match[1]);
    expect(advertised.sort()).toEqual([...androidTypes.map(([mime]) => mime), 'text/comma-separated-values'].sort());
  });

  it('advertises exactly the same eight concrete types accepted by the extension', () => {
    const rule = buildActivationRule();
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const iosExtension = readFileSync(
      `${root}modules/secure-share-intake/plugin/ShareIntakeViewController.swift`,
      'utf8',
    );

    expect(ALLOWED_TYPE_IDENTIFIERS).toEqual([
      'com.adobe.pdf',
      'public.jpeg',
      'public.png',
      'org.webmproject.webp',
      'public.plain-text',
      'public.comma-separated-values-text',
      'org.openxmlformats.wordprocessingml.document',
      'org.openxmlformats.spreadsheetml.sheet',
    ]);
    expect(new Set(ALLOWED_TYPE_IDENTIFIERS)).toHaveProperty('size', 8);
    expect(rule).not.toContain('extensionItems.@count == 1 AND');
    expect(rule).not.toContain('$item.attachments.@count == 1 AND');
    expect(rule).toContain('SUBQUERY(extensionItems, $item, SUBQUERY($item.attachments');
    expect(rule).not.toContain('SUBQUERY($attachment.registeredTypeIdentifiers');
    expect(rule.match(/ANY \$attachment\.registeredTypeIdentifiers UTI-EQUALS/g))
      .toHaveLength(8);
    expect(iosExtension).toContain('guard providers.count == 1');
    expect(iosExtension).toContain('$0.identifier == registeredIdentifier');
    expect(iosExtension).not.toContain('registeredType.conforms');
    for (const identifier of ALLOWED_TYPE_IDENTIFIERS) {
      expect(rule).toContain(`UTI-EQUALS "${identifier}"`);
    }
    expect(rule).not.toContain('UTI-CONFORMS-TO');
    expect(rule).not.toContain('TRUEPREDICATE');
    expect(rule).not.toContain('public.image');
  });

  it('fails closed when the generated share extension configuration set is incomplete', () => {
    const configurations = {
      EXTENSION_DEBUG: xcodeConfiguration('org.example.unionground.secure-share-intake'),
    };

    expect(() => setExtensionTargetDeviceFamily({
      pbxXCBuildConfigurationSection: () => configurations,
    }, 'org.example.unionground.secure-share-intake')).toThrow('Secure share extension must have exactly two iPhone-only build configurations.');
  });
});
