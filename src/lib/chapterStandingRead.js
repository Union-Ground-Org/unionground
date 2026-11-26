export const CHAPTER_STANDING_RETRY_DELAY_MS = 150;

const TRANSIENT_CODES = new Set([
  "PGRST003", // PostgREST pool acquisition timeout.
  "57014", // PostgreSQL statement cancellation/timeout.
  "57P01", // PostgreSQL admin shutdown.
  "57P02", // PostgreSQL crash shutdown.
  "57P03", // PostgreSQL cannot connect now.
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
]);

function waitMs(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function failedResult(error) {
  return {
    data: null,
    error: error && typeof error === "object" ? error : { message: String(error) },
    status: Number(error?.status) || 0,
  };
}

async function readOnce(client, retry) {
  try {
    return await (retry ? retry() : client.rpc("get_chapter_standing"));
  } catch (error) {
    // This RPC is additive. A transport rejection must degrade like the
    // PostgREST-shaped failures returned by supabase-js, not reject the entire
    // member bootstrap Promise.all batch.
    return failedResult(error);
  }
}

export function shouldRetryChapterStanding(result) {
  if (!result?.error) return false;
  const status = Number(result.status ?? result.error?.status);
  if (status === 429 || status >= 500) return true;
  const code = String(result.error?.code || "").toUpperCase();
  if (TRANSIENT_CODES.has(code)) return true;
  const message = String(result.error?.message || "");
  return /(?:upstream|gateway).*(?:timeout|unavailable|error)|temporar(?:y|ily) unavailable|connection (?:reset|terminated)|failed to fetch|networkerror(?: when attempting to fetch resource)?|load failed/i.test(message);
}

export async function loadChapterStandingWithRetry(client, { wait = waitMs } = {}) {
  const first = await readOnce(client);
  if (!shouldRetryChapterStanding(first)) return first;

  // Exactly one delayed retry absorbs a short PostgREST/Supavisor burst. It is
  // deliberately neither a loop nor a general RPC retry policy: authorization
  // and validation failures remain final, and a sustained outage still
  // degrades this optional tile after a bounded 150 ms pause.
  await wait(CHAPTER_STANDING_RETRY_DELAY_MS);
  // A session registry caches settled failures. Its scoped retry bypasses that
  // one failed request while enforcing the same single-retry budget across
  // projections; direct clients continue to issue the RPC normally.
  return readOnce(client, typeof first.retry === "function" ? () => first.retry() : undefined);
}
