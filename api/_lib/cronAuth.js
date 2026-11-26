// The one authorization rule for every scheduled (cron) route. Each route used
// to carry its own copy, and the copies drifted: some accepted any non-empty
// CRON_SECRET, so a copy of this project that kept the .env.example value let
// anyone run its purge, export and dispatch jobs.
//
// A bad configuration (missing, short or placeholder secret) answers 503 with a
// message for the operator; a caller without the exact bearer answers 401.
// The bearer is compared in constant time.
import { createHash, timingSafeEqual } from "node:crypto";
import { secretProblem, secretProblemMessage } from "./secretStrength.js";

function headerValue(request, name) {
  const headers = request?.headers;
  if (typeof headers?.get === "function") return String(headers.get(name) || "");
  const direct = headers?.[name] ?? headers?.[name.toLowerCase()];
  return String(Array.isArray(direct) ? direct[0] || "" : direct || "");
}

// True when the request carries Vercel's scheduler marker. The marker alone
// is client-suppliable and never authorizes anything. Vercel's scheduler does
// not send it, so no scheduled route asks for it; the option below stays for
// a route that is only ever called by a sender that does.
export function hasVercelCronHeader(request) {
  return headerValue(request, "x-vercel-cron") === "1";
}

export function cronBearer(request) {
  const match = /^bearer\s+(.+)$/i.exec(headerValue(request, "authorization"));
  return match ? match[1].trim() : "";
}

// Both sides are hashed first so the compare always runs over two 32-byte
// buffers and never leaks the secret's length.
export function constantTimeEqual(a, b) {
  const left = createHash("sha256").update(String(a ?? "")).digest();
  const right = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(left, right);
}

export function cronSecretUsable(env = process.env, secretName = "CRON_SECRET") {
  return secretProblem(env?.[secretName]) === "";
}

// { ok: true } or { ok: false, status, error, message? }.
// Options:
//   env: where to read the secret (default process.env)
//   secretName: which variable holds it (default CRON_SECRET)
//   requireVercelCronHeader: also demand `x-vercel-cron: 1`. Vercel's
//     scheduler sends only the CRON_SECRET bearer (with the vercel-cron user
//     agent) and no such marker, so no scheduled route passes this.
export function cronAuthorization(request, options = {}) {
  const env = options.env || process.env;
  const secretName = options.secretName || "CRON_SECRET";
  const secret = env?.[secretName];
  const problem = secretProblem(secret);
  if (problem) {
    return {
      ok: false,
      status: 503,
      error: "cron_secret_not_configured",
      message: secretProblemMessage(secretName, problem),
    };
  }
  if (options.requireVercelCronHeader && !hasVercelCronHeader(request)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  const supplied = cronBearer(request);
  if (!supplied || !constantTimeEqual(supplied, secret)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

// The response body for a refusal, in the route's own shape. `base` carries the
// fields a route always sends (for example `{ ok: false }`). The 401 body says
// nothing beyond "unauthorized"; the 503 body tells the operator what to fix.
export function cronRefusalBody(decision, base = {}) {
  if (decision.status === 503) {
    return { ...base, error: decision.error, message: decision.message };
  }
  return { ...base, error: decision.error };
}
