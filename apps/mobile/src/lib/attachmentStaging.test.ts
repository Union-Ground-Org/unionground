import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_FILENAME_LIMIT,
  ATTACHMENT_LIMIT_NOTICE,
  ATTACHMENT_UPLOAD_CEILING_BYTES,
  STAGED_CONVERTED_NOTE,
  STAGED_DOCUMENT_PREVIEW_NOTE,
  STAGED_FORMAT_EXTENSIONS,
  STAGED_FORMAT_MIME_TYPES,
  STAGED_TEXT_PREVIEW_BYTES,
  STAGED_TEXT_PREVIEW_CHARACTERS,
  STAGED_TEXT_PREVIEW_LINES,
  boundedTextPreview,
  formatAttachmentBytes,
  splitStagedFilename,
  stagedFilename,
  stagedFormatLabel,
  stagedNameProblem,
  stagedPreviewKind,
  stagedSummary,
} from './attachmentStaging';

const encoder = new TextEncoder();

describe('what the worker is told before the picker opens', () => {
  it('states the exact ceiling and the exact format list', () => {
    expect(ATTACHMENT_UPLOAD_CEILING_BYTES).toBe(10485760);
    expect(ATTACHMENT_LIMIT_NOTICE).toContain('up to 10 MiB');
    expect(ATTACHMENT_LIMIT_NOTICE).toContain('10,485,760 bytes');
    for (const extension of STAGED_FORMAT_EXTENSIONS) {
      expect(ATTACHMENT_LIMIT_NOTICE).toContain(extension);
    }
    expect(STAGED_FORMAT_EXTENSIONS).toEqual(['PDF', 'JPG/JPEG', 'PNG', 'WebP', 'TXT', 'CSV', 'DOCX', 'XLSX']);
    expect(STAGED_FORMAT_MIME_TYPES).toHaveLength(STAGED_FORMAT_EXTENSIONS.length);
  });

  it('names HEIC only as a conversion input, never as an uploadable format', () => {
    expect(ATTACHMENT_LIMIT_NOTICE).toContain('converted to JPG on this device');
    expect(STAGED_FORMAT_EXTENSIONS).not.toContain('HEIC');
    expect(STAGED_FORMAT_MIME_TYPES).not.toContain('image/heic');
    expect(STAGED_FORMAT_MIME_TYPES).not.toContain('image/heif');
    expect(stagedFormatLabel('image/heic')).toBe('File');
    expect(STAGED_CONVERTED_NOTE).toContain('original photo is not uploaded');
  });
});

describe('renaming a staged file', () => {
  it('lets the worker edit only the stem and keeps the real extension verbatim', () => {
    expect(splitStagedFilename('IMG_0042.HEIC')).toEqual({ stem: 'IMG_0042', extension: 'HEIC' });
    expect(splitStagedFilename('grievance.2026-09.pdf')).toEqual({ stem: 'grievance.2026-09', extension: 'pdf' });
    expect(splitStagedFilename('noextension')).toEqual({ stem: 'noextension', extension: '' });
    // A dotfile has no extension to preserve: index 0 is not a split point.
    expect(splitStagedFilename('.hidden')).toEqual({ stem: '.hidden', extension: '' });

    // Casing survives the round trip, so a rename cannot turn .JPG into .jpg.
    const parts = splitStagedFilename('Scan_final.JPG');
    expect(stagedFilename('Grievance packet', parts.extension)).toBe('Grievance packet.JPG');
    expect(stagedFilename('  padded  ', 'pdf')).toBe('padded.pdf');
    expect(stagedFilename('nothing', '')).toBe('nothing');
    expect(stagedFilename('report\u202egnp', 'pdf')).toBe('reportgnp.pdf');
    expect(stagedNameProblem('report\u202egnp', 'pdf')).toMatch(/control characters/);
  });

  it('refuses a name the upload validator would reject, before any upload starts', () => {
    expect(stagedNameProblem('grievance packet', 'pdf')).toBeNull();
    expect(stagedNameProblem('notes.2026', 'csv')).toBeNull();
    expect(stagedNameProblem('', 'pdf')).toMatch(/Enter a name/);
    expect(stagedNameProblem('   ', 'pdf')).toMatch(/Enter a name/);
    expect(stagedNameProblem('folder/child', 'pdf')).toMatch(/cannot contain folders/);
    expect(stagedNameProblem('back\\slash', 'pdf')).toMatch(/cannot contain folders/);
    expect(stagedNameProblem('line\nbreak', 'pdf')).toMatch(/control characters/);
    expect(stagedNameProblem('tab\tstop', 'pdf')).toMatch(/control characters/);

    // The budget is the whole filename, extension included, exactly as
    // validateAttachmentCandidate counts it.
    const exact = 'a'.repeat(ATTACHMENT_FILENAME_LIMIT - 4);
    expect(stagedFilename(exact, 'pdf')).toHaveLength(ATTACHMENT_FILENAME_LIMIT);
    expect(stagedNameProblem(exact, 'pdf')).toBeNull();
    expect(stagedNameProblem(`${exact}b`, 'pdf')).toMatch(/160 characters or fewer/);
  });
});

