import { PUBLIC_LEARNING_GUIDES, readablePublicDownload, type PublicLearningGuide, type PublicLearningLibrary, type PublicLearningDownload } from '../lib/publicLearning';
import { PUBLIC_SITE_ORIGIN } from '../lib/publicSite';
import { loadFileSystem } from './optionalFileSystem';

// Public bytes only. This directory never receives a user ID, draft, server
// record, access token or attachment. Cold offline reads need no saved role.
const directoryName = 'public-learning-v1/';

let generation = 0;
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(action: () => Promise<T>): Promise<T> {
  const result = queue.then(action);
  queue = result.catch(() => undefined);
  return result;
}

function storage() {
  const fs = loadFileSystem();
  if (!fs?.documentDirectory) throw new Error('Downloads are unavailable in this build.');
  return { fs, root: `${fs.documentDirectory}${directoryName}` };
}

function upgradedSavedGuide(value: unknown, guide: PublicLearningGuide, now: number): (PublicLearningGuide & { downloadedAt: number }) | null {
  // This release changes the public guide's wording only. Preserve an existing
  // save by replacing its bytes with the reviewed bundle, never with disk text.
  if (guide.id !== 'data-and-offline' || guide.revision !== '3' || !value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'body,downloadedAt,id,reviewedAt,revision,title'
    || row.id !== guide.id || row.revision !== '2' || row.reviewedAt !== '2026-10-13'
    || row.title !== guide.title || typeof row.body !== 'string') return null;
  const download = readablePublicDownload({ ...row, ...guide }, now);
  return download ? { ...guide, downloadedAt: download.downloadedAt } : null;
}

async function readLibrary(): Promise<PublicLearningLibrary> {
  const { fs, root } = storage();
  if (!(await fs.getInfoAsync(`${root}enabled`)).exists) return { enabled: false, downloads: [], bytes: 0 };
  const downloads = [];
  for (const guide of PUBLIC_LEARNING_GUIDES) {
    const path = `${root}${guide.id}.json`;
    const info = await fs.getInfoAsync(path);
    if (!info.exists) continue;
    // Reject oversized disk data before reading it.
    let download: PublicLearningDownload | null = null;
    if ('size' in info && info.size <= 16_384) {
      let stored: unknown;
      try { stored = JSON.parse(await fs.readAsStringAsync(path)); } catch { /* Invalid download. */ }
      const now = Date.now();
      download = readablePublicDownload(stored, now);
      const upgraded = download ? null : upgradedSavedGuide(stored, guide, now);
      if (upgraded) {
        const pending = `${root}${guide.id}.pending`;
        try {
          await fs.writeAsStringAsync(pending, JSON.stringify(upgraded));
          await fs.moveAsync({ from: pending, to: path });
        } catch (error) {
          await fs.deleteAsync(pending, { idempotent: true }).catch(() => undefined);
          throw error;
        }
        download = readablePublicDownload(upgraded, now);
      }
    }
    if (download?.id === guide.id) downloads.push(download);
    else await fs.deleteAsync(path, { idempotent: true });
  }
  return { enabled: true, downloads, bytes: downloads.reduce((total, item) => total + item.bytes, 0) };
}

export function readPublicLearningLibrary(): Promise<PublicLearningLibrary> {
  return serial(readLibrary);
}

export function setPublicLearningEnabled(enabled: boolean): Promise<PublicLearningLibrary> {
  if (!enabled) generation += 1;
  return serial(async () => {
    const { fs, root } = storage();
    if (enabled) {
      await fs.makeDirectoryAsync(root, { intermediates: true });
      await fs.writeAsStringAsync(`${root}enabled`, '1');
    } else await fs.deleteAsync(root, { idempotent: true });
    return readLibrary();
  });
}

export function clearPublicLearningDownloads(): Promise<PublicLearningLibrary> {
  generation += 1;
  return serial(async () => {
    const { fs, root } = storage();
    for (const guide of PUBLIC_LEARNING_GUIDES) {
      await fs.deleteAsync(`${root}${guide.id}.json`, { idempotent: true });
      await fs.deleteAsync(`${root}${guide.id}.pending`, { idempotent: true });
    }
    return readLibrary();
  });
}

export async function purgePublicLearningForSignOut(): Promise<void> {
  generation += 1;
  // Older dev clients without the filesystem could never create downloads.
  if (!loadFileSystem()?.documentDirectory) return;
  await setPublicLearningEnabled(false);
}

export function downloadPublicLearningGuide(id: string): Promise<PublicLearningLibrary> {
  const requestedGeneration = generation;
  return serial(async () => {
    const guide = PUBLIC_LEARNING_GUIDES.find((item) => item.id === id);
    if (!guide) throw new Error('This guide is not approved for download.');
    if (!PUBLIC_SITE_ORIGIN) throw new Error('Offline guide downloads are not available yet.');
    if (requestedGeneration !== generation) throw new Error('Download canceled.');
    const library = await readLibrary();
    if (!library.enabled) throw new Error('Turn on offline availability first.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      // Fixed public source, no auth or cookies. Never accept a caller URL.
      const response = await fetch(`${PUBLIC_SITE_ORIGIN}/learning/${guide.id}.json`, {
        signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
      }).catch(() => { throw new Error(controller.signal.aborted ? 'The download timed out. Try again when connected.' : 'The download could not connect. Check your connection and try again.'); });
      if (response.status === 404) throw new Error('This guide is not available to download yet. Try again later.');
      if (!response.ok) throw new Error('The guide service is unavailable. Try again later.');
      const declared = Number(response.headers.get('content-length'));
      if (declared > 16_384) throw new Error('This download is too large.');
      const text = await response.text().catch(() => { throw new Error('The download was interrupted. Try again when connected.'); });
      if (text.length > 16_384) throw new Error('This download is too large.');
      let downloaded: Record<string, unknown>;
      try { downloaded = JSON.parse(text) as Record<string, unknown>; }
      catch { throw new Error('This guide could not be read. Try again later.'); }
      const record = { ...downloaded, downloadedAt: Date.now() };
      if (readablePublicDownload(record, Date.now())?.id !== guide.id) throw new Error('This guide has changed. Update the app before downloading it.');
      if (requestedGeneration !== generation) throw new Error('Download canceled.');
      const { fs, root } = storage();
      const path = `${root}${guide.id}`;
      await fs.writeAsStringAsync(`${path}.pending`, JSON.stringify(record));
      if (requestedGeneration !== generation) {
        await fs.deleteAsync(`${path}.pending`, { idempotent: true });
        throw new Error('Download canceled.');
      }
      await fs.moveAsync({ from: `${path}.pending`, to: `${path}.json` });
      if (requestedGeneration !== generation) {
        await fs.deleteAsync(`${path}.json`, { idempotent: true });
        throw new Error('Download canceled.');
      }
      return readLibrary();
    } finally { clearTimeout(timeout); }
  });
}
