// @vitest-environment node
//
// SEC-UG-UNION-CATALOG-EXPORT-PRIVACY-FILTER-20260924: one test per filter
// rule F1-F13, one F8 name-scrub test per exported free-text field, and one
// test per row of the value-normalization table (spec 2026-09-24 union
// catalog design §2.5). Every fixture is fictional (tests/helpers/union-catalog-fixture.mjs).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ALWAYS_DROPPED_FIELDS,
  DOCUMENT_INDEX_FIELDS,
  FILTER_VERSION,
  ExclusionMatcher,
  LEDGER_FIELDS,
  MIXED_L_TOKEN_MAX,
  READING_WORD_MAX,
  RecordPeople,
  assertNoReferenceKey,
  assertReleasePrivacy,
  buildCatalogRelease,
  buildOrganizationPrefill,
  containsContactPattern,
  createShortNameMatcher,
  detectionRuns,
  directoryBodyKey,
  exclusionCandidates,
  exclusionReadings,
  foldLookAlikes,
  lookAlikeReadings,
  nameTokens,
  exclusionHash,
  exclusionHashes,
  normalizeConfidence,
  normalizeSector,
  normalizeState,
  normalizeSubunitKind,
  parseElectionCycle,
  parseExclusionList,
  projectDocumentIndex,
  projectLedgerRecords,
  registrableDomain,
  sha256Hex,
} from "../scripts/union-catalog/privacy-filter.mjs";
import { RELEASE_SCHEMA, releaseViolations } from "../scripts/union-catalog/catalog-shape.mjs";
import { LOOK_ALIKE_LETTERS } from "../scripts/union-catalog/look-alike-letters.mjs";
import {
  ALWAYS_DROPPED_SENTINELS,
  DUPLICATE_ID,
  LOCAL_ID,
  NATIONAL_ID,
  OLMS_KEY,
  PEOPLE,
  PERSON_EMAILS,
  PERSON_PHONES,
  STATE_BODY_ID,
  TEST_SALT,
  baseFixture,
  emptyRecord,
  exclusionList,
  filterOptions,
} from "./helpers/union-catalog-fixture.mjs";

function run(mutate = () => {}, overrides = {}) {
  const fixture = baseFixture();
  mutate(fixture);
  return buildCatalogRelease(filterOptions(fixture, overrides));
}

function prefill(mutate = () => {}, overrides = {}) {
  const fixture = baseFixture();
  mutate(fixture);
  return buildOrganizationPrefill(LOCAL_ID, filterOptions(fixture, overrides));
}

const local = (fixture) => fixture.enriched[LOCAL_ID];

// SEC-UG-CATALOG-PRIVACY-FILTER-POSSESSIVE-AND-APOSTROPHE-NAME-LEAK-20261113:
// every apostrophe-like character a name may be written with (the C128 probe
// of November 13, 2026), and the three ways each one may stand in a name.
const APOSTROPHE_LIKE = Object.freeze({
  "U+0027": "'", "U+2019": "\u2019", "U+2018": "\u2018", "U+02BC": "\u02BC", "U+00B4": "\u00B4", "U+2032": "\u2032",
  "U+0060": "`", "U+FF07": "\uFF07", "U+05F3": "\u05F3", "U+02B9": "\u02B9", "U+201B": "\u201B", "U+02BB": "\u02BB",
  "U+02BD": "\u02BD", "U+02BE": "\u02BE", "U+A78C": "\uA78C", "U+FF40": "\uFF40", "U+2035": "\u2035",
});
// [label, surname as listed, surname as written in the text]
const NAME_SHAPES = [
  ...Object.entries(APOSTROPHE_LIKE).flatMap(([code, mark]) => [
    [`a possessive with ${code}`, "Fixtureperson", `Fixtureperson${mark}s office`],
    [`${code} inside the name`, "O'Fixtureperson", `O${mark}Fixtureperson`],
    [`${code} inside the listed name`, `O${mark}Fixtureperson`, "O'Fixtureperson"],
  ]),
  ["a U+FEFF inside the name", "Fixtureperson", "Fixture\uFEFFperson"],
  ["a zero-width space between the apostrophe and the s", "Fixtureperson", "Fixtureperson'\u200Bs office"],
];
// The class, not a list ( review, November 13, 2026): punctuation
// that is not on any list, and combining marks outside U+0300-U+036F. Each is
// checked in a structure note, a document title and a percent-encoded URL.
const UNLISTED_SHAPES = [
  ...["U+055A", "U+07F4", "U+07F5", "U+02BA", "U+02CA", "U+02CB", "U+275C", "U+201A"].flatMap((code) => {
    const mark = String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    return [
      [`unlisted ${code} inside the name`, "O'Fixtureperson", `O${mark}Fixtureperson`],
      [`unlisted ${code} in a possessive`, "Fixtureperson", `Fixtureperson${mark}s office`],
    ];
  }),
  ["a U+0301 between the apostrophe and the s", "Fixtureperson", "Fixtureperson'\u0301s office"],
  ...["U+1AB0", "U+1DC0", "U+20D6"].map((code) => [`a ${code} combining mark inside the name`, "Fixtureperson", `Fi${String.fromCodePoint(Number.parseInt(code.slice(2), 16))}xtureperson`]),
];
// Text that names no listed person, which must still export.
const NAME_CONTROLS = [
  ["Finley William", "Minutes by Finley Williams."],
  ["Finley William", "Minutes by Finley Williams' office."],
  ["Finley O'Fixtureperson", "The Workers\u2019 Council's office moved to O\u05F3Hara Street."],
  ["Finley O'Fixtureperson", "The O\u2019Fixtureperson River and Fixtureperson County office are open."],
  ["Finley Fixtureperson", "Organization plans support Williams County workers."],
  ["Finley William", "The county's headquarters supports workers' rights."],
  ["Finley Fixtureperson", "Minutes by Finley Fixturepersonage, for the unit."],
];
// A contraction or possessive ending is never a name token ( second
// review): a short listed name must not take ordinary text with it. Each is
// checked in a structure note, a document title and a percent-encoded URL.
const SHORT_NAME_CONTROLS = [
  ["Don T", "Don't close the public office before noon."],
  ["Don T", "We don't require an appointment."],
  ["Don T", "Members don't need to bring a printed copy."],
  ["Don T.", "Please don\u2019t send originals by mail."],
  ["Ray S", "Ray's Summit is a fictional place on the map."],
  ["Al S", "Al's General Store hosts the fictional community office."],
  ["Lee S.", "Lee's Summit has a public library."],
];
const placeInAllThreeFields = (f, value) => {
  local(f).structureNote = value;
  f.documents[1].title = value;
  f.documents[2].url = `https://exampleworkers1.example/files/${encodeURIComponent(value)}-letter.pdf`;
};
const expectAllThreeExported = (out, value) => {
  expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBe(value);
  expect(out.release.documents.find((d) => d.url.endsWith("/files/bylaws.pdf"))).toMatchObject({ title: value, title_derived: false });
  expect(out.release.documents.some((d) => d.url.includes("letter.pdf"))).toBe(true);
};
const northside = (fixture) => local(fixture).subunits[0];
const serialized = (out) => JSON.stringify(out.release).toLowerCase();
const subunitsOf = (out) => out.release.subunits.filter((s) => s.catalog_key === OLMS_KEY.local);

describe("listed-name ASCII comparisons use the canonical letter fold (#9295)", () => {
  const spellings = [
    ["æ", "Æ", "ae"], ["œ", "Œ", "oe"], ["ß", "ẞ", "ss"], ["þ", "Þ", "th"],
    ["ð", "Ð", "d"], ["ø", "Ø", "o", "oe"], ["ł", "Ł", "l"], ["đ", "Đ", "d"],
  ].flatMap(([lower, upper, ...ascii]) => [lower, upper].flatMap((letter) => [letter, ...ascii].map((written) => [letter, written])));
  const listed = (letter) => {
    const people = new RecordPeople();
    people.addName(`Avery Q${letter}ll`);
    return people;
  };
  describe.each(["joined", "reversed"])("%s handles", (order) => {
    describe.each(["raw", "encoded"])("%s URL", (encoding) => {
      it.each(spellings)("recognizes listed %s written %s", (letter, written) => {
        const handle = order === "joined" ? `averyq${written}ll` : `q${written}llavery`;
        const path = encoding === "encoded" ? encodeURIComponent(handle) : handle;
        expect(listed(letter).handleNamesPerson(`https://social.example/${path}`)).toBe(true);
      });
    });
  });
  describe.each(["%s", "desk%s", "%sdesk"])("local part %s", (pattern) => {
    it.each(spellings)("recognizes listed %s written %s", (letter, written) => {
      expect(listed(letter).localPartNamesPerson(pattern.replace("%s", `q${written}ll`))).toBe(true);
    });
  });
  it.each(spellings)("recognizes listed %s through a detection-run join written %s", (letter, written) => {
    expect(listed(letter).containsName(`Avery Q·${written}ll`)).toBe(true);
  });
  it("keeps digit boundaries in local parts and preserves unrelated handles", () => {
    const people = new RecordPeople();
    people.addName("Ivo Quill");
    expect(people.localPartNamesPerson("ivo7")).toBe(true);
    expect(people.localPartNamesPerson("office")).toBe(false);
    expect(people.handleNamesPerson("https://social.example/ivoquill")).toBe(true);
    expect(people.handleNamesPerson("https://social.example/organizationdesk")).toBe(false);
  });
});

describe("the baseline fixture", () => {
  it("builds a release of the declared schema and filter version", () => {
    const out = run();
    expect(out.release.schema).toBe(RELEASE_SCHEMA);
    expect(out.release.filterVersion).toBe(FILTER_VERSION);
    expect(out.release.organizations.map((o) => o.catalog_key).sort()).toEqual(Object.values(OLMS_KEY).sort());
    expect(out.idMap[LOCAL_ID]).toBe(OLMS_KEY.local);
  });
});

describe("F1: inputs", () => {
  it("refuses to run when a parsed input carries a key named reference", () => {
    expect(() => run((f) => {
      northside(f).reference = { note: "fictional" };
    })).toThrow(/F1: enriched\.json carries a key named "reference"/);
    expect(() => assertNoReferenceKey({ documents: [{ reference: 1 }] }, "documents/index.json")).toThrow(/F1: documents\/index\.json/);
  });

  it("keeps only id, file, parent, members, fy and aff of a ledger record", () => {
    const projected = projectLedgerRecords(baseFixture().ledger);
    for (const record of Object.values(projected)) expect(Object.keys(record).sort()).toEqual([...LEDGER_FIELDS].sort());
    expect(serialized(run())).not.toContain("sentinel-ledger");
  });

  it("keeps only the metadata fields of the document index", () => {
    const projected = projectDocumentIndex({ documents: baseFixture().documents });
    for (const doc of projected) {
      expect(Object.keys(doc).every((k) => DOCUMENT_INDEX_FIELDS.includes(k))).toBe(true);
      for (const entry of doc.alsoIn) expect(Object.keys(entry).sort()).toEqual(["orgId", "subunit"]);
    }
    const text = serialized(run());
    for (const marker of ["sentinel-found-on", "sentinel-page-title", "sentinel-doc-orgname", "sentinel-source-record", "sentinel-alsoin"]) {
      expect(text).not.toContain(marker);
    }
  });
});

describe("F2: provenance", () => {
  it("drops and counts a sub-unit with no public source", () => {
    const out = run((f) => {
      local(f).subunits[1].source = "";
    });
    expect(subunitsOf(out).map((s) => s.name)).toEqual(["Northside Chapter"]);
    expect(out.dropReport["subunits:unsourced"]).toBe(1);
  });

  it("drops a parent body whose source is neither http(s) nor an OLMS filing", () => {
    const out = run((f) => {
      local(f).parentBodies[1].source = "batch notes";
    });
    expect(out.release.edges.some((e) => e.parent_label === "Example District 7")).toBe(false);
    expect(out.dropReport["edges:unsourced"]).toBe(1);
  });

  it("drops a seat that has no own source and nothing to inherit", () => {
    const out = run((f) => {
      local(f).sources = [];
      local(f).leaders[0].source = "";
    });
    expect(out.release.seat_outlines.some((s) => s.subunit_key === null)).toBe(false);
    expect(out.dropReport["seat_outlines:unsourced"]).toBe(1);
  });
});

describe("F3: the election, candidate and ballot source class", () => {
  it("never counts a person sourced from an election page in a seat outline", () => {
    const out = run((f) => {
      northside(f).board[0].source = "https://exampleworkers1.example/2026-election-results";
    });
    const board = out.release.seat_outlines.find((s) => s.seat_class === "board");
    expect(board.listed).toBe(1);
    expect(board.vacant).toBe(1);
    expect(out.dropReport["seat_outlines:election_source"]).toBe(1);
  });

  it("gives a sub-unit listed on a candidate page no seat outlines", () => {
    const out = run((f) => {
      northside(f).source = "https://exampleworkers1.example/candidates";
    });
    const key = subunitsOf(out).find((s) => s.name === "Northside Chapter").subunit_key;
    expect(out.release.seat_outlines.filter((s) => s.subunit_key === key)).toEqual([]);
    expect(out.dropReport["seat_outlines:election_source"]).toBe(4);
  });

  it("never supplies a document from an election, ballot or nomination link", () => {
    const out = run((f) => {
      f.documents.push({ url: "https://exampleworkers1.example/nomination-form.pdf", orgId: LOCAL_ID, subunit: "", kind: "form", title: "Form", asOf: "", status: "ok" });
    });
    const urls = out.release.documents.map((d) => d.url);
    expect(urls.some((u) => /election|nominat/.test(u))).toBe(false);
    expect(out.dropReport["documents:election_source"]).toBe(2);
  });

  it("keeps no holder note from an election page in prefill mode", () => {
    const staged = prefill((f) => {
      local(f).leaders[0].source = "https://exampleworkers1.example/ballot-2026";
    });
    expect(staged.staffNotes.some((n) => n.holderName === PEOPLE.president)).toBe(false);
  });
});

