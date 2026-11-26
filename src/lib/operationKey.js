// One operation key per write intent, kept across every attempt of that
// intent. A server that deduplicates by key (a row id, an event key, a
// provider Idempotency-Key) applies a write once only when the retry after a
// lost response carries the key of the first try; a key minted per call
// turns that retry into a second request, reminder or message
// (SYS-UG-SHARED-RETRY-IDEMPOTENCY-GUARD-20261113).
function defaultRandomUUID() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  throw Object.assign(new Error("secure id generator unavailable"), { code: "UUID_UNAVAILABLE" });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, stable(value[name])]));
  }
  return value;
}

// The same operation with the same fields is the same intent, whatever the
// order the fields were written in. Undefined fields are dropped, as JSON does.
export function operationIntent(operation, fields = {}) {
  if (typeof operation !== "string" || !operation.trim()) throw new TypeError("An operation intent needs an operation name");
  return `${operation}:${JSON.stringify(stable(fields))}`;
}

// The server checks the key's shape (most functions take a uuid); the client
// only refuses a source that produced no key at all.
function mintedKey(value) {
  if (typeof value !== "string" || !value) throw new Error("The UUID source produced no operation key");
  return value;
}

// A kept key is for retrying the attempt that just failed, not for a later
// write with the same fields: past this age a new key is minted, so a server
// that remembers an old key cannot answer a new alert, request or contact
// with the old one (review of #8648).
export const OPERATION_KEY_MAX_AGE_MS = 10 * 60_000;

// Hold this for the lifetime of a form, screen or adapter. keyFor returns the
// intent's pending key while it is younger than maxAgeMs, or mints one; settle
// forgets it once the server has answered, so a deliberate second submission
// is a new operation. mint gives a key for a write that keeps none, where the
// server already merges a repeat.
export function createOperationKeys(randomUUID = defaultRandomUUID, { maxAgeMs = OPERATION_KEY_MAX_AGE_MS, now = Date.now } = {}) {
  if (typeof randomUUID !== "function") throw new TypeError("A UUID source is required for operation keys");
  const keys = new Map();
  const current = (intent) => {
    const held = keys.get(intent);
    return held && now() - held.at < maxAgeMs ? held.key : null;
  };
  return Object.freeze({
    keyFor(intent) {
      const held = current(intent);
      if (held) return held;
      const key = mintedKey(randomUUID());
      keys.set(intent, { key, at: now() });
      return key;
    },
    pending(intent) {
      return current(intent);
    },
    mint() {
      return mintedKey(randomUUID());
    },
    settle(intent) {
      keys.delete(intent);
    },
    clear() {
      keys.clear();
    },
  });
}

// Runs one attempt of an intent with its kept key. A failure keeps the key, so
// the next attempt (a person's retry or the caller's own) reuses it; only an
// answer from the server settles the intent.
export async function withOperationKey(keys, intent, send) {
  const result = await send(keys.keyFor(intent));
  keys.settle(intent);
  return result;
}
