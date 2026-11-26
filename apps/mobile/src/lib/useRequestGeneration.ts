// Metro resolves the shared hook's React import to this app's React instance.
import { useRequestGeneration as useSharedGeneration } from '../../../../src/lib/useRequestGeneration.js';
import type { RequestGeneration } from './requestGeneration';

export function useRequestGeneration(scope: unknown): RequestGeneration {
  return useSharedGeneration(scope);
}
