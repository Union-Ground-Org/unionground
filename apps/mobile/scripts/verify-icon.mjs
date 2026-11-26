import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import pngjs from 'pngjs';
import sharp from 'sharp';

import { assertApprovedAssetBytes, pngSignature } from './asset-format.mjs';

const { PNG } = pngjs;
const iconPath = new URL('../assets/icon.png', import.meta.url);
const masterPath = new URL('../assets/icon-master.svg', import.meta.url);
const assetsPath = new URL('../assets/', import.meta.url);
const assetsDirectory = fileURLToPath(assetsPath);
const master = readFileSync(masterPath, 'utf8');

for (const entry of readdirSync(assetsPath, { withFileTypes: true })) {
  assert(entry.isFile(), `assets/${entry.name} must be a regular file`);
  assertApprovedAssetBytes(entry.name, readFileSync(join(assetsDirectory, entry.name)));
}

if (process.argv.includes('--write')) {
  await sharp(Buffer.from(master))
    .resize(1024, 1024)
    .removeAlpha()
    .withMetadata({ icc: 'srgb' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(fileURLToPath(iconPath));
}

const source = readFileSync(iconPath);

// The neutral placeholder icon every unbranded build ships: a white rounded
// outline, full-bleed on slate. Official builds use branding/official/ instead
// (app.config.ts). The master SVG is the only source; icon.png must be its
// exact render.
for (const contract of [
  'width="1024" height="1024" viewBox="0 0 1024 1024"',
  '<rect width="1024" height="1024" fill="#3f4a46"/>',
  '<rect x="320" y="320" width="384" height="384" rx="96" fill="none" stroke="#ffffff" stroke-width="64"/>',
]) assert(master.includes(contract), `icon-master.svg is missing the source contract: ${contract}`);
assert(!/#efa738|#0a2f26|#15573f/i.test(master), 'icon-master.svg must not carry the Union Ground mark colours');

assert(source.subarray(0, 8).equals(pngSignature), 'icon.png must have a valid PNG signature');

const chunks = [];
let offset = 8;
while (offset < source.length) {
  assert(offset + 12 <= source.length, 'icon.png contains a truncated PNG chunk');
  const length = source.readUInt32BE(offset);
  const type = source.toString('ascii', offset + 4, offset + 8);
  const dataStart = offset + 8;
  const dataEnd = dataStart + length;
  assert(dataEnd + 4 <= source.length, `icon.png contains a truncated ${type} chunk`);
  chunks.push({ type, data: source.subarray(dataStart, dataEnd) });
  offset = dataEnd + 4;
}

assert.equal(offset, source.length, 'icon.png must end at a complete PNG chunk boundary');
assert.equal(chunks[0]?.type, 'IHDR', 'icon.png must begin with IHDR');
assert.equal(chunks.at(-1)?.type, 'IEND', 'icon.png must end with IEND');
const embeddedSrgbProfile = chunks.some(({ type, data }) => {
  if (type === 'sRGB') return true;
  if (type !== 'iCCP') return false;
  const nameEnd = data.indexOf(0);
  if (nameEnd < 1 || data[nameEnd + 1] !== 0) return false;
  const profile = inflateSync(data.subarray(nameEnd + 2));
  const utf16Srgb = Buffer.from([0, 0x73, 0, 0x52, 0, 0x47, 0, 0x42]);
  return profile.toString('ascii', 16, 20) === 'RGB '
    && profile.toString('ascii', 36, 40) === 'acsp'
    && profile.includes(utf16Srgb);
});
assert(embeddedSrgbProfile, 'icon.png must declare sRGB with an sRGB or iCCP chunk');
assert(!chunks.some(({ type }) => type === 'tRNS'), 'icon.png must not contain transparency');

const ihdr = chunks[0].data;
assert.equal(ihdr.readUInt32BE(0), 1024, 'icon.png width must be exactly 1024px');
assert.equal(ihdr.readUInt32BE(4), 1024, 'icon.png height must be exactly 1024px');
assert.equal(ihdr[8], 8, 'icon.png must use 8-bit channels');
assert.equal(ihdr[9], 2, 'icon.png must be truecolor RGB (PNG color type 2)');
assert.equal(ihdr[12], 0, 'icon.png must be non-interlaced');

const decoded = PNG.sync.read(source, { checkCRC: true });
assert.equal(decoded.width, 1024);
assert.equal(decoded.height, 1024);

const rendered = await sharp(Buffer.from(master))
  .resize(1024, 1024)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
assert.deepEqual(
  { width: rendered.info.width, height: rendered.info.height, channels: rendered.info.channels },
  { width: 1024, height: 1024, channels: 3 },
  'the pinned SVG renderer must produce a 1024px RGB raster',
);
for (let renderedIndex = 0, pngIndex = 0; renderedIndex < rendered.data.length; renderedIndex += 3, pngIndex += 4) {
  for (let channel = 0; channel < 3; channel += 1) {
    assert.equal(
      decoded.data[pngIndex + channel],
      rendered.data[renderedIndex + channel],
      `icon.png must exactly match icon-master.svg at RGB byte ${renderedIndex + channel}`,
    );
  }
}

function pixelAt(x, y) {
  const index = (y * decoded.width + x) * 4;
  return Array.from(decoded.data.subarray(index, index + 4));
}

function nearColor(pixel, target, tolerance) {
  return target.every((channel, index) => Math.abs(pixel[index] - channel) <= tolerance);
}

function assertNearColor(x, y, target, tolerance, label) {
  assert(
    nearColor(pixelAt(x, y), target, tolerance),
    `${label} at ${x},${y} must be near rgb(${target.join(',')}); got rgba(${pixelAt(x, y).join(',')})`,
  );
}

for (let index = 3; index < decoded.data.length; index += 4) {
  assert.equal(decoded.data[index], 255, 'every decoded icon pixel must be fully opaque');
}

const slate = [63, 74, 70];
const white = [255, 255, 255];

for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023]]) {
  assertNearColor(x, y, slate, 1, 'full-bleed slate corner');
}