describe('what the staged card can honestly show', () => {
  it('previews images and text, and says so plainly for everything else', () => {
    expect(stagedPreviewKind('image/jpeg')).toBe('image');
    expect(stagedPreviewKind('image/png')).toBe('image');
    expect(stagedPreviewKind('image/webp')).toBe('image');
    expect(stagedPreviewKind('text/plain')).toBe('text');
    expect(stagedPreviewKind('text/csv')).toBe('text');
    expect(stagedPreviewKind('application/pdf')).toBe('document');
    expect(stagedPreviewKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('document');
    expect(stagedPreviewKind('IMAGE/JPEG')).toBe('image');
    expect(STAGED_DOCUMENT_PREVIEW_NOTE).toContain('cannot be shown here');
  });

  it('summarises every uploadable type with its kind and its size', () => {
    for (const mimeType of STAGED_FORMAT_MIME_TYPES) {
      const summary = stagedSummary(mimeType, 2048);
      expect(summary).toContain('2 KiB');
      expect(summary).not.toContain('File ·');
    }
    expect(stagedSummary('application/pdf', 1_572_864)).toBe('PDF document · 1.5 MiB');
    expect(stagedSummary('image/jpeg', 900)).toBe('JPG image · 900 B');
    expect(formatAttachmentBytes(0)).toBe('0 B');
    expect(formatAttachmentBytes(1023)).toBe('1023 B');
    expect(formatAttachmentBytes(1024)).toBe('1 KiB');
    expect(formatAttachmentBytes(ATTACHMENT_UPLOAD_CEILING_BYTES)).toBe('10.0 MiB');
    expect(formatAttachmentBytes(Number.NaN)).toBe('0 B');
  });
});

describe('the bounded text preview', () => {
  it('shows the beginning of a plain-text file and says when there is more', () => {
    const bytes = encoder.encode('case,amount\nsite-12,42\n');
    const whole = boundedTextPreview(bytes, bytes.byteLength);
    expect(whole).toEqual({ text: 'case,amount\nsite-12,42', truncated: false });

    // The same window taken from a much larger file is honest about it.
    expect(boundedTextPreview(bytes, bytes.byteLength + 1)?.truncated).toBe(true);
  });

  it('decodes multi-byte UTF-8 and drops a sequence the window cut in half', () => {
    const full = encoder.encode('año de cuotas — 2026\n');
    expect(boundedTextPreview(full, full.byteLength)?.text).toBe('año de cuotas — 2026');

    // The em dash is three bytes; ending the window inside it must not produce
    // a replacement character.
    const dashStart = full.indexOf(0xe2);
    expect(dashStart).toBeGreaterThan(0);
    const cut = full.subarray(0, dashStart + 2);
    const preview = boundedTextPreview(cut, full.byteLength);
    expect(preview?.text).toBe('año de cuotas');
    expect(preview?.text).not.toContain('�');
    expect(preview?.truncated).toBe(true);
  });

  it('normalises CRLF without inventing blank lines', () => {
    const bytes = encoder.encode('first\r\nsecond\rthird\n');
    expect(boundedTextPreview(bytes, bytes.byteLength)?.text).toBe('first\nsecond\nthird');
  });

  it('caps the window by bytes, by lines and by characters', () => {
    const many = encoder.encode(`${'line\n'.repeat(STAGED_TEXT_PREVIEW_LINES + 8)}`);
    const capped = boundedTextPreview(many, many.byteLength);
    expect(capped?.text.split('\n')).toHaveLength(STAGED_TEXT_PREVIEW_LINES);
    expect(capped?.truncated).toBe(true);

    const long = encoder.encode('x'.repeat(STAGED_TEXT_PREVIEW_CHARACTERS + 50));
    const shortened = boundedTextPreview(long, long.byteLength);
    expect(shortened?.text).toHaveLength(STAGED_TEXT_PREVIEW_CHARACTERS);
    expect(shortened?.truncated).toBe(true);

    // Even handed more bytes than the window allows, only the window is read.
    const oversized = encoder.encode('a'.repeat(STAGED_TEXT_PREVIEW_BYTES + 512));
    expect(boundedTextPreview(oversized, oversized.byteLength)?.text.length)
      .toBeLessThanOrEqual(STAGED_TEXT_PREVIEW_CHARACTERS);
  });

  it('refuses to render bytes that are not text', () => {
    // A control byte, a stray continuation byte, an overlong encoding, a lone
    // surrogate, and an all-whitespace window are all "no preview", never a
    // scrubbed approximation of content.
    expect(boundedTextPreview(new Uint8Array([0x68, 0x00, 0x69]), 3)).toBeNull();
    expect(boundedTextPreview(new Uint8Array([0x68, 0x07]), 2)).toBeNull();
    expect(boundedTextPreview(new Uint8Array([0x80, 0x61]), 2)).toBeNull();
    expect(boundedTextPreview(new Uint8Array([0xc0, 0xaf]), 2)).toBeNull();
    expect(boundedTextPreview(new Uint8Array([0xed, 0xa0, 0x80]), 3)).toBeNull();
    expect(boundedTextPreview(new Uint8Array([0xff, 0xfe, 0x41]), 3)).toBeNull();
    expect(boundedTextPreview(encoder.encode('   \n\t\n'), 6)).toBeNull();
    expect(boundedTextPreview(new Uint8Array(), 0)).toBeNull();
    // A DEL byte is printable-adjacent but is not content either.
    expect(boundedTextPreview(new Uint8Array([0x61, 0x7f]), 2)).toBeNull();
  });
});
