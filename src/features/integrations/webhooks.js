export const WEBHOOK_EVENTS = Object.freeze([
  "member.invited",
  "member.profile_updated",
  "case.opened",
  "case.updated",
  "broadcast.published",
  "event.checkin",
  "appointment.scheduled",
]);

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "metadata.google.com",
  "kubernetes.default.svc",
]);

const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home", ".corp", ".invalid"];

export function parseWebhookEvents(raw) {
  const tokens = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\s]+/))
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return { ok: false, reason: "events_required" };
  const invalid = tokens.filter((token) => !WEBHOOK_EVENTS.includes(token));
  if (invalid.length > 0) return { ok: false, reason: "unknown_events", invalid };
  return { ok: true, events: [...new Set(tokens)] };
}

export function classifyWebhookUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "https:") return { ok: false, reason: "https_required" };
  if (parsed.username || parsed.password) return { ok: false, reason: "credentials_forbidden" };
  if (parsed.port && parsed.port !== "443") return { ok: false, reason: "port_forbidden" };

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!hostname) return { ok: false, reason: "host_required" };
  if (hostname.includes("%")) return { ok: false, reason: "encoded_host_forbidden" };
  if (BLOCKED_HOSTS.has(hostname)) return { ok: false, reason: "blocked_host" };
  if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return { ok: false, reason: "blocked_suffix" };

  const ipClass = classifyLiteralIp(hostname);
  if (ipClass === "blocked") return { ok: false, reason: "private_or_metadata_ip" };
  if (ipClass === "invalid") return { ok: false, reason: "invalid_ip" };

  parsed.hostname = hostname;

  return {
    ok: true,
    href: `${parsed.origin}${parsed.pathname}${parsed.search}`,
    hostname,
    path: `${parsed.pathname}${parsed.search}`,
  };
}

export function isSafeWebhookUrl(rawUrl) {
  return classifyWebhookUrl(rawUrl).ok;
}

function classifyLiteralIp(hostname) {
  if (hostname.includes(":")) return classifyIpv6(hostname);
  if (/^\d+$/.test(hostname)) return "blocked";
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return "name";

  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return "invalid";
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return "blocked";
  if (a === 169 && b === 254) return "blocked";
  if (a === 172 && b >= 16 && b <= 31) return "blocked";
  if (a === 192 && b === 168) return "blocked";
  if (a === 192 && b === 0) return "blocked";
  if (a === 100 && b >= 64 && b <= 127) return "blocked";
  if (a === 198 && (b === 18 || b === 19)) return "blocked";
  if (a === 198 && b === 51) return "blocked";
  if (a === 203 && b === 0) return "blocked";
  if (a >= 224) return "blocked";
  return "public";
}

function classifyIpv6(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return "blocked";
  if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return "blocked";
  if (normalized.startsWith("::ffff:")) {
    return classifyLiteralIp(normalized.slice("::ffff:".length)) === "public" ? "public" : "blocked";
  }
  if (normalized.startsWith("2001:db8:")) return "blocked";
  if (normalized.startsWith("2001:0000:") || normalized.startsWith("2001:0:")) return "blocked";
  if (normalized.startsWith("2002:")) return "blocked";
  return /^[23][0-9a-f]{0,3}:/.test(normalized) ? "public" : "blocked";
}

export function pinWebhookDestination(hostname, resolvedAddresses = []) {
  const literalClass = classifyLiteralIp(hostname);
  if (literalClass === "public") {
    return { ok: true, address: hostname, addresses: [hostname] };
  }
  if (literalClass !== "name") return { ok: false, reason: "private_or_metadata_ip" };

  const addresses = [...new Set((Array.isArray(resolvedAddresses) ? resolvedAddresses : [])
    .map((entry) => typeof entry === "string" ? entry : entry?.address)
    .filter((entry) => typeof entry === "string" && entry.length > 0))];
  if (addresses.length === 0) return { ok: false, reason: "destination_resolution_required" };
  if (addresses.some((address) => classifyLiteralIp(address.replace(/^\[|\]$/g, "")) !== "public")) {
    return { ok: false, reason: "unsafe_destination_resolution" };
  }
  return { ok: true, address: addresses[0], addresses };
}

export function buildWebhookDeliveryPlan({ webhook, eventName, occurredAt, idempotencyKey }) {
  const url = classifyWebhookUrl(webhook.url);
  if (!url.ok) return { ok: false, reason: url.reason };
  if (!webhook.active) return { ok: false, reason: "webhook_inactive" };
  if (!webhook.events.includes(eventName)) return { ok: false, reason: "event_not_subscribed" };

  return {
    ok: true,
    plan: {
      webhookId: webhook.id,
      organizationId: webhook.organizationId,
      eventName,
      destinationHost: url.hostname,
      occurredAt,
      idempotencyKey,
      followRedirects: false,
      maxAttempts: 5,
    },
  };
}

export function nextWebhookBackoffMs(attempt) {
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}
