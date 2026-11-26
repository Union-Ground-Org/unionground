// @brand-literal
// The web build's brand: one name and one mark for the whole bundle, decided
// by src/lib/shared-core/brand.js from VITE_BRAND_NAME, VITE_OFFICIAL_BRANDING
// and the presence of branding/official/.
//
// - resolveWebBrand() runs in vite.config.mjs and stops a production build
//   that has no name of its own, or that uses the Union Ground name without
//   official branding, with a message for the operator.
// - brandPlugin() hands the result to the app (__UNIONGROUND_BRAND__ and, in an
//   official build only, the official mark as data URLs), and in an
//   unbranded build rewrites "Union Ground" in the app's own modules,
//   index.html, the public route documents, manifest.webmanifest, offline.html,
//   404.html, robots.txt, sitemap.xml and sw.js to the build's name. "Based on Union
//   Ground" (the NOTICE attribution) and "Union Ground LLC" stay as written.
//   A production build then checks the output and fails if the name is left
//   anywhere else.
// - In an official build it swaps the neutral placeholder icons for the files
//   in branding/official/ and drops the maskable placeholders, for which the
//   official kit has no counterpart.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import {
  BRAND_LITERAL_DIRECTIVE,
  applyBrandName,
  resolveBrand,
  resolveSourceCodeUrl,
  withoutProtectedNames,
} from "../../src/lib/shared-core/brand.js";

export const OFFICIAL_BRANDING_DIR = "branding/official";
export const OFFICIAL_MARK_FILES = Object.freeze({ tile: "mark-tile.svg", plain: "mark-on-dark.svg" });
// Public path in the build -> official file that replaces it.
export const OFFICIAL_ICON_REPLACEMENTS = Object.freeze({
  "assets/favicon.svg": "mark-tile.svg",
  "favicon-32.png": "mark-tile-32.png",
  "apple-touch-icon.png": "mark-tile-180.png",
  "icon-192.png": "mark-tile-192.png",
  "icon-512.png": "mark-tile-512.png",
});
// Neutral placeholders with no official counterpart: removed from an
// official build so it never mixes the two identities.
export const NEUTRAL_ONLY_PUBLIC_FILES = Object.freeze([
  "favicon.ico",
  "icon-192-maskable.png",
  "icon-512-maskable.png",
  "assets/favicon-maskable.svg",
]);
export const OFFICIAL_REQUIRED_FILES = Object.freeze([
  "LICENSE.md",
  ...new Set([...Object.values(OFFICIAL_MARK_FILES), ...Object.values(OFFICIAL_ICON_REPLACEMENTS)]),
]);
// Public files that carry the product name as text.
export const BRANDED_PUBLIC_TEXT_FILES = Object.freeze(["manifest.webmanifest", "offline.html", "404.html", "robots.txt", "sitemap.xml", "sw.js"]);

const MODULE_PATTERN = /\.(?:[cm]?[jt]sx?|json)$/;
const OUTPUT_TEXT_PATTERN = /\.(?:html|webmanifest|txt|js|mjs|css|json|xml|svg)$/;

export function officialAssetsPresent(root) {
  return OFFICIAL_REQUIRED_FILES.every((name) => existsSync(join(root, OFFICIAL_BRANDING_DIR, name)));
}

// The brand for one Vite command. `env` is the merged VITE_* environment
// (process.env over .env files) plus SOURCE_CODE_URL.
export function resolveWebBrand({ env, mode, command, root }) {
  const production = command === "build" && (mode === "production" || env.NODE_ENV === "production");
  const brand = resolveBrand({
    brandName: env.VITE_BRAND_NAME,
    officialBranding: env.VITE_OFFICIAL_BRANDING,
    officialAssetsPresent: officialAssetsPresent(root),
    production,
  });
  return Object.freeze({ ...brand, production, sourceCodeUrl: resolveSourceCodeUrl(env.SOURCE_CODE_URL) });
}

function officialMarkDataUrls(root) {
  return Object.fromEntries(Object.entries(OFFICIAL_MARK_FILES).map(([key, file]) => [
    key,
    `data:image/svg+xml;base64,${readFileSync(join(root, OFFICIAL_BRANDING_DIR, file)).toString("base64")}`,
  ]));
}

export function officialWebHosts(root) {
  return JSON.parse(readFileSync(join(root, "config/official-domains.json"), "utf8")).webHosts;
}

export function brandDefines(brand, root) {
  return {
    __UNIONGROUND_BRAND__: JSON.stringify({
      name: brand.name,
      official: brand.official,
      initial: brand.initial,
      sourceCodeUrl: brand.sourceCodeUrl,
    }),
    __UNIONGROUND_OFFICIAL_MARK__: JSON.stringify(brand.official ? officialMarkDataUrls(root) : null),
    // The official service's hosts, for the "Official Union Ground service"
    // mark. Only an official build can show it, so only an official bundle
    // carries the list (the web bundle identity check refuses the LLC's hosts
    // in any other).
    __UNIONGROUND_OFFICIAL_HOSTS__: JSON.stringify(brand.official ? officialWebHosts(root) : []),
  };
}

