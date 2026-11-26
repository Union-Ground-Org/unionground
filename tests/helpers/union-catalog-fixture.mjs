// Fictional research snapshot for the union catalog privacy filter and
// exporter tests. Every organization, person, domain and number here is
// invented: organizations are "Example Workers ..." bodies, people carry the
// surname "Fixtureperson", domains use the reserved .example top-level
// domain, phone numbers sit in the 555-01xx fiction range, and OLMS file
// numbers sit at 900000001 and up. Values that must never reach a release
// carry a SENTINEL marker so a test can search the output for them.
import {
  exclusionHashes,
  parseExclusionList,
  projectDocumentIndex,
  projectLedgerRecords,
} from "../../scripts/union-catalog/privacy-filter.mjs";

export const FAMILY = "TESTFAM";
export const FAMILY_DOMAINS = Object.freeze({ schema: "catalog-family-domains/1", families: { [FAMILY]: ["testfamily.example"] } });
export const BLOCKED_DOMAINS = Object.freeze({
  schema: "catalog-blocked-email-domains/1",
  consumer: ["freemail.example"],
  hosting: ["sitebuilder.example"],
});
export const TEST_SALT = "test-salt-0123456789abcdef";

export const LOCAL_ID = "9001";
export const NATIONAL_ID = "9002";
export const STATE_BODY_ID = "9003";
export const DUPLICATE_ID = "9004";

export const PEOPLE = Object.freeze({
  president: "Avery Fixtureperson",
  signatory: "FIXTUREPERSON, BLAKE",
  signatoryPlain: "Blake Fixtureperson",
  chair: "Casey Fixtureperson",
  board: "Drew Fixtureperson",
  steward: "Emery Fixtureperson",
  staff: "Finley Fixtureperson",
  regionalLeader: "Gale Fixtureperson",
});

export const PERSON_EMAILS = Object.freeze([
  "avery.fixtureperson@exampleworkers1.example",
  "casey@exampleworkers1.example",
  "emery@exampleworkers1.example",
  "finley@exampleworkers1.example",
]);
export const PERSON_PHONES = Object.freeze(["802-555-0101", "802-555-0102", "802-555-0111", "802-555-0199"]);

// F12: one unique sentinel per always-dropped research field, planted in the
// fixture below, so a test can name the field whose value leaked.
export const ALWAYS_DROPPED_SENTINELS = Object.freeze({
  notes: "SENTINEL-NOTES",
  corrections: "SENTINEL-CORRECTION",
  history: "SENTINEL-HISTORY",
  membershipNote: "SENTINEL-MEMBERSHIP-NOTE",
  classifierHits: "SENTINEL-CLASSIFIER",
  code: "SENTINEL-CODE",
  specific: "SENTINEL-SPECIFIC",
  leadersMergedIntoProfile: "SENTINEL-LEADERSMERGED",
  depthPass: "SENTINEL-DEPTHPASS",
  sourceNote: "SENTINEL-SOURCENOTE",
  mailing: "SENTINEL-MAILING",
  fax: "SENTINEL-FAX",
});

