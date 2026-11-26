import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  files: new Map<string, string>(),
  purgeNotes: vi.fn(async (): Promise<void> => undefined), purgePublic: vi.fn(async (): Promise<void> => undefined),
  suspend: vi.fn(),
  available: true, documentDirectory: 'file:///documents/' as string | null,
  writeFails: false, deleteFails: false,
  deleteGate: null as Promise<void> | null, deleting: false,
}));
vi.mock('./offlineAvailability', () => ({ purgeOfflineAvailability: harness.purgeNotes, suspendOfflineAvailability: harness.suspend }));
vi.mock('./publicLearningDownloads', () => ({ purgePublicLearningForSignOut: harness.purgePublic }));
vi.mock('./optionalFileSystem', () => ({ loadFileSystem: () => harness.available ? ({
  documentDirectory: harness.documentDirectory,
  getInfoAsync: async (path: string) => ({ exists: harness.files.has(path) }),
  writeAsStringAsync: async (path: string, body: string) => {
    if (harness.writeFails) throw new Error('marker write failed');
    harness.files.set(path, body);
  },
  deleteAsync: async (path: string) => {
    harness.deleting = true;
    if (harness.deleteGate) await harness.deleteGate;
    if (harness.deleteFails) throw new Error('marker deletion failed');
    harness.files.delete(path);
  },
}) : null }));
const marker = 'file:///documents/offline-signout-cleanup-v1';
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); harness.files.clear();
  harness.purgeNotes.mockReset().mockResolvedValue(undefined);
  harness.purgePublic.mockReset().mockResolvedValue(undefined);
  harness.available = true; harness.documentDirectory = 'file:///documents/';
  harness.writeFails = false; harness.deleteFails = false;
  harness.deleteGate = null; harness.deleting = false;
});

