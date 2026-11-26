import { stubSessionWriter } from '../testing/stubSessionWriter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { attachmentHttpClient } from './attachmentSession';

// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699,
// part 2): form attachments on the phone through the website's paths.
type Call = [string, ...unknown[]];
const calls: Call[] = [];
const backend = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(), upload: vi.fn(), auth: { getSession: vi.fn() }, pinned: vi.fn(),
}));
const web = vi.hoisted(() => ({ upload: vi.fn(), remove: vi.fn(), download: vi.fn(), rpc: vi.fn() }));
const files = vi.hoisted(() => ({ inspect: vi.fn(), downloadObject: vi.fn(), share: vi.fn(), cleanup: vi.fn(), written: [] as unknown[] }));
vi.mock('./supabase', () => ({
  captureSessionWriter: (session: { user: { id: string } }) => stubSessionWriter(() => backend, session.user.id),
  getSupabaseClient: () => backend,
  createCapturedSessionRpcClient: (session: { user: { id: string } }) => {
    backend.pinned(session.user.id);
    return { rpc: backend.rpc, from: backend.from, storage: { from: (bucket: string) => ({ upload: (...args: unknown[]) => backend.upload(bucket, ...args) }) } };
  },
}));
vi.mock('../../../../src/lib/sensitiveContentApi.js', () => ({
  sensitiveContentRpc: web.rpc, uploadSensitiveFormFile: web.upload, removeSensitiveFormFile: web.remove, downloadSensitiveFormBytes: web.download,
}));
vi.mock('./privateFileAccess', async () => {
  class PrivateFileError extends Error {
    readonly code: string;
    constructor(code: string) { super(code); this.code = code; }
  }
  return { PrivateFileError, requestPrivateFileInspection: files.inspect, downloadPrivateObjectToFile: files.downloadObject, privateFileApiOrigin: () => 'https://sample.unionground.example' };
});
vi.mock('./attachments', () => ({
  createOpaqueAttachmentCacheFile: async () => ({ uri: 'file:///cache/opaque.pdf' }),
  cleanupLocalURI: files.cleanup,
  cleanupAttachmentCandidate: async (candidate: { uri: string }) => files.cleanup(candidate.uri),
}));
vi.mock('../lib/config', () => ({ mobileConfig: { portalBaseUrl: 'https://sample.unionground.example' } }));
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(readonly uri: string) {}
    async arrayBuffer() { return new ArrayBuffer(2048); }
    write(bytes: unknown) { files.written.push(bytes); }
  },
}));
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync: files.share }));
const nativeFetch = vi.hoisted(() => vi.fn());
vi.mock('expo/fetch', () => ({ fetch: nativeFetch }));

import { PrivateFileError } from './privateFileAccess';
import { addFormFile, finishFormFile, listFormFiles, openFormFile, recheckFormFile, removeFormFile, reviewedManifest, shareFilingCopy, type FormFile } from './formFiles';

const session = (userID: string) => ({ data: { session: { access_token: `token-${userID}`, user: { id: userID } } } });
const ordinary = { formID: 'form-1', templateKey: 'grievance', ownerID: 'user-1' };
const sealed = { formID: 'form-1', templateKey: 'fmla_self', ownerID: 'user-1' };
const candidate = { uri: 'file:///picked/provider.pdf', filename: 'provider.pdf', mimeType: 'application/pdf', sizeBytes: 2048, cacheOwned: true } as const;
// The real reply shapes (gate stage 168, r1s2): register_member_form_file
// returns the row in camelCase (20260906023000), confirm_member_form_file only
// a receipt (20260906020000), and get_form_filing_status the form's
// attachments with scanCurrent (20261003040000).
const row = (fields: Record<string, unknown> = {}) => ({
  id: 'file-1', formId: 'form-1', bucketId: 'member-form-files', objectName: 'user-1/form-1/file-1', filename: 'provider.pdf',
  mimeType: 'application/pdf', sizeBytes: 2048, confirmedAt: null, createdAt: '2026-11-14T05:00:00Z', ...fields,
});
const listed = (attachments: Record<string, unknown>[]) => ({ formId: 'form-1', status: 'draft', attachments: attachments.map((attachment) => Object.fromEntries(Object.entries(attachment).filter(([key]) => key !== 'formId'))) });
let attachmentsNow: Record<string, unknown>[] = [];

