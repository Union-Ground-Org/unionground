// Organization-only synthetic rehearsal, not a copy of the research corpus.
// Includes every inhabited Americas country/territory and both territories
// with no permanent population. Unknown locale evidence remains explicit.
import { createHash } from "node:crypto";
import { releaseCounts } from "../../scripts/load-union-catalog.mjs";
import { stamp } from "../../scripts/lib/provenance.mjs";

export const AMERICAS_COUNTRIES = Object.freeze("AG AI AR AW BB BL BM BO BQ BR BS BZ CA CL CO CR CU CW DM DO EC FK GD GF GL GP GS GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PM PR PY SR SV SX TC TT US UY VC VE VG VI".split(" ").filter((code) => code !== "US"));
const hash = (value, length) => createHash("sha256").update(value).digest("hex").slice(0, length);
export const sampleKey = (country) => `ug-sample${country.toLowerCase()}00`;

export function fixtureLocale(country = "CA") {
  const known = { CA: ["CA-ON", "K1A 0B1", "fr-CA", "America/Toronto"],
    MX: ["MX-JAL", "44100", "es-MX", "America/Mexico_City"],
    BR: ["BR-SP", "01000-000", "pt-BR", "America/Sao_Paulo"],
    CW: [null, null, "nl-CW", "America/Curacao"] }[country] ?? [null, null, null, null];
  const row = { country, subdivision: known[0], postal_code: known[1], language: known[2], timezone: known[3] };
  return { ...row, locale_unknowns: Object.fromEntries(Object.entries(row).filter(([, value]) => value === null).map(([key]) => [key, "not_published"])) };
}

export function combinedAmericasRelease(base, label = "20261112-51") {
  const release = structuredClone(base.release);
  release.label = label;
  release.identifiers ??= [];
  const template = base.release.organizations.find((row) => row.duplicate_of === null);
  for (const country of AMERICAS_COUNTRIES) {
    const key = sampleKey(country);
    const locale = fixtureLocale(country);
    const url = `https://sample${country.toLowerCase()}.example/`;
    release.organizations.push({ ...template, ...locale, catalog_key: key, olms_file_number: null, union_org_id: null,
      name: `Example ${country} Workers`, aka: [], family: null, designation: null, local_number: null,
      city: null, state: null, zip5: null, census_region: null, census_division: null,
      latitude: null, longitude: null, geo_precision: null, website: url, members_reported: null, members_fiscal_year: null,
      structure_note: null, next_election_on: "2028-01-01", election_term_years: 3, bylaws_url: null,
      confidence: "official_site", researched_on: "2026-11-12", source_urls: [url], search_text: `Example ${country} Workers`, duplicate_of: null });
    release.edges.push({ ...locale, edge_key: `${key}~parent`, child_key: key, parent_key: country === "CA" ? null : sampleKey("CA"),
      parent_label: country === "CA" ? "Example federation" : null, edge_kind: "parent_body", certainty: "confirmed", source_url: url });
    const subunitKey = `${key}~chapter-${hash(key, 12)}`;
    release.subunits.push({ ...base.release.subunits[0], ...locale, subunit_key: subunitKey, catalog_key: key,
      parent_subunit_key: null, kind: "chapter", kind_label: "Chapter", name: `Example ${country} Chapter`,
      location: null, employer: null, members: null, members_source: null, density_note: null,
      election_note: null, structure_note: null, confidence: "official_site", website: url, source_url: url, as_of: "2026-11-12" });
    release.seat_outlines.push({ ...locale, outline_key: `${key}~board`, catalog_key: key, subunit_key: subunitKey,
      seat_class: "board", title: "Board seat", listed: 1, vacant: 1, source_url: url, as_of: "2026-11-12" });
    release.contacts.push({ ...locale, contact_key: `${key}~website`, catalog_key: key, contact_kind: "website",
      value: url, label: null, basis: "own_site", source_url: url, as_of: "2026-11-12" });
    const documentKey = `${key}~${hash(url, 16)}`;
    release.documents.push({ ...locale, document_key: documentKey, catalog_key: key, doc_kind: "bylaws",
      title: "Example governing document", title_derived: false, url: `${url}bylaws.pdf`, url_host: `sample${country.toLowerCase()}.example`, as_of: "2026-11-12" });
    release.document_subunits.push({ document_key: documentKey, subunit_key: subunitKey });
    release.identifiers.push({ identifier_key: `ri-${hash(key, 32)}`, catalog_key: key, namespace: `${country.toLowerCase()}-fixture`,
      identifier: `fixture-${country}`, source_url: url, as_of: "2026-11-12",
      provenance: stamp({ bytes: Buffer.from(`Example registry fixture ${country}`), source: { url, publisher: new URL(url).hostname },
        retrievedAt: "2026-11-12T17:00:00Z", capture: { method: "bulk-file", tool: "catalog-country-fixture/1", run_id: "fixture-8511" },
        asOf: "2026-11-12", reuse: { basis: "public-record" } }) });
  }
  return { release, manifest: { ...base.manifest, label, counts: releaseCounts(release),
    artifact: { ...base.manifest.artifact, sha256: hash(JSON.stringify(release), 64) } } };
}

