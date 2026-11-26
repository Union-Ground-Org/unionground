// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699,
// part 2): a member's form attachments on the phone, through the website's own
// paths (src/lib/memberApi.js addMemberFormFile, removeMemberFormFile,
// memberFormFileBlob). register_member_form_file names the file; an ordinary
// form's bytes go to Storage under the member's session, a sealed FMLA form's
// through /api/sensitive-form-files, where the server encrypts them; the
// private-file safety check runs before confirm_member_form_file makes the file
// count. Removal is the server's (#8569). Every step runs for the member the
// editor belongs to and stops when another signs in.
// The server's refusal for a session that needs a step-up first (the shared
// contract's string; this edition has no PIN sessions, so it is rare).
const STEP_UP_ERROR = 'step-up-required';
import {
  downloadSensitiveFormBytes as webDownloadSensitiveFormBytes,
  removeSensitiveFormFile as webRemoveSensitiveFormFile,
  uploadSensitiveFormFile as webUploadSensitiveFormFile,
} from '../../../../src/lib/sensitiveContentApi.js';
import type { AttachmentCandidate } from './attachments';
import { formIsSealed, pinMemberSession, type FormAttachment } from './memberForms';
import { attachmentHttpClient } from './attachmentSession';
import { captureSessionWriter, createCapturedSessionRpcClient, getSupabaseClient } from './supabase';

type Row = Record<string, unknown>;
type Transport = { data?: unknown; error?: unknown };
const uploadSensitiveFormFile = webUploadSensitiveFormFile as (client: unknown, fileId: string, file: { size: number; arrayBuffer: () => Promise<ArrayBuffer> }, origin: string) => Promise<Transport>;
const removeSensitiveFormFile = webRemoveSensitiveFormFile as (client: unknown, fileId: string, origin: string) => Promise<{ id: string; deleted: true }>;
const downloadSensitiveFormBytes = webDownloadSensitiveFormBytes as (client: unknown, fileId: string, origin: string, fetcher: typeof globalThis.fetch) => Promise<ArrayBuffer>;

// One form attachment as the filing step shows it.
// scanCurrent: false when a confirmed file's clean verdict has lapsed, so it
// must be checked again before it opens or the form can be submitted.
export type FormFile = FormAttachment & { formID: string; bucketID: string; objectName: string; createdAt: string; scanCurrent: boolean };
export type FormFileTarget = { formID: string; templateKey: string; ownerID: string };
export type FormFilePhase = 'uploading' | 'checking' | 'confirming';

export class FormFileError extends Error {
  // A fixed reason the screen words; never a server message or a file name.
  // 'pending': the bytes are uploaded but the check or confirmation did not
  // finish, so the file stays "Upload pending" and Retry finishes it.
  // 'stale': the file needs a fresh safety check before it can be opened.
  // 'step-up': a restricted session must verify again first.
  readonly reason: 'rejected' | 'pending' | 'stale' | 'step-up' | 'session-changed' | 'unavailable' | 'failed';
  constructor(reason: FormFileError['reason']) {
    super(reason);
    this.reason = reason;
  }
}

// The portal the sealed file route lives on, read on use as memberForms does,
// so reading the form list never loads the build configuration.
async function portal(): Promise<string> {
  return (await import('../lib/config')).mobileConfig.portalBaseUrl;
}

// The attachment cache helpers and the private-file transport, loaded on use:
// their modules read the build configuration, which listing forms never does.
async function cache() {
  return import('./attachments');
}

async function privateFiles() {
  return import('./privateFileAccess');
}

function client() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new FormFileError('unavailable');
  return supabase;
}

// A full attachment row: register_member_form_file's reply, or an entry of
// get_form_filing_status's attachments, which are the form's own and carry no
// form id (named = false).
function fileFrom(value: unknown, formID: string, named = true): FormFile {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
  const id = typeof row.id === 'string' ? row.id : '';
  if (!id || (named && String(row.form_id ?? row.formId ?? '') !== formID)) throw new FormFileError('failed');
  return {
    id,
    formID,
    bucketID: String(row.bucket_id ?? row.bucketId ?? ''),
    objectName: String(row.object_name ?? row.objectName ?? ''),
    filename: String(row.filename ?? ''),
    mimeType: String(row.mime_type ?? row.mimeType ?? ''),
    sizeBytes: Number(row.size_bytes ?? row.sizeBytes ?? 0),
    confirmed: typeof (row.confirmed_at ?? row.confirmedAt) === 'string' && (row.confirmed_at ?? row.confirmedAt) !== '',
    createdAt: String(row.created_at ?? row.createdAt ?? ''),
    scanCurrent: row.scanCurrent !== false,
  };
}

