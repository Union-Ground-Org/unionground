import { releaseTaskAttachmentHandoffs } from '../lib/taskDocumentHandoff';
import { PULSE_CHART_EXPORT_CACHE_KEY } from '../lib/savedPulseCharts';
import { recordLifecycleEvent, type LifecycleOutcome } from './lifecycleDiagnostics';
import { uploadSensitiveCaseFile, downloadSensitiveCaseBytes } from '../../../../src/lib/sensitiveContentApi.js';
import { mobileConfig } from '../lib/config';
import { attachmentImageSize, stripAttachmentJpegMetadata } from '../lib/attachmentJpeg';
import {
  boundedTextPreview,
  stagedPreviewKind,
  STAGED_TEXT_PREVIEW_BYTES,
  type StagedTextPreview,
} from '../lib/attachmentStaging';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  PrivateFileError,
  downloadPrivateObjectToFile,
  requestPrivateFileInspection,
} from './privateFileAccess';
import { getSupabaseClient, verifyCapturedMobileSession, type MobileSessionWriter } from './supabase';
import { attachmentHttpClient, attachmentWriteClient } from './attachmentSession';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// image/heic is deliberately absent (DECISIONS.md E2): the private buckets no
// longer allow it and the server-side inspector refuses it permanently, so
// uploading HEIC bytes could only mint an unreachable quarantined object that
// burns inspection quota on every retry. HEIC is re-encoded to JPEG on this
// device before it is ever validated — see convertibleCandidate below.
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

// The picker still offers HEIC/HEIF so an iPhone's default capture format can
// be chosen and converted. Nothing in this list is ever uploaded as-is.
const PICKER_MIME_TYPES = [
  ...ALLOWED_ATTACHMENT_MIME_TYPES,
  'text/comma-separated-values',
  'image/heic',
  'image/heif',
] as const;
const CONVERTIBLE_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const CONVERTIBLE_EXTENSIONS = new Set(['heic', 'heif']);

export type AllowedAttachmentMimeType = typeof ALLOWED_ATTACHMENT_MIME_TYPES[number];
export type AttachmentTarget = { kind: 'case' | 'task'; id: string };

export type AuthorizedAttachment = {
  id: string;
  targetID: string;
  bucketID: 'case-files' | 'chapter-task-files';
  objectName: string;
  filename: string;
  mimeType: AllowedAttachmentMimeType;
  sizeBytes: number;
  createdAt: string;
};

export type AttachmentCandidate = {
  uri: string;
  filename: string;
  mimeType: AllowedAttachmentMimeType;
  sizeBytes: number;
  cacheOwned: true;
};

export type CameraCaptureResult =
  | { status: 'cancelled' }
  | { status: 'permission-denied'; canAskAgain: boolean }
  | { status: 'selected'; candidate: AttachmentCandidate };

export class AttachmentError extends Error {
  // `rejected` marks a permanent safety-check refusal of these exact bytes:
  // there is nothing for the member to retry. `recheckable` marks the opposite,
  // a verdict that expired or was superseded and can be re-established with one
  // fresh inspection. `reauthRequired` marks the safety check refusing the
  // CALLER rather than the file: authorize_private_upload_inspection requires a
  // satisfied MFA session for every kind (DECISIONS E4, no per-kind carve-out),
  // so a stale session fails every retry identically until the member verifies
  // again. All three are advisory presentation flags; the `code` keeps its
  // existing meaning so every caller's rollback behaviour is unchanged.
  readonly rejected: boolean;
  readonly recheckable: boolean;
  readonly reauthRequired: boolean;
  readonly pendingUploadID?: string;

  constructor(
    readonly code: 'validation' | 'authorization' | 'load' | 'upload' | 'open' | 'remove' | 'camera' | 'cleanup',
    message: string,
    details: { rejected?: boolean; recheckable?: boolean; reauthRequired?: boolean; pendingUploadID?: string } = {},
  ) {
    super(message);
    this.name = 'AttachmentError';
    this.rejected = details.rejected === true;
    this.recheckable = details.recheckable === true;
    this.reauthRequired = details.reauthRequired === true;
    this.pendingUploadID = details.pendingUploadID;
  }
}

