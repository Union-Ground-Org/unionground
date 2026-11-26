import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { inspectPrivateFileBytes } from '../../../../api/_lib/privateFileSafety.js';
import { registerTaskAttachmentOwner, TaskDocumentHandoff } from '../lib/taskDocumentHandoff';
import { stubSessionWriter } from '../testing/stubSessionWriter';

const state = vi.hoisted(() => ({
  client: null as Record<string, unknown> | null,
  files: new Map<string, { bytes: Uint8Array; exists: boolean; deleteFails?: boolean }>(),
  directories: new Set<string>(),
  uuids: [] as string[],
  documentResult: null as null | { canceled: boolean; assets: Array<Record<string, unknown>> | null },
  documentResultGate: null as Promise<void> | null,
  cameraResultGate: null as Promise<void> | null,
  cameraResult: null as null | { canceled: boolean; assets: Array<Record<string, unknown>> | null },
  pendingResult: vi.fn(),
  manipulate: vi.fn(),
  share: vi.fn(),
  fetchImpl: vi.fn(),
  moveThrowsAfterWrite: false,
  deleteError: null as unknown,
}));

function joinedURI(parts: Array<string | { uri: string }>): string {
  return parts.reduce<string>((path, part, index) => {
    const value = typeof part === 'string' ? part : part.uri;
    if (index === 0) return value.replace(/\/$/, '');
    return `${path}/${value.replace(/^\/+|\/+$/g, '')}`;
  }, '');
}

vi.mock('./supabase', () => ({
  getSupabaseClient: () => state.client,
  verifyCapturedMobileSession: async (session: { user: { id: string } }) => ({ data: { user: session.user }, error: null }),
}));
vi.mock('expo/fetch', () => ({ fetch: state.fetchImpl }));

vi.mock('../lib/config', () => ({
  mobileConfig: {
    supabaseUrl: 'https://sample-boundary.supabase.co',
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
      this.uri = joinedURI(parts);
    }

    get exists() { return state.files.get(this.uri)?.exists ?? false; }
    get size() { return state.files.get(this.uri)?.bytes.byteLength ?? 0; }
    delete() {
      if (state.deleteError) throw state.deleteError;
      const entry = state.files.get(this.uri);
      if (entry && !entry.deleteFails) entry.exists = false;
    }
    async move(destination: MockFile) {
      const entry = state.files.get(this.uri);
      if (!entry?.exists) throw new Error('source missing');
      state.files.set(destination.uri, { ...entry, exists: true });
      entry.exists = false;
      if (state.moveThrowsAfterWrite) throw new Error('move response lost after destination write');
      this.uri = destination.uri;
    }
    async arrayBuffer() {
      const bytes = state.files.get(this.uri)?.bytes ?? new Uint8Array();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    create() {
      state.files.set(this.uri, { ...state.files.get(this.uri), bytes: new Uint8Array(), exists: true });
    }
    write(content: Uint8Array) {
      state.files.set(this.uri, {
        ...state.files.get(this.uri),
        bytes: new Uint8Array(content),
        exists: true,
      });
    }
  }

  class MockDirectory {
    uri: string;

    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = joinedURI(parts);
    }

    get exists() { return state.directories.has(this.uri); }
    create() { state.directories.add(this.uri); }
    list() {
      const prefix = `${this.uri}/`;
      return [...state.files.entries()]
        .filter(([uri, entry]) => entry.exists && uri.startsWith(prefix) && !uri.slice(prefix.length).includes('/'))
        .map(([uri]) => new MockFile(uri));
    }
    delete() {
      for (const [uri, entry] of state.files) {
        if (uri.startsWith(`${this.uri}/`) && !entry.deleteFails) entry.exists = false;
      }
      if (![...state.files.entries()].some(([uri, entry]) => uri.startsWith(`${this.uri}/`) && entry.exists)) {
        state.directories.delete(this.uri);
      }
    }
  }

  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: { cache: { uri: 'file:///cache' } },
  };
});

vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    const value = state.uuids.shift();
    if (!value) throw new Error('unexpected UUID mint');
    return value;
  },
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: async () => { await state.documentResultGate; return state.documentResult; },
}));

vi.mock('expo-image-picker', () => ({
  CameraType: { back: 'back' },
  requestCameraPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  launchCameraAsync: async () => { await state.cameraResultGate; return state.cameraResult; },
  getPendingResultAsync: state.pendingResult,
}));

vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: state.manipulate },
  SaveFormat: { JPEG: 'jpeg' },
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: state.share,
}));

import * as attachmentService from './attachments';
import { diagnosticReason, readLifecycleDiagnostics, resetLifecycleDiagnostics, setLifecycleDiagnosticsSink } from './lifecycleDiagnostics';

const DOCUMENT_UUID = '11111111-1111-4111-8111-111111111111';
const RAW_CAMERA_UUID = '22222222-2222-4222-8222-222222222222';
const SANITIZED_CAMERA_UUID = '33333333-3333-4333-8333-333333333333';
const VIEWER_UUID = '44444444-4444-4444-8444-444444444444';
const ATTACHMENT_CACHE = 'file:///cache/ug-attachment-cache-v1';

beforeEach(() => {
  resetLifecycleDiagnostics();
  setLifecycleDiagnosticsSink(() => undefined);
  state.client = null;
  state.files.clear();
  state.directories.clear();
  state.directories.add('file:///cache');
  state.directories.add('file:///cache/DocumentPicker');
  state.directories.add('file:///cache/ImageManipulator');
  state.directories.add('file:///cache/ImagePicker');
  state.uuids.length = 0;
  state.documentResult = null;
  state.documentResultGate = null;
  state.cameraResult = null;
  state.cameraResultGate = null;
  state.pendingResult.mockReset().mockResolvedValue(null);
  state.manipulate.mockReset();
  state.share.mockReset();
  state.moveThrowsAfterWrite = false;
  state.deleteError = null;
  state.fetchImpl.mockReset().mockImplementation(async (input: string) => (
    input.includes('/api/private-files')
      ? new Response(JSON.stringify({ fileId: '55555555-5555-4555-8555-555555555555', status: 'clean' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
      : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: {
        'Content-Type': 'application/pdf', 'X-Sensitive-Total-Bytes': '3', 'X-Sensitive-Data-Version': 'synthetic-version',
      } })
  ));
  vi.stubGlobal('fetch', state.fetchImpl);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('attachment cache lifecycle', () => {
  it('keeps a task picker result through protected-child teardown and transfers it after fresh target authorization', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/task-document.txt';
    state.files.set(sourceURI, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    state.uuids.push(DOCUMENT_UUID);
    state.documentResult = { canceled: false, assets: [{ uri: sourceURI, name: 'task-document.txt', mimeType: 'text/plain', size: 3 }] };
    let finishPicker: () => void = () => { throw new Error('picker gate missing'); };
    state.documentResultGate = new Promise<void>((resolve) => { finishPicker = resolve; });
    const owner = new TaskDocumentHandoff<attachmentService.AttachmentCandidate>(attachmentService.cleanupAttachmentCandidate);
    owner.observe('account:session', 'chapter', 'authorized');
    owner.authorizeTasks(['task']);
    owner.setQuery('exact task'); owner.setOpen('task', true);
    const selection = owner.choose('task', () => attachmentService.pickAuthorizedDocument());
    // Foreground bootstrap removes the original AttachmentPanel; its local
    // generation must remain invalid, even though the route owns this picker.
    const previousPanel = new attachmentService.AttachmentSelectionLifecycle();
    const previousGeneration = previousPanel.capture(); previousPanel.invalidate();
    expect(previousPanel.capture()).not.toBe(previousGeneration);
    owner.observe('account:session', null, 'checking');
    finishPicker(); await selection;
    expect(owner.getSnapshot().pending).toBeNull();
    expect(await attachmentService.purgeAttachmentCache()).toBe(false);
    expect(state.files.get(`${ATTACHMENT_CACHE}/${DOCUMENT_UUID}.txt`)?.exists).toBe(true);
    owner.observe('account:session', 'chapter', 'authorized'); owner.authorizeTasks(['task']);
    const candidate = owner.getSnapshot().pending?.candidate;
    expect(candidate).toBeTruthy();
    if (!candidate) throw new Error('authorized candidate missing');
    expect(owner.take('task', candidate)).toBe(true);
    const resumedPanel = new attachmentService.AttachmentSelectionLifecycle();
    resumedPanel.updateTarget({ kind: 'task', id: 'task' });
    const stage = vi.fn(async () => attachmentService.readStagedTextPreview(candidate));
    expect((await resumedPanel.consume(resumedPanel.capture(), candidate, stage)).status).toBe('uploaded');
    expect(stage).toHaveBeenCalledOnce();
    expect(state.fetchImpl).not.toHaveBeenCalled(); // Review did not upload.
    await attachmentService.cleanupAttachmentCandidate(candidate);
    owner.dispose();
    expect(state.files.get(`${ATTACHMENT_CACHE}/${DOCUMENT_UUID}.txt`)?.exists).toBe(false);
  });

  it.each(['transfer', 'sign-out', 'session-loss', 'stale-sign-out'])('retains a pending camera result across foreground cleanup and handles %s safely', async (ending) => {
    const rawURI = 'file:///cache/ImagePicker/blank-paper.jpg';
    const renderedURI = 'file:///cache/ImageManipulator/blank-paper.jpg';
    state.files.set(rawURI, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    state.files.set(renderedURI, { bytes: new Uint8Array(readFileSync(new URL('./fixtures/ios-uikit-blank-64.jpg', import.meta.url))), exists: true });
    state.uuids.push(RAW_CAMERA_UUID, SANITIZED_CAMERA_UUID);
    state.cameraResult = { canceled: false, assets: [{ uri: rawURI }] };
    state.manipulate.mockImplementation(() => ({ renderAsync: async () => ({ width: 64, height: 64,
      saveAsync: async () => ({ uri: renderedURI }) }) }));
    let finish: () => void = () => { throw new Error('camera gate missing'); };
    state.cameraResultGate = new Promise<void>((resolve) => { finish = resolve; });
    const owner = new TaskDocumentHandoff<attachmentService.AttachmentCandidate>(attachmentService.cleanupAttachmentCandidate);
    const unregister = registerTaskAttachmentOwner(owner);
    try {
      owner.observe('account:session', 'chapter', 'authorized'); owner.authorizeTasks(['task']);
      owner.setOpen('task', true);
      const selection = owner.choose('task', async (onPhase) => {
        const result = await attachmentService.captureAuthorizedScan({ onPhase });
        return result.status === 'selected' ? result.candidate : null;
      }, 'scan');
      owner.observe('account:session', null, 'checking');
      // The native producer is pending. Foreground cleanup may not steal it.
      expect(await attachmentService.purgeAttachmentCache()).toBe(false);
      expect(state.files.get(rawURI)?.exists).toBe(true);
      expect(state.pendingResult).not.toHaveBeenCalled();
      finish(); await selection;
      const retainedURI = `${ATTACHMENT_CACHE}/${SANITIZED_CAMERA_UUID}.jpg`;
      expect(owner.getSnapshot().pending).toBeNull();
      expect(await attachmentService.purgeAttachmentCache()).toBe(false);
      expect(state.files.get(retainedURI)?.exists).toBe(true);
      if (ending === 'sign-out') {
        await expect(attachmentService.purgeAttachmentCacheForSignOut()).resolves.toBeUndefined();
      } else if (ending === 'session-loss') {
        await expect(attachmentService.purgeAttachmentCacheForSessionLoss(() => true)).resolves.toBe(true);
      } else {
        if (ending === 'stale-sign-out') {
          await expect(attachmentService.purgeAttachmentCacheForSignOut(() => false)).rejects.toMatchObject({ code: 'authorization' });
          expect(state.files.get(retainedURI)?.exists).toBe(true);
        }
        owner.observe('account:session', 'chapter', 'authorized'); owner.authorizeTasks(['task']);
        const selected = owner.getSnapshot().pending?.candidate;
        expect(owner.getSnapshot().pending?.kind).toBe('scan');
        if (!selected) throw new Error('camera result missing');
        expect(owner.take('task', selected)).toBe(true);
        await attachmentService.cleanupAttachmentCandidate(selected);
      }
      expect(state.files.get(retainedURI)?.exists).toBe(false);
      expect(state.fetchImpl).not.toHaveBeenCalled();
    } finally { await owner.releaseForSessionEnd(); unregister(); }
  });

  it('relocates a picked document to a dedicated opaque cache path', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/member-private-filename.pdf';
    state.files.set(sourceURI, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    state.uuids.push(DOCUMENT_UUID);
    state.documentResult = {
      canceled: false,
      assets: [{
        uri: sourceURI,
        name: 'member-private-filename.pdf',
        mimeType: 'application/pdf',
        size: 3,
        lastModified: 0,
      }],
    };

    const candidate = await attachmentService.pickAuthorizedDocument();

    expect(candidate).toMatchObject({
      uri: `${ATTACHMENT_CACHE}/${DOCUMENT_UUID}.pdf`,
      filename: 'member-private-filename.pdf',
    });
    expect(candidate?.uri).not.toContain('member-private-filename');
    expect(state.files.get(sourceURI)?.exists).toBe(false);
    await attachmentService.cleanupAttachmentCandidate(candidate);
  });

  it('removes both possible paths when a relocation response is lost after writing the destination', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/relocation-response-loss.pdf';
    const destinationURI = `${ATTACHMENT_CACHE}/${DOCUMENT_UUID}.pdf`;
    state.files.set(sourceURI, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    state.uuids.push(DOCUMENT_UUID);
    state.moveThrowsAfterWrite = true;
    state.documentResult = {
      canceled: false,
      assets: [{
        uri: sourceURI,
        name: 'relocation-response-loss.pdf',
        mimeType: 'application/pdf',
        size: 3,
        lastModified: 0,
      }],
    };

    await expect(attachmentService.pickAuthorizedDocument()).rejects.toMatchObject({ code: 'cleanup' });
    expect(state.files.get(sourceURI)?.exists).toBe(false);
    expect(state.files.get(destinationURI)?.exists).toBe(false);
  });

  it('relocates camera raw and sanitized output before returning the candidate', async () => {
    const rawURI = 'file:///cache/ImagePicker/camera-secret.jpg';
    const manipulatedURI = 'file:///cache/ImageManipulator/render-secret.jpg';
    state.files.set(rawURI, { bytes: new Uint8Array([1, 2, 3, 4]), exists: true });
    state.files.set(manipulatedURI, { bytes: new Uint8Array(readFileSync(new URL('./fixtures/ios-uikit-blank-64.jpg', import.meta.url))), exists: true });
    state.uuids.push(RAW_CAMERA_UUID, SANITIZED_CAMERA_UUID);
    state.cameraResult = { canceled: false, assets: [{ uri: rawURI }] };
    state.manipulate.mockImplementation((uri: string) => ({
      renderAsync: async () => ({
        width: 64, height: 64,
        saveAsync: async () => {
          expect(uri).toBe(`${ATTACHMENT_CACHE}/${RAW_CAMERA_UUID}.jpg`);
          return { uri: manipulatedURI };
        },
      }),
    }));

    const result = await attachmentService.captureAuthorizedScan();

    expect(result).toMatchObject({
      status: 'selected',
      candidate: { uri: `${ATTACHMENT_CACHE}/${SANITIZED_CAMERA_UUID}.jpg` },
    });
    expect(state.files.get(rawURI)?.exists).toBe(false);
    expect(state.files.get(manipulatedURI)?.exists).toBe(false);
    if (result.status === 'selected') {
      await expect(inspectPrivateFileBytes(state.files.get(result.candidate.uri)!.bytes, {
        filename: result.candidate.filename, mimeType: result.candidate.mimeType, expectedSize: result.candidate.sizeBytes,
      })).resolves.toMatchObject({ profile: 'structure-only' });
      await attachmentService.cleanupAttachmentCandidate(result.candidate);
    }
  });

  it('downloads viewer bytes only to the dedicated opaque cache directory', async () => {
    const query = {} as Record<string, ReturnType<typeof vi.fn>>;
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: '55555555-5555-4555-8555-555555555555',
        case_id: '66666666-6666-4666-8666-666666666666',
        bucket_id: 'case-files',
        object_name: 'private/server-object.pdf',
        filename: 'member-private-filename.pdf',
        mime_type: 'application/pdf',
        size_bytes: 3,
        created_at: '2026-09-03T20:00:00Z',
      },
      error: null,
    });
    state.uuids.push(VIEWER_UUID);
    state.share.mockImplementation(async (uri: string) => {
      expect(state.files.get(uri)).toMatchObject({ bytes: new Uint8Array([1, 2, 3]), exists: true });
    });
    state.client = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user' } }, error: null }),
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: 'member-access-token', user: { id: 'user' } } },
          error: null,
        }),
      },
      from: vi.fn(() => query),
      storage: { from: vi.fn() },
    };

    await attachmentService.openAuthorizedAttachment(
      { kind: 'case', id: '66666666-6666-4666-8666-666666666666' },
      '55555555-5555-4555-8555-555555555555',
      stubSessionWriter(() => state.client, 'user'),
    );

    expect(state.share).toHaveBeenCalledWith(`${ATTACHMENT_CACHE}/${VIEWER_UUID}.pdf`, expect.any(Object));
    // The authenticated document read writes into the same cache directory the
    // purge sweeps, so a viewer copy is never left somewhere unswept.
    expect([...state.files.keys()]).toEqual([`${ATTACHMENT_CACHE}/${VIEWER_UUID}.pdf`]);
    expect(state.files.get(`${ATTACHMENT_CACHE}/${VIEWER_UUID}.pdf`)?.exists).toBe(false);
    expect(state.fetchImpl).toHaveBeenCalledWith(
      'https://sample.unionground.example/api/sensitive-case-files',
      expect.objectContaining({ method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: 'Bearer member-access-token',
      }, body: JSON.stringify({ action: 'read', fileId: '55555555-5555-4555-8555-555555555555' }) }),
    );
  });

  it('purges a viewer download that outlived its session instead of leaving it opened', async () => {
    const leftover = `${ATTACHMENT_CACHE}/${VIEWER_UUID}.pdf`;
    state.directories.add(ATTACHMENT_CACHE);
    state.files.set(leftover, { bytes: new Uint8Array([1, 2, 3]), exists: true });

    await expect(attachmentService.purgeAttachmentCache()).resolves.toBe(true);
    expect(state.files.get(leftover)?.exists).toBe(false);
  });

  it('discovers a failed deletion from disk after a simulated process restart', async () => {
    const leftover = `${ATTACHMENT_CACHE}/77777777-7777-4777-8777-777777777777.pdf`;
    const pickerLeftover = 'file:///cache/DocumentPicker/provider-copy.pdf';
    const manipulatorLeftover = 'file:///cache/ImageManipulator/rendered-copy.jpg';
    const cameraLeftover = 'file:///cache/ImagePicker/camera-copy.jpg';
    state.directories.add(ATTACHMENT_CACHE);
    state.files.set(leftover, { bytes: new Uint8Array([1]), exists: true, deleteFails: true });
    state.files.set(pickerLeftover, { bytes: new Uint8Array([1]), exists: true });
    state.files.set(manipulatorLeftover, { bytes: new Uint8Array([1]), exists: true });
    state.files.set(cameraLeftover, { bytes: new Uint8Array([1]), exists: true });
    const firstPurge = (attachmentService as unknown as {
      purgeAttachmentCache?: () => Promise<boolean>;
    }).purgeAttachmentCache;

    expect(typeof firstPurge).toBe('function');
    if (!firstPurge) return;
    await expect(firstPurge()).resolves.toBe(false);
    expect(state.files.get(leftover)?.exists).toBe(true);
    expect(state.files.get(pickerLeftover)?.exists).toBe(false);
    expect(state.files.get(manipulatorLeftover)?.exists).toBe(false);
    expect(state.files.get(cameraLeftover)?.exists).toBe(false);

    const entry = state.files.get(leftover);
    if (entry) entry.deleteFails = false;
    vi.resetModules();
    const restarted = await import('./attachments');
    await expect(restarted.purgeAttachmentCache()).resolves.toBe(true);
    expect(state.files.get(leftover)?.exists).toBe(false);
  });

  it('refuses sign-out purge while a staged candidate is active', async () => {
    const sourceURI = 'file:///cache/DocumentPicker/active.pdf';
    state.files.set(sourceURI, { bytes: new Uint8Array([1, 2, 3]), exists: true });
    state.uuids.push(DOCUMENT_UUID);
    state.documentResult = {
      canceled: false,
      assets: [{ uri: sourceURI, name: 'active.pdf', mimeType: 'application/pdf', size: 3, lastModified: 0 }],
    };
    const candidate = await attachmentService.pickAuthorizedDocument();
    const purgeForSignOut = (attachmentService as unknown as {
      purgeAttachmentCacheForSignOut?: () => Promise<void>;
    }).purgeAttachmentCacheForSignOut;

    expect(typeof purgeForSignOut).toBe('function');
    if (!purgeForSignOut) return;
    await expect(purgeForSignOut()).rejects.toMatchObject({ code: 'cleanup' });
    expect(state.files.get(candidate?.uri ?? '')?.exists).toBe(true);

    await attachmentService.cleanupAttachmentCandidate(candidate);
    await expect(purgeForSignOut()).resolves.toBeUndefined();
  });

  it('consumes Android one-shot camera recovery while account cleanup is still current', async () => {
    const interruptedURI = 'file:///cache/ImagePicker/interrupted-private.jpg';
    state.pendingResult.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: interruptedURI }],
    });
    const purgeForSignOut = (attachmentService as unknown as {
      purgeAttachmentCacheForSignOut?: (isCurrent?: () => boolean) => Promise<void>;
    }).purgeAttachmentCacheForSignOut;
    expect(typeof purgeForSignOut).toBe('function');
    if (!purgeForSignOut) return;

    await expect(purgeForSignOut(() => true)).resolves.toBeUndefined();
    expect(state.pendingResult).toHaveBeenCalledOnce();
  });
});

