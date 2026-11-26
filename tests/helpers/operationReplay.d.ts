export class LostResponseError extends Error { constructor(); }
export interface EffectLedger {
  effects: Array<{ key: string; payload: unknown }>;
  keys: string[];
  loseNextResponses(count?: number): void;
  perform(key: string, payload?: unknown): Promise<{ id: string; effect: number }>;
}
export function createEffectLedger(): EffectLedger;
export function retryAfterLostResponse<T>(ledger: EffectLedger, attempt: () => Promise<T>): Promise<T>;
export function deliverTwice<T>(attempt: () => Promise<T>): Promise<[T, T]>;
