/**
 * Staged-attachment presentation model.
 *
 * Evidence now arrives in three visible steps: the member chooses a file, sees
 * what was staged and names it, and then uploads it deliberately. Every rule
 * those steps need lives here — the ceiling and format copy shown *before* the
 * picker opens, the name arithmetic that keeps the file's real extension while
 * the member edits only its stem, the honest summary for a file that cannot be
 * shown, and the bounded text window.
 *
 * Nothing in this module reads a file, touches a native module, or reaches the
 * network. The panel supplies the bytes it already holds in the app-private
 * cache, and no preview ever leaves the device or enters a log.
 */

/**
 * The upload ceiling, in bytes, exactly as the service enforces it.
 * `attachments.test.ts` pins this against `MAX_ATTACHMENT_BYTES`, so the number
 * the member is shown before the picker cannot drift from the number that
 * actually refuses a file.
 */
export const ATTACHMENT_UPLOAD_CEILING_BYTES = 10485760;

/** The filename budget `validateAttachmentCandidate` enforces, extension included. */
export const ATTACHMENT_FILENAME_LIMIT = 160;

/** The bounded window a text preview may read from the staged local copy. */
export const STAGED_TEXT_PREVIEW_BYTES = 4096;
export const STAGED_TEXT_PREVIEW_CHARACTERS = 480;
export const STAGED_TEXT_PREVIEW_LINES = 10;

type StagedFormat = {
  mimeType: string;
  /** What the member sees in the staged summary. */
  label: string;
  /** What the member sees in the pre-picker format list. */
  extensions: string;
};

/**
 * One row per uploadable type. HEIC/HEIF are deliberately absent: they are
 * converted to JPG on this device before anything is validated, so they are
 * named in the notice below as an input the picker accepts rather than as a
 * format that can be uploaded.
 */
const STAGED_FORMATS: readonly StagedFormat[] = Object.freeze([
  { mimeType: 'application/pdf', label: 'PDF document', extensions: 'PDF' },
  { mimeType: 'image/jpeg', label: 'JPG image', extensions: 'JPG/JPEG' },
  { mimeType: 'image/png', label: 'PNG image', extensions: 'PNG' },
  { mimeType: 'image/webp', label: 'WebP image', extensions: 'WebP' },
  { mimeType: 'text/plain', label: 'Text file', extensions: 'TXT' },
  { mimeType: 'text/csv', label: 'CSV file', extensions: 'CSV' },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word document',
    extensions: 'DOCX',
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel workbook',
    extensions: 'XLSX',
  },
]);

/** The exact format list, in the order the notice prints it. */
export const STAGED_FORMAT_EXTENSIONS: readonly string[] =
  Object.freeze(STAGED_FORMATS.map((format) => format.extensions));

/** Every MIME type the staged summary can name, for the anti-drift test. */
export const STAGED_FORMAT_MIME_TYPES: readonly string[] =
  Object.freeze(STAGED_FORMATS.map((format) => format.mimeType));

function ceilingLabel(): string {
  return `${ATTACHMENT_UPLOAD_CEILING_BYTES / (1024 * 1024)} MiB`;
}

function groupedCeiling(): string {
  return ATTACHMENT_UPLOAD_CEILING_BYTES.toLocaleString('en-US');
}

/**
 * Shown before the picker opens, not after a refusal. A member who learns the
 * ceiling and the format list from an error message has already lost the file
 * they chose.
 */
export const ATTACHMENT_LIMIT_NOTICE = `Attach a ${STAGED_FORMAT_EXTENSIONS.slice(0, -1).join(', ')} or ${
  STAGED_FORMAT_EXTENSIONS[STAGED_FORMAT_EXTENSIONS.length - 1] ?? ''
} file up to ${ceilingLabel()} (${groupedCeiling()} bytes). HEIC and HEIF photos are converted to JPG on this device before the file is checked. Every file must pass a safety check; a supported format can still be rejected.`;

/** What the staged card can actually render for a given type. */
export type StagedPreviewKind = 'image' | 'text' | 'document';

const IMAGE_PREVIEW_TYPES: readonly string[] = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const TEXT_PREVIEW_TYPES: readonly string[] = Object.freeze(['text/plain', 'text/csv']);

export function stagedPreviewKind(mimeType: string): StagedPreviewKind {
  const normalized = mimeType.trim().toLowerCase();
  if (IMAGE_PREVIEW_TYPES.includes(normalized)) return 'image';
  if (TEXT_PREVIEW_TYPES.includes(normalized)) return 'text';
  return 'document';
}

export function stagedFormatLabel(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return STAGED_FORMATS.find((format) => format.mimeType === normalized)?.label ?? 'File';
}

export function formatAttachmentBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * The honest line every staged file carries, previewable or not: what it is and
 * how big it is. A document that cannot be rendered says so through this
 * summary instead of through an empty frame.
 */
export function stagedSummary(mimeType: string, sizeBytes: number): string {
  return `${stagedFormatLabel(mimeType)} · ${formatAttachmentBytes(sizeBytes)}`;
}

export const STAGED_DOCUMENT_PREVIEW_NOTE =
  'This file type cannot be shown here. Open it from the list after it uploads.';

