import { productionBackendFromEnv, sampleBackendFromEnv } from "./_lib/backend.js";
import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import { json, methodGuard, supabaseRpc } from "./_lib/http.js";

// The §6.4 database-currency canary.
//
// docs/security/private-upload-activation-plan.md §6.4 and
// docs/security/private-upload-inspection.md §8 both name the quiet failure of
// this design: `clean_until = least(now() + 24h, signature_updated_at + 48h)`.
// When signature refresh stops, or a clock drifts, or the arithmetic is wrong,
// the scanner stays up and answers every probe while clean verdicts expire one
// at a time and downloads start failing for files that worked yesterday — with
// no scanner error anywhere.
//
// The scanner host's own watchdog cannot see that, because it is the scanner's
// clock that is being trusted. This tick asks the database instead: does the
// clean ledger row closest to expiry still satisfy
// `private.private_upload_is_current`, and does the database's clock agree with
// this function's clock? A disagreement in either is a decided fault and
// answers 500; an inability to ask answers 503.
//
// Vercel Cron pages nobody on a 500, so a status code alone was never an
// alert. Only a 200 tick pings the Better Stack heartbeat in
// PRIVATE_UPLOAD_CURRENCY_HEARTBEAT_URL; a missed ping is what pages.
//
// Read-only: the RPC is `stable`, service-only, and returns a bucket id, three
// timestamps and two counts — never an object name, file id or path.
const RPC_TIMEOUT_MS = 10_000;
// The 48-hour freshness rule and `clean_until` are both wall-clock arithmetic,
// so a minute of disagreement between the API region and the database is
// already worth a page. The scanner host's watchdog applies the same bound to
// the scanner's own clock.
export const MAX_CLOCK_SKEW_MS = 60_000;

const HEARTBEAT_TIMEOUT_MS = 5_000;
// Better Stack's heartbeat URL shapes. The token is a bearer of sorts: it is
// never logged or answered, and any other URL is refused rather than fetched.
const HEARTBEAT_URL = /^https:\/\/(?:uptime|incidents)\.betterstack\.com\/api\/v1\/heartbeat\/[A-Za-z0-9]{8,128}$/;

// Diagnostics carry the outcome class only. Nothing here may name an object.
function noteOutcome(outcome) {
  console.error("[private-upload-currency-canary]", { outcome });
}

/** Pings the heartbeat after a passing tick. Unset is a no-op so a deploy
 * ahead of the console step still runs; a failed ping never changes the tick's
 * answer, because the missed ping is itself the alert. */
