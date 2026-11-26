// The privacy filter for the public-record union catalog, version
// privacy-filter/1 (spec docs/superpowers/specs/2026-09-24-union-catalog-
// prefilled-organizations-design.md §1.3, §2.2 and §2.5).
//
// Pure functions over already-parsed JSON. Nothing here opens a file, reads
// the environment or talks to a database; export-release.mjs does the I/O
// and hands this module three parsed inputs:
//
//   enriched   build/enriched.json, keyed by ledger id
//   ledger     source-data.json -> index-data.json.records, projected to
//              {id, file, parent, members, fy, aff, catalog_key} (F1)
//   documents  documents/index.json -> documents[], projected to
//              {url, orgId, subunit, kind, title, asOf, status, alsoIn} and
//              the locale fields (F1)
//
// A record that states locale (a country-aware build;) is
// exported with a locale bundle on every row, under the country-aware rules
// below (localeBundle).
//
// It is an ALLOW-LIST. A field reaches the release only because a rule below
// copies it there; everything else, including every person field (F4) and the
// always-dropped research fields (F12), is never read. The privacy gates fail
// closed:
//
//   * F1  a parsed input carrying a key named `reference` aborts the run;
//   * F8  a free-text value with an email or phone pattern, election-result
//         wording, or the name of a person listed in the same record is
//         dropped and counted; assertReleasePrivacy() then aborts the run if
//         any exported string outside a phone or email contact value still
//         carries an email or phone pattern. Patterns are tested on the
//         value as written (percent-decoded run by run for a URL) and on its
//         NFKC fold with every default-ignorable character removed, and a
//         hit on either reading counts; a free-text value carrying a
//         bidirectional control is dropped as a control character;
//   * F9  the exclusion list is required; a match drops the value or entity.
//
// Shape faults (F13) are dropped and counted by field path, never truncated.
// Only structural faults (a missing ledger record, a key collision) abort.
//
// EXCLUSION LIST FORMAT (F9). CATALOG_EXCLUSIONS_FILE holds
//   {"schema":"catalog-exclusions/1","salt":"<16+ chars>","hashes":["<64 hex>",...]}
// The owner's hashing recipe: each hash is the lowercase hex of
//   sha256(salt + "\u0000" + canonical)
// where canonical is
//   * for a name (person or organization): exclusionRecipeNameTokens(name)
//     .join(" "), the frozen Main nameTokens recipe: lowercase, accents and
//     apostrophes removed, split on everything else ("Pat O'Quill-Moss" ->
//     "pat oquill moss", "Søren Þorn" -> "s ren orn");
//   * for an email address or a URL fragment: normalizeExclusionValue(value),
//     that is NFKC, lowercase, whitespace collapsed ("info@x.example",
//     "x.example/files").
// exclusionHashes(salt, value) emits the normalized form, that unchanged
// recipe and the added transliterated-name form, deduplicated. Stored
// Main-recipe hashes remain valid; the owner never needs to replace the list.
// The matcher tests every form of each candidate: the whole value, its
// percent-decoded form, each of those with possessive 's removed, every run
// of one to five words and of one to five name tokens of each, every email
// address in each, and, for a URL, its host and every host/path prefix. The file lives outside every repository
// and is maintained by the owner; it is never committed, printed or logged,
// and only its sha256 and a match count reach the manifest.
import { createHash } from "node:crypto";
import {
  CATALOG_KEY_PATTERN,
  CONTENT_TABLES,
  DOC_KINDS,
  ORGANIZATION_NAME_MAX,
  RELEASE_SCHEMA,
  RELEASE_TABLES,
  RESEARCH_TABLES,
  charLength,
  hasControlCharacter,
  isRealIsoDate,
  primaryKeyOf,
  releaseViolations,
  rowViolations,
} from "./catalog-shape.mjs";
import { CAPTURE_METHODS, stamp } from "../lib/provenance.mjs";
import { LOOK_ALIKE_LETTERS } from "./look-alike-letters.mjs";
import { applyShortNamePrivacy } from "./short-name-privacy.mjs";
import {
  LOCALE_FIELDS,
  UNKNOWN_REASONS,
  validCountry,
  validLanguage,
  validSubdivision,
  validTimezone,
} from "./catalog-locale.mjs";

export const FILTER_VERSION = "privacy-filter/1";
export const EXCLUSIONS_SCHEMA = "catalog-exclusions/1";
export const TEST_KEY_PREFIX = "test-";

// ---------------------------------------------------------------- patterns

export const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const EMAIL_GLOBAL = new RegExp(EMAIL_PATTERN.source, "g");
const EMAIL_EXACT = new RegExp(`^${EMAIL_PATTERN.source}$`);
const OBFUSCATED_EMAIL_PATTERN = /[A-Za-z0-9._%+-]+\s*[[(]\s*at\s*[\])]\s*[A-Za-z0-9-]+\s*(?:[[(]\s*dot\s*[\])]|\.)\s*[A-Za-z]{2,}/i;
// North American numbers as people write them: (617) 555-0100,
// (617)-555-0100, 617.555.0100, 617 555 0100, 617/555-0100, 617–555–0100,
// +1 617-555-0100, 1-800-555-0100. Only a neighbouring digit disqualifies a
// match, so a number inside a slug (Local-1234-802-555-0100, 617-555-0100-2),
// after a prefix (p.617.555.0100) or before an extension (617-555-0100x12)
// counts, while a longer digit run such as 2019-555-0100 does not.
//
// Two shapes of the same pattern. In a URL every separator is one character
// and a slash is accepted only after the area code (617/555-0100), so a
// path of numbered segments is not read as a phone. In free text a separator
// may be repeated and padded with spaces (617 – 555 – 0100, 617--555--0100)
// and a slash may stand anywhere (617/555/0100, (617)/555-0100); there, a
// number that continues a slash-separated chain of digit groups
// (Ref 1/234/567/8901/2345) is an identifier, and a slash is not accepted
// after the country code.
const DASH_CLASS = "\\u2010-\\u2015\\u2043\\u2212";
const PHONE_SEPARATOR = `[\\s.${DASH_CLASS}-]`;
const TEXT_SEPARATOR = `(?:\\s*[./${DASH_CLASS}-]+\\s*|\\s+)`;
const TEXT_PREFIX_SEPARATOR = `(?:\\s*[.${DASH_CLASS}-]+\\s*|\\s+)`;
const TEXT_LEAD = "(?<!\\d)(?<!\\d\\s*/\\s*)";
export const PHONE_PATTERN = new RegExp(
  `(?<!\\d)(?:\\+?1${PHONE_SEPARATOR}?)?(?:\\(\\d{3}\\)${PHONE_SEPARATOR}?|\\d{3}(?:${PHONE_SEPARATOR}|/)?)\\d{3}${PHONE_SEPARATOR}\\d{4}(?!\\d)`,
);
const TEXT_PHONE_PATTERN = new RegExp(
  `${TEXT_LEAD}(?:\\+?1${TEXT_PREFIX_SEPARATOR}?)?(?:\\(\\d{3}\\)${TEXT_SEPARATOR}?|\\d{3}${TEXT_SEPARATOR}?)\\d{3}${TEXT_SEPARATOR}\\d{4}(?!\\d)`,
);
// Free text only: a bare run of exactly ten digits (again only a neighbouring
// digit disqualifies it, so p.8025550100 and 8025550100x12 count) and a +1
// number with no separators (+16175550100, 16175550100).
const BARE_PHONE_PATTERN = /(?<!\d)\d{10}(?!\d)/;
const COUNTRY_CODE_PHONE_PATTERN = /(?<!\d)\+?1[\s.-]?[2-9]\d{2}[2-9]\d{6}(?!\d)/;
// An E.164 number, in free text and in URLs: a plus, a country code and
// seven to fourteen more digits with any free-text separator between them
// (+44 20 7946 0958, +44–20–7946–0958, +44 20/7946/0958), or with the first
// group in parentheses (+1(802)5550177, +44 (0)20 7946 0958).
const E164_PATTERN = new RegExp(
  `(?<![\\d+])\\+[1-9](?:(?:${TEXT_SEPARATOR}?\\d){7,14}|\\d{0,2}${TEXT_SEPARATOR}?\\(\\d{1,4}\\)(?:${TEXT_SEPARATOR}?\\d){4,12})(?!\\d)`,
);
// URLs only. A "+" decodes to a space, so the +1 and E.164 forms are read
// from the raw URL with %2B restored to "+" as well as from the decoded one
// (where a plus can only come from %2B or a fullwidth plus). A ten-digit run
// in a URL is usually a document id, but a valid North American number that
// fills a whole path segment, query value or delimited token
// (/workplaces/8025550100, /8025550100-2, ?id=8025550100,
// /8025550100;jsessionid=x, ?ids=8025550100,8025550101) is a phone; one
// glued to a letter, a digit, "_" or "." (/doc_8025550100.pdf) is not.
const URL_COUNTRY_CODE_PHONE_PATTERN = /(?:\+|%2B)1[2-9]\d{2}[2-9]\d{6}(?!\d)/i;
const URL_SEGMENT_PHONE_PATTERN = /(?<![\w.])1?[2-9]\d{2}[2-9]\d{6}(?![\w.])/;
const CONTACT_SCHEME_PATTERN = /(?:^|[^a-z])(?:mailto|tel|sms):/i;
// Bidirectional embedding, override and isolate controls: they can reorder
// what a reader sees, so a free-text value carrying one is dropped (F13).
const BIDI_CONTROL_PATTERN = /[\u202A-\u202E\u2066-\u2069]/;
// Every character a renderer may leave out: the format characters (zero-width
// space and joiners, soft hyphen, bidi controls, tags) and the other
// default-ignorable code points (variation selectors, the combining grapheme
// joiner, Hangul fillers, Mongolian and Khmer selectors).
const IGNORABLE_PATTERN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// The apostrophes a name may be written with, and the possessive they form:
// the ASCII apostrophe and grave accent, the curly quotes, the modifier
// letters (apostrophe, prime, turned comma, half rings), the acute accent,
// the prime and reversed prime, the Hebrew geresh, the reversed-9 quotation
// mark, the Latin saltillo and the fullwidth apostrophe and grave accent.
const APOSTROPHES = "'`\u2019\u2018\u201B\u02BC\u02B9\u02BB\u02BD\u02BE\u00B4\u2032\u2035\u05F3\uA78C\uFF07\uFF40";
const APOSTROPHE_PATTERN = new RegExp(`[${APOSTROPHES}]`, "gu");
const POSSESSIVE_PATTERN = new RegExp(`[${APOSTROPHES}]s\\b`, "giu");
// One run of percent escapes.
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
// safeDecode decodes again until the text stops changing, at most this many
// times; a URL still encoded after that is dropped (overEncoded).
export const DECODE_PASSES = 8;
// One word for foldLookAlikes: letters with their marks and any
// invisible character written inside them.
const LOOK_ALIKE_WORD = /[\p{L}\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}]+/gu;
const BASIC_LATIN_LETTER = /^[A-Za-z]$/u;
// Read through by foldLookAlikes and left out of its reading, never a reason
// to leave a word as written: marks, modifier letters and symbols, invisible
// characters and every letter the scripts share (Common and Inherited). The
// apostrophes the filter reads (U+02BC among them) are kept as written.
const LOOK_ALIKE_TRANSPARENT = /^[\p{M}\p{Lm}\p{Sk}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Script=Common}\p{Script=Inherited}]$/u;
const LATIN_LETTER = /^\p{Script=Latin}$/u;
const APOSTROPHE_SET = new Set(APOSTROPHES);

// F3: a URL or title of this class never supplies a person fact, a seat
// outline or a document.
export const ELECTION_SOURCE_PATTERN = /(election|candidate|ballot|nominat|results)/i;
// F8: a sentence with election-result wording is dropped from free text.
export const ELECTION_RESULT_PATTERN = /\b(re-?elected|elected|slate|won|defeated|unopposed|runoff|sworn in)\b/i;
// F6: the only local parts an organization email may have.
export const ROLE_MAILBOX_PATTERN = /^(?:info|office|contact|admin|local[-_.]?[0-9]{1,5})$/i;
// F6 for a body outside the United States (its organization row carries a
// country other than US): the reviewed office, information, contact,
// administration, reception, press and union mailboxes in English, Spanish,
// French, Portuguese and Dutch, written without accents as a mailbox local
// part is, plus a numbered local or section. Officer titles (president,
// secretary, treasurer and their translations) are never role mailboxes here
// either: such a mailbox reaches whoever holds the office. A U.S. body keeps
// ROLE_MAILBOX_PATTERN exactly.
export const INTERNATIONAL_ROLE_MAILBOXES = Object.freeze([
  // English
  "info", "office", "contact", "admin", "reception", "communications", "press",
  // Spanish
  "contacto", "contactenos", "informacion", "informes", "oficina", "administracion", "recepcion",
  "comunicaciones", "comunicacion", "prensa", "sindicato",
  // French
  "information", "informations", "bureau", "administration", "accueil", "communication", "syndicat",
  // Portuguese
  "contato", "informacoes", "informacao", "escritorio", "administracao", "recepcao", "comunicacao",
  "imprensa", "atendimento",
  // Dutch
  "informatie", "kantoor", "administratie", "receptie", "communicatie", "vakbond",
]);
export const INTERNATIONAL_ROLE_MAILBOX_PATTERN = new RegExp(
  `^(?:${INTERNATIONAL_ROLE_MAILBOXES.join("|")}|(?:local|seccion|section|secao)[-_.]?[0-9]{1,5})$`,
  "i",
);
const FIRST_LAST_LOCAL_PART = /^[a-z]+[._-][a-z]+$/i;
const VACANT_NAME_PATTERN = /^\s*(?:vacant|vacancy|open|tbd|tba|to be (?:named|determined|filled|announced|appointed))\b/i;
const URL_IN_TEXT = /https?:\/\/[^\s;,()[\]<>"']+/i;

// F12: research fields that are always dropped. The allow-list never reads
// them; the list exists so a test can prove none of their values leaks.
export const ALWAYS_DROPPED_FIELDS = Object.freeze([
  "notes", "corrections", "history", "membershipNote", "classifierHits", "code", "specific",
  "leadersMergedIntoProfile", "depthPass", "sourceNote", "mailing", "fax",
]);
// F4: person fields that never reach a shared table, at any level.
export const PERSON_FIELDS = Object.freeze(["leaders", "board", "stewards", "staff", "olms.contact", "olms.signatories"]);

// F1: the only ledger fields and document-index fields the exporter keeps.
// `catalog_key` is read only for a record with no federal file number: a
// stable ug- key the research build assigned (see catalogIdentityOf).
export const LEDGER_FIELDS = Object.freeze(["id", "file", "parent", "members", "fy", "aff", "catalog_key"]);
export const DOCUMENT_INDEX_FIELDS = Object.freeze([
  "url", "orgId", "subunit", "kind", "title", "asOf", "status", "alsoIn",
  "country", "subdivision", "postal_code", "language", "timezone", "locale_unknowns",
]);
// Every locale field a research row may state.
const LOCALE_INPUT_FIELDS = Object.freeze([...LOCALE_FIELDS, "locale_unknowns"]);
// The registry-identifier fields read from a record's identifiers[] (B06).
// A capture receipt is stamped from content_sha256, retrieved_at and
// capture_method; nothing narrative is read.
export const IDENTIFIER_INPUT_FIELDS = Object.freeze(["namespace", "value", "source_url", "as_of", "content_sha256", "retrieved_at", "capture_method"]);
export const IDENTIFIER_KEY_BASIS = "catalog-identifier/1";
// A receipt needs an observed capture; computed and authored records need
// derived_from inputs the research build does not carry.
export const IDENTIFIER_CAPTURE_METHODS = Object.freeze(CAPTURE_METHODS.filter((method) => method !== "computed" && method !== "authored"));
// The reserved shape of a directory-listed body's derived key (directoryBodyKey).
const DIRECTORY_KEY_SHAPE = /^ug-d[0-9a-f]{9}$/;
const UG_KEY_SHAPE = /^ug-[a-z0-9]{10}$/;

// Directory-listed bodies (snapshot directory/listed-bodies.json, written by
// build-directory-snapshot.mjs): locals, councils and state or intermediate
// bodies that a national union lists in its own published directory but that
// have no federal file number. F1 for them: only these fields of a body, and
// only {url, asOf} of each source, are ever read. Staff, officer and contact
// fields a body may carry are never read (F4).
export const DIRECTORY_BODIES_SCHEMA = "union-catalog-directory-bodies/1";
export const DIRECTORY_BODY_FIELDS = Object.freeze(["id", "name", "family", "tier", "parentFileNumber", "city", "state", "country", "website", "sources"]);
export const DIRECTORY_KEY_BASIS = "directory-listed-body/1";
// What every loaded directory-listed body says about itself, so a reader can
// tell it from a filer. It states no filing.
export const DIRECTORY_BODY_NOTE = "Listed in its national union's own published directory. This entry is not from a federal filing and has not been reviewed.";
// The postal codes a U.S. place may carry: the states, DC and the territories.
export const US_STATE_CODES = Object.freeze(new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "PR", "GU", "VI", "AS", "MP",
]));

// Document-index statuses that point at a page or file that answered. Broken
// links (http-4xx/5xx, fetch errors) and non-documents are dropped.
export const LIVE_DOCUMENT_STATUSES = Object.freeze(["ok", "page", "page-no-documents", "too-large"]);
const LIVE_STATUS_SET = new Set(LIVE_DOCUMENT_STATUSES);

const DOC_KIND_LABELS = Object.freeze({
  contract: "Contract",
  bylaws: "Bylaws",
  form: "Form",
  newsletter: "Newsletter",
  handbook: "Handbook",
  other: "Document",
});

export const SEAT_DEFAULT_TITLES = Object.freeze({
  officer: "Officer",
  board: "Board seat",
  steward: "Steward",
  delegate: "Delegate",
});