function localRecord() {
  return {
    id: 9001,
    name: "Example Workers Local 1",
    unit: "",
    code: ALWAYS_DROPPED_SENTINELS.code,
    orgType: "Local union",
    tier: "local",
    state: "VT",
    stateName: "Vermont",
    city: "Exampleville",
    region: "Northeast",
    division: "New England",
    zip: "05999",
    lat: 44.123456,
    lon: -72.654321,
    geoPrecision: "zip",
    sector: "Public",
    industries: ["Public administration"],
    occupations: ["Clerical"],
    trades: [],
    classifierHits: [ALWAYS_DROPPED_SENTINELS.classifierHits],
    specific: ALWAYS_DROPPED_SENTINELS.specific,
    phones: ["802-555-0120", "802-555-0102"],
    email: "info@exampleworkers1.example",
    fax: `802-555-0198 ${ALWAYS_DROPPED_SENTINELS.fax}`,
    web: "https://exampleworkers1.example/",
    social: ["https://social.example/exampleworkers1"],
    address: "1 Fixture Way, Exampleville, VT 05999",
    mailing: `${ALWAYS_DROPPED_SENTINELS.mailing} PO Box 1`,
    olms: {
      form: "LM-3",
      period: "2025",
      designation: "LU",
      designationNbr: "1",
      contact: PEOPLE.signatoryPlain,
      street: "SENTINEL-OLMS-STREET 9 Home Lane",
      building: "",
      poBox: "",
      city: "EXAMPLEVILLE",
      state: "VT",
      zip: "05999",
      recordsAtMailing: "",
      signatories: [{ name: PEOPLE.signatory, title: "TREASURER", phone: "802-555-0102", signed: "2026-01-01" }],
      nextElection: "06/2027",
      membershipCategories: [],
      fetched: true,
    },
    leaders: [
      { name: PEOPLE.president, title: "President", email: PERSON_EMAILS[0], phone: "802-555-0101", source: "https://exampleworkers1.example/officers" },
    ],
    offices: [
      { name: "Main office", address: "1 Fixture Way, Exampleville", phone: "802-555-0130", email: "office@exampleworkers1.example", source: "https://exampleworkers1.example/contact" },
      { name: "Field office", address: "2 Elsewhere Road", phone: "802-555-0131", email: "", source: "https://directory.example/listing" },
    ],
    subunits: [
      {
        name: "Northside Chapter",
        kind: "chapter",
        location: "Exampleville",
        employer: "Example County",
        members: 120,
        membersSource: "https://exampleworkers1.example/chapters",
        density: "80%",
        website: "https://exampleworkers1.example/northside",
        phone: "802-555-0140",
        email: "northside@exampleworkers1.example",
        address: "SENTINEL-SUBUNIT-ADDRESS",
        leaders: [{ name: PEOPLE.chair, title: "Chapter Chair", email: PERSON_EMAILS[1], phone: "802-555-0111", source: "" }],
        board: [
          { name: PEOPLE.board, seat: "At-large seat", email: "", source: "" },
          { name: "Vacant", seat: "At-large seat", email: "", source: "" },
        ],
        stewards: [{ name: PEOPLE.steward, worksite: "Main office", email: PERSON_EMAILS[2], source: "" }],
        staff: [{ name: PEOPLE.staff, title: "Staff representative", email: PERSON_EMAILS[3], source: "" }],
        electionDate: "2027-06",
        asOf: "2026-09-01",
        documents: [],
        source: "https://exampleworkers1.example/chapters",
        confidence: "official-site-2026",
        notes: "SENTINEL-SUBUNIT-NOTES",
        sourceNote: ALWAYS_DROPPED_SENTINELS.sourceNote,
      },
      {
        name: "Retirees",
        kind: "retiree chapter",
        location: "",
        employer: "",
        members: "",
        membersSource: "",
        density: "",
        website: "",
        phone: "",
        email: "",
        address: "",
        leaders: [],
        board: [],
        stewards: [],
        electionDate: "",
        asOf: "",
        documents: [],
        source: "https://exampleworkers1.example/retirees",
        confidence: "",
      },
    ],
    parentBodies: [
      { name: "Example State Council", kind: "state council", source: "https://testfamily.example/councils" },
      { name: "Example District 7", kind: "district", source: "OLMS filing 2025" },
    ],
    employers: ["SENTINEL-EMPLOYERS-LIST"],
    membershipNote: ALWAYS_DROPPED_SENTINELS.membershipNote,
    history: ALWAYS_DROPPED_SENTINELS.history,
    aka: ["EWU Local 1"],
    sources: ["https://exampleworkers1.example/about", "https://directory.example/local-1"],
    confidence: "official-site-2026",
    reviewed: "2026-09-24",
    notes: ALWAYS_DROPPED_SENTINELS.notes,
    researched: true,
    structureNote: "The local is organized in chapters by employer. Chapter officers serve two-year terms.",
    bylawsUrl: "https://exampleworkers1.example/bylaws.pdf",
    electionCycle: "Officers serve three-year terms; next election 06/2027. SENTINEL-CYCLE",
    depthPass: ALWAYS_DROPPED_SENTINELS.depthPass,
    depthReviewed: "2026-09-24",
    duplicateOf: null,
    regionalBody: {
      id: null,
      name: "Example Region 9",
      kind: "region",
      office: "SENTINEL-REGION-OFFICE",
      phone: "802-555-0150",
      website: "https://testfamily.example/region-9",
      leader: { name: PEOPLE.regionalLeader, phone: "802-555-0199" },
      source: "https://testfamily.example/regions",
      notes: "",
      options: [],
    },
    stateBodyId: 9003,
    stateBody: null,
    aflcioState: { name: "Example State Labor Federation", website: "https://federation.example/", phone: "802-555-0160", office: "", source: "https://federation.example/" },
    corrections: [{ field: "name", supplied: ALWAYS_DROPPED_SENTINELS.corrections, found: "", source: "" }],
    leadersMergedIntoProfile: ALWAYS_DROPPED_SENTINELS.leadersMergedIntoProfile,
  };
}

