// @vitest-environment node
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinnedSampleSupabaseOrigin } from "../src/lib/sampleBackend.js";
import {
  confirmationEmail, emailDigest, mintSignupToken, normalizeEmail, openSignupConfig, parseBody,
  readSignupToken, resendIdempotencyKey, scopeHash, sendConfirmationEmail, signupKeys, signupLink,
  TOKEN_TTL_SECONDS, turnstileVerdict,
} from "../api/_lib/openSignup.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const SECRET = "open-signup-secret-at-least-32-characters";
const keys = signupKeys(SECRET);
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

afterEach(() => vi.restoreAllMocks());

describe("signup keys", () => {
  it("refuses a short or missing secret", () => {
    expect(signupKeys("short")).toBeNull();
    expect(signupKeys(undefined)).toBeNull();
    expect(signupKeys("x".repeat(31))).toBeNull();
    expect(signupKeys("x".repeat(32))).not.toBeNull();
  });

  it("treats the .env.example placeholder as a missing secret", () => {
    expect(signupKeys("replace-with-at-least-32-random-characters")).toBeNull();
    expect(signupKeys("  REPLACE-WITH-something-long-enough-for-the-check")).toBeNull();
  });

  it("derives separate token and scope keys", () => {
    expect(keys.token.equals(keys.scope)).toBe(false);
    expect(keys.token).toHaveLength(32);
  });
});

describe("confirmation token", () => {
  const claims = { email: "person@example.invalid", locale: "es", termsVersion: "2026-09-22", residenceState: "CA" };

  it("round-trips the email, locale, terms version, state and the age attestation time", () => {
    const token = mintSignupToken(keys, claims, NOW);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("example.invalid");
    expect(readSignupToken(keys, token, NOW + 60_000)).toEqual({
      email: "person@example.invalid", locale: "es", termsVersion: "2026-09-22",
      residenceState: "CA", ageRule: "adult",
      ageAttestedAt: new Date(Math.floor(NOW / 1000) * 1000).toISOString(),
    });
  });

  // The state selects the attestation the
  // account records, 18 or older in the five app-store age-law states and the
  // D-03 B band elsewhere.
  it.each([["TX", "adult"], ["LA", "adult"], ["NY", "band"], ["GU", "band"], ["outside-us", "band"]])(
    "reads the age rule for %s as %s",
    (residenceState, ageRule) => {
      const token = mintSignupToken(keys, { ...claims, residenceState }, NOW);
      expect(readSignupToken(keys, token, NOW)).toMatchObject({ residenceState, ageRule });
    },
  );

  // A link minted before the state question, or with an unlisted state,
  // never creates an account.
  it.each([undefined, "", "ZZ", "tx"])("refuses a sealed token whose state is %s", (residenceState) => {
    const token = mintSignupToken(keys, { ...claims, residenceState }, NOW);
    expect(readSignupToken(keys, token, NOW)).toBeNull();
  });

  // A link minted before the "I'm 18 or
  // older" attestation existed carries none, and never creates an account.
  it("refuses a sealed token that carries no adult attestation", () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keys.token, iv);
    const payload = JSON.stringify({ e: claims.email, x: Math.floor(NOW / 1000) + 600, l: "en", t: claims.termsVersion, s: "CA" });
    const sealed = Buffer.concat([cipher.update(payload, "utf8"), cipher.final(), cipher.getAuthTag()]);
    expect(readSignupToken(keys, `v1.${iv.toString("base64url")}.${sealed.toString("base64url")}`, NOW)).toBeNull();
  });

  it("defaults an unknown locale to English", () => {
    const token = mintSignupToken(keys, { ...claims, locale: "fr" }, NOW);
    expect(readSignupToken(keys, token, NOW).locale).toBe("en");
  });

  it("expires after 30 minutes", () => {
    const token = mintSignupToken(keys, claims, NOW);
    expect(readSignupToken(keys, token, NOW + (TOKEN_TTL_SECONDS - 1) * 1000)).not.toBeNull();
    expect(readSignupToken(keys, token, NOW + TOKEN_TTL_SECONDS * 1000)).toBeNull();
  });

  it("refuses a tampered token, a foreign key and malformed input", () => {
    const token = mintSignupToken(keys, claims, NOW);
    const [version, iv, sealed] = token.split(".");
    const flipped = `${sealed.slice(0, 5)}${sealed[5] === "A" ? "B" : "A"}${sealed.slice(6)}`;
    expect(readSignupToken(keys, `${version}.${iv}.${flipped}`, NOW)).toBeNull();
    expect(readSignupToken(signupKeys("another-secret-that-is-long-enough-000"), token, NOW)).toBeNull();
    expect(readSignupToken(keys, "v1.short.value", NOW)).toBeNull();
    expect(readSignupToken(keys, "", NOW)).toBeNull();
    expect(readSignupToken(null, token, NOW)).toBeNull();
    expect(readSignupToken(keys, `v2.${iv}.${sealed}`, NOW)).toBeNull();
  });

  it("refuses a sealed payload that does not carry a valid email", () => {
    const bad = mintSignupToken(keys, { ...claims, email: "not-an-email" }, NOW);
    expect(readSignupToken(keys, bad, NOW)).toBeNull();
  });

  it("puts the token in a fragment on the app origin", () => {
    expect(signupLink(PORTAL_ORIGIN, "v1.a.b")).toBe(`${PORTAL_ORIGIN}/signup/confirm#token=v1.a.b`);
  });
});