// ---------------------------------------------------------------- small helpers

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function collapse(value) {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

// collapse() reads U+FEFF as a space (JavaScript's \s includes it), which
// would split a name written around one ("Fixture\uFEFFperson"), so the name
// and exclusion checks also read a value with every default-ignorable
// character removed first. The exported value is still collapse()'s.
function unhidden(value) {
  return collapse(text(value).replace(IGNORABLE_PATTERN, ""));
}

// One run of percent escapes, decoded; a run that is not UTF-8 is read as
// Latin-1.
function decodeRun(run) {
  try {
    return decodeURIComponent(run);
  } catch {
    return run.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}

/**
 * Percent-decodes a URL for detection, one run of escapes at a time, so a
 * malformed escape elsewhere ("%zz", a trailing "%") never leaves the rest of
 * the URL encoded. A run that is not UTF-8 is read as Latin-1; a malformed
 * escape stays as written. A "+" is read as a space. A name percent-encoded
 * twice or more ("%2550at",) is decoded again until the text stops
 * changing, at most DECODE_PASSES times; only the first pass reads "+" as a
 * space, so a "+" that decoding produced stays one.
 */
export function safeDecode(value) {
  let current = value.replace(/\+/g, " ");
  for (let pass = 0; pass < DECODE_PASSES; pass += 1) {
    const next = current.replace(PERCENT_RUN, decodeRun);
    if (next === current) break;
    current = next;
  }
  return current;
}

/** True when a URL still has an escape to decode after safeDecode's last pass: it is dropped. */
export function overEncoded(value) {
  const decoded = safeDecode(value);
  return decoded.replace(PERCENT_RUN, decodeRun) !== decoded;
}

// The ways foldLookAlikes reads a letter the confusables data reads as "l"
// (Cyrillic palochka, Byelorussian-Ukrainian I, Greek iota and the rest): as
// "I" at the start of a word and "l" after it, as "l" everywhere, or as "I"
// everywhere, so "Qui\u04C0l", "\u04CFris" and "W\u04C0LL\u04C0AM" read as Quill, Iris and
// WILLIAM.
const L_READINGS = Object.freeze(["position", "l", "I"]);

// One character of a word, read in Latin for foldLookAlikes: its letter in
// LOOK_ALIKE_LETTERS, nothing for a character read through, or each part of
// its compatibility form (a basic Latin letter, a look-alike, or another
// Latin letter; a mark or a space the form carries, as in U+037A, is left
// out). Null for a letter of another script that looks like no Latin letter.
// hit: the reading differs from the character as written.
function lookAlikeReading(character, lReading, first) {
  if (APOSTROPHE_SET.has(character)) return { text: character, hit: false };
  const read = (letter) => {
    if (letter !== "l") return letter;
    if (typeof lReading === "function") return lReading();
    return lReading === "I" || (lReading === "position" && first) ? "I" : "l";
  };
  if (LOOK_ALIKE_LETTERS.has(character)) return { text: read(LOOK_ALIKE_LETTERS.get(character)), hit: true };
  const parts = [...character.normalize("NFKD")];
  if (LOOK_ALIKE_TRANSPARENT.test(character) && !parts.some((part) => BASIC_LATIN_LETTER.test(part))) return { text: "", hit: true };
  let reading = "";
  let hit = false;
  for (const part of parts) {
    if (BASIC_LATIN_LETTER.test(part)) reading += part;
    else if (LOOK_ALIKE_LETTERS.has(part)) {
      reading += read(LOOK_ALIKE_LETTERS.get(part));
      hit = true;
    } else if (/^\s$/u.test(part)) hit = true;
    else if (LOOK_ALIKE_TRANSPARENT.test(part)) continue;
    else if (LATIN_LETTER.test(part)) reading += part;
    else return null;
  }
  return { text: reading, hit };
}

/**
 * Detection only: never an exported value, a key or a hash. Reads a
 * word in Latin when every letter in it is a Latin letter, a look-alike of a
 * basic Latin letter from any script (LOOK_ALIKE_LETTERS, built from the
 * Unicode confusables data), or a character read through and left out (a
 * mark, a modifier letter or symbol, a letter the scripts share, an invisible
 * character), so "P\u0430t O\u02BCQu\u0456ll" reads as "Pat O\u02BCQuill" and
 * "Fixture\uA67F\uA67Fperson" as "Fixtureperson". The apostrophes the filter
 * reads stay as written. A word that also carries a letter of another script
 * that looks like no Latin letter is genuinely written in that script and is
 * read as written, and so is a word with nothing to read differently (Latin
 * text with no look-alike and nothing read through comes back as written).
 * lReading is one of L_READINGS.
 */
export function foldLookAlikes(value, { lReading = "position" } = {}) {
  return text(value).replace(LOOK_ALIKE_WORD, (word) => {
    let folded = "";
    let hit = false;
    for (const character of word) {
      const reading = lookAlikeReading(character, lReading, folded === "");
      if (reading === null) return word;
      folded += reading.text;
      hit ||= reading.hit;
    }
    return hit ? folded : word;
  });
}

/** Every reading foldLookAlikes gives a value (one per L_READINGS), the value itself first. */
export function lookAlikeReadings(value) {
  return new Set([text(value), ...L_READINGS.map((lReading) => foldLookAlikes(value, { lReading }))]);
}

// (cases a, b and e of the runbook's Known limits):
// further readings, for the exclusion list (F9) only. Each one only adds a
// candidate. A word is a run of letters, marks and digits. Case (c), "rn"
// read as "m", is not read: measured on the catalog's person names it would
// hold back a real name whenever another real name is listed (one collision),
// so it waits for a narrower change of its own.
const READING_WORD = /[\p{L}\p{M}\p{N}]+/gu;
const LOOK_ALIKE_L_MAX = 4;
// No name word is longer than this, so the digit and capital-I readings are
// not given to a longer word: each would copy the whole word, which every
// candidate pass scans again, and the filter's cost on one long word already
// grows with about the square of its length (the review of, P2-1;
//). Before a review note neither was read, so such a word
// is matched as it was then. A word here is always a READING_WORD run
// (letters, marks and digits), so punctuation splits a URL or an e-mail
// address into short words and a name inside it is still read (the review of
//, P2-1). The mixed I-or-l choices apply it only to a run that holds a
// look-alike of "l", and cap the whole token at MIXED_L_TOKEN_MAX (tooling
// ledger item 290).
export const READING_WORD_MAX = 64;
const readable = (word) => word.length <= READING_WORD_MAX || [...word].length <= READING_WORD_MAX;
// A whitespace-separated token, as the mixed I-or-l reading varies it. Only
// the look-alikes of "l" are varied, so a run of more than READING_WORD_MAX
// letters and digits stops the reading only when it holds such a look-alike
// itself: a name beside a long session id, hash or signature in the same URL
// keeps its reading, while a long run of
// look-alikes is read as before a review note, at that cost. Every token is
// capped at MIXED_L_TOKEN_MAX characters, far above any practical URL,
// because each of up to 16 variants copies the whole token (the review of
//: without a cap one long token brings the square-of-length cost back).
export const MIXED_L_TOKEN_MAX = 2048;
const holdsLookAlikeL = (run) => [...run].some((character) => LOOK_ALIKE_LETTERS.get(character) === "l");
const readableToken = (token) => token.length <= READING_WORD_MAX
  || ([...token].length <= MIXED_L_TOKEN_MAX && (token.match(READING_WORD) ?? []).every((run) => readable(run) || !holdsLookAlikeL(run)));

// (a) In a word that has both letters and digits, 0 read as o, and 1 read as
// i (one reading) or l (the other). No other digit is read, and a word of
// digits alone is never read.
function digitReadings(value) {
  return ["i", "l"].map((one) => value.replace(READING_WORD, (word) => (
    readable(word) && /\p{L}/u.test(word) && /[01]/.test(word) ? word.replace(/0/g, "o").replace(/1/g, one) : word
  )));
}

// (b) A Latin capital I that follows a lowercase letter in the same word,
// read as l ("QuiIl" as "Quill"). An I that starts a word, and the I of an
// all-capitals word, are left as written. The lowercase letter and the I are
// both in one READING_WORD, so reading word by word changes nothing but the
// length limit.
function capitalIReading(value) {
  return value.replace(READING_WORD, (word) => (readable(word) ? word.replace(/(?<=\p{Ll}\p{M}*)I/gu, "l") : word));
}

// (e) A word with two to four letters the look-alike data reads as "l", read
// with every choice of I or l for each of them (McIlroy written with two
// palochkas needs I then l); the other words of the value keep the
// positional reading.
//
// Each variant is built only within MIXED_L_WINDOW words on each side of the
// varied word, never the whole value: the exclusion candidates are runs of at
// most five words or tokens, so a wider reading adds nothing, and a whole-value
// reading per mask made the cost grow with the square of the value's length
// (the review of, P1-2). A word with nothing to vary is skipped, and so
// is one longer than MIXED_L_TOKEN_MAX or holding a run over READING_WORD_MAX
// that has a look-alike of "l" in it; a longer URL, e-mail address or
// hyphenated string is read, a long id or hash in it included.
const MIXED_L_WINDOW = 4;
function mixedLReadings(value) {
  const readings = [];
  // Words at even indexes, the whitespace between them at odd ones.
  const parts = text(value).split(/(\s+)/);
  let folded = null;
  for (let k = 0; k < parts.length; k += 2) {
    const word = parts[k];
    if (!readableToken(word)) continue;
    const count = [...word].filter((character) => LOOK_ALIKE_LETTERS.get(character) === "l").length;
    if (count < 2 || count > LOOK_ALIKE_L_MAX) continue;
    const variants = new Set();
    for (let mask = 0; mask < 2 ** count; mask += 1) {
      let index = 0;
      const lReading = () => ((mask >> index++) & 1 ? "I" : "l");
      const reading = foldLookAlikes(word, { lReading });
      if (reading !== word) variants.add(reading);
    }
    if (!variants.size) continue;
    folded ??= parts.map((part, index) => (index % 2 ? part : foldLookAlikes(part)));
    const before = folded.slice(Math.max(0, k - (2 * MIXED_L_WINDOW)), k).join("");
    const after = folded.slice(k + 1, k + 1 + (2 * MIXED_L_WINDOW)).join("");
    for (const variant of variants) readings.push(`${before}${variant}${after}`);
  }
  return readings;
}

/**
 * Detection only, for the exclusion list (F9): every reading lookAlikeReadings
 * gives a value, and for each of them the a review note readings: digits 0 and 1
 * in a word of letters and digits, and a capital I after a lowercase letter;
 * plus every I-or-l choice for a word with two to four look-alikes of l. The
 * readings are not combined with each other.
 */
export function exclusionReadings(value) {
  const readings = lookAlikeReadings(value);
  for (const reading of [...readings]) {
    for (const extra of [...digitReadings(reading), capitalIReading(reading)]) readings.add(extra);
  }
  for (const extra of mixedLReadings(value)) readings.add(extra);
  return readings;
}

/** True when a string carries an email address or a phone number. */
export function containsContactPattern(value, { url = false } = {}) {
  if (typeof value !== "string" || value.length === 0) return false;
  // For detection only, the patterns run on two readings of the value and a
  // hit on either counts: the value as written (percent-decoded for a URL),
  // and its NFKC fold with every default-ignorable character removed, so
  // that fullwidth forms and invisible characters cannot disguise a contact.
  // Neither reading replaces the other: the fold turns a superscript or
  // circled digit next to a number into a plain digit, and removing an
  // invisible character can glue a digit onto a number, and either would
  // hide a number from the digit-only boundary guards. The value itself is
  // not changed.
  const written = url ? safeDecode(value) : value;
  const folded = written.normalize("NFKC").replace(IGNORABLE_PATTERN, "");
  const rawPlus = url ? value.replace(/%2B/gi, "+") : null;
  for (const subject of folded === written ? [written] : [written, folded]) {
    if (EMAIL_PATTERN.test(subject) || OBFUSCATED_EMAIL_PATTERN.test(subject)) return true;
    if (CONTACT_SCHEME_PATTERN.test(subject)) return true;
    if (url) {
      if (PHONE_PATTERN.test(subject) || URL_SEGMENT_PHONE_PATTERN.test(subject)) return true;
      if (URL_COUNTRY_CODE_PHONE_PATTERN.test(subject) || E164_PATTERN.test(subject)) return true;
    } else if (TEXT_PHONE_PATTERN.test(subject) || BARE_PHONE_PATTERN.test(subject)
      || COUNTRY_CODE_PHONE_PATTERN.test(subject) || E164_PATTERN.test(subject)) {
      return true;
    }
  }
  return url && (URL_COUNTRY_CODE_PHONE_PATTERN.test(rawPlus) || E164_PATTERN.test(rawPlus));
}

/** Splits free text into sentences and drops every one with election-result wording. */
export function dropElectionSentences(value) {
  const pieces = value.split(/(?<=[.!?;])\s+/);
  const kept = pieces.filter((piece) => !ELECTION_RESULT_PATTERN.test(piece));
  return { text: kept.join(" ").trim(), removed: pieces.length - kept.length };
}

// NFKD leaves these Latin letters intact. Both name readings use the same
// transliteration after lowercasing, so their capitals need no second table.
const NAME_TRANSLITERATIONS = Object.freeze({
  ø: "o", ł: "l", đ: "d", æ: "ae", œ: "oe", ß: "ss", þ: "th", ð: "d",
});
const transliterateNameLetters = (value) => value.replace(/[øłđæœßþð]/gu, (letter) => NAME_TRANSLITERATIONS[letter]);
const LISTED_NAME_DIGRAPHS = Object.freeze({ ö: "oe", ä: "ae", ü: "ue", ø: "oe", å: "aa", æ: "ae", œ: "oe" });
// Add a reading only while collecting a listed name. Text and canonical
// tokens keep their existing fold: a listed Mueller does not become Muller.
const listedNameReadings = (name) => typeof name !== "string" ? [] : [...new Set([
  name, name.normalize("NFC").replace(/[öäüøåæœ]/giu, (letter) => LISTED_NAME_DIGRAPHS[letter.toLowerCase()]),
])];

/**
 * Lowercase, accent-free word tokens; apostrophes of every kind vanish first
 * (O'Brien, O’Brien, OʼBrien and O´Brien are all "obrien"), again after the
 * compatibility fold (so any character that folds into one vanishes too), and
 * so does every default-ignorable character.
 */
function transliteratedNameTokens(value) {
  return transliterateNameLetters(text(value)
    .replace(APOSTROPHE_PATTERN, "")
    .normalize("NFKD")
    .replace(APOSTROPHE_PATTERN, "")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(IGNORABLE_PATTERN, "")
    .toLowerCase())
    .match(/[a-z0-9]+/g) ?? [];
}

// Frozen exclusion-list hash recipe: keep Main's exact tokenization available.
function exclusionRecipeNameTokens(value) {
  return text(value)
    .replace(APOSTROPHE_PATTERN, "")
    .normalize("NFKD")
    .replace(APOSTROPHE_PATTERN, "")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(IGNORABLE_PATTERN, "")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

// Preserve the public canonical recipe for existing hash/identity callers.
export function nameTokens(value) {
  return exclusionRecipeNameTokens(value);
}

const nameTokenReadings = (value) => {
  const main = exclusionRecipeNameTokens(value);
  const added = transliteratedNameTokens(value);
  return main.join(" ") === added.join(" ") ? [main] : [main, added];
};

// Every combining mark, of any block (U+0300-U+036F are only the common ones).
const COMBINING_MARK = /\p{M}/gu;
// A separator inside a word that is never read as an apostrophe: whitespace,
// a dash, and URL and sentence punctuation.
const STRUCTURAL_SEPARATOR = /[\s\p{Pd}/.:?=&#_@,;+%|\\()[\]{}<>!*~$^]/u;
// The longest token run detectionRuns yields (personNameVariants' five), and
// the most separators one run may read as apostrophes.
const DETECTION_TOKENS = 5;
const DETECTION_JOINS = 3;
// A contraction or possessive ending ("don't", "Ray's", "we'll", "they're",
// "we've") or any single letter. After an apostrophe read as a break it is
// never a token of a name, so "don't" never reads as the name "Don T".
const APOSTROPHE_ENDING = /^(?:[a-z]|ll|re|ve)$/;

/**
 * Detection only: never an exported value, a key or a hash. Every run of one
 * to five name tokens under which a name may be written in a value, read
 * after the compatibility fold with every combining mark (of any block) and
 * every default-ignorable character removed. A single character between two
 * letters or digits that is not structural (STRUCTURAL_SEPARATOR) may be an
 * apostrophe, so each one is read both joined ("o fixtureperson" and
 * "ofixtureperson") and as a break, except that a break never makes a token
 * of an APOSTROPHE_ENDING after it. A possessive needs no rule of its own:
 * the run up to its apostrophe is the name. This closes
 * the class of apostrophe-like characters instead of listing them. Shared by
 * the same-record scrub (F8) and the exclusion list (F9).
 */
export function detectionRuns(value, { pairs = false } = {}) {
  const reading = text(value).normalize("NFKD").toLowerCase().normalize("NFKD")
    .replace(COMBINING_MARK, "")
    .replace(IGNORABLE_PATTERN, "");
  const out = detectionRunsForReading(reading, pairs);
  const added = transliterateNameLetters(reading);
  if (added !== reading) for (const run of detectionRunsForReading(added, pairs)) out.add(run);
  return out;
}

function detectionRunsForReading(reading, pairs) {
  const runs = [];
  const joinable = [];
  const apostrophe = [];
  let end = 0;
  for (const match of reading.matchAll(/[a-z0-9]+/g)) {
    if (runs.length) {
      const separator = reading.slice(end, match.index);
      // (d) For the exclusion list (F9, pairs), two non-structural characters
      // in a row are read as one joinable separator too ("Fixture\u00B7\u00B7person",
      // The apostrophe rule, which also decides the contraction endings
      // below, stays the single-character one, so a pair only adds join
      // readings and never removes a break (the review of, P1-1).
      const characters = [...separator];
      const single = characters.length === 1 && !STRUCTURAL_SEPARATOR.test(separator);
      apostrophe.push(single);
      joinable.push(single || (pairs && characters.length === 2
        && characters.every((character) => !STRUCTURAL_SEPARATOR.test(character))));
    }
    runs.push(match[0]);
    end = match.index + match[0].length;
  }
  // ending[i]: runs[i] is an ending that follows an apostrophe-like character.
  const ending = runs.map((run, i) => i > 0 && apostrophe[i - 1] && APOSTROPHE_ENDING.test(run));
  const out = new Set();
  const walk = (i, tokens, current, joins) => {
    out.add(tokens.length ? `${tokens.join(" ")} ${current}` : current);
    if (i + 1 >= runs.length) return;
    if (joinable[i] && joins < DETECTION_JOINS) walk(i + 1, tokens, current + runs[i + 1], joins + 1);
    if (tokens.length + 1 < DETECTION_TOKENS && !ending[i + 1]) walk(i + 1, [...tokens, current], runs[i + 1], joins);
  };
  for (let i = 0; i < runs.length; i += 1) if (!ending[i]) walk(i, [], runs[i], 0);
  return out;
}

const HONORIFICS = new Set(["jr", "sr", "ii", "iii", "iv", "dr", "mr", "mrs", "ms", "miss", "rev", "hon", "esq", "phd", "md", "rn", "lpn"]);
// A "name" that carries one of these words is an organization or a place, not
// a person; OLMS contact fields sometimes hold the filer's own name.
const ORGANIZATION_WORDS = new Set([
  "local", "union", "council", "district", "lodge", "chapter", "association", "federation", "employees",
  "workers", "afl", "cio", "afscme", "seiu", "usw", "ibew", "uaw", "aft", "nea", "teamsters", "ufcw",
  "alpa", "carpenters", "international", "brotherhood", "guild", "department", "division", "region",
  "unit", "committee", "center", "services", "university", "college", "school", "county", "city",
  "state", "hospital", "company", "inc", "corp", "llc", "office", "board", "staff", "members", "retirees",
]);

/**
 * The token runs under which a person's name may appear in text. A name with
 * an apostrophe is read both joined and split there ("Pat O'Quill" is "pat
 * oquill" and "pat o quill"), so the text "Pat O Quill" and the e-mail local
 * part "quill" are found too.
 */
export function personNameVariants(name) {
  return [...new Set([exclusionRecipeNameTokens, transliteratedNameTokens]
    .flatMap((tokens) => personVariantsWithTokens(name, tokens)))];
}

function personVariantsWithTokens(name, tokenize) {
  if (typeof name !== "string") return [];
  // Every apostrophe becomes ASCII before the fold, which would otherwise turn
  // an acute accent into a space and a combining mark; then every combining
  // mark goes, of any block, as in detectionRuns.
  let raw = name.replace(APOSTROPHE_PATTERN, "'").normalize("NFKD").replace(COMBINING_MARK, "").normalize("NFKC").replace(/\([^)]*\)/g, " ").trim();
  if (!raw || /[0-9@]/.test(raw) || VACANT_NAME_PATTERN.test(raw)) return [];
  const commas = raw.split(",");
  if (commas.length === 2 && commas[1].trim()) raw = `${commas[1]} ${commas[0]}`;
  const usable = (tokens) => tokens.length >= 2 && tokens.length <= 5 && !tokens.some((t) => ORGANIZATION_WORDS.has(t));
  const joined = tokenize(raw).filter((t) => !HONORIFICS.has(t));
  if (!usable(joined)) return [];
  const split = tokenize(raw.replace(APOSTROPHE_PATTERN, " ")).filter((t) => !HONORIFICS.has(t));
  const variants = new Set();
  for (const tokens of usable(split) ? [joined, split] : [joined]) {
    variants.add(tokens.join(" "));
    variants.add(`${tokens[0]} ${tokens[tokens.length - 1]}`);
    variants.add(tokens.filter((t, i) => i === 0 || i === tokens.length - 1 || t.length > 1).join(" "));
  }
  return [...variants];
}

function digitsOf(value) {
  return text(value).replace(/\D/g, "");
}

/**
 * Everything the filter needs to know about the people one record lists, so
 * that no free-text field, URL or contact value can carry them out. Built
 * from every person field (F4), including the OLMS signatories and contact.
 */
export class RecordPeople {
  constructor() {
    this.byFirstToken = new Map();
    this.variants = new Set();
    this.tokens = new Set();
    this.emails = new Set();
    this.phones = new Set();
    // The last seven digits of every listed phone of seven digits or more,
    // for an international number (sharesPhoneTail).
    this.phoneTails = new Set();
    // Each listed name as a handle pattern over letters only (handleNamesPerson).
    this.handles = [];
    // Set for a record outside the United States (buildOrganization): its
    // URLs are also checked for the last seven digits of a listed phone.
    this.international = false;
  }

  addName(name) {
    const variants = [...new Set(listedNameReadings(name).flatMap(personNameVariants))];
    if (variants.length) this.addHandle(variants);
    for (const variant of variants) {
      this.variants.add(variant);
      const parts = variant.split(" ");
      const list = this.byFirstToken.get(parts[0]) ?? [];
      if (!list.some((existing) => existing.join(" ") === variant)) {
        list.push(parts);
        this.byFirstToken.set(parts[0], list);
      }
      for (const part of parts) if (part.length >= 3) this.tokens.add(part);
    }
  }

  addEmail(value) {
    for (const email of text(value).match(EMAIL_GLOBAL) ?? []) this.emails.add(email.toLowerCase());
  }

  /**
   * The handle forms of one listed name, as one pattern over a URL's letters:
   * its name tokens joined in order or in reverse, and first and last name
   * joined either way with at most one letter (a middle initial) between
   * them. "Rosa Fixtureperson" matches rosafixtureperson, RosaFixtureperson,
   * fixtureperson.rosa and rosa.f.fixtureperson. A name whose first and last
   * tokens make fewer than six letters is too short to tell from a word.
   */
  addHandle(variants) {
    const forms = new Set();
    for (const variant of variants) {
      const tokens = variant.split(" ").filter((token) => /^[a-z]+$/.test(token));
      if (tokens.length < 2) continue;
      const first = tokens[0];
      const last = tokens[tokens.length - 1];
      if (first.length + last.length < 6) continue;
      forms.add(tokens.join(""));
      forms.add([...tokens].reverse().join(""));
      forms.add(`${first}[a-z]?${last}`);
      forms.add(`${last}[a-z]?${first}`);
    }
    if (forms.size) this.handles.push(new RegExp([...forms].join("|")));
  }

  /**
   * True when a URL, read after its scheme as letters only (percent-decoded,
   * compatibility-folded, every mark removed, lowercased), carries a handle
   * form of a listed person's name (addHandle). Catches a personal profile
   * whose handle joins or reorders the name, which the word-run check
   * (containsName) cannot split.
   */
  handleNamesPerson(url) {
    if (this.handles.length === 0) return false;
    for (const reading of lookAlikeReadings(safeDecode(text(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")))) {
      const folded = reading
        .replace(APOSTROPHE_PATTERN, "").normalize("NFKD").replace(COMBINING_MARK, "").replace(IGNORABLE_PATTERN, "")
        .toLowerCase();
      const letters = new Set([folded.replace(/[^a-z]/g, ""), transliterateNameLetters(folded).replace(/[^a-z]/g, "")]);
      if ([...letters].some((value) => this.handles.some((pattern) => pattern.test(value)))) return true;
    }
    return false;
  }

  addPhone(value) {
    const digits = digitsOf(value);
    if (digits.length >= 10) this.phones.add(digits.slice(-10));
    if (digits.length >= 7) this.phoneTails.add(digits.slice(-7));
  }

  /**
   * B18, for an international number: true when its last seven digits are
   * the last seven of any listed person's phone. A person's number written
   * nationally (a trunk 0, no country code) and the same number in E.164
   * share those digits, so either spelling is caught; an unrelated office
   * number that happens to share them is dropped too, which fails closed.
   */
  sharesPhoneTail(value) {
    const digits = digitsOf(value);
    return digits.length >= 7 && this.phoneTails.has(digits.slice(-7));
  }

  /**
   * Any seven-digit window of every digit in the value, joined across any
   * separator: a registry token holding a listed number among other digits
   * (MX-5555-0161-99, 33_5555_0161_9) is that person's.
   */
  containsPhoneTailDigits(value) {
    if (this.phoneTails.size === 0) return false;
    const digits = digitsOf(value);
    for (let i = 0; i + 7 <= digits.length; i += 1) if (this.phoneTails.has(digits.slice(i, i + 7))) return true;
    return false;
  }

  /** containsPersonPhone for international numbers: any seven-digit window of a joined digit run. */
  containsPhoneTail(value) {
    if (this.phoneTails.size === 0) return false;
    for (const run of text(value).split(/[^\d\s().,/+-]+/)) {
      const digits = run.replace(/\D/g, "");
      for (let i = 0; i + 7 <= digits.length; i += 1) {
        if (this.phoneTails.has(digits.slice(i, i + 7))) return true;
      }
    }
    return false;
  }

  addPerson(person) {
    if (!isPlainObject(person)) return;
    this.addName(person.name);
    this.addName(person.person);
    this.addEmail(person.email);
    this.addPhone(person.phone);
  }

  /**
   * True when a listed person's name appears as a whole-word run in the value,
   * also with every possessive 's removed (before and after the compatibility
   * fold), so "Pat Quill's office" carries "pat quill" and not "pat quills",
   * or as one of its detectionRuns.
   */
  containsName(value) {
    if (this.byFirstToken.size === 0) return false;
    const written = text(value).replace(IGNORABLE_PATTERN, "");
    const readings = new Set([written, written.replace(POSSESSIVE_PATTERN, ""), written.normalize("NFKC").replace(POSSESSIVE_PATTERN, "")]);
    //: each reading again with look-alike letters read as Latin.
    for (const reading of [...readings]) for (const folded of lookAlikeReadings(reading)) readings.add(folded);
    for (const reading of readings) {
      for (const tokens of nameTokenReadings(reading)) {
        for (let i = 0; i < tokens.length; i += 1) {
          const candidates = this.byFirstToken.get(tokens[i]);
          if (!candidates) continue;
          for (const parts of candidates) {
            let hit = true;
            for (let j = 1; j < parts.length; j += 1) {
              if (tokens[i + j] !== parts[j]) {
                hit = false;
                break;
              }
            }
            if (hit) return true;
          }
        }
      }
    }
    for (const subject of lookAlikeReadings(value)) {
      for (const run of detectionRuns(subject)) if (this.variants.has(run)) return true;
    }
    return false;
  }

  /** True when an email local part carries a token of a listed person's name (F6). */
  localPartNamesPerson(localPart) {
    // Keep Main's raw segments (including apostrophe breaks), then add the fold.
    const segments = new Set([
      ...text(localPart).toLowerCase().split(/[^a-z]+/),
      ...transliteratedNameTokens(localPart).join(" ").split(/[^a-z]+/),
    ].filter(Boolean));
    for (const segment of segments) {
      if (this.tokens.has(segment)) return true;
      for (const token of this.tokens) if (token.length >= 4 && segment.includes(token)) return true;
    }
    return false;
  }

  isPersonEmail(value) {
    return this.emails.has(text(value).trim().toLowerCase());
  }

  isPersonPhone(value) {
    const digits = digitsOf(value);
    return digits.length >= 10 && this.phones.has(digits.slice(-10));
  }

  /**
   * True when a listed person's phone appears anywhere in the value, in any
   * spelling: every run of digits joined across spaces, parentheses, dots,
   * commas, slashes and dashes (but not across letters, so a street number
   * and a ZIP code do not join) is read in every ten-digit window.
   */
  containsPersonPhone(value) {
    if (this.phones.size === 0) return false;
    for (const run of text(value).split(/[^\d\s().,/-]+/)) {
      const digits = run.replace(/\D/g, "");
      for (let i = 0; i + 10 <= digits.length; i += 1) {
        if (this.phones.has(digits.slice(i, i + 10))) return true;
      }
    }
    return false;
  }
}

/**
 * F10: every email and phone listed for any person in any record. A contact
 * value equal to one of these is a person's contact wherever it appears, so
 * no organization contact may carry it, even in a different record.
 */
export function collectPersonContacts(enriched) {
  const sink = new RecordPeople();
  const addPerson = (person) => {
    if (!isPlainObject(person)) return;
    sink.addEmail(person.email);
    sink.addPhone(person.phone);
  };
  for (const record of Object.values(enriched)) {
    if (!isPlainObject(record)) continue;
    for (const person of Array.isArray(record.leaders) ? record.leaders : []) addPerson(person);
    const olms = isPlainObject(record.olms) ? record.olms : {};
    for (const signatory of Array.isArray(olms.signatories) ? olms.signatories : []) addPerson(signatory);
    for (const body of [record.regionalBody, record.stateBody]) {
      if (isPlainObject(body)) addPerson(body.leader);
    }
    for (const subunit of Array.isArray(record.subunits) ? record.subunits : []) {
      if (!isPlainObject(subunit)) continue;
      for (const key of ["leaders", "board", "stewards", "staff"]) {
        for (const person of Array.isArray(subunit[key]) ? subunit[key] : []) addPerson(person);
      }
    }
  }
  return sink;
}

/** Collects the people a research record lists, at every level (F4, F8, F10). */
export function collectRecordPeople(record) {
  const people = new RecordPeople();
  if (!isPlainObject(record)) return people;
  for (const person of Array.isArray(record.leaders) ? record.leaders : []) people.addPerson(person);
  for (const office of Array.isArray(record.offices) ? record.offices : []) {
    if (isPlainObject(office)) people.addName(office.person);
  }
  const olms = isPlainObject(record.olms) ? record.olms : {};
  people.addName(olms.contact);
  for (const signatory of Array.isArray(olms.signatories) ? olms.signatories : []) {
    if (!isPlainObject(signatory)) continue;
    people.addName(signatory.name);
    people.addPhone(signatory.phone);
  }
  for (const body of [record.regionalBody, record.stateBody]) {
    if (isPlainObject(body) && isPlainObject(body.leader)) people.addPerson(body.leader);
  }
  for (const subunit of Array.isArray(record.subunits) ? record.subunits : []) {
    if (!isPlainObject(subunit)) continue;
    for (const key of ["leaders", "board", "stewards", "staff"]) {
      for (const person of Array.isArray(subunit[key]) ? subunit[key] : []) people.addPerson(person);
    }
  }
  return people;
}

/** A spelling match only nominates a field for the reviewed provenance gate. */
export function createShortNameMatcher(record) {
  const names = [];
  const list = (value) => Array.isArray(value) ? value : [];
  const addName = (name) => { if (typeof name === "string") names.push(...listedNameReadings(name)); };
  const addPerson = (person) => {
    if (!isPlainObject(person)) return;
    addName(person.name);
    addName(person.person);
  };
  for (const person of list(record.leaders)) addPerson(person);
  for (const office of list(record.offices)) addName(office?.person);
  addName(record.olms?.contact);
  for (const person of list(record.olms?.signatories)) addName(person?.name);
  for (const body of [record.regionalBody, record.stateBody]) addPerson(body?.leader);
  for (const subunit of list(record.subunits)) {
    for (const key of ["leaders", "board", "stewards", "staff"]) {
      for (const person of list(subunit?.[key])) addPerson(person);
    }
  }
  const folds = (value) => {
    const main = value.normalize("NFKD").replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "").toLowerCase();
    return [...new Set([main, transliterateNameLetters(main)])];
  };
  const tokens = (value) => folds(value).map((reading) => reading.replace(/['’]/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const pairs = new Map();
  const reversedPairs = new Map();
  for (const name of names) {
    if (/[0-9@]/u.test(name)) continue;
    const commas = name.split(",");
    const reordered = commas.length === 2 ? `${commas[1]} ${commas[0]}` : name;
    for (const parts of tokens(reordered.replace(/\([^)]*\)/gu, " ")).map((reading) => reading.filter((part) => !HONORIFICS.has(part)))) {
      if (parts.length < 2) continue;
      // The legacy full-name matcher has a five-token scope. Longer listed
      // names still nominate short forms under the same vacancy/word rules.
      const usable = parts.length > 5
        ? !VACANT_NAME_PATTERN.test(name) && !parts.some((part) => ORGANIZATION_WORDS.has(part))
        : personNameVariants(name).length > 0;
      if (!usable && !parts.some((part) => [...part].some((letter) => letter.codePointAt(0) > 127))) continue;
      for (const last of parts.slice(1)) {
        // Forward two-token forms already enter the legacy full-name veto.
        // Reversed text needs the same reviewed attribution as short names.
        if (parts.length >= 3) pairs.set(`${parts[0]} ${last}`, [parts[0], last]);
        reversedPairs.set(`${last} ${parts[0]}`, [last, parts[0]]);
      }
    }
  }
  const people = new RecordPeople();
  for (const pair of pairs.values()) people.addName(pair.join(" "));
  const reversedPeople = new RecordPeople();
  for (const pair of reversedPairs.values()) reversedPeople.addName(pair.join(" "));
  const handles = [...pairs.values()].flatMap(([first, last]) => [first + last, last + first]);
  return (value, { url = false } = {}) => {
    if (pairs.size === 0 && reversedPairs.size === 0) return false;
    const decoded = url ? safeDecode(value) : value;
    const words = tokens(decoded);
    if ([...pairs.values()].some(([first, last]) => words.some((reading) => reading.some((word, i) => word === first && reading[i + 1] === last)))) return true;
    if (people.containsName(decoded)) return true;
    if (!url) return [...reversedPairs.values()].some(([last, first]) => words.some((reading) => reading.some((word, i) => word === last && reading[i + 1] === first)))
      || reversedPeople.containsName(decoded);
    if (people.handleNamesPerson(value)) return true;
    const letters = folds(decoded).map((reading) => reading.replace(/[^\p{L}]/gu, ""));
    return handles.some((handle) => letters.some((reading) => reading.includes(handle)));
  };
}

function shortNamePrivacy(release, options, state, report) {
  return applyShortNamePrivacy(release, {
    enriched: options.enriched,
    idMap: Object.fromEntries([...state.identities].map(([id, identity]) => [id, identity.catalogKey])),
    matcherFor: createShortNameMatcher,
    evidence: options.shortNameEvidence,
    report,
    searchTextFor: (row) => buildSearchText([
      row.name, ...row.aka, row.family,
      row.designation && row.local_number ? `${row.designation} ${row.local_number}` : row.designation,
      row.local_number ? `local ${row.local_number}` : null, row.city, row.state, row.org_type_label,
    ]),
  });
}

// ---------------------------------------------------------------- URLs and domains

export const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "org.au", "net.au", "co.nz", "org.nz", "com.mx", "co.za",
]);

/** An approximation of the registrable domain (eTLD+1), without a public-suffix dependency. */
export function registrableDomain(host) {
  const h = text(host).toLowerCase().replace(/\.$/, "");
  if (!h || /^[0-9.]+$/.test(h) || h.includes(":")) return null;
  const labels = h.split(".");
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  // <name>.<state>.us locality domains, for example county.ma.us
  if (labels.length >= 3 && labels.at(-1) === "us" && labels.at(-2).length === 2) return labels.slice(-3).join(".");
  return lastTwo;
}

// B18: the second-level public suffixes of the Americas' country-code
// domains (a reviewed subset of the Public Suffix List, ICANN section),
// read only for a body outside the United States, so an org.br or com.ar
// site is its own registrable domain and not the whole suffix. The U.S.
// path, and the claim domain check mirrored in SQL
// (private.catalog_registrable_domain), keep MULTI_LABEL_SUFFIXES exactly.
const AMERICAS_SECOND_LEVEL = Object.freeze({
  ar: ["com", "edu", "gob", "gov", "int", "mil", "net", "org", "tur"],
  bb: ["com", "edu", "gov", "net", "org"],
  bo: ["com", "edu", "gob", "int", "mil", "net", "org", "tv"],
  br: ["adv", "art", "com", "coop", "edu", "gov", "ind", "net", "org"],
  bs: ["com", "edu", "gov", "net", "org"],
  bz: ["com", "edu", "gov", "net", "org"],
  ca: ["ab", "bc", "gc", "mb", "nb", "nf", "nl", "ns", "nt", "nu", "on", "pe", "qc", "sk", "yk"],
  cl: ["co", "gob", "gov", "mil"],
  co: ["com", "edu", "gov", "mil", "net", "nom", "org"],
  cr: ["ac", "co", "ed", "fi", "go", "or", "sa"],
  cu: ["com", "edu", "gov", "inf", "net", "org"],
  do: ["art", "com", "edu", "gob", "gov", "mil", "net", "org", "sld", "web"],
  ec: ["com", "edu", "fin", "gob", "gov", "info", "med", "mil", "net", "org", "pro"],
  gt: ["com", "edu", "gob", "ind", "mil", "net", "org"],
  gy: ["co", "com", "edu", "gov", "net", "org"],
  hn: ["com", "edu", "gob", "mil", "net", "org"],
  ht: ["com", "edu", "net", "org"],
  mx: ["com", "edu", "gob", "net", "org"],
  ni: ["com", "edu", "gob", "net", "org"],
  pa: ["abo", "ac", "com", "edu", "gob", "ing", "med", "net", "nom", "org", "sld"],
  pe: ["com", "edu", "gob", "mil", "net", "nom", "org"],
  py: ["com", "coop", "edu", "gov", "net", "org"],
  sv: ["com", "edu", "gob", "org", "red"],
  tt: ["co", "com", "edu", "gov", "net", "org"],
  uy: ["com", "edu", "gub", "mil", "net", "org"],
  ve: ["co", "com", "edu", "gob", "net", "org"],
});
export const AMERICAS_PUBLIC_SUFFIXES = Object.freeze(new Set(
  Object.entries(AMERICAS_SECOND_LEVEL).flatMap(([tld, labels]) => labels.map((label) => `${label}.${tld}`)),
));

/**
 * registrableDomain for a body outside the United States: the same rules,
 * plus AMERICAS_PUBLIC_SUFFIXES (so "sindicato.org.br" and not "org.br").
 */
export function internationalRegistrableDomain(host) {
  const h = text(host).toLowerCase().replace(/\.$/, "");
  if (AMERICAS_PUBLIC_SUFFIXES.has(h)) return null;
  const labels = h.split(".");
  if (labels.length >= 3 && AMERICAS_PUBLIC_SUFFIXES.has(labels.slice(-2).join(".")) && registrableDomain(h)) {
    return labels.slice(-3).join(".");
  }
  return registrableDomain(h);
}

/**
 * B18: an office phone of a body outside the United States, as E.164: a plus,
 * a country code and 8 to 15 digits in all, written with spaces, dots,
 * dashes, slashes or one parenthesized group. A number without its country
 * code is not guessed from the body's country; it returns null.
 */
export function e164Phone(value) {
  const v = collapse(text(value));
  if (!/^\+[1-9][0-9 ()./‐-―-]*[0-9]$/.test(v)) return null;
  if ((v.match(/\(/g) ?? []).length > 1 || (v.match(/\(/g) ?? []).length !== (v.match(/\)/g) ?? []).length) return null;
  const digits = digitsOf(v);
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The first http(s) URL inside a source string that may hold several, plus notes (F13). */
export function firstHttpUrl(value) {
  const match = text(value).match(URL_IN_TEXT);
  return match ? match[0].replace(/[.]+$/, "") : null;
}

/** Scheme and host lowercased, default port and fragment removed. The basis of document keys. */
export function normalizeUrl(value) {
  const parsed = new URL(value);
  parsed.hash = "";
  return parsed.href;
}

// ---------------------------------------------------------------- normalization (F13)

/** `sector`: Private/Mixed/Public lowercased, Federal -> public, anything else null. */
export function normalizeSector(value) {
  const v = text(value).trim().toLowerCase();
  if (v === "private" || v === "public" || v === "mixed") return { value: v };
  if (v === "federal") return { value: "public" };
  return { value: null, dropped: v ? "unknown_sector" : null };
}

/** `state`: two capital letters; the "00" filler becomes null ("State not recorded"). */
export function normalizeState(value) {
  const v = text(value).trim();
  if (v === "00") return { value: null, dropped: "not_recorded" };
  if (/^[A-Z]{2}$/.test(v)) return { value: v };
  return { value: null, dropped: v ? "shape" : null };
}

/** `confidence`: official-site-*, secondary, olms-filing, not-found; '', unverified or missing -> unreviewed. */
export function normalizeConfidence(value) {
  const v = text(value).trim().toLowerCase().replace(/_/g, "-");
  if (v.startsWith("official-site")) return { value: "official_site" };
  if (v === "secondary") return { value: "secondary" };
  if (v === "olms-filing") return { value: "olms_filing" };
  if (v === "not-found") return { value: "not_found" };
  if (v === "" || v === "unverified" || v === "unreviewed") return { value: "unreviewed" };
  return { value: "unreviewed", dropped: "unknown_confidence" };
}

/** Research tiers onto the catalog enum (sub-local -> sub_local). */
export function normalizeTier(value) {
  const v = text(value).trim().toLowerCase().replace(/[- ]/g, "_");
  return ["national", "regional", "state", "local", "sub_local"].includes(v) ? v : null;
}

const SUBUNIT_KIND_MAP = Object.freeze({
  chapter: "chapter",
  unit: "unit",
  "bargaining unit": "bargaining_unit",
  "retiree chapter": "retiree_chapter",
  local: "local",
  district: "district",
  division: "division",
  region: "region",
  sector: "sector",
  department: "department",
  council: "council",
  committee: "committee",
});

/** Sub-unit kinds outside the §2.2 enum become `other`; the research label is kept verbatim. */
export function normalizeSubunitKind(value) {
  const label = collapse(text(value));
  const key = label.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const kind = SUBUNIT_KIND_MAP[key] ?? "other";
  return { kind, label: label || kind.replace(/_/g, " "), mapped: !SUBUNIT_KIND_MAP[key] };
}

/** Unknown document kinds, including `memorandum`, map to `other`. */
export function normalizeDocKind(value) {
  const v = text(value).trim().toLowerCase();
  return DOC_KINDS.includes(v) ? { kind: v, mapped: false } : { kind: "other", mapped: true };
}

const MONTHS = new Map(Object.entries({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
}));

function isoDate(year, month, day) {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (year < 1900 || year > 2100 || !isRealIsoDate(value)) return null;
  return value;
}

function settle(value) {
  return value ? { value, status: "ok" } : { value: null, status: "unparsed" };
}

/**
 * A research date onto YYYY-MM-DD. Month precision (2026-09, 09/2026,
 * September 2026) reads as the first of the month; a bare year or a contract
 * term ("2024-2027") is not a date and is reported as unparsed.
 */
export function parseLooseDate(value) {
  const v = collapse(text(value));
  if (!v) return { value: null, status: "empty" };
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][0-9:.+Z-]*)?$/.exec(v);
  if (m) return settle(isoDate(+m[1], +m[2], +m[3]));
  m = /^(\d{4})-(\d{2})$/.exec(v);
  if (m) return settle(isoDate(+m[1], +m[2], 1));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return settle(isoDate(+m[3], +m[1], +m[2]));
  m = /^(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return settle(isoDate(+m[2], +m[1], 1));
  m = /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/.exec(v);
  if (m && MONTHS.has(m[1].toLowerCase())) return settle(isoDate(+m[3], MONTHS.get(m[1].toLowerCase()), +m[2]));
  m = /^([A-Za-z]+)\.?,? (\d{4})$/.exec(v);
  if (m && MONTHS.has(m[1].toLowerCase())) return settle(isoDate(+m[2], MONTHS.get(m[1].toLowerCase()), 1));
  return { value: null, status: "unparsed" };
}

const NUMBER_WORDS = new Map(Object.entries({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }));
const DATE_IN_TEXT = /(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}(?![\d-])|\d{1,2}\/\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? (?:\d{1,2},? )?\d{4})/i;

/**
 * `electionCycle` is never exported as text (F8). Only the cadence survives:
 * a term length in years and the next election date, when the text states
 * them. The OLMS filing's next-election month is the fallback.
 */
export function parseElectionCycle(cycle, olmsNextElection) {
  const value = collapse(text(cycle));
  let termYears = null;
  const term = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[- ](?:year|yr)s?\b(?![- ]old)/i.exec(value)
    ?? /\bterms? of (\d{1,2}|one|two|three|four|five|six) years?\b/i.exec(value)
    ?? /\bevery (\d{1,2}|two|three|four|five|six) years\b/i.exec(value);
  if (term) {
    const raw = term[1].toLowerCase();
    termYears = NUMBER_WORDS.get(raw) ?? Number.parseInt(raw, 10);
  } else if (/\b(annual(?:ly)?|every year)\b/i.test(value)) termYears = 1;
  else if (/\bbiennial(?:ly)?\b/i.test(value)) termYears = 2;
  else if (/\btriennial(?:ly)?\b/i.test(value)) termYears = 3;
  else if (/\bquadrennial(?:ly)?\b/i.test(value)) termYears = 4;
  if (!(Number.isInteger(termYears) && termYears >= 1 && termYears <= 10)) termYears = null;

  let nextOn = null;
  const next = /\bnext\b/i.exec(value);
  if (next) {
    const date = DATE_IN_TEXT.exec(value.slice(next.index, next.index + 100));
    if (date) nextOn = parseLooseDate(date[1].replace(/,/g, "")).value;
  }
  if (!nextOn && olmsNextElection) nextOn = parseLooseDate(olmsNextElection).value;
  return { termYears, nextOn };
}

/**
 * B19: a typed date. Only a real YYYY-MM-DD, or the calendar date of an RFC
 * 3339 timestamp (Z or a numeric offset) as written, is a date; 05/06/2026 is
 * unparsed, because outside the United States it usually means June 5. No
 * month name of any language is read.
 */
export function typedIsoDate(value) {
  const v = text(value).trim();
  if (!v) return { value: null, status: "empty" };
  const m = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(v);
  return settle(m && isoDate(+m[1].slice(0, 4), +m[1].slice(5, 7), +m[1].slice(8, 10)));
}

/**
 * B19: the typed election cadence of a body outside the United States:
 * `election_term_years` (a whole number from 1 to 10) and `next_election_on`
 * (a typed date). Free cadence text, in any language, is never parsed for
 * such a body.
 */
export function typedElectionCadence(record) {
  const term = record.election_term_years;
  const termYears = Number.isInteger(term) && term >= 1 && term <= 10 ? term : null;
  return { termYears, nextOn: typedIsoDate(record.next_election_on).value };
}

// ---------------------------------------------------------------- exclusions (F9)

export function normalizeExclusionValue(value) {
  return text(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function exclusionHash(salt, value) {
  return sha256Hex(`${salt}\u0000${normalizeExclusionValue(value)}`);
}

/**
 * Keep the owner's Main-recipe hashes, adding the transliterated name form
 * alongside the normalized value. No existing list needs to be rewritten.
 */
export function exclusionHashes(salt, value) {
  const forms = new Set([normalizeExclusionValue(value), ...nameTokenReadings(value).map((tokens) => tokens.join(" "))]);
  forms.delete("");
  return [...forms].map((form) => sha256Hex(`${salt}\u0000${form}`));
}

/**
 * Parses the owner's exclusion list. Anything malformed throws: a list that
 * cannot be read protects nothing, so it fails closed.
 */
export function parseExclusionList(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("F9: the exclusion list is not valid JSON; refusing to run");
  }
  if (!isPlainObject(parsed) || parsed.schema !== EXCLUSIONS_SCHEMA) {
    throw new Error(`F9: the exclusion list must declare schema ${EXCLUSIONS_SCHEMA}; refusing to run`);
  }
  if (typeof parsed.salt !== "string" || parsed.salt.length < 16) {
    throw new Error("F9: the exclusion list salt must be a string of at least 16 characters; refusing to run");
  }
  if (!Array.isArray(parsed.hashes) || !parsed.hashes.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h))) {
    throw new Error("F9: every exclusion hash must be 64 lowercase hex characters; refusing to run");
  }
  return {
    salt: parsed.salt,
    hashes: new Set(parsed.hashes),
    fileSha256: sha256Hex(typeof raw === "string" ? raw : JSON.stringify(raw)),
  };
}

// The longest word or name-token run checked, matching personNameVariants' five tokens.
const EXCLUSION_RUN = 5;
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * The canonical strings a value is checked under (F9). Every candidate is
 * added in the normalized form and both the frozen Main-recipe and added
 * transliterated name forms: the whole value and its percent-decoded form, each of
 * those with possessive 's removed (so "Pat Quill's office" carries
 * "pat quill"; also after the compatibility fold with every default-ignorable
 * character removed), every run of one to five words of each (as written and with
 * the run's edge punctuation trimmed), every run of one to five name tokens
 * of each, every email address, every detectionRuns run of the value and of
 * its percent-decoded form, and for a URL its host and every host/path
 * prefix.
 */
export function exclusionCandidates(value) {
  const out = new Set();
  const add = (candidate) => {
    const normalized = normalizeExclusionValue(candidate);
    if (normalized) out.add(normalized);
    for (const tokens of nameTokenReadings(candidate)) if (tokens.length) out.add(tokens.join(" "));
  };
  const raw = text(value);
  if (!normalizeExclusionValue(raw)) return out;
  const subjects = new Set([raw, safeDecode(raw)]);
  for (const subject of [...subjects]) {
    subjects.add(subject.replace(POSSESSIVE_PATTERN, ""));
    subjects.add(subject.normalize("NFKC").replace(IGNORABLE_PATTERN, "").replace(POSSESSIVE_PATTERN, ""));
  }
  //: every subject again with look-alike letters read as Latin.
  for (const subject of [...subjects]) for (const folded of exclusionReadings(subject)) subjects.add(folded);
  for (const subject of subjects) {
    add(subject);
    const words = subject.split(/\s+/).filter(Boolean);
    for (let n = 1; n <= EXCLUSION_RUN; n += 1) {
      for (let i = 0; i + n <= words.length; i += 1) {
        const run = words.slice(i, i + n).join(" ");
        add(run);
        add(run.replace(EDGE_PUNCTUATION, ""));
      }
    }
    for (const tokens of nameTokenReadings(subject)) {
      for (let n = 1; n <= EXCLUSION_RUN; n += 1) {
        for (let i = 0; i + n <= tokens.length; i += 1) out.add(tokens.slice(i, i + n).join(" "));
      }
    }
    for (const email of subject.match(EMAIL_GLOBAL) ?? []) out.add(normalizeExclusionValue(email));
  }
  for (const subject of new Set([...exclusionReadings(raw), ...exclusionReadings(safeDecode(raw))])) {
    for (const run of detectionRuns(subject, { pairs: true })) out.add(run);
  }
  if (/^https?:\/\//i.test(raw.trim())) {
    try {
      const parsed = new URL(raw.trim());
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      out.add(host);
      let prefix = host;
      for (const segment of safeDecode(parsed.pathname).split("/").filter(Boolean)) {
        prefix = normalizeExclusionValue(`${prefix}/${segment}`);
        out.add(prefix);
      }
    } catch {
      // Not a URL after all; the word runs above still apply.
    }
  }
  return out;
}

export class ExclusionMatcher {
  constructor(list) {
    if (!list || !(list.hashes instanceof Set) || typeof list.salt !== "string") {
      throw new Error("F9: an exclusion list is required; refusing to run without CATALOG_EXCLUSIONS_FILE");
    }
    this.salt = list.salt;
    this.hashes = list.hashes;
    this.fileSha256 = list.fileSha256 ?? null;
    this.matchCount = 0;
    this.cache = new Map();
  }

  matches(value) {
    if (this.hashes.size === 0 || typeof value !== "string" || !value) return false;
    let hit = this.cache.get(value);
    if (hit === undefined) {
      hit = false;
      for (const candidate of exclusionCandidates(value)) {
        if (this.hashes.has(sha256Hex(`${this.salt}\u0000${candidate}`))) {
          hit = true;
          break;
        }
      }
      if (this.cache.size < 200_000) this.cache.set(value, hit);
    }
    if (hit) this.matchCount += 1;
    return hit;
  }
}

// ---------------------------------------------------------------- drop report

/** Counts only, keyed "<table>.<field>:<reason>". Never a value. */
export function createDropReport() {
  const counts = new Map();
  return {
    drop(path, reason, n = 1) {
      if (n <= 0) return;
      const key = `${path}:${reason}`;
      counts.set(key, (counts.get(key) ?? 0) + n);
    },
    get(path, reason) {
      return counts.get(`${path}:${reason}`) ?? 0;
    },
    toJSON() {
      return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
  };
}

// ---------------------------------------------------------------- keys

function hex(value, length) {
  return sha256Hex(value).slice(0, length);
}

function normalizedName(value) {
  return collapse(text(value)).toLowerCase();
}

/**
 * <catalog_key>~<kind>-<first 12 hex of sha256(file|kind|normalized name)> (§2.2).
 * A body with no federal file number hashes its own stable catalog key in the
 * file's place (B02), so every filer's existing sub-unit key is unchanged.
 */
export function subunitKey(catalogKey, fileNumber, kind, name, disambiguator = null) {
  const basis = [fileNumber ?? catalogKey, kind, normalizedName(name)];
  if (disambiguator !== null) basis.push(normalizedName(disambiguator));
  return `${catalogKey}~${kind}-${hex(basis.join("|"), 12)}`;
}

/** <catalog_key>~<first 16 hex of sha256(normalized url)> (§2.2). */
export function documentKey(catalogKey, url) {
  return `${catalogKey}~${hex(normalizeUrl(url), 16)}`;
}

/** ri- and the first 32 hex of sha256("catalog-identifier/1" NUL catalog key NUL namespace NUL identifier). */
export function identifierKey(catalogKey, namespace, identifier) {
  return `ri-${hex(`${IDENTIFIER_KEY_BASIS}\u0000${catalogKey}\u0000${namespace}\u0000${identifier}`, 32)}`;
}

/**
 * The catalog key of a directory-listed body: "ug-d" and the first 9 hex of
 * sha256("directory-listed-body/1" NUL <parent's federal file number> NUL
 * <the body's name as name tokens>). It depends only on the parent filer and
 * the listed name, so rebuilding from the same listing gives the same key, and
 * the leading "d" keeps it from ever reading as a ten-digit number.
 */
export function directoryBodyKey(parentFileNumber, name) {
  return `ug-d${hex(`${DIRECTORY_KEY_BASIS}\u0000${parentFileNumber}\u0000${nameTokens(name).join(" ")}`, 9)}`;
}

function edgeKey(childKey, kind, parentKey, parentLabel) {
  return `${childKey}~${kind}-${hex(parentKey ?? `label:${normalizedName(parentLabel)}`, 12)}`;
}

function outlineKey(scopeKey, seatClass, title) {
  return `${scopeKey}~${seatClass}-${hex(normalizedName(title), 12)}`;
}

function contactKey(catalogKey, kind, value) {
  return `${catalogKey}~${kind}-${hex(`${kind}|${normalizedName(value)}`, 12)}`;
}

// ---------------------------------------------------------------- F1 structural guard

/** F1: refuses any parsed input object that carries a key named `reference`. */
export function assertNoReferenceKey(value, label) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item !== null && typeof item === "object") stack.push(item);
    } else if (current !== null && typeof current === "object") {
      if (Object.hasOwn(current, "reference")) {
        throw new Error(`F1: ${label} carries a key named "reference"; refusing to run`);
      }
      for (const item of Object.values(current)) if (item !== null && typeof item === "object") stack.push(item);
    }
  }
}

/** F1: keeps only {id,file,parent,members,fy,aff} of each ledger record. */
export function projectLedgerRecords(records) {
  if (!isPlainObject(records)) throw new Error("Structural fault: index-data.json.records is not an object");
  const out = {};
  for (const [id, record] of Object.entries(records)) {
    if (!isPlainObject(record)) throw new Error(`Structural fault: ledger record ${id} is not an object`);
    const projected = {};
    for (const field of LEDGER_FIELDS) projected[field] = record[field] ?? null;
    out[id] = projected;
  }
  return out;
}

/** F1: keeps only the document-index metadata fields, and {orgId, subunit} of each alsoIn entry. */
export function projectDocumentIndex(index) {
  if (!isPlainObject(index) || !Array.isArray(index.documents)) {
    throw new Error("Structural fault: documents/index.json has no documents array");
  }
  return index.documents.map((doc, i) => {
    if (!isPlainObject(doc)) throw new Error(`Structural fault: documents/index.json entry ${i} is not an object`);
    const projected = {};
    // A locale field is projected only when the index states it, so a
    // document that states none inherits its body's place (localeBundle).
    for (const field of DOCUMENT_INDEX_FIELDS) {
      if (LOCALE_INPUT_FIELDS.includes(field) && !Object.hasOwn(doc, field)) continue;
      projected[field] = doc[field] ?? null;
    }
    projected.alsoIn = Array.isArray(doc.alsoIn)
      ? doc.alsoIn.filter(isPlainObject).map((entry) => ({ orgId: entry.orgId ?? null, subunit: entry.subunit ?? null }))
      : [];
    return projected;
  });
}

/**
 * F1: keeps only DIRECTORY_BODY_FIELDS of each directory-listed body, {url,
 * asOf} of each of its sources, and the builder's held-out counts (reason ->
 * whole number). Anything malformed is a structural fault.
 */
export function projectDirectoryBodies(input) {
  if (!isPlainObject(input) || input.schema !== DIRECTORY_BODIES_SCHEMA || !Array.isArray(input.bodies)) {
    throw new Error(`Structural fault: directory/listed-bodies.json is not ${DIRECTORY_BODIES_SCHEMA} with a bodies array`);
  }
  const held = {};
  for (const [reason, count] of Object.entries(isPlainObject(input.held) ? input.held : {})) {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(reason) || !Number.isInteger(count) || count < 0) {
      throw new Error("Structural fault: directory/listed-bodies.json held counts must be reason codes with whole-number counts");
    }
    held[reason] = count;
  }
  const bodies = input.bodies.map((body, i) => {
    if (!isPlainObject(body)) throw new Error(`Structural fault: directory-listed body ${i} is not an object`);
    const projected = {};
    for (const field of DIRECTORY_BODY_FIELDS) projected[field] = body[field] ?? null;
    projected.id = projected.id === null ? null : String(projected.id);
    if (!projected.id) throw new Error(`Structural fault: directory-listed body ${i} has no id`);
    projected.sources = Array.isArray(body.sources)
      ? body.sources.filter(isPlainObject).map((source) => ({ url: source.url ?? null, asOf: source.asOf ?? null }))
      : [];
    return projected;
  });
  return { held, bodies };
}

