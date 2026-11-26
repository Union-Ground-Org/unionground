// A 2048-square raster occupies at most 16 MiB as RGBA, below the server's
// shared 25 MiB expansion budget. JPEG compression alone does not bound this.
export const ATTACHMENT_IMAGE_MAX_EDGE = 2048;
const MAX_JPEG_BYTES = 10 * 1024 * 1024;

export function attachmentImageSize(width: number, height: number) {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('attachment-image-dimensions');
  }
  const scale = Math.min(1, ATTACHMENT_IMAGE_MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** Native re-encoding fixes orientation, but UIImage.jpegData still emits
 * EXIF. Remove ancillary APP/COM segments from the freshly rendered JPEG;
 * keep decoding parameters and every compressed scan byte unchanged. This is
 * not a safety verdict: the server still validates and scans the result.
 */
export function stripAttachmentJpegMetadata(bytes: Uint8Array): Uint8Array {
  const fail = (): never => { throw new Error('attachment-jpeg-container'); };
  if (bytes.length < 4 || bytes.length > MAX_JPEG_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail();
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let scans = 0;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) fail();
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined) return fail();
    if (marker === 0xd9) {
      if (!scans || offset !== bytes.length) fail();
      parts.push(bytes.subarray(start, offset));
      const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
      let cursor = 0;
      for (const part of parts) { result.set(part, cursor); cursor += part.length; }
      return result;
    }
    // Standalone markers cannot occur outside entropy data. Unknown segment
    // types also fail here rather than being turned into a different file.
    if (![0xc0, 0xc2, 0xc4, 0xdb, 0xdd, 0xda, 0xfe].includes(marker)
      && !(marker >= 0xe0 && marker <= 0xef)) fail();
    if (offset + 2 > bytes.length) fail();
    const length = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) fail();
    offset += length;
    // APP0 JFIF and APP14 Adobe are decoding parameters, not free-form data.
    const ancillary = marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xee);
    if (!ancillary) parts.push(bytes.subarray(start, offset));
    if (marker === 0xda) {
      scans += 1;
      const entropyStart = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const nextMarker = offset++;
        while (bytes[offset] === 0xff) offset += 1;
        const code = bytes[offset];
        if (code === 0 || (code !== undefined && code >= 0xd0 && code <= 0xd7)) { offset += 1; continue; }
        offset = nextMarker;
        break;
      }
      parts.push(bytes.subarray(entropyStart, offset));
    }
  }
  return fail();
}