const MIME_BY_EXTENSION: Record<string, AllowedAttachmentMimeType> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const ALLOWED_MIME_SET = new Set<string>(ALLOWED_ATTACHMENT_MIME_TYPES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTACHMENT_CACHE_DIRECTORY = 'ug-attachment-cache-v1';
const NATIVE_ATTACHMENT_CACHE_DIRECTORIES = ['DocumentPicker', 'ImageManipulator', 'ImagePicker'] as const;
const pendingCacheCleanupURIs = new Set<string>();
const activeAttachmentCacheURIs = new Set<string>();
let nativeAttachmentProducerCount = 0;

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function expectedBucket(target: AttachmentTarget): AuthorizedAttachment['bucketID'] {
  return target.kind === 'case' ? 'case-files' : 'chapter-task-files';
}

function extensionFor(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index > 0 ? filename.slice(index + 1).toLowerCase() : '';
}

function safeCacheExtension(filename: string): string {
  const extension = extensionFor(filename);
  // Convertible staging copies keep their real extension so the image
  // re-encoder can identify the container; they never become an upload.
  return Object.hasOwn(MIME_BY_EXTENSION, extension) || CONVERTIBLE_EXTENSIONS.has(extension)
    ? extension
    : 'bin';
}

// Shared with the form attachments (services/formFiles.ts), so their opened
// copies live in the same cache the sign-out purge empties.
export async function createOpaqueAttachmentCacheFile(filename: string) {
  const [{ Directory, File, Paths }, Crypto] = await Promise.all([
    import('expo-file-system'),
    import('expo-crypto'),
  ]);
  const opaqueID = Crypto.randomUUID();
  if (!UUID_PATTERN.test(opaqueID)) {
    throw new AttachmentError('cleanup', 'Protected attachment storage could not be initialized. Try again.');
  }
  const directory = new Directory(Paths.cache, ATTACHMENT_CACHE_DIRECTORY);
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  if (!directory.exists) {
    throw new AttachmentError('cleanup', 'Protected attachment storage could not be initialized. Try again.');
  }
  const destination = new File(directory, `${opaqueID}.${safeCacheExtension(filename)}`);
  activeAttachmentCacheURIs.add(destination.uri);
  return destination;
}

async function relocateToAttachmentCache(uri: string, filename: string): Promise<string> {
  const destination = await createOpaqueAttachmentCacheFile(filename);
  try {
    const { File } = await import('expo-file-system');
    const source = new File(uri);
    if (!source.exists) throw new Error('temporary source missing');
    await source.move(destination);
    if (!destination.exists) throw new Error('temporary destination missing');
    pendingCacheCleanupURIs.delete(uri);
    return destination.uri;
  } catch (error) {
    let cleanupFailed = false;
    for (const possibleURI of [destination.uri, uri]) {
      try {
        await cleanupLocalURI(possibleURI);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      throw new AttachmentError(
        'cleanup',
        'Temporary attachment cleanup could not be confirmed. Keep this session open and try again.',
      );
    }
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError('cleanup', 'The selected file could not be moved into protected app storage.');
  }
}

function normalizedMime(filename: string, declaredMimeType: string | null | undefined): AllowedAttachmentMimeType {
  const extensionMime = MIME_BY_EXTENSION[extensionFor(filename)];
  const inputMime = declaredMimeType?.trim().toLowerCase() ?? '';
  // Android's document provider uses this exact alias for .csv files.
  const declared = inputMime === 'text/comma-separated-values' ? 'text/csv' : inputMime;
  const generic = declared === '' || declared === 'application/octet-stream' || declared === 'binary/octet-stream';
  if (!extensionMime || (!generic && declared !== extensionMime)) {
    throw new AttachmentError('validation', 'Choose a PDF, image, text, CSV, Word, or Excel file.');
  }
  return extensionMime;
}

export function validateAttachmentCandidate(input: {
  uri: string;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}): AttachmentCandidate {
  const uri = requiredString(input.uri);
  const filename = requiredString(input.filename);
  const sizeBytes = Number(input.sizeBytes);
  if (!uri.startsWith('file://')) {
    throw new AttachmentError('validation', 'The selected file could not be copied into protected app storage.');
  }
  if (filename.length < 1 || filename.length > 160 || /[/\\\p{C}]/u.test(filename)) {
    throw new AttachmentError('validation', 'The file name must be 1–160 characters without folders or control characters.');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError('validation', 'Choose a file between 1 byte and 10 MiB.');
  }
  return {
    uri,
    filename,
    mimeType: normalizedMime(filename, input.mimeType),
    sizeBytes,
    cacheOwned: true,
  };
}

export async function cleanupLocalURI(uri: string, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) {
    throw new AttachmentError('authorization', 'The secure session changed before temporary attachment cleanup.');
  }
  try {
    const { File } = await import('expo-file-system');
    if (!isCurrent()) {
      throw new AttachmentError('authorization', 'The secure session changed before temporary attachment cleanup.');
    }
    const file = new File(uri);
    if (file.exists) file.delete();
    if (file.exists) throw new Error('temporary file still exists');
    activeAttachmentCacheURIs.delete(uri);
    pendingCacheCleanupURIs.delete(uri);
  } catch (error) {
    if (error instanceof AttachmentError && error.code === 'authorization') throw error;
    recordLifecycleEvent({
      scope: 'attachment-cache', step: 'cache-purge-failed', outcome: 'cache-entry-delete', error,
    });
    activeAttachmentCacheURIs.delete(uri);
    // Every app-owned protected-cache path gets the same durable in-process
    // retry treatment. Callers can lose their last reference after a picker,
    // failed upload, camera sanitization, or viewer close, so foreground
    // cleanup must retain it until absence is verified.
    pendingCacheCleanupURIs.add(uri);
    // Never include the URI in this error: provider paths can contain
    // member-created filenames. Callers must fail closed instead of claiming
    // cleanup succeeded while protected cache bytes may remain.
    throw new AttachmentError(
      'cleanup',
      'Temporary attachment cleanup could not be confirmed. Keep this session open and try again.',
    );
  }
}

export async function cleanupAttachmentCandidate(candidate: AttachmentCandidate | null): Promise<void> {
  if (candidate?.cacheOwned) await cleanupLocalURI(candidate.uri);
}

/**
 * Duplicate a staged candidate under the member's chosen filename.
 *
 * `uploadAuthorizedAttachment` owns the candidate it is given: it deletes the
 * local copy after the bytes land and before the safety verdict, precisely so a
 * refusal can still roll back a pending row that has no app-owned copy behind
 * it. Handing it a per-attempt duplicate keeps that ordering exactly as it is
 * while leaving the staged original on disk, so a recoverable failure — a
 * lapsed MFA session above all — can be retried without sending the member back
 * through the picker for bytes that were already validated.
 *
 * Only the name's stem may differ. The extension, MIME type and size come from
 * the staged candidate and are validated again here, so a rename can never turn
 * a checked file into a different kind of upload.
 */
export async function copyStagedAttachmentCandidate(
  candidate: AttachmentCandidate,
  filename: string,
): Promise<AttachmentCandidate> {
  // Re-derived, not trusted: the renamed filename has to agree with the staged
  // MIME type, so a stem that swapped the extension is refused here rather than
  // becoming a differently typed upload.
  const requested = validateAttachmentCandidate({
    uri: candidate.uri,
    filename,
    mimeType: candidate.mimeType,
    sizeBytes: candidate.sizeBytes,
  });
  const destination = await createOpaqueAttachmentCacheFile(requested.filename);
  try {
    const { File } = await import('expo-file-system');
    const source = new File(candidate.uri);
    if (!source.exists || source.size !== candidate.sizeBytes) {
      throw new AttachmentError('validation', 'The selected file changed before upload. Choose it again.');
    }
    await source.copy(destination);
    if (!destination.exists || destination.size !== candidate.sizeBytes) {
      throw new Error('staged attachment copy is incomplete');
    }
    return { ...requested, uri: destination.uri };
  } catch (error) {
    let cleanupFailed = false;
    try {
      await cleanupLocalURI(destination.uri);
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      throw new AttachmentError(
        'cleanup',
        'Temporary attachment cleanup could not be confirmed. Keep this session open and try again.',
      );
    }
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError('upload', 'The attachment upload could not be initialized securely. Try again.');
  }
}

export async function consumeAttachmentCandidateIfCurrent<T>(
  candidate: AttachmentCandidate,
  isCurrent: () => boolean,
  startUpload: () => Promise<T>,
): Promise<{ status: 'discarded' } | { status: 'uploaded'; value: T }> {
  if (!isCurrent()) {
    await cleanupAttachmentCandidate(candidate);
    return { status: 'discarded' };
  }
  // Once started, uploadAuthorizedAttachment owns the complete local/remote
  // lifecycle. A later screen generation must not interrupt its rollback or
  // delete-verified local cleanup.
  return { status: 'uploaded', value: await startUpload() };
}

export class AttachmentSelectionLifecycle {
  private generation = 0;
  private targetKey: string | null = null;

  updateTarget(target: AttachmentTarget): void {
    const nextKey = `${target.kind}\0${target.id}`;
    if (this.targetKey === null) {
      this.targetKey = nextKey;
    } else if (this.targetKey !== nextKey) {
      this.targetKey = nextKey;
      this.invalidate();
    }
  }

  capture(): number {
    return this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }

  consume<T>(
    token: number,
    candidate: AttachmentCandidate,
    startUpload: () => Promise<T>,
  ): Promise<{ status: 'discarded' } | { status: 'uploaded'; value: T }> {
    return consumeAttachmentCandidateIfCurrent(
      candidate,
      () => token === this.generation,
      startUpload,
    );
  }
}

// Either declared signal is enough on its own: a picker that reports
// `image/jpeg` for `IMG_0042.HEIC`, and one that reports `image/heic` for a
// name with no extension at all, both describe a photo this build must
// re-encode. Neither claim is trusted to overrule the other.
function needsOnDeviceConversion(filename: string, mimeType: string | null | undefined): boolean {
  return CONVERTIBLE_EXTENSIONS.has(extensionFor(requiredString(filename)))
    || CONVERTIBLE_MIME_TYPES.has(requiredString(mimeType).toLowerCase());
}

// ISO base media containers announce themselves at bytes 4..8 with `ftyp`, and
// the brand that follows says which flavour. These are the HEIF/HEIC brands the
// server inspector permanently refuses; `avif`/`avis` are deliberately absent,
// because an AVIF is not something this converter should silently re-encode.
const HEIC_FTYP_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis',
  'hevc', 'hevx', 'hevm', 'hevs',
  'mif1', 'msf1',
]);

