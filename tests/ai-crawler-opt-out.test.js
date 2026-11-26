import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { catalogue } from "../src/lib/i18n.js";
import {
  AI_CRAWL_DIRECTIVES,
  DEFAULT_ROBOTS,
  robotsForLocation,
  robotsForPath,
  withAiCrawlDirectives,
} from "../src/lib/publicPageMetadata.js";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

// Owner request 2026-09-29: the website and the apps tell AI crawlers, bots
// and agents not to collect them. The policy is published through every
// channel such readers use, and this file pins each one so they cannot drift
// apart: robots.txt (per-agent groups plus the Content Signals line), the
// X-Robots-Tag and TDM-Reservation headers (vercel.json), <meta name="robots"> and <meta name="tdm-reservation">
// in every HTML shell, /.well-known/tdmrep.json, the no-JavaScript notice in
// index.html, and the Terms clause humans read (mirrored in the native app by
// apps/mobile/src/lib/legalDocuments.test.ts).

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const vercel = JSON.parse(read("vercel.json"));

// A few well-known operators from every category: training crawlers, AI
// search and answer fetchers, agentic browsers, dataset builders. The full
// list in robots.txt is longer; these are the ones that must never drop out.
const REQUIRED_AI_AGENTS = [
  "GPTBot", "ChatGPT-User", "OAI-SearchBot",
  "ClaudeBot", "Claude-User", "anthropic-ai",
  "Google-Extended", "Applebot-Extended",
  "Meta-ExternalAgent", "Amazonbot",
  "PerplexityBot", "Perplexity-User",
  "Bytespider", "CCBot", "cohere-ai", "MistralAI-User",
];

function robotsGroups(text) {
  const groups = [];
  let current = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const key = field.trim().toLowerCase();
    if (key === "user-agent") {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
    } else if (key === "sitemap") {
      groups.sitemap = value;
    } else if (current) {
      current.rules.push([key, value]);
    }
  }
  return groups;
}

// The group an RFC 9309 reader obeys: the one naming its product token
// (case-insensitive), else the "*" group.
function groupFor(groups, token) {
  return groups.find((group) => group.agents.some((agent) => agent.toLowerCase() === token.toLowerCase()))
    ?? groups.find((group) => group.agents.includes("*"));
}

// Vendor-published tokens of the general search engines and link-preview
// fetchers (sources cited in robots.txt). Owner instruction 2026-10-19: every
// other automated agent is denied the whole site, even to fetch a page for
// information, answers or summaries.
const SEARCH_AGENTS = [
  "Googlebot", "Bingbot", "DuckDuckBot", "Applebot", "PetalBot",
  "facebookexternalhit", "Twitterbot", "LinkedInBot", "Slackbot-LinkExpanding", "Slackbot",
];

