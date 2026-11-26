import { isOfflineError } from "../../lib/outbox.js";
import { rpcRefusalKey } from "../../lib/rpcErrorText.js";

export function messageActionFailureKey(error, fallbackKey) {
  if (String(error?.code) !== "42501") {
    return rpcRefusalKey(error, isOfflineError(error, null) ? "offline.unconfirmed" : fallbackKey);
  }

  const prefix = error.label ? `${error.label}: ` : "";
  const rawMessage = typeof error.message === "string" ? error.message : "";
  const message = prefix && rawMessage.startsWith(prefix) ? rawMessage.slice(prefix.length) : rawMessage;

  // The SQLSTATE also covers session, preservation and other refusals.
  // Name a cause only for an exact message this UI understands.
  switch (message) {
    case "authentication required": return "rpcError.authenticationRequired";
    case "step-up required": return "stepUp.notice";
    case "not permitted": return "rpcError.notPermitted";
    default: return fallbackKey;
  }
}
