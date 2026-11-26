import { pricingCatalogueSpanish } from "./locales/es/namespaces/pricing.js";
// The public /pricing page, REQ-UG-PUBLIC-PRICING-PAGE-FREE-NO-COST-20261104.
// This file is the ONLY declaration of every `pricing.` key; the barrel spreads
// it back into `catalogue`, so `t()` is unchanged for every web importer.
//
// The page says
// Union Ground is free. Copy rules: no prices, plans, tiers, comparisons or
// sales contact; the fees wording is quoted from the terms
// (`legal.terms.fees.title` and `.body`), never restated here.
export const pricingCatalogue = {
  en: {
    "pricing.footerLink": "Pricing",
    "pricing.title": "Pricing",
    "pricing.intro": "Union Ground is free. There is no cost.",
    "pricing.joinTitle": "Start a free pilot",
  },
  get es() { return pricingCatalogueSpanish; },
};
