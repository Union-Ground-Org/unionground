// The naming, preview and refusal vocabulary behind <EvidenceUpload>.
//
// Everything here is local and pure: no network, no storage, no preview
// service, and nothing is written to a log. The server's content inspection
// stays the authority on whether bytes may attach
// (docs/security/private-upload-inspection.md); the checks in this file exist
// only so a member reads one specific sentence in the browser instead of
// spending an inspection attempt to learn that a 40 MB screen recording was
// never going to be accepted.
//
// Two boundaries are copied from the server rather than invented here, and they
// must not drift:
//
//   EVIDENCE_UPLOAD_MAX_BYTES  the four private buckets' `file_size_limit`
//   EVIDENCE_UPLOAD_EXTENSIONS the extension half of the inspector's exact
//                              MIME-to-extension pairing (api/_lib/
//                              privateFileSafety.js EXTENSIONS)
//
// HEIC/HEIF are deliberately absent from that allowlist and deliberately
// present in the picker's `accept`: the buckets refuse HEIC, so an iPhone photo
// is converted to JPEG by normalizeUploadFile BEFORE it reaches these checks.
// Validating the converted file is the whole point of the ordering.
import { lookup } from "./i18n/runtime.js";

/** 10 MiB, exactly the bucket limit. */
export const EVIDENCE_UPLOAD_MAX_BYTES = 10485760;

/**
 * What the picker offers. HEIC/HEIF are included because this build converts
 * them; every other entry is something the inspector can actually accept.
 */
export const EVIDENCE_UPLOAD_ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.txt,.csv,.docx,.xlsx";

/** The post-conversion allowlist. */
export const EVIDENCE_UPLOAD_EXTENSIONS = Object.freeze([
  "pdf", "jpg", "jpeg", "png", "webp", "txt", "csv", "docx", "xlsx",
]);

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const TEXT_EXTENSIONS = new Set(["txt", "csv"]);

/**
 * How much of a text file the preview reads.
 *
 * Small on purpose. The preview is a reassurance that the right file was
 * picked, not a viewer, and the whole file is held in memory already.
 */
export const EVIDENCE_UPLOAD_TEXT_PREVIEW_BYTES = 2048;

// The stem the member edits, and the name the row can hold. 160 is the
// database ceiling (member_case_files_filename_bounded and its siblings);
// the stem is capped well below it so an extension always fits.
const MAX_STEM_LENGTH = 96;
const MAX_NAME_LENGTH = 160;
const FALLBACK_STEM = "evidence";

/**
 * Split a filename into the part a member may edit and the part they may not.
 *
 * The extension keeps its leading dot and its original case: it is compared
 * against the file's MIME by the inspector, and a file with no extension at
 * all is refused there, so an empty extension is reported honestly rather than
 * guessed at.
 */
export function splitUploadName(name) {
  const value = String(name ?? "");
  const dot = value.lastIndexOf(".");
  // A leading dot is not an extension: `.htaccess` is a stem.
  if (dot <= 0) return { stem: value, extension: "" };
  return { stem: value.slice(0, dot), extension: value.slice(dot) };
}

/** The extension, lowercased and without its dot: the allowlist's key. */
export function uploadExtensionKey(name) {
  return splitUploadName(name).extension.slice(1).toLowerCase();
}

function trimStemEdges(value) {
  // A trailing dot would make the stored name disagree with its extension, and
  // a leading one hides the file in every tool a steward opens it with.
  return value.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
}

/**
 * The stem as it will actually be delivered.
 *
 * `\p{C}` is removed rather than only C0 controls: a right-to-left override in
 * the middle of a name makes the visible text disagree with the stored bytes,
 * which is a filename that lies about its own extension to everyone who later
 * reads the case file list. Path separators and the characters a desktop
 * cannot save become spaces, so a pasted path degrades to something legible
 * instead of vanishing.
 *
 * Slicing is by code point. Cutting a UTF-16 string at 96 units can split a
 * surrogate pair and leave a lone half, which is exactly the class of
 * character the first step just removed.
 */
