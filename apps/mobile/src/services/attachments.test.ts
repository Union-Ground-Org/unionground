import { stubSessionWriter } from '../testing/stubSessionWriter';
import { getSupabaseClient } from './supabase';
import { inspectPrivateFileBytes } from '../../../../api/_lib/privateFileSafety.js';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: null as Record<string, unknown> | null,
  files: new Map<string, { bytes: Uint8Array; exists: boolean; deleteFails?: boolean; deleteEvent?: string }>(),
  directories: new Set<string>(),
  events: [] as string[],
  shareAsync: vi.fn(),
  pendingCameraResult: vi.fn(),
  cryptoUUID: vi.fn(),
  manipulate: vi.fn(),
  fetchImpl: vi.fn(),
  inspection: null as null | { status: number; body?: unknown; headers?: Record<string, string> },
  downloadStatus: 200,
  requests: [] as Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>,
  wholeFileReads: [] as string[],
  handleReads: [] as Array<{ uri: string; mode: string | null; lengths: number[]; closed?: boolean }>,
  copyFails: false,
}));

// Every client literal in this file predates the inspection contract, so the
// session read is filled in here rather than in twenty places. Tests that care
// about the bearer assert on mocks.requests instead.
vi.mock('./supabase', () => ({
  verifyCapturedMobileSession: (session: { access_token: string }) => (mocks.client?.auth as { getUser: (token: string) => unknown }).getUser(session.access_token),
  getSupabaseClient: () => {
    const client = mocks.client;
    const auth = client?.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth === 'object' && !('getSession' in auth)) {
      auth.getSession = async () => ({
        data: { session: { access_token: 'member-access-token' } },
        error: null,
      });
    }
    return client;
  },
}));

// The real SAMPLE pair: private-file inspection refuses any other backend.
vi.mock('../lib/config', () => ({
  mobileConfig: {
    supabaseUrl: 'https://unionground-sample.supabase.co',
    supabasePublishableKey: 'sb_publishable_test-key',
    portalBaseUrl: 'https://sample.unionground.example',
    compassNetworkEnabled: true,
    previewEnabled: false,
    backendConfigured: true,
  },
}));

vi.mock('expo-file-system', () => {
  class MockFile {
    uri: string;

    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => typeof part === 'string' ? part : part.uri).join('/').replace('file:///cache/', 'file:///cache/');
    }

    get exists() { return mocks.files.get(this.uri)?.exists ?? false; }
    get size() { return mocks.files.get(this.uri)?.bytes.byteLength ?? 0; }
    delete() {
      const record = mocks.files.get(this.uri);
      if (record?.deleteEvent) mocks.events.push(record.deleteEvent);
      if (record && !record.deleteFails) record.exists = false;
    }
    async move(destination: MockFile) {
      const record = mocks.files.get(this.uri);
      if (!record?.exists) throw new Error('source missing');
      mocks.files.set(destination.uri, { ...record, exists: true });
      record.exists = false;
      this.uri = destination.uri;
    }

    // The native copy leaves the source in place, which is the whole point of
    // the staged duplicate: the member keeps their selection while the upload
    // consumes and deletes a copy of it. Flags already registered against the
    // destination path survive, so a test can arm its deletion behaviour.
    async copy(destination: MockFile) {
      const record = mocks.files.get(this.uri);
      if (!record?.exists) throw new Error('source missing');
      if (mocks.copyFails) throw new Error('copy failed');
      mocks.events.push('copy-staged');
      mocks.files.set(destination.uri, {
        ...mocks.files.get(destination.uri),
        bytes: new Uint8Array(record.bytes),
        exists: true,
      });
    }
    async arrayBuffer() {
      const bytes = mocks.files.get(this.uri)?.bytes ?? new Uint8Array();
      mocks.wholeFileReads.push(this.uri);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    // A bounded read handle, like the native one: `readBytes(n)` advances a
    // cursor and never materialises the rest of the file. The test records
    // every length asked for, so a probe that quietly grew back into a
    // whole-file read fails here.
    open(mode?: string) {
      const record = mocks.files.get(this.uri);
      if (!record?.exists) throw new Error('file missing');
      let offset = 0;
      let closed = false;
      const entry = { uri: this.uri, mode: mode ?? null, lengths: [] as number[], closed: false };
      mocks.handleReads.push(entry);
      return {
        readBytes: (length: number) => {
          if (closed) throw new Error('handle closed');
          entry.lengths.push(length);
          const slice = record.bytes.subarray(offset, offset + length);
          offset += slice.byteLength;
          return new Uint8Array(slice);
        },
        close: () => { closed = true; entry.closed = true; },
      };
    }

    create() {
      mocks.files.set(this.uri, { ...mocks.files.get(this.uri), bytes: new Uint8Array(), exists: true });
    }

    write(content: Uint8Array) {
      mocks.files.set(this.uri, {
        ...mocks.files.get(this.uri),
        bytes: new Uint8Array(content),
        exists: true,
      });
    }

    static async downloadFileAsync() {
      // Nothing may reach the header-less downloader: attachment bytes are read
      // with the member's own bearer through privateFileAccess.
      throw new Error('File.downloadFileAsync must not be used for private objects');
    }
  }

  class MockDirectory {
    uri: string;

    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => typeof part === 'string' ? part : part.uri).join('/').replace('file:///cache/', 'file:///cache/');
    }

    get exists() { return mocks.directories.has(this.uri); }
    create() { mocks.directories.add(this.uri); }
    list() {
      const prefix = `${this.uri}/`;
      return [...mocks.files.entries()]
        .filter(([uri, record]) => record.exists && uri.startsWith(prefix) && !uri.slice(prefix.length).includes('/'))
        .map(([uri]) => new MockFile(uri));
    }
  }

  return {
    Directory: MockDirectory,
    File: MockFile,
    FileMode: { ReadWrite: 'rw', ReadOnly: 'r', Write: 'w', Append: 'a' },
    Paths: { cache: { uri: 'file:///cache' } },
  };
});

vi.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mocks.fetchImpl(...args) }));
vi.mock('expo-crypto', () => ({ randomUUID: mocks.cryptoUUID }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync: mocks.shareAsync }));
vi.mock('expo-image-picker', () => ({ getPendingResultAsync: mocks.pendingCameraResult }));
vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: mocks.manipulate },
  SaveFormat: { JPEG: 'jpeg' },
}));

import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  AttachmentError,
  cleanupAttachmentCandidate,
  copyStagedAttachmentCandidate,
  discardInterruptedCameraCapture,
  openAuthorizedAttachment as rawopenAuthorizedAttachment,
  pickAuthorizedDocument,
  readStagedTextPreview,
  recheckAuthorizedAttachment as rawrecheckAuthorizedAttachment,
  reconcileAuthorizedAttachmentUpload as rawreconcileAuthorizedAttachmentUpload,
  removeAuthorizedAttachment as rawremoveAuthorizedAttachment,
  uploadAuthorizedAttachment as rawuploadAuthorizedAttachment,
  validateAttachmentCandidate,
} from './attachments';
import * as attachmentService from './attachments';

// Protocol fixtures use an explicit writer; the real Auth lock matrix lives
// in attachmentWriters.session.test.ts. Existing policy assertions stay intact.
const uploadAuthorizedAttachment: typeof rawuploadAuthorizedAttachment = (target, candidate, options = {}) => rawuploadAuthorizedAttachment(target, candidate, { ...options, writer: stubSessionWriter(getSupabaseClient) });
const reconcileAuthorizedAttachmentUpload: typeof rawreconcileAuthorizedAttachmentUpload = (target, id, options = {}) => rawreconcileAuthorizedAttachmentUpload(target, id, { ...options, writer: stubSessionWriter(getSupabaseClient) });
const openAuthorizedAttachment: typeof rawopenAuthorizedAttachment = (target, id) => rawopenAuthorizedAttachment(target, id, stubSessionWriter(getSupabaseClient));
const removeAuthorizedAttachment: typeof rawremoveAuthorizedAttachment = (target, id) => rawremoveAuthorizedAttachment(target, id, stubSessionWriter(getSupabaseClient));
const recheckAuthorizedAttachment: typeof rawrecheckAuthorizedAttachment = (target, id) => rawrecheckAuthorizedAttachment(target, id, stubSessionWriter(getSupabaseClient));
import {
  ATTACHMENT_LIMIT_NOTICE,
  ATTACHMENT_UPLOAD_CEILING_BYTES,
  STAGED_TEXT_PREVIEW_BYTES,
  stagedFormatLabel,
} from '../lib/attachmentStaging';

const serviceSource = readFileSync(fileURLToPath(new URL('./attachments.ts', import.meta.url)), 'utf8');
const accessSource = readFileSync(fileURLToPath(new URL('./privateFileAccess.ts', import.meta.url)), 'utf8');
const panelSource = readFileSync(fileURLToPath(new URL('../components/AttachmentPanel.tsx', import.meta.url)), 'utf8');
type AttachmentQueryFixture = {
  select: () => AttachmentQueryFixture;
  eq: () => AttachmentQueryFixture;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
};

const configSource = readFileSync(fileURLToPath(new URL('../../app.config.ts', import.meta.url)), 'utf8');
const caseSource = readFileSync(fileURLToPath(new URL('../../app/issue/[id].tsx', import.meta.url)), 'utf8');
const taskSource = readFileSync(fileURLToPath(new URL('../features/LiveLivedInScreens.tsx', import.meta.url)), 'utf8');

