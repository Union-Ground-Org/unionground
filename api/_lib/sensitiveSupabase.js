import { createClient } from "@supabase/supabase-js";
import { supabaseHeaders } from "./http.js";

// The SDK adds bearer credentials after global headers. Normalize at the final
// fetch boundary so RPC, table and Storage requests all obey the server contract.
export function createSensitiveServiceClient(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: sensitiveSupabaseFetch(key) },
  });
}

export function sensitiveSupabaseFetch(key, token = key, fetcher = globalThis.fetch) {
  return (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.delete("authorization");
      headers.delete("apikey");
      for (const [name, value] of Object.entries(supabaseHeaders(key, token))) headers.set(name, value);
      return fetcher(input, { ...init, headers });
  };
}
