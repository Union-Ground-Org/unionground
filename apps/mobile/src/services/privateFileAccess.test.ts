import { stubSessionWriter } from '../testing/stubSessionWriter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: null as null | { access_token: string },
  sessionError: null as null | { message: string },
  fetchImpl: vi.fn(),
  files: new Map<string, { bytes: Uint8Array; exists: boolean; createFails?: boolean }>(),
}));

// A real admitted backend/portal pair: the inspection request refuses any
// other configuration before it reads the session (privateFileOrigin.test.ts).
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

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists() { return mocks.files.get(this.uri)?.exists ?? false; }
    get size() { return mocks.files.get(this.uri)?.bytes.byteLength ?? 0; }

    create() {
      if (mocks.files.get(this.uri)?.createFails) throw new Error('cache write refused');
      mocks.files.set(this.uri, { ...mocks.files.get(this.uri), bytes: new Uint8Array(), exists: true });
    }

    write(content: Uint8Array) {
      mocks.files.set(this.uri, {
        ...mocks.files.get(this.uri),
        bytes: new Uint8Array(content),
        exists: true,
      });
    }
  }

  class MockDirectory {
    uri: string;

    constructor(parent: { uri: string } | string, name: string) {
      const base = typeof parent === 'string' ? parent : parent.uri;
      this.uri = `${base.replace(/\/$/, '')}/${name}/`;
    }
  }

  // expo-file-system@57 exposes Paths.cache as a Directory, and attachments.ts
  // builds the cache root as new Directory(Paths.cache, 'ug-attachment-cache-v1').
  // The containment check is only meaningful if it is derived the same way.
  return { File: MockFile, Directory: MockDirectory, Paths: { cache: { uri: 'file:///cache/' } } };
});

import {
  PrivateFileError,
  downloadPrivateObjectToFile as rawDownloadPrivateObjectToFile,
  requestPrivateFileInspection as rawRequestPrivateFileInspection,
  type PrivateFileKind,
} from './privateFileAccess';

function privateFileWriter(client: Parameters<typeof rawRequestPrivateFileInspection>[0]) {
  const writer = stubSessionWriter(() => client);
  writer.session = async () => {
    const response = await client.auth.getSession();
    if (response.error || !response.data.session) throw new PrivateFileError('reauth-required');
    return response.data.session;
  };
  return writer;
}
const requestPrivateFileInspection: typeof rawRequestPrivateFileInspection = (client, kind, id, options = {}) =>
  rawRequestPrivateFileInspection(client, kind, id, { ...options, writer: privateFileWriter(client) });
const downloadPrivateObjectToFile: typeof rawDownloadPrivateObjectToFile = (client, target, destination, writer = privateFileWriter(client)) =>
  rawDownloadPrivateObjectToFile(client, target, destination, writer);

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const CACHE_DESTINATION = 'file:///cache/ug-attachment-cache-v1/22222222-2222-4222-8222-222222222222.pdf';

