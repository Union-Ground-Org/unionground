// @vitest-environment node
// @brand-literal
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_NOTICE,
  BrandConfigurationError,
  DEFAULT_SOURCE_CODE_URL,
  DEVELOPMENT_BRAND_NAME,
  applyBrandName,
  brandInitial,
  isReservedBrandName,
  resolveBrand,
  resolveSourceCodeUrl,
  withoutProtectedNames,
} from "../src/lib/shared-core/brand.js";
import {
  BRANDED_PUBLIC_TEXT_FILES,
  NEUTRAL_ONLY_PUBLIC_FILES,
  OFFICIAL_BRANDING_DIR,
  OFFICIAL_ICON_REPLACEMENTS,
  OFFICIAL_REQUIRED_FILES,
  brandDefines,
  finishBuiltOutput,
  leftoverBrandFiles,
  officialAssetsPresent,
  resolveWebBrand,
  rewriteModuleSource,
} from "../scripts/lib/brand-vite-plugin.mjs";
import { BRAND, BRAND_NAME, OFFICIAL_MARK } from "../src/lib/brand.js";
import { scanWebBundle } from "../scripts/verify-web-bundle-identity.mjs";
import { BrandMark, BrandWordmark, NeutralMark } from "../src/components/BrandMark.jsx";
import { PRODUCT_MARK, PRODUCT_NAME } from "../src/lib/productIdentity.js";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const unbranded = Object.freeze({ name: "Harbor Workspace", official: false, initial: "H", production: true });
const official = Object.freeze({ name: "Union Ground", official: true, initial: "U", production: true });

