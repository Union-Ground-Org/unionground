// A literal tail hiding behind a legitimate alias pair. `A || B || "literal"`
// parses as `(A || B) || "literal"`, so the ban has to walk the left spine.
export const serviceKey = process.env.SUPABASE_SECRET_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || "placeholder-service-value";
