// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { STATIC_SHELL_SECURITY_HEADERS } from "../api/_lib/http.js";
import { WORKSPACE_PATH_VIEWS } from "../src/lib/workspacePages.js";
import { STANDALONE_DOCUMENT, STANDALONE_DOCUMENT_ROUTES } from "../scripts/member-shell-build.mjs";

const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
// The public chapter directory, public events and Union Ground's public union
// catalog are left out of Union Ground: none of their shapes may be
// deployed, whether through the dynamic metadata handler or the static shell.
const leftOutPublicRoutes = [
  "/chapters",
  "/chapters/:code",
  "/chapters/:code/:section",
  "/chapters/:code/:section/:page",
  "/events/:eventId",
  "/unions",
  "/orgs/:slug",
  "/unions/claim/confirm",
];
// Left-out member pages: dues, contract clauses, civic action and the
// membership card with its public verifier.
const leftOutShellRoutes = [
  "/m/card",
  "/verify-card",
  "/m/dues",
  "/m/clauses",
  "/m/civic",
  "/m/civic/officials",
  "/m/civic/act",
  "/m/civic/outcomes",
  "/m/civic/ratings",
  "/m/civic/officer/campaigns",
  "/m/civic/officer/ratings",
  "/m/civic/officer/local",
];
const unchangedShellRoutes = [
  "/m/automations",
  "/auth",
  "/signin",
  "/sign-in",
  "/login",
  "/invite",
  "/app/invite",
  "/signup",
  "/signup/confirm",
  // REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006: the reset form and
  // the emailed recovery link, a fragment-only shell route.
  "/reset-password",
  "/app/reset-password",
  "/get-app",
  "/request-invite",
  // SEC-UG-PUBLIC-INTEREST-SUPPRESSION-CONFIRMATION-20260921: the emailed
  // single-use stop confirmation lands on this fragment-only shell route.
  "/stop-updates",
  "/m",
  "/m/messages",
  "/m/numbers",
  "/m/voting",
  "/m/voice",
  "/m/qa",
  "/m/pay",
  "/m/cases",
  "/m/rights",
  // REQ-UG-MEMBER-ORG-STRUCTURE-VIEW-20260922. A plain member page with no
  // tab group, so it is a shell route rather than a WORKSPACE_PATH_VIEWS entry,
  // and it keeps its position next to the rewrite it was added beside.
  "/m/org-structure",
  "/m/support",
  // REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001: the real-account Site Guide.
  "/m/guide",
  "/m/events",
  "/m/appointments",
  "/m/settings",
  "/m/access-history",
  "/m/workload",
  "/m/forms",
  "/m/rewards",
  "/m/search",
  "/m/organize",
  "/m/network",
  "/m/steward",
  "/m/coordinator",
  "/m/advisor",
  "/m/admin",
  "/m/vp",
  "/m/tasks",
  "/m/events-desk",
  "/m/campaigns",
  "/m/integrations",
  "/m/analytics",
  "/m/organization-map",
  "/m/actions",
  "/m/coordination",
  "/m/qa-queue",
  // Union Ground's own shell routes: the worker Work page and the public
  // organizing pages (src/lib/appRoutes.js UNIONGROUND_PUBLIC_SPA_PATHS).
  "/m/work",
  "/learn",
  "/connect",
  // Retired Union Ground paths: the app shows RetiredLegacyView (noindex)
  // for every one of them instead of redirecting.
  "/contractsurvey",
  "/design",
  "/m/pulse",
  "/m/updates",
  "/contractsurvey/:path*",
  "/design/:path*",
  // UB-UG-UNKNOWN-APP-ADDRESS-LEAVES-SHELL-20261106: the last shell
  // rewrite serves every other /m address, so the shell shows its not-found.
  "/m/:path*",
];

describe("public page deployment routing", () => {
  it("deploys no public chapter, event or union-catalog page and no metadata handler for them", () => {
    const sources = vercel.rewrites.map((rewrite) => rewrite.source);
    for (const source of leftOutPublicRoutes) expect(sources, source).not.toContain(source);
    expect(vercel.rewrites.filter((rewrite) => /\/api\/public-page\b/.test(rewrite.destination))).toEqual([]);
    expect(vercel.functions["api/public-page.js"]).toBeUndefined();
    expect(existsSync("api/public-page.js")).toBe(false);
  });

  it("deploys no left-out member page as a shell route", () => {
    const sources = vercel.rewrites.map((rewrite) => rewrite.source);
    for (const source of leftOutShellRoutes) expect(sources, source).not.toContain(source);
    expect(sources.filter((source) => source.startsWith("/m/civic"))).toEqual([]);
  });

  it("preserves every static-shell rewrite", () => {
    const shellRewrites = vercel.rewrites.filter((rewrite) => ["/index.html", `/${STANDALONE_DOCUMENT}`].includes(rewrite.destination));
    // Preserve the original routes in their original order, while accounting
    // exactly for the separately registered focused workspace destinations.
    // The standalone routes get the app document without the member shell
    // preload; every other shell route keeps index.html.
    const documentFor = (source) => (STANDALONE_DOCUMENT_ROUTES.includes(source) ? `/${STANDALONE_DOCUMENT}` : "/index.html");
    expect(shellRewrites.filter(({ source }) => unchangedShellRoutes.includes(source)))
      .toEqual(unchangedShellRoutes.map((source) => ({ source, destination: documentFor(source) })));
    expect(shellRewrites.filter(({ source }) => !unchangedShellRoutes.includes(source))
      .sort((a, b) => a.source.localeCompare(b.source)))
      .toEqual(Object.keys(WORKSPACE_PATH_VIEWS).sort((a, b) => a.localeCompare(b))
        .map((source) => ({ source, destination: "/index.html" })));
  });

  it("carries no header rule for the left-out public organization landing page", () => {
    expect(vercel.headers.filter((entry) => leftOutPublicRoutes.includes(entry.source))).toEqual([]);
    expect(vercel.headers.filter((entry) => leftOutShellRoutes.includes(entry.source))).toEqual([]);
  });

  // The public-page handler is gone, but server-rendered HTML (secureHtml in
  // api/_lib/http.js, used by api/email-unsubscribe.js) still sends this
  // policy, and it must stay the static shell's.
  it("keeps the server-rendered HTML security policy exactly equal to the static shell policy", () => {
    const siteWide = vercel.headers.find((entry) => entry.source === "/(.*)" && !entry.has);
    expect(Object.fromEntries(siteWide.headers.map(({ key, value }) => [key, value])))
      .toEqual(STATIC_SHELL_SECURITY_HEADERS);
  });
});
