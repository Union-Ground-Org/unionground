import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const harness = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    fs: {
      documentDirectory: 'file:///documents/',
      getInfoAsync: vi.fn(async (path: string) => ({ exists: files.has(path), size: files.has(path) ? new TextEncoder().encode(files.get(path)).length : 0 })),
      makeDirectoryAsync: vi.fn(async () => undefined),
      readAsStringAsync: vi.fn(async (path: string) => files.get(path) ?? ''),
      writeAsStringAsync: vi.fn(async (path: string, value: string) => { files.set(path, value); }),
      deleteAsync: vi.fn(async (path: string) => { for (const key of files.keys()) if (key === path || key.startsWith(path.endsWith('/') ? path : `${path}/`)) files.delete(key); }),
      moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => { files.set(to, files.get(from)!); files.delete(from); }),
    },
  };
});

vi.mock('./optionalFileSystem', () => ({ loadFileSystem: () => harness.fs }));
// No Union Ground site is published, so the shipped app refuses every
// download (see the last case). The flow is exercised against a fictional one.
vi.mock('../lib/publicSite', () => ({ PUBLIC_SITE_ORIGIN: 'https://app.unionground.example' }));

import { PUBLIC_LEARNING_GUIDES, PUBLIC_LEARNING_MAX_AGE_MS } from '../lib/publicLearning';
import { clearPublicLearningDownloads, downloadPublicLearningGuide, readPublicLearningLibrary, setPublicLearningEnabled } from './publicLearningDownloads';

const guide = PUBLIC_LEARNING_GUIDES[0]!;
const path = `file:///documents/public-learning-v1/${guide.id}.json`;

beforeEach(async () => {
  vi.restoreAllMocks();
  harness.files.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(guide), { headers: { 'content-type': 'application/json' } })));
  await setPublicLearningEnabled(false);
});