describe("F4: no person data in shared tables", () => {
  it("exports no name, email or phone of any listed person", () => {
    const text = serialized(run());
    expect(text).not.toContain("fixtureperson");
    for (const email of PERSON_EMAILS) expect(text).not.toContain(email);
    for (const phone of PERSON_PHONES) expect(text).not.toContain(phone);
  });

  it("reduces people to seat outlines of title, listed and vacant", () => {
    const out = run();
    for (const seat of out.release.seat_outlines) {
      expect(Object.keys(seat).sort()).toEqual(["as_of", "catalog_key", "listed", "outline_key", "seat_class", "source_url", "subunit_key", "title", "vacant"]);
    }
    const board = out.release.seat_outlines.find((s) => s.seat_class === "board");
    expect(board).toMatchObject({ title: "At-large seat", listed: 2, vacant: 1 });
  });

  it("never carries a person field into any table", () => {
    const out = run();
    for (const rows of Object.values(out.release).filter(Array.isArray)) {
      for (const row of rows) {
        for (const field of ["leaders", "board", "stewards", "staff", "signatories", "contact", "holder", "phone", "email"]) {
          expect(Object.hasOwn(row, field)).toBe(false);
        }
      }
    }
  });
});

describe("F5: people in prefill mode", () => {
  it("keeps officer and board holder names only from the organization's own web host", () => {
    const staged = prefill((f) => {
      northside(f).board[0].source = "https://directory.example/board";
    });
    const holders = staged.staffNotes.map((n) => n.holderName);
    expect(holders).toContain(PEOPLE.president);
    expect(holders).toContain(PEOPLE.chair);
    expect(holders).not.toContain(PEOPLE.board);
    expect(staged.dropReport["prefill.staff_notes:not_own_site"]).toBe(1);
  });

  it("never keeps a steward's name", () => {
    const staged = prefill();
    expect(staged.staffNotes.some((n) => n.seatClass === "steward" || n.holderName === PEOPLE.steward)).toBe(false);
  });

  it("keeps an OLMS signatory as name and title only", () => {
    const staged = prefill();
    const signatory = staged.staffNotes.find((n) => n.basis === "olms_signatory");
    expect(signatory).toEqual({ subunitKey: null, seatClass: "officer", title: "TREASURER", holderName: PEOPLE.signatory, sourceHost: "olms", basis: "olms_signatory" });
  });

  it("keeps no person's email or phone", () => {
    const text = JSON.stringify(prefill()).toLowerCase();
    for (const email of PERSON_EMAILS) expect(text).not.toContain(email);
    for (const phone of PERSON_PHONES) expect(text).not.toContain(phone);
  });

  // A seat entry is credited only to the page it came from (§2.5
  // normalization): an unusable own source never falls back to the sub-unit's
  // or the organization's own-site source.
  it("keeps no holder note when an off-site own source is dropped for carrying the holder's name", () => {
    const staged = prefill((f) => {
      northside(f).leaders[0].source = "https://directory.example/casey-fixtureperson";
    });
    expect(staged.staffNotes.some((n) => n.holderName === PEOPLE.chair)).toBe(false);
    expect(staged.dropReport["seat_outlines.source_url:person_name"]).toBe(1);
    expect(staged.dropReport["seat_outlines:own_source_unusable"]).toBe(1);
  });

  it("keeps no holder note when the own source is on the exclusion list", () => {
    const staged = prefill((f) => {
      northside(f).leaders[0].source = "https://exampleworkers1.example/people/chair";
    }, { exclusions: exclusionList(["exampleworkers1.example/people"]) });
    expect(staged.staffNotes.some((n) => n.holderName === PEOPLE.chair)).toBe(false);
    expect(staged.dropReport["seat_outlines:own_source_unusable"]).toBe(1);
    expect(staged.exclusionMatches).toBeGreaterThan(0);
  });

  it("keeps no holder note for an organization leader whose own source is OLMS text, and still keeps the OLMS signatory", () => {
    const staged = prefill((f) => {
      local(f).leaders[0].source = "OLMS LM-3 2025";
    });
    expect(staged.staffNotes.some((n) => n.holderName === PEOPLE.president)).toBe(false);
    expect(staged.staffNotes.some((n) => n.basis === "olms_signatory" && n.holderName === PEOPLE.signatory)).toBe(true);
    expect(staged.dropReport["seat_outlines.source_url:not_url"]).toBe(1);
    expect(staged.dropReport["seat_outlines:own_source_unusable"]).toBe(1);
  });

  it("keeps no holder note for a sub-unit leader whose own source is not a URL", () => {
    const staged = prefill((f) => {
      northside(f).leaders[0].source = "Chapter newsletter, spring 2026";
    });
    expect(staged.staffNotes.some((n) => n.holderName === PEOPLE.chair)).toBe(false);
    expect(staged.dropReport["seat_outlines:own_source_unusable"]).toBe(1);
  });

  it("never lets an organization leader with an empty own source inherit the organization's first source", () => {
    const staged = prefill((f) => {
      local(f).leaders[0].source = "";
    });
    expect(staged.staffNotes.some((n) => n.holderName === PEOPLE.president)).toBe(false);
    expect(staged.dropReport["seat_outlines:unsourced"]).toBe(1);
  });

  it("lets a sub-unit entry with an empty own source inherit only the sub-unit's source", () => {
    const staged = prefill();
    expect(staged.staffNotes.find((n) => n.holderName === PEOPLE.chair)).toMatchObject({ sourceHost: "exampleworkers1.example", basis: "own_site" });
  });

  it("drops and counts an entry whose own source is an array, an object or a number instead of letting it inherit", () => {
    const staged = prefill((f) => {
      northside(f).leaders[0].source = ["https://directory.example/casey-fixtureperson"];
      northside(f).board[0].source = { url: "https://directory.example/listing" };
      northside(f).board[1].source = 2025;
    });
    expect(staged.staffNotes.some((n) => n.holderName === PEOPLE.chair || n.holderName === PEOPLE.board)).toBe(false);
    expect(staged.dropReport["seat_outlines.source_url:not_url"]).toBe(3);
    expect(staged.dropReport["seat_outlines:own_source_unusable"]).toBe(3);
    expect(staged.dropReport["seat_outlines:unsourced"]).toBeUndefined();
    expect(JSON.stringify(staged)).not.toContain("casey-fixtureperson");
    expect(JSON.stringify(staged)).not.toContain("directory.example/listing");
    const out = run((f) => {
      northside(f).leaders[0].source = ["https://directory.example/casey-fixtureperson"];
    });
    const chapterKey = subunitsOf(out).find((s) => s.name === "Northside Chapter").subunit_key;
    expect(out.release.seat_outlines.some((s) => s.subunit_key === chapterKey && s.seat_class === "officer")).toBe(false);
    expect(out.dropReport["seat_outlines:own_source_unusable"]).toBe(1);
  });
});

describe("F6: organization contacts", () => {
  const emailsOf = (out) => out.release.contacts.filter((c) => c.contact_kind === "email");

  it("keeps a role mailbox on the organization's own domain", () => {
    expect(emailsOf(run()).map((c) => [c.value, c.basis])).toContainEqual(["info@exampleworkers1.example", "own_site"]);
  });

  it("keeps a role mailbox on the family's national domain", () => {
    const out = run((f) => {
      local(f).email = "contact@testfamily.example";
      local(f).sources.push("https://testfamily.example/locals");
    });
    expect(emailsOf(out).find((c) => c.value === "contact@testfamily.example")).toMatchObject({ basis: "family_national_site", source_url: "https://testfamily.example/locals" });
  });

  it("drops a mailbox on a consumer or hosting domain", () => {
    const out = run((f) => {
      local(f).email = "info@freemail.example";
    });
    expect(emailsOf(out).some((c) => c.value === "info@freemail.example")).toBe(false);
    expect(out.dropReport["contacts.email:blocked_domain"]).toBe(1);
  });

  it("drops a first.last-shaped local part", () => {
    const out = run((f) => {
      local(f).email = "robin.example@exampleworkers1.example";
    });
    expect(out.dropReport["contacts.email:person_shaped"]).toBe(1);
  });

  it("drops a local part that carries a token of a listed person's name", () => {
    const out = run((f) => {
      local(f).email = "local1avery@exampleworkers1.example";
    });
    expect(out.dropReport["contacts.email:person_name"]).toBe(1);
  });

  it("drops a mailbox that is not on the role allow-list", () => {
    const out = run((f) => {
      local(f).email = "members@exampleworkers1.example";
    });
    expect(out.dropReport["contacts.email:not_role_mailbox"]).toBe(1);
  });

  it("keeps an office phone and address only when the office source is the organization's own site", () => {
    const out = run();
    const values = out.release.contacts.map((c) => c.value);
    expect(values).toContain("802-555-0130");
    expect(values).toContain("1 Fixture Way, Exampleville");
    expect(values).not.toContain("802-555-0131");
    expect(values).not.toContain("2 Elsewhere Road");
    expect(out.dropReport["contacts.office:not_from_own_site"]).toBe(1);
  });

  it("exports no top-level phone or address, because neither carries its own source", () => {
    const out = run();
    const values = out.release.contacts.map((c) => c.value);
    expect(values).not.toContain("802-555-0120");
    expect(values).not.toContain("802-555-0102");
    expect(values).not.toContain("1 Fixture Way, Exampleville, VT 05999");
    expect(out.dropReport["contacts.phone:unsourced"]).toBe(2);
    expect(out.dropReport["contacts.office_address:unsourced"]).toBe(1);
  });

  it("exports no top-level address equal to the OLMS street, even on an own-site record", () => {
    const out = run((f) => {
      local(f).address = local(f).olms.street;
    });
    expect(out.release.contacts.some((c) => c.contact_kind === "office_address" && c.value.includes("9 Home Lane"))).toBe(false);
    expect(out.dropReport["contacts.office_address:unsourced"]).toBe(1);
  });

  it("drops an own-site office address that carries the OLMS street or PO box", () => {
    const street = run((f) => {
      local(f).olms.street = "9 Home Lane";
      local(f).offices[0].address = "9 Home Lane, Exampleville, VT 05999";
    });
    expect(street.release.contacts.some((c) => c.contact_kind === "office_address")).toBe(false);
    expect(street.dropReport["contacts.office_address:olms_street"]).toBe(1);
    const poBox = run((f) => {
      local(f).olms.poBox = "PO Box 12";
      local(f).offices[0].address = "P.O. Box 12, Exampleville";
    });
    expect(poBox.release.contacts.some((c) => c.contact_kind === "office_address")).toBe(false);
    expect(poBox.dropReport["contacts.office_address:olms_street"]).toBe(1);
  });

  it("drops an own-site office address that carries the record's filed mailing address (F6)", () => {
    const out = run((f) => {
      local(f).mailing = "PO Box 77, Exampleville, VT 05999";
      local(f).offices[0].address = "P.O. Box 77, Exampleville, VT 05999";
    });
    expect(out.release.contacts.some((c) => c.contact_kind === "office_address")).toBe(false);
    expect(out.dropReport["contacts.office_address:filed_mailing"]).toBe(1);
    expect(JSON.stringify(out.release)).not.toContain("Box 77");
  });

  it("drops an office address that carries a phone number or email address", () => {
    const out = run((f) => {
      local(f).offices[0].address = "1 Fixture Way, Exampleville, 802-555-0135";
    });
    expect(out.release.contacts.some((c) => c.value.includes("802-555-0135"))).toBe(false);
    expect(out.dropReport["contacts.office_address:contact_pattern"]).toBe(1);
    const email = run((f) => {
      local(f).offices[0].address = "1 Fixture Way, write to office@exampleworkers1.example";
    });
    expect(email.release.contacts.some((c) => c.contact_kind === "office_address")).toBe(false);
    expect(email.dropReport["contacts.office_address:contact_pattern"]).toBe(1);
  });

  // A listed person's phone (F10) inside an address, in a spelling the phone
  // pattern does not read: every digit run joined across separators is
  // checked against the listed phones.
  it.each([
    ["no separator between exchange and line", "(802)5550101"],
    ["a dash and no exchange separator", "802-5550101"],
    ["spaced dashes", "802 - 555 - 0101"],
    ["commas", "802,555,0101"],
    ["split line groups", "802 555 01 01"],
  ])("drops an office address that carries a listed person's phone written with %s", (_label, phone) => {
    const out = run((f) => {
      local(f).offices[0].address = `1 Fixture Way, Exampleville, VT 05999, ${phone}`;
    });
    expect(out.release.contacts.some((c) => c.catalog_key === OLMS_KEY.local && c.contact_kind === "office_address")).toBe(false);
    expect(out.dropReport["contacts.office_address:person_contact"]).toBe(1);
    expect(serialized(out)).not.toContain(phone);
    expect(() => assertReleasePrivacy(out.release)).not.toThrow();
  });

  it("drops an office address that carries a phone listed for a person in another record", () => {
    const out = run((f) => {
      f.enriched[NATIONAL_ID].leaders = [{ name: "Harper Fixtureperson", title: "President", phone: "802-555-0133", source: "https://testfamily.example/about" }];
      local(f).offices[0].address = "1 Fixture Way, Exampleville (802)5550133";
    });
    expect(out.release.contacts.some((c) => c.catalog_key === OLMS_KEY.local && c.contact_kind === "office_address")).toBe(false);
    expect(out.dropReport["contacts.office_address:person_contact"]).toBe(1);
  });

  it("keeps an office address whose street number, suite and ZIP only share digits with a listed phone", () => {
    const out = run((f) => {
      local(f).offices[0].address = "802 Fixture Way, Suite 555, Box 0101, Exampleville, VT 05999";
    });
    expect(out.release.contacts.find((c) => c.catalog_key === OLMS_KEY.local && c.contact_kind === "office_address"))
      .toMatchObject({ value: "802 Fixture Way, Suite 555, Box 0101, Exampleville, VT 05999" });
    expect(out.dropReport["contacts.office_address:person_contact"]).toBeUndefined();
    const unlisted = run((f) => {
      local(f).offices[0].address = "Building 12345, 67890 Fixture Way, Exampleville";
    });
    expect(unlisted.release.contacts.some((c) => c.catalog_key === OLMS_KEY.local && c.contact_kind === "office_address")).toBe(true);
  });

  it("drops a role mailbox on an unrelated domain", () => {
    const out = run((f) => {
      local(f).email = "info@unrelated.example";
    });
    expect(emailsOf(out).some((c) => c.value === "info@unrelated.example")).toBe(false);
    expect(out.dropReport["contacts.email:domain_mismatch"]).toBe(1);
  });

  it("keeps a role mailbox on a subdomain of the organization's own domain", () => {
    expect(registrableDomain("mail.exampleworkers1.example")).toBe("exampleworkers1.example");
    const out = run((f) => {
      local(f).email = "info@mail.exampleworkers1.example";
    });
    expect(emailsOf(out).find((c) => c.value === "info@mail.exampleworkers1.example")).toMatchObject({ basis: "own_site" });
  });

  it("keeps a local<number> mailbox on the organization's own domain", () => {
    const out = run((f) => {
      local(f).email = "local123@exampleworkers1.example";
    });
    expect(emailsOf(out).find((c) => c.value === "local123@exampleworkers1.example")).toMatchObject({ basis: "own_site" });
  });

  it("keeps a social link read on the organization's own site and drops one with no own-site source", () => {
    const social = (out) => out.release.contacts.filter((c) => c.catalog_key === OLMS_KEY.local && c.contact_kind === "social");
    expect(social(run())).toEqual([
      expect.objectContaining({ value: "https://social.example/exampleworkers1", basis: "own_site", source_url: "https://exampleworkers1.example/about", label: "social.example" }),
    ]);
    const out = run((f) => {
      local(f).sources = ["https://directory.example/local-1"];
    });
    expect(social(out)).toEqual([]);
    expect(out.dropReport["contacts.social:not_from_own_site"]).toBe(1);
  });
});

