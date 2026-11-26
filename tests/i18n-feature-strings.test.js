import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { localeSource } from "./helpers/locale-sources.js";
import { appCodeSplitting, catalogueChunkGuardPlugin, catalogueModulesInEntry, isCatalogueModule, manualChunkFor } from "../scripts/lib/app-chunks.mjs";

// REQ-UG-WEB-ENTRY-CHUNK-CARRIES-WHOLE-ENGLISH-CATALOGUE-20261109:
// the string catalogue is its own chunk, never part of the entry chunk, and
// the namespaces only lazily loaded views use register themselves with those
// views (registerFeatureStrings in src/lib/i18n.js).

const root = process.cwd();
const featureDir = resolve("src/lib/i18n/features");
// <namespace>Strings.js, never <namespace>.js: tests that collect a
// namespace's keys from a view's source with /altCaseDesk\.[A-Za-z]+/ would
// read the import path as a key.
const featureNames = readdirSync(featureDir).map((name) => name.replace(/Strings\.js$/, "")).sort();
const namespaceFiles = readdirSync(resolve("src/lib/i18n")).filter((name) => name.endsWith(".js") && !["es.js", "allLanguages.js", "runtime.js", "format.js", "zonedDates.js"].includes(name));
// The English literal: the barrel and its per-area modules.
const barrelSource = localeSource("en");

async function englishTable(name) {
  const module = await import(pathToFileURL(resolve(`src/lib/i18n/${name}.js`)).href);
  return Object.values(module).find((value) => value && typeof value === "object" && value.en && typeof value.en === "object").en;
}

function sourceModules() {
  const files = [];
  (function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:jsx?|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(path);
    }
  })(resolve("src"));
  return files.filter((path) => !path.startsWith(`${resolve("src/lib/i18n")}/`) && path !== resolve("src/lib/i18n.js"));
}

describe("feature strings", () => {
  it("are a known, non-empty set, each registered by a three-line module", () => {
    expect(featureNames.length).toBeGreaterThan(20);
    for (const name of featureNames) {
      const source = readFileSync(join(featureDir, `${name}Strings.js`), "utf8");
      expect(source, name).toMatch(new RegExp(`^import \\{ registerFeatureStrings \\} from "\\.\\./\\.\\./i18n\\.js";\\nimport \\{ (\\w+) \\} from "\\.\\./${name}\\.js";\\n\\nregisterFeatureStrings\\(\\1\\);\\n$`));
      // Not spread into the English literal as well.
      expect(barrelSource, name).not.toMatch(new RegExp(`from "\\./i18n/${name}\\.js"`));
    }
  });

  it("own keys no other table declares, so the order they register in changes nothing", async () => {
    const owners = new Map();
    for (const file of namespaceFiles) {
      const name = file.slice(0, -3);
      const table = await englishTable(name).catch(() => null);
      if (!table) continue;
      for (const key of Object.keys(table)) owners.set(key, [...(owners.get(key) || []), name]);
    }
    for (const name of featureNames) {
      for (const key of Object.keys(await englishTable(name))) {
        expect(owners.get(key), key).toEqual([name]);
        expect(barrelSource.includes(`"${key}":`), key).toBe(false);
      }
    }
  });

  it("are imported, directly, by every module that names one of their keys", async () => {
    const modules = sourceModules().map((path) => [path, readFileSync(path, "utf8")]);
    for (const name of featureNames) {
      const prefixes = [...new Set(Object.keys(await englishTable(name)).map((key) => key.split(".")[0]))];
      const users = modules.filter(([, code]) => prefixes.some((prefix) => new RegExp(`["'\`]${prefix}\\.`).test(code)));
      expect(users.length, name).toBeGreaterThan(0);
      for (const [path, code] of users) {
        let specifier = relative(join(path, ".."), join(featureDir, `${name}Strings.js`));
        if (!specifier.startsWith(".")) specifier = `./${specifier}`;
        expect(code.includes(`import "${specifier}";`), `${relative(root, path)} names ${name} keys`).toBe(true);
      }
    }
  });

  it("are all registered for Node and the tests by allLanguages.js", async () => {
    const source = readFileSync("src/lib/i18n/allLanguages.js", "utf8");
    for (const name of featureNames) {
      expect(source, name).toContain(`import "./features/${name}Strings.js";`);
      for (const [key, value] of Object.entries(await englishTable(name))) expect(catalogue.en[key], key).toBe(value);
    }
  });
});