export const STAGED_TEXT_PREVIEW_UNAVAILABLE_NOTE =
  'The first lines of this file could not be shown. The name and size above are read from the staged copy.';

export const STAGED_CONVERTED_NOTE =
  'Converted to JPG on this device. The original photo is not uploaded.';

/**
 * Said only when deletion of the staged copy could not be confirmed. The
 * service keeps that path queued and retries it on the next foreground pass, so
 * this is a pending state rather than a leak the member must act on alone.
 */
export const STAGED_CLEANUP_PENDING_MESSAGE =
  'The temporary copy on this device could not be confirmed deleted. Keep this session open and try again.';

export type StagedNameParts = { stem: string; extension: string };

/**
 * Split a validated filename the way the service does: the extension is
 * whatever follows the last dot, and it is returned with its original casing so
 * a rename can put the exact same extension back.
 */
export function splitStagedFilename(filename: string): StagedNameParts {
  const trimmed = filename.trim();
  const index = trimmed.lastIndexOf('.');
  return index > 0
    ? { stem: trimmed.slice(0, index), extension: trimmed.slice(index + 1) }
    : { stem: trimmed, extension: '' };
}

/** Rejoin a member-edited stem with the file's actual extension. */
export function stagedFilename(stem: string, extension: string): string {
  const base = stem.normalize('NFC').replace(/\p{C}/gu, '').trim();
  return extension ? `${base}.${extension}` : base;
}

/**
 * Why this name cannot be used, in the member's terms, or null when it can.
 * The rules are the ones `validateAttachmentCandidate` enforces, so the panel
 * refuses a name before an upload starts rather than after a round trip.
 */
export function stagedNameProblem(stem: string, extension: string): string | null {
  const base = stem.trim();
  if (base.length < 1) return 'Enter a name for this file before uploading it.';
  const filename = stagedFilename(base, extension);
  if (filename.length > ATTACHMENT_FILENAME_LIMIT) {
    return `Use ${ATTACHMENT_FILENAME_LIMIT} characters or fewer, including the file extension.`;
  }
  if (/[/\\\p{C}]/u.test(stem) || /[/\\\p{C}]/u.test(extension)) {
    return 'A file name cannot contain folders or control characters.';
  }
  return null;
}

export type StagedTextPreview = { text: string; truncated: boolean };

/**
 * Decode a bounded window of UTF-8 bytes without a platform decoder.
 *
 * The window is at most STAGED_TEXT_PREVIEW_BYTES, so the cost is fixed, and
 * decoding it here keeps the preview identical on every runtime instead of
 * depending on whether a TextDecoder happens to be installed. An invalid
 * sequence returns null, and the panel then shows the summary rather than
 * mojibake; a sequence the window cut in half is simply dropped.
 */
function decodeBoundedUtf8(bytes: Uint8Array): string | null {
  let text = '';
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index] ?? 0;
    let length = 1;
    let codePoint = first;
    if (first >= 0xf8) return null;
    if (first >= 0xf0) {
      length = 4;
      codePoint = first & 0x07;
    } else if (first >= 0xe0) {
      length = 3;
      codePoint = first & 0x0f;
    } else if (first >= 0xc0) {
      length = 2;
      codePoint = first & 0x1f;
    } else if (first >= 0x80) {
      return null;
    }
    if (index + length > bytes.length) break;
    for (let offset = 1; offset < length; offset += 1) {
      const next = bytes[index + offset] ?? 0;
      if ((next & 0xc0) !== 0x80) return null;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (length === 2 && codePoint < 0x80) return null;
    if (length === 3 && codePoint < 0x800) return null;
    if (length === 4 && codePoint < 0x10000) return null;
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
    text += String.fromCodePoint(codePoint);
    index += length;
  }
  return text;
}

/**
 * Build the bounded text preview from a window of the staged local copy.
 *
 * `totalBytes` is the staged file's full size, so a preview taken from the
 * first window can say honestly that there is more. A window carrying control
 * bytes is not text at all and returns null rather than being scrubbed into
 * something that looks like content.
 */
export function boundedTextPreview(bytes: Uint8Array, totalBytes: number): StagedTextPreview | null {
  const decoded = decodeBoundedUtf8(bytes.subarray(0, STAGED_TEXT_PREVIEW_BYTES));
  if (decoded === null) return null;
  const normalized = decoded.replace(/\r\n?/gu, '\n');
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x7f) return null;
    if (code < 0x20 && character !== '\n' && character !== '\t') return null;
  }
  const allLines = normalized.split('\n');
  const lines = allLines.slice(0, STAGED_TEXT_PREVIEW_LINES);
  let text = lines.join('\n');
  let truncated = totalBytes > Math.min(bytes.length, STAGED_TEXT_PREVIEW_BYTES)
    || lines.length < allLines.length;
  if (text.length > STAGED_TEXT_PREVIEW_CHARACTERS) {
    text = text.slice(0, STAGED_TEXT_PREVIEW_CHARACTERS);
    truncated = true;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  return { text: trimmed, truncated };
}

export const STAGED_TEXT_PREVIEW_TRUNCATED_NOTE = 'First lines only.';
