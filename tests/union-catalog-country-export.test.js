// @vitest-environment node
//  part 2: the exporter half of country-aware catalog bodies.
// Every body, host, person and number here is invented (fixture names,
// reserved .example hosts, the two suffix hosts of the Americas fixture,
// 555-01xx and the Ofcom drama range 020 7946 0xxx).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planRelease, readRelease } from "../scripts/load-union-catalog.mjs";
import { validate as validateProvenance } from "../scripts/lib/provenance.mjs";
import { localeViolations } from "../scripts/union-catalog/catalog-locale.mjs";
import { releaseViolations } from "../scripts/union-catalog/catalog-shape.mjs";
import {
  INTERNATIONAL_ROLE_MAILBOX_PATTERN,
  LEDGER_FIELDS,
  ROLE_MAILBOX_PATTERN,
  assertReleasePrivacy,
  buildCatalogRelease,
  e164Phone,
  identifierKey,
  internationalRegistrableDomain,
  registrableDomain,
  typedElectionCadence,
  typedIsoDate,
} from "../scripts/union-catalog/privacy-filter.mjs";
import { LOCAL_ID, baseFixture, exclusionList, filterOptions } from "./helpers/union-catalog-fixture.mjs";
import { BASE_LABEL, writeBaseRelease } from "./helpers/union-catalog-research-fixture.mjs";
import {
  AMERICAS_COUNTRIES,
  EXPORT_AS_OF,
  addAmericasSnapshot,
  americasSnapshotRecord,
  exportKey,
  exportLedgerId,
} from "./helpers/union-catalog-americas-fixture.mjs";

const ROW_TABLES = ["organizations", "edges", "subunits", "seat_outlines", "contacts", "documents"];

function combined(mutate = () => {}) {
  const fixture = addAmericasSnapshot(baseFixture());
  mutate(fixture);
  return fixture;
}
const exportOf = (fixture, overrides) => buildCatalogRelease(filterOptions(fixture, overrides));
const rowsOf = (release, table, country) => release[table].filter((row) => (row.catalog_key ?? row.child_key) === exportKey(country));
/** One extra non-US body, ledger id 8519nnn, built from the CA sample record. */
function withBody(fixture, suffix, patch, ledgerPatch = {}) {
  const id = `8519${suffix}`;
  const key = ledgerPatch.catalog_key ?? `ug-extra${suffix}0`.slice(0, 13).padEnd(13, "0");
  fixture.enriched[id] = { ...americasSnapshotRecord("CA"), name: `Example Extra ${suffix} Union`, catalog_key: key, identifiers: [], ...patch };
  fixture.ledger[id] = { id, file: null, parent: null, members: null, fy: null, aff: null, catalog_key: key, ...ledgerPatch };
  return { id, key };
}

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "catalog-country-export-"));
  dirs.push(dir);
  return dir;
}

