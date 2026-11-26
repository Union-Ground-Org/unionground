// Explicit fail-closed validation. The value is never printed.
export function requireWebhookSecret(environment = process.env) {
  const value = environment.INTEGRATION_WEBHOOK_SECRET;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("INTEGRATION_WEBHOOK_SECRET must be configured");
  }
  return value.trim();
}