describe('public offline learning library', () => {
  // PHASE-2-WEB-PARITY: the web phase publishes these bytes under public/learning.
  it.skip('ships exactly the reviewed catalog bytes at each public URL', () => {
    for (const item of PUBLIC_LEARNING_GUIDES) {
      const published: unknown = JSON.parse(readFileSync(new URL(`../../../../public/learning/${item.id}.json`, import.meta.url), 'utf8'));
      expect(published).toEqual(item);
    }
  });

  it('requires opt-in and a known guide, downloads only on request without credentials', async () => {
    await expect(downloadPublicLearningGuide(guide.id)).rejects.toThrow('Turn on');
    await setPublicLearningEnabled(true);
    await expect(downloadPublicLearningGuide('private-case')).rejects.toThrow('not approved');
    expect(fetch).not.toHaveBeenCalled();
    const result = await downloadPublicLearningGuide(guide.id);
    expect(result.downloads).toHaveLength(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith(`https://app.unionground.example/learning/${guide.id}.json`, expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
  });

  it('reads a downloaded guide after a cold disconnected start without fetching', async () => {
    await setPublicLearningEnabled(true);
    await downloadPublicLearningGuide(guide.id);
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    vi.mocked(fetch).mockClear();
    expect((await readPublicLearningLibrary()).downloads[0]?.id).toBe(guide.id);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upgrades the saved revision-2 data guide offline without renewing its expiry', async () => {
    await setPublicLearningEnabled(true);
    const current = PUBLIC_LEARNING_GUIDES.find((item) => item.id === 'data-and-offline')!;
    const downloadedAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const savedPath = `file:///documents/public-learning-v1/${current.id}.json`;
    harness.files.set(savedPath, JSON.stringify({ ...current, revision: '2', reviewedAt: '2026-10-13',
      body: current.body.replace('Saved guides and notes are separate.', 'Offline availability is separate.'), downloadedAt }));
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const library = await readPublicLearningLibrary();
    expect(library.downloads).toEqual([expect.objectContaining({ id: current.id, downloadedAt })]);
    const stored: unknown = JSON.parse(harness.files.get(savedPath)!);
    expect(stored).toEqual({ ...current, downloadedAt });
    expect(fetch).not.toHaveBeenCalled();
    expect((await readPublicLearningLibrary()).downloads).toEqual(library.downloads);
  });

  it('does not upgrade expired, future-dated or unrecognized saved revisions', async () => {
    await setPublicLearningEnabled(true);
    const current = PUBLIC_LEARNING_GUIDES.find((item) => item.id === 'data-and-offline')!;
    const savedPath = `file:///documents/public-learning-v1/${current.id}.json`;
    for (const overrides of [
      { downloadedAt: Date.now() - PUBLIC_LEARNING_MAX_AGE_MS },
      { downloadedAt: Date.now() + 3600_000 },
      { revision: 'unknown' },
      { id: 'private-case' },
      { privateRecord: 'not public' },
    ]) {
      harness.files.set(savedPath, JSON.stringify({ ...current, revision: '2', reviewedAt: '2026-10-13',
        downloadedAt: Date.now(), ...overrides }));
      expect((await readPublicLearningLibrary()).downloads).toEqual([]);
      expect(harness.files.has(savedPath)).toBe(false);
    }
  });

  it('keeps the original saved guide when its offline upgrade cannot be written', async () => {
    await setPublicLearningEnabled(true);
    const current = PUBLIC_LEARNING_GUIDES.find((item) => item.id === 'data-and-offline')!;
    const savedPath = `file:///documents/public-learning-v1/${current.id}.json`;
    const before = JSON.stringify({ ...current, revision: '2', reviewedAt: '2026-10-13', downloadedAt: Date.now() });
    harness.files.set(savedPath, before);
    const failingWrite = vi.spyOn(harness.fs, 'writeAsStringAsync').mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      await expect(readPublicLearningLibrary()).rejects.toThrow('storage unavailable');
      expect(harness.files.get(savedPath)).toBe(before);
      expect(harness.files.has(savedPath.replace('.json', '.pending'))).toBe(false);
    } finally { failingWrite.mockRestore(); }
  });

  it('keeps the previous complete copy when a connection is interrupted', async () => {
    await setPublicLearningEnabled(true);
    await downloadPublicLearningGuide(guide.id);
    const before = harness.files.get(path);
    vi.mocked(fetch).mockRejectedValue(new Error('connection interrupted'));
    await expect(downloadPublicLearningGuide(guide.id)).rejects.toThrow();
    expect(harness.files.get(path)).toBe(before);
  });

  it('refuses modified content and extra fields instead of retaining unreviewed or private input', async () => {
    await setPublicLearningEnabled(true);
    for (const payload of [{ ...guide, body: 'new unreviewed content' }, { ...guide, privateRecord: 'not public' }]) {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(payload)));
      await expect(downloadPublicLearningGuide(guide.id)).rejects.toThrow('changed');
    }
    expect((await readPublicLearningLibrary()).downloads).toEqual([]);
  });

  it('refuses a different approved guide before creating the requested file', async () => {
    await setPublicLearningEnabled(true);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(PUBLIC_LEARNING_GUIDES[1])));
    await expect(downloadPublicLearningGuide(guide.id)).rejects.toThrow('changed');
    expect(harness.files.has(path)).toBe(false);
    expect(harness.files.has(path.replace('.json', '.pending'))).toBe(false);
    expect((await readPublicLearningLibrary()).downloads).toEqual([]);
  });

  it('keeps the previous copy when a refresh returns a different approved guide', async () => {
    await setPublicLearningEnabled(true);
    await downloadPublicLearningGuide(guide.id);
    const before = harness.files.get(path);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(PUBLIC_LEARNING_GUIDES[1])));
    await expect(downloadPublicLearningGuide(guide.id)).rejects.toThrow('changed');
    expect(harness.files.get(path)).toBe(before);
    expect((await readPublicLearningLibrary()).downloads.map((item) => item.id)).toEqual([guide.id]);
  });

  it('removes a mismatched cached file without duplicating or deleting the correctly named guide', async () => {
    await setPublicLearningEnabled(true);
    const other = PUBLIC_LEARNING_GUIDES[1]!;
    const otherPath = `file:///documents/public-learning-v1/${other.id}.json`;
    const payload = JSON.stringify({ ...other, downloadedAt: Date.now() });
    harness.files.set(path, payload);
    harness.files.set(otherPath, payload);
    expect((await readPublicLearningLibrary()).downloads.map((item) => item.id)).toEqual([other.id]);
    expect(harness.files.has(path)).toBe(false);
    expect(harness.files.get(otherPath)).toBe(payload);
  });

  it('removes expired and future-dated copies before returning them', async () => {
    await setPublicLearningEnabled(true);
    for (const downloadedAt of [Date.now() - PUBLIC_LEARNING_MAX_AGE_MS, Date.now() + 3600_000]) {
      harness.files.set(path, JSON.stringify({ ...guide, downloadedAt }));
      expect((await readPublicLearningLibrary()).downloads).toEqual([]);
      expect(harness.files.has(path)).toBe(false);
    }
  });

  it('invalidates a download in flight when the user clears the library', async () => {
    await setPublicLearningEnabled(true);
    let complete!: (response: Response) => void;
    let requested!: () => void;
    const started = new Promise<void>((resolve) => { requested = resolve; });
    vi.mocked(fetch).mockImplementationOnce(() => { requested(); return new Promise<Response>((resolve) => { complete = resolve; }); });
    const download = downloadPublicLearningGuide(guide.id);
    const rejection = expect(download).rejects.toThrow('canceled');
    await started;
    const clearing = clearPublicLearningDownloads();
    complete(new Response(JSON.stringify(guide)));
    await rejection;
    expect((await clearing).downloads).toEqual([]);
    expect(harness.files.has(path)).toBe(false);
  });

  it('disabling removes public copies and reports zero storage', async () => {
    await setPublicLearningEnabled(true);
    await downloadPublicLearningGuide(guide.id);
    expect(await setPublicLearningEnabled(false)).toEqual({ enabled: false, downloads: [], bytes: 0 });
    expect(harness.files.size).toBe(0);
  });
});

