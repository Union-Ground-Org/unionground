import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const documentKey = `olms-990000876~${"1".repeat(16)}`;
export const secondKey = `olms-990000876~${"2".repeat(16)}`;
export const documentLocale = { country: "CA", subdivision: "CA-QC", postal_code: "H2X 1Y4", language: "fr-CA", timezone: "America/Toronto", locale_unknowns: {} };
export const doc = (overrides = {}) => ({ document_key: documentKey, catalog_key: "olms-990000876", doc_kind: "contract", title: "Example Workers contract", title_derived: false, url: "https://exampleworkers876.example/contract.pdf", url_host: "exampleworkers876.example", as_of: null, ...overrides });
export const object = (overrides = {}) => ({ sha256: "a".repeat(64), key: `documents/aa/${"a".repeat(64)}`, bytes: 21, primary_url: doc().url, license: "Public domain", ...overrides });
export function writeFileFixture(directory, objects = [object()], documents = [doc()]) {
  const organizations = [...new Set(documents.map(row => row.catalog_key))].map(catalog_key => ({ catalog_key }));
  const release = { schema: "union-catalog-release/1", filterVersion: "privacy-filter/1", sourceSha256: "c".repeat(64), label: "20261112-91", organizations, documents };
  const bytes = gzipSync(JSON.stringify(release)), idMap = Buffer.from("{}");
  const sha = value => createHash("sha256").update(value).digest("hex");
  const manifest = { schema: "union-catalog-manifest/1", releaseSchema: release.schema, label: release.label, filterVersion: release.filterVersion, sourceSha256: release.sourceSha256, artifact: { sha256: sha(bytes) }, idMap: { sha256: sha(idMap) } };
  writeFileSync(join(directory, "catalog-release.json.gz"), bytes);
  writeFileSync(join(directory, "catalog-id-map.json"), idMap);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  const manifestPath = join(directory, "manifest-fictional-20261112.jsonl");
  writeFileSync(manifestPath, objects.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { catalogDirectory: directory, manifestPath, preparedAt: new Date().toISOString(), label: "fixture-file-release", release, manifest };
}
