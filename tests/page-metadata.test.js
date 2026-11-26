import { readFileSync } from "node:fs";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { applyPageMetadata, canonicalUrlForPath, metadataForPath, PUBLIC_ORIGIN, SOCIAL_IMAGE_URL, usePageMetadata } from "../src/lib/pageMetadata.js";
import { PUBLIC_ROUTE_METADATA, robotsForLocation } from "../src/lib/publicPageMetadata.js";
import { useSignInPathMetadata } from "../src/lib/signInPathMetadata.js";

const content = (selector) => document.head.querySelector(selector)?.getAttribute("content");

beforeEach(() => {
  document.head.innerHTML = '<title>stale</title><link rel="canonical" href="https://example.test/stale"><meta name="description" content="stale">';
});

describe("public route metadata", () => {
  it.each([
    ["/", "Union Ground | Organizing software for workers forming a union", "index, follow, noarchive, noai, noimageai"],
    ["/about/", "About Union Ground", "index, follow, noarchive, noai, noimageai"],
    ["/contact", "Contact | Union Ground", "index, follow, noarchive, noai, noimageai"],
    ["/privacy", "Privacy | Union Ground", "index, follow, noarchive, noai, noimageai"],
    ["/terms", "Terms of use | Union Ground", "index, follow, noarchive, noai, noimageai"],
    ["/accessibility", "Accessibility | Union Ground", "index, follow, noarchive, noai, noimageai"],
    ["/ai-disclosure", "How the Guide uses AI | Union Ground", "index, follow, noarchive, noai, noimageai"],
    ["/retention", "Data retention schedule | Union Ground", "index, follow, noarchive, noai, noimageai"],
    // Union Ground has no membership card and no public card verifier, so
    // the old verifier address is a private page like any unknown path.
    ["/verify-card", "Union Ground | Organizing workspace", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/m/card", "Union Ground | Organizing workspace", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/verify", "Verify a vote receipt | Union Ground", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/m/cases", "Union Ground | Organizing workspace", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/not-a-public-route", "Union Ground | Organizing workspace", "noindex, nofollow, noarchive, noai, noimageai"],
    // Union Ground has no public union catalog, organization landing page,
    // claim confirmation or chapter directory: those paths are private pages.
    ["/unions/", "Union Ground | Organizing workspace", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/orgs/example-workers-local-1", "Union Ground | Organizing workspace", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/orgs/example-workers-local-1/", "Union Ground | Organizing workspace", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/orgs/Not_A_Slug", "Union Ground | Organizing workspace", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/unions/claim/confirm", "Union Ground | Organizing workspace", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/chapters", "Union Ground | Organizing workspace", "noindex, nofollow, noarchive, noai, noimageai"],
  ])("sets complete metadata for %s", (path, title, robots) => {
    applyPageMetadata(path);
    expect(document.title).toBe(title);
    expect(content('meta[name="robots"]')).toBe(robots);
    expect(content('meta[property="og:title"]')).toBe(title);
    expect(content('meta[name="twitter:title"]')).toBe(title);
    // Union Ground has no public origin, so there is no social image to name.
    expect(SOCIAL_IMAGE_URL).toBe("");
    expect(content('meta[property="og:image"]')).toBeUndefined();
    expect(content('meta[name="twitter:card"]')).toBe("summary");
    expect(content('meta[property="og:site_name"]')).toBe("Union Ground");
    expect(document.head.innerHTML).not.toMatch(/Union Base|Compass/);
  });

  it("replaces every stale value across SPA transitions", () => {
    applyPageMetadata("/verify");
    applyPageMetadata("/privacy");
    expect(document.title).toBe("Privacy | Union Ground");
    expect(content('meta[name="robots"]')).toBe("index, follow, noarchive, noai, noimageai");
    // No public origin: the stale canonical and og:url are removed and none is written.
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(content('meta[property="og:url"]')).toBeUndefined();
  });

  it("normalizes paths without accepting query strings or receipt data", () => {
    const receipt = "SG-SECRET-RECEIPT";
    applyPageMetadata("/verify");
    expect(document.head.innerHTML).not.toContain(receipt);
    expect(metadataForPath("/verify/").path).toBe("/verify");
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(canonicalUrlForPath("/verify")).toBe("");
  });

  it("publishes no public union catalog, organization or chapter directory metadata", () => {
    for (const path of ["/unions", "/unions/claim/confirm", "/chapters", "/orgs/example-workers-local-1"]) {
      expect(metadataForPath(path).path).toBe("/m");
    }
    expect(Object.keys(PUBLIC_ROUTE_METADATA).filter((path) => /^\/(unions|orgs|chapters)(\/|$)/.test(path))).toEqual([]);
  });

  it("keeps a query key out of the head on a former catalog path", () => {
    const key = "olms-900000001";
    applyPageMetadata("/unions", `?org=${key}`);
    expect(content('meta[name="robots"]')).toBe("noindex, nofollow, noarchive, noai, noimageai");
    // No public origin: a former catalog path resolves to the private
    // workspace and publishes no canonical link at all.
    expect(PUBLIC_ORIGIN).toBe("");
    expect(metadataForPath("/unions").path).toBe("/m");
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(content('meta[property="og:url"]')).toBeUndefined();
    expect(document.head.innerHTML).not.toContain(key);
  });

  it("reads the window location by default and lets no query string change the policy", () => {
    window.history.replaceState({}, "", "/about?org=olms-900000001");
    applyPageMetadata("/about");
    expect(content('meta[name="robots"]')).toBe("index, follow, noarchive, noai, noimageai");
    expect(document.head.innerHTML).not.toContain("olms-900000001");
    window.history.replaceState({}, "", "/verify?org=olms-900000001");
    applyPageMetadata("/verify");
    expect(content('meta[name="robots"]')).toBe("noindex, nofollow, noarchive, noai, noimageai");
    window.history.replaceState({}, "", "/");
  });

  it.each([
    ["/unions", "?org=olms-900000001", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/unions/", "?org=", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/unions", "?q=steel", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/unions", "", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/unions", undefined, "noindex, nofollow, noarchive, noai, noimageai"],
    ["/about", "", "index, follow, noarchive, noai, noimageai"],
    ["/about", "?org=olms-900000001", "index, follow, noarchive, noai, noimageai"],
    ["/verify", "?org=olms-900000001", "noindex, nofollow, noarchive, noai, noimageai"],
    ["/m/cases", "", "noindex, nofollow, noarchive, noai, noimageai"],
  ])("robotsForLocation(%s, %s) is %s", (path, search, robots) => {
    expect(robotsForLocation(path, search)).toBe(robots);
  });
});

// BUG-UG-PUBLIC-PAGE-TITLE-MEMBER-WORKSPACE-20261003
describe("public sign-in, invitation and app pages", () => {
  it.each([
    ["/auth", "Sign in | Union Ground", "/auth"],
    ["/signin", "Sign in | Union Ground", "/auth"],
    ["/login/", "Sign in | Union Ground", "/auth"],
    ["/invite", "Accept your invitation | Union Ground", "/invite"],
    ["/get-app", "Get Union Ground | Union Ground", "/get-app"],
    ["/request-invite", "Request an invitation | Union Ground", "/request-invite"],
    ["/stop-updates", "Stop updates | Union Ground", "/stop-updates"],
  ])("titles %s as a public page and keeps it out of the index", (path, title, canonical) => {
    const metadata = metadataForPath(path);
    expect(metadata.title).toBe(title);
    expect(metadata.title).not.toContain("Organizing workspace");
    expect(metadata.path).toBe(canonical);
    expect(metadata.robots).toBe("noindex, nofollow, noarchive");
  });

  it("still titles the signed-in workspace as the organizing workspace", () => {
    expect(metadataForPath("/m/settings").title).toBe("Union Ground | Organizing workspace");
  });

  it("follows the session on a sign-in path: workspace after sign-in, sign-in again after sign-out", () => {
    // MemberApp keeps the /auth address across both transitions, and the
    // route-level hook only reruns on a new pathname.
    window.history.replaceState(null, "", "/login/");
    // The hook takes the screen MemberApp shows ("sign-in", "landing",
    // "workspace", or null while the session settles), not a signed-in flag.
    const { rerender, unmount } = renderHook(({ screen }) => useSignInPathMetadata(screen), { initialProps: { screen: "sign-in" } });
    expect(document.title).toBe("Sign in | Union Ground");
    rerender({ screen: "workspace" });
    expect(document.title).toBe("Union Ground | Organizing workspace");
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    rerender({ screen: "sign-in" });
    expect(document.title).toBe("Sign in | Union Ground");
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(metadataForPath("/login/").path).toBe("/auth");
    unmount();
  });

  it("leaves the head alone while the session settles", () => {
    window.history.replaceState(null, "", "/m/settings");
    const { rerender, unmount } = renderHook(({ screen }) => useSignInPathMetadata(screen), { initialProps: { screen: null } });
    rerender({ screen: null });
    expect(document.title).toBe("stale");
    unmount();
  });

  // With no public origin there is no canonical link, so a language switch
  // re-applies the head from its route instead of throwing.
  it("re-applies the head on a language switch when no canonical link is published", async () => {
    window.history.replaceState(null, "", "/reset-password");
    document.documentElement.lang = "en";
    const { unmount } = renderHook(() => usePageMetadata("/reset-password"));
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    act(() => { document.documentElement.lang = "es"; });
    await waitFor(() => expect(document.title).toBe(metadataForPath("/reset-password", "es").title));
    unmount();
    document.documentElement.lang = "en";
  });

  it("is what MemberApp uses for the screen it shows", () => {
    const source = readFileSync(`${process.cwd()}/src/App.jsx`, "utf8");
    expect(source).toContain("useSignInPathMetadata(headScreen);");
    expect(source).toContain(': session ? "workspace" : showSignIn || demo ? "sign-in" : "landing";');
  });
});