export async function pingCurrencyHeartbeat(env = process.env) {
  const url = String(env.PRIVATE_UPLOAD_CURRENCY_HEARTBEAT_URL || "").trim();
  if (!url) return "not_configured";
  if (!HEARTBEAT_URL.test(url)) {
    noteOutcome("heartbeat_url_refused");
    return "refused";
  }
  try {
    const answer = await fetch(url, { method: "GET", signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    if (answer.ok) return "sent";
  } catch {
    // The kind of failure is not worth a log line that could carry the URL.
  }
  noteOutcome("heartbeat_failed");
  return "failed";
}

/** Decides the tick from the RPC answer alone, so the whole rule is testable
 * without a database. Returns the exact body this endpoint answers with. */
export function assessCurrencyCanary(result, nowMs, { maxSkewMs = MAX_CLOCK_SKEW_MS } = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { status: 503, body: { ok: false, error: "currency_canary_unreadable" } };
  }
  const databaseNow = Date.parse(String(result.now || ""));
  if (!Number.isFinite(databaseNow) || !Number.isFinite(nowMs)) {
    return { status: 503, body: { ok: false, error: "currency_canary_unreadable" } };
  }
  const skewMs = Math.abs(databaseNow - nowMs);
  const liveCleanObjects = result.liveCleanObjects;
  const expiredCleanObjects = result.expiredCleanObjects;
  if (typeof result.checked !== "boolean"
      || !Number.isSafeInteger(liveCleanObjects) || liveCleanObjects < 0
      || !Number.isSafeInteger(expiredCleanObjects) || expiredCleanObjects < 0
      || (result.checked ? liveCleanObjects < 1 : liveCleanObjects !== 0)) {
    return { status: 503, body: { ok: false, error: "currency_canary_unreadable" } };
  }
  const observed = {
    checked: result.checked === true,
    skewMs,
    liveCleanObjects,
    expiredCleanObjects,
  };
  // Clock disagreement is checked first and independently of the predicate: a
  // drifted clock can make the predicate answer correctly today and wrongly
  // tomorrow, so it must alert while everything still looks healthy.
  if (skewMs > maxSkewMs) {
    return { status: 500, body: { ok: false, error: "currency_canary_clock_skew", ...observed } };
  }
  // An empty or deleted ledger is unavailable coverage, never a manufactured
  // pass; this read-only endpoint never creates a person or object.
  if (!observed.checked && expiredCleanObjects === 0) {
    return { status: 503, body: { ok: false, ...observed, error: "currency_canary_no_witness" } };
  }
  // Every clean verdict has expired: the ledger is idle, not faulty. A verdict
  // lives at most 24 hours by design and is renewed only when someone opens the
  // file and the app re-inspects it (private-upload-inspection.md §5, §9), so a
  // quiet database reaches this state a day after its last file was opened.
  // Answering 500 here kept Production red from Nov 4, 2026 onward and made the
  // tick useless as a page. The clock check above still ran; the predicate
  // check resumes with the next inspection. Signatures that stop refreshing are
  // paged by the scanner host's own sig-fresh checks (ops/scanner/README.md).
  if (!observed.checked) {
    return { status: 200, body: { ok: true, ...observed, coverage: "idle" } };
  }
  // The row says it is current by its own `clean_until`; the predicate says it
  // is not. That disagreement is the join, arithmetic or clock fault this
  // canary exists to catch, and it has no other witness.
  if (result.current !== true) {
    return { status: 500, body: { ok: false, error: "private_upload_not_current", ...observed } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      ...observed,
      bucketId: String(result.bucketId || ""),
      cleanUntil: String(result.cleanUntil || ""),
      signatureUpdatedAt: String(result.signatureUpdatedAt || ""),
    },
  };
}

export default async function handler(request, response) {
  if (methodGuard(request, ["GET"], () => json(response, 405, { ok: false, error: "method_not_allowed" }))) return;
  // Fail closed: the configured CRON_SECRET presented as the bearer, the one
  // rule in api/_lib/cronAuth.js. A demo-host request cannot force production keys.
  const cron = cronAuthorization(request);
  if (!cron.ok) return json(response, cron.status, cronRefusalBody(cron, { ok: false }));
  // An authenticated Vercel cron deliberately resolves to SaaS in ordinary
  // host routing. Explicitly ask BOTH credential families here; the request
  // host cannot choose the target, and SAMPLE still enforces its project pin.
  const surfaces = {};
  let status = 200;
  for (const backend of [productionBackendFromEnv(), sampleBackendFromEnv()]) {
    let assessment;
    if (!backend.url || !backend.serviceRoleKey) {
      assessment = { status: 503, body: { ok: false, error: "not_configured" } };
    } else {
      try {
        const result = await supabaseRpc(
          backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
          "private_upload_currency_canary", {}, { timeoutMs: RPC_TIMEOUT_MS },
        );
        assessment = assessCurrencyCanary(result, Date.now());
      } catch {
        assessment = { status: 503, body: { ok: false, error: "currency_canary_unavailable" } };
      }
    }
    surfaces[backend.surface] = assessment.body;
    if (!assessment.body.ok) noteOutcome(assessment.body.error);
    // A decided fault stays visible even if the other backend is unavailable.
    if (assessment.status === 500 || (assessment.status === 503 && status === 200)) status = assessment.status;
  }
  if (status === 200) await pingCurrencyHeartbeat();
  return json(response, status, { ok: status === 200, surfaces });
}
