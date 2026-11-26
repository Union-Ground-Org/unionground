import { androidSingleFaceFamilies, type EmbeddedWeight, type FontFamilyName } from '../theme/tokens';

// Which embedded face a Text draws in
// (UX-UG-NATIVE-ARCHIVO-AND-PUBLIC-SANS-TYPEFACES-20261115). The app's
// Text and TextInput (src/components/Text.tsx) pass their own style here.
//
// - A Text that names another family (Archivo through a heading role, Georgia,
//   an icon font) keeps it, and so do the Texts nested in it.
// - Otherwise the text is Public Sans: an outermost Text with no weight gets
//   the family only, and a nested one inherits everything.
// - A weight picks an embedded Public Sans face: 100 to 400 Regular, 500
//   Medium, 600 SemiBold, 700 and heavier Bold (there is no Public Sans 800).
//   On Android before API 28 the in-between weights take their single-face
//   family, because a family there yields only its normal and bold faces.

export type TextFaceInput = {
  fontFamily?: string | null;
  fontWeight?: string | number | null;
};

export type TextFace = { fontFamily: FontFamilyName; fontWeight?: EmbeddedWeight };

const PUBLIC_SANS: FontFamilyName = 'Public Sans';
const publicSansFamilies: readonly string[] = [PUBLIC_SANS, ...Object.values(androidSingleFaceFamilies)];

export function embeddedPublicSansWeight(weight: string | number): EmbeddedWeight {
  const value = weight === 'bold' ? 700 : weight === 'normal' ? 400 : Number(weight);
  if (!Number.isFinite(value) || value <= 400) return '400';
  if (value < 600) return '500';
  if (value < 700) return '600';
  return '700';
}

/**
 * The face style a Text adds over its own style, or null to add nothing.
 * `inheritedFamily` is the family the nearest enclosing Text resolved, or null
 * for an outermost Text. `singleFaceFamilies` is true on Android before API 28.
 */
export function textFace(own: TextFaceInput, inheritedFamily: string | null, singleFaceFamilies: boolean): TextFace | null {
  const ownFamily = own.fontFamily ?? null;
  if (ownFamily !== null && !publicSansFamilies.includes(ownFamily)) return null;
  if (ownFamily === null && inheritedFamily !== null && !publicSansFamilies.includes(inheritedFamily)) return null;
  const weightGiven = own.fontWeight !== undefined && own.fontWeight !== null;
  if (!weightGiven) {
    if (ownFamily !== null || inheritedFamily !== null) return null;
    return { fontFamily: PUBLIC_SANS };
  }
  const fontWeight = embeddedPublicSansWeight(own.fontWeight as string | number);
  const single = singleFaceFamilies ? androidSingleFaceFamilies[fontWeight] : undefined;
  return { fontFamily: single ?? PUBLIC_SANS, fontWeight };
}

/**
 * The font family and weight a style ends with: style arrays apply in order,
 * later entries winning, and false, null and undefined entries are skipped.
 */
export function flattenTextStyle(style: unknown): TextFaceInput {
  const flat: TextFaceInput = {};
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) { entry.forEach(visit); return; }
    if (!entry || typeof entry !== 'object') return;
    const record = entry as TextFaceInput;
    if ('fontFamily' in record && record.fontFamily !== undefined) flat.fontFamily = record.fontFamily;
    if ('fontWeight' in record && record.fontWeight !== undefined) flat.fontWeight = record.fontWeight;
  };
  visit(style);
  return flat;
}

/** The family a Text's children inherit: what it resolved, its own, or its parent's. */
export function resolvedTextFamily(own: TextFaceInput, face: TextFace | null, inheritedFamily: string | null): string | null {
  return face?.fontFamily ?? own.fontFamily ?? inheritedFamily;
}
