import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalUrlForPath, metadataForPath, robotsForPath, SOCIAL_IMAGE_URL } from "../src/lib/publicPageMetadata.js";
import { LEGAL_CHANGELOG_PATH, LEGAL_INSTRUMENT_PATHS } from "../src/lib/legalInstruments.js";

export const PUBLIC_STATIC_ROUTES = [
  "/about",
  "/contact",
  "/operator",
  "/privacy",
  "/subprocessors",
  "/telemetry",
  "/privacy/deletion-request",
  "/terms",
  "/accessibility",
  "/accessibility/statement",
  "/ai-disclosure",
  "/retention",
  "/verify",
  // The instrument route behind each summary and the public version history
  //: crawler-visible documents like every
  // other public legal route, registered from the one instrument source.
  ...LEGAL_INSTRUMENT_PATHS,
  LEGAL_CHANGELOG_PATH,
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function replaceMeta(html, attribute, key, content) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta\\s+[^>]*${attribute}=["']${escapedKey}["'][^>]*>`, "i");
  return html.replace(pattern, (tag) => tag.replace(/content=["'][^"']*["']/i, `content="${escapeHtml(content)}"`));
}

export function renderPublicRouteHtml(shell, route) {
  const metadata = metadataForPath(route);
  if (metadata.path !== route) throw new Error(`No public metadata registered for ${route}`);
  // No canonical URL, og:url or social image while Union Ground has no
  // public origin (src/lib/publicPageMetadata.js); a canonical link already in
  // the shell is dropped rather than left pointing elsewhere.
  const canonical = canonicalUrlForPath(metadata.path);
  const robots = robotsForPath(route);
  let html = shell.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(metadata.title)}</title>`);
  html = canonical
    ? html.replace(/<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${escapeHtml(canonical)}" />`)
    : html.replace(/\s*<link\s+rel=["']canonical["'][^>]*>/i, "");
  html = replaceMeta(html, "name", "description", metadata.description);
  html = replaceMeta(html, "name", "robots", robots);
  html = replaceMeta(html, "property", "og:title", metadata.title);
  html = replaceMeta(html, "property", "og:description", metadata.description);
  if (canonical) html = replaceMeta(html, "property", "og:url", canonical);
  if (SOCIAL_IMAGE_URL) html = replaceMeta(html, "property", "og:image", SOCIAL_IMAGE_URL);
  html = replaceMeta(html, "name", "twitter:title", metadata.title);
  html = replaceMeta(html, "name", "twitter:description", metadata.description);
  if (SOCIAL_IMAGE_URL) html = replaceMeta(html, "name", "twitter:image", SOCIAL_IMAGE_URL);
  return html;
}

export function publicRouteMetadataPlugin() {
  const installDevRouteDocuments = (server) => {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url || "/", "http://localhost");
      const route = url.pathname.replace(/\/+$/, "") || "/";
      if (!PUBLIC_STATIC_ROUTES.includes(route) || !["GET", "HEAD"].includes(request.method || "GET")) {
        next();
        return;
      }
      try {
        const shell = await readFile(resolve(server.config.root, "index.html"), "utf8");
        const html = await server.transformIndexHtml(route, renderPublicRouteHtml(shell, route));
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Content-Length", Buffer.byteLength(html));
        response.end(request.method === "HEAD" ? undefined : html);
      } catch (error) {
        next(error);
      }
    });
  };
  const installPreviewRouteDocuments = (server) => {
    server.middlewares.use((request, _response, next) => {
      const url = new URL(request.url || "/", "http://localhost");
      const route = url.pathname.replace(/\/+$/, "") || "/";
      if (PUBLIC_STATIC_ROUTES.includes(route)) {
        request.url = `${route}/index.html${url.search}`;
      }
      next();
    });
  };
  return {
    name: "public-route-metadata",
    enforce: "post",
    configureServer: installDevRouteDocuments,
    configurePreviewServer: installPreviewRouteDocuments,
    generateBundle(_options, bundle) {
      const shellAsset = bundle["index.html"];
      if (!shellAsset || shellAsset.type !== "asset") throw new Error("Vite did not emit index.html");
      const shell = String(shellAsset.source);
      for (const route of PUBLIC_STATIC_ROUTES) {
        this.emitFile({
          type: "asset",
          fileName: `${route.slice(1)}/index.html`,
          source: renderPublicRouteHtml(shell, route),
        });
      }
    },
  };
}
