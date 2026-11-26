import { createHash } from "node:crypto";
import { connect as connectTls } from "node:tls";
import { PRIVATE_FILE_MAX_BYTES } from "./privateFileSafety.js";

const MAX_REPLY_BYTES = 4096;
const MAX_SIGNATURE_AGE_MS = 48 * 60 * 60 * 1000;
// base64 of a SHA-256 digest: 43 payload characters and one '=' pad. Anything
// else is a typo, a hex digest or a fingerprint of the wrong thing, and a
// scanner identity that is only approximately configured is not an identity.
const SPKI_PIN = /^[A-Za-z0-9+/]{43}=$/;
const ENGINE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** The complete server-only configuration this adapter requires. There is no
 * default for any of them and no plaintext fallback: an incomplete or drifted
 * configuration produces no scan and therefore no clean attestation. */
export const PRIVATE_FILE_SCANNER_ENV = Object.freeze([
  "PRIVATE_FILE_SCANNER_HOST",
  "PRIVATE_FILE_SCANNER_PORT",
  "PRIVATE_FILE_SCANNER_CA",
  "PRIVATE_FILE_SCANNER_CERT",
  "PRIVATE_FILE_SCANNER_KEY",
  "PRIVATE_FILE_SCANNER_EXPECTED_SPKI",
  "PRIVATE_FILE_SCANNER_ENGINE_MIN",
]);

// One deployment serves both hosted surfaces and host-routes its Supabase
// backend per request (api/_lib/backend.js). The scanner credential must route
// the same way or the two surfaces necessarily share one client certificate,
// and revoking SAMPLE's identity would take production down with it — the
// acceptance criterion H7 in docs/security/private-upload-activation-plan.md
// §6.1 explicitly forbids. The SAMPLE surface therefore reads its own twins.
//
// There is deliberately NO fallback from a twin to the bare production name. A
// SAMPLE deployment whose twins are unset must return 503, not silently present
// the production client certificate to the production listener: the whole point
// of the split is that one surface's material never speaks for the other.
export const SAMPLE_SCANNER_ENV_PREFIX = "SAMPLE_";
export const SAMPLE_PRIVATE_FILE_SCANNER_ENV = Object.freeze(
  PRIVATE_FILE_SCANNER_ENV.map((name) => `${SAMPLE_SCANNER_ENV_PREFIX}${name}`),
);
// Keyed by the exact `surface` value resolveSupabaseBackend() resolves. An
// unrecognised surface has no configured identity and is refused rather than
// defaulted, so a future third surface cannot inherit production's credential
// by omission.
const SCANNER_ENV_PREFIX = Object.freeze({ saas: "", demo: SAMPLE_SCANNER_ENV_PREFIX });

function failure(reason) { return new Error(`private-file-scanner-${reason}`); }

function scannerConfiguration(config) {
  if (!config || typeof config.host !== "string" || !/^[a-z0-9.-]+$/i.test(config.host)
    || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
    || ![config.ca, config.cert, config.key].every((value) => typeof value === "string" && value.trim())
    // The pin and the engine floor are as required as the key material. A CA
    // says "someone we trust signed this"; the pin says "this exact service".
    || typeof config.expectedSpki !== "string" || !SPKI_PIN.test(config.expectedSpki)
    || typeof config.engineMin !== "string" || !ENGINE_VERSION.test(config.engineMin)) {
    throw failure("configuration");
  }
  return {
    connection: {
      host: config.host, port: config.port, servername: config.host,
      ca: config.ca, cert: config.cert, key: config.key,
      rejectUnauthorized: true, minVersion: "TLSv1.2",
    },
    expectedSpki: config.expectedSpki, engineMin: config.engineMin,
  };
}

function scannerEnvPrefix(surface) {
  if (typeof surface !== "string" || !Object.hasOwn(SCANNER_ENV_PREFIX, surface)) throw failure("configuration");
  return SCANNER_ENV_PREFIX[surface];
}

