// The same platform-neutral operation keys as web; native supplies its own
// UUID source (expo-crypto) where globalThis.crypto is absent.
export {
  OPERATION_KEY_MAX_AGE_MS, createOperationKeys, operationIntent, withOperationKey,
} from '../../../../src/lib/operationKey.js';
export type { OperationKeyOptions, OperationKeys } from '../../../../src/lib/operationKey.js';