// The third signal, for the file that lies in both of the others: `IMG_0042.jpg`
// reported as `image/jpeg` and holding HEIC bytes. Uploading those bytes mints
// an object the inspector rejects permanently and burns inspection quota on
// every retry, so the container is read rather than believed. A file that
// cannot be read here simply keeps its declared type; the server still refuses
// the bytes, so this can only ever turn a permanent rejection into a working
// conversion.
//
// TWELVE BYTES, NOT THE WHOLE FILE. This probe runs for every locally picked
// attachment that name and MIME did not already classify, and attachments are
// capped at 10 MiB — reading the whole file to look at its header would cost a
// full extra read and a 10 MiB allocation on a mid-range device before the
// upload even starts. `File.open()` gives a read handle whose `readBytes` is
// bounded, so the cost is the header alone. The handle is closed on every path,
// including the throwing one. (The web twin does the same with
// `file.slice(0, 12).arrayBuffer()` in src/lib/heicNormalization.js.)
const HEIC_MAGIC_BYTES = 12;

async function localFileHasHeicMagic(uri: string): Promise<boolean> {
  try {
    const { File, FileMode } = await import('expo-file-system');
    const file = new File(uri);
    if (!file.exists) return false;
    // Read-only: a SAF `content://` URI cannot be opened read-write at all, and
    // nothing here has any business writing to a member's chosen file.
    const handle = file.open(FileMode.ReadOnly);
    let head: Uint8Array;
    try {
      head = handle.readBytes(HEIC_MAGIC_BYTES);
    } finally {
      handle.close();
    }
    if (head.length < HEIC_MAGIC_BYTES) return false;
    let ascii = '';
    for (const byte of head.subarray(4, HEIC_MAGIC_BYTES)) ascii += String.fromCharCode(byte);
    return ascii.startsWith('ftyp') && HEIC_FTYP_BRANDS.has(ascii.slice(4, 8).toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Read the staged text preview window from the app-private copy.
 *
 * The same bounded read handle the HEIC probe uses: at most
 * STAGED_TEXT_PREVIEW_BYTES leave the file, never the whole 10 MiB, and the
 * handle is closed on every path. The bytes are decoded and shown on this
 * device only — no preview text is logged, announced, or sent anywhere — and any
 * failure simply means no preview, because the summary alone is already honest.
 */
export async function readStagedTextPreview(
  candidate: AttachmentCandidate,
): Promise<StagedTextPreview | null> {
  if (stagedPreviewKind(candidate.mimeType) !== 'text') return null;
  try {
    const { File, FileMode } = await import('expo-file-system');
    const file = new File(candidate.uri);
    if (!file.exists) return null;
    const handle = file.open(FileMode.ReadOnly);
    let head: Uint8Array;
    try {
      head = handle.readBytes(STAGED_TEXT_PREVIEW_BYTES);
    } finally {
      handle.close();
    }
    return boundedTextPreview(head, candidate.sizeBytes);
  } catch {
    return null;
  }
}

function jpegFilename(filename: string): string {
  const trimmed = requiredString(filename);
  const index = trimmed.lastIndexOf('.');
  const base = (index > 0 ? trimmed.slice(0, index) : trimmed).slice(0, 150);
  return `${base || 'photo'}.jpg`;
}

// One re-encoder for both the camera and the gallery/document path: the pixels
// are re-rendered and bounded, then native encoder metadata is removed before
// the JPEG can leave protected temporary storage.
async function jpegFromProtectedURI(protectedURI: string, outputName: string): Promise<string> {
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const context = ImageManipulator.manipulate(protectedURI);
  let rendered = await context.renderAsync();
  const size = attachmentImageSize(rendered.width, rendered.height);
  if (size.width !== rendered.width || size.height !== rendered.height) {
    context.resize(size);
    rendered = await context.renderAsync();
  }
  const saved = await rendered.saveAsync({ compress: 0.82, format: SaveFormat.JPEG, base64: false });
  const protectedOutput = await relocateToAttachmentCache(saved.uri, outputName);
  let bytes: Uint8Array | undefined;
  let normalized: Uint8Array | undefined;
  try {
    const { File } = await import('expo-file-system');
    const file = new File(protectedOutput);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error('attachment-image-size');
    }
    bytes = new Uint8Array(await file.arrayBuffer());
    normalized = stripAttachmentJpegMetadata(bytes);
    file.write(normalized);
    return protectedOutput;
  } catch (error) {
    await cleanupLocalURI(protectedOutput);
    throw error;
  } finally {
    bytes?.fill(0);
    normalized?.fill(0);
  }
}

// HEIC/HEIF chosen from the gallery or the document picker is converted here
// rather than uploaded: the buckets refuse image/heic and the inspector rejects
// it permanently. The declared size is recomputed from the re-encoded bytes and
// the candidate is re-validated, so nothing about the original survives.
async function convertibleCandidate(input: {
  uri: string;
  filename: string;
}): Promise<AttachmentCandidate> {
  let convertedURI: string | null = null;
  let protectedRawURI: string | null = null;
  try {
    protectedRawURI = await relocateToAttachmentCache(input.uri, `photo-source.${extensionFor(input.filename) || 'heic'}`);
    convertedURI = await jpegFromProtectedURI(protectedRawURI, 'photo-output.jpg');
    const { File } = await import('expo-file-system');
    const file = new File(convertedURI);
    return validateAttachmentCandidate({
      uri: convertedURI,
      filename: jpegFilename(input.filename),
      mimeType: 'image/jpeg',
      sizeBytes: file.size,
    });
  } catch (error) {
    if (convertedURI) await cleanupLocalURI(convertedURI);
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError('validation', 'This photo could not be converted for upload. Choose a JPEG or PNG instead.');
  } finally {
    const rawURI = protectedRawURI ?? input.uri;
    if (convertedURI !== rawURI) {
      try {
        await cleanupLocalURI(rawURI);
      } catch (cleanupError) {
        if (convertedURI) await cleanupLocalURI(convertedURI).catch(() => undefined);
        throw cleanupError;
      }
    }
  }
}

async function candidateFromLocalFile(input: {
  uri: string;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  onPhase?: (phase: AttachmentProducerPhase) => void;
}): Promise<AttachmentCandidate> {
  if (needsOnDeviceConversion(input.filename, input.mimeType)
    || await localFileHasHeicMagic(requiredString(input.uri))) {
    // The re-encode is the slow stage on a mid-range device, so the member is
    // told it is happening rather than watching a generic spinner.
    notifyProducerPhase(input.onPhase, 'converting');
    return convertibleCandidate({ uri: requiredString(input.uri), filename: input.filename });
  }
  try {
    const { File } = await import('expo-file-system');
    const file = new File(input.uri);
    const candidate = validateAttachmentCandidate({ ...input, sizeBytes: input.sizeBytes ?? file.size });
    const protectedURI = await relocateToAttachmentCache(candidate.uri, candidate.filename);
    return { ...candidate, uri: protectedURI };
  } catch (error) {
    await cleanupLocalURI(input.uri);
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError('validation', 'The selected file could not be read from protected app storage.');
  }
}

export type AttachmentProducerPhase = 'preparing' | 'converting';

// A presentation listener must never be able to change what the producer
// returns, exactly as on the upload path.
function notifyProducerPhase(
  onPhase: ((phase: AttachmentProducerPhase) => void) | undefined,
  phase: AttachmentProducerPhase,
): void {
  try {
    onPhase?.(phase);
  } catch {
    // ignored on purpose
  }
}

export async function pickAuthorizedDocument(options?: {
  onPhase?: (phase: AttachmentProducerPhase) => void;
}): Promise<AttachmentCandidate | null> {
  nativeAttachmentProducerCount += 1;
  try {
    const DocumentPicker = await import('expo-document-picker');
    const result = await DocumentPicker.getDocumentAsync({
      type: [...PICKER_MIME_TYPES],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset) return null;
    notifyProducerPhase(options?.onPhase, 'preparing');
    return await candidateFromLocalFile({
      uri: asset.uri,
      filename: asset.name,
      mimeType: asset.mimeType,
      sizeBytes: asset.size,
      onPhase: options?.onPhase,
    });
  } finally {
    nativeAttachmentProducerCount -= 1;
  }
}

function scanFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `scanned-document-${stamp}.jpg`;
}

async function sanitizedCameraCandidate(uri: string): Promise<AttachmentCandidate> {
  let sanitizedURI: string | null = null;
  let protectedRawURI: string | null = null;
  try {
    protectedRawURI = await relocateToAttachmentCache(uri, 'camera-source.jpg');
    sanitizedURI = await jpegFromProtectedURI(protectedRawURI, 'camera-output.jpg');
    const { File } = await import('expo-file-system');
    const file = new File(sanitizedURI);
    return validateAttachmentCandidate({
      uri: sanitizedURI,
      filename: scanFilename(),
      mimeType: 'image/jpeg',
      sizeBytes: file.size,
    });
  } catch (error) {
    if (sanitizedURI) await cleanupLocalURI(sanitizedURI);
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError('camera', 'The scan could not be prepared securely. Try the camera again.');
  } finally {
    const rawURI = protectedRawURI ?? uri;
    if (sanitizedURI !== rawURI) {
      try {
        await cleanupLocalURI(rawURI);
      } catch (cleanupError) {
        if (sanitizedURI) await cleanupLocalURI(sanitizedURI).catch(() => undefined);
        throw cleanupError;
      }
    }
  }
}

export async function captureAuthorizedScan(options?: {
  onPhase?: (phase: AttachmentProducerPhase) => void;
}): Promise<CameraCaptureResult> {
  nativeAttachmentProducerCount += 1;
  try {
    const ImagePicker = await import('expo-image-picker');
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { status: 'permission-denied', canAskAgain: permission.canAskAgain };
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      cameraType: ImagePicker.CameraType.back,
      allowsEditing: false,
      allowsMultipleSelection: false,
      base64: false,
      exif: false,
      quality: 1,
    });
    if (result.canceled) return { status: 'cancelled' };
    const asset = result.assets[0];
    if (!asset?.uri) return { status: 'cancelled' };
    notifyProducerPhase(options?.onPhase, 'preparing');
    // Every scan is re-encoded and stripped before it can leave protected
    // storage, so the conversion stage is reported unconditionally here.
    notifyProducerPhase(options?.onPhase, 'converting');
    return { status: 'selected', candidate: await sanitizedCameraCandidate(asset.uri) };
  } finally {
    nativeAttachmentProducerCount -= 1;
  }
}

