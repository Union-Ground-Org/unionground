#!/usr/bin/env node
// REQ-UG-RIGHTS-LAW-LIBRARY-20261012: build the Massachusetts rights
// and law library under data/reference/labor-rights/ from a labor-rights
// reference library (an agency list plus saved agency pages) and fresh captures
// of every agency page it rests on. Operator-side: the captured bytes live in the campaign's
// lane directories, not in this repository; the output carries a provenance
// record (docs/conventions/provenance.md) on every agency, deadline, scenario,
// concept and document, plus every capture record those derive from.
//
// Fails closed: a deadline whose quote is not an exact substring of its fresh
// capture, a contact value nobody verified, a document without a capture, or
// any record validate() refuses stops the build with the list of problems.
//
//   node scripts/build-rights-law-library.mjs \
//     --lane <source-directory> --l7 <supplement-directory> \
//     --library <directory of a labor-rights reference library: agencies.json and its pages> \
//     --built-at <UTC timestamp> --out data/reference/labor-rights
//
// The library is an input the builder reads, not a source it cites: every
// published record derives from fresh public captures only, so nothing in the
// output names where the library was kept.

import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Hex, stamp, validateDocument } from "./lib/provenance.mjs";
import { publicNoteText, publicReferenceDocument } from "./lib/public-provenance.mjs";

const VERSION = "scripts/build-rights-law-library.mjs@1";
const RUN_ID = "build-it-all-20261012/L2a";
const DISCLAIMER = "General information about Massachusetts and federal workplace law, not legal advice. Deadlines can be shorter or longer depending on the facts. Talk to your steward about your situation before a deadline passes.";
// Library pages captured by earlier the same morning; reused unchanged.
const L7_KEYS = {
  "sub-01-dlr-ulp-procedures": "dlr-a-ulp-procedures",
  "sub-01-dlr-prohibited-practices": "dlr-f-prohibited",
};

const CONTACT_LABELS = {
  url: "Website",
  filingPortal: "File online",
  whistleblowerPortal: "Whistleblower complaint form",
  publicAccess: "Public access",
  anonymousFiling: "Anonymous filing",
  dualFiling: "Filing with the EEOC",
  hearingLocations: "Hearing locations",
};

