// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import jsQR from "jsqr";
import { CHECKIN_TOKEN_ALPHABET, makeCheckinQrMatrix } from "../src/lib/checkinQr.js";

function decodeMatrix(matrix, scale = 8, quiet = 4) {
  const width = (matrix.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const moduleX = Math.floor(x / scale) - quiet;
      const moduleY = Math.floor(y / scale) - quiet;
      const dark = matrix[moduleY]?.[moduleX] === true;
      const offset = (y * width + x) * 4;
      data[offset] = dark ? 0 : 255;
      data[offset + 1] = dark ? 0 : 255;
      data[offset + 2] = dark ? 0 : 255;
      data[offset + 3] = 255;
    }
  }
  return jsQR(data, width, width, { inversionAttempts: "dontInvert" });
}

describe("event check-in QR encoding", () => {
  it("produces a deterministic Version 1 QR matrix for the seven-character token", () => {
    const first = makeCheckinQrMatrix("ABC1234");
    const second = makeCheckinQrMatrix("abc1234");

    expect(first).toEqual(second);
    expect(first).toHaveLength(21);
    expect(first.every((row) => row.length === 21 && row.every((cell) => typeof cell === "boolean"))).toBe(true);
    expect(first.slice(0, 7).map((row) => row.slice(0, 7))).toEqual([
      [true, true, true, true, true, true, true],
      [true, false, false, false, false, false, true],
      [true, false, true, true, true, false, true],
      [true, false, true, true, true, false, true],
      [true, false, true, true, true, false, true],
      [true, false, false, false, false, false, true],
      [true, true, true, true, true, true, true],
    ]);
  });

  it("rejects values outside the server token alphabet and length", () => {
    expect(() => makeCheckinQrMatrix("ABC123")).toThrow(/seven-character/i);
    for (const symbol of CHECKIN_TOKEN_ALPHABET) expect(() => makeCheckinQrMatrix(symbol.repeat(7))).not.toThrow();
    for (const symbol of ["I", "L", "O", "U"]) expect(() => makeCheckinQrMatrix(`ABC${symbol}234`)).toThrow(/alphabet/i);
  });

  it("round-trips through an independent decoder with the rendered quiet zone", () => {
    for (const token of ["ABC1234", "0101010", "Z9Y8X7W"]) {
      expect(decodeMatrix(makeCheckinQrMatrix(token))?.data).toBe(token);
    }
  });

  // BUG-UG-CHECKIN-QR-UNSUPPORTED-STRING-AT-20261020: the odd final
  // character was read with String.prototype.at, which older supported
  // browsers do not have, so every seven-character token threw before any
  // module was drawn.
  it("encodes every token identically without String.prototype.at", () => {
    const tokens = ["ABC1234", "0101010", "Z9Y8X7W", ...[...CHECKIN_TOKEN_ALPHABET].map((symbol) => `${symbol}234567`.slice(0, 6) + symbol)];
    const native = tokens.map((token) => makeCheckinQrMatrix(token));
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "at");
    delete String.prototype.at;
    try {
      expect("ABC".at).toBeUndefined();
      tokens.forEach((token, index) => {
        const matrix = makeCheckinQrMatrix(token.toLowerCase());
        expect(matrix).toEqual(native[index]);
        expect(decodeMatrix(matrix)?.data).toBe(token);
      });
      expect(() => makeCheckinQrMatrix("ABC123")).toThrow(/seven-character/i);
      expect(() => makeCheckinQrMatrix("ABCI234")).toThrow(/alphabet/i);
    } finally {
      Object.defineProperty(String.prototype, "at", descriptor);
    }
  });

  it("keeps the demo token inside the same server alphabet", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    const token = app.match(/return \{ token: "([A-Z0-9]{7})", expiresAt:/)?.[1];
    expect(token).toMatch(new RegExp(`^[${CHECKIN_TOKEN_ALPHABET}]{7}$`));
  });
});