type AttachmentCachePurgeResult = { clean: boolean; found: boolean };

let attachmentCachePurgeTail: Promise<void> = Promise.resolve();

async function purgeAttachmentCachePass(
  isCurrent: () => boolean = () => true,
  consumeInterruptedCameraResult = false,
): Promise<AttachmentCachePurgeResult> {
  let found = pendingCacheCleanupURIs.size > 0 || activeAttachmentCacheURIs.size > 0;
  let clean = activeAttachmentCacheURIs.size === 0 && nativeAttachmentProducerCount === 0;
  let step: LifecycleOutcome = 'retained-cache-cleanup';
  const recordFailure = (error: unknown) => recordLifecycleEvent({
    scope: 'attachment-cache', step: 'cache-purge-failed', outcome: step, error,
  });
  try {
    // Retry every retained protected-cache URI before Android consumes its
    // one-shot pending camera result. Any path whose deletion cannot be
    // verified remains queued for the next serialized foreground pass.
    step = 'retained-cache-cleanup';
    for (const uri of [...pendingCacheCleanupURIs]) {
      if (!isCurrent()) throw new AttachmentError('authorization', 'The secure session changed during temporary attachment cleanup.');
      if (activeAttachmentCacheURIs.has(uri)) {
        clean = false;
        continue;
      }
      try {
        await cleanupLocalURI(uri, isCurrent);
      } catch (error) {
        if (error instanceof AttachmentError && error.code === 'authorization') throw error;
        // cleanupLocalURI already recorded the original native exception.
        return { clean: false, found: true };
      }
    }

    step = 'cache-directory-list';
    const { Directory, Paths } = await import('expo-file-system');
    if (!isCurrent()) throw new AttachmentError('authorization', 'The secure session changed during temporary attachment cleanup.');
    const directoryNames = [ATTACHMENT_CACHE_DIRECTORY, PULSE_CHART_EXPORT_CACHE_KEY, ...NATIVE_ATTACHMENT_CACHE_DIRECTORIES];
    for (const directoryName of directoryNames) {
      if (directoryName !== ATTACHMENT_CACHE_DIRECTORY && nativeAttachmentProducerCount > 0) {
        clean = false;
        continue;
      }
      step = 'cache-directory-list';
      const directory = new Directory(Paths.cache, directoryName);
      if (!directory.exists) continue;
      for (const entry of directory.list()) {
        if (!isCurrent()) throw new AttachmentError('authorization', 'The secure session changed during temporary attachment cleanup.');
        found = true;
        if (activeAttachmentCacheURIs.has(entry.uri)) {
          clean = false;
          continue;
        }
        step = 'cache-entry-delete';
        try {
          if (entry.exists) entry.delete();
          if (entry.exists) throw new Error('temporary cache entry still exists');
          pendingCacheCleanupURIs.delete(entry.uri);
        } catch (error) {
          recordFailure(error);
          pendingCacheCleanupURIs.add(entry.uri);
          clean = false;
        }
      }
    }

    // Do not consume Android's one-shot result while an earlier known path is
    // still undeleted or while a native picker/manipulator owns its cache.
    if (pendingCacheCleanupURIs.size > 0 || nativeAttachmentProducerCount > 0) {
      return { clean: false, found };
    }

    if (!consumeInterruptedCameraResult) {
      return {
        clean: clean && activeAttachmentCacheURIs.size === 0,
        found,
      };
    }
    step = 'pending-camera-result';
    const ImagePicker = await import('expo-image-picker');
    if (!isCurrent()) throw new AttachmentError('authorization', 'The secure session changed during temporary attachment cleanup.');
    const pending = await ImagePicker.getPendingResultAsync();
    if (!isCurrent()) throw new AttachmentError('authorization', 'The secure session changed during temporary attachment cleanup.');
    if (!pending || 'code' in pending || pending.canceled) {
      return {
        clean: clean && activeAttachmentCacheURIs.size === 0,
        found,
      };
    }
    for (const asset of pending.assets) {
      const uri = requiredString(asset.uri);
      if (!uri) return { clean: false, found: true };
      pendingCacheCleanupURIs.add(uri);
      found = true;
    }
    step = 'retained-cache-cleanup';
    for (const uri of [...pendingCacheCleanupURIs]) {
      if (!isCurrent()) throw new AttachmentError('authorization', 'The secure session changed during temporary attachment cleanup.');
      try {
        await cleanupLocalURI(uri, isCurrent);
      } catch (error) {
        if (error instanceof AttachmentError && error.code === 'authorization') throw error;
        // cleanupLocalURI already recorded the original native exception.
        // The URI remains in the module-level queue for the next active pass.
        clean = false;
      }
    }
    return {
      clean: clean && pendingCacheCleanupURIs.size === 0 && activeAttachmentCacheURIs.size === 0,
      found,
    };
  } catch (error) {
    if (error instanceof AttachmentError && error.code === 'authorization') throw error;
    recordFailure(error);
    return { clean: false, found };
  }
}