const problems = [];
const fail = (message) => problems.push(message);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  for (const key of ["lane", "l7", "library", "out"]) {
    if (!out[key]) throw new Error(`--${key} is required`);
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readRegistry(laneDir, registry) {
  const entries = new Map();
  for (const line of fs.readFileSync(path.join(laneDir, "sources", "registry.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    entries.set(`${registry}:${row.key}`, { ...row, registry, laneDir });
  }
  return entries;
}

// The capture's text view (exact bytes for Firecrawl markdown; tag-stripped text
// for HTML) is where quotes are bound.
function captureText(entry) {
  return fs.readFileSync(path.join(entry.laneDir, "sources", "text", `${entry.key}.txt`), "utf8");
}

function captureBytes(entry) {
  return fs.readFileSync(path.join(entry.laneDir, entry.raw_path));
}

// Drop what is not the agency's own text: image-only lines (the MCAD and DIA
// pages carry hundreds of kilobytes of map-tile links), and the news, social,
// location-map and feedback blocks mass.gov appends to every page.
// Everything before the page's first top-level heading is the site banner
// ("An official website of ...") and breadcrumbs, and is dropped too.
const DROP_SECTIONS = /^(notices( &| and) alerts|news( &| and) announcements|social media links|locations|help us improve|did you find|feedback|related)\b/i;
export function excerpt(markdown) {
  const out = [];
  let dropLevel = 0;
  // Firecrawl writes card links as "[\\\\" + newline + "Title](url)"; fold those
  // hard breaks into spaces so each link is one line.
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\\+\n/g, " ").replace(/\[(?:\s|\\)+/g, "[")
    // Markdown escapes of plain punctuation ("\[3\]", "1\.") read as stray
    // backslashes once rendered; "\*" stays escaped so it never becomes emphasis.
    .replace(/\\([[\]()_#.!+-])/g, "$1").split("\n");
  const title = lines.findIndex((line) => /^#\s+\S/.test(line));
  for (const line of title > 0 ? lines.slice(title) : lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (dropLevel && level <= dropLevel) dropLevel = 0;
      if (!dropLevel && DROP_SECTIONS.test(heading[2].replace(/[*_[\]]/g, "").trim())) {
        dropLevel = level;
        continue;
      }
    }
    if (dropLevel) continue;
    const cleaned = line.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[\]\([^)]*\)/g, "").replace(/[ \t]+$/, "");
    if (!cleaned.trim() && line.trim()) continue;
    out.push(cleaned);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function main() {
  const opt = args(process.argv.slice(2));
  const builtAt = opt["built-at"] ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const libraryRoot = opt.library;
  const registry = new Map([...readRegistry(opt.lane, "L2a"), ...readRegistry(opt.l7, "L7")]);
  const used = new Map();
  const capture = (registryName, key) => {
    const entry = registry.get(`${registryName}:${key}`);
    if (!entry) {
      fail(`no capture ${registryName}:${key}`);
      return null;
    }
    // The record vouches for the raw capture; refuse a capture whose bytes no
    // longer hash to it, before any quote or excerpt is taken from it.
    if (sha256Hex(captureBytes(entry)) !== entry.record.content_sha256) {
      fail(`capture ${registryName}:${key}: raw bytes do not match the record's content_sha256`);
      return null;
    }
    used.set(entry.record.provenance_id, entry.record);
    return entry;
  };

  const library = readJson(path.join(libraryRoot, "agencies.json"));
  const verifiedDeadlines = readJson(path.join(opt.lane, "DEADLINES-VERIFIED.json"));
  const claims = opt.claims ?? path.join(opt.lane, "stage", "claims");
  const contacts = readJson(path.join(claims, "contacts.json"));
  const scenarios = readJson(path.join(claims, "scenarios.json"));
  const concepts = readJson(path.join(claims, "concepts.json"));
  // CONTENT-UG-RIGHTS-LIBRARY-OSHA-SAFETY-ENTRIES-20261022: statute
  // fields the reference library got wrong, corrected here with bound evidence
  // instead of in the library (optional file; one row per agency).
  const correctionsFile = path.join(claims, "agency-corrections.json");
  const corrections = fs.existsSync(correctionsFile) ? readJson(correctionsFile) : [];
  // UX-UG-RIGHTS-LIBRARY-AGENCY-EXCERPT-DEADLINE-NOTE-20261022: a
  // library-authored note shown beside an agency excerpt whose own deadline
  // wording differs from the library's cards; the excerpt stays verbatim.
  const notesFile = path.join(claims, "document-notes.json");
  const documentNotes = fs.existsSync(notesFile) ? readJson(notesFile) : [];

  const quoteBound = (entry, quote, label) => {
    if (!entry) return false;
    const text = captureText(entry);
    if (typeof quote !== "string" || quote.length < 20) return fail(`${label}: quote missing or too short`), false;
    if (!text.includes(quote)) return fail(`${label}: quote is not an exact substring of ${entry.registry}:${entry.key}`), false;
    return true;
  };
  // A review cannot predate the captures it read: a record whose newest
  // source was captured after --built-at is stamped at that capture time, so
  // a rebuild that adds sources leaves every unchanged record byte-identical.
  // Compared as instants, so a fractional --built-at or capture time keeps
  // its order; whole-second times print without the ".000".
  const reviewedAt = (ids) => {
    const latest = ids.map((id) => used.get(id)?.retrieved_at).filter(Boolean)
      .reduce((max, at) => Math.max(max, Date.parse(at)), Date.parse(builtAt));
    return latest === Date.parse(builtAt) ? builtAt : new Date(latest).toISOString().replace(/\.000Z$/, "Z");
  };
  const firstSource = (ids) => used.get(ids[0])?.source;
  const authored = ({ content, source, retrievedAt, derivedFrom, title, note = "" }) => stamp({
    bytes: canonicalJson(content),
    source: { ...source, ...(title ? { title } : {}) },
    retrievedAt,
    capture: { method: "authored", tool: `${VERSION} from a labor-rights reference library, fact-checked against fresh captures`, run_id: RUN_ID },
    extraction: { method: "model", extractor: "claude-opus-5-5 (lane L2a verifiers); quotes checked by " + VERSION, quote_binding: "exact-substring" },
    asOf: reviewedAt(derivedFrom).slice(0, 10),
    derivedFrom: [...new Set(derivedFrom)],
    review: { status: "reviewed", reviewed_at: reviewedAt(derivedFrom), reviewer_role: "lane", note: note || "Every claim bound to an exact quote in a fresh capture or cut. Not yet reviewed by a platform editor." },
    reuse: { basis: "owner-authored", note: "Plain-language summary compiled for the platform; agency pages and statutes are cited, short quotations only." },
  });
  const evidenceIds = (evidence, label) => evidence.flatMap((item, index) => {
    const entry = capture(item.registry, item.key);
    return quoteBound(entry, item.quote, `${label} evidence[${index}]`) ? [entry.record.provenance_id] : [];
  });

  // Deadlines: only verified or corrected ones, each bound to its quote.
  const deadlinesByAgency = new Map();
  for (const row of verifiedDeadlines) {
    const label = `deadline ${row.deadline_id}`;
    if (row.status === "refused") continue;
    if (!["verified", "corrected", "range"].includes(row.status)) { fail(`${label}: unknown status ${row.status}`); continue; }
    if (row.status === "range" && row.period) { fail(`${label}: a range has no single period`); continue; }
    const entry = capture(row.evidence_registry, row.evidence_key);
    if (!quoteBound(entry, row.quote, label)) continue;
    if (row.period && !(Number.isInteger(row.period.value) && ["day", "business_day", "week", "month", "year"].includes(row.period.unit))) {
      fail(`${label}: period must be {integer value, day|business_day|week|month|year}`);
      continue;
    }
    const cap = entry.record;
    const deadline = {
      id: row.deadline_id,
      claim: row.claim,
      period: row.period ?? null,
      period_text: row.period_text,
      trigger: row.trigger_plain,
      extension: row.extension_plain ?? null,
      statute: row.statute_pinpoint ?? null,
      quote: row.quote,
      evidence_url: cap.source.url,
      provenance: stamp({
        contentSha256: cap.content_sha256,
        source: cap.source,
        retrievedAt: cap.retrieved_at,
        capture: cap.capture,
        extraction: { method: "model", extractor: "claude-opus-5-5 (lane L2a deadline verifier); quote checked by " + VERSION, quote_binding: "exact-substring" },
        asOf: cap.as_of,
        derivedFrom: [cap.provenance_id],
        review: { status: "reviewed", reviewed_at: reviewedAt([cap.provenance_id]), reviewer_role: "lane", note: publicNoteText(row.change_note) },
        reuse: cap.reuse ?? { basis: "public-record" },
      }),
    };
    deadlinesByAgency.set(row.agency_id, [...(deadlinesByAgency.get(row.agency_id) ?? []), deadline]);
  }

  // The per-jurisdiction ULP charge window the casework trigger reads
  // (migration 20261013200000). Massachusetts: the DLR's procedures page for
  // the period, trigger and exception, bound to the DLR's own copy of
  // 456 CMR 15.04 for the rule itself.
  const ulpLimitationPeriods = [];
  const maUlp = (deadlinesByAgency.get("ma-dlr") ?? []).find((deadline) => deadline.id === "dlr-ulp-charge");
  const regulation = capture("L7", "dlr-456-cmr-15");
  const regulationQuote = "any prohibited practice occurring more than six months prior to the filing of a charge with the";
  if (!maUlp || !maUlp.period || maUlp.period.unit !== "month") fail("MA ULP period: verified dlr-ulp-charge with a month period is required");
  else if (quoteBound(regulation, regulationQuote, "MA ULP period regulation")) {
    const procedure = used.get(maUlp.provenance.derived_from[0]);
    ulpLimitationPeriods.push({
      jurisdiction: "MA",
      jurisdiction_name: "Massachusetts",
      period: maUlp.period,
      period_text: "six months",
      trigger: maUlp.trigger,
      extension: maUlp.extension,
      pinpoint: "456 CMR 15.04",
      quote: maUlp.quote,
      regulation_quote: regulationQuote,
      provenance: stamp({
        contentSha256: procedure.content_sha256,
        source: procedure.source,
        retrievedAt: procedure.retrieved_at,
        capture: procedure.capture,
        extraction: { method: "model", extractor: "claude-opus-5-5 (lane L2a deadline verifier); quotes checked by " + VERSION, quote_binding: "exact-substring" },
        asOf: procedure.as_of,
        derivedFrom: [procedure.provenance_id, regulation.record.provenance_id],
        review: { status: "reviewed", reviewed_at: builtAt, reviewer_role: "lane", note: "Period, trigger and exception from the DLR procedures page; the rule from the DLR's own copy of 456 CMR 15.04. Agrees with the Massachusetts row (456 CMR 15.04 via Cornell LII)." },
        reuse: procedure.reuse ?? { basis: "public-record" },
      }),
    });
  }

  // Documents: agency landing pages and filing-procedure subpages as excerpts.
  const documents = [];
  const uncaptured = [];
  const docsByAgency = new Map();
  const agencyOfFile = new Map();
  const landingFiles = new Set(library.agencies.map((agency) => agency.sourceFiles?.landing).filter(Boolean));
  for (const agency of library.agencies) {
    for (const file of [agency.sourceFiles?.landing, ...(agency.sourceFiles?.subpages ?? [])].filter(Boolean)) agencyOfFile.set(file, agency.id);
  }
  const pageFiles = fs.readdirSync(libraryRoot).filter((name) => /^(\d\d-ma-|\d\d-(eeoc|dol|osha|nlrb)|sub-).*\.md$/.test(name) && !name.startsWith("00-")).sort();
  for (const file of pageFiles) {
    const name = file.replace(/\.md$/, "");
    const [registryName, key] = L7_KEYS[name] ? ["L7", L7_KEYS[name]]
      : registry.has(`L2a:lrfc-${name}`) ? ["L2a", `lrfc-${name}`] : ["L2a", `lr-${name}`];
    if (!registry.has(`${registryName}:${key}`)) {
      uncaptured.push(file);
      continue;
    }
    const entry = capture(registryName, key);
    if (entry.record.capture.method !== "firecrawl") { fail(`document ${name}: excerpt source must be a main-content capture`); continue; }
    const body = excerpt(captureBytes(entry).toString("utf8"));
    const cap = entry.record;
    const id = name.replace(/^sub-/, "");
    const agencyId = agencyOfFile.get(file) ?? null;
    if (!agencyId) fail(`document ${name}: no agency in agencies.json lists ${file}`);
    const noteRow = documentNotes.find((row) => row.document_id === id);
    let libraryNote = null;
    if (noteRow) {
      const cards = (deadlinesByAgency.get(agencyId) ?? []).filter((deadline) => (noteRow.deadline_ids ?? []).includes(deadline.id));
      if (!noteRow.text || !noteRow.title || !cards.length || cards.length !== noteRow.deadline_ids.length) {
        fail(`document ${id}: a library note needs a title, text and deadline_ids that are this agency's published deadlines`);
      } else {
        const content = { title: noteRow.title, text: noteRow.text, deadline_ids: noteRow.deadline_ids };
        const ids = cards.map((deadline) => deadline.provenance.derived_from[0]);
        libraryNote = { ...content, provenance: authored({ content, source: { url: firstSource(ids).url, publisher: firstSource(ids).publisher }, title: noteRow.title, retrievedAt: used.get(ids[0]).retrieved_at, derivedFrom: [...ids], note: "Library-authored note shown beside the verbatim agency excerpt; it restates the bound deadline cards it links." }) };
      }
    }
    documents.push({
      id,
      agency_id: agencyId,
      kind: landingFiles.has(file) ? "agency_page" : "procedure",
      title: cap.source.title,
      url: cap.source.url,
      locale: "en",
      body_md: body,
      provenance: stamp({
        bytes: body,
        source: cap.source,
        retrievedAt: cap.retrieved_at,
        capture: { method: "computed", tool: VERSION, run_id: RUN_ID },
        extraction: { method: "script", extractor: `${VERSION} excerpt (images, news, social, map and feedback blocks dropped)`, quote_binding: "none" },
        asOf: cap.as_of,
        derivedFrom: [cap.provenance_id],
        review: { status: "unreviewed", reviewed_at: null, reviewer_role: "lane", note: "" },
        reuse: { basis: "public-record", note: "Government agency page; main content republished as an excerpt with a link to the source." },
      }),
      ...(libraryNote ? { library_note: libraryNote } : {}),
    });
    if (agencyId) docsByAgency.set(agencyId, [...(docsByAgency.get(agencyId) ?? []), id]);
  }

  // Agencies: library fields, verified contacts only, verified deadlines.
  const excluded = [];
  const agencies = [];
  for (const agency of library.agencies) {
    const docIds = docsByAgency.get(agency.id) ?? [];
    const landing = documents.find((doc) => doc.agency_id === agency.id && doc.kind === "agency_page");
    if (!landing) {
      excluded.push({ id: agency.id, name: agency.name, reason: `No fresh capture of the agency's own page (${agency.sourceFiles?.landing ?? "none listed"}); refused rather than published from the May 2026 scrape.` });
      continue;
    }
    const contact = contacts.find((row) => row.agency_id === agency.id);
    if (!contact) { fail(`agency ${agency.id}: no contacts.json entry`); continue; }
    const kept = (contact.values ?? []).filter((value) => value.status !== "cut");
    const contactIds = kept.flatMap((value, index) => evidenceIds([value.evidence], `agency ${agency.id} contact[${index}]`));
    const correction = corrections.find((row) => row.agency_id === agency.id);
    const correctionIds = correction ? evidenceIds(correction.evidence ?? [], `agency ${agency.id} correction`) : [];
    if (correction && correctionIds.length !== (correction.evidence ?? []).length) { fail(`agency ${agency.id}: correction evidence must all bind`); continue; }
    if (correction && !correctionIds.length) { fail(`agency ${agency.id}: correction without evidence`); continue; }
    const card = {
      id: agency.id,
      name: agency.name,
      abbreviation: agency.abbreviation,
      jurisdiction: agency.jurisdiction,
      category: agency.category,
      use_for: agency.useFor,
      primary_statute: correction?.primary_statute ?? agency.primaryStatute,
      additional_statutes: correction?.additional_statutes ?? agency.additionalStatutes ?? [],
      // contacts.json fields read "phone:Boston (Main)"; the part after the colon is the office.
      // A value the checker added from a fresh page reads "suggested-add:phone:Springfield".
      contact: kept.map(({ field, value }) => {
        const [kind, ...office] = String(field).replace(/^suggested-add:/, "").split(":");
        const shown = office.length ? office.join(":").trim() : CONTACT_LABELS[kind];
        return { field: kind, value: kind === "anonymousFiling" && value === "true" ? "Allowed" : value, ...(shown ? { label: shown } : {}) };
      }),
      documents: docIds,
    };
    const landingCapture = landing.provenance.derived_from[0];
    agencies.push({
      ...card,
      deadlines: deadlinesByAgency.get(agency.id) ?? [],
      provenance: authored({
        content: card,
        source: { url: landing.url, publisher: landing.provenance.source.publisher },
        title: agency.name,
        retrievedAt: landing.provenance.retrieved_at,
        derivedFrom: [landingCapture, ...contactIds, ...correctionIds],
      }),
    });
  }
  for (const file of uncaptured) {
    if (!excluded.some((row) => row.id === agencyOfFile.get(file))) fail(`document ${file}: no fresh capture, and its agency is published`);
  }
  for (const id of deadlinesByAgency.keys()) if (!agencies.some((agency) => agency.id === id)) fail(`deadlines for ${id} have no published agency`);
  for (const row of documentNotes) if (!documents.some((doc) => doc.id === row.document_id)) fail(`library note for ${row.document_id} has no published document`);
  for (const row of corrections) if (!agencies.some((agency) => agency.id === row.agency_id)) fail(`agency correction for ${row.agency_id} has no published agency`);

  const scenarioRows = scenarios.filter((row) => row.status !== "cut").map((row) => {
    const ids = evidenceIds(row.evidence ?? [], `scenario ${row.id}`);
    const content = { id: row.id, title: row.title, summary: row.summary, primary_agency: row.primary_agency ?? null, also_see: row.also_see ?? [], urgency_text: row.urgency_text, deadline_ids: row.deadline_ids ?? [] };
    if (!ids.length) { fail(`scenario ${row.id}: no bound evidence`); return null; }
    return { ...content, provenance: authored({ content, source: { url: firstSource(ids).url, publisher: firstSource(ids).publisher }, title: row.title, retrievedAt: used.get(ids[0]).retrieved_at, derivedFrom: ids }) };
  }).filter(Boolean);
  const conceptRows = concepts.filter((row) => row.status !== "cut").map((row) => {
    const ids = evidenceIds(row.evidence ?? [], `concept ${row.id}`);
    const content = { id: row.id, name: row.name, summary: row.summary, applies_to: row.applies_to };
    if (!ids.length) { fail(`concept ${row.id}: no bound evidence`); return null; }
    return { ...content, provenance: authored({ content, source: { url: firstSource(ids).url, publisher: firstSource(ids).publisher }, title: row.name, retrievedAt: used.get(ids[0]).retrieved_at, derivedFrom: ids }) };
  }).filter(Boolean);

  // The sibling product's member guide and steward cheat sheet are not
  // published here: Union Ground serves workers still forming a union, and
  // those guides were that product's own platform content on its own site.

  const recordsFor = (doc) => {
    const ids = new Set();
    const walk = (node) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        if (Array.isArray(node.derived_from)) node.derived_from.forEach((id) => id.startsWith("prov-") && ids.add(id));
        Object.values(node).forEach(walk);
      }
    };
    walk(doc);
    return [...ids].sort().map((id) => {
      if (!used.has(id)) fail(`no capture record for ${id}`);
      return { provenance: used.get(id) };
    });
  };

  const header = {
    schema: "union-ground/rights-law-library/v1",
    jurisdictions: ["MA", "US"],
    locale: "en",
    disclaimer: DISCLAIMER,
    generated_by: VERSION,
    built_at: builtAt,
  };
  // The shipped form drops the internal library reference and build tool and
  // run identifiers (OPS-UG-LAW-LIBRARY-STRIP-INTERNAL-SOURCE-PATHS-20261110).
  const agenciesBuilt = { ...header, excluded, agencies, scenarios: scenarioRows, concepts: conceptRows, ulp_limitation_periods: ulpLimitationPeriods };
  agenciesBuilt.source_records = recordsFor(agenciesBuilt);
  const agenciesDoc = publicReferenceDocument(agenciesBuilt, "agencies.json");
  const documentsBuilt = { ...header, documents };
  documentsBuilt.source_records = recordsFor(documentsBuilt);
  const documentsDoc = publicReferenceDocument(documentsBuilt, "documents.json");

  for (const [name, doc] of [["agencies.json", agenciesDoc], ["documents.json", documentsDoc]]) {
    const result = validateDocument(doc);
    if (!result.ok) result.errors.forEach((error) => fail(`${name}: ${error}`));
  }
  if (problems.length) {
    console.error(`refused: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  fs.mkdirSync(opt.out, { recursive: true });
  for (const [name, doc] of [["agencies.json", agenciesDoc], ["documents.json", documentsDoc]]) {
    fs.writeFileSync(path.join(opt.out, name), JSON.stringify(doc, null, 2) + "\n");
  }
  const deadlineCount = agencies.reduce((sum, agency) => sum + agency.deadlines.length, 0);
  console.log(`agencies ${agencies.length} (excluded ${excluded.length}), deadlines ${deadlineCount}, scenarios ${scenarioRows.length}, concepts ${conceptRows.length}, documents ${documents.length}, capture records ${used.size}`);
  console.log(`sha256 agencies.json ${sha256Hex(fs.readFileSync(path.join(opt.out, "agencies.json")))}`);
}

main();