/** The first source of a directory-listed body that has an http(s) URL and a real YYYY-MM-DD as-of date. */
function datedSource(body) {
  return body.sources.find((source) => typeof source.url === "string" && /^https?:\/\/\S+$/i.test(source.url.trim())
    && typeof source.asOf === "string" && isRealIsoDate(source.asOf)) ?? null;
}

// ---------------------------------------------------------------- the filter context

function createContext(options) {
  const { exclusions, familyDomains, blockedDomains, fixtureNames = [], report = createDropReport() } = options;
  const matcher = exclusions instanceof ExclusionMatcher ? exclusions : new ExclusionMatcher(exclusions);
  const families = isPlainObject(familyDomains?.families) ? familyDomains.families : {};
  return {
    report,
    exclusions: matcher,
    families,
    blocked: blockedDomainList(blockedDomains),
    fixtureNames: new Set(fixtureNames.map((n) => normalizedName(n)).filter(Boolean)),
    realFilerNames: new Set(),
    personContacts: new RecordPeople(),
  };
}

export function blockedDomainList(blockedDomains) {
  return [
    ...(Array.isArray(blockedDomains?.consumer) ? blockedDomains.consumer : []),
    ...(Array.isArray(blockedDomains?.hosting) ? blockedDomains.hosting : []),
  ].map((d) => String(d).toLowerCase());
}

