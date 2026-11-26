import type { Baseline } from '../apps/mobile/scripts/type-coverage-ratchet.mjs';

export function readBaselineHistory(options: {
  repositoryRoot: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Baseline[];
export function baselineHistoryFailures(candidate: unknown, historical: readonly Baseline[]): string[];
