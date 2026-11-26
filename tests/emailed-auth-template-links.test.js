import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  invitationUrl, sendInvitationEmail, signInPasswordEmail,
} from "../api/_lib/memberInvitations.js";
import {
  resetLink, resetTicketKey, sealResetTicket, sendPasswordResetEmail,
} from "../api/_lib/passwordReset.js";
import { parseEmailedAuthLink } from "../src/lib/emailedAuthLink.js";
import { redirectSystemPath } from "../apps/mobile/app/+native-intent.tsx";
import {
  readLifecycleDiagnostics, resetLifecycleDiagnostics, setLifecycleDiagnosticsSink,
} from "../apps/mobile/src/services/lifecycleDiagnostics.ts";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

// Exercise what the mail transport receives, not just a proposed URL.
// The /m generator cited in the device note is not a production mail sender.
vi.mock("../src/lib/emailLinkHosts.js", async () => (await import("./helpers/fictional-provider.js")).emailLinkHostsModule());
vi.mock("../apps/mobile/src/lib/appLinkHosts", async () => ({
  APP_LINK_HOSTS: [(await import("./helpers/fictional-provider.js")).PORTAL_HOST],
}));

const origin = PORTAL_ORIGIN;
const invite = "A".repeat(43);
const recoveryToken = "a1".repeat(28);
const ticket = sealResetTicket(resetTicketKey("test-only-service-key-long-enough"), recoveryToken);
const policy = JSON.parse(readFileSync("config/mobile-app-links.json", "utf8"));
const appleDocument = JSON.parse(readFileSync("public/native-links/apple-app-site-association.json", "utf8"));
const androidDocument = JSON.parse(readFileSync("public/native-links/assetlinks.json", "utf8"));

beforeAll(() => setLifecycleDiagnosticsSink(() => {}));
afterEach(() => { vi.unstubAllGlobals(); resetLifecycleDiagnostics(); });
afterAll(() => setLifecycleDiagnosticsSink(null));

function htmlLinks(html) {
  const document = new DOMParser().parseFromString(html, "text/html");
  return [...document.querySelectorAll("a[href]")].map((node) => node.getAttribute("href"));
}

function assertClaimedEmail(message, { path, kind, token, callback }) {
  const url = new URL(htmlLinks(message.html)[0]);
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe(path);
  expect(url.search).toBe("");
  expect(url.pathname).not.toContain(token);
  expect(message.text).toContain(url.href);
  expect(message.subject).not.toContain(token);
  expect(parseEmailedAuthLink(url.href)).toEqual({ kind, token });

  expect(url.hostname).toBe(PORTAL_HOST);
  expect(url.hash).toContain(token);
  expect(parseEmailedAuthLink(new URL(url.pathname + url.hash, "https://untrusted.example").href)).toBeNull();

  for (const initial of [true, false]) {
    expect(redirectSystemPath({ path: url.href, initial })).toBe(callback);
  }
  const diagnostics = JSON.stringify(readLifecycleDiagnostics());
  expect(diagnostics).not.toContain(token);
  expect(diagnostics).not.toContain(url.href);
}

describe("delivered account-access email links", () => {
  it("ships no association for a provider until an operator provisions one", async () => {
    const { APP_LINK_HOSTS } = await vi.importActual("../apps/mobile/src/lib/appLinkHosts");
    const { EMAIL_LINK_HOSTS } = await vi.importActual("../src/lib/emailLinkHosts.js");
    expect(policy).toMatchObject({ enabled: false, domains: [], appleAppIDs: [], androidCertFingerprints: [] });
    expect(APP_LINK_HOSTS).toEqual([]);
    expect(EMAIL_LINK_HOSTS).toEqual([]);
    expect(appleDocument.applinks.details).toEqual([]);
    expect(androidDocument).toEqual([]);
  });

  const sources = [
    ["administrator", { source: "administrator" }],
    ["roster", { source: "administrator", rosterLink: true }],
    ["SCIM", { source: "scim" }],
    ["founder", { source: "founder" }],
  ];
  for (const locale of ["en", "es"]) {
    it.each(sources)(`${locale} %s invitation mail opens the existing native acceptance screen`, async (_source, names) => {
      const transport = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", transport);
      await expect(sendInvitationEmail({
        resendKey: "test-only-mail-key", from: "test@example.invalid", to: "member@example.invalid",
        locale, appOrigin: origin, link: invitationUrl(origin, invite), invitationId: "test-invitation",
        deliveryVersion: 1, names: { organization: "Example Workers", inviter: "Alex Example", ...names },
      })).resolves.toBe(true);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0][0]).toBe("https://api.resend.com/emails");
      assertClaimedEmail(JSON.parse(transport.mock.calls[0][1].body), {
        path: "/app/invite", kind: "invitation", token: invite, callback: `/auth/callback?invite=${invite}`,
      });
    });

    it(`${locale} recovery mail opens the existing two-step password reset screen`, async () => {
      const transport = vi.fn().mockResolvedValue({ ok: true });
      await expect(sendPasswordResetEmail({
        resendKey: "test-only-mail-key", from: "test@example.invalid", to: "member@example.invalid",
        locale, link: resetLink(origin, ticket), token: recoveryToken,
      }, transport)).resolves.toBe(true);
      expect(transport).toHaveBeenCalledTimes(1);
      const message = JSON.parse(transport.mock.calls[0][1].body);
      assertClaimedEmail(message, {
        path: "/app/reset-password", kind: "passwordReset", token: ticket,
        callback: `/auth/callback?resetTicket=${ticket}`,
      });
      expect(JSON.stringify(message)).not.toContain(recoveryToken);
    });

    it(`${locale} first-password and reissued-password emails carry only public navigation links`, () => {
      for (const reissuedAt of [null, new Date("2026-10-31T13:00:00-04:00")]) {
        const message = signInPasswordEmail(locale, "test-only-temporary-password", origin, { reissuedAt });
        expect(htmlLinks(message.html)).toEqual([
          `${origin}/`,
          `${origin}/get-app`,
        ]);
        for (const href of htmlLinks(message.html)) {
          expect(parseEmailedAuthLink(href)).toBeNull();
          expect(href).not.toContain("test-only-temporary-password");
          expect(new URL(href).hash).toBe("");
          expect(new URL(href).search).toBe("");
        }
      }
    });
  }
});
