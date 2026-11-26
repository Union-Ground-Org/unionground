import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The fake keychain below is deliberately strict: it enforces the real
 * SecureStore key charset, a conservative 2048-byte value ceiling, and the
 * requirement that every write names WHEN_UNLOCKED_THIS_DEVICE_ONLY. A test
 * that would have written a plaintext-sized blob, an illegal key, or a value
 * under a weaker accessibility class records a violation rather than passing.
 */
const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  const violations: string[] = [];
  const state = {
    available: true,
    platformOS: 'ios',
    uuid: 0,
    getErrorPattern: null as RegExp | null,
    getHoldPattern: null as RegExp | null,
    getHold: null as Promise<void> | null,
    // null means unlimited; otherwise the number of writes left before the
    // keychain starts failing, which models an interrupted write.
    setBudget: null as number | null,
    // Writes matching this pattern resolve without storing, which models a
    // keychain that reports success but does not persist.
    dropPattern: null as RegExp | null,
    // Suspends the first write matching holdPattern so a purge can be raced
    // against an operation that is already mid-write.
    holdPattern: null as RegExp | null,
    hold: null as Promise<void> | null,
  };
  return { store, violations, state };
});

vi.mock('react-native', () => ({
  Platform: { get OS() { return mocks.state.platformOS; } },
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    mocks.state.uuid += 1;
    return `11111111-2222-4333-8444-00000000000${mocks.state.uuid.toString(16)}`;
  },
}));

vi.mock('expo-secure-store', () => {
  const assertKey = (key: string) => {
    if (typeof key !== 'string' || key.length === 0 || !/^[A-Za-z0-9._-]+$/.test(key)) {
      mocks.violations.push(`illegal key: ${String(key)}`);
    }
  };
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-device-only',
    WHEN_UNLOCKED: 'when-unlocked',
    isAvailableAsync: async () => mocks.state.available,
    getItemAsync: async (key: string) => {
      assertKey(key);
      if (mocks.state.getErrorPattern?.test(key)) throw new Error("keychain temporarily locked");
      if (mocks.state.getHoldPattern?.test(key) && mocks.state.getHold) {
        const hold = mocks.state.getHold; mocks.state.getHold = null; await hold;
      }
      return mocks.store.get(key) ?? null;
    },
    setItemAsync: async (key: string, value: string, options?: { keychainAccessible?: string }) => {
      assertKey(key);
      if (mocks.state.holdPattern?.test(key) && mocks.state.hold) {
        const hold = mocks.state.hold;
        mocks.state.hold = null;
        await hold;
      }
      if (typeof value !== 'string') mocks.violations.push(`non-string value at ${key}`);
      if (Buffer.byteLength(value, 'utf8') > 2_048) {
        mocks.violations.push(`value over the 2048-byte limit at ${key}`);
      }
      if (options?.keychainAccessible !== 'when-unlocked-device-only') {
        mocks.violations.push(`weak accessibility at ${key}: ${String(options?.keychainAccessible)}`);
      }
      if (mocks.state.setBudget !== null) {
        if (mocks.state.setBudget <= 0) throw new Error('keychain write interrupted');
        mocks.state.setBudget -= 1;
      }
      if (mocks.state.dropPattern?.test(key)) return;
      mocks.store.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      assertKey(key);
      mocks.store.delete(key);
    },
  };
});

import {
  OFFLINE_LIMITS,
  OfflineAvailabilityError,
  activateOfflineScope as activateScope,
  deleteOfflineLearningDraft,
  purgeOfflineAvailability,
  readOfflineAvailability,
  resetOfflineAvailabilityStateForTests,
  saveOfflineLearningDraft,
  setOfflineAvailability,
  suspendOfflineAvailability,
  type OfflineAvailabilityErrorCode,
  type OfflineScope,
} from './offlineAvailability';

import { payloadChecksum } from '../lib/offlineAvailability';

