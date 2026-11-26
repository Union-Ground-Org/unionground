import { glossaryCatalogueSpanish } from "./locales/es/namespaces/glossary.js";
// The glossary namespace (REQ-UG-EXPLAINER-CONTENT-20261012), split
// out of the src/lib/i18n.js barrel like ./sourceLine.js. This file is the
// ONLY declaration of every `glossary.` key and of the glossary's setting
// labels; the barrel spreads it back into `catalogue`. The terms themselves
// are in content/explainer-content/glossary.json, in English and Spanish.
export const glossaryCatalogue = {
  en: {
    "glossary.title": "Glossary",
    "glossary.subtitle": "Plain-language meanings of the words you meet in your contract, at the union and at work.",
    "glossary.open": "Open the glossary",
    "glossary.loading": "Loading the glossary…",
    "glossary.loadFailed": "The glossary could not be loaded. Try again later.",
    "glossary.retry": "Try again",
    "glossary.disclaimer": "General information, not legal advice. Each term lists the public sources it rests on. For your own situation, talk to your committee member and read your contract.",
    "glossary.search": "Find a term",
    "glossary.count": "Terms shown: {count}",
    "glossary.seeAlso": "See also:",
    "glossary.sources": "Written for Union Ground from these public sources:",
    "glossary.scope.maPublic": "Massachusetts public sector",
    "glossary.scope.federalPrivate": "Federal law, private sector",
    "glossary.scope.unionInternal": "Inside the union",
    "settings.def.features.learn.glossary.label": "Glossary",
    "settings.def.features.learn.glossary.description": "Show workers the sourced glossary of labor terms on the Rights page, in English and Spanish, each term with its sources. General information, not legal advice.",
  },
  get es() { return glossaryCatalogueSpanish; },
};
