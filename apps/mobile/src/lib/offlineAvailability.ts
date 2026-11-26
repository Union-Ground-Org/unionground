// Bounded personal learning notes only. Public downloads have a separate,
// account-free filesystem service in publicLearningDownloads.ts. This schema
// cannot retain protected server records, evidence, ballots or queued writes.

export type OfflineScope = {
  accountID: string;
  organizationID: string;
};

export type OfflineDraft = {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
};

export type OfflineAvailabilitySnapshot = {
  enabled: boolean;
  drafts: OfflineDraft[];
  bytes: number;
};

export type OfflineDraftInput = {
  id?: string;
  body: string;
  expectedRevision?: number;
};

export type PersistedOfflineRecord = {
  version: 1;
  accountID: string;
  organizationID: string;
  enabled: boolean;
  drafts: OfflineDraft[];
};

export type OfflineLimits = {
  readonly maxDrafts: number;
  readonly maxDraftBodyChars: number;
  readonly draftMaxAgeMs: number;
  readonly maxTotalBytes: number;
  readonly maxScopeIDChars: number;
  readonly clockSkewToleranceMs: number;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

export const OFFLINE_LIMITS: OfflineLimits = {
  maxDrafts: 4,
  maxDraftBodyChars: 500,
  draftMaxAgeMs: 7 * DAY_MS,
  maxTotalBytes: 32_768,
  maxScopeIDChars: 64,
  // Absorbs ordinary clock jitter between a write and the next read without
  // widening the retention bound itself.
  clockSkewToleranceMs: 60_000,
};

export type OfflineAvailabilityErrorCode =
  // No encrypted device storage: web, or a device where SecureStore is absent.
  | 'unavailable'
  // Malformed scope, or a scope that is not the activated one.
  | 'scope'
  // A purge or an account/organization change invalidated the operation.
  | 'stale'
  // Offline availability has not been turned on for this scope.
  | 'disabled'
  // A count, length, or byte bound would be exceeded.
  | 'limit'
  // Draft revision conflict, or the draft is gone.
  | 'conflict'
  // Caller input violates the schema.
  | 'invalid'
  // The encrypted write could not be made durable.
  | 'storage';

export class OfflineAvailabilityError extends Error {
  readonly code: OfflineAvailabilityErrorCode;

  constructor(code: OfflineAvailabilityErrorCode, message: string) {
    super(message);
    this.name = 'OfflineAvailabilityError';
    this.code = code;
  }
}

function fail(code: OfflineAvailabilityErrorCode, message: string): never {
  throw new OfflineAvailabilityError(code, message);
}

// SecureStore keys accept alphanumerics, '.', '-' and '_'. Requiring the same
// charset of every scope identifier keeps key derivation total and injective:
// no identifier can contain the '.' separators the key layout relies on
// being ours, and none can be empty.
// Also applied to draft identifiers, which are UUIDs or slugs.
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// Control characters other than tab and newline cannot survive a round trip
// through every keyboard and reader, and lone surrogates break JSON.
const DISALLOWED_BODY_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const OFFLINE_STORAGE_PREFIX = 'org.unionground.app.offline.v1';

function validScopeID(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= OFFLINE_LIMITS.maxScopeIDChars
    && SAFE_ID_PATTERN.test(value);
}

/**
 * Rejects a scope the key layout cannot represent. Callers pass identifiers
 * straight from the session, so this is the boundary where a hostile or merely
 * unexpected identifier stops.
 */
export function validateOfflineScope(scope: OfflineScope): OfflineScope {
  if (!scope || typeof scope !== 'object') {
    fail('scope', 'Offline availability needs an account and organization.');
  }
  if (!validScopeID(scope.accountID) || !validScopeID(scope.organizationID)) {
    fail('scope', 'Offline availability needs a valid account and organization.');
  }
  return { accountID: scope.accountID, organizationID: scope.organizationID };
}

export function sameOfflineScope(left: OfflineScope | null, right: OfflineScope | null): boolean {
  if (!left || !right) return left === right;
  return left.accountID === right.accountID && left.organizationID === right.organizationID;
}

/**
 * Per-account and per-organization keyspace. Both identifiers are already
 * restricted to a charset without '.', so the separators below cannot be
 * forged from inside an identifier and two different scopes cannot collide.
 */
export function offlineScopeKey(scope: OfflineScope): string {
  const validated = validateOfflineScope(scope);
  return `${OFFLINE_STORAGE_PREFIX}.a-${validated.accountID}.o-${validated.organizationID}`;
}

/**
 * JSON restricted to ASCII.
 *
 * Every character above 0x7E becomes a `\uXXXX` escape, which is still valid
 * JSON, so `JSON.parse` reverses this with no custom decoder. The point is
 * that one character is then exactly one stored byte, which lets the service
 * chunk the payload under a conservative 2048-byte keychain value budget by counting
 * characters, and lets `bytes` report real stored size rather than an estimate.
 */
export function asciiJSON(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007F-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * FNV-1a over the ASCII payload. Not a security hash: it exists so a read can
 * notice a torn or partially written chunk set instead of parsing a splice of
 * two generations.
 */
export function payloadChecksum(payload: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The allowlist for locally authored content: personal learning notes, bounded
 * in length and free of characters that cannot survive storage.
 */
export function validateDraftBody(body: string): string {
  if (typeof body !== 'string' || body.trim().length === 0) {
    fail('invalid', 'A learning note needs some text.');
  }
  if (body.length > OFFLINE_LIMITS.maxDraftBodyChars) {
    fail(
      'limit',
      `A learning note can hold up to ${OFFLINE_LIMITS.maxDraftBodyChars} characters.`,
    );
  }
  if (DISALLOWED_BODY_PATTERN.test(body) || LONE_SURROGATE_PATTERN.test(body)) {
    fail('invalid', 'A learning note cannot contain those characters.');
  }
  return body;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validDraft(value: unknown): value is OfflineDraft {
  if (!value || typeof value !== 'object') return false;
  const draft: Partial<OfflineDraft> = value as Partial<OfflineDraft>;
  return typeof draft.id === 'string' && SAFE_ID_PATTERN.test(draft.id) && draft.id.length <= 64
    && typeof draft.body === 'string'
    && draft.body.trim().length > 0
    && draft.body.length <= OFFLINE_LIMITS.maxDraftBodyChars
    && !DISALLOWED_BODY_PATTERN.test(draft.body)
    && finiteTimestamp(draft.createdAt)
    && finiteTimestamp(draft.updatedAt)
    && draft.updatedAt >= draft.createdAt
    && typeof draft.revision === 'number'
    && Number.isInteger(draft.revision)
    && draft.revision >= 1;
}

export function emptyOfflineSnapshot(): OfflineAvailabilitySnapshot {
  return { enabled: false, drafts: [], bytes: 0 };
}

export function emptyOfflineRecord(scope: OfflineScope): PersistedOfflineRecord {
  const validated = validateOfflineScope(scope);
  return {
    version: 1,
    accountID: validated.accountID,
    organizationID: validated.organizationID,
    enabled: false,
    drafts: [],
  };
}

/**
 * Reads a persisted payload back into a record.
 *
 * Malformed data is never fatal and is never trusted. An unreadable or foreign
 * envelope yields null, which the service reports as "nothing stored"; an
 * envelope that parses keeps only the entries that individually satisfy the
 * schema, so one corrupt draft cannot take the other three with it.
 *
 * A record whose embedded scope does not match the requested scope is treated
 * as foreign and discarded rather than merged.
 */
export function parseOfflineRecord(payload: string, scope: OfflineScope): PersistedOfflineRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const envelope: Partial<PersistedOfflineRecord> = parsed as Partial<PersistedOfflineRecord>;
  if (envelope.version !== 1) return null;
  if (envelope.accountID !== scope.accountID || envelope.organizationID !== scope.organizationID) {
    return null;
  }
  if (typeof envelope.enabled !== 'boolean') return null;

  const drafts: OfflineDraft[] = Array.isArray(envelope.drafts)
    ? envelope.drafts.filter(validDraft)
    : [];

  return {
    version: 1,
    accountID: scope.accountID,
    organizationID: scope.organizationID,
    enabled: envelope.enabled,
    drafts: dedupeByID(drafts),
  };
}

function dedupeByID<T extends { id: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    kept.push(entry);
  }
  return kept;
}

// Every access enforces seven days from creation and rejects future timestamps.
// Editing cannot extend retention. Bounds remain enforced without a running timer.
export function pruneOfflineRecord(
  record: PersistedOfflineRecord,
  nowMs: number,
): PersistedOfflineRecord {
  if (!record.enabled) {
    return { ...record, drafts: [] };
  }
  const horizon = nowMs + OFFLINE_LIMITS.clockSkewToleranceMs;

  const drafts = record.drafts
    .filter((draft) => draft.createdAt <= horizon && draft.updatedAt <= horizon)
    .filter((draft) => draft.createdAt + OFFLINE_LIMITS.draftMaxAgeMs > nowMs)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, OFFLINE_LIMITS.maxDrafts);

  return { ...record, drafts };
}

export function serializeOfflineRecord(record: PersistedOfflineRecord): string {
  return asciiJSON(record);
}

// Stored payload bytes exclude keychain/encryption overhead.
export function offlineSnapshot(record: PersistedOfflineRecord): OfflineAvailabilitySnapshot {
  return {
    enabled: record.enabled,
    drafts: record.drafts.map((draft) => ({ ...draft })),
    bytes: record.enabled ? serializeOfflineRecord(record).length : 0,
  };
}

/**
 * Creates or edits a personal learning note.
 *
 * Conflict handling is strict because the same note can be open in more than
 * one place in the app:
 *
 *   - Creating (no `id`) must not carry an `expectedRevision` other than 0.
 *   - Editing (with `id`) must carry the `expectedRevision` the editor loaded.
 *     Omitting it is a conflict, not a blind overwrite, so an editor that
 *     never read the current revision cannot clobber a newer body.
 *   - Editing a note that is gone — deleted elsewhere, or expired between the
 *     editor opening and saving — is a conflict. Saving would otherwise
 *     resurrect a note past its retention bound.
 *
 * `createdAt` is copied forward unchanged on every edit; only `updatedAt` and
 * `revision` move.
 */
export function applyOfflineDraftSave(
  record: PersistedOfflineRecord,
  input: OfflineDraftInput,
  nowMs: number,
  generateID: () => string,
): { record: PersistedOfflineRecord; draft: OfflineDraft } {
  if (!record.enabled) {
    fail('disabled', 'Turn on offline availability before writing a learning note.');
  }
  const body = validateDraftBody(input.body);

  if (input.id === undefined) {
    if (input.expectedRevision !== undefined && input.expectedRevision !== 0) {
      fail('conflict', 'That learning note no longer exists on this phone.');
    }
    if (record.drafts.length >= OFFLINE_LIMITS.maxDrafts) {
      fail(
        'limit',
        `This phone can hold ${OFFLINE_LIMITS.maxDrafts} learning notes. Delete one to write another.`,
      );
    }
    const id = generateID();
    if (!SAFE_ID_PATTERN.test(id) || id.length > 64) {
      fail('invalid', 'The learning note could not be given an identifier.');
    }
    if (record.drafts.some((draft) => draft.id === id)) {
      fail('conflict', 'The learning note could not be given a unique identifier.');
    }
    const draft: OfflineDraft = {
      id,
      body,
      createdAt: nowMs,
      updatedAt: nowMs,
      revision: 1,
    };
    return withDraft({ ...record, drafts: [draft, ...record.drafts] }, draft);
  }

  const existing = record.drafts.find((draft) => draft.id === input.id);
  if (!existing) {
    fail('conflict', 'That learning note is no longer on this phone.');
  }
  if (input.expectedRevision === undefined) {
    fail('conflict', 'Reopen that learning note before saving it again.');
  }
  if (existing.revision !== input.expectedRevision) {
    fail('conflict', 'That learning note changed elsewhere in the app. Reopen it and try again.');
  }
  const draft: OfflineDraft = {
    id: existing.id,
    body,
    // Immutable: the seven-day bound is measured from first authorship, so an
    // edit must not restart it.
    createdAt: existing.createdAt,
    updatedAt: nowMs,
    revision: existing.revision + 1,
  };
  const drafts = record.drafts.map((entry) => (entry.id === draft.id ? draft : entry));
  return withDraft({ ...record, drafts }, draft);
}

function withDraft(
  record: PersistedOfflineRecord,
  draft: OfflineDraft,
): { record: PersistedOfflineRecord; draft: OfflineDraft } {
  if (serializeOfflineRecord(record).length > OFFLINE_LIMITS.maxTotalBytes) {
    fail('limit', 'This phone has no room left for another learning note.');
  }
  return { record, draft };
}

export function applyOfflineDraftDelete(
  record: PersistedOfflineRecord,
  id: string,
): PersistedOfflineRecord {
  return { ...record, drafts: record.drafts.filter((draft) => draft.id !== id) };
}
