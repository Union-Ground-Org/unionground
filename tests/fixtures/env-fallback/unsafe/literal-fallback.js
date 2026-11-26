// A committed literal standing in for a missing webhook secret.
export function signingSecret() {
  return process.env.INTEGRATION_WEBHOOK_SECRET || "placeholder-not-a-real-secret";
}
