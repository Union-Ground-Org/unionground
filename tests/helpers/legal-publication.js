import stamp from "../../content/legal/release-stamp.json";
import { bundledLegalReleaseFiles, publishedWebVersions } from "../../src/lib/legalReleaseBundle.js";

// The proof /api/legal-pack?publication=1 returns once the bundled legal
// release is live on the deployment and its legal pack is verified in that
// deployment's database.
// Tests that render an acceptance surface stand in for that deployment here;
// production must obtain the proof from legal-pack.
export function publishedLegalDeployment() {
  const releaseId = stamp.release?.migrationId;
  return { stampJson: JSON.stringify(stamp), liveReleaseIds: releaseId ? [releaseId] : [], verifiedPackReleaseIds: releaseId ? [releaseId] : [] };
}

export function publishedLegalReleaseFiles() {
  return { ...bundledLegalReleaseFiles(), deployment: publishedLegalDeployment() };
}

// What loadPublishedWebVersions resolves to on a deployment with that proof:
// the real gate, run against the bundled stamp and the proof above.
export async function publishedVersionsWithProof(instruments) {
  return publishedWebVersions(instruments, publishedLegalReleaseFiles());
}
