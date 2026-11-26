// HEIC on the web: convert, or refuse in words a member can act on.
//
// The four private buckets no longer accept `image/heic`
// (20260906010000_private_upload_write_path_hardening.sql), because the
// inspector permanently refuses HEIC: accepting the bytes would only mint
// unreachable quarantined objects and burn the caller's hourly inspection
// quota on every retry. That is the secure default, and it leaves the client
// with exactly two honest options for the photo an iPhone just handed it —
// convert it here, or say plainly that it cannot be attached.
//
// `createImageBitmap` is the conversion. It is a feature test that cannot be
// faked: a browser that can decode HEIC (Safari, and iOS WebKit generally)
// resolves it; one that cannot (Chrome, Firefox on most platforms) rejects,
// and there is no user agent string to misread. The re-encode also drops every
// EXIF block — GPS coordinates included — which is a second reason to prefer
// it over shipping the original bytes.

const HEIC_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);
const HEIC_EXTENSION = /\.(heic|heif)$/i;

// Matches the native side's re-encode quality (attachments.ts camera path), so
// a photo attached from a phone browser and the same photo attached from the
// app produce comparably sized JPEGs.
const JPEG_QUALITY = 0.82;

/**
 * A refusal the member can act on, not a scanner detail.
 *
 * `details` is the stable token `rpcErrorText` translates, so the message a
 * member reads comes from the catalogue in their own language rather than from
 * this English fallback.
 */
export class UnsupportedUploadFormatError extends Error {
  constructor() {
    super("Convert this photo to JPEG or PNG before attaching it.");
    this.name = "UnsupportedUploadFormatError";
    this.code = "unsupported-format";
    this.details = "private_file_unsupported_format";
    this.privateFileCode = "unsupported-format";
  }
}

// ISO base media containers announce themselves at bytes 4..8 with `ftyp`, and
// the brand that follows says which flavour. These are the HEIF/HEIC brands the
// inspector permanently refuses; `avif`/`avis` are deliberately absent, because
// an AVIF is not something this converter should silently re-encode.
const HEIC_BRANDS = new Set([
  "heic", "heix", "heim", "heis",
  "hevc", "hevx", "hevm", "hevs",
  "mif1", "msf1",
]);
const FTYP_PROBE_BYTES = 12;

/**
 * True for a file this build must convert before it can be uploaded.
 *
 * The MIME type is a CLAIM, not evidence — a browser picking `photo.heic` off
 * an iPhone quite happily reports `image/jpeg`, and trusting that shipped the
 * original HEIC bytes under a `.heic` filename to a server whose inspector
 * accepts only `.jpg`/`.jpeg` for that MIME. The result was a permanent
 * rejection instead of a conversion. So either signal is enough on its own:
 * a HEIC/HEIF MIME, or a HEIC/HEIF extension, whatever the other one says.
 */
export function isHeicUpload(file) {
  const type = String(file?.type || "").toLowerCase();
  if (HEIC_MIME_TYPES.has(type)) return true;
  return HEIC_EXTENSION.test(String(file?.name || ""));
}

/**
 * True when the first bytes are an ISO base media container with a HEIF brand.
 *
 * This is the third signal, for the file that lies in both of the others —
 * `IMG_0042.jpg` reported as `image/jpeg` and holding HEIC bytes. Reading
 * twelve bytes cannot fail closed usefully: a browser that will not hand them
 * over leaves the declared type standing, and the server inspector still
 * refuses the bytes.
 */
async function hasHeicMagic(file) {
  if (typeof file?.slice !== "function") return false;
  let head;
  try {
    const buffer = await file.slice(0, FTYP_PROBE_BYTES).arrayBuffer();
    head = new Uint8Array(buffer);
  } catch {
    return false;
  }
  if (head.length < FTYP_PROBE_BYTES) return false;
  const ascii = String.fromCharCode(...head.subarray(4, FTYP_PROBE_BYTES));
  return ascii.startsWith("ftyp") && HEIC_BRANDS.has(ascii.slice(4, 8).toLowerCase());
}

function notifyPhase(onPhase, phase) {
  // A view's state update must never be able to fail an upload: a throwing
  // callback is the caller's UI problem, not a reason to break a conversion
  // or a transaction that may already have put bytes in Storage.
  try { onPhase?.(phase); } catch { /* the caller's UI, not our transaction */ }
}

function jpegName(name) {
  const base = String(name || "photo").replace(HEIC_EXTENSION, "");
  // A file that lied only in its bytes already carries a JPEG name; appending
  // a second extension would make the filename disagree with the MIME the
  // inspector checks it against.
  if (/\.jpe?g$/i.test(base)) return base;
  return `${base || "photo"}.jpg`;
}

async function decode(file) {
  if (typeof createImageBitmap !== "function") throw new UnsupportedUploadFormatError();
  try {
    return await createImageBitmap(file);
  } catch {
    // The browser cannot decode HEIC. There is no fallback worth shipping —
    // a WASM decoder is megabytes of attack surface for a format the server
    // refuses anyway — so the member converts it.
    throw new UnsupportedUploadFormatError();
  }
}

async function encodeJpeg(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new UnsupportedUploadFormatError();
  context.drawImage(bitmap, 0, 0);
  const blob = await new Promise((resolve) => {
    // toBlob hands back null when the canvas is tainted or the type is
    // unsupported; either way there is nothing to upload.
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY);
  });
  if (!blob || blob.size === 0) throw new UnsupportedUploadFormatError();
  return blob;
}

/**
 * Return the file that should actually be uploaded.
 *
 * Anything the buckets accept is passed through untouched — this must never
 * silently re-encode a PDF or a JPEG the member chose. Only HEIC/HEIF is
 * converted, and only to `image/jpeg`, which every allowlist already admits.
 * HEIC is recognised by its MIME, by its extension, or by its `ftyp` brand,
 * because any one of those three can be the only honest signal.
 *
 * Throws `UnsupportedUploadFormatError` when this browser cannot decode the
 * photo, so the caller can show one specific sentence instead of letting the
 * server produce an opaque "file type is not accepted".
 *
 * `onPhase` is optional and backward compatible. It hears `preparing` once,
 * the moment the local read starts (the twelve-byte container probe runs even
 * for a file that turns out to need nothing), and `converting` only when a
 * HEIC/HEIF re-encode actually starts — whichever of the three signals (MIME,
 * extension, or the `ftyp` brand) triggered it. A file the buckets already
 * accept is returned untouched and never emits `converting`.
 */
export async function normalizeUploadFile(file, { onPhase } = {}) {
  notifyPhase(onPhase, "preparing");
  if (!isHeicUpload(file) && !await hasHeicMagic(file)) return file;
  // Only now has conversion actually started. Emitting this earlier — on a
  // signal that the magic-byte probe might still clear — would show the
  // member a conversion that never happens.
  notifyPhase(onPhase, "converting");
  const bitmap = await decode(file);
  try {
    const blob = await encodeJpeg(bitmap);
    return new File([blob], jpegName(file?.name), {
      type: "image/jpeg",
      lastModified: file?.lastModified ?? Date.now(),
    });
  } finally {
    bitmap.close?.();
  }
}
