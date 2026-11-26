import { createHmac } from "node:crypto";
import { requestNetworkBucket } from "./networkAddress.js";

function publicInterestNetworkScope(request, key, purpose) {
  const network = requestNetworkBucket(request);
  if (!network) return null;
  return createHmac("sha256", key)
    .update(`${purpose}:${network}`)
    .digest("hex");
}

export function publicInterestScope(request, key) {
  return publicInterestNetworkScope(request, key, "public-interest-submit-v2");
}

export function publicInterestStopScope(request, key) {
  return publicInterestNetworkScope(request, key, "public-interest-stop-v1");
}

export function publicInterestEmailScope(email, interest, key) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedInterest = String(interest || "");
  return createHmac("sha256", key)
    .update(`public-interest-email-v1:${normalizedEmail}\u001f${normalizedInterest}`)
    .digest("hex");
}

export function publicInterestStopEmailScope(email, key) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  return createHmac("sha256", key)
    .update(`public-interest-stop-email-v1:${normalizedEmail}`)
    .digest("hex");
}