function isBlockedDomain(blocked, domain) {
  return blocked.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function familyDomainsFor(ctx, family) {
  return (Array.isArray(ctx.families[family]) ? ctx.families[family] : []).map((d) => String(d).toLowerCase());
}

/**
 * The F8 gate for one free-text value. Returns the cleaned string or null,
 * and counts the reason under `path` when it drops something.
 *   election: "sentence" drops only the sentences with election-result
 *             wording; "reject" drops the whole value; "none" skips it.
 *   names:    run the same-record person-name scrub.
 */
function scrubText(ctx, people, path, raw, { max, election = "sentence", names = true } = {}) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    ctx.report.drop(path, "not_text");
    return null;
  }
  if (hasControlCharacter(raw.replace(/[\t\n\r]/g, " ")) || BIDI_CONTROL_PATTERN.test(raw)) {
    ctx.report.drop(path, "control_character");
    return null;
  }
  let value = collapse(raw);
  if (!value) return null;
  let bare = unhidden(raw);
  if (containsContactPattern(value)) {
    ctx.report.drop(path, "contact_pattern");
    return null;
  }
  if (election === "reject" && ELECTION_RESULT_PATTERN.test(value)) {
    ctx.report.drop(path, "election_wording");
    return null;
  }
  if (election === "sentence") {
    const result = dropElectionSentences(value);
    if (result.removed > 0) ctx.report.drop(path, "election_sentence", result.removed);
    value = result.text;
    if (!value) return null;
    bare = dropElectionSentences(bare).text;
  }
  const readings = bare === value ? [value] : [value, bare];
  if (names && readings.some((reading) => people.containsName(reading))) {
    ctx.report.drop(path, "person_name");
    return null;
  }
  if (readings.some((reading) => ctx.exclusions.matches(reading))) return null;
  if (max !== undefined && charLength(value) > max) {
    ctx.report.drop(path, "too_long");
    return null;
  }
  return value;
}

