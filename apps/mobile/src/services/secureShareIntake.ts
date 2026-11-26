import type { SupabaseClient } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import SecureShareIntakeModule from '../../modules/secure-share-intake/src/SecureShareIntakeModule';
import { caseRowLine } from '../lib/caseRowLine';
import { mobileConfig } from '../lib/config';
import {
  AttachmentError,
  reconcileAuthorizedAttachmentUpload,
  uploadAuthorizedAttachment,
  validateAttachmentCandidate,
  type AttachmentCandidate,
  type AttachmentTarget,
  type AuthorizedAttachment,
} from './attachments';
import { type MobileSessionWriter, getSupabaseClient, verifyCapturedMobileSession } from './supabase';
import { nativeTaskReference } from '../lib/taskDiscussions';
import { installShareRecoveryTestHook, waitForShareRecoveryTestRecovery, withShareRecoveryTestHold } from './shareRecoveryTestHook';

export const SHARE_INTAKE_MAX_AGE_MS = 5 * 60 * 1_000;
const SHARE_INTAKE_FUTURE_SKEW_MS = 30 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SESSION_ESTABLISHMENT_RECOVERY_ATTEMPTS = 8;

export type SecureShareCleanupBoundary = Readonly<{
  sequence: number;
  capturedTokens: Promise<readonly string[]>;
}>;

export type PendingSharedAttachment = {
  token: string;
  createdAtMs: number;
  candidate: AttachmentCandidate;
};

export type AuthorizedShareTarget = AttachmentTarget & {
  label: string;
  title: string;
  meta: string;
};

export type PendingSharedAttachmentUploadSettlement =
  | { status: 'uploaded'; attachmentID: string; attachment: AuthorizedAttachment }
  | { status: 'failed'; attachmentID: string; error: ShareIntakeError };

export type PendingSharedAttachmentUploadOperation = {
  userID: string;
  attachmentID: string;
  token: string;
  target: AttachmentTarget;
  settlement: Promise<PendingSharedAttachmentUploadSettlement>;
};

export type PendingSharedAttachmentUploadRecovery = {
  version: 1;
  backend: string;
  userID: string;
  attachmentID: string;
  token: string;
  target: AttachmentTarget;
  status: 'uploading' | 'uploaded';
};

type PendingSharedAttachmentUploadQuarantine = {
  version: 1;
  recoveries: PendingSharedAttachmentUploadRecovery[];
};

export type ShareUploadPresentationGate = {
  setReady: (ready: boolean) => void;
  waitUntilReady: () => Promise<void>;
  waitForSettlement: (
    settlement: Promise<PendingSharedAttachmentUploadSettlement>,
  ) => Promise<PendingSharedAttachmentUploadSettlement>;
};

export type PendingSharedAttachmentUploadRecoveryResult =
  | { status: 'uploaded'; attachmentID: string; attachment?: AuthorizedAttachment }
  | { status: 'absent'; attachmentID: string }
  // A shared file the safety check refused. Distinct from 'absent' because the
  // member is owed an explanation, and distinct from 'uncertain' because the
  // rollback was proven by an exact abort receipt before this is ever returned.
  | { status: 'rejected'; attachmentID: string }
  // The safety check refused the caller's session, not the file. The recovery
  // marker is deliberately KEPT: the upload is still pending and still
  // recoverable once the member verifies again (DECISIONS E4).
  | { status: 'reauth-required'; attachmentID: string }
  // Nothing was attached and the hidden pending upload is queued for the
  // service reconciler. The session was proven by the abort itself, so the
  // marker is cleared and sharing is unblocked; the member is told the file
  // was not attached and is being removed, never asked to verify again.
  | { status: 'cleanup-queued'; attachmentID: string }
  | { status: 'uncertain'; attachmentID: string };

export class ShareIntakeError extends Error {
  // Set when the private-upload inspection refused the caller's session
  // (a stale MFA session, which the share sheet is the likeliest entry point
  // for). The share screen offers re-authentication instead of a retry that
  // would fail identically every time.
  readonly reauthRequired: boolean;

  constructor(
    readonly code: 'expired' | 'invalid' | 'authorization' | 'load' | 'upload' | 'cleanup' | 'remote-cleanup',
    message: string,
    details: { reauthRequired?: boolean } = {},
  ) {
    super(message);
    this.name = 'ShareIntakeError';
    this.reauthRequired = details.reauthRequired === true;
  }
}

class ExistingShareUploadRecoveryError extends ShareIntakeError {
  constructor() {
    super(
      'remote-cleanup',
      'An earlier attachment upload is still awaiting exact recovery. Recover it before sharing another item.',
    );
  }
}

type SecureShareStagingCleanupListener = (required: boolean) => void;

let secureShareStagingCleanupRequired = false;
const pendingSecureShareCleanupTokens = new Set<string>();
let pendingSharedAttachmentUpload: PendingSharedAttachmentUploadOperation | null = null;
let pendingSharedAttachmentUploadRecoveryAttempt: {
  identity: string;
  promise: Promise<PendingSharedAttachmentUploadRecoveryResult>;
} | null = null;
let pendingSharedAttachmentSessionLossAttempt: {
  userID: string;
  cleanupScope: string;
  promise: Promise<'ready' | 'recovery-required'>;
} | null = null;
let pendingSharedAttachmentSessionBoundary = 0;
let pendingSharedAttachmentRecoveryStateTail: Promise<void> = Promise.resolve();
const secureShareStagingCleanupListeners = new Set<SecureShareStagingCleanupListener>();
const pendingSharedAttachmentUploadRecoveryKey = 'union-ground.secure-share-upload.v1';
const pendingSharedAttachmentUploadQuarantineKey = 'union-ground.secure-share-upload-quarantine.v1';
const pendingSharedAttachmentUploadQuarantineLimit = 8;
let secureShareCleanupBoundarySequence = 0;

function withPendingSharedAttachmentRecoveryStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingSharedAttachmentRecoveryStateTail.then(operation);
  pendingSharedAttachmentRecoveryStateTail = result.then(() => undefined, () => undefined);
  return result;
}

function setSecureShareStagingCleanupRequired(required: boolean): void {
  if (secureShareStagingCleanupRequired === required) return;
  secureShareStagingCleanupRequired = required;
  for (const listener of secureShareStagingCleanupListeners) listener(required);
}

export function markSecureShareStagingCleanupRequired(token: string): void {
  if (!UUID_PATTERN.test(token)) return;
  pendingSecureShareCleanupTokens.add(token.toLowerCase());
  setSecureShareStagingCleanupRequired(true);
}

export function isSecureShareStagingCleanupRequired(): boolean {
  return secureShareStagingCleanupRequired;
}