describe('download retry and understandable failure states', () => {
  it('updates the same guide without duplicates and retains a cold-readable copy', async () => {
    await setPublicLearningEnabled(true);
    await downloadPublicLearningGuide(guide.id);
    const updated = await downloadPublicLearningGuide(guide.id);
    expect(updated.downloads).toHaveLength(1);
    expect((await readPublicLearningLibrary()).bytes).toBe(updated.bytes);
    expect(harness.files.has(path.replace('.json', '.pending'))).toBe(false);
  });
  it('distinguishes an unpublished guide from a broken connection', async () => {
    await setPublicLearningEnabled(true);
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    await expect(downloadPublicLearningGuide(guide.id)).rejects.toThrow('not available to download yet');
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('opaque platform detail'));
    await expect(downloadPublicLearningGuide(guide.id)).rejects.toThrow('Check your connection');
    expect((await readPublicLearningLibrary()).bytes).toBe(0);
  });
  it('does not expose a parser exception for a non-JSON service response', async () => {
    await setPublicLearningEnabled(true);
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<html>service unavailable</html>'));
    await expect(downloadPublicLearningGuide(guide.id)).rejects.toThrow('could not be read');
  });
});

describe('unpublished Union Ground site', () => {
  it('refuses downloads before any request while no public site exists', async () => {
    vi.resetModules();
    vi.doUnmock('../lib/publicSite');
    vi.stubGlobal('fetch', vi.fn());
    const service = await import('./publicLearningDownloads');
    await service.setPublicLearningEnabled(true);
    await expect(service.downloadPublicLearningGuide(guide.id)).rejects.toThrow('Offline guide downloads are not available yet.');
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
