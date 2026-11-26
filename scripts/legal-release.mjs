// Cut one legal release from the pending files on pinned main.
// A declaration pull request does not run this. It only adds a pending file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TELEMETRY_PINS, collectTelemetrySources, readStagedTelemetryPins, readStagedTelemetryWriters, readTelemetrySources, stagedTelemetryConfigPins, stagedWriterSources, telemetryWriterFailures } from "./lib/telemetry-disclosure-sources.mjs";
import {
  FILE_SURFACES, GENERATOR_VERSION, MIGRATIONS_DIR, PENDING_DIR, PIN_DIR, REGISTER_SOURCE, STAMP_PATH, TELEMETRY_DOCS,
  applyLegalRelease, assertPinnedMain, baselineStamp, collectRepoHashes, latestValidatorExtraction,
  renderReleaseTelemetry, renderTelemetryWithScript, surfaceHashesFromTree, verifyWorkingTree,
} from "./lib/legal-release.mjs";

function main() {
  const root = process.cwd();
  const read = (path) => readFileSync(join(root, path), "utf8");
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  if (process.argv.includes("--check")) {
    const result = verifyWorkingTree(root);
    console.log(`legal release stamp matches ${result.base || "the working tree"}`);
    return;
  }

  if (process.argv.includes("--stamp-baseline")) {
    const stampPath = join(root, STAMP_PATH);
    if (existsSync(stampPath)) {
      const current = JSON.parse(readFileSync(stampPath, "utf8"));
      if (current.release) throw new Error("a release stamp cannot be replaced by a baseline");
    }
    writeFileSync(stampPath, `${JSON.stringify(baselineStamp(root), null, 2)}\n`);
    console.log("wrote the baseline legal release stamp");
    return;
  }

  if (!process.argv.includes("--release")) {
    console.error("usage: node scripts/legal-release.mjs --check | --stamp-baseline | --release --date YYYY-MM-DD --migration-id YYYYMMDDHHMMSS");
    process.exitCode = 1;
    return;
  }

  const dateFlag = process.argv.indexOf("--date");
  const migrationFlag = process.argv.indexOf("--migration-id");
  const releaseDate = dateFlag >= 0 ? process.argv[dateFlag + 1] : "";
  const migrationId = migrationFlag >= 0 ? process.argv[migrationFlag + 1] : "";
  const tree = {};
  for (const path of [...FILE_SURFACES, "src/lib/i18n.js", "src/lib/i18n/es.js", REGISTER_SOURCE]) tree[path] = read(path);
  for (const name of readdirSync(join(root, PIN_DIR))) {
    const path = `${PIN_DIR}/${name}`;
    if (statSync(join(root, path)).isFile()) tree[path] = read(path);
  }
  for (const name of readdirSync(join(root, TELEMETRY_PINS))) tree[`${TELEMETRY_PINS}/${name}`] = read(`${TELEMETRY_PINS}/${name}`);
  for (const name of readdirSync(join(root, MIGRATIONS_DIR))) {
    if (name.endsWith(".sql")) tree[`${MIGRATIONS_DIR}/${name}`] = read(`${MIGRATIONS_DIR}/${name}`);
  }
  for (const name of readdirSync(join(root, PENDING_DIR))) {
    if (name.endsWith(".json")) tree[`${PENDING_DIR}/${name}`] = read(`${PENDING_DIR}/${name}`);
  }
  for (const writer of readStagedTelemetryWriters(root)) {
    for (const source of new Set([...stagedWriterSources(writer), ...stagedTelemetryConfigPins(writer).map(([source]) => source)])) {
      if (!/^(src|api)\/.*\.(js|jsx)$/.test(source) || source.split("/").includes("..")) throw new Error("invalid staged telemetry source");
      tree[source] = read(source);
    }
  }
  for (const [key] of readStagedTelemetryPins(root)) {
    if (key.startsWith("config/")) tree[key.slice("config/".length)] = read(key.slice("config/".length));
    // The installed library file is read so the release re-verifies its bytes.
    if (key.startsWith("sdkSources/")) tree[key.slice("sdkSources/".length)] = read(key.slice("sdkSources/".length));
  }
  if (existsSync(join(root, STAMP_PATH))) tree[STAMP_PATH] = read(STAMP_PATH);
  const extracted = latestValidatorExtraction(tree);
  let committedSql;
  try {
    committedSql = git(["show", `origin/main:${extracted.path}`]);
  } catch {
    throw new Error(`The latest validator is not on origin/main (${extracted.path}). Apply that predecessor on main first.`);
  }
  const committed = latestValidatorExtraction({ [extracted.path]: committedSql }).body;
  assertPinnedMain({
    headCommit: git(["rev-parse", "HEAD"]),
    mainCommit: git(["rev-parse", "origin/main"]),
    headValidator: extracted.body,
    mainValidator: committed,
  });
  const folded = applyLegalRelease(tree, {
    baseCommit: git(["rev-parse", "HEAD"]),
    releaseDate,
    migrationId,
    generatorVersion: GENERATOR_VERSION,
    renderTelemetry: renderReleaseTelemetry,
  });
  const failures = telemetryWriterFailures(collectTelemetrySources(), readTelemetrySources(), readStagedTelemetryWriters(root));
  if (failures.length) throw new Error(`unlisted telemetry writers: ${failures.join(", ")}`);
  for (const [path, text] of Object.entries(folded.tree)) {
    if (tree[path] !== text) writeFileSync(join(root, path), text);
  }
  for (const path of Object.keys(tree)) {
    if (!Object.hasOwn(folded.tree, path)) unlinkSync(join(root, path));
  }
  // The script is the document producer. It rewrites the three generated pages
  // from the inventory just written. A drift means this renderer and the
  // script no longer emit the same sentences, so the release stops.
  const expectedDocs = Object.fromEntries(TELEMETRY_DOCS.map((path) => [path, folded.tree[path]]));
  renderTelemetryWithScript(root);
  for (const path of TELEMETRY_DOCS) {
    if (read(path) !== expectedDocs[path]) throw new Error(`telemetry renderer drifted: ${path}`);
  }
  // The register script writes the same policy block from the same source; with
  // the pending files consumed, its full check must pass on the release output.
  try {
    execFileSync(process.execPath, ["scripts/render-subprocessor-register.mjs", "--check"], { cwd: root, stdio: "pipe" });
  } catch {
    throw new Error("subprocessor register renderer drifted from the release output");
  }
  if (JSON.stringify(collectRepoHashes(root)) !== JSON.stringify(surfaceHashesFromTree(folded.tree))) throw new Error("telemetry source pins differ from the declared release output");
  const stamp = {
    schema: 1,
    generatorVersion: GENERATOR_VERSION,
    release: folded.release,
    surfaces: collectRepoHashes(root),
  };
  writeFileSync(join(root, STAMP_PATH), `${JSON.stringify(stamp, null, 2)}\n`);
  console.log(`released ${migrationId} on ${releaseDate}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
