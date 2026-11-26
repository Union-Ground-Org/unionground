import { legalPendingDeclarations } from "../../content/legal/pending/directory.js";

// The build generates this statically imported data manifest from every JSON
// declaration. Without generation, null keeps publication closed.
export function bundledPendingTexts(modules = legalPendingDeclarations) {
  if (!modules) return null;
  return Object.keys(modules).sort().map((path) => modules[path]);
}
