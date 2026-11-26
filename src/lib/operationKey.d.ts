export interface OperationKeys {
  keyFor(intent: string): string;
  pending(intent: string): string | null;
  mint(): string;
  settle(intent: string): void;
  clear(): void;
}
export function operationIntent(operation: string, fields?: unknown): string;
export declare const OPERATION_KEY_MAX_AGE_MS: number;
export interface OperationKeyOptions { maxAgeMs?: number; now?: () => number }
export function createOperationKeys(randomUUID?: () => string, options?: OperationKeyOptions): OperationKeys;
export function withOperationKey<T>(keys: OperationKeys, intent: string, send: (key: string) => Promise<T>): Promise<T>;