// The module rewrite, exported for tests. Returns null when nothing changes.
export function rewriteModuleSource(code, id, brand) {
  if (brand.official) return null;
  const file = String(id).split("?", 1)[0];
  if (String(id).startsWith("\0") || file.includes("/node_modules/") || !MODULE_PATTERN.test(file)) return null;
  if (!code.includes("Union Ground") && !code.includes("UNION")) return null;
  if (code.includes(BRAND_LITERAL_DIRECTIVE)) return null;
  const next = applyBrandName(code, brand.name);
  return next === code ? null : next;
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

// Every text file in a built output that still says "Union Ground" outside
// the protected phrases.
export function leftoverBrandFiles(outDir) {
  const leftovers = [];
  for (const path of walk(outDir)) {
    if (!OUTPUT_TEXT_PATTERN.test(path) || statSync(path).size > 20 * 1024 * 1024) continue;
    const text = withoutProtectedNames(readFileSync(path, "utf8"));
    if (text.includes("Union Ground") || /UNION(?: |&nbsp;)GROUND/.test(text)) leftovers.push(relative(outDir, path));
  }
  return leftovers.sort();
}

function officialManifest(source) {
  const manifest = JSON.parse(source);
  manifest.icons = (manifest.icons || []).filter((icon) => {
    const path = String(icon.src || "").replace(/^\//, "");
    return !NEUTRAL_ONLY_PUBLIC_FILES.includes(path);
  });
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function finishBuiltOutput(outDir, brand, root) {
  if (brand.official) {
    for (const [publicPath, file] of Object.entries(OFFICIAL_ICON_REPLACEMENTS)) {
      // Only where the build copied the placeholder (a test build may have no public folder).
      if (existsSync(join(outDir, publicPath))) copyFileSync(join(root, OFFICIAL_BRANDING_DIR, file), join(outDir, publicPath));
    }
    for (const publicPath of NEUTRAL_ONLY_PUBLIC_FILES) rmSync(join(outDir, publicPath), { force: true });
    const manifestPath = join(outDir, "manifest.webmanifest");
    if (existsSync(manifestPath)) writeFileSync(manifestPath, officialManifest(readFileSync(manifestPath, "utf8")));
    return;
  }
  for (const path of walk(outDir)) {
    const name = relative(outDir, path).split("\\").join("/");
    if (extname(path) !== ".html" && !BRANDED_PUBLIC_TEXT_FILES.includes(name)) continue;
    const source = readFileSync(path, "utf8");
    const next = applyBrandName(source, brand.name);
    if (next !== source) writeFileSync(path, next);
  }
  if (!brand.production) return;
  const leftovers = leftoverBrandFiles(outDir);
  if (leftovers.length > 0) {
    throw new Error(`The unbranded build still names Union Ground in: ${leftovers.slice(0, 20).join(", ")}. `
      + "Print the name through src/lib/brand.js or plain \"Union Ground\" copy the brand plugin rewrites (scripts/lib/brand-vite-plugin.mjs).");
  }
}

export function brandPlugin(brand, { root = process.cwd() } = {}) {
  let outDir = null;
  return {
    name: "union-ground-brand",
    enforce: "pre",
    config() {
      return { define: brandDefines(brand, root) };
    },
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    transform(code, id) {
      const next = rewriteModuleSource(code, id, brand);
      return next === null ? null : { code: next, map: null };
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return brand.official ? html : applyBrandName(html, brand.name);
      },
    },
    configureServer(server) {
      const publicDir = server.config.publicDir;
      server.middlewares.use((request, response, next) => {
        const path = (request.url || "/").split("?", 1)[0].replace(/^\//, "");
        if (brand.official && Object.hasOwn(OFFICIAL_ICON_REPLACEMENTS, path)) {
          const file = join(root, OFFICIAL_BRANDING_DIR, OFFICIAL_ICON_REPLACEMENTS[path]);
          response.setHeader("Content-Type", file.endsWith(".svg") ? "image/svg+xml" : "image/png");
          response.end(readFileSync(file));
          return;
        }
        if (brand.official || !BRANDED_PUBLIC_TEXT_FILES.includes(path) || !publicDir) return next();
        const file = join(publicDir, path);
        if (!existsSync(file)) return next();
        const types = { ".webmanifest": "application/manifest+json", ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
        response.setHeader("Content-Type", types[extname(file)] || "text/plain; charset=utf-8");
        response.end(applyBrandName(readFileSync(file, "utf8"), brand.name));
      });
    },
    closeBundle() {
      if (outDir && existsSync(outDir)) finishBuiltOutput(outDir, brand, root);
    },
  };
}
