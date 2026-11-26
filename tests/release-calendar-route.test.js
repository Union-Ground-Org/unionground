// @vitest-environment node
//
// REQ-UG-RELEASE-CALENDAR-SCREEN-RELEASE-AND-HOLD-CHANGE-BOTH-DATABASES-20261117 (#9077).
//
// POST /api/release-calendar: Release and Hold from the release calendar
// screen change Production, as the stepped-up operator, then SAMPLE, with one
// release time, and read both back. Production and SAMPLE are faked at the
// fetch boundary, so the route's real auth, RPC and header code runs. Every
// test also checks that Production's service key never leaves the route and
// that the SAMPLE follow function is never called on Production.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { instant, parseChange, sameInstant } from "../api/release-calendar.js";
import { PORTAL_HOST, SAMPLE_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

vi.mock("../src/lib/sampleBackend.js", async (original) => {
  const actual = await original();
  const sampleOrigin = "https://lanesamplefixture.supabase.co";
  return {
    ...actual,
    pinnedSampleSupabaseOrigin: () => sampleOrigin,
    isForbiddenSampleBackend: (origin) => origin !== sampleOrigin,
  };
});

const PRODUCTION = SUPABASE_ORIGIN;
const SAMPLE = "https://lanesamplefixture.supabase.co";
const PRODUCTION_PUBLISHABLE = "sb_publishable_production_fixture";
const PRODUCTION_SERVICE = "sb_secret_production_fixture_never_sent";
const SAMPLE_SERVICE = "sb_secret_sample_fixture";
const OPERATOR = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const MEMBER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const KEY = "features.civic.watchlist";
const DB_NOW = "2026-11-18T22:00:00.123456+00:00";
const EARLIER = "2026-11-10T14:00:00+00:00";
const DATED = "2026-12-07T14:00:00+00:00";
const ACTOR = `Production operator ${OPERATOR}, release calendar screen`;

let sites;
let calls;
let faults;

function reset({ production = "infinity", sample = "infinity" } = {}) {
  sites = { production: new Map([[KEY, production]]), sample: new Map([[KEY, sample]]) };
  calls = [];
  faults = {};
}

const reply = (status, body) => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const held = (time) => time === "infinity" || Date.parse(time) > Date.parse(DB_NOW);

async function fakeFetch(url, init = {}) {
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), headers, body });
  const bearer = (headers.authorization ?? "").replace(/^Bearer /u, "");
  const person = { "operator-token": OPERATOR, "member-token": MEMBER }[bearer];
  const path = String(url);

  if (path === `${PRODUCTION}/auth/v1/user`) return person ? reply(200, { id: person }) : reply(401, { message: "invalid" });
  if (path.startsWith(`${PRODUCTION}/rest/v1/rpc/`)) {
    const name = path.slice(`${PRODUCTION}/rest/v1/rpc/`.length);
    if (person !== OPERATOR) return reply(403, { code: "42501", message: "platform operator required" });
    if (name === "get_platform_setting_release_calendar") {
      if (faults.productionReadBack && calls.filter((call) => call.url === path).length > 1) return reply(503, { message: "down" });
      return reply(200, {
        now: DB_NOW,
        switches: [...sites.production].filter(([, time]) => time !== null).map(([key, time]) => ({ key, label: key, releaseAt: time, held: held(time) })),
        changes: [],
      });
    }
    if (name === "set_platform_setting_release") {
      if (faults.productionWrite) return reply(503, { message: "down" });
      expect(body.p_actor).toBeNull();
      const previous = sites.production.get(body.p_key);
      sites.production.set(body.p_key, body.p_release_at);
      return reply(200, { key: body.p_key, previousReleaseAt: previous, releaseAt: body.p_release_at, held: held(body.p_release_at), updated: previous !== body.p_release_at });
    }
    return reply(404, { code: "PGRST202", message: "Could not find the function" });
  }
  if (path === `${SAMPLE}/rest/v1/rpc/get_platform_setting_release_for_follow`) {
    if (headers.apikey !== SAMPLE_SERVICE) return reply(401, { message: "no" });
    if (faults.sampleRead) return reply(503, { message: "down" });
    return reply(200, { key: body.p_key, releaseAt: sites.sample.get(body.p_key) ?? null, now: DB_NOW });
  }
  if (path === `${SAMPLE}/rest/v1/rpc/follow_platform_setting_release`) {
    if (headers.apikey !== SAMPLE_SERVICE) return reply(401, { message: "no" });
    if (faults.sampleWrite) return reply(503, { message: "down" });
    if (faults.sampleRace) return reply(409, { code: "PT409", message: "the release time changed since it was read" });
    const previous = sites.sample.get(body.p_key);
    if (previous === body.p_release_at) return reply(200, { key: body.p_key, updated: false });
    if (!sameInstant(previous, body.p_expected)) return reply(409, { code: "PT409", message: "changed" });
    sites.sample.set(body.p_key, body.p_release_at);
    return reply(200, { key: body.p_key, previousReleaseAt: previous, releaseAt: body.p_release_at, updated: true });
  }
  throw new Error(`unexpected fetch ${path}`);
}