function attachmentCachePurgePass(
  isCurrent: () => boolean = () => true,
  consumeInterruptedCameraResult = false,
): Promise<AttachmentCachePurgeResult> {
  // Each caller keeps its own ownership guard. Reusing an older in-flight
  // promise would also reuse its account epoch and could let that pass clean a
  // newer session's files. The tail serializes deletion without coalescing the
  // guards.
  const pass = attachmentCachePurgeTail.then(
    () => purgeAttachmentCachePass(isCurrent, consumeInterruptedCameraResult),
    () => purgeAttachmentCachePass(isCurrent, consumeInterruptedCameraResult),
  );
  attachmentCachePurgeTail = pass.then(() => undefined, () => undefined);
  return pass;
}

export async function purgeAttachmentCache(
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  return (await attachmentCachePurgePass(isCurrent, true)).clean;
}

export async function purgeAttachmentCacheForSignOut(
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) {
    throw new AttachmentError('authorization', 'The secure session changed before temporary attachment cleanup.');
  }
  await releaseTaskAttachmentHandoffs(isCurrent);
  if (!isCurrent()) throw new AttachmentError('authorization', 'The secure session changed during temporary attachment cleanup.');
  if (nativeAttachmentProducerCount > 0 || activeAttachmentCacheURIs.size > 0) {
    throw new AttachmentError(
      'cleanup',
      'An attachment operation is still active. Keep this session open and try again.',
    );
  }
  const result = await attachmentCachePurgePass(isCurrent, true);
  if (!isCurrent()) {
    throw new AttachmentError('authorization', 'The secure session changed during temporary attachment cleanup.');
  }
  if (!result.clean || nativeAttachmentProducerCount > 0 || activeAttachmentCacheURIs.size > 0) {
    throw new AttachmentError(
      'cleanup',
      'Temporary attachment cleanup could not be confirmed. Keep this session open and try again.',
    );
  }
}

export async function purgeAttachmentCacheForSessionLoss(isCurrent: () => boolean): Promise<boolean> {
  await releaseTaskAttachmentHandoffs(isCurrent);
  if (!isCurrent()) return false;
  return purgeAttachmentCache(isCurrent);
}

export async function discardInterruptedCameraCapture(): Promise<boolean> {
  const result = await attachmentCachePurgePass(() => true, true);
  return result.found && result.clean;
}

function requireClient(): SupabaseClient {
  const client = getSupabaseClient();
  if (!client) throw new AttachmentError('authorization', 'The secure mobile backend is not configured.');
  return client;
}

async function requireCurrentSession(client: SupabaseClient, writer?: MobileSessionWriter): Promise<void> {
  const { data, error } = writer
    ? await verifyCapturedMobileSession(await writer.session())
    : await client.auth.getUser();
  if (error && error.status !== 401 && error.status !== 403) {
    throw new AttachmentError('load', 'Your authorization could not be checked. Try again when connected.');
  }
  if (error || !data.user) {
    throw new AttachmentError('authorization', 'Your authorization changed. Sign in again before working with attachments.');
  }
}

function attachmentFromRow(
  target: AttachmentTarget,
  value: unknown,
  expectedID?: string,
): AuthorizedAttachment {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const id = requiredString(row.id);
  const targetID = requiredString(target.kind === 'case'
    ? row.case_id ?? row.caseId
    : row.task_id ?? row.taskId);
  const bucketID = requiredString(row.bucket_id ?? row.bucketId);
  const objectName = requiredString(row.object_name ?? row.objectName);
  const filename = requiredString(row.filename);
  const mimeType = requiredString(row.mime_type ?? row.mimeType).toLowerCase();
  const sizeBytes = Number(row.size_bytes ?? row.sizeBytes);
  const createdAt = requiredString(row.created_at ?? row.createdAt);
  if (!UUID_PATTERN.test(id) || (expectedID && id !== expectedID)
    || targetID !== target.id || bucketID !== expectedBucket(target)
    || !objectName || !createdAt || !ALLOWED_MIME_SET.has(mimeType)) {
    throw new AttachmentError('load', 'Attachment metadata did not match the authorized record.');
  }
  const validated = validateAttachmentCandidate({
    uri: 'file://metadata-only',
    filename,
    mimeType,
    sizeBytes,
  });
  return {
    id,
    targetID,
    bucketID: bucketID as AuthorizedAttachment['bucketID'],
    objectName,
    filename: validated.filename,
    mimeType: validated.mimeType,
    sizeBytes: validated.sizeBytes,
    createdAt,
  };
}

function tableFor(target: AttachmentTarget): 'member_case_files' | 'chapter_task_files' {
  return target.kind === 'case' ? 'member_case_files' : 'chapter_task_files';
}

function targetColumn(target: AttachmentTarget): 'case_id' | 'task_id' {
  return target.kind === 'case' ? 'case_id' : 'task_id';
}

const ATTACHMENT_COLUMNS = 'id,case_id,task_id,bucket_id,object_name,filename,mime_type,size_bytes,created_at';

export async function listAuthorizedAttachments(target: AttachmentTarget): Promise<AuthorizedAttachment[]> {
  const client = requireClient();
  await requireCurrentSession(client);
  const columns = target.kind === 'case'
    ? ATTACHMENT_COLUMNS.replace('task_id,', '')
    : ATTACHMENT_COLUMNS.replace('case_id,', '');
  const { data, error } = await client.from(tableFor(target))
    .select(columns)
    .eq(targetColumn(target), target.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true });
  if (error) throw new AttachmentError('load', 'Attachments could not be refreshed through your current authorization.');
  return (data ?? []).map((row) => attachmentFromRow(target, row));
}

async function currentAttachment(client: SupabaseClient, target: AttachmentTarget, attachmentID: string, writer?: MobileSessionWriter): Promise<AuthorizedAttachment> {
  await requireCurrentSession(client, writer);
  const columns = target.kind === 'case'
    ? ATTACHMENT_COLUMNS.replace('task_id,', '')
    : ATTACHMENT_COLUMNS.replace('case_id,', '');
  const { data, error } = await client.from(tableFor(target))
    .select(columns)
    .eq('id', attachmentID)
    .eq(targetColumn(target), target.id)
    .maybeSingle();
  if (error && !['42501', 'PGRST301', 'PGRST302', 'PGRST303'].includes(error.code)) {
    throw new AttachmentError('load', 'The attachment could not be refreshed securely. Try again.');
  }
  if (error || !data) {
    throw new AttachmentError('authorization', 'That attachment is no longer available through your current authorization.');
  }
  return attachmentFromRow(target, data);
}

function uploadContract(target: AttachmentTarget, candidate: AttachmentCandidate, fileID: string) {
  return target.kind === 'case'
    ? {
      begin: 'begin_member_case_file_upload',
      confirm: 'confirm_member_case_file_upload',
      abort: 'abort_member_case_file_upload',
      args: { p_file_id: fileID, p_case_id: target.id, p_filename: candidate.filename, p_mime_type: candidate.mimeType, p_size_bytes: candidate.sizeBytes },
    }
    : {
      begin: 'begin_chapter_task_file_upload',
      confirm: 'confirm_chapter_task_file_upload',
      abort: 'abort_chapter_task_file_upload',
      args: { p_file_id: fileID, p_task_id: target.id, p_filename: candidate.filename, p_mime_type: candidate.mimeType, p_size_bytes: candidate.sizeBytes },
    };
}