/** The seven names this surface reads, in the order they are documented. */
export function privateFileScannerEnvNames(surface) {
  const prefix = scannerEnvPrefix(surface);
  return prefix ? SAMPLE_PRIVATE_FILE_SCANNER_ENV : PRIVATE_FILE_SCANNER_ENV;
}

/** Reads and validates the scanner policy from server-only environment values.
 * Callers run this before any request-derived work, so a missing or malformed
 * value is a 503 the caller cannot influence, never a partial scan.
 *
 * `surface` is the resolved backend surface for the request
 * (`resolveSupabaseBackend(request).surface`) and is required: it selects which
 * of the two credential families is read, and a caller that cannot say which
 * surface it is serving must not be handed either one. */
export function privateFileScannerPolicy(env = process.env, surface) {
  const prefix = scannerEnvPrefix(surface);
  const read = (name) => env[`${prefix}${name}`];
  const config = {
    host: read("PRIVATE_FILE_SCANNER_HOST"),
    port: Number(read("PRIVATE_FILE_SCANNER_PORT")),
    ca: read("PRIVATE_FILE_SCANNER_CA"),
    cert: read("PRIVATE_FILE_SCANNER_CERT"),
    key: read("PRIVATE_FILE_SCANNER_KEY"),
    expectedSpki: read("PRIVATE_FILE_SCANNER_EXPECTED_SPKI"),
    engineMin: read("PRIVATE_FILE_SCANNER_ENGINE_MIN"),
  };
  scannerConfiguration(config);
  return config;
}

// The pin is a digest of a public key, so it is not secret and a constant-time
// comparison would protect nothing. What matters is that a peer whose SPKI is
// not this exact value never receives a payload.
function assertScannerIdentity(socket, expectedSpki) {
  const key = socket.getPeerX509Certificate?.()?.publicKey;
  if (!key) throw failure("identity");
  let presented;
  try { presented = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("base64"); }
  catch { throw failure("identity"); }
  if (presented !== expectedSpki) throw failure("identity");
}

function exchange(payload, { connection, connect, deadlineAt, signal, expectedSpki }) {
  return new Promise((resolve, reject) => {
    let socket;
    let timer;
    let settled = false;
    let received = Buffer.alloc(0);
    const finish = (error, reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      socket?.destroy();
      if (error) reject(error);
      else resolve(reply);
    };
    const aborted = () => finish(failure("unavailable"));
    const remaining = deadlineAt - Date.now();
    if (signal?.aborted || remaining <= 0) { aborted(); return; }
    timer = setTimeout(aborted, remaining);
    signal?.addEventListener("abort", aborted, { once: true });
    try { socket = connect(connection); }
    catch { finish(failure("unavailable")); return; }
    socket.once("secureConnect", () => {
      // Post-handshake, before a single byte of command or file content is
      // written. Every exchange opens its own connection, so every exchange
      // re-proves the identity rather than trusting the first one.
      try { assertScannerIdentity(socket, expectedSpki); }
      catch (error) { finish(error); return; }
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      if (received.length + chunk.length > MAX_REPLY_BYTES) { finish(failure("invalid-reply")); return; }
      received = Buffer.concat([received, chunk]);
    });
    socket.once("end", () => {
      // A peer that hangs up without sending a single byte never answered: the
      // scanner was reachable at the TLS layer but produced no reply. This is
      // exactly the shape of a ghostunnel authorization refusal — the client
      // certificate chains to the CA and the handshake completes, then the
      // listener closes the connection because the leaf is not on its allowlist
      // — so it is an availability failure, not a malformed reply, and must be
      // classified with the connection-level "unavailable" that its `error` and
      // `close` siblings raise, deterministically regardless of whether the OS
      // delivered a clean FIN (this handler) or a reset.
      if (received.length === 0) { finish(failure("unavailable")); return; }
      // Require the whole single-command reply, including EOF, so a prefix OK
      // cannot hide a later FOUND/ERROR or a second trailing response.
      if (received.length < 2 || received.at(-1) !== 0 || received.indexOf(0) !== received.length - 1
        || !received.subarray(0, -1).every((value) => value >= 32 && value <= 126)) {
        finish(failure("invalid-reply")); return;
      }
      finish(null, received.subarray(0, -1).toString("ascii"));
    });
    socket.once("error", () => finish(failure("unavailable")));
    socket.once("close", () => finish(failure("unavailable")));
  });
}