function response() {
  return {
    statusCode: 0,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() { return this; },
    end(value) { this.payload = value ? JSON.parse(value) : null; },
  };
}

function request(body, { token = "operator-token", host = PORTAL_HOST, origin = `https://${host}`, method = "POST" } = {}) {
  return {
    method,
    body,
    headers: { host, origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  };
}

async function press(body, options) {
  const res = response();
  await handler(request(body, options), res);
  return res;
}

const urls = () => calls.map((call) => call.url.replace(PRODUCTION, "P").replace(SAMPLE, "S").replace(/\?.*$/u, "?"));

beforeEach(() => {
  reset();
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VITE_APP_SURFACE", "saas");
  vi.stubEnv("VITE_SUPABASE_URL", PRODUCTION);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", PRODUCTION_PUBLISHABLE);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", PRODUCTION_SERVICE);
  vi.stubEnv("SAMPLE_SUPABASE_URL", SAMPLE);
  vi.stubEnv("SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_sample_fixture");
  vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", SAMPLE_SERVICE);
});

afterEach(() => {
  // Production's service key is never sent, and SAMPLE's follow function is
  // never called on Production.
  for (const call of calls) expect(JSON.stringify(call.headers)).not.toContain(PRODUCTION_SERVICE);
  expect(calls.filter((call) => /follow_platform_setting_release|platform_setting_release_for_follow/u.test(call.url)).every((call) => call.url.startsWith(SAMPLE))).toBe(true);
  expect(calls.some((call) => call.url.startsWith(PRODUCTION) && /follow/u.test(call.url))).toBe(false);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("release calendar route: release and hold", () => {
  it("releases on Production as the operator, then SAMPLE with the same time, and reads both back", async () => {
    const res = await press({ key: KEY, action: "release", reason: "Civic watchlist week" });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      key: KEY, action: "release",
      production: { before: "infinity", after: DB_NOW, changed: true },
      sample: { before: "infinity", after: DB_NOW, changed: true, error: null },
      differs: false,
    });
    expect(urls()).toEqual([
      "P/auth/v1/user",
      "P/rest/v1/rpc/get_platform_setting_release_calendar",
      "S/rest/v1/rpc/get_platform_setting_release_for_follow",
      "P/rest/v1/rpc/set_platform_setting_release",
      "S/rest/v1/rpc/follow_platform_setting_release",
      "P/rest/v1/rpc/get_platform_setting_release_calendar",
      "S/rest/v1/rpc/get_platform_setting_release_for_follow",
    ]);
    const [, read, , set, follow] = calls;
    expect(read.headers.authorization).toBe("Bearer operator-token");
    expect(read.headers.apikey).toBe(PRODUCTION_PUBLISHABLE);
    expect(set.headers.authorization).toBe("Bearer operator-token");
    expect(set.body).toEqual({ p_key: KEY, p_release_at: DB_NOW, p_reason: "Civic watchlist week", p_actor: null });
    expect(follow.headers.apikey).toBe(SAMPLE_SERVICE);
    expect(follow.body).toEqual({ p_key: KEY, p_release_at: DB_NOW, p_expected: "infinity", p_reason: "Civic watchlist week", p_actor: ACTOR });
  });

  it("holds both sites with no date", async () => {
    reset({ production: EARLIER, sample: EARLIER });
    const res = await press({ key: KEY, action: "hold", reason: "Pulled back a week" });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      production: { before: EARLIER, after: "infinity", changed: true },
      sample: { before: EARLIER, after: "infinity", changed: true, error: null },
      differs: false,
    });
    expect(calls.find((call) => call.url.endsWith("/set_platform_setting_release")).body.p_release_at).toBe("infinity");
    expect(calls.find((call) => call.url.endsWith("/follow_platform_setting_release")).body).toMatchObject({ p_release_at: "infinity", p_expected: EARLIER });
  });

  it("holds a dated switch and writes nothing when both sites already show the target", async () => {
    reset({ production: DATED, sample: DATED });
    expect((await press({ key: KEY, action: "hold", reason: "No date yet" })).payload.differs).toBe(false);
    calls = [];
    const again = await press({ key: KEY, action: "hold", reason: "No date yet" });
    expect(again.payload).toMatchObject({ production: { changed: false }, sample: { changed: false, error: null }, differs: false });
    expect(urls().some((url) => url.includes("set_platform_setting_release") || url.includes("follow_platform"))).toBe(false);
  });
});

