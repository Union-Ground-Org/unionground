import { describe, expect, it, vi } from "vitest";
import {
  SAMPLE_BACKEND,
  isForbiddenSampleBackend,
  isSampleAccountEmail,
  pinnedSampleSupabaseOrigin,
  retiredHostRefusesSession,
  samplePersonas,
} from "../src/lib/sampleBackend.js";
import { PORTAL_HOST, SAMPLE_HOST } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://ref.supabase.co", "https://someotherproject.supabase.co"));

// BUG-UG-DEMO-HOST-SIGNED-OUT-DEAD-END-20261106: the demo host adopts
// a session only for a seeded persona or a fictional SAMPLE organization
// account, decided on the access token's own email claim. Unit coverage for
// every branch of that guard and of the domain check.

function tokenWithEmail(email) {
  const payload = Buffer.from(JSON.stringify({ email, session_id: "11111111-1111-4111-8111-111111111111" })).toString("base64url");
  return `header.${payload}.signature`;
}

const session = (email, claim = email) => ({ user: { id: "u", email }, access_token: claim === null ? "not-a-token" : tokenWithEmail(claim) });
const DEMO = SAMPLE_HOST;

describe("isSampleAccountEmail", () => {
  it("accepts exactly the configured fictional SAMPLE account domain", () => {
    expect(SAMPLE_BACKEND.sampleAccountEmailDomains).toEqual(["loadtest.demo.example.com"]);
    expect(isSampleAccountEmail("kayla.doyle@loadtest.demo.example.com")).toBe(true);
  });

  it.each([
    ["a non-string", 42],
    ["no address at all", undefined],
    ["a domain with no local part", "@loadtest.demo.example.com"],
    ["no at sign", "kayla.doyle.loadtest.demo.example.com"],
    ["a subdomain", "kayla@x.loadtest.demo.example.com"],
    ["a look-alike suffix", "kayla@loadtest.demo.example.com.example.net"],
    ["a prefix", "kayla@evil-loadtest.demo.example.com"],
    ["an outside domain", "someone@example.com"],
    ["a retired persona domain", "darnell.foster@demo.example.com"],
  ])("refuses %s", (_label, email) => {
    expect(isSampleAccountEmail(email)).toBe(false);
  });
});

describe("retiredHostRefusesSession", () => {
  it("adopts a fictional SAMPLE organization account whose claim equals the stored email", () => {
    expect(retiredHostRefusesSession(session("kayla.doyle@loadtest.demo.example.com"), DEMO)).toBe(false);
  });

  // UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107: the entry's
  // personas are Tamarack accounts; the retired pre-bot people are refused.
  it("adopts every demo entry persona and refuses the retired pre-bot people", () => {
    for (const persona of samplePersonas()) {
      expect(isSampleAccountEmail(persona.email)).toBe(false);
      expect(retiredHostRefusesSession(session(persona.email), DEMO)).toBe(false);
    }
    expect(retiredHostRefusesSession(session("darnell.foster@demo.example.com"), DEMO)).toBe(true);
  });

  it("refuses an outside account", () => {
    expect(retiredHostRefusesSession(session("someone@example.com"), DEMO)).toBe(true);
  });

  it("refuses a stored SAMPLE email whose token claims another account", () => {
    expect(retiredHostRefusesSession(session("kayla.doyle@loadtest.demo.example.com", "someone@example.com"), DEMO)).toBe(true);
  });

  it("refuses a token with no readable email claim beside a SAMPLE email", () => {
    expect(retiredHostRefusesSession(session("kayla.doyle@loadtest.demo.example.com", null), DEMO)).toBe(true);
  });

  it("never acts off the demo host or without a session", () => {
    expect(retiredHostRefusesSession(session("someone@example.com"), PORTAL_HOST)).toBe(false);
    expect(retiredHostRefusesSession(null, DEMO)).toBe(false);
    expect(retiredHostRefusesSession({ access_token: "x" }, DEMO)).toBe(false);
  });
});

describe("SAMPLE backend pinning helpers", () => {
  it("refuses candidate SAMPLE backends while no project is pinned", () => {
    expect(SAMPLE_BACKEND.sampleSupabaseRef).toBe("");
    expect(pinnedSampleSupabaseOrigin()).toBe("");
    expect(isForbiddenSampleBackend("someotherproject")).toBe(true);
    expect(isForbiddenSampleBackend("https://someotherproject.supabase.co")).toBe(true);
  });

  it("prefers an explicit SAMPLE origin over the derived one", () => {
    expect(pinnedSampleSupabaseOrigin({ sampleSupabaseOrigin: "https://sample.example.test", sampleSupabaseRef: "ref" })).toBe("https://sample.example.test");
    expect(pinnedSampleSupabaseOrigin({ sampleSupabaseOrigin: "", sampleSupabaseRef: "ref" })).toBe("https://ref.supabase.co");
  });
});
