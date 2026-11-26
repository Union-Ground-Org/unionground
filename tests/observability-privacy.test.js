import { describe, expect, it } from "vitest";
import {
  sanitizePostHogEvent,
  sanitizeSentryBreadcrumb,
  sanitizeSentryEvent,
  sanitizeSentrySpan,
  redactSensitiveText,
  stripUrlDetails,
} from "../src/lib/observabilityPrivacy.js";

describe("observability privacy boundary", () => {
  it("removes query strings and fragments from captured URLs", () => {
    expect(stripUrlDetails("https://app.example.org/reset?token=secret#access_token=also-secret"))
      .toBe("https://app.example.org/reset");
  });

  it("keeps PostHog routing metadata but drops member content and identity fields", () => {
    const event = sanitizePostHogEvent({
      event: "$pageview",
      properties: {
        token: "public-project-token",
        $current_url: "https://app.example.org/m/cases?member=42#private",
        email: "member@example.com",
        message: "case narrative",
        deployment_environment: "production",
      },
    });
    expect(event.properties).toEqual({
      token: "public-project-token",
      $current_url: "https://app.example.org/m/cases",
      deployment_environment: "production",
    });
  });

  it("redacts credentials and email addresses in retained text, including malformed URLs", () => {
    const text = "member@example.com Bearer abc.def.ghi eyJhbGci.eyJzdWI.signature";
    expect(redactSensitiveText(text)).toBe("[redacted-email] Bearer [redacted] [redacted-token]");
    expect(stripUrlDetails("https://[invalid]/member@example.com?token=private#fragment"))
      .toBe("https://[invalid]/[redacted-email]");
    expect(stripUrlDetails("/m/cases?member=42#private")).toBe("/m/cases");
    expect(stripUrlDetails("")).toBe("");
    expect(stripUrlDetails(null)).toBeNull();
    expect(redactSensitiveText(42)).toBe(42);
  });

  it("bounds nested PostHog values and arrays while removing sensitive keys at every level", () => {
    const nested = { safe: { safe: { safe: { safe: { safe: { safe: { email: "member@example.com" } } } } } } };
    const event = sanitizePostHogEvent({ properties: {
      items: Array.from({ length: 60 }, () => ({ email: "member@example.com", count: 1 })),
      nested, missing: undefined, empty: null, enabled: true, count: 2,
      label: Symbol("public-label"),
    } });
    expect(event.properties.items).toHaveLength(50);
    expect(event.properties.items.every(item => JSON.stringify(item) === '{"count":1}')).toBe(true);
    expect(event.properties.nested.safe.safe.safe.safe.safe.safe).toBe("[truncated]");
    expect(event.properties).toMatchObject({ empty: null, enabled: true, count: 2, label: "Symbol(public-label)" });
    expect(event.properties.missing).toBeUndefined();
    expect(sanitizePostHogEvent({ event: "$pageview" }).properties).toEqual({});
    expect(sanitizePostHogEvent(null)).toBeNull();
    expect(sanitizePostHogEvent("invalid")).toBe("invalid");
  });

  it("drops Sentry member identity, requests and arbitrary extras", () => {
    const event = sanitizeSentryEvent({ user: { id: "internal-uuid", email: "member@example.com" }, request: { data: "private" }, extra: { safe_count: 2, arbitrary: "private" } });
    expect(event).toEqual({ level: "error", message: "Application error" });
  });

  it("drops all Sentry breadcrumbs including navigation queries and dotted attributes", () => {
    for (const category of ["console", "navigation", "fetch", "ui.click", "native.lifecycle"]) {
      expect(sanitizeSentryBreadcrumb({ category, data: { "http.query": "member=private", from: "/m/cases?q=private", to: "/m/messages#private" } })).toBeNull();
    }
  });

  it("drops all span identity and description fields, including dotted query attributes", () => {
    const clean = sanitizeSentrySpan({ trace_id: "private", description: "Taylor Example", data: { "http.query": "private", "http.fragment": "private", memberId: "private" } });
    expect(JSON.stringify(clean)).not.toContain("private");
    expect(clean.data).toEqual({});
  });
});
