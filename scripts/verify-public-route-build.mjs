import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_STATIC_ROUTES } from "./public-route-metadata.mjs";
import { canonicalUrlForPath, metadataForPath, PUBLIC_ORIGIN, robotsForPath } from "../src/lib/publicPageMetadata.js";
import { SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import { verifyMobileAppLinkArtifacts } from "./lib/mobile-app-link-policy.mjs";
import { loadEnv } from "vite";
import { resolveWebBrand } from "./lib/brand-vite-plugin.mjs";
import { applyBrandName } from "../src/lib/shared-core/brand.js";
import { STANDALONE_DOCUMENT, STANDALONE_DOCUMENT_ROUTES, standaloneDocumentProblems } from "./member-shell-build.mjs";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
// The build wrote its own product name into every title
// (scripts/lib/brand-vite-plugin.mjs); resolve it from the same settings.
const mode = process.env.MODE || "production";
const brand = resolveWebBrand({
  env: { ...loadEnv(mode, process.cwd(), "VITE_"), ...loadEnv(mode, process.cwd(), "SOURCE_CODE_URL"), NODE_ENV: process.env.NODE_ENV },
  mode,
  command: "build",
  root: process.cwd(),
});
const sitemap = read("dist/sitemap.xml");
const vercel = JSON.parse(read("vercel.json"));
const spaRoutes = new Set(
  vercel.rewrites
    .filter((entry) => ["/index.html", `/${STANDALONE_DOCUMENT}`].includes(entry.destination) || entry.destination.startsWith("/api/public-page?path="))
    .map((entry) => entry.source),
);

assert.ok(spaRoutes.size > 0, "vercel.json must declare its SPA route allowlist");
assert.equal(vercel.trailingSlash, false, "Vercel must canonicalize trailing-slash SPA URLs before exact allowlist rewrites");
assert.deepEqual(
  [...spaRoutes].sort(),
  [...SPA_ROUTE_PATHS].sort(),
  "vercel.json SPA rewrites must exactly match the application route registry",
);

for (const route of PUBLIC_STATIC_ROUTES) {
  const metadata = metadataForPath(route);
  const documentPath = `dist/${route.slice(1)}/index.html`;
  const html = read(documentPath);
  const canonical = canonicalUrlForPath(route);

  assert.ok(html.includes(`<title>${applyBrandName(metadata.title, brand.name)}</title>`), `${documentPath} has the wrong title`);
  if (canonical) {
    assert.ok(html.includes(`rel="canonical" href="${canonical}"`), `${documentPath} has the wrong canonical URL`);
    assert.ok(html.includes(`property="og:url" content="${canonical}"`), `${documentPath} has the wrong Open Graph URL`);
  } else {
    // No public origin yet: no document may claim a canonical or og:url.
    assert.ok(!html.includes('rel="canonical"'), `${documentPath} names a canonical URL without a public origin`);
    assert.ok(!html.includes('property="og:url"'), `${documentPath} names an Open Graph URL without a public origin`);
  }
  assert.ok(html.includes(`name="robots" content="${robotsForPath(route)}"`), `${documentPath} has the wrong robots policy`);
  assert.equal(spaRoutes.has(route), false, `${route} is swallowed by the Vercel SPA route allowlist`);
  assert.equal(spaRoutes.has(`${route}/`), false, `${route}/ is swallowed by the Vercel SPA route allowlist`);
}

if (PUBLIC_ORIGIN) {
  for (const route of ["/ai-disclosure", "/retention"]) {
    assert.ok(sitemap.includes(`${PUBLIC_ORIGIN}${route}`), `${route} is missing from dist/sitemap.xml`);
  }
  assert.ok(!sitemap.includes(`${PUBLIC_ORIGIN}/verify`), "/verify must remain outside dist/sitemap.xml");
} else {
  // A sitemap URL must be absolute; with no public origin it lists nothing.
  assert.ok(!sitemap.includes("<loc>"), "dist/sitemap.xml lists URLs although Union Ground has no public origin");
}
assert.ok(read("dist/verify/index.html").includes('name="robots" content="noindex, nofollow, noarchive, noai, noimageai"'), "/verify must remain noindex");
verifyMobileAppLinkArtifacts({ root: "dist" });

// The standalone pages' document drops only the member
// shell's preload, and exactly the standalone routes are served it.
assert.deepEqual(standaloneDocumentProblems(read("dist/index.html"), read(`dist/${STANDALONE_DOCUMENT}`)), []);
assert.deepEqual(
  vercel.rewrites.filter((entry) => entry.destination === `/${STANDALONE_DOCUMENT}`).map((entry) => entry.source),
  [...STANDALONE_DOCUMENT_ROUTES],
  `only the standalone routes may be served /${STANDALONE_DOCUMENT}`,
);

console.log(`Verified ${PUBLIC_STATIC_ROUTES.length} physical public route documents and Vercel exclusions.`);