describe("B01: bodies without a federal file number take the one null-OLMS identity route", () => {
  it("keeps every filer row, key and id-map entry identical, and a legacy export has no locale or identifiers", () => {
    const base = exportOf(baseFixture());
    const both = exportOf(combined());
    for (const table of [...ROW_TABLES, "document_subunits"]) {
      const after = new Set(both.release[table].map((row) => JSON.stringify(row)));
      for (const row of base.release[table]) expect(after.has(JSON.stringify(row)), table).toBe(true);
    }
    for (const [id, key] of Object.entries(base.idMap)) expect(both.idMap[id]).toBe(key);
    expect(Object.hasOwn(base.release, "identifiers")).toBe(false);
    for (const table of ROW_TABLES) for (const row of base.release[table]) expect(Object.hasOwn(row, "country"), table).toBe(false);
    expect(LEDGER_FIELDS).toContain("catalog_key");
  });

  it("exports each ledger ug- key as itself, with no file number, registry link or invented number", () => {
    const built = exportOf(combined());
    for (const country of AMERICAS_COUNTRIES) {
      const [org] = rowsOf(built.release, "organizations", country);
      expect(org, country).toMatchObject({ catalog_key: exportKey(country), olms_file_number: null, union_org_id: null, country });
      expect(built.idMap[exportLedgerId(country)]).toBe(exportKey(country));
    }
    expect(built.counts.organizations_without_file_number).toBe(AMERICAS_COUNTRIES.length);
    expect(releaseViolations(built.release)).toEqual([]);
  });

  it("refuses a record with neither identity, a reserved directory key, a disagreeing key and a collision", () => {
    expect(() => exportOf(combined((f) => { delete f.enriched[exportLedgerId("CA")].catalog_key; })))
      .toThrow(/ledger record 8511\d+ has no positive integer OLMS file number/);
    expect(() => exportOf(combined((f) => { withBody(f, "001", {}, { catalog_key: "ug-d000000000" }); })))
      .toThrow(/reserved directory-listed key shape/);
    expect(() => exportOf(combined((f) => { f.ledger[LOCAL_ID].catalog_key = "ug-exca999999"; })))
      .toThrow(/has a federal file number and a different catalog key/);
    expect(() => exportOf(combined((f) => { f.ledger[exportLedgerId("MX")].catalog_key = exportKey("BR"); })))
      .toThrow(/names a catalog key its ledger record does not/);
    expect(() => exportOf(combined((f) => { f.enriched[exportLedgerId("MX")].catalog_key = exportKey("BR"); })))
      .toThrow(/catalog key collision ug-exbr000000 \(ledger records/);
    expect(() => exportOf(combined((f) => { f.enriched[exportLedgerId("MX")].catalog_key = "ug-EX"; })))
      .toThrow(/ledger record 8511\d+ has no positive integer OLMS file number/);
  });

  it("keys a body by its ledger catalog_key as well, and lets a real file number supersede a research key", () => {
    const built = exportOf(combined((f) => {
      f.ledger[exportLedgerId("CA")].catalog_key = exportKey("CA");
      f.enriched[LOCAL_ID].catalog_key = "ug-exus000001";
    }));
    expect(built.idMap[exportLedgerId("CA")]).toBe(exportKey("CA"));
    expect(built.idMap[LOCAL_ID]).toBe("olms-900000001");
    expect(built.dropReport["organizations.catalog_key:superseded_by_file_number"]).toBe(1);
  });

  it("keeps the first of two different sub-units sharing a key on a body without a file number, and counts the other", () => {
    const built = exportOf(combined((f) => {
      const record = f.enriched[exportLedgerId("MX")];
      record.subunits.push({ ...record.subunits[0], website: "https://www.union-mx.example/section" });
    }));
    expect(rowsOf(built.release, "subunits", "MX")).toHaveLength(1);
    expect(built.dropReport["subunits:key_collision"]).toBe(1);
  });

  it("drops a body without a file number whose every source fails the privacy gate", () => {
    const built = exportOf(combined((f) => { withBody(f, "002", { sources: ["https://www.union-ca.example/contact/802-555-0100"] }); }));
    expect(built.release.organizations.some((org) => org.name === "Example Extra 002 Union")).toBe(false);
    expect(built.dropReport["organizations:no_usable_source"]).toBe(1);
  });
});

describe("B07-B09: every row a country-aware body exports carries a validated locale bundle", () => {
  it("emits complete bundles on organizations, edges, sub-units, seats, contacts and documents", () => {
    const built = exportOf(combined());
    for (const country of AMERICAS_COUNTRIES) {
      for (const table of ROW_TABLES) {
        const rows = rowsOf(built.release, table, country);
        if (table !== "seat_outlines" && !(table === "edges" && country === "CA")) expect(rows.length, `${table} ${country}`).toBeGreaterThan(0);
        for (const row of rows) {
          expect(localeViolations(row), `${table} ${country}`).toEqual([]);
          expect(row.country, `${table} ${country}`).toBe(country);
        }
      }
    }
    const [ca] = rowsOf(built.release, "organizations", "CA");
    expect(ca).toMatchObject({ subdivision: "CA-ON", postal_code: "K1A 0B1", language: "fr-CA", timezone: "America/Toronto", locale_unknowns: {}, state: null, zip5: null });
    const [cw] = rowsOf(built.release, "organizations", "CW");
    expect(cw.locale_unknowns).toEqual({ subdivision: "not_applicable", postal_code: "not_published" });
    const [gs] = rowsOf(built.release, "organizations", "GS");
    expect(gs.locale_unknowns).toEqual({ subdivision: "unconfirmed", postal_code: "unconfirmed", language: "unconfirmed", timezone: "unconfirmed" });
    // A document states its own language; a timezone it does not state is never inherited.
    const [doc] = rowsOf(built.release, "documents", "CA");
    expect(doc).toMatchObject({ country: "CA", subdivision: "CA-ON", language: "fr-CA", timezone: null });
  });

  it("drops invalid values and counts them, never repairs, re-cases or infers them, and keeps state and zip5 U.S. only", () => {
    const built = exportOf(combined((f) => {
      Object.assign(f.enriched[exportLedgerId("CA")], { subdivision: "MX-JAL", timezone: "america/toronto", state: "ON", zip: "12345", region: "Northeast" });
      Object.assign(f.enriched[exportLedgerId("MX")], { country: "ZZ", postal_code: "8025550100" });
      Object.assign(f.enriched[exportLedgerId("BR")], { language: "pt_BR" });
    }));
    const [ca] = rowsOf(built.release, "organizations", "CA");
    expect(ca).toMatchObject({ subdivision: null, timezone: null, state: null, zip5: null, census_region: null });
    expect(ca.locale_unknowns).toMatchObject({ subdivision: "unconfirmed", timezone: "unconfirmed" });
    const mx = built.release.organizations.find((row) => row.catalog_key === exportKey("MX"));
    expect(mx).toMatchObject({ country: null, subdivision: null, postal_code: null });
    expect(built.release.organizations.find((row) => row.catalog_key === exportKey("BR")).language).toBeNull();
    for (const path of ["organizations.subdivision:invalid", "organizations.timezone:invalid", "organizations.country:invalid",
      "organizations.postal_code:invalid", "organizations.language:invalid", "organizations.state:outside_united_states", "organizations.zip5:outside_united_states"]) {
      expect(built.dropReport[path], path).toBeGreaterThan(0);
    }
    expect(releaseViolations(built.release)).toEqual([]);
  });
});

describe("B04/B06: registry identifiers keep their source and as-of date, never as federal file numbers", () => {
  it("stamps a name-free capture receipt for each sourced identifier", () => {
    const built = exportOf(combined());
    expect(built.release.identifiers).toHaveLength(AMERICAS_COUNTRIES.length);
    for (const row of built.release.identifiers) {
      expect(row.identifier_key).toBe(identifierKey(row.catalog_key, row.namespace, row.identifier));
      expect(validateProvenance(row.provenance).ok).toBe(true);
      expect(row.provenance).toMatchObject({ as_of: EXPORT_AS_OF, source: { url: row.source_url, publisher: new URL(row.source_url).hostname }, capture: { method: "http-get" } });
      expect(row.provenance.source.title).toBeUndefined();
    }
    expect(built.release.organizations.every((org) => org.olms_file_number === null || String(org.catalog_key) === `olms-${org.olms_file_number}`)).toBe(true);
  });

  it("drops OLMS namespaces, unsourced, undated, uncaptured, person-shaped and duplicate identifiers, and admits a numeric registry token", () => {
    const id = exportLedgerId("CA");
    const good = americasSnapshotRecord("CA").identifiers[0];
    const built = exportOf(combined((f) => {
      f.enriched[id].identifiers = [
        { ...good, namespace: "ca-olms" },
        { ...good, value: "CA-2", source_url: null },
        { ...good, value: "CA-3", as_of: "12/11/2026" },
        { ...good, value: "CA-4", content_sha256: null },
        { ...good, value: "CA-5", capture_method: "computed" },
        { ...good, value: "someone@union-ca.example" },
        good, good,
        { ...good, value: "8025550100" },
      ];
    }));
    const rows = built.release.identifiers.filter((row) => row.catalog_key === exportKey("CA"));
    expect(rows.map((row) => row.identifier).sort()).toEqual(["8025550100", good.value].sort());
    for (const reason of ["olms_namespace", "unsourced", "no_as_of", "no_capture_receipt", "identifier_shape", "duplicate"]) {
      expect(built.dropReport[`identifiers:${reason}`], reason).toBeGreaterThan(0);
    }
    expect(built.dropReport["identifiers:no_capture_receipt"]).toBe(2);
    expect(assertReleasePrivacy(built.release)).toBe(true);
    // The exemption is for a valid identifier row's token only.
    const broken = structuredClone(built.release);
    broken.identifiers.find((row) => row.identifier === "8025550100").provenance.as_of = "2026-11-13";
    expect(() => assertReleasePrivacy(broken)).toThrow(/F8 privacy gate: identifiers\.identifier/);
  });
});

describe("repairs (G7 at 5d8886fa)", () => {
  it("drops a registry identifier that carries a listed person's phone in any spelling", () => {
    const id = exportLedgerId("MX");
    const good = americasSnapshotRecord("MX").identifiers[0];
    const built = exportOf(combined((f) => {
      const record = f.enriched[id];
      record.leaders = [{ name: "Rosa Fixtureperson", title: "Secretaria General", phone: "+52 33 5555 0161" }];
      record.identifiers = [good, { ...good, value: "523355550161" }, { ...good, value: "55550161" }, { ...good, value: "MX-55550161-A" }];
    }));
    const rows = built.release.identifiers.filter((row) => row.catalog_key === exportKey("MX"));
    expect(rows.map((row) => row.identifier)).toEqual([good.value]);
    expect(built.dropReport["identifiers:person_or_excluded"]).toBe(3);
  });

  it("lets a document whose index states no locale inherit its body's place, through the projected index", () => {
    const built = exportOf(combined((f) => {
      const doc = f.documents.find((entry) => entry.orgId === exportLedgerId("MX"));
      for (const field of ["country", "subdivision", "postal_code", "language", "timezone"]) delete doc[field];
    }));
    const [doc] = rowsOf(built.release, "documents", "MX");
    expect(doc).toMatchObject({ country: "MX", subdivision: "MX-JAL", postal_code: "44100", language: null, timezone: null });
    expect(doc.locale_unknowns).toEqual({ language: "unconfirmed", timezone: "unconfirmed" });
    expect(localeViolations(doc)).toEqual([]);
    // A legacy index entry still projects to exactly its old fields.
    const legacy = exportOf(baseFixture());
    for (const row of legacy.release.documents) expect(Object.hasOwn(row, "country")).toBe(false);
  });

  it("keeps the U.S. contact rules for a country-aware body whose country is unknown", () => {
    const built = exportOf(combined((f) => {
      Object.assign(f.enriched[exportLedgerId("MX")], { country: null, subdivision: null });
      f.enriched[exportLedgerId("CW")].country = "ZZ";
    }));
    const mx = rowsOf(built.release, "contacts", "MX");
    expect(mx.some((row) => row.value === "contacto@union-mx.example")).toBe(false);
    expect(rowsOf(built.release, "contacts", "CW").some((row) => row.contact_kind === "email")).toBe(false);
    expect(built.dropReport["contacts.email:not_role_mailbox"]).toBeGreaterThanOrEqual(2);
    expect(rowsOf(built.release, "organizations", "MX")[0]).toMatchObject({ country: null, state: null, zip5: null });
    expect(assertReleasePrivacy(built.release)).toBe(true);
    const planted = structuredClone(built.release);
    planted.contacts.push({ ...rowsOf(built.release, "contacts", "MX")[0], contact_key: `${exportKey("MX")}~email-000000000000`, contact_kind: "email", value: "contacto@union-mx.example" });
    expect(() => assertReleasePrivacy(planted)).toThrow(/F6 privacy gate/);
  });

  it("counts malformed typed cadence and dates instead of dropping them silently", () => {
    const built = exportOf(combined((f) => {
      Object.assign(f.enriched[exportLedgerId("MX")], { election_term_years: "3", next_election_on: "2028-02-30", researched_on: "12/11/2026" });
      Object.assign(f.enriched[exportLedgerId("BR")], { election_term_years: 0 });
    }));
    expect(rowsOf(built.release, "organizations", "MX")[0]).toMatchObject({ election_term_years: null, next_election_on: null, researched_on: EXPORT_AS_OF });
    expect(built.dropReport["organizations.election_term_years:invalid"]).toBe(2);
    expect(built.dropReport["organizations.next_election_on:unparsed"]).toBe(1);
    expect(built.dropReport["organizations.researched_on:unparsed"]).toBe(1);
  });
});

describe("repairs, round two (G7 at 095c7811)", () => {
  const ROSA = { name: "Rosa Fixtureperson", title: "Secretaria General", phone: "+52 33 5555 0161" };
  const socialValues = (built, country) => rowsOf(built.release, "contacts", country).filter((row) => row.contact_kind === "social").map((row) => row.value);

  it("drops a URL carrying a listed person's phone, from this record or another, and keeps the body's own links", () => {
    const built = exportOf(combined((f) => {
      const mx = f.enriched[exportLedgerId("MX")];
      mx.leaders = [ROSA];
      mx.social = [{ url: "https://wa.me/523355550161", country: "MX" }, "https://wa.me/551155550199", { url: "https://social.example/unionmxexample", country: "MX" }];
      f.enriched[exportLedgerId("BR")].leaders = [{ name: "Davi Fixtureperson", title: "Presidente", phone: "+55 11 5555 0199" }];
      const cl = f.enriched[exportLedgerId("CL")];
      cl.leaders = [{ name: "Ines Fixtureperson", title: "Tesorera", phone: "2 2555 0177" }];
      cl.web = "https://www.union-cl.example/whatsapp/56225550177";
    }));
    expect(socialValues(built, "MX")).toEqual(["https://social.example/unionmxexample"]);
    expect(built.dropReport["contacts.social:person_contact"]).toBe(2);
    expect(rowsOf(built.release, "organizations", "CL")[0].website).toBeNull();
    expect(built.dropReport["organizations.website:person_contact"]).toBe(1);
    expect(assertReleasePrivacy(built.release)).toBe(true);
  });

  it("drops a listed person's handle written joined, reordered or with a middle initial, in every locale", () => {
    const handles = ["https://facebook.example/rosafixtureperson", "https://x.example/RosaFixtureperson",
      "https://tiktok.example/@fixtureperson.rosa", "https://facebook.example/rosa.f.fixtureperson", "https://rosafixtureperson.social.example/"];
    const built = exportOf(combined((f) => {
      const mx = f.enriched[exportLedgerId("MX")];
      mx.leaders = [ROSA];
      mx.social = [...handles.map((url) => ({ url, country: "MX" })), "https://x.example/union_mx_example", { url: "https://facebook.example/unionmxexample", country: "MX" }];
      // A U.S. filer's string link is held to the same rule.
      f.enriched[LOCAL_ID].social = ["https://social.example/averyfixtureperson", "https://social.example/fixturepersonavery"];
    }));
    expect(socialValues(built, "MX").sort()).toEqual(["https://facebook.example/unionmxexample", "https://x.example/union_mx_example"]);
    expect(built.dropReport["contacts.social:person_name"]).toBe(handles.length + 2);
    const us = built.release.contacts.filter((row) => row.catalog_key === "olms-900000001").map((row) => row.value);
    expect(us.some((value) => /averyfixtureperson|fixturepersonavery/.test(value))).toBe(false);
  });

  it("drops a registry identifier holding a listed person's local number among other digits", () => {
    const good = americasSnapshotRecord("MX").identifiers[0];
    const built = exportOf(combined((f) => {
      const mx = f.enriched[exportLedgerId("MX")];
      mx.leaders = [ROSA];
      mx.identifiers = [good, { ...good, value: "MX-5555-0161-99" }, { ...good, value: "33_5555_0161_9" }];
    }));
    expect(built.release.identifiers.filter((row) => row.catalog_key === exportKey("MX")).map((row) => row.identifier)).toEqual([good.value]);
    expect(built.dropReport["identifiers:person_or_excluded"]).toBe(2);
  });
});

describe("B18: contacts outside the United States", () => {
  it("accepts reviewed role mailboxes in Spanish, French, Portuguese and Dutch, and never an officer title", () => {
    for (const local of ["contacto", "contactenos", "informacion", "oficina", "administracion", "bureau", "accueil", "syndicat", "contato",
      "escritorio", "atendimento", "kantoor", "administratie", "info", "seccion-12", "secao_3"]) {
      expect(INTERNATIONAL_ROLE_MAILBOX_PATTERN.test(local), local).toBe(true);
    }
    for (const local of ["secretaria", "presidente", "president", "tesorero", "tresorier", "secretario.general", "maria.lopez", "voorzitter"]) {
      expect(INTERNATIONAL_ROLE_MAILBOX_PATTERN.test(local), local).toBe(false);
    }
    expect(ROLE_MAILBOX_PATTERN.test("contacto")).toBe(false);
    const built = exportOf(combined());
    const emails = built.release.contacts.filter((row) => row.contact_kind === "email").map((row) => row.value);
    for (const value of ["contacto@union-mx.example", "contato@fixture-sindicato.org.br", "informes@fixture-gremio.com.ar", "kantoor@union-cw.example", "accueil@union-gp.example"]) {
      expect(emails).toContain(value);
    }
    expect(emails).not.toContain("secretaria@union-cl.example");
  });

  it("keeps the U.S. mailbox rule for a U.S. body and in the final gate", () => {
    const fixture = baseFixture();
    fixture.enriched[LOCAL_ID].email = "contacto@exampleworkers1.example";
    const built = exportOf(fixture);
    expect(built.release.contacts.some((row) => row.value === "contacto@exampleworkers1.example")).toBe(false);
    const planted = structuredClone(built.release);
    const email = planted.contacts.find((row) => row.contact_kind === "email");
    email.value = email.value.replace(/^[^@]+/, "contacto");
    expect(() => assertReleasePrivacy(planted)).toThrow(/F6 privacy gate/);
  });

  it("reads registrable domains under the Americas' multi-label suffixes without changing the U.S. rule", () => {
    expect(internationalRegistrableDomain("www.fixture-sindicato.org.br")).toBe("fixture-sindicato.org.br");
    expect(internationalRegistrableDomain("mail.fixture-gremio.com.ar")).toBe("fixture-gremio.com.ar");
    expect(internationalRegistrableDomain("union.on.ca")).toBe("union.on.ca");
    expect(internationalRegistrableDomain("org.br")).toBeNull();
    expect(internationalRegistrableDomain("www.union-ca.example")).toBe("union-ca.example");
    expect(registrableDomain("www.fixture-sindicato.org.br")).toBe("org.br");
    const built = exportOf(combined((f) => { f.enriched[exportLedgerId("BR")].offices[0].email = "contato@outro-sindicato.org.br"; }));
    expect(built.release.contacts.some((row) => row.value === "contato@outro-sindicato.org.br")).toBe(false);
    expect(built.dropReport["contacts.email:domain_mismatch"]).toBe(1);
  });

  it("keeps office phones only in E.164 and drops a listed person's phone in any spelling", () => {
    expect(e164Phone("+1 613 555 0142")).toBe("+16135550142");
    expect(e164Phone("+44 (20) 7946-0958")).toBe("+442079460958");
    for (const value of ["(11) 5555-0100", "613 555 0142", "+1234567", "+44 (20) (7946) 0958", "+44 20 7946 0958 ext 2", "+0 20 7946 0958"]) expect(e164Phone(value), value).toBeNull();
    const built = exportOf(combined((f) => {
      f.enriched[exportLedgerId("CA")].social = [{ url: "https://social.example/union-ca", country: "CA", language: "en-CA" }];
    }));
    expect(rowsOf(built.release, "contacts", "CA").find((row) => row.contact_kind === "phone").value).toBe("+16135550142");
    expect(rowsOf(built.release, "contacts", "CA").find((row) => row.contact_kind === "social")).toMatchObject({ value: "https://social.example/union-ca", language: "en-CA", subdivision: null });
    expect(built.dropReport["contacts.phone:not_e164"]).toBe(1);
    // A person listed with a local eight-digit number: its E.164 form at the office is that person's.
    const personal = exportOf(combined((f) => {
      const record = f.enriched[exportLedgerId("CA")];
      record.leaders = [{ name: "Rosa Fixtureperson", title: "Presidenta", phone: "7946 0961" }];
      record.offices[0].phone = "+44 20 7946 0961";
      record.offices.push({ name: "Annex", source: "https://www.union-ca.example/annex", address: "Fixture Street 1, tel 020 7946 0961", country: "CA" });
    }));
    expect(rowsOf(personal.release, "contacts", "CA").some((row) => row.contact_kind === "phone")).toBe(false);
    expect(rowsOf(personal.release, "contacts", "CA").some((row) => row.contact_kind === "office_address")).toBe(false);
    expect(personal.dropReport["contacts.phone:person_contact"]).toBe(1);
    expect(personal.dropReport["contacts.office_address:person_contact"]).toBe(1);
  });

  it("still drops person-shaped mailboxes and excluded values outside the United States", () => {
    const built = exportOf(combined((f) => {
      f.enriched[exportLedgerId("MX")].offices[0].email = "maria.lopez@union-mx.example";
      f.enriched[exportLedgerId("CW")].offices[0].email = "kantoor@union-cw.example";
    }), { exclusions: exclusionList(["kantoor@union-cw.example"]) });
    const emails = built.release.contacts.filter((row) => row.contact_kind === "email").map((row) => row.value);
    expect(emails).not.toContain("maria.lopez@union-mx.example");
    expect(emails).not.toContain("kantoor@union-cw.example");
    expect(built.dropReport["contacts.email:person_shaped"]).toBe(1);
    expect(built.exclusionMatches).toBeGreaterThan(0);
  });
});

describe("B19: typed dates and cadence outside the United States", () => {
  it("reads only typed ISO dates", () => {
    expect(typedIsoDate("2026-11-12")).toEqual({ value: "2026-11-12", status: "ok" });
    expect(typedIsoDate("2026-11-12T17:00:00Z").value).toBe("2026-11-12");
    expect(typedIsoDate("2026-11-12T23:30:00.123456-05:00").value).toBe("2026-11-12");
    for (const value of ["05/06/2026", "12 de noviembre de 2026", "November 12, 2026", "2026-02-30", "2026-11", "2026-11-12T17:00:00", "2026-11-12 17:00:00Z"]) {
      expect(typedIsoDate(value).value, value).toBeNull();
    }
    expect(typedIsoDate("").status).toBe("empty");
    expect(typedElectionCadence({ election_term_years: 4, next_election_on: "2027-06-05" })).toEqual({ termYears: 4, nextOn: "2027-06-05" });
    expect(typedElectionCadence({ election_term_years: 11, next_election_on: "05/06/2027" })).toEqual({ termYears: null, nextOn: null });
  });

  it("never lets an English-only parser decide a non-English date or cadence", () => {
    const built = exportOf(combined((f) => {
      const record = f.enriched[exportLedgerId("MX")];
      delete record.election_term_years;
      delete record.next_election_on;
      record.electionCycle = "Two-year terms; next election 05/06/2027";
      record.subunits[0].as_of = "05/06/2026";
      record.provenance = { as_of: "05/06/2026" };
    }));
    const [mx] = rowsOf(built.release, "organizations", "MX");
    expect(mx).toMatchObject({ election_term_years: null, next_election_on: null, researched_on: null });
    expect(rowsOf(built.release, "subunits", "MX")[0].as_of).toBeNull();
    expect(built.dropReport["subunits.as_of:unparsed"]).toBe(1);
    const [ca] = rowsOf(built.release, "organizations", "CA");
    expect(ca).toMatchObject({ election_term_years: 3, next_election_on: "2028-05-01", researched_on: EXPORT_AS_OF });
  });
});

describe("B03: parent edges", () => {
  it("keys an explicit parent, never re-keys a filer's label, and narrows an ambiguous name to the child's country", () => {
    const built = exportOf(combined((f) => {
      // A filer naming a sample body keeps its label-only edge.
      f.enriched[LOCAL_ID].parentBodies = [...(f.enriched[LOCAL_ID].parentBodies ?? []), { name: "Example MX Workers Union", kind: "federation", source: "https://exampleworkers1.example/about" }];
      // Two bodies share a name in different countries; a Mexican child resolves to the Mexican one.
      withBody(f, "003", { name: "Example Shared Federation", country: "MX", subdivision: null, postal_code: null, language: null, timezone: null });
      withBody(f, "004", { name: "Example Shared Federation", country: "CA" });
      const child = f.enriched[exportLedgerId("PE")];
      child.parentBodies = [{ name: "Example Shared Federation", kind: "federation", source: child.web }];
      child.country = "MX";
      child.subdivision = null;
      f.enriched[exportLedgerId("GT")].parentBodies = [{ name: "Example CA Workers Union", kind: "federation", source: "https://www.union-gt.example/", parent_catalog_key: "ug-zzzzzzzzzz" }];
    }));
    const filerEdge = built.release.edges.find((edge) => edge.child_key === "olms-900000001" && edge.parent_label === "Example MX Workers Union");
    expect(filerEdge.parent_key).toBeNull();
    expect(Object.hasOwn(filerEdge, "country")).toBe(false);
    const shared = built.release.organizations.find((org) => org.name === "Example Shared Federation" && org.country === "MX").catalog_key;
    expect(rowsOf(built.release, "edges", "PE")[0].parent_key).toBe(shared);
    expect(rowsOf(built.release, "edges", "BR")[0]).toMatchObject({ parent_key: exportKey("CA"), parent_label: null, edge_kind: "parent_body", certainty: "confirmed" });
    expect(built.dropReport["edges.parent_body:explicit_key_unresolved"]).toBe(1);
    expect(rowsOf(built.release, "edges", "GT")[0].parent_key).toBe(exportKey("CA"));
  });
});

describe("catalog:export and catalog:plan over the accepted base", () => {
  it("plans the combined release against the base with nothing retired", () => {
    const dir = tempDir();
    const base = readRelease(writeBaseRelease(dir).dir);
    const next = readRelease(writeBaseRelease(dir, { label: "20261114-61", mutate: addAmericasSnapshot }).dir);
    expect(next.manifest.counts.organizations).toBe(base.manifest.counts.organizations + AMERICAS_COUNTRIES.length);
    expect(next.manifest.counts.identifiers).toBe(AMERICAS_COUNTRIES.length);
    const plan = planRelease(next, { previous: base });
    expect(plan.label).toBe("20261114-61");
    expect(JSON.stringify(plan)).not.toMatch(/"(?:organizations|subunits)Retired":[1-9]/);
    expect(base.manifest.label).toBe(BASE_LABEL);
  });
});
