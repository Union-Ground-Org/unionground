// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { brandText, serverBrand, serverBrandName } from "../api/_lib/brand.js";
import { invitationEmail, signInPasswordEmail } from "../api/_lib/memberInvitations.js";
import { pushTemplateFor, templateFor } from "../api/notifications-dispatch.js";
import { renderEmail, renderText } from "../api/_lib/emailTemplate.js";
import { passwordResetEmail } from "../api/_lib/passwordReset.js";
import { confirmationEmail } from "../api/_lib/openSignup.js";
import { stopConfirmationEmail } from "../api/_lib/publicInterestStopConfirmation.js";
import { inviteRequestEmail } from "../api/_lib/inviteRequest.js";
import { buildGuideMessages } from "../api/_lib/compassPrompts.js";
import { DEVELOPMENT_BRAND_NAME } from "../src/lib/shared-core/brand.js";

afterEach(() => vi.unstubAllEnvs());

function asUnbranded(name = "Harbor Workspace") {
  vi.stubEnv("VITE_OFFICIAL_BRANDING", "");
  vi.stubEnv("VITE_BRAND_NAME", name);
}

const leftover = (value) => JSON.stringify(value).replaceAll("Based on Union Ground", "").match(/Union Ground|UNION GROUND|UNION&nbsp;GROUND/g);

describe("server brand (api/_lib/brand.js)", () => {
  it("follows the deployment's build settings", () => {
    expect(serverBrand({ VITE_OFFICIAL_BRANDING: "1" })).toMatchObject({ name: "Union Ground", official: true });
    expect(serverBrandName({ VITE_BRAND_NAME: "Harbor Workspace" })).toBe("Harbor Workspace");
    expect(serverBrandName({})).toBe(DEVELOPMENT_BRAND_NAME);
    expect(serverBrandName({ VITE_BRAND_NAME: "Union Ground" })).toBe(DEVELOPMENT_BRAND_NAME);
    expect(serverBrandName({ VITE_BRAND_NAME: "<bad>" })).toBe(DEVELOPMENT_BRAND_NAME);
  });

  it("rewrites copy deeply and keeps the attribution notice", () => {
    const env = { VITE_BRAND_NAME: "Harbor" };
    expect(brandText({ a: ["Open Union Ground", { b: "UNION GROUND" }], n: 3 }, env))
      .toEqual({ a: ["Open Harbor", { b: "HARBOR" }], n: 3 });
    expect(brandText("Based on Union Ground (https://unionground.org)", env)).toBe("Based on Union Ground (https://unionground.org)");
  });

  it("keeps Union Ground in the official deployment, as this suite runs", () => {
    expect(invitationEmail("en", "https://app.example.org/i#x", null, { organization: "Tamarack" }).subject).toBe("Tamarack: your Union Ground invitation");
  });

  it("sends mail, notifications and Guide prompts in an unbranded deployment's own name", () => {
    asUnbranded();
    const messages = [
      invitationEmail("en", "https://app.example.org/i#x", "https://app.example.org", { organization: "Tamarack", inviter: "Rosa" }),
      invitationEmail("es", "https://app.example.org/i#x", "https://app.example.org", { organization: "Tamarack", inviter: "Rosa" }),
      signInPasswordEmail("en", "pw-123", "https://app.example.org", { reissuedAt: new Date("2026-11-14T15:00:00Z") }),
      passwordResetEmail("en", "https://app.example.org/reset#x", new Date("2026-11-14T15:00:00Z"), "ref"),
      confirmationEmail("es", "https://app.example.org/signup/confirm#x"),
      stopConfirmationEmail("en", "https://app.example.org/stop-updates#x"),
      inviteRequestEmail({ name: "Ana", email: "ana@example.org", organization: "Tamarack", note: "hi" }, new Date("2026-11-14T15:00:00Z")),
      templateFor("deadlines", "en"),
      templateFor("workload", "es", { event: "reminder" }),
      pushTemplateFor("cases", "en"),
      renderEmail({ kind: "deadlines", lang: "en", subject: "S", body: "B", appUrl: "https://app.example.org/m", logoUrl: "https://app.example.org/icon-192.png" }),
      renderText({ body: "B", appUrl: "https://app.example.org/m", lang: "es" }),
      buildGuideMessages("How do we start?", {}, [], []),
    ];
    for (const message of messages) expect(leftover(message), JSON.stringify(message).slice(0, 120)).toBeNull();
    expect(JSON.stringify(messages)).toContain("Harbor Workspace");
    expect(messages[0].html).toContain("HARBOR WORKSPACE");
    expect(messages[10]).toContain("HARBOR&nbsp;WORKSPACE");
  });
});

describe("server error messages", () => {
  it("names the deployment's product in the server's own error string only", async () => {
    asUnbranded();
    const { json } = await import("../api/_lib/http.js");
    const sent = {};
    const response = {
      status(code) { sent.status = code; return this; },
      setHeader() { return this; },
      end(body) { sent.body = JSON.parse(body); },
    };
    json(response, 503, { code: "compass_paused", error: "Union Ground Guide is paused by an administrator.", answer: "Union Ground data" });
    expect(sent).toEqual({ status: 503, body: { code: "compass_paused", error: "Harbor Workspace Guide is paused by an administrator.", answer: "Union Ground data" } });
  });
});
