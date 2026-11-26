// Batch 00 helper: a pinned SAMPLE project distinct from the fictional trusted
// pair in fictional-provider.js. Union Ground pins no SAMPLE Supabase project
// (src/lib/sampleBackend.js SAMPLE_BACKEND.sampleSupabaseRef is empty), so the
// shipped module refuses every SAMPLE target. Suites that must tell a SAMPLE
// backend from a production one substitute this module with vi.mock; shipped
// code never sees it. The module keeps the shipped fail-closed rule: exactly the
// pinned project is accepted and every other target, including the fictional
// production project, is refused.
//
//   vi.mock("../src/lib/sampleBackend.js", async (importOriginal) =>
//     (await import("./helpers/b00-pinned-sample-backend.js")).pinnedSampleBackendModule(await importOriginal()));
export const SAMPLE_REF = "psgfictionalsample";
export const SAMPLE_SUPABASE_ORIGIN = `https://${SAMPLE_REF}.supabase.co`;

export function pinnedSampleBackendModule(actual) {
  const SAMPLE_BACKEND = Object.freeze({
    ...actual.SAMPLE_BACKEND,
    sampleSupabaseOrigin: SAMPLE_SUPABASE_ORIGIN,
    sampleSupabaseRef: SAMPLE_REF,
  });
  return {
    ...actual,
    SAMPLE_BACKEND,
    sampleBackendContract: () => SAMPLE_BACKEND,
    pinnedSampleSupabaseOrigin: () => SAMPLE_SUPABASE_ORIGIN,
    isForbiddenSampleBackend(originOrRef) {
      const value = String(originOrRef || "").trim().toLowerCase();
      if (!value) return false;
      if (value === SAMPLE_REF) return false;
      return actual.supabaseRefFromOrigin(value) !== SAMPLE_REF;
    },
  };
}