describe('durable post-sign-out offline cleanup', () => {
  it('keeps public downloads on an ordinary signed-out cold start', async () => {
    const service = await import('./offlineSignOutCleanup');
    await service.retryPendingOfflineSignOutCleanup(() => true);
    expect(harness.purgeNotes).not.toHaveBeenCalled();
    expect(harness.purgePublic).not.toHaveBeenCalled();
  });
  it('purges both stores and clears the marker only after both succeed', async () => {
    const service = await import('./offlineSignOutCleanup');
    await service.requestOfflineSignOutCleanup();
    expect(harness.purgeNotes).toHaveBeenCalledOnce();
    expect(harness.purgePublic).toHaveBeenCalledOnce();
    expect(harness.files.has(marker)).toBe(false);
  });
  it.each(['module', 'documentDirectory'])('purges both stores without an optional filesystem %s', async (missing) => {
    if (missing === 'module') harness.available = false;
    else harness.documentDirectory = null;
    const service = await import('./offlineSignOutCleanup');
    await expect(service.requestOfflineSignOutCleanup()).resolves.toBeUndefined();
    expect(harness.suspend).toHaveBeenCalledOnce();
    expect(harness.purgeNotes).toHaveBeenCalledOnce();
    expect(harness.purgePublic).toHaveBeenCalledOnce();
    await service.retryPendingOfflineSignOutCleanup();
    expect(harness.purgeNotes).toHaveBeenCalledOnce();
    expect(harness.purgePublic).toHaveBeenCalledOnce();
  });
  it('retries a failed encrypted purge without the optional filesystem', async () => {
    harness.available = false;
    harness.purgeNotes.mockRejectedValueOnce(new Error('locked keychain'));
    const service = await import('./offlineSignOutCleanup');
    await expect(service.requestOfflineSignOutCleanup()).rejects.toThrow('cleanup is still pending');
    expect(harness.purgeNotes).toHaveBeenCalledOnce();
    expect(harness.purgePublic).toHaveBeenCalledOnce();
    await service.retryPendingOfflineSignOutCleanup();
    expect(harness.purgeNotes).toHaveBeenCalledTimes(2);
    expect(harness.purgePublic).toHaveBeenCalledTimes(2);
  });
  it('still attempts both purges when the retry marker cannot be written', async () => {
    harness.writeFails = true;
    const service = await import('./offlineSignOutCleanup');
    await service.requestOfflineSignOutCleanup();
    expect(harness.purgeNotes).toHaveBeenCalledOnce();
    expect(harness.purgePublic).toHaveBeenCalledOnce();
    await service.retryPendingOfflineSignOutCleanup();
    expect(harness.purgeNotes).toHaveBeenCalledOnce();
  });
  it.each(['module', 'documentDirectory'])('retries failed cleanup after a signed-out cold restart without filesystem %s', async (missing) => {
    if (missing === 'module') harness.available = false;
    else harness.documentDirectory = null;
    let service = await import('./offlineSignOutCleanup');
    harness.purgeNotes.mockRejectedValueOnce(new Error('locked keychain'));
    await expect(service.requestOfflineSignOutCleanup()).rejects.toThrow('cleanup is still pending');
    vi.resetModules();
    service = await import('./offlineSignOutCleanup');
    await service.retryPendingOfflineSignOutCleanup(() => true);
    expect(harness.purgeNotes).toHaveBeenCalledTimes(2);
    expect(harness.purgePublic).toHaveBeenCalledTimes(2);
  });
  it('keeps cold-start cleanup failing until encrypted storage recovers', async () => {
    harness.available = false;
    harness.purgeNotes.mockRejectedValue(new Error('locked keychain'));
    let service = await import('./offlineSignOutCleanup');
    await expect(service.requestOfflineSignOutCleanup()).rejects.toThrow('cleanup is still pending');
    vi.resetModules();
    service = await import('./offlineSignOutCleanup');
    await expect(service.retryPendingOfflineSignOutCleanup(() => true)).rejects.toThrow('cleanup is still pending');
    expect(harness.purgePublic).toHaveBeenCalledTimes(2);
    harness.purgeNotes.mockResolvedValue(undefined);
    await service.retryPendingOfflineSignOutCleanup(() => true);
    expect(harness.purgeNotes).toHaveBeenCalledTimes(3);
    expect(harness.purgePublic).toHaveBeenCalledTimes(3);
  });
  it('preserves signed-in notes on an ordinary filesystem-free foreground check', async () => {
    harness.available = false;
    const service = await import('./offlineSignOutCleanup');
    await service.retryPendingOfflineSignOutCleanup(() => false);
    expect(harness.purgeNotes).not.toHaveBeenCalled();
    expect(harness.purgePublic).not.toHaveBeenCalled();
    expect(harness.suspend).not.toHaveBeenCalled();
  });
  it('rechecks signed-out ownership when a queued cold retry starts', async () => {
    harness.available = false;
    let finishPurge: (() => void) | undefined;
    harness.purgeNotes.mockImplementationOnce(() => new Promise<void>((resolve) => { finishPurge = resolve; }));
    const service = await import('./offlineSignOutCleanup');
    const request = service.requestOfflineSignOutCleanup();
    await vi.waitFor(() => expect(harness.purgeNotes).toHaveBeenCalledOnce());
    let signedOut = true;
    const retry = service.retryPendingOfflineSignOutCleanup(() => signedOut);
    signedOut = false;
    finishPurge!();
    await Promise.all([request, retry]);
    expect(harness.purgeNotes).toHaveBeenCalledOnce();
    expect(harness.purgePublic).toHaveBeenCalledOnce();
  });
  it('retains pending cleanup when public deletion fails and still purges notes', async () => {
    harness.purgePublic.mockRejectedValueOnce(new Error('public deletion failed'));
    const service = await import('./offlineSignOutCleanup');
    await expect(service.requestOfflineSignOutCleanup()).rejects.toThrow('cleanup is still pending');
    expect(harness.purgeNotes).toHaveBeenCalledOnce();
    expect(harness.files.get(marker)).toBe('pending');
    await service.retryPendingOfflineSignOutCleanup();
    expect(harness.purgeNotes).toHaveBeenCalledTimes(2);
    expect(harness.purgePublic).toHaveBeenCalledTimes(2);
    expect(harness.files.has(marker)).toBe(false);
  });
  it('retries after marker deletion fails even though both stores were purged', async () => {
    harness.deleteFails = true;
    const service = await import('./offlineSignOutCleanup');
    await expect(service.requestOfflineSignOutCleanup()).rejects.toThrow('marker deletion failed');
    expect(harness.purgeNotes).toHaveBeenCalledOnce();
    expect(harness.purgePublic).toHaveBeenCalledOnce();
    expect(harness.files.get(marker)).toBe('pending');
    harness.deleteFails = false;
    await service.retryPendingOfflineSignOutCleanup();
    expect(harness.purgeNotes).toHaveBeenCalledTimes(2);
    expect(harness.files.has(marker)).toBe(false);
  });
  it('retains the retry marker across a cold process restart after keychain failure', async () => {
    let service = await import('./offlineSignOutCleanup');
    harness.purgeNotes.mockRejectedValueOnce(new Error('locked keychain'));
    await expect(service.requestOfflineSignOutCleanup()).rejects.toThrow('cleanup is still pending');
    expect(harness.purgePublic).toHaveBeenCalledOnce();
    expect(harness.files.get(marker)).toBe('pending');
    vi.resetModules();
    service = await import('./offlineSignOutCleanup');
    await service.retryPendingOfflineSignOutCleanup();
    expect(harness.purgeNotes).toHaveBeenCalledTimes(2);
    expect(harness.files.has(marker)).toBe(false);
  });
  it('does not drop a sign-out request that arrives during a normal foreground check', async () => {
    const service = await import('./offlineSignOutCleanup');
    await Promise.all([service.retryPendingOfflineSignOutCleanup(), service.requestOfflineSignOutCleanup()]);
    expect(harness.purgeNotes).toHaveBeenCalled();
    expect(harness.purgePublic).toHaveBeenCalled();
    expect(harness.files.has(marker)).toBe(false);
  });
});

