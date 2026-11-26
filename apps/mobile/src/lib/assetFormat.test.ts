import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { assertApprovedAssetBytes, pngSignature } from '../../scripts/asset-format.mjs';

const validSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const disguisedFormats: Array<[string, Buffer]> = [
  ['ICNS', Buffer.from('icns\0\0\0\u0010 payload <svg></svg>')],
  ['JXL', Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from(' payload <svg></svg>')])],
  ['HEIF', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic payload <svg></svg>')])],
];

describe('mobile build asset format gate', () => {
  it('accepts PNG signatures and SVG documents at their real document start', () => {
    expect(() => assertApprovedAssetBytes('icon.png', Buffer.concat([pngSignature, Buffer.from('fixture')]))).not.toThrow();
    expect(() => assertApprovedAssetBytes('icon.svg', validSvg)).not.toThrow();
    expect(() => assertApprovedAssetBytes(
      'declared.svg',
      Buffer.from('\uFEFF  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    )).not.toThrow();
    expect(() => assertApprovedAssetBytes('commented.svg', Buffer.from('<!-- created by a design tool -->\n<svg/>'))).not.toThrow();
    expect(() => assertApprovedAssetBytes(
      'declared-doctype.svg',
      Buffer.from('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg/>'),
    )).not.toThrow();
  });

  for (const [format, bytes] of disguisedFormats) {
    it.each(['svg', 'png'])(`rejects ${format} magic hidden behind a .%s extension and later SVG tag`, (extension) => {
      expect(() => assertApprovedAssetBytes(`disguised.${extension}`, bytes)).toThrow(/cannot disguise another image parser input/u);
    });
  }

  it('rejects unapproved extensions', () => {
    expect(() => assertApprovedAssetBytes('photo.heic', Buffer.from('fixture'))).toThrow(/unapproved image format/u);
  });

  it('rejects overlapping and repeated prologues in bounded time', () => {
    const adversarialPrefixes = [
      '<!--->'.repeat(80) + 'junk',
      '<?xml ?>'.repeat(200) + 'junk',
      '<!-- -->'.repeat(200) + 'junk',
    ];
    const started = performance.now();
    for (const [index, prefix] of adversarialPrefixes.entries()) {
      expect(() => assertApprovedAssetBytes(`pathological-${index}.svg`, Buffer.from(prefix))).toThrow(/must begin with an SVG document/u);
    }
    expect(performance.now() - started).toBeLessThan(250);
  });
});