function stepUpOr(error: unknown, otherwise: FormFileError['reason']): FormFileError {
  if (error instanceof FormFileError) return error;
  if (error instanceof Error && error.message === STEP_UP_ERROR) return new FormFileError('step-up');
  if (error instanceof Error && error.message === 'session-changed') return new FormFileError('session-changed');
  return new FormFileError(otherwise);
}

async function pinned(ownerID: string) {
  try {
    const pinned = await pinMemberSession(ownerID);
    return { ...pinned, writer: captureSessionWriter(pinned.session.session) };
  } catch {
    throw new FormFileError('session-changed');
  }
}

async function fenced(fence: () => Promise<void>): Promise<void> {
  try {
    await fence();
  } catch {
    throw new FormFileError('session-changed');
  }
}

// The form's attachments, uploads still pending included, oldest first, read
// from get_form_filing_status as the website's filing step reads them, so a
// confirmed file whose safety verdict lapsed is known (scanCurrent false).
export async function listFormFiles(target: FormFileTarget): Promise<FormFile[]> {
  const { session, fence } = await pinned(target.ownerID);
  const result: { data: unknown; error: unknown } = await createCapturedSessionRpcClient(session.session).rpc('get_form_filing_status', { p_form_id: target.formID });
  await fenced(fence);
  const status = !result.error && result.data && typeof result.data === 'object' ? result.data as Row : null;
  if (!status || status.formId !== target.formID || !Array.isArray(status.attachments)) throw new FormFileError('unavailable');
  return (status.attachments as unknown[]).map((row) => fileFrom(row, target.formID, false));
}

// The safety check, then the confirmation that makes the file count. A
// rejected file is removed; anything short of a verdict leaves it pending.
async function inspectAndConfirm(target: FormFileTarget, fileID: string, onPhase?: (phase: FormFilePhase) => void, known?: FormFile): Promise<FormFile> {
  const { session, fence, writer } = await pinned(target.ownerID);
  onPhase?.('checking');
  try {
    await (await privateFiles()).requestPrivateFileInspection(client(), 'form', fileID, { writer });
  } catch (error) {
    await fenced(fence);
    if (error instanceof (await privateFiles()).PrivateFileError && error.code === 'rejected') {
      await removeSensitiveFormFile(attachmentHttpClient(writer), fileID, await portal()).catch(() => null); // swallow-ok: a refused file keeps its removal mark, and Remove finishes it
      throw new FormFileError('rejected');
    }
    throw new FormFileError('pending');
  }
  await fenced(fence);
  onPhase?.('confirming');
  // Confirmation may have committed when its reply is lost, so it is asked
  // once more and never undone (the website's rule). Its reply is a receipt,
  // {id, confirmedAt}, not a file row (gate stage 168, r1s2); the file is then
  // read back from the form's list.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const confirmed: { data: unknown; error: unknown } = await createCapturedSessionRpcClient(session.session).rpc('confirm_member_form_file', { p_file_id: fileID });
    await fenced(fence);
    const receipt = !confirmed.error && confirmed.data && typeof confirmed.data === 'object' ? confirmed.data as Row : null;
    if (receipt?.id === fileID && typeof receipt.confirmedAt === 'string' && receipt.confirmedAt) {
      const stored = await listFormFiles(target).then((files) => files.find((file) => file.id === fileID), () => undefined); // swallow-ok: the file is confirmed; the screen reads the list again either way
      return stored ?? { ...(known ?? { id: fileID, formID: target.formID, bucketID: '', objectName: '', filename: '', mimeType: '', sizeBytes: 0, createdAt: '', scanCurrent: true }), confirmed: true };
    }
  }
  throw new FormFileError('pending');
}

