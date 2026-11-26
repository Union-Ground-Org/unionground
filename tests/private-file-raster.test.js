// @vitest-environment node
import sharp from "sharp";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { inspectPrivateFileBytes } from "../api/_lib/privateFileSafety.js";
import { inspectPrivateFileInWorker } from "../api/_lib/privateFileInspection.js";

const inspect = (bytes, format) => inspectPrivateFileBytes(bytes, {
  filename: `image.${format}`, mimeType: `image/${format}`, expectedSize: bytes.length,
});
const raster = (format, options = {}, width = 16, height = 12) => sharp({
  create: { width, height, channels: 4, background: { r: 70, g: 90, b: 30, alpha: 0.5 } },
}).toFormat(format, options).toBuffer();

describe("complete private image decoding", () => {
  it.each([["jpeg", {}], ["jpeg", { progressive: true }], ["webp", {}], ["webp", { lossless: true }]])(
    "accepts metadata-free %s and binds the original bytes", async (format, options) => {
      const bytes = await raster(format, options);
      await expect(inspect(bytes, format)).resolves.toMatchObject({ mimeType: `image/${format}`, sizeBytes: bytes.length });
      await expect(inspectPrivateFileInWorker(bytes, {
        filename: `image.${format}`, mimeType: `image/${format}`, expectedSize: bytes.length,
      })).resolves.toMatchObject({ sizeBytes: bytes.length });
    },
  );

  it.each(["jpeg", "webp"])("rejects EXIF/GPS, truncation, trailing bytes and MIME spoofing for %s", async (format) => {
    const bytes = await raster(format);
    const gps = await sharp(bytes).withExif({ IFD0: { Artist: "Synthetic" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 42/1 46/1" } }).toFormat(format).toBuffer();
    await expect(inspect(gps, format)).rejects.toThrow(/metadata/);
    await expect(inspect(bytes.subarray(0, -5), format)).rejects.toThrow(/image/);
    await expect(inspect(Buffer.concat([bytes, Buffer.from("MZsynthetic")]), format)).rejects.toThrow(/image/);
    await expect(inspect(Buffer.from("synthetic"), format)).rejects.toThrow(/mime/);
  });

  it("rejects a valid JPEG header followed by damaged entropy instead of inspecting metadata alone", async () => {
    const bytes = await raster("jpeg");
    const start = bytes.indexOf(Buffer.from([0xff, 0xda]));
    const entropyStart = start + 2 + bytes.readUInt16BE(start + 2);
    const damaged = Buffer.concat([bytes.subarray(0, entropyStart), Buffer.from([0xff, 0xd9])]);
    await expect(inspect(damaged, "jpeg")).rejects.toThrow(/image/);
  });

  it.each(["jpeg", "webp"])("rejects oversized decoded %s before pixel allocation", async (format) => {
    const bytes = await raster(format, {}, 3000, 3000);
    await expect(inspect(bytes, format)).rejects.toThrow(/expanded-size/);
  });

  it("fully decodes JPEGs embedded in ordinary Office files under one shared budget", async () => {
    const jpeg = await raster("jpeg");
    const makeDocx = (image) => Buffer.from(zipSync({
      "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
      "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'),
      "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'),
      "word/media/photo.jpg": image,
    }));
    const bytes = makeDocx(jpeg);
    const metadata = { filename: "document.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", expectedSize: bytes.length };
    await expect(inspectPrivateFileBytes(bytes, metadata)).resolves.toMatchObject({ mimeType: metadata.mimeType });
    const corrupt = makeDocx(jpeg.subarray(0, -5));
    await expect(inspectPrivateFileBytes(corrupt, { ...metadata, expectedSize: corrupt.length })).rejects.toThrow(/image/);
  });
});