export function subscribeSecureShareStagingCleanup(
  listener: SecureShareStagingCleanupListener,
): () => void {
  secureShareStagingCleanupListeners.add(listener);
  return () => secureShareStagingCleanupListeners.delete(listener);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function captureSecureShareCleanupBoundary(): SecureShareCleanupBoundary {
  // The native snapshot and every native stage operation share one platform
  // lock. Its linearization point gives cleanup an exact set of opaque tokens:
  // later shares are never selected, and no wall-clock precision or rollback
  // heuristic is needed across an account transition.
  const capturedTokens = SecureShareIntakeModule.captureCleanupTokensAsync();
  // Some auth events ultimately do not need cleanup. Attach a rejection
  // observer immediately so a denied native read never becomes an unhandled
  // promise while preserving the original rejection for a later consumer.
  void capturedTokens.catch(() => undefined);
  secureShareCleanupBoundarySequence += 1;
  return { sequence: secureShareCleanupBoundarySequence, capturedTokens };
}

function normalizeSecureShareCleanupBoundary(
  boundary: SecureShareCleanupBoundary,
): SecureShareCleanupBoundary | null {
  return boundary && typeof boundary === 'object'
    && Number.isSafeInteger(boundary.sequence)
    && boundary.sequence > 0
    && typeof boundary.capturedTokens?.then === 'function'
    ? boundary
    : null;
}

async function capturedCleanupTokens(
  boundary: SecureShareCleanupBoundary,
  isCurrent: () => boolean,
): Promise<string[]> {
  requireStagingCleanupCurrent(isCurrent);
  let rawTokens: readonly string[];
  try {
    rawTokens = await boundary.capturedTokens;
  } catch {
    throw cleanupError();
  }
  requireStagingCleanupCurrent(isCurrent);
  if (!Array.isArray(rawTokens)) throw cleanupError();
  const tokens = rawTokens.map((value) => requiredString(value).toLowerCase());
  if (tokens.some((token) => !UUID_PATTERN.test(token))) throw cleanupError();
  return [...new Set(tokens)];
}

export function validateNativePendingShare(
  value: unknown,
  now = Date.now(),
): PendingSharedAttachment {
  const row = object(value);
  const token = requiredString(row.token).toLowerCase();
  const createdAtMs = Number(row.createdAtMs);
  if (!UUID_PATTERN.test(token)
    || !Number.isSafeInteger(createdAtMs)
    || createdAtMs > now + SHARE_INTAKE_FUTURE_SKEW_MS
    || now - createdAtMs > SHARE_INTAKE_MAX_AGE_MS) {
    throw new ShareIntakeError('expired', 'That shared item expired. Share it to Union Ground again.');
  }
  try {
    return {
      token,
      createdAtMs,
      candidate: validateAttachmentCandidate({
        uri: requiredString(row.uri),
        filename: requiredString(row.filename),
        mimeType: requiredString(row.mimeType),
        sizeBytes: Number(row.sizeBytes),
      }),
    };
  } catch {
    throw new ShareIntakeError('invalid', 'That shared item could not be verified. Share one supported file again.');
  }
}

async function waitForPendingSharedAttachmentUpload(): Promise<void> {
  const operation = pendingSharedAttachmentUpload;
  if (operation) await operation.settlement;
}

async function readPendingSharedAttachmentNow(): Promise<PendingSharedAttachment | null> {
  const raw = await SecureShareIntakeModule.getPendingAsync();
  if (!raw) return null;
  try {
    return validateNativePendingShare(raw);
  } catch (error) {
    const exactToken = object(raw).token;
    if (typeof exactToken !== 'string' || !UUID_PATTERN.test(exactToken)) throw error;
    await discardPendingSharedAttachmentNow(exactToken);
    throw error;
  }
}

export async function readPendingSharedAttachment(): Promise<PendingSharedAttachment | null> {
  await waitForPendingSharedAttachmentUpload();
  return readPendingSharedAttachmentNow();
}

function cleanupError(uploaded = false): ShareIntakeError {
  return new ShareIntakeError(
    'cleanup',
    uploaded
      ? 'The attachment was uploaded, but its local staged copy could not be cleared. Keep Union Ground open and try cleanup again.'
      : 'The local staged copy could not be cleared. Keep Union Ground open and try again.',
  );
}

async function discardPendingSharedAttachmentNow(token: string): Promise<void> {
  if (!UUID_PATTERN.test(token)) {
    throw cleanupError();
  }
  const normalizedToken = token.toLowerCase();
  try {
    if (await SecureShareIntakeModule.discardAsync(normalizedToken) !== true) throw cleanupError();
    pendingSecureShareCleanupTokens.delete(normalizedToken);
    if (pendingSecureShareCleanupTokens.size === 0) setSecureShareStagingCleanupRequired(false);
  } catch {
    markSecureShareStagingCleanupRequired(normalizedToken);
    throw cleanupError();
  }
}

export async function discardPendingSharedAttachment(token: string): Promise<void> {
  await waitForPendingSharedAttachmentUpload();
  return discardPendingSharedAttachmentNow(token);
}

function requireStagingCleanupCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) {
    throw new ShareIntakeError('authorization', 'The secure session changed during staged-share cleanup.');
  }
}

async function discardPendingSharedAttachmentCreatedAtOrBeforeNow(
  cleanupBoundary: SecureShareCleanupBoundary,
  isCurrent: () => boolean = () => true,
): Promise<{
  status: 'absent' | 'discarded';
}> {
  const boundary = normalizeSecureShareCleanupBoundary(cleanupBoundary);
  if (!boundary) throw cleanupError();
  const tokens = await capturedCleanupTokens(boundary, isCurrent);
  for (const token of tokens) markSecureShareStagingCleanupRequired(token);
  for (const token of tokens) {
    requireStagingCleanupCurrent(isCurrent);
    await discardPendingSharedAttachmentNow(token);
    requireStagingCleanupCurrent(isCurrent);
  }
  return { status: tokens.length > 0 ? 'discarded' : 'absent' };
}

export async function discardPendingSharedAttachmentCreatedAtOrBefore(
  cleanupBoundary: SecureShareCleanupBoundary,
): Promise<void> {
  await waitForPendingSharedAttachmentUpload();
  await discardPendingSharedAttachmentCreatedAtOrBeforeNow(cleanupBoundary);
}

async function discardAllPendingSharedAttachmentsNow(
  cleanupBoundary: SecureShareCleanupBoundary,
  exactTokens: readonly string[],
  isCurrent: () => boolean = () => true,
): Promise<'absent' | 'discarded'> {
  requireStagingCleanupCurrent(isCurrent);
  const boundary = normalizeSecureShareCleanupBoundary(cleanupBoundary);
  if (!boundary) throw cleanupError();
  const nativeTokens = await capturedCleanupTokens(boundary, isCurrent);
  const cleanupTokens = [...new Set([...nativeTokens, ...exactTokens.map((token) => token.toLowerCase())])];
  if (cleanupTokens.some((token) => !UUID_PATTERN.test(token))) throw cleanupError();
  for (const token of cleanupTokens) markSecureShareStagingCleanupRequired(token);
  for (const exactToken of cleanupTokens) {
    requireStagingCleanupCurrent(isCurrent);
    await discardPendingSharedAttachmentNow(exactToken);
    requireStagingCleanupCurrent(isCurrent);
  }
  return cleanupTokens.length > 0 ? 'discarded' : 'absent';
}

export async function discardAllPendingSharedAttachments(
  isCurrent: () => boolean = () => true,
  cleanupBoundary: SecureShareCleanupBoundary = captureSecureShareCleanupBoundary(),
): Promise<void> {
  const exactTokens = [...pendingSecureShareCleanupTokens];
  await waitForPendingSharedAttachmentUpload();
  await discardAllPendingSharedAttachmentsNow(cleanupBoundary, exactTokens, isCurrent);
}

export async function retryPendingSharedAttachmentCleanup(
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const exactTokens = [...pendingSecureShareCleanupTokens];
  await waitForPendingSharedAttachmentUpload();
  for (const exactToken of exactTokens) {
    if (!isCurrent()) {
      throw new ShareIntakeError('authorization', 'The secure session changed during staged-share cleanup.');
    }
    await discardPendingSharedAttachmentNow(exactToken);
    if (!isCurrent()) {
      throw new ShareIntakeError('authorization', 'The secure session changed during staged-share cleanup.');
    }
  }
}

function requireClient(): SupabaseClient {
  const client = getSupabaseClient();
  if (!client) throw new ShareIntakeError('authorization', 'The secure mobile backend is not configured.');
  return client;
}

