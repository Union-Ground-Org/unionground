// Server side of the shared operation key (src/lib/operationKey.js). A write
// endpoint reads the caller's key, never mints its own, and hands it on
// unchanged to the database function or provider that deduplicates by it.
const SAFE_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function headerValue(request, name) {
  const value = request?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

// The body field wins over the Idempotency-Key header; an absent or malformed
// key is null, so the endpoint refuses the write instead of inventing one.
// uuid: true holds the key to the uuid columns most database functions take.
export function readOperationKey(request, { field = "idempotencyKey", uuid = false } = {}) {
  const raw = request?.body?.[field] ?? headerValue(request, "idempotency-key");
  const key = String(raw ?? "").trim();
  return (uuid ? UUID_KEY : SAFE_KEY).test(key) ? key : null;
}
