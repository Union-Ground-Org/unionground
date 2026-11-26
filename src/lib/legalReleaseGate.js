// A path named by a pending legal file stays off until the release that
// publishes it is the text running on this deployment and the database pack
// for that release has been verified. Administrator overrides, environment
// values and remote flags are not consulted. A missing or unreadable pending
// directory or release stamp is pending-unreadable, so the path stays off.

export const TERMS_RECEIPT_PATH = "terms-receipt";
const HASH = /^[a-f0-9]{64}$/;
const INSTRUMENTS = ["privacy-policy", "terms-of-use", "accessibility-statement", "ai-disclosure", "retention-schedule"];
const KINDS = ["collection", "use", "sharing", "retention"];
function validDate(value) {
  const timestamp = typeof value === "string" ? Date.parse(`${value}T12:00:00Z`) : NaN;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function validLegalReleaseStamp(stamp) {
  if (!stamp || stamp.schema !== 1 || stamp.generatorVersion !== "legal-release-1" || !Object.hasOwn(stamp, "release") || !stamp.surfaces || typeof stamp.surfaces !== "object" || Array.isArray(stamp.surfaces)) return false;
  const required = ["src/lib/legalInstruments.js", "src/lib/legalContent.js", "apps/mobile/src/lib/legalInstrumentText.ts", "apps/mobile/src/lib/legalDocuments.ts", "src/data/telemetryDisclosure.json", "docs/legal/telemetry-disclosure-20261010.md", "docs/legal/data-policy-20261009.md", "docs/legal/data-policy-20261009-es.md", "src/lib/i18n.js#legal-lines", "src/lib/i18n/es.js#legal-lines", "config/legal-catalogue-pins", "config/telemetry-disclosure-sources.d", "legal-validator"];
  if (Object.keys(stamp.surfaces).length !== required.length || required.some((key) => !HASH.test(stamp.surfaces[key]))) return false;
  if (stamp.release === null) return true;
  const r = stamp.release;
  return !!r && r.generatorVersion === stamp.generatorVersion && /^[a-f0-9]{40}$/.test(r.baseCommit)
    && /^\d{14}$/.test(r.migrationId) && validDate(r.date) && validDate(r.privacyEffective) && r.privacyEffective <= r.date
    && HASH.test(r.migrationSha256) && HASH.test(r.contentSha256)
    && Array.isArray(r.consumed) && r.consumed.length > 0
    && r.consumed.every((entry) => /^[\w.-]+\.json$/.test(entry.name) && HASH.test(entry.sha256))
    && INSTRUMENTS.every((key) => /^\d+\.\d+\.\d+$/.test(r.versions?.[key]) && typeof r.material?.[key] === "boolean")
    && Array.isArray(r.gatedPaths) && r.gatedPaths.every((path) => typeof path.id === "string" && path.id.length > 0 && KINDS.includes(path.kind) && /^\d{14}$/.test(path.releaseId));
}

function closedLegalReleaseContext() {
  return { pending: [], gatedPaths: [], pendingUnreadable: true };
}

// `files` is the read of content/legal/pending and the release stamp.
// Anything missing, unreadable, or not the expected JSON shape fails closed.
export function legalReleaseContextFromFiles(files) {
  if (!files || files.pendingDirectoryPresent !== true || typeof files.stampText !== "string" || !Array.isArray(files.pendingTexts)) {
    return closedLegalReleaseContext();
  }
  try {
    const pending = [];
    for (const text of files.pendingTexts) {
      if (typeof text !== "string") return closedLegalReleaseContext();
      const parsed = JSON.parse(text);
      if (!parsed || parsed.schema !== 1 || typeof parsed.recordId !== "string" || !parsed.instruments || typeof parsed.instruments !== "object" || Array.isArray(parsed.instruments) || (parsed.paths !== undefined && !Array.isArray(parsed.paths)) || (parsed.paths || []).some((path) => !path.id || !KINDS.includes(path.kind) || !path.release)) return closedLegalReleaseContext();
      pending.push(parsed);
    }
    const stamp = JSON.parse(files.stampText);
    if (!validLegalReleaseStamp(stamp)) return closedLegalReleaseContext();
    const gated = stamp.release == null ? [] : (stamp.release.gatedPaths ?? []);
    if (!Array.isArray(gated)) return closedLegalReleaseContext();
    return { pending, gatedPaths: gated, pendingUnreadable: false, releaseId: stamp.release?.migrationId || null, stampJson: JSON.stringify(stamp), deployment: files.deployment };
  } catch {
    return closedLegalReleaseContext();
  }
}

export function decideLegalPath(pathId, input = {}) {
  const pending = Array.isArray(input.pending) ? input.pending : [];
  if (input.pendingUnreadable === true) return { enabled: false, reason: "pending-unreadable" };
  const held = pending.some((file) => (file.paths || []).some((path) => path.id === pathId));
  if (held) return { enabled: false, reason: "pending-release" };
  const gated = (input.gatedPaths || []).find((path) => path.id === pathId);
  if (!gated && !input.releaseId) return { enabled: true, reason: "open" };
  const releaseId = gated?.releaseId || input.releaseId;
  const bound = input.stampJson && input.deployment?.stampJson === input.stampJson;
  const live = bound && input.deployment?.liveReleaseIds?.includes(releaseId) === true;
  const verified = bound && input.deployment?.verifiedPackReleaseIds?.includes(releaseId) === true;
  if (!live || !verified) return { enabled: false, reason: "release-not-live" };
  return { enabled: true, reason: "released" };
}

// A proof comes from this deployment, over the same trusted origin as its
// public legal pack. Caller flags and environment overrides are never proof.
/** @returns {Promise<{stampJson: string, liveReleaseIds: string[], verifiedPackReleaseIds: string[]} | null>} */
export async function fetchLegalDeployment(files, fetcher = globalThis.fetch, origin = "") {
  const context = legalReleaseContextFromFiles(files);
  if (context.pendingUnreadable || !context.releaseId) return null;
  try {
    const response = await fetcher(`${origin}/api/legal-pack?publication=1`, { cache: "no-store", credentials: "omit", redirect: "error" });
    if (!response.ok) return null;
    const proof = await response.json();
    return proof?.stampJson === context.stampJson ? proof : null;
  } catch { return null; }
}

/**
 * @param {string} plane
 * @param {string} pathId
 * @param {object} input
 * @param {() => unknown} operation
 * @returns {{ ran: boolean, plane: string, reason: string, result?: unknown }}
 */
export function runLegalOperation(plane, pathId, input, operation) {
  const decision = decideLegalPath(pathId, input);
  if (!decision.enabled) return { ran: false, plane, reason: decision.reason };
  return { ran: true, plane, reason: decision.reason, result: operation() };
}

function runWebLegalOperation(pathId, input, operation) {
  return runLegalOperation("web", pathId, input, operation);
}

export function publishWebLegalPath(pathId, files, operation) {
  return runWebLegalOperation(pathId, legalReleaseContextFromFiles(files), operation);
}

export function runNativeLegalOperation(pathId, input, operation) {
  return runLegalOperation("native", pathId, input, operation);
}