/** The URL counterpart of scrubText: scheme, userinfo, contact patterns, F3, names, exclusions, length. */
function scrubUrl(ctx, people, path, raw, { max, https = false, composite = false, electionSource = false } = {}) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") {
    ctx.report.drop(path, "not_url");
    return null;
  }
  let candidate = raw.trim();
  if (!candidate) return null;
  if (composite && !/^https?:\/\/\S+$/i.test(candidate)) {
    const first = firstHttpUrl(candidate);
    if (!first) {
      ctx.report.drop(path, "not_url");
      return null;
    }
    ctx.report.drop(path, "composite_source_reduced");
    candidate = first;
  }
  if (!/^https?:\/\//i.test(candidate)) {
    ctx.report.drop(path, "not_url");
    return null;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    ctx.report.drop(path, "not_url");
    return null;
  }
  if (parsed.username || parsed.password) {
    ctx.report.drop(path, "userinfo");
    return null;
  }
  if (https && parsed.protocol !== "https:") {
    ctx.report.drop(path, "http_only");
    return null;
  }
  const href = parsed.href;
  //: a URL still encoded after every decoding pass cannot be read for a
  // name, so it is dropped.
  if (overEncoded(href)) {
    ctx.report.drop(path, "over_encoded");
    return null;
  }
  if (containsContactPattern(href, { url: true })) {
    ctx.report.drop(path, "contact_pattern");
    return null;
  }
  const decoded = safeDecode(href);
  if (electionSource && ELECTION_SOURCE_PATTERN.test(decoded)) {
    ctx.report.drop(path, "election_source");
    return null;
  }
  if (people.containsName(decoded)) {
    ctx.report.drop(path, "person_name");
    return null;
  }
  // A listed person's phone in a URL (wa.me/<number>, a number in a path),
  // from this record or any other, in any spelling the phone checks know;
  // for a record outside the United States also its last seven digits.
  if (people.containsPersonPhone(decoded) || ctx.personContacts.containsPersonPhone(decoded)
    || (people.international && (people.containsPhoneTail(decoded) || ctx.personContacts.containsPhoneTail(decoded)))) {
    ctx.report.drop(path, "person_contact");
    return null;
  }
  if (ctx.exclusions.matches(href)) return null;
  if (max !== undefined && charLength(href) > max) {
    ctx.report.drop(path, "too_long");
    return null;
  }
  return href;
}

// ---------------------------------------------------------------- locale (B07-B09)

const POSTAL_TEXT = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,31}$/u;

/**
 * True when a research row states any locale field. Only a build that
 * records locale (the country-aware research builds) states one; a body
 * from a build that does not keeps the legacy row shape, so its rows, their
 * content hashes and the release are exactly what they were.
 */
export function statesLocale(row) {
  return isPlainObject(row) && LOCALE_INPUT_FIELDS.some((field) => Object.hasOwn(row, field));
}

function localeValueValid(ctx, field, value, country) {
  if (typeof value !== "string") return false;
  if (field === "country") return validCountry(value);
  if (field === "subdivision") return typeof country === "string" && validSubdivision(value, country);
  if (field === "postal_code") return POSTAL_TEXT.test(value) && !containsContactPattern(value) && !ctx.exclusions.matches(value);
  if (field === "language") return validLanguage(value);
  return validTimezone(value);
}

/**
 * The locale bundle of one exported row: country, subdivision, postal_code,
 * language, timezone and locale_unknowns. When `source`
 * states locale, each field is read from it as evidence and validated; an
 * invalid value is dropped and counted under `<path>.<field>`, never
 * repaired or re-cased. When it states none, the fields named in `inherit`
 * come from `fallback` (the owning row's bundle) and the rest stay unknown.
 * Nothing is ever inferred from a country. Every null carries a reason: the
 * source's own when it is one of UNKNOWN_REASONS, otherwise `unconfirmed`.
 */
export function localeBundle(ctx, path, source, { fallback = null, inherit = LOCALE_FIELDS } = {}) {
  const own = statesLocale(source);
  const reasons = own && isPlainObject(source.locale_unknowns) ? source.locale_unknowns : {};
  const bundle = {};
  const unknowns = {};
  for (const field of LOCALE_FIELDS) {
    let value = null;
    let reason = "unconfirmed";
    if (own) {
      const raw = source[field] ?? null;
      if (raw !== null && localeValueValid(ctx, field, raw, bundle.country)) value = raw;
      else if (raw !== null) ctx.report.drop(`${path}.${field}`, "invalid");
      else if (UNKNOWN_REASONS.includes(reasons[field])) reason = reasons[field];
    } else if (fallback && inherit.includes(field)) {
      value = fallback[field];
      if (value === null) reason = fallback.locale_unknowns[field];
    }
    // A subdivision is only ever stated inside its own country.
    if (field === "subdivision" && value !== null && !(typeof bundle.country === "string" && validSubdivision(value, bundle.country))) {
      ctx.report.drop(`${path}.subdivision`, "invalid");
      value = null;
      reason = "unconfirmed";
    }
    bundle[field] = value;
    if (value === null) unknowns[field] = reason;
  }
  bundle.locale_unknowns = unknowns;
  return bundle;
}

/** True when a locale bundle states a valid country other than US (the international contact rules). */
function internationalCountry(locale) {
  return Boolean(locale) && typeof locale.country === "string" && locale.country !== "US" && validCountry(locale.country);
}

/** The row with its locale bundle appended, or the row unchanged when there is none. */
function withLocale(row, locale) {
  return locale ? { ...row, ...locale, locale_unknowns: { ...locale.locale_unknowns } } : row;
}

// ---------------------------------------------------------------- organizations

const INT4_MAX = 2147483647;

function integerOrNull(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/** A member count for an int4 column: negative or above the int4 range is dropped and counted, never clamped. */
function memberCount(ctx, path, value) {
  const members = integerOrNull(value);
  if (members === null) return null;
  if (members < 0 || members > INT4_MAX) {
    ctx.report.drop(path, members < 0 ? "negative" : "out_of_range");
    return null;
  }
  return members;
}

function round4(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null;
}

function fiscalYear(fy) {
  const m = /^(\d{4})/.exec(text(fy));
  return m ? Number.parseInt(m[1], 10) : null;
}

function buildSearchText(parts) {
  const joined = collapse(parts.filter((p) => typeof p === "string" && p).join(" ")).toLowerCase();
  return charLength(joined) <= 4000 ? joined : [...joined].slice(0, 4000).join("").trim();
}

function scrubList(ctx, people, path, values, options) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const cleaned = scrubText(ctx, people, path, value, options);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

function emptyOrganizationFacts() {
  return {
    aka: [], designation: null, local_number: null, org_type_label: null, sector: null,
    industries: [], occupations: [], trades: [], city: null, state: null, zip5: null,
    census_region: null, census_division: null, latitude: null, longitude: null, geo_precision: null,
    website: null, members_reported: null, members_fiscal_year: null, structure_note: null,
    election_term_years: null, next_election_on: null, bylaws_url: null, researched_on: null, source_urls: [],
  };
}

/**
 * Builds every row for one research record. `mode: "prefill"` additionally
 * collects the staff-only material F5 and F7 allow for the one organization
 * being staged.
 */
function buildOrganization(ctx, state, id, record, mode) {
  const identity = state.identities.get(id);
  const catalogKey = identity.catalogKey;
  const people = collectRecordPeople(record);
  const ledgerRecord = state.ledger[id];
  const out = {
    organization: null,
    subunits: [],
    seat_outlines: [],
    contacts: [],
    subunitNameIndex: new Map(),
    staffNotes: [],
    subunitContacts: [],
    people,
  };

  const name = scrubText(ctx, people, "organizations.name", record.name, { max: ORGANIZATION_NAME_MAX, election: "none", names: false });
  if (!name || charLength(name) < 2) {
    ctx.report.drop("organizations", "name_unusable");
    return null;
  }
  const tier = normalizeTier(record.tier);
  if (!tier) {
    ctx.report.drop("organizations", "unknown_tier");
    return null;
  }
  const family = scrubText(ctx, people, "organizations.family", ledgerRecord.aff ?? null, { max: 40, election: "none", names: false });
  const confidence = normalizeConfidence(record.confidence);
  if (confidence.dropped) ctx.report.drop("organizations.confidence", confidence.dropped);
  // B07-B09: a record that states locale carries a full bundle on every row
  // it exports; one that states none keeps the legacy shape (country US at
  // activation). `domestic` keeps the U.S.-only rules (state, zip5, census
  // fields, English date and cadence parsing, the U.S. contact rules) for a
  // legacy or US row.
  const locale = statesLocale(record) ? localeBundle(ctx, "organizations", record) : null;
  const domestic = !locale || locale.country === "US";
  out.locale = locale;
  out.domestic = domestic;
  // The wider international contact rules need a stated, valid country other
  // than US; a body whose country is unknown keeps the U.S. contact rules.
  out.internationalContacts = internationalCountry(locale);
  people.international = !domestic;

  if (record.duplicateOf !== null && record.duplicateOf !== undefined) {
    // F12: a duplicate filer gets a pointer and no facts.
    const primary = state.identities.get(String(record.duplicateOf));
    const duplicateOf = primary && state.exportedKeys.has(primary.catalogKey) ? primary.catalogKey : null;
    if (!duplicateOf) ctx.report.drop("organizations.duplicate_of", "unresolved");
    out.organization = withLocale({
      catalog_key: catalogKey,
      olms_file_number: identity.file,
      union_org_id: null,
      origin: "research",
      name,
      family,
      tier,
      confidence: confidence.value,
      duplicate_of: duplicateOf,
      search_text: buildSearchText([name, family]),
      ...emptyOrganizationFacts(),
    }, locale);
    return out;
  }

  const olms = isPlainObject(record.olms) ? record.olms : {};
  const aka = scrubList(ctx, people, "organizations.aka", record.aka, { max: 200, election: "reject" });
  if (aka.length > 20) {
    ctx.report.drop("organizations.aka", "over_cap", aka.length - 20);
    aka.length = 20;
  }
  // A body with no federal file number has no OLMS designation; its own
  // listing's designation and local number are read instead.
  const nullOlms = identity.file === null;
  const designation = scrubText(ctx, people, "organizations.designation", (nullOlms ? record.designation : olms.designation) || null, { max: 160, election: "none", names: false });
  const localNumber = scrubText(ctx, people, "organizations.local_number", (nullOlms ? record.local_number : olms.designationNbr) || null, { max: 20, election: "none", names: false });
  const orgType = scrubText(ctx, people, "organizations.org_type_label", record.orgType || null, { max: 120, election: "none", names: false });
  const sector = normalizeSector(record.sector);
  if (sector.dropped) ctx.report.drop("organizations.sector", sector.dropped);
  // The legacy state and zip5 columns are U.S. only (B07); a body outside the
  // United States states its place in subdivision and postal_code.
  const stateCode = domestic ? normalizeState(record.state) : { value: null, dropped: text(record.state).trim() ? "outside_united_states" : null };
  if (stateCode.dropped) ctx.report.drop("organizations.state", stateCode.dropped);
  const city = scrubText(ctx, people, "organizations.city", record.city || null, { max: 120, election: "none", names: false });
  if (!domestic && text(record.zip).trim()) ctx.report.drop("organizations.zip5", "outside_united_states");
  const zip = domestic && /^\d{5}$/.test(text(record.zip)) ? record.zip : null;
  let latitude = round4(record.lat);
  let longitude = round4(record.lon);
  if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    if (latitude !== null || longitude !== null) ctx.report.drop("organizations.latitude", "unpaired_or_out_of_range");
    latitude = null;
    longitude = null;
  }
  const geoPrecision = latitude !== null && ["zip", "city", "state"].includes(record.geoPrecision) ? record.geoPrecision : null;
  // Census regions and divisions are U.S. geography.
  const census = (raw, path) => (domestic && raw && raw !== "Unknown" ? scrubText(ctx, people, path, raw, { max: 60, election: "none", names: false }) : null);
  const website = scrubUrl(ctx, people, "organizations.website", record.web || null, { max: 500 });

  let members = memberCount(ctx, "organizations.members_reported", ledgerRecord.members);
  let membersYear = fiscalYear(ledgerRecord.fy);
  if (members === null || membersYear === null) {
    if (members !== null) ctx.report.drop("organizations.members_reported", "no_fiscal_year");
    members = null;
    membersYear = null;
  }

  // B19: outside the United States only typed values decide a date or a
  // cadence; no English-only parser reads a non-English source.
  const cycle = domestic ? parseElectionCycle(record.electionCycle, olms.nextElection) : typedElectionCadence(record);
  if (!domestic) {
    if (text(record.electionCycle).trim()) ctx.report.drop("organizations.election_cycle", "free_text_not_parsed");
    if (record.election_term_years !== undefined && record.election_term_years !== null && cycle.termYears === null) ctx.report.drop("organizations.election_term_years", "invalid");
    if (typedIsoDate(record.next_election_on).status === "unparsed") ctx.report.drop("organizations.next_election_on", "unparsed");
    if (typedIsoDate(record.researched_on).status === "unparsed") ctx.report.drop("organizations.researched_on", "unparsed");
  }
  const researchedOn = domestic
    ? (record.researched ? parseLooseDate(record.depthReviewed || record.reviewed).value : null)
    : (typedIsoDate(record.researched_on).value ?? typedIsoDate(isPlainObject(record.provenance) ? record.provenance.as_of : null).value);
  const sourceUrls = [];
  for (const source of Array.isArray(record.sources) ? record.sources : []) {
    const url = scrubUrl(ctx, people, "organizations.source_urls", source, { max: 1000, composite: true });
    if (url && !sourceUrls.includes(url)) sourceUrls.push(url);
  }
  if (sourceUrls.length > 150) {
    ctx.report.drop("organizations.source_urls", "over_cap", sourceUrls.length - 150);
    sourceUrls.length = 150;
  }
  // No federal filing stands behind a body without a file number, so, like a
  // directory-listed body, it loads only with a source that survives F8.
  if (nullOlms && sourceUrls.length === 0) {
    ctx.report.drop("organizations", "no_usable_source");
    return null;
  }

  out.organization = {
    catalog_key: catalogKey,
    olms_file_number: identity.file,
    union_org_id: null,
    origin: "research",
    name,
    aka,
    family,
    designation,
    local_number: localNumber,
    tier,
    org_type_label: orgType,
    sector: sector.value,
    industries: scrubList(ctx, people, "organizations.industries", record.industries, { max: 120, election: "none", names: false }),
    occupations: scrubList(ctx, people, "organizations.occupations", record.occupations, { max: 120, election: "none", names: false }),
    trades: scrubList(ctx, people, "organizations.trades", record.trades, { max: 120, election: "none", names: false }),
    city,
    state: stateCode.value,
    zip5: zip,
    census_region: census(record.region, "organizations.census_region"),
    census_division: census(record.division, "organizations.census_division"),
    latitude,
    longitude,
    geo_precision: geoPrecision,
    website,
    members_reported: members,
    members_fiscal_year: membersYear,
    structure_note: scrubText(ctx, people, "organizations.structure_note", record.structureNote || null, { max: 3000 }),
    election_term_years: cycle.termYears,
    next_election_on: cycle.nextOn,
    bylaws_url: scrubUrl(ctx, people, "organizations.bylaws_url", record.bylawsUrl || null, { max: 1000, https: true, electionSource: true }),
    confidence: confidence.value,
    researched_on: researchedOn,
    source_urls: sourceUrls,
    duplicate_of: null,
    search_text: buildSearchText([
      name, ...aka, family, designation && localNumber ? `${designation} ${localNumber}` : designation,
      localNumber ? `local ${localNumber}` : null, city, stateCode.value, orgType,
    ]),
  };
  out.organization = withLocale(out.organization, locale);

  const familyDomains = familyDomainsFor(ctx, ledgerRecord.aff);
  buildSubunits(ctx, out, id, record, identity, people, mode, familyDomains);
  buildOrganizationSeats(ctx, out, record, catalogKey, people, mode);
  buildContacts(ctx, out, record, catalogKey, people, familyDomains, website, sourceUrls);
  return out;
}

