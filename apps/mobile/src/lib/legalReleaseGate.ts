import { bundledLegalReleaseFiles } from "../../../../src/lib/legalReleaseBundle.js";
import {
  legalReleaseContextFromFiles,
  runLegalOperation,
  TERMS_RECEIPT_PATH,
  fetchLegalDeployment,
} from "../../../../src/lib/legalReleaseGate.js";

export type LegalOperationResult = {
  ran: boolean;
  plane: string;
  reason: string;
  result?: unknown;
};

export function runNativeLegalOperation(
  pathId: string,
  input: object,
  operation: () => unknown,
): LegalOperationResult {
  return runLegalOperation("native", pathId, input, operation);
}

type LegalReleaseFiles = {
  pendingDirectoryPresent?: boolean;
  pendingTexts?: string[] | null;
  stampText?: string | null;
  deployment?: object | null;
};

export function publishNativeTermsReceipt(
  operation: () => unknown,
  files: LegalReleaseFiles = bundledLegalReleaseFiles(),
): LegalOperationResult {
  return runNativeLegalOperation(TERMS_RECEIPT_PATH, legalReleaseContextFromFiles(files), operation);
}

export async function publishVerifiedNativeTermsReceipt(
  operation: () => unknown,
  origin: string,
  files: LegalReleaseFiles = bundledLegalReleaseFiles(),
  fetcher: typeof fetch = globalThis.fetch,
): Promise<LegalOperationResult> {
  const deployment = await fetchLegalDeployment(files, fetcher, origin);
  return publishNativeTermsReceipt(operation, { ...files, deployment });
}
