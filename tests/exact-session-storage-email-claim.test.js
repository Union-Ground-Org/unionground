import { describe, expect, it } from "vitest";

import { emailFromAccessToken } from "../src/lib/exactSessionStorage.js";

// BUG-UG-REMOVE-RETIRED-PREVIEW-INVITATION-20261020: the retired
// preview host decides on the access token's own email claim, so every way the
// claim can be unreadable must answer null rather than throw or guess.
function tokenWithPayload(payload) {
  return `header.${Buffer.from(payload).toString("base64url")}.signature`;
}

describe("emailFromAccessToken", () => {
  it("reads and lowercases the email claim of a JWT-shaped token", () => {
    expect(emailFromAccessToken(tokenWithPayload(JSON.stringify({ email: "Member@Example.Test", session_id: "x" })))).toBe("member@example.test");
  });

  it("answers null for anything that is not a readable JWT with an email claim", () => {
    expect(emailFromAccessToken(undefined)).toBeNull();
    expect(emailFromAccessToken(42)).toBeNull();
    expect(emailFromAccessToken("token")).toBeNull();
    expect(emailFromAccessToken("header..signature")).toBeNull();
    expect(emailFromAccessToken("header.%%%not-base64%%%.signature")).toBeNull();
    expect(emailFromAccessToken(tokenWithPayload("{not json"))).toBeNull();
    expect(emailFromAccessToken(tokenWithPayload(JSON.stringify({ session_id: "x" })))).toBeNull();
    expect(emailFromAccessToken(tokenWithPayload(JSON.stringify({ email: "" })))).toBeNull();
    expect(emailFromAccessToken(tokenWithPayload(JSON.stringify({ email: 7 })))).toBeNull();
    expect(emailFromAccessToken(tokenWithPayload("null"))).toBeNull();
  });
});
