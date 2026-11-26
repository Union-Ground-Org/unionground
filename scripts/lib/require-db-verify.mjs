// One reading of REQUIRE_DB_VERIFY for every live-database verifier.
//
// The flag turns "SUPABASE_DB_URL is missing, so SKIP and exit 0" into a hard
// failure on the CI lanes that are SUPPOSED to hold the secret, so a silently
// empty secret reads as red instead of green. It existed in two shapes: some
// scripts armed on any non-empty value except "0"/"false", others only on
// exactly "1"/"true". Under the narrow reading REQUIRE_DB_VERIFY=yes silently
// disarmed the guard and the lane skipped while looking like a pass — the flag
// that guards against misconfiguration failing open on a misconfiguration.
//
// The broad reading wins because it is the one verify-db-contract.mjs
// documents as the contract, and because failing closed is the whole point:
// only an explicit, unambiguous off value disarms it.

/**
 * Decide whether a missing database URL must fail the run.
 *
 * @param {Record<string, string | undefined>} [env] environment to read
 * @returns {boolean} true when the verifier must fail instead of skipping
 */
export function requireDbVerify(env = process.env) {
  const raw = (env.REQUIRE_DB_VERIFY ?? "").trim().toLowerCase();
  return raw !== "" && raw !== "0" && raw !== "false";
}
