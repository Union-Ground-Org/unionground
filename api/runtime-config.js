import { runtimeConfigForRequest, serializeRuntimeConfig } from "./_lib/runtimeConfig.js";
import { signupPosture } from "./_lib/signupPosture.js";
import { withOperator } from "./_lib/operator.js";

// A configured browser is also refused while the Supabase project lets anyone
// sign up (api/_lib/signupPosture.js), so a copy that left public sign-up on
// shows its not-configured state instead of running invitation-only flows on
// a project that does not enforce them. Every answer says who runs this
// server, and a deployed server that does not say is refused too
// (api/_lib/operator.js).
async function servedConfig(request) {
  const config = withOperator(runtimeConfigForRequest(request));
  if (!config.configured) return config;
  const posture = await signupPosture({ url: config.supabaseUrl, publishableKey: config.supabasePublishableKey });
  if (posture.ok) return config;
  return { schema: config.schema, surface: config.surface, configured: false, refused: posture.reason, operator: config.operator };
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Content-Type", "application/javascript; charset=utf-8");
  response.setHeader("Vary", "Host");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    response.status(405);
    response.end();
    return;
  }

  const body = serializeRuntimeConfig(await servedConfig(request));
  response.status(200);
  response.end(request.method === "HEAD" ? undefined : body);
}
