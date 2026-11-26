import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

export const AUTHORIZED_RPC_SCHEMA_VERSION = 1;

export const REQUIRED_PROBE_DOMAINS = Object.freeze([
  "mfa-enrolled-aal1-refusal",
  "mfa-aal2-pass",
  "mfa-no-factor-non-lockout",
  "null-caller-refusal",
  "points-cap-exhausted",
  "points-cap-positive-control",
  "ballot-cross-option-refusal",
  "ballot-valid-anonymous-write",
  "ballot-repeat-vote-refusal",
  "task-number-monotonicity",
  "chapter-library-isolation",
  "intake-lifecycle",
  "authorized-source-tasks",
  "member-invitations",
  "signin-recovery",
  "device-sessions",
  "workload-intelligence",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const PROJECT_REF = /^[a-z]{20}$/;
const STAFF_ROLES = new Set(["steward", "coordinator", "advisor", "admin", "vp"]);

// Intentionally empty until the owner adds an Ed25519 verification key through
// an exact-SHA reviewed repository change. Database credentials and a checksum
// alone must never let an operator self-authorize identity impersonation.
export const TRUSTED_AUTHORIZATION_KEYS = Object.freeze({});

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${label} has unsupported field(s): ${unexpected.join(", ")}`);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requiredUuid(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!UUID.test(normalized)) throw new Error(`${label} must be a UUID`);
  return normalized;
}

function requiredDate(value, label) {
  const normalized = requiredString(value, label);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return { normalized, parsed };
}

function parseActor(actor, label) {
  exactKeys(actor, ["userId", "organizationId", "chapterId"], label);
  return {
    userId: requiredUuid(actor.userId, `${label}.userId`),
    organizationId: requiredUuid(actor.organizationId, `${label}.organizationId`),
    chapterId: requiredString(actor.chapterId, `${label}.chapterId`),
  };
}

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function authorizedRpcSigningPayload(manifest) {
  const unsigned = structuredClone(manifest);
  if (unsigned?.authorization) delete unsigned.authorization.signature;
  return canonicalJson(unsigned);
}

function verifyTrustedAuthorization(manifest, trustedPublicKeys) {
  const keyId = requiredString(manifest.authorization.keyId, "manifest.authorization.keyId");
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(keyId)) {
    throw new Error("manifest.authorization.keyId has an invalid format");
  }
  const suppliedSignature = requiredString(
    manifest.authorization.signature,
    "manifest.authorization.signature",
  );
  const signature = Buffer.from(suppliedSignature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== suppliedSignature) {
    throw new Error("manifest.authorization.signature must be a canonical Ed25519 signature");
  }
  const publicKeyPem = trustedPublicKeys?.[keyId];
  if (!publicKeyPem) throw new Error(`manifest authorization keyId is not trusted: ${keyId}`);
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`trusted authorization key ${keyId} must be Ed25519`);
  }
  if (!verifySignature(null, Buffer.from(authorizedRpcSigningPayload(manifest)), publicKey, signature)) {
    throw new Error("manifest authorization signature is invalid");
  }
  return { keyId, signature: suppliedSignature };
}

export function assertAuthorizedSupabaseEndpoint(suppliedUrl, projectRef) {
  let parsed;
  try {
    parsed = new URL(suppliedUrl);
  } catch {
    throw new Error("SUPABASE_DB_URL is not a valid connection URL");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("SUPABASE_DB_URL must use the postgres protocol");
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      "authorized RPC verification forbids connection-string query parameters or fragments",
    );
  }

  const username = decodeURIComponent(parsed.username);
  const directHost = `db.${projectRef}.supabase.co`;
  const isCanonicalDatabase = parsed.pathname === "/postgres";
  const isDirect = parsed.hostname === directHost
    && username === "postgres"
    && parsed.port === "5432"
    && isCanonicalDatabase;
  const isPooler = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(parsed.hostname)
    && username === `postgres.${projectRef}`
    && ["5432", "6543"].includes(parsed.port)
    && isCanonicalDatabase;
  if (!isDirect && !isPooler) {
    throw new Error(
      `authorized RPC verification requires the exact ${directHost}:5432/postgres direct endpoint `
      + "or a recognized Supabase pooler host on port 5432 or 6543 with database /postgres "
      + "and the exact project-qualified username",
    );
  }
  return isDirect ? "direct" : "pooler";
}

export function validateAuthorizedRpcManifest(raw, options = {}) {
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  const manifest = typeof raw === "string" ? JSON.parse(raw) : raw;
  exactKeys(manifest, ["schemaVersion", "authorization", "actors", "probeDomains"], "manifest");
  if (manifest.schemaVersion !== AUTHORIZED_RPC_SCHEMA_VERSION) {
    throw new Error(`manifest.schemaVersion must be ${AUTHORIZED_RPC_SCHEMA_VERSION}`);
  }

  exactKeys(
    manifest.authorization,
    [
      "reference", "approvedBy", "approvedAt", "expiresAt", "sourceSha", "targetProjectRef", "dataClass",
      "keyId", "signature",
    ],
    "manifest.authorization",
  );
  const trustedAuthorization = verifyTrustedAuthorization(
    manifest,
    options.trustedPublicKeys ?? TRUSTED_AUTHORIZATION_KEYS,
  );
  const approvedAt = requiredDate(manifest.authorization.approvedAt, "manifest.authorization.approvedAt");
  const expiresAt = requiredDate(manifest.authorization.expiresAt, "manifest.authorization.expiresAt");
  if (approvedAt.parsed > now) throw new Error("manifest authorization is not active yet");
  if (expiresAt.parsed <= now) throw new Error("manifest authorization has expired");
  if (expiresAt.parsed - approvedAt.parsed > 7 * 24 * 60 * 60 * 1000) {
    throw new Error("manifest authorization may cover at most seven days");
  }

  const sourceSha = requiredString(manifest.authorization.sourceSha, "manifest.authorization.sourceSha");
  if (!SHA.test(sourceSha)) throw new Error("manifest.authorization.sourceSha must be an exact commit SHA");
  if (options.expectedSha && sourceSha !== options.expectedSha) {
    throw new Error("manifest authorization does not cover the expected source SHA");
  }
  const targetProjectRef = requiredString(
    manifest.authorization.targetProjectRef,
    "manifest.authorization.targetProjectRef",
  );
  if (!PROJECT_REF.test(targetProjectRef)) throw new Error("manifest targetProjectRef must be a Supabase project ref");
  if (options.targetProjectRef && targetProjectRef !== options.targetProjectRef) {
    throw new Error("manifest authorization does not cover the guarded database target");
  }
  if (manifest.authorization.dataClass !== "legitimate-organization") {
    throw new Error("manifest.authorization.dataClass must be legitimate-organization");
  }

  exactKeys(manifest.actors, ["member", "staff", "foreignStaff"], "manifest.actors");
  const actors = {
    member: parseActor(manifest.actors.member, "manifest.actors.member"),
    staff: parseActor(manifest.actors.staff, "manifest.actors.staff"),
    foreignStaff: parseActor(manifest.actors.foreignStaff, "manifest.actors.foreignStaff"),
  };
  if (new Set(Object.values(actors).map((actor) => actor.userId)).size !== 3) {
    throw new Error("authorized actors must be three distinct identities");
  }
  if (actors.member.organizationId !== actors.staff.organizationId) {
    throw new Error("member and staff actors must belong to the same legitimate organization");
  }
  if (actors.member.chapterId !== actors.staff.chapterId) {
    throw new Error("member and staff actors must share the selected chapter for positive lifecycle probes");
  }
  if (actors.foreignStaff.organizationId === actors.member.organizationId) {
    throw new Error("foreignStaff must belong to a different legitimate organization");
  }

  if (!Array.isArray(manifest.probeDomains)) throw new Error("manifest.probeDomains must be an array");
  const domains = [...new Set(manifest.probeDomains.map((value) => requiredString(value, "probe domain")))].sort();
  const required = [...REQUIRED_PROBE_DOMAINS].sort();
  if (JSON.stringify(domains) !== JSON.stringify(required)) {
    throw new Error(`manifest.probeDomains must name the complete governed matrix: ${required.join(", ")}`);
  }

  return {
    schemaVersion: AUTHORIZED_RPC_SCHEMA_VERSION,
    authorization: {
      reference: requiredString(manifest.authorization.reference, "manifest.authorization.reference"),
      approvedBy: requiredString(manifest.authorization.approvedBy, "manifest.authorization.approvedBy"),
      approvedAt: approvedAt.normalized,
      expiresAt: expiresAt.normalized,
      sourceSha,
      targetProjectRef,
      dataClass: "legitimate-organization",
      keyId: trustedAuthorization.keyId,
      signature: trustedAuthorization.signature,
    },
    actors,
    probeDomains: required,
  };
}

export function actorMeetsRoleBoundary(actorName, roleScope = {}) {
  const chapterRoles = new Set(
    (roleScope.chapterRoles ?? []).map((role) => String(role).toLowerCase()),
  );
  const organizationRoles = new Set(
    (roleScope.organizationRoles ?? []).map((role) => String(role).toLowerCase()),
  );
  const hasStaffRole = [...chapterRoles, ...organizationRoles]
    .some((role) => STAFF_ROLES.has(role));
  if (actorName === "member") return !hasStaffRole;
  return chapterRoles.has("admin")
    && (chapterRoles.has("steward") || chapterRoles.has("coordinator"));
}

export function actorMeetsMfaBoundary(actorName, staffMfaRequired, verifiedTotpCount) {
  const count = Number(verifiedTotpCount);
  return actorName === "member"
    ? count === 0
    : staffMfaRequired === true && Number.isInteger(count) && count > 0;
}
