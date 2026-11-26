import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// REQ-UG-WEB-ENTRY-CHUNK-CARRIES-WHOLE-ENGLISH-CATALOGUE-20261109.
// The manual chunks of the web build, and the guard that keeps the string
// catalogue out of the entry chunk.
//
// Dependencies change on a different clock than the app does. Pinning React
// and Supabase into their own chunks means an ordinary deploy rewrites the app
// chunks and leaves ~410 kB of vendor code sitting in the member's cache under
// an unchanged hash — the caching win that makes the split worth having on
// repeat visits, not just first paint.
//
// The English catalogue (src/lib/i18n.js and the namespace files under
// src/lib/i18n/) was about half of the entry chunk every route loads, so any
// string change rewrote the whole app script. It is its own chunk now, fetched
// in parallel with the entry (modulepreload) and cached on its own hash. Its
// module order is unchanged, so t() stays synchronous and the first paint is
// still whole-language copy. Spanish keeps its own on-demand chunk
// (src/lib/i18n/es.js, loaded by loadLanguage()); allLanguages.js is the Node
// and test entry and never reaches the web bundle. The feature namespaces that
// register themselves (src/lib/i18n/features/<name>Strings.js, see
// registerFeatureStrings)
// stay out of it too, so Rollup places them with the views that import them.
const FEATURE_NAMESPACES = readdirSync(resolve(import.meta.dirname, "../../src/lib/i18n/features"))
  .filter((name) => name.endsWith("Strings.js"))
  .map((name) => `/src/lib/i18n/${name.slice(0, -"Strings.js".length)}.js`);
const I18N_ON_DEMAND = ["/src/lib/i18n/es.js", "/src/lib/i18n/allLanguages.js", ...FEATURE_NAMESPACES];
const I18N_MODULES = [
  "/src/lib/i18n.js",
  "/src/lib/i18n/",
  // The catalogue's own imports, so the strings chunk never imports back
  // from the entry chunk.
  "/src/lib/passwordPolicy.js",
  "/src/lib/loadDeadline.js",
];

function normalized(id) {
  return id.split("?")[0].replaceAll("\\", "/");
}

// The Spanish area modules (OPS-UG-I18N-PER-AREA-LOCALE-MODULES-20261109)
// belong to es.js's on-demand chunk, never to the English one.
const I18N_ON_DEMAND_DIRS = ["/src/lib/i18n/features/", "/src/lib/i18n/locales/es/"];

export function isCatalogueModule(id) {
  const path = normalized(id);
  if (I18N_ON_DEMAND_DIRS.some((part) => path.includes(part)) || I18N_ON_DEMAND.some((suffix) => path.endsWith(suffix))) return false;
  return I18N_MODULES.some((part) => (part.endsWith("/") ? path.includes(part) : path.endsWith(part)));
}

export function manualChunkFor(id) {
  if (id.includes("node_modules/@sentry") || id.includes("node_modules/posthog") || id.includes("node_modules/@posthog")) return "vendor-observability";
  if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "vendor-react";
  if (id.includes("node_modules/@supabase") || id.includes("node_modules/iceberg-js") || id.includes("node_modules/tslib")) return "vendor-supabase";
  if (isCatalogueModule(id)) return "i18n-en";
  return undefined;
}

// Rolldown (Vite 8) pulls a captured module's dependencies into its group, so
// one group naming every chunk let vendor-observability take React with
// @sentry/react and load Sentry on first paint. One group per chunk, React
// first: a module a higher group took stays out of the lower ones.
//
// Rollup kept every app module the entry imports in the entry chunk; Rolldown
// gives each one a lazy view also imports its own common chunk, which turned
// the first paint into 30 module preloads. "app-initial" holds them together
// again (Rolldown folds it into the entry). Rollup's experimentalMinChunkSize
// has no Rolldown counterpart, and the long tail it folded away was mostly
// single lucide icons shared by two lazy views, so the icons get one group
// (Rolldown keeps the first-paint icons apart from the lazy ones).
const CHUNK_ORDER = ["vendor-react", "vendor-supabase", "vendor-observability", "i18n-en"];
const isIcon = (id) => normalized(id).includes("/node_modules/lucide-react/");
export function memberShellChunkFor(id, context) {
  if (manualChunkFor(id) || isIcon(id)) return null;
  let member = false, initial = false, standalone = false;
  const seen = new Set();
  function visit(current) {
    if (seen.has(current)) return;
    seen.add(current);
    const path = normalized(current);
    if (path.endsWith("/src/App.jsx")) { member = true; return; }
    if (path.endsWith("/src/main.jsx")) { initial = true; return; }
    const info = context.getModuleInfo(current);
    if (!info) return;
    if (info.isEntry) initial = true;
    if (info.dynamicImporters.some((parent) => normalized(parent).endsWith("/src/AppRouter.jsx"))) standalone = true;
    for (const parent of info.importers) visit(parent);
  }
  visit(id);
  // Helpers shared only by lazy pages must not inflate every entry load.
  // The member document preloads the shell's static dependency closure, and
  // Vite preloads a standalone page's dependencies before resolving its import.
  return initial ? "app-initial" : member && standalone ? "member-shared" : member ? "member-shell" : null;
}
export const appCodeSplitting = {
  groups: [
    ...CHUNK_ORDER.map((name, index) => ({
      name,
      priority: CHUNK_ORDER.length - index,
      test: (id) => manualChunkFor(id) === name,
    })),
    { name: memberShellChunkFor, debugName: "app-initial", includeDependenciesRecursively: false,
      test: (id) => !manualChunkFor(id) && !isIcon(id) },
    { name: "icons", priority: -1, test: isIcon },
  ],
};

// Catalogue modules a built entry chunk still carries (an empty list is the
// contract). Rolldown moves a module back into the entry when a group loses
// it, so this reads the emitted bundle rather than the configuration.
export function catalogueModulesInEntry(bundle) {
  return Object.values(bundle)
    .filter((chunk) => chunk.type === "chunk" && chunk.isEntry)
    .flatMap((chunk) => Object.keys(chunk.modules).filter(isCatalogueModule).map((id) => `${chunk.fileName}: ${normalized(id).replace(/^.*?\/src\//, "src/")}`));
}

export function catalogueChunkGuardPlugin() {
  // The namespace APIs also serve native/Node synchronously. On the web their
  // Spanish imports become live bindings populated by es.js, so a helper used
  // by the English screen cannot pull its bilingual table back into bootstrap.
  const spanishNamespace = "\0spanish-namespace:";
  return {
    name: "catalogue-chunk-guard",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !/^\.\/locales\/es\/namespaces\/[\w-]+\.js$/.test(source)) return null;
      const path = normalized(importer);
      if (!/\/src\/lib\/i18n\/[\w-]+\.js$/.test(path) || path.endsWith("/es.js")) return null;
      return `${spanishNamespace}${resolve(dirname(path), source)}`;
    },
    load(id) {
      if (!id.startsWith(spanishNamespace)) return null;
      const path = id.slice(spanishNamespace.length);
      const exports = [...readFileSync(path, "utf8").matchAll(/^export const (\w+) =/gm)].map((match) => match[1]);
      if (!exports.length) this.error(`Spanish namespace has no table: ${path}`);
      const registry = resolve(dirname(path), "../../../spanishNamespaces.js");
      return `export { ${exports.join(", ")} } from ${JSON.stringify(registry)};`;
    },
    generateBundle(_options, bundle) {
      const reached = catalogueModulesInEntry(bundle);
      if (reached.length) this.error(`string catalogue modules reached the entry chunk: ${reached.join(", ")}`);
    },
  };
}
