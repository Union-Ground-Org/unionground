// @vitest-environment node
import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import sharp from "sharp";
import { makeQrMatrix, QR_QUIET_ZONE, qrSvgPath } from "../src/lib/qrCode.js";
import { qrPng } from "../api/_lib/qrPng.js";

function decodeMatrix(matrix, scale = 6) {
  const width = (matrix.length + QR_QUIET_ZONE * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dark = matrix[Math.floor(y / scale) - QR_QUIET_ZONE]?.[Math.floor(x / scale) - QR_QUIET_ZONE] === true;
      const offset = (y * width + x) * 4;
      data.fill(dark ? 0 : 255, offset, offset + 3);
      data[offset + 3] = 255;
    }
  }
  return jsQR(data, width, width, { inversionAttempts: "dontInvert" });
}

describe("general QR encoder", () => {
  it("round-trips URLs across every supported version", () => {
    const seen = new Set();
    for (const length of [1, 10, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412]) {
      const text = `https://app.example.org/get-app#${"x".repeat(Math.max(0, length - 28))}`.slice(0, length);
      const matrix = makeQrMatrix(text);
      seen.add(matrix.length);
      expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
      expect(decodeMatrix(matrix)?.data).toBe(text);
    }
    // Versions 1 through 15 (21 to 77 modules) are all exercised.
    expect(Math.min(...seen)).toBe(21);
    expect(Math.max(...seen)).toBe(77);
    expect(seen.size).toBe(15);
  });

  it("encodes UTF-8 and the real invitation link shapes", () => {
    for (const text of [
      "https://app.example.org/get-app",
      `https://app.example.org/invite#invite=${"A".repeat(43)}`,
      "https://app.example.org/get-app?lang=es&ñ=1",
    ]) expect(decodeMatrix(makeQrMatrix(text))?.data).toBe(text);
  });

  it("refuses empty and oversized payloads", () => {
    expect(() => makeQrMatrix("")).toThrow(/empty/);
    expect(() => makeQrMatrix("x".repeat(413))).toThrow(/too long/);
  });

  it("is deterministic and draws only dark modules into the SVG path", () => {
    const matrix = makeQrMatrix("https://app.example.org/get-app");
    expect(makeQrMatrix("https://app.example.org/get-app")).toEqual(matrix);
    const dark = matrix.flat().filter(Boolean).length;
    expect(qrSvgPath(matrix).match(/M/g)).toHaveLength(dark);
  });

  it("renders a scannable grayscale PNG for email", async () => {
    const { png, width } = qrPng("https://app.example.org/get-app");
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(width);
    expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toBe("https://app.example.org/get-app");
  });
});