function buildSubunits(ctx, out, id, record, identity, people, mode, familyDomains) {
  const catalogKey = identity.catalogKey;
  const orgHost = hostOf(out.organization.website);
  const candidates = [];
  for (const subunit of Array.isArray(record.subunits) ? record.subunits : []) {
    if (!isPlainObject(subunit)) {
      ctx.report.drop("subunits", "not_an_object");
      continue;
    }
    const rawName = text(subunit.name);
    const reject = (reason) => {
      ctx.report.drop("subunits", reason);
      if (!out.subunitNameIndex.has(rawName)) out.subunitNameIndex.set(rawName, null);
    };
    const name = scrubText(ctx, people, "subunits.name", subunit.name, { max: 200, election: "reject" });
    if (!name) {
      reject("name_unusable");
      continue;
    }
    if (ctx.fixtureNames.has(normalizedName(name)) && !ctx.realFilerNames.has(normalizedName(name))) {
      reject("fixture_name");
      continue;
    }
    const sourceUrl = scrubUrl(ctx, people, "subunits.source_url", subunit.source || null, { max: 1000, composite: true });
    if (!sourceUrl) {
      reject("unsourced");
      continue;
    }
    const { kind, label, mapped } = normalizeSubunitKind(subunit.kind);
    if (mapped) ctx.report.drop("subunits.kind", "mapped_to_other");
    // The research label is scrubbed as written, before collapse() can read a
    // U+FEFF in it as a space; scrubText collapses it the same way.
    const kindLabel = scrubText(ctx, people, "subunits.kind_label", text(subunit.kind).trim() ? subunit.kind : label, { max: 60, election: "reject" }) ?? kind.replace(/_/g, " ");
    const members = memberCount(ctx, "subunits.members", subunit.members);
    const confidence = normalizeConfidence(subunit.confidence);
    if (confidence.dropped) ctx.report.drop("subunits.confidence", confidence.dropped);
    const asOf = out.domestic ? parseLooseDate(subunit.asOf) : typedIsoDate(subunit.asOf ?? subunit.as_of);
    if (asOf.status === "unparsed") ctx.report.drop("subunits.as_of", "unparsed");
    const locale = out.locale ? localeBundle(ctx, "subunits", subunit, { fallback: out.locale }) : null;
    candidates.push({
      rawName,
      subunit,
      locale,
      row: {
        subunit_key: null,
        catalog_key: catalogKey,
        parent_subunit_key: null,
        kind,
        kind_label: kindLabel,
        name,
        location: scrubText(ctx, people, "subunits.location", subunit.location || null, { max: 200 }),
        employer: scrubText(ctx, people, "subunits.employer", subunit.employer || null, { max: 300 }),
        members,
        members_source: scrubText(ctx, people, "subunits.members_source", subunit.membersSource || null, { max: 300 }),
        density_note: scrubText(ctx, people, "subunits.density_note", subunit.density || null, { max: 200 }),
        website: scrubUrl(ctx, people, "subunits.website", subunit.website || null, { max: 500 }),
        election_note: scrubText(ctx, people, "subunits.election_note", subunit.electionDate || null, { max: 300 }),
        structure_note: scrubText(ctx, people, "subunits.structure_note", subunit.structureNote || null, { max: 1000 }),
        confidence: confidence.value,
        source_url: sourceUrl,
        as_of: asOf.value,
      },
    });
  }

  // Keys: file|kind|normalized name. Two distinct sub-units of one
  // organization that share a kind and a name are told apart by their
  // location; identical repeats collapse into one row; anything else is a
  // structural collision and aborts the run.
  const byBaseKey = new Map();
  for (const candidate of candidates) {
    const base = subunitKey(catalogKey, identity.file, candidate.row.kind, candidate.row.name);
    const list = byBaseKey.get(base) ?? [];
    list.push(candidate);
    byBaseKey.set(base, list);
  }
  const accepted = new Map();
  for (const [base, list] of byBaseKey) {
    for (const candidate of list) {
      candidate.row.subunit_key = list.length === 1
        ? base
        : subunitKey(catalogKey, identity.file, candidate.row.kind, candidate.row.name, candidate.row.location ?? "");
      if (list.length > 1) ctx.report.drop("subunits.subunit_key", "disambiguated_by_location");
      const existing = accepted.get(candidate.row.subunit_key);
      if (existing) {
        if (JSON.stringify(existing.row) === JSON.stringify(candidate.row)) {
          ctx.report.drop("subunits", "identical_duplicate");
          candidate.duplicateOf = existing;
          continue;
        }
        // A research build without file numbers can list one sub-unit twice
        // with different details; its first listing is kept and the others
        // are counted. A filer's collision still aborts the run.
        if (identity.file === null) {
          ctx.report.drop("subunits", "key_collision");
          continue;
        }
        throw new Error(`Structural fault: sub-unit key collision ${candidate.row.subunit_key} in ledger record ${id}`);
      }
      accepted.set(candidate.row.subunit_key, candidate);
    }
  }

  for (const candidate of candidates) {
    const winner = candidate.duplicateOf ?? candidate;
    const existing = out.subunitNameIndex.get(candidate.rawName);
    // One raw name shared by distinct sub-units cannot be resolved from a
    // document-index entry, so it resolves to no sub-unit.
    out.subunitNameIndex.set(
      candidate.rawName,
      existing === undefined || existing === winner.row.subunit_key ? winner.row.subunit_key : null,
    );
  }

  for (const candidate of accepted.values()) {
    out.subunits.push(withLocale(candidate.row, candidate.locale));
    buildSubunitSeats(ctx, out, candidate, people, orgHost, mode);
    if (mode === "prefill") buildSubunitPrefillContacts(ctx, out, candidate, people, orgHost, familyDomains);
  }
}

function seatClassFor(key, person) {
  if (key === "leaders") return "officer";
  if (key === "board") return "board";
  return /delegate/i.test(`${text(person.role)} ${text(person.title)}`) ? "delegate" : "steward";
}

function seatTitleFor(seatClass, key, person) {
  if (seatClass === "steward" || seatClass === "delegate") return SEAT_DEFAULT_TITLES[seatClass];
  if (key === "board") return text(person.seat) || text(person.title);
  return text(person.title);
}

/**
 * F4/F3/F2: people become outlines of title, listed count and vacant count.
 * An entry sourced from an election, candidate or ballot page is not counted.
 * Only a sub-unit entry whose own source is empty inherits, and only the
 * sub-unit's source_url (§2.5 normalization); an organization-level leader
 * never inherits. An entry whose own source is present but unusable (not a
 * URL, a person's name, a contact pattern, an exclusion match, too long) is
 * dropped and counted, so no seat and no F5 holder note is ever credited to
 * a page the entry did not come from.
 */
function addSeats(ctx, out, { catalogKey, scopeSubunitKey, people, entries, subunitSource, asOf, orgHost, mode, locale = null }) {
  const groups = new Map();
  for (const { key, person } of entries) {
    if (!isPlainObject(person)) continue;
    if (person.source !== null && person.source !== undefined && typeof person.source !== "string") {
      // An own source that is present but not a string (an array, an object,
      // a number) is unusable; it never reads as empty, so it never inherits.
      ctx.report.drop("seat_outlines.source_url", "not_url");
      ctx.report.drop("seat_outlines", "own_source_unusable");
      continue;
    }
    const ownRaw = text(person.source).trim();
    const ownSource = firstHttpUrl(ownRaw);
    if (ownSource && ELECTION_SOURCE_PATTERN.test(safeDecode(ownSource))) {
      ctx.report.drop("seat_outlines", "election_source");
      continue;
    }
    let source;
    if (ownRaw) {
      if (!ownSource) ctx.report.drop("seat_outlines.source_url", "not_url");
      source = ownSource ? scrubUrl(ctx, people, "seat_outlines.source_url", ownSource, { max: 1000 }) : null;
      if (!source) {
        ctx.report.drop("seat_outlines", "own_source_unusable");
        continue;
      }
    } else {
      source = subunitSource;
      if (!source) {
        ctx.report.drop("seat_outlines", "unsourced");
        continue;
      }
    }
    if (ELECTION_SOURCE_PATTERN.test(safeDecode(source))) {
      ctx.report.drop("seat_outlines", "election_source");
      continue;
    }
    const seatClass = seatClassFor(key, person);
    const rawTitle = seatTitleFor(seatClass, key, person);
    let title = rawTitle ? scrubText(ctx, people, "seat_outlines.title", rawTitle, { max: 120, election: "reject" }) : null;
    if (!title) title = SEAT_DEFAULT_TITLES[seatClass];
    const groupKey = `${seatClass}|${title.toLowerCase()}`;
    const group = groups.get(groupKey) ?? { seatClass, title, listed: 0, vacant: 0, source };
    group.listed += 1;
    const vacant = VACANT_NAME_PATTERN.test(text(person.name));
    if (vacant) group.vacant += 1;
    groups.set(groupKey, group);

    // F5: officer and board holder names, in prefill mode only, only from the
    // organization's own web host. Steward names are never kept, and no
    // person's email or phone is kept in any mode.
    if (mode === "prefill" && (seatClass === "officer" || seatClass === "board") && !vacant) {
      const sourceHost = hostOf(source);
      const holder = collapse(text(person.name));
      if (!orgHost || sourceHost !== orgHost) {
        ctx.report.drop("prefill.staff_notes", "not_own_site");
      } else if (!holder || containsContactPattern(holder) || ctx.exclusions.matches(holder) || ctx.exclusions.matches(unhidden(person.name))) {
        ctx.report.drop("prefill.staff_notes", "holder_unusable");
      } else {
        out.staffNotes.push({ subunitKey: scopeSubunitKey, seatClass, title, holderName: holder, sourceHost, basis: "own_site" });
      }
    }
  }
  for (const group of groups.values()) {
    out.seat_outlines.push(withLocale({
      outline_key: outlineKey(scopeSubunitKey ?? catalogKey, group.seatClass, group.title),
      catalog_key: catalogKey,
      subunit_key: scopeSubunitKey,
      seat_class: group.seatClass,
      title: group.title,
      listed: group.listed,
      vacant: group.vacant,
      source_url: group.source,
      as_of: asOf,
    }, locale));
  }
}

function buildSubunitSeats(ctx, out, candidate, people, orgHost, mode) {
  const entries = [];
  for (const key of ["leaders", "board", "stewards"]) {
    for (const person of Array.isArray(candidate.subunit[key]) ? candidate.subunit[key] : []) entries.push({ key, person });
  }
  if (Array.isArray(candidate.subunit.staff) && candidate.subunit.staff.length > 0) {
    ctx.report.drop("seat_outlines", "staff_not_a_seat", candidate.subunit.staff.length);
  }
  addSeats(ctx, out, {
    catalogKey: candidate.row.catalog_key,
    scopeSubunitKey: candidate.row.subunit_key,
    people,
    entries,
    subunitSource: candidate.row.source_url,
    asOf: candidate.row.as_of,
    orgHost,
    mode,
    locale: candidate.locale,
  });
}

function buildOrganizationSeats(ctx, out, record, catalogKey, people, mode) {
  addSeats(ctx, out, {
    catalogKey,
    scopeSubunitKey: null,
    people,
    entries: (Array.isArray(record.leaders) ? record.leaders : []).map((person) => ({ key: "leaders", person })),
    subunitSource: null,
    asOf: null,
    orgHost: hostOf(out.organization.website),
    mode,
    locale: out.locale,
  });
  if (mode !== "prefill") return;
  // F5: OLMS signatories, name and title only, as staff-only notes.
  const olms = isPlainObject(record.olms) ? record.olms : {};
  for (const signatory of Array.isArray(olms.signatories) ? olms.signatories : []) {
    if (!isPlainObject(signatory)) continue;
    const holder = collapse(text(signatory.name));
    const title = collapse(text(signatory.title)) || SEAT_DEFAULT_TITLES.officer;
    if (!holder || containsContactPattern(holder) || containsContactPattern(title) || ctx.exclusions.matches(holder)
      || ctx.exclusions.matches(unhidden(signatory.name))) {
      ctx.report.drop("prefill.staff_notes", "signatory_unusable");
      continue;
    }
    out.staffNotes.push({ subunitKey: null, seatClass: "officer", title, holderName: holder, sourceHost: "olms", basis: "olms_signatory" });
  }
}

/** F6: the email rule, shared by organization contacts and prefill sub-unit contacts. */
/**
 * The contact rules of one organization: U.S. (and legacy) bodies keep
 * ROLE_MAILBOX_PATTERN and registrableDomain exactly; a body outside the
 * United States uses the reviewed multilingual mailboxes, the Americas'
 * public suffixes and E.164 office phones (B18).
 */
function contactRules(domestic) {
  return domestic
    ? { domainOf: registrableDomain, rolePattern: ROLE_MAILBOX_PATTERN, domestic }
    : { domainOf: internationalRegistrableDomain, rolePattern: INTERNATIONAL_ROLE_MAILBOX_PATTERN, domestic };
}

function emailVerdict(ctx, people, email, { orgDomain, familyDomains, rules = contactRules(true) }) {
  const value = text(email).trim().toLowerCase();
  if (!EMAIL_EXACT.test(value)) return { dropped: "shape" };
  const [localPart, host] = value.split("@");
  const domain = rules.domainOf(host);
  if (!domain) return { dropped: "shape" };
  if (isBlockedDomain(ctx.blocked, host) || isBlockedDomain(ctx.blocked, domain)) return { dropped: "blocked_domain" };
  if (people.isPersonEmail(value) || ctx.personContacts.isPersonEmail(value)) return { dropped: "person_contact" };
  let basis = null;
  if (familyDomains.includes(domain)) basis = "family_national_site";
  else if (orgDomain && domain === orgDomain) basis = "own_site";
  if (!basis) return { dropped: "domain_mismatch" };
  if (FIRST_LAST_LOCAL_PART.test(localPart) && !rules.rolePattern.test(localPart)) return { dropped: "person_shaped" };
  if (people.localPartNamesPerson(localPart)) return { dropped: "person_name" };
  return { basis, localPart, domain, value };
}

/** Lowercase letters and digits only, for comparing addresses written differently. */
function addressKey(value) {
  return text(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildContacts(ctx, out, record, catalogKey, people, familyDomains, website, sourceUrls) {
  const seen = new Set();
  const rules = contactRules(!out.internationalContacts);
  const orgDomain = website ? rules.domainOf(hostOf(website)) : null;
  const ownSources = orgDomain ? sourceUrls.filter((u) => rules.domainOf(hostOf(u)) === orgDomain) : [];
  const push = (kind, value, basis, sourceUrl, label = null, locale = out.locale) => {
    const key = contactKey(catalogKey, kind, value);
    if (seen.has(key)) return;
    if (charLength(value) < 3 || charLength(value) > 500) {
      ctx.report.drop(`contacts.${kind}`, "shape");
      return;
    }
    if (ctx.exclusions.matches(value)) return;
    seen.add(key);
    out.contacts.push(withLocale({ contact_key: key, catalog_key: catalogKey, contact_kind: kind, value, label, basis, source_url: sourceUrl, as_of: null }, locale));
  };

  if (website) push("website", website, "own_site", website);

  // Social links are kept only when the research read the organization's own site.
  // A country-aware build writes each as {url, ...locale}; only its url and
  // locale are read.
  for (const entry of Array.isArray(record.social) ? record.social : []) {
    const raw = out.locale && isPlainObject(entry) ? entry.url ?? null : entry;
    const socialLocale = out.locale && isPlainObject(entry) ? localeBundle(ctx, "contacts", entry, { fallback: out.locale }) : out.locale;
    const url = scrubUrl(ctx, people, "contacts.social", raw, { max: 500 });
    if (!url) continue;
    if (people.handleNamesPerson(url)) {
      ctx.report.drop("contacts.social", "person_name");
      continue;
    }
    if (ownSources.length === 0) {
      ctx.report.drop("contacts.social", "not_from_own_site");
      continue;
    }
    let label = hostOf(url);
    if (label && (charLength(label) > 80 || containsContactPattern(label))) {
      ctx.report.drop("contacts.label", charLength(label) > 80 ? "too_long" : "contact_pattern");
      label = null;
    }
    push("social", url, "own_site", ownSources[0], label, socialLocale);
  }

  const emailFrom = (raw, sourceHint, locale = out.locale) => {
    if (!text(raw).trim()) return;
    const verdict = emailVerdict(ctx, people, raw, { orgDomain, familyDomains, rules });
    if (verdict.dropped) {
      ctx.report.drop("contacts.email", verdict.dropped);
      return;
    }
    if (!rules.rolePattern.test(verdict.localPart)) {
      ctx.report.drop("contacts.email", "not_role_mailbox");
      return;
    }
    const sourceUrl = sourceHint
      ?? (verdict.basis === "own_site" ? ownSources[0] ?? website : sourceUrls.find((u) => rules.domainOf(hostOf(u)) === verdict.domain));
    if (!sourceUrl) {
      ctx.report.drop("contacts.email", "unsourced");
      return;
    }
    push("email", verdict.value, verdict.basis, sourceUrl, null, locale);
  };

  emailFrom(record.email, null);

  // F6: an office phone or address is kept only from an offices[] entry whose
  // own source is on the organization's registrable domain, and an address
  // that carries the OLMS filing's street or PO box, or the record's filed
  // mailing address, is dropped, because small locals often file an
  // officer's home details. An address carrying a listed person's phone in
  // any spelling, or any phone or email pattern, is dropped as well (F8, F10).
  const olms = isPlainObject(record.olms) ? record.olms : {};
  const filedAddresses = [
    ...[olms.street, olms.poBox].map((value) => ({ key: addressKey(value), reason: "olms_street" })),
    { key: addressKey(record.mailing), reason: "filed_mailing" },
  ].filter((entry) => entry.key.length >= 4);
  for (const office of Array.isArray(record.offices) ? record.offices : []) {
    if (!isPlainObject(office)) continue;
    const source = scrubUrl(ctx, people, "contacts.office_source", office.source || null, { max: 1000, composite: true });
    if (!source || !orgDomain || rules.domainOf(hostOf(source)) !== orgDomain) {
      if (text(office.phone) || text(office.address) || text(office.email)) ctx.report.drop("contacts.office", "not_from_own_site");
      continue;
    }
    const label = scrubText(ctx, people, "contacts.label", office.name || null, { max: 80, election: "reject" });
    // An office states its own place; one that states none is the body's.
    const officeLocale = out.locale ? localeBundle(ctx, "contacts", office, { fallback: out.locale }) : null;
    if (text(office.email).trim()) emailFrom(office.email, source, officeLocale);
    officePhoneAndAddress(ctx, people, (kind, value, basis, sourceUrl, officeLabel) => push(kind, value, basis, sourceUrl, officeLabel, officeLocale),
      office.phone, office.address, source, label, filedAddresses, rules);
  }

  // The top-level phones and address carry no per-value source, so neither
  // is exported (F2, F6); both are counted.
  for (const phone of Array.isArray(record.phones) ? record.phones : []) {
    if (text(phone).trim()) ctx.report.drop("contacts.phone", "unsourced");
  }
  if (text(record.address).trim()) ctx.report.drop("contacts.office_address", "unsourced");
}

function officePhoneAndAddress(ctx, people, push, phone, address, source, label, filedAddresses, rules = contactRules(true)) {
  const phoneText = collapse(text(phone));
  if (phoneText && !rules.domestic) {
    // B18: outside the United States an office phone is kept only in E.164.
    const e164 = e164Phone(phoneText);
    if (!e164) ctx.report.drop("contacts.phone", "not_e164");
    else if (people.isPersonPhone(e164) || ctx.personContacts.isPersonPhone(e164)
      || people.sharesPhoneTail(e164) || ctx.personContacts.sharesPhoneTail(e164)) ctx.report.drop("contacts.phone", "person_contact");
    else if (people.containsName(phoneText) || people.containsName(unhidden(phone))) ctx.report.drop("contacts.phone", "person_name");
    else if (!ctx.exclusions.matches(unhidden(phone)) && !ctx.exclusions.matches(e164)) push("phone", e164, "own_site", source, label);
  } else if (phoneText) {
    if (digitsOf(phoneText).length < 10) ctx.report.drop("contacts.phone", "shape");
    else if (people.isPersonPhone(phoneText) || ctx.personContacts.isPersonPhone(phoneText)) ctx.report.drop("contacts.phone", "person_contact");
    else if (people.containsName(phoneText) || people.containsName(unhidden(phone))) ctx.report.drop("contacts.phone", "person_name");
    else if (!ctx.exclusions.matches(unhidden(phone))) push("phone", phoneText, "own_site", source, label);
  }
  const addressText = collapse(text(address));
  if (addressText) {
    const key = addressKey(addressText);
    const filed = filedAddresses.find((entry) => key.includes(entry.key));
    if (people.containsPersonPhone(addressText) || ctx.personContacts.containsPersonPhone(addressText)
      || (!rules.domestic && (people.containsPhoneTail(addressText) || ctx.personContacts.containsPhoneTail(addressText)))) ctx.report.drop("contacts.office_address", "person_contact");
    else if (containsContactPattern(addressText)) ctx.report.drop("contacts.office_address", "contact_pattern");
    else if (filed) ctx.report.drop("contacts.office_address", filed.reason);
    else if (people.containsName(addressText) || people.containsName(unhidden(address))) ctx.report.drop("contacts.office_address", "person_name");
    else if (!ctx.exclusions.matches(unhidden(address))) push("office_address", addressText, "own_site", source, label);
  }
}

/** F7: sub-unit contacts, prefill mode only, always staff-only and unconfirmed. */
function buildSubunitPrefillContacts(ctx, out, candidate, people, orgHost, familyDomains) {
  const rules = contactRules(!out.internationalContacts);
  const orgDomain = orgHost ? rules.domainOf(orgHost) : null;
  const subunit = candidate.subunit;
  const sourceHost = hostOf(candidate.row.source_url);
  const base = { subunitKey: candidate.row.subunit_key, contactVisibility: "staff", confirmationState: "unconfirmed", isPersonalAddress: false, sourceHost };
  if (text(subunit.email).trim()) {
    const verdict = emailVerdict(ctx, people, subunit.email, { orgDomain, familyDomains, rules });
    if (verdict.dropped) ctx.report.drop("prefill.subunit_contacts.email", verdict.dropped);
    else out.subunitContacts.push({ ...base, kind: "email", value: verdict.value });
  }
  const phone = collapse(text(subunit.phone));
  const international = phone && !rules.domestic ? e164Phone(phone) : null;
  if (phone) {
    if (!orgHost || sourceHost !== orgHost) ctx.report.drop("prefill.subunit_contacts.phone", "not_own_site");
    else if (people.isPersonPhone(phone) || ctx.personContacts.isPersonPhone(phone)
      || (!rules.domestic && (people.sharesPhoneTail(phone) || ctx.personContacts.sharesPhoneTail(phone)))) ctx.report.drop("prefill.subunit_contacts.phone", "person_contact");
    else if (rules.domestic ? digitsOf(phone).length < 10 : !international) ctx.report.drop("prefill.subunit_contacts.phone", rules.domestic ? "shape" : "not_e164");
    else out.subunitContacts.push({ ...base, kind: "phone", value: international ?? phone });
  }
}

// ---------------------------------------------------------------- registry identifiers (B04, B06)

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * The registry identifiers of one primary organization: rows of the private
 * identifiers table, each a bounded registry token with its namespace, its
 * source and as-of date, and a name-free capture receipt stamped here from
 * the capture's content_sha256, retrieved_at and capture_method (publisher:
 * the source host; no title, note or quote). A namespace naming OLMS is
 * refused: a foreign registry number is never a federal file number. An
 * identifier with no usable source, no typed as-of date or no capture is
 * dropped and counted.
 */
function buildIdentifiers(ctx, record, catalogKey, people) {
  const rows = [];
  const seen = new Set();
  const drop = (reason) => ctx.report.drop("identifiers", reason);
  for (const raw of Array.isArray(record.identifiers) ? record.identifiers : []) {
    if (!isPlainObject(raw)) {
      drop("not_an_object");
      continue;
    }
    const namespace = text(raw.namespace).trim();
    const identifier = text(raw.value).trim();
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(namespace)) {
      drop("namespace_shape");
      continue;
    }
    if (namespace.includes("olms")) {
      drop("olms_namespace");
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9./_-]{0,159}$/.test(identifier)) {
      drop("identifier_shape");
      continue;
    }
    // A registry token never carries a listed person's name or phone: the
    // office-phone checks apply to it, failing closed.
    if (people.containsName(identifier) || ctx.exclusions.matches(identifier)
      || people.isPersonPhone(identifier) || ctx.personContacts.isPersonPhone(identifier)
      || people.sharesPhoneTail(identifier) || ctx.personContacts.sharesPhoneTail(identifier)
      || people.containsPersonPhone(identifier) || ctx.personContacts.containsPersonPhone(identifier)
      || people.containsPhoneTailDigits(identifier) || ctx.personContacts.containsPhoneTailDigits(identifier)) {
      drop("person_or_excluded");
      continue;
    }
    const asOf = typedIsoDate(raw.as_of);
    if (!asOf.value) {
      drop("no_as_of");
      continue;
    }
    const sourceUrl = scrubUrl(ctx, people, "identifiers.source_url", raw.source_url ?? null, { max: 1000, electionSource: true });
    if (!sourceUrl) {
      drop("unsourced");
      continue;
    }
    const method = text(raw.capture_method).trim();
    const retrievedAt = text(raw.retrieved_at).trim();
    const contentSha256 = text(raw.content_sha256).trim();
    if (!IDENTIFIER_CAPTURE_METHODS.includes(method) || !RFC3339_UTC.test(retrievedAt) || !/^[0-9a-f]{64}$/.test(contentSha256)) {
      drop("no_capture_receipt");
      continue;
    }
    const key = identifierKey(catalogKey, namespace, identifier);
    if (seen.has(key)) {
      drop("duplicate");
      continue;
    }
    let provenance;
    try {
      provenance = structuredClone(stamp({
        contentSha256,
        source: { url: sourceUrl, publisher: new URL(sourceUrl).hostname },
        retrievedAt,
        capture: { method },
        asOf: asOf.value,
        reuse: { basis: "public-record" },
      }));
    } catch {
      drop("receipt_invalid");
      continue;
    }
    seen.add(key);
    rows.push({ identifier_key: key, catalog_key: catalogKey, namespace, identifier, source_url: sourceUrl, as_of: asOf.value, provenance });
  }
  return rows;
}

