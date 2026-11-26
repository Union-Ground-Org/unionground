import assert from 'node:assert/strict';
import { extname } from 'node:path';

export const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const whitespace = /\s/u;

function skipWhitespace(source, start) {
  let cursor = start;
  while (cursor < source.length && whitespace.test(source[cursor])) cursor += 1;
  return cursor;
}

function hasSvgDocumentStart(asset) {
  const source = asset.subarray(0, 4096).toString('utf8');
  let cursor = source.startsWith('\uFEFF') ? 1 : 0;
  cursor = skipWhitespace(source, cursor);

  while (cursor < source.length) {
    let tokenEnd;
    if (source.startsWith('<?xml', cursor)) {
      tokenEnd = source.indexOf('?>', cursor + 5);
      if (tokenEnd < 0) return false;
      cursor = tokenEnd + 2;
    } else if (source.startsWith('<!--', cursor)) {
      tokenEnd = source.indexOf('-->', cursor + 4);
      if (tokenEnd < 0) return false;
      cursor = tokenEnd + 3;
    } else if (source.startsWith('<!DOCTYPE', cursor)) {
      tokenEnd = source.indexOf('>', cursor + 9);
      if (tokenEnd < 0) return false;
      const declaration = source.slice(cursor, tokenEnd + 1);
      if (!/^<!DOCTYPE\s+svg(?:\s|>)/u.test(declaration)) return false;
      cursor = tokenEnd + 1;
    } else {
      break;
    }
    cursor = skipWhitespace(source, cursor);
  }

  if (!source.startsWith('<svg', cursor)) return false;
  const delimiter = source[cursor + 4];
  return delimiter === '/' || delimiter === '>' || (delimiter !== undefined && whitespace.test(delimiter));
}

export function assertApprovedAssetBytes(name, asset) {
  const extension = extname(name).toLowerCase();
  assert(
    extension === '.png' || extension === '.svg',
    `assets/${name} uses an unapproved image format; only inspected PNG and SVG inputs are allowed`,
  );

  if (extension === '.png') {
    assert(
      asset.subarray(0, pngSignature.length).equals(pngSignature),
      `assets/${name} must contain PNG bytes and cannot disguise another image parser input`,
    );
    return;
  }

  assert(
    hasSvgDocumentStart(asset),
    `assets/${name} must begin with an SVG document and cannot disguise another image parser input`,
  );
}
