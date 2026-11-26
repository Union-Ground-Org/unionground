// Union Ground has no membership card and no public card verifier (owner
// decision D5, 2026-10-15). Before recognition there is no membership to
// verify, and a public verify page would let anyone, an employer included,
// confirm that a person is part of the campaign. Union Ground's card screen,
// its /verify-card page, both API routes, the signed-token helper, the saved
// card cache, the Google Wallet pass and every entry point to them are gone.
// The database objects the card used stay in place and inert. These checks
// keep every piece from coming back unreviewed.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/AppRouter.jsx";
import { appViewForPath, MEMBER_PATH_VIEWS, SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import { FEATURE_GROUPS } from "../src/lib/mobileNav.js";
import { metadataForPath } from "../src/lib/publicPageMetadata.js";
import { catalogue } from "../src/lib/i18n.js";
import { COMPASS_PAGE_KEYS } from "../src/features/compass/pageHelp.js";
import { COMPASS_PAGE_LABELS } from "../api/_lib/compassPrompts.js";
import { isLeftOutSetting } from "../src/lib/organizationSettingsAdmin.js";
import { telemetry } from "../src/lib/telemetryDisclosure.js";

const CARD_PATHS = ["/m/card", "/verify-card"];

describe("membership card removal", () => {
  it("ships no card API route, token helper, wallet signer, view or cache", () => {
    for (const path of [
      "api/membership-card.js",
      "api/membership-card-verify.js",
      "api/_lib/membershipCardToken.js",
      "api/_lib/googleWallet.js",
      "src/views/MembershipCardView.jsx",
      "src/views/VerifyMembershipCardView.jsx",
      "src/lib/membershipCard.js",
      "src/lib/membershipCardCache.js",
      "src/features/membershipCard",
    ]) expect(existsSync(path), path).toBe(false);
    // No other API route or library issues, verifies or caches a card.
    const apiSources = readdirSync("api", { recursive: true })
      .filter((name) => /\.js$/.test(name))
      .map((name) => [name, readFileSync(`api/${name}`, "utf8")]);
    for (const [name, source] of apiSources) {
      expect(source, name).not.toMatch(/MEMBERSHIP_CARD_SIGNING_SECRET|consume_membership_card_verification_nonce|get_my_membership_wallet_pass|savetowallet/);
    }
    expect(readFileSync(".env.example", "utf8")).not.toMatch(/MEMBERSHIP_CARD|GOOGLE_WALLET/);
  });

  it("registers neither card address as an app route, rewrite or header rule", () => {
    for (const path of CARD_PATHS) {
      expect(appViewForPath(path), path).toBeNull();
      expect(MEMBER_PATH_VIEWS[path], path).toBeUndefined();
      expect(SPA_ROUTE_PATHS, path).not.toContain(path);
    }
    expect(Object.values(MEMBER_PATH_VIEWS)).not.toContain("card");
    // vercel.json has no catch-all rewrite, so an address without a rewrite is
    // answered by the edge 404 before any app code runs.
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(vercel.rewrites.some((rule) => /^\/\(\.\*\)$|^\/:path\*$/.test(rule.source))).toBe(false);
    const sources = [...vercel.rewrites, ...(vercel.redirects ?? []), ...vercel.headers].map((rule) => rule.source);
    for (const path of CARD_PATHS) expect(sources, path).not.toContain(path);
    expect(JSON.stringify(vercel)).not.toMatch(/membership-card|verify-card/);
  });

  it("gives the verifier no public page metadata", () => {
    expect(metadataForPath("/verify-card").path).not.toBe("/verify-card");
    expect(readFileSync("src/lib/publicPageMetadata.js", "utf8")).not.toContain("/verify-card");
  });

  it("offers no navigation, palette, shortcut or Guide page entry for a card", () => {
    const items = FEATURE_GROUPS.flatMap((group) => group.items);
    expect(items.filter((item) => item.key === "card" || item.path === "/m/card")).toEqual([]);
    for (const path of ["src/components/DesktopRail.jsx", "src/lib/mobileNav.js", "src/App.jsx", "src/lib/appRoutes.js"]) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/\/m\/card|nav\.card|MembershipCard(View)?\b|membershipCardCache|verify-card/);
    }
    expect(COMPASS_PAGE_KEYS).not.toContain("card");
    expect(Object.keys(COMPASS_PAGE_LABELS)).not.toContain("card");
  });

  it("keeps no card or wallet copy in either language", () => {
    for (const lang of ["en", "es"]) {
      const keys = Object.keys(catalogue[lang]);
      expect(keys.filter((key) => /^card\.|^nav\.card$|^compass\.page\.card$|^googleActivations\.wallet|google_wallet_pass|^telemetry\.storage\.card\./.test(key)), lang).toEqual([]);
      const values = Object.values(catalogue[lang]).filter((value) => typeof value === "string");
      expect(values.filter((value) => /membership card|tarjeta de membres[ií]a|credencial de miembro|Google Wallet/i.test(value)), lang).toEqual([]);
    }
  });

  it("discloses no card storage and hides the inert wallet switch", () => {
    expect(telemetry.storage.map((row) => row.id)).not.toContain("card");
    expect(JSON.stringify(telemetry.storage)).not.toContain("membership-card");
    expect(isLeftOutSetting({ key: "features.integrations.google_wallet_pass" })).toBe(true);
  });
});

describe("membership card addresses in App", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  });
  afterEach(() => {
    window.history.replaceState({}, "", "/m");
  });

  it.each([
    "/verify-card",
    "/verify-card/",
    "/verify-card?token=abc.def",
    "/m/card",
    "/m/card/",
  ])("renders the not-found page for %s and asks no server", async (path) => {
    window.history.replaceState({}, "", path);
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /membership card|verify a card/i })).toBeNull();
    expect(screen.queryByLabelText(/verification code/i)).toBeNull();
    expect(document.querySelector(".card-nav")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
