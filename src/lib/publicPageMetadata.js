import { LEGAL_CHANGELOG_PATH, LEGAL_INSTRUMENTS } from "./legalInstruments.js";

// Union Ground publishes no public website yet (apps/mobile/src/lib/
// publicSite.ts says the same for the native app), so there is no origin to
// name in a canonical link, an og:url, a social image or the sitemap. Every
// writer of those values omits them while this is "". Set it once an
// owner-approved Union Ground domain exists; never a sibling product's.
export const PUBLIC_ORIGIN = "";
export const SOCIAL_IMAGE_URL = PUBLIC_ORIGIN ? `${PUBLIC_ORIGIN}/union-ground-social.png` : "";

// The absolute canonical URL for a public path, or "" while no public origin
// exists.
export function canonicalUrlForPath(path) {
  return PUBLIC_ORIGIN ? `${PUBLIC_ORIGIN}${path}` : "";
}

// Owner request 2026-09-29: every page tells AI crawlers, bots and agents not
// to collect the site. "noarchive" is the directive Bing documents as "do not
// use for training Microsoft's generative AI models and do not link in Chat
// and Copilot" while the page stays in search results (Google lists it as
// unused and ignores it). "noai, noimageai" are the DeviantArt-originated
// directives dataset tools read: img2dataset honours them in the X-Robots-Tag
// header, and the same tokens are published in <meta name="robots"> for
// readers that look there. Search engines ignore directives they do not
// know, so the indexing policy in front of them is unchanged.
// public/robots.txt, the TDM-Reservation header (vercel.json,
// api/public-page.js) and public/.well-known/tdmrep.json state the same policy
// for readers that use those channels. tests/ai-crawler-opt-out.test.js pins
// every channel.
export const AI_CRAWL_DIRECTIVES = "noarchive, noai, noimageai";
export const DEFAULT_ROBOTS = "index, follow";

// Appends the directive set to an indexing policy, keeping each token once
// (the private policy already carries noarchive).
export function withAiCrawlDirectives(robots) {
  const tokens = [];
  for (const token of `${robots}, ${AI_CRAWL_DIRECTIVES}`.split(",")) {
    const trimmed = token.trim();
    if (trimmed && !tokens.includes(trimmed)) tokens.push(trimmed);
  }
  return tokens.join(", ");
}

const LANDING = {
  title: "Union Ground | Organizing software for workers forming a union",
  description: "Union Ground is an organizing workspace for workers and committees forming a union: committees, cards, meetings, issues, and a first contract.",
  path: "/",
};

// BUG-UG-PUBLIC-PAGE-TITLE-MEMBER-WORKSPACE-20261003: the sign-in,
// invitation and app pages are public but used to fall through to the private
// "Member workspace" title. They keep the private pages' noindex policy.
const SIGN_IN = {
  title: "Sign in | Union Ground",
  titleEs: "Inicia sesión | Union Ground",
  description: "Sign in to Union Ground with the email address and password from your invitation.",
  path: "/auth",
  robots: "noindex, nofollow, noarchive",
};

// D-13 and D-14 (owner, October 10, 2026): the instrument behind each summary
// and the public version history. They stay out of the index until the
// professional review under UB-PUB-04 clears the text and D-08's recorded
// acceptance ships — the routes are reachable and linked from the summaries,
// which is what the decision asks for; advertising a pre-operative instrument
// to search engines is not.
const LEGAL_INSTRUMENT_METADATA = Object.fromEntries(LEGAL_INSTRUMENTS.map((entry) => [
  entry.path,
  {
    title: `${entry.englishName} — full instrument | Union Ground`,
    description: `The versioned Union Ground instrument behind the ${entry.englishName} summary, with its version, its effective date and its change history.`,
    path: entry.path,
    robots: "noindex, follow",
  },
]));

