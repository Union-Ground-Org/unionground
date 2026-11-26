// @vitest-environment node
//
// REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110: document links are
// for members. Nothing the web or native build ships may carry the address of
// a union contract, agreement, bylaws, form or other union document, or of a
// page that indexes them: not public/ (copied as is; public/design is pruned
// from dist), not the app sources, and not the content/ and data/reference/
// data the bundles import. Law, agency guidance and labor board decisions are
// not union documents, so a document-shaped address on a government or state
// law publisher's host is allowed; any other one fails here.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
};
const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)__tests__\//.test(path);
const SHIPPED = [
  ...walk("public").filter((path) => !path.startsWith(join("public", "design"))),
  ...walk("src").filter((path) => !isTest(path)),
  ...walk(join("apps", "mobile", "src")).filter((path) => !isTest(path)),
  // content/ ships only where a deployment adds it.
  ...(existsSync("content") ? walk("content") : []),
  ...walk(join("data", "reference")),
];

// A document by its address, following the database rule: a file (also with
// an escaped dot), a download, an upload folder, a page that names a contract,
// agreement, bylaws, constitution, newsletter, handbook or salary chart, or a
// file-sharing, viewer or online-form host.
const DOCUMENT_SHAPE = /(\.|%2e)(pdf|docx?|xlsx?|pptx?|rtf|odt)(?![a-z0-9])|\/download(?:[/?#]|$)|\/_files\/ugd\/|\/wp-content\/uploads\/|contracts?\b|agreements?\b|bylaws|constitution|newsletters?\b|handbooks?\b|salary-charts?|collective-bargaining/i;
const DOCUMENT_HOST = /(^|\.)(drive\.google\.com|docs\.google\.com|dropbox\.com|scribd\.com|issuu\.com|docsend\.com|box\.com|1drv\.ms|onedrive\.live\.com|sharepoint\.com|forms\.gle|jotform\.com|formstack\.com|typeform\.com|surveymonkey\.com|yumpu\.com|flipsnack\.com|calameo\.com)$/i;
// Government and state law publishers. A government page that indexes union
// contracts is still a union document index.
const LAW_HOST = /(\.gov|\.state\.ar\.us|(^|\.)tnsosfiles\.com)$/i;
const UNION_CONTRACT_INDEX = /union-contracts/i;

function documentAddresses() {
  const found = [];
  for (const path of SHIPPED) {
    const text = readFileSync(path, "latin1");
    for (const [address] of text.matchAll(/https?:\/\/[^\s"'`<>()\\]+/g)) {
      let url;
      try {
        url = new URL(address);
      } catch {
        continue;
      }
      if (!DOCUMENT_SHAPE.test(url.pathname + url.search) && !(DOCUMENT_HOST.test(url.hostname) && url.pathname.length > 1)) continue;
      if (LAW_HOST.test(url.hostname) && !UNION_CONTRACT_INDEX.test(url.pathname)) continue;
      found.push(`${path}: ${url.href}`);
    }
  }
  return found;
}

describe("what the builds ship carries no union document address", () => {
  it("scans public/, the web and native sources, and the content and reference data", () => {
    expect(SHIPPED.length).toBeGreaterThan(1000);
    expect(SHIPPED).toContain(join("data", "reference", "labor-rights", "documents.json"));
  });

  it("finds no document-shaped address off a government or state law host", () => {
    expect(documentAddresses()).toEqual([]);
  });

  it("would catch the addresses this record removed", () => {
    for (const address of [
      "https://www.tamarack-union.example/wp-content/uploads/2025/03/2024-2026-state-cba-signed-08012024-searchable.pdf",
      "https://www.harbor-workers.example/unit-6-contracts",
      "https://www.harbor-workers.example/unit-1-salary-charts",
      "https://www.harbor-workers.example/constitution-bylaws",
      "https://www.harbor-workers.example/_files/ugd/b873eb_9163eeca0743422aae151bfbd2c5c90a.pdf",
    ]) {
      const url = new URL(address);
      expect(DOCUMENT_SHAPE.test(url.pathname + url.search), address).toBe(true);
      expect(LAW_HOST.test(url.hostname), address).toBe(false);
    }
    const index = new URL("https://www.mass.gov/guides/collective-bargaining-agreements-union-contracts");
    expect(LAW_HOST.test(index.hostname) && !UNION_CONTRACT_INDEX.test(index.pathname)).toBe(false);
  });
});