async function currentUser(client: SupabaseClient, writer?: MobileSessionWriter): Promise<{ id: string }> {
  const session = writer ? await writer.session() : (await client.auth.getSession()).data.session;
  if (!session) throw new ShareIntakeError('authorization', 'Sign in again before saving this attachment.');
  const { data, error } = await verifyCapturedMobileSession(session);
  if (error || !data.user || (writer && data.user.id !== writer.userId)) {
    throw new ShareIntakeError('authorization', 'Your authorization changed. Sign in again before saving this attachment.');
  }
  return { id: data.user.id };
}

function backendBoundary(): string {
  const backend = mobileConfig.supabaseUrl;
  if (!backend) {
    throw new ShareIntakeError('authorization', 'The secure mobile backend is not configured.');
  }
  return backend;
}

function expectedUserBoundary(userID: string): string {
  const normalized = requiredString(userID).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new ShareIntakeError(
      'authorization',
      'The account boundary for an interrupted attachment upload could not be verified.',
    );
  }
  return normalized;
}

function parsePendingSharedAttachmentUploadRecovery(
  raw: string,
): PendingSharedAttachmentUploadRecovery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShareIntakeError(
      'remote-cleanup',
      'An interrupted attachment upload could not be verified. Keep it blocked until recovery is complete.',
    );
  }
  const row = object(parsed);
  const target = object(row.target);
  const backend = typeof row.backend === 'string' ? row.backend : '';
  const userID = typeof row.userID === 'string' ? row.userID : '';
  const attachmentID = typeof row.attachmentID === 'string' ? row.attachmentID : '';
  const token = typeof row.token === 'string' ? row.token : '';
  const targetKind = target.kind;
  const targetID = typeof target.id === 'string' ? target.id : '';
  const status = row.status;
  if (row.version !== 1
    || !backend
    || !UUID_PATTERN.test(userID)
    || !UUID_PATTERN.test(attachmentID)
    || !UUID_PATTERN.test(token)
    || (targetKind !== 'case' && targetKind !== 'task')
    || !UUID_PATTERN.test(targetID)
    || (status !== 'uploading' && status !== 'uploaded')) {
    throw new ShareIntakeError(
      'remote-cleanup',
      'An interrupted attachment upload could not be verified. Keep it blocked until recovery is complete.',
    );
  }
  return {
    version: 1,
    backend,
    userID: userID.toLowerCase(),
    attachmentID: attachmentID.toLowerCase(),
    token: token.toLowerCase(),
    target: { kind: targetKind, id: targetID.toLowerCase() },
    status,
  };
}

function recoveryIdentity(recovery: PendingSharedAttachmentUploadRecovery): string {
  return `${recovery.backend}\u0000${recovery.userID}\u0000${recovery.attachmentID}`;
}

function detachInMemoryPendingSharedAttachmentWork(
  recovery: PendingSharedAttachmentUploadRecovery | null,
): void {
  if (!recovery || pendingSharedAttachmentUpload?.attachmentID === recovery.attachmentID) {
    pendingSharedAttachmentUpload = null;
  }
  if (!recovery
    || pendingSharedAttachmentUploadRecoveryAttempt?.identity === recoveryIdentity(recovery)) {
    pendingSharedAttachmentUploadRecoveryAttempt = null;
  }
}

function requirePendingSharedAttachmentSessionBoundary(expected: number): void {
  if (pendingSharedAttachmentSessionBoundary !== expected) {
    throw new ShareIntakeError(
      'authorization',
      'The signed-in account changed while attachment recovery was running. Continue from the current account.',
    );
  }
}

function parsePendingSharedAttachmentUploadQuarantine(
  raw: string,
): PendingSharedAttachmentUploadQuarantine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShareIntakeError(
      'remote-cleanup',
      'Protected attachment recovery could not be verified. Keep sharing blocked and try again.',
    );
  }
  const row = object(parsed);
  if (row.version !== 1
    || !Array.isArray(row.recoveries)
    || row.recoveries.length > pendingSharedAttachmentUploadQuarantineLimit) {
    throw new ShareIntakeError(
      'remote-cleanup',
      'Protected attachment recovery could not be verified. Keep sharing blocked and try again.',
    );
  }
  const recoveries = row.recoveries.map((value) => (
    parsePendingSharedAttachmentUploadRecovery(JSON.stringify(value))
  ));
  if (new Set(recoveries.map(recoveryIdentity)).size !== recoveries.length) {
    throw new ShareIntakeError(
      'remote-cleanup',
      'Protected attachment recovery contains duplicate operations. Keep sharing blocked and try again.',
    );
  }
  return { version: 1, recoveries };
}

async function readStoredPendingSharedAttachmentUploadRecovery(
): Promise<PendingSharedAttachmentUploadRecovery | null> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(pendingSharedAttachmentUploadRecoveryKey);
  } catch {
    throw new ShareIntakeError(
      'remote-cleanup',
      'The interrupted attachment upload could not be read securely. Keep it blocked and try recovery again.',
    );
  }
  return raw === null ? null : parsePendingSharedAttachmentUploadRecovery(raw);
}

async function readQuarantinedPendingSharedAttachmentUploadRecoveries(
): Promise<PendingSharedAttachmentUploadRecovery[]> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(pendingSharedAttachmentUploadQuarantineKey);
  } catch {
    throw new ShareIntakeError(
      'remote-cleanup',
      'Protected attachment recovery could not be read securely. Keep sharing blocked and try again.',
    );
  }
  return raw === null ? [] : parsePendingSharedAttachmentUploadQuarantine(raw).recoveries;
}

async function requireRecoveryBoundary(
  recovery: PendingSharedAttachmentUploadRecovery,
  writer?: MobileSessionWriter,
): Promise<void> {
  const user = await currentUser(requireClient(), writer);
  if (recovery.backend !== backendBoundary() || recovery.userID !== user.id.toLowerCase()) {
    throw new ShareIntakeError(
      'authorization',
      'This interrupted attachment upload belongs to a different secure account or backend. Sign in to its original account to recover it.',
    );
  }
}

function requireExpectedRecoveryBoundary(
  recovery: PendingSharedAttachmentUploadRecovery,
  expectedUserID: string,
): void {
  if (recovery.backend !== backendBoundary()
    || recovery.userID !== expectedUserBoundary(expectedUserID)) {
    throw new ShareIntakeError(
      'authorization',
      'An interrupted attachment upload belongs to a different secure account or backend. Return to its original account to recover it.',
    );
  }
}

function sameRecovery(
  left: PendingSharedAttachmentUploadRecovery,
  right: PendingSharedAttachmentUploadRecovery,
): boolean {
  return left.version === right.version
    && left.backend === right.backend
    && left.userID === right.userID
    && left.attachmentID === right.attachmentID
    && left.token === right.token
    && left.target.kind === right.target.kind
    && left.target.id === right.target.id
    && left.status === right.status;
}

async function deleteExactPendingSharedAttachmentUploadRecoveryUnlocked(
  expected: PendingSharedAttachmentUploadRecovery,
): Promise<void> {
  const current = await readStoredPendingSharedAttachmentUploadRecovery();
  if (!current || !sameRecovery(current, expected)) {
    throw new ShareIntakeError(
      'remote-cleanup',
      'The interrupted attachment upload changed while cleanup was running. Keep it blocked and try recovery again.',
    );
  }
  try {
    await SecureStore.deleteItemAsync(pendingSharedAttachmentUploadRecoveryKey);
    if (await SecureStore.getItemAsync(pendingSharedAttachmentUploadRecoveryKey) !== null) {
      throw new Error('recovery record remains');
    }
  } catch {
    throw new ShareIntakeError(
      'cleanup',
      'The attachment result is known, but its protected recovery marker could not be cleared. Keep Union Ground open and try cleanup again.',
    );
  }
}

