import type { Baseline } from '../../apps/mobile/scripts/type-coverage-ratchet.mjs';
export function loadCoveragePins(path: string): Baseline;
export function appendCoveragePin(path: string, previous: Baseline, next: Baseline): void;
