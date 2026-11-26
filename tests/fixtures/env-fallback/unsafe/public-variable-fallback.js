// A build-time public variable can never stand in for a service-role key.
export const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