async function writeQuarantinedPendingSharedAttachmentUploadRecoveriesUnlocked(
  recoveries: PendingSharedAttachmentUploadRecovery[],
): Promise<void> {
  if (recoveries.length > pendingSharedAttachmentUploadQuarantineLimit
    || new Set(recoveries.map(recoveryIdentity)).size !== recoveries.length) {
    throw new ShareIntakeError(
      'remote-cleanup',
      'Protected attachment recovery is full or inconsistent. Keep sharing blocked and recover the original account first.',
    );
  }
  try {
    if (recoveries.length === 0) {
      await SecureStore.deleteItemAsync(pendingSharedAttachmentUploadQuarantineKey);
      if (await SecureStore.getItemAsync(pendingSharedAttachmentUploadQuarantineKey) !== null) {
        throw new Error('quarantine remains');
      }
      return;
    }
    const serialized = JSON.stringify({ version: 1, recoveries });
    await SecureStore.setItemAsync(pendingSharedAttachmentUploadQuarantineKey, serialized, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (await SecureStore.getItemAsync(pendingSharedAttachmentUploadQuarantineKey) !== serialized) {
      throw new Error('quarantine did not round-trip');
    }
  } catch (error) {
    if (error instanceof ShareIntakeError) throw error;
    throw new ShareIntakeError(
      'remote-cleanup',
      'Protected attachment recovery could not be saved securely. Keep sharing blocked and try again.',
    );
  }
}

async function removeExactQuarantinedPendingSharedAttachmentUploadRecoveryUnlocked(
  expected: PendingSharedAttachmentUploadRecovery,
): Promise<void> {
  const recoveries = await readQuarantinedPendingSharedAttachmentUploadRecoveries();
  const identity = recoveryIdentity(expected);
  const current = recoveries.find((recovery) => recoveryIdentity(recovery) === identity);
  if (!current) return;
  if (!sameRecovery(current, expected)) {
    throw new ShareIntakeError(
      'remote-cleanup',
      'Protected attachment recovery changed while it was being restored. Keep sharing blocked and try again.',
    );
  }
  await writeQuarantinedPendingSharedAttachmentUploadRecoveriesUnlocked(
    recoveries.filter((recovery) => recoveryIdentity(recovery) !== identity),
  );
}

async function quarantinePendingSharedAttachmentUploadRecoveryUnlocked(
  recovery: PendingSharedAttachmentUploadRecovery,
  stagingCleanup: 'exact' | 'all',
  cleanupBoundary?: SecureShareCleanupBoundary,
  exactTokens: readonly string[] = [],
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const recoveries = await readQuarantinedPendingSharedAttachmentUploadRecoveries();
  const identity = recoveryIdentity(recovery);
  const existing = recoveries.find((candidate) => recoveryIdentity(candidate) === identity);
  if (existing && !sameRecovery(existing, recovery)) {
    throw new ShareIntakeError(
      'remote-cleanup',
      'Protected attachment recovery changed while it was being isolated. Keep sharing blocked and try again.',
    );
  }
  if (!existing) {
    await writeQuarantinedPendingSharedAttachmentUploadRecoveriesUnlocked([...recoveries, recovery]);
  }
  // The quarantine is verified before the account-global slot is detached.
  // Staging is then removed while the original active marker still provides a
  // retry anchor. A crash can only duplicate the same exact operation; the
  // next activation repeats cleanup and removes that duplicate without loss.
  if (stagingCleanup === 'all') {
    if (!cleanupBoundary) throw cleanupError();
    await discardAllPendingSharedAttachmentsNow(
      cleanupBoundary,
      [...exactTokens, recovery.token],
      isCurrent,
    );
  } else {
    requireStagingCleanupCurrent(isCurrent);
    await discardPendingSharedAttachmentNow(recovery.token);
    requireStagingCleanupCurrent(isCurrent);
  }
  await deleteExactPendingSharedAttachmentUploadRecoveryUnlocked(recovery);
}

async function activatePendingSharedAttachmentUploadRecoveryForUserUnlocked(
  expectedUserID: string,
  sessionBoundary?: number,
): Promise<PendingSharedAttachmentUploadRecovery | null> {
  const requireCurrentSession = () => {
    if (sessionBoundary !== undefined) {
      requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    }
  };
  requireCurrentSession();
  const userID = expectedUserBoundary(expectedUserID);
  const backend = backendBoundary();
  let active = await readStoredPendingSharedAttachmentUploadRecovery();
  requireCurrentSession();
  if (active && (active.backend !== backend || active.userID !== userID)) {
    if (pendingSharedAttachmentUpload?.attachmentID === active.attachmentID) {
      throw new ShareIntakeError(
        'authorization',
        'The active attachment upload belongs to a different secure account. Wait for its exact settlement before changing accounts.',
      );
    }
    requireCurrentSession();
    await quarantinePendingSharedAttachmentUploadRecoveryUnlocked(active, 'exact');
    requireCurrentSession();
    active = null;
  }

  if (active) {
    requireCurrentSession();
    await removeExactQuarantinedPendingSharedAttachmentUploadRecoveryUnlocked(active);
    requireCurrentSession();
    return active;
  }

  const recoveries = await readQuarantinedPendingSharedAttachmentUploadRecoveries();
  requireCurrentSession();
  const matching = recoveries.find((recovery) => (
    recovery.backend === backend && recovery.userID === userID
  ));
  if (!matching) return null;
  requireCurrentSession();
  await storePendingSharedAttachmentUploadRecoveryUnlocked(matching);
  requireCurrentSession();
  await removeExactQuarantinedPendingSharedAttachmentUploadRecoveryUnlocked(matching);
  requireCurrentSession();
  return matching;
}

async function storePendingSharedAttachmentUploadRecoveryUnlocked(
  recovery: PendingSharedAttachmentUploadRecovery,
): Promise<void> {
  const serialized = JSON.stringify(recovery);
  try {
    await SecureStore.setItemAsync(pendingSharedAttachmentUploadRecoveryKey, serialized, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (await SecureStore.getItemAsync(pendingSharedAttachmentUploadRecoveryKey) !== serialized) {
      throw new Error('recovery record did not round-trip');
    }
  } catch {
    throw new ShareIntakeError(
      recovery.status === 'uploading' ? 'upload' : 'remote-cleanup',
      recovery.status === 'uploading'
        ? 'The attachment upload could not be recorded securely. Nothing was uploaded; share the item again.'
        : 'The attachment was uploaded, but its recovery state could not be recorded. Keep it blocked until recovery is complete.',
    );
  }
}

function activatePendingSharedAttachmentUploadRecoveryForUser(
  expectedUserID: string,
  sessionBoundary?: number,
): Promise<PendingSharedAttachmentUploadRecovery | null> {
  return withPendingSharedAttachmentRecoveryStateLock(() => (
    activatePendingSharedAttachmentUploadRecoveryForUserUnlocked(expectedUserID, sessionBoundary)
  ));
}

async function reservePendingSharedAttachmentUploadRecovery(
  target: AttachmentTarget,
  expectedToken: string,
  attachmentID: string,
  writer?: MobileSessionWriter,
): Promise<{
  current: PendingSharedAttachment;
  recovery: PendingSharedAttachmentUploadRecovery;
}> {
  const sessionBoundary = pendingSharedAttachmentSessionBoundary;
  if (!writer) throw new ShareIntakeError('authorization', 'The upload account is unavailable.');
  const user = await currentUser(requireClient(), writer);
  return withPendingSharedAttachmentRecoveryStateLock(async () => {
    if (pendingSharedAttachmentSessionBoundary !== sessionBoundary) {
      throw new ShareIntakeError(
        'authorization',
        'Your authorization changed before the attachment upload was reserved. Share the item again.',
      );
    }
    const prior = await activatePendingSharedAttachmentUploadRecoveryForUserUnlocked(user.id, sessionBoundary);
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    if (prior) throw new ExistingShareUploadRecoveryError();
    const current = await readPendingSharedAttachmentNow();
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    if (!current || current.token !== expectedToken.toLowerCase()) {
      throw new ShareIntakeError('expired', 'That shared item is no longer available. Share it to Union Ground again.');
    }
    const recovery: PendingSharedAttachmentUploadRecovery = {
      version: 1,
      backend: backendBoundary(),
      userID: user.id.toLowerCase(),
      attachmentID,
      token: current.token,
      target: { ...target },
      status: 'uploading',
    };
    await storePendingSharedAttachmentUploadRecoveryUnlocked(recovery);
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    return { current, recovery };
  });
}

async function replaceExactPendingSharedAttachmentUploadRecovery(
  expected: PendingSharedAttachmentUploadRecovery,
  replacement: PendingSharedAttachmentUploadRecovery,
  writer?: MobileSessionWriter,
): Promise<void> {
  await requireRecoveryBoundary(expected, writer);
  await withPendingSharedAttachmentRecoveryStateLock(async () => {
    const current = await readStoredPendingSharedAttachmentUploadRecovery();
    if (!current || !sameRecovery(current, expected)) {
      throw new ShareIntakeError(
        'remote-cleanup',
        'The interrupted attachment upload changed while its result was being recorded. Keep it blocked and recover the original account.',
      );
    }
    await storePendingSharedAttachmentUploadRecoveryUnlocked(replacement);
  });
}

async function clearPendingSharedAttachmentUploadRecovery(
  attachmentID: string,
  writer?: MobileSessionWriter,
): Promise<void> {
  const recovery = await withPendingSharedAttachmentRecoveryStateLock(
    () => readStoredPendingSharedAttachmentUploadRecovery(),
  );
  if (!recovery) return;
  if (recovery.attachmentID !== attachmentID) {
    throw new ShareIntakeError(
      'remote-cleanup',
      'A different interrupted attachment upload is still awaiting recovery.',
    );
  }
  await requireRecoveryBoundary(recovery, writer);
  await withPendingSharedAttachmentRecoveryStateLock(async () => {
    await deleteExactPendingSharedAttachmentUploadRecoveryUnlocked(recovery);
  });
}

export async function readPendingSharedAttachmentUploadRecovery(
  writer?: MobileSessionWriter,
): Promise<PendingSharedAttachmentUploadRecovery | null> {
  const sessionBoundary = pendingSharedAttachmentSessionBoundary;
  const user = await currentUser(requireClient(), writer);
  return withPendingSharedAttachmentRecoveryStateLock(async () => {
    if (pendingSharedAttachmentSessionBoundary !== sessionBoundary) {
      throw new ShareIntakeError(
        'authorization',
        'Your authorization changed while attachment recovery was opening. Try again from the current account.',
      );
    }
    const recovery = await activatePendingSharedAttachmentUploadRecoveryForUserUnlocked(user.id, sessionBoundary);
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    if (recovery) requireExpectedRecoveryBoundary(recovery, user.id);
    return recovery;
  });
}

async function reconcilePendingSharedAttachmentUploadRecoveryNow(
  recovery: PendingSharedAttachmentUploadRecovery,
  writer: MobileSessionWriter,
): Promise<PendingSharedAttachmentUploadRecoveryResult> {
  // `uploaded` is written only after an exact confirm response and a repeated
  // authenticated user/backend check. It remains authoritative if target
  // access is later revoked; re-confirming through that target would turn a
  // known success into a permanently ambiguous marker.
  if (recovery.status === 'uploaded') {
    await discardPendingSharedAttachmentNow(recovery.token);
    return { status: 'uploaded', attachmentID: recovery.attachmentID };
  }
  const reconciled = await reconcileAuthorizedAttachmentUpload(
    recovery.target,
    recovery.attachmentID,
    { writer },
  );
  if (reconciled.status === 'uncertain') {
    return { status: 'uncertain', attachmentID: recovery.attachmentID };
  }
  if (reconciled.status === 'reauth-required') {
    // Nothing was confirmed and nothing was aborted. Keep the marker so the
    // same exact upload is reconciled after the member verifies again.
    return { status: 'reauth-required', attachmentID: recovery.attachmentID };
  }
  if (reconciled.status === 'aborted') {
    await clearPendingSharedAttachmentUploadRecovery(recovery.attachmentID, writer);
    return { status: 'absent', attachmentID: recovery.attachmentID };
  }
  if (reconciled.status === 'cleanup-queued') {
    await clearPendingSharedAttachmentUploadRecovery(recovery.attachmentID, writer);
    return { status: 'cleanup-queued', attachmentID: recovery.attachmentID };
  }
  if (reconciled.status === 'rejected') {
    // reconcileAuthorizedAttachmentUpload only reports 'rejected' after an
    // exact abort receipt, so the row and its bytes are already gone. The
    // marker is cleared on the same durable path an abort takes.
    await clearPendingSharedAttachmentUploadRecovery(recovery.attachmentID, writer);
    return { status: 'rejected', attachmentID: recovery.attachmentID };
  }
  if (reconciled.attachment.id !== recovery.attachmentID) {
    return { status: 'uncertain', attachmentID: recovery.attachmentID };
  }
  await replaceExactPendingSharedAttachmentUploadRecovery(
    recovery,
    { ...recovery, status: 'uploaded' },
    writer,
  );
  await discardPendingSharedAttachmentNow(recovery.token);
  return {
    status: 'uploaded',
    attachmentID: recovery.attachmentID,
    attachment: reconciled.attachment,
  };
}

export async function reconcilePendingSharedAttachmentUploadRecovery(
  writer?: MobileSessionWriter,
): Promise<PendingSharedAttachmentUploadRecoveryResult> {
  if (!writer) throw new ShareIntakeError('authorization', 'The recovery account is unavailable.');
  await writer.session();
  const recovery = await readPendingSharedAttachmentUploadRecovery(writer);
  if (!recovery) {
    throw new ShareIntakeError('invalid', 'No interrupted attachment upload is available to recover.');
  }
  const identity = recoveryIdentity(recovery);
  const existing = pendingSharedAttachmentUploadRecoveryAttempt;
  if (existing) {
    if (existing.identity === identity) return existing.promise;
    await existing.promise.catch(() => undefined);
    return reconcilePendingSharedAttachmentUploadRecovery(writer);
  }
  const promise = reconcilePendingSharedAttachmentUploadRecoveryNow(recovery, writer);
  const attempt = { identity, promise };
  pendingSharedAttachmentUploadRecoveryAttempt = attempt;
  const clear = () => {
    if (pendingSharedAttachmentUploadRecoveryAttempt === attempt) {
      pendingSharedAttachmentUploadRecoveryAttempt = null;
    }
  };
  void promise.then(clear, clear);
  return promise;
}

async function preparePendingSharedAttachmentUploadForSessionLossNow(
  expectedUserID: string,
  cleanupBoundary: SecureShareCleanupBoundary,
  exactTokens: readonly string[],
): Promise<'ready' | 'recovery-required'> {
  // The runner may pause after the caller captured the exact cleanup scope.
  // Do not acquire the storage lock until released; no current-account tokens
  // are re-selected when this captured operation resumes.
  const recoveryPause = waitForShareRecoveryTestRecovery();
  if (recoveryPause) await recoveryPause;
  return withPendingSharedAttachmentRecoveryStateLock(async () => {
    const recovery = await readStoredPendingSharedAttachmentUploadRecovery();
    if (!recovery) {
      detachInMemoryPendingSharedAttachmentWork(null);
      await discardAllPendingSharedAttachmentsNow(
        cleanupBoundary,
        exactTokens,
      );
      return 'ready';
    }
    const expectedUser = expectedUserBoundary(expectedUserID);
    const belongsToLostSession = recovery.backend === backendBoundary()
      && recovery.userID === expectedUser;
    detachInMemoryPendingSharedAttachmentWork(recovery);
    if (belongsToLostSession && recovery.status === 'uploaded') {
      await discardAllPendingSharedAttachmentsNow(
        cleanupBoundary,
        [...exactTokens, recovery.token],
      );
      await deleteExactPendingSharedAttachmentUploadRecoveryUnlocked(recovery);
      return 'ready';
    }
    await quarantinePendingSharedAttachmentUploadRecoveryUnlocked(
      recovery,
      'all',
      cleanupBoundary,
      exactTokens,
    );
    return belongsToLostSession ? 'recovery-required' : 'ready';
  });
}

export function preparePendingSharedAttachmentUploadForSessionLoss(
  expectedUserID: string,
  cleanupBoundary: SecureShareCleanupBoundary = captureSecureShareCleanupBoundary(),
): Promise<'ready' | 'recovery-required'> {
  let userID: string;
  try {
    userID = expectedUserBoundary(expectedUserID);
    if (!normalizeSecureShareCleanupBoundary(cleanupBoundary)) {
      throw new ShareIntakeError(
        'authorization',
        'The staged-share session boundary could not be verified.',
      );
    }
  } catch (error) {
    return Promise.reject(error);
  }
  const exactTokens = [...pendingSecureShareCleanupTokens];
  const cleanupScope = `${cleanupBoundary.sequence}:${exactTokens.join(',')}`;
  pendingSharedAttachmentSessionBoundary += 1;
  if (pendingSharedAttachmentSessionLossAttempt?.userID === userID
    && pendingSharedAttachmentSessionLossAttempt.cleanupScope === cleanupScope) {
    return pendingSharedAttachmentSessionLossAttempt.promise;
  }
  const previous = pendingSharedAttachmentSessionLossAttempt?.promise;
  const promise = previous
    ? previous.catch(() => undefined).then(() => (
      preparePendingSharedAttachmentUploadForSessionLossNow(userID, cleanupBoundary, exactTokens)
    ))
    : preparePendingSharedAttachmentUploadForSessionLossNow(userID, cleanupBoundary, exactTokens);
  const attempt = { userID, cleanupScope, promise };
  pendingSharedAttachmentSessionLossAttempt = attempt;
  const clear = () => {
    if (pendingSharedAttachmentSessionLossAttempt === attempt) {
      pendingSharedAttachmentSessionLossAttempt = null;
    }
  };
  void promise.then(clear, clear);
  return promise;
}

export async function preparePendingSharedAttachmentUploadForSessionEstablishment(
  expectedUserID: string,
  writer?: MobileSessionWriter,
): Promise<void> {
  pendingSharedAttachmentSessionBoundary += 1;
  const sessionBoundary = pendingSharedAttachmentSessionBoundary;
  while (pendingSharedAttachmentSessionLossAttempt) {
    const attempt = pendingSharedAttachmentSessionLossAttempt;
    await attempt.promise;
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    if (pendingSharedAttachmentSessionLossAttempt === attempt) {
      pendingSharedAttachmentSessionLossAttempt = null;
    }
  }
  for (let attempt = 0; attempt < MAX_SESSION_ESTABLISHMENT_RECOVERY_ATTEMPTS; attempt += 1) {
    const recovery = await activatePendingSharedAttachmentUploadRecoveryForUser(
      expectedUserID,
      sessionBoundary,
    );
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    if (!recovery) {
      pendingSharedAttachmentUpload = null;
      return;
    }
    requireExpectedRecoveryBoundary(recovery, expectedUserID);
    await requireRecoveryBoundary(recovery, writer);
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    let result: PendingSharedAttachmentUploadRecoveryResult;
    try {
      result = await reconcilePendingSharedAttachmentUploadRecovery(writer);
    } catch (error) {
      if (!(error instanceof ShareIntakeError) || error.code !== 'cleanup') throw error;
      // A known remote result is safe to retry, but a marker that survives a
      // local delete attempt must remain blocking. Keep the loop bounded so a
      // broken SecureStore cannot turn session establishment into a hang.
      continue;
    }
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    if (result.attachmentID !== recovery.attachmentID) {
      throw new ShareIntakeError(
        'remote-cleanup',
        'A different interrupted attachment upload finished during recovery. Keep this account locked and try again.',
      );
    }
    if (result.status === 'reauth-required') {
      throw new ShareIntakeError(
        'remote-cleanup',
        'Verify it is you to finish recovering the interrupted attachment upload. Nothing was attached.',
        { reauthRequired: true },
      );
    }
    if (result.status === 'uncertain') {
      throw new ShareIntakeError(
        'remote-cleanup',
        'An interrupted attachment upload still needs exact recovery. Keep this account signed in and try again.',
      );
    }
    await discardPendingSharedAttachmentNow(recovery.token);
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    if (result.status === 'uploaded') {
      await clearPendingSharedAttachmentUploadRecovery(recovery.attachmentID, writer);
      requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    }
  }
  throw new ShareIntakeError(
    'remote-cleanup',
    'An interrupted attachment upload exceeded its secure recovery attempts. Keep this account signed in and try again.',
  );
}

export async function preparePendingSharedAttachmentUploadForSignOut(
  expectedUserID: string,
  isCurrent: () => boolean = () => true,
  writer?: MobileSessionWriter,
): Promise<void> {
  const expectedUser = expectedUserBoundary(expectedUserID);
  const cleanupBoundary = captureSecureShareCleanupBoundary();
  const exactCleanupTokens = [...pendingSecureShareCleanupTokens];
  requireStagingCleanupCurrent(isCurrent);
  pendingSharedAttachmentSessionBoundary += 1;
  const sessionBoundary = pendingSharedAttachmentSessionBoundary;
  const cleanupStillCurrent = () => (
    isCurrent() && pendingSharedAttachmentSessionBoundary === sessionBoundary
  );
  while (pendingSharedAttachmentSessionLossAttempt) {
    const attempt = pendingSharedAttachmentSessionLossAttempt;
    await attempt.promise;
    requireStagingCleanupCurrent(isCurrent);
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    if (pendingSharedAttachmentSessionLossAttempt === attempt) {
      pendingSharedAttachmentSessionLossAttempt = null;
    }
  }
  await waitForPendingSharedAttachmentUpload();
  requireStagingCleanupCurrent(isCurrent);
  requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
  // Recovery-free staging is local cleanup by tokens captured before this
  // sign-out boundary. It must not wait on Auth while offline. The caller's
  // identity guard and session boundary still protect every local mutation;
  // this preparation does not authorize the later server sign-out barrier.
  // Keep emptiness and discard under the reservation lock: a concurrent
  // confirmation must not create an upload marker for bytes being removed.
  const clearRecoveryFreeStaging = () => withPendingSharedAttachmentRecoveryStateLock(async () => {
    const stored = await readStoredPendingSharedAttachmentUploadRecovery();
    const quarantined = await readQuarantinedPendingSharedAttachmentUploadRecoveries();
    requireStagingCleanupCurrent(isCurrent);
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    // Quarantine has no staged bytes and is recovered only by its owner.
    // Another account/backend must not prevent recovery-free local sign-out.
    if (stored || quarantined.some((recovery) => (
      recovery.backend === backendBoundary() && recovery.userID === expectedUser
    ))) return false;
    await discardAllPendingSharedAttachmentsNow(cleanupBoundary, exactCleanupTokens, cleanupStillCurrent);
    requireStagingCleanupCurrent(isCurrent);
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    pendingSharedAttachmentUpload = null;
    return true;
  });
  if (await clearRecoveryFreeStaging()) return;
  // Remote upload recovery keeps its authoritative account check.
  const user = await currentUser(requireClient(), writer);
  requireStagingCleanupCurrent(isCurrent);
  requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
  if (user.id.toLowerCase() !== expectedUser) {
    throw new ShareIntakeError(
      'authorization',
      'The signed-in account changed before attachment cleanup finished. Continue from the current account.',
    );
  }
  const recovery = await activatePendingSharedAttachmentUploadRecoveryForUser(expectedUser, sessionBoundary);
  requireStagingCleanupCurrent(isCurrent);
  requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
  if (recovery) {
    requireExpectedRecoveryBoundary(recovery, expectedUser);
    await requireRecoveryBoundary(recovery, writer);
    requireStagingCleanupCurrent(isCurrent);
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    const result = await reconcilePendingSharedAttachmentUploadRecovery(writer);
    requireStagingCleanupCurrent(isCurrent);
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    if (result.attachmentID !== recovery.attachmentID) {
      throw new ShareIntakeError(
        'remote-cleanup',
        'A different interrupted attachment upload finished during sign-out. Keep this account signed in and try again.',
      );
    }
    if (result.status === 'uncertain') {
      throw new ShareIntakeError(
        'remote-cleanup',
        'An interrupted attachment upload is still awaiting exact recovery. Keep this account signed in and try again.',
      );
    }
    requireStagingCleanupCurrent(isCurrent);
    await discardAllPendingSharedAttachmentsNow(
      cleanupBoundary,
      [...exactCleanupTokens, recovery.token],
      cleanupStillCurrent,
    );
    requireStagingCleanupCurrent(isCurrent);
    requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    if (result.status === 'uploaded') {
      await clearPendingSharedAttachmentUploadRecovery(recovery.attachmentID, writer);
      requireStagingCleanupCurrent(isCurrent);
      requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
    }
  } else {
    if (!(await clearRecoveryFreeStaging())) {
      throw new ShareIntakeError('remote-cleanup', 'An interrupted attachment upload appeared during sign-out. Keep this account signed in and try again.');
    }
  }
  requireStagingCleanupCurrent(isCurrent);
  pendingSharedAttachmentUpload = null;
}

export async function preparePendingSharedAttachmentStagingForPreviewExit(
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const cleanupBoundary = captureSecureShareCleanupBoundary();
  const exactCleanupTokens = [...pendingSecureShareCleanupTokens];
  requireStagingCleanupCurrent(isCurrent);
  pendingSharedAttachmentSessionBoundary += 1;
  const sessionBoundary = pendingSharedAttachmentSessionBoundary;
  const cleanupStillCurrent = () => (
    isCurrent() && pendingSharedAttachmentSessionBoundary === sessionBoundary
  );
  await waitForPendingSharedAttachmentUpload();
  requireStagingCleanupCurrent(isCurrent);
  requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
  await discardAllPendingSharedAttachmentsNow(
    cleanupBoundary,
    exactCleanupTokens,
    cleanupStillCurrent,
  );
  requireStagingCleanupCurrent(isCurrent);
  requirePendingSharedAttachmentSessionBoundary(sessionBoundary);
  pendingSharedAttachmentUpload = null;
}

export async function loadAuthorizedShareTargets(options: {
  coordinatorAccess: boolean;
  staffTaskAccess: boolean;
}): Promise<AuthorizedShareTarget[]> {
  const client = requireClient();
  const user = await currentUser(client);
  // The coordinator RPC hoists the same RLS scope once. Never fall back to
  // the broad table read: on a populated tenant its per-row policy times out.
  const caseQuery = options.coordinatorAccess
    ? client.rpc('list_share_case_destinations', { p_limit: 100 }).returns<unknown>()
    : client.from('member_cases')
        .select('id,user_id,reference,case_type,step,status,updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(100);
  const [caseResult, taskResult] = await Promise.all([
    caseQuery,
    options.staffTaskAccess
      ? client.from('chapter_tasks')
          .select('id,chapter_id,task_number,title,status,updated_at')
          .is('deleted_at', null)
          .order('updated_at', { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (caseResult.error || taskResult.error) {
    throw new ShareIntakeError('load', 'Authorized attachment destinations could not be refreshed.');
  }
  if (caseResult.data !== null && !Array.isArray(caseResult.data)) {
    throw new ShareIntakeError('load', 'Authorized attachment destinations could not be refreshed.');
  }
  const caseRows: unknown[] = Array.isArray(caseResult.data) ? caseResult.data : [];
  const cases = caseRows.flatMap((value) => {
    const row = object(value);
    const id = requiredString(row.id);
    const reference = requiredString(row.reference);
    // list_share_case_destinations sends the neutral line as title; the
    // member's own case read selects type and step instead of the topic (#7015).
    const title = requiredString(row.title) || caseRowLine(row.case_type, row.step);
    if (!UUID_PATTERN.test(id) || !reference || !title) return [];
    return [{
      kind: 'case' as const,
      id,
      label: reference,
      title,
      meta: requiredString(row.status) || 'Issue',
    }];
  });
  const tasks = (taskResult.data ?? []).flatMap((value: unknown) => {
    const row = object(value);
    const id = requiredString(row.id);
    const title = requiredString(row.title);
    if (!UUID_PATTERN.test(id) || !title) return [];
    return [{
      kind: 'task' as const,
      id,
      label: nativeTaskReference(row.chapter_id, row.task_number),
      title,
      meta: requiredString(row.status).replaceAll('_', ' ') || 'Task',
    }];
  });
  return [...cases, ...tasks];
}

async function uploadPendingSharedAttachmentNow(
  target: AttachmentTarget,
  expectedToken: string,
  attachmentID: string,
  writer?: MobileSessionWriter,
): Promise<AuthorizedAttachment> {
  const { current, recovery } = await reservePendingSharedAttachmentUploadRecovery(
    target,
    expectedToken,
    attachmentID,
    writer,
  );
  let attachment: AuthorizedAttachment;
  try {
    attachment = await withShareRecoveryTestHold(recovery.userID, () => (
      uploadAuthorizedAttachment(target, current.candidate, { fileID: attachmentID, writer })
    ));
  } catch (error) {
    let mapped: ShareIntakeError;
    if (error instanceof AttachmentError) {
      mapped = new ShareIntakeError(
        error.code === 'authorization'
          ? 'authorization'
          : error.code === 'cleanup'
            ? 'remote-cleanup'
            : 'upload',
        error.message,
        { reauthRequired: error.reauthRequired },
      );
    } else {
      mapped = new ShareIntakeError(
        'remote-cleanup',
        'The upload state could not be confirmed. Refresh the record before sharing this item again.',
      );
    }
    if (shareUploadAllowsReshare(mapped)) {
      try {
        await clearPendingSharedAttachmentUploadRecovery(attachmentID, writer);
      } catch {
        throw new ShareIntakeError(
          'remote-cleanup',
          'The upload was rolled back, but its protected recovery marker could not be cleared. Keep it blocked and try recovery again.',
        );
      }
    }
    throw mapped;
  }
  if ((await currentUser(requireClient(), writer)).id.toLowerCase() !== recovery.userID
    || backendBoundary() !== recovery.backend) {
    throw new ShareIntakeError(
      'remote-cleanup',
      'The signed-in account changed while the attachment was uploading. Sign in to the original account to recover it.',
    );
  }
  await replaceExactPendingSharedAttachmentUploadRecovery(
    recovery,
    { ...recovery, status: 'uploaded' },
    writer,
  );
  try {
    await discardPendingSharedAttachmentNow(current.token);
  } catch {
    try {
      await discardPendingSharedAttachmentNow(current.token);
    } catch {
      throw cleanupError(true);
    }
  }
  return attachment;
}

function sameTarget(left: AttachmentTarget, right: AttachmentTarget): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function failClosedUploadError(error: unknown): ShareIntakeError {
  return error instanceof ShareIntakeError
    ? error
    : new ShareIntakeError(
      'remote-cleanup',
      'The upload state could not be confirmed. Refresh the record before sharing this item again.',
    );
}

export function beginPendingSharedAttachmentUpload(
  target: AttachmentTarget,
  expectedToken: string,
  writer?: MobileSessionWriter,
): PendingSharedAttachmentUploadOperation {
  if (!writer?.userId) throw new ShareIntakeError('authorization', 'The upload account is unavailable.');
  const token = expectedToken.toLowerCase();
  if (pendingSharedAttachmentUpload) {
    if (pendingSharedAttachmentUpload.userID === writer.userId
      && pendingSharedAttachmentUpload.token === token
      && sameTarget(pendingSharedAttachmentUpload.target, target)) {
      return pendingSharedAttachmentUpload;
    }
    throw new ShareIntakeError(
      'remote-cleanup',
      'Another shared attachment is still being reconciled. Return to its record before sharing again.',
    );
  }

  const attachmentID = Crypto.randomUUID();
  if (!UUID_PATTERN.test(attachmentID)) {
    throw new ShareIntakeError('upload', 'The attachment upload could not be initialized securely. Try again.');
  }
  const settlement: Promise<PendingSharedAttachmentUploadSettlement> = Promise.resolve()
    .then(() => uploadPendingSharedAttachmentNow(target, token, attachmentID, writer))
    .then((attachment): PendingSharedAttachmentUploadSettlement => ({
      status: 'uploaded',
      attachmentID,
      attachment,
    }))
    .catch((error: unknown): PendingSharedAttachmentUploadSettlement => {
      if (error instanceof ExistingShareUploadRecoveryError
        && pendingSharedAttachmentUpload?.attachmentID === attachmentID) {
        pendingSharedAttachmentUpload = null;
      }
      return { status: 'failed', attachmentID, error: failClosedUploadError(error) };
    });
  pendingSharedAttachmentUpload = { userID: writer.userId, attachmentID, token, target: { ...target }, settlement };
  return pendingSharedAttachmentUpload;
}

export function getPendingSharedAttachmentUpload(userID?: string | null): PendingSharedAttachmentUploadOperation | null {
  return userID && pendingSharedAttachmentUpload?.userID === userID ? pendingSharedAttachmentUpload : null;
}

export async function acknowledgePendingSharedAttachmentUpload(attachmentID: string): Promise<boolean> {
  const activeMatches = pendingSharedAttachmentUpload?.attachmentID === attachmentID;
  const stored = await readStoredPendingSharedAttachmentUploadRecovery();
  if (!activeMatches && stored?.attachmentID !== attachmentID) return false;
  await clearPendingSharedAttachmentUploadRecovery(attachmentID);
  if (activeMatches) {
    pendingSharedAttachmentUpload = null;
  }
  return true;
}

export function pendingShareStagingCanBeDiscarded(): boolean {
  return pendingSharedAttachmentUpload === null;
}

export function shareUploadAllowsReshare(error: unknown): boolean {
  return error instanceof ShareIntakeError
    && (error.code === 'expired'
      || error.code === 'invalid'
      || error.code === 'authorization'
      || error.code === 'upload');
}

export function withDistinctGuidance(message: string, guidance: string): string {
  return message.includes(guidance) ? message : `${message} ${guidance}`;
}

export function createShareUploadPresentationGate(initialReady: boolean): ShareUploadPresentationGate {
  let ready = initialReady;
  const waiters = new Set<() => void>();
  const waitUntilReady = async () => {
    if (!ready) await new Promise<void>((resolve) => waiters.add(resolve));
  };
  return {
    setReady(nextReady) {
      ready = nextReady;
      if (!ready) return;
      for (const resolve of waiters) resolve();
      waiters.clear();
    },
    waitUntilReady,
    async waitForSettlement(settlement) {
      const result = await settlement;
      await waitUntilReady();
      return result;
    },
  };
}

export async function uploadPendingSharedAttachment(
  target: AttachmentTarget,
  expectedToken: string,
  writer?: MobileSessionWriter,
): Promise<void> {
  const operation = beginPendingSharedAttachmentUpload(target, expectedToken, writer);
  const settlement = await operation.settlement;
  if (settlement.status === 'failed') {
    if (shareUploadAllowsReshare(settlement.error)) {
      await acknowledgePendingSharedAttachmentUpload(operation.attachmentID);
    }
    throw settlement.error;
  }
  await acknowledgePendingSharedAttachmentUpload(operation.attachmentID);
}

export function isStaffTaskAttachmentRole(roles: readonly string[]): boolean {
  return roles.some((role) => (
    role === 'steward' || role === 'coordinator' || role === 'advisor' || role === 'admin' || role === 'vp'
  ));
}

// Only a development SAMPLE bundle can publish this local debugger control.
// Revoke the captured Auth session, then wait for durable exact quarantine;
// no injected user/session or bypass of native account isolation is supplied.
if (typeof __DEV__ !== 'undefined' && __DEV__) {
  installShareRecoveryTestHook(async (expectedUserID) => {
    const client = requireClient();
    const captured = await client.auth.getSession();
    const session = captured.data.session;
    if (captured.error || !session || session.user.id.toLowerCase() !== expectedUserID) {
      throw new Error('The held upload session is no longer current.');
    }
    if ((await currentUser(client)).id.toLowerCase() !== expectedUserID) {
      throw new Error('The held upload no longer belongs to the current account.');
    }
    const recovery = await readStoredPendingSharedAttachmentUploadRecovery();
    if (recovery && (recovery.userID !== expectedUserID || recovery.backend !== backendBoundary())) {
      throw new Error('The exact held upload recovery is unavailable.');
    }
    // This path names A's captured JWT even if a new account arrived meanwhile.
    // Never invoke ambient auth.signOut(), which could revoke that new account.
    const { error } = await client.auth.admin.signOut(session.access_token, 'local');
    if (error) throw error;
    // Auth owns its lock, current-session selection and SIGNED_OUT event. A
    // failed refresh keeps a session whose access token is unexpired, so ask
    // the server about the current JWT: session_not_found makes Auth remove it
    // and emit SIGNED_OUT. If B arrived meanwhile B's JWT is valid, nothing is
    // removed, and the checks below refuse to credit that run instead of
    // forcing an injected signed-out state.
    await client.auth.getUser();
    const attempt = pendingSharedAttachmentSessionLossAttempt;
    if (attempt?.userID === expectedUserID) await attempt.promise;
    const after = await client.auth.getSession();
    if (after.error || after.data.session) throw new Error('The local session was not cleared.');
    const quarantined = await readQuarantinedPendingSharedAttachmentUploadRecoveries();
    if (recovery && !quarantined.some((entry) => sameRecovery(entry, recovery))) {
      throw new Error('The auth meeting did not quarantine the exact held upload.');
    }
  }, async (pause) => {
    // Capture before any asynchronous lookup so even an expired debugger task
    // cannot select a subsequently staged share from a different account.
    const boundary = captureSecureShareCleanupBoundary();
    const owner = await currentUser(requireClient());
    await pause(owner.id.toLowerCase());
    await discardPendingSharedAttachmentCreatedAtOrBefore(boundary);
  });
}
