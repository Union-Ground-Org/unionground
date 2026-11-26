// Release and Hold from the release calendar screen, on Production and the
// SAMPLE tour together
// (REQ-UG-RELEASE-CALENDAR-SCREEN-RELEASE-AND-HOLD-CHANGE-BOTH-DATABASES-20261117, #9077).
//
// POST { key, action: "release" | "hold", reason } from the site's own origin only.
// The client names no site and no time: Hold is infinity, and Release is
// Production's database clock, or Production's stored time when Production is
// already released and SAMPLE is behind (a second press after a partial
// failure). The rules are in docs/contracts/staged-feature-releases.md.
//
// 1. Production, as the operator: the screen's own read,
//    public.get_platform_setting_release_calendar, with the operator's token.
//    The database decides who may press (a platform operator in a stepped-up
//    session, private.platform_setting_release_caller); anyone else is 403 and
//    nothing is read from or written to SAMPLE.
// 2. SAMPLE's row, read with SAMPLE's service key
//    (public.get_platform_setting_release_for_follow). Both sites must agree before
//    a change, as scripts/release-calendar.mjs requires, unless Production
//    already shows the target and only SAMPLE is behind.
// 3. Production is written with the operator's token
//    (public.set_platform_setting_release). Production's service key is never
//    used by this route.
// 4. SAMPLE follows with SAMPLE's service key
//    (public.follow_platform_setting_release): Production's stored time, only
//    while SAMPLE still holds the time read in step 2.
// 5. Both sites are read back. A SAMPLE failure after Production changed is
//    answered 200 with `differs: true` and the SAMPLE error, so the screen can
//    say so and name the sync step.
//
// With no usable SAMPLE backend the route answers 503 sample-not-configured
// before reading or writing anything anywhere.
import { timingSafeEqual } from "node:crypto";
import { isSaasHost } from "../src/lib/demoOrigin.js";
import { pinnedSampleSupabaseOrigin } from "../src/lib/sampleBackend.js";
import { productionBackendFromEnv, sampleBackendFromEnv } from "./_lib/backend.js";
import {
  authenticateCaller,
  bearerToken,
  json,
  methodGuard,
  requestHostname,
  supabaseRpc,
  validateMutationOrigin,
} from "./_lib/http.js";

export const RELEASE_CALENDAR_ACTIONS = Object.freeze(["release", "hold"]);
const FIELDS = new Set(["key", "action", "reason"]);
const KEY = /^features\.[a-z0-9_]+(?:\.[a-z0-9_]+)+$/u;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const REASON_MAX = 500;
export const READ_RPC = "get_platform_setting_release_calendar";
export const SET_RPC = "set_platform_setting_release";
export const FOLLOW_RPC = "follow_platform_setting_release";
export const FOLLOW_READ_RPC = "get_platform_setting_release_for_follow";

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function bodyOf(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { // swallow-ok: an unreadable body is an invalid request, answered 400 by the caller
    return null;
  }
}

// The request, or null. Only key, action and reason: a site or a time from
// the client is refused, never ignored.
export function parseChange(value) {
  const body = bodyOf(value);
  if (!body || Object.keys(body).some((field) => !FIELDS.has(field))) return null;
  const { key, action } = body;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (typeof key !== "string" || !KEY.test(key)) return null;
  if (!RELEASE_CALENDAR_ACTIONS.includes(action)) return null;
  if (!reason || reason.length > REASON_MAX || /\p{Cc}/u.test(reason)) return null;
  return { key, action, reason };
}

// A database time as microseconds since the epoch, "infinity", or null.
// PostgREST and jsonb both write timestamptz as ISO text with up to six
// fractional digits and an offset; Date.parse would drop the microseconds.
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/u;
export function instant(value) {
  if (value === null || value === undefined) return null;
  if (value === "infinity") return "infinity";
  const match = INSTANT.exec(String(value));
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0));
  }
  const millis = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - offsetMinutes * 60_000;
  return BigInt(millis) * 1000n + BigInt(fraction.padEnd(6, "0"));
}

export function sameInstant(left, right) {
  const a = instant(left);
  const b = instant(right);
  return a !== undefined && b !== undefined && a === b;
}

// SAMPLE is usable only when it is the pinned SAMPLE project with its own
// service key, shared with nothing of Production's.
export function usableSample(sample, production) {
  const pinned = pinnedSampleSupabaseOrigin().replace(/\/$/, "");
  if (!sample.url || !sample.serviceRoleKey || sample.url !== pinned) return false;
  if (production.url && production.url === sample.url) return false;
  return ![production.publishableKey, production.serviceRoleKey, sample.publishableKey]
    .filter(Boolean)
    .some((credential) => safeEqual(sample.serviceRoleKey, credential));
}

function databaseError(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || "");
  if (code === "42501" || status === 403) return "refused";
  if (status === 401) return "unauthenticated";
  if (code === "55000") return "never-held";
  if (code === "PT409" || status === 409) return "changed";
  if (code === "PGRST202" || code === "42883") return "control-missing";
  if (code === "22023") return "invalid";
  return "unavailable";
}