describe("scopes and digests", () => {
  it("keeps network and email scopes separate and 64-hex", () => {
    const network = scopeHash(keys, "network", "ipv4:203.0.113.7");
    const email = scopeHash(keys, "email", "ipv4:203.0.113.7");
    expect(network).toMatch(/^[0-9a-f]{64}$/);
    expect(network).not.toBe(email);
    expect(scopeHash(keys, "network", "ipv4:203.0.113.7")).toBe(network);
  });

  it("hashes the normalized email the way the database does", () => {
    expect(emailDigest("person@example.invalid"))
      .toBe(createHash("sha256").update("person@example.invalid").digest("hex"));
    expect(normalizeEmail("  Person@Example.Invalid ")).toBe("person@example.invalid");
    expect(normalizeEmail("no-at-sign")).toBe("");
    expect(normalizeEmail(`${"a".repeat(250)}@x.io`)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
  });

  it("derives a Resend idempotency key that never carries the email", () => {
    const key = resendIdempotencyKey(keys, "person@example.invalid", NOW);
    expect(key).toMatch(/^ug-signup-[0-9a-f]{24}$/);
    expect(resendIdempotencyKey(keys, "person@example.invalid", NOW + 1000)).toBe(key);
    expect(resendIdempotencyKey(keys, "person@example.invalid", NOW + TOKEN_TTL_SECONDS * 1000)).not.toBe(key);
  });
});

describe("Turnstile verification", () => {
  const good = { success: true, hostname: PORTAL_HOST, action: "open-signup" };
  const reply = (body, ok = true) => vi.fn().mockResolvedValue({ ok, json: vi.fn().mockResolvedValue(body) });

  it("passes only a successful token for a SaaS host and the signup action", async () => {
    const fetcher = reply(good);
    expect(await turnstileVerdict("secret", "token", "203.0.113.7", fetcher)).toBe("pass");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(new URLSearchParams(init.body).get("remoteip")).toBe("203.0.113.7");
    expect(await turnstileVerdict("secret", "token", "", reply({ ...good, hostname: `www.${PORTAL_HOST}` }))).toBe("fail");
  });

  it.each([
    ["failure", { ...good, success: false }],
    ["a refused visitor token", { success: false, "error-codes": ["invalid-input-response"] }],
    ["a spent visitor token", { success: false, "error-codes": ["timeout-or-duplicate"] }],
    ["preview host", { ...good, hostname: "feature.vercel.app" }],
    ["other action", { ...good, action: "login" }],
  ])("fails closed on %s", async (_name, body) => {
    expect(await turnstileVerdict("secret", "token", "", reply(body))).toBe("fail");
  });

  it("fails a missing or oversized token without calling Cloudflare", async () => {
    const fetcher = reply(good);
    expect(await turnstileVerdict("secret", "", "", fetcher)).toBe("fail");
    expect(await turnstileVerdict("secret", "x".repeat(2049), "", fetcher)).toBe("fail");
    expect(fetcher).not.toHaveBeenCalled();
  });

  // REQ-UG-SIGNUP-AND-ACCOUNT-MAIL-FAILURES-RAISE-NO-PRIVATE-ALERT-20261111:
  // an outage or a refused site secret is told apart from a refused visitor.
  it.each([
    ["an HTTP error", reply(good, false)],
    ["a transport error", vi.fn().mockRejectedValue(new Error("down"))],
    ["an unreadable answer", vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockRejectedValue(new SyntaxError("bad")) })],
    ["an empty answer", reply(null)],
    ["an object without a verdict", reply({})],
    ["an array", reply([])],
    ["a verdict that is not a boolean", reply({ ...good, success: "true" })],
    ["Cloudflare's internal error", reply({ success: false, "error-codes": ["internal-error"] })],
    ["a refused site secret", reply({ success: false, "error-codes": ["invalid-input-secret"] })],
    ["a missing site secret", reply({ success: false, "error-codes": ["missing-input-secret"] })],
    ["a malformed request", reply({ success: false, "error-codes": ["bad-request"] })],
  ])("reports the check unavailable on %s", async (_name, fetcher) => {
    expect(await turnstileVerdict("secret", "token", "", fetcher)).toBe("unavailable");
  });
});

