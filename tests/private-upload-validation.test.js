// @vitest-environment node
//
// Local pre-flight for the four private upload buckets. The server's
// begin/register RPCs and the content inspector stay authoritative; this
// check exists so a file that can never be accepted is refused before any
// network request, minted row, or spent inspection quota. These tests pin
// the exact contract: the eight allowed formats, the exact 10 MiB bound the
// RPCs raise on, and the extension/MIME pairing the inspector enforces.
import { describe, expect, it } from "vitest";
import {
  InvalidUploadFormatError,
  InvalidUploadSizeError,
  PRIVATE_UPLOAD_MAX_BYTES,
  validatePrivateUploadFile,
} from "../src/lib/privateUploadValidation.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("private upload local validation", () => {
  it("mirrors the exact server bound: 10 MiB is 10485760 bytes", () => {
    // The begin/register RPCs raise 22023 outside 1..10485760. A drift here
    // would either refuse files the server accepts or admit files it refuses.
    expect(PRIVATE_UPLOAD_MAX_BYTES).toBe(10485760);
    expect(PRIVATE_UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("passes every allowed format through as the SAME object — no re-wrap, no re-encode", () => {
    for (const [name, type] of [
      ["notes.pdf", "application/pdf"],
      ["photo.jpg", "image/jpeg"],
      ["photo.jpeg", "image/jpeg"],
      ["photo.png", "image/png"],
      ["photo.webp", "image/webp"],
      ["notes.txt", "text/plain"],
      ["ledger.csv", "text/csv"],
      ["letter.docx", DOCX_MIME],
      ["ledger.xlsx", XLSX_MIME],
      // Extension case is not signal; pickers hand over .JPG and .PDF freely.
      ["PHOTO.JPG", "image/jpeg"],
      ["Report.PDF", "application/pdf"],
    ]) {
      const file = { name, type, size: 4 };
      expect(validatePrivateUploadFile(file), name).toBe(file);
    }
  });

  it("accepts a file exactly at the 10 MiB ceiling", () => {
    const file = { name: "evidence.pdf", type: "application/pdf", size: 10485760 };
    expect(validatePrivateUploadFile(file)).toBe(file);
  });

  it("refuses one byte past the ceiling, an empty file, and a missing size", () => {
    for (const size of [10485761, 0, -1, 1.5, Number.NaN, undefined]) {
      const file = { name: "evidence.pdf", type: "application/pdf", size };
      expect(() => validatePrivateUploadFile(file), String(size)).toThrowError(InvalidUploadSizeError);
      try {
        validatePrivateUploadFile(file);
      } catch (error) {
        expect(error.privateFileCode).toBe("invalid-size");
        expect(error.code).toBe("invalid-size");
        expect(error.details).toBe("private_file_invalid_size");
      }
    }
  });

  it("refuses formats the buckets can never accept", () => {
    for (const file of [
      { name: "animation.gif", type: "image/gif", size: 4 },
      { name: "tool.exe", type: "application/octet-stream", size: 4 },
      { name: "photo.avif", type: "image/avif", size: 4 },
      // Unconverted HEIC never reaches this check — the converter runs first —
      // but the validation alone must still refuse it.
      { name: "photo.heic", type: "image/heic", size: 4 },
      { name: "no-extension", type: "image/jpeg", size: 4 },
      { name: "archive.tar.gz", type: "application/gzip", size: 4 },
      { name: "photo.jpe", type: "image/jpeg", size: 4 },
      { name: "", type: "application/pdf", size: 4 },
    ]) {
      expect(() => validatePrivateUploadFile(file), file.name).toThrowError(InvalidUploadFormatError);
      try {
        validatePrivateUploadFile(file);
      } catch (error) {
        expect(error.privateFileCode).toBe("invalid-format");
        expect(error.code).toBe("invalid-format");
        expect(error.details).toBe("private_file_invalid_format");
      }
    }
  });

  it("refuses a declared MIME that positively disagrees with the extension", () => {
    // Normalizing bytes that CLAIM to be something else is how a disguised
    // payload would slip past the member's own understanding of the pick.
    for (const file of [
      { name: "photo.jpg", type: "image/png", size: 4 },
      { name: "doc.pdf", type: "image/jpeg", size: 4 },
      { name: "notes.txt", type: "application/pdf", size: 4 },
      { name: "ledger.xlsx", type: DOCX_MIME, size: 4 },
    ]) {
      expect(() => validatePrivateUploadFile(file), file.name).toThrowError(InvalidUploadFormatError);
    }
  });

  it("normalizes a generic declared MIME per the exact extension, preserving the bytes", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    for (const generic of ["application/octet-stream", "binary/octet-stream", ""]) {
      const picked = new File([bytes], "evidence.pdf", { type: generic, lastModified: 1_700_000_000_000 });
      const prepared = validatePrivateUploadFile(picked);
      expect(prepared).not.toBe(picked);
      expect(prepared.name).toBe("evidence.pdf");
      expect(prepared.type).toBe("application/pdf");
      expect(prepared.size).toBe(4);
      expect(prepared.lastModified).toBe(1_700_000_000_000);
      // Only the label changed; the member's bytes ride through untouched.
      expect(new Uint8Array(await prepared.arrayBuffer())).toEqual(bytes);
    }
  });

  it("refuses a generic label it cannot faithfully re-wrap", () => {
    // A non-Blob test double carries no bytes to preserve; guessing at a
    // re-wrap would corrupt the upload, so this fails closed.
    const fake = { name: "evidence.pdf", type: "application/octet-stream", size: 4 };
    expect(() => validatePrivateUploadFile(fake)).toThrowError(InvalidUploadFormatError);
  });

  it("normalizes MIME parameters and the native CSV alias without changing bytes", async () => {
    for (const [name, type, expected] of [
      ["notes.txt", "text/plain; charset=utf-8", "text/plain"],
      ["data.csv", "text/comma-separated-values", "text/csv"],
    ]) {
      const file = new File(["original contents"], name, { type });
      const prepared = validatePrivateUploadFile(file);
      expect(prepared.type).toBe(expected);
      expect(await prepared.text()).toBe("original contents");
    }
  });
});
