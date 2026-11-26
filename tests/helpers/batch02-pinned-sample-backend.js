// Union Ground pins no SAMPLE Supabase project yet (src/lib/sampleBackend.js
// SAMPLE_BACKEND.sampleSupabaseRef is empty), so the shipped module refuses
// every SAMPLE target. A suite that exercises what a SAMPLE-backed handler does
// once a project is pinned substitutes this module for it with vi.mock; shipped
// code never sees it. The pin is the fictional project in fictional-provider.js,
// and the module keeps the shipped fail-closed rule: exactly the pinned project
// is accepted and every other target is refused.
//
//   vi.mock("../src/lib/sampleBackend.js", async (importOriginal) =>
//     (await import("./helpers/batch02-pinned-sample-backend.js")).pinnedSampleBackendModule(await importOriginal()));
import { SUPABASE_ORIGIN, SUPABASE_REF } from "./fictional-provider.js";

export function pinnedSampleBackendModule(actual) {
  const SAMPLE_BACKEND = Object.freeze({
    ...actual.SAMPLE_BACKEND,
    sampleSupabaseOrigin: SUPABASE_ORIGIN,
    sampleSupabaseRef: SUPABASE_REF,
  });
  return {
    ...actual,
    SAMPLE_BACKEND,
    sampleBackendContract: () => SAMPLE_BACKEND,
    pinnedSampleSupabaseOrigin: () => SUPABASE_ORIGIN,
    isForbiddenSampleBackend(originOrRef) {
      const value = String(originOrRef || "").trim().toLowerCase();
      if (!value) return false;
      if (value === SUPABASE_REF) return false;
      return actual.supabaseRefFromOrigin(value) !== SUPABASE_REF;
    },
  };
}