function removalContract(target: AttachmentTarget, attachmentID: string, removalID: string) {
  return target.kind === 'case'
    ? {
      request: 'request_member_case_file_removal',
      args: { p_file_id: attachmentID, p_removal_id: removalID },
    }
    : {
      request: 'request_chapter_task_file_removal',
      args: { p_file_id: attachmentID, p_removal_id: removalID },
    };
}

function exactRemovalReceipt(value: unknown, attachmentID: string, removalID: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return requiredString(receipt.id) === attachmentID
    && requiredString(receipt.removal_id ?? receipt.removalId) === removalID
    && (receipt.deleted === true || receipt.absent === true);
}

function requestedRemovalFromRow(
  target: AttachmentTarget,
  value: unknown,
  attachmentID: string,
  removalID: string,
): AuthorizedAttachment {
  const attachment = attachmentFromRow(target, value, attachmentID);
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const returnedRemovalID = requiredString(row.removal_id ?? row.removalId);
  const requestedAt = requiredString(row.removal_requested_at ?? row.removalRequestedAt);
  if (returnedRemovalID !== removalID || !requestedAt || !Number.isFinite(Date.parse(requestedAt))) {
    throw new AttachmentError('cleanup', 'The attachment removal checkpoint could not be verified.');
  }
  return attachment;
}

function responseConfirmedAt(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return requiredString((value as Record<string, unknown>).confirmed_at
    ?? (value as Record<string, unknown>).confirmedAt);
}

async function abortPendingUpload(
  client: SupabaseClient,
  abortRPC: string,
  fileID: string,
  writer?: MobileSessionWriter,
): Promise<'absent' | 'queued' | 'uncertain'> {
  try {
    // Pending rows are deliberately unreadable, and Supabase Storage DELETE
    // also requires SELECT. The authenticated client therefore commits only
    // an exact cleanup checkpoint; the service-role reconciler owns bytes.
    //
    // This is also the ONLY thing on the client that can tell "the row is gone"
    // from "your session is stale": the abort RPC is authorized by the caller's
    // own scope, so it answers about a row it will only ever touch if that row
    // is the caller's own pending upload. `absent` and `deleted` are exact
    // receipts; `queued` and every ambiguity stay unresolved on purpose.
    const aborted = await (await attachmentWriteClient(writer)).rpc(abortRPC, { p_file_id: fileID });
    if (aborted.error) return 'uncertain';
    const answer = aborted.data && typeof aborted.data === 'object' && !Array.isArray(aborted.data)
      ? aborted.data as Record<string, unknown>
      : null;
    if (requiredString(answer?.id) !== fileID) return 'uncertain';
    if (answer?.deleted === true || answer?.absent === true) return 'absent';
    const cleanupRequestedAt = requiredString(answer?.cleanup_requested_at ?? answer?.cleanupRequestedAt);
    return answer?.cleanupQueued === true
      && Number.isFinite(Date.parse(cleanupRequestedAt))
      ? 'queued'
      : 'uncertain';
  } catch {
    return 'uncertain';
  }
}

export type AttachmentUploadReconciliation =
  | { status: 'confirmed'; attachment: AuthorizedAttachment }
  | { status: 'aborted' }
  | { status: 'rejected' }
  // The safety check refused the caller's session. Fail-closed exactly like
  // 'uncertain' — nothing is confirmed and nothing is aborted — but named
  // separately so the caller can prompt re-auth instead of retrying forever.
  | { status: 'reauth-required' }
  // The caller's own abort answered with a queued cleanup: the row is hidden
  // and the service reconciler owns its bytes. The abort requires a satisfied
  // MFA session, so this proves the session is fine; nothing was attached, and
  // no reauthentication could change the answer.
  | { status: 'cleanup-queued' }
  | { status: 'uncertain' };

// A refused file is rolled back through the pending-upload abort RPC, never
// through a client-side storage.remove(): the authenticated client only ever
// commits an exact checkpoint and the service reconciler owns the bytes (G5).
async function abortRefusedUpload(
  client: SupabaseClient,
  abortRPC: string,
  fileID: string,
  writer?: MobileSessionWriter,
): Promise<AttachmentUploadReconciliation> {
  try {
    const aborted = await (await attachmentWriteClient(writer)).rpc(abortRPC, { p_file_id: fileID });
    if (aborted.error || !aborted.data || typeof aborted.data !== 'object' || Array.isArray(aborted.data)) {
      return { status: 'uncertain' };
    }
    const receipt = aborted.data as Record<string, unknown>;
    if (requiredString(receipt.id) !== fileID
      || (receipt.deleted !== true && receipt.absent !== true)) {
      return { status: 'uncertain' };
    }
    return { status: 'rejected' };
  } catch {
    return { status: 'uncertain' };
  }
}

export async function reconcileAuthorizedAttachmentUpload(
  target: AttachmentTarget,
  fileID: string,
  options: { writer?: MobileSessionWriter; onPhase?: (phase: AttachmentUploadPhase) => void } = {},
): Promise<AttachmentUploadReconciliation> {
  if (!UUID_PATTERN.test(fileID)) return { status: 'uncertain' };
  let client: SupabaseClient;
  try {
    client = await attachmentWriteClient(options.writer);
    await requireCurrentSession(client, options.writer);
  } catch {
    return { status: 'uncertain' };
  }

  const confirmRPC = target.kind === 'case'
    ? 'confirm_member_case_file_upload'
    : 'confirm_chapter_task_file_upload';
  const abortRPC = target.kind === 'case'
    ? 'abort_member_case_file_upload'
    : 'abort_chapter_task_file_upload';

  // The interrupted attempt may never have been inspected. Confirming first
  // would make an unscanned upload visible, so the verdict is re-established
  // here — the server short-circuits on an already-current clean verdict.
  notifyPhase(options.onPhase, 'checking');
  try {
    await requestPrivateFileInspection(client, target.kind, fileID, { writer: options.writer });
  } catch (error) {
    if (error instanceof PrivateFileError
      && (error.code === 'not-authorized' || error.code === 'reauth-required')) {
      // Two very different things reach this branch, and the endpoint will not
      // say which: a stale MFA session, and a row that is simply gone. The
      // second one is real and routine — a rejected upload still has bytes, so
      // its abort answers `cleanupQueued`, and the service reconciler removes
      // the object and the row afterwards. Treating that as a session problem
      // left the member reauthenticating forever while share intake stayed
      // blocked, because the marker is deliberately retained for 'reauth'.
      //
      // The idempotent abort/status transition resolves it without guessing.
      // It requires a satisfied MFA session of its own, so a genuinely stale
      // session cannot answer it at all and lands on 'uncertain' — the marker
      // is kept, exactly as before. Only an EXACT absent/deleted receipt for
      // this file id clears it. A queued cleanup is the third, routine answer
      // (a refused upload whose bytes still await the service reconciler): the
      // abort itself proved the session, so it is never reported as reauth.
      const settled = await abortPendingUpload(client, abortRPC, fileID, options.writer);
      if (settled === 'absent') return { status: 'aborted' };
      if (settled === 'queued') return { status: 'cleanup-queued' };
      return { status: 'reauth-required' };
    }
    if (!(error instanceof PrivateFileError) || error.code !== 'rejected') {
      return { status: 'uncertain' };
    }
    return abortRefusedUpload(client, abortRPC, fileID, options.writer);
  }

  let confirmation: Awaited<ReturnType<SupabaseClient['rpc']>>;
  notifyPhase(options.onPhase, 'confirming');
  try {
    confirmation = await (await attachmentWriteClient(options.writer)).rpc(confirmRPC, { p_file_id: fileID });
  } catch {
    return { status: 'uncertain' };
  }

  if (!confirmation.error) {
    try {
      const attachment = attachmentFromRow(target, confirmation.data, fileID);
      if (!responseConfirmedAt(confirmation.data)) return { status: 'uncertain' };
      return { status: 'confirmed', attachment };
    } catch {
      return { status: 'uncertain' };
    }
  }

  const status = Number((confirmation as { status?: unknown }).status);
  const code = requiredString((confirmation.error as { code?: unknown }).code);
  const message = requiredString(confirmation.error.message).toLowerCase();
  const definitivelyUnavailable = status === 400 && code === '22023'
    && (message.includes('uploaded file was not found') || message.includes('file unavailable'));
  if (!definitivelyUnavailable) return { status: 'uncertain' };

  try {
    const aborted = await (await attachmentWriteClient(options.writer)).rpc(abortRPC, { p_file_id: fileID });
    if (aborted.error || !aborted.data || typeof aborted.data !== 'object' || Array.isArray(aborted.data)) {
      return { status: 'uncertain' };
    }
    const receipt = aborted.data as Record<string, unknown>;
    if (requiredString(receipt.id) !== fileID
      || (receipt.deleted !== true && receipt.absent !== true)) {
      return { status: 'uncertain' };
    }
    return { status: 'aborted' };
  } catch {
    return { status: 'uncertain' };
  }
}

