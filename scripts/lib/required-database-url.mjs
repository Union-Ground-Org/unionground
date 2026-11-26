// Fail-closed accessor for a credential-bearing database URL.
//
// A local proof script must never carry a committed connection string. The
// documented loopback default looked harmless, but it silently selected a
// long-lived shared stack whenever the operator forgot to export the variable,
// which is exactly the misconfiguration SEC-UG-SECRET-FALLBACK-BAN exists
// to surface. Requiring the variable turns that into an immediate, explicit
// error instead.
//
// Nothing here prints the value.

/**
 * Read a required database URL from the environment.
 *
 * `aliases` accepts the other names the same value has been published under, in
 * priority order. Falling from one alias to the next is not a default: every
 * name in the list holds the same credential, so an unset set still fails.
 *
 * @param {string} variableName exact primary environment variable name
 * @param {{ env?: Record<string, string | undefined>, aliases?: readonly string[] }} [options]
 * @returns {string} the raw URL
 * @throws {Error} when no listed variable holds a value
 */
export function requireDatabaseUrl(variableName, { env = process.env, aliases = [] } = {}) {
  if (typeof variableName !== "string" || variableName.length === 0) {
    throw new Error("requireDatabaseUrl needs an exact environment variable name");
  }
  const names = [variableName, ...aliases];
  for (const name of names) {
    const raw = env[name];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  throw new Error(
    `${names.join(" or ")} must be set to a disposable loopback database URL; `
      + "this proof has no default target and will not guess one",
  );
}
