import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { assertSurfacesMatchStamp, collectRepoHashes } from "../../scripts/lib/legal-release.mjs";
import { supabaseRpc } from "./http.js";
import {
  decideLegalPath, legalReleaseContextFromFiles, runLegalOperation, TERMS_RECEIPT_PATH,
} from "../../src/lib/legalReleaseGate.js";

export { TERMS_RECEIPT_PATH };

// Tests point this at a fixture tree. The signup handlers call it with no
// argument, which is this checkout.
export const legalReleaseIO = {
  root() {
    return process.cwd();
  },
};

export function readLegalReleaseFiles(root) {
  const pendingDir = join(root, "content/legal/pending");
  const stampPath = join(root, "content/legal/release-stamp.json");
  try {
    if (!existsSync(pendingDir) || !existsSync(stampPath)) {
      return { pendingDirectoryPresent: false, pendingTexts: null, stampText: null };
    }
    const pendingTexts = [];
    for (const name of readdirSync(pendingDir).sort()) {
      if (!name.endsWith(".json")) continue;
      pendingTexts.push(readFileSync(join(pendingDir, name), "utf8"));
    }
    return {
      pendingDirectoryPresent: true,
      pendingTexts,
      stampText: readFileSync(stampPath, "utf8"),
    };
  } catch {
    return { pendingDirectoryPresent: false, pendingTexts: null, stampText: null };
  }
}

export function loadLegalReleaseContext(root, env = process.env) {
  return {
    ...legalReleaseContextFromFiles(readLegalReleaseFiles(root)),
    ignoredEnvironment: env.LEGAL_RELEASE_FORCE || "",
  };
}

export function runServerLegalOperation(pathId, operation, extras = {}) {
  const context = legalReleaseContextFromFiles(readLegalReleaseFiles(extras.root || legalReleaseIO.root()));
  return runLegalOperation("server", pathId, {
    ...context,
    deployment: extras.deployment,
    overrides: extras.overrides,
    remoteFlags: extras.remoteFlags,
  }, operation);
}

export function publishServerTermsReceipt(operation, extras = {}) {
  return runServerLegalOperation(TERMS_RECEIPT_PATH, operation, extras);
}

export async function verifiedLegalDeployment(config, root = legalReleaseIO.root()) {
  const files = readLegalReleaseFiles(root);
  const context = legalReleaseContextFromFiles(files);
  if (context.pendingUnreadable) return null;
  try {
    const stamp = JSON.parse(files.stampText);
    assertSurfacesMatchStamp(collectRepoHashes(root), stamp);
    if (!stamp.release) return null;
    const hash = (text) => createHash("sha256").update(text).digest("hex");
    if (hash(JSON.stringify(stamp.surfaces)) !== stamp.release.contentSha256) return null;
    const migration = readFileSync(join(root, `supabase/migrations/${stamp.release.migrationId}_legal_pack_release.sql`), "utf8");
    if (hash(migration) !== stamp.release.migrationSha256) return null;
    if (!config?.supabaseUrl || !config.serviceKey) return null;
    const ready = await supabaseRpc(config.supabaseUrl, config.serviceKey, config.serviceKey, "legal_acceptance_pack_ready", { p_versions: stamp.release.versions });
    if (ready !== true) return null;
    const ids = [...new Set([stamp.release.migrationId, ...stamp.release.gatedPaths.map((path) => path.releaseId)])];
    return { stampJson: context.stampJson, liveReleaseIds: ids, verifiedPackReleaseIds: ids };
  } catch { return null; }
}

// An operation that requires published permission must have its own path in
// the verified release. A baseline stamp or release covering other paths
// cannot grant permission to collect or share data. The operation may be async:
// the result carries its promise.
export async function runVerifiedServerLegalOperation(config, pathId, operation, root = legalReleaseIO.root()) {
  const files = readLegalReleaseFiles(root);
  const context = legalReleaseContextFromFiles(files);
  const early = decideLegalPath(pathId, context);
  if (early.reason === "pending-release" || early.reason === "pending-unreadable") {
    return { ran: false, plane: "server", reason: early.reason };
  }
  if (!context.gatedPaths.some((path) => path.id === pathId)) {
    return { ran: false, plane: "server", reason: "pending-release" };
  }
  const deployment = await verifiedLegalDeployment(config, root);
  return runLegalOperation("server", pathId, { ...context, deployment }, operation);
}

export async function publishVerifiedServerTermsReceipt(config, operation, root = legalReleaseIO.root()) {
  const files = readLegalReleaseFiles(root);
  const context = legalReleaseContextFromFiles(files);
  const deployment = context.releaseId
    ? await verifiedLegalDeployment(config, root) : null;
  return runLegalOperation("server", TERMS_RECEIPT_PATH, { ...context, deployment }, operation);
}