describe("release calendar route: refused callers", () => {
  it("refuses anyone who is not a stepped-up platform operator on Production, and never reaches SAMPLE", async () => {
    const res = await press({ key: KEY, action: "release", reason: "proof" }, { token: "member-token" });
    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({ error: "not-permitted" });
    expect(calls.some((call) => call.url.startsWith(SAMPLE))).toBe(false);
    expect(sites.production.get(KEY)).toBe("infinity");
  });

  it("refuses a missing or rejected token, the SAMPLE host, another origin and another method before any database call", async () => {
    expect((await press({ key: KEY, action: "release", reason: "proof" }, { token: null })).statusCode).toBe(401);
    expect(calls).toEqual([]);
    const rejected = await press({ key: KEY, action: "release", reason: "proof" }, { token: "stolen-token" });
    expect(rejected.statusCode).toBe(401);
    expect(urls()).toEqual(["P/auth/v1/user"]);
    calls = [];
    const demoBrowser = await press({ key: KEY, action: "release", reason: "proof" }, { host: SAMPLE_HOST });
    expect(demoBrowser.statusCode).toBe(403);
    expect(demoBrowser.payload).toEqual({ error: "untrusted-origin" });
    const demo = await press({ key: KEY, action: "release", reason: "proof" }, { host: SAMPLE_HOST, origin: "" });
    expect(demo.statusCode).toBe(404);
    expect(demo.payload).toEqual({ error: "not-available" });
    expect((await press({ key: KEY, action: "release", reason: "proof" }, { origin: "https://elsewhere.example" })).statusCode).toBe(403);
    expect((await press({ key: KEY, action: "release", reason: "proof" }, { method: "GET" })).statusCode).toBe(405);
    expect(calls).toEqual([]);
  });

  it("takes no site and no time from the client, and needs a key, an action and a reason", async () => {
    for (const body of [
      { key: KEY, action: "release", reason: "proof", site: "sample" },
      { key: KEY, action: "hold", reason: "proof", releaseAt: "2027-01-01T14:00:00Z" },
      { key: KEY, action: "set", reason: "proof" },
      { key: "limits.casework.deadline_red_days", action: "release", reason: "proof" },
      { key: KEY, action: "release", reason: "   " },
      { key: KEY, action: "release", reason: "a\nb" },
      { key: KEY, action: "release", reason: "x".repeat(501) },
      [KEY],
      "not json",
    ]) {
      const res = await press(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toEqual([]);
    expect(parseChange(JSON.stringify({ key: KEY, action: "hold", reason: " Held " }))).toEqual({ key: KEY, action: "hold", reason: "Held" });
  });
});

describe("release calendar route: SAMPLE not configured", () => {
  it("answers plainly and touches no database when SAMPLE has no usable backend", async () => {
    for (const env of [
      { SAMPLE_SUPABASE_URL: "", VITE_SAMPLE_SUPABASE_URL: "" },
      { SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "" },
      { SAMPLE_SUPABASE_URL: "https://someother.supabase.co" },
      { SAMPLE_SUPABASE_SERVICE_ROLE_KEY: PRODUCTION_SERVICE },
      { SAMPLE_SUPABASE_SERVICE_ROLE_KEY: PRODUCTION_PUBLISHABLE },
    ]) {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const res = await press({ key: KEY, action: "release", reason: "proof" });
      expect(res.statusCode, JSON.stringify(env)).toBe(503);
      expect(res.payload).toEqual({ error: "sample-not-configured" });
      vi.stubEnv("SAMPLE_SUPABASE_URL", SAMPLE);
      vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", SAMPLE_SERVICE);
    }
    // The headers of these refused presses never carried a key at all.
    expect(calls).toEqual([]);
    expect(sites.production.get(KEY)).toBe("infinity");
  });

  it("writes nothing when SAMPLE cannot be read before the change", async () => {
    faults.sampleRead = true;
    const res = await press({ key: KEY, action: "release", reason: "proof" });
    expect(res.statusCode).toBe(503);
    expect(res.payload).toEqual({ error: "sample-unavailable" });
    expect(sites.production.get(KEY)).toBe("infinity");
    expect(urls().some((url) => url.includes("set_platform_setting_release"))).toBe(false);
  });
});

describe("release calendar route: a partial failure and the second press", () => {
  it("reports Production changed and SAMPLE not, and a second press only copies Production's time to SAMPLE", async () => {
    faults.sampleWrite = true;
    const first = await press({ key: KEY, action: "release", reason: "Release day" });
    expect(first.statusCode).toBe(200);
    expect(first.payload).toEqual({
      key: KEY, action: "release",
      production: { before: "infinity", after: DB_NOW, changed: true },
      sample: { before: "infinity", after: "infinity", changed: false, error: "unavailable" },
      differs: true,
    });

    faults.sampleWrite = false;
    calls = [];
    const second = await press({ key: KEY, action: "release", reason: "Release day" });
    expect(second.payload).toEqual({
      key: KEY, action: "release",
      production: { before: DB_NOW, after: DB_NOW, changed: false },
      sample: { before: "infinity", after: DB_NOW, changed: true, error: null },
      differs: false,
    });
    // Production is not written again, so no new release time is made.
    expect(urls().some((url) => url.endsWith("/set_platform_setting_release"))).toBe(false);
    expect(calls.find((call) => call.url.endsWith("/follow_platform_setting_release")).body).toMatchObject({ p_release_at: DB_NOW, p_expected: "infinity" });
  });

  it("reports a SAMPLE change made since the read, and a Production read-back it could not make, as differing", async () => {
    reset({ production: EARLIER, sample: EARLIER });
    faults.sampleRace = true;
    const racedRelease = await press({ key: KEY, action: "hold", reason: "proof" });
    expect(racedRelease.payload).toMatchObject({ production: { after: "infinity" }, sample: { after: EARLIER, error: "changed" }, differs: true });

    reset();
    faults.productionReadBack = true;
    const unread = await press({ key: KEY, action: "release", reason: "proof" });
    expect(unread.payload).toMatchObject({ production: { after: null, changed: true }, sample: { after: DB_NOW }, differs: true });
  });

  it("refuses, before writing, a switch the sites already hold differently, unless only SAMPLE is behind", async () => {
    reset({ production: "infinity", sample: DATED });
    const res = await press({ key: KEY, action: "release", reason: "proof" });
    expect(res.statusCode).toBe(409);
    expect(res.payload).toEqual({ error: "sites-differ", production: "infinity", sample: DATED });
    expect(urls().some((url) => url.includes("set_platform_setting_release") || url.includes("follow_platform"))).toBe(false);

    // Production already held with no date, SAMPLE behind: Hold repairs SAMPLE only.
    calls = [];
    const repair = await press({ key: KEY, action: "hold", reason: "proof" });
    expect(repair.payload).toMatchObject({ production: { changed: false }, sample: { before: DATED, after: "infinity", changed: true }, differs: false });
  });

  it("refuses a switch never held on SAMPLE or not held on Production, and stops when Production fails", async () => {
    reset({ sample: null });
    expect((await press({ key: KEY, action: "hold", reason: "proof" })).payload).toEqual({ error: "sample-never-held" });
    expect(sites.production.get(KEY)).toBe("infinity");

    reset();
    expect((await press({ key: "features.proof.never_held", action: "hold", reason: "proof" })).payload).toEqual({ error: "never-held" });
    expect(calls.some((call) => call.url.startsWith(SAMPLE))).toBe(false);

    reset();
    faults.productionWrite = true;
    const down = await press({ key: KEY, action: "release", reason: "proof" });
    expect(down.statusCode).toBe(503);
    expect(down.payload).toEqual({ error: "production-unavailable" });
    expect(urls().some((url) => url.includes("follow_platform"))).toBe(false);
  });
});

describe("release calendar route: database times", () => {
  it("compares times to the microsecond across offsets", () => {
    expect(sameInstant("2026-11-18T22:00:00.123456+00:00", "2026-11-18 17:00:00.123456-05")).toBe(true);
    expect(sameInstant("2026-11-18T22:00:00.123456+00:00", "2026-11-18T22:00:00.123457+00:00")).toBe(false);
    expect(sameInstant("2026-11-18T22:00:00Z", "2026-11-18T22:00:00.000+00:00")).toBe(true);
    expect(sameInstant("infinity", "infinity")).toBe(true);
    expect(sameInstant("infinity", null)).toBe(false);
    expect(sameInstant(null, null)).toBe(true);
    expect(sameInstant("not a time", "not a time")).toBe(false);
    expect(instant("2026-11-18T22:00:00+05:30")).toBe(BigInt(Date.parse("2026-11-18T16:30:00Z")) * 1000n);
  });
});
