// @vitest-environment node
import { LANDING_CHROME_COPY } from "../src/lib/i18n/landingChromeCopy.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { catalogue, t } from "../src/lib/i18n/allLanguages.js";
import { appCodeSplitting, catalogueChunkGuardPlugin } from "../scripts/lib/app-chunks.mjs";

const namespaceDir = resolve("src/lib/i18n/locales/es/namespaces");
const lookupProbes = [
  { module: "eventTypes", fn: "eventTypeText", key: "deadline", fullKey: "events.deadline" },
  { module: "connectedWorkflows", fn: "connectedWorkflowsT", key: "connectedWorkflows.actions.remind", fullKey: "connectedWorkflows.actions.remind" },
  { module: "issueIntelligence", fn: "issueIntelligenceT", key: "issueIntelligence.kicker", fullKey: "issueIntelligence.kicker" },
  { module: "partnerOffices", fn: "partnerOfficesT", key: "partnerTitle", fullKey: "partnerOffices.partnerTitle" },
  { module: "connectedWorkflows", fn: "connectedWorkflowsT", key: "connectedWorkflows.unknownKey", fullKey: "connectedWorkflows.unknownKey" },
  { module: "issueIntelligence", fn: "issueIntelligenceT", key: "issueIntelligence.unknownKey", fullKey: "issueIntelligence.unknownKey" },
  { module: "partnerOffices", fn: "partnerOfficesT", key: "unknownKey", fullKey: "partnerOffices.unknownKey" },
];

describe("Spanish namespace loading", () => {
  it("gives the site chrome both languages from its own namespace", () => {
    expect(Object.keys(LANDING_CHROME_COPY).sort()).toEqual(["en", "es"]);
  });

  it("preserves standalone namespace lookups and unknown-key fallbacks in both languages", async () => {
    for (const probe of lookupProbes) {
      const namespace = await import(pathToFileURL(resolve("src/lib/i18n", `${probe.module}.js`)).href);
      for (const lang of ["en", "es"]) expect(namespace[probe.fn](lang, probe.key)).toBe(t(lang, probe.fullKey));
    }
  });

  it("keeps every namespace's strings identical in the complete catalogue and synchronous APIs", async () => {
    for (const file of await readdir(namespaceDir)) {
      const source = await readFile(join(namespaceDir, file), "utf8");
      const tables = await import(pathToFileURL(join(namespaceDir, file)).href);
      const namespace = await import(pathToFileURL(resolve("src/lib/i18n", file)).href);
      for (const [, binding] of source.matchAll(/^export const (\w+) =/gm)) {
        const api = namespace[binding.slice(0, -"Spanish".length)];
        expect(api.es, binding).toBe(tables[binding]);
        if (typeof api.en !== "object") continue;
        expect(Object.keys(api.es).sort(), binding).toEqual(Object.keys(api.en).sort());
        for (const [key, value] of Object.entries(api.en)) {
          if (key in catalogue.en) {
            expect(catalogue.en[key], key).toBe(value);
            expect(catalogue.es[key], key).toBe(api.es[key]);
          }
        }
      }
    }
  });

  it("emits no Spanish namespace data in the English load, including direct shared helper imports", async () => {
    const files = (await readdir(namespaceDir)).sort();
    // The per-namespace Spanish modules this edition ships (the press, pilot,
    // public home and ask-your-union pages are not part of it, and the unused
    // landing tour-link copy is gone).
    expect(files).toHaveLength(48);
    const imports = files.map((file, index) => `import * as n${index} from ${JSON.stringify(resolve("src/lib/i18n", file))};`);
    const entry = `${imports.join("\n")}\nexport const namespaces = [${files.map((_, index) => `n${index}`).join(",")}];\nexport { catalogue, loadLanguage, languageLoaded } from ${JSON.stringify(resolve("src/lib/i18n.js"))};`;
    const dir = await mkdtemp(join(tmpdir(), "spanish-load-"));
    try {
      const { output } = await build({
        configFile: false,
        envFile: false,
        logLevel: "silent",
        plugins: [
          { name: "namespace-probe", resolveId: (id) => id === "namespace-probe" ? id : null, load: (id) => id === "namespace-probe" ? entry : null },
          catalogueChunkGuardPlugin(),
        ],
        build: {
          write: false,
          minify: false,
          modulePreload: false,
          rolldownOptions: {
            input: "namespace-probe",
            preserveEntrySignatures: "allow-extension",
            output: { format: "esm", codeSplitting: appCodeSplitting, entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" },
          },
        },
      });
      const chunks = output.filter((item) => item.type === "chunk");
      const initial = chunks.find((item) => item.isEntry);
      const eager = new Set();
      const visit = (name) => {
        if (eager.has(name)) return;
        eager.add(name);
        for (const dependency of chunks.find((item) => item.fileName === name).imports) visit(dependency);
      };
      visit(initial.fileName);
      const spanishModules = chunks.filter((item) => eager.has(item.fileName)).flatMap((item) => Object.keys(item.modules)).filter((id) => /\/locales\/es\//.test(id) && !id.startsWith("\0"));
      expect(spanishModules).toEqual([]);
      for (const chunk of chunks) await writeFile(join(dir, chunk.fileName), chunk.code);
      // Execute the emitted ESM in Node, outside Vitest's source transformer.
      const built = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
        const app = await import(process.argv[1]);
        const probes = JSON.parse(process.argv[2]);
        const lookups = (lang) => probes.map((probe) => app.namespaces[probe.index][probe.fn](lang, probe.key));
        const before = app.languageLoaded("es");
        const english = lookups("en");
        const spanishBeforeLoad = lookups("es");
        const loaded = await app.loadLanguage("es");
        const spanish = lookups("es");
        const namespaces = app.namespaces.map((namespace) => Object.fromEntries(Object.entries(namespace).filter(([, value]) => value && typeof value === "object" && "es" in value)));
        console.log(JSON.stringify({ before, loaded, catalogue: app.catalogue, namespaces, english, spanishBeforeLoad, spanish }));
      `, pathToFileURL(join(dir, initial.fileName)).href, JSON.stringify(lookupProbes.map((probe) => ({ ...probe, index: files.indexOf(`${probe.module}.js`) })))], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
      expect(built.before).toBe(false);
      expect(built.loaded).toBe(true);
      expect(built.catalogue.es).toEqual(catalogue.es);
      expect(built.english).toEqual(lookupProbes.map((probe) => t("en", probe.fullKey)));
      expect(built.spanishBeforeLoad).toEqual(built.english);
      expect(built.spanish).toEqual(lookupProbes.map((probe) => t("es", probe.fullKey)));
      for (let index = 0; index < files.length; index++) {
        const expected = await import(pathToFileURL(resolve("src/lib/i18n", files[index])).href);
        for (const [key, api] of Object.entries(expected)) {
          if (api && typeof api === "object" && "es" in api) expect(built.namespaces[index][key].es, `${files[index]} ${key}`).toEqual(api.es);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