function nationalRecord() {
  return {
    ...emptyRecord(9002, "Example Workers International Union", "national"),
    web: "https://testfamily.example/",
    confidence: "official-site-2026",
    sources: ["https://testfamily.example/about"],
    researched: true,
    reviewed: "2026-09-24",
  };
}

// The state body has no OLMS designation, so a fallback from the empty
// designation to the always-dropped code (F12) would show in its row.
function stateBodyRecord() {
  return { ...emptyRecord(9003, "Example State Council", "state"), confidence: "", code: ALWAYS_DROPPED_SENTINELS.code };
}

function duplicateRecord() {
  return {
    ...emptyRecord(9004, "Example Workers Local 1 (legacy filer)", "local"),
    duplicateOf: 9001,
    structureNote: "SENTINEL-DUPLICATE-FACT",
    web: "https://exampleworkers1.example/legacy",
  };
}

export function emptyRecord(id, name, tier) {
  return {
    id,
    name,
    unit: "",
    code: "",
    orgType: "",
    tier,
    state: "VT",
    stateName: "Vermont",
    city: "Exampleville",
    region: "Northeast",
    division: "New England",
    zip: "05999",
    lat: null,
    lon: null,
    geoPrecision: "",
    sector: "Private",
    industries: [],
    occupations: [],
    trades: [],
    classifierHits: [],
    specific: false,
    phones: [],
    email: "",
    fax: "",
    web: "",
    social: [],
    address: "",
    mailing: "",
    olms: { designation: "", designationNbr: "", contact: "", signatories: [], nextElection: "" },
    leaders: [],
    offices: [],
    subunits: [],
    parentBodies: [],
    employers: [],
    membershipNote: "",
    history: "",
    aka: [],
    sources: [],
    confidence: "not-found",
    reviewed: "",
    notes: "",
    researched: false,
    structureNote: "",
    bylawsUrl: "",
    electionCycle: "",
    depthPass: false,
    depthReviewed: "",
    duplicateOf: null,
    regionalBody: null,
    stateBodyId: null,
    stateBody: null,
    aflcioState: null,
    corrections: [],
  };
}

function ledgerRecord(id, file, parent, extra = {}) {
  return {
    id: Number(id),
    name: "SENTINEL-LEDGER-NAME",
    aff: FAMILY,
    label: "LU 1",
    level: 2,
    place: "Exampleville, VT",
    members: 450,
    assets: 1,
    receipts: 2,
    disbursements: 3,
    web: "",
    parent,
    file,
    fy: "2025-12-31",
    zip: "05999",
    address: "SENTINEL-LEDGER-ADDRESS",
    addressSource: "https://olms.example/report",
    publicContacts: ["SENTINEL-LEDGER-CONTACT"],
    ...extra,
  };
}