describe("confirmation email", () => {
  it("names no organization and carries no chapter eyebrow in either language", () => {
    for (const locale of ["en", "es"]) {
      const mail = confirmationEmail(locale, `${PORTAL_ORIGIN}/signup/confirm#token=v1.a.b`);
      expect(mail.html).not.toMatch(/LOCAL|CHAPTER|CAPÍTULO|509/);
      expect(mail.text).toContain(`${PORTAL_ORIGIN}/signup/confirm#token=v1.a.b`);
      expect(mail.html).toContain("#efa738");
    }
    expect(confirmationEmail("en", "x").subject).toBe("Confirm your email for Union Ground");
    expect(confirmationEmail("es", "x").subject).toBe("Confirma tu correo para Union Ground");
    expect(confirmationEmail("en", "x").text).toContain("Finish creating my account");
    expect(confirmationEmail("es", "x").text).toContain("Terminar de crear mi cuenta");
    expect(confirmationEmail("en", '"><script>').html).not.toContain("<script>");
  });

  it("sends one Resend request with the idempotency key and reports failure as false", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    expect(await sendConfirmationEmail({
      resendKey: "re_key", from: "Union Ground <alerts@example.invalid>", to: "person@example.invalid",
      locale: "en", link: `${PORTAL_ORIGIN}/signup/confirm#token=v1.a.b`, idempotencyKey: "ug-signup-abc",
    }, fetcher)).toBe(true);
    expect(fetcher.mock.calls[0][1].headers["Idempotency-Key"]).toBe("ug-signup-abc");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).to).toEqual(["person@example.invalid"]);
    expect(await sendConfirmationEmail({ idempotencyKey: "k" }, vi.fn().mockResolvedValue({ ok: false }))).toBe(false);
    expect(await sendConfirmationEmail({ idempotencyKey: "k" }, vi.fn().mockRejectedValue(new Error("x")))).toBe(false);
  });
});

describe("configuration", () => {
  const backend = { url: "https://project.supabase.co", serviceRoleKey: "service" };
  const env = {
    INVITATION_APP_ORIGIN: `${PORTAL_ORIGIN}/`,
    OPEN_SIGNUP_SECRET: SECRET,
    TURNSTILE_SECRET_KEY: "turnstile",
    RESEND_API_KEY: "re_key",
    NOTIFY_FROM_ADDRESS: "Union Ground <alerts@example.invalid>",
  };

  it("returns every value when complete", () => {
    const config = openSignupConfig(backend, env);
    expect(config.appOrigin).toBe(PORTAL_ORIGIN);
    expect(config.keys).not.toBeNull();
  });

  it.each(["INVITATION_APP_ORIGIN", "OPEN_SIGNUP_SECRET", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "NOTIFY_FROM_ADDRESS"])(
    "is null without %s", (name) => {
      expect(openSignupConfig(backend, { ...env, [name]: "" })).toBeNull();
    },
  );

  it("is null for a short secret, a missing backend or a malformed origin", () => {
    expect(openSignupConfig(backend, { ...env, OPEN_SIGNUP_SECRET: "short" })).toBeNull();
    expect(openSignupConfig({}, env)).toBeNull();
    expect(openSignupConfig(backend, { ...env, INVITATION_APP_ORIGIN: `${PORTAL_ORIGIN}/path` })).toBeNull();
    expect(openSignupConfig(backend, { ...env, INVITATION_APP_ORIGIN: "not a url" })).toBeNull();
  });

  it.each([
    "http://unionground.net", SAMPLE_ORIGIN, "https://feature.vercel.app",
    "https://example.invalid", `${PORTAL_ORIGIN}:8443`, "https://user:pass@unionground.net",
  ])("refuses to send confirmation links to %s", (origin) => {
    expect(openSignupConfig(backend, { ...env, INVITATION_APP_ORIGIN: origin })).toBeNull();
  });

  // This edition's SaaS hosts are exactly the configured portals: no www variant.
  it("accepts the configured SaaS origin only and refuses plaintext backend credentials", () => {
    expect(openSignupConfig(backend, { ...env, INVITATION_APP_ORIGIN: PORTAL_ORIGIN })).not.toBeNull();
    expect(openSignupConfig(backend, { ...env, INVITATION_APP_ORIGIN: `https://www.${PORTAL_HOST}` })).toBeNull();
    expect(openSignupConfig({ ...backend, url: "http://project.supabase.co" }, env)).toBeNull();
    expect(openSignupConfig({ ...backend, url: pinnedSampleSupabaseOrigin() }, env)).toBeNull();
    expect(openSignupConfig({ ...backend, url: `${backend.url}/path` }, env)).toBeNull();
    expect(openSignupConfig({ url: backend.url }, env)).toBeNull();
  });

  it("parses only JSON objects", () => {
    expect(parseBody({ a: 1 })).toEqual({ a: 1 });
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseBody("[1]")).toBeNull();
    expect(parseBody("{")).toBeNull();
    expect(parseBody([1])).toBeNull();
  });
});