describe("AI crawler opt-out: robots.txt", () => {
  const groups = robotsGroups(read("public/robots.txt"));
  const wildcard = groups.find((group) => group.agents.includes("*"));
  const search = groups.find((group) => group.agents.includes("Googlebot"));

  it("denies every agent the whole site by default", () => {
    expect(wildcard.agents).toEqual(["*"]);
    expect(wildcard.rules).toEqual([
      ["content-signal", "search=yes, ai-input=no, ai-train=no"],
      ["disallow", "/"],
    ]);
    for (const token of ["SomeNewAgent", "python-requests", "Bravebot", "YandexBot", "Baiduspider"]) {
      expect(groupFor(groups, token), `${token} falls under the default-deny group`).toBe(wildcard);
    }
  });

  it("lets only the named search engines and link-preview fetchers onto the public pages, with the Content Signals policy", () => {
    expect(search.agents).toEqual(SEARCH_AGENTS);
    for (const token of SEARCH_AGENTS) expect(groupFor(groups, token)).toBe(search);
    expect(groupFor(groups, "googlebot")).toBe(search);
    // Link previews stay on for X, LinkedIn and Slack.
    for (const token of ["Twitterbot", "LinkedInBot", "Slackbot"]) {
      expect(groupFor(groups, token).rules, `${token} may fetch the public pages`).toContainEqual(["allow", "/"]);
    }
    expect(search.rules).toContainEqual(["content-signal", "search=yes, ai-input=no, ai-train=no"]);
    expect(search.rules).toContainEqual(["allow", "/"]);
    for (const path of ["/api/", "/m", "/design/", "/demo", "/verify"]) {
      expect(search.rules).toContainEqual(["disallow", path]);
    }
    expect(groups.filter((group) => group.rules.some(([key, value]) => key === "allow" && value === "/"))).toEqual([search]);
    // Union Ground has no public origin, so robots.txt names no sitemap.
    expect(groups.sitemap).toBeUndefined();
    expect(read("public/robots.txt")).not.toMatch(/^\s*sitemap:/im);
  });

  it("denies the AI fetchers that the Content-Signal line alone would not stop", () => {
    for (const token of ["GPTBot", "ClaudeBot", "Claude-User", "PerplexityBot", "Google-Extended"]) {
      expect(groupFor(groups, token).rules, `${token} must be denied /`).toEqual([["disallow", "/"]]);
    }
  });

  it("disallows every AI crawler, fetcher, agent and dataset builder from the whole site", () => {
    for (const agent of REQUIRED_AI_AGENTS) {
      const group = groups.find((entry) => entry.agents.includes(agent));
      expect(group, `${agent} must have a robots.txt group`).toBeTruthy();
      expect(group.rules, `${agent} must be disallowed from /`).toEqual([["disallow", "/"]]);
    }
    const aiAgents = groups.filter((group) => group !== wildcard && group !== search).flatMap((group) => group.agents);
    expect(new Set(aiAgents.map((agent) => agent.toLowerCase())).size).toBe(aiAgents.length);
    // Exact count so that dropping a token is an explicit test change, not a
    // silent edit. Bare generic tokens ("Spider") stay out: substring-matching
    // parsers would read them onto search crawlers such as Baiduspider.
    expect(aiAgents).toHaveLength(177);
    expect(aiAgents).not.toContain("Spider");
    for (const searchEngine of ["Googlebot", "Bingbot", "DuckDuckBot", "Applebot", "YandexBot", "Baiduspider", "Bravebot", "PetalBot", "facebookexternalhit", "Twitterbot", "LinkedInBot"]) {
      expect(aiAgents.map((agent) => agent.toLowerCase())).not.toContain(searchEngine.toLowerCase());
    }
  });

  it("states the policy and its other channels for a human reading the file", () => {
    const robots = read("public/robots.txt");
    expect(robots).toContain("not permitted");
    expect(robots).toContain("See /terms on this site.");
    expect(robots).not.toMatch(/unionground\.net/i);
    expect(siblingIdentityIn(robots)).toEqual([]);
    expect(robots).toContain("X-Robots-Tag: noarchive, noai, noimageai");
    expect(robots).toContain("TDM-Reservation: 1");
    expect(robots).toContain("/.well-known/tdmrep.json");
    expect(robots).toContain("No automated agent may fetch this site, for any purpose");
    expect(robots).toContain("information, answers or summaries");
    expect(robots).toContain("It is not the\n# access rule");
  });
});

