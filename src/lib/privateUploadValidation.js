// Local pre-flight for the four private upload buckets.
//
// The server's begin/register RPCs already refuse a file over 10 MiB or
// outside the bucket allowlist, and the content inspector stays the
// authoritative, required verdict on the bytes themselves. Nothing here
// weakens or replaces that: this module exists so a file that can NEVER be
// accepted is refused before any network request — before the begin RPC
// mints a row, before a byte crosses the wire, and before one of the
// member's twenty hourly inspections is spent on a certain refusal.
//
// The contract mirrors the server exactly:
//   - size between 1 byte and 10 MiB (10485760 bytes), the bound every
//     begin_*/register_* RPC raises `22023` on;
//   - only PDF, JPG/JPEG, PNG, WebP, TXT, CSV, DOCX and XLSX, the eight
//     formats in the bucket `allowed_mime_types`;
//   - the extension must agree with the declared MIME, because the inspector
//     pairs them (a `.heic` name against `image/jpeg` is a permanent
//     refusal, which is why the HEIC converter runs before this check).
//
// Validation runs AFTER any HEIC conversion and BEFORE the begin RPC, so the
// bytes checked are the bytes that would actually be uploaded.

// The exact server bound: `p_size_bytes between 1 and 10485760`. This is not
// a new cap and must never drift from the RPC check it pre-flights.
export const PRIVATE_UPLOAD_MAX_BYTES = 10485760;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Exact lowercase extension → the one MIME the bucket allowlist and the
// inspector's extension pairing accept for it.
const MIME_BY_EXTENSION = new Map([
  [".pdf", "application/pdf"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".txt", "text/plain"],
  [".csv", "text/csv"],
  [".docx", DOCX_MIME],
  [".xlsx", XLSX_MIME],
]);

// A picker that knows nothing about the type reports one of these. Only a
// generic label may be normalized from the exact extension; a picker that
// positively disagrees (photo.jpg declared as image/png) is refused, because
// re-labelling bytes that claim to be something else is how a disguised
// payload would slip past the member's own understanding of what they picked.
const GENERIC_MIME = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/**
 * A refusal the member can act on, in the same shape as the HEIC converter's:
 * `privateFileCode` is the stable token the views branch on, and `details`
 * follows the `private_file_*` translation-token convention.
 */
export class InvalidUploadFormatError extends Error {
  constructor() {
    super("Attach a PDF, JPG, PNG, WebP, TXT, CSV, DOCX, or XLSX file.");
    this.name = "InvalidUploadFormatError";
    this.code = "invalid-format";
    this.details = "private_file_invalid_format";
    this.privateFileCode = "invalid-format";
  }
}

export class InvalidUploadSizeError extends Error {
  constructor() {
    super("Files must be 10 MiB or smaller.");
    this.name = "InvalidUploadSizeError";
    this.code = "invalid-size";
    this.details = "private_file_invalid_size";
    this.privateFileCode = "invalid-size";
  }
}

function fileExtension(name) {
  const base = String(name || "").toLowerCase();
  const dot = base.lastIndexOf(".");
  // A leading dot with nothing before it (".pdf") is the whole name, not an
  // extension; either way the Map lookup decides.
  return dot <= 0 ? "" : base.slice(dot);
}

/** The one MIME the allowlist accepts for this file name, or null. Server
 * code that sees only a declared name and type
 * applies the same pairing the picker check above applies to a File. */

function declaredMime(file) {
  // Browsers never attach parameters to File.type, but a synthetic File can
  // carry them; the allowlist compares the bare type.
  const mime = String(file?.type || "").toLowerCase().split(";")[0].trim();
  return mime === "text/comma-separated-values" ? "text/csv" : mime;
}

/**
 * Return the exact file to upload, or throw before any network happens.
 *
 * The pass-through is identity: a file whose declared MIME already matches
 * its extension is returned as the SAME object, so no upload path ever
 * silently re-encodes or re-wraps bytes the member chose. The one exception
 * is a generic declared MIME on a recognized extension, which is re-labelled
 * — the bytes are preserved exactly (the original Blob rides inside the new
 * File); only the meaningless `application/octet-stream` label changes so
 * the begin RPC and the bucket see the format the extension already states.
 */
export function validatePrivateUploadFile(file) {
  const expected = MIME_BY_EXTENSION.get(fileExtension(file?.name));
  if (!expected) throw new InvalidUploadFormatError();
  const declared = declaredMime(file);
  let prepared = file;
  if (declared !== expected && !GENERIC_MIME.has(declared)) throw new InvalidUploadFormatError();
  if (file.type !== expected) {
    if (typeof Blob !== "function" || !(file instanceof Blob)) {
      // Re-labelling needs the original bytes to ride inside the new File.
      // A non-Blob cannot be faithfully re-wrapped, so refuse closed rather
      // than upload a corrupted stand-in.
      throw new InvalidUploadFormatError();
    }
    prepared = new File([file], file.name, {
      type: expected,
      lastModified: file.lastModified ?? Date.now(),
    });
  }
  // AFTER any re-labelling, the exact server size bound: 1 byte to 10 MiB.
  // A missing or non-numeric size fails here rather than as an opaque 22023.
  if (!Number.isSafeInteger(prepared.size) || prepared.size < 1 || prepared.size > PRIVATE_UPLOAD_MAX_BYTES) {
    throw new InvalidUploadSizeError();
  }
  return prepared;
}