const AUTHORIZATION_ID = '11111111-1111-4111-8111-111111111111';
function activateOfflineScope(scope: OfflineScope | null, authorizationID = AUTHORIZATION_ID) {
  return activateScope(scope, authorizationID);
}

const PREFIX = 'org.unionground.app.offline.v1';
const DAY_MS = 24 * 60 * 60 * 1_000;
const START = 1_800_000_000_000;

const alpha: OfflineScope = { accountID: 'account-a', organizationID: 'chapter-alpha' };
const beta: OfflineScope = { accountID: 'account-b', organizationID: 'chapter-alpha' };
const alphaOtherOrg: OfflineScope = { accountID: 'account-a', organizationID: 'chapter-beta' };

let now = START;

function storedKeys(): string[] {
  return [...mocks.store.keys()].filter((key) => key.startsWith(PREFIX) && !key.endsWith('.authorization')).sort();
}

function scopeKeys(scope: OfflineScope): string[] {
  const base = `${PREFIX}.a-${scope.accountID}.o-${scope.organizationID}`;
  return storedKeys().filter((key) => key.startsWith(`${base}.`));
}

/** Everything the keychain holds for a scope, as one payload. */
function storedPayload(scope: OfflineScope): string {
  const base = `${PREFIX}.a-${scope.accountID}.o-${scope.organizationID}`;
  const raw = mocks.store.get(`${base}.manifest`);
  if (!raw) return '';
  const manifest: { slot: string; chunks: number } = JSON.parse(raw);
  let payload = '';
  for (let index = 0; index < manifest.chunks; index += 1) {
    payload += mocks.store.get(`${base}.${manifest.slot}.${index}`) ?? '';
  }
  return payload;
}

async function codeOf(run: () => Promise<unknown>): Promise<OfflineAvailabilityErrorCode | 'no-throw'> {
  try {
    await run();
  } catch (error) {
    return error instanceof OfflineAvailabilityError ? error.code : 'no-throw';
  }
  return 'no-throw';
}

function tick(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

async function enable(scope: OfflineScope): Promise<void> {
  await activateOfflineScope(scope);
  await setOfflineAvailability(scope, true);
}

beforeEach(async () => {
  mocks.store.clear();
  mocks.violations.length = 0;
  mocks.state.available = true;
  mocks.state.platformOS = 'ios';
  mocks.state.uuid = 0;
  mocks.state.getErrorPattern = null;
  mocks.state.getHoldPattern = null;
  mocks.state.getHold = null;
  mocks.state.setBudget = null;
  mocks.state.dropPattern = null;
  mocks.state.holdPattern = null;
  mocks.state.hold = null;
  now = START;
  resetOfflineAvailabilityStateForTests();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await activateOfflineScope(alpha);
});

afterEach(() => {
  // Every completed test must have written only legal, device-only values.
  expect(mocks.violations).toEqual([]);
  vi.restoreAllMocks();
});

describe('encrypted storage requirement', () => {
  it('refuses every operation on web instead of falling back to plaintext', async () => {
    mocks.state.platformOS = 'web';

    expect(await codeOf(() => readOfflineAvailability(alpha))).toBe('unavailable');
    expect(await codeOf(() => setOfflineAvailability(alpha, true))).toBe('unavailable');
    expect(await codeOf(() => saveOfflineLearningDraft(alpha, { body: 'note' }))).toBe('unavailable');
    expect(await codeOf(() => deleteOfflineLearningDraft(alpha, 'note-1'))).toBe('unavailable');
    expect(storedKeys()).toEqual([]);

    // Sign-out must still succeed where nothing can have been stored.
    await expect(purgeOfflineAvailability()).resolves.toBeUndefined();
  });

  it('refuses on a device whose keychain reports unavailable, and recovers later', async () => {
    resetOfflineAvailabilityStateForTests();
    mocks.state.available = false;
    expect(await codeOf(() => activateOfflineScope(alpha))).toBe('unavailable');
    expect(await codeOf(() => setOfflineAvailability(alpha, true))).toBe('scope');
    expect(storedKeys()).toEqual([]);

    mocks.state.available = true;
    await activateOfflineScope(alpha);
    await expect(setOfflineAvailability(alpha, true)).resolves.toMatchObject({ enabled: true });
  });
});

describe('opt-in', () => {
  it('stores nothing and reports nothing until offline availability is turned on', async () => {
    await expect(readOfflineAvailability(alpha)).resolves.toEqual({
      enabled: false, drafts: [], bytes: 0,
    });
    expect(storedKeys()).toEqual([]);

    expect(await codeOf(() => saveOfflineLearningDraft(alpha, { body: 'note' }))).toBe('disabled');
    expect(storedKeys()).toEqual([]);
  });

  it('turning it off removes the notes from the phone', async () => {
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'a personal note' });
    expect(scopeKeys(alpha).length).toBeGreaterThan(0);

    await expect(setOfflineAvailability(alpha, false)).resolves.toEqual({
      enabled: false, drafts: [], bytes: 0,
    });
    expect(scopeKeys(alpha)).toEqual([]);
    await expect(readOfflineAvailability(alpha)).resolves.toMatchObject({ enabled: false });
  });
});

