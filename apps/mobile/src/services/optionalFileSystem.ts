type FileSystemLegacy = typeof import('expo-file-system/legacy');
let cache: FileSystemLegacy | null | undefined;

// Lazy for the same reason as expo-audio in quick capture: dev clients built
// before this dependency shipped cannot record, so having nothing to delete
// and no module to delete with are the same condition. Kept in its own module
// so behavior tests can mock the loader through the ESM graph.
export function loadFileSystem(): FileSystemLegacy | null {
  if (cache === undefined) {
    try {
      cache = require('expo-file-system/legacy') as FileSystemLegacy;
    } catch {
      cache = null;
    }
  }
  return cache;
}