// The original native exception must survive as a safe reason before the
// purge replaces it with its fail-closed cleanup refusal.
describe('sign-out purge diagnosis', () => {
  it('records the originating pending camera exception without its private message', async () => {
    state.pendingResult.mockRejectedValueOnce(Object.assign(new Error('private file path'), { code: 'EACCES' }));
    await expect(attachmentService.purgeAttachmentCacheForSignOut()).rejects.toMatchObject({ code: 'cleanup' });
    expect(readLifecycleDiagnostics()).toContainEqual(expect.objectContaining({
      scope: 'attachment-cache', step: 'cache-purge-failed', outcome: 'pending-camera-result', reason: 'permission-denied',
    }));
    expect(JSON.stringify(readLifecycleDiagnostics())).not.toContain('private file path');
  });
});

it('records a recovered file deletion exception before cleanupLocalURI replaces it', async () => {
  const uri = 'file:///cache/recovered-document.pdf';
  state.files.set(uri, { bytes: new Uint8Array([1]), exists: true });
  state.pendingResult.mockResolvedValueOnce({ canceled: false, assets: [{ uri }] });
  state.deleteError = Object.assign(new Error('private native file path'), { code: 'EACCES' });
  try {
    await expect(attachmentService.purgeAttachmentCacheForSignOut()).rejects.toMatchObject({ code: 'cleanup' });
    expect(readLifecycleDiagnostics()).toContainEqual(expect.objectContaining({
      scope: 'attachment-cache', step: 'cache-purge-failed', outcome: 'cache-entry-delete', reason: 'permission-denied',
    }));
  } finally {
    state.deleteError = null;
    await attachmentService.purgeAttachmentCacheForSignOut();
  }
});

