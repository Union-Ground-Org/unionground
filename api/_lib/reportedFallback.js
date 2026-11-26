// A server step that may fall back reports the failure first
// (SYS-UG-SHARED-SWALLOWED-ERROR-GUARD-20261113). The report is the
// content-free one every API failure sends (captureServerFailure): no request,
// member, tenant or error text leaves the function, only that it happened.
import { captureServerFailure } from "./observability.js";

function reportCaughtFailure() {
  captureServerFailure(500);
}

// fallback is a value, or a function of the caught error for a fallback that
// depends on it. A failing report never changes the answer.
export async function withReportedFallback(run, fallback, { report = reportCaughtFailure } = {}) {
  try {
    return await run();
  } catch (error) {
    try { report(); } catch { /* swallow-ok: monitoring must not change the answer */ }
    return typeof fallback === "function" ? fallback(error) : fallback;
  }
}
