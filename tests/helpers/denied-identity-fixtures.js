// Fictional stand-ins for the sibling product's identifiers. The real ones are
// listed only as digests (config/sample-backend.json, scripts/db-contract.json;
// scripts/lib/denied-identity.mjs); these fixtures are on the same lists, so a
// test proves each refusal with them instead of naming a real project, host or
// account. The two refs match the placeholders the migrations use.
export const DENIED_PRODUCTION_REF = "productionprojectref";
export const DENIED_SAMPLE_REF = "sampledemoprojectref";
export const DENIED_SUPABASE_REFS = Object.freeze([DENIED_PRODUCTION_REF, DENIED_SAMPLE_REF]);
export const DENIED_APP_HOST = "sibling-product.example";
export const DENIED_SAAS_HOST = "sibling-saas.example";
export const DENIED_APP_HOSTS = Object.freeze([DENIED_APP_HOST, DENIED_SAAS_HOST]);
export const DENIED_IDENTITY_TOKEN = "denied-fixture-token";

export const deniedSupabaseOrigin = (ref = DENIED_PRODUCTION_REF) => `https://${ref}.supabase.co`;
