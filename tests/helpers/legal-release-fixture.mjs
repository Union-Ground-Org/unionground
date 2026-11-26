import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import "../../src/lib/i18n/allLanguages.js";
import { catalogue } from "../../src/lib/i18n.js";
import { LEGAL_CONTENT_LAST_REVIEWED } from "../../src/lib/legalContent.js";
import { legalInstrument } from "../../src/lib/legalInstruments.js";
import {
  FILE_SURFACES, GENERATOR_VERSION, MIGRATIONS_DIR, PENDING_DIR, PIN_DIR, REGISTER_SOURCE, STAMP_PATH,
  applyLegalRelease, renderReleaseTelemetry, surfaceHashesFromTree,
} from "../../scripts/lib/legal-release.mjs";
import { TELEMETRY_PINS, readStagedTelemetryPins, readStagedTelemetryWriters, stagedTelemetryConfigPins } from "../../scripts/lib/telemetry-disclosure-sources.mjs";

export function realLegalRelease() {
  const base = {};
  for (const path of [...FILE_SURFACES, "src/lib/i18n.js", "src/lib/i18n/es.js", REGISTER_SOURCE, STAMP_PATH]) base[path] = readFileSync(path, "utf8");
  for (const directory of [PIN_DIR, "config/telemetry-disclosure-sources.d", MIGRATIONS_DIR]) {
    for (const name of readdirSync(directory).sort()) {
      if (!name.endsWith(".json") && !name.endsWith(".sql")) continue;
      const path = `${directory}/${name}`;
      base[path] = readFileSync(path, "utf8");
    }
  }
  const identity = "legal.privacy.intro";
  const prior = { en: catalogue.en[identity], es: catalogue.es[identity] };
  const next = { en: `${prior.en} Parser's "native" control.`, es: `${prior.es} Control de analisis.` };
  const bodyIdentity = "legal.instrument.privacy.scope.body";
  const bodyPrior = { en: catalogue.en[bodyIdentity], es: catalogue.es[bodyIdentity] };
  const bodyNext = { en: `${bodyPrior.en} Parser's "instrument" control.`, es: `${bodyPrior.es} Control del instrumento.` };
  base[`${PENDING_DIR}/test-parser.json`] = JSON.stringify({
    schema: 1, recordId: "test-parser", release: "next",
    instruments: {
      "privacy-policy": {
        material: false, priorVersion: legalInstrument("privacy-policy").version,
        note: { en: "Parser control.", es: "Control de analisis." },
        edits: [
          { identity, kind: "string", prior, next },
          { identity: bodyIdentity, kind: "string", prior: bodyPrior, next: bodyNext },
        ],
      },
    },
    paths: [{ id: "terms-receipt", kind: "collection", release: "next" }],
    telemetryWriters: [],
  });
  const result = applyLegalRelease(base, {
    releaseDate: LEGAL_CONTENT_LAST_REVIEWED, migrationId: "20991105130000",
    generatorVersion: GENERATOR_VERSION, baseCommit: "a".repeat(40),
  });
  const stamp = { schema: 1, generatorVersion: GENERATOR_VERSION, release: result.release, surfaces: surfaceHashesFromTree(result.tree) };
  return { base, result, stamp, prior, next, identity };
}

// The tree `node scripts/legal-release.mjs --release` reads, with every real
// pending declaration, folded in memory (#9518 unit 2). Nothing is written.
// A declaration that the next release cannot fold fails here, at its own pull
// request, instead of at the release.
export function pendingLegalRelease(options = {}) {
  const tree = {};
  for (const path of [...FILE_SURFACES, "src/lib/i18n.js", "src/lib/i18n/es.js", REGISTER_SOURCE, STAMP_PATH]) tree[path] = readFileSync(path, "utf8");
  for (const name of readdirSync(PIN_DIR).sort()) if (name.endsWith(".json")) tree[`${PIN_DIR}/${name}`] = readFileSync(`${PIN_DIR}/${name}`, "utf8");
  for (const name of readdirSync(TELEMETRY_PINS).sort()) tree[`${TELEMETRY_PINS}/${name}`] = readFileSync(`${TELEMETRY_PINS}/${name}`, "utf8");
  for (const name of readdirSync(MIGRATIONS_DIR).sort()) if (name.endsWith(".sql")) tree[`${MIGRATIONS_DIR}/${name}`] = readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8");
  const declarations = readdirSync(PENDING_DIR).filter((name) => name.endsWith(".json")).sort();
  for (const name of declarations) tree[`${PENDING_DIR}/${name}`] = readFileSync(`${PENDING_DIR}/${name}`, "utf8");
  for (const writer of readStagedTelemetryWriters(process.cwd())) {
    for (const source of new Set([writer.source, ...(writer.row.sources || []), ...stagedTelemetryConfigPins(writer).map(([path]) => path)])) {
      tree[source] = readFileSync(source, "utf8");
    }
  }
  for (const [key] of readStagedTelemetryPins(process.cwd())) {
    if (key.startsWith("config/")) tree[key.slice("config/".length)] = readFileSync(key.slice("config/".length), "utf8");
    if (key.startsWith("sdkSources/")) tree[key.slice("sdkSources/".length)] = readFileSync(key.slice("sdkSources/".length), "utf8");
  }
  const result = applyLegalRelease(tree, {
    releaseDate: LEGAL_CONTENT_LAST_REVIEWED, migrationId: "20991105130000",
    generatorVersion: GENERATOR_VERSION, baseCommit: "a".repeat(40), renderTelemetry: renderReleaseTelemetry, ...options,
  });
  return { base: tree, result, declarations };
}

export function releasedLegalRoot(release) {
  const root = mkdtempSync(join(tmpdir(), "released-legal-proof-"));
  try {
    for (const [path, text] of Object.entries({ ...release.result.tree, [STAMP_PATH]: JSON.stringify(release.stamp) })) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    mkdirSync(join(root, PENDING_DIR), { recursive: true });
    return { root, close: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