function isSlate(pixel) {
  return nearColor(pixel, slate, 2) && pixel[3] === 255;
}

for (let coordinate = 0; coordinate < 1024; coordinate += 1) {
  assert(isSlate(pixelAt(coordinate, 0)), 'the top edge must be painted slate, not pre-masked');
  assert(isSlate(pixelAt(coordinate, 1023)), 'the bottom edge must be painted slate, not pre-masked');
  assert(isSlate(pixelAt(0, coordinate)), 'the left edge must be painted slate, not pre-masked');
  assert(isSlate(pixelAt(1023, coordinate)), 'the right edge must be painted slate, not pre-masked');
}

// The outline sits centred, inside the 66% safe zone every launcher keeps.
let whiteCount = 0;
let minX = 1024;
let minY = 1024;
let maxX = -1;
let maxY = -1;
for (let y = 0; y < 1024; y += 1) {
  for (let x = 0; x < 1024; x += 1) {
    if (!nearColor(pixelAt(x, y), white, 3)) continue;
    whiteCount += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
}
assert(whiteCount > 0, 'icon.png must contain the white outline');
assert(minX >= 174 && minY >= 174 && maxX <= 850 && maxY <= 850, 'the outline must stay inside the launcher safe zone');
assert(Math.abs((minX + maxX) / 2 - 511.5) <= 2 && Math.abs((minY + maxY) / 2 - 511.5) <= 2, 'the outline must be centred');
assertNearColor(512, 512, slate, 1, 'outline interior');
assertNearColor(512, 320, white, 1, 'outline stroke');

const digest = createHash('sha256').update(source).digest('hex');
console.log(`iOS icon verified: 1024x1024 opaque sRGB RGB; sha256=${digest}`);