describe('personal learning notes', () => {
  it('creates, edits and deletes notes while holding createdAt fixed', async () => {
    await enable(alpha);
    const created = await saveOfflineLearningDraft(alpha, { body: 'first version' });
    expect(created.draft.revision).toBe(1);
    expect(created.draft.createdAt).toBe(START);

    now = START + 2 * DAY_MS;
    const edited = await saveOfflineLearningDraft(alpha, {
      id: created.draft.id, body: 'second version', expectedRevision: 1,
    });
    expect(edited.draft.createdAt).toBe(START);
    expect(edited.draft.updatedAt).toBe(START + 2 * DAY_MS);
    expect(edited.draft.revision).toBe(2);

    const afterDelete = await deleteOfflineLearningDraft(alpha, created.draft.id);
    expect(afterDelete.drafts).toEqual([]);
    // Deleting again is not an error.
    await expect(deleteOfflineLearningDraft(alpha, created.draft.id)).resolves.toMatchObject({ drafts: [] });
  });

  it('rejects a save that raced another editor of the same note', async () => {
    await enable(alpha);
    const created = await saveOfflineLearningDraft(alpha, { body: 'first' });

    // Two editors both loaded revision 1; the first one wins.
    await saveOfflineLearningDraft(alpha, { id: created.draft.id, body: 'editor one', expectedRevision: 1 });
    expect(await codeOf(() => saveOfflineLearningDraft(alpha, {
      id: created.draft.id, body: 'editor two', expectedRevision: 1,
    }))).toBe('conflict');

    // An editor that never read a revision may not overwrite blindly.
    expect(await codeOf(() => saveOfflineLearningDraft(alpha, {
      id: created.draft.id, body: 'blind write',
    }))).toBe('conflict');

    const current = await readOfflineAvailability(alpha);
    expect(current.drafts[0]?.body).toBe('editor one');
    expect(current.drafts[0]?.revision).toBe(2);
  });

  it('holds four notes and refuses the fifth', async () => {
    await enable(alpha);
    for (let index = 0; index < OFFLINE_LIMITS.maxDrafts; index += 1) {
      await saveOfflineLearningDraft(alpha, { body: `note ${index}` });
    }
    expect(await codeOf(() => saveOfflineLearningDraft(alpha, { body: 'one too many' }))).toBe('limit');
    expect(await codeOf(() => saveOfflineLearningDraft(alpha, {
      body: 'x'.repeat(OFFLINE_LIMITS.maxDraftBodyChars + 1),
    }))).toBe('limit');
    await expect(readOfflineAvailability(alpha)).resolves.toMatchObject({
      drafts: expect.arrayContaining([expect.objectContaining({ revision: 1 })]),
    });
  });
});

