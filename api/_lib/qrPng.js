import { crc32, deflateSync } from "node:zlib";
import { makeQrMatrix, QR_QUIET_ZONE } from "../../src/lib/qrCode.js";

// An 8-bit grayscale PNG of a QR code, built in-process so the encoded link
// never reaches a third-party image service. Email clients cannot render
// inline SVG, so invitation mail attaches this PNG inline (cid:).

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

export function qrPng(text, scale = 6) {
  const matrix = makeQrMatrix(text);
  const width = (matrix.length + QR_QUIET_ZONE * 2) * scale;
  const rows = Buffer.alloc((width + 1) * width, 255);
  for (let y = 0; y < width; y += 1) {
    const rowStart = y * (width + 1);
    rows[rowStart] = 0; // Filter type: none.
    const moduleY = Math.floor(y / scale) - QR_QUIET_ZONE;
    for (let x = 0; x < width; x += 1) {
      const moduleX = Math.floor(x / scale) - QR_QUIET_ZONE;
      if (matrix[moduleY]?.[moduleX] === true) rows[rowStart + 1 + x] = 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header[8] = 8; // Bit depth.
  header[9] = 0; // Grayscale.
  return {
    width,
    png: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  };
}