function atLeastVersion(actual, minimum) {
  const left = actual.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function signatureIdentity(reply, now, engineMin) {
  const match = /^ClamAV (\d+\.\d+\.\d+)\/(\d+)\/((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/.exec(reply);
  if (!match) throw failure("invalid-version");
  // An engine below the reviewed floor is refused before any bytes are sent.
  // Downgrading the daemon must not silently downgrade every later verdict.
  if (!atLeastVersion(match[1], engineMin)) throw failure("engine");
  // The owned scanner service runs with TZ=UTC. Do not parse in the API host's
  // local timezone, or silently accept an undocumented scanner time format.
  const date = Date.parse(`${match[3]} GMT`);
  const version = Number(match[2]);
  if (!Number.isFinite(now) || !Number.isFinite(date) || date > now + 5 * 60 * 1000
    || now - date > MAX_SIGNATURE_AGE_MS || !Number.isSafeInteger(version) || version <= 0) {
    throw failure("stale-signatures");
  }
  return { engine: `ClamAV ${match[1]}`, signatureVersion: version, signatureDate: new Date(date).toISOString() };
}

/** Only server-owned configuration may reach this adapter. `connect` and `now`
 * are injection points for isolated protocol proofs, never request parameters.
 * Production connections authenticate both TLS peers and pin the server's
 * SubjectPublicKeyInfo; no plaintext fallback. Scanner errors throw and
 * therefore cannot produce a clean attestation.
 *
 * The resolved value is the service attestation for this scan:
 *   verdict, sha256, sizeBytes  — what was decided, about which exact bytes
 *   engine, signatureVersion, signatureDate, scannedAt — the ledger provenance
 *   scannerSpki, engineMin      — the identity and policy floor that were
 *                                 enforced as preconditions of the verdict
 * Nothing in it repeats a signature name, a parser detail or a file's content. */
export async function scanPrivateFileWithClamd(input, {
  config, signal, timeoutMs = 20000, connect = connectTls, now = Date.now,
} = {}) {
  const { connection, expectedSpki, engineMin } = scannerConfiguration(config);
  if (!(input instanceof Uint8Array) || !input.length || input.length > PRIVATE_FILE_MAX_BYTES) throw failure("size");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw failure("configuration");
  // Copy before the first await. Caller mutation cannot change the scan/hash.
  const bytes = Buffer.from(input);
  const options = { connection, connect, signal, expectedSpki, deadlineAt: Date.now() + timeoutMs };
  const before = await exchange(Buffer.from("zVERSION\0"), options);
  const identity = signatureIdentity(before, now(), engineMin);
  const parts = [Buffer.from("zINSTREAM\0")];
  for (let cursor = 0; cursor < bytes.length; cursor += 65536) {
    const chunk = bytes.subarray(cursor, cursor + 65536);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.length);
    parts.push(length, chunk);
  }
  parts.push(Buffer.alloc(4));
  const reply = await exchange(Buffer.concat(parts), options);
  let verdict;
  if (reply === "stream: OK") verdict = "clean";
  else if (/^stream: [A-Za-z0-9_.() -]+ FOUND$/.test(reply)) verdict = "blocked";
  else throw failure("invalid-verdict");
  const after = await exchange(Buffer.from("zVERSION\0"), options);
  if (after !== before) throw failure("signatures-changed");
  signatureIdentity(after, now(), engineMin);
  return {
    verdict, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length,
    ...identity, scannedAt: new Date(now()).toISOString(), scannerSpki: expectedSpki, engineMin,
  };
}
