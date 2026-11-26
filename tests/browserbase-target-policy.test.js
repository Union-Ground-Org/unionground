// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  assertLoadedBuildDocument,
  assertPageOrigin,
  canonicalHttpsOrigin,
  canonicalSupabaseOrigin,
  captureAuthenticatedMemberId,
  exactApprovedOrigin,
  exactResponseTarget,
  isTrustedPasswordTokenResponse,
  loadedBuildDocumentSha,
} from "../scripts/lib/browserbase-target-policy.mjs";

const TARGET = "https://app.example.org";
const SUPABASE = "https://project.supabase.co";
const CREATED_ID = "00000000-0000-4000-8000-000000000001";
const EVIL_ID = "00000000-0000-4000-8000-000000000999";
const EXPECTED_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function loadedDocument(overrides = {}) {
  return {
    requestedUrl: `${TARGET}/`,
    responseUrl: `${TARGET}/`,
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><meta name="union-ground-build-sha" content="${EXPECTED_SHA}" /></head></html>`,
    expectedOrigin: TARGET,
    expectedSha: EXPECTED_SHA,
    ...overrides,
  };
}

describe("Browserbase target policy", () => {
  it("accepts only one canonical root HTTPS origin", () => {
    expect(canonicalHttpsOrigin(TARGET)).toBe(TARGET);
    for (const value of [
      "http://app.example.org",
      "https://user@app.example.org",
      "https://app.example.org:443",
      "https://app.example.org/",
      "https://app.example.org/m",
      "https://app.example.org?token=secret",
      "https://app.example.org#fragment",
      "https://127.0.0.1",
      "https://app.exämple.org",
    ]) {
      expect(() => canonicalHttpsOrigin(value)).toThrow();
    }
  });

  it("pins the browser target and Supabase project origins independently", () => {
    expect(exactApprovedOrigin(TARGET, TARGET, "target")).toBe(TARGET);
    expect(() => exactApprovedOrigin("https://app.example.org.evil.example", TARGET, "target")).toThrow(/source-approved/);
    expect(canonicalSupabaseOrigin(SUPABASE)).toBe(SUPABASE);
    expect(() => canonicalSupabaseOrigin("https://project.supabase.co.evil.example")).toThrow(/Supabase project/);
  });

  it("rejects a main-frame redirect before credential entry", () => {
    expect(assertPageOrigin("https://app.example.org/signin", TARGET)).toBe(TARGET);
    expect(() => assertPageOrigin("https://evil.example/signin", TARGET)).toThrow(/left the attested/);
    expect(() => assertPageOrigin("not a URL", TARGET)).toThrow(/invalid URL/);
  });

  it("reads the marker a loaded document carries without binding it", () => {
    const other = `<!doctype html><html><head><meta name="union-ground-build-sha" content="${OTHER_SHA}" /></head></html>`;
    expect(loadedBuildDocumentSha(loadedDocument().body)).toBe(EXPECTED_SHA);
    expect(loadedBuildDocumentSha(other)).toBe(OTHER_SHA);
    expect(loadedBuildDocumentSha(new TextEncoder().encode(other))).toBe(OTHER_SHA);
    // Missing, repeated, malformed, or unreadable markers read as unknown.
    expect(loadedBuildDocumentSha("<!doctype html><html><head></head></html>")).toBeNull();
    expect(loadedBuildDocumentSha(`${loadedDocument().body}${other}`)).toBeNull();
    expect(loadedBuildDocumentSha('<meta name="union-ground-build-sha" content="abc" />')).toBeNull();
    expect(loadedBuildDocumentSha(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
    expect(loadedBuildDocumentSha(new Uint8Array())).toBeNull();
    expect(loadedBuildDocumentSha("")).toBeNull();
    expect(loadedBuildDocumentSha(undefined)).toBeNull();
    expect(loadedBuildDocumentSha({ body: other })).toBeNull();
  });

  it("binds the actual loaded main-document bytes to the expected build", () => {
    expect(assertLoadedBuildDocument(loadedDocument())).toEqual({
      url: `${TARGET}/`,
      sha: EXPECTED_SHA,
    });
    expect(assertLoadedBuildDocument(loadedDocument({ body: new TextEncoder().encode(loadedDocument().body) }))).toEqual({
      url: `${TARGET}/`,
      sha: EXPECTED_SHA,
    });
  });

  it("rejects a loaded document whose marker is a different build SHA", () => {
    expect(() => assertLoadedBuildDocument(loadedDocument({
      body: loadedDocument().body.replace(EXPECTED_SHA, OTHER_SHA),
    }))).toThrow(/not bound to the expected build SHA/);
  });

  it.each([
    ["redirect chain", { redirectedFrom: true }, /must not follow a redirect/],
    ["changed response URL", { responseUrl: `${TARGET}/signin` }, /must not follow a redirect/],
    ["cross-origin response", { responseUrl: "https://evil.example/" }, /left the attested/],
    ["partial response", { status: 206 }, /exact HTTP 200/],
    ["non-HTML response", { contentType: "application/json" }, /must be HTML/],
    ["missing marker", { body: "<!doctype html><html></html>" }, /not bound to the expected build SHA/],
    ["duplicate marker", { body: `${loadedDocument().body}${loadedDocument().body}` }, /not bound to the expected build SHA/],
    ["oversized document", { body: "x".repeat(512 * 1024 + 1) }, /body size is invalid/],
    ["invalid UTF-8", { body: new Uint8Array([0xff]) }, /valid UTF-8/],
    ["invalid expected SHA", { expectedSha: "ABC" }, /expected SHA is invalid/],
  ])("fails closed for %s", (_label, overrides, expectedMessage) => {
    expect(() => assertLoadedBuildDocument(loadedDocument(overrides))).toThrow(expectedMessage);
  });

  it("recognizes only the exact configured Supabase password-token response", () => {
    expect(isTrustedPasswordTokenResponse(`${SUPABASE}/auth/v1/token?grant_type=password`, SUPABASE)).toBe(true);
    for (const value of [
      `https://evil.example/auth/v1/token?grant_type=password`,
      `${TARGET}/auth/v1/token?grant_type=password`,
      `${SUPABASE}/auth/v1/token/evil?grant_type=password`,
      `${SUPABASE}/auth/v1/token?grant_type=refresh_token`,
      `${SUPABASE}/auth/v1/token?grant_type=password&next=evil`,
      `${SUPABASE}/auth/v1/token?grant_type=password#fragment`,
      "not a URL",
    ]) {
      expect(isTrustedPasswordTokenResponse(value, SUPABASE)).toBe(false);
    }
  });

  it("never lets target-controlled token JSON overwrite a runner-created member id", () => {
    expect(captureAuthenticatedMemberId({
      adminProvisionedByRunner: true,
      createdUserId: CREATED_ID,
      currentMemberUserId: CREATED_ID,
      responseUrl: `${SUPABASE}/auth/v1/token?grant_type=password`,
      payload: { user: { id: EVIL_ID } },
      supabaseOrigin: SUPABASE,
    })).toBe(CREATED_ID);
    expect(() => captureAuthenticatedMemberId({
      adminProvisionedByRunner: true,
      createdUserId: "attacker-chosen-id",
      responseUrl: `${SUPABASE}/auth/v1/token?grant_type=password`,
      payload: { user: { id: EVIL_ID } },
      supabaseOrigin: SUPABASE,
    })).toThrow(/Runner-created member id is invalid/);
  });

  it("captures an existing account only from the exact trusted auth response", () => {
    expect(captureAuthenticatedMemberId({
      adminProvisionedByRunner: false,
      currentMemberUserId: "",
      responseUrl: `${SUPABASE}/auth/v1/token?grant_type=password`,
      payload: { user: { id: CREATED_ID } },
      supabaseOrigin: SUPABASE,
    })).toBe(CREATED_ID);
    expect(captureAuthenticatedMemberId({
      adminProvisionedByRunner: false,
      currentMemberUserId: CREATED_ID,
      responseUrl: `${TARGET}/auth/v1/token?grant_type=password`,
      payload: { user: { id: EVIL_ID } },
      supabaseOrigin: SUPABASE,
    })).toBe(CREATED_ID);
    expect(captureAuthenticatedMemberId({
      adminProvisionedByRunner: false,
      currentMemberUserId: CREATED_ID,
      responseUrl: `${SUPABASE}/auth/v1/token?grant_type=password`,
      payload: { user: { id: "chosen-non-uuid" } },
      supabaseOrigin: SUPABASE,
    })).toBe(CREATED_ID);
  });

  it("binds persistence responses to exact Supabase origin, path, and method", () => {
    expect(exactResponseTarget({
      value: `${SUPABASE}/rest/v1/member_profiles?select=id`,
      origin: SUPABASE,
      pathname: "/rest/v1/member_profiles",
      method: "PATCH",
      actualMethod: "PATCH",
    })).toBe(true);
    for (const [value, method] of [
      [`https://evil.example/rest/v1/member_profiles`, "PATCH"],
      [`${TARGET}/rest/v1/member_profiles`, "PATCH"],
      [`${SUPABASE}/rest/v1/member_profiles/evil`, "PATCH"],
      [`${SUPABASE}/rest/v1/member_profiles`, "POST"],
      ["not a URL", "PATCH"],
    ]) {
      expect(exactResponseTarget({
        value,
        origin: SUPABASE,
        pathname: "/rest/v1/member_profiles",
        method: "PATCH",
        actualMethod: method,
      })).toBe(false);
    }
  });
});
