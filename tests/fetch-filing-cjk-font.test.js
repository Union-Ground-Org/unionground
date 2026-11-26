// @vitest-environment node
// #8725 step 2: the CJK font is fetched by the Vercel build, pinned by commit
// and sha256; a download that does not match the pin fails the build and
// leaves no file. Nothing here touches the network.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CJK_FONT, ensureFilingCjkFont, sha256Hex } from "../scripts/fetch-filing-cjk-font.mjs";

const BYTES = new TextEncoder().encode("pinned font bytes");
let directory;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
const pin = async () => {
  directory = mkdtempSync(join(tmpdir(), "filing-cjk-font-"));
  return { url: "https://example.test/font.otf", sha256: await sha256Hex(BYTES), bytes: BYTES.length, path: join(directory, "font.otf"), cache: join(directory, "cache", "font.otf") };
};

describe("fetching the filing copy's CJK font in the build", () => {
  it("pins the notofonts release by commit, sha256 and size, into the API's fonts folder", () => {
    expect(CJK_FONT.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/notofonts\/noto-cjk\/[0-9a-f]{40}\/Sans\/OTF\/SimplifiedChinese\/NotoSansCJKsc-Regular\.otf$/);
    expect(CJK_FONT.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(CJK_FONT.bytes).toBe(16437364);
    expect(CJK_FONT.path).toMatch(/api\/_lib\/fonts\/NotoSansCJKsc-Regular\.otf$/);
    // Vercel's build cache restores and saves .vercel/cache.
    expect(CJK_FONT.cache).toMatch(/\.vercel\/cache\/filing-cjk-font\/NotoSansCJKsc-Regular\.otf$/);
  });

  it("computes sha256 digests", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("writes a download that matches the pin, and keeps a matching file without downloading again", async () => {
    const target = await pin();
    const calls = [];
    const get = async (url) => { calls.push(url); return BYTES; };
    expect(await ensureFilingCjkFont(target, { get })).toBe("downloaded");
    expect(readFileSync(target.path)).toEqual(Buffer.from(BYTES));
    expect(await ensureFilingCjkFont(target, { get })).toBe("present");
    expect(calls).toEqual(["https://example.test/font.otf"]);
    expect(readFileSync(target.cache)).toEqual(Buffer.from(BYTES));
  });

  // A later build takes the font from the build cache,
  // checked against the same sha256, and downloads only when that fails.
  it("takes a matching font from the build cache without downloading, and replaces a cached copy that does not match", async () => {
    const target = await pin();
    const calls = [];
    const get = async (url) => { calls.push(url); return BYTES; };
    expect(await ensureFilingCjkFont(target, { get })).toBe("downloaded");
    rmSync(target.path);
    expect(await ensureFilingCjkFont(target, { get })).toBe("cached");
    expect(readFileSync(target.path)).toEqual(Buffer.from(BYTES));
    expect(calls).toHaveLength(1);
    rmSync(target.path);
    writeFileSync(target.cache, "a corrupted cache entry");
    expect(await ensureFilingCjkFont(target, { get })).toBe("downloaded");
    expect(calls).toHaveLength(2);
    expect(readFileSync(target.cache)).toEqual(Buffer.from(BYTES));
  });

  it("fails on a download that does not match the pin, and leaves no file", async () => {
    const target = await pin();
    writeFileSync(target.path, "an older, wrong file");
    await expect(ensureFilingCjkFont(target, { get: async () => new TextEncoder().encode("other bytes") }))
      .rejects.toThrow(/does not match its pin/);
    expect(existsSync(target.path)).toBe(false);
    expect(existsSync(`${target.path}.partial`)).toBe(false);
  });

  it("retries a failed download, and fails after the last attempt", async () => {
    const target = await pin();
    let calls = 0;
    const waits = [];
    const wait = async (ms) => { waits.push(ms); };
    const flaky = async () => { calls += 1; if (calls < 3) throw new Error("connection reset"); return BYTES; };
    expect(await ensureFilingCjkFont(target, { get: flaky, wait })).toBe("downloaded");
    expect(calls).toBe(3);
    // A pause before each retry.
    expect(waits).toEqual([2000, 4000]);
    rmSync(target.path);
    rmSync(target.cache);
    // A stale file that does not match the pin is removed
    // even when every download fails.
    writeFileSync(target.path, "a stale, wrong file");
    await expect(ensureFilingCjkFont(target, { get: async () => { throw new Error("offline"); }, attempts: 2, wait }))
      .rejects.toThrow(/could not be downloaded: Error: offline/);
    expect(existsSync(target.path)).toBe(false);
  });
});
