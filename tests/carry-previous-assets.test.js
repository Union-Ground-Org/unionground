// @vitest-environment node
// At each Production switch the edge keeps serving the old
// page for about 20 seconds while the files it names already answer 404. The
// build carries the live build's own hashed /assets files into the new build
// (scripts/carry-previous-assets.mjs). Every fetch here goes to a fake host on
// 127.0.0.1; nothing touches the real network.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CARRY_LIMITS,
  MANIFEST_NAME,
  carryPreviousAssets,
  isHashedAssetName,
  isHostedBuild,
  listOwnAssets,
  runAssetCarry,
  sha256Hex,
} from "../scripts/carry-previous-assets.mjs";

const HOSTED = { VERCEL: "1", VERCEL_ENV: "production" };

let directory;
let server;
afterEach(async () => {
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
  server = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

// A build output: dist/assets with the given files, and a public/assets folder
// holding the unhashed files Vite copies through unchanged.
function makeBuild(assets, publicNames = ["archivo-latin.woff2", "favicon.svg"]) {
  directory = mkdtempSync(join(tmpdir(), "carry-previous-assets-"));
  const dist = join(directory, "dist");
  const publicAssets = join(directory, "public", "assets");
  mkdirSync(join(dist, "assets"), { recursive: true });
  mkdirSync(publicAssets, { recursive: true });
  for (const name of publicNames) {
    writeFileSync(join(publicAssets, name), `public ${name}`);
    writeFileSync(join(dist, "assets", name), `public ${name}`);
  }
  for (const [name, text] of Object.entries(assets)) writeFileSync(join(dist, "assets", name), text);
  writeFileSync(join(dist, "build-info.json"), JSON.stringify({ commitSha: "b".repeat(40) }));
  return { dist, publicAssets };
}

const entry = async (name, text, origin = "own") => ({ name, sha256: await sha256Hex(Buffer.from(text)), bytes: Buffer.byteLength(text), origin });
const entries = (...rows) => Promise.all(rows.map((row) => entry(...row)));
const liveManifest = async (files) => JSON.stringify({ version: 1, build: "a".repeat(40), files: await files });

// The fake Production host: path -> body string, or a function (req, res).
async function fakeHost(routes) {
  const requests = [];
  server = createServer((request, response) => {
    requests.push(request.url);
    const route = routes[request.url];
    if (typeof route === "function") return route(request, response);
    if (route === undefined) {
      response.writeHead(404, { "content-type": "text/html" });
      return response.end("<!doctype html><title>Page not found</title>");
    }
    response.writeHead(200);
    return response.end(route);
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

function collect() {
  const lines = [];
  return { lines, log: (line) => { lines.push(line); } };
}

const readManifest = (dist) => JSON.parse(readFileSync(join(dist, MANIFEST_NAME), "utf8"));

it("skips a hosted build without a configured production origin and still writes its manifest", async () => {
  const { dist, publicAssets } = makeBuild({ "index-XUMKDY1P.js": "entry" });
  const log = vi.fn();
  const fetchImpl = vi.fn();
  const result = await runAssetCarry({ distDir: dist, publicAssetsDir: publicAssets, env: HOSTED, log, fetchImpl });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("ASSET_CARRY_PRODUCTION_ORIGIN is unset"));
  expect(result.carried).toEqual([]);
  expect(readManifest(dist).files).toEqual(result.own);
});

describe("which files the carry may copy", () => {
  it("accepts Vite's 8-character hashed names and the 12-hex critical sheet", () => {
    for (const name of ["index-XUMKDY1P.js", "AboutView-Bo7JkWzf.js", "AboutView-C7mETRso.css", "AccessHistoryView-Bezl_alN.js", "critical-e5b6a1188e6b.css", "hero-DkS-9_aQ.webp", "mark-Cq1x2y3z.svg"]) {
      expect(isHashedAssetName(name), name).toBe(true);
    }
  });

  it("refuses HTML, JSON, maps, unhashed names, paths and names shipped from public/assets", () => {
    const publicNames = new Set(["archivo-latin.woff2", "favicon.svg", "spline-sans-ABCDEFGH.woff2"]);
    for (const name of ["index.html", "asset-manifest.json", "build-info.json", "x-ABCDEFGH.html", "x-ABCDEFGH.json", "index-XUMKDY1P.js.map", "archivo-latin.woff2", "favicon.svg", "sw.js", "../index-XUMKDY1P.js", "sub/index-XUMKDY1P.js", ".hidden-XUMKDY1P.js", "index-XUMKDY1.js", "index-XUMKDY1P.JS", "spline-sans-ABCDEFGH.woff2", "", 42, null]) {
      expect(isHashedAssetName(name, publicNames), String(name)).toBe(false);
    }
  });
});

describe("the manifest every build writes", () => {
  it("lists each own hashed file with its sha256 and size, sorted, and leaves out public and unhashed files", async () => {
    const { dist, publicAssets } = makeBuild({ "index-XUMKDY1P.js": "entry", "critical-e5b6a1188e6b.css": "body{}", "notes.txt": "x" });
    expect(await listOwnAssets(dist, publicAssets)).toEqual([await entry("critical-e5b6a1188e6b.css", "body{}"), await entry("index-XUMKDY1P.js", "entry")]);
  });

  it("is written by a build without the hosted signal, which makes no fetch at all", async () => {
    const { dist, publicAssets } = makeBuild({ "index-XUMKDY1P.js": "entry" });
    const calls = [];
    const summary = await runAssetCarry({ distDir: dist, publicAssetsDir: publicAssets, env: { CI: "true", GITHUB_ACTIONS: "true" }, fetchImpl: async (url) => { calls.push(url); throw new Error("no network"); }, log: () => {} });
    expect(calls).toEqual([]);
    expect(summary.carried).toEqual([]);
    expect(readManifest(dist)).toEqual({ version: 1, build: "b".repeat(40), files: [await entry("index-XUMKDY1P.js", "entry")] });
  });
});

describe("the hosted-build signal", () => {
  it("is Vercel's own build of a Production or Preview deployment, never CI, tests or a local build", () => {
    expect(isHostedBuild(HOSTED)).toBe(true);
    expect(isHostedBuild({ VERCEL: "1", VERCEL_ENV: "preview" })).toBe(true);
    expect(isHostedBuild({})).toBe(false);
    expect(isHostedBuild({ VERCEL_ENV: "production" })).toBe(false);
    expect(isHostedBuild({ VERCEL: "1", VERCEL_ENV: "development" })).toBe(false);
    expect(isHostedBuild({ ...HOSTED, GITHUB_ACTIONS: "true" })).toBe(false);
    expect(isHostedBuild({ ...HOSTED, VITEST: "true" })).toBe(false);
  });

  it("reads only the public Production host, over HTTPS", () => {
    expect(CARRY_LIMITS.timeoutMs).toBe(20_000);
  });
});

describe("carrying the live build's files", () => {
  it("copies the live build's own files that are missing, byte for byte, and marks them carried", async () => {
    const { dist, publicAssets } = makeBuild({ "index-NEWNEW01.js": "new entry", "vendor-react-SAMESAME.js": "react" });
    const host = await fakeHost({
      "/asset-manifest.json": await liveManifest(entries(["index-OLDOLD01.js", "old entry"], ["critical-0123456789ab.css", "old critical"], ["vendor-react-SAMESAME.js", "react"])),
      "/assets/index-OLDOLD01.js": "old entry",
      "/assets/critical-0123456789ab.css": "old critical",
    });
    const { lines, log } = collect();
    const summary = await runAssetCarry({ distDir: dist, publicAssetsDir: publicAssets, env: { ...HOSTED, ASSET_CARRY_PRODUCTION_ORIGIN: `${host.origin}/` }, log });
    expect(readFileSync(join(dist, "assets", "index-OLDOLD01.js"), "utf8")).toBe("old entry");
    expect(readFileSync(join(dist, "assets", "critical-0123456789ab.css"), "utf8")).toBe("old critical");
    expect(summary.carried.map((file) => file.name)).toEqual(["critical-0123456789ab.css", "index-OLDOLD01.js"]);
    // The file both builds share is not fetched again.
    expect(host.requests).not.toContain("/assets/vendor-react-SAMESAME.js");
    expect(readManifest(dist).files).toEqual([
      await entry("critical-0123456789ab.css", "old critical", "carried"),
      await entry("index-NEWNEW01.js", "new entry"),
      await entry("index-OLDOLD01.js", "old entry", "carried"),
      await entry("vendor-react-SAMESAME.js", "react"),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/carried 2 files/);
  });

  it("carries one generation only: files the live build itself carried are never copied again", async () => {
    const { dist, publicAssets } = makeBuild({ "index-NEWNEW01.js": "new entry" });
    const host = await fakeHost({
      "/asset-manifest.json": await liveManifest(entries(["index-OLDOLD01.js", "old entry"], ["index-OLDEST01.js", "oldest entry", "carried"])),
      "/assets/index-OLDOLD01.js": "old entry",
      "/assets/index-OLDEST01.js": "oldest entry",
    });
    await runAssetCarry({ distDir: dist, publicAssetsDir: publicAssets, env: HOSTED, origin: host.origin, log: () => {} });
    expect(host.requests).not.toContain("/assets/index-OLDEST01.js");
    expect(existsSync(join(dist, "assets", "index-OLDEST01.js"))).toBe(false);
    expect(readManifest(dist).files.map((file) => [file.name, file.origin])).toEqual([["index-NEWNEW01.js", "own"], ["index-OLDOLD01.js", "carried"]]);
  });

  it("drops a file whose bytes do not match the live manifest's sha256, with one log line, and keeps the rest", async () => {
    const { dist, publicAssets } = makeBuild({ "index-NEWNEW01.js": "new entry" });
    const host = await fakeHost({
      "/asset-manifest.json": await liveManifest(entries(["index-OLDOLD01.js", "old entry"], ["chunk-TAMPERED.js", "real bytes"])),
      "/assets/index-OLDOLD01.js": "old entry",
      "/assets/chunk-TAMPERED.js": "fake bytes",
    });
    const { lines, log } = collect();
    const summary = await runAssetCarry({ distDir: dist, publicAssetsDir: publicAssets, env: HOSTED, origin: host.origin, log });
    expect(existsSync(join(dist, "assets", "chunk-TAMPERED.js"))).toBe(false);
    expect(summary.carried.map((file) => file.name)).toEqual(["index-OLDOLD01.js"]);
    expect(lines.filter((line) => line.includes("chunk-TAMPERED.js"))).toHaveLength(1);
    expect(lines.find((line) => line.includes("chunk-TAMPERED.js"))).toMatch(/sha256/);
  });

  it("refuses a listed name that does not match the hashed-name pattern, and never requests it", async () => {
    const { dist, publicAssets } = makeBuild({ "index-NEWNEW01.js": "new entry" });
    const host = await fakeHost({
      "/asset-manifest.json": await liveManifest(entries(["index.html", "<html>"], ["../sw-ABCDEFGH.js", "x"], ["favicon.svg", "svg"], ["index-OLDOLD01.js", "old entry"])),
      "/assets/index-OLDOLD01.js": "old entry",
    });
    const summary = await runAssetCarry({ distDir: dist, publicAssetsDir: publicAssets, env: HOSTED, origin: host.origin, log: () => {} });
    expect(summary.carried.map((file) => file.name)).toEqual(["index-OLDOLD01.js"]);
    expect(host.requests.sort()).toEqual(["/asset-manifest.json", "/assets/index-OLDOLD01.js"]);
    expect(readFileSync(join(dist, "assets", "favicon.svg"), "utf8")).toBe("public favicon.svg");
  });

  it("reads each file with the smaller of its listed size and the budget left, and drops only the file that overruns", async () => {
    const big = "x".repeat(4096);
    const { dist, publicAssets } = makeBuild({ "index-NEWNEW01.js": "new entry" });
    const listed = await entries(["index-OLDOLD01.js", "old entry"], ["chunk-LONGER01.js", "short"], ["chunk-BIGBIG01.js", big], ["chunk-BIGBIG02.js", big]);
    const host = await fakeHost({
      "/asset-manifest.json": JSON.stringify({ version: 1, build: "a".repeat(40), files: listed }),
      "/assets/chunk-BIGBIG01.js": big,
      "/assets/chunk-BIGBIG02.js": big,
      // Longer than its listed size: read only up to that size, then dropped.
      "/assets/chunk-LONGER01.js": "short, then much more than was listed",
      "/assets/index-OLDOLD01.js": "old entry",
    });
    const { lines, log } = collect();
    const summary = await runAssetCarry({ distDir: dist, publicAssetsDir: publicAssets, env: HOSTED, origin: host.origin, log, limits: { maxBytes: 6000 } });
    // In manifest order: 9 + 5 + 4,096 of 6,000 are taken; the second big file gets the 1,890 left and overruns.
    expect(summary.carried.map((file) => file.name)).toEqual(["chunk-BIGBIG01.js", "index-OLDOLD01.js"]);
    expect(existsSync(join(dist, "assets", "chunk-BIGBIG02.js"))).toBe(false);
    expect(existsSync(join(dist, "assets", "chunk-LONGER01.js"))).toBe(false);
    expect(lines.filter((line) => /chunk-BIGBIG02\.js: over its 1890-byte bound/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /chunk-LONGER01\.js: over its 5-byte bound/.test(line))).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/carried 2 files/);
  });

  it("logs the first 5 refused or dropped entries and one count line, never one line per entry", async () => {
    const { dist, publicAssets } = makeBuild({ "index-NEWNEW01.js": "new entry" });
    const refused = await entries(...Array.from({ length: 40 }, (_, index) => [`page-${index}.html`, "<html>"]), ["index-OLDOLD01.js", "old entry"]);
    const host = await fakeHost({
      "/asset-manifest.json": JSON.stringify({ version: 1, build: "a".repeat(40), files: refused }),
      "/assets/index-OLDOLD01.js": "old entry",
    });
    const { lines, log } = collect();
    const summary = await runAssetCarry({ distDir: dist, publicAssetsDir: publicAssets, env: HOSTED, origin: host.origin, log });
    expect(summary.carried.map((file) => file.name)).toEqual(["index-OLDOLD01.js"]);
    expect(lines).toHaveLength(7);
    expect(lines.slice(0, 5).every((line) => /refused "page-\d+\.html"/.test(line))).toBe(true);
    expect(lines[5]).toMatch(/40 entries refused or dropped in all, the first 5 listed above/);
    expect(lines[6]).toMatch(/carried 1 files/);
  });

  it("never replaces a current file of the same name, and does not fetch it", async () => {
    const { dist, publicAssets } = makeBuild({ "index-SAMENAME.js": "current bytes" });
    const host = await fakeHost({
      "/asset-manifest.json": await liveManifest(entries(["index-SAMENAME.js", "live bytes"])),
      "/assets/index-SAMENAME.js": "live bytes",
    });
    const summary = await runAssetCarry({ distDir: dist, publicAssetsDir: publicAssets, env: HOSTED, origin: host.origin, log: () => {} });
    expect(readFileSync(join(dist, "assets", "index-SAMENAME.js"), "utf8")).toBe("current bytes");
    expect(host.requests).toEqual(["/asset-manifest.json"]);
    expect(summary.carried).toEqual([]);
    expect(readManifest(dist).files).toEqual([await entry("index-SAMENAME.js", "current bytes")]);
  });
});

describe("the soft fail: one log line, no carry, the build goes on", () => {
  async function softFail(routes, options = {}) {
    const { dist, publicAssets } = makeBuild({ "index-NEWNEW01.js": "new entry" });
    const host = await fakeHost(routes);
    const { lines, log } = collect();
    const summary = await runAssetCarry({ distDir: dist, publicAssetsDir: publicAssets, env: HOSTED, origin: options.origin ?? host.origin, log, limits: options.limits });
    expect(summary.carried).toEqual([]);
    expect(readdirSync(join(dist, "assets")).sort()).toEqual(["archivo-latin.woff2", "favicon.svg", "index-NEWNEW01.js"]);
    expect(readManifest(dist).files).toEqual([await entry("index-NEWNEW01.js", "new entry")]);
    expect(lines).toHaveLength(1);
    return { line: lines[0], host };
  }

  it("when the live build has no manifest (the 404 page)", async () => {
    const { line } = await softFail({});
    expect(line).toMatch(/no carry/);
    expect(line).toMatch(/404/);
  });

  it("when the manifest is not valid JSON or not the expected shape", async () => {
    expect((await softFail({ "/asset-manifest.json": "<!doctype html>" })).line).toMatch(/no carry/);
    await new Promise((resolve) => { server.close(resolve); });
    server = undefined;
    rmSync(directory, { recursive: true, force: true });
    expect((await softFail({ "/asset-manifest.json": JSON.stringify({ version: 2, files: [] }) })).line).toMatch(/no carry/);
  });

  it("when the host cannot be reached", async () => {
    const { line } = await softFail({}, { origin: "http://127.0.0.1:1" });
    expect(line).toMatch(/no carry/);
  });

  it("when the total time runs out, even after some files arrived", async () => {
    const { line } = await softFail({
      "/asset-manifest.json": await liveManifest(entries(["index-OLDOLD01.js", "old entry"], ["chunk-STALLED1.js", "stalled"])),
      "/assets/index-OLDOLD01.js": "old entry",
      "/assets/chunk-STALLED1.js": (request, response) => { response.writeHead(200); response.write("sta"); },
    }, { limits: { timeoutMs: 300 } });
    expect(line).toMatch(/no carry/);
    expect(line).toMatch(/time/);
  });

  it("when writing a carried file fails, removing every file this run wrote", async () => {
    const writes = [];
    const writeFile = (path, bytes, options) => {
      writes.push(path);
      if (writes.length === 1) return writeFileSync(path, bytes, options);
      writeFileSync(path, bytes.subarray(0, 2), options);
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    };
    const { dist, publicAssets } = makeBuild({ "index-NEWNEW01.js": "new entry" });
    const host = await fakeHost({
      "/asset-manifest.json": await liveManifest(entries(["chunk-WRITTEN1.js", "written first"], ["chunk-WRITTEN2.js", "half written"])),
      "/assets/chunk-WRITTEN1.js": "written first",
      "/assets/chunk-WRITTEN2.js": "half written",
    });
    const { lines, log } = collect();
    const summary = await runAssetCarry({ distDir: dist, publicAssetsDir: publicAssets, env: HOSTED, origin: host.origin, log, writeFile });
    expect(writes).toHaveLength(2);
    expect(summary.carried).toEqual([]);
    expect(readdirSync(join(dist, "assets")).sort()).toEqual(["archivo-latin.woff2", "favicon.svg", "index-NEWNEW01.js"]);
    expect(readManifest(dist).files).toEqual([await entry("index-NEWNEW01.js", "new entry")]);
    expect(lines).toEqual([expect.stringMatching(/no carry, write failed \(ENOSPC\)/)]);
  });

  it("when the host answers with a redirect, which is never followed", async () => {
    const emptyManifest = await liveManifest(entries());
    const other = createServer((request, response) => { response.writeHead(200); response.end(emptyManifest); });
    await new Promise((resolve) => { other.listen(0, "127.0.0.1", resolve); });
    const otherRequests = [];
    other.on("request", (request) => { otherRequests.push(request.url); });
    try {
      const { line } = await softFail({
        "/asset-manifest.json": (request, response) => { response.writeHead(302, { location: `http://127.0.0.1:${other.address().port}/asset-manifest.json` }); response.end(); },
      });
      expect(line).toMatch(/no carry/);
      expect(line).toMatch(/302/);
      expect(otherRequests).toEqual([]);
    } finally {
      await new Promise((resolve) => { other.close(resolve); });
    }
  });

  it("sends no credential or cookie", async () => {
    const seen = [];
    await softFail({ "/asset-manifest.json": (request, response) => { seen.push(request.headers); response.writeHead(404); response.end(); } });
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toBeUndefined();
    expect(seen[0].cookie).toBeUndefined();
  });
});

describe("the exported carry on its own", () => {
  it("never throws: an unreachable host gives an empty carry", async () => {
    const { dist, publicAssets } = makeBuild({ "index-NEWNEW01.js": "new entry" });
    expect(await carryPreviousAssets({ distDir: dist, publicAssetsDir: publicAssets, origin: "http://127.0.0.1:1", log: () => {} })).toEqual([]);
  });
});