function documents() {
  return [
    {
      url: "https://exampleworkers1.example/files/northside-agreement.pdf",
      orgId: LOCAL_ID,
      orgName: "SENTINEL-DOC-ORGNAME",
      subunit: "Northside Chapter",
      kind: "contract",
      title: "Northside Chapter Agreement 2025-2028",
      asOf: "2025-07-01",
      sourceRecord: "SENTINEL-SOURCE-RECORD",
      sourceField: "documents",
      id: "doc-1",
      status: "ok",
      retrieved: "2026-09-24",
      contentType: "application/pdf",
      error: "",
      foundOn: "SENTINEL-FOUND-ON",
      pageTitle: "SENTINEL-PAGE-TITLE",
      alsoIn: [],
    },
    {
      url: "https://exampleworkers1.example/files/bylaws.pdf",
      orgId: LOCAL_ID,
      subunit: "",
      kind: "bylaws",
      title: "Local 1 Bylaws",
      asOf: "2024",
      status: "ok",
    },
    {
      url: "https://exampleworkers1.example/files/membership-card.pdf",
      orgId: LOCAL_ID,
      subunit: "",
      kind: "memorandum",
      title: "",
      asOf: "",
      status: "ok",
    },
    {
      url: "http://exampleworkers1.example/files/old-contract.pdf",
      orgId: LOCAL_ID,
      subunit: "",
      kind: "contract",
      title: "Old contract",
      asOf: "",
      status: "ok",
    },
    {
      url: "https://exampleworkers1.example/files/election-notice.pdf",
      orgId: LOCAL_ID,
      subunit: "",
      kind: "other",
      title: "Officer election notice",
      asOf: "",
      status: "ok",
    },
    {
      url: "https://exampleworkers1.example/files/missing.pdf",
      orgId: LOCAL_ID,
      subunit: "",
      kind: "form",
      title: "Dues form",
      asOf: "",
      status: "http-404",
    },
    {
      url: "https://testfamily.example/files/shared-guide.pdf",
      orgId: NATIONAL_ID,
      subunit: "",
      kind: "handbook",
      title: "Steward guide",
      asOf: "September 2025",
      status: "ok",
      alsoIn: [{ orgId: LOCAL_ID, subunit: "Northside Chapter", sourceRecord: "SENTINEL-ALSOIN" }],
    },
  ];
}

/** A fresh, mutable fictional snapshot. */
export function baseFixture() {
  const enriched = {
    [LOCAL_ID]: localRecord(),
    [NATIONAL_ID]: nationalRecord(),
    [STATE_BODY_ID]: stateBodyRecord(),
    [DUPLICATE_ID]: duplicateRecord(),
  };
  const ledger = {
    [LOCAL_ID]: ledgerRecord(LOCAL_ID, 900000001, 9002),
    [NATIONAL_ID]: ledgerRecord(NATIONAL_ID, 900000002, -1, { members: 90000 }),
    [STATE_BODY_ID]: ledgerRecord(STATE_BODY_ID, 900000003, 9002),
    [DUPLICATE_ID]: ledgerRecord(DUPLICATE_ID, 900000004, 9002),
  };
  return { enriched, ledger, documents: documents() };
}

/** A synthetic exclusion list, hashed with the owner's recipe (exclusionHashes). */
export function exclusionList(values = []) {
  return parseExclusionList(JSON.stringify({ schema: "catalog-exclusions/1", salt: TEST_SALT, hashes: values.flatMap((v) => exclusionHashes(TEST_SALT, v)) }));
}

/** Filter options for a fixture, with the projections the exporter applies (F1). */
export function filterOptions(fixture, overrides = {}) {
  return {
    enriched: fixture.enriched,
    ledger: projectLedgerRecords(fixture.ledger),
    documents: projectDocumentIndex({ documents: fixture.documents }),
    exclusions: exclusionList(),
    familyDomains: FAMILY_DOMAINS,
    blockedDomains: BLOCKED_DOMAINS,
    fixtureNames: ["Example Sample Chapter", "Example Workers International Union"],
    fixtures: { ids: ["ug-sample-fixture"], fileNumbers: [900999999] },
    ...overrides,
  };
}

export const OLMS_KEY = Object.freeze({
  local: "olms-900000001",
  national: "olms-900000002",
  stateBody: "olms-900000003",
  duplicate: "olms-900000004",
});
