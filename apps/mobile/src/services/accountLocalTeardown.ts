export const ACCOUNT_CLEANUP_MESSAGE = 'You are signed out. Account-local cleanup is still pending on this phone; keep the app open to retry.';

type Dependencies = {
  readPending(): Promise<string | null>;
  writePending(value: string): Promise<void>;
  clearPush(userID: string, isCurrent: () => boolean): Promise<void>;
  purgeCaptures(userID: string, isCurrent: () => boolean): Promise<void>;
};

/** One serialized, durable retry ledger; it contains account IDs, never content. */
export function createAccountLocalTeardown(dependencies: Dependencies) {
  const pending = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.catch(() => undefined);
    return result;
  }
  async function hydrate() {
    const raw = await dependencies.readPending();
    if (!raw) return;
    const ids: unknown = JSON.parse(raw);
    if (!Array.isArray(ids) || ids.some((id: unknown) => typeof id !== 'string' || !id || id.length > 128)) {
      throw new Error(ACCOUNT_CLEANUP_MESSAGE);
    }
    ids.forEach((id: string) => pending.add(id));
  }
  async function persist() {
    await dependencies.writePending(JSON.stringify([...pending]));
  }
  async function clean(userID: string, isCurrent: () => boolean, pushAlreadyCleared = false, ledgerReady = true): Promise<boolean> {
    if (!isCurrent()) return false;
    let failed = false;
    if (!pushAlreadyCleared) {
      try { await dependencies.clearPush(userID, isCurrent); } catch { failed = true; }
    }
    if (!isCurrent()) return false;
    try { await dependencies.purgeCaptures(userID, isCurrent); } catch { failed = true; }
    if (!isCurrent() || failed || !ledgerReady) return false;
    pending.delete(userID);
    try { await persist(); } catch { pending.add(userID); return false; }
    return true;
  }
  return {
    request(userID: string, isCurrent: () => boolean, options?: { pushAlreadyCleared?: boolean }): Promise<boolean> {
      return serialized(async () => {
        if (!userID || !isCurrent()) return false;
        pending.add(userID);
        let ledgerReady = true;
        try { await hydrate(); await persist(); } catch { ledgerReady = false; }
        // Still attempt cleanup if writing the retry ledger failed. Memory
        // retains the obligation; the UI must not report success on this path.
        const cleanResult = await clean(userID, isCurrent, options?.pushAlreadyCleared, ledgerReady);
        if (!ledgerReady) { pending.add(userID); return false; }
        return cleanResult;
      });
    },
    retry(isCurrent: () => boolean): Promise<boolean> {
      return serialized(async () => {
        if (!isCurrent()) return false;
        try { await hydrate(); } catch { return false; }
        let complete = true;
        for (const userID of [...pending]) {
          if (!isCurrent()) return false;
          if (!(await clean(userID, isCurrent))) complete = false;
        }
        return complete;
      });
    },
  };
}