describe('native authorized attachment policy', () => {
  beforeEach(() => {
    mocks.client = null;
    mocks.files.clear();
    mocks.directories.clear();
    mocks.directories.add('file:///cache');
    mocks.events.length = 0;
    mocks.requests.length = 0;
    mocks.wholeFileReads.length = 0;
    mocks.handleReads.length = 0;
    mocks.copyFails = false;
    vi.clearAllMocks();
    mocks.cryptoUUID.mockReset().mockReturnValue('00000000-0000-4000-8000-000000000000');
    mocks.pendingCameraResult.mockReset().mockResolvedValue(null);
    mocks.manipulate.mockReset();
    mocks.inspection = null;
    mocks.downloadStatus = 200;
    mocks.fetchImpl.mockReset().mockImplementation(async (input: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null;
      mocks.requests.push({
        url: input,
        method: init.method ?? 'GET',
        headers: { ...headers },
        body,
      });
      if (input.includes('/api/sensitive-case-files') && (body as { action?: string })?.action === 'upload') {
        mocks.events.push('upload');
        return new Response(JSON.stringify({ fileId: (body as { fileId: string }).fileId, status: 'uploaded' }), { status: 200 });
      }
      if (input.includes('/api/private-files')) {
        mocks.events.push('inspect');
        const outcome = mocks.inspection;
        if (outcome) {
          return new Response(JSON.stringify(outcome.body ?? {}), {
            status: outcome.status,
            headers: { 'content-type': 'application/json', ...outcome.headers },
          });
        }
        const fileId = (body as { fileId?: string } | null)?.fileId ?? null;
        return new Response(JSON.stringify({ fileId, status: 'clean' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      mocks.events.push('download-object');
      if (mocks.downloadStatus !== 200) return new Response(JSON.stringify({ error: 'file-recheck-required' }), { status: input.includes('/api/sensitive-case-files') && mocks.downloadStatus < 500 ? 409 : mocks.downloadStatus, headers: { 'content-type': 'application/json' } });
      return new Response(new Uint8Array([7, 7, 7]), { status: 200, headers: { 'X-Sensitive-Total-Bytes': '3', 'X-Sensitive-Data-Version': 'synthetic-version' } });
    });
    vi.stubGlobal('fetch', mocks.fetchImpl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes the Android CSV provider alias without accepting a mismatched filename', () => {
    const input = { uri: 'file:///cache/table.csv', filename: 'table.csv', sizeBytes: 21,
      mimeType: 'text/comma-separated-values' };
    expect(validateAttachmentCandidate(input).mimeType).toBe('text/csv');
    expect(() => validateAttachmentCandidate({ ...input, filename: 'table.txt' })).toThrow(AttachmentError);
    expect(() => validateAttachmentCandidate({ ...input, mimeType: 'text/x-csv' })).toThrow(AttachmentError);
  });

  it('offers and reads the Android CSV provider alias through the document picker', async () => {
    const uri = 'file:///cache/DocumentPicker/table.csv';
    mocks.files.set(uri, { bytes: new TextEncoder().encode('item,value\nphones3,1\n'), exists: true });
    const getDocumentAsync = vi.fn(async () => ({ canceled: false,
      assets: [{ uri, name: 'table.csv', mimeType: 'text/comma-separated-values', size: 21 }] }));
    vi.doMock('expo-document-picker', () => ({ getDocumentAsync }));
    const candidate = await pickAuthorizedDocument();
    expect(candidate).toMatchObject({ filename: 'table.csv', mimeType: 'text/csv', sizeBytes: 21 });
    expect(getDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({
      type: expect.arrayContaining(['text/csv', 'text/comma-separated-values']),
    }));
    await cleanupAttachmentCandidate(candidate);
    vi.doUnmock('expo-document-picker');
  });

  it('accepts only the deployed filename, MIME, URI, and size alphabet', () => {
    expect(validateAttachmentCandidate({
      uri: 'file:///cache/record.pdf',
      filename: 'record.pdf',
      mimeType: 'application/pdf',
      sizeBytes: MAX_ATTACHMENT_BYTES,
    })).toMatchObject({ filename: 'record.pdf', mimeType: 'application/pdf', sizeBytes: MAX_ATTACHMENT_BYTES });

    for (const input of [
      { uri: 'content://provider/record.pdf', filename: 'record.pdf', mimeType: 'application/pdf', sizeBytes: 12 },
      { uri: 'file:///cache/record.pdf', filename: '../record.pdf', mimeType: 'application/pdf', sizeBytes: 12 },
      { uri: 'file:///cache/record.exe', filename: 'record.exe', mimeType: 'application/pdf', sizeBytes: 12 },
      { uri: 'file:///cache/record.pdf', filename: 'record.pdf', mimeType: 'text/plain', sizeBytes: 12 },
      { uri: 'file:///cache/record.pdf', filename: 'record.pdf', mimeType: 'application/pdf', sizeBytes: MAX_ATTACHMENT_BYTES + 1 },
    ]) {
      expect(() => validateAttachmentCandidate(input)).toThrow(AttachmentError);
    }
  });

  it('rechecks interrupted camera output after a clean foreground instead of using a one-shot guard', async () => {
    const uri = 'file:///cache/interrupted-camera.jpg';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    mocks.pendingCameraResult
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ canceled: false, assets: [{ uri }] });

    await expect(discardInterruptedCameraCapture()).resolves.toBe(false);
    await expect(discardInterruptedCameraCapture()).resolves.toBe(true);
    expect(mocks.pendingCameraResult).toHaveBeenCalledTimes(2);
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('consumes an unowned interrupted camera result during ordinary lifecycle purge', async () => {
    const uri = 'file:///cache/interrupted-camera-lifecycle.jpg';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    mocks.pendingCameraResult.mockResolvedValueOnce({ canceled: false, assets: [{ uri }] });

    await expect(attachmentService.purgeAttachmentCache()).resolves.toBe(true);

    expect(mocks.pendingCameraResult).toHaveBeenCalledOnce();
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('consumes an unowned interrupted camera result before signout completes', async () => {
    const uri = 'file:///cache/interrupted-camera-signout.jpg';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    mocks.pendingCameraResult.mockResolvedValueOnce({ canceled: false, assets: [{ uri }] });

    await expect(attachmentService.purgeAttachmentCacheForSignOut()).resolves.toBeUndefined();

    expect(mocks.pendingCameraResult).toHaveBeenCalledOnce();
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('retains a consumed Android camera URI until a later pass verifies deletion', async () => {
    const uri = 'file:///cache/interrupted-camera-retry.jpg';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true, deleteFails: true });
    mocks.pendingCameraResult
      .mockResolvedValueOnce({ canceled: false, assets: [{ uri }] })
      .mockResolvedValue(null);

    await expect(discardInterruptedCameraCapture()).resolves.toBe(false);
    await expect(discardInterruptedCameraCapture()).resolves.toBe(false);
    expect(mocks.pendingCameraResult).toHaveBeenCalledTimes(1);
    expect(mocks.files.get(uri)?.exists).toBe(true);

    const retained = mocks.files.get(uri);
    if (retained) retained.deleteFails = false;
    await expect(discardInterruptedCameraCapture()).resolves.toBe(true);
    expect(mocks.pendingCameraResult).toHaveBeenCalledTimes(2);
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('serializes concurrent Android pending-result cleanup without sharing an ownership pass', async () => {
    const uri = 'file:///cache/interrupted-camera-concurrent.jpg';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    let releasePending!: (value: { canceled: false; assets: Array<{ uri: string }> }) => void;
    const pending = new Promise<{ canceled: false; assets: Array<{ uri: string }> }>((resolve) => {
      releasePending = resolve;
    });
    mocks.pendingCameraResult
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(null);

    const first = discardInterruptedCameraCapture();
    const second = discardInterruptedCameraCapture();
    await vi.waitFor(() => expect(mocks.pendingCameraResult).toHaveBeenCalled());
    expect(mocks.pendingCameraResult).toHaveBeenCalledTimes(1);
    releasePending({ canceled: false, assets: [{ uri }] });

    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(mocks.pendingCameraResult).toHaveBeenCalledTimes(2);
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('retains any failed protected-cache deletion for the next foreground pass', async () => {
    const uri = 'file:///cache/general-cleanup-retry.pdf';
    const candidate = validateAttachmentCandidate({
      uri,
      filename: 'general-cleanup-retry.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
    });
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true, deleteFails: true });

    await expect(cleanupAttachmentCandidate(candidate)).rejects.toMatchObject({ code: 'cleanup' });
    await expect(discardInterruptedCameraCapture()).resolves.toBe(false);
    expect(mocks.pendingCameraResult).not.toHaveBeenCalled();
    expect(mocks.files.get(uri)?.exists).toBe(true);

    const retained = mocks.files.get(uri);
    if (retained) retained.deleteFails = false;
    await expect(discardInterruptedCameraCapture()).resolves.toBe(true);
    expect(mocks.pendingCameraResult).toHaveBeenCalledOnce();
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('deletes a stale post-picker candidate without starting its upload', async () => {
    const uri = 'file:///cache/stale-picker-result.pdf';
    const candidate = validateAttachmentCandidate({
      uri,
      filename: 'stale-picker-result.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
    });
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const upload = vi.fn();
    const consume = (attachmentService as unknown as {
      consumeAttachmentCandidateIfCurrent: <T>(
        value: typeof candidate,
        isCurrent: () => boolean,
        startUpload: () => Promise<T>,
      ) => Promise<{ status: 'discarded' } | { status: 'uploaded'; value: T }>;
    }).consumeAttachmentCandidateIfCurrent;

    expect(typeof consume).toBe('function');
    await expect(consume(candidate, () => false, upload)).resolves.toEqual({ status: 'discarded' });
    expect(upload).not.toHaveBeenCalled();
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('does not cancel an upload that was current when it started', async () => {
    const uri = 'file:///cache/current-picker-result.pdf';
    const candidate = validateAttachmentCandidate({
      uri,
      filename: 'current-picker-result.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
    });
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    let generationIsCurrent = true;
    let finishUpload!: () => void;
    const upload = vi.fn(() => new Promise<'finished'>((resolve) => {
      finishUpload = () => resolve('finished');
    }));
    const consume = (attachmentService as unknown as {
      consumeAttachmentCandidateIfCurrent: <T>(
        value: typeof candidate,
        isCurrent: () => boolean,
        startUpload: () => Promise<T>,
      ) => Promise<{ status: 'discarded' } | { status: 'uploaded'; value: T }>;
    }).consumeAttachmentCandidateIfCurrent;

    expect(typeof consume).toBe('function');
    const consuming = consume(candidate, () => generationIsCurrent, upload);
    expect(upload).toHaveBeenCalledOnce();
    generationIsCurrent = false;
    finishUpload();
    await expect(consuming).resolves.toEqual({ status: 'uploaded', value: 'finished' });
  });

  it('invalidates a captured panel generation before consuming an OS-picker result', async () => {
    const Lifecycle = (attachmentService as unknown as {
      AttachmentSelectionLifecycle: new () => {
        updateTarget: (target: { kind: 'case' | 'task'; id: string }) => void;
        capture: () => number;
        invalidate: () => void;
        consume: <T>(
          token: number,
          candidate: ReturnType<typeof validateAttachmentCandidate>,
          startUpload: () => Promise<T>,
        ) => Promise<{ status: 'discarded' } | { status: 'uploaded'; value: T }>;
      };
    }).AttachmentSelectionLifecycle;
    expect(typeof Lifecycle).toBe('function');

    const uri = 'file:///cache/changed-panel-target.pdf';
    const candidate = validateAttachmentCandidate({
      uri,
      filename: 'changed-panel-target.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
    });
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const lifecycle = new Lifecycle();
    expect(typeof lifecycle.updateTarget).toBe('function');
    lifecycle.updateTarget({ kind: 'case', id: '11111111-1111-4111-8111-111111111111' });
    const token = lifecycle.capture();
    lifecycle.updateTarget({ kind: 'task', id: '22222222-2222-4222-8222-222222222222' });
    const upload = vi.fn();

    await expect(lifecycle.consume(token, candidate, upload)).resolves.toEqual({ status: 'discarded' });
    expect(upload).not.toHaveBeenCalled();
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('uses exact server registration metadata, uploads bytes once, and deletes the cache copy', async () => {
    const uri = 'file:///cache/evidence.pdf';
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    mocks.files.set(uri, { bytes, exists: true, deleteEvent: 'delete-local-candidate' });
    const pending = {
        id: '00000000-0000-4000-8000-000000000000',
        caseId: '22222222-2222-4222-8222-222222222222',
        bucketId: 'case-files',
        objectName: 'private/server-minted-path',
        filename: 'evidence.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        confirmedAt: null,
        createdAt: '2026-08-25T18:00:00Z',
    };
    const rpc = vi.fn()
      .mockImplementationOnce(async () => {
        mocks.events.push('begin');
        return { data: pending, error: null };
      })
      .mockImplementationOnce(async () => {
        mocks.events.push('confirm');
        return { data: { ...pending, confirmedAt: '2026-08-25T18:00:01Z' }, error: null };
      });
    const upload = vi.fn(async () => {
      mocks.events.push('upload');
      return { error: null };
    });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({ upload })) },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: bytes.byteLength }),
    )).resolves.toMatchObject({ bucketID: 'case-files', objectName: 'private/server-minted-path' });

    expect(rpc).toHaveBeenNthCalledWith(1, 'begin_member_case_file_upload', expect.objectContaining({
      p_file_id: '00000000-0000-4000-8000-000000000000',
    }));
    expect(rpc).toHaveBeenNthCalledWith(2, 'confirm_member_case_file_upload', {
      p_file_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(upload).not.toHaveBeenCalled();
    expect(mocks.requests[0]).toMatchObject({ url: 'https://sample.unionground.example/api/sensitive-case-files', method: 'POST',
      body: { action: 'upload', fileId: '00000000-0000-4000-8000-000000000000', bytes: 'JVBERg==' } });
    // The safety check sits between the local cleanup and the confirm: no row
    // becomes visible before a clean verdict names this exact file.
    expect(mocks.events).toEqual(['begin', 'upload', 'delete-local-candidate', 'inspect', 'confirm']);
    expect(mocks.requests.filter((r) => r.url.includes('/api/private-files'))).toEqual([{
      url: 'https://sample.unionground.example/api/private-files',
      method: 'POST',
      headers: {
        Authorization: 'Bearer member-access-token',
        'Content-Type': 'application/json',
      },
      body: { kind: 'case', fileId: '00000000-0000-4000-8000-000000000000' },
    }]);
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('deletes an owned candidate when the mobile backend is unavailable before begin', async () => {
    const uri = 'file:///cache/backend-unavailable.pdf';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'backend-unavailable.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'authorization' });

    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('deletes an owned candidate when caller-id creation fails before begin', async () => {
    const uri = 'file:///cache/invalid-id.pdf';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    mocks.cryptoUUID.mockReturnValue('not-a-uuid');
    mocks.client = {};

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'invalid-id.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'upload' });

    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('keeps a pre-begin session rejection as authorization without calling abort', async () => {
    const uri = 'file:///cache/expired-session.pdf';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'not authenticated' } });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'expired', status: 401 } }) },
      rpc,
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'task', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'expired-session.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'authorization' });

    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('rolls registration back and cleans local bytes when storage upload fails', async () => {
    const uri = 'file:///cache/evidence.pdf';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000000',
          taskId: '22222222-2222-4222-8222-222222222222',
          bucketId: 'chapter-task-files',
          objectName: 'private/server-minted-path',
          filename: 'evidence.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 3,
          createdAt: '2026-08-25T18:00:00Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { deleted: true, id: '00000000-0000-4000-8000-000000000000' },
        error: null,
      });
    const remove = vi.fn().mockResolvedValue({ data: [{ name: 'private/server-minted-path' }], error: null });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: { message: 'network' } }),
        remove,
      })) },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'task', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'upload' });

    expect(rpc).toHaveBeenNthCalledWith(2, 'abort_chapter_task_file_upload', {
      p_file_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(remove).not.toHaveBeenCalled();
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('uses a caller-minted id and does not expose an upload until the confirm RPC succeeds', async () => {
    const uri = 'file:///cache/two-phase.pdf';
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fileID = '00000000-0000-4000-8000-000000000000';
    const targetID = '22222222-2222-4222-8222-222222222222';
    const pending = {
      id: fileID,
      caseId: targetID,
      bucketId: 'case-files',
      objectName: `private/${fileID}/two-phase.pdf`,
      filename: 'two-phase.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.byteLength,
      confirmedAt: null,
      createdAt: '2026-09-03T18:45:00Z',
    };
    mocks.files.set(uri, { bytes, exists: true });
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: pending, error: null })
      .mockResolvedValueOnce({ data: { ...pending, confirmedAt: '2026-09-03T18:45:01Z' }, error: null });
    const upload = vi.fn().mockResolvedValue({ data: { path: pending.objectName }, error: null });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({ upload })) },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: targetID },
      validateAttachmentCandidate({ uri, filename: 'two-phase.pdf', mimeType: 'application/pdf', sizeBytes: bytes.byteLength }),
    )).resolves.toMatchObject({ id: fileID, objectName: pending.objectName });

    expect(rpc).toHaveBeenNthCalledWith(1, 'begin_member_case_file_upload', {
      p_file_id: fileID,
      p_case_id: targetID,
      p_filename: 'two-phase.pdf',
      p_mime_type: 'application/pdf',
      p_size_bytes: bytes.byteLength,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'confirm_member_case_file_upload', { p_file_id: fileID });
    expect(upload).not.toHaveBeenCalled();
    expect(mocks.requests.filter((r) => r.url.includes('/api/sensitive-case-files'))).toHaveLength(1);
  });

  it('uses a strictly validated caller-supplied upload id for crash-stable retries', async () => {
    const uri = 'file:///cache/caller-supplied-id.pdf';
    const bytes = new Uint8Array([1, 2, 3]);
    const fileID = '11111111-1111-4111-8111-111111111111';
    const targetID = '22222222-2222-4222-8222-222222222222';
    const pending = {
      id: fileID,
      caseId: targetID,
      bucketId: 'case-files',
      objectName: `private/${fileID}/caller-supplied-id.pdf`,
      filename: 'caller-supplied-id.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.byteLength,
      confirmedAt: null,
      createdAt: '2026-09-03T18:45:00Z',
    };
    mocks.files.set(uri, { bytes, exists: true });
    mocks.cryptoUUID.mockImplementation(() => { throw new Error('internal mint must not run'); });
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: pending, error: null })
      .mockResolvedValueOnce({ data: { ...pending, confirmedAt: '2026-09-03T18:45:01Z' }, error: null });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({ upload: vi.fn().mockResolvedValue({ error: null }) })) },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: targetID },
      validateAttachmentCandidate({
        uri,
        filename: 'caller-supplied-id.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.byteLength,
      }),
      { fileID },
    )).resolves.toMatchObject({ id: fileID });

    expect(rpc).toHaveBeenNthCalledWith(1, 'begin_member_case_file_upload', expect.objectContaining({
      p_file_id: fileID,
    }));
    expect(mocks.cryptoUUID).not.toHaveBeenCalled();
  });

  it('treats a resolved 5xx begin response as ambiguous until abort is confirmed', async () => {
    const uri = 'file:///cache/begin-5xx.pdf';
    const fileID = '00000000-0000-4000-8000-000000000000';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'gateway lost the committed response' },
        status: 500,
        statusText: 'Internal Server Error',
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'abort response unavailable' },
        status: 503,
        statusText: 'Service Unavailable',
      });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn() },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'task', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'begin-5xx.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'cleanup' });

    expect(rpc).toHaveBeenNthCalledWith(2, 'abort_chapter_task_file_upload', { p_file_id: fileID });
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('requires the abort receipt to name the exact caller-minted id after begin ambiguity', async () => {
    const uri = 'file:///cache/begin-wrong-abort-id.pdf';
    const fileID = '00000000-0000-4000-8000-000000000000';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'gateway lost response' }, status: 500 })
      .mockResolvedValueOnce({
        data: { deleted: true, absent: false, id: '11111111-1111-4111-8111-111111111111' },
        error: null,
        status: 200,
      });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn() },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'begin-wrong-abort-id.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'cleanup' });
    expect(rpc).toHaveBeenNthCalledWith(2, 'abort_member_case_file_upload', { p_file_id: fileID });
  });

  it('aborts the caller-minted pending row when a successful begin response is malformed', async () => {
    const uri = 'file:///cache/malformed.pdf';
    const fileID = '00000000-0000-4000-8000-000000000000';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { unexpected: true }, error: null })
      .mockResolvedValueOnce({ data: { deleted: true, id: fileID }, error: null });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn() },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'task', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'malformed.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'load' });

    expect(rpc).toHaveBeenNthCalledWith(2, 'abort_chapter_task_file_upload', { p_file_id: fileID });
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('queues an uploaded pending object for trusted service cleanup without authenticated Storage deletion', async () => {
    const uri = 'file:///cache/evidence.pdf';
    const fileID = '00000000-0000-4000-8000-000000000000';
    const targetID = '22222222-2222-4222-8222-222222222222';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const pending = {
      id: fileID,
      taskId: targetID,
      bucketId: 'chapter-task-files',
      objectName: 'private/server-minted-path',
      filename: 'evidence.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
      confirmedAt: null,
      createdAt: '2026-09-03T18:45:00Z',
    };
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: pending, error: null })
      .mockResolvedValueOnce({
        data: {
          deleted: false,
          absent: false,
          cleanupQueued: true,
          cleanupRequestedAt: '2026-09-03T18:45:01Z',
          id: fileID,
        },
        error: null,
      });
    const remove = vi.fn().mockResolvedValue({ data: [], error: null });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: { message: 'network' } }),
        remove,
      })) },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'task', id: targetID },
      validateAttachmentCandidate({ uri, filename: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'cleanup' });

    expect(remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenNthCalledWith(2, 'abort_chapter_task_file_upload', { p_file_id: fileID });
  });

  it('can retain a caller-owned staged file for one foreground retry', async () => {
    mocks.fetchImpl.mockResolvedValueOnce(new Response('', { status: 503 }));
    const uri = 'file:///cache/shared-evidence.pdf';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000000',
          caseId: '22222222-2222-4222-8222-222222222222',
          bucketId: 'case-files',
          objectName: 'private/server-minted-path',
          filename: 'shared-evidence.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 3,
          createdAt: '2026-08-25T18:00:00Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { deleted: true, id: '00000000-0000-4000-8000-000000000000' },
        error: null,
      });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: { message: 'network' } }),
        remove: vi.fn().mockResolvedValue({ data: [{ name: 'private/server-minted-path' }], error: null }),
      })) },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'shared-evidence.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
      { cleanupCandidate: false },
    )).rejects.toMatchObject({ code: 'upload' });

    expect(mocks.files.get(uri)?.exists).toBe(true);
  });

  it('fails closed when a resolved rollback response cannot confirm remote cleanup', async () => {
    const uri = 'file:///cache/evidence.pdf';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000000',
          caseId: '22222222-2222-4222-8222-222222222222',
          bucketId: 'case-files',
          objectName: 'private/server-minted-path',
          filename: 'evidence.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 3,
          createdAt: '2026-08-25T18:00:00Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { message: 'authorization changed' } });
    const remove = vi.fn().mockResolvedValue({ data: [{ name: 'private/server-minted-path' }], error: null });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: { message: 'network' } }),
        remove,
      })) },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'cleanup' });

    expect(remove).not.toHaveBeenCalled();
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('does not report success when protected cache deletion cannot be verified', async () => {
    const uri = 'file:///cache/evidence.pdf';
    const bytes = new Uint8Array([1, 2, 3]);
    mocks.files.set(uri, { bytes, exists: true, deleteFails: true, deleteEvent: 'delete-local-candidate' });
    const pending = {
          id: '00000000-0000-4000-8000-000000000000',
          caseId: '22222222-2222-4222-8222-222222222222',
          bucketId: 'case-files',
          objectName: 'private/server-minted-path',
          filename: 'evidence.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 3,
          confirmedAt: null,
          createdAt: '2026-08-25T18:00:00Z',
    };
    const rpc = vi.fn()
      .mockImplementationOnce(async () => {
        mocks.events.push('begin');
        return { data: pending, error: null };
      })
      .mockImplementationOnce(async () => {
        mocks.events.push('abort');
        return {
          data: {
            deleted: false,
            absent: false,
            cleanupQueued: true,
            cleanupRequestedAt: '2026-09-03T18:45:01Z',
            id: pending.id,
          },
          error: null,
        };
      });
    const remove = vi.fn(async () => {
      mocks.events.push('remove-exact-storage-object');
      return { data: [{ name: 'private/server-minted-path' }], error: null };
    });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({
        upload: vi.fn(async () => {
          mocks.events.push('upload');
          return { error: null };
        }),
        remove,
      })) },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'cleanup' });
    expect(remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenNthCalledWith(2, 'abort_member_case_file_upload', {
      p_file_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(mocks.events).toEqual([
      'begin',
      'upload',
      'delete-local-candidate',
      'abort',
      'delete-local-candidate',
    ]);
    expect(mocks.files.get(uri)?.exists).toBe(true);
  });

  it('never removes or aborts after confirmation has an ambiguous response', async () => {
    const uri = 'file:///cache/ambiguous-confirm.pdf';
    const fileID = '00000000-0000-4000-8000-000000000000';
    const targetID = '22222222-2222-4222-8222-222222222222';
    const pending = {
      id: fileID,
      caseId: targetID,
      bucketId: 'case-files',
      objectName: 'private/server-minted-path',
      filename: 'ambiguous-confirm.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
      confirmedAt: null,
      createdAt: '2026-09-03T18:45:00Z',
    };
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: pending, error: null })
      .mockRejectedValueOnce(new Error('connection lost after commit'));
    const remove = vi.fn();
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({ upload: vi.fn().mockResolvedValue({ error: null }), remove })) },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: targetID },
      validateAttachmentCandidate({ uri, filename: 'ambiguous-confirm.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'cleanup' });

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).not.toHaveBeenCalledWith('abort_member_case_file_upload', expect.anything());
    expect(remove).not.toHaveBeenCalled();
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('reconciles a crash-stable upload id through exact confirm or abort receipts', async () => {
    const fileID = '00000000-0000-4000-8000-000000000000';
    const target = { kind: 'case' as const, id: '22222222-2222-4222-8222-222222222222' };
    const confirmed = {
      id: fileID,
      caseId: target.id,
      bucketId: 'case-files',
      objectName: 'private/server-minted-path',
      filename: 'recovered.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
      confirmedAt: '2026-09-03T20:00:00Z',
      createdAt: '2026-09-03T19:59:00Z',
    };
    const reconcile = reconcileAuthorizedAttachmentUpload;
    expect(typeof reconcile).toBe('function');
    if (!reconcile) return;

    const confirmRpc = vi.fn().mockResolvedValue({ data: confirmed, error: null, status: 200 });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc: confirmRpc,
    };
    await expect(reconcile(target, fileID)).resolves.toMatchObject({
      status: 'confirmed',
      attachment: { id: fileID },
    });

    const abortRpc = vi.fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: '22023', message: 'uploaded file was not found', details: '', hint: '' },
        status: 400,
      })
      .mockResolvedValueOnce({
        data: { deleted: true, absent: false, id: fileID },
        error: null,
        status: 200,
      });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc: abortRpc,
    };
    await expect(reconcile(target, fileID)).resolves.toEqual({ status: 'aborted' });
    expect(abortRpc).toHaveBeenNthCalledWith(2, 'abort_member_case_file_upload', { p_file_id: fileID });
  });

  it('keeps recovery uncertain while an exact pending object is queued for service cleanup', async () => {
    const fileID = '00000000-0000-4000-8000-000000000000';
    const target: { kind: 'task'; id: string } = { kind: 'task', id: '22222222-2222-4222-8222-222222222222' };
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: '22023', message: 'file unavailable', details: '', hint: '' },
        status: 400,
      })
      .mockResolvedValueOnce({
        data: {
          deleted: false,
          absent: false,
          cleanupQueued: true,
          cleanupRequestedAt: '2026-09-03T20:00:00Z',
          id: fileID,
        },
        error: null,
        status: 200,
      });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn() },
    };

    await expect(reconcileAuthorizedAttachmentUpload(target, fileID)).resolves.toEqual({ status: 'uncertain' });
    expect(rpc).toHaveBeenNthCalledWith(2, 'abort_chapter_task_file_upload', { p_file_id: fileID });
    expect((mocks.client.storage as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });

  it('keeps thrown, 5xx, authorization-loss, and malformed upload recovery outcomes uncertain', async () => {
    const fileID = '00000000-0000-4000-8000-000000000000';
    const target = { kind: 'task' as const, id: '22222222-2222-4222-8222-222222222222' };
    const reconcile = reconcileAuthorizedAttachmentUpload;
    expect(typeof reconcile).toBe('function');
    if (!reconcile) return;

    const outcomes = [
      () => Promise.reject(new Error('transport lost after commit')),
      () => Promise.resolve({ data: null, error: { code: 'XX000', message: 'gateway' }, status: 503 }),
      () => Promise.resolve({ data: null, error: { code: '42501', message: 'authorization changed' }, status: 403 }),
      () => Promise.resolve({ data: { unexpected: true }, error: null, status: 200 }),
    ];
    for (const outcome of outcomes) {
      const rpc = vi.fn().mockImplementationOnce(outcome);
      mocks.client = {
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
        rpc,
      };
      await expect(reconcile(target, fileID)).resolves.toEqual({ status: 'uncertain' });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).not.toHaveBeenCalledWith('abort_chapter_task_file_upload', expect.anything());
    }
  });

  it('rolls back a server-created row whose returned storage metadata fails closed', async () => {
    const uri = 'file:///cache/evidence.pdf';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000000',
          caseId: '22222222-2222-4222-8222-222222222222',
          bucketId: 'public-files',
          objectName: 'unexpected',
          filename: 'evidence.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 3,
          createdAt: '2026-08-25T18:00:00Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { deleted: true, id: '00000000-0000-4000-8000-000000000000' },
        error: null,
      });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn() },
    };

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      validateAttachmentCandidate({ uri, filename: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({ code: 'load' });

    expect(rpc).toHaveBeenNthCalledWith(2, 'abort_member_case_file_upload', {
      p_file_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(mocks.files.get(uri)?.exists).toBe(false);
  });

  it('commits an unreadable tombstone without asking authenticated Storage to delete it', async () => {
    const query = {} as Record<string, ReturnType<typeof vi.fn>>;
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        case_id: '22222222-2222-4222-8222-222222222222',
        bucket_id: 'case-files',
        object_name: 'private/server-minted-path',
        filename: 'evidence.pdf',
        mime_type: 'application/pdf',
        size_bytes: 4,
        created_at: '2026-08-25T18:00:00Z',
      },
      error: null,
    });
    const removalID = '00000000-0000-4000-8000-000000000000';
    const tombstone = {
      id: '11111111-1111-4111-8111-111111111111',
      caseId: '22222222-2222-4222-8222-222222222222',
      bucketId: 'case-files',
      objectName: 'private/server-minted-path',
      filename: 'evidence.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
      createdAt: '2026-08-25T18:00:00Z',
      removalId: removalID,
      removalRequestedAt: '2026-09-03T20:00:00Z',
    };
    const rpc = vi.fn().mockResolvedValue({ data: tombstone, error: null });
    const storageFrom = vi.fn();
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      from: vi.fn(() => query),
      rpc,
      storage: { from: storageFrom },
    };

    await expect(removeAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      '11111111-1111-4111-8111-111111111111',
    )).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('request_member_case_file_removal', {
      p_file_id: tombstone.id,
      p_removal_id: removalID,
    });
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it('settles a lost request response by replaying the same tombstone id without touching Storage', async () => {
    const query = {} as Record<string, ReturnType<typeof vi.fn>>;
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        case_id: '22222222-2222-4222-8222-222222222222',
        bucket_id: 'case-files',
        object_name: 'private/server-minted-path',
        filename: 'evidence.pdf',
        mime_type: 'application/pdf',
        size_bytes: 4,
        created_at: '2026-08-25T18:00:00Z',
      },
      error: null,
    });
    const removalID = '00000000-0000-4000-8000-000000000000';
    const tombstone = {
      id: '11111111-1111-4111-8111-111111111111',
      caseId: '22222222-2222-4222-8222-222222222222',
      bucketId: 'case-files',
      objectName: 'private/server-minted-path',
      filename: 'evidence.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
      createdAt: '2026-08-25T18:00:00Z',
      removalId: removalID,
      removalRequestedAt: '2026-09-03T20:00:00Z',
    };
    const storageFrom = vi.fn();
    const rpc = vi.fn()
      .mockImplementationOnce(async () => {
        mocks.events.push('request-response-lost');
        throw new Error('response lost after commit');
      })
      .mockImplementationOnce(async () => {
        mocks.events.push('request-replay');
        return { data: tombstone, error: null };
      });
    mocks.client = {
      auth: { getUser: vi.fn(async () => {
        mocks.events.push('refresh-authorization');
        return { data: { user: { id: 'user' } }, error: null };
      }) },
      from: vi.fn(() => query),
      rpc,
      storage: { from: storageFrom },
    };

    await expect(removeAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      '11111111-1111-4111-8111-111111111111',
    )).resolves.toBeUndefined();

    expect(mocks.events).toEqual([
      'refresh-authorization',
      'request-response-lost',
      'request-replay',
    ]);
    expect(rpc).toHaveBeenNthCalledWith(1, 'request_member_case_file_removal', {
      p_file_id: tombstone.id,
      p_removal_id: removalID,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'request_member_case_file_removal', {
      p_file_id: tombstone.id,
      p_removal_id: removalID,
    });
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it('fails closed when neither tombstone request response names the exact checkpoint', async () => {
    const query = {} as Record<string, ReturnType<typeof vi.fn>>;
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        case_id: '22222222-2222-4222-8222-222222222222',
        bucket_id: 'case-files',
        object_name: 'private/server-minted-path',
        filename: 'evidence.pdf',
        mime_type: 'application/pdf',
        size_bytes: 4,
        created_at: '2026-08-25T18:00:00Z',
      },
      error: null,
    });
    const removalID = '00000000-0000-4000-8000-000000000000';
    const tombstone = {
      id: '11111111-1111-4111-8111-111111111111',
      caseId: '22222222-2222-4222-8222-222222222222',
      bucketId: 'case-files',
      objectName: 'private/server-minted-path',
      filename: 'evidence.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
      createdAt: '2026-08-25T18:00:00Z',
      removalId: removalID,
      removalRequestedAt: '2026-09-03T20:00:00Z',
    };
    const storageFrom = vi.fn();
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      from: vi.fn(() => query),
      rpc: vi.fn()
        .mockResolvedValueOnce({ data: { ...tombstone, removalId: '99999999-9999-4999-8999-999999999999' }, error: null })
        .mockResolvedValueOnce({ data: null, error: null }),
      storage: { from: storageFrom },
    };

    await expect(removeAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      '11111111-1111-4111-8111-111111111111',
    )).rejects.toMatchObject({ code: 'cleanup' });
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it('rejects a tombstone response whose storage object does not match the authorized row', async () => {
    const query = {} as Record<string, ReturnType<typeof vi.fn>>;
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        case_id: '22222222-2222-4222-8222-222222222222',
        bucket_id: 'case-files',
        object_name: 'private/server-minted-path',
        filename: 'evidence.pdf',
        mime_type: 'application/pdf',
        size_bytes: 4,
        created_at: '2026-08-25T18:00:00Z',
      },
      error: null,
    });
    const removalID = '00000000-0000-4000-8000-000000000000';
    const rpc = vi.fn().mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        caseId: '22222222-2222-4222-8222-222222222222',
        bucketId: 'case-files',
        objectName: 'private/unexpected-path',
        filename: 'evidence.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4,
        createdAt: '2026-08-25T18:00:00Z',
        removalId: removalID,
        removalRequestedAt: '2026-09-03T20:00:00Z',
      },
      error: null,
    });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      from: vi.fn(() => query),
      rpc,
      storage: { from: vi.fn() },
    };

    await expect(removeAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      '11111111-1111-4111-8111-111111111111',
    )).rejects.toMatchObject({ code: 'cleanup' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenNthCalledWith(1, 'request_member_case_file_removal', {
      p_file_id: '11111111-1111-4111-8111-111111111111',
      p_removal_id: removalID,
    });
  });

  it('uses the same service-owned tombstone protocol for task attachments', async () => {
    const query = {} as Record<string, ReturnType<typeof vi.fn>>;
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        task_id: '22222222-2222-4222-8222-222222222222',
        bucket_id: 'chapter-task-files',
        object_name: 'private/server-minted-path',
        filename: 'evidence.pdf',
        mime_type: 'application/pdf',
        size_bytes: 4,
        created_at: '2026-08-25T18:00:00Z',
      },
      error: null,
    });
    const removalID = '00000000-0000-4000-8000-000000000000';
    const rpc = vi.fn().mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        taskId: '22222222-2222-4222-8222-222222222222',
        bucketId: 'chapter-task-files',
        objectName: 'private/server-minted-path',
        filename: 'evidence.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4,
        createdAt: '2026-08-25T18:00:00Z',
        removalId: removalID,
        removalRequestedAt: '2026-09-03T20:00:00Z',
      },
      error: null,
    });
    const storageFrom = vi.fn();
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      from: vi.fn(() => query),
      rpc,
      storage: { from: storageFrom },
    };

    await expect(removeAuthorizedAttachment(
      { kind: 'task', id: '22222222-2222-4222-8222-222222222222' },
      '11111111-1111-4111-8111-111111111111',
    )).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('request_chapter_task_file_removal', {
      p_file_id: '11111111-1111-4111-8111-111111111111',
      p_removal_id: removalID,
    });
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it.each<'current' | 'changed' | 'unavailable'>(['current', 'changed', 'unavailable'])('keeps downloaded bytes private and distinguishes the final ownership proof: %s', async (ownership) => {
    const query = {} as Record<string, ReturnType<typeof vi.fn>>;
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        task_id: '22222222-2222-4222-8222-222222222222',
        bucket_id: 'chapter-task-files',
        object_name: 'private/server-minted-path',
        filename: 'evidence.pdf',
        mime_type: 'application/pdf',
        size_bytes: 4,
        created_at: '2026-08-25T18:00:00Z',
      },
      error: null,
    });
    const storageFrom = vi.fn();
    mocks.shareAsync.mockImplementation(async () => { mocks.events.push('share-file'); });
    mocks.client = {
      auth: { getUser: vi.fn(async () => {
        mocks.events.push('refresh-authorization');
        return { data: { user: { id: 'user' } }, error: null };
      }) },
      from: vi.fn(() => query),
      storage: { from: storageFrom },
    };

    const writer = stubSessionWriter(getSupabaseClient);
    writer.check = async () => ownership;
    writer.isCurrent = async () => ownership === 'current';
    const opening = rawopenAuthorizedAttachment(
      { kind: 'task', id: '22222222-2222-4222-8222-222222222222' },
      '11111111-1111-4111-8111-111111111111',
      writer,
    );
    if (ownership === 'current') await opening;
    else await expect(opening).rejects.toMatchObject({ code: ownership === 'changed' ? 'authorization' : 'open' });

    expect(mocks.events).toEqual([
      'refresh-authorization',
      'download-object',
      ...(ownership === 'current' ? ['share-file'] : []),
    ]);
    // No signed URL is minted: the bytes are read with the member's own token
    // against the storage-js object path, so the quarantine policy is
    // re-evaluated on this request.
    expect(storageFrom).not.toHaveBeenCalled();
    expect(mocks.requests).toEqual([{
      url: 'https://unionground-sample.supabase.co/storage/v1/object/chapter-task-files/private/server-minted-path',
      method: 'GET',
      headers: {
        apikey: 'sb_publishable_test-key',
        Authorization: 'Bearer member-access-token',
      },
      body: null,
    }]);
    const cached = [...mocks.files.values()];
    expect(cached).toHaveLength(1);
    expect(cached[0]?.exists).toBe(false);
  });

  // The root sensitive-content-api suite proves Storage failures become this
  // HTTP response. Keep server handlers (and their Node SDKs) out of mobile.
  it.each(['sensitive-document-unavailable', 'file-recheck-required'])('keeps a 503 %s response unavailable without a native recheck', async (error) => {
    const row = { id: '11111111-1111-4111-8111-111111111111', case_id: '22222222-2222-4222-8222-222222222222',
      bucket_id: 'case-files', object_name: 'synthetic/path', filename: 'evidence.pdf', mime_type: 'application/pdf', size_bytes: 4,
      member_cases: { organization_id: 'synthetic' }, created_at: '2026-08-25T18:00:00Z' };
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    query.select = vi.fn(() => query); query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
    query.single = query.maybeSingle;
    mocks.client = { auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user' } }, error: null })) }, from: () => query };
    mocks.fetchImpl.mockResolvedValue(new Response(JSON.stringify({ error }), {
      status: 503, headers: { 'content-type': 'application/json' },
    }));
    await expect(openAuthorizedAttachment({ kind: 'case', id: row.case_id }, row.id))
      .rejects.toMatchObject({ code: 'open', recheckable: false });
    expect(mocks.fetchImpl).toHaveBeenCalledOnce();
    expect(mocks.fetchImpl).toHaveBeenCalledWith('https://sample.unionground.example/api/sensitive-case-files', expect.any(Object));
    expect(mocks.shareAsync).not.toHaveBeenCalled();
    expect([...mocks.files.values()]).toEqual([]);
  });

  it.each(['text/plain', 'application/pdf'])(
    'hands authorized %s issue bytes to the viewer and deletes the opaque cache', async (mimeType) => {
      const row = {
        id: '11111111-1111-4111-8111-111111111111',
        case_id: '22222222-2222-4222-8222-222222222222',
        bucket_id: 'case-files', object_name: 'private/server-minted-path',
        filename: mimeType === 'text/plain' ? 'private-evidence.txt' : 'private-evidence.pdf',
        mime_type: mimeType, size_bytes: 3, created_at: '2026-08-25T18:00:00Z',
      };
      const query: AttachmentQueryFixture = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row, error: null }) };
      mocks.client = {
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
        from: vi.fn(() => query),
      };
      mocks.shareAsync.mockImplementation(async (uri: string, options: { mimeType: string }) => {
        expect(uri).not.toContain('private-evidence');
        expect(options.mimeType).toBe(mimeType);
        expect(mocks.files.get(uri)).toMatchObject({ exists: true, bytes: new Uint8Array([7, 7, 7]) });
      });
      await openAuthorizedAttachment({ kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
        '11111111-1111-4111-8111-111111111111');
      expect(mocks.shareAsync).toHaveBeenCalledOnce();
      expect([...mocks.files.values()].every((file) => !file.exists)).toBe(true);
    });

  it.each<[number, 'load' | 'authorization']>([[503, 'load'], [0, 'load'], [401, 'authorization'], [403, 'authorization']])(
    'distinguishes authentication transport status %s from a rejected session', async (status, code) => {
      mocks.client = { auth: { getUser: async () => ({ data: { user: null }, error: { status } }) } };
      await expect(openAuthorizedAttachment({ kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
        '11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code });
      expect(mocks.shareAsync).not.toHaveBeenCalled();
    });

  it.each<[{ code: string; message: string } | null, 'load' | 'authorization']>([
    [{ code: 'PGRST000', message: 'transport unavailable' }, 'load'],
    [{ code: '42501', message: 'permission denied' }, 'authorization'],
    [null, 'authorization'],
  ])('classifies a metadata refusal without mistaking an outage for lost authorization (%j)', async (error, code) => {
    const query: AttachmentQueryFixture = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error }) };
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      from: vi.fn(() => query),
    };
    await expect(openAuthorizedAttachment({ kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      '11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code });
    expect(mocks.shareAsync).not.toHaveBeenCalled();
    expect(mocks.files.size).toBe(0);
  });

  it('offers one re-check when the download is refused by the quarantine policy', async () => {
    const query = {} as Record<string, ReturnType<typeof vi.fn>>;
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        case_id: '22222222-2222-4222-8222-222222222222',
        bucket_id: 'case-files',
        object_name: 'private/server-minted-path',
        filename: 'evidence.pdf',
        mime_type: 'application/pdf',
        size_bytes: 4,
        created_at: '2026-08-25T18:00:00Z',
      },
      error: null,
    });
    mocks.downloadStatus = 400;
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      from: vi.fn(() => query),
      storage: { from: vi.fn() },
    };
    const target = { kind: 'case' as const, id: '22222222-2222-4222-8222-222222222222' };

    await expect(openAuthorizedAttachment(target, '11111111-1111-4111-8111-111111111111'))
      .rejects.toMatchObject({ code: 'open', recheckable: true, rejected: false });
    // The refusal is read from the response before any byte is written, so the
    // cache never holds a partial file.
    expect([...mocks.files.values()]).toEqual([]);

    // The re-check names nothing about the object either: one POST of
    // {kind, fileId} with the member's bearer.
    mocks.requests.length = 0;
    await expect(recheckAuthorizedAttachment(target, '11111111-1111-4111-8111-111111111111'))
      .resolves.toBeUndefined();
    expect(mocks.requests.filter((r) => r.url.includes('/api/private-files'))).toEqual([{
      url: 'https://sample.unionground.example/api/private-files',
      method: 'POST',
      headers: {
        Authorization: 'Bearer member-access-token',
        'Content-Type': 'application/json',
      },
      body: { kind: 'case', fileId: '11111111-1111-4111-8111-111111111111' },
    }]);

    mocks.requests.length = 0;
    mocks.inspection = { status: 422, body: { error: 'private-file-executable' } };
    await expect(recheckAuthorizedAttachment(target, '11111111-1111-4111-8111-111111111111'))
      .rejects.toMatchObject({ code: 'open', rejected: true, recheckable: false });
    expect(mocks.requests).toHaveLength(1);
  });

  it('removes the downloaded copy when the viewer handoff fails after the bytes land', async () => {
    const query = {} as Record<string, ReturnType<typeof vi.fn>>;
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        case_id: '22222222-2222-4222-8222-222222222222',
        bucket_id: 'case-files',
        object_name: 'private/server-minted-path',
        filename: 'evidence.pdf',
        mime_type: 'application/pdf',
        size_bytes: 4,
        created_at: '2026-08-25T18:00:00Z',
      },
      error: null,
    });
    mocks.shareAsync.mockRejectedValue(new Error('viewer handoff interrupted after the file was written'));
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      from: vi.fn(() => query),
      storage: { from: vi.fn() },
    };

    await expect(openAuthorizedAttachment(
      { kind: 'case', id: '22222222-2222-4222-8222-222222222222' },
      '11111111-1111-4111-8111-111111111111',
    )).rejects.toMatchObject({ code: 'open' });

    expect([...mocks.files.values()]).toEqual([
      expect.objectContaining({ exists: false }),
    ]);
  });

  it.each<'absent' | 'queued' | 'uncertain'>(['absent', 'queued', 'uncertain'])(
    'preserves a safety rejection with %s remote cleanup without confirming', async (cleanup) => {
    const uri = 'file:///cache/refused.pdf';
    const fileID = '00000000-0000-4000-8000-000000000000';
    const targetID = '22222222-2222-4222-8222-222222222222';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true, deleteEvent: 'delete-local-candidate' });
    const rpc = vi.fn()
      .mockImplementationOnce(async () => {
        mocks.events.push('begin');
        return {
          data: {
            id: fileID,
            caseId: targetID,
            bucketId: 'case-files',
            objectName: 'private/server-minted-path',
            filename: 'refused.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 3,
            confirmedAt: null,
            createdAt: '2026-09-03T18:45:00Z',
          },
          error: null,
        };
      })
      .mockImplementationOnce(async () => {
        mocks.events.push('abort');
        return { data: cleanup === 'absent' ? { deleted: true, id: fileID }
          : cleanup === 'queued' ? { deleted: false, absent: false, cleanupQueued: true, cleanupRequestedAt: '2026-09-03T18:45:01Z', id: fileID }
          : { id: fileID }, error: null };
      });
    const remove = vi.fn();
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({
        upload: vi.fn(async () => { mocks.events.push('upload'); return { error: null }; }),
        remove,
      })) },
    };
    mocks.inspection = { status: 422, body: { error: 'private-file-executable' } };

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: targetID },
      validateAttachmentCandidate({ uri, filename: 'refused.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({
      code: cleanup === 'absent' ? 'upload' : 'cleanup',
      rejected: cleanup !== 'uncertain',
      message: cleanup === 'absent' ? 'This file was rejected by the safety check and was not attached.'
        : cleanup === 'queued' ? 'This file was rejected by the safety check and was not attached. Its temporary upload is queued for cleanup.'
        : 'The upload did not complete and cleanup could not be confirmed. Refresh this record before trying again.',
    });

    expect(mocks.events).toEqual(['begin', 'upload', 'delete-local-candidate', 'inspect', 'abort']);
    expect(rpc).toHaveBeenNthCalledWith(2, 'abort_member_case_file_upload', { p_file_id: fileID });
    expect(rpc).not.toHaveBeenCalledWith('confirm_member_case_file_upload', expect.anything());
    // Rollback stays a service-owned checkpoint: the authenticated client never
    // deletes Storage bytes itself (G5).
    expect(remove).not.toHaveBeenCalled();
  });

  it('leaves an unresolved safety check to the reconciler without aborting or confirming', async () => {
    const uri = 'file:///cache/unresolved.pdf';
    const fileID = '00000000-0000-4000-8000-000000000000';
    const targetID = '22222222-2222-4222-8222-222222222222';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn().mockResolvedValueOnce({
      data: {
        id: fileID,
        taskId: targetID,
        bucketId: 'chapter-task-files',
        objectName: 'private/server-minted-path',
        filename: 'unresolved.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        confirmedAt: null,
        createdAt: '2026-09-03T18:45:00Z',
      },
      error: null,
    });
    const remove = vi.fn();
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({ upload: vi.fn().mockResolvedValue({ error: null }), remove })) },
    };
    // 429 is refused without a retry, so the quota is not spent again, and the
    // verdict for these bytes stays unknown.
    mocks.inspection = { status: 429, body: { error: 'rate-limited' }, headers: { 'Retry-After': '3600' } };

    await expect(uploadAuthorizedAttachment(
      { kind: 'task', id: targetID },
      validateAttachmentCandidate({ uri, filename: 'unresolved.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({
      code: 'cleanup',
      rejected: false,
      pendingUploadID: fileID,
      message: 'The upload may have completed, but confirmation was interrupted. Refresh this record before trying again.',
    });

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalledWith('abort_chapter_task_file_upload', expect.anything());
    expect(rpc).not.toHaveBeenCalledWith('confirm_chapter_task_file_upload', expect.anything());
    expect(remove).not.toHaveBeenCalled();
    expect(mocks.events.filter((event) => event === 'inspect')).toHaveLength(1);
  });

  it('retains the exact interrupted attempt id and reconciles it without uploading twice', async () => {
    const uri = 'file:///cache/retry.pdf';
    const fileID = '00000000-0000-4000-8000-000000000000';
    const target = { kind: 'task' as const, id: '22222222-2222-4222-8222-222222222222' };
    const row = { id: fileID, taskId: target.id, bucketId: 'chapter-task-files',
      objectName: 'private/server-minted-path', filename: 'retry.pdf', mimeType: 'application/pdf',
      sizeBytes: 3, createdAt: '2026-09-03T18:45:00Z' };
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn(async (name: string) => ({ data: { ...row,
      confirmedAt: name === 'confirm_chapter_task_file_upload' ? '2026-09-03T18:46:00Z' : null }, error: null }));
    const upload = vi.fn().mockResolvedValue({ error: null });
    mocks.client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc, storage: { from: vi.fn(() => ({ upload })) } };
    mocks.inspection = { status: 429, body: { error: 'rate-limited' } };
    const failure: unknown = await uploadAuthorizedAttachment(target,
      validateAttachmentCandidate({ uri, filename: 'retry.pdf', mimeType: 'application/pdf', sizeBytes: 3 }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AttachmentError);
    if (!(failure instanceof AttachmentError) || !failure.pendingUploadID) throw new Error('missing attempt identity');
    mocks.inspection = null;
    await expect(reconcileAuthorizedAttachmentUpload(target, failure.pendingUploadID))
      .resolves.toMatchObject({ status: 'confirmed', attachment: { id: fileID } });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.filter(([name]) => name === 'begin_chapter_task_file_upload')).toHaveLength(1);
    expect(mocks.cryptoUUID).toHaveBeenCalledTimes(1);
  });

  it('surfaces a stale-session inspection refusal as a re-auth prompt and neither aborts nor confirms', async () => {
    const uri = 'file:///cache/stale-session.pdf';
    const fileID = '00000000-0000-4000-8000-000000000000';
    const targetID = '22222222-2222-4222-8222-222222222222';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    const rpc = vi.fn().mockResolvedValueOnce({
      data: {
        id: fileID,
        caseId: targetID,
        bucketId: 'case-files',
        objectName: 'private/server-minted-path',
        filename: 'stale-session.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        confirmedAt: null,
        createdAt: '2026-09-03T18:45:00Z',
      },
      error: null,
    });
    const remove = vi.fn();
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({ upload: vi.fn().mockResolvedValue({ error: null }), remove })) },
    };
    // authorize_private_upload_inspection requires private.mfa_satisfied() for
    // every kind (DECISIONS E4). A stale session is a 403, which is a refusal of
    // the CALLER, not of these bytes.
    mocks.inspection = { status: 403, body: { error: 'not-authorized' } };

    await expect(uploadAuthorizedAttachment(
      { kind: 'case', id: targetID },
      validateAttachmentCandidate({ uri, filename: 'stale-session.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    )).rejects.toMatchObject({
      code: 'cleanup',
      rejected: false,
      reauthRequired: true,
      message: 'Verify it is you before this file can be checked. Nothing was attached yet.',
    });

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalledWith('abort_member_case_file_upload', expect.anything());
    expect(rpc).not.toHaveBeenCalledWith('confirm_member_case_file_upload', expect.anything());
    expect(remove).not.toHaveBeenCalled();
  });

  it('reports a stale-session reconciliation as reauth-required without confirming', async () => {
    const fileID = '00000000-0000-4000-8000-000000000000';
    const target = { kind: 'task' as const, id: '22222222-2222-4222-8222-222222222222' };
    mocks.inspection = { status: 401, body: { error: 'file-check-reauth-required' } };
    // The abort/status probe is attempted, and a genuinely stale session cannot
    // answer it either: abort_*_file_upload requires private.mfa_satisfied() of
    // its own. Nothing is confirmed, nothing is proven absent, and the caller
    // is told to re-authenticate so the marker is retained.
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'authentication required', details: '', hint: '' },
      status: 403,
    });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn() },
    };

    await expect(reconcileAuthorizedAttachmentUpload(target, fileID))
      .resolves.toEqual({ status: 'reauth-required' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('abort_chapter_task_file_upload', { p_file_id: fileID });
    expect(rpc).not.toHaveBeenCalledWith('confirm_chapter_task_file_upload', expect.anything());
  });

  it('reports a refused upload whose own abort queued cleanup as cleanup-queued, never as reauth', async () => {
    // #6270 acc 3: the safety check refused the file (422), the upload's own
    // abort queued cleanup, and on return the inspection answers the merged
    // 403 for the hidden row. The abort answers cleanupQueued, which requires a
    // satisfied MFA session of its own, so the session is proven fine. Only an
    // abort that cannot answer at all (the stale-session test above) is reauth.
    const fileID = '00000000-0000-4000-8000-000000000000';
    const target: { kind: 'case'; id: string } = { kind: 'case', id: '22222222-2222-4222-8222-222222222222' };
    mocks.inspection = { status: 403, body: { error: 'not-authorized' } };
    const rpc = vi.fn<(name: string, args: Record<string, string>) => Promise<unknown>>().mockResolvedValue({
      data: { deleted: false, absent: false, cleanupQueued: true, cleanupRequestedAt: '2026-10-28T22:58:12Z', id: fileID },
      error: null,
      status: 200,
    });
    const storageFrom = vi.fn<(bucket: string) => unknown>();
    mocks.client = {
      auth: { getUser: vi.fn<() => Promise<unknown>>().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: storageFrom },
    };

    await expect(reconcileAuthorizedAttachmentUpload(target, fileID))
      .resolves.toEqual({ status: 'cleanup-queued' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('abort_member_case_file_upload', { p_file_id: fileID });
    expect(rpc).not.toHaveBeenCalledWith('confirm_member_case_file_upload', expect.anything());
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it('clears a rejected share upload after the service deletion the cleanup queue produced', async () => {
    // The regression this file exists to hold: rejected -> cleanupQueued ->
    // service deletion -> next recovery clears the marker.
    //
    // A REAL rejected upload still has bytes, so abort answers `cleanupQueued`,
    // not `deleted`/`absent`, and recovery correctly stays uncertain. The
    // service reconciler then removes the object AND the row. On the next
    // recovery the inspection endpoint has no row to authorize, which used to
    // produce the very same 403 a stale MFA session produces, so the client
    // reported 'reauth-required' and deliberately kept the marker — forever.
    // The member could reauthenticate all day and share intake stayed blocked.
    const fileID = '00000000-0000-4000-8000-000000000000';
    const target = { kind: 'task' as const, id: '22222222-2222-4222-8222-222222222222' };

    // 1. The refusal itself: bytes exist, so the abort can only queue cleanup.
    mocks.inspection = { status: 422, body: { error: 'private-file-mime-mismatch' } };
    const queuedRpc = vi.fn().mockResolvedValue({
      data: {
        deleted: false,
        absent: false,
        cleanupQueued: true,
        cleanupRequestedAt: '2026-09-03T20:00:00Z',
        id: fileID,
      },
      error: null,
      status: 200,
    });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc: queuedRpc,
      storage: { from: vi.fn() },
    };
    await expect(reconcileAuthorizedAttachmentUpload(target, fileID))
      .resolves.toEqual({ status: 'uncertain' });
    expect(queuedRpc).toHaveBeenCalledWith('abort_chapter_task_file_upload', { p_file_id: fileID });

    // 2. The service reconciler has since deleted the object and the row. The
    //    inspection endpoint refuses with the merged row-shaped 403, and the
    //    idempotent abort answers with an EXACT absent receipt for this id.
    mocks.inspection = { status: 403, body: { error: 'not-authorized' } };
    const absentRpc = vi.fn().mockResolvedValue({
      data: { deleted: false, absent: true, id: fileID },
      error: null,
      status: 200,
    });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc: absentRpc,
      storage: { from: vi.fn() },
    };
    await expect(reconcileAuthorizedAttachmentUpload(target, fileID))
      .resolves.toEqual({ status: 'aborted' });
    expect(absentRpc).toHaveBeenCalledOnce();
    expect(absentRpc).toHaveBeenCalledWith('abort_chapter_task_file_upload', { p_file_id: fileID });
    expect(absentRpc).not.toHaveBeenCalledWith('confirm_chapter_task_file_upload', expect.anything());
    // The client never deletes bytes itself: G5 removal semantics are unchanged.
    expect((mocks.client.storage as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();

    // 3. A receipt for a DIFFERENT file id proves nothing about this one.
    const wrongRpc = vi.fn().mockResolvedValue({
      data: { deleted: true, absent: false, id: '11111111-1111-4111-8111-111111111111' },
      error: null,
      status: 200,
    });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc: wrongRpc,
      storage: { from: vi.fn() },
    };
    await expect(reconcileAuthorizedAttachmentUpload(target, fileID))
      .resolves.toEqual({ status: 'reauth-required' });
  });

  it('never leaks the worker bearer through an inspection or download failure', async () => {
    const uri = 'file:///cache/leak-check.pdf';
    const fileID = '00000000-0000-4000-8000-000000000000';
    const targetID = '22222222-2222-4222-8222-222222222222';
    mocks.files.set(uri, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc: vi.fn().mockResolvedValueOnce({
        data: {
          id: fileID,
          caseId: targetID,
          bucketId: 'case-files',
          objectName: 'private/server-minted-path',
          filename: 'leak-check.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 3,
          confirmedAt: null,
          createdAt: '2026-09-03T18:45:00Z',
        },
        error: null,
      }),
      storage: { from: vi.fn(() => ({ upload: vi.fn().mockResolvedValue({ error: null }) })) },
    };
    mocks.fetchImpl.mockImplementation(async () => {
      throw new Error('TLS failure for Bearer member-access-token at https://sample.unionground.example/api/private-files');
    });

    const failure = await uploadAuthorizedAttachment(
      { kind: 'case', id: targetID },
      validateAttachmentCandidate({ uri, filename: 'leak-check.pdf', mimeType: 'application/pdf', sizeBytes: 3 }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AttachmentError);
    const rendered = `${(failure as Error).message}${(failure as Error).stack ?? ''}`;
    expect(rendered).not.toContain('member-access-token');
    expect(rendered).not.toContain('Bearer');
    expect(rendered).not.toContain('private/server-minted-path');
  });

  it('re-establishes the verdict before an idempotent reconciliation confirm', async () => {
    const fileID = '00000000-0000-4000-8000-000000000000';
    const target = { kind: 'case' as const, id: '22222222-2222-4222-8222-222222222222' };
    const rpc = vi.fn().mockImplementationOnce(async () => {
      mocks.events.push('confirm');
      return {
        data: {
          id: fileID,
          caseId: target.id,
          bucketId: 'case-files',
          objectName: 'private/server-minted-path',
          filename: 'recovered.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 3,
          confirmedAt: '2026-09-03T20:00:00Z',
          createdAt: '2026-09-03T19:59:00Z',
        },
        error: null,
        status: 200,
      };
    });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
    };

    await expect(reconcileAuthorizedAttachmentUpload(target, fileID))
      .resolves.toMatchObject({ status: 'confirmed' });
    expect(mocks.events).toEqual(['inspect', 'confirm']);
  });

  it('rolls an interrupted upload back through abort when reconciliation is refused', async () => {
    const fileID = '00000000-0000-4000-8000-000000000000';
    const target = { kind: 'task' as const, id: '22222222-2222-4222-8222-222222222222' };
    mocks.inspection = { status: 422, body: { error: 'private-file-mime-mismatch' } };
    const rpc = vi.fn().mockResolvedValueOnce({
      data: { deleted: true, absent: false, id: fileID },
      error: null,
      status: 200,
    });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn() },
    };

    await expect(reconcileAuthorizedAttachmentUpload(target, fileID)).resolves.toEqual({ status: 'rejected' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('abort_chapter_task_file_upload', { p_file_id: fileID });
    expect(rpc).not.toHaveBeenCalledWith('confirm_chapter_task_file_upload', expect.anything());

    // An abort that cannot produce an exact receipt stays uncertain rather than
    // reporting a rollback that was never proven.
    mocks.events.length = 0;
    const unprovenRpc = vi.fn().mockResolvedValueOnce({
      data: { cleanupQueued: true, id: fileID },
      error: null,
      status: 200,
    });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc: unprovenRpc,
    };
    await expect(reconcileAuthorizedAttachmentUpload(target, fileID)).resolves.toEqual({ status: 'uncertain' });
  });

  it('makes a real iOS-encoded synthetic image pass the unchanged server structural inspector', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/blank.HEIC';
    const renderedURI = 'file:///cache/ImageManipulator/native-encoded.jpg';
    const nativeJPEG = new Uint8Array(readFileSync(new URL('./fixtures/ios-uikit-blank-64.jpg', import.meta.url)));
    mocks.files.set(sourceURI, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    mocks.files.set(renderedURI, { bytes: nativeJPEG, exists: true });
    mocks.manipulate.mockImplementation(() => ({
      renderAsync: async () => ({ width: 64, height: 64, saveAsync: async () => ({ uri: renderedURI }) }),
    }));
    vi.doMock('expo-document-picker', () => ({ getDocumentAsync: async () => ({
      canceled: false, assets: [{ uri: sourceURI, name: 'blank.HEIC', mimeType: 'image/heic', size: 3 }],
    }) }));
    try {
      const candidate = await pickAuthorizedDocument();
      expect(candidate).not.toBeNull();
      const bytes = mocks.files.get(candidate!.uri)!.bytes;
      await expect(inspectPrivateFileBytes(bytes, {
        filename: candidate!.filename, mimeType: candidate!.mimeType, expectedSize: candidate!.sizeBytes,
      })).resolves.toMatchObject({ profile: 'structure-only', mimeType: 'image/jpeg' });
    } finally { vi.doUnmock('expo-document-picker'); }
  });

  it('bounds a high-resolution conversion before its bytes reach the unchanged inspector', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/large.HEIC';
    const renderedURI = 'file:///cache/ImageManipulator/large.jpg';
    const nativeJPEG = readFileSync(new URL('./fixtures/ios-uikit-blank-4032.jpg', import.meta.url));
    mocks.files.set(sourceURI, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    let width = 4032; let height = 3024;
    mocks.manipulate.mockImplementation(() => ({
      resize: (size: { width: number; height: number }) => { width = size.width; height = size.height; },
      renderAsync: async () => ({ width, height, saveAsync: async () => {
        const bytes = await sharp(nativeJPEG).resize(width, height).withMetadata().jpeg().toBuffer();
        mocks.files.set(renderedURI, { bytes: new Uint8Array(bytes), exists: true });
        return { uri: renderedURI };
      } }),
    }));
    vi.doMock('expo-document-picker', () => ({ getDocumentAsync: async () => ({
      canceled: false, assets: [{ uri: sourceURI, name: 'large.HEIC', mimeType: 'image/heic', size: 3 }],
    }) }));
    try {
      const candidate = await pickAuthorizedDocument();
      const bytes = mocks.files.get(candidate!.uri)!.bytes;
      expect(await sharp(bytes).metadata()).toMatchObject({ width: 2048, height: 1536 });
      await expect(inspectPrivateFileBytes(bytes, {
        filename: candidate!.filename, mimeType: candidate!.mimeType, expectedSize: candidate!.sizeBytes,
      })).resolves.toMatchObject({ profile: 'structure-only' });
      expect(mocks.files.get(sourceURI)?.exists).toBe(false);
      expect(mocks.files.get(renderedURI)?.exists).toBe(false);
    } finally { vi.doUnmock('expo-document-picker'); }
  });

  it('cleans both source and protected output when native encoding returns a malformed JPEG', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/broken.HEIC';
    const renderedURI = 'file:///cache/ImageManipulator/broken.jpg';
    mocks.files.set(sourceURI, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    mocks.files.set(renderedURI, { bytes: new Uint8Array([255, 216, 255]), exists: true });
    mocks.manipulate.mockImplementation(() => ({
      renderAsync: async () => ({ width: 64, height: 64, saveAsync: async () => ({ uri: renderedURI }) }),
    }));
    vi.doMock('expo-document-picker', () => ({ getDocumentAsync: async () => ({
      canceled: false, assets: [{ uri: sourceURI, name: 'broken.HEIC', mimeType: 'image/heic', size: 3 }],
    }) }));
    try {
      await expect(pickAuthorizedDocument()).rejects.toThrow('could not be converted');
      expect([...mocks.files.values()].some((file) => file.exists)).toBe(false);
    } finally { vi.doUnmock('expo-document-picker'); }
  });

  it('re-encodes a chosen HEIC photo to JPEG before it is ever validated or uploaded', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/IMG_0042.HEIC';
    const renderedURI = 'file:///cache/ImageManipulator/rendered.jpg';
    mocks.files.set(sourceURI, { bytes: new Uint8Array([1, 2, 3, 4, 5]), exists: true });
    mocks.files.set(renderedURI, { bytes: new Uint8Array(readFileSync(new URL('./fixtures/ios-uikit-blank-64.jpg', import.meta.url))), exists: true });
    mocks.cryptoUUID
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const savedOptions: Array<Record<string, unknown>> = [];
    mocks.manipulate.mockImplementation((uri: string) => ({
      renderAsync: async () => ({
        width: 64, height: 64,
        saveAsync: async (options: Record<string, unknown>) => {
          savedOptions.push({ ...options, source: uri });
          return { uri: renderedURI };
        },
      }),
    }));
    vi.doMock('expo-document-picker', () => ({
      getDocumentAsync: async () => ({
        canceled: false,
        assets: [{ uri: sourceURI, name: 'IMG_0042.HEIC', mimeType: 'image/heic', size: 5 }],
      }),
    }));

    const candidate = await pickAuthorizedDocument();

    expect(candidate).toMatchObject({
      filename: 'IMG_0042.jpg',
      mimeType: 'image/jpeg',
      // Size is recomputed from the re-encoded bytes, never carried over.
      sizeBytes: 709,
      uri: 'file:///cache/ug-attachment-cache-v1/22222222-2222-4222-8222-222222222222.jpg',
    });
    expect(savedOptions).toEqual([
      expect.objectContaining({
        format: 'jpeg',
        compress: 0.82,
        base64: false,
        source: 'file:///cache/ug-attachment-cache-v1/11111111-1111-4111-8111-111111111111.heic',
      }),
    ]);
    expect(mocks.files.get(sourceURI)?.exists).toBe(false);
    expect(mocks.files.get(renderedURI)?.exists).toBe(false);
    // HEIC is not an uploadable type any more, so nothing can declare it.
    expect([...ALLOWED_ATTACHMENT_MIME_TYPES]).not.toContain('image/heic');
    expect(() => validateAttachmentCandidate({
      uri: 'file:///cache/photo.heic',
      filename: 'photo.heic',
      mimeType: 'image/heic',
      sizeBytes: 12,
    })).toThrow(AttachmentError);
    vi.doUnmock('expo-document-picker');
  });

  // The picker's declared MIME is a claim, not evidence. An iPhone photo can
  // arrive as `IMG_0042.jpg` reported `image/jpeg` and still hold HEIC bytes;
  // uploading those mints an object the server inspector rejects permanently
  // and burns inspection quota on every retry. So the container is read.
  it('re-encodes a photo whose bytes are HEIC even when name and MIME both say JPEG', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/IMG_0042.jpg';
    const renderedURI = 'file:///cache/ImageManipulator/rendered.jpg';
    const heicHeader = new Uint8Array(16);
    heicHeader.set([0, 0, 0, 16], 0);
    heicHeader.set([...'ftypheic'].map((character) => character.charCodeAt(0)), 4);
    mocks.files.set(sourceURI, { bytes: heicHeader, exists: true });
    mocks.files.set(renderedURI, { bytes: new Uint8Array(readFileSync(new URL('./fixtures/ios-uikit-blank-64.jpg', import.meta.url))), exists: true });
    mocks.cryptoUUID
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    mocks.manipulate.mockImplementation(() => ({
      renderAsync: async () => ({ width: 64, height: 64, saveAsync: async () => ({ uri: renderedURI }) }),
    }));
    vi.doMock('expo-document-picker', () => ({
      getDocumentAsync: async () => ({
        canceled: false,
        assets: [{ uri: sourceURI, name: 'IMG_0042.jpg', mimeType: 'image/jpeg', size: 16 }],
      }),
    }));

    const candidate = await pickAuthorizedDocument();

    expect(candidate).toMatchObject({
      // Already a .jpg name: a second extension would make the filename
      // disagree with the MIME the inspector checks it against.
      filename: 'IMG_0042.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 709,
    });
    expect(mocks.manipulate).toHaveBeenCalled();
    vi.doUnmock('expo-document-picker');
  });

  // THE PROBE COSTS TWELVE BYTES, NOT TEN MEGABYTES.
  //
  // It runs for every locally picked attachment that name and MIME did not
  // already classify, and attachments are capped at 10 MiB, so reading the whole
  // file to look at its header would cost a full extra read and a 10 MiB
  // allocation on a mid-range device before the upload even starts.
  it('reads only the container header when probing for HEIC magic bytes', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/IMG_0044.jpg';
    const bytes = new Uint8Array(4 * 1024 * 1024);
    bytes.set([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 0], 0);
    mocks.files.set(sourceURI, { bytes, exists: true });
    mocks.cryptoUUID.mockReturnValueOnce('44444444-4444-4444-8444-444444444444');
    mocks.manipulate.mockClear();
    vi.doMock('expo-document-picker', () => ({
      getDocumentAsync: async () => ({
        canceled: false,
        assets: [{ uri: sourceURI, name: 'IMG_0044.jpg', mimeType: 'image/jpeg', size: bytes.byteLength }],
      }),
    }));

    await pickAuthorizedDocument();

    const probes = mocks.handleReads.filter((handle) => handle.uri === sourceURI);
    expect(probes).toHaveLength(1);
    expect(probes[0]?.lengths).toEqual([12]);
    // Read-only, and the handle is released whatever happens.
    expect(probes[0]?.mode).toBe('r');
    expect(probes[0]?.closed).toBe(true);
    // Nothing pulled the whole 4 MiB into memory to look at its first bytes.
    expect(mocks.wholeFileReads).not.toContain(sourceURI);
    expect(mocks.manipulate).not.toHaveBeenCalled();
    vi.doUnmock('expo-document-picker');
  });

  // A file that cannot be opened keeps its declared type rather than failing the
  // pick: the server still refuses HEIC bytes, so the probe can only ever turn a
  // permanent rejection into a working conversion.
  it('keeps the declared type when the header cannot be read', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/IMG_0045.jpg';
    mocks.files.set(sourceURI, { bytes: new Uint8Array([0xff, 0xd8]), exists: true });
    mocks.cryptoUUID.mockReturnValueOnce('55555555-5555-4555-8555-555555555555');
    mocks.manipulate.mockClear();
    vi.doMock('expo-document-picker', () => ({
      getDocumentAsync: async () => ({
        canceled: false,
        assets: [{ uri: sourceURI, name: 'IMG_0045.jpg', mimeType: 'image/jpeg', size: 2 }],
      }),
    }));

    const candidate = await pickAuthorizedDocument();

    expect(candidate).toMatchObject({ filename: 'IMG_0045.jpg', mimeType: 'image/jpeg', sizeBytes: 2 });
    expect(mocks.manipulate).not.toHaveBeenCalled();
    vi.doUnmock('expo-document-picker');
  });

  it('leaves a genuine JPEG untouched rather than re-encoding every attachment', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/IMG_0043.jpg';
    mocks.files.set(sourceURI, {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 0]),
      exists: true,
    });
    mocks.cryptoUUID.mockReturnValueOnce('33333333-3333-4333-8333-333333333333');
    mocks.manipulate.mockClear();
    vi.doMock('expo-document-picker', () => ({
      getDocumentAsync: async () => ({
        canceled: false,
        assets: [{ uri: sourceURI, name: 'IMG_0043.jpg', mimeType: 'image/jpeg', size: 12 }],
      }),
    }));

    const candidate = await pickAuthorizedDocument();

    expect(candidate).toMatchObject({ filename: 'IMG_0043.jpg', mimeType: 'image/jpeg', sizeBytes: 12 });
    expect(mocks.manipulate).not.toHaveBeenCalled();
    vi.doUnmock('expo-document-picker');
  });

  it('notifies a preparing phase after the picker returns an asset and before conversion finishes', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/IMG_0046.HEIC';
    const renderedURI = 'file:///cache/ImageManipulator/rendered.jpg';
    mocks.files.set(sourceURI, { bytes: new Uint8Array([1, 2, 3, 4, 5]), exists: true });
    mocks.files.set(renderedURI, { bytes: new Uint8Array(readFileSync(new URL('./fixtures/ios-uikit-blank-64.jpg', import.meta.url))), exists: true });
    mocks.cryptoUUID
      .mockReturnValueOnce('66666666-6666-4666-8666-666666666666')
      .mockReturnValueOnce('77777777-7777-4777-8777-777777777777');
    const phases: string[] = [];
    mocks.manipulate.mockImplementation(() => {
      phases.push('convert');
      return {
        renderAsync: async () => ({ width: 64, height: 64, saveAsync: async () => ({ uri: renderedURI }) }),
      };
    });
    vi.doMock('expo-document-picker', () => ({
      getDocumentAsync: async () => ({
        canceled: false,
        assets: [{ uri: sourceURI, name: 'IMG_0046.HEIC', mimeType: 'image/heic', size: 5 }],
      }),
    }));

    await pickAuthorizedDocument({
      onPhase: (phase) => { phases.push(phase); },
    });

    expect(phases[0]).toBe('preparing');
    // The conversion stage is announced before the re-encoder is entered, so a
    // slow HEIC round trip reads as work in progress rather than a stall.
    expect(phases).toEqual(['preparing', 'converting', 'convert']);
    vi.doUnmock('expo-document-picker');
  });

  it('keeps capture, opening, revocation, and platform permissions fail-closed', () => {
    expect(serviceSource).toContain('copyToCacheDirectory: true');
    expect(serviceSource).toContain("cameraType: ImagePicker.CameraType.back");
    expect(serviceSource).toContain('exif: false');
    expect(serviceSource).toContain('ImageManipulator.manipulate(protectedURI)');
    expect(serviceSource).toContain("format: SaveFormat.JPEG");
    expect(serviceSource).toContain('getPendingResultAsync()');
    // The signed-URL and header-less download path is gone for good: a signed
    // URL survives a later quarantine, and File.downloadFileAsync cannot refuse
    // a redirect that would replay the member's bearer at another host.
    expect(serviceSource).not.toContain('createSignedUrl');
    expect(serviceSource).not.toContain('File.downloadFileAsync');
    expect(serviceSource).toContain('downloadPrivateObjectToFile(');
    expect(accessSource).toContain("redirect: 'error'");
    expect(accessSource).not.toContain('File.downloadFileAsync(');
    expect(serviceSource).toContain('await cleanupLocalURI(downloadedURI)');
    expect(serviceSource).toContain('await requireCurrentSession(client)');
    expect(serviceSource).toContain("request: 'request_member_case_file_removal'");
    expect(serviceSource).toContain('requestedRemovalFromRow(target, result.data, fresh.id, removalID)');
    expect(serviceSource).not.toContain('const probe = await bucket.download(fresh.objectName)');
    expect(serviceSource).not.toContain('const removal = await bucket.remove([fresh.objectName])');
    expect(serviceSource).not.toContain('bucket.upload(fresh.objectName');
    expect(serviceSource).not.toMatch(/console\.(?:log|warn|error)/);

    expect(configSource).toContain("'android.permission.READ_MEDIA_IMAGES'");
    expect(configSource).toContain("'android.permission.READ_EXTERNAL_STORAGE'");
    expect(configSource).toContain('photosPermission: false');
    expect(configSource).toContain('cameraPermission:');
    expect(panelSource).toContain("Linking.openSettings()");
    expect(panelSource).toContain("nextError.code === 'authorization'");
    expect(panelSource).toContain('setAttachments([])');
    expect(panelSource).toContain("accessibilityLiveRegion=\"assertive\"");
    expect(panelSource).toContain("Alert.alert(\n      'Remove attachment?'");
    expect(caseSource).toContain("target={{ kind: 'case', id: item.id }}");
    expect(taskSource).toContain("target={{ kind: 'task', id: task.id }}");
  });
});

