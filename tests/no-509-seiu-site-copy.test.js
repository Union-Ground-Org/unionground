// @vitest-environment node

// Owner directive, 2026-10-01: the deployed site carries no "509", "SEIU 509"
// or "SEIU" reference (legal and contract documents excepted). Two surfaces
// carry all user-visible copy outside component code: every English and
// Spanish string in the i18n catalogue, and the static text files Vite copies
// from public/ into the deployment. Component code is covered by the
// legacy-literal scan in organization-name.test.jsx.
//
// The pattern needs a word boundary around 509, so a longer number or a name
// that merely contains those digits is not matched. Nothing is allowlisted.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import { catalogue } from "../src/lib/i18n.js";

const BANNED = /\b509\b|seiu/i;
const root = process.cwd();
const TEXT_FILE = /\.(html|webmanifest|js|json|txt|xml|svg|css)$/;

function collectStrings(value, path, out) {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectStrings(item, `${path}.${key}`, out);
  }
  return out;
}

// public/design/ holds Claude Design source exports that
// scripts/prune-deployed-design.mjs removes from every production build, so
// they are never served; every other text file under public/ is deployed.
function deployedPublicTextFiles(dir = "public") {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return path === "public/design" ? [] : deployedPublicTextFiles(path);
    return TEXT_FILE.test(entry.name) ? [path] : [];
  });
}

describe("no 509 or SEIU reference in site copy", () => {
  it("guards the references the owner named without catching a domain name or record ids", () => {
    for (const sample of ["509", "Local 509", "SEIU Local 509", "seiu", "1199SEIU", "509 218", "About Local 509"]) {
      expect(sample).toMatch(BANNED);
    }
    for (const sample of ["509ab.example", "REQ-UG-FEATURE-20261001", "5090", "1509"]) {
      expect(sample).not.toMatch(BANNED);
    }
  });

  it("keeps every English and Spanish catalogue string free of them", () => {
    expect(Object.keys(catalogue.en).length).toBeGreaterThan(1000);
    expect(Object.keys(catalogue.es).length).toBeGreaterThan(1000);
    const hits = ["en", "es"]
      .flatMap((lang) => collectStrings(catalogue[lang], lang, []))
      .filter(([, value]) => BANNED.test(value))
      .map(([path]) => path);
    expect(hits).toEqual([]);
  });

  it("keeps every deployed public text file free of them", () => {
    const files = deployedPublicTextFiles();
    for (const required of [
      "public/404.html",
      "public/offline.html",
      "public/manifest.webmanifest",
      "public/robots.txt",
      "public/sitemap.xml",
    ]) {
      expect(files).toContain(required);
    }
    // Union Ground publishes no public union catalog page.
    expect(files.filter((file) => file.startsWith("public/featured-unions/"))).toEqual([]);
    const hits = files.filter((file) => BANNED.test(readFileSync(join(root, file), "utf8")));
    expect(hits).toEqual([]);
  });
});