// ---------------------------------------------------------------- exporter snapshot (part 2)
// The same 55 jurisdictions as research-build input to catalog:export, in
// the shape of the Americas build's enriched.json, ledger and document index:
// a ledger record with no federal file number and the body's stable ug- key,
// locale on the body, its offices, sub-units and documents, typed cadence,
// and sourced registry identifiers with their capture fields. Every body,
// host and number is invented; hosts are .example names except the two that
// exercise multi-label public suffixes.

export const exportKey = (country) => `ug-ex${country.toLowerCase()}000000`;
export const exportLedgerId = (country) => String(8511000 + AMERICAS_COUNTRIES.indexOf(country));
export const SUFFIX_HOSTS = Object.freeze({ BR: "fixture-sindicato.org.br", AR: "fixture-gremio.com.ar" });
export const exportHost = (country) => SUFFIX_HOSTS[country] ?? `union-${country.toLowerCase()}.example`;
const LOCALES = Object.freeze({
  CA: ["CA-ON", "K1A 0B1", "fr-CA", "America/Toronto"],
  MX: ["MX-JAL", "44100", "es-MX", "America/Mexico_City"],
  BR: ["BR-SP", "01000-000", "pt-BR", "America/Sao_Paulo"],
  AR: ["AR-B", null, "es-AR", "America/Argentina/Buenos_Aires"],
  CL: ["CL-RM", null, "es-CL", "America/Santiago"],
  CW: [null, null, "nl-CW", "America/Curacao"],
});
// A reviewed role mailbox in the body's language, and one that is not.
const MAILBOX = Object.freeze({ CA: "info", MX: "contacto", BR: "contato", AR: "informes", CL: "secretaria", CW: "kantoor", GP: "accueil" });
export const EXPORT_AS_OF = "2026-11-12";

export function americasSnapshotRecord(country) {
  const host = exportHost(country);
  const site = `https://www.${host}/`;
  const [subdivision = null, postal = null, language = null, timezone = null] = LOCALES[country] ?? [];
  const record = {
    name: `Example ${country} Workers Union`,
    catalog_key: exportKey(country),
    tier: country === "CA" ? "national" : "local",
    country, subdivision, postal_code: postal, language, timezone,
    web: site,
    sources: [site],
    designation: "Local",
    local_number: String(100 + AMERICAS_COUNTRIES.indexOf(country)),
    provenance: { as_of: EXPORT_AS_OF },
    // Typed cadence decides; the free text (05/06 is a day-first date) is never parsed.
    election_term_years: 3,
    next_election_on: "2028-05-01",
    electionCycle: "Elecciones cada 05/06/2027",
    identifiers: [{
      namespace: `${country.toLowerCase()}-registry`, value: `${country}-${1000 + AMERICAS_COUNTRIES.indexOf(country)}`,
      source_url: `${site}registro`, as_of: EXPORT_AS_OF,
      content_sha256: hash(`registry capture ${country}`, 64), retrieved_at: "2026-11-12T17:00:00Z", capture_method: "http-get",
    }],
    parentBodies: country === "CA" ? [] : [{ name: "Example CA Workers Union", kind: "federation", source: site, parent_catalog_key: exportKey("CA") }],
    subunits: [{ name: `Example ${country} Section 1`, kind: "Seccionales", source: site, as_of: EXPORT_AS_OF }],
    offices: [{
      name: "Central office", source: `${site}contact`,
      email: `${MAILBOX[country] ?? "info"}@${host}`,
      ...(country === "CA" ? { phone: "+1 613 555 0142" } : {}),
      ...(country === "BR" ? { phone: "(11) 5555-0100" } : {}),
      country, subdivision, postal_code: postal, language, timezone,
    }],
  };
  if (country === "CW") record.locale_unknowns = { subdivision: "not_applicable", postal_code: "not_published" };
  return record;
}

/** Adds the 55-jurisdiction Americas sample to a baseFixture() (the exporter's inputs). */
export function addAmericasSnapshot(fixture) {
  for (const country of AMERICAS_COUNTRIES) {
    const id = exportLedgerId(country);
    fixture.enriched[id] = americasSnapshotRecord(country);
    // As in the research build: the ledger record carries only the legacy
    // fields, and the stable key is on the enriched record.
    fixture.ledger[id] = { id, file: null, parent: null, members: null, fy: null, aff: null };
    const [subdivision = null, , language = null] = LOCALES[country] ?? [];
    fixture.documents.push({
      url: `https://www.${exportHost(country)}/estatutos.pdf`, orgId: id, subunit: null, kind: "bylaws", title: "Estatutos",
      asOf: EXPORT_AS_OF, status: "ok", alsoIn: [], country, subdivision, postal_code: null, language, timezone: null,
    });
  }
  return fixture;
}
