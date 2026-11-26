// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  constantContactAccountLabel,
  fetchConstantContactAccountLabel,
  fetchConstantContactMember,
  requestConstantContactToken,
} from "../api/_lib/constantContact.js";
import {
  CONSTANT_CONTACT_SCOPES,
  buildConstantContactAuthorizeUrl,
  constantContactEnvKeys,
  constantContactPaginationUrl,
  constantContactRedirectUri,
  parseConstantContactToken,
  resolveConstantContactActivation,
  summarizeConstantContactActivities,
} from "../src/features/integrations/constantContact.js";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

function providerResponse(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

describe("Constant Contact domain", () => {
  it("keeps production and SAMPLE activation separate and unset by default", () => {
    expect(constantContactEnvKeys("saas").clientId).toBe("CONSTANT_CONTACT_CLIENT_ID");
    expect(constantContactEnvKeys("demo").clientId).toBe("SAMPLE_CONSTANT_CONTACT_CLIENT_ID");
    expect(resolveConstantContactActivation({}, "saas").configured).toBe(false);
    expect(resolveConstantContactActivation({
      CONSTANT_CONTACT_CLIENT_ID: "client-id",
      CONSTANT_CONTACT_CLIENT_SECRET: "long-enough-client-secret",
    }, "saas").configured).toBe(true);
    expect(resolveConstantContactActivation({
      CONSTANT_CONTACT_CLIENT_ID: "client-id",
      CONSTANT_CONTACT_CLIENT_SECRET: "long-enough-client-secret",
    }, "demo").configured).toBe(false);
  });

  it("accepts only canonical product hosts for the OAuth callback", () => {
    expect(constantContactRedirectUri(`${PORTAL_HOST}:443`)).toBe(`${PORTAL_ORIGIN}/api/constant-contact-oauth`);
    expect(constantContactRedirectUri(`${PORTAL_HOST}.`)).toBe(`${PORTAL_ORIGIN}/api/constant-contact-oauth`);
    expect(constantContactRedirectUri(`www.${PORTAL_HOST}`)).toBeNull();
    expect(constantContactRedirectUri(`${PORTAL_HOST}.attacker.example`)).toBeNull();
    expect(constantContactRedirectUri("unionground.invalid")).toBeNull();
    expect(constantContactRedirectUri("localhost:5173")).toBeNull();
  });

  it("builds a PKCE authorization request with the exact bounded scopes", () => {
    const result = buildConstantContactAuthorizeUrl({
      clientId: "client-id",
      redirectUri: `${PORTAL_ORIGIN}/api/constant-contact-oauth`,
      state: "state-value",
      codeChallenge: "challenge-value",
    });
    expect(result.ok).toBe(true);
    const url = new URL(result.url);
    expect(url.searchParams.get("scope")).toBe(CONSTANT_CONTACT_SCOPES.join(" "));
    expect(CONSTANT_CONTACT_SCOPES).toContain("account_read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-value");
  });

  it("rejects incomplete token payloads and summarizes only recognized dated activity", () => {
    expect(parseConstantContactToken({ access_token: "short-lived" }, { requireRefreshToken: true })).toEqual({
      ok: false,
      reason: "provider_error",
    });
    const summary = summarizeConstantContactActivities([
      { tracking_activity_type: "em_opens", created_time: "2026-08-29T14:00:00Z" },
      { tracking_activity_type: "em_opens", created_time: "2026-08-30T14:00:00Z" },
      { tracking_activity_type: "em_clicks", created_time: "not-a-date" },
      { tracking_activity_type: "unsupported", created_time: "2026-08-30T15:00:00Z" },
    ]);
    expect(summary.opensCount).toBe(2);
    expect(summary.clicksCount).toBe(0);
    expect(summary.lastOpenedAt).toBe("2026-08-30T14:00:00.000Z");
    expect(summary.lastActivityAt).toBe("2026-08-30T14:00:00.000Z");
  });

  it("classifies OAuth invalid_grant as rejected credentials and reserves finalization time", async () => {
    const rejected = await requestConstantContactToken({
      clientId: "client-id",
      clientSecret: "client-secret",
      body: { grant_type: "refresh_token", refresh_token: "refresh-token" },
      fetcher: vi.fn().mockResolvedValue(providerResponse({ error: "invalid_grant" }, false, 400)),
    });
    expect(rejected).toEqual({ ok: false, reason: "credential_rejected" });

    const fetcher = vi.fn();
    await expect(fetchConstantContactMember({
      accessToken: "access-token",
      email: "member@example.com",
      fetcher,
      deadlineMs: Date.now() + 1_000,
    })).rejects.toThrow("invocation_budget");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("pins pagination to the provider API and caps activity retrieval", async () => {
    expect(constantContactPaginationUrl("https://evil.example/v3/contacts")).toBeNull();
    expect(constantContactPaginationUrl("https://api.cc.email/v2/contacts")).toBeNull();
    const activities = Array.from({ length: 100 }, (_, index) => ({
      tracking_activity_type: "em_sends",
      created_time: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T12:00:00Z`,
    }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(providerResponse({ contacts: [{
        contact_id: "contact-1",
        email_address: { permission_to_send: "implicit" },
        list_memberships: ["list-1"],
        taggings: ["tag-1"],
      }] }))
      .mockResolvedValueOnce(providerResponse({
        tracking_activities: activities,
        _links: { next: { href: "https://api.cc.email/v3/next-page-2" } },
      }))
      .mockResolvedValueOnce(providerResponse({
        tracking_activities: activities,
        _links: { next: { href: "https://api.cc.email/v3/next-page-3" } },
      }))
      .mockResolvedValueOnce(providerResponse({
        tracking_activities: activities,
        _links: { next: { href: "https://api.cc.email/v3/next-page-4" } },
      }));
    const result = await fetchConstantContactMember({
      accessToken: "short-lived-access",
      email: "MEMBER@EXAMPLE.COM",
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[0][0])).toContain("email=member%40example.com");
    expect(fetcher.mock.calls.every(([url]) => new URL(url).hostname === "api.cc.email")).toBe(true);
    expect(result.analytics.sendsCount).toBe(300);
    expect(result.listCount).toBe(1);
    expect(result.tagCount).toBe(1);
  });

  it("labels the connected account from provider identity within the stored-label bounds", async () => {
    expect(constantContactAccountLabel({ organization_name: "  Harborview\u0000 Care\n Workers ", contact_email: "a@b.example" }))
      .toBe("Harborview Care Workers");
    expect(constantContactAccountLabel({ organization_name: "", contact_email: "owner@harborview.example" }))
      .toBe("owner@harborview.example");
    const long = constantContactAccountLabel({ organization_name: `${"é".repeat(119)}😀😀` });
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith("😀")).toBe(true);
    expect(long).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(constantContactAccountLabel(null)).toBe("");
    expect(constantContactAccountLabel({ organization_name: 42 })).toBe("");

    const fetcher = vi.fn().mockResolvedValue(providerResponse({ organization_name: "Harborview Care United" }));
    await expect(fetchConstantContactAccountLabel({ accessToken: "access", fetcher })).resolves.toBe("Harborview Care United");
    expect(fetcher.mock.calls[0][0]).toBe("https://api.cc.email/v3/account/summary");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer access" },
      redirect: "error",
    });
    await expect(fetchConstantContactAccountLabel({
      accessToken: "access",
      fetcher: vi.fn().mockResolvedValue(providerResponse({}, false, 403)),
    })).resolves.toBe("");
    await expect(fetchConstantContactAccountLabel({
      accessToken: "access",
      fetcher: vi.fn().mockRejectedValue(new Error("offline")),
    })).resolves.toBe("");
  });
});