describe("F7: sub-unit contacts", () => {
  it("exports no sub-unit contact in shared mode", () => {
    const text = serialized(run());
    expect(text).not.toContain("northside@exampleworkers1.example");
    expect(text).not.toContain("802-555-0140");
  });

  it("stages a union-domain email and an own-site phone as staff-only and unconfirmed in prefill mode", () => {
    const staged = prefill();
    expect(staged.subunitContacts.map((c) => [c.kind, c.value])).toEqual([
      ["email", "northside@exampleworkers1.example"],
      ["phone", "802-555-0140"],
    ]);
    for (const contact of staged.subunitContacts) {
      expect(contact).toMatchObject({ contactVisibility: "staff", confirmationState: "unconfirmed", isPersonalAddress: false });
    }
  });

  it("drops a consumer-domain email and a phone published off the union's own site", () => {
    const staged = prefill((f) => {
      northside(f).email = "chapter@freemail.example";
      northside(f).source = "https://directory.example/chapters";
    });
    expect(staged.subunitContacts).toEqual([]);
    expect(staged.dropReport["prefill.subunit_contacts.email:blocked_domain"]).toBe(1);
    expect(staged.dropReport["prefill.subunit_contacts.phone:not_own_site"]).toBe(1);
  });

  it("drops a sub-unit email on an unrelated domain in prefill mode", () => {
    const staged = prefill((f) => {
      northside(f).email = "chapter@unrelated.example";
    });
    expect(staged.subunitContacts.some((c) => c.kind === "email")).toBe(false);
    expect(staged.dropReport["prefill.subunit_contacts.email:domain_mismatch"]).toBe(1);
  });

  it("drops a first.last-shaped sub-unit email in prefill mode", () => {
    const staged = prefill((f) => {
      northside(f).email = "robin.example@exampleworkers1.example";
    });
    expect(staged.subunitContacts.some((c) => c.kind === "email")).toBe(false);
    expect(staged.dropReport["prefill.subunit_contacts.email:person_shaped"]).toBe(1);
  });

  it("drops a sub-unit email whose local part carries a listed person's name in prefill mode", () => {
    const staged = prefill((f) => {
      northside(f).email = "casey1@exampleworkers1.example";
    });
    expect(staged.subunitContacts.some((c) => c.kind === "email")).toBe(false);
    expect(staged.dropReport["prefill.subunit_contacts.email:person_name"]).toBe(1);
  });

  it("drops a sub-unit email whose local part carries the part of a listed surname after its apostrophe", () => {
    const staged = prefill((f) => {
      northside(f).leaders[0].name = "Casey O\u2019Ravenfixture";
      northside(f).email = "ravenfixture@exampleworkers1.example";
    });
    expect(staged.subunitContacts.some((c) => c.kind === "email")).toBe(false);
    expect(staged.dropReport["prefill.subunit_contacts.email:person_name"]).toBe(1);
  });
});

