import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("public company discovery", () => {
  it("ships crawlable product identity before JavaScript", () => {
    const html = read("index.html");

    // Union Ground has no product domain or operating company of its own
    // yet, so the shell names the product and its purpose but publishes no
    // canonical origin, no Organization JSON-LD and no official-service identity.
    expect(html).toContain("<title>Union Ground</title>");
    expect(html).toContain('<meta property="og:site_name" content="Union Ground" />');
    expect(html).toContain('class="crawl-fallback"');
    expect(html).toContain("<h1>Union Ground</h1>");
    expect(html).toContain("Union Ground is an organizing workspace for workers and committees who are forming a union.");
    expect(html).toContain("Choosing an election or voluntary recognition path, and bargaining a first contract");
    expect(html).not.toContain('type="application/ld+json"');
    expect(html).not.toMatch(/unionground\.net/);
    expect(siblingIdentityIn(html)).toEqual([]);
    expect(html.indexOf("crawl-fallback")).toBeLessThan(html.indexOf('/src/main.jsx'));
  });

  it("publishes a real robots file and sitemap", () => {
    const robots = read("public/robots.txt");
    const sitemap = read("public/sitemap.xml");

    // Union Ground has no public origin yet, and sitemap locations must be
    // absolute URLs: robots names no sitemap and the sitemap lists nothing,
    // never a sibling product's domain.
    expect(robots).not.toMatch(/^Sitemap:/m);
    expect(robots).toContain("Content-Signal: search=yes, ai-input=no, ai-train=no");
    expect(robots).toContain("Disallow: /m");
    expect(robots).toContain("Disallow: /verify");
    expect(robots).toContain("Disallow: /demo");
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemap).not.toContain("<loc>");
    for (const file of [robots, sitemap]) {
      expect(file).not.toMatch(/unionground\.net/);
      expect(siblingIdentityIn(file)).toEqual([]);
    }
    expect(sitemap).not.toContain("/verify");
    expect(sitemap).not.toContain("/demo");
    // The public chapter directory and the public union catalog are left out
    // of Union Ground, so the sitemap lists neither.
    expect(sitemap).not.toMatch(/\/chapters\b/);
    expect(sitemap).not.toMatch(/\/unions\b/);
    expect(sitemap).not.toMatch(/\/events\//);
  });

  it("builds crawler-visible route documents with per-route metadata before JavaScript", async () => {
    const { PUBLIC_STATIC_ROUTES, renderPublicRouteHtml } = await import("../scripts/public-route-metadata.mjs");
    const shell = read("index.html");
    const expectations = new Map([
      ["/about", "About Union Ground"],
      ["/contact", "Contact | Union Ground"],
      ["/operator", "Who runs this server | Union Ground"],
      ["/privacy", "Privacy | Union Ground"],
      ["/subprocessors", "Subprocessors and AI processing | Union Ground"],
      ["/telemetry", "Telemetry and browser storage | Union Ground"],
      ["/privacy/deletion-request", "Request account deletion | Union Ground"],
      ["/terms", "Terms of use | Union Ground"],
      ["/accessibility", "Accessibility | Union Ground"],
      ["/accessibility/statement", "Accessibility statement | Union Ground"],
      ["/ai-disclosure", "How the Guide uses AI | Union Ground"],
      ["/retention", "Data retention schedule | Union Ground"],
      ["/verify", "Verify a vote receipt | Union Ground"],
    ]);

    // One instrument route
    // behind each summary plus the public version history, registered from
    // src/lib/legalInstruments.js. They are crawler-visible documents like the
    // summaries, kept out of the index until the professional review clears
    // the text (src/lib/publicPageMetadata.js).
    const { LEGAL_CHANGELOG_PATH, LEGAL_INSTRUMENTS } = await import("../src/lib/legalInstruments.js");
    for (const entry of LEGAL_INSTRUMENTS) {
      expectations.set(entry.path, `${entry.englishName} — full instrument | Union Ground`);
    }
    expectations.set(LEGAL_CHANGELOG_PATH, "Legal version history | Union Ground");
    expect(PUBLIC_STATIC_ROUTES).toEqual([...expectations.keys()]);
    for (const entry of [...LEGAL_INSTRUMENTS.map((instrument) => instrument.path), LEGAL_CHANGELOG_PATH]) {
      expect(renderPublicRouteHtml(shell, entry)).toContain('name="robots" content="noindex, follow, noarchive, noai, noimageai"');
    }
    for (const [route, title] of expectations) {
      const html = renderPublicRouteHtml(shell, route);
      expect(html).toContain(`<title>${title}</title>`);
      expect(html).not.toMatch(/Union Base|Compass/);
      // The shell carries no canonical link or og:url (Union Ground has no
      // product origin), so a route document cannot gain one either.
      expect(html).not.toContain('rel="canonical"');
      expect(html).not.toContain('property="og:url"');
      expect(html.indexOf(`<title>${title}</title>`)).toBeLessThan(html.indexOf('/src/main.jsx'));
    }
    // The left-out public directory and union catalog have no route document.
    for (const route of ["/chapters", "/unions", "/orgs/example", "/unions/claim/confirm"]) {
      expect(PUBLIC_STATIC_ROUTES).not.toContain(route);
      expect(() => renderPublicRouteHtml(shell, route), route).toThrow(/No public metadata registered/);
    }
  });

  it("publishes summary preview metadata without a social image on a foreign origin", () => {
    const html = read("index.html");

    // With no product origin there is no absolute URL for a large social card,
    // so the shell publishes a plain summary card and its own text.
    expect(html).toContain('<meta property="og:title" content="Union Ground" />');
    expect(html).toContain('<meta property="og:description" content="An organizing workspace for workers and committees forming a union." />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).not.toContain('property="og:image"');
    expect(html).not.toContain('name="twitter:image"');
    expect(html).toContain('name="robots" content="index, follow, noarchive, noai, noimageai"');
  });

  it("keeps discovery files outside the SPA fallback and provides a demo URL", () => {
    const vercel = JSON.parse(read("vercel.json"));
    const spaRoutes = new Set(vercel.rewrites.filter((entry) => entry.destination === "/index.html").map((entry) => entry.source));

    expect(vercel.trailingSlash).toBe(false);
    for (const route of ["about", "contact", "pricing", "press", "pilot", "privacy", "subprocessors", "telemetry", "privacy/deletion-request", "terms", "accessibility", "accessibility/statement", "ai-disclosure", "retention", "verify", "robots.txt", "sitemap.xml", "union-ground-social.png"]) {
      expect(spaRoutes.has(`/${route}`), `/${route} must bypass the SPA route allowlist`).toBe(false);
    }
    expect(spaRoutes.has("/m/events")).toBe(true);
    expect(spaRoutes.has("/m/events/"), "trailing slashes must canonicalize to the exact SPA allowlist entry").toBe(false);
    expect(spaRoutes.has("/m/member"), "unknown member paths get no exact rewrite; only the last /m/:path* fallback serves them").toBe(false);
    expect(vercel.rewrites.at(-1), "unknown member paths reach the shell's own not-found page").toEqual({ source: "/m/:path*", destination: "/index.html" });
    expect(spaRoutes.has("/auth")).toBe(true);
    expect(spaRoutes.has("/sign-in")).toBe(true);
    // Union Ground has one deployment and no separate demo host: /demo
    // opens the auth-free demo of the same site, with no host-specific rule.
    const demoRedirects = vercel.redirects.filter((entry) => entry.source === "/demo");
    expect(demoRedirects).toEqual([{ source: "/demo", destination: "/m?demo=1", permanent: false }]);
    expect(JSON.stringify(vercel.redirects)).not.toMatch(/unionground\.net/);
    expect(siblingIdentityIn(JSON.stringify(vercel.redirects))).toEqual([]);
    expect(spaRoutes.has("/demo")).toBe(false);
    expect(read("public/404.html")).toContain("Page not found");
  });

  it("makes built route-document verification part of every production build", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts.build).toBe(
      "vite build && node scripts/prune-deployed-design.mjs && node scripts/verify-public-route-build.mjs && node scripts/verify-runtime-config-isolation.mjs && node scripts/carry-previous-assets.mjs",
    );
    expect(read("scripts/verify-public-route-build.mjs")).toContain("dist/${route.slice(1)}/index.html");
  });

  it("declares site-wide HSTS in the deployment config, not only at the edge", () => {
    // SEC-UG-VERCEL-HSTS-HEADER-20260817: a preview alias or any path that
    // reaches the Vercel origin directly bypasses an edge, so the deployment
    // config carries HSTS itself. Union Ground keeps the two-year maximum
    // from Union Ground together with its own includeSubDomains (it has no
    // custom domain whose subdomains could still need plain HTTP); preload
    // stays absent.
    const vercel = JSON.parse(read("vercel.json"));
    const siteWide = vercel.headers.find((entry) => entry.source === "/(.*)" && !entry.has);

    expect(siteWide, "vercel.json must carry a site-wide header block").toBeTruthy();
    expect(siteWide.headers).toContainEqual({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains",
    });

    // No later matching rule may drop or weaken it: on Vercel the last rule
    // that matches a path wins the shared header key.
    const siteWideIndex = vercel.headers.indexOf(siteWide);
    for (const entry of vercel.headers.slice(siteWideIndex + 1)) {
      const override = entry.headers.find((header) => header.key === "Strict-Transport-Security");
      expect(override, `${entry.source} must not override site-wide HSTS`).toBeUndefined();
    }
  });
});
