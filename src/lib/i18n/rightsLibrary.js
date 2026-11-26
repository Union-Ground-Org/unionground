import { rightsLibraryCatalogueSpanish } from "./locales/es/namespaces/rightsLibrary.js";
// The rights and law library namespace (REQ-UG-RIGHTS-LAW-LIBRARY-20261012),
// split out of the src/lib/i18n.js barrel like ./caseworkUlp.js. This file is
// the ONLY declaration of every `rightsLibrary.` key and of the library's
// setting labels; the barrel spreads it back into `catalogue`.
//
// The library's own content is English (no reviewed Spanish translation
// exists yet); the Spanish strings here are the surrounding interface only,
// and `rightsLibrary.englishOnly` says so.
export const rightsLibraryCatalogue = {
  en: {
    "rightsLibrary.title": "Laws and agencies",
    "rightsLibrary.subtitle": "Who enforces your rights at work in Massachusetts, and how long you have to act.",
    "rightsLibrary.disclaimerTitle": "General information, not legal advice",
    "rightsLibrary.askSteward": "Talk to your committee contact",
    "rightsLibrary.englishOnly": "This library's content is in English.",
    "rightsLibrary.loading": "Loading the library…",
    "rightsLibrary.loadFailed": "The library could not be loaded. Try again later or talk to your committee contact.",
    "rightsLibrary.retry": "Try again",
    "rightsLibrary.situations": "Something happened at work",
    "rightsLibrary.agencies": "Agencies",
    "rightsLibrary.concepts": "Rights to know",
    "rightsLibrary.guides": "Guides",
    "rightsLibrary.deadlines": "Filing deadlines",
    "rightsLibrary.noDeadlines": "No filing deadline from this agency is listed here. Ask your committee contact.",
    "rightsLibrary.howLong": "How long you have",
    "rightsLibrary.trigger": "Counted from",
    "rightsLibrary.extension": "Exceptions",
    "rightsLibrary.law": "Law",
    "rightsLibrary.quote": "What the agency says",
    "rightsLibrary.handles": "Handles",
    "rightsLibrary.contact": "Contact",
    "rightsLibrary.pagesCount": "Agency pages ({count})",
    "rightsLibrary.openGuides": "Open the guides",
    "rightsLibrary.readPage": "Read the page",
    "rightsLibrary.openAgency": "See {agency}",
    "rightsLibrary.excluded": "Not included yet: {names}.",
    "rightsLibrary.federalLaw": "Federal laws and regulations",
    "rightsLibrary.federalLawIntro": "The main federal labor laws and their regulations, each with a link to its official text.",
    "rightsLibrary.openFederalLaw": "Open the federal laws",
    "rightsLibrary.readOfficial": "Read it in the official U.S. Code",
    "rightsLibrary.regulations": "Regulations",
    "rightsLibrary.readEcfr": "Read it in the official eCFR",
    "settings.def.features.rights.law_library.label": "Laws and agencies library",
    "settings.def.features.rights.law_library.description": "Show workers the Massachusetts and federal labor-rights library on the Rights page: enforcement agencies, filing deadlines with their sources, and plain-language guides. General information, not legal advice.",
  },
  get es() { return rightsLibraryCatalogueSpanish; },
};