// Adds a picked or scanned file to the form. The candidate was already
// checked on the phone (type, size, name) by the attachment picker.
export async function addFormFile(target: FormFileTarget, candidate: AttachmentCandidate, onPhase?: (phase: FormFilePhase) => void): Promise<FormFile> {
  // The picked copy is the app's own and is deleted however the add ends, a
  // refused registration included, or sign-out stays blocked on it (gate
  // stage 168, r1s3). The sign-out purge empties the cache if this fails.
  try {
    return await addPickedFile(target, candidate, onPhase);
  } finally {
    await (await cache()).cleanupAttachmentCandidate(candidate).catch(() => null); // swallow-ok: the attachment cache is purged on sign-out
  }
}

async function addPickedFile(target: FormFileTarget, candidate: AttachmentCandidate, onPhase?: (phase: FormFilePhase) => void): Promise<FormFile> {
  const { session, fence, writer } = await pinned(target.ownerID);
  const registered: { data: unknown; error: unknown } = await createCapturedSessionRpcClient(session.session).rpc('register_member_form_file', {
    p_form_id: target.formID, p_filename: candidate.filename, p_mime_type: candidate.mimeType, p_size_bytes: candidate.sizeBytes,
  });
  await fenced(fence);
  if (registered.error) throw new FormFileError('failed');
  const row = fileFrom(registered.data, target.formID);
  onPhase?.('uploading');
  let uploaded = false;
  try {
    const { File } = await import('expo-file-system');
    const local = new File(candidate.uri);
    const bytes = await local.arrayBuffer();
    if (bytes.byteLength !== candidate.sizeBytes) throw new FormFileError('failed');
    await fenced(fence);
    const upload: Transport = formIsSealed(target.templateKey)
      ? await uploadSensitiveFormFile(attachmentHttpClient(writer), row.id, { size: bytes.byteLength, arrayBuffer: async () => bytes }, await portal())
        .catch((cause: unknown) => ({ error: cause }))
      : await createCapturedSessionRpcClient(session.session).storage.from(row.bucketID).upload(row.objectName, bytes, { contentType: row.mimeType, upsert: false });
    uploaded = !upload.error;
  } catch (error) {
    if (error instanceof FormFileError && error.reason === 'session-changed') throw error;
  }
  await fenced(fence);
  if (!uploaded) {
    // Nothing usable was stored: the registration is removed, as on the
    // website. A removal that fails leaves its mark, and Remove finishes it.
    await removeSensitiveFormFile(attachmentHttpClient(writer), row.id, await portal()).catch(() => null); // swallow-ok: the removal mark stays and Remove finishes it
    throw new FormFileError('failed');
  }
  return inspectAndConfirm(target, row.id, onPhase, row);
}

// Finishes a pending upload: its check and confirmation only, never its bytes.
export async function finishFormFile(target: FormFileTarget, fileID: string, onPhase?: (phase: FormFilePhase) => void): Promise<FormFile> {
  return inspectAndConfirm(target, fileID, onPhase);
}

// The server removes the file and its bytes, confirmed or not (#8569).
export async function removeFormFile(target: FormFileTarget, fileID: string): Promise<void> {
  const { fence, writer } = await pinned(target.ownerID);
  try {
    await removeSensitiveFormFile(attachmentHttpClient(writer), fileID, await portal());
  } catch (error) {
    throw stepUpOr(error, 'failed');
  }
  await fenced(fence);
}

// A fresh safety check for a confirmed file whose verdict lapsed.
export async function recheckFormFile(target: FormFileTarget, fileID: string): Promise<void> {
  const { fence, writer } = await pinned(target.ownerID);
  try {
    await (await privateFiles()).requestPrivateFileInspection(client(), 'form', fileID, { writer });
  } catch (error) {
    await fenced(fence);
    throw new FormFileError(error instanceof (await privateFiles()).PrivateFileError && error.code === 'rejected' ? 'rejected' : 'unavailable');
  }
  await fenced(fence);
}

