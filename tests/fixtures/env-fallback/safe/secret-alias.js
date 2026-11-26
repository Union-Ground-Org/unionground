// A rename in flight: both names hold the same secret, so an absent pair still
// fails closed.
export const serviceKey = process.env.SUPABASE_SECRET_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY;
