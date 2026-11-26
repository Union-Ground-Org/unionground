// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699):
// a drawn form signature in the shape sign_member_form and respond_to_cosign
// accept (private.validate_form_signature_strokes): 1-64 strokes of 2-512
// points, at most 2,000 points, each point exactly { x, y } with integers from
// 0 to 1000. The web pad (src/components/SignaturePad.jsx) scales and caps the
// same way, so a phone signature and a web signature read alike.
export const SIGNATURE_LIMIT = 1000;
export const MAX_SIGNATURE_STROKES = 64;
export const MAX_POINTS_PER_STROKE = 512;
export const MAX_SIGNATURE_POINTS = 2000;

export type SignaturePoint = { x: number; y: number };
export type SignatureStrokes = SignaturePoint[][];
export type StrokeChange = { strokes: SignatureStrokes; capped: boolean };

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(SIGNATURE_LIMIT, Math.round(value))) : 0;
}

// A touch at (x, y) inside a pad of the given size, in the 0-1000 grid.
export function signaturePoint(x: number, y: number, width: number, height: number): SignaturePoint {
  return {
    x: clamp((x / Math.max(1, width)) * SIGNATURE_LIMIT),
    y: clamp((y / Math.max(1, height)) * SIGNATURE_LIMIT),
  };
}

export function signaturePointCount(strokes: SignatureStrokes): number {
  return strokes.reduce((total, stroke) => total + stroke.length, 0);
}

export function beginSignatureStroke(strokes: SignatureStrokes, point: SignaturePoint): StrokeChange {
  if (strokes.length >= MAX_SIGNATURE_STROKES || signaturePointCount(strokes) >= MAX_SIGNATURE_POINTS) return { strokes, capped: true };
  return { strokes: [...strokes, [point]], capped: false };
}

export function appendSignaturePoint(strokes: SignatureStrokes, point: SignaturePoint): StrokeChange {
  const active = strokes.at(-1);
  if (!active || active.length >= MAX_POINTS_PER_STROKE || signaturePointCount(strokes) >= MAX_SIGNATURE_POINTS) return { strokes, capped: true };
  const last = active.at(-1);
  if (last && last.x === point.x && last.y === point.y) return { strokes, capped: false };
  return { strokes: [...strokes.slice(0, -1), [...active, point]], capped: false };
}

// A tap leaves a one-point stroke, which the server refuses; it becomes a dot
// two points long, as on the web.
export function finishSignatureStroke(strokes: SignatureStrokes): SignatureStrokes {
  const active = strokes.at(-1);
  const point = active?.[0];
  if (!active || !point || active.length !== 1) return strokes;
  const neighbour = { x: point.x < SIGNATURE_LIMIT ? point.x + 1 : point.x - 1, y: point.y };
  if (signaturePointCount(strokes) >= MAX_SIGNATURE_POINTS) return strokes.slice(0, -1);
  return [...strokes.slice(0, -1), [point, neighbour]];
}

// What the server will accept, checked before anything is sent.
export function signatureIsSendable(strokes: SignatureStrokes): boolean {
  if (strokes.length < 1 || strokes.length > MAX_SIGNATURE_STROKES) return false;
  if (signaturePointCount(strokes) > MAX_SIGNATURE_POINTS) return false;
  return strokes.every((stroke) => stroke.length >= 2 && stroke.length <= MAX_POINTS_PER_STROKE
    && stroke.every((point) => Number.isInteger(point.x) && Number.isInteger(point.y)
      && point.x >= 0 && point.x <= SIGNATURE_LIMIT && point.y >= 0 && point.y <= SIGNATURE_LIMIT));
}