// The module only ever reads `client.auth.getSession()`; nothing else on the
// Supabase client is touched, which is the point of the contract.
const client = {
  auth: {
    getSession: async () => ({
      data: { session: mocks.session },
      error: mocks.sessionError,
    }),
  },
} as unknown as Parameters<typeof requestPrivateFileInspection>[0];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  mocks.session = { access_token: 'member-access-token' };
  mocks.sessionError = null;
  mocks.files.clear();
  mocks.fetchImpl.mockReset();
  vi.stubGlobal('fetch', mocks.fetchImpl);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('native private file inspection request', () => {
  it.each<PrivateFileKind>(['case', 'task', 'form', 'knowledge'])('sends exactly {kind: %s, fileId} with the worker bearer and no ambient credentials', async (kind) => {
    mocks.fetchImpl.mockResolvedValue(json(200, { fileId: FILE_ID, status: 'clean' }));

    await expect(requestPrivateFileInspection(client, kind, FILE_ID))
      .resolves.toEqual({ fileID: FILE_ID, status: 'clean' });

    expect(mocks.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = mocks.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sample.unionground.example/api/private-files');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ kind, fileId: FILE_ID });
    expect(init.headers).toEqual({
      Authorization: 'Bearer member-access-token',
      'Content-Type': 'application/json',
    });
    // No bucket, object name, signed URL, digest or verdict may be nameable by
    // the caller, and no cookie may be attached to a bearer request.
    expect(String(init.body)).not.toMatch(/bucket|object|sha256|signedUrl|status/i);
    expect(init).not.toHaveProperty('credentials');
  });

  it('refuses a 2xx that does not name this exact file as clean', async () => {
    for (const body of [
      { fileId: FILE_ID, status: 'pending' },
      { fileId: '33333333-3333-4333-8333-333333333333', status: 'clean' },
      { status: 'clean' },
      {},
    ]) {
      mocks.fetchImpl.mockReset().mockResolvedValue(json(200, body));
      await expect(requestPrivateFileInspection(client, 'task', FILE_ID, { attempts: 1 }))
        .rejects.toMatchObject({ code: 'unavailable' });
    }
  });

  it('maps each refusal status onto a stable code and retries only what can change', async () => {
    const cases: Array<[number, string, boolean]> = [
      [400, 'invalid', false],
      // 401 and 403 are deliberately different codes. 401 is the endpoint
      // saying "your MFA session is stale", decided before it looks at the
      // file; 403 is the merged answer for unknown, foreign, removed and
      // unauthorized rows, so the endpoint cannot be used to enumerate ids.
      [401, 'reauth-required', false],
      [403, 'not-authorized', false],
      [422, 'rejected', false],
      [429, 'rate-limited', false],
    ];
    for (const [status, code, retryable] of cases) {
      mocks.fetchImpl.mockReset().mockResolvedValue(json(status, { error: code }));
      const failure = await requestPrivateFileInspection(client, 'form', FILE_ID)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PrivateFileError);
      expect(failure).toMatchObject({ code, retryable });
      // A rejection is about these bytes and a quota refusal is about this
      // actor: repeating either only spends quota.
      expect(mocks.fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it('parses Retry-After without ever turning it into an immediate retry', async () => {
    mocks.fetchImpl.mockResolvedValue(json(429, { error: 'rate-limited' }, { 'Retry-After': '3600' }));
    await expect(requestPrivateFileInspection(client, 'knowledge', FILE_ID))
      .rejects.toMatchObject({ code: 'rate-limited', retryAfterMs: 3600000 });

    mocks.fetchImpl.mockResolvedValue(json(429, { error: 'rate-limited' }, { 'Retry-After': 'soon' }));
    await expect(requestPrivateFileInspection(client, 'knowledge', FILE_ID))
      .rejects.toMatchObject({ code: 'rate-limited', retryAfterMs: null });
  });

  it('retries a held lease and an outage, and resolves when they clear', async () => {
    vi.useFakeTimers();
    mocks.fetchImpl
      .mockResolvedValueOnce(json(409, { error: 'busy' }))
      .mockResolvedValueOnce(json(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(json(200, { fileId: FILE_ID, status: 'clean' }));

    const pending = requestPrivateFileInspection(client, 'case', FILE_ID);
    // The busy poll is five seconds; the unavailable backoff is the first
    // documented one second.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toEqual({ fileID: FILE_ID, status: 'clean' });
    expect(mocks.fetchImpl).toHaveBeenCalledTimes(3);
  });

  // A `busy` answer is a CONCURRENT INSPECTION HOLDING THE 60-SECOND ATTEMPT
  // LEASE, not a momentary hiccup, and a legitimate inspection can hold most of
  // it — a 10 s privileged download plus a scan bounded at 20 s. Spending the
  // three ordinary attempts on it gave up mid-scan and told the member the
  // upload failed. Busy therefore polls until the lease cannot still be alive.
  it('polls a held lease past the whole 60-second lease before giving up', async () => {
    vi.useFakeTimers();
    mocks.fetchImpl.mockResolvedValue(json(409, { error: 'busy' }, { 'Retry-After': '5' }));

    const pending = requestPrivateFileInspection(client, 'case', FILE_ID);
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15000);
    // Three attempts on the old backoff would have been spent by now.
    expect(mocks.fetchImpl).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(60000);
    await expect(settled).resolves.toMatchObject({ code: 'busy', retryable: true, retryAfterMs: 5000 });
    expect(mocks.fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(13);
  });

  it('honours a server Retry-After longer than the poll interval', async () => {
    vi.useFakeTimers();
    mocks.fetchImpl.mockResolvedValue(json(409, { error: 'busy' }, { 'Retry-After': '20' }));

    const pending = requestPrivateFileInspection(client, 'case', FILE_ID);
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(19000);
    expect(mocks.fetchImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120000);
    await expect(settled).resolves.toMatchObject({ code: 'busy', retryAfterMs: 20000 });
  });

  it('still makes exactly one request when the caller asked for one attempt', async () => {
    mocks.fetchImpl.mockResolvedValue(json(409, { error: 'busy' }, { 'Retry-After': '5' }));
    await expect(requestPrivateFileInspection(client, 'case', FILE_ID, { attempts: 1 }))
      .rejects.toMatchObject({ code: 'busy', retryable: true });
    expect(mocks.fetchImpl).toHaveBeenCalledOnce();
  });

  it('never reaches the network without a session, a known kind, or a well-formed id', async () => {
    for (const [kind, fileID] of [
      ['case', 'not-a-uuid'],
      ['bucket', FILE_ID],
      ['', FILE_ID],
    ] as Array<[string, string]>) {
      await expect(requestPrivateFileInspection(
        client,
        kind as 'case',
        fileID,
      )).rejects.toMatchObject({ code: 'invalid' });
    }
    mocks.session = null;
    // No session at all is the same class of problem as a stale one: the member
    // has to verify again, and no file was named to anyone.
    await expect(requestPrivateFileInspection(client, 'case', FILE_ID))
      .rejects.toMatchObject({ code: 'reauth-required' });
    expect(mocks.fetchImpl).not.toHaveBeenCalled();
  });

  it('does not re-surface a transport failure that carried the bearer', async () => {
    mocks.fetchImpl.mockRejectedValue(new Error('TLS handshake failed for Bearer member-access-token'));
    const failure = await requestPrivateFileInspection(client, 'case', FILE_ID, { attempts: 1 })
      .catch((error: unknown) => error) as Error;
    expect(failure).toBeInstanceOf(PrivateFileError);
    expect(`${failure.message}${failure.stack ?? ''}`).not.toContain('member-access-token');
  });
});

describe('native private object download', () => {
  it('refuses an omitted writer before reading a live token or downloading bytes', async () => {
    mocks.fetchImpl.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    await expect(rawDownloadPrivateObjectToFile(client, { bucketID: 'case-files', objectName: 'private/file.pdf' }, CACHE_DESTINATION))
      .rejects.toMatchObject({ code: 'reauth-required' });
    expect(mocks.fetchImpl).not.toHaveBeenCalled();
    expect(mocks.files.size).toBe(0);
  });
  it('reads the storage-js object path with the worker token and refuses redirects', async () => {
    mocks.fetchImpl.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    await expect(downloadPrivateObjectToFile(
      client,
      { bucketID: 'case-files', objectName: 'private/issue id/evidence #1.pdf' },
      CACHE_DESTINATION,
    )).resolves.toBeUndefined();

    expect(mocks.fetchImpl).toHaveBeenCalledWith(
      'https://unionground-sample.supabase.co/storage/v1/object/case-files/private/issue%20id/evidence%20%231.pdf',
      {
        method: 'GET',
        redirect: 'error',
        headers: {
          apikey: 'sb_publishable_test-key',
          Authorization: 'Bearer member-access-token',
        },
      },
    );
    expect(mocks.files.get(CACHE_DESTINATION)).toMatchObject({ exists: true });
  });

  it('marks a 4xx as a stale verdict and a 5xx as a plain outage', async () => {
    mocks.fetchImpl.mockResolvedValue(new Response('', { status: 400 }));
    await expect(downloadPrivateObjectToFile(
      client,
      { bucketID: 'case-files', objectName: 'private/object.pdf' },
      CACHE_DESTINATION,
    )).rejects.toMatchObject({ code: 'unavailable', staleVerdict: true });

    mocks.fetchImpl.mockResolvedValue(new Response('', { status: 502 }));
    await expect(downloadPrivateObjectToFile(
      client,
      { bucketID: 'case-files', objectName: 'private/object.pdf' },
      CACHE_DESTINATION,
    )).rejects.toMatchObject({ code: 'unavailable', staleVerdict: false });
    expect(mocks.files.size).toBe(0);
  });

  it('canonicalizes the destination beneath the real cache root', async () => {
    // The old check asked only whether SOME URI segment equalled the cache
    // directory name. Every destination below satisfies that or looks close
    // enough to, and none of them is the directory purgeAttachmentCachePass
    // actually sweeps: a traversal out of it, its percent-encoded twin, a
    // sibling directory that merely starts with the same name, the same name
    // under a different root, a subdirectory the purge pass does not walk, the
    // directory itself, and a non-file scheme.
    mocks.fetchImpl.mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));

    for (const destination of [
      'file:///cache/ug-attachment-cache-v1/../escape.pdf',
      'file:///cache/ug-attachment-cache-v1/%2e%2e/escape.pdf',
      'file:///cache/ug-attachment-cache-v1-evil/a.pdf',
      'file:///Documents/ug-attachment-cache-v1/a.pdf',
      'file:///cache/ug-attachment-cache-v1/nested/a.pdf',
      'file:///cache/ug-attachment-cache-v1/',
      'file:///cache/ug-attachment-cache-v1',
      'file:///cache/ug-attachment-cache-v1/a.pdf?x=1',
      'content://cache/ug-attachment-cache-v1/a.pdf',
      '',
    ]) {
      await expect(downloadPrivateObjectToFile(
        client,
        { bucketID: 'case-files', objectName: 'private/object.pdf' },
        destination,
      )).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(mocks.fetchImpl).not.toHaveBeenCalled();
    expect(mocks.files.size).toBe(0);

    // ...and the shape createOpaqueAttachmentCacheFile actually produces is
    // still accepted, so this is containment rather than a broken path.
    await expect(downloadPrivateObjectToFile(
      client,
      { bucketID: 'case-files', objectName: 'private/object.pdf' },
      CACHE_DESTINATION,
    )).resolves.toBeUndefined();
    expect(mocks.files.get(CACHE_DESTINATION)).toMatchObject({ exists: true });
  });

  it('refuses a destination outside the attachment cache and an unknown bucket', async () => {
    mocks.fetchImpl.mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));

    for (const destination of ['file:///cache/loose.pdf', 'file:///Documents/ug-attachment-cache-v1x/a.pdf']) {
      await expect(downloadPrivateObjectToFile(
        client,
        { bucketID: 'case-files', objectName: 'private/object.pdf' },
        destination,
      )).rejects.toMatchObject({ code: 'invalid' });
    }
    for (const bucketID of ['public-files', 'case-files-copy', '']) {
      await expect(downloadPrivateObjectToFile(
        client,
        { bucketID, objectName: 'private/object.pdf' },
        CACHE_DESTINATION,
      )).rejects.toMatchObject({ code: 'invalid' });
    }
    for (const objectName of ['', '../escape.pdf', 'private//object.pdf', 'private\\object.pdf']) {
      await expect(downloadPrivateObjectToFile(
        client,
        { bucketID: 'case-files', objectName },
        CACHE_DESTINATION,
      )).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(mocks.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an empty or oversized body rather than writing it', async () => {
    mocks.fetchImpl.mockResolvedValue(new Response(new Uint8Array(0), { status: 200 }));
    await expect(downloadPrivateObjectToFile(
      client,
      { bucketID: 'chapter-task-files', objectName: 'private/object.pdf' },
      CACHE_DESTINATION,
    )).rejects.toMatchObject({ code: 'unavailable' });

    mocks.fetchImpl.mockResolvedValue(new Response(new Uint8Array(10 * 1024 * 1024 + 1), { status: 200 }));
    await expect(downloadPrivateObjectToFile(
      client,
      { bucketID: 'chapter-task-files', objectName: 'private/object.pdf' },
      CACHE_DESTINATION,
    )).rejects.toMatchObject({ code: 'unavailable' });
    expect(mocks.files.size).toBe(0);
  });

  it('fails closed when the cache file cannot be created', async () => {
    mocks.files.set(CACHE_DESTINATION, { bytes: new Uint8Array(), exists: false, createFails: true });
    mocks.fetchImpl.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    await expect(downloadPrivateObjectToFile(
      client,
      { bucketID: 'member-form-files', objectName: 'private/object.pdf' },
      CACHE_DESTINATION,
    )).rejects.toMatchObject({ code: 'unavailable' });
    expect(mocks.files.get(CACHE_DESTINATION)?.exists).toBe(false);
  });
});
