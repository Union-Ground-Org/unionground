import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, supabaseRpc } from "./_lib/http.js";

// REQ-UG-PUBLIC-PAGE-SECTION-SWITCHES-AND-SIGN-IN-DESIGNS-2-TO-4-20261117
// (#9038): which public-page sections are released. Signed-out pages read this
// before drawing a section that is held for a later release (sign-in designs 2
// to 4, the 3D map on Find your union). The answer names only released
// sections, and only the ones this build knows; a held section is never named.
// Every answer that is not a fresh read (a missing backend, a failed read)
// names none, so a held section can never show by mistake. Publishable key
// only: no account, no organization and no service role.
export const PUBLIC_SECTIONS = Object.freeze(["sign_in_design_2", "sign_in_design_3", "sign_in_design_4", "unions_map_3d"]);

const NONE = Object.freeze({ released: [] });

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Vary", "Host");
  if (methodGuard(request, ["GET"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const backend = resolveSupabaseBackend(request);
  if (!backend.url || !backend.publishableKey) return json(response, 503, NONE);
  try {
    const state = await supabaseRpc(backend.url, backend.publishableKey, backend.publishableKey, "get_public_section_release_state");
    const named = Array.isArray(state?.released) ? state.released : [];
    return json(response, 200, { released: PUBLIC_SECTIONS.filter((section) => named.includes(section)) });
  } catch {
    return json(response, 503, NONE);
  }
}