export type AttachmentUploadPhase = 'uploading' | 'checking' | 'confirming';

function notifyPhase(
  onPhase: ((phase: AttachmentUploadPhase) => void) | undefined,
  phase: AttachmentUploadPhase,
): void {
  // A presentation listener must never be able to change the upload's outcome.
  try {
    onPhase?.(phase);
  } catch {
    // ignored on purpose
  }
}

export async function uploadAuthorizedAttachment(
  target: AttachmentTarget,
  candidate: AttachmentCandidate,
  options: {
    writer?: MobileSessionWriter;
    cleanupCandidate?: boolean;
    fileID?: string;
    onPhase?: (phase: AttachmentUploadPhase) => void;
  } = {},
): Promise<AuthorizedAttachment> {
  let client: SupabaseClient | null = null;
  let fileID = '';
  let contract: ReturnType<typeof uploadContract> | null = null;
  let beginMayExist = false;
  let registered: AuthorizedAttachment | null = null;
  let confirmationAttempted = false;
  // Set only when the safety check answered with something other than an
  // explicit verdict. The upload is then owned by the durable reconciler: this
  // path must neither abort it nor confirm it.
  let inspectionUnresolved = false;
  try {
    try { client = await attachmentWriteClient(options.writer); }
    catch { throw new AttachmentError('authorization', 'Your authorization changed. Sign in again before working with attachments.'); }
    if (options.fileID === undefined) {
      const Crypto = await import('expo-crypto');
      fileID = Crypto.randomUUID();
    } else {
      fileID = options.fileID;
    }
    if (!UUID_PATTERN.test(fileID)) {
      throw new AttachmentError('upload', 'The attachment upload could not be initialized securely. Try again.');
    }
    contract = uploadContract(target, candidate, fileID);
    await requireCurrentSession(client, options.writer);
    beginMayExist = true;
    const result = await (await attachmentWriteClient(options.writer)).rpc(contract.begin, contract.args);
    if (result.error) {
      throw new AttachmentError('authorization', 'This record no longer accepts attachments through your current authorization.');
    }
    registered = attachmentFromRow(target, result.data, fileID);

    const { File } = await import('expo-file-system');
    const localFile = new File(candidate.uri);
    if (!localFile.exists || localFile.size !== candidate.sizeBytes) {
      throw new AttachmentError('validation', 'The selected file changed before upload. Choose it again.');
    }
    const bytes = await localFile.arrayBuffer();
    if (bytes.byteLength !== candidate.sizeBytes) {
      throw new AttachmentError('validation', 'The selected file changed before upload. Choose it again.');
    }
    notifyPhase(options.onPhase, 'uploading');
    const upload = target.kind === 'case'
      ? await uploadSensitiveCaseFile(attachmentHttpClient(options.writer), fileID, { size: bytes.byteLength, arrayBuffer: async () => bytes }, mobileConfig.portalBaseUrl)
      : await (await attachmentWriteClient(options.writer)).storage.from(registered.bucketID).upload(registered.objectName, bytes, {
      contentType: registered.mimeType,
      upsert: false,
    });
    if (upload.error) throw new AttachmentError('upload', 'The attachment was not uploaded. Nothing was saved; try again.');
    // Keep metadata pending until the app-owned local copy is gone. If local
    // cleanup fails, the exact Storage object can still be removed and the
    // pending row aborted without an ambiguous visible attachment.
    if (options.cleanupCandidate ?? true) await cleanupAttachmentCandidate(candidate);

    // The safety verdict sits strictly before confirmation. Once
    // confirmationAttempted is true nothing may abort (G5), so this is the last
    // moment at which a refusal can still be rolled back. Only an explicit clean
    // verdict for this exact file lets the confirm RPC run; the request carries
    // nothing but {kind, fileId}.
    notifyPhase(options.onPhase, 'checking');
    try {
      await requestPrivateFileInspection(client, target.kind, fileID, { writer: options.writer });
    } catch (inspectionError) {
      if (inspectionError instanceof PrivateFileError && inspectionError.code === 'rejected') {
        throw new AttachmentError(
          'upload',
          'This file was rejected by the safety check and was not attached.',
          { rejected: true },
        );
      }
      // The safety check refused this SESSION, not this file. Every retry —
      // including the durable reconciler's — fails identically until the member
      // verifies again, so it is surfaced distinctly instead of as a generic
      // interruption. The row is still left pending: neither aborted nor
      // confirmed, exactly like any other unresolved verdict.
      inspectionUnresolved = true;
      if (inspectionError instanceof PrivateFileError
        && (inspectionError.code === 'reauth-required' || inspectionError.code === 'not-authorized')) {
        throw new AttachmentError(
          'cleanup',
          'Verify it is you before this file can be checked. Nothing was attached yet.',
          { reauthRequired: true },
        );
      }
      throw new AttachmentError(
        'cleanup',
        'The upload may have completed, but confirmation was interrupted. Refresh this record before trying again.',
      );
    }

    // The verdict is in and the row is about to become visible. This is the
    // last stage the member waits through, and it is the one that can only be
    // recovered by the idempotent confirm RPC, so it is named.
    notifyPhase(options.onPhase, 'confirming');
    confirmationAttempted = true;
    let confirmation: Awaited<ReturnType<SupabaseClient['rpc']>> | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      confirmation = await (await attachmentWriteClient(options.writer)).rpc(contract.confirm, { p_file_id: fileID });
      if (!confirmation.error) break;
    }
    if (!confirmation || confirmation.error) {
      throw new AttachmentError(
        'cleanup',
        'The upload may have completed, but confirmation was interrupted. Refresh this record before trying again.',
      );
    }
    const confirmed = attachmentFromRow(target, confirmation.data, fileID);
    if (!responseConfirmedAt(confirmation.data)) {
      throw new AttachmentError(
        'cleanup',
        'The upload may have completed, but confirmation was interrupted. Refresh this record before trying again.',
      );
    }
    return confirmed;
  } catch (error) {
    // Once confirmation has been attempted its response is ambiguous: the
    // database may already have made the attachment visible. Never delete in
    // that state. The idempotent confirm RPC and the durable reconciler are
    // the recovery paths.
    const abortState = !beginMayExist
      ? 'absent'
      : confirmationAttempted || inspectionUnresolved || !client || !contract
        ? 'uncertain'
        : await abortPendingUpload(client, contract.abort, fileID, options.writer);
    // A queued checkpoint is safely hidden and service-owned, but its final
    // absence is not yet proven. Keep crash-recovery callers blocked until a
    // later exact abort receipt confirms the row and byte are gone.
    const remoteCleanupConfirmed = abortState === 'absent';
    let localCleanupConfirmed = true;
    if (options.cleanupCandidate ?? true) {
      try {
        await cleanupAttachmentCandidate(candidate);
      } catch {
        localCleanupConfirmed = false;
      }
    }
    if (abortState === 'queued' && localCleanupConfirmed
      && error instanceof AttachmentError && error.rejected) {
      // Preserve the known verdict without claiming byte deletion. The cleanup
      // code keeps durable share recovery blocked until an exact absent receipt.
      throw new AttachmentError(
        'cleanup',
        'This file was rejected by the safety check and was not attached. Its temporary upload is queued for cleanup.',
        { rejected: true },
      );
    }
    if (!remoteCleanupConfirmed || !localCleanupConfirmed) {
      // An unresolved safety verdict is not a failed cleanup: the row is
      // deliberately left pending for the reconciler, and saying so keeps the
      // member from being told bytes may have leaked.
      if (inspectionUnresolved && localCleanupConfirmed && error instanceof AttachmentError) {
        throw new AttachmentError(error.code, error.message, {
          reauthRequired: error.reauthRequired, pendingUploadID: fileID,
        });
      }
      throw new AttachmentError(
        'cleanup',
        'The upload did not complete and cleanup could not be confirmed. Refresh this record before trying again.',
        { pendingUploadID: remoteCleanupConfirmed ? undefined : fileID },
      );
    }
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError('upload', 'The attachment was not uploaded. Nothing was saved; try again.');
  }
}

