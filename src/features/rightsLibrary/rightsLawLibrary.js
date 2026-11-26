// REQ-UG-RIGHTS-LAW-LIBRARY-20261012: loading and shaping the
// reference library in data/reference/labor-rights/. Each file is its own lazy
// chunk: agencies.json (agencies, deadlines, situations, rights to know) loads
// when the switch is on and the Rights page opens; documents.json (agency
// pages and the guides, the larger file) loads only when the member opens an
// agency's pages or the guides. Every record in them is validated where
// node:crypto exists: by scripts/build-rights-law-library.mjs when they are
// written, by npm run verify:conventions (data/reference/ rule) and by
// tests/rights-law-library-data.test.js. In the browser a file of the wrong
// shape is refused, and SourceLine says "source record missing" for any row
// whose record it cannot show.

export const RIGHTS_LIBRARY_SWITCH = "features.rights.law_library";

export function rightsLibraryEnabled(configuration) {
  return configuration?.switches?.[RIGHTS_LIBRARY_SWITCH] === true;
}

const RIGHTS_LIBRARY_SCHEMA = "union-ground/rights-law-library/v1";

export function assertAgencies(agencies) {
  const lists = [agencies?.agencies, agencies?.scenarios, agencies?.concepts, agencies?.excluded, agencies?.source_records];
  if (agencies?.schema !== RIGHTS_LIBRARY_SCHEMA || !lists.every(Array.isArray)) {
    throw new Error("rights library refused: unexpected agencies file shape");
  }
  return agencies;
}

export function assertDocuments(documents) {
  if (documents?.schema !== RIGHTS_LIBRARY_SCHEMA || !Array.isArray(documents?.documents) || !Array.isArray(documents?.source_records)) {
    throw new Error("rights library refused: unexpected documents file shape");
  }
  return documents;
}

export async function loadRightsLawAgencies() {
  const agencies = await import("../../../data/reference/labor-rights/agencies.json");
  return assertAgencies(agencies.default);
}

export async function loadRightsLawDocuments() {
  const documents = await import("../../../data/reference/labor-rights/documents.json");
  return assertDocuments(documents.default);
}

// REQ-UG-RIGHTS-LIBRARY-FEDERAL-TEXT-TO-OFFICIAL-LINKS-20261110: the
// federal acts and regulation parts are one line each (name, citation and a
// link to the official text) in data/reference/labor-rights/federal-law/ and
// federal-regulations/. Each index loads when the member opens the federal law
// section; the library no longer carries the text itself.
export function assertFederalIndex(index) {
  if (index?.schema !== RIGHTS_LIBRARY_SCHEMA || !Array.isArray(index?.acts) || !Array.isArray(index?.source_records)) {
    throw new Error("rights library refused: unexpected federal law index shape");
  }
  return index;
}

export async function loadFederalLawIndex() {
  const index = await import("../../../data/reference/labor-rights/federal-law/index.json");
  return assertFederalIndex(index.default);
}

export function assertRegulationsIndex(index) {
  if (index?.schema !== RIGHTS_LIBRARY_SCHEMA || !Array.isArray(index?.parts) || !Array.isArray(index?.source_records)) {
    throw new Error("rights library refused: unexpected federal regulations index shape");
  }
  return index;
}

export async function loadRegulationsIndex() {
  const index = await import("../../../data/reference/labor-rights/federal-regulations/index.json");
  return assertRegulationsIndex(index.default);
}

// The full records a file carries, for SourceLine's inputs list.
export function recordsOf(...files) {
  return files.flatMap((file) => (Array.isArray(file?.source_records) ? file.source_records : [])).map((row) => row.provenance);
}

// The public markdown sanitizer caps its input; split long pages at headings
// (or blank lines when one section alone is too long) so nothing is cut.
// An agency page sometimes splits a mailbox into two links, one of them an
// https URL whose path is the address (mass.gov's DLS accident page). The
// excerpt stays verbatim in the data; such a link renders as its plain label,
// and the agency card's verified contacts carry the real mailbox.
const MAILBOX_URL_LINK = /\[([^\]]*)\]\((https:\/\/[^)\s]*(?:%40|@)[^)\s]*)\)/giu;

export function demoteMailboxLinks(markdown) {
  return String(markdown ?? "").replace(MAILBOX_URL_LINK, "$1");
}

export function splitMarkdown(markdown, limit = 40_000) {
  const parts = [];
  let current = "";
  for (const block of String(markdown || "").split(/\n(?=#{1,6}\s)|\n{2,}/)) {
    if (current && current.length + block.length + 2 > limit) {
      parts.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) parts.push(current);
  return parts;
}

// The public markdown sanitizer knows no tables, numbered lists or titled
// links, and the guides and agency captures use all three. Pull pipe tables out
// as rows of cells and numbered steps out as numbered items so the view renders them as
// tables and ordered lists, and drop link titles so the sanitizer sees a plain
// link. A lone pipe line is not a table and stays prose.
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const STEP = /^\s*(\d+)[.)]\s+(\S.*)$/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;

export function markdownBlocks(markdown) {
  const text = String(markdown || "").replace(/(\]\(https:\/\/[^)\s]+)\s+"[^"]*"\)/g, "$1)");
  const blocks = [];
  let prose = [];
  let table = [];
  let steps = [];
  const flushSteps = () => {
    if (steps.length) blocks.push({ kind: "ordered", items: steps });
    steps = [];
  };
  const flushProse = () => {
    if (prose.length) blocks.push({ kind: "markdown", text: prose.join("\n") });
    prose = [];
  };
  const flushTable = () => {
    const rows = table.filter((line) => !TABLE_RULE.test(line)).map((line) => line.trim().slice(1, -1).split("|").map((cell) => cell.trim()));
    if (rows.length > 1) {
      flushProse();
      blocks.push({ kind: "table", rows });
    } else prose.push(...table);
    table = [];
  };
  for (const line of text.split("\n")) {
    if (TABLE_ROW.test(line)) {
      flushSteps();
      table.push(line);
      continue;
    }
    if (table.length) flushTable();
    const step = STEP.exec(line);
    if (step) {
      flushProse();
      // Keep the source number: steps split by bullets continue, not restart.
      steps.push({ number: Number(step[1]), text: step[2] });
      continue;
    }
    // A blank line between numbered steps keeps one list.
    if (steps.length && !line.trim()) continue;
    flushSteps();
    prose.push(line);
  }
  if (table.length) flushTable();
  flushSteps();
  flushProse();
  return blocks;
}
