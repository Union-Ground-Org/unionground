// Typed signatures (#8701): a member who cannot draw signs by typing their
// full name and ticking the consent box. The server's
// private.normalize_form_typed_signature decides; this mirror only lets the
// form say what is wrong before the member presses Save.

const TYPED_SIGNATURE_MIN = 2;
export const TYPED_SIGNATURE_MAX = 120;

// Control, invisible and direction-changing characters: the same set the
// server refuses.
const HIDDEN = /[\p{Cc}\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
const LETTER = /\p{L}/u;

export function normalizeTypedSignature(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

// "" when the name can be signed, otherwise "hidden", "length" or "letter".
export function typedSignatureProblem(value) {
  const raw = String(value ?? "");
  if (HIDDEN.test(raw)) return "hidden";
  const name = normalizeTypedSignature(raw);
  const length = [...name].length;
  if (length < TYPED_SIGNATURE_MIN || length > TYPED_SIGNATURE_MAX) return "length";
  if (!LETTER.test(name)) return "letter";
  return "";
}

// A signature value is a strokes array (drawn, the shape every caller used
// before #8701) or { kind: "drawn", strokes } or { kind: "typed", name }.
export function signatureIsReady(signature) {
  if (Array.isArray(signature)) return signature.length > 0;
  if (signature?.kind === "typed") return typedSignatureProblem(signature.name) === "";
  return Array.isArray(signature?.strokes) && signature.strokes.length > 0;
}

// The RPC arguments for one signature. A drawn signature sends only p_strokes,
// exactly as before; a typed one sends p_strokes null and the typed name.
export function signatureRpcArgs(signature) {
  if (signature && !Array.isArray(signature) && signature.kind === "typed") {
    return { p_strokes: null, p_typed_name: normalizeTypedSignature(signature.name) };
  }
  return { p_strokes: Array.isArray(signature) ? signature : signature?.strokes ?? null };
}
