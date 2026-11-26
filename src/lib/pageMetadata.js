import { useEffect } from "react";
import { canonicalUrlForPath, metadataForPath, robotsForLocation, SOCIAL_IMAGE_URL } from "./publicPageMetadata.js";
import { currentWorkspaceTitle } from "./workspaceTitle.js";

export { canonicalUrlForPath, metadataForPath, PUBLIC_ORIGIN, SOCIAL_IMAGE_URL } from "./publicPageMetadata.js";

function removeHeadElement(selector) {
  document.head.querySelector(selector)?.remove();
}

function upsertMeta(selector, attributes) {
  let element = document.head.querySelector(selector);
  if (!element) {
    element = document.createElement("meta");
    document.head.append(element);
  }
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  return element;
}

// The shell's own addresses (/, every /m page and the sign-in aliases) show
// whichever screen the session calls for, so their head names the screen on
// display, not the address: the sign-in screen at a signed-out /m link, on the
// demo host's front door or at / after signing out, and the workspace once
// signed in (BUG-UG-SIGN-IN-SCREEN-CARRIES-ANOTHER-PAGES-TAB-TITLE-20261122).
// MemberApp sets it (signInPathMetadata.js); like the workspace title, every
// later head refresh (language change, route change) reads the current value.
const SHELL_HEAD_PATHS = new Set(["/", "/m", "/auth"]);
const SCREEN_HEAD_PATHS = Object.freeze({ "sign-in": "/auth", landing: "/", workspace: "/m" });
let shellScreen = null;

// #9540 (C-8): an open union profile on /unions names the union in the browser
// tab ("General Teamsters Local Union No. 313 | Union Ground"), not the
// directory's "Find your union". The profile panel sets it while it shows a
// union and clears it when it closes; like the workspace title, every later
// head refresh of /unions (language change, back and forward) reads it. It
// writes the tab only while the address is /unions, so a profile closing as
// the visitor leaves for another page never names that page.
let unionsProfileTitle = null;

export function setUnionsProfileTitle(name) {
  const previous = unionsProfileTitle;
  const text = String(name ?? "").replace(/\s+/g, " ").trim();
  unionsProfileTitle = text ? `${text} | Union Ground` : null;
  if (metadataForPath(window.location.pathname).path !== "/unions") return;
  if (unionsProfileTitle) document.title = unionsProfileTitle;
  // On close, only a tab still showing that union goes back to the
  // directory's title.
  else if (previous && document.title === previous) document.title = metadataForPath("/unions", document.documentElement.lang).title;
}

export function setShellScreen(screen) {
  shellScreen = Object.hasOwn(SCREEN_HEAD_PATHS, screen ?? "") ? screen : null;
}

function headPath(pathname) {
  return shellScreen && SHELL_HEAD_PATHS.has(metadataForPath(pathname).path) ? SCREEN_HEAD_PATHS[shellScreen] : pathname;
}

// The path decides every head value (robots included), so the canonical never
// carries a query-string key.
export function applyPageMetadata(requestedPath, search = window.location.search) {
  const pathname = headPath(requestedPath);
  const metadata = metadataForPath(pathname, document.documentElement.lang);
  const canonicalUrl = canonicalUrlForPath(metadata.path === "/" ? "/" : metadata.path);
  // "" while Union Ground has no public origin: then no canonical link,
  // og:url or social image is published at all.
  const robots = robotsForLocation(pathname, search);

  // A signed-in page names itself and the worn role (workspaceTitle.js).
  document.title = (metadata.path === "/m" && currentWorkspaceTitle())
    || (metadata.path === "/unions" && unionsProfileTitle)
    || metadata.title;
  upsertMeta('meta[name="description"]', { name: "description", content: metadata.description });
  upsertMeta('meta[name="robots"]', { name: "robots", content: robots });
  upsertMeta('meta[property="og:type"]', { property: "og:type", content: "website" });
  upsertMeta('meta[property="og:site_name"]', { property: "og:site_name", content: "Union Ground" });
  upsertMeta('meta[property="og:title"]', { property: "og:title", content: metadata.title });
  upsertMeta('meta[property="og:description"]', { property: "og:description", content: metadata.description });
  if (SOCIAL_IMAGE_URL) {
    upsertMeta('meta[property="og:image"]', { property: "og:image", content: SOCIAL_IMAGE_URL });
    upsertMeta('meta[property="og:image:width"]', { property: "og:image:width", content: "1200" });
    upsertMeta('meta[property="og:image:height"]', { property: "og:image:height", content: "630" });
    upsertMeta('meta[property="og:image:alt"]', { property: "og:image:alt", content: "Union Ground" });
    upsertMeta('meta[name="twitter:image"]', { name: "twitter:image", content: SOCIAL_IMAGE_URL });
  } else {
    for (const selector of ['meta[property="og:image"]', 'meta[property="og:image:width"]', 'meta[property="og:image:height"]', 'meta[property="og:image:alt"]', 'meta[name="twitter:image"]']) removeHeadElement(selector);
  }
  upsertMeta('meta[name="twitter:card"]', { name: "twitter:card", content: SOCIAL_IMAGE_URL ? "summary_large_image" : "summary" });
  upsertMeta('meta[name="twitter:title"]', { name: "twitter:title", content: metadata.title });
  upsertMeta('meta[name="twitter:description"]', { name: "twitter:description", content: metadata.description });

  if (!canonicalUrl) {
    removeHeadElement('meta[property="og:url"]');
    removeHeadElement('link[rel="canonical"]');
    return;
  }
  upsertMeta('meta[property="og:url"]', { property: "og:url", content: canonicalUrl });
  let canonical = document.head.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.append(canonical);
  }
  canonical.href = canonicalUrl;
}

export function usePageMetadata(pathname) {
  useEffect(() => {
    applyPageMetadata(pathname);
    // The language provider owns html lang. Follow its settled language,
    // including standalone-page switches, without changing the session's
    // selected head (/auth becomes /m while signed in).
    const observer = new MutationObserver(() => applyPageMetadata(pathname));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, [pathname]);
}