beforeEach(() => {
  calls.length = 0;
  files.written.length = 0;
  for (const mock of [backend.rpc, backend.from, backend.upload, backend.pinned, web.upload, web.remove, web.download, files.inspect, files.downloadObject, files.share, files.cleanup]) mock.mockReset();
  backend.auth.getSession.mockResolvedValue(session('user-1'));
  attachmentsNow = [row({ confirmedAt: '2026-11-14T05:01:00Z', scanCurrent: true })];
  backend.rpc.mockImplementation(async (name: string, args: unknown) => {
    calls.push(['rpc', name, args]);
    if (name === 'register_member_form_file') return { data: row(), error: null };
    if (name === 'confirm_member_form_file') return { data: { id: 'file-1', confirmedAt: '2026-11-14T05:01:00Z' }, error: null };
    if (name === 'get_form_filing_status') return { data: listed(attachmentsNow), error: null };
    return { data: null, error: { message: `unexpected ${name}` } };
  });
  backend.upload.mockImplementation(async (...args: unknown[]) => { calls.push(['storage', ...args.slice(0, 2)]); return { error: null }; });
  web.upload.mockImplementation(async (_client: unknown, fileID: string) => { calls.push(['sealed-upload', fileID]); return { error: null }; });
  web.remove.mockImplementation(async (_client: unknown, fileID: string) => { calls.push(['remove', fileID]); return { id: fileID, deleted: true }; });
  files.inspect.mockImplementation(async (_client: unknown, kind: string, fileID: string) => { calls.push(['inspect', kind, fileID]); return { fileID, status: 'clean' }; });
  files.cleanup.mockResolvedValue(undefined);
});

describe('adding a form attachment', () => {
  it('registers, uploads to Storage under the worker’s session, checks, then confirms an ordinary form’s file', async () => {
    const phases: string[] = [];
    expect(await addFormFile(ordinary, candidate, (phase) => phases.push(phase))).toMatchObject({ id: 'file-1', confirmed: true });
    expect(calls).toEqual([
      ['rpc', 'register_member_form_file', { p_form_id: 'form-1', p_filename: 'provider.pdf', p_mime_type: 'application/pdf', p_size_bytes: 2048 }],
      ['storage', 'member-form-files', 'user-1/form-1/file-1'],
      ['inspect', 'form', 'file-1'],
      ['rpc', 'confirm_member_form_file', { p_file_id: 'file-1' }],
      ['rpc', 'get_form_filing_status', { p_form_id: 'form-1' }],
    ]);
    expect(phases).toEqual(['uploading', 'checking', 'confirming']);
    expect(backend.pinned).toHaveBeenCalledWith('user-1');
    // The picked copy is deleted once its bytes are sent.
    expect(files.cleanup).toHaveBeenCalledWith('file:///picked/provider.pdf');
  });

  it('sends a sealed form’s bytes only through the sensitive form files route, never to Storage', async () => {
    await addFormFile(sealed, candidate);
    expect(calls.map((call) => call[0] === 'rpc' ? call[1] : call[0])).toEqual(['register_member_form_file', 'sealed-upload', 'inspect', 'confirm_member_form_file', 'get_form_filing_status']);
    const uploadClient: ReturnType<typeof attachmentHttpClient> = web.upload.mock.calls[0]![0];
    expect(await uploadClient.auth.getSession()).toEqual({ ...session('user-1'), error: null });
    expect(web.upload).toHaveBeenCalledWith(uploadClient, 'file-1', expect.objectContaining({ size: 2048 }), 'https://sample.unionground.example');
    expect(backend.upload).not.toHaveBeenCalled();
  });

  it('removes a file the safety check rejects, and confirms nothing', async () => {
    files.inspect.mockRejectedValue(new PrivateFileError('rejected'));
    await expect(addFormFile(ordinary, candidate)).rejects.toMatchObject({ reason: 'rejected' });
    expect(calls).toContainEqual(['remove', 'file-1']);
    expect(calls.some((call) => call[1] === 'confirm_member_form_file')).toBe(false);
  });

  it('leaves an unfinished check pending without removing the bytes, and Retry finishes it', async () => {
    files.inspect.mockRejectedValueOnce(new PrivateFileError('unavailable'));
    await expect(addFormFile(ordinary, candidate)).rejects.toMatchObject({ reason: 'pending' });
    expect(web.remove).not.toHaveBeenCalled();
    calls.length = 0;
    expect(await finishFormFile(ordinary, 'file-1')).toMatchObject({ id: 'file-1', confirmed: true, filename: 'provider.pdf' });
    expect(calls.map((call) => call[0] === 'rpc' ? call[1] : call[0])).toEqual(['inspect', 'confirm_member_form_file', 'get_form_filing_status']);
  });

  // Gate stage 168 (r1s2): the confirmation's reply is a receipt, not a row.
  it('treats confirm_member_form_file’s receipt as success, and anything else as still pending', async () => {
    expect(await addFormFile(ordinary, candidate)).toMatchObject({ id: 'file-1', confirmed: true });
    // The list read failing afterwards does not undo a committed confirmation.
    attachmentsNow = [];
    expect(await finishFormFile(ordinary, 'file-1')).toMatchObject({ id: 'file-1', confirmed: true });
    backend.rpc.mockImplementation(async (name: string) => (name === 'confirm_member_form_file' ? { data: { id: 'file-9', confirmedAt: '2026-11-14T05:01:00Z' }, error: null } : { data: null, error: null }));
    await expect(finishFormFile(ordinary, 'file-1')).rejects.toMatchObject({ reason: 'pending' });
    backend.rpc.mockImplementation(async (name: string) => (name === 'confirm_member_form_file' ? { data: { id: 'file-1', confirmedAt: null }, error: null } : { data: null, error: null }));
    await expect(finishFormFile(ordinary, 'file-1')).rejects.toMatchObject({ reason: 'pending' });
  });

  // Gate stage 168 (r1s3): a refused registration still deletes the picked
  // copy, so sign-out is not blocked by it.
  it('deletes the picked copy when the registration is refused, or the worker changed first', async () => {
    backend.rpc.mockImplementation(async () => ({ data: null, error: { message: 'a form can hold at most 20 attachments' } }));
    await expect(addFormFile(ordinary, candidate)).rejects.toMatchObject({ reason: 'failed' });
    expect(files.cleanup).toHaveBeenCalledWith('file:///picked/provider.pdf');
    files.cleanup.mockClear();
    backend.auth.getSession.mockResolvedValue(session('user-2'));
    await expect(addFormFile(ordinary, candidate)).rejects.toMatchObject({ reason: 'session-changed' });
    expect(files.cleanup).toHaveBeenCalledWith('file:///picked/provider.pdf');
  });

  it('removes the registration when the upload fails', async () => {
    backend.upload.mockResolvedValue({ error: { message: 'storage refused' } });
    await expect(addFormFile(ordinary, candidate)).rejects.toMatchObject({ reason: 'failed' });
    expect(calls).toContainEqual(['remove', 'file-1']);
    expect(files.inspect).not.toHaveBeenCalled();
  });

  it('stops when another worker signs in, before any bytes are sent', async () => {
    backend.rpc.mockImplementation(async (name: string) => {
      backend.auth.getSession.mockResolvedValue(session('user-2'));
      return { data: name === 'register_member_form_file' ? row() : null, error: null };
    });
    await expect(addFormFile(ordinary, candidate)).rejects.toMatchObject({ reason: 'session-changed' });
    expect(backend.upload).not.toHaveBeenCalled();
    expect(web.upload).not.toHaveBeenCalled();
  });
});