describe('expiry and clock rollback', () => {

  it('removes a note seven days after it was first written, even if edited since', async () => {
    await enable(alpha);
    const created = await saveOfflineLearningDraft(alpha, { body: 'first' });

    now = START + 6 * DAY_MS;
    await saveOfflineLearningDraft(alpha, {
      id: created.draft.id, body: 'edited near the end of its life', expectedRevision: 1,
    });
    await expect(readOfflineAvailability(alpha)).resolves.toMatchObject({ drafts: [expect.anything()] });

    // The edit did not restart the seven days.
    now = START + 7 * DAY_MS + 1_000;
    const lapsed = await readOfflineAvailability(alpha);
    expect(lapsed.drafts).toEqual([]);
    expect(storedPayload(alpha)).not.toContain('edited near the end of its life');
  });

  it('drops entries stamped ahead of the clock instead of letting a rollback extend them', async () => {
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'written before the clock moved' });

    // The device clock is wound back a month: the note now looks future-dated.
    now = START - 30 * DAY_MS;
    const snapshot = await readOfflineAvailability(alpha);
    expect(snapshot.drafts).toEqual([]);
    expect(storedPayload(alpha)).not.toContain('written before the clock moved');
  });
});

describe('durability of the encrypted record', () => {
  it('chunks a multi-chunk record under the keychain value limit and reads it back', async () => {
    await enable(alpha);
    for (let index = 0; index < OFFLINE_LIMITS.maxDrafts; index += 1) {
      await saveOfflineLearningDraft(alpha, { body: 'n'.repeat(OFFLINE_LIMITS.maxDraftBodyChars) });
    }

    const chunkKeys = scopeKeys(alpha).filter((key) => /\.[ab]\.\d+$/.test(key));
    expect(chunkKeys.length).toBeGreaterThan(1);
    for (const key of chunkKeys) {
      const value = mocks.store.get(key) ?? '';
      expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(1_600);
      // ASCII-only, so one stored character is one stored byte.
      expect(value).toMatch(/^[\x20-\x7E]*$/);
    }

    const snapshot = await readOfflineAvailability(alpha);
    expect(snapshot.drafts).toHaveLength(OFFLINE_LIMITS.maxDrafts);
    expect(snapshot.bytes).toBe(storedPayload(alpha).length);
  });

  it('leaves the previous record live when a write is interrupted partway', async () => {
    await enable(alpha);
    const committed = storedPayload(alpha);

    // The keychain accepts one more write and then starts failing.
    mocks.state.setBudget = 1;
    expect(await codeOf(() => saveOfflineLearningDraft(alpha, { body: 'lost to the interruption' })))
      .toBe('storage');

    mocks.state.setBudget = null;
    expect(storedPayload(alpha)).toBe(committed);
    const snapshot = await readOfflineAvailability(alpha);
    expect(snapshot.drafts).toEqual([]);
  });

  it('reports failure when the keychain accepts a write it does not persist', async () => {
    await enable(alpha);
    const committed = storedPayload(alpha);

    mocks.state.dropPattern = /\.[ab]\.\d+$/;
    expect(await codeOf(() => saveOfflineLearningDraft(alpha, { body: 'never lands' }))).toBe('storage');

    mocks.state.dropPattern = null;
    expect(storedPayload(alpha)).toBe(committed);
  });

  it('recovers to nothing stored when persisted data is malformed, then writes cleanly again', async () => {
    await enable(alpha);
    const base = `${PREFIX}.a-${alpha.accountID}.o-${alpha.organizationID}`;
    const manifest: { slot: string } = JSON.parse(mocks.store.get(`${base}.manifest`) ?? '{}');

    // A single flipped chunk must not read back as partial data.
    mocks.store.set(`${base}.${manifest.slot}.0`, '{"version":1,"accountID":"acc');
    await expect(readOfflineAvailability(alpha)).resolves.toEqual({
      enabled: false, drafts: [], bytes: 0,
    });

    // A garbage manifest is equally inert.
    mocks.store.set(`${base}.manifest`, 'not json at all');
    await expect(readOfflineAvailability(alpha)).resolves.toMatchObject({ enabled: false });

    // A missing chunk cannot be read as a shorter record.
    await enable(alpha);
    const rewritten: { slot: string; chunks: number } = JSON.parse(mocks.store.get(`${base}.manifest`) ?? '{}');
    mocks.store.delete(`${base}.${rewritten.slot}.${rewritten.chunks - 1}`);
    await expect(readOfflineAvailability(alpha)).resolves.toMatchObject({ enabled: false });

    // And the feature still works afterwards.
    await enable(alpha);
    await expect(saveOfflineLearningDraft(alpha, { body: 'pending reminder' })).resolves.toMatchObject({
      draft: { body: 'pending reminder', revision: 1 },
    });
  });

  it('never reads another account’s record out of this account’s keyspace', async () => {
    await enable(alpha);
    const base = `${PREFIX}.a-${alpha.accountID}.o-${alpha.organizationID}`;
    const manifest: { slot: string; chunks: number } = JSON.parse(mocks.store.get(`${base}.manifest`) ?? '{}');
    const payload = storedPayload(alpha).replace(`"accountID":"${alpha.accountID}"`, '"accountID":"account-z"');

    // Rewrite in place with a correct manifest, so only the embedded scope differs.
    expect(payload.length).toBeLessThanOrEqual(1_600 * manifest.chunks);
    mocks.store.set(`${base}.${manifest.slot}.0`, payload.slice(0, 1_600));
    for (let index = 1; index < manifest.chunks; index += 1) {
      mocks.store.set(`${base}.${manifest.slot}.${index}`, payload.slice(index * 1_600, (index + 1) * 1_600));
    }
    mocks.store.set(`${base}.manifest`, JSON.stringify({
      ...manifest, version: 1, length: payload.length, highWaterChunks: manifest.chunks,
      checksum: payloadChecksum(payload),
    }));

    // The checksum is valid but the embedded account is foreign, so the
    // record remains unreadable instead of becoming someone else's notes.
    await expect(readOfflineAvailability(alpha)).resolves.toMatchObject({ enabled: false });
  });
});