// BUG-UG-OFFLINE-CLEANUP-QUEUED-PENDING-LOSS-20261020 (Grok on #5455): an
// older marker-free cleanup that succeeds after a newer sign-out request was
// queued must not clear the newer obligation.
describe('queued sign-out obligations without a durable marker', () => {
  it.each(['module', 'documentDirectory'])('keeps a newer failed purge pending when the filesystem %s is missing', async (missing) => {
    if (missing === 'module') harness.available = false;
    else harness.documentDirectory = null;
    const service = await import('./offlineSignOutCleanup');
    let releaseOlder: () => void = () => undefined;
    harness.purgeNotes.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseOlder = resolve; }));
    const older = service.retryPendingOfflineSignOutCleanup(() => true);
    await vi.waitFor(() => expect(harness.purgeNotes).toHaveBeenCalledTimes(1));

    harness.purgeNotes.mockRejectedValueOnce(new Error('encrypted purge failed'));
    const newer = service.requestOfflineSignOutCleanup();
    releaseOlder();
    await expect(older).resolves.toBeUndefined();
    await expect(newer).rejects.toThrow(service.OFFLINE_CLEANUP_MESSAGE);
    expect(harness.purgeNotes).toHaveBeenCalledTimes(2);

    // A continuing failure keeps the obligation and its diagnosis.
    harness.purgeNotes.mockRejectedValueOnce(new Error('encrypted purge failed again'));
    await expect(service.retryPendingOfflineSignOutCleanup()).rejects.toThrow(service.OFFLINE_CLEANUP_MESSAGE);
    expect(harness.purgeNotes).toHaveBeenCalledTimes(3);
    expect(harness.purgePublic).toHaveBeenCalledTimes(3);

    // Storage recovers: the next retry attempts both purges and completes it.
    await expect(service.retryPendingOfflineSignOutCleanup()).resolves.toBeUndefined();
    expect(harness.purgeNotes).toHaveBeenCalledTimes(4);
    expect(harness.purgePublic).toHaveBeenCalledTimes(4);

    // The obligation is done: an ordinary signed-in foreground keeps its notes.
    await service.retryPendingOfflineSignOutCleanup();
    expect(harness.purgeNotes).toHaveBeenCalledTimes(4);
  });

  it('still lets the newer request complete when the older cleanup succeeds first', async () => {
    harness.available = false;
    const service = await import('./offlineSignOutCleanup');
    let releaseOlder: () => void = () => undefined;
    harness.purgeNotes.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseOlder = resolve; }));
    const older = service.retryPendingOfflineSignOutCleanup(() => true);
    await vi.waitFor(() => expect(harness.purgeNotes).toHaveBeenCalledTimes(1));
    const newer = service.requestOfflineSignOutCleanup();
    releaseOlder();
    await expect(Promise.all([older, newer])).resolves.toEqual([undefined, undefined]);
    expect(harness.purgeNotes).toHaveBeenCalledTimes(2);
    await service.retryPendingOfflineSignOutCleanup();
    expect(harness.purgeNotes).toHaveBeenCalledTimes(2);
  });
  it('keeps a newer obligation when it arrives while an older cleanup deletes its marker', async () => {
    const service = await import('./offlineSignOutCleanup');
    let releaseDelete: () => void = () => undefined;
    harness.deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const older = service.requestOfflineSignOutCleanup();
    await vi.waitFor(() => expect(harness.deleting).toBe(true));

    harness.writeFails = true;
    harness.purgeNotes.mockRejectedValueOnce(new Error('encrypted purge failed'));
    const newer = service.requestOfflineSignOutCleanup();
    harness.deleteGate = null;
    releaseDelete();
    await expect(older).resolves.toBeUndefined();
    await expect(newer).rejects.toThrow(service.OFFLINE_CLEANUP_MESSAGE);
    expect(harness.files.has(marker)).toBe(false);

    // Neither a marker nor a stale success may drop the obligation.
    harness.writeFails = false;
    await expect(service.retryPendingOfflineSignOutCleanup()).resolves.toBeUndefined();
    expect(harness.purgeNotes).toHaveBeenCalledTimes(3);
    expect(harness.purgePublic).toHaveBeenCalledTimes(3);
  });
});
