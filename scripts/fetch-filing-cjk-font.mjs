#!/usr/bin/env node
// The Chinese, Japanese and Korean font for the official filing copy (#8725
// step 2): Noto Sans CJK SC Regular, from the notofonts noto-cjk release
// Sans2.004, pinned by commit and sha256. It is 16 MB, over the repository's
// 1 MB per-file rule, so it is not committed: the Vercel build command
// (vercel.json) runs this before `npm run build`, and api/form-filing.js reads
// it from the function bundle (includeFiles). Nothing is fetched at run time.
// A download whose sha256 is not the pin fails the build and leaves no file.
// Without the file (tests, local runs) the copy prints Chinese, Japanese and
// Korean as [U+XXXX] codes with the note, as before.
//
// A verified copy is also kept in .vercel/cache, which Vercel's build cache
// restores before each build and saves after each successful one, so most
// builds do not download again. The cached copy is checked against the same
// sha256 before it is used; a copy that does not match is deleted and the
// font is downloaded.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const CJK_FONT = {
  url: "https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
  sha256: "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b",
  bytes: 16437364,
  path: fileURLToPath(new URL("../api/_lib/fonts/NotoSansCJKsc-Regular.otf", import.meta.url)),
  cache: fileURLToPath(new URL("../.vercel/cache/filing-cjk-font/NotoSansCJKsc-Regular.otf", import.meta.url)),
};

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// True when `path` holds exactly the pinned bytes; a file that does not is deleted.
async function holdsPin(path, pin) {
  if (!existsSync(path)) return false;
  if (await sha256Hex(readFileSync(path)) === pin.sha256) return true;
  rmSync(path, { force: true });
  return false;
}

// Makes sure `pin.path` holds exactly the pinned font. Returns "present" when
// it already did, "cached" when it came from the build cache, "downloaded"
// when it was fetched; throws on a pin mismatch or when every attempt fails.
export async function ensureFilingCjkFont(pin = CJK_FONT, { get = download, attempts = 3, wait = pause } = {}) {
  if (await holdsPin(pin.path, pin)) return "present";
  if (pin.cache && await holdsPin(pin.cache, pin)) {
    copyFileSync(pin.cache, pin.path);
    return "cached";
  }
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await wait(2000 * (attempt - 1));
    let bytes;
    try {
      bytes = await get(pin.url);
    } catch (error) {
      lastError = error;
      continue;
    }
    const digest = await sha256Hex(bytes);
    if (digest !== pin.sha256 || bytes.length !== pin.bytes) {
      rmSync(pin.path, { force: true });
      throw new Error(`filing CJK font does not match its pin: sha256 ${digest}, ${bytes.length} bytes; expected ${pin.sha256}, ${pin.bytes} bytes`);
    }
    const partial = `${pin.path}.partial`;
    writeFileSync(partial, bytes);
    renameSync(partial, pin.path);
    if (pin.cache) {
      mkdirSync(dirname(pin.cache), { recursive: true });
      copyFileSync(pin.path, pin.cache);
    }
    return "downloaded";
  }
  throw new Error(`filing CJK font could not be downloaded: ${String(lastError)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(`filing CJK font ${await ensureFilingCjkFont()}: ${CJK_FONT.path}`);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