describe('account and organization isolation', () => {
  it('keeps each scope in its own keyspace when both are used', async () => {
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'alpha note' });
    await enable(alphaOtherOrg);
    await saveOfflineLearningDraft(alphaOtherOrg, { body: 'beta campaign note' });

    expect(await codeOf(() => readOfflineAvailability(alpha))).toBe('scope');
    expect(scopeKeys(alpha)).toEqual([]);
    const second = await readOfflineAvailability(alphaOtherOrg);
    expect(second.drafts[0]?.body).toBe('beta campaign note');
  });

  it('purges the previous scope and refuses it once the account changes', async () => {
    await activateOfflineScope(alpha);
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'previous account note' });
    expect(scopeKeys(alpha).length).toBeGreaterThan(0);

    await activateOfflineScope(beta);
    expect(scopeKeys(alpha)).toEqual([]);

    // The previous account is no longer addressable at all.
    expect(await codeOf(() => readOfflineAvailability(alpha))).toBe('scope');
    expect(await codeOf(() => saveOfflineLearningDraft(alpha, { body: 'late' }))).toBe('scope');
    await expect(readOfflineAvailability(beta)).resolves.toMatchObject({ enabled: false });
  });

  it('purges on an organization change within the same account', async () => {
    await activateOfflineScope(alpha);
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'campaign alpha note' });

    await activateOfflineScope(alphaOtherOrg);
    expect(scopeKeys(alpha)).toEqual([]);
    await expect(readOfflineAvailability(alphaOtherOrg)).resolves.toMatchObject({ enabled: false });
  });

  it('re-activating the same scope changes nothing', async () => {
    await activateOfflineScope(alpha);
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'still here' });

    await activateOfflineScope({ ...alpha });
    await expect(readOfflineAvailability(alpha)).resolves.toMatchObject({
      drafts: [expect.objectContaining({ body: 'still here' })],
    });
  });

  it('rejects a malformed scope without touching storage', async () => {
    expect(await codeOf(() => readOfflineAvailability({ accountID: 'a.b', organizationID: 'x' })))
      .toBe('scope');
    expect(await codeOf(() => activateOfflineScope({ accountID: '', organizationID: 'x' })))
      .toBe('scope');
    expect(storedKeys()).toEqual([]);
  });
});

