import stamp from "../../content/legal/release-stamp.json";
import { legalPendingDirectoryPresent } from "../../content/legal/pending/directory.js";
import { currentLegalVersions } from "./legalInstruments.js";
import { publishWebLegalPath, TERMS_RECEIPT_PATH } from "./legalReleaseGate.js";
import { bundledPendingTexts } from "./legalPending";
import { fetchLegalDeployment } from "./legalReleaseGate.js";

// Pending declarations shipped to web and native. The directory on disk is the
// source; tests/legal-release-batching.test.js requires this list to match
// every content/legal/pending/*.json file. The server reads that directory
// itself. An empty list is the readable baseline, not a missing directory.

export function legalReleaseFilesFromStamp(parsedStamp, pendingTexts) {
  if (parsedStamp == null || typeof parsedStamp !== "object" || Array.isArray(parsedStamp) || !Array.isArray(pendingTexts)) {
    return { pendingDirectoryPresent: false, pendingTexts: null, stampText: null };
  }
  return {
    pendingDirectoryPresent: true,
    pendingTexts: pendingTexts.slice(),
    stampText: JSON.stringify(parsedStamp),
  };
}

export function bundledLegalReleaseFiles() {
  if (!legalPendingDirectoryPresent) return { pendingDirectoryPresent: false, pendingTexts: null, stampText: null };
  return legalReleaseFilesFromStamp(stamp, bundledPendingTexts());
}

export function publishWebTermsReceipt(operation, files = bundledLegalReleaseFiles()) {
  return publishWebLegalPath(TERMS_RECEIPT_PATH, files, operation);
}

// The versions the web page is about to publish. A closed gate throws so the
// caller records nothing; the thrown error is the closed publication, not a
// claim about the person.
export function publishedWebVersions(instruments, files = bundledLegalReleaseFiles()) {
  const publication = publishWebTermsReceipt(() => currentLegalVersions(instruments), files);
  if (!publication.ran) throw new Error("legal release is not published");
  return publication.result;
}

export async function loadPublishedWebVersions(instruments, files = bundledLegalReleaseFiles(), fetcher = globalThis.fetch) {
  const deployment = await fetchLegalDeployment(files, fetcher);
  return publishedWebVersions(instruments, { ...files, deployment });
}