// Opens a file in the device's viewer from the protected cache, which is
// emptied afterwards and on sign-out. Bytes are read with the member's own
// token on every open, so a later quarantine still applies.
export async function openFormFile(target: FormFileTarget, file: FormFile): Promise<void> {
  const { fence, writer } = await pinned(target.ownerID);
  let uri: string | null = null;
  try {
    const Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync())) throw new FormFileError('unavailable');
    const destination = await (await cache()).createOpaqueAttachmentCacheFile(file.filename);
    uri = destination.uri;
    if (formIsSealed(target.templateKey)) {
      const nativeTransport: { fetch: typeof globalThis.fetch } = await import('expo/fetch');
      const bytes = await downloadSensitiveFormBytes(attachmentHttpClient(writer), file.id, await portal(), nativeTransport.fetch);
      await fenced(fence);
      const { File } = await import('expo-file-system');
      new File(destination.uri).write(new Uint8Array(bytes));
    } else {
      await (await privateFiles()).downloadPrivateObjectToFile(client(), { bucketID: file.bucketID, objectName: file.objectName }, destination.uri, writer);
    }
    // Nothing is shared once another member signed in or the session ended
    // while the bytes were on their way; the copy is deleted below.
    await fenced(fence);
    await Sharing.shareAsync(destination.uri, { mimeType: file.mimeType });
  } catch (error) {
    if (error instanceof Error && 'staleVerdict' in error && error.staleVerdict === true) throw new FormFileError('stale');
    throw stepUpOr(error, 'unavailable');
  } finally {
    if (uri) await (await cache()).cleanupLocalURI(uri).catch(() => null); // swallow-ok: a copy left behind is purged with the attachment cache on sign-out
  }
}

// The official filing copy of an approved form (GET /api/form-filing, as the
// website's downloadFormFiling), in the member's language. It is written to the
// protected cache, handed to the device's share sheet and deleted after. A
// restricted session is asked to step up; nothing else from the server is
// shown to the member.
const FILING_TIMEOUT_MS = 15000;

export async function shareFilingCopy(formID: string, ownerID: string, language: 'en' | 'es'): Promise<void> {
  const { session, fence } = await pinned(ownerID);
  let uri: string | null = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FILING_TIMEOUT_MS);
  try {
    const Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync())) throw new FormFileError('unavailable');
    // The cache file is made before the download, so sign-out waits for it
    // and the copy is deleted however the download ends (gate stage 168, r1s1).
    const destination = await (await cache()).createOpaqueAttachmentCacheFile(`union-ground-filing-${formID}.pdf`);
    uri = destination.uri;
    const nativeTransport: { fetch: typeof globalThis.fetch } = await import('expo/fetch');
    const response = await nativeTransport.fetch(`${await portal()}/api/form-filing?formId=${encodeURIComponent(formID)}&lang=${language === 'es' ? 'es' : 'en'}`, {
      headers: { Authorization: `Bearer ${session.token}` },
      signal: controller.signal,
    });
    await fenced(fence);
    if (response.status === 403) {
      const body: unknown = await response.json().catch(() => null); // swallow-ok: a refusal without a JSON body is not a step-up, and is shown as unavailable
      throw new FormFileError(body && typeof body === 'object' && (body as Row).error === STEP_UP_ERROR ? 'step-up' : 'unavailable');
    }
    if (!response.ok || !String(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/pdf')) throw new FormFileError('unavailable');
    const bytes = await response.arrayBuffer();
    // The member is checked again once the body is in, before anything is
    // written, and again before the share sheet opens.
    await fenced(fence);
    const { File } = await import('expo-file-system');
    new File(destination.uri).write(new Uint8Array(bytes));
    await fenced(fence);
    await Sharing.shareAsync(destination.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
  } catch (error) {
    throw stepUpOr(error, 'unavailable');
  } finally {
    clearTimeout(timeout);
    if (uri) await (await cache()).cleanupLocalURI(uri).catch(() => null); // swallow-ok: a copy left behind is purged with the attachment cache on sign-out
  }
}

// The reviewed manifest a signature names: the confirmed files, in the
// signature digest's order (by id) and shape (#8702).
export function reviewedManifest(files: readonly FormFile[]): { id: string; filename: string; mimeType: string; sizeBytes: number }[] {
  return files.filter((file) => file.confirmed)
    .map(({ id, filename, mimeType, sizeBytes }) => ({ id, filename, mimeType, sizeBytes }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