describe("the catalogue chunk", () => {
  it("takes the barrel, its namespaces and passwordPolicy.js, and leaves Spanish and the feature strings on demand", () => {
    for (const id of ["/repo/src/lib/i18n.js", "/repo/src/lib/i18n/unionCatalog.js", "/repo/src/lib/i18n/guideEngine.js", "/repo/src/lib/i18n/runtime.js", "/repo/src/lib/i18n/locales/en/admin.js", "/repo/src/lib/passwordPolicy.js"]) {
      expect(manualChunkFor(id), id).toBe("i18n-en");
    }
    for (const id of ["/repo/src/lib/i18n/es.js", "/repo/src/lib/i18n/allLanguages.js", "/repo/src/lib/i18n/telemetry.js", "/repo/src/lib/i18n/features/telemetryStrings.js", "/repo/src/lib/i18n/locales/es/admin.js", "/repo/src/App.jsx"]) {
      expect(manualChunkFor(id), id).toBeUndefined();
    }
    expect(manualChunkFor("/repo/node_modules/react-dom/client.js")).toBe("vendor-react");
    expect(isCatalogueModule("/repo/src/lib/i18n.js?import")).toBe(true);
  });

  it("gives React the first group, so Sentry's dependency on it cannot pull it into vendor-observability", () => {
    const groups = [...appCodeSplitting.groups].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    expect(groups.map((group) => group.debugName ?? group.name)).toEqual(["vendor-react", "vendor-supabase", "vendor-observability", "i18n-en", "app-initial", "icons"]);
    // The first group by priority that tests true takes the module; app-initial only sees first-paint modules.
    const claim = (id) => {
      const group = groups.find((group) => !group.tags && group.test(id));
      return typeof group?.name === "function" ? group.name(id, { getModuleInfo: () => null }) : group?.name;
    };
    expect(claim("/repo/node_modules/react/index.js")).toBe("vendor-react");
    expect(claim("/repo/node_modules/@sentry/react/build/esm/index.js")).toBe("vendor-observability");
    expect(claim("/repo/node_modules/@supabase/auth-js/dist/module/index.js")).toBe("vendor-supabase");
    expect(claim("/repo/src/lib/i18n/unionCatalog.js")).toBe("i18n-en");
    expect(claim("/repo/node_modules/lucide-react/dist/esm/icons/x.js")).toBe("icons");
    const initial = groups.find((group) => group.debugName === "app-initial");
    expect(initial.includeDependenciesRecursively).toBe(false);
    expect(initial.test("/repo/node_modules/lucide-react/dist/esm/icons/x.js")).toBe(false);
  });

  it("fails the build when a catalogue module reaches an entry chunk", () => {
    const bundle = {
      "index.js": { type: "chunk", isEntry: true, fileName: "index.js", modules: { "/repo/src/main.jsx": {}, "/repo/src/lib/passwordPolicy.js": {} } },
      "i18n-en.js": { type: "chunk", isEntry: false, fileName: "i18n-en.js", modules: { "/repo/src/lib/i18n.js": {} } },
    };
    expect(catalogueModulesInEntry(bundle)).toEqual(["index.js: src/lib/passwordPolicy.js"]);
    const errors = [];
    catalogueChunkGuardPlugin().generateBundle.call({ error: (message) => errors.push(message) }, {}, bundle);
    expect(errors).toEqual(["string catalogue modules reached the entry chunk: index.js: src/lib/passwordPolicy.js"]);
    delete bundle["index.js"].modules["/repo/src/lib/passwordPolicy.js"];
    expect(catalogueModulesInEntry(bundle)).toEqual([]);
  });

  it("is wired into builds", () => {
    const config = readFileSync("vite.config.mjs", "utf8");
    expect(config).toContain("!process.env.VITEST && catalogueChunkGuardPlugin(),");
    expect(config).toContain("codeSplitting: appCodeSplitting,");
  });
});
