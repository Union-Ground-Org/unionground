// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "vite";
import { legalPendingManifestPlugin } from "../scripts/lib/legal-pending-manifest.mjs";
import { bundledPendingTexts } from "../src/lib/legalPending.js";
import { legalReleaseFilesFromStamp, publishWebTermsReceipt } from "../src/lib/legalReleaseBundle.js";
import { publishNativeTermsReceipt } from "../apps/mobile/src/lib/legalReleaseGate.ts";

const stamp = { ...JSON.parse(readFileSync("content/legal/release-stamp.json", "utf8")), release: null };
const fixtures = [];

afterEach(async () => {
  for (const { server, root } of fixtures.splice(0)) {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture(generate = true, mobileRoot = false) {
  const root = mkdtempSync(join(tmpdir(), "legal-manifest-"));
  const directory = join(root, "content/legal/pending");
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(root, "src/lib"), { recursive: true });
  for (const path of ["src/lib/legalPending.js", "content/legal/pending/directory.js"]) {
    writeFileSync(join(root, path), readFileSync(path, "utf8"));
  }
  const appRoot = mobileRoot ? join(root, "apps/mobile") : root;
  mkdirSync(appRoot, { recursive: true });
  const server = await createServer({ root: appRoot, configFile: false, plugins: generate ? [legalPendingManifestPlugin(mobileRoot ? root : undefined)] : [], server: { middlewareMode: true, fs: { allow: [root] } }, appType: "custom" });
  fixtures.push({ root, server });
  const entry = mobileRoot ? `/@fs/${join(root, "src/lib/legalPending.js")}` : "/src/lib/legalPending.js";
  const texts = async () => (await server.ssrLoadModule(entry)).bundledPendingTexts();
  return { root, directory, server, texts };
}

describe("statically imported pending legal manifest", () => {
  it("keeps publication closed when manifest generation is absent", async () => {
    const { texts } = await fixture(false);
    const operation = vi.fn();
    const pending = await texts();
    expect(pending).toBeNull();
    expect(bundledPendingTexts(null)).toBeNull();
    expect(publishWebTermsReceipt(operation, legalReleaseFilesFromStamp(stamp, pending))).toMatchObject({ ran: false, reason: "pending-unreadable" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("distinguishes a generated empty directory from an ungenerated manifest", async () => {
    const { texts } = await fixture();
    const pending = await texts();
    expect(pending).toEqual([]);
    expect(publishWebTermsReceipt(() => "baseline", legalReleaseFilesFromStamp(stamp, pending))).toMatchObject({ ran: true, result: "baseline" });
  });

  it("generates the native test inputs from the repository root and retains pending gates", async () => {
    const { directory, server, texts } = await fixture(true, true);
    const empty = await texts();
    expect(empty).toEqual([]);
    expect(publishNativeTermsReceipt(() => "native baseline", legalReleaseFilesFromStamp(stamp, empty))).toMatchObject({ ran: true, result: "native baseline" });
    const raw = JSON.stringify({ schema: 1, recordId: "held", instruments: {}, paths: [{ id: "terms-receipt", kind: "collection", release: "next" }] });
    const path = join(directory, "held.json");
    writeFileSync(path, raw);
    server.watcher.emit("all", "add", path);
    const pending = await texts();
    expect(pending).toEqual([raw]);
    const operation = vi.fn();
    expect(publishNativeTermsReceipt(operation, legalReleaseFilesFromStamp(stamp, pending))).toMatchObject({ ran: false, reason: "pending-release" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("includes all raw JSON in sorted order and leaves invalid declarations closed", async () => {
    const { directory, texts } = await fixture();
    const raw = '{\n  "schema": 1, "recordId": "a", "instruments": {}, "paths": []\n}\n';
    writeFileSync(join(directory, "z-invalid.json"), "{");
    writeFileSync(join(directory, "a.json"), raw);
    writeFileSync(join(directory, "note.js"), "throw new Error('must not execute');");
    const pending = await texts();
    expect(pending).toEqual([raw, "{"]);
    const operation = vi.fn();
    expect(publishWebTermsReceipt(operation, legalReleaseFilesFromStamp(stamp, pending))).toMatchObject({ ran: false, reason: "pending-unreadable" });
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(["directory", "symlink"])("refuses a nonregular JSON declaration (%s)", async (kind) => {
    const { directory, texts } = await fixture();
    const path = join(directory, "held.json");
    if (kind === "directory") mkdirSync(path);
    else symlinkSync("directory.js", path);
    await expect(texts()).rejects.toThrow(/not a regular file/);
  });

  it("keeps publication closed when the pending directory is missing", async () => {
    const { directory, texts } = await fixture();
    rmSync(directory, { recursive: true });
    // Vite may load the module before its watcher observes removal (null
    // declarations), or reject the missing import. Both must deny publication.
    const pending = await texts().catch(() => null);
    const operation = vi.fn();
    expect(pending).toBeNull();
    const files = legalReleaseFilesFromStamp(stamp, pending);
    expect(publishWebTermsReceipt(operation, files)).toMatchObject({ ran: false, reason: "pending-unreadable" });
    expect(publishNativeTermsReceipt(operation, files)).toMatchObject({ ran: false, reason: "pending-unreadable" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("refreshes the generated manifest for declaration add, change and removal events", async () => {
    const { directory, server, texts } = await fixture();
    const path = join(directory, "held.json");
    expect(await texts()).toEqual([]);
    writeFileSync(path, "first declaration");
    server.watcher.emit("all", "add", path);
    expect(await texts()).toEqual(["first declaration"]);
    writeFileSync(path, "changed declaration");
    server.watcher.emit("all", "change", path);
    expect(await texts()).toEqual(["changed declaration"]);
    rmSync(path);
    server.watcher.emit("all", "unlink", path);
    expect(await texts()).toEqual([]);
  });
});
