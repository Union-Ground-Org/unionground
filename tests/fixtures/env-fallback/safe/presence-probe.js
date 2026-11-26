// A multi-field configuration probe uses a Boolean aggregation, never a secret fallback.
export const configured = {
  apns: [process.env.APNS_TEAM_ID, process.env.APNS_KEY_ID,
    process.env.APNS_PRIVATE_KEY, process.env.APNS_BUNDLE_ID].some(Boolean),
};
export function ready() {
  if (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) return true;
  return false;
}
