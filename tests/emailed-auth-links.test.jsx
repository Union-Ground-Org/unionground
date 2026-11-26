import { existsSync, readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invitationUrl } from "../api/_lib/memberInvitations.js";
import { resetLink } from "../api/_lib/passwordReset.js";
import { expectedAssociationDocuments, mobileApplicationId } from "../scripts/lib/mobile-app-link-policy.mjs";
import { EMAIL_AUTH_PATHS, parseEmailedAuthLink } from "../src/lib/emailedAuthLink.js";
import { SPA_ROUTE_PATHS, appViewForPath } from "../src/lib/appRoutes.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";
import { InvitationAcceptView } from "../src/views/InvitationAcceptView.jsx";
import { PasswordResetView } from "../src/views/PasswordResetView.jsx";
import * as legalReleaseBundle from "../src/lib/legalReleaseBundle.js";
import { publishedVersionsWithProof } from "./helpers/legal-publication.js";

// The bundled legal release is published only with the deployment's proof
// (tests/helpers/legal-publication.js); this file renders acceptance against it.
let legalProofSpy;
beforeEach(() => {
  legalProofSpy = vi.spyOn(legalReleaseBundle, "loadPublishedWebVersions").mockImplementation(publishedVersionsWithProof);
});
afterEach(() => legalProofSpy?.mockRestore());


// Union Ground has no verified domain, so the real host list is empty and
// refuses every emailed link (asserted below). The suite substitutes one
// fictional, non-resolvable host to exercise the parser.
const FIXTURE_HOST = "unionground.invalid";
const FIXTURE_ORIGIN = `https://${FIXTURE_HOST}`;
vi.mock("../src/lib/emailLinkHosts.js", () => ({ EMAIL_LINK_HOSTS: Object.freeze(["unionground.invalid"]) }));

const invite = "A".repeat(43);
const ticket = `t1.${"A".repeat(16)}.${"B".repeat(64)}`;
afterEach(() => { cleanup(); window.sessionStorage.clear(); window.history.replaceState(null, "", "/"); });

describe("associated email links", () => {
  it("names no email-link host until a Union Ground domain is approved", async () => {
    const { EMAIL_LINK_HOSTS } = await vi.importActual("../src/lib/emailLinkHosts.js");
    expect(EMAIL_LINK_HOSTS).toEqual([]);
  });

  it.each([FIXTURE_ORIGIN])("keeps both email credentials under the associated paths at %s", (origin) => {
    // Union Ground's committed association is fail closed (no approved
    // domain or signing identity), and it publishes no credential association.
    // The emailed paths must still sit under the one component an approved
    // policy would associate, so a later activation needs no path change.
    const apple = JSON.parse(readFileSync("public/native-links/apple-app-site-association.json", "utf8"));
    expect(apple).toEqual({ applinks: { details: [] } });
    expect(existsSync("public/native-credentials")).toBe(false);
    const activated = expectedAssociationDocuments({
      enabled: true,
      applicationId: mobileApplicationId(),
      domains: [],
      appleAppIDs: [`ABCDE12345.${mobileApplicationId()}`],
      androidCertFingerprints: ["AA:".repeat(31) + "AA"],
    }).apple;
    for (const [url, kind, token] of [
      [invitationUrl(origin, invite), "invitation", invite],
      [resetLink(origin, ticket), "passwordReset", ticket],
    ]) {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe(EMAIL_AUTH_PATHS[kind]);
      expect(parsed.search).toBe("");
      expect(parseEmailedAuthLink(url)).toEqual({ kind, token });
      expect(activated.applinks.details[0].components.some((entry) => {
        const pattern = entry["/"];
        return pattern.endsWith("*") && parsed.pathname.startsWith(pattern.slice(0, -1));
      })).toBe(true);
    }
    const appConfig = readFileSync("apps/mobile/app.config.ts", "utf8");
    expect(appConfig).toContain("pathPrefix: '/app'");
  });

  it("binds the web fallback routes to the same paths used by the email generators", () => {
    const app = readFileSync("src/AppRouter.jsx", "utf8");
    expect(app).toContain("[EMAIL_AUTH_PATHS.invitation]: InvitationAcceptView");
    expect(app).toContain("[EMAIL_AUTH_PATHS.passwordReset]: PasswordResetView");
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    for (const source of Object.values(EMAIL_AUTH_PATHS)) {
      expect(SPA_ROUTE_PATHS).toContain(source);
      expect(appViewForPath(source)).toBeNull();
      expect(vercel.rewrites.find((rule) => rule.source === source)).toEqual({ source, destination: "/index.html" });
      const headers = Object.fromEntries(vercel.headers.find((rule) => rule.source === source).headers.map(({ key, value }) => [key, value]));
      expect(headers["Referrer-Policy"]).toBe("no-referrer");
      expect(headers["Cache-Control"]).toBe("no-store");
      expect(headers["X-Robots-Tag"]).toContain("noindex");
      expect(vercel.redirects.some((rule) => rule.source === source)).toBe(false);
    }
  });

  it.each([
    `https://evil.example/app/invite#invite=${invite}`,
    `https://unionground.invalid:444/app/invite#invite=${invite}`,
    `https://someone@unionground.invalid/app/invite#invite=${invite}`,
    `http://unionground.invalid/app/invite#invite=${invite}`,
    `unionground://app/invite#invite=${invite}`,
    `https://unionground.invalid/app/invite?invite=${invite}`,
    `https://unionground.invalid/app/invite?next=https://evil.example#invite=${invite}`,
    `https://unionground.invalid/app/invite#invite=${invite}&invite=${invite}`,
    `https://unionground.invalid/app/invite#invite=${invite}&token=${ticket}`,
    `https://unionground.invalid/app/invite/extra#invite=${invite}`,
    "https://unionground.invalid/app/reset-password#token=raw-gotrue-token",
  ])("refuses unsupported or ambiguous payloads", (url) => {
    expect(parseEmailedAuthLink(url)).toBeNull();
  });

  it("immediately scrubs the browser fallback credential and accepts only after versioned consent", async () => {
    window.history.replaceState(null, "", `/app/invite#invite=${invite}`);
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ accepted: true }) });
    render(<LanguageProvider><InvitationAcceptView fetcher={fetcher} /></LanguageProvider>);
    // REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010, acceptance 1:
    // show the current terms and require explicit consent before exchange.
    const consent = await screen.findByRole("checkbox", { name: /I have read the terms of use/i });
    expect(consent).not.toBeChecked();
    expect(fetcher).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/invite");
    fireEvent.click(consent);
    expect(fetcher).not.toHaveBeenCalled();
    // A state, then the age attestation it selects.
    fireEvent.change(screen.getByRole("combobox", { name: "State where you live" }), { target: { value: "PR" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "I'm 13 or older, and if I'm under 18, my organization authorized this account." }));
    fireEvent.click(screen.getByRole("button", { name: /agree and accept the invitation/i }));
    await screen.findByRole("link", { name: /sign in/i });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      token: invite,
      acceptedVersions: currentLegalVersions(),
      residenceState: "PR",
      ageAttested: true,
    });
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/invite");
  });

  it("uses the same two-step reset flow in the browser fallback and scrubs the ticket", async () => {
    window.history.replaceState(null, "", `/app/reset-password#token=${ticket}`);
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ mode: "challenge", state: "sealed-state" }) });
    render(<LanguageProvider><PasswordResetView fetcher={fetcher} /></LanguageProvider>);
    await screen.findByLabelText(/code from your app/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: "begin", token: ticket });
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/reset-password");
  });
});