describe('purge', () => {
  it('a purge that starts mid-write leaves nothing behind and the write reports it', async () => {
    await activateOfflineScope(alpha);
    await enable(alpha);

    // Suspend the save inside its first chunk write, then sign out.
    let release = () => {};
    mocks.state.hold = new Promise<void>((resolve) => { release = resolve; });
    mocks.state.holdPattern = /\.[ab]\.0$/;

    const saving = saveOfflineLearningDraft(alpha, { body: 'written as the user signs out' });
    await tick();
    const purging = purgeOfflineAvailability();
    release();

    expect(await codeOf(() => saving)).toBe('stale');
    await purging;
    // The interrupted write cannot resurrect the record behind the purge.
    expect(storedKeys()).toEqual([]);
  });

  it('a purge queued against a pending note voids it', async () => {
    await activateOfflineScope(alpha);
    await enable(alpha);

    const saving = saveOfflineLearningDraft(alpha, { body: 'pending reminder' });
    const purging = purgeOfflineAvailability();

    expect(await codeOf(() => saving)).toBe('stale');
    await purging;
    expect(storedKeys()).toEqual([]);
  });

  it('an account change voids a save already in flight for the previous account', async () => {
    await activateOfflineScope(alpha);
    await enable(alpha);

    let release = () => {};
    mocks.state.hold = new Promise<void>((resolve) => { release = resolve; });
    mocks.state.holdPattern = /\.[ab]\.0$/;

    const saving = saveOfflineLearningDraft(alpha, { body: 'belongs to the previous account' });
    await tick();
    const switching = activateOfflineScope(beta);
    release();

    expect(await codeOf(() => saving)).toBe('stale');
    await switching;
    expect(scopeKeys(alpha)).toEqual([]);
  });

  it('sign-out removes the final scope after successive account switches', async () => {
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'one' });
    await enable(beta);
    await saveOfflineLearningDraft(beta, { body: 'two' });
    await enable(alphaOtherOrg);
    await saveOfflineLearningDraft(alphaOtherOrg, { body: 'three' });
    expect(scopeKeys(alpha)).toEqual([]);
    expect(scopeKeys(beta)).toEqual([]);
    expect(scopeKeys(alphaOtherOrg).length).toBeGreaterThan(0);

    await purgeOfflineAvailability();
    expect(storedKeys()).toEqual([]);
  });

  it('a cold restart denies note access until fresh activation and purges another account', async () => {
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'private on first launch' });
    resetOfflineAvailabilityStateForTests();
    expect(await codeOf(() => readOfflineAvailability(alpha))).toBe('scope');
    expect(await codeOf(() => saveOfflineLearningDraft(alpha, { body: 'unauthorized' }))).toBe('scope');
    await activateOfflineScope(beta);
    expect(scopeKeys(alpha)).toEqual([]);
    expect(await codeOf(() => readOfflineAvailability(alpha))).toBe('scope');
    await expect(readOfflineAvailability(beta)).resolves.toMatchObject({ enabled: false });
  });

  it('a purge after sign-out blocks a write that had already been queued', async () => {
    await activateOfflineScope(alpha);
    await enable(alpha);
    const pending = saveOfflineLearningDraft(alpha, { body: 'pending reminder' });
    await purgeOfflineAvailability();
    expect(await codeOf(() => pending)).toBe('stale');
    expect(storedKeys()).toEqual([]);
    expect(await codeOf(() => readOfflineAvailability(alpha))).toBe('scope');
  });
});