// ---------------------------------------------------------------- edges

// The stored parent_label limit (catalog_edges_parent_label_check and the
// edge row check in catalog-shape.mjs).
const PARENT_LABEL_MAX = 300;

function buildEdges(ctx, state, id, record, catalogKey, people, locale = null) {
  const edges = [];
  // A filer's parent_body labels resolve among filers only, exactly as
  // before, so adding bodies without file numbers never re-keys a filer's
  // edge. A body without one resolves among every exported primary body,
  // and an ambiguous name is narrowed to the child's own country (B03).
  const nullOlms = state.identities.get(id)?.file === null;
  const childCountry = locale ? locale.country : "US";
  // keepLabel: a parent_body edge resolved by name keeps its label, and its
  // edge_key stays the label hash, so a release that newly resolves it
  // updates the loaded row in place instead of retiring and re-adding it.
  // storeLabel false: a resolved edge whose label is longer than the stored
  // label limit keeps its label-hash edge_key but stores no label.
  const push = (kind, parentKey, parentLabel, certainty, sourceUrl, { keepLabel = false, storeLabel = true } = {}) => {
    if (parentKey && !state.exportedKeys.has(parentKey)) return ctx.report.drop("edges", "parent_not_exported");
    if (parentKey === catalogKey) return ctx.report.drop("edges", "self_edge");
    if (!parentKey && !parentLabel) return ctx.report.drop("edges", "no_parent");
    if ((!parentKey || keepLabel) && charLength(parentLabel) < 2) return ctx.report.drop("edges.parent_label", "too_short");
    // An edge's locale is its child's jurisdiction (the contract).
    edges.push(withLocale({
      edge_key: edgeKey(catalogKey, kind, keepLabel ? null : parentKey, parentLabel),
      child_key: catalogKey,
      parent_key: parentKey,
      parent_label: parentKey && (!keepLabel || !storeLabel) ? null : parentLabel,
      edge_kind: kind,
      certainty,
      source_url: sourceUrl,
    }, locale));
    return undefined;
  };
  const keyOfLedger = (ledgerId) => state.identities.get(String(ledgerId))?.catalogKey ?? null;
  const label = (raw) => scrubText(ctx, people, "edges.parent_label", raw || null, { max: PARENT_LABEL_MAX });
  // A parent body may name an organization by its full registered name, which
  // can be up to ORGANIZATION_NAME_MAX characters, so the name
  // is read at that limit for matching; pushParentBody keeps the stored-label
  // limit for an edge it cannot key.
  const parentBodyName = (raw) => scrubText(ctx, people, "edges.parent_label", raw || null, { max: ORGANIZATION_NAME_MAX });
  const source = (raw) => scrubUrl(ctx, people, "edges.source_url", raw || null, { max: 1000, composite: true });
  // A parent_body label names a catalog organization only when its scrubbed
  // text, normalized, equals the registered name of exactly one exported,
  // non-duplicate organization other than the child. Research parent bodies
  // carry no file number, so the name is the only key; anything short of one
  // exact match stays label-only and is counted once per exported edge,
  // never guessed. The child counts toward that one match, so a label naming
  // the child itself beside a same-named filer is ambiguous, not keyed.
  const unkeyed = new Map();
  const pushParentBody = (parentLabel, certainty, sourceUrl, explicitKey = null) => {
    // B03: a parent the research bound by its catalog key keys the edge
    // directly when that key is exported and is not the child.
    if (explicitKey !== null && explicitKey !== undefined) {
      if (typeof explicitKey === "string" && CATALOG_KEY_PATTERN.test(explicitKey) && explicitKey !== catalogKey && state.exportedKeys.has(explicitKey)) {
        push("parent_body", explicitKey, null, certainty, sourceUrl);
        return;
      }
      ctx.report.drop("edges.parent_body", "explicit_key_unresolved");
    }
    let matches = parentLabel ? [...(state.primaryNameKeys.get(normalizedName(parentLabel)) ?? [])] : [];
    if (!nullOlms) matches = matches.filter((key) => state.filerKeys.has(key));
    else if (matches.length > 1) {
      const sameCountry = matches.filter((key) => state.keyCountry.get(key) === childCountry);
      if (sameCountry.length === 1) matches = sameCountry;
    }
    const parentKey = matches.length === 1 && matches[0] !== catalogKey && state.exportedKeys.has(matches[0]) ? matches[0] : null;
    // A label longer than the stored limit keys the edge when it resolves and
    // is not stored; one that does not resolve is dropped as too long, as
    // before the organization name limit grew.
    const fits = !parentLabel || charLength(parentLabel) <= PARENT_LABEL_MAX;
    if (!parentKey && !fits) {
      ctx.report.drop("edges.parent_label", "too_long");
      parentLabel = null;
    }
    const count = edges.length;
    push("parent_body", parentKey, parentLabel, certainty, sourceUrl, { keepLabel: true, storeLabel: fits });
    if (!parentKey && edges.length > count) unkeyed.set(edges[count].edge_key, matches.length > 1 ? "ambiguous" : "unresolved");
  };

  const parent = state.ledger[id].parent;
  if (Number.isInteger(parent) && parent >= 0) {
    const parentKey = keyOfLedger(parent);
    if (parentKey) push("olms_parent", parentKey, null, "filed", null);
    else ctx.report.drop("edges", "olms_parent_unresolved");
  }

  const regional = isPlainObject(record.regionalBody) ? record.regionalBody : null;
  if (regional) {
    const certainty = Array.isArray(regional.options) && regional.options.length > 0 ? "split" : "inferred";
    const parentKey = Number.isInteger(regional.id) ? keyOfLedger(regional.id) : null;
    push("regional_body", parentKey, parentKey ? null : label(regional.name), certainty, source(regional.source));
  }

  if (Number.isInteger(record.stateBodyId)) {
    push("state_body", keyOfLedger(record.stateBodyId), null, "inferred", null);
  } else if (isPlainObject(record.stateBody)) {
    push("state_body", null, label(record.stateBody.name), "inferred", source(record.stateBody.source));
  }

  if (isPlainObject(record.aflcioState)) {
    push("state_federation", null, label(record.aflcioState.name), "inferred", source(record.aflcioState.source));
  }

  for (const body of Array.isArray(record.parentBodies) ? record.parentBodies : []) {
    if (!isPlainObject(body)) continue;
    const federation = /state federation/i.test(text(body.kind));
    const parentLabel = federation ? label(body.name) : parentBodyName(body.name);
    const rawSource = text(body.source).trim();
    const emit = federation
      ? (...args) => push("state_federation", null, parentLabel, ...args)
      : (...args) => pushParentBody(parentLabel, ...args, body.parent_catalog_key ?? null);
    if (firstHttpUrl(rawSource)) {
      const url = source(rawSource);
      if (url) emit("confirmed", url);
      else ctx.report.drop("edges", "unsourced");
    } else if (/^olms\b/i.test(rawSource)) {
      emit("filed", null);
    } else {
      ctx.report.drop("edges", "unsourced");
    }
  }

  const unique = new Map();
  for (const edge of edges) {
    if (unique.has(edge.edge_key)) ctx.report.drop("edges", "duplicate");
    else unique.set(edge.edge_key, edge);
  }
  for (const reason of unkeyed.values()) ctx.report.drop("edges.parent_body", reason);
  return [...unique.values()];
}

// ---------------------------------------------------------------- documents

function buildDocuments(ctx, state, documents, orgOutputs, { onlyListed = false } = {}) {
  const rows = new Map();
  const links = new Map();
  for (const doc of documents) {
    if (!LIVE_STATUS_SET.has(doc.status)) {
      ctx.report.drop("documents", "unavailable_status");
      continue;
    }
    const { kind, mapped } = normalizeDocKind(doc.kind);
    if (mapped) ctx.report.drop("documents.doc_kind", "mapped_to_other");
    const pairs = [{ orgId: doc.orgId, subunit: doc.subunit }, ...(doc.alsoIn ?? [])];
    for (const pair of pairs) {
      const orgId = pair.orgId === null || pair.orgId === undefined ? null : String(pair.orgId);
      const org = orgId ? orgOutputs.get(orgId) : null;
      if (!org) {
        if (!onlyListed) ctx.report.drop("documents", orgId && state.duplicates.has(orgId) ? "duplicate_record" : "organization_not_exported");
        continue;
      }
      if (ELECTION_SOURCE_PATTERN.test(text(doc.title)) || ELECTION_SOURCE_PATTERN.test(safeDecode(text(doc.url)))) {
        ctx.report.drop("documents", "election_source");
        continue;
      }
      const catalogKey = org.organization.catalog_key;
      const url = scrubUrl(ctx, org.people, "documents.url", doc.url, { max: 2000, https: true, electionSource: true });
      if (!url) {
        ctx.report.drop("documents", "url_unusable");
        continue;
      }
      // url_host (and a title derived from it) is exported as text, so it is
      // bounded and checked here rather than left to abort the final gate.
      const host = new URL(url).hostname.toLowerCase();
      if (charLength(host) > 253) {
        ctx.report.drop("documents.url_host", "too_long");
        continue;
      }
      if (containsContactPattern(host)) {
        ctx.report.drop("documents.url_host", "contact_pattern");
        continue;
      }
      const key = documentKey(catalogKey, url);
      if (!rows.has(key)) {
        let title = scrubText(ctx, org.people, "documents.title", doc.title || null, { max: 300, election: "reject" });
        let derived = false;
        if (!title) {
          title = `${DOC_KIND_LABELS[kind]} from ${host.replace(/^www\./, "")}`;
          derived = true;
        }
        const asOf = org.domestic === false ? typedIsoDate(doc.asOf) : parseLooseDate(doc.asOf);
        if (asOf.status === "unparsed") ctx.report.drop("documents.as_of", "unparsed");
        // A document's language and timezone describe that document; when
        // the index states no locale only its owner's place is carried.
        const locale = org.locale
          ? localeBundle(ctx, "documents", doc, { fallback: org.locale, inherit: ["country", "subdivision", "postal_code"] })
          : null;
        rows.set(key, withLocale({ document_key: key, catalog_key: catalogKey, doc_kind: kind, title, title_derived: derived, url, url_host: host, as_of: asOf.value }, locale));
      } else {
        ctx.report.drop("documents", "merged_same_url");
      }
      const subunitName = text(pair.subunit);
      if (subunitName) {
        const resolved = org.subunitNameIndex.get(subunitName);
        if (resolved === undefined) ctx.report.drop("document_subunits", "unresolved_subunit");
        else if (resolved === null) ctx.report.drop("document_subunits", "subunit_not_exported");
        else links.set(`${key}|${resolved}`, { document_key: key, subunit_key: resolved });
      }
    }
  }
  return { documents: [...rows.values()], document_subunits: [...links.values()] };
}

// ---------------------------------------------------------------- the release

function prepareState(options, report = createDropReport()) {
  const { enriched, ledger } = options;
  if (!isPlainObject(enriched)) throw new Error("Structural fault: enriched.json is not an object keyed by ledger id");
  if (!isPlainObject(ledger)) throw new Error("Structural fault: the ledger records are not an object keyed by id");
  const fixtures = {
    fileNumbers: new Set((options.fixtures?.fileNumbers ?? []).filter(Number.isInteger)),
    ids: new Set((options.fixtures?.ids ?? []).map(String)),
  };
  const identities = new Map();
  const byKey = new Map();
  const fixtureIds = new Set();
  const duplicates = new Set();
  // normalized registered name -> catalog keys of the non-duplicate filers
  // carrying it; parent_body edges resolve against it (buildEdges).
  const primaryNameKeys = new Map();
  // Filer keys, and each key's country (US for a filer from a build that
  // states no locale): parent_body names resolve within them (buildEdges).
  const filerKeys = new Set();
  const keyCountry = new Map();
  for (const [id, record] of Object.entries(enriched)) {
    if (!isPlainObject(record)) throw new Error(`Structural fault: enriched record ${id} is not an object`);
    // F11: a fixture identity (the reserved test- prefix, a SAMPLE fixture id
    // or a SAMPLE fixture OLMS file number) is refused before anything else.
    const file = ledger[id]?.file;
    if (id.startsWith(TEST_KEY_PREFIX) || fixtures.ids.has(id) || (Number.isInteger(file) && fixtures.fileNumbers.has(file))) {
      fixtureIds.add(id);
      continue;
    }
    if (!ledger[id]) throw new Error(`Structural fault: enriched record ${id} has no ledger record`);
    const identity = catalogIdentityOf(id, ledger[id], record, report);
    claimCatalogKey(byKey, identity.catalogKey, id, (previous) => `ledger records ${previous} and ${id}`);
    identities.set(id, identity);
    if (identity.file !== null) filerKeys.add(identity.catalogKey);
    keyCountry.set(identity.catalogKey, statesLocale(record) ? (validCountry(record.country) ? record.country : null) : "US");
    if (record.duplicateOf !== null && record.duplicateOf !== undefined) {
      duplicates.add(id);
      continue;
    }
    const name = normalizedName(record.name);
    if (!name) continue;
    if (!primaryNameKeys.has(name)) primaryNameKeys.set(name, new Set());
    primaryNameKeys.get(name).add(identity.catalogKey);
  }
  // Directory-listed bodies have no federal file number. One is accepted only
  // with a dated http(s) source and a parent filer; anything less is refused
  // like a ledger record without a file number. They stay out of
  // `identities` (so the id map and the research records' name resolution are
  // exactly what they would be without them) and of primaryNameKeys.
  const directory = [];
  for (const body of options.directoryBodies ?? []) {
    if (body.id.startsWith(TEST_KEY_PREFIX) || fixtures.ids.has(body.id)) {
      fixtureIds.add(`directory:${body.id}`);
      continue;
    }
    const parentFile = body.parentFileNumber;
    if (!datedSource(body) || !Number.isInteger(parentFile) || parentFile <= 0) {
      throw new Error(`Structural fault: directory-listed body ${body.id} has no federal file number and lacks a dated http(s) source or a parent filer`);
    }
    if (fixtures.fileNumbers.has(parentFile)) {
      fixtureIds.add(`directory:${body.id}`);
      continue;
    }
    const catalogKey = directoryBodyKey(parentFile, body.name);
    claimCatalogKey(byKey, catalogKey, `directory-listed body ${body.id}`, (previous) => `directory-listed body ${body.id} and ${previous}`);
    directory.push({ body, catalogKey, parentKey: `olms-${parentFile}` });
  }
  return { ledger, identities, fixtureIds, duplicates, primaryNameKeys, filerKeys, keyCountry, directory, exportedKeys: new Set() };
}

/**
 * Claims a catalog key for one body. Every body, filer or not, claims its key
 * here, so a key is never exported twice.
 */
function claimCatalogKey(byKey, catalogKey, owner, describe) {
  if (byKey.has(catalogKey)) {
    throw new Error(`Structural fault: catalog key collision ${catalogKey} (${describe(byKey.get(catalogKey))})`);
  }
  byKey.set(catalogKey, owner);
}

/**
 * The identity of one ledger record (B01). A positive federal file number is
 * the olms- route, exactly as before. A ledger catalog_key beside it must be
 * that same olms- key. A research key on the enriched record (a build's own
 * id for a body it matched to a real filer) is superseded by the file number
 * and counted.
 *
 * A record with no file number takes the null-OLMS route of  (record
 * REQ-UNIONGROUND-CATALOG-DIRECTORY-LISTED-BODIES-WITHOUT-FEDERAL-FILE-
 * 20261111): a stable ug- key, never derived from or stored as a federal
 * file number, with olms_file_number and union_org_id null. The key is the one
 * the research build assigned: the ledger record's catalog_key, or else the
 * enriched record's (ug- plus ten characters). When both are present they must
 * agree. A directory-listed body derives its key with directoryBodyKey, whose
 * ug-d shape a research key may not use. A record with neither a file number
 * nor a key is refused, as before. Both routes claim their keys through
 * claimCatalogKey.
 */
