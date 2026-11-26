import { boundedListsCatalogueSpanish } from "./locales/es/namespaces/boundedLists.js";
// Bounded staff and member lists (design census phase 2, 2026-10-02): the
// Home steward roster cap, the engagement survey pages and channel chapter
// groups, the coordination mission leaderboards and the campaign registry
// pages. Split out of the src/lib/i18n.js barrel like homeNudges.js: this file
// is the ONLY declaration of these keys; the barrel spreads it back into
// `catalogue`, so `t()` is unchanged.
export const boundedListsCatalogue = {
  en: {
    "today.stewardSeeAll": "See all {count} committee members",
    "today.stewardShowFewer": "Show fewer committee members",
    "engagement.surveyFilter": "Show surveys",
    "engagement.surveyFilter.all": "All",
    "engagement.surveyFilter.open": "Open",
    "engagement.surveyFilter.draft": "Drafts",
    "engagement.surveyFilter.closed": "Closed",
    "engagement.surveysShowing": "Showing {shown} of {total} surveys",
    "engagement.surveysShowMore": "Show more surveys",
    "engagement.surveysLoadingMore": "Loading more surveys…",
    "engagement.surveysLoadFailed": "More surveys could not be loaded.",
    "engagement.surveysEmptyFilter": "No surveys match this filter.",
    "engagement.channelChapter": "Campaign: {chapter}",
    "engagement.channelChapterGroup": "{chapter} ({count})",
    "engagement.channelNoChapter": "No campaign",
    "engagement.channelCardNamed": "{name}, {chapter}",
    "campaigns.loadingMore": "Loading more campaigns…",
    "campaigns.moreError": "More campaigns could not be loaded.",
  },
  get es() { return boundedListsCatalogueSpanish; },
};
