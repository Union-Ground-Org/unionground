// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { bearerToken, validateMutationOrigin } from "../api/_lib/http.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

function request({
  host = PORTAL_HOST,
  origin,
  authorization = "Bearer member-session-token",
  cookie,
  referer,
  secFetchSite,
} = {}) {
  return {
    method: "POST",
    headers: {
      host,
      authorization,
      ...(origin === undefined ? {} : { origin }),
      ...(cookie === undefined ? {} : { cookie }),
      ...(referer === undefined ? {} : { referer }),
      ...(secFetchSite === undefined ? {} : { "sec-fetch-site": secFetchSite }),
    },
  };
}

describe("browser mutation Origin validation at the bearer-session boundary", () => {
  it.each(["Bearer", "bearer", "BEARER", "bEaReR"])("matches only the scheme case and preserves credential bytes (%s)", (scheme) => {
    const credential = "AbC.xY_z-09+=/";
    const authorization = `${scheme} ${credential}`;
    expect(bearerToken(request({ authorization }))).toBe(credential);
    expect(bearerToken(request({ authorization, origin: "https://app.unionground.test" }))).toBe(credential);
    expect(bearerToken({ method: "GET", headers: new Headers({ authorization }) })).toBe(credential);
    expect(bearerToken(request({ authorization, secFetchSite: "same-origin" }))).toBe("");
    expect(bearerToken(request({ authorization, origin: "https://attacker.invalid" }))).toBe("");
  });

  it.each([
    "https://attacker.example",
    `https://${PORTAL_HOST}.attacker.example`,
    `http://${PORTAL_HOST}`,
    `https://${PORTAL_HOST}:444`,
    `https://${PORTAL_HOST}:443`,
    `HTTPS://${PORTAL_HOST}`,
    `https://${PORTAL_HOST}/extra`,
    "null",
    "not-a-url",
  ])("rejects the token for the untrusted Origin %s", (origin) => {
    expect(bearerToken(request({ origin }))).toBe("");
  });

  it("accepts only the exact trusted portal origin, never the SAMPLE host or a cross-host origin", () => {
    expect(bearerToken(request({ origin: PORTAL_ORIGIN }))).toBe("member-session-token");
    expect(bearerToken(request({ host: SAMPLE_HOST, origin: SAMPLE_ORIGIN }))).toBe("");
    expect(bearerToken(request({ host: SAMPLE_HOST, origin: PORTAL_ORIGIN }))).toBe("");
    expect(bearerToken(request({ host: PORTAL_HOST, origin: SAMPLE_ORIGIN }))).toBe("");
  });

  it("rejects a non-canonical port even when Host and Origin repeat it", () => {
    expect(validateMutationOrigin(request({
      host: `${PORTAL_HOST}:444`,
      origin: `https://${PORTAL_HOST}:444`,
    }))).toBe(false);
  });

  it("rejects missing Origin when browser metadata or cookies identify a browser request", () => {
    expect(bearerToken(request({ secFetchSite: "same-origin" }))).toBe("");
    expect(bearerToken(request({ cookie: "session=browser-cookie" }))).toBe("");
    expect(bearerToken(request({ referer: `https://${PORTAL_HOST}/m` }))).toBe("");
    expect(bearerToken({
      ...request(),
      headers: { ...request().headers, "sec-fetch-mode": "cors" },
    })).toBe("");
    expect(bearerToken({
      ...request(),
      headers: { ...request().headers, "sec-fetch-dest": "empty" },
    })).toBe("");
  });

  it("preserves the documented no-Origin transport for a bearer-only native or machine client", () => {
    expect(bearerToken(request())).toBe("member-session-token");
  });

  it("does not trust any Vercel deployment origin, even one the deployment environment names", () => {
    // Union Ground trusts only the portals paired in trustedBackends.js, so a
    // preview deployment is refused however its own URL is announced.
    const preview = "unionground-git-csrf-example.vercel.app";
    for (const env of [
      { NODE_ENV: "production", VERCEL_URL: preview },
      { NODE_ENV: "production", VERCEL_BRANCH_URL: `https://${preview}/` },
      { NODE_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: preview },
    ]) {
      expect(validateMutationOrigin(request({ host: preview, origin: `https://${preview}` }), env), JSON.stringify(env)).toBe(false);
      expect(validateMutationOrigin(request({ host: "other.vercel.app", origin: "https://other.vercel.app" }), env), JSON.stringify(env)).toBe(false);
    }
  });

  it("accepts an exact loopback origin only outside production", () => {
    const local = request({ host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173" });
    expect(validateMutationOrigin(local, { NODE_ENV: "development" })).toBe(true);
    expect(validateMutationOrigin(local, { NODE_ENV: "production" })).toBe(false);
    expect(validateMutationOrigin(local, {})).toBe(true);
  });

  it("supports Fetch Headers and Node array headers without weakening exact matching", () => {
    expect(bearerToken({
      method: "PATCH",
      headers: new Headers({
        host: PORTAL_HOST,
        origin: `https://${PORTAL_HOST}`,
        authorization: "Bearer headers-session-token",
      }),
    })).toBe("headers-session-token");
    expect(bearerToken({
      method: "DELETE",
      headers: {
        host: [PORTAL_HOST],
        origin: [`https://${PORTAL_HOST}`],
        authorization: ["Bearer array-session-token"],
      },
    })).toBe("array-session-token");
    expect(bearerToken({ method: "POST", headers: new Headers() })).toBe("");
    expect(bearerToken({ method: "POST", headers: { authorization: [] } })).toBe("");
  });

  it("fails closed for an unparseable request host and leaves reads unchanged", () => {
    expect(validateMutationOrigin(request({
      host: "%%%",
      origin: `https://${PORTAL_HOST}`,
    }))).toBe(false);
    expect(validateMutationOrigin({ headers: {} })).toBe(true);
  });

  it("does not let a forwarded host override the canonical request host", () => {
    const forwardedSpoof = request({ host: PORTAL_HOST, origin: `https://${SAMPLE_HOST}` });
    forwardedSpoof.headers["x-forwarded-host"] = SAMPLE_HOST;
    expect(validateMutationOrigin(forwardedSpoof)).toBe(false);
  });

  it("uses the deployment-owned forwarded host only when Host is unavailable", () => {
    const forwardedOnly = request({ origin: `https://${PORTAL_HOST}` });
    delete forwardedOnly.headers.host;
    forwardedOnly.headers["x-forwarded-host"] = PORTAL_HOST;
    expect(validateMutationOrigin(forwardedOnly)).toBe(true);
  });
});