function catalogIdentityOf(id, ledgerRecord, record, report) {
  const file = ledgerRecord.file;
  const ledgerKey = ledgerRecord.catalog_key ?? null;
  const recordKey = record.catalog_key ?? null;
  if (Number.isInteger(file) && file > 0) {
    if (ledgerKey !== null && ledgerKey !== `olms-${file}`) throw new Error(`Structural fault: ledger record ${id} has a federal file number and a different catalog key`);
    if (recordKey !== null && recordKey !== `olms-${file}`) report.drop("organizations.catalog_key", "superseded_by_file_number");
    return { file, catalogKey: `olms-${file}` };
  }
  if (ledgerKey !== null && recordKey !== null && ledgerKey !== recordKey) {
    throw new Error(`Structural fault: enriched record ${id} names a catalog key its ledger record does not`);
  }
  const explicit = ledgerKey ?? recordKey;
  if ((file === null || file === undefined) && typeof explicit === "string" && UG_KEY_SHAPE.test(explicit)) {
    if (DIRECTORY_KEY_SHAPE.test(explicit)) throw new Error(`Structural fault: ledger record ${id} uses the reserved directory-listed key shape`);
    return { file: null, catalogKey: explicit };
  }
  throw new Error(`Structural fault: ledger record ${id} has no positive integer OLMS file number`);
}

/**
 * One directory-listed body: organization facts from its own listing only
 * (name, family, tier, U.S. place, website, its dated sources), confidence
 * unreviewed, the fixed DIRECTORY_BODY_NOTE, and a parent_body edge to its
 * parent filer's catalog key. No file number, registry link, membership,
 * designation, sub-unit, seat, contact or document. A body whose place is
 * outside the United States, whose parent filer is not exported, or whose
 * sources do not survive the F8 gate is dropped and counted.
 */
function buildDirectoryBody(ctx, state, { body, catalogKey, parentKey }) {
  const drop = (reason) => {
    ctx.report.drop("directory_bodies", reason);
    return null;
  };
  // Nothing about any person is read from a listing, so the same-record name
  // scrub has no names to look for; the contact-pattern, election and
  // exclusion gates still run on every value.
  const people = new RecordPeople();
  const country = text(body.country).trim().toUpperCase();
  const stateCode = text(body.state).trim();
  if ((country && country !== "US") || (stateCode && !US_STATE_CODES.has(stateCode))) return drop("outside_united_states");
  if (!state.exportedKeys.has(parentKey)) return drop("parent_not_exported");
  const name = scrubText(ctx, people, "organizations.name", body.name, { max: ORGANIZATION_NAME_MAX, election: "none", names: false });
  if (!name || charLength(name) < 2) return drop("name_unusable");
  const tier = normalizeTier(body.tier);
  if (!tier) return drop("unknown_tier");
  const sourceUrls = [];
  let asOf = null;
  for (const source of body.sources) {
    if (typeof source.asOf !== "string" || !isRealIsoDate(source.asOf)) continue;
    const url = scrubUrl(ctx, people, "organizations.source_urls", source.url, { max: 1000 });
    if (!url) continue;
    if (!sourceUrls.includes(url)) sourceUrls.push(url);
    if (!asOf || source.asOf > asOf) asOf = source.asOf;
  }
  if (sourceUrls.length === 0) return drop("no_usable_source");
  if (sourceUrls.length > 150) {
    ctx.report.drop("organizations.source_urls", "over_cap", sourceUrls.length - 150);
    sourceUrls.length = 150;
  }
  const family = scrubText(ctx, people, "organizations.family", body.family, { max: 40, election: "none", names: false });
  const city = scrubText(ctx, people, "organizations.city", body.city || null, { max: 120, election: "none", names: false });
  const usState = stateCode || null;
  return {
    organization: {
      catalog_key: catalogKey,
      olms_file_number: null,
      union_org_id: null,
      origin: "research",
      name,
      family,
      tier,
      ...emptyOrganizationFacts(),
      city,
      state: usState,
      website: scrubUrl(ctx, people, "organizations.website", body.website || null, { max: 500 }),
      structure_note: DIRECTORY_BODY_NOTE,
      confidence: "unreviewed",
      researched_on: asOf,
      source_urls: sourceUrls,
      duplicate_of: null,
      search_text: buildSearchText([name, family, city, usState]),
    },
    edge: {
      edge_key: edgeKey(catalogKey, "parent_body", parentKey, null),
      child_key: catalogKey,
      parent_key: parentKey,
      parent_label: null,
      edge_kind: "parent_body",
      certainty: "confirmed",
      source_url: sourceUrls[0],
    },
  };
}

function orderedIds(state) {
  return [...state.identities.keys()].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

/**
 * Shared mode: the whole catalog, with no person data of any kind.
 * Returns the release object, the drop report, the exclusion match count,
 * the ledger-id map and the release counts.
 */
export function buildCatalogRelease(options) {
  const ctx = createContext(options);
  const { enriched, documents = [] } = options;
  assertNoReferenceKey(enriched, "enriched.json");
  assertNoReferenceKey(options.ledger, "source-data.json index-data.json.records");
  assertNoReferenceKey(documents, "documents/index.json");
  const state = prepareState(options, ctx.report);
  ctx.personContacts = collectPersonContacts(enriched);
  for (const id of state.identities.keys()) ctx.realFilerNames.add(normalizedName(enriched[id].name));
  if (state.fixtureIds.size > 0) ctx.report.drop("organizations", "fixture_identity", state.fixtureIds.size);

  // Primary records first, so every duplicate pointer and edge can check its target.
  const primaries = new Map();
  const duplicates = [];
  const ids = orderedIds(state);
  for (const id of ids.filter((i) => !state.duplicates.has(i))) {
    const built = buildOrganization(ctx, state, id, enriched[id], "shared");
    if (!built) continue;
    primaries.set(id, built);
    state.exportedKeys.add(built.organization.catalog_key);
  }
  for (const id of ids.filter((i) => state.duplicates.has(i))) {
    const built = buildOrganization(ctx, state, id, enriched[id], "shared");
    if (!built) continue;
    duplicates.push(built);
    state.exportedKeys.add(built.organization.catalog_key);
  }

  const release = { schema: RELEASE_SCHEMA, filterVersion: FILTER_VERSION };
  for (const table of CONTENT_TABLES) release[table] = [];
  const identifiers = [];
  for (const [id, built] of primaries) {
    release.organizations.push(built.organization);
    release.edges.push(...buildEdges(ctx, state, id, enriched[id], built.organization.catalog_key, built.people, built.locale));
    release.subunits.push(...built.subunits);
    release.seat_outlines.push(...built.seat_outlines);
    release.contacts.push(...built.contacts);
    identifiers.push(...buildIdentifiers(ctx, enriched[id], built.organization.catalog_key, built.people));
  }
  for (const built of duplicates) release.organizations.push(built.organization);
  for (const id of ids.filter((i) => state.duplicates.has(i))) {
    const listed = enriched[id].identifiers;
    if (Array.isArray(listed) && listed.length > 0) ctx.report.drop("identifiers", "duplicate_record", listed.length);
  }
  // Directory-listed bodies last: their parents must already be exported, and
  // nothing built above depends on them.
  for (const [reason, count] of Object.entries(options.directoryHeld ?? {})) ctx.report.drop("directory_bodies.held", reason, count);
  for (const entry of state.directory) {
    const built = buildDirectoryBody(ctx, state, entry);
    if (!built) continue;
    state.exportedKeys.add(built.organization.catalog_key);
    release.organizations.push(built.organization);
    release.edges.push(built.edge);
  }
  const docs = buildDocuments(ctx, state, documents, primaries);
  release.documents = docs.documents;
  release.document_subunits = docs.document_subunits;
  // The optional identifiers table appears only when a body has one, so a
  // release without them is exactly what it was.
  if (identifiers.length > 0) release.identifiers = identifiers;

  shortNamePrivacy(release, options, state, ctx.report);
  const problems = releaseViolations(release);
  if (problems.length > 0) {
    throw new Error(`Structural fault: the filter built ${problems.length} row(s) that violate a table constraint:\n  - ${problems.slice(0, 20).join("\n  - ")}`);
  }
  assertReleasePrivacy(release, { blocked: ctx.blocked });

  const idMap = {};
  for (const [id, identity] of state.identities) {
    if (state.exportedKeys.has(identity.catalogKey)) idMap[id] = identity.catalogKey;
  }
  return {
    release,
    dropReport: ctx.report.toJSON(),
    exclusionMatches: ctx.exclusions.matchCount,
    idMap,
    counts: releaseCounts(release),
  };
}

/**
 * Prefill mode (F5, F7): one organization, for stage-prefill only. Returns
 * the shared-mode rows for that organization plus staff-only holder notes and
 * staff-only sub-unit contacts. No person email or phone is kept in any mode.
 */
export function buildOrganizationPrefill(ledgerId, options) {
  const ctx = createContext(options);
  const { enriched } = options;
  assertNoReferenceKey(enriched, "enriched.json");
  assertNoReferenceKey(options.ledger, "source-data.json index-data.json.records");
  const id = String(ledgerId);
  const state = prepareState(options, ctx.report);
  ctx.personContacts = collectPersonContacts(enriched);
  for (const key of state.identities.keys()) {
    ctx.realFilerNames.add(normalizedName(enriched[key].name));
    state.exportedKeys.add(state.identities.get(key).catalogKey);
  }
  if (!state.identities.has(id)) throw new Error(`Ledger record ${id} is not an exportable catalog organization`);
  if (state.duplicates.has(id)) throw new Error(`Ledger record ${id} is a duplicate filer and carries no facts`);
  const built = buildOrganization(ctx, state, id, enriched[id], "prefill");
  if (!built) throw new Error(`Ledger record ${id} was dropped by the filter`);
  const mentions = (doc) => String(doc.orgId) === id || (doc.alsoIn ?? []).some((entry) => String(entry.orgId) === id);
  const docs = buildDocuments(ctx, state, (options.documents ?? []).filter(mentions), new Map([[id, built]]), { onlyListed: true });
  const slice = {
    schema: RELEASE_SCHEMA,
    filterVersion: FILTER_VERSION,
    organizations: [built.organization],
    edges: buildEdges(ctx, state, id, enriched[id], built.organization.catalog_key, built.people, built.locale),
    subunits: built.subunits,
    seat_outlines: built.seat_outlines,
    contacts: built.contacts,
    documents: docs.documents,
    document_subunits: docs.document_subunits,
  };
  const { heldSubunits, heldSeats } = shortNamePrivacy(slice, options, state, ctx.report);
  const keepAttachment = (kind, subunitKey, seatKey = null) => {
    const reasons = [heldSubunits.get(subunitKey), heldSeats.get(seatKey)].filter(Boolean);
    if (reasons.length === 0) return true;
    ctx.report.drop(`short_name.held.${kind}`, reasons.includes("person") ? "person" : "unknown");
    return false;
  };
  // Edges may name parents outside this one-organization slice, so rows are
  // checked one by one rather than as a closed release.
  for (const table of CONTENT_TABLES) {
    for (const row of slice[table]) {
      const problems = rowViolations(table, row);
      if (problems.length > 0) throw new Error(`Structural fault: ${table} ${primaryKeyOf(table, row)}: ${problems.join("; ")}`);
    }
  }
  assertReleasePrivacy(slice, { blocked: ctx.blocked });
  return {
    ...slice,
    // F5 OLMS notes have no corresponding seat outline. Its intentional
    // staff-only holder-name exception remains separate from shared seats.
    staffNotes: built.staffNotes.filter((note) => keepAttachment("prefill_staff_notes", note.subunitKey,
      note.basis === "own_site" ? outlineKey(note.subunitKey ?? built.organization.catalog_key, note.seatClass, note.title) : null)),
    subunitContacts: built.subunitContacts.filter((contact) => keepAttachment("prefill_subunit_contacts", contact.subunitKey)),
    dropReport: ctx.report.toJSON(),
    exclusionMatches: ctx.exclusions.matchCount,
  };
}

// ---------------------------------------------------------------- counts and the final gate

export function releaseCounts(release) {
  const countBy = (rows, field) => {
    const out = {};
    for (const row of rows) out[row[field]] = (out[row[field]] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  return {
    organizations: release.organizations.length,
    organizations_duplicate: release.organizations.filter((o) => o.duplicate_of).length,
    organizations_with_website: release.organizations.filter((o) => o.website).length,
    organizations_by_tier: countBy(release.organizations, "tier"),
    organizations_with_subunits: new Set(release.subunits.map((s) => s.catalog_key)).size,
    edges: release.edges.length,
    edges_by_kind: countBy(release.edges, "edge_kind"),
    subunits: release.subunits.length,
    subunits_with_members: release.subunits.filter((s) => s.members !== null).length,
    seat_outlines: release.seat_outlines.length,
    seats_listed: release.seat_outlines.reduce((n, s) => n + s.listed, 0),
    seats_vacant: release.seat_outlines.reduce((n, s) => n + s.vacant, 0),
    contacts: release.contacts.length,
    contacts_by_kind: countBy(release.contacts, "contact_kind"),
    documents: release.documents.length,
    documents_by_kind: countBy(release.documents, "doc_kind"),
    documents_title_derived: release.documents.filter((d) => d.title_derived).length,
    document_subunits: release.document_subunits.length,
    ...directoryCounts(release),
    ...researchCounts(release),
    // Present only when the release carries registry identifiers (B06), as
    // the loader counts them.
    ...(Object.hasOwn(release, "identifiers") ? { identifiers: release.identifiers.length } : {}),
  };
}

// Present only when the release carries an organization with no federal file
// number (a directory-listed body), so a release built before they existed
// keeps the counts its manifest recorded.
function directoryCounts(release) {
  const listed = release.organizations.filter((o) => o.olms_file_number === null || o.olms_file_number === undefined).length;
  return listed > 0 ? { organizations_without_file_number: listed } : {};
}

// Present only when the release carries research tables, so a release built
// before they existed keeps the counts its manifest recorded.
function researchCounts(release) {
  if (!RESEARCH_TABLES.some((table) => Object.hasOwn(release, table))) return {};
  const facts = release.research_facts ?? [];
  const categories = release.research_categories ?? [];
  const countBy = (rows, field) => {
    const out = {};
    for (const row of rows) out[row[field]] = (out[row[field]] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  return {
    research_facts: facts.length,
    research_facts_by_tier: countBy(facts, "evidence_tier"),
    research_facts_bound: facts.filter((row) => row.binding === "bound").length,
    research_facts_by_kind: countBy(facts, "fact_kind"),
    research_categories: categories.length,
    research_categories_by_outcome: countBy(categories, "outcome"),
  };
}

// Research rows (translate-research-export.mjs) carry no free text from a
// research packet. A column named for a person or for packet text is a
// translator bug, never data, and so is a source URL or title from an
// election, candidate, ballot or nomination page (F3) or a title with
// election-result wording (F8).
export const RESEARCH_FORBIDDEN_FIELDS = Object.freeze(["quote", "label", "value", "holder", "name", "email", "phone"]);

function assertResearchRowPrivacy(table, row, key) {
  for (const forbidden of RESEARCH_FORBIDDEN_FIELDS) {
    if (Object.hasOwn(row, forbidden)) throw new Error(`research gate: ${table} ${key} carries a ${forbidden} field; refusing the release`);
  }
  if (table !== "research_facts") return;
  if (typeof row.url === "string" && ELECTION_SOURCE_PATTERN.test(safeDecode(row.url))) {
    throw new Error(`F3 research gate: research_facts.url of ${key} is an election, candidate, ballot or nomination source; refusing the release`);
  }
  if (typeof row.title === "string" && (ELECTION_SOURCE_PATTERN.test(row.title) || ELECTION_RESULT_PATTERN.test(row.title))) {
    throw new Error(`F8 research gate: research_facts.title of ${key} carries election wording; refusing the release`);
  }
}

const URL_COLUMNS = new Set(["website", "bylaws_url", "source_url", "source_urls", "url"]);

/**
 * A research digest or reason code: a *_sha256 column holding exactly 64
 * lowercase hex, or an `unresolved` item that is exactly ur- and 12 hex. Its
 * digit runs are hash output, not a phone number, and it can carry nothing
 * else, so the contact-pattern check skips it.
 */
export function isResearchDigest(column, item) {
  if (column.endsWith("_sha256")) return /^[0-9a-f]{64}$/.test(item);
  if (column === "unresolved") return /^ur-[0-9a-f]{12}$/.test(item);
  return false;
}
const URL_CONTACT_KINDS = new Set(["website", "social"]);
const CONTACT_VALUE_KINDS = new Set(["phone", "email"]);

/**
 * The fail-closed F8/F11/F6 gate over a finished release. Every exported
 * string outside a phone or email contact value is checked for an email or
 * phone pattern (website and social values as URLs, office addresses as
 * text); any hit aborts the run, naming the field path and row key, never the
 * value. Research rows also pass the research gate above.
 */
export function assertReleasePrivacy(release, { blocked = [] } = {}) {
  const internationalOrgs = new Set((release.organizations ?? [])
    .filter((org) => internationalCountry(org)).map((org) => org.catalog_key));
  for (const table of RELEASE_TABLES) {
    for (const row of release[table] ?? []) {
      const key = primaryKeyOf(table, row);
      if (RESEARCH_TABLES.includes(table)) assertResearchRowPrivacy(table, row, key);
      for (const [column, value] of Object.entries(row)) {
        // Keys, and publisher_candidates (catalog keys checked by pattern in
        // releaseViolations): a ug- key's ten characters can read as a phone.
        if (column.endsWith("_key") || column === "duplicate_of" || column === "publisher_candidates") {
          for (const item of Array.isArray(value) ? value : [value]) {
            if (typeof item === "string" && item.startsWith(TEST_KEY_PREFIX)) {
              throw new Error(`F11: ${table}.${column} of ${key} carries the reserved test- prefix`);
            }
          }
          continue;
        }
        const contactValue = table === "contacts" && column === "value";
        if (contactValue && CONTACT_VALUE_KINDS.has(row.contact_kind)) continue;
        // A registry token is a typed identifier, like a catalog key: a
        // numeric registry number can read as a phone. Only the token of a
        // row that passes the identifier row check is exempt; its source URL
        // and every other column are still swept.
        if (table === "identifiers" && column === "identifier" && rowViolations("identifiers", row).length === 0) continue;
        const url = contactValue ? URL_CONTACT_KINDS.has(row.contact_kind) : URL_COLUMNS.has(column);
        for (const item of Array.isArray(value) ? value : [value]) {
          if (typeof item !== "string" || (RESEARCH_TABLES.includes(table) && isResearchDigest(column, item))) continue;
          if (containsContactPattern(item, { url })) {
            throw new Error(`F8 privacy gate: ${table}.${column} of ${key} carries an email or phone pattern; refusing to write the release`);
          }
        }
      }
      if (table === "contacts" && row.contact_kind === "email") {
        const [localPart = "", domain = ""] = String(row.value).split("@");
        // A contact of an organization stating a country other than US is
        // held to the reviewed multilingual mailboxes, as the builder held
        // it (contactRules); every other contact to the U.S. ones.
        const domestic = !internationalOrgs.has(row.catalog_key);
        if (!(domestic ? ROLE_MAILBOX_PATTERN : INTERNATIONAL_ROLE_MAILBOX_PATTERN).test(localPart) || isBlockedDomain(blocked, domain)) {
          throw new Error(`F6 privacy gate: contacts.value of ${key} is not an allowed organization mailbox`);
        }
      }
      if (typeof row.catalog_key === "string" && !CATALOG_KEY_PATTERN.test(row.catalog_key)) {
        throw new Error(`F11: ${table}.catalog_key of ${key} is not a catalog key`);
      }
    }
  }
  return true;
}
