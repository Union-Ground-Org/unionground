// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  decryptRefreshToken,
  encryptRefreshToken,
  pkcePair,
} from "../api/_lib/calendarOAuth.js";
import { parseTokenResponse } from "../src/features/calendarFreeBusy/oauth.js";

describe("calendar OAuth token custody", () => {
  it("round-trips AES-GCM envelopes and rejects tampering or the wrong surface key", () => {
    const env = {
      CALENDAR_OAUTH_TOKEN_WRAP_KEY: "production-wrap-key-value-32-characters-long!",
      SAMPLE_CALENDAR_OAUTH_TOKEN_WRAP_KEY: "sample-wrap-key-value-32-characters-long!!!!",
    };
    const envelope = encryptRefreshToken(env, "saas", "provider-refresh-token");
    expect(envelope).toMatch(/^v1:/);
    expect(envelope).not.toContain("provider-refresh-token");
    expect(decryptRefreshToken(env, "saas", envelope)).toBe("provider-refresh-token");
    expect(decryptRefreshToken(env, "demo", envelope)).toBeNull();
    const parts = envelope.split(":");
    parts[3] = `${parts[3].slice(0, -1)}${parts[3].endsWith("A") ? "B" : "A"}`;
    expect(decryptRefreshToken(env, "saas", parts.join(":"))).toBeNull();

    const canonicalParts = envelope.split(":");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const tagLastIndex = alphabet.indexOf(canonicalParts[2].at(-1));
    const nonCanonicalTag = `${canonicalParts[2].slice(0, -1)}${alphabet[tagLastIndex + 1]}`;
    expect(Buffer.from(nonCanonicalTag, "base64url")).toEqual(Buffer.from(canonicalParts[2], "base64url"));
    canonicalParts[2] = nonCanonicalTag;
    expect(decryptRefreshToken(env, "saas", canonicalParts.join(":"))).toBeNull();
  });

  it("creates bounded PKCE S256 material without returning provider secrets", () => {
    const pair = pkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  it("rejects a provider token response without a refresh token", () => {
    expect(parseTokenResponse({ access_token: "short-lived-access-token" })).toEqual({
      ok: false,
      reason: "provider_error",
      details: null,
    });
  });
});
