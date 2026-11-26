export type ReadFailureKind = 'network' | 'server' | 'timeout';
export const READ_FAILURES: readonly ReadFailureKind[];
export function readFailure(kind: ReadFailureKind): Error;
export function failingRead(kind: ReadFailureKind): (() => Promise<never>) & { calls: number };
export function expectFailureShown(text: string | null | undefined, expected: { failure: string; empty?: string[]; success?: string[] }): void;
