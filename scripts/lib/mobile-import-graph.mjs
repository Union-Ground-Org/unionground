// The apps/mobile runtime import graph, walked statically.
//
// PERF-UG-MOBILE-QA-BUNDLES-FULL-WEB-CATALOGUE-20260917. apps/mobile and the
// web app share first-party modules under src/features and src/lib (metro.config.js
// watches both), and the two apps do not share a bundler. Anything the native
// graph reaches is *in the app bundle*: Metro does not tree-shake, so a single
// shared re-export can put a 785 KB web object literal on a member's phone to
// resolve sixty strings, silently, with every web test still green. This module
// answers the only question that catches that — what does a route actually
// reach, and how many bytes is it — so a test can hold a budget over it.
//
// Resolution mirrors what apps/mobile/metro.config.js and apps/mobile/tsconfig.json
// actually do today, and nothing more:
//   * only RELATIVE specifiers are graph edges; a bare specifier is a node_module
//     and is not first-party bytes. apps/mobile declares no Metro alias and no
//     tsconfig `paths`, so there is no alias form to resolve.
//   * extensions and index files in Metro's order, plus `.json`
//     (tsconfig `resolveJsonModule`, used by src/theme/tokens.ts).
//   * metro.config.js blocks `src/features/**/*.jsx` — the web JSX desks — so a
//     module behind that fence is NOT in the bundle. Reaching one is a native
//     build failure rather than weight, so it is reported separately.
//
// The walk is deliberately conservative: it follows type-only import
// declarations too, which are erased at build time, so the module count and the
// byte total are an upper bound on what ships. A budget held against an upper
// bound never passes a bundle that is actually over it.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { readModuleFacts } from "./module-graph.mjs";

// Metro's sourceExts order, with the TypeScript pair first as expo/metro-config
// leaves it, then `.json` for resolveJsonModule.
const RESOLUTION_ORDER = Object.freeze([
  "",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs", "/index.json",
]);

// config.resolver.blockList in apps/mobile/metro.config.js.
const WEB_JSX_FENCE = /^src\/features\/.*\.jsx$/;

// Every module that carries the shared string register: the src/lib/i18n.js
// barrel and its namespace chunks under src/lib/i18n/, at ANY depth — a chunk
// moved to src/lib/i18n/<ns>/index.js must still count against the budget, or
// the budget would quietly stop measuring part of the register.
export const CATALOGUE_MODULE = /^src\/lib\/i18n(?:\.js|\/.+\.js)$/;

// The shared-register source budget applies to every native route, with no
// exclusions. On 2026-09-28 the bilingual chapter Connections namespace adds
// 21,785 source bytes (5,482 gzip bytes) and raises total native register reach
// from 17,066 to 38,851 bytes. Its publication/review/help copy is required by
// the new native feature, so the reviewed bound is 40 KiB. This measures source
// bytes, not the compressed/Hermes bundle. The separate full-barrel ban remains
// absolute. The web barrel was 947,785 bytes (about 926 KiB) on 2026-09-25;
// importing it therefore still fails both the explicit ban and this bound.
// Keep catalogue byte measurements here so chunk comments cannot drift.
export const MOBILE_CATALOGUE_BYTE_BUDGET = 40 * 1024;

export function mobileRouteEntries(root) {
  const appDirectory = join(root, "apps/mobile/app");
  const entries = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      entries.push(relative(root, child).replace(/\\/g, "/"));
    }
  };
  walk(appDirectory);
  return entries.sort();
}

function resolveMobileSpecifier(root, fromPath, specifier) {
  const base = resolve(root, dirname(fromPath), specifier);
  for (const suffix of RESOLUTION_ORDER) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(root, candidate).replace(/\\/g, "/");
    }
  }
  return null;
}

/**
 * Walk every module apps/mobile reaches from `entries`.
 *
 * @returns {{
 *   modules: Map<string, number>,   // module path -> source bytes
 *   importedBy: Map<string, string>,// module path -> the module that first reached it
 *   bytes: number,
 *   blocked: string[],              // edges into the metro blockList
 *   unresolved: string[],           // relative specifiers that resolve to nothing
 * }}
 */
export function walkMobileGraph(root, entries) {
  const modules = new Map();
  const importedBy = new Map();
  const blocked = [];
  const unresolved = [];
  const queue = [...entries];
  for (const entry of entries) importedBy.set(entry, null);

  while (queue.length) {
    const path = queue.shift();
    if (modules.has(path)) continue;
    const source = readFileSync(join(root, path), "utf8");
    modules.set(path, Buffer.byteLength(source, "utf8"));
    if (path.endsWith(".json")) continue;
    for (const specifier of readModuleFacts({ path, source }).relativeSpecifiers) {
      const target = resolveMobileSpecifier(root, path, specifier);
      if (!target) {
        unresolved.push(`${path} -> ${specifier}`);
        continue;
      }
      if (WEB_JSX_FENCE.test(target)) {
        blocked.push(`${path} -> ${target}`);
        continue;
      }
      if (!importedBy.has(target)) importedBy.set(target, path);
      queue.push(target);
    }
  }

  let bytes = 0;
  for (const size of modules.values()) bytes += size;
  return { modules, importedBy, bytes, blocked, unresolved };
}

/** Every catalogue module the graph reaches, and their combined source bytes. */
export function catalogueReach(graph) {
  const reached = [...graph.modules.keys()].filter((path) => CATALOGUE_MODULE.test(path)).sort();
  let bytes = 0;
  for (const path of reached) bytes += graph.modules.get(path);
  return { reached, bytes };
}

/** The import chain from an entry down to `target`, for a failure message. */
export function importChain(graph, target) {
  if (!graph.modules.has(target)) return [];
  const chain = [];
  let cursor = target;
  while (cursor) {
    chain.unshift(cursor);
    cursor = graph.importedBy.get(cursor) ?? null;
  }
  return chain;
}
