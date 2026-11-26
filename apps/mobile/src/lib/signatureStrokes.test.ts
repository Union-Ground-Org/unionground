import { describe, expect, it } from 'vitest';

import {
  MAX_POINTS_PER_STROKE,
  MAX_SIGNATURE_POINTS,
  MAX_SIGNATURE_STROKES,
  appendSignaturePoint,
  beginSignatureStroke,
  finishSignatureStroke,
  signatureIsSendable,
  signaturePoint,
  type SignatureStrokes,
} from './signatureStrokes';

// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699):
// strokes the phone sends to sign_member_form are what
// private.validate_form_signature_strokes accepts.
describe('signature strokes', () => {
  it('scales a touch into the 0-1000 integer grid whatever the pad size, clamped at the edges', () => {
    expect(signaturePoint(150, 45, 300, 90)).toEqual({ x: 500, y: 500 });
    expect(signaturePoint(-20, 200, 300, 90)).toEqual({ x: 0, y: 1000 });
    expect(signaturePoint(100.4, 30.2, 333, 97)).toEqual({ x: 302, y: 311 });
    expect(signaturePoint(10, 10, 0, 0)).toEqual({ x: 1000, y: 1000 });
  });

  it('turns a tap into a two-point dot, as the web pad does', () => {
    const tapped = beginSignatureStroke([], { x: 1000, y: 40 }).strokes;
    expect(signatureIsSendable(tapped)).toBe(false);
    const finished = finishSignatureStroke(tapped);
    expect(finished).toEqual([[{ x: 1000, y: 40 }, { x: 999, y: 40 }]]);
    expect(signatureIsSendable(finished)).toBe(true);
  });

  it('stops at the server’s stroke, per-stroke and total point limits', () => {
    let strokes: SignatureStrokes = [];
    for (let index = 0; index < MAX_SIGNATURE_STROKES; index += 1) strokes = finishSignatureStroke(beginSignatureStroke(strokes, { x: index, y: 1 }).strokes);
    expect(beginSignatureStroke(strokes, { x: 5, y: 5 }).capped).toBe(true);

    let long = beginSignatureStroke([], { x: 0, y: 0 }).strokes;
    for (let index = 1; index < MAX_POINTS_PER_STROKE; index += 1) long = appendSignaturePoint(long, { x: index % 1000, y: Math.floor(index / 1000) }).strokes;
    expect(long[0]).toHaveLength(MAX_POINTS_PER_STROKE);
    expect(appendSignaturePoint(long, { x: 7, y: 7 }).capped).toBe(true);
    expect(signatureIsSendable(long)).toBe(true);

    const full: SignatureStrokes = Array.from({ length: 4 }, (_, stroke) => Array.from({ length: 500 }, (__, index) => ({ x: index, y: stroke })));
    expect(full.flat()).toHaveLength(MAX_SIGNATURE_POINTS);
    expect(beginSignatureStroke(full, { x: 1, y: 9 }).capped).toBe(true);
    expect(signatureIsSendable([...full, [{ x: 1, y: 9 }, { x: 2, y: 9 }]])).toBe(false);
  });

  it('skips a repeated point and sends only integer points inside the grid', () => {
    const begun = beginSignatureStroke([], { x: 10, y: 10 }).strokes;
    expect(appendSignaturePoint(begun, { x: 10, y: 10 }).strokes).toBe(begun);
    expect(signatureIsSendable([])).toBe(false);
    expect(signatureIsSendable([[{ x: 1.5, y: 2 }, { x: 3, y: 4 }]])).toBe(false);
    expect(signatureIsSendable([[{ x: -1, y: 2 }, { x: 3, y: 4 }]])).toBe(false);
  });
});
