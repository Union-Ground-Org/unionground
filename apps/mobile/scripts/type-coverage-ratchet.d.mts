export interface SuppressionCounts {
  readonly tsNoCheck: number;
  readonly tsIgnore: number;
  readonly tsExpectError: number;
  readonly explicitAny: number;
  readonly asAny: number;
  readonly doubleAssertion: number;
}

export interface FileMeasurement {
  readonly path: string;
  readonly identifiers: number;
  readonly any: number;
  readonly coveragePercent: number;
  readonly suppressions: SuppressionCounts;
}

export interface Measurement {
  readonly fileCount: number;
  readonly totalIdentifiers: number;
  readonly anyIdentifiers: number;
  readonly coveragePercent: number;
  readonly suppressions: SuppressionCounts;
  readonly files: readonly FileMeasurement[];
}

export interface Baseline {
  readonly schema: number;
  readonly measured_on: string;
  readonly minimum_coverage_percent: number;
  readonly new_file_minimum_percent: number;
  readonly maximum_suppressions: SuppressionCounts;
  readonly measured_file_count: number;
  readonly exclusions: readonly string[];
  readonly files: Readonly<Record<string, number>>;
}

export const MOBILE_ROOT: string;
export const BASELINE_PATH: string;
export const EXCLUDED_PATTERNS: readonly RegExp[];
export const MEASURED_ROOTS: readonly string[];
export const SUPPRESSION_KINDS: readonly (keyof SuppressionCounts)[];
export const MINIMUM_NEW_FILE_FLOOR: number;
export const DEFAULT_NEW_FILE_FLOOR: number;

export function isMeasured(relativePath: string, roots?: readonly string[]): boolean;
export function measure(options?: { projectRoot?: string; roots?: readonly string[] }): Measurement;
export function loadBaseline(path?: string): Baseline;
export function validateBaseline(baseline: unknown): string[];

export interface AggregateFloor {
  readonly percent: number;
  readonly source: string;
}

export function compare(measurement: Measurement, baseline: Baseline, options?: { aggregateFloor?: AggregateFloor | null }): string[];
export function perFileFailures(measurement: Measurement, baseline: Baseline, options?: { requireRecorded?: boolean }): string[];
export function evaluate(
  measurement: Measurement,
  baseline: Baseline,
  options?: { requireRecorded?: boolean; aggregateFloor?: AggregateFloor | null },
): string[];

export const BASE_TREE_PATHS: readonly string[];
export function aggregateBaseCommit(options?: {
  repositoryRoot?: string;
  env?: Readonly<Record<string, string | undefined>>;
}): string | null;
export function measureAtCommit(commit: string, options?: { repositoryRoot?: string }): Measurement | null;

export interface ParsedArguments {
  readonly report: boolean;
  readonly update: boolean;
  readonly acceptRegression: boolean;
  readonly baselinePath: string;
}

export function parseArguments(args: readonly string[]): ParsedArguments;
