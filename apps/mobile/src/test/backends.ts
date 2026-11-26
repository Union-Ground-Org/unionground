// Fictional backend/portal pairs for tests only. Neither exists; `.example`
// hosts are reserved (RFC 2606) and never resolve.
export type TestBackendPair = { readonly supabaseUrl: string; readonly portal: string };

export const TEST_BACKENDS: Readonly<Record<'sample' | 'live', TestBackendPair>> = {
  sample: { supabaseUrl: 'https://unionground-sample.supabase.co', portal: 'https://sample.unionground.example' },
  live: { supabaseUrl: 'https://unionground-live.supabase.co', portal: 'https://app.unionground.example' },
};
