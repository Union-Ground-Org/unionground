#!/usr/bin/env node
// At each Production switch Vercel's edge keeps serving its
// copy of the old page for about 20 seconds, while every hashed file that page
// names already answers 404 from the new deployment. A first-time visitor in
// that window gets unstyled text and an app that never starts.
//
// The last step of `npm run build`:
//   1. Every build writes dist/asset-manifest.json: each hashed file under
//      dist/assets with its sha256 and size, marked "own" (this build made it)
//      or "carried" (copied from the build that was live).
//   2. Only in a hosted build (isHostedBuild: Vercel building a Production or
//      Preview deployment), before writing the manifest, it reads the live
//      Production build's manifest from the public host and copies that build's
//      OWN files missing here into dist/assets, so the old page keeps working
//      through the switch. One generation only: files the live build itself
//      carried are not copied again, so the folder never grows without bound.
//      Each file must match its listed sha256 and size, and is read with the
//      smaller of its listed size and the byte budget left, or that one file is
//      dropped; the first 5 refused or dropped entries are logged, then one
//      count line. A file of the same name already here is never replaced or
//      fetched. Only hashed /assets names are taken (never HTML, JSON or the
//      unhashed files from public/assets).
//   3. A failure of the whole carry (no manifest, a fetch error, the 20 s total
//      time, a write error, which removes every file this run wrote) logs one
//      line and the build goes on with no carry, exactly as before this step
//      existed.
//
// It runs after the build's own checks, so those read only what this build
// made; a carried file is byte-identical (sha256) to a file the live build
// shipped after passing the same checks. CI, tests and a local
// `npm run build` never fetch anything. Requests go only to the configured production origin,
// over HTTPS, with no credential or cookie, and a redirect is never followed.
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_NAME = "asset-manifest.json";
export const MANIFEST_VERSION = 1;
export const CARRY_LIMITS = Object.freeze({
  timeoutMs: 20_000,
  // A whole assets folder is about 14.5 MB; most names repeat between builds.
  maxBytes: 32 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxFiles: 2000,
  concurrency: 8,
});

// Vite's hashed output, `[name]-[hash].[ext]` with an 8-character base64url
// hash, and the critical sheet scripts/lib/critical-full-styles.mjs names
// `critical-<12 hex>.css`.
const HASHED_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,150}-(?:[A-Za-z0-9_-]{8}|[0-9a-f]{12})\.(?:js|css|woff2|woff|ttf|otf|svg|png|jpg|jpeg|webp|avif|gif|ico|wasm)$/;
const SHA256 = /^[0-9a-f]{64}$/;

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

/** True for a flat hashed /assets file name that public/assets did not ship. */
export function isHashedAssetName(name, publicNames = new Set()) {
  return typeof name === "string" && HASHED_NAME.test(name) && !publicNames.has(name);
}

/**
 * The hosted-build signal. Vercel sets VERCEL=1 and VERCEL_ENV in its own
 * build; nothing in this repository's CI, tests or local scripts sets VERCEL=1
 * (tests stub VERCEL_ENV alone). GitHub Actions and Vitest are refused outright
 * in case one ever does. A wrong match could only make a public read.
 */
export function isHostedBuild(env = process.env) {
  if (env.GITHUB_ACTIONS || env.VITEST) return false;
  return env.VERCEL === "1" && (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview");
}

function publicNamesIn(publicAssetsDir) {
  return new Set(existsSync(publicAssetsDir) ? readdirSync(publicAssetsDir) : []);
}

/** This build's own hashed files under dist/assets, sorted by name. */
export async function listOwnAssets(distDir, publicAssetsDir) {
  const assetsDir = join(distDir, "assets");
  const publicNames = publicNamesIn(publicAssetsDir);
  const names = readdirSync(assetsDir).filter((name) => isHashedAssetName(name, publicNames) && statSync(join(assetsDir, name)).isFile()).sort();
  return Promise.all(names.map(async (name) => {
    const bytes = readFileSync(join(assetsDir, name));
    return { name, sha256: await sha256Hex(bytes), bytes: bytes.length, origin: "own" };
  }));
}

class CarryAbort extends Error {}
class Overrun extends Error {}

const LOGGED_DROPS = 5;

// Reads a body of at most `limit` bytes; a longer one throws Overrun.
async function readBounded(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Overrun(`over its ${limit}-byte bound`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > limit) throw new Overrun(`over its ${limit}-byte bound`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function get(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { redirect: "manual", credentials: "omit", cache: "no-store", signal, headers: { accept: "*/*" } });
  return response;
}

function parseManifest(bytes, limits) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CarryAbort("the live manifest is not JSON");
  }
  if (!manifest || manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.files)) throw new CarryAbort("the live manifest is not version 1");
  if (manifest.files.length > limits.maxFiles) throw new CarryAbort(`the live manifest lists over ${limits.maxFiles} files`);
  return manifest;
}

/**
 * Copies the live build's own hashed files missing from dist/assets. Never
 * throws for a network or manifest problem: it logs one line and returns [].
 * Nothing is written unless every fetch finished inside the time and byte
 * bounds; each written file was verified against its listed sha256 and size.
 */
