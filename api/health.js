import { json, methodGuard } from "./_lib/http.js";

// Public liveness only. GET and HEAD are intentionally unauthenticated and
// read no member, organization, database, dependency, environment, build, or
// credential state. Do not add detail here: /build-info.json owns deployment
// identity and authenticated service probes own dependency health.
export default function handler(request, response) {
  if (methodGuard(request, ["GET", "HEAD"], () => json(response, 405, { ok: false }))) return;

  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
  response.status(200);
  response.end(request.method === "HEAD" ? undefined : JSON.stringify({ ok: true, service: "union-base" }));
}
