// Who runs this server, as /api/runtime-config reports it (api/_lib/operator.js).
// null while the server has not said: the operator page then warns the
// visitor instead of naming anyone.
const UNSAFE_TEXT = /[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function field(value, max) {
  return typeof value === "string" && value.trim() && value.length <= max && !UNSAFE_TEXT.test(value) ? value.trim() : null;
}

export function runtimeOperator(config = globalThis.__UNIONGROUND_RUNTIME_CONFIG__) {
  const operator = config?.operator;
  if (!operator || typeof operator !== "object") return null;
  const name = field(operator.name, 120);
  const contactEmail = field(operator.contactEmail, 254);
  if (!name || !contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return null;
  const url = field(operator.url, 2048);
  const jurisdiction = field(operator.jurisdiction, 120);
  return {
    name,
    contactEmail,
    url: url && /^https:\/\//.test(url) ? url : null,
    jurisdiction,
  };
}
