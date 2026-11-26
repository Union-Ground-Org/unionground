// @vitest-environment node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Explicit delivery inventory: removing a guard must fail at the actual handler,
// independently of the static scanner's interpretation of the source.
const endpoints = ["account-lifecycle", "admin-invitations", "admin-mfa-reset", "admin-password-reissue", "admin-signin-recovery", "calendar-oauth", "calendar-sync", "constant-contact-oauth", "constant-contact-sync", "engagement-delivery", "engagement-email-bridge", "google-drive", "guide", "integration-webhooks", "integration-webhooks-dispatch", "knowledge-ingest", "mfa-recovery", "notifications-dispatch", "task-files-reconcile", "twilio-send"];

// Union Ground left out dues, the member PIN, passkey/SSO sign-in and the
// membership card with its public verifier, so their mutation routes must not
// come back without a reviewed Origin guard.
const removedEndpoints = ["membership-card", "membership-card-verify", "dues-checkout", "dues-stripe-connect", "dues-stripe-webhook", "dues-stripe-reconcile", "dues-reminders-dispatch", "auth-pin-signin", "auth-passkey-signin", "auth-signin-options", "sso-admin", "sso-signin", "civic-draft", "civic-resolve-now", "civic-track-bill", "organization-claim", "organization-claim-confirm", "organization-claim-review", "public-page", "public/event-rsvp"];

// Union Ground has no product host yet; loopback outside production is the
// only trusted Origin (api/_lib/http.js trustedOriginForRequest).
const host = "localhost:5173";

afterEach(() => vi.unstubAllGlobals());

describe("mutation Origin rejection before handler work", () => {
  it.each(endpoints)("%s rejects hostile and missing browser Origin before any body or provider access", async (endpoint) => {
    const { default: handler } = await import(`../api/${endpoint}.js`);
    const fetcher = vi.fn(() => { throw new Error("Unexpected provider call"); });
    vi.stubGlobal("fetch", fetcher);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const origin of [undefined, "https://attacker.example"]) {
        const request = {
          method,
          headers: {
            host,
            authorization: "Bearer user-token",
            cookie: "session=browser",
            ...(origin ? { origin } : {}),
          },
          get body() { throw new Error("Body accessed before Origin rejection"); },
        };
        const response = {
          statusCode: 0,
          body: "",
          status(code) { this.statusCode = code; return this; },
          setHeader() { return this; },
          end(body) { this.body = body; return this; },
        };
        await handler(request, response);
        expect(response.statusCode).toBe(403);
        expect(JSON.parse(response.body)).toEqual({ error: "untrusted-origin" });
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(removedEndpoints)("the removed %s route is absent from the API tree", (endpoint) => {
    expect(existsSync(fileURLToPath(new URL(`../api/${endpoint}.js`, import.meta.url)))).toBe(false);
  });

  it("allows the exact trusted Origin to reach authentication without reading the body", async () => {
    const { default: handler } = await import("../api/admin-invitations.js");
    const request = {
      method: "POST",
      headers: { host, origin: `http://${host}` },
      get body() { throw new Error("Body accessed before authentication"); },
    };
    const response = {
      statusCode: 0,
      body: "",
      status(code) { this.statusCode = code; return this; },
      setHeader() { return this; },
      end(body) { this.body = body; return this; },
    };

    await handler(request, response);

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "unauthenticated" });
  });
});
