export const BLOCKED_PERMISSIONS: string[];
export const REQUIRED_PERMISSIONS: string[];
export function readManifest(xml: string): { granted: string[]; removed: string[]; mediaPlaybackServices: string[] };
export function manifestFailures(xml: string): string[];
export function builtManifestPaths(androidDirectory: string, variant?: string): string[];
