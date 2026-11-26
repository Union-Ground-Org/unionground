export function screenFiles(root?: string): string[];
export function testFiles(root?: string, repo?: string): string[];
export function executedScreens(tests?: string[]): Set<string>;
export function unexecutedScreens(options?: { screens?: string[]; tests?: string[] }): string[];
