import sharp from "sharp";

const reject = (reason) => { throw new Error(`private-file-image-${reason}`); };

function dimensions(width, height, budget) {
  if (!width || !height || width > 16384 || height > 16384) reject("profile");
  const size = width * height * 4;
  if (size > budget.remaining) reject("expanded-size");
  budget.remaining -= size;
  return { width, height, size };
}

function jpegContainer(bytes, budget) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) throw new Error("private-file-mime-mismatch");
  let offset = 2;
  let frame;
  let scans = 0;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) reject("marker");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || !scans || offset !== bytes.length) reject("trailing-or-missing-data");
      return frame;
    }
    // A narrow, metadata-free baseline/progressive profile. APP0 JFIF and
    // APP14 Adobe carry decoding parameters; arbitrary APP/COM payloads do not.
    if (![0xc0, 0xc2, 0xc4, 0xdb, 0xdd, 0xda, 0xe0, 0xee].includes(marker)) reject("metadata-or-profile");
    if (offset + 2 > bytes.length) reject("truncated");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) reject("truncated");
    const data = bytes.subarray(offset + 2, offset + length);
    offset += length;
    if (marker === 0xe0 && (data.length !== 14 || data.toString("ascii", 0, 5) !== "JFIF\0"
      || data[12] !== 0 || data[13] !== 0)) reject("metadata");
    if (marker === 0xee && (data.length !== 12 || data.toString("ascii", 0, 5) !== "Adobe")) reject("metadata");
    if ([0xc0, 0xc2].includes(marker)) {
      if (frame || data.length < 6 || data[0] !== 8 || ![1, 3].includes(data[5])
        || data.length !== 6 + data[5] * 3) reject("profile");
      frame = dimensions(data.readUInt16BE(3), data.readUInt16BE(1), budget);
    }
    if (marker === 0xda) {
      if (!frame || !data.length || data.length !== 4 + 2 * data[0]) reject("profile");
      scans += 1;
      // Entropy data may contain stuffed FF bytes and restart markers. The
      // next other marker returns to the segment parser, including later scans.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const start = offset++;
        while (bytes[offset] === 0xff) offset += 1;
        if (bytes[offset] === 0 || (bytes[offset] >= 0xd0 && bytes[offset] <= 0xd7)) { offset += 1; continue; }
        offset = start;
        break;
      }
    }
  }
  reject("missing-end");
}

function webpContainer(bytes, budget) {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WEBP") throw new Error("private-file-mime-mismatch");
  if (bytes.readUInt32LE(4) !== bytes.length - 8) reject("trailing-or-truncated");
  let offset = 12;
  let frame;
  let extended;
  let alpha = false;
  const seen = new Set();
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) reject("truncated");
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length + (length % 2) > bytes.length) reject("truncated");
    const data = bytes.subarray(offset, offset + length);
    offset += length;
    if (length % 2 && bytes[offset++] !== 0) reject("padding");
    if (!["VP8X", "ALPH", "VP8 ", "VP8L"].includes(type)) reject("metadata-or-animation");
    if (seen.has(type) || frame) reject("chunk-order");
    seen.add(type);
    if (type === "VP8X") {
      if (seen.size !== 1 || length !== 10 || (data[0] & ~0x10) || data[1] || data[2] || data[3]) reject("metadata-or-animation");
      extended = { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1, alpha: !!(data[0] & 0x10) };
    } else if (type === "ALPH") {
      if (!extended?.alpha || !length) reject("profile");
      alpha = true;
    } else if (type === "VP8 ") {
      if (length < 10 || (data[0] & 1) || !data.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
        || (extended && extended.alpha !== alpha)) reject("profile");
      frame = dimensions(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff, budget);
    } else {
      if (length < 5 || data[0] !== 0x2f || (data[4] & 0xe0) || alpha) reject("profile");
      const packed = data.readUInt32LE(1);
      frame = dimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1, budget);
      if (extended && extended.alpha !== !!(packed & 0x10000000)) reject("profile");
    }
  }
  if (!frame || (extended && (extended.width !== frame.width || extended.height !== frame.height))) reject("profile");
  return frame;
}

/** Only called inside the isolated inspector. The container walk accounts for
 * every byte and reserves a shared RGBA budget before native pixel decoding.
 * Metadata inspection by itself cannot detect damaged entropy data. */
export async function inspectPrivateRaster(bytes, format, budget) {
  const frame = format === "jpeg" ? jpegContainer(bytes, budget) : webpContainer(bytes, budget);
  let decoded;
  try {
    decoded = await sharp(bytes, {
      failOn: "warning", limitInputPixels: frame.width * frame.height,
      limitInputChannels: 4, sequentialRead: true,
    }).timeout({ seconds: 1 }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch { reject("decode"); }
  if (decoded.info.width !== frame.width || decoded.info.height !== frame.height
    || decoded.info.channels !== 4 || decoded.data.length !== frame.size) reject("decode-size");
}
