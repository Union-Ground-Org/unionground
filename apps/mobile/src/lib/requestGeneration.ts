// The same platform-neutral lane as web; no native scheduling or data policy.
import { createRequestGeneration as createSharedGeneration, type RequestGeneration } from '../../../../src/lib/requestGeneration.js';
export { isStaleResponse, StaleResponseError } from '../../../../src/lib/requestGeneration.js';
export type { RequestGeneration, RequestTicket } from '../../../../src/lib/requestGeneration.js';

export function createRequestGeneration(): RequestGeneration {
  return createSharedGeneration();
}