export async function carryPreviousAssets({ distDir, publicAssetsDir, origin, fetchImpl = globalThis.fetch, limits: overrides, log = console.log, writeFile = writeFileSync } = {}) {
  const previousOrigin = origin?.trim().replace(/\/+$/, "");
  if (!previousOrigin) {
    log("asset carry: skipped because ASSET_CARRY_PRODUCTION_ORIGIN is unset");
    return [];
  }
  const limits = { ...CARRY_LIMITS, ...overrides };
  const assetsDir = join(distDir, "assets");
  const publicNames = publicNamesIn(publicAssetsDir);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, limits.timeoutMs);
  let budgetLeft = limits.maxBytes;
  const dropped = [];
  let present = 0;
  try {
    const manifestResponse = await get(fetchImpl, `${previousOrigin}/${MANIFEST_NAME}`, controller.signal);
    if (manifestResponse.status !== 200) throw new CarryAbort(`the live manifest answered HTTP ${manifestResponse.status}`);
    let manifestBytes;
    try {
      manifestBytes = await readBounded(manifestResponse, limits.maxManifestBytes);
    } catch (error) {
      throw error instanceof Overrun ? new CarryAbort(`the live manifest is ${error.message}`) : error;
    }
    const manifest = parseManifest(manifestBytes, limits);
    const wanted = [];
    const seen = new Set();
    for (const file of manifest.files) {
      // One generation: only what the live build made itself.
      if (!file || file.origin !== "own" || seen.has(file.name)) continue;
      if (!isHashedAssetName(file.name, publicNames) || !SHA256.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
        dropped.push(`refused ${JSON.stringify(String(file.name).slice(0, 200))}: not a hashed asset entry`);
        continue;
      }
      seen.add(file.name);
      // Never shadow, never refetch, a file this build already has.
      if (existsSync(join(assetsDir, file.name))) { present += 1; continue; }
      wanted.push(file);
    }
    const fetched = [];
    let next = 0;
    const worker = async () => {
      while (next < wanted.length) {
        const file = wanted[next];
        next += 1;
        // The smaller of its listed size and the budget left; taken before the
        // fetch, so the order of the live manifest decides who fits.
        const limit = Math.min(file.bytes, budgetLeft);
        budgetLeft -= limit;
        const response = await get(fetchImpl, `${previousOrigin}/assets/${file.name}`, controller.signal);
        if (response.status !== 200) {
          await response.body?.cancel();
          dropped.push(`dropped ${file.name}: HTTP ${response.status}`);
          continue;
        }
        let bytes;
        try {
          bytes = await readBounded(response, limit);
        } catch (error) {
          if (!(error instanceof Overrun)) throw error;
          await response.body?.cancel().catch(() => {});
          dropped.push(`dropped ${file.name}: ${error.message} (listed size or byte budget)`);
          continue;
        }
        const digest = await sha256Hex(bytes);
        if (digest !== file.sha256 || bytes.length !== file.bytes) {
          dropped.push(`dropped ${file.name}: sha256 or size differs from the live manifest`);
          continue;
        }
        fetched.push({ file, bytes });
      }
    };
    await Promise.all(Array.from({ length: Math.min(limits.concurrency, wanted.length) }, worker));
    if (controller.signal.aborted) throw new CarryAbort("the total time ran out");
    const carried = [];
    for (const { file, bytes } of fetched.sort((a, b) => (a.file.name < b.file.name ? -1 : 1))) {
      try {
        // "wx": a file of that name appearing meanwhile is kept, never replaced.
        writeFile(join(assetsDir, file.name), bytes, { flag: "wx" });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          // No partly written file ships: remove this one and every one before it.
          // Only EEXIST means the name was someone else's, so these are ours.
          for (const name of [...carried.map((done) => done.name), file.name]) {
            try { unlinkSync(join(assetsDir, name)); } catch { /* already gone */ }
          }
          throw new CarryAbort(`write failed (${error?.code || error?.name || "error"})`);
        }
        present += 1;
        continue;
      }
      carried.push({ name: file.name, sha256: file.sha256, bytes: file.bytes, origin: "carried" });
    }
    for (const line of dropped.slice(0, LOGGED_DROPS)) log(`asset carry: ${line}`);
    if (dropped.length) log(`asset carry: ${dropped.length} entries refused or dropped in all${dropped.length > LOGGED_DROPS ? `, the first ${LOGGED_DROPS} listed above` : ""}`);
    const total = carried.reduce((sum, file) => sum + file.bytes, 0);
    log(`asset carry: carried ${carried.length} files (${total} bytes) from ${previousOrigin} build ${String(manifest.build ?? "unknown").slice(0, 40)} in ${Date.now() - started} ms; ${present} already here`);
    return carried;
  } catch (error) {
    const reason = controller.signal.aborted ? "the total time ran out" : error instanceof CarryAbort ? error.message : `fetch failed (${error?.cause?.code || error?.name || "error"})`;
    log(`asset carry: no carry, ${reason}; the build goes on without the previous build's files`);
    return [];
  } finally {
    clearTimeout(timer);
    // Stops any fetch still running after a failed one.
    controller.abort();
  }
}

function readBuildSha(distDir) {
  try {
    const sha = JSON.parse(readFileSync(join(distDir, "build-info.json"), "utf8")).commitSha;
    return typeof sha === "string" ? sha : null;
  } catch {
    return null;
  }
}

/** The build step: carry when hosted, then write the manifest. */
export async function runAssetCarry({ distDir, publicAssetsDir, env = process.env, origin = env.ASSET_CARRY_PRODUCTION_ORIGIN, fetchImpl, limits, log = console.log, writeFile }) {
  const own = await listOwnAssets(distDir, publicAssetsDir);
  const carried = isHostedBuild(env) ? await carryPreviousAssets({ distDir, publicAssetsDir, origin, fetchImpl, limits, log, writeFile }) : [];
  const files = [...own, ...carried].sort((a, b) => (a.name < b.name ? -1 : 1));
  const manifest = { version: MANIFEST_VERSION, build: readBuildSha(distDir), files };
  writeFileSync(join(distDir, MANIFEST_NAME), `${JSON.stringify(manifest)}\n`);
  return { own, carried };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  await runAssetCarry({ distDir: join(root, "dist"), publicAssetsDir: join(root, "public", "assets") });
}