export function sanitizeUploadStem(stem) {
  const cleaned = trimStemEdges(
    String(stem ?? "")
      .normalize("NFC")
      .replace(/\p{C}/gu, "")
      .replace(/[/\\]/g, " ")
      .replace(/[:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return trimStemEdges([...cleaned].slice(0, MAX_STEM_LENGTH).join("")) || FALLBACK_STEM;
}

/**
 * The exact name the upload will carry.
 *
 * The extension is the prepared file's own — a converted HEIC arrives as
 * `.jpg` and stays `.jpg`, because the member renaming a photo must not be
 * able to make the name disagree with the bytes.
 */
export function uploadFinalName(file, stem) {
  const { extension } = splitUploadName(file?.name);
  const safe = sanitizeUploadStem(stem);
  const room = Math.max(1, MAX_NAME_LENGTH - extension.length);
  const bounded = trimStemEdges([...safe].slice(0, room).join("")) || FALLBACK_STEM;
  return `${bounded}${extension}`;
}

/**
 * The prepared file under the member's chosen name.
 *
 * Returns the same File when the name is already what it should be, so an
 * untouched selection is delivered as the object that was validated.
 */
export function renameUploadFile(file, stem) {
  const name = uploadFinalName(file, stem);
  if (!file || name === file.name || typeof File !== "function") return file;
  return new File([file], name, {
    type: file.type,
    lastModified: file.lastModified ?? Date.now(),
  });
}

/**
 * The client-side courtesy refusal, run on the PREPARED file.
 *
 * Returns a copy token or null. Size is checked before the extension because a
 * 40 MB PDF and a 40 MB video are the same problem and the member should read
 * the same sentence for both.
 */
export function validatePreparedUpload(file) {
  const size = Number(file?.size);
  if (!Number.isFinite(size) || size < 1) return "empty";
  if (size > EVIDENCE_UPLOAD_MAX_BYTES) return "tooLarge";
  if (!EVIDENCE_UPLOAD_EXTENSIONS.includes(uploadExtensionKey(file?.name))) {
    return "unsupportedExtension";
  }
  return null;
}

/**
 * Which preview a prepared file may have.
 *
 * Keyed on the extension, because that is the half of the pair the inspector
 * holds the file to, and a browser's MIME guess is a claim. "document" is the
 * honest answer for PDF, DOCX and XLSX: this build has no inline renderer for
 * them that is safe to point at bytes nothing has inspected yet.
 */
export function uploadPreviewKind(file) {
  const extension = uploadExtensionKey(file?.name);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return "document";
}

/**
 * The first bytes of a text file, as display text.
 *
 * Control and format characters are dropped except tab and newline: a preview
 * exists to be read, and NUL padding or a bidi override in the first line is
 * noise at best and a spoof at worst. React renders the result as a text node,
 * so nothing here can become markup.
 */
export async function readBoundedUploadText(file, limit = EVIDENCE_UPLOAD_TEXT_PREVIEW_BYTES) {
  const part = typeof file?.slice === "function" ? file.slice(0, limit) : file;
  let raw = "";
  try {
    raw = typeof part?.text === "function" ? await part.text() : "";
  } catch {
    // An unreadable local file is not an upload failure: the preview stays
    // empty and the member can still send the bytes.
  }
  // Dropping the \r of a CRLF file leaves the \n, so Windows text still reads
  // as lines rather than as one run-together paragraph.
  const text = raw.replace(/\p{C}/gu, (character) => (character === "\n" || character === "\t" ? character : ""));
  return { text, truncated: Number(file?.size) > limit };
}

const TOKEN_BY_PRIVATE_FILE_CODE = Object.freeze({
  rejected: "rejected",
  "unsupported-format": "unsupportedFormat",
  "invalid-format": "unsupportedExtension",
  "invalid-size": "invalidSize",
  "pending-check": "pendingCheck",
  "rate-limited": "rateLimited",
  stale: "stale",
  unavailable: "unavailable",
});

const TOKEN_BY_DETAILS = Object.freeze({
  private_file_rejected: "rejected",
  private_file_invalid_format: "unsupportedExtension",
  private_file_invalid_size: "invalidSize",
  private_file_pending_check: "pendingCheck",
  private_file_rate_limited: "rateLimited",
  private_file_stale: "stale",
  private_file_unavailable: "unavailable",
  private_file_unsupported_format: "unsupportedFormat",
});

/**
 * The copy token for an upload failure.
 *
 * `privateFileCode` is the machine-readable half memberApi attaches for exactly
 * this purpose; `details` is the same decision spelled as an i18n token, which
 * is what reaches a caller that re-wraps the error. Anything unrecognised —
 * a dropped connection, a host's own Error — lands on `unavailable`, the
 * retryable sentence, because an unknown failure is not evidence that these
 * bytes were refused.
 */
export function uploadErrorToken(error) {
  const code = error?.privateFileCode;
  if (typeof code === "string" && Object.hasOwn(TOKEN_BY_PRIVATE_FILE_CODE, code)) {
    return TOKEN_BY_PRIVATE_FILE_CODE[code];
  }
  // UnsupportedUploadFormatError: this browser cannot convert the photo.
  if (error?.code === "unsupported-format") return "unsupportedFormat";
  const details = error?.details;
  if (typeof details === "string" && Object.hasOwn(TOKEN_BY_DETAILS, details)) {
    return TOKEN_BY_DETAILS[details];
  }
  return "unavailable";
}

// A decision about these bytes, or about a file this browser cannot prepare.
// Repeating either spends an inspection attempt to be told the same thing, so
// the retry control is withheld until a different file is chosen.
const PERMANENT_TOKENS = new Set([
  "rejected", "unsupportedFormat", "unsupportedExtension", "tooLarge", "empty", "invalidSize",
]);

/** True when retrying the same file cannot change the answer. */
export function uploadErrorIsPermanent(token) {
  return PERMANENT_TOKENS.has(token);
}

/**
 * This component's own copy, in the two languages the app ships.
 *
 * It lives here rather than in src/lib/i18n.js so the upload panel can be
 * added to a surface without touching the shared catalogue, and it is resolved
 * by the same `lookup` the barrel's `t()` uses so interpolation and the
 * English fallback behave identically.
 */
export const EVIDENCE_UPLOAD_COPY = Object.freeze({
  en: {
    "evidenceUpload.title": "Attach a document",
    "evidenceUpload.formats": "Accepted files: PDF, JPG or JPEG, PNG, WebP, TXT, CSV, DOCX, XLSX.",
    "evidenceUpload.size": "One file at a time, up to 10 MiB (10,485,760 bytes).",
    "evidenceUpload.conversion": "iPhone HEIC and HEIF photos are converted to JPEG in this browser first. If this browser cannot convert one, save it as JPEG or PNG and choose it again.",
    "evidenceUpload.inspection": "Files must pass a safety check before they attach. A supported format can still be rejected.",
    "evidenceUpload.choose": "Choose a file",
    "evidenceUpload.replace": "Choose a different file",
    "evidenceUpload.stage.preparing": "Reading this file…",
    "evidenceUpload.stage.converting": "Converting this photo to JPEG…",
    "evidenceUpload.stage.staged": "Ready. Nothing is sent until you choose Upload.",
    "evidenceUpload.stage.uploading": "Uploading…",
    "evidenceUpload.stage.checking": "Checking this file for safety…",
    "evidenceUpload.stage.confirming": "Attaching this file…",
    "evidenceUpload.stage.done": "Attached.",
    "evidenceUpload.nameLabel": "File name",
    "evidenceUpload.nameHelp": "The {extension} extension is kept automatically.",
    "evidenceUpload.finalName": "Will be attached as",
    "evidenceUpload.upload": "Upload",
    "evidenceUpload.retry": "Try again",
    "evidenceUpload.reconcile": "Check upload status",
    "evidenceUpload.error.reconcile": "The previous upload still needs confirmation. Check its status to finish the same upload. Clearing this selection does not cancel that upload.",
    "evidenceUpload.cancel": "Cancel",
    "evidenceUpload.size.kb": "{kilobytes} KiB",
    "evidenceUpload.preview.image": "Preview of {name}",
    "evidenceUpload.preview.text": "First lines of {name}",
    "evidenceUpload.preview.truncated": "Only the beginning of the file is shown.",
    "evidenceUpload.preview.empty": "This file has no text to show.",
    "evidenceUpload.preview.document": "Content preview is unavailable for this format. Check the file name and size before uploading.",
    "evidenceUpload.error.invalidSize": "Choose a nonempty file no larger than 10 MiB.",
    "evidenceUpload.error.empty": "This file is empty, so there is nothing to attach.",
    "evidenceUpload.error.tooLarge": "This file is larger than 10 MiB. Attach a smaller file or split it.",
    "evidenceUpload.error.unsupportedExtension": "That file type cannot be attached. Use PDF, JPG, PNG, WebP, TXT, CSV, DOCX or XLSX.",
    "evidenceUpload.error.unsupportedFormat": "This browser cannot convert that photo. Save it as JPEG or PNG, then attach it.",
    "evidenceUpload.error.rejected": "This file was rejected by the safety check and was not attached.",
    "evidenceUpload.error.pendingCheck": "The safety check did not finish, so this file was not attached. Try again. Your file and name are still here.",
    "evidenceUpload.error.rateLimited": "You have reached the hourly limit of 20 file checks. Try again later. Your file and name are still here.",
    "evidenceUpload.error.stale": "This file needs a fresh safety check. Your file and name are still here — try again.",
    "evidenceUpload.error.unavailable": "This file could not be attached right now. Your file and name are still here — try again.",
    "evidenceUpload.permanent": "Trying again with this file will give the same answer. Choose a different file.",
  },
  es: {
    "evidenceUpload.title": "Adjuntar un documento",
    "evidenceUpload.formats": "Archivos aceptados: PDF, JPG o JPEG, PNG, WebP, TXT, CSV, DOCX, XLSX.",
    "evidenceUpload.size": "Un archivo a la vez, hasta 10 MiB (10 485 760 bytes).",
    "evidenceUpload.conversion": "Las fotos HEIC y HEIF del iPhone se convierten a JPEG en este navegador. Si este navegador no puede convertirla, guárdala como JPEG o PNG y elígela otra vez.",
    "evidenceUpload.inspection": "Los archivos deben pasar una comprobación de seguridad antes de adjuntarse. Un formato compatible también puede rechazarse.",
    "evidenceUpload.choose": "Elegir un archivo",
    "evidenceUpload.replace": "Elegir otro archivo",
    "evidenceUpload.stage.preparing": "Leyendo este archivo…",
    "evidenceUpload.stage.converting": "Convirtiendo esta foto a JPEG…",
    "evidenceUpload.stage.staged": "Listo. No se envía nada hasta que elijas Subir.",
    "evidenceUpload.stage.uploading": "Subiendo…",
    "evidenceUpload.stage.checking": "Comprobando la seguridad de este archivo…",
    "evidenceUpload.stage.confirming": "Adjuntando este archivo…",
    "evidenceUpload.stage.done": "Adjuntado.",
    "evidenceUpload.nameLabel": "Nombre del archivo",
    "evidenceUpload.nameHelp": "La extensión {extension} se conserva automáticamente.",
    "evidenceUpload.finalName": "Se adjuntará como",
    "evidenceUpload.upload": "Subir",
    "evidenceUpload.retry": "Intentar de nuevo",
    "evidenceUpload.reconcile": "Consultar estado de carga",
    "evidenceUpload.error.reconcile": "La carga anterior aún necesita confirmación. Consulta su estado para terminar la misma carga. Borrar esta selección no cancela esa carga.",
    "evidenceUpload.cancel": "Cancelar",
    "evidenceUpload.size.kb": "{kilobytes} KiB",
    "evidenceUpload.preview.image": "Vista previa de {name}",
    "evidenceUpload.preview.text": "Primeras líneas de {name}",
    "evidenceUpload.preview.truncated": "Solo se muestra el comienzo del archivo.",
    "evidenceUpload.preview.empty": "Este archivo no tiene texto para mostrar.",
    "evidenceUpload.preview.document": "La vista previa del contenido no está disponible para este formato. Revisa el nombre y el tamaño antes de subirlo.",
    "evidenceUpload.error.invalidSize": "Elige un archivo no vacío de hasta 10 MiB.",
    "evidenceUpload.error.empty": "Este archivo está vacío, así que no hay nada que adjuntar.",
    "evidenceUpload.error.tooLarge": "Este archivo supera los 10 MiB. Adjunta un archivo más pequeño o divídelo.",
    "evidenceUpload.error.unsupportedExtension": "Ese tipo de archivo no se puede adjuntar. Usa PDF, JPG, PNG, WebP, TXT, CSV, DOCX o XLSX.",
    "evidenceUpload.error.unsupportedFormat": "Este navegador no puede convertir esa foto. Guárdala como JPEG o PNG y elígela otra vez.",
    "evidenceUpload.error.rejected": "La comprobación de seguridad rechazó este archivo y no se adjuntó.",
    "evidenceUpload.error.pendingCheck": "La comprobación de seguridad no terminó, así que el archivo no se adjuntó. Tu archivo y su nombre siguen aquí: inténtalo de nuevo.",
    "evidenceUpload.error.rateLimited": "Alcanzaste el límite de 20 comprobaciones por hora. Tu archivo y su nombre siguen aquí: inténtalo más tarde.",
    "evidenceUpload.error.stale": "Este archivo necesita una comprobación de seguridad nueva. Tu archivo y su nombre siguen aquí: inténtalo de nuevo.",
    "evidenceUpload.error.unavailable": "No se pudo adjuntar este archivo ahora. Tu archivo y su nombre siguen aquí: inténtalo de nuevo.",
    "evidenceUpload.permanent": "Intentarlo otra vez con este archivo dará la misma respuesta. Elige un archivo distinto.",
  },
});

/** Resolve one of this component's strings for a language. */
export function evidenceUploadText(lang, key, vars) {
  return lookup(EVIDENCE_UPLOAD_COPY, lang, key, vars);
}
