import { loadFileSystem } from './optionalFileSystem';
import { purgeOfflineAvailability, suspendOfflineAvailability } from './offlineAvailability';
import { purgePublicLearningForSignOut } from './publicLearningDownloads';

export const OFFLINE_CLEANUP_MESSAGE = 'You are signed out. Offline cleanup is still pending on this phone; keep the app open to retry. Notes stay locked until cleanup succeeds.';
let pending = false;
// Bumped by every sign-out request. A cleanup clears pending only when no
// newer request arrived while it ran, so an older success cannot erase a
// newer, still-unfinished obligation (Grok on #5455).
let requested = 0;
let queue: Promise<void> = Promise.resolve();

function marker() {
  const fs = loadFileSystem();
  // Encrypted notes use a separate backend and still need purging in clients
  // without this optional filesystem or its public-download retry marker.
  if (!fs?.documentDirectory) return null;
  // This flag contains no account, organization, token or note. It survives
  // deletion of public downloads and lets a cold launch retry a failed purge.
  return { fs, path: `${fs.documentDirectory}offline-signout-cleanup-v1` };
}

async function clean(): Promise<void> {
  const generation = requested;
  // Try both stores even if one fails. Neither failure may become success.
  const outcomes = await Promise.allSettled([purgeOfflineAvailability(), purgePublicLearningForSignOut()]);
  if (outcomes.some((outcome) => outcome.status === 'rejected')) throw new Error(OFFLINE_CLEANUP_MESSAGE);
  const stored = marker();
  if (generation !== requested) return;
  if (stored) await stored.fs.deleteAsync(stored.path, { idempotent: true });
  // A request can arrive while the marker deletion is in flight (Sol on #5593).
  if (generation !== requested) return;
  pending = false;
}

function attempt(action: () => Promise<void>): Promise<void> {
  const result = queue.then(action);
  queue = result.catch(() => undefined);
  return result;
}

export function requestOfflineSignOutCleanup(): Promise<void> {
  pending = true;
  requested += 1;
  suspendOfflineAvailability();
  return attempt(async () => {
    const stored = marker();
    // A signing-out session is already gone. Preserve a durable retry marker
    // where possible, and still try the encrypted purge if writing it fails.
    if (stored) await stored.fs.writeAsStringAsync(stored.path, 'pending').catch(() => undefined);
    await clean();
  });
}

export function retryPendingOfflineSignOutCleanup(isSignedOut: () => boolean = () => false): Promise<void> {
  return attempt(async () => {
    const stored = marker();
    // Without a durable marker, a confirmed signed-out launch must retry even
    // after process-local pending was lost. Check ownership inside the queue:
    // an ordinary signed-in foreground must preserve its current notes.
    if (!pending && (stored ? !(await stored.fs.getInfoAsync(stored.path)).exists : !isSignedOut())) return;
    pending = true;
    suspendOfflineAvailability();
    await clean();
  });
}
