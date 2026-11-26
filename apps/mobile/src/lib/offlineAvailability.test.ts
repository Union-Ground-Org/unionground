import { describe, expect, it } from 'vitest';

import {
  OFFLINE_LIMITS,
  OfflineAvailabilityError,
  applyOfflineDraftDelete,
  applyOfflineDraftSave,
  asciiJSON,
  emptyOfflineRecord,
  offlineScopeKey,
  offlineSnapshot,
  parseOfflineRecord,
  payloadChecksum,
  pruneOfflineRecord,
  sameOfflineScope,
  serializeOfflineRecord,
  validateDraftBody,
  validateOfflineScope,
  type OfflineAvailabilityErrorCode,
  type OfflineDraft,
  type OfflineScope,
  type PersistedOfflineRecord,
} from './offlineAvailability';

const scope: OfflineScope = {
  accountID: '4f0f5f36-2b3a-4c31-9a4d-7f6a2b1c9d00',
  organizationID: 'chapter-alpha',
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = 1_800_000_000_000;

function enabledRecord(): PersistedOfflineRecord {
  return { ...emptyOfflineRecord(scope), enabled: true };
}

function codeOf(run: () => unknown): OfflineAvailabilityErrorCode | 'no-throw' {
  try {
    run();
  } catch (error) {
    return error instanceof OfflineAvailabilityError ? error.code : 'no-throw';
  }
  return 'no-throw';
}

function draft(overrides: Partial<OfflineDraft> = {}): OfflineDraft {
  return {
    id: 'note-1',
    body: 'A personal learning note.',
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
    ...overrides,
  };
}

describe('offline scope contract', () => {
  it('accepts identifiers the key layout can represent and refuses the rest', () => {
    expect(validateOfflineScope(scope)).toEqual(scope);
    expect(codeOf(() => validateOfflineScope({ accountID: '', organizationID: 'a' }))).toBe('scope');
    // A dot would forge the separators the key layout relies on owning.
    expect(codeOf(() => validateOfflineScope({ accountID: 'a.b', organizationID: 'a' }))).toBe('scope');
    expect(codeOf(() => validateOfflineScope({ accountID: 'a b', organizationID: 'a' }))).toBe('scope');
    expect(codeOf(() => validateOfflineScope({ accountID: '-lead', organizationID: 'a' }))).toBe('scope');
    expect(codeOf(() => validateOfflineScope({
      accountID: 'a'.repeat(OFFLINE_LIMITS.maxScopeIDChars + 1),
      organizationID: 'a',
    }))).toBe('scope');
  });

  it('gives every account and organization pair its own keyspace', () => {
    const a = offlineScopeKey({ accountID: 'acct1', organizationID: 'org1' });
    const b = offlineScopeKey({ accountID: 'acct1', organizationID: 'org2' });
    const c = offlineScopeKey({ accountID: 'acct2', organizationID: 'org1' });
    expect(new Set([a, b, c]).size).toBe(3);
    // Neither identifier can contain a dot, so no pair can be rearranged into
    // another pair's key.
    expect(offlineScopeKey({ accountID: 'acct1-o', organizationID: 'org1' })).not.toBe(a);
    for (const key of [a, b, c]) expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('compares scopes by both halves', () => {
    expect(sameOfflineScope(scope, { ...scope })).toBe(true);
    expect(sameOfflineScope(scope, { ...scope, organizationID: 'chapter-beta' })).toBe(false);
    expect(sameOfflineScope(null, null)).toBe(true);
    expect(sameOfflineScope(scope, null)).toBe(false);
  });
});

describe('ascii payload encoding', () => {
  it('round-trips non-ascii text while keeping every stored character one byte', () => {
    const value = { body: 'año — 支部 \u{1F600}', tab: 'a\tb\nc' };
    const encoded = asciiJSON(value);
    expect(encoded).toMatch(/^[\x20-\x7E]*$/);
    expect(JSON.parse(encoded)).toEqual(value);
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(encoded.length);
  });

  it('detects a payload that changed under a checksum', () => {
    const payload = asciiJSON({ a: 1, b: 'two' });
    expect(payloadChecksum(payload)).toBe(payloadChecksum(payload));
    expect(payloadChecksum(payload)).not.toBe(payloadChecksum(`${payload} `));
    expect(payloadChecksum('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('personal learning note validation', () => {
  it('bounds length and rejects characters storage cannot carry', () => {
    expect(validateDraftBody('remember to ask about the schedule')).toBe('remember to ask about the schedule');
    expect(validateDraftBody('a'.repeat(OFFLINE_LIMITS.maxDraftBodyChars))).toHaveLength(500);
    expect(codeOf(() => validateDraftBody('a'.repeat(OFFLINE_LIMITS.maxDraftBodyChars + 1)))).toBe('limit');
    expect(codeOf(() => validateDraftBody('   '))).toBe('invalid');
    expect(codeOf(() => validateDraftBody('bad\u0000byte'))).toBe('invalid');
    expect(codeOf(() => validateDraftBody('lone \uD800 surrogate'))).toBe('invalid');
    // Tabs, newlines and paired surrogates are ordinary note text.
    expect(() => validateDraftBody('line\nnext\tcell \u{1F600}')).not.toThrow();
  });
});

describe('persisted record parsing', () => {
  it('reads back a record it wrote', () => {
    const record: PersistedOfflineRecord = {
      ...enabledRecord(),
      drafts: [draft()],
    };
    expect(parseOfflineRecord(serializeOfflineRecord(record), scope)).toEqual(record);
  });

  it('treats unreadable or foreign envelopes as nothing stored', () => {
    expect(parseOfflineRecord('not json', scope)).toBeNull();
    expect(parseOfflineRecord('[]', scope)).toBeNull();
    expect(parseOfflineRecord('"a string"', scope)).toBeNull();
    expect(parseOfflineRecord(asciiJSON({ ...enabledRecord(), version: 2 }), scope)).toBeNull();
    expect(parseOfflineRecord(asciiJSON({ ...enabledRecord(), enabled: 'yes' }), scope)).toBeNull();
    // Another account's record restored into this keyspace is not merged.
    const foreign = { ...enabledRecord(), accountID: 'someone-else' };
    expect(parseOfflineRecord(asciiJSON(foreign), scope)).toBeNull();
    const foreignOrg = { ...enabledRecord(), organizationID: 'chapter-beta' };
    expect(parseOfflineRecord(asciiJSON(foreignOrg), scope)).toBeNull();
  });

  it('drops individually invalid entries and keeps the rest', () => {
    const payload = asciiJSON({
      ...enabledRecord(),
      drafts: [
        draft({ id: 'keep-me' }),
        draft({ id: 'no-body', body: '   ' }),
        draft({ id: 'backwards', createdAt: NOW, updatedAt: NOW - 1 }),
        draft({ id: 'bad-revision', revision: 0 }),
        { id: 'not-a-draft' },
      ],
    });
    const parsed = parseOfflineRecord(payload, scope);
    expect(parsed?.drafts.map((entry) => entry.id)).toEqual(['keep-me']);
  });

  it('keeps the first of duplicated identifiers', () => {
    const payload = asciiJSON({
      ...enabledRecord(),
      drafts: [draft({ body: 'first' }), draft({ body: 'second' })],
    });
    const parsed = parseOfflineRecord(payload, scope);
    expect(parsed?.drafts).toHaveLength(1);
    expect(parsed?.drafts[0]?.body).toBe('first');
  });
});

describe('retention', () => {
  it('drops notes past seven days', () => {
    const record: PersistedOfflineRecord = {
      ...enabledRecord(),
      drafts: [
        draft({ id: 'fresh', createdAt: NOW - 6 * DAY_MS, updatedAt: NOW - DAY_MS }),
        draft({ id: 'lapsed', createdAt: NOW - 8 * DAY_MS, updatedAt: NOW - DAY_MS }),
      ],
    };
    const pruned = pruneOfflineRecord(record, NOW);
    expect(pruned.drafts.map((entry) => entry.id)).toEqual(['fresh']);
  });

  it('drops entries stamped in the future rather than trusting a rolled-back clock', () => {
    const record: PersistedOfflineRecord = {
      ...enabledRecord(),
      drafts: [
        draft({ id: 'future-note', createdAt: NOW + 10 * DAY_MS, updatedAt: NOW + 10 * DAY_MS }),
        draft({ id: 'jitter', createdAt: NOW + 5_000, updatedAt: NOW + 5_000 }),
      ],
    };
    const pruned = pruneOfflineRecord(record, NOW);
    // Ordinary clock jitter inside the tolerance survives; a real rollback does not.
    expect(pruned.drafts.map((entry) => entry.id)).toEqual(['jitter']);
  });
});

describe('personal note application', () => {
  const nextID = (value: string) => () => value;

  it('creates a note at revision 1 and enforces the count cap', () => {
    let record = enabledRecord();
    for (let index = 0; index < OFFLINE_LIMITS.maxDrafts; index += 1) {
      record = applyOfflineDraftSave(record, { body: `note ${index}` }, NOW + index, nextID(`n${index}`)).record;
    }
    expect(record.drafts).toHaveLength(OFFLINE_LIMITS.maxDrafts);
    expect(record.drafts[0]?.revision).toBe(1);
    expect(codeOf(() => applyOfflineDraftSave(record, { body: 'one more' }, NOW, nextID('n9')))).toBe('limit');
  });

  it('keeps createdAt fixed across edits and moves only updatedAt and revision', () => {
    const created = applyOfflineDraftSave(enabledRecord(), { body: 'first' }, NOW, nextID('note-a'));
    const edited = applyOfflineDraftSave(
      created.record,
      { id: 'note-a', body: 'second', expectedRevision: 1 },
      NOW + 3 * DAY_MS,
      nextID('unused'),
    );
    expect(edited.draft.createdAt).toBe(NOW);
    expect(edited.draft.updatedAt).toBe(NOW + 3 * DAY_MS);
    expect(edited.draft.revision).toBe(2);
    expect(edited.draft.body).toBe('second');

    // The seven-day bound is measured from authorship, so the edit did not
    // buy the note more time.
    expect(pruneOfflineRecord(edited.record, NOW + 8 * DAY_MS).drafts).toHaveLength(0);
  });

  it('rejects every shape of revision conflict', () => {
    const created = applyOfflineDraftSave(enabledRecord(), { body: 'first' }, NOW, nextID('note-a')).record;

    // A second editor that loaded revision 1 after someone else saved revision 2.
    const advanced = applyOfflineDraftSave(
      created,
      { id: 'note-a', body: 'second', expectedRevision: 1 },
      NOW + 1,
      nextID('unused'),
    ).record;
    expect(codeOf(() => applyOfflineDraftSave(
      advanced,
      { id: 'note-a', body: 'third', expectedRevision: 1 },
      NOW + 2,
      nextID('unused'),
    ))).toBe('conflict');

    // An editor that never read a revision may not blind-overwrite.
    expect(codeOf(() => applyOfflineDraftSave(
      advanced,
      { id: 'note-a', body: 'blind' },
      NOW + 3,
      nextID('unused'),
    ))).toBe('conflict');

    // A note deleted in another part of the app is not resurrected.
    const deleted = applyOfflineDraftDelete(advanced, 'note-a');
    expect(codeOf(() => applyOfflineDraftSave(
      deleted,
      { id: 'note-a', body: 'back from the dead', expectedRevision: 2 },
      NOW + 4,
      nextID('unused'),
    ))).toBe('conflict');

    // A note that expired between opening the editor and saving is likewise gone.
    const expired = pruneOfflineRecord(created, NOW + 8 * DAY_MS);
    expect(codeOf(() => applyOfflineDraftSave(
      expired,
      { id: 'note-a', body: 'late save', expectedRevision: 1 },
      NOW + 8 * DAY_MS,
      nextID('unused'),
    ))).toBe('conflict');

    // Creating never carries a revision other than none.
    expect(codeOf(() => applyOfflineDraftSave(
      enabledRecord(),
      { body: 'new', expectedRevision: 4 },
      NOW,
      nextID('note-b'),
    ))).toBe('conflict');
  });

  it('requires the opt-in and a usable generated identifier', () => {
    expect(codeOf(() => applyOfflineDraftSave(
      emptyOfflineRecord(scope), { body: 'x' }, NOW, nextID('note-a'),
    ))).toBe('disabled');
    expect(codeOf(() => applyOfflineDraftSave(
      enabledRecord(), { body: 'x' }, NOW, nextID('bad id.with dots'),
    ))).toBe('invalid');
  });

  it('deletes idempotently without disturbing another note', () => {
    const created = applyOfflineDraftSave(enabledRecord(), { body: 'first' }, NOW, nextID('note-a')).record;
    const cleared = created;
    expect(applyOfflineDraftDelete(cleared, 'note-a').drafts).toHaveLength(0);
    expect(applyOfflineDraftDelete(cleared, 'never-existed').drafts).toHaveLength(1);
  });
});

describe('snapshot projection', () => {

  it('reports no storage in use while offline availability is off', () => {
    const snapshot = offlineSnapshot(emptyOfflineRecord(scope));
    expect(snapshot).toEqual({ enabled: false, drafts: [], bytes: 0 });
  });

  it('copies notes out rather than sharing the stored array', () => {
    const record = applyOfflineDraftSave(enabledRecord(), { body: 'first' }, NOW, () => 'note-a').record;
    const snapshot = offlineSnapshot(record);
    const mutable = snapshot.drafts[0];
    if (mutable) mutable.body = 'mutated by the caller';
    expect(record.drafts[0]?.body).toBe('first');
  });
});

describe('bounded note projection', () => {
  it('caps parsed notes and reports only the encrypted note payload bytes', () => {
    const record = { ...enabledRecord(), drafts: Array.from({ length: 12 }, (_, index) => draft({ id: `note-${index}`, createdAt: NOW - index, updatedAt: NOW - index })) };
    const bounded = pruneOfflineRecord(record, NOW);
    expect(bounded.drafts).toHaveLength(OFFLINE_LIMITS.maxDrafts);
    expect(bounded.drafts[0]?.id).toBe('note-0');
    expect(offlineSnapshot(bounded).bytes).toBe(serializeOfflineRecord(bounded).length);
    expect(pruneOfflineRecord({ ...record, enabled: false }, NOW).drafts).toEqual([]);
  });
  it('drops fields outside the note schema instead of retaining a server snapshot or download', () => {
    const parsed = parseOfflineRecord(JSON.stringify({ ...enabledRecord(), drafts: [draft()], downloads: [{ body: 'unreviewed' }], dashboard: { evidence: 'private' } }), scope);
    expect(parsed).toEqual({ ...enabledRecord(), drafts: [draft()] });
  });
});