describe("AI crawler opt-out: response headers", () => {
  // "/(.*)" is the only source that also matches the bare root: Vercel's
  // "/:path*" leaves "/" (the landing page) without the headers, verified on a
  // preview deployment on 2026-09-29.
  const policyIndex = vercel.headers.findIndex((rule) => rule.source === "/(.*)" && !rule.has && rule.headers.some((header) => header.key === "TDM-Reservation"));

  it("publishes the AI directives and the TDM reservation on every path, including the root", () => {
    expect(policyIndex).toBeGreaterThan(0);
    expect(vercel.headers[policyIndex]).toEqual({
      source: "/(.*)",
      headers: [
        { key: "X-Robots-Tag", value: AI_CRAWL_DIRECTIVES },
        { key: "TDM-Reservation", value: "1" },
      ],
    });
    // The dynamic public-page handler served the left-out public chapter
    // directory; Union Ground ships no such handler, so vercel.json is the
    // only place the headers are set.
    expect(existsSync(resolve(process.cwd(), "api/public-page.js"))).toBe(false);
    expect(vercel.functions?.["api/public-page.js"]).toBeUndefined();
    // The site-wide security rule keeps its own block, found first by the
    // security tests, so the two never merge or swap.
    const siteWide = vercel.headers.find((rule) => rule.source === "/(.*)" && !rule.has);
    expect(siteWide.headers.some((header) => header.key === "Content-Security-Policy")).toBe(true);
    expect(vercel.headers.indexOf(siteWide)).toBeLessThan(policyIndex);
  });

  it("keeps the AI directives on every later rule that overrides X-Robots-Tag", () => {
    // On Vercel the last matching rule wins a shared header key, so a later
    // noindex rule that dropped "noai" would silently remove the opt-out, and
    // a noindex rule placed before the policy rule would lose its noindex.
    expect(vercel.headers.slice(0, policyIndex).some((rule) => rule.headers.some((header) => header.key === "X-Robots-Tag"))).toBe(false);
    const later = vercel.headers.slice(policyIndex + 1).filter((rule) => rule.headers.some((header) => header.key === "X-Robots-Tag"));
    expect(later.length).toBeGreaterThanOrEqual(6);
    for (const rule of later) {
      const value = rule.headers.find((header) => header.key === "X-Robots-Tag").value;
      expect(value, `${rule.source} ${JSON.stringify(rule.has || [])}`).toBe(withAiCrawlDirectives("noindex, nofollow"));
    }
    // The public organization landing pages (/orgs/:slug) are left out of
    // Union Ground, so no rule keeps their "follow" exception.
    expect(vercel.headers.some((rule) => rule.source === "/orgs/:slug")).toBe(false);
    // Union Ground has no product host of its own, and no header rule may
    // be keyed to a Union Ground host.
    const hostConditions = vercel.headers.flatMap((rule) => (rule.has || []).filter((condition) => condition.type === "host"));
    for (const condition of hostConditions) {
      expect(condition.value).not.toMatch(/unionground\.net/i);
      expect(siblingIdentityIn(condition.value)).toEqual([]);
    }
  });

  it("serves the TDM Reservation Protocol file with its content type outside the SPA fallback", () => {
    expect(JSON.parse(read("public/.well-known/tdmrep.json"))).toEqual([{ location: "/", "tdm-reservation": 1 }]);
    const rule = vercel.headers.find((entry) => entry.source === "/.well-known/tdmrep.json");
    expect(rule.headers).toContainEqual({ key: "Content-Type", value: "application/json; charset=utf-8" });
    expect(vercel.rewrites.some((entry) => entry.source === "/.well-known/tdmrep.json")).toBe(false);
  });
});

describe("AI crawler opt-out: HTML shells and page metadata", () => {
  it("appends the AI directives to every robots value without changing the indexing policy", () => {
    expect(AI_CRAWL_DIRECTIVES).toBe("noarchive, noai, noimageai");
    expect(withAiCrawlDirectives(DEFAULT_ROBOTS)).toBe("index, follow, noarchive, noai, noimageai");
    // The private policy already carries noarchive; it is never doubled.
    expect(withAiCrawlDirectives("noindex, nofollow, noarchive")).toBe("noindex, nofollow, noarchive, noai, noimageai");
    expect(robotsForPath("/")).toBe("index, follow, noarchive, noai, noimageai");
    expect(robotsForPath("/verify")).toBe("noindex, nofollow, noarchive, noai, noimageai");
    expect(robotsForPath("/m/cases")).toBe("noindex, nofollow, noarchive, noai, noimageai");
    // There is no public union catalog: /unions is a private, unindexed path
    // and a catalog query string cannot open it to indexing.
    expect(robotsForLocation("/unions", "?org=olms-900000001")).toBe("noindex, nofollow, noarchive, noai, noimageai");
    expect(robotsForPath("/unions")).toBe("noindex, nofollow, noarchive, noai, noimageai");
    expect(robotsForPath("/chapters")).toBe("noindex, nofollow, noarchive, noai, noimageai");
  });

  it("ships the directives, the TDM meta tag and a plain notice in the static shells", () => {
    const index = read("index.html");
    expect(index).toContain('<meta name="robots" content="index, follow, noarchive, noai, noimageai" />');
    expect(index).toContain('<meta name="tdm-reservation" content="1" />');
    expect(index).toContain("Notice to crawlers, bots, and AI agents");
    expect(index).toContain('not permitted. See <a href="/terms">Terms</a>.');
    expect(index.indexOf("Notice to crawlers")).toBeLessThan(index.indexOf("/src/main.jsx"));
    for (const shell of ["public/404.html", "public/offline.html"]) {
      const html = read(shell);
      expect(html, shell).toContain('<meta name="robots" content="noindex, nofollow, noarchive, noai, noimageai" />');
      expect(html, shell).toContain('<meta name="tdm-reservation" content="1" />');
    }
  });
});

