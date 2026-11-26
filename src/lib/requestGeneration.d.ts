export interface RequestTicket {
  isCurrent(): boolean;
  assertCurrent(): void;
}
export interface RequestGeneration {
  begin(): RequestTicket;
  capture(): RequestTicket;
  invalidate(): void;
  activate(): void;
  dispose(): void;
}
export class StaleResponseError extends Error { constructor(); }
export function isStaleResponse(error: unknown): error is StaleResponseError;
export function createRequestGeneration(): RequestGeneration;