describe('reading, opening and removing', () => {
  it('lists the form’s files from its filing status, pending ones and lapsed checks included, on the worker’s session', async () => {
    attachmentsNow = [row({ scanCurrent: true }), row({ id: 'file-2', confirmedAt: '2026-11-14T05:01:00Z', scanCurrent: false })];
    const files = await listFormFiles(ordinary);
    expect(files.map((file) => [file.id, file.confirmed, file.scanCurrent])).toEqual([['file-1', false, true], ['file-2', true, false]]);
    expect(calls).toEqual([['rpc', 'get_form_filing_status', { p_form_id: 'form-1' }]]);
    expect(backend.pinned).toHaveBeenCalledWith('user-1');
    backend.rpc.mockImplementation(async () => ({ data: { formId: 'form-other', attachments: [] }, error: null }));
    await expect(listFormFiles(ordinary)).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('re-checks a confirmed file whose safety verdict lapsed', async () => {
    await recheckFormFile(ordinary, 'file-1');
    expect(calls).toEqual([['inspect', 'form', 'file-1']]);
    files.inspect.mockRejectedValue(new PrivateFileError('rejected'));
    await expect(recheckFormFile(ordinary, 'file-1')).rejects.toMatchObject({ reason: 'rejected' });
  });

  it('opens a sealed file through the sensitive route and says when it needs a fresh check', async () => {
    const file: FormFile = { id: 'file-1', formID: 'form-1', bucketID: 'member-form-files', objectName: 'x', filename: 'provider.pdf', mimeType: 'application/pdf', sizeBytes: 2048, confirmed: true, createdAt: '', scanCurrent: true };
    web.download.mockResolvedValue(new ArrayBuffer(4));
    await openFormFile(sealed, file);
    const downloadClient: ReturnType<typeof attachmentHttpClient> = web.download.mock.calls[0]![0];
    expect(await downloadClient.auth.getSession()).toEqual({ ...session('user-1'), error: null });
    expect(web.download).toHaveBeenCalledWith(downloadClient, 'file-1', 'https://sample.unionground.example', expect.any(Function));
    expect(files.share).toHaveBeenCalledWith('file:///cache/opaque.pdf', { mimeType: 'application/pdf' });
    expect(files.cleanup).toHaveBeenCalledWith('file:///cache/opaque.pdf');
    web.download.mockRejectedValue(Object.assign(new Error('sensitive-document-read-unavailable'), { staleVerdict: true }));
    await expect(openFormFile(sealed, file)).rejects.toMatchObject({ reason: 'stale' });
    await openFormFile(ordinary, file);
    expect(files.downloadObject).toHaveBeenCalledWith(backend, { bucketID: 'member-form-files', objectName: 'x' }, 'file:///cache/opaque.pdf', expect.objectContaining({ userId: 'user-1' }));
  });

  it('removes through the server and asks for step-up when the session is restricted', async () => {
    await removeFormFile(ordinary, 'file-1');
    const removalClient: ReturnType<typeof attachmentHttpClient> = web.remove.mock.calls[0]![0];
    expect(await removalClient.auth.getSession()).toEqual({ ...session('user-1'), error: null });
    expect(web.remove).toHaveBeenCalledWith(removalClient, 'file-1', 'https://sample.unionground.example');
    web.remove.mockRejectedValue(new Error('step-up-required'));
    await expect(removeFormFile(ordinary, 'file-1')).rejects.toMatchObject({ reason: 'step-up' });
  });

  it('names the confirmed files, by id, as the reviewed manifest', () => {
    const file = (id: string, confirmed: boolean) => ({ id, filename: `${id}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, confirmed, formID: 'form-1', bucketID: 'b', objectName: 'o', createdAt: '', scanCurrent: true });
    expect(reviewedManifest([file('c', true), file('a', true), file('b', false)])).toEqual([
      { id: 'a', filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
      { id: 'c', filename: 'c.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
    ]);
  });
});

describe('the official filing copy', () => {
  const pdf = (status = 200, type = 'application/pdf', body: unknown = null) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => new ArrayBuffer(8),
    json: async () => body,
  });

  it('fetches it with the worker’s own token in their language, shares it from the protected cache and deletes it', async () => {
    nativeFetch.mockResolvedValue(pdf());
    await shareFilingCopy('form-1', 'user-1', 'es');
    expect(nativeFetch).toHaveBeenCalledWith('https://sample.unionground.example/api/form-filing?formId=form-1&lang=es', expect.objectContaining({ headers: { Authorization: 'Bearer token-user-1' } }));
    expect(files.share).toHaveBeenCalledWith('file:///cache/opaque.pdf', { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
    expect(files.written).toHaveLength(1);
    expect(files.cleanup).toHaveBeenCalledWith('file:///cache/opaque.pdf');
  });

  // Gate stage 168 (r1s1): a sign-out or account switch while the body is
  // still arriving writes and shares nothing, and the copy is deleted.
  it('writes and shares nothing when the worker changed while the PDF body was on its way', async () => {
    nativeFetch.mockResolvedValue({ ...pdf(), arrayBuffer: async () => { backend.auth.getSession.mockResolvedValue(session('user-2')); return new ArrayBuffer(8); } });
    await expect(shareFilingCopy('form-1', 'user-1', 'en')).rejects.toMatchObject({ reason: 'session-changed' });
    expect(files.written).toHaveLength(0);
    expect(files.share).not.toHaveBeenCalled();
    expect(files.cleanup).toHaveBeenCalledWith('file:///cache/opaque.pdf');
  });

  it('shares no opened attachment when the worker changed while its bytes were on their way', async () => {
    const file: FormFile = { id: 'file-1', formID: 'form-1', bucketID: 'member-form-files', objectName: 'x', filename: 'provider.pdf', mimeType: 'application/pdf', sizeBytes: 2048, confirmed: true, createdAt: '', scanCurrent: true };
    files.downloadObject.mockImplementation(async () => { backend.auth.getSession.mockResolvedValue(session('user-2')); });
    await expect(openFormFile(ordinary, file)).rejects.toMatchObject({ reason: 'session-changed' });
    expect(files.share).not.toHaveBeenCalled();
    expect(files.cleanup).toHaveBeenCalledWith('file:///cache/opaque.pdf');
  });

  it('asks a restricted session to step up, and refuses anything that is not a PDF', async () => {
    nativeFetch.mockResolvedValue(pdf(403, 'application/json', { error: 'step-up-required' }));
    await expect(shareFilingCopy('form-1', 'user-1', 'en')).rejects.toMatchObject({ reason: 'step-up' });
    nativeFetch.mockResolvedValue(pdf(200, 'text/html'));
    await expect(shareFilingCopy('form-1', 'user-1', 'en')).rejects.toMatchObject({ reason: 'unavailable' });
    nativeFetch.mockResolvedValue(pdf(404));
    await expect(shareFilingCopy('form-1', 'user-1', 'en')).rejects.toMatchObject({ reason: 'unavailable' });
    expect(files.share).not.toHaveBeenCalled();
  });
});
