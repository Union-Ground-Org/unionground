import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[a-zA-Z0-9_-]{1,64}$/;
const fail = () => new Error("sensitive-data-key-or-ciphertext-unavailable");
const b64 = (value) => value.toString("base64");
function decode(value, size) {
  if (typeof value !== "string" || value.length > 24 * 1024 * 1024) throw fail();
  const bytes = Buffer.from(value, "base64");
  if (b64(bytes) !== value || (size !== undefined && bytes.length !== size)) throw fail();
  return bytes;
}
function aad(context, dataVersion, wrapVersion) {
  if (!context || !UUID.test(context.organization) || !UUID.test(context.record)
    || !/^[a-z_]{1,80}$/.test(context.field) || !/^[a-z_-]{1,80}$/.test(context.purpose)
    || !UUID.test(dataVersion) || (wrapVersion !== undefined && !VERSION.test(wrapVersion))) throw fail();
  return Buffer.from(JSON.stringify(["ug-sensitive-v1", context.organization, context.record,
    context.field, context.purpose, dataVersion, ...(wrapVersion === undefined ? [] : ["wrap", wrapVersion])]));
}
function seal(bytes, key, associated) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { nonce: b64(nonce), tag: b64(cipher.getAuthTag()), ciphertext: b64(ciphertext) };
}
function open(box, key, associated) {
  const decipher = createDecipheriv("aes-256-gcm", key, decode(box.nonce, 12), { authTagLength: 16 });
  decipher.setAAD(associated);
  decipher.setAuthTag(decode(box.tag, 16));
  return Buffer.concat([decipher.update(decode(box.ciphertext)), decipher.final()]);
}
export function sensitiveKeyring(surface = "saas", env = process.env) {
  try {
    const prefix = surface === "demo" ? "SAMPLE_" : "";
    const raw = JSON.parse(env[`${prefix}SENSITIVE_DATA_KEYS`] || "null");
    const active = env[`${prefix}SENSITIVE_DATA_ACTIVE_KEY`];
    const revoked = JSON.parse(env[`${prefix}SENSITIVE_DATA_REVOKED_ORGANIZATIONS`] || "[]");
    if (!raw || Array.isArray(raw) || typeof raw !== "object" || !VERSION.test(active || "")
      || !Object.hasOwn(raw, active) || !Array.isArray(revoked) || revoked.some((id) => !UUID.test(id))) throw fail();
    const keys = new Map(Object.entries(raw).map(([version, key]) => {
      if (!VERSION.test(version)) throw fail();
      return [version, decode(key, 32)];
    }));
    if (keys.size > 32) throw fail();
    return { active, keys, revoked: new Set(revoked) };
  } catch { throw fail(); }
}
function keyFor(ring, version, context) {
  const key = ring?.keys?.get(version);
  if (!key || key.length !== 32 || ring.revoked?.has(context.organization)) throw fail();
  return key;
}
export function encryptSensitive(bytes, context, ring) {
  let dek;
  try {
    const key = keyFor(ring, ring.active, context);
    const dataVersion = randomUUID();
    dek = randomBytes(32);
    return { schema: 1, ...context, dataVersion, keyVersion: ring.active,
      payload: seal(Buffer.from(bytes), dek, aad(context, dataVersion)),
      wrappedKey: seal(dek, key, aad(context, dataVersion, ring.active)) };
  } catch { throw fail(); }
  finally { dek?.fill(0); }
}
function unwrap(envelope, context, ring) {
  if (envelope?.schema !== 1 || Object.keys(context).some((key) => envelope[key] !== context[key])) throw fail();
  const dek = open(envelope.wrappedKey, keyFor(ring, envelope.keyVersion, context), aad(context, envelope.dataVersion, envelope.keyVersion));
  if (dek.length !== 32) { dek.fill(0); throw fail(); }
  return dek;
}
// Keyring custody check (SEC-UG-ENCRYPTION-KEYRING-CUSTODY-20261016):
// proves a backed-up keyring opens an envelope's wrapped data key without
// reading the payload. The data key is zeroed before returning.
export function verifySensitiveWrap(envelope, context, ring) {
  let dek;
  try {
    dek = unwrap(envelope, context, ring);
    return true;
  } catch { return false; }
  finally { dek?.fill(0); }
}
export function decryptSensitive(envelope, context, ring) {
  let dek;
  try {
    dek = unwrap(envelope, context, ring);
    return open(envelope.payload, dek, aad(context, envelope.dataVersion));
  } catch { throw fail(); }
  finally { dek?.fill(0); }
}
export function rewrapSensitive(envelope, context, oldRing, newRing) {
  let dek;
  let verified;
  try {
    dek = unwrap(envelope, context, oldRing);
    // Authenticate the payload too: rotation must not bless damaged backups.
    verified = open(envelope.payload, dek, aad(context, envelope.dataVersion));
    const key = keyFor(newRing, newRing.active, context);
    return { ...envelope, keyVersion: newRing.active,
      wrappedKey: seal(dek, key, aad(context, envelope.dataVersion, newRing.active)) };
  } catch { throw fail(); }
  finally { dek?.fill(0); verified?.fill(0); }
}
export function migrateSensitiveValue(value, envelope, context, ring) {
  if (envelope) {
    const verified = decryptSensitive(envelope, context, ring);
    verified.fill(0);
    return envelope;
  }
  if (typeof value !== "string" || value === "[encrypted]") throw fail();
  return encryptSensitive(Buffer.from(value), context, ring);
}

// Rotation may resume across committed rows. Versions are immutable; conflicting
// custody refuses before any writes, and neither ring can lift a revocation.
export function rotationReadKeyring(oldRing, ring) {
  const keys = new Map(oldRing.keys);
  for (const [version, key] of ring.keys) {
    if (keys.has(version) && !keys.get(version).equals(key)) throw fail();
    keys.set(version, key);
  }
  return { active: ring.active, keys, revoked: new Set([...oldRing.revoked, ...ring.revoked]) };
}