async function productionRow(production, token, key) {
  const calendar = await supabaseRpc(production.url, production.publishableKey, token, READ_RPC);
  if (!calendar || typeof calendar.now !== "string" || !Array.isArray(calendar.switches)) {
    throw Object.assign(new Error("calendar-shape"), { status: 502 });
  }
  return { now: calendar.now, row: calendar.switches.find((entry) => entry?.key === key) ?? null };
}

// SAMPLE's release time for one key: a time, "infinity", or null (never held
// there, or no such switch).
async function sampleReleaseAt(sample, key) {
  const state = await supabaseRpc(sample.url, sample.serviceRoleKey, sample.serviceRoleKey, FOLLOW_READ_RPC, { p_key: key });
  if (!state || typeof state !== "object" || state.key !== key) throw Object.assign(new Error("sample-read-shape"), { status: 502 });
  return typeof state.releaseAt === "string" ? state.releaseAt : null;
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  // Production goes first and the operator's session is a Production session,
  // so the SAMPLE host (and every preview) never drives this route.
  if (!isSaasHost(requestHostname(request))) return json(response, 404, { error: "not-available" });

  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "unauthenticated" });
  const change = parseChange(request.body);
  if (!change) return json(response, 400, { error: "invalid-request" });

  const production = productionBackendFromEnv();
  if (!production.url || !production.publishableKey) return json(response, 503, { error: "not-configured" });
  const sample = sampleBackendFromEnv();
  if (!usableSample(sample, production)) return json(response, 503, { error: "sample-not-configured" });

  const caller = await authenticateCaller(production.url, production.publishableKey, token);
  if (caller.outcome === "unavailable") return json(response, 503, { error: "production-unavailable" });
  const userId = typeof caller.user?.id === "string" ? caller.user.id.trim() : "";
  if (!USER_ID.test(userId)) return json(response, 401, { error: "unauthenticated" });

  // 1. The operator check, on Production, by the database.
  let before;
  try {
    before = await productionRow(production, token, change.key);
  } catch (error) {
    const kind = databaseError(error);
    if (kind === "refused") return json(response, 403, { error: "not-permitted" });
    if (kind === "unauthenticated") return json(response, 401, { error: "unauthenticated" });
    return json(response, 503, { error: "production-unavailable" });
  }
  if (!before.row) return json(response, 409, { error: "never-held" });

  // 2. SAMPLE's row, read only after Production accepted the operator.
  let sampleBefore;
  try {
    sampleBefore = await sampleReleaseAt(sample, change.key);
  } catch {
    return json(response, 503, { error: "sample-unavailable" });
  }
  if (sampleBefore === null) return json(response, 409, { error: "sample-never-held" });

  const productionAtTarget = change.action === "hold"
    ? before.row.releaseAt === "infinity"
    : before.row.held === false;
  if (!productionAtTarget && !sameInstant(before.row.releaseAt, sampleBefore)) {
    return json(response, 409, { error: "sites-differ", production: before.row.releaseAt, sample: sampleBefore });
  }

  // 3. Production, as the operator.
  let productionTime = before.row.releaseAt;
  let productionChanged = false;
  if (!productionAtTarget) {
    const target = change.action === "hold" ? "infinity" : before.now;
    try {
      const result = await supabaseRpc(production.url, production.publishableKey, token, SET_RPC, {
        p_key: change.key, p_release_at: target, p_reason: change.reason, p_actor: null,
      });
      productionTime = typeof result?.releaseAt === "string" ? result.releaseAt : target;
      productionChanged = result?.updated === true;
    } catch (error) {
      const kind = databaseError(error);
      if (kind === "refused") return json(response, 403, { error: "not-permitted" });
      if (kind === "never-held") return json(response, 409, { error: "never-held" });
      // The statement may have committed: the screen reads both sites again.
      return json(response, 503, { error: "production-unavailable" });
    }
  }

  // 4. SAMPLE follows Production's stored time.
  let sampleChanged = false;
  let sampleError = null;
  if (!sameInstant(productionTime, sampleBefore)) {
    try {
      const result = await supabaseRpc(sample.url, sample.serviceRoleKey, sample.serviceRoleKey, FOLLOW_RPC, {
        p_key: change.key,
        p_release_at: productionTime,
        p_expected: sampleBefore,
        p_reason: change.reason,
        p_actor: `Production operator ${userId}, release calendar screen`,
      });
      sampleChanged = result?.updated === true;
    } catch (error) {
      sampleError = databaseError(error);
    }
  }

  // 5. Both sites read back.
  const productionAfter = await productionRow(production, token, change.key)
    .then((read) => read.row?.releaseAt ?? null, () => null); // swallow-ok: an unread site answers null and differs: true
  const sampleAfter = await sampleReleaseAt(sample, change.key).catch(() => null); // swallow-ok: an unread site answers null and differs: true
  const differs = productionAfter === null || sampleAfter === null || !sameInstant(productionAfter, sampleAfter);

  return json(response, 200, {
    key: change.key,
    action: change.action,
    production: { before: before.row.releaseAt, after: productionAfter, changed: productionChanged },
    sample: { before: sampleBefore, after: sampleAfter, changed: sampleChanged, error: sampleError },
    differs,
  });
}
