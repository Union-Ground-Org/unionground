import registerData from "../data/subprocessors.json" with { type: "json" };
import { renderRegisterMarkdownFrom } from "./subprocessorRegisterMarkdown.js";

export const register = registerData;
const DAY = 86_400_000;

function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Expected a calendar date");
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new Error("Invalid calendar date");
  return parsed;
}

// This creates a public advance notice, not permission to activate a provider.
// Existing entries are never edited; an operator must separately retain delivery
// evidence and verify the start window before changing production configuration.
export function appendProviderNotice(current, provider, announced, starts) {
  if (current.providers.some(({ id }) => id === provider.id)) throw new Error("duplicate provider");
  if (dateValue(starts) - dateValue(announced) < 15 * DAY) throw new Error("At least 15 days of notice required");
  if (announced < current.history.at(-1).announced) throw new Error("Notice dates must be chronological");
  for (const lang of ["en", "es"]) {
    if (!provider[lang]?.country || !provider[lang]?.scope) throw new Error("Both languages require country and data scope");
  }
  return {
    ...current,
    reviewed: announced,
    providers: [...current.providers, { ...provider, starts }],
    history: [...current.history, { kind: "notice", announced, starts, providers: [provider.id] }],
  };
}

// An amendment corrects a retained provider's published scope to a smaller one
// and swaps proof that no longer exists. It is not a notice: anything that
// widens processing, or adds a provider, still needs appendProviderNotice. The
// replaced row stays in history unchanged, so the earlier wording remains
// public. Scope is free text, so "narrower" is a reviewed statement in the
// bilingual summary; this function enforces everything else that can be checked.
export function appendProviderAmendment(current, provider, announced, summary) {
  const previous = current.providers.find(({ id }) => id === provider.id);
  if (!previous) throw new Error("An amendment may only change a retained provider");
  dateValue(announced);
  if (announced < current.history.at(-1).announced) throw new Error("Amendment dates must be chronological");
  const keys = (row) => Object.keys(row).sort().join();
  if (keys(provider) !== keys(previous)) throw new Error("An amendment may not add or remove provider fields");
  const fixed = ({ id, name, starts, sources, en, es }) => JSON.stringify({ id, name, starts, sources, country: [en?.country, es?.country] });
  if (fixed(provider) !== fixed(previous)) throw new Error("An amendment may not change identity, location, sources or start date");
  for (const lang of ["en", "es"]) {
    if (!provider[lang]?.scope || !summary?.[lang]) throw new Error("Both languages require the amended scope and a summary");
    if (keys(provider[lang]) !== keys(previous[lang])) throw new Error("An amendment may only change the scope text");
  }
  if ((provider.en.scope === previous.en.scope) !== (provider.es.scope === previous.es.scope)) throw new Error("Amend both languages together");
  if (!provider.evidence?.length) throw new Error("An amended provider still needs evidence");
  if (JSON.stringify(provider) === JSON.stringify(previous)) throw new Error("An amendment must change the scope or evidence");
  return {
    ...current,
    reviewed: announced,
    providers: current.providers.map((entry) => (entry.id === provider.id ? provider : entry)),
    history: [...current.history, { kind: "amendment", announced, providers: [provider.id], summary, previous }],
  };
}

export function renderRegisterMarkdown(lang) {
  return renderRegisterMarkdownFrom(register, lang);
}

// REQ-UG-LOVABLE-PUBLIC-SITE-BATCH-B-PORT-20261103 (WEB-PUB-15): a
// retained provider's location text is locked (appendProviderAmendment), and
// two carry an internal review note ("[B-6 — counsel: …]", "[B-7 — owner: …]")
// for the counsel packet. The public page drops the note; the register data
// and the generated policy table keep it.
export function withoutReviewNote(text) {
  return String(text).replace(/\s*\[B-\d+ — [^\]]*\]/g, "");
}
