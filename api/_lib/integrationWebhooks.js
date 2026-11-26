import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const DELIVERY_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 3_000;

async function resolveWithDeadline(resolver, hostname) {
  let timer;
  try {
    return await Promise.race([
      resolver(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("dns timeout")), DNS_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function publicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

function publicIpv6(address) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return publicIpv4(normalized.slice(7));
  // IPv4 may be concealed inside transition formats. 6to4 embeds it after
  // 2002::/16 and Teredo after 2001:0000::/32, so neither is a safe public
  // destination even when the outer IPv6 address looks globally routable.
  if (normalized.startsWith("2002:") || /^2001:0{0,4}:/.test(normalized)) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  return /^[23][0-9a-f]{0,3}:/.test(normalized);
}

export function isPublicIntegrationAddress(address) {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family === 6) return publicIpv6(address);
  return false;
}

export async function resolvePinnedIntegrationDestination(rawUrl, resolver = lookup) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    return { ok: false, reason: "invalid_url" };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname.includes("%")) return { ok: false, reason: "invalid_url" };
  let addresses;
  if (isIP(hostname)) {
    addresses = [{ address: hostname }];
  } else {
    try {
      addresses = await resolveWithDeadline(resolver, hostname);
    } catch {
      return { ok: false, reason: "destination_resolution_failed" };
    }
  }
  const unique = [...new Set((addresses || []).map((entry) => entry?.address).filter(Boolean))];
  if (unique.length === 0) return { ok: false, reason: "destination_resolution_failed" };
  if (unique.some((address) => !isPublicIntegrationAddress(address))) {
    return { ok: false, reason: "unsafe_destination_resolution" };
  }
  return {
    ok: true,
    hostname,
    address: unique[0],
    approvedAddresses: unique,
    path: `${parsed.pathname}${parsed.search}`,
  };
}

function sendPinned({ destination, payload, signature, timestamp, deliveryId, requester = httpsRequest }) {
  return new Promise((resolve) => {
    let settled = false;
    let deadline;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(outcome);
    };
    const request = requester({
      protocol: "https:",
      hostname: destination.address,
      port: 443,
      servername: destination.hostname,
      path: destination.path,
      method: "POST",
      headers: {
        Host: isIP(destination.hostname) === 6 ? `[${destination.hostname}]` : destination.hostname,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "X-Union-Ground-Signature": `t=${timestamp},v1=${signature}`,
        "X-Union-Ground-Timestamp": timestamp,
        "X-Union-Ground-Delivery": String(deliveryId),
      },
    }, (response) => {
      if (typeof response.destroy === "function") response.destroy();
      else response.resume();
      finish(response.statusCode >= 200 && response.statusCode < 300
        ? { ok: true }
        : { ok: false, reason: "destination_rejected" });
    });
    deadline = setTimeout(() => request.destroy(new Error("timeout")), DELIVERY_TIMEOUT_MS);
    request.on("error", () => finish({ ok: false, reason: "transport_error" }));
    request.end(payload);
  });
}

export async function deliverClaimedIntegrationWebhook(claim, dependencies = {}) {
  const destination = await resolvePinnedIntegrationDestination(claim?.url, dependencies.resolver || lookup);
  if (!destination.ok) {
    return {
      ok: false,
      terminal: destination.reason !== "destination_resolution_failed",
      reason: destination.reason,
      destinationHost: null,
    };
  }
  if (typeof claim?.secret !== "string" || !claim.secret.startsWith("whsec_")) {
    return { ok: false, terminal: true, reason: "secret_unavailable", destinationHost: destination.hostname };
  }
  const payload = JSON.stringify({
    id: claim.eventId,
    type: claim.eventName,
    occurredAt: claim.occurredAt,
    test: String(claim.eventId || "").startsWith("test:"),
  });
  const timestamp = String(Math.floor((dependencies.now?.() ?? Date.now()) / 1000));
  const signature = createHmac("sha256", claim.secret).update(`${timestamp}.${payload}`).digest("hex");
  const outcome = await sendPinned({
    destination,
    payload,
    signature,
    timestamp,
    deliveryId: claim.deliveryId,
    requester: dependencies.requester || httpsRequest,
  });
  return { ...outcome, terminal: false, destinationHost: destination.hostname };
}

export async function dispatchClaimedIntegrationWebhook(claim, recordOutcome, dependencies = {}) {
  const outcome = await deliverClaimedIntegrationWebhook(claim, dependencies);
  const status = outcome.ok ? "ok" : outcome.terminal ? "blocked" : "failed";
  const recorded = await recordOutcome({
    p_delivery_id: claim.deliveryId,
    p_attempt_count: claim.attemptCount,
    p_status: status,
    p_error_code: outcome.ok ? null : outcome.reason,
    p_destination_host: outcome.destinationHost,
  });
  if (recorded !== true) throw new Error("delivery outcome was not recorded");
  return { deliveryId: claim.deliveryId, ok: outcome.ok, status };
}