describe("brand resolution (src/lib/shared-core/brand.js)", () => {
  it("uses the operator's own name in an unbranded build", () => {
    const brand = resolveBrand({ brandName: "  Harbor   Workspace ", production: true });
    expect(brand).toEqual({ name: "Harbor Workspace", official: false, initial: "H" });
  });

  it("fails a production build with no name, with a message for the operator", () => {
    for (const brandName of [undefined, "", "   "]) {
      expect(() => resolveBrand({ brandName, production: true })).toThrow(BrandConfigurationError);
      expect(() => resolveBrand({ brandName, production: true })).toThrow(/VITE_BRAND_NAME is not set.*own product name.*TRADEMARKS\.md/);
    }
    expect(() => resolveBrand({ production: true, nameVariable: "BRAND_NAME" })).toThrow(/^BRAND_NAME is not set/);
  });

  it("fails a production build that uses the Union Ground name without official branding, in any case or spacing", () => {
    for (const brandName of ["Union Ground", "union ground", "UNION  GROUND", "UnionGround", "union-ground", "Union Ground Plus", "My Union.Ground"]) {
      expect(isReservedBrandName(brandName), brandName).toBe(true);
      expect(() => resolveBrand({ brandName, production: true }), brandName).toThrow(/reserved for Union Ground LLC's official builds/);
    }
    expect(isReservedBrandName("Union Grounds Crew")).toBe(true);
    expect(isReservedBrandName("Harbor Union")).toBe(false);
    expect(isReservedBrandName("Common Ground")).toBe(false);
  });

  it("falls back to the development name in development and tests", () => {
    expect(resolveBrand({}).name).toBe(DEVELOPMENT_BRAND_NAME);
    expect(DEVELOPMENT_BRAND_NAME).toBe("Union workspace (development build)");
    const reserved = resolveBrand({ brandName: "Union Ground" });
    expect(reserved).toMatchObject({ name: DEVELOPMENT_BRAND_NAME, official: false });
    expect(reserved.warning).toMatch(/reserved/);
  });

  it("refuses names that cannot be written safely into code and pages, in every mode", () => {
    for (const brandName of ["Harbor's", "A\"B", "<b>x</b>", "back\\slash", "cost $5", "x", "tick`"]) {
      expect(() => resolveBrand({ brandName }), brandName).toThrow(/2 to 60 letters/);
    }
    expect(resolveBrand({ brandName: "Harbor\u2019s Hall & Co. (North)" }).name).toBe("Harbor\u2019s Hall & Co. (North)");
    expect(resolveBrand({ brandName: "Sindicato Árbol" }).initial).toBe("S");
  });

  it("turns on official branding only with the flag and the official files", () => {
    expect(resolveBrand({ officialBranding: "1", officialAssetsPresent: true, production: true }))
      .toEqual({ name: "Union Ground", official: true, initial: "U" });
    expect(resolveBrand({ brandName: "Union Ground", officialBranding: "1", officialAssetsPresent: true, production: true }).official).toBe(true);
    expect(() => resolveBrand({ officialBranding: "1", officialAssetsPresent: false, production: true }))
      .toThrow(/branding\/official\/ is missing/);
    const development = resolveBrand({ officialBranding: "1", officialAssetsPresent: false });
    expect(development).toMatchObject({ name: DEVELOPMENT_BRAND_NAME, official: false });
    expect(() => resolveBrand({ brandName: "Harbor", officialBranding: "1", officialAssetsPresent: true }))
      .toThrow(/always uses the Union Ground name/);
    expect(() => resolveBrand({ officialBranding: "yes" })).toThrow(/VITE_OFFICIAL_BRANDING must be 1 or unset/);
    expect(resolveBrand({ brandName: "Harbor", officialBranding: "0", officialAssetsPresent: true }).official).toBe(false);
  });

  it("derives the neutral mark's initial from the name", () => {
    expect(brandInitial("harbor")).toBe("H");
    expect(brandInitial("(North) Hall")).toBe("N");
    expect(brandInitial(DEVELOPMENT_BRAND_NAME)).toBe("U");
  });

  it("accepts only an https source code URL, defaulting to the upstream repository", () => {
    expect(resolveSourceCodeUrl("")).toBe(DEFAULT_SOURCE_CODE_URL);
    expect(DEFAULT_SOURCE_CODE_URL).toBe("https://github.com/Union-Ground-Org/unionground");
    expect(resolveSourceCodeUrl(" https://git.example.org/harbor/app ")).toBe("https://git.example.org/harbor/app");
    for (const value of ["http://example.org/src", "ftp://example.org", "not a url", "https://user:pw@example.org/x"]) {
      expect(() => resolveSourceCodeUrl(value), value).toThrow(/SOURCE_CODE_URL must be an https URL/);
    }
  });
});

describe("name substitution", () => {
  it("rewrites the product name and keeps the attribution notice and the company name", () => {
    const text = `Welcome to Union Ground. UNION GROUND · UNION&nbsp;GROUND. ${ATTRIBUTION_NOTICE}. Union Ground LLC owns the marks.`;
    expect(applyBrandName(text, "Harbor Workspace")).toBe(
      `Welcome to Harbor Workspace. HARBOR WORKSPACE · HARBOR&nbsp;WORKSPACE. ${ATTRIBUTION_NOTICE}. Union Ground LLC owns the marks.`,
    );
    expect(applyBrandName(text, "Union Ground")).toBe(text);
    expect(withoutProtectedNames(applyBrandName(text, "Harbor"))).not.toContain("Union Ground");
  });

  it("rewrites the app's own modules in an unbranded build and leaves the rest alone", () => {
    const code = 'export const t = { title: "Sign in | Union Ground" };';
    expect(rewriteModuleSource(code, "/repo/src/lib/x.js", unbranded)).toBe('export const t = { title: "Sign in | Harbor Workspace" };');
    expect(rewriteModuleSource(code, "/repo/src/lib/x.js", official)).toBeNull();
    expect(rewriteModuleSource(code, "/repo/node_modules/pkg/index.js", unbranded)).toBeNull();
    expect(rewriteModuleSource(code, "\0virtual:thing", unbranded)).toBeNull();
    expect(rewriteModuleSource(code, "/repo/src/styles.css", unbranded)).toBeNull();
    expect(rewriteModuleSource(`// @brand-literal\n${code}`, "/repo/src/lib/brand.js", unbranded)).toBeNull();
    expect(rewriteModuleSource('{"name":"Union Ground"}', "/repo/src/data/x.json", unbranded)).toBe('{"name":"Harbor Workspace"}');
  });

  it("leaves no Union Ground name in the web app's own source once rewritten", () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (/\.(jsx?|json)$/.test(entry.name)) files.push(rel);
      }
    };
    walk("src");
    const leftovers = files.filter((file) => {
      const source = read(file);
      const rewritten = rewriteModuleSource(source, join(root, file), unbranded) ?? source;
      if (source.includes("@brand-literal")) return false;
      return withoutProtectedNames(rewritten).includes("Union Ground");
    });
    expect(leftovers).toEqual([]);
    // Only the brand module and its users may keep the literal name.
    const literal = files.filter((file) => read(file).includes("@brand-literal"));
    expect(literal).toEqual([join("src", "lib", "shared-core", "brand.js")]);
  });

  it("rewrites the public text files, the route documents and the shell", () => {
    const out = mkdtempSync(join(tmpdir(), "unionground-brand-out-"));
    try {
      mkdirSync(join(out, "about"));
      writeFileSync(join(out, "index.html"), "<title>Union Ground</title>");
      writeFileSync(join(out, "about", "index.html"), "<title>About Union Ground</title><footer>Based on Union Ground (https://unionground.org)</footer>");
      for (const name of BRANDED_PUBLIC_TEXT_FILES) writeFileSync(join(out, name), read("public", name));
      writeFileSync(join(out, "app.js"), 'const t="Harbor Workspace";');
      finishBuiltOutput(out, unbranded, root);
      expect(readFileSync(join(out, "index.html"), "utf8")).toBe("<title>Harbor Workspace</title>");
      expect(readFileSync(join(out, "about", "index.html"), "utf8")).toContain("Based on Union Ground (https://unionground.org)");
      expect(JSON.parse(readFileSync(join(out, "manifest.webmanifest"), "utf8")).name).toBe("Harbor Workspace");
      expect(leftoverBrandFiles(out)).toEqual([]);

      writeFileSync(join(out, "late.js"), 'const t="Union Ground";');
      expect(() => finishBuiltOutput(out, unbranded, root)).toThrow(/still names Union Ground in: late\.js/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("official branding files", () => {
  const officialDir = join(root, OFFICIAL_BRANDING_DIR);

  it("ships the official mark files with their non-AGPL license", () => {
    expect(officialAssetsPresent(root)).toBe(true);
    const names = readdirSync(officialDir).sort();
    // The web files plus the phone app icon (apps/mobile/app.config.ts).
    expect(names).toEqual([...OFFICIAL_REQUIRED_FILES, "mark-tile-1024.png"].sort());
    const license = read(OFFICIAL_BRANDING_DIR, "LICENSE.md");
    expect(license).toMatch(/trademarks of Union Ground LLC/);
    expect(license).toMatch(/not licensed under the GNU Affero General Public License/);
    expect(license).toMatch(/Modified versions of Union Ground may not use them/);
    expect(license).toContain("TRADEMARKS.md");
    expect(read(OFFICIAL_BRANDING_DIR, "mark-tile.svg")).toContain("Union Ground mark");
  });

  it("swaps in the official icons and drops the maskable placeholders in an official build", () => {
    const out = mkdtempSync(join(tmpdir(), "unionground-brand-official-"));
    try {
      mkdirSync(join(out, "assets"));
      for (const path of [...Object.keys(OFFICIAL_ICON_REPLACEMENTS), ...NEUTRAL_ONLY_PUBLIC_FILES]) {
        writeFileSync(join(out, path), readFileSync(join(root, "public", path)));
      }
      writeFileSync(join(out, "manifest.webmanifest"), read("public", "manifest.webmanifest"));
      finishBuiltOutput(out, official, root);
      const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
      for (const [path, file] of Object.entries(OFFICIAL_ICON_REPLACEMENTS)) {
        expect(digest(join(out, path)), path).toBe(digest(join(officialDir, file)));
      }
      for (const path of NEUTRAL_ONLY_PUBLIC_FILES) expect(existsSync(join(out, path)), path).toBe(false);
      const manifest = JSON.parse(readFileSync(join(out, "manifest.webmanifest"), "utf8"));
      expect(manifest.name).toBe("Union Ground");
      expect(manifest.icons.map((icon) => icon.purpose)).not.toContain("maskable");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("hands the official mark to the bundle only in an official build", () => {
    expect(JSON.parse(brandDefines(unbranded, root).__UNIONGROUND_OFFICIAL_MARK__)).toBeNull();
    const mark = JSON.parse(brandDefines(official, root).__UNIONGROUND_OFFICIAL_MARK__);
    expect(mark.tile).toBe(`data:image/svg+xml;base64,${readFileSync(join(officialDir, "mark-tile.svg")).toString("base64")}`);
    expect(mark.plain).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(JSON.parse(brandDefines(unbranded, root).__UNIONGROUND_BRAND__)).toMatchObject({ name: "Harbor Workspace", official: false });
    expect(JSON.parse(brandDefines(unbranded, root).__UNIONGROUND_OFFICIAL_HOSTS__)).toEqual([]);
    expect(JSON.parse(brandDefines(official, root).__UNIONGROUND_OFFICIAL_HOSTS__)).toContain("app.unionground.org");
  });

  it("keeps Union Ground artwork out of the neutral placeholders", () => {
    for (const path of ["public/assets/favicon.svg", "public/assets/favicon-maskable.svg", "apps/mobile/assets/icon-master.svg"]) {
      const svg = read(path);
      expect(svg, path).toContain("#3f4a46");
      expect(svg, path).not.toMatch(/#efa738|#0a2f26|#15573f/i);
    }
  });
});

describe("bundle identity check (scripts/verify-web-bundle-identity.mjs)", () => {
  it("lets only an official build name the official service's hosts", () => {
    const out = mkdtempSync(join(tmpdir(), "unionground-brand-identity-"));
    try {
      writeFileSync(join(out, "app.js"), 'const hosts=["unionground.org","app.unionground.net"];');
      expect(scanWebBundle(out).hits.join("\n")).toMatch(/unionground\.net \(application host\)/);
      expect(scanWebBundle(out, { allowedHosts: JSON.parse(brandDefines(official, root).__UNIONGROUND_OFFICIAL_HOSTS__) }).hits).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("web build configuration", () => {
  it("is production only for vite build in production mode", () => {
    const env = { VITE_BRAND_NAME: "Harbor" };
    expect(resolveWebBrand({ env, mode: "production", command: "build", root }).production).toBe(true);
    expect(resolveWebBrand({ env: { ...env, NODE_ENV: "production" }, mode: "staging", command: "build", root }).production).toBe(true);
    expect(resolveWebBrand({ env, mode: "development", command: "build", root }).production).toBe(false);
    expect(resolveWebBrand({ env, mode: "production", command: "serve", root }).production).toBe(false);
    expect(() => resolveWebBrand({ env: {}, mode: "production", command: "build", root })).toThrow(/VITE_BRAND_NAME is not set/);
    expect(() => resolveWebBrand({ env: { VITE_BRAND_NAME: "Union Ground" }, mode: "production", command: "build", root })).toThrow(/reserved/);
    expect(resolveWebBrand({ env: { VITE_OFFICIAL_BRANDING: "1" }, mode: "production", command: "build", root }).official).toBe(true);
    expect(resolveWebBrand({ env: {}, mode: "development", command: "serve", root }).name).toBe(DEVELOPMENT_BRAND_NAME);
  });

  it("runs this suite as the official build", () => {
    expect(BRAND).toMatchObject({ name: "Union Ground", official: true, initial: "U", sourceCodeUrl: DEFAULT_SOURCE_CODE_URL });
    expect(BRAND_NAME).toBe(PRODUCT_NAME);
    expect(PRODUCT_MARK).toBe("U");
    expect(OFFICIAL_MARK.tile).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});

describe("product mark", () => {
  it("draws the official mark from branding/official in an official build", () => {
    const html = renderToStaticMarkup(createElement(BrandMark, { size: 40 }));
    expect(html).toContain(`src="${OFFICIAL_MARK.tile}"`);
    expect(html).toContain('width="40"');
    expect(renderToStaticMarkup(createElement(BrandMark, { variant: "plain" }))).toContain(`src="${OFFICIAL_MARK.plain}"`);
    expect(renderToStaticMarkup(createElement(BrandWordmark))).toBe("<span>Union</span> Ground");
  });

  it("draws a plain rounded square with the initial in an unbranded build", () => {
    const html = renderToStaticMarkup(createElement(NeutralMark, { size: 30, initial: "H" }));
    expect(html).toContain('rx="15"');
    expect(html).toContain(">H</text>");
    expect(html).not.toMatch(/<path|<img|efa738/i);
  });
});
