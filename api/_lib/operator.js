// "Who runs this server". Anyone may run a copy of Union Ground, so every
// server says who operates it and how to reach them: OPERATOR_NAME and
// OPERATOR_CONTACT_EMAIL (required on a deployed server), OPERATOR_URL and
// OPERATOR_JURISDICTION (optional). The browser gets them through
// /api/runtime-config and shows them on the public /operator page.
//
// A deployed server (any Vercel or Lambda signal, api/_lib/providerBoundary.js)
// refuses to serve sign-in until the two required settings are set: the
// runtime config answers not configured, the same way it refuses a project
// with public sign-up on (api/_lib/signupPosture.js). Local development and
// tests are not refused.
import { localDevelopmentSeamOpen } from "./providerBoundary.js";

export const OPERATOR_UNSET_MESSAGE = "This server does not say who runs it. Set OPERATOR_NAME (the person or organization "
  + "that runs this server) and OPERATOR_CONTACT_EMAIL (where people can reach them); OPERATOR_URL and "
  + "OPERATOR_JURISDICTION are optional. Sign-in stays off until both are set.";

const EMAIL_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
// Printable text only: no control or bidirectional-override characters.
const UNSAFE_TEXT = /[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function text(value, max) {
  const normalized = String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > max || UNSAFE_TEXT.test(normalized)) return null;
  return normalized;
}

function httpsUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

// The public disclosure, or null while the required settings are missing or
// unusable. Optional settings that are malformed are left out.
export function operatorDisclosure(env = process.env) {
  const name = text(env?.OPERATOR_NAME, 120);
  const email = text(env?.OPERATOR_CONTACT_EMAIL, 254);
  if (!name || !email || !EMAIL_PATTERN.test(email)) return null;
  const url = httpsUrl(env?.OPERATOR_URL);
  const jurisdiction = text(env?.OPERATOR_JURISDICTION, 120);
  return {
    name,
    contactEmail: email,
    ...(url ? { url } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
  };
}

// { ok: true } or { ok: false, reason: "operator-unset", message }.
export function operatorPosture(env = process.env) {
  if (operatorDisclosure(env) || localDevelopmentSeamOpen(env)) return { ok: true };
  return { ok: false, reason: "operator-unset", message: OPERATOR_UNSET_MESSAGE };
}

// The runtime config a browser receives, with the operator disclosure added.
// A deployed server without its operator settings answers not configured.
export function withOperator(config, env = process.env) {
  const operator = operatorDisclosure(env);
  if (!config?.configured || operatorPosture(env).ok) return { ...config, operator };
  console.error(`[operator] operator-unset: ${OPERATOR_UNSET_MESSAGE}`);
  return { schema: config.schema, surface: config.surface, configured: false, refused: "operator-unset", operator };
}
