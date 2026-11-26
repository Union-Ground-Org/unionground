import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A @font-face whose woff2 is missing fails silently: every test passes and
// the browser falls back per-family (Spline Sans Mono spent a month rendering
// as Consolas this way — declared in sg-tokens.css and 26 call sites, shipped
// nowhere). The design package pins its ds/fonts files one by one in
// tests/design-package.test.js; this is the same guard for the app's own
// faces, derived from the sheet instead of a list so a new face is covered
// the day it is declared.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesCss = readFileSync(join(root, "src", "styles.css"), "utf8");

describe("app @font-face assets", () => {
  const urls = [...stylesCss.matchAll(/@font-face\s*{[^}]*?src:\s*url\("(\/[^"]+\.woff2)"\)/g)].map((m) => m[1]);

  it("still declares the three Union Base faces, latin and latin-ext each", () => {
    const families = [...stylesCss.matchAll(/@font-face\s*{[^}]*?font-family:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect([...new Set(families)].sort()).toEqual(["Archivo", "Public Sans", "Spline Sans Mono"]);
    expect(urls).toHaveLength(6);
    expect(urls.filter((url) => url.endsWith("-latin-ext.woff2"))).toHaveLength(3);
  });

  it("ships a real woff2 for every face it declares", () => {
    // Magic bytes alone would pass a truncated file or three copies of the
    // same font (sol-review finding 4), so also: every face points at a
    // DISTINCT file, and none is implausibly small for a latin subset.
    expect(new Set(urls).size, "faces must not share a file").toBe(urls.length);
    for (const url of urls) {
      const file = join(root, "public", ...url.split("/").filter(Boolean));
      expect(existsSync(file), `${url} has no file under public/`).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 4).toString("ascii"), `${url} is not woff2`).toBe("wOF2");
      // The latin-ext subsets are smaller (Public Sans's is about 18 KB).
      const floor = url.endsWith("-latin-ext.woff2") ? 15000 : 20000;
      expect(bytes.length, `${url} is too small to be a real latin subset`).toBeGreaterThan(floor);
    }
  });

  it("keeps every face byte-identical to the design package's known-good copy", () => {
    // All six files were vendored from the design package's ds/fonts, which
    // this edition does not ship; their SHA-256 values below are that
    // package's copies, so a re-subset still fails here and a human decides.
    const known = {
      "archivo-latin.woff2": "8f704806dbedeaaeca334b11ec348bc3ac3a439d6431544b3afb54f534ee4967",
      "archivo-latin-ext.woff2": "ff4f17d21930e36d6d93baba663e624cb767afc3feebf7adaebd82242638de05",
      "public-sans-latin.woff2": "5ed4d31c988e73b258894244f209069ebe77dc7e564861954b21198b6de90d68",
      "public-sans-latin-ext.woff2": "3a00a32f0242b723dcea79935747d6d27dd93675d03ef23f470dfe274e79586a",
      "spline-sans-mono-latin.woff2": "46b7dcafe3e51dbe87be1bafaac3fed7646db1fe0a146647a6ffce3699f2752d",
      "spline-sans-mono-latin-ext.woff2": "0ca9a3989044d1f9b4da1f303cea3c3091f5cb02fe54da04fd51fceaf676ecf9",
    };
    expect(urls.map((url) => url.split("/").pop()).sort()).toEqual(Object.keys(known).sort());
    for (const url of urls) {
      const name = url.split("/").pop();
      const app = readFileSync(join(root, "public", "assets", name));
      expect(createHash("sha256").update(app).digest("hex"), `${name} differs from the design package copy`).toBe(known[name]);
    }
  });

  it("ships the OFL notice and copyright line beside every face", () => {
    // The SIL OFL 1.1 lets a font travel only with its license and copyright
    // notice; public/ is copied into the build, so this file ships with them.
    const notice = readFileSync(join(root, "public", "assets", "FONT-LICENSE.txt"), "utf8");
    expect(notice).toContain("SIL OPEN FONT LICENSE Version 1.1");
    for (const url of urls) expect(notice, `${url} is not named in FONT-LICENSE.txt`).toContain(url.split("/").pop());
    for (const family of ["Archivo", "Public Sans", "Spline Sans Mono"]) {
      expect(notice).toMatch(new RegExp(`Copyright \\d{4} The ${family} Project Authors`));
    }
  });

  it("keeps the mono face byte-identical to its known-good vendored copy", () => {
    // The app face was vendored from the Union Ground design package (same
    // gstatic artifact the prototype renders; that package is not part of this
    // repo). Pinning the SHA-256 fixes content, weight axis and cmap in one
    // assertion: if the file is ever re-subset, this fails and a human decides
    // whether the new bytes are canonical.
    const app = readFileSync(join(root, "public", "assets", "spline-sans-mono-latin.woff2"));
    expect(createHash("sha256").update(app).digest("hex")).toBe(
      "46b7dcafe3e51dbe87be1bafaac3fed7646db1fe0a146647a6ffce3699f2752d",
    );
  });
});