describe("F8: free-text gates", () => {
  it("drops and counts a free-text value that carries an email address", () => {
    const out = run((f) => {
      local(f).structureNote = "Write to the office at info@exampleworkers1.example for details.";
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
    expect(out.dropReport["organizations.structure_note:contact_pattern"]).toBe(1);
  });

  it("drops and counts a free-text value that carries a phone number", () => {
    const out = run((f) => {
      northside(f).location = "Exampleville, call 802-555-0177";
    });
    expect(subunitsOf(out).find((s) => s.name === "Northside Chapter").location).toBeNull();
    expect(out.dropReport["subunits.location:contact_pattern"]).toBe(1);
  });

  it("drops only the sentence with election-result wording", () => {
    const out = run((f) => {
      local(f).structureNote = "The local has four chapters. Its slate was re-elected unopposed in 2025.";
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBe("The local has four chapters.");
    expect(out.dropReport["organizations.structure_note:election_sentence"]).toBe(1);
  });

  it("drops a sub-unit whose name carries election-result wording", () => {
    const out = run((f) => {
      local(f).subunits[1].name = "Retirees (newly elected board)";
    });
    expect(subunitsOf(out).map((s) => s.name)).toEqual(["Northside Chapter"]);
    expect(out.dropReport["subunits.name:election_wording"]).toBe(1);
    expect(out.dropReport["subunits:name_unusable"]).toBe(1);
  });

  it("never exports the election cycle as text, only its cadence", () => {
    const out = run();
    const org = out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local);
    expect(org).toMatchObject({ election_term_years: 3, next_election_on: "2027-06-01" });
    expect(serialized(out)).not.toContain("sentinel-cycle");
  });

  it("aborts when an exported string outside a contact value carries an email or phone pattern", () => {
    const { release } = run();
    const leaked = structuredClone(release);
    leaked.subunits[0].employer = "Example County, 802-555-0178";
    let message = "";
    try {
      assertReleasePrivacy(leaked);
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/F8 privacy gate: subunits\.employer of olms-900000001~chapter-/);
    expect(message).not.toContain("802-555-0178");
    const contactValue = structuredClone(release);
    expect(() => assertReleasePrivacy(contactValue)).not.toThrow();
  });

  it("does not mistake a URL-encoded contract term for a phone number", () => {
    expect(containsContactPattern("https://example.org/files/Master%20Contract%202023-2027.pdf", { url: true })).toBe(false);
    expect(containsContactPattern("https://example.org/call-802-555-0100", { url: true })).toBe(true);
  });

  // Phone boundaries: only a neighbouring digit disqualifies a match.
  it.each([
    ["a directory slug", "https://directory.example/business/Example-Workers-Local-1234-802-555-0100"],
    ["a numbered-body slug", "https://directory.example/business/Example-Joint-Council-No-12-802-555-0100"],
    ["a trailing -2 slug", "https://directory.example/listing/802-555-0100-2"],
    ["a word-glued slug", "https://directory.example/call-802-555-0100-today"],
  ])("finds a phone number in %s", (_label, url) => {
    expect(containsContactPattern(url, { url: true })).toBe(true);
  });

  it.each([
    ["a glued x extension", "Call 802-555-0100x12"],
    ["an -ext suffix", "802-555-0100-ext 4"],
    ["a p. prefix", "p.802.555.0100"],
    ["a Ph. prefix", "Ph.802-555-0100"],
    ["a hyphen after the parenthesized area code", "(802)-555-0100"],
    ["a parenthesized area code and an extension", "(802)555-0100x3"],
    ["a prefixed bare run", "p.8025550100"],
    ["a bare run with an extension", "8025550100x12"],
    ["a slash after the area code", "Call 802/555-0100"],
    ["en dashes", "Call 802–555–0100"],
    ["non-breaking hyphens", "802‑555‑0100"],
    ["minus signs", "802−555−0100"],
    ["a spaced en dash", "802 \u2013 555 \u2013 0100"],
    ["spaced hyphens", "802 - 555 - 0100"],
    ["slashes in every position", "802/555/0100"],
    ["a slash after the parenthesized area code", "(802)/555-0100"],
    ["doubled hyphens", "802--555--0100"],
    ["fullwidth solidi", "802\uFF0F555\uFF0F0100"],
    ["a spaced slash after the area code", "office 802 / 555-0173"],
  ])("finds a phone number written with %s", (_label, value) => {
    expect(containsContactPattern(value)).toBe(true);
  });

  it("does not mistake a longer digit run or a slash-separated id for a phone number", () => {
    expect(containsContactPattern("Contract 2019-555-0100")).toBe(false);
    expect(containsContactPattern("Ref 1/234/567/8901/2345")).toBe(false);
    expect(containsContactPattern("Master Contract 2023-2027")).toBe(false);
    expect(containsContactPattern("Order 123456789012")).toBe(false);
    expect(containsContactPattern("Building 12345, 67890 Fixture Way")).toBe(false);
    expect(containsContactPattern("Phone/Fax: 802-555-0100/802-555-0101")).toBe(true);
  });

  it("drops a free-text phone with spaced or slash separators, and the final gate refuses one planted after the filter", () => {
    const out = run((f) => {
      northside(f).location = "office 802 \u2013 555 \u2013 0170";
      northside(f).employer = "Example County, 802/555/0172";
    });
    expect(subunitsOf(out).find((s) => s.name === "Northside Chapter")).toMatchObject({ location: null, employer: null });
    expect(out.dropReport["subunits.location:contact_pattern"]).toBe(1);
    expect(out.dropReport["subunits.employer:contact_pattern"]).toBe(1);
    const { release } = run();
    const planted = structuredClone(release);
    planted.subunits[0].location = "office (802)/555 - 0174";
    expect(() => assertReleasePrivacy(planted)).toThrow(/F8 privacy gate: subunits\.location/);
  });

  it("drops a slug, extension or prefix phone from free text and URLs, and the final gate refuses one planted after the filter", () => {
    const out = run((f) => {
      northside(f).location = "Office line 802-555-0177x12";
      northside(f).employer = "Example County, Ph.802/555-0178";
      local(f).sources.push("https://directory.example/business/Example-Workers-Local-1234-802-555-0179");
    });
    const northsideRow = subunitsOf(out).find((s) => s.name === "Northside Chapter");
    expect(northsideRow).toMatchObject({ location: null, employer: null });
    expect(out.dropReport["subunits.location:contact_pattern"]).toBe(1);
    expect(out.dropReport["subunits.employer:contact_pattern"]).toBe(1);
    expect(out.dropReport["organizations.source_urls:contact_pattern"]).toBe(1);
    expect(serialized(out)).not.toContain("555-017");

    const { release } = run();
    const url = structuredClone(release);
    url.organizations.find((o) => o.catalog_key === OLMS_KEY.local).source_urls.push("https://directory.example/listing/802-555-0100-2");
    expect(() => assertReleasePrivacy(url)).toThrow(/F8 privacy gate: organizations\.source_urls of olms-900000001/);
    const text = structuredClone(release);
    text.subunits[0].location = "Call 802-555-0100x12";
    expect(() => assertReleasePrivacy(text)).toThrow(/F8 privacy gate: subunits\.location/);
  });

  // E.164 and unseparated +1 numbers.
  it("finds a +1 number with no separators and an E.164 number in free text", () => {
    for (const value of ["+18025550177", "18025550177", "+1-8025550177", "call +1 8025550177"]) {
      expect(containsContactPattern(value)).toBe(true);
    }
    // The international example uses the UK range reserved for drama (fictional).
    expect(containsContactPattern("Overseas office +44 20 7946 0958")).toBe(true);
    for (const value of ["+1(802)5550177", "+1 (617) 5550100", "+44\u201320\u20137946\u20130958", "+44 (0)20 7946 0958", "+44 20/7946/0958"]) {
      expect(containsContactPattern(value)).toBe(true);
    }
  });

  it("finds a +1 number in a URL, raw or percent-encoded, and leaves an 11-digit document id alone", () => {
    expect(containsContactPattern("https://directory.example/c/%2B18025550177", { url: true })).toBe(true);
    expect(containsContactPattern("https://directory.example/c/+18025550177", { url: true })).toBe(true);
    expect(containsContactPattern("https://directory.example/c/%EF%BC%8B18025550177", { url: true })).toBe(true);
    // E.164 and separated +1 numbers, percent-encoded or with a raw plus.
    for (const url of [
      "https://exampleworkers1.example/chapters?callback=%2B442079460958",
      "https://exampleworkers1.example/chapters/%2B1-802-5550177",
      "https://exampleworkers1.example/chapters?p=%2B1%20802%205550177",
      "https://exampleworkers1.example/chapters?p=+442079460958",
    ]) {
      expect(containsContactPattern(url, { url: true })).toBe(true);
    }
    expect(containsContactPattern("https://exampleworkers1.example/files/17000000001.pdf", { url: true })).toBe(false);
  });

  it("drops a structure note that carries a +1 number with no separators", () => {
    const out = run((f) => {
      local(f).structureNote = "The hall line is +18025550177.";
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
    expect(out.dropReport["organizations.structure_note:contact_pattern"]).toBe(1);
    const parenthesized = run((f) => {
      local(f).structureNote = "The hall line is +1(802)5550177.";
      northside(f).source = "https://exampleworkers1.example/chapters?callback=%2B442079460958";
    });
    expect(parenthesized.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
    expect(parenthesized.dropReport["organizations.structure_note:contact_pattern"]).toBe(1);
    expect(parenthesized.dropReport["subunits.source_url:contact_pattern"]).toBe(1);
    expect(serialized(parenthesized)).not.toContain("442079460958");
  });

  // A valid North American number that fills a whole URL token is a phone;
  // a document id glued with "_" or ".", or one that is not NANP-valid, is not.
  it("finds a ten-digit phone number that fills a URL path segment, hyphen token or query value", () => {
    for (const url of [
      "https://exampleworkers1.example/workplaces/8025550177",
      "https://exampleworkers1.example/workplaces/8025550177-2",
      "https://exampleworkers1.example/workplaces?id=8025550177",
      "https://exampleworkers1.example/workplaces/18025550177/",
      // Any RFC 3986 sub-delimiter bounds the number.
      "https://exampleworkers1.example/workplaces/8025550177;jsessionid=abc",
      "https://exampleworkers1.example/workplaces?ids=8025550177,8025550178",
      "https://exampleworkers1.example/workplaces:8025550177",
      "https://exampleworkers1.example/workplaces?a=1&ids=8025550177!",
    ]) {
      expect(containsContactPattern(url, { url: true })).toBe(true);
    }
    for (const url of [
      "https://exampleworkers1.example/files/1700000000",
      "https://exampleworkers1.example/files/doc_8025550177.pdf",
      "https://exampleworkers1.example/files/8025550177.pdf",
    ]) {
      expect(containsContactPattern(url, { url: true })).toBe(false);
    }
  });

  it("drops a seat whose only source is a URL keyed by a phone number, and counts it", () => {
    const out = run((f) => {
      northside(f).board[0].source = "https://exampleworkers1.example/workplaces/8025550177";
    });
    expect(out.release.seat_outlines.find((s) => s.seat_class === "board")).toMatchObject({ listed: 1, vacant: 1 });
    expect(out.dropReport["seat_outlines.source_url:contact_pattern"]).toBe(1);
    expect(out.dropReport["seat_outlines:own_source_unusable"]).toBe(1);
    expect(serialized(out)).not.toContain("8025550177");
  });

  // Invisible format characters and fullwidth forms cannot disguise a contact.
  it.each([
    ["a zero-width space in an email", "avery​@exampleworkers1.example"],
    ["a soft hyphen in an email", "avery­@exampleworkers1.example"],
    ["a bidi override in an email", "avery‮@exampleworkers1.example"],
    ["a fullwidth at sign", "avery＠exampleworkers1.example"],
    ["zero-width spaces in a phone number", "802​555​0177"],
    ["a word joiner in a phone number", "802⁠-555-0177"],
    ["fullwidth digits", "８０２-５５５-０１７７"],
    ["a variation selector in an email", "avery\uFE0F@exampleworkers1.example"],
    ["a combining grapheme joiner in a phone number", "802\u034F-555-0177"],
    ["a Hangul filler in an email", "avery\u3164@exampleworkers1.example"],
  ])("finds a contact disguised with %s", (_label, value) => {
    expect(containsContactPattern(value)).toBe(true);
    expect(containsContactPattern(`https://directory.example/p/${encodeURIComponent(value)}`, { url: true })).toBe(true);
  });

  it("drops a free-text value with a disguised contact or a bidi control, and the final gate refuses one planted after the filter", () => {
    const out = run((f) => {
      northside(f).employer = "Example County, avery​@exampleworkers1.example";
      northside(f).location = "Exampleville ⁦north⁩";
    });
    expect(subunitsOf(out).find((s) => s.name === "Northside Chapter")).toMatchObject({ employer: null, location: null });
    expect(out.dropReport["subunits.employer:contact_pattern"]).toBe(1);
    expect(out.dropReport["subunits.location:control_character"]).toBe(1);

    const { release } = run();
    const planted = structuredClone(release);
    planted.subunits[0].employer = "Example County, 802​555​0177";
    expect(() => assertReleasePrivacy(planted)).toThrow(/F8 privacy gate: subunits\.employer/);
  });

  // Folding must never hide what the value as written shows: a superscript
  // or circled digit folds to a plain digit, and an invisible character
  // between a number and a digit vanishes; either would glue onto the number.
  it.each([
    ["a superscript two", "Office 802-555-0177\u00B2"],
    ["a superscript one", "802-555-0177\u00B9"],
    ["a circled digit", "802-555-0177\u2460"],
    ["a digit before it across a zero-width space", "9\u200B802-555-0177"],
    ["digits after it across a zero-width space", "802-555-0177\u200B12"],
    ["a digit after it across an Arabic end-of-ayah mark", "802-555-0177\u06DD7"],
  ])("still finds a phone number followed or preceded by %s", (_label, value) => {
    expect(containsContactPattern(value)).toBe(true);
    expect(containsContactPattern(`https://directory.example/p/${encodeURIComponent(value)}`, { url: true })).toBe(true);
  });

  it("drops a phone with a folding neighbour from free text and URLs, and the final gate refuses one planted after the filter", () => {
    const out = run((f) => {
      northside(f).location = "Office 802-555-0177\u00B2";
      northside(f).employer = "Example County, 802-555-0177\u00B9";
      local(f).sources.push("https://directory.example/p/802-555-0177\u00B2");
    });
    expect(subunitsOf(out).find((s) => s.name === "Northside Chapter")).toMatchObject({ location: null, employer: null });
    expect(out.dropReport["subunits.location:contact_pattern"]).toBe(1);
    expect(out.dropReport["subunits.employer:contact_pattern"]).toBe(1);
    expect(out.dropReport["organizations.source_urls:contact_pattern"]).toBe(1);
    expect(serialized(out)).not.toContain("555-0177");

    const { release } = run();
    const text = structuredClone(release);
    text.subunits[0].location = "Office 802-555-0177\u00B2";
    expect(() => assertReleasePrivacy(text)).toThrow(/F8 privacy gate: subunits\.location/);
    const url = structuredClone(release);
    url.organizations.find((o) => o.catalog_key === OLMS_KEY.local).source_urls.push("https://directory.example/p/802-555-0177%C2%B2");
    expect(() => assertReleasePrivacy(url)).toThrow(/F8 privacy gate: organizations\.source_urls/);
    const glued = structuredClone(release);
    glued.subunits[0].employer = "Example County, 802-555-0177\u200B12";
    expect(() => assertReleasePrivacy(glued)).toThrow(/F8 privacy gate: subunits\.employer/);
  });

  // Percent escapes are decoded run by run, so one malformed escape never
  // leaves the rest of a URL encoded.
  it("finds a contact in a URL that also carries a malformed percent escape", () => {
    expect(containsContactPattern("https://exampleworkers1.example/workplaces/%38025550100?q=%ZZ", { url: true })).toBe(true);
    expect(containsContactPattern("https://directory.example/100%zz/call-802%E2%80%8B-555-0179", { url: true })).toBe(true);
    expect(containsContactPattern("https://directory.example/p/802-555-0179?rev=5%", { url: true })).toBe(true);
    expect(containsContactPattern("https://exampleworkers1.example/files/%zz/guide.pdf", { url: true })).toBe(false);
    const out = run((f) => {
      local(f).sources.push("https://directory.example/100%zz/call-802%E2%80%8B-555-0179");
    });
    expect(out.dropReport["organizations.source_urls:contact_pattern"]).toBe(1);
    expect(serialized(out)).not.toContain("555-0179");
    const { release } = run();
    const planted = structuredClone(release);
    planted.organizations.find((o) => o.catalog_key === OLMS_KEY.local).source_urls.push("https://exampleworkers1.example/workplaces/%38025550100?q=%ZZ");
    expect(() => assertReleasePrivacy(planted)).toThrow(/F8 privacy gate: organizations\.source_urls/);
  });

  it("checks every contact value except phone and email numbers and mailboxes", () => {
    const { release } = run();
    const contact = (kind) => release.contacts.find((c) => c.catalog_key === OLMS_KEY.local && c.contact_kind === kind);
    const address = structuredClone(release);
    address.contacts.find((c) => c.contact_key === contact("office_address").contact_key).value = "1 Fixture Way, 802-555-0101";
    expect(() => assertReleasePrivacy(address)).toThrow(/F8 privacy gate: contacts\.value/);
    const social = structuredClone(release);
    social.contacts.find((c) => c.contact_key === contact("social").contact_key).value = "https://social.example/802-555-0100-2";
    expect(() => assertReleasePrivacy(social)).toThrow(/F8 privacy gate: contacts\.value/);
    expect(contact("phone")).toBeDefined();
    expect(contact("email")).toBeDefined();
    expect(() => assertReleasePrivacy(release)).not.toThrow();
  });

  // One name-scrub regression per exported free-text field (§2.5 F8).
  const NAME = PEOPLE.president;
  const cases = [
    ["organizations.structure_note", (f) => { local(f).structureNote = `Led by ${NAME} since 2020.`; }],
    ["subunits.name", (f) => { local(f).subunits[1].name = `${NAME} Retirees`; }],
    ["subunits.location", (f) => { northside(f).location = `Zone 3 ; zone director ${NAME}`; }],
    ["subunits.employer", (f) => { northside(f).employer = `${NAME} Consulting`; }],
    ["subunits.kind_label", (f) => { northside(f).kind = `${NAME} unit`; }],
    ["subunits.members_source", (f) => { northside(f).membersSource = `Per ${NAME}, 2025`; }],
    ["subunits.density_note", (f) => { northside(f).density = `Estimated by ${NAME}`; }],
    ["subunits.election_note", (f) => { northside(f).electionDate = `${NAME} serves until 2027`; }],
    ["subunits.structure_note", (f) => { northside(f).structureNote = `${NAME} coordinates the chapter.`; }],
    ["edges.parent_label", (f) => { local(f).parentBodies[0].name = `${NAME} Council`; }],
    ["documents.title", (f) => { f.documents[1].title = `Letter from ${NAME}`; }],
  ];
  it.each(cases)("scrubs a same-record person name from %s", (path, mutate) => {
    const out = run(mutate);
    expect(out.dropReport[`${path}:person_name`]).toBe(1);
    expect(serialized(out)).not.toContain("fixtureperson");
  });

  // A listed name is also read split at its apostrophe; the exclusion list
  // holds only hashes of the joined form, so this shape is F8's alone.
  it.each([...NAME_SHAPES, ["the apostrophe written as a space", "O'Fixtureperson", "O Fixtureperson"]])("scrubs a same-record person name written with %s", (_label, listed, written) => {
    const out = run((f) => {
      northside(f).staff[0].name = `Finley ${listed}`;
      local(f).structureNote = `Minutes by Finley ${written}.`;
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
    expect(out.dropReport["organizations.structure_note:person_name"]).toBe(1);
  });

  it.each(UNLISTED_SHAPES)("scrubs a same-record person name written with %s from a note, a title and a URL", (_label, listed, written) => {
    const out = run((f) => {
      northside(f).staff[0].name = `Finley ${listed}`;
      local(f).structureNote = `Minutes by Finley ${written}.`;
      f.documents[1].title = `Letter from Finley ${written}.`;
      f.documents[2].url = `https://exampleworkers1.example/files/${encodeURIComponent(`Finley ${written} letter`)}.pdf`;
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
    expect(out.release.documents.find((d) => d.url.endsWith("/files/bylaws.pdf"))).toMatchObject({ title_derived: true });
    expect(out.release.documents.some((d) => d.url.includes("letter.pdf"))).toBe(false);
  });

  it.each(NAME_CONTROLS)("still exports text that does not name %s", (listed, note) => {
    const out = run((f) => {
      northside(f).staff[0].name = listed;
      local(f).structureNote = note;
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBe(note);
  });

  it.each(SHORT_NAME_CONTROLS)("still exports ordinary text when %s is listed in the same record: %s", (listed, value) => {
    const out = run((f) => {
      northside(f).staff[0].name = listed;
      placeInAllThreeFields(f, value);
    });
    expectAllThreeExported(out, value);
  });

  // Intended: "Jo'Ann" is how a person named Jo Ann may write the name, and a
  // business named after a listed person is dropped like any other text that
  // carries the name ("Avery Fixtureperson Consulting" above).
  it("drops a business name that carries a listed name written with an apostrophe between its parts", () => {
    const out = run((f) => {
      northside(f).staff[0].name = "Jo Ann";
      local(f).structureNote = "Jo'Ann's Craft Cooperative publishes a handbook.";
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
  });

  it("scrubs a same-record name hidden by a U+FEFF from a sub-unit kind label and an office address", () => {
    const out = run((f) => {
      northside(f).kind = "Finley Fixture\uFEFFperson unit";
      local(f).offices[0].address = "1 Fixture Way, care of Finley Fixture\uFEFFperson";
    });
    expect(out.dropReport["subunits.kind_label:person_name"]).toBe(1);
    expect(out.dropReport["contacts.office_address:person_name"]).toBe(1);
    expect(serialized(out)).not.toContain("fixture person");
  });
});

describe("F9: the exclusion list", () => {
  // Literal canonical strings from Main's recipe, never the current tokenizer.
  const mainRecipe = [
    ["Avery Qøll", "avery q ll"], ["Avery Qłll", "avery q ll"],
    ["Avery Qđll", "avery q ll"], ["Avery Qæll", "avery q ll"],
    ["Avery Qœll", "avery q ll"], ["Avery Qßll", "avery q ll"],
    ["Avery Qþll", "avery q ll"], ["Avery Qðll", "avery q ll"],
    ["Søren Þorn", "s ren orn"],
  ];
  const hashCanonical = (canonical) => createHash("sha256").update(`${TEST_SALT}\u0000${canonical}`).digest("hex");
  describe.each(["plain", "hyphenated", "upper-case", "possessive", "URL"])("Main-recipe hashes: %s", (form) => {
    it.each(mainRecipe)("still holds %s hashed literally as %s", (name, canonical) => {
      const written = form === "hyphenated" ? name.replaceAll(" ", "-")
        : form === "upper-case" ? name.replaceAll("ß", "ẞ").toUpperCase()
          : form === "possessive" ? `${name}'s`
            : form === "URL" ? `https://social.example/${encodeURIComponent(name.replaceAll(" ", "-"))}` : name;
      const list = parseExclusionList({ schema: "catalog-exclusions/1", salt: TEST_SALT, hashes: [hashCanonical(canonical)] });
      expect(exclusionCandidates(written).has(canonical)).toBe(true);
      expect(new ExclusionMatcher(list).matches(written)).toBe(true);
    });
  });
  it.each(mainRecipe)("keeps Main's hash when generating hashes for %s", (name, canonical) => {
    expect(nameTokens(name).join(" ")).toBe(canonical);
    expect(exclusionHashes(TEST_SALT, name)).toContain(hashCanonical(canonical));
  });
  it.each(mainRecipe.slice(0, 8))("keeps Main's full-name, detection and handle readings of %s", (name, canonical) => {
    const people = new RecordPeople();
    people.addName(name);
    expect(people.containsName(canonical)).toBe(true);
    expect(people.handleNamesPerson(`https://social.example/${canonical.replaceAll(" ", "")}`)).toBe(true);
    expect(detectionRuns(name)).toContain("avery qll");
    const short = createShortNameMatcher({ leaders: [{ name: `${name} Fixtureperson` }] });
    expect(short(canonical)).toBe(true);
    expect(short("q ll avery")).toBe(true);
  });
  it("keeps Main's apostrophe-separated local-part segments", () => {
    const people = new RecordPeople();
    people.addName("Avery Ray");
    expect(people.localPartNamesPerson("o'ray")).toBe(true);
    expect(people.localPartNamesPerson("ray7")).toBe(true);
  });

  it("refuses to run without an exclusion list", () => {
    expect(() => run(() => {}, { exclusions: undefined })).toThrow(/F9: an exclusion list is required/);
  });

  it("refuses a malformed exclusion list", () => {
    expect(() => parseExclusionList("not json")).toThrow(/F9/);
    expect(() => parseExclusionList(JSON.stringify({ schema: "catalog-exclusions/1", salt: "short", hashes: [] }))).toThrow(/F9: .*salt/);
    expect(() => parseExclusionList(JSON.stringify({ schema: "catalog-exclusions/1", salt: "test-salt-0123456789", hashes: ["ABC"] }))).toThrow(/F9: .*hash/);
  });

  it("drops a value whose word run matches a synthetic hash and reports only a count", () => {
    const out = run(() => {}, { exclusions: exclusionList(["northside chapter"]) });
    expect(subunitsOf(out).map((s) => s.name)).toEqual(["Retirees"]);
    expect(out.exclusionMatches).toBeGreaterThan(0);
    expect(JSON.stringify(out.dropReport)).not.toContain("northside");
  });

  it("matches a URL fragment against the host and path prefixes", () => {
    const out = run(() => {}, { exclusions: exclusionList(["testfamily.example/files"]) });
    expect(out.release.documents.some((d) => d.url.includes("shared-guide"))).toBe(false);
  });

  it("drops an organization whose name matches, with every row that depends on it", () => {
    const out = run(() => {}, { exclusions: exclusionList(["example state council"]) });
    expect(out.release.organizations.some((o) => o.catalog_key === OLMS_KEY.stateBody)).toBe(false);
    expect(out.release.edges.some((e) => e.parent_key === OLMS_KEY.stateBody || e.child_key === OLMS_KEY.stateBody)).toBe(false);
  });

  it("hashes a list entry in both canonical forms of the owner's recipe", () => {
    const hashes = exclusionHashes(TEST_SALT, "Robin O'Fixtureperson");
    expect(hashes).toEqual([
      exclusionHash(TEST_SALT, "Robin O'Fixtureperson"),
      sha256Hex(`${TEST_SALT}\u0000robin ofixtureperson`),
    ]);
    expect(hashes[0]).toBe(sha256Hex(`${TEST_SALT}\u0000robin o'fixtureperson`));
    // An entry whose two forms agree yields one hash.
    expect(exclusionHashes(TEST_SALT, "northside chapter")).toEqual([exclusionHash(TEST_SALT, "northside chapter")]);
  });

  // The November 13, 2026 repair added apostrophe-like characters to the
  // name-token form. An entry written only with the characters handled before
  // it keeps its hashes and its directory-listed body key, so the owner's list
  // and the loaded directory bodies need no rehash. The pins were computed on
  // Main 5921a3412b, before the repair.
  const HANDLED_NAMES = [
    ["Robin O'Fixtureperson", "robin ofixtureperson"],
    ["Robin O\u2019Fixtureperson", "robin ofixtureperson"],
    ["Robin O\u2018Fixtureperson", "robin ofixtureperson"],
    ["Robin O\u02BCFixtureperson", "robin ofixtureperson"],
    ["Robin O\u00B4Fixtureperson", "robin ofixtureperson"],
    ["Robin O\u2032Fixtureperson", "robin ofixtureperson"],
    ["Robin O`Fixtureperson", "robin ofixtureperson"],
    ["Zo\u00EB D'Fixtureperson-Example", "zoe dfixtureperson example"],
    ["Workers' Council of Example County", "workers council of example county"],
    ["Example Nurses\u2019 Association Local 12", "example nurses association local 12"],
  ];
  it("keeps the hashes and directory keys of names written only with the characters handled before the repair", () => {
    for (const [entry, tokens] of HANDLED_NAMES) {
      expect(exclusionHashes(TEST_SALT, entry)).toContain(sha256Hex(`${TEST_SALT}\u0000${tokens}`));
    }
    const all = HANDLED_NAMES.flatMap(([entry]) => exclusionHashes(TEST_SALT, entry));
    expect(sha256Hex(all.join("\n"))).toBe("60df8bddc00e156608cf82b59ceb9a065e4c86e443c8129df9931bf5e8247325");
    expect(HANDLED_NAMES.map(([entry]) => directoryBodyKey(12345, entry))).toEqual([
      ...Array(7).fill("ug-d2a49a5fd8"), "ug-dc2ef43d61", "ug-db05563775", "ug-d9fa72cea9",
    ]);
  });

  // Names that are not listed in the same record, so only F9 can catch them.
  // Each is placed inside a longer structure note, a document title and a
  // document file name written with %20.
  it.each([
    ["an apostrophe", "Robin O'Fixtureperson", "Robin O'Fixtureperson"],
    ["an apostrophe listed straight and written curly", "Robin O'Fixtureperson", "Robin O’Fixtureperson"],
    ["a precomposed accent", "Zoë Fixtureperson", "Zoë Fixtureperson"],
    ["an accent listed precomposed and written decomposed", "Zoë Fixtureperson", "Zoë Fixtureperson"],
    ["a hyphen", "Robin Fixtureperson-Example", "Robin Fixtureperson-Example"],
    ["a middle initial", "Robin J. Fixtureperson", "Robin J. Fixtureperson"],
    ["an apostrophe listed straight and written as a left single quotation mark", "Robin O'Fixtureperson", "Robin O\u2018Fixtureperson"],
    ["an apostrophe listed straight and written as a modifier letter apostrophe", "Robin O'Fixtureperson", "Robin O\u02BCFixtureperson"],
    ["an apostrophe listed straight and written as an acute accent", "Robin O'Fixtureperson", "Robin O\u00B4Fixtureperson"],
    ["an apostrophe listed straight and written as a prime", "Robin O'Fixtureperson", "Robin O\u2032Fixtureperson"],
  ])("drops a listed name with %s inside longer text and a %%20-encoded URL", (_label, listed, written) => {
    const out = run((f) => {
      local(f).structureNote = `Minutes prepared by ${written}, for the unit.`;
      f.documents[1].title = `Letter from ${written}.`;
      f.documents[2].url = `https://exampleworkers1.example/files/${encodeURIComponent(`${written} letter`)}.pdf`;
    }, { exclusions: exclusionList([listed]) });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
    expect(out.release.documents.find((d) => d.url.endsWith("/files/bylaws.pdf"))).toMatchObject({ title_derived: true });
    expect(out.release.documents.some((d) => d.url.includes("letter.pdf"))).toBe(false);
    expect(out.exclusionMatches).toBeGreaterThanOrEqual(3);
    expect(serialized(out)).not.toContain("fixtureperson");
  });

  it("does not match a longer surname that merely starts with a listed one", () => {
    const out = run((f) => {
      local(f).structureNote = "Minutes prepared by Robin Fixturepersonage, for the unit.";
    }, { exclusions: exclusionList(["Robin Fixtureperson"]) });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBe("Minutes prepared by Robin Fixturepersonage, for the unit.");
  });

  it.each([
    ["a straight possessive", "Robin O'Fixtureperson", "Robin O'Fixtureperson's committee"],
    ["a curly possessive", "Zo\u00EB Fixtureperson", "Zo\u00EB Fixtureperson\u2019s office"],
    ["a plain possessive", "Robin Fixtureperson", "Robin Fixtureperson's report"],
  ])("drops a listed name written as %s", (_label, listed, written) => {
    const out = run((f) => {
      local(f).structureNote = `Minutes prepared by ${written}.`;
      f.documents[1].title = `Notes on ${written}.`;
    }, { exclusions: exclusionList([listed]) });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
    expect(out.release.documents.find((d) => d.url.endsWith("/files/bylaws.pdf"))).toMatchObject({ title_derived: true });
    expect(out.exclusionMatches).toBeGreaterThanOrEqual(2);
    expect(serialized(out)).not.toContain("fixtureperson");
  });

  it.each(NAME_SHAPES)("drops a listed name not in the record written with %s", (_label, listed, written) => {
    const out = run((f) => {
      local(f).structureNote = `Minutes by Robin ${written}.`;
    }, { exclusions: exclusionList([`Robin ${listed}`]) });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
    expect(out.exclusionMatches).toBeGreaterThanOrEqual(1);
  });

  it.each(UNLISTED_SHAPES)("drops a listed name not in the record written with %s from a note, a title and a URL", (_label, listed, written) => {
    const out = run((f) => {
      local(f).structureNote = `Minutes by Robin ${written}.`;
      f.documents[1].title = `Letter from Robin ${written}.`;
      f.documents[2].url = `https://exampleworkers1.example/files/${encodeURIComponent(`Robin ${written} letter`)}.pdf`;
    }, { exclusions: exclusionList([`Robin ${listed}`]) });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
    expect(out.release.documents.find((d) => d.url.endsWith("/files/bylaws.pdf"))).toMatchObject({ title_derived: true });
    expect(out.release.documents.some((d) => d.url.includes("letter.pdf"))).toBe(false);
    expect(out.exclusionMatches).toBeGreaterThanOrEqual(3);
  });

  it.each(NAME_CONTROLS)("keeps text that does not name the listed %s", (listed, note) => {
    const out = run((f) => {
      local(f).structureNote = note;
    }, { exclusions: exclusionList([listed]) });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBe(note);
  });

  it.each(SHORT_NAME_CONTROLS)("keeps ordinary text when %s is on the exclusion list: %s", (listed, value) => {
    const out = run((f) => placeInAllThreeFields(f, value), { exclusions: exclusionList([listed]) });
    expectAllThreeExported(out, value);
  });

  it("drops a listed staff-note holder whose name hides a U+FEFF", () => {
    const staged = prefill((f) => {
      northside(f).leaders[0].name = "Casey Fixture\uFEFFperson";
    }, { exclusions: exclusionList(["Casey Fixtureperson"]) });
    expect(staged.staffNotes.some((n) => /casey/i.test(n.holderName))).toBe(false);
    expect(staged.dropReport["prefill.staff_notes:holder_unusable"]).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["a trailing malformed escape", "Robin O'Fixtureperson", "https://exampleworkers1.example/files/Robin%20O%27Fixtureperson%20letter.pdf?rev=5%"],
    ["a malformed escape in an earlier segment", "Robin O'Fixtureperson", "https://exampleworkers1.example/files/100%zz/Robin%20O%27Fixtureperson%20letter.pdf"],
    ["a Latin-1 escape", "Zo\u00EB Fixtureperson", "https://exampleworkers1.example/files/Zo%EB%20Fixtureperson%20letter.pdf"],
  ])("drops a %%20-encoded listed name from a URL with %s", (_label, listed, url) => {
    const out = run((f) => {
      f.documents[2].url = url;
    }, { exclusions: exclusionList([listed]) });
    expect(out.release.documents.some((d) => d.url.includes("letter.pdf"))).toBe(false);
    expect(out.exclusionMatches).toBeGreaterThanOrEqual(1);
    expect(serialized(out)).not.toContain("fixtureperson");
  });
});

// SEC-UG-CATALOG-PRIVACY-FILTER-LOOK-ALIKE-LETTERS-AND-TWICE-ENCODED-URLS-20261115
//: a listed name written with a Cyrillic or Greek look-alike of one
// of its Latin letters, or inside a URL percent-encoded more than once, is
// held back from a note, a title and a URL on both export paths: the release
// and the organization prefill. Text genuinely in another script still exports.
describe("F8 and F9: look-alike letters and URLs encoded more than once", () => {
  const LOOK_ALIKE_SPELLINGS = [
    ["a Cyrillic small i", "F\u0456xtureperson"],
    ["a Greek small iota", "F\u03B9xtureperson"],
    ["a Cyrillic small o and e", "Fixturep\u0435rs\u043En"],
    ["a Greek capital iota in a name written in capitals", "F\u0399XTUREPERSON"],
    ["a Greek iota with tonos", "F\u03AFxtureperson"],
    // Every script the confusables data
    // reads as a basic Latin letter, and Latin letters outside a-z.
    ["an Armenian small oh", "Fixturepers\u0585n"],
    ["an Armenian small seh", "Fixt\u057Dreperson"],
    ["a Cherokee capital in a name written in capitals", "FIXTUR\u13ACPERSON"],
    ["a Cherokee small letter", "Fixtur\uAB7Cperson"],
    ["a Latin dotless i", "F\u0131xtureperson"],
    ["a Latin small capital i", "F\u026Axtureperson"],
    ["a Latin small capital o", "Fixturepers\u1D0Fn"],
    // F3: a near-invisible Greek mark beside a look-alike is read through.
    ["a Cyrillic o beside a Greek ypogegrammeni", "Fixturepers\u043E\u037An"],
    // Delta review of: every Latin small capital (F2), letters the data
    // reads as a letter with a mark (F3), and read-through characters in a
    // row or without a look-alike (F4).
    ["only Latin small capitals", "\uA730\u026Ax\u1D1B\u1D1C\u0280\u1D07\u1D18\u1D07\u0280\uA731\u1D0F\u0274"],
    ["one Latin small capital inside a lowercase word", "Fixtu\u0280eperson"],
    ["a Greek small eta", "Fixturepers\u03BF\u03B7"],
    ["a Greek small theta", "Fixturepers\u03B8n"],
    ["a Latin eng", "Fixturepers\u043E\u014B"],
    ["two Cyrillic payeroks beside a look-alike", "F\u0456xture\uA67F\uA67Fperson"],
    ["two Cyrillic payeroks", "Fixture\uA67F\uA67Fperson"],
    ["a Greek ypogegrammeni alone", "Fixturepers\u037Aon"],
  ];
  // F1 of the delta review: a letter the data reads as "l" is read as I and as l.
  const L_LOOK_ALIKES = [
    ["a Cyrillic capital palochka for l", "Iris Qui\u04C0l"],
    ["two Byelorussian-Ukrainian capital I for l", "Iris Qui\u0406\u0406"],
    ["a Greek capital iota for l", "Iris Qui\u0399l"],
    ["a Cyrillic small palochka for a capital I", "\u04CFris Quill"],
    ["an Arabic alef for a capital I", "\u0627ris Quill"],
  ];
  // F1: the letter-category apostrophes the filter reads do not stop the fold.
  const APOSTROPHE_LOOK_ALIKES = ["\u02BC", "\u02B9", "\u02BB", "\u02BD", "\u02BE", "\u2019", "'"]
    .map((mark) => [`U+${mark.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`, `Robin O${mark}Qu\u0456ll`]);
  const BUILDS = [
    ["the release", (mutate, overrides) => run(mutate, overrides).release],
    ["the prefill", (mutate, overrides) => prefill(mutate, overrides)],
  ];
  const noteOf = (built) => built.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note;
  const bylawsOf = (built) => built.documents.find((d) => d.url.endsWith("/files/bylaws.pdf"));
  const letterKept = (built) => built.documents.some((d) => d.url.includes("letter.pdf"));
  const place = (f, written, url = `https://exampleworkers1.example/files/${encodeURIComponent(`${written} letter`)}.pdf`) => {
    local(f).structureNote = `Minutes prepared by ${written}, for the unit.`;
    f.documents[1].title = `Letter from ${written}.`;
    f.documents[2].url = url;
  };

  describe.each(BUILDS)("on %s", (_build, build) => {
    it.each(LOOK_ALIKE_SPELLINGS)("holds back an excluded name written with %s", (_label, surname) => {
      const built = build((f) => place(f, `Robin ${surname}`), { exclusions: exclusionList(["Robin Fixtureperson"]) });
      expect(noteOf(built)).toBeNull();
      expect(bylawsOf(built)).toMatchObject({ title_derived: true });
      expect(letterKept(built)).toBe(false);
    });

    it.each(APOSTROPHE_LOOK_ALIKES)("holds back an excluded apostrophe name written with %s and a Cyrillic small i", (_label, written) => {
      const built = build((f) => place(f, written), { exclusions: exclusionList(["Robin O'Quill"]) });
      expect(noteOf(built)).toBeNull();
      expect(bylawsOf(built)).toMatchObject({ title_derived: true });
      expect(letterKept(built)).toBe(false);
    });

    it.each(L_LOOK_ALIKES)("holds back an excluded name written with %s", (_label, written) => {
      const built = build((f) => place(f, written), { exclusions: exclusionList(["Iris Quill"]) });
      expect(noteOf(built)).toBeNull();
      expect(bylawsOf(built)).toMatchObject({ title_derived: true });
      expect(letterKept(built)).toBe(false);
    });

    it.each(LOOK_ALIKE_SPELLINGS)("holds back a name listed in the record written with %s", (_label, surname) => {
      const built = build((f) => place(f, `Avery ${surname}`));
      expect(noteOf(built)).toBeNull();
      expect(bylawsOf(built)).toMatchObject({ title_derived: true });
      expect(letterKept(built)).toBe(false);
    });

    it.each([2, 3, 8])("holds back a listed and an excluded name inside a URL percent-encoded %i times", (times) => {
      const encoded = (value) => Array.from({ length: times }).reduce((v) => encodeURIComponent(v), value);
      for (const [written, overrides] of [["Robin Fixtureperson", { exclusions: exclusionList(["Robin Fixtureperson"]) }], [PEOPLE.president, {}]]) {
        const built = build((f) => {
          f.documents[2].url = `https://exampleworkers1.example/files/${encoded(`${written} letter`)}.pdf`;
        }, overrides);
        expect(letterKept(built)).toBe(false);
      }
    });

    it("drops a URL still encoded after every decoding pass", () => {
      const encoded = Array.from({ length: 12 }).reduce((v) => encodeURIComponent(v), "Quarterly letter");
      const built = build((f) => {
        f.documents[2].url = `https://exampleworkers1.example/files/${encoded}.pdf`;
      });
      expect(letterKept(built)).toBe(false);
    });

    it.each([
      ["Greek", "\u0397 \u03B3\u03B5\u03BD\u03B9\u03BA\u03AE \u03C3\u03C5\u03BD\u03AD\u03BB\u03B5\u03C5\u03C3\u03B7 \u03C4\u03B7\u03C2 \u039A\u03B1\u03B9 \u039F\u03BC\u03AC\u03B4\u03B1\u03C2."],
      ["Cyrillic", "\u041E\u0431\u0449\u0435\u0435 \u0441\u043E\u0431\u0440\u0430\u043D\u0438\u0435 \u0447\u043B\u0435\u043D\u043E\u0432 \u0410\u0432\u0435\u0440\u0438 \u0432 \u041A\u0438\u0435\u0432\u0435."],
      ["Armenian", "\u0540\u0561\u0575\u0561\u057D\u057F\u0561\u0576\u056B \u0561\u0577\u056D\u0561\u057F\u0578\u0572\u0576\u0565\u0580\u056B \u0570\u0561\u0576\u0564\u056B\u057A\u0578\u0582\u0574\u0589"],
      ["Cherokee", "\u13E3\u13B3\u13A9 \u13A0\u13CD\u13A6\u13EF \u13A4\u13C2\u13EA\u13AF\u13CD\u13D7."],
    ])("keeps text genuinely written in %s that names no one listed", (_script, value) => {
      const built = build((f) => {
        local(f).structureNote = value;
        f.documents[1].title = value;
        f.documents[2].url = `https://exampleworkers1.example/files/${encodeURIComponent(value)}-letter.pdf`;
      }, { exclusions: exclusionList(["Robin Fixtureperson"]) });
      expect(noteOf(built)).toBe(value);
      expect(bylawsOf(built)).toMatchObject({ title: value, title_derived: false });
      expect(letterKept(built)).toBe(true);
    });
  });

  it("reads every row of the look-alike table as its Latin letter inside a Latin word", () => {
    expect(LOOK_ALIKE_LETTERS.size).toBeGreaterThan(400);
    for (const [letter, latin] of LOOK_ALIKE_LETTERS) {
      expect(latin, letter).toMatch(/^[A-Za-z]$/u);
      expect(foldLookAlikes(`ab${letter}cd`), `U+${letter.codePointAt(0).toString(16)}`).toBe(`ab${latin}cd`);
    }
  });

  it("leaves Latin text and words genuinely in another script exactly as written", () => {
    for (const value of ["Zo\u00EB O\u00B4Brien", "Stra\u00DFe", "O\u02BCBrien", "\u03BB\u03CC\u03B3\u03BF\u03C2", "\u041F\u0435\u0442\u0440", "\u0540\u0561\u0575\u0561\u057D\u057F\u0561\u0576", "\u13E3\u13B3\u13A9"]) {
      expect(foldLookAlikes(value)).toBe(value);
    }
    // A Latin letter with a stroke the data reads as its base letter is read so too.
    expect(foldLookAlikes("\u0141\u00F3d\u017A")).toBe("Lodz");
  });

  it("counts the over-encoded URL it drops", () => {
    const encoded = Array.from({ length: 12 }).reduce((v) => encodeURIComponent(v), "Quarterly letter");
    const out = run((f) => {
      f.documents[2].url = `https://exampleworkers1.example/files/${encoded}.pdf`;
    });
    expect(out.dropReport["documents.url:over_encoded"]).toBe(1);
  });
});

// Look-alikes outside the Unicode letter data, read
// for the exclusion list (F9) only. Invented names throughout.
describe("F9: digits, a capital I and mixed palochkas read as letters", () => {
  const BUILDS = [
    ["the release", (mutate, overrides) => run(mutate, overrides).release],
    ["the prefill", (mutate, overrides) => prefill(mutate, overrides)],
  ];
  const noteOf = (built) => built.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note;
  const place = (f, written) => {
    local(f).structureNote = `Minutes prepared by ${written}, for the unit.`;
  };
  const HELD_BACK = [
    ["(a) a digit 1 for i", "Robin Fixtureperson", "Robin F1xtureperson"],
    ["(a) a digit 0 for o", "Robin Fixtureperson", "Robin Fixturepers0n"],
    ["(a) a digit 1 for l", "Robin Quill", "Robin Qui11"],
    ["(b) a capital I for l after a lowercase letter", "Robin Quill", "Robin QuiIl"],
    ["(d) two middle dots inside a name", "Robin Fixtureperson", "Robin Fixture\u00B7\u00B7person"],
    ["(e) a capital palochka for I and a small palochka for l in one word", "Robin McIlfixture", "Robin Mc\u04C0\u04CFfixture"],
  ];
  // A near-name stays: these readings never touch it, so it publishes.
  const KEPT = [
    ["an all-capitals word (no capital I is read as l)", "Robin Lan", "Robin IAN"],
    ["a capital I that starts a word", "Robin Lris", "Robin Iris"],
    ["a word of digits alone", "Robin Iol", "Robin 101"],
    // Case (c) is not read (one measured collision among real names).
    ["rn written for m", "Robin Fixturemoss", "Robin Fixturernoss"],
    ["three middle dots inside a name", "Robin Fixtureperson", "Robin Fixture\u00B7\u00B7\u00B7person"],
  ];

  // The review of, P1-1: names Main holds back that the first head let
  // out, because a separator pair made the next letter a contraction ending.
  const STILL_HELD_BACK = [
    ["a pair and a single middle dot around an apostrophe name", "Pat O'Quill", "Pat\u00B7\u00B7O\u00B7Quill"],
    ["doubled left quotes before an apostrophe name", "Pat D'Fixture", "Pat\u2018\u2018D\u2019Fixture"],
    ["a pair and a single middle dot inside a one-letter prefix name", "Robin Jfixture", "Robin\u00B7\u00B7J\u00B7Fixture"],
  ];

  describe.each(BUILDS)("on %s", (_build, build) => {
    it.each(STILL_HELD_BACK)("still holds back what Main held back: %s", (_label, listed, written) => {
      const built = build((f) => place(f, written), { exclusions: exclusionList([listed]) });
      expect(noteOf(built)).toBeNull();
    });

    it.each(HELD_BACK)("holds back an excluded name written with %s", (_label, listed, written) => {
      const built = build((f) => place(f, written), { exclusions: exclusionList([listed]) });
      expect(noteOf(built)).toBeNull();
    });

    it.each(KEPT)("keeps a name written with %s that is not the listed one", (_label, listed, written) => {
      const built = build((f) => place(f, written), { exclusions: exclusionList([listed]) });
      expect(noteOf(built)).toBe(`Minutes prepared by ${written}, for the unit.`);
    });
  });

  // The review of, P1-2: the mixed I-or-l readings are built only near
  // the varied word, so the work grows with the value's length, not its square.
  it("keeps the readings of a long value linear in its length", () => {
    const letter = (n) => String.fromCharCode(97 + (n % 26));
    const word = (i) => `Mc\u04C0\u04CF\u04C0\u04CF${letter(i)}${letter(Math.floor(i / 26))}fix`;
    const work = (n) => [...exclusionReadings(Array.from({ length: n }, (_, i) => word(i)).join(" "))]
      .reduce((sum, reading) => sum + reading.length, 0);
    const small = work(100);
    const large = work(400);
    // Four times the words, at most about four times the work (a reading of
    // the whole value per variant made it sixteen times).
    expect(large / small).toBeLessThan(5);
    // At most 16 variants per word, each at most nine words of 13 characters.
    expect(large).toBeLessThan(400 * 16 * 9 * 14 + 4 * 400 * 14);
  });

  // The review of, P2-1: no reading is given
  // to a word longer than a name word can be, so one very long word costs
  // what it costs on Main, which reads none of them.
  describe("a word over READING_WORD_MAX characters", () => {
    const pad = (word, length) => word + "x".repeat(length - [...word].length);
    const palochkas = "Mc\u04C0\u04CFroy";

    it("is 64 characters", () => {
      expect(READING_WORD_MAX).toBe(64);
    });

    it.each([
      ["a digit 1 read as i", "F1xture", "Fixture"],
      ["a digit 0 read as o", "Fixturepers0n", "Fixtureperson"],
      ["a capital I after a lowercase letter read as l", "QuiIl", "Quill"],
    ])("keeps %s in a word of exactly 64 characters, and gives it to no longer word", (_label, written, reading) => {
      const at = pad(written, READING_WORD_MAX);
      const over = pad(written, READING_WORD_MAX + 1);
      expect(exclusionReadings(`Robin ${at}`).has(`Robin ${pad(reading, READING_WORD_MAX)}`)).toBe(true);
      expect(exclusionReadings(`Robin ${over}`).has(`Robin ${pad(reading, READING_WORD_MAX + 1)}`)).toBe(false);
      // Main's own readings of the longer word are all still given.
      expect([...exclusionReadings(`Robin ${over}`)]).toEqual([...lookAlikeReadings(`Robin ${over}`)]);
    });

    it("counts characters, not UTF-16 units", () => {
      // 64 characters, 66 UTF-16 units: one astral letter.
      const word = pad("F1xture\u{1D4D0}", READING_WORD_MAX);
      expect(word.length).toBe(READING_WORD_MAX + 1);
      expect([...exclusionReadings(word)].some((reading) => reading.startsWith("Fixture"))).toBe(true);
    });

    it("gives one very long word nothing beyond Main's readings, whatever it holds", () => {
      const letters = Array.from({ length: 80_000 }, (_, i) => String.fromCharCode(97 + (i % 26)));
      for (const [index, character] of [[16_000, "\u04C0"], [32_000, "\u04CF"], [48_000, "\u04C0"], [64_000, "\u04CF"], [70_000, "1"], [70_002, "0"], [75_000, "I"]]) letters[index] = character;
      const word = letters.join("");
      // Work, without timing: the readings are exactly the look-alike
      // readings Main gives, one copy of the word each.
      expect([...exclusionReadings(word)]).toEqual([...lookAlikeReadings(word)]);
      expect([...exclusionReadings(word)].length).toBeLessThanOrEqual(4);
    });

    // The review of, P2-1: the limit is on a letters-and-digits run,
    // not on a space-separated token, so a URL, e-mail address or hyphenated
    // string over 64 characters keeps the mixed I-or-l reading of a name in it.
    it.each([
      ["a profile URL", "https://www.example.org/union/people/directory/robin-Mc\u04C0\u04CFroy-fixtureperson-profile"],
      ["an e-mail address", "robin.Mc\u04C0\u04CFroy.fixtureperson.steward.office@members.example-union-hall.org"],
      ["a hyphenated string", `${"unit-".repeat(14)}robin-Mc\u04C0\u04CFroy-fixtureperson`],
    ])("reads a mixed-palochka name inside %s over 64 characters", (_label, written) => {
      expect([...written].length).toBeGreaterThan(READING_WORD_MAX);
      const reading = written.replace("Mc\u04C0\u04CFroy", "McIlroy");
      expect(exclusionReadings(written).has(reading)).toBe(true);
      expect(exclusionReadings(`Notes ${written} filed`).has(`Notes ${reading} filed`)).toBe(true);
    });

    it("holds back the listed name from a 76-character profile URL, as Main does", () => {
      const url = "https://www.example.org/union/people/directory/robin-Mc\u04C0\u04CFroy/profile.html.en";
      expect([...url].length).toBe(76);
      expect([...exclusionCandidates(url)]).toContain("robin mcilroy");
    });

    // A run over 64 stops the I-or-l choices only
    // when it holds a look-alike of "l" itself, so a long run in the same
    // token (a session id, a hash or a signature) no longer drops the reading
    // of a name beside it.
    it("keeps the I-or-l choices in a run of exactly 64 characters, and gives them to no longer run that holds the look-alikes", () => {
      expect(exclusionReadings(`Robin ${pad(palochkas, READING_WORD_MAX)}`).has(`Robin ${pad("McIlroy", READING_WORD_MAX)}`)).toBe(true);
      const over = `Robin ${pad(palochkas, READING_WORD_MAX + 1)}`;
      expect(exclusionReadings(over).has(`Robin ${pad("McIlroy", READING_WORD_MAX + 1)}`)).toBe(false);
      expect([...exclusionReadings(over)]).toEqual([...lookAlikeReadings(over)]);
    });

    it("reads a name beside a long run with no look-alike in the same hyphenated string", () => {
      const written = `robin-Mc\u04C0\u04CFroy-${"x".repeat(300)}`;
      expect(exclusionReadings(written).has(written.replace("Mc\u04C0\u04CFroy", "McIlroy"))).toBe(true);
    });

    it.each([
      ["a session id", `https://www.example.org/people/robin-Mc\u04C0\u04CFroy?session=${"a1B2c3D4e5".repeat(8)}`],
      ["a hash", `https://files.example.org/${"0f1e2d3c4b5a6978".repeat(8)}/robin-Mc\u04C0\u04CFroy.pdf`],
    ])("reads a mixed-palochka name beside %s over 64 characters in the same URL", (_label, url) => {
      expect((url.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).some((run) => [...run].length > READING_WORD_MAX)).toBe(true);
      expect(exclusionReadings(url).has(url.replace("Mc\u04C0\u04CFroy", "McIlroy"))).toBe(true);
      expect([...exclusionCandidates(url)]).toContain("robin mcilroy");
    });

    it("gives no mixed reading to a token over MIXED_L_TOKEN_MAX characters, which bounds its cost", () => {
      expect(MIXED_L_TOKEN_MAX).toBe(2048);
      const at = `${"unit-".repeat(400)}robin-Mc\u04C0\u04CFroy`;
      const over = `${"unit-".repeat(410)}robin-Mc\u04C0\u04CFroy`;
      expect([...at].length).toBeLessThanOrEqual(MIXED_L_TOKEN_MAX);
      expect([...over].length).toBeGreaterThan(MIXED_L_TOKEN_MAX);
      expect(exclusionReadings(at).has(at.replace("Mc\u04C0\u04CFroy", "McIlroy"))).toBe(true);
      expect(exclusionReadings(over).has(over.replace("Mc\u04C0\u04CFroy", "McIlroy"))).toBe(false);
    });

    it("still reads a short name beside a long word", () => {
      const value = `${"y".repeat(200)} Robin ${palochkas}`;
      expect(exclusionReadings(value).has(`${"y".repeat(200)} Robin McIlroy`)).toBe(true);
    });
  });

  it("gives each reading only where it applies, and never combines them", () => {
    expect([...exclusionReadings("F1xture Qui11")]).toEqual(expect.arrayContaining(["Fixture Quiii", "Flxture Quill"]));
    expect([...exclusionReadings("Robin 101 IAN Iris")]).toEqual(["Robin 101 IAN Iris"]);
    expect(exclusionReadings("F1xture QuiIl").has("Fixture Quill")).toBe(false);
    expect(exclusionReadings("Fixturernoss").has("Fixturemoss")).toBe(false);
  });
});

describe("F10: the internal-reference path", () => {
  it("never exports a person's email even when it also appears as the organization mailbox", () => {
    const out = run((f) => {
      northside(f).leaders[0].email = "info@exampleworkers1.example";
    });
    expect(out.release.contacts.some((c) => c.value === "info@exampleworkers1.example")).toBe(false);
    expect(out.dropReport["contacts.email:person_contact"]).toBe(1);
  });

  it("never exports a phone listed for a person in any record", () => {
    const out = run((f) => {
      f.enriched[NATIONAL_ID].leaders = [{ name: "Harper Fixtureperson", title: "President", phone: "802-555-0130", source: "https://testfamily.example/about" }];
    });
    expect(out.release.contacts.some((c) => c.value === "802-555-0130")).toBe(false);
    expect(out.dropReport["contacts.phone:person_contact"]).toBe(1);
  });

  it("keeps no person contact in prefill mode even when a sub-unit mailbox equals one", () => {
    const staged = prefill((f) => {
      northside(f).email = PERSON_EMAILS[1];
    });
    expect(staged.subunitContacts.some((c) => c.kind === "email")).toBe(false);
    expect(staged.dropReport["prefill.subunit_contacts.email:person_contact"]).toBe(1);
  });
});

describe("F11: fixtures", () => {
  it("refuses a record with the reserved test- prefix", () => {
    const out = run((f) => {
      f.enriched["test-9005"] = emptyRecord(9005, "Example Fixture Local 5", "local");
      f.ledger["test-9005"] = { ...f.ledger[LOCAL_ID], id: 9005, file: 900000005 };
    });
    expect(out.release.organizations.some((o) => o.name === "Example Fixture Local 5")).toBe(false);
    expect(out.dropReport["organizations:fixture_identity"]).toBe(1);
  });

  it("refuses a SAMPLE fixture identity by OLMS file number", () => {
    const out = run((f) => {
      f.ledger[STATE_BODY_ID].file = 900999999;
    });
    expect(out.release.organizations.some((o) => o.name === "Example State Council")).toBe(false);
    expect(out.dropReport["organizations:fixture_identity"]).toBe(1);
  });

  it("refuses a sub-unit named like a SAMPLE fixture unless the name is a real filer's registered name", () => {
    const out = run((f) => {
      local(f).subunits.push({ ...structuredClone(local(f).subunits[1]), name: "Example Sample Chapter", source: "https://exampleworkers1.example/sample" });
      local(f).subunits.push({ ...structuredClone(local(f).subunits[1]), name: "Example Workers International Union", kind: "local", source: "https://exampleworkers1.example/parent" });
    });
    const names = subunitsOf(out).map((s) => s.name);
    expect(names).not.toContain("Example Sample Chapter");
    expect(names).toContain("Example Workers International Union");
    expect(out.dropReport["subunits:fixture_name"]).toBe(1);
  });

  it("aborts when a release row carries a test- key", () => {
    const { release } = run();
    const planted = structuredClone(release);
    planted.document_subunits.push({ document_key: "test-doc", subunit_key: "test-subunit" });
    expect(() => assertReleasePrivacy(planted)).toThrow(/F11/);
  });
});

describe("F12: always-dropped fields", () => {
  // The twelve fields spec §2.5 F12 names, each planted with its own sentinel.
  const F12_FIELDS = ["notes", "corrections", "history", "membershipNote", "classifierHits", "code", "specific", "leadersMergedIntoProfile", "depthPass", "sourceNote", "mailing", "fax"];
  const snakeCase = (field) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  it.each(F12_FIELDS)("never exports a value or a column from %s", (field) => {
    const sentinel = ALWAYS_DROPPED_SENTINELS[field];
    expect(sentinel).toMatch(/^SENTINEL-/);
    expect(JSON.stringify(baseFixture().enriched)).toContain(sentinel);
    const out = run();
    // Lowercased, so a copy into search_text (lowercase) is caught as well.
    expect(serialized(out)).not.toContain(sentinel.toLowerCase());
    expect(JSON.stringify(prefill()).toLowerCase()).not.toContain(sentinel.toLowerCase());
    for (const rows of Object.values(out.release).filter(Array.isArray)) {
      for (const row of rows) {
        expect(Object.hasOwn(row, field)).toBe(false);
        expect(Object.hasOwn(row, snakeCase(field))).toBe(false);
      }
    }
  });

  it("gives every always-dropped field its own sentinel and exports no sentinel at all", () => {
    expect([...ALWAYS_DROPPED_FIELDS].sort()).toEqual([...F12_FIELDS].sort());
    const sentinels = F12_FIELDS.map((field) => ALWAYS_DROPPED_SENTINELS[field]);
    expect(new Set(sentinels).size).toBe(F12_FIELDS.length);
    for (const a of sentinels) for (const b of sentinels) if (a !== b) expect(a.includes(b)).toBe(false);
    expect(serialized(run())).not.toContain("sentinel");
  });

  // Exact column sets, so a derived copy of an always-dropped field under a
  // new column name (is_specific, depth_checked, leaders_merged) cannot pass.
  it("exports exactly the declared columns of every organization, sub-unit, contact, edge and document row", () => {
    const out = run();
    const columns = {
      organizations: ["aka", "bylaws_url", "catalog_key", "census_division", "census_region", "city", "confidence", "designation", "duplicate_of", "election_term_years", "family", "geo_precision", "industries", "latitude", "local_number", "longitude", "members_fiscal_year", "members_reported", "name", "next_election_on", "occupations", "olms_file_number", "org_type_label", "origin", "researched_on", "search_text", "sector", "source_urls", "state", "structure_note", "tier", "trades", "union_org_id", "website", "zip5"],
      subunits: ["as_of", "catalog_key", "confidence", "density_note", "election_note", "employer", "kind", "kind_label", "location", "members", "members_source", "name", "parent_subunit_key", "source_url", "structure_note", "subunit_key", "website"],
      contacts: ["as_of", "basis", "catalog_key", "contact_key", "contact_kind", "label", "source_url", "value"],
      edges: ["certainty", "child_key", "edge_key", "edge_kind", "parent_key", "parent_label", "source_url"],
      documents: ["as_of", "catalog_key", "doc_kind", "document_key", "title", "title_derived", "url", "url_host"],
    };
    for (const [table, expected] of Object.entries(columns)) {
      expect(out.release[table].length).toBeGreaterThan(0);
      for (const row of out.release[table]) expect(Object.keys(row).sort()).toEqual(expected);
    }
    expect(out.release.organizations.some((o) => o.duplicate_of !== null)).toBe(true);
  });

  it("exports no designation for a record whose OLMS designation is empty and whose code is a sentinel", () => {
    const fixture = baseFixture();
    expect(fixture.enriched[STATE_BODY_ID].olms.designation).toBe("");
    expect(fixture.enriched[STATE_BODY_ID].code).toBe(ALWAYS_DROPPED_SENTINELS.code);
    const out = run();
    const stateBody = out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.stateBody);
    expect(stateBody).toMatchObject({ designation: null, local_number: null });
    expect(stateBody.search_text).not.toContain("sentinel");
    expect(serialized(out)).not.toContain(ALWAYS_DROPPED_SENTINELS.code.toLowerCase());
  });

  it("gives a duplicate filer a pointer and no facts", () => {
    const out = run();
    const duplicate = out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.duplicate);
    expect(duplicate).toMatchObject({ duplicate_of: OLMS_KEY.local, website: null, structure_note: null, source_urls: [], aka: [] });
    for (const table of ["subunits", "seat_outlines", "contacts", "documents"]) {
      expect(out.release[table].some((row) => row.catalog_key === OLMS_KEY.duplicate)).toBe(false);
    }
    expect(out.release.edges.some((e) => e.child_key === OLMS_KEY.duplicate)).toBe(false);
    expect(out.idMap[DUPLICATE_ID]).toBe(OLMS_KEY.duplicate);
  });
});

describe("F13: shape", () => {
  it("drops and counts a value that fails its shape instead of truncating it", () => {
    const out = run((f) => {
      northside(f).density = "x".repeat(201);
    });
    expect(subunitsOf(out).find((s) => s.name === "Northside Chapter").density_note).toBeNull();
    expect(out.dropReport["subunits.density_note:too_long"]).toBe(1);
  });

  it("drops a row that is missing a required field", () => {
    const out = run((f) => {
      local(f).subunits[1].name = "   ";
    });
    expect(subunitsOf(out)).toHaveLength(1);
    expect(out.dropReport["subunits:name_unusable"]).toBe(1);
  });

  it("aborts on a structural fault and names the ids involved", () => {
    expect(() => run((f) => {
      f.ledger[STATE_BODY_ID].file = f.ledger[LOCAL_ID].file;
    })).toThrow(/Structural fault: catalog key collision olms-900000001 \(ledger records 9001 and 9003\)/);
    expect(() => run((f) => {
      delete f.ledger[STATE_BODY_ID];
    })).toThrow(/Structural fault: enriched record 9003 has no ledger record/);
  });

  it("maps unknown document kinds such as memorandum to other", () => {
    const out = run();
    expect(out.release.documents.find((d) => d.url.endsWith("membership-card.pdf"))).toMatchObject({ doc_kind: "other", title_derived: true });
    expect(out.dropReport["documents.doc_kind:mapped_to_other"]).toBe(1);
  });

  it("drops and counts http-only document links", () => {
    const out = run();
    expect(out.release.documents.some((d) => d.url.startsWith("http:"))).toBe(false);
    expect(out.dropReport["documents.url:http_only"]).toBe(1);
  });

  it("keeps the first twenty aliases and counts the rest", () => {
    const out = run((f) => {
      local(f).aka = Array.from({ length: 25 }, (_, i) => `Example Alias ${String.fromCharCode(65 + i)}`);
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).aka).toHaveLength(20);
    expect(out.dropReport["organizations.aka:over_cap"]).toBe(5);
  });

  it("nulls and counts a social label longer than 80 characters and keeps the link", () => {
    const host = `${"a".repeat(45)}.${"b".repeat(45)}.example`;
    const out = run((f) => {
      local(f).social = [`https://${host}/exampleworkers1`];
    });
    const social = out.release.contacts.find((c) => c.catalog_key === OLMS_KEY.local && c.contact_kind === "social");
    expect(social).toMatchObject({ value: `https://${host}/exampleworkers1`, label: null });
    expect(out.dropReport["contacts.label:too_long"]).toBe(1);
  });

  it("drops and counts a document whose host is longer than 253 characters or carries a phone number", () => {
    const longHost = `${Array.from({ length: 5 }, (_, i) => String.fromCharCode(104 + i).repeat(50)).join(".")}.example`;
    expect(longHost.length).toBeGreaterThan(253);
    const out = run((f) => {
      f.documents.push({ url: `https://${longHost}/files/guide.pdf`, orgId: LOCAL_ID, subunit: "", kind: "handbook", title: "Guide", asOf: "", status: "ok" });
      f.documents.push({ url: "https://8025550177.example/files/guide.pdf", orgId: LOCAL_ID, subunit: "", kind: "handbook", title: "Guide", asOf: "", status: "ok" });
    });
    expect(out.release.documents.some((d) => d.url.endsWith("/files/guide.pdf"))).toBe(false);
    expect(out.dropReport["documents.url_host:too_long"]).toBe(1);
    expect(out.dropReport["documents.url_host:contact_pattern"]).toBe(1);
  });

  it("drops and counts a member count outside the int4 range instead of aborting", () => {
    const out = run((f) => {
      f.ledger[LOCAL_ID].members = 3_000_000_000;
      northside(f).members = "3000000000";
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local)).toMatchObject({ members_reported: null, members_fiscal_year: null });
    expect(subunitsOf(out).find((s) => s.name === "Northside Chapter").members).toBeNull();
    expect(out.dropReport["organizations.members_reported:out_of_range"]).toBe(1);
    expect(out.dropReport["subunits.members:out_of_range"]).toBe(1);
  });

  it("collapses an identical repeated sub-unit and tells same-name sub-units apart by location", () => {
    const out = run((f) => {
      const retirees = local(f).subunits[1];
      local(f).subunits.push(structuredClone(retirees));
      local(f).subunits.push({ ...structuredClone(retirees), name: "Region A", kind: "region", location: "North" });
      local(f).subunits.push({ ...structuredClone(retirees), name: "Region A", kind: "region", location: "South" });
    });
    const regions = subunitsOf(out).filter((s) => s.name === "Region A");
    expect(regions).toHaveLength(2);
    expect(new Set(regions.map((s) => s.subunit_key)).size).toBe(2);
    expect(subunitsOf(out).filter((s) => s.name === "Retirees")).toHaveLength(1);
    expect(out.dropReport["subunits:identical_duplicate"]).toBe(1);
  });
});

describe("value normalization (§2.5 F13 table)", () => {
  it("lowercases sector Private, Mixed and Public", () => {
    expect(["Private", "Mixed", "Public"].map((v) => normalizeSector(v).value)).toEqual(["private", "mixed", "public"]);
  });

  it("maps sector Federal to public", () => {
    expect(normalizeSector("Federal").value).toBe("public");
  });

  it("maps state 00 to null, shown as State not recorded", () => {
    expect(normalizeState("00")).toEqual({ value: null, dropped: "not_recorded" });
    const out = run((f) => {
      local(f).state = "00";
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).state).toBeNull();
    expect(out.dropReport["organizations.state:not_recorded"]).toBe(1);
  });

  it("maps official-site-*, secondary, olms-filing and not-found onto the confidence enum", () => {
    expect(["official-site-2026", "secondary", "olms-filing", "not-found"].map((v) => normalizeConfidence(v).value))
      .toEqual(["official_site", "secondary", "olms_filing", "not_found"]);
  });

  it("maps an empty, unverified or missing confidence to unreviewed", () => {
    expect(["", "unverified", undefined].map((v) => normalizeConfidence(v).value)).toEqual(["unreviewed", "unreviewed", "unreviewed"]);
  });

  it("maps sub-unit kinds outside the enum to other and keeps the research label verbatim", () => {
    expect(normalizeSubunitKind("state federation")).toEqual({ kind: "other", label: "state federation", mapped: true });
    expect(normalizeSubunitKind("bargaining unit")).toMatchObject({ kind: "bargaining_unit", mapped: false });
    const out = run((f) => {
      northside(f).kind = "Master Executive Council";
    });
    expect(subunitsOf(out).find((s) => s.name === "Northside Chapter")).toMatchObject({ kind: "other", kind_label: "Master Executive Council" });
  });

  it("reduces a composite source to its first http(s) URL and drops a source with none", () => {
    const out = run((f) => {
      northside(f).source = "Listed at https://exampleworkers1.example/chapters; see also https://directory.example/x";
      local(f).subunits[1].source = "OLMS Schedule 13 only";
    });
    expect(subunitsOf(out).map((s) => [s.name, s.source_url])).toEqual([["Northside Chapter", "https://exampleworkers1.example/chapters"]]);
    expect(out.dropReport["subunits.source_url:composite_source_reduced"]).toBe(1);
    expect(out.dropReport["subunits.source_url:not_url"]).toBe(1);
  });

  it("keeps more than twenty sources, up to the 150 cap", () => {
    const out = run((f) => {
      local(f).sources = Array.from({ length: 160 }, (_, i) => `https://exampleworkers1.example/page-${i}`);
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).source_urls).toHaveLength(150);
    expect(out.dropReport["organizations.source_urls:over_cap"]).toBe(10);
  });

  it("keeps a structure note over 1,200 characters, up to the 3,000 cap", () => {
    const long = `${"The local is organized in chapters by employer. ".repeat(50)}`.trim();
    expect(long.length).toBeGreaterThan(1200);
    const out = run((f) => {
      local(f).structureNote = long;
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBe(long);
    const tooLong = run((f) => {
      local(f).structureNote = "y".repeat(3001);
    });
    expect(tooLong.dropReport["organizations.structure_note:too_long"]).toBe(1);
  });

  it("drops and counts a sub-unit employer over 300 or location over 200 characters", () => {
    const out = run((f) => {
      northside(f).employer = "e".repeat(301);
      northside(f).location = "l".repeat(201);
    });
    expect(subunitsOf(out).find((s) => s.name === "Northside Chapter")).toMatchObject({ employer: null, location: null });
    expect(out.dropReport["subunits.employer:too_long"]).toBe(1);
    expect(out.dropReport["subunits.location:too_long"]).toBe(1);
  });

  it("reads a board entry's seat as its title", () => {
    const out = run();
    expect(out.release.seat_outlines.find((s) => s.seat_class === "board").title).toBe("At-large seat");
  });

  it("gives an officer or board entry with an empty own source its sub-unit's source", () => {
    const out = run();
    const chapterKey = subunitsOf(out).find((s) => s.name === "Northside Chapter").subunit_key;
    const officer = out.release.seat_outlines.find((s) => s.subunit_key === chapterKey && s.seat_class === "officer");
    expect(officer.source_url).toBe("https://exampleworkers1.example/chapters");
  });

  it("gives an organization-level leader with an empty own source nothing to inherit", () => {
    const out = run((f) => {
      local(f).leaders[0].source = "";
    });
    expect(out.release.organizations.find((o) => o.catalog_key === OLMS_KEY.local).source_urls).not.toEqual([]);
    expect(out.release.seat_outlines.some((s) => s.catalog_key === OLMS_KEY.local && s.subunit_key === null)).toBe(false);
    expect(out.dropReport["seat_outlines:unsourced"]).toBe(1);
  });

  it("drops and counts an entry whose own source is present but unusable instead of letting it inherit", () => {
    const out = run((f) => {
      northside(f).board[0].source = "Chapter newsletter, spring 2026";
      northside(f).leaders[0].source = "https://directory.example/casey-fixtureperson";
      local(f).leaders[0].source = "OLMS LM-3 2025";
    });
    const chapterKey = subunitsOf(out).find((s) => s.name === "Northside Chapter").subunit_key;
    const chapter = out.release.seat_outlines.filter((s) => s.subunit_key === chapterKey);
    expect(chapter.find((s) => s.seat_class === "board")).toMatchObject({ listed: 1, vacant: 1 });
    expect(chapter.some((s) => s.seat_class === "officer")).toBe(false);
    expect(out.release.seat_outlines.some((s) => s.catalog_key === OLMS_KEY.local && s.subunit_key === null)).toBe(false);
    expect(out.dropReport["seat_outlines.source_url:not_url"]).toBe(2);
    expect(out.dropReport["seat_outlines.source_url:person_name"]).toBe(1);
    expect(out.dropReport["seat_outlines:own_source_unusable"]).toBe(3);
  });

  it("parses the election cycle into a term length and next election date and never exports the text", () => {
    expect(parseElectionCycle("Chapter officers serve two-year terms; next local-wide election 04/2028.", null)).toEqual({ termYears: 2, nextOn: "2028-04-01" });
    expect(parseElectionCycle("Elections every three years.", "06/2027")).toEqual({ termYears: 3, nextOn: "2027-06-01" });
    expect(parseElectionCycle("", "")).toEqual({ termYears: null, nextOn: null });
    const out = run();
    expect(Object.keys(out.release.organizations[0])).not.toContain("election_cycle");
  });
});

// REQ-UG-UNION-CATALOG-EXPORT-PARENT-BODY-KEYS-20260926: a parent_body
// label resolves to a catalog key only on one exact normalized-name match to
// a non-duplicate organization; otherwise it stays label-only and is counted.
describe("parent_body keys", () => {
  const parentBodyEdges = (out, label) => out.release.edges.filter((e) => e.edge_kind === "parent_body" && e.parent_label === label);
  const addFiler = (f, id, file, name) => {
    f.enriched[id] = emptyRecord(Number(id), name, "state");
    f.ledger[id] = { ...f.ledger[STATE_BODY_ID], id: Number(id), file };
  };

  it("keys a parent body whose name matches exactly one organization and keeps its label", () => {
    const out = run((f) => {
      local(f).parentBodies[0].name = "  example   STATE council ";
    });
    const [edge] = parentBodyEdges(out, "example STATE council");
    expect(edge).toMatchObject({ child_key: OLMS_KEY.local, parent_key: OLMS_KEY.stateBody, certainty: "confirmed" });
    expect(out.dropReport["edges.parent_body:unresolved"]).toBe(1);
    expect(out.dropReport["edges.parent_body:ambiguous"]).toBeUndefined();
  });

  it("keeps the label-hash edge_key when a parent body resolves", () => {
    const keyed = parentBodyEdges(run(), "Example State Council")[0];
    const unkeyed = parentBodyEdges(run((f) => {
      f.enriched[STATE_BODY_ID].name = "Example State Council of Fixtureperson Workers";
    }), "Example State Council")[0];
    expect(keyed.parent_key).toBe(OLMS_KEY.stateBody);
    expect(unkeyed.parent_key).toBeNull();
    expect(keyed.edge_key).toBe(unkeyed.edge_key);
  });

  it("leaves a parent body with no matching organization label-only and counts it unresolved", () => {
    const out = run();
    expect(parentBodyEdges(out, "Example District 7")).toEqual([expect.objectContaining({ parent_key: null, certainty: "filed" })]);
    expect(out.dropReport["edges.parent_body:unresolved"]).toBe(1);
  });

  it("leaves a parent body matching two organizations label-only and counts it ambiguous", () => {
    const out = run((f) => addFiler(f, "9005", 900000005, "Example State Council"));
    expect(parentBodyEdges(out, "Example State Council")).toEqual([expect.objectContaining({ parent_key: null })]);
    expect(out.dropReport["edges.parent_body:ambiguous"]).toBe(1);
  });

  it("never keys a parent body to a duplicate filer or to the child itself", () => {
    const toDuplicate = run((f) => {
      local(f).parentBodies[0].name = "Example Workers Local 1 (legacy filer)";
    });
    expect(parentBodyEdges(toDuplicate, "Example Workers Local 1 (legacy filer)")[0].parent_key).toBeNull();
    const toSelf = run((f) => {
      local(f).parentBodies[0].name = local(f).name;
    });
    expect(toSelf.release.edges.filter((e) => e.edge_kind === "parent_body" && e.parent_key !== null)).toEqual([]);
    expect(toSelf.dropReport["edges:self_edge"]).toBeUndefined();
    for (const out of [toDuplicate, toSelf]) expect(out.dropReport["edges.parent_body:unresolved"]).toBe(2);
  });

  it("counts a self-named parent body beside a same-named second filer as ambiguous instead of keying the other filer", () => {
    const out = run((f) => {
      local(f).parentBodies[0].name = local(f).name;
      addFiler(f, "9005", 900000005, local(f).name);
    });
    expect(parentBodyEdges(out, "Example Workers Local 1")).toEqual([expect.objectContaining({ parent_key: null })]);
    expect(out.dropReport["edges.parent_body:ambiguous"]).toBe(1);
    expect(out.dropReport["edges.parent_body:unresolved"]).toBe(1);
  });

  it("keeps a parent body label-only and counts it unresolved when its single match is not exported", () => {
    // The only body with this name is dropped (an unknown tier), so its name
    // matches but its key is not exported. (Before  this used a name over
    // the old 200-character cap, which now exports.)
    const longName = "Example State Council ".repeat(12).trim().padEnd(256, "x");
    const out = run((f) => {
      f.enriched[STATE_BODY_ID].name = longName;
      f.enriched[STATE_BODY_ID].tier = "galactic";
      local(f).parentBodies[0].name = longName;
    });
    expect(out.release.organizations.map((o) => o.catalog_key)).not.toContain(OLMS_KEY.stateBody);
    expect(parentBodyEdges(out, longName)).toEqual([expect.objectContaining({ parent_key: null, certainty: "confirmed" })]);
    expect(out.dropReport["edges.parent_body:unresolved"]).toBe(2);
  });

  it("counts an unresolved parent body once per exported edge, not once per source", () => {
    const out = run((f) => {
      local(f).parentBodies.push({ name: "Example District 7", kind: "district", source: "https://testfamily.example/districts" });
    });
    expect(parentBodyEdges(out, "Example District 7")).toHaveLength(1);
    expect(out.dropReport["edges:duplicate"]).toBe(1);
    expect(out.dropReport["edges.parent_body:unresolved"]).toBe(1);
  });

  it("does not key a state federation parent body even when its name matches", () => {
    const out = run((f) => {
      local(f).parentBodies[0].kind = "state federation";
    });
    expect(out.release.edges.find((e) => e.edge_kind === "state_federation" && e.parent_label === "Example State Council").parent_key).toBeNull();
  });

  it("keys the parent body in prefill mode too", () => {
    expect(parentBodyEdges({ release: prefill() }, "Example State Council")[0].parent_key).toBe(OLMS_KEY.stateBody);
  });

  it("rejects a release whose parent_body edge is keyed to a duplicate organization", () => {
    const { release } = run();
    const edge = parentBodyEdges({ release }, "Example State Council")[0];
    edge.parent_key = OLMS_KEY.duplicate;
    expect(releaseViolations(release)).toEqual([`edges ${edge.edge_key}: parent_key names a duplicate organization`]);
  });
});