export async function removeAuthorizedAttachment(target: AttachmentTarget, attachmentID: string, writer?: MobileSessionWriter): Promise<void> {
  const client = await attachmentWriteClient(writer);
  const fresh = await currentAttachment(client, target, attachmentID, writer);

  let removalID = '';
  try {
    const Crypto = await import('expo-crypto');
    removalID = Crypto.randomUUID();
  } catch {
    throw new AttachmentError('remove', 'The attachment removal could not be initialized securely. Try again.');
  }
  if (!UUID_PATTERN.test(removalID)) {
    throw new AttachmentError('remove', 'The attachment removal could not be initialized securely. Try again.');
  }
  const contract = removalContract(target, fresh.id, removalID);

  // The same caller-minted key makes a lost request response replay-safe. The
  // tombstone immediately hides both row and bytes; only the bounded trusted
  // reconciler performs physical Storage deletion and metadata retirement.
  let requested: AuthorizedAttachment | null = null;
  for (let attempt = 0; attempt < 2 && !requested; attempt += 1) {
    try {
      const result = await (await attachmentWriteClient(writer)).rpc(contract.request, contract.args);
      if (!result.error && exactRemovalReceipt(result.data, fresh.id, removalID)) return;
      if (!result.error) requested = requestedRemovalFromRow(target, result.data, fresh.id, removalID);
    } catch {
      // The response may have been lost after the tombstone committed. Replay
      // once under the same operation ID before declaring cleanup uncertain.
    }
  }
  if (!requested
    || requested.bucketID !== fresh.bucketID
    || requested.objectName !== fresh.objectName) {
    throw new AttachmentError(
      'cleanup',
      'Attachment removal may still be pending. Refresh the record before trying again.',
    );
  }
}

// No signed URL is minted for these buckets, by design: a signed URL is decided
// once and honoured until it expires, which is exactly what a later quarantine
// has to be able to revoke. The bytes are read with the member's own token so
// Storage re-evaluates the restrictive quarantine policy on every request.
export async function openAuthorizedAttachment(target: AttachmentTarget, attachmentID: string, writer?: MobileSessionWriter): Promise<void> {
  const client = await attachmentWriteClient(writer);
  const fresh = await currentAttachment(client, target, attachmentID, writer);

  let downloadedURI: string | null = null;
  try {
    const Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync())) {
      throw new AttachmentError('open', 'No secure file viewer is available on this device.');
    }
    const destination = await createOpaqueAttachmentCacheFile(fresh.filename);
    downloadedURI = destination.uri;
    if (target.kind === 'case') {
      const nativeTransport: { fetch: typeof globalThis.fetch } = await import('expo/fetch');
      const bytes = await downloadSensitiveCaseBytes(attachmentHttpClient(writer), fresh.id, mobileConfig.portalBaseUrl, nativeTransport.fetch);
      const { File } = await import('expo-file-system');
      new File(destination.uri).write(new Uint8Array(bytes));
    } else {
      await downloadPrivateObjectToFile(client, { bucketID: fresh.bucketID, objectName: fresh.objectName }, destination.uri, writer);
    }
    const ownership = writer ? await writer.check() : 'changed';
    if (ownership === 'changed') throw new AttachmentError('authorization', 'Your authorization changed.');
    if (ownership === 'unavailable') throw new AttachmentError('open', 'The attachment could not be opened securely. Try again.');
    await Sharing.shareAsync(destination.uri, {
      dialogTitle: 'Open authorized attachment',
      mimeType: fresh.mimeType,
    });
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    // A refusal from Storage for an otherwise authorized member is the
    // quarantine policy answering: the clean verdict expired or was superseded.
    // One fresh inspection can recover it, so say so instead of "try again".
    if (error instanceof Error && 'staleVerdict' in error && error.staleVerdict === true) {
      throw new AttachmentError(
        'open',
        'This file needs a fresh safety check before it can be opened.',
        { recheckable: true },
      );
    }
    throw new AttachmentError('open', 'The attachment could not be opened securely. Try again.');
  } finally {
    if (downloadedURI) await cleanupLocalURI(downloadedURI);
  }
}

/**
 * Re-establish a lapsed safety verdict for an already-confirmed attachment.
 *
 * Nothing about the object is named by the caller: the file id is re-read
 * through the member's own authorization and only {kind, fileId} is sent.
 */
export async function recheckAuthorizedAttachment(
  target: AttachmentTarget,
  attachmentID: string,
  writer?: MobileSessionWriter,
): Promise<void> {
  const client = await attachmentWriteClient(writer);
  const fresh = await currentAttachment(client, target, attachmentID, writer);
  try {
    await requestPrivateFileInspection(client, target.kind, fresh.id, { writer });
  } catch (error) {
    if (error instanceof PrivateFileError && error.code === 'rejected') {
      throw new AttachmentError(
        'open',
        'This file was rejected by the safety check and cannot be opened.',
        { rejected: true },
      );
    }
    // Not a verdict, so the member may try once more.
    throw new AttachmentError(
      'open',
      'The safety check could not be completed. Try again.',
      { recheckable: true },
    );
  }
}
