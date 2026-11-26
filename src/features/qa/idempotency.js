// One idempotency key per Q&A operation, bound to the exact content it
// submitted. A retry with byte-equal content reuses the key so duplicate
// clicks and lost responses replay safely; a retry with changed content gets
// a fresh key so the server commits the edit instead of replaying the
// earlier submission. Only fields the server commits belong in the
// fingerprint.
export function qaContentFingerprint({ title = null, body = null } = {}) {
  return JSON.stringify([title ?? null, body ?? null]);
}

export function qaIdempotencyKeyFor(keys, operation, fingerprint) {
  const current = keys.get(operation);
  if (current && current.fingerprint === fingerprint) return current.key;
  const key = crypto.randomUUID();
  keys.set(operation, { fingerprint, key });
  return key;
}