describe('suspend', () => {
  it('voids work in flight without deleting the notes', async () => {
    await activateOfflineScope(alpha);
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'already committed' });
    const committed = storedPayload(alpha);

    let release = () => {};
    mocks.state.hold = new Promise<void>((resolve) => { release = resolve; });
    mocks.state.holdPattern = /\.[ab]\.0$/;

    const saving = saveOfflineLearningDraft(alpha, { body: 'interrupted by the lock' });
    await tick();
    // A lock or a lost session: stop new work, keep the member's notes.
    suspendOfflineAvailability();
    release();
    expect(await codeOf(() => saving)).toBe('stale');

    // Nothing was purged, and the previous record is still the live one.
    await activateOfflineScope(alpha);
    const snapshot = await readOfflineAvailability(alpha);
    expect(snapshot.drafts).toHaveLength(1);
    expect(snapshot.drafts[0]?.body).toBe('already committed');
    expect(storedPayload(alpha)).toBe(committed);
  });

  it('leaves no trace when the very first write for a scope is invalidated', async () => {
    await activateOfflineScope(alpha);

    let release = () => {};
    mocks.state.hold = new Promise<void>((resolve) => { release = resolve; });
    mocks.state.holdPattern = /\.[ab]\.0$/;

    // Nothing was stored for this scope yet, so the rollback has to remove the
    // record and its registry entry rather than restore a previous version.
    const enabling = setOfflineAvailability(alpha, true);
    await tick();
    suspendOfflineAvailability();
    release();
    expect(await codeOf(() => enabling)).toBe('stale');
    expect(storedKeys()).toEqual([]);
  });

  it('clears the activated scope so the next account can be activated cleanly', async () => {
    await activateOfflineScope(alpha);
    await enable(alpha);
    suspendOfflineAvailability();

    expect(await codeOf(() => readOfflineAvailability(alpha))).toBe('scope');
    expect(await codeOf(() => saveOfflineLearningDraft(alpha, { body: 'late' }))).toBe('scope');
    // The persisted registry survives suspension, so the next account also
    // purges the previous account after a cold launch or session transition.
    await activateOfflineScope(beta);
    expect(scopeKeys(alpha)).toEqual([]);

    await purgeOfflineAvailability();
    expect(storedKeys()).toEqual([]);
  });
});

describe('local-only guarantee', () => {
  it('has no network surface, so notes cannot sync or overwrite a server record', () => {
    const source = readFileSync(new URL('./offlineAvailability.ts', import.meta.url), 'utf8');
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'supabase', 'axios', 'http://', 'https://', 'WebSocket']) {
      expect(source).not.toContain(forbidden);
    }
    // The only imports are the keychain, the UUID source, the platform check
    // and this feature's own pure library.
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect([...new Set(imports)].sort()).toEqual([
      '../lib/offlineAvailability', 'expo-crypto', 'expo-secure-store', 'react-native',
    ]);
  });

  it('two devices holding the same account stay independent', async () => {
    // A second device is a second process with its own keychain; the closest
    // faithful stand-in is a full reset with its own store, which must not see
    // anything the first device wrote.
    await enable(alpha);
    const first = await saveOfflineLearningDraft(alpha, { body: 'written on phone one' });
    expect(first.draft.revision).toBe(1);

    mocks.store.clear();
    resetOfflineAvailabilityStateForTests();
    await activateOfflineScope(alpha);

    await expect(readOfflineAvailability(alpha)).resolves.toEqual({
      enabled: false, drafts: [], bytes: 0,
    });
    await enable(alpha);
    const second = await saveOfflineLearningDraft(alpha, { body: 'written on phone two' });
    // Same account, independent note, independent revision line.
    expect(second.draft.revision).toBe(1);
    expect(second.draft.id).not.toBe(first.draft.id);
  });
});