// Exercise real AttachmentError instances without loading native modules in the
// diagnostics-only suite.
it.each<['authorization' | 'cleanup', 'aborted' | 'io-failure']>([
  ['authorization', 'aborted'],
  ['cleanup', 'io-failure'],
])('classifies AttachmentError %s as %s', (code, reason) => {
  expect(diagnosticReason(new attachmentService.AttachmentError(code, 'private context'))).toBe(reason);
});

it('does not report a foreground session guard abort as a cache failure', async () => {
  await expect(attachmentService.purgeAttachmentCache(() => false)).rejects.toMatchObject({ code: 'authorization' });
  expect(readLifecycleDiagnostics()).toEqual([]);
});

it('does not report a session change during pending camera recovery as a cache failure', async () => {
  let current = true;
  state.pendingResult.mockImplementationOnce(async () => { current = false; return null; });
  await expect(attachmentService.purgeAttachmentCache(() => current)).rejects.toMatchObject({ code: 'authorization' });
  expect(readLifecycleDiagnostics()).toEqual([]);
});

it('records each native deletion failure once, including retained-cache retries', async () => {
  const uri = 'file:///cache/recovered-retry.pdf';
  state.files.set(uri, { bytes: new Uint8Array([1]), exists: true });
  state.pendingResult.mockResolvedValueOnce({ canceled: false, assets: [{ uri }] });
  state.deleteError = { name: 'CodedError', code: 'ERR_UNABLE_TO_DELETE' };
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      resetLifecycleDiagnostics();
      await expect(attachmentService.purgeAttachmentCache()).resolves.toBe(false);
      expect(readLifecycleDiagnostics()).toEqual([expect.objectContaining({
        scope: 'attachment-cache', step: 'cache-purge-failed', outcome: 'cache-entry-delete', reason: 'io-failure',
      })]);
    }
  } finally {
    state.deleteError = null;
    await attachmentService.purgeAttachmentCache();
  }
});