/** Every `recordLifecycleEvent(...)` argument list in a source file, verbatim. */
function lifecycleCallArguments(source: string): string[] {
  const calls: string[] = [];
  const token = 'recordLifecycleEvent(';
  let index = source.indexOf(token);
  while (index !== -1) {
    let depth = 0;
    let cursor = index + token.length - 1;
    do {
      const character = source[cursor];
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      cursor += 1;
    } while (depth > 0 && cursor < source.length);
    calls.push(source.slice(index + token.length, cursor - 1));
    index = source.indexOf(token, cursor);
  }
  return calls;
}

describe('staged attachment selections', () => {
  beforeEach(() => {
    mocks.client = null;
    mocks.files.clear();
    mocks.directories.clear();
    mocks.directories.add('file:///cache');
    mocks.events.length = 0;
    mocks.requests.length = 0;
    mocks.wholeFileReads.length = 0;
    mocks.handleReads.length = 0;
    mocks.copyFails = false;
    vi.clearAllMocks();
    mocks.inspection = null;
    mocks.downloadStatus = 200;
    mocks.cryptoUUID.mockReset().mockReturnValue('00000000-0000-4000-8000-000000000000');
    mocks.pendingCameraResult.mockReset().mockResolvedValue(null);
    mocks.fetchImpl.mockReset().mockImplementation(async (input: string, init: RequestInit = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null;
      mocks.requests.push({ url: input, method: init.method ?? 'GET', headers: {}, body });
      if (input.includes('/api/sensitive-case-files')) {
        mocks.events.push('upload');
        return new Response(JSON.stringify({ fileId: (body as { fileId: string }).fileId, status: 'uploaded' }), { status: 200 });
      }
      mocks.events.push('inspect');
      const outcome = mocks.inspection;
      if (outcome) {
        return new Response(JSON.stringify(outcome.body ?? {}), {
          status: outcome.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      // The verdict must name this exact file, exactly as the portal does.
      return new Response(JSON.stringify({ fileId: (body as { fileId?: string } | null)?.fileId ?? null, status: 'clean' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', mocks.fetchImpl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CASE = { kind: 'case', id: '22222222-2222-4222-8222-222222222222' } as const;
  const STAGED_URI = 'file:///cache/ug-attachment-cache-v1/33333333-3333-4333-8333-333333333333.pdf';
  const COPY_URI = 'file:///cache/ug-attachment-cache-v1/00000000-0000-4000-8000-000000000000.pdf';

  function stagedPdf(sizeBytes = 4) {
    return validateAttachmentCandidate({
      uri: STAGED_URI,
      filename: 'IMG_0031.pdf',
      mimeType: 'application/pdf',
      sizeBytes,
    });
  }

  function pendingRow(filename: string, sizeBytes: number) {
    return {
      id: '00000000-0000-4000-8000-000000000000',
      caseId: CASE.id,
      bucketId: 'case-files',
      objectName: 'private/server-minted-path',
      filename,
      mimeType: 'application/pdf',
      sizeBytes,
      confirmedAt: null,
      createdAt: '2026-09-28T18:00:00Z',
    };
  }

  it('states the same ceiling and format set the service actually enforces', () => {
    expect(ATTACHMENT_UPLOAD_CEILING_BYTES).toBe(MAX_ATTACHMENT_BYTES);
    expect(ATTACHMENT_UPLOAD_CEILING_BYTES).toBe(10485760);
    expect(ATTACHMENT_LIMIT_NOTICE).toContain('10,485,760 bytes');
    expect(ATTACHMENT_LIMIT_NOTICE).toContain('up to 10 MiB');
    // Every uploadable type has a member-facing label, and nothing that cannot
    // be uploaded is named as an accepted format.
    for (const mimeType of ALLOWED_ATTACHMENT_MIME_TYPES) {
      expect(stagedFormatLabel(mimeType)).not.toBe('File');
    }
    expect(stagedFormatLabel('image/heic')).toBe('File');
    for (const extension of ['PDF', 'JPG/JPEG', 'PNG', 'WebP', 'TXT', 'CSV', 'DOCX', 'XLSX']) {
      expect(ATTACHMENT_LIMIT_NOTICE).toContain(extension);
    }
    // HEIC appears only as a conversion input, never as something that uploads.
    expect(ATTACHMENT_LIMIT_NOTICE).toMatch(/HEIC and HEIF photos are converted to JPG on this device/);
  });

  it('duplicates the staged bytes under the worker name and leaves the selection in place', async () => {
    mocks.files.set(STAGED_URI, { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), exists: true });

    const copy = await copyStagedAttachmentCandidate(stagedPdf(), 'Grievance packet 2026-09.pdf');

    expect(copy).toMatchObject({
      uri: COPY_URI,
      filename: 'Grievance packet 2026-09.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
    });
    expect(copy.uri).not.toBe(STAGED_URI);
    // The staged original survives, byte for byte.
    expect(mocks.files.get(STAGED_URI)?.exists).toBe(true);
    expect([...(mocks.files.get(COPY_URI)?.bytes ?? [])]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('refuses a rename that would change the file kind or contradict the staged bytes', async () => {
    mocks.files.set(STAGED_URI, { bytes: new Uint8Array([1, 2, 3, 4]), exists: true });

    // A swapped extension, a missing one, a folder and an empty name are all
    // refused by the same validator the picker path uses.
    await expect(copyStagedAttachmentCandidate(stagedPdf(), 'renamed.txt')).rejects.toMatchObject({
      code: 'validation',
      message: 'Choose a PDF, image, text, CSV, Word, or Excel file.',
    });
    for (const filename of ['renamed', 'folder/renamed.pdf', '']) {
      await expect(copyStagedAttachmentCandidate(stagedPdf(), filename)).rejects.toMatchObject({
        code: 'validation',
      });
    }
    // Nothing was staged for those refusals, so no cache entry is left behind.
    expect([...mocks.files.keys()].filter((uri) => uri !== STAGED_URI && mocks.files.get(uri)?.exists))
      .toEqual([]);

    // A staged file whose bytes moved under the panel is refused too.
    mocks.files.set(STAGED_URI, { bytes: new Uint8Array([1, 2]), exists: true });
    await expect(copyStagedAttachmentCandidate(stagedPdf(4), 'still-four.pdf')).rejects.toMatchObject({
      code: 'validation',
    });
    expect(mocks.files.get(COPY_URI)?.exists).toBeFalsy();
  });

  it('deletes its own copy when the duplication itself fails', async () => {
    mocks.files.set(STAGED_URI, { bytes: new Uint8Array([1, 2, 3, 4]), exists: true });
    mocks.copyFails = true;

    await expect(copyStagedAttachmentCandidate(stagedPdf(), 'attempt.pdf')).rejects.toMatchObject({
      code: 'upload',
    });

    expect(mocks.files.get(COPY_URI)?.exists).toBeFalsy();
    expect(mocks.files.get(STAGED_URI)?.exists).toBe(true);
  });

  it('keeps the staged selection uploadable after a recoverable safety-check failure', async () => {
    // The exact case the staging model exists for: the safety check refuses the
    // SESSION, so every retry needs the same bytes again. The upload deletes the
    // per-attempt copy it owns; the member's selection must survive it.
    mocks.files.set(STAGED_URI, { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), exists: true });
    mocks.inspection = { status: 401, body: { error: 'reauth-required' } };
    const rpc = vi.fn().mockResolvedValue({ data: pendingRow('retry-me.pdf', 4), error: null });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({ upload: vi.fn() })) },
    };

    const copy = await copyStagedAttachmentCandidate(stagedPdf(), 'retry-me.pdf');
    await expect(uploadAuthorizedAttachment(CASE, copy)).rejects.toMatchObject({
      code: 'cleanup',
      reauthRequired: true,
    });

    expect(mocks.files.get(copy.uri)?.exists).toBe(false);
    expect(mocks.files.get(STAGED_URI)?.exists).toBe(true);

    // And the retry works from the retained selection, under the same name.
    mocks.inspection = null;
    mocks.cryptoUUID.mockReturnValue('44444444-4444-4444-8444-444444444444');
    rpc.mockReset()
      .mockResolvedValueOnce({ data: { ...pendingRow('retry-me.pdf', 4), id: '44444444-4444-4444-8444-444444444444' }, error: null })
      .mockResolvedValueOnce({
        data: {
          ...pendingRow('retry-me.pdf', 4),
          id: '44444444-4444-4444-8444-444444444444',
          confirmedAt: '2026-09-28T18:00:05Z',
        },
        error: null,
      });
    const retry = await copyStagedAttachmentCandidate(stagedPdf(), 'retry-me.pdf');
    await expect(uploadAuthorizedAttachment(CASE, retry)).resolves.toMatchObject({
      filename: 'retry-me.pdf',
    });
    expect(mocks.files.get(retry.uri)?.exists).toBe(false);
    expect(mocks.files.get(STAGED_URI)?.exists).toBe(true);
  });

  it('still deletes the uploaded copy before the verdict, and names the confirming stage', async () => {
    mocks.files.set(STAGED_URI, {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      exists: true,
      deleteEvent: 'delete-staged-selection',
    });
    mocks.files.set(COPY_URI, { bytes: new Uint8Array(), exists: false, deleteEvent: 'delete-upload-copy' });
    const rpc = vi.fn()
      .mockImplementationOnce(async () => {
        mocks.events.push('begin');
        return { data: pendingRow('named-by-member.pdf', 4), error: null };
      })
      .mockImplementationOnce(async () => {
        mocks.events.push('confirm');
        return { data: { ...pendingRow('named-by-member.pdf', 4), confirmedAt: '2026-09-28T18:00:05Z' }, error: null };
      });
    mocks.client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }) },
      rpc,
      storage: { from: vi.fn(() => ({ upload: vi.fn() })) },
    };

    const phases: string[] = [];
    const copy = await copyStagedAttachmentCandidate(stagedPdf(), 'named-by-member.pdf');
    await expect(uploadAuthorizedAttachment(CASE, copy, {
      onPhase: (phase) => { phases.push(phase); },
    })).resolves.toMatchObject({ filename: 'named-by-member.pdf' });

    // The staged duplicate is deleted before the safety check, exactly as the
    // single-step upload always did, so a refusal can still roll the row back.
    expect(mocks.events).toEqual(['copy-staged', 'begin', 'upload', 'delete-upload-copy', 'inspect', 'confirm']);
    expect(phases).toEqual(['uploading', 'checking', 'confirming']);
    // The member's own selection is untouched: only the panel releases it.
    expect(mocks.events).not.toContain('delete-staged-selection');
    expect(mocks.files.get(STAGED_URI)?.exists).toBe(true);
  });

  it('reads only a bounded window for the text preview and closes the handle', async () => {
    const line = 'campaign supply ledger — año 2026\n';
    const uri = 'file:///cache/ug-attachment-cache-v1/55555555-5555-4555-8555-555555555555.csv';
    const bytes = new TextEncoder().encode(line.repeat(600));
    mocks.files.set(uri, { bytes, exists: true });
    const candidate = validateAttachmentCandidate({
      uri,
      filename: 'ledger.csv',
      mimeType: 'text/csv',
      sizeBytes: bytes.byteLength,
    });

    const preview = await readStagedTextPreview(candidate);

    expect(preview?.truncated).toBe(true);
    expect(preview?.text).toContain('año 2026');
    expect(preview?.text.length).toBeLessThanOrEqual(480);
    // Bounded handle, one read, closed, and never a whole-file read.
    expect(mocks.handleReads).toEqual([
      { uri, mode: 'r', lengths: [STAGED_TEXT_PREVIEW_BYTES], closed: true },
    ]);
    expect(mocks.wholeFileReads).toEqual([]);
  });

  it('offers no text preview for a type that is not text, and none for unreadable bytes', async () => {
    mocks.files.set(STAGED_URI, { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), exists: true });
    await expect(readStagedTextPreview(stagedPdf())).resolves.toBeNull();
    expect(mocks.handleReads).toEqual([]);

    const uri = 'file:///cache/ug-attachment-cache-v1/66666666-6666-4666-8666-666666666666.txt';
    mocks.files.set(uri, { bytes: new Uint8Array([0x01, 0x02, 0x00, 0x03]), exists: true });
    await expect(readStagedTextPreview(validateAttachmentCandidate({
      uri,
      filename: 'not-really-text.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
    }))).resolves.toBeNull();

    // A missing staged copy is not an error path the member has to read about.
    await expect(readStagedTextPreview(validateAttachmentCandidate({
      uri: 'file:///cache/ug-attachment-cache-v1/77777777-7777-4777-8777-777777777777.txt',
      filename: 'gone.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
    }))).resolves.toBeNull();
  });

  it('never writes a preview, a name, or a staged path into the diagnostics channel', () => {
    // Read the actual argument text of every diagnostics call rather than a
    // window around it: a leak would be inside the call, and a loose window
    // matches unrelated code on either side.
    const calls = lifecycleCallArguments(panelSource).concat(lifecycleCallArguments(serviceSource));
    expect(calls.length).toBeGreaterThan(8);
    for (const argumentText of calls) {
      // `candidate ? 'selected' : 'cancelled'` is allowed: it chooses between
      // two enumerated outcomes and carries nothing from the file itself.
      for (const forbidden of ['preview', 'filename', 'stem', '.uri', 'candidate.']) {
        expect(argumentText).not.toContain(forbidden);
      }
    }
    // And no preview text can reach the accessibility channel either.
    expect(panelSource).not.toMatch(/queueAnnouncement\([^)]*preview/);
  });
});
