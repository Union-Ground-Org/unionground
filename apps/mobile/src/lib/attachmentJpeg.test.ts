import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { inspectPrivateFileBytes } from '../../../../api/_lib/privateFileSafety.js';
import { attachmentImageSize, stripAttachmentJpegMetadata } from './attachmentJpeg';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../services/fixtures/${name}`, import.meta.url)));
const inspect = (bytes: Uint8Array) => inspectPrivateFileBytes(bytes, { filename: 'blank.jpg', mimeType: 'image/jpeg', expectedSize: bytes.length });

describe('attachment JPEG preparation at the server boundary', () => {
  it('removes actual UIKit EXIF without changing rendered pixels or scan data', async () => {
    const original = fixture('ios-uikit-blank-64.jpg');
    await expect(inspect(original)).rejects.toThrow('private-file-image-metadata-or-profile');
    const normalized = stripAttachmentJpegMetadata(original);
    expect((await sharp(normalized).metadata()).exif).toBeUndefined();
    await expect(inspect(normalized)).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    expect(await sharp(normalized).raw().toBuffer()).toEqual(await sharp(original).raw().toBuffer());
    expect(stripAttachmentJpegMetadata(normalized)).toEqual(normalized);
  });

  it('demonstrates why the 12 MP native output also needs bounded dimensions', async () => {
    const original = fixture('ios-uikit-blank-4032.jpg');
    const metadataFree = stripAttachmentJpegMetadata(original);
    await expect(inspect(metadataFree)).rejects.toThrow('private-file-image-expanded-size');
    const dimensions = attachmentImageSize(4032, 3024);
    const resized = await sharp(original).resize(dimensions.width, dimensions.height).jpeg().toBuffer();
    await expect(inspect(stripAttachmentJpegMetadata(resized))).resolves.toMatchObject({ mimeType: 'image/jpeg' });
  });

  it.each([[4032, 3024], [3024, 4032], [8064, 6048], [10000, 1], [64, 64], [1, 1]])(
    'preserves aspect ratio without upscaling %ix%i', (width, height) => {
      const out = attachmentImageSize(width, height);
      expect(out.width).toBeGreaterThan(0); expect(out.height).toBeGreaterThan(0);
      expect(out.width).toBeLessThanOrEqual(width); expect(out.height).toBeLessThanOrEqual(height);
      expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(2048);
      expect(out.width * out.height * 4).toBeLessThan(25 * 1024 * 1024);
      expect(Math.abs(out.width * height - out.height * width)).toBeLessThanOrEqual(Math.max(width, height));
    },
  );

  it.each([0, -1, NaN, Infinity, 1.5])('refuses invalid dimension %s', (value) => {
    expect(() => attachmentImageSize(value, 20)).toThrow();
    expect(() => attachmentImageSize(20, value)).toThrow();
  });

  it('refuses truncation, malformed metadata lengths, and trailing payloads', () => {
    const bytes = fixture('ios-uikit-blank-64.jpg');
    for (const end of [0, 1, 3, 8, bytes.length - 1, bytes.length - 2]) {
      expect(() => stripAttachmentJpegMetadata(bytes.subarray(0, end))).toThrow();
    }
    const trailing = new Uint8Array(bytes.length + 4); trailing.set(bytes); trailing.set([80, 75, 3, 4], bytes.length);
    expect(() => stripAttachmentJpegMetadata(trailing)).toThrow();
    const malformed = new Uint8Array(bytes.length + 4); malformed.set([255, 216, 255, 225, 255, 255]); malformed.set(bytes.subarray(2), 6);
    expect(() => stripAttachmentJpegMetadata(malformed)).toThrow();
  });

  it('retains multi-scan progressive JPEG decoding', async () => {
    const progressive = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#aabbcc' } }).jpeg({ progressive: true }).toBuffer();
    const normalized = stripAttachmentJpegMetadata(progressive);
    await expect(inspect(normalized)).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    expect(await sharp(normalized).raw().toBuffer()).toEqual(await sharp(progressive).raw().toBuffer());
  });
});