// Owner follow-up 2026-09-29: the note must name AI providers and agents,
// not only describe them. The same names appear in every human-readable
// channel so a provider cannot claim the notice did not reach it.
const NAMED_PROVIDERS = [
  "OpenAI", "Anthropic", "Google", "Microsoft", "Meta", "Amazon", "Apple",
  "Perplexity", "xAI", "Mistral", "Cohere", "ByteDance", "DeepSeek", "Common Crawl",
];

describe("AI crawler opt-out: named providers and agents", () => {
  // The provider name as a whole word that is not a bot token: "Apple" must
  // not be satisfied by "Applebot-Extended", nor "Google" by "Google-Extended".
  const namesProvider = (text, provider) => new RegExp(`(?<![\\w-])${provider}(?![\\w-])`).test(text);

  it("names every provider in the robots.txt policy comment, the no-JavaScript notice and the Terms", () => {
    const robots = read("public/robots.txt");
    const policySentence = robots.slice(robots.indexOf("This applies to every AI provider"), robots.indexOf("Every response also carries"));
    expect(policySentence.length).toBeGreaterThan(100);
    const notice = read("index.html").match(/<p>Notice to crawlers[^<]*/)[0];
    for (const provider of NAMED_PROVIDERS) {
      expect(namesProvider(policySentence, provider), `robots.txt policy names ${provider}`).toBe(true);
      expect(namesProvider(notice, provider), `index.html notice names ${provider}`).toBe(true);
      for (const locale of ["en", "es"]) {
        expect(namesProvider(catalogue[locale]["legal.terms.aiProviders.body"], provider), `${locale} terms name ${provider}`).toBe(true);
      }
    }
    expect(namesProvider("Applebot-Extended and Google-Extended", "Apple")).toBe(false);
    expect(namesProvider("Applebot-Extended and Google-Extended", "Google")).toBe(false);
    for (const kind of ["agentic browser", "coding agent"]) {
      expect(notice).toContain(kind);
      expect(policySentence).toContain(kind);
      expect(catalogue.en["legal.terms.aiProviders.body"]).toContain(kind);
    }
    expect(catalogue.en["legal.terms.aiProviders.body"]).toMatch(/whether or not it identifies itself/);
    expect(catalogue.es["legal.terms.aiProviders.body"]).toMatch(/^La regla de acceso automatizado anterior se aplica/);
    expect(read("src/views/LegalView.jsx")).toContain('["legal.terms.aiProviders.title", "legal.terms.aiProviders.body"]');
  });
});

describe("AI crawler opt-out: the Terms clause people read", () => {
  it("publishes the automated-access clause in both locales and on the terms page", () => {
    for (const locale of ["en", "es"]) {
      expect(catalogue[locale]["legal.terms.automated.title"], locale).toBeTruthy();
      expect(catalogue[locale]["legal.terms.automated.body"], locale).toContain("Union Ground");
      expect(catalogue[locale]["legal.terms.automated.body"], locale).not.toMatch(/LLC/);
    }
    expect(catalogue.en["legal.terms.automated.body"]).toMatch(/without written permission\. Search engines/);
    expect(catalogue.en["legal.terms.automated.body"]).toMatch(/Search engines may still index public pages/);
    expect(catalogue.es["legal.terms.automated.body"]).toMatch(/^No uses herramientas automatizadas para recopilar/);
    expect(read("src/views/LegalView.jsx")).toContain('["legal.terms.automated.title", "legal.terms.automated.body"]');
  });
});