export const PUBLIC_ROUTE_METADATA = Object.freeze({
  ...LEGAL_INSTRUMENT_METADATA,
  [LEGAL_CHANGELOG_PATH]: {
    title: "Legal version history | Union Ground",
    description: "Every published version of every Union Ground legal instrument, with its date and whether the change was material.",
    path: LEGAL_CHANGELOG_PATH,
    robots: "noindex, follow",
  },
  "/": LANDING,
  "/auth": SIGN_IN,
  "/signin": SIGN_IN,
  "/sign-in": SIGN_IN,
  "/login": SIGN_IN,
  "/invite": {
    title: "Accept your invitation | Union Ground",
    description: "Accept a one-time Union Ground invitation.",
    path: "/invite",
    robots: "noindex, nofollow, noarchive",
  },
  "/get-app": {
    title: "Get Union Ground | Union Ground",
    description: "Use Union Ground on the website, and on your phone once the apps are available.",
    path: "/get-app",
    robots: "noindex, nofollow, noarchive",
  },
  "/request-invite": {
    title: "Request an invitation | Union Ground",
    description: "Ask the Union Ground team for an invitation. Accounts are by invitation only.",
    path: "/request-invite",
    robots: "noindex, nofollow, noarchive",
  },
  "/stop-updates": {
    title: "Stop updates | Union Ground",
    description: "Confirm that you no longer want Union Ground updates.",
    path: "/stop-updates",
    robots: "noindex, nofollow, noarchive",
  },
  "/about": {
    title: "About Union Ground",
    description: "What Union Ground is, who it serves, and what this preview does and does not publish yet.",
    path: "/about",
  },
  "/operator": {
    title: "Who runs this server | Union Ground",
    description: "Who runs this Union Ground server, how to reach them, and where to get its source code.",
    path: "/operator",
  },
  "/contact": {
    title: "Contact | Union Ground",
    description: "How to reach Union Ground. No public mailbox is published yet.",
    path: "/contact",
  },
  "/subprocessors": {
    title: "Subprocessors and AI processing | Union Ground",
    description: "Read the dated register of Union Ground service providers, data scopes and change notices.",
    path: "/subprocessors",
  },
  "/telemetry": {
    title: "Telemetry and browser storage | Union Ground",
    description: "Read what Union Ground measures and stores, including demo analytics, error monitoring and browser storage.",
    path: "/telemetry",
  },
  "/privacy": {
    title: "Privacy | Union Ground",
    titleEs: "Privacidad | Union Ground",
    description: "Read the current Union Ground privacy summary and contact information.",
    path: "/privacy",
  },
  "/terms": {
    title: "Terms of use | Union Ground",
    titleEs: "Términos de uso | Union Ground",
    description: "Read the current Union Ground terms summary and support information.",
    path: "/terms",
  },
  "/accessibility": {
    title: "Accessibility | Union Ground",
    description: "Read the Union Ground accessibility commitments and ways to request support or an alternative format.",
    path: "/accessibility",
  },
  "/accessibility/statement": {
    title: "Accessibility statement | Union Ground",
    description: "The formal Union Ground accessibility statement: a WCAG 2.2 AA target, partial conformance, the September 2026 screen-reader evaluation, the known exceptions, and how to report a barrier.",
    path: "/accessibility/statement",
  },
  "/ai-disclosure": {
    title: "How the Guide uses AI | Union Ground",
    description: "Read how Union Ground's Guide would use AI, including human review, source citations, limitations, and worker privacy protections.",
    path: "/ai-disclosure",
  },
  "/retention": {
    title: "Data retention schedule | Union Ground",
    description: "Read the Union Ground data retention schedule for worker, campaign, issue, messaging, and audit records.",
    path: "/retention",
  },
  "/privacy/deletion-request": {
    title: "Request account deletion | Union Ground",
    description: "How to ask Union Ground to delete an account and its data: the in-app Data rights path for signed-in workers, and the verified written request for everyone else.",
    path: "/privacy/deletion-request",
  },
  "/verify": {
    title: "Verify a vote receipt | Union Ground",
    titleEs: "Verifica un comprobante de voto | Union Ground",
    description: "Check whether a Union Ground ballot receipt was counted without revealing the ballot choice.",
    path: "/verify",
    robots: "noindex, nofollow, noarchive",
  },
});

const PRIVATE = {
  title: "Union Ground | Organizing workspace",
  description: "Union Ground secure organizing workspace.",
  path: "/m",
  robots: "noindex, nofollow, noarchive",
};

function normalizedPath(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}

// Union Ground has no public union catalog, so no query string changes a
// page's indexing policy; the helper keeps its signature for its callers.
export function robotsForLocation(pathname) {
  return robotsForPath(pathname);
}

// The indexing policy registered for the path plus the AI opt-out directives:
// the one value every static route document, the SPA head and the dynamic
// public-page handler publish for <meta name="robots">.
export function robotsForPath(pathname) {
  return withAiCrawlDirectives(metadataForPath(pathname).robots || DEFAULT_ROBOTS);
}

export function metadataForPath(pathname, language = "en") {
  const metadata = PUBLIC_ROUTE_METADATA[normalizedPath(pathname)] || PRIVATE;
  return language === "es" && metadata.titleEs ? { ...metadata, title: metadata.titleEs } : metadata;
}
