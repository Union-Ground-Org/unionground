import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandLogoMark } from "../src/components/MobileTopBar.jsx";
import { BrandMark } from "../src/components/BrandMark.jsx";
import { hasRetiredProjectName } from "../scripts/lib/retired-project-names.mjs";
import { forbiddenIdentityTokensIn } from "../scripts/lib/sibling-deny-list.mjs";
import { DENIED_IDENTITY_TOKEN } from "./helpers/denied-identity-fixtures.js";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
// "Union Base", "Solid Ground" and the project's former name
// (scripts/lib/retired-project-names.mjs) are retired, in any spacing or case, and the one-word "UnionGround" is a code name, never a
// display name (identifiers such as UnionGroundLogo do not match). The
// sibling product's name is refused by digest (config/sample-backend.json,
// scripts/lib/sibling-deny-list.mjs), so this file does not spell it.
const retiredDisplayName = new RegExp(
  String.raw`(?:Union|UNION)(?:\s|&nbsp;)(?:Base|BASE)|(?:Solid|SOLID)(?:\s|&nbsp;)?(?:Ground|GROUND)|(?<![\w$])UnionGround(?![\w$.-])`,
);

const PRODUCT_NAME = /Union Ground/;

describe("Union Ground product identity", () => {
  it("uses Union Ground across current application and delivery surfaces", () => {
    const surfaces = [
      ["index.html"],
      ["public", "manifest.webmanifest"],
      ["public", "offline.html"],
      ["public", "sw.js"],
      ["src", "lib", "i18n.js"],
      ["src", "components", "DesktopRail.jsx"],
      ["src", "views", "LegalView.jsx"],
      ["api", "_lib", "emailTemplate.js"],
      ["api", "notifications-dispatch.js"],
      ["apps", "mobile", "app.config.ts"],
      ["apps", "mobile", "app", "sign-in.tsx"],
    ];

    for (const parts of surfaces) {
      const content = read(...parts);
      expect(content, parts.join("/")).toMatch(PRODUCT_NAME);
      expect(content, parts.join("/")).not.toMatch(retiredDisplayName);
      expect(hasRetiredProjectName(content), parts.join("/")).toBe(false);
      expect(forbiddenIdentityTokensIn(content), parts.join("/")).toEqual([]);
    }
  });

  it("keeps the retired names out while still recognising Union Ground", () => {
    expect("Union Ground").not.toMatch(retiredDisplayName);
    expect("UNION GROUND").not.toMatch(retiredDisplayName);
    expect("Solid Ground").toMatch(retiredDisplayName);
    expect("the Solid Ground hub").toMatch(retiredDisplayName);
    expect("SolidGround").toMatch(retiredDisplayName);
    expect("Union Base").toMatch(retiredDisplayName);
    expect("UnionGround").toMatch(retiredDisplayName);
    expect("UnionGroundLogo").not.toMatch(retiredDisplayName);
  });

  it("checks digest matches regardless of case, separators or surrounding text", () => {
    const names = new Set(["4dee12a5a40a03d3d680fb8f9d315abf7d9e5cdfb11b6fb928253655140d8360"]);
    for (const text of ["Pineboxy", "pInEbOxY", "the Pin Eboxy service", "UsesPin-EboxyLogo", "Pin_eboxy"]) {
      expect(hasRetiredProjectName(text, names), text).toBe(true);
    }
    expect(hasRetiredProjectName("Pin Ebox", names)).toBe(false);
  });

  it("refuses the sibling product's name by digest, and record ids do not trip it", () => {
    expect(forbiddenIdentityTokensIn(`About ${DENIED_IDENTITY_TOKEN}`)).toEqual([DENIED_IDENTITY_TOKEN]);
    expect(forbiddenIdentityTokensIn("REQ-UG-STEWARD-APPOINTMENTS-20260801")).toEqual([]);
    expect("REQ-UG-STEWARD-APPOINTMENTS-20260801").not.toMatch(retiredDisplayName);
  });

  it("never labels a reward with the product name and never renames it through a data migration", () => {
    const memberApi = read("src", "lib", "memberApi.js");
    expect(memberApi).not.toContain("Union Ground hoodie");
    expect(memberApi).not.toContain("Sudadera Union Ground");
    expect(memberApi).not.toMatch(retiredDisplayName);
    expect(hasRetiredProjectName(memberApi)).toBe(false);
    expect(forbiddenIdentityTokensIn(memberApi)).toEqual([]);
    expect(existsSync(join(root, "supabase", "migrations", "20260817150000_union_ground_display_name.sql"))).toBe(false);
  });
});

describe("Product mark", () => {
  const sourceFiles = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.(jsx?|tsx?)$/.test(entry.name) ? [rel] : [];
  });

  it("draws the mark in exactly one component, and none of the retired triangle artwork is left", () => {
    const definers = sourceFiles("src").filter((file) => /<svg[^>]*viewBox="0 0 64 64"/.test(read(file)) && read(file).includes("rx=\"15\""));
    expect(definers).toEqual([join("src", "components", "BrandMark.jsx")]);
    for (const file of sourceFiles("src")) expect(read(file), file).not.toContain("M32 27 L47 45 L17 45 Z");
  });

  it("renders the top-bar mark identically to the product mark at the same size", () => {
    for (const size of [28, 30]) {
      expect(renderToStaticMarkup(createElement(BrandLogoMark, { size }))).toBe(
        renderToStaticMarkup(createElement(BrandMark, { size })),
      );
    }
    expect(renderToStaticMarkup(createElement(BrandLogoMark))).toContain('width="28"');
  });

});