describe('cleanup index and suspended reads', () => {
  it('never reports a purge successful when the registry is unreadable or damaged', async () => {
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'must really be removed' });
    mocks.state.getErrorPattern = /\.scopes$/;
    expect(await codeOf(() => purgeOfflineAvailability())).toBe('storage');
    expect(scopeKeys(alpha).length).toBeGreaterThan(0);
    mocks.state.getErrorPattern = null;
    mocks.store.set(`${PREFIX}.scopes`, 'broken json');
    expect(await codeOf(() => purgeOfflineAvailability())).toBe('storage');
    expect(await codeOf(() => activateOfflineScope(beta))).toBe('storage');
    expect(await codeOf(() => readOfflineAvailability(alpha))).toBe('scope');
  });

  it('does not publish data unless the cleanup index was durably written', async () => {
    mocks.state.dropPattern = /\.scopes$/;
    expect(await codeOf(() => setOfflineAvailability(alpha, true))).toBe('storage');
    expect(scopeKeys(alpha)).toEqual([]);
  });

  it('purges unpublished chunks beyond a shorter live manifest', async () => {
    await enable(alpha);
    const base = `${PREFIX}.a-${alpha.accountID}.o-${alpha.organizationID}`;
    mocks.store.set(`${base}.b.19`, 'residue of interrupted larger write');
    await purgeOfflineAvailability();
    expect(storedKeys()).toEqual([]);
  });

  it('rejects a read interrupted by session suspension before returning private text', async () => {
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'authorized before the lock' });
    let release = () => {};
    mocks.state.getHold = new Promise<void>((resolve) => { release = resolve; });
    mocks.state.getHoldPattern = /\.[ab]\.0$/;
    const reading = readOfflineAvailability(alpha);
    await tick();
    suspendOfflineAvailability();
    release();
    expect(await codeOf(() => reading)).toBe('stale');
  });
});

describe('unavailable authorization scope', () => {
  it('locks notes without deleting them, then requires a fresh matching activation', async () => {
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'keep through a temporary failed campaign read' });
    const before = storedPayload(alpha);
    await activateOfflineScope(null);
    expect(await codeOf(() => readOfflineAvailability(alpha))).toBe('scope');
    expect(storedPayload(alpha)).toBe(before);
    await activateOfflineScope(alpha);
    expect((await readOfflineAvailability(alpha)).drafts[0]?.body).toBe('keep through a temporary failed campaign read');
  });
});

describe('server-session binding across failed sign-out cleanup', () => {
  it('cannot restore old notes after the same account signs in with a new session', async () => {
    await enable(alpha);
    await saveOfflineLearningDraft(alpha, { body: 'old session note' });
    resetOfflineAvailabilityStateForTests();
    mocks.state.getErrorPattern = /\.scopes$/;
    await expect(purgeOfflineAvailability()).rejects.toThrow();
    mocks.state.getErrorPattern = null;
    resetOfflineAvailabilityStateForTests();
    await activateOfflineScope(alpha, '22222222-2222-4222-8222-222222222222');
    expect((await readOfflineAvailability(alpha)).drafts).toEqual([]);
    expect(storedPayload(alpha)).not.toContain('old session note');
  });
  it('refuses activation without a fresh session binding and keeps notes locked', async () => {
    suspendOfflineAvailability();
    await expect(activateScope(alpha)).rejects.toThrow('authorized session');
    expect(await codeOf(() => readOfflineAvailability(alpha))).toBe('scope');
  });
  it('does not report a native purge successful when encrypted storage is unavailable', async () => {
    resetOfflineAvailabilityStateForTests();
    mocks.state.available = false;
    await expect(purgeOfflineAvailability()).rejects.toThrow('encrypted storage');
  });
});
