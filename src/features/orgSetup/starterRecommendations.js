// Recommendations read public facts and the current creator's answers only.
// No imported content, case text, member identity or browser storage lives here.
import { ISSUE_FAMILIES } from "../issueIntelligence/model.js";
import { dateOnly } from "../unionCatalog/catalogSearch.js";

const SECTORS = ["public", "private", "mixed"];
const DOCUMENTS = ["contract", "form", "handbook", "bylaws"];
const STARTER_PATHS = Object.freeze({
  library: "/m/organize/library",
  forms: "/m/admin/form-templates",
  structure: "/m/admin/organization",
});

export function starterCatalogContext(raw) {
  if (raw?.found !== true) return null;
  const documents = [];
  for (const doc of Array.isArray(raw.documents) ? raw.documents : []) {
    if (!DOCUMENTS.includes(doc?.kind) || typeof doc.title !== "string" || !doc.title.trim()) continue;
    try {
      const url = new URL(doc.url);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      if (documents.some((item) => item.href === url.href)) continue;
      documents.push({ kind: doc.kind, title: doc.title.trim().slice(0, 300), href: url.href, asOf: dateOnly(doc.asOf) });
    } catch { /* A missing or unsafe public link is not a recommendation. */ }
    if (documents.length === 6) break;
  }
  return {
    confidence: ["official_site", "secondary", "olms_filing", "not_found"].includes(raw.organization?.confidence) ? raw.organization.confidence : "unreviewed",
    sector: SECTORS.includes(raw.organization?.sector) ? raw.organization.sector : null,
    // Presence is enough for a setup suggestion; employer prose never leaves
    // this boundary, and is never copied into an import payload.
    agencyListed: (Array.isArray(raw.subunits) ? raw.subunits : []).some((item) => typeof item?.employer === "string" && item.employer.trim().length > 0),
    documents,
  };
}

export function buildStarterRecommendations({ catalog = null, answers = {}, caseSignals = null } = {}) {
  const items = new Map();
  const add = (id, destination, reason) => {
    if (!items.has(id)) items.set(id, { id, href: STARTER_PATHS[destination], reasons: [], documents: [] });
    const item = items.get(id);
    if (!item.reasons.includes(reason)) item.reasons.push(reason);
    return item;
  };
  if (SECTORS.includes(catalog?.sector)) add("library", "library", `sector.${catalog.sector}`);
  if (catalog?.agencyListed === true) add("structure", "structure", "agency");
  for (const doc of catalog?.documents ?? []) {
    const form = doc.kind === "form";
    const item = add(form ? "forms" : "library", form ? "forms" : "library", `document.${doc.kind}`);
    item.documents.push(doc);
  }
  if (["contract", "learning"].includes(answers.focus)) add("library", "library", `answer.${answers.focus}`);
  if (answers.focus === "support") add("forms", "forms", "answer.support");
  if (answers.multiUnit === "yes") add("structure", "structure", "answer.multiUnit");
  // Only the existing server-approved staff projection may contribute cases.
  // No count, raw case, other tenant id, or client-side case aggregation.
  if (caseSignals?.enabled === true && caseSignals.viewer === "staff") {
    for (const signal of caseSignals.signals ?? []) {
      if (!signal.evidenceFamilies?.includes("cases")) continue;
      if (signal.family === ISSUE_FAMILIES.contractRights) add("library", "library", "cases.contract");
      if (signal.family === ISSUE_FAMILIES.retaliation) add("forms", "forms", "cases.support");
    }
  }
  return [...items.values()];
}
