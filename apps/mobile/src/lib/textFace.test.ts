import { describe, expect, it } from 'vitest';

import { embeddedPublicSansWeight, flattenTextStyle, resolvedTextFamily, textFace } from './textFace';

// UX-UG-NATIVE-ARCHIVO-AND-PUBLIC-SANS-TYPEFACES-20261115 (#8928): the
// face every Text draws in, through the app's Text (src/components/Text.tsx).
describe('textFace', () => {
  it('maps every weight to an embedded Public Sans face', () => {
    const cases: readonly (readonly [string | number, string])[] = [
      ['100', '400'], ['300', '400'], ['normal', '400'], ['400', '400'], [400, '400'],
      ['500', '500'], ['600', '600'], [600, '600'], ['700', '700'], ['bold', '700'],
      ['800', '700'], ['900', '700'], ['heavy', '400'],
    ];
    for (const [weight, face] of cases) expect(embeddedPublicSansWeight(weight), String(weight)).toBe(face);
  });

  it('gives an outermost Text with no weight the family only, and leaves nested ones to inherit', () => {
    expect(textFace({}, null, false)).toEqual({ fontFamily: 'Public Sans' });
    expect(textFace({}, 'Public Sans', false)).toBeNull();
    expect(textFace({ fontFamily: 'Public Sans' }, null, false)).toBeNull();
  });

  it('turns a weight into the face that draws it, on every platform', () => {
    expect(textFace({ fontWeight: '600' }, null, false)).toEqual({ fontFamily: 'Public Sans', fontWeight: '600' });
    expect(textFace({ fontWeight: '800' }, null, false)).toEqual({ fontFamily: 'Public Sans', fontWeight: '700' });
    expect(textFace({ fontWeight: '700' }, 'Public Sans', false)).toEqual({ fontFamily: 'Public Sans', fontWeight: '700' });
  });

  it('names the single-face family for Medium and SemiBold on Android before API 28', () => {
    expect(textFace({ fontWeight: '500' }, null, true)).toEqual({ fontFamily: 'Public Sans Medium', fontWeight: '500' });
    expect(textFace({ fontWeight: '600' }, null, true)).toEqual({ fontFamily: 'Public Sans SemiBold', fontWeight: '600' });
    expect(textFace({ fontFamily: 'Public Sans SemiBold', fontWeight: '600' }, null, true))
      .toEqual({ fontFamily: 'Public Sans SemiBold', fontWeight: '600' });
    expect(textFace({ fontWeight: '700' }, null, true)).toEqual({ fontFamily: 'Public Sans', fontWeight: '700' });
    expect(textFace({ fontWeight: '400' }, null, true)).toEqual({ fontFamily: 'Public Sans', fontWeight: '400' });
  });

  it('keeps another face, and the face of the Text it sits in', () => {
    expect(textFace({ fontFamily: 'Archivo', fontWeight: '800' }, null, false)).toBeNull();
    expect(textFace({ fontFamily: 'Georgia', fontWeight: '600' }, null, false)).toBeNull();
    expect(textFace({ fontWeight: '700' }, 'Archivo', false)).toBeNull();
    expect(textFace({}, 'serif', false)).toBeNull();
  });

  it('hands nested Text the family a Text ends with', () => {
    expect(resolvedTextFamily({}, { fontFamily: 'Public Sans' }, null)).toBe('Public Sans');
    expect(resolvedTextFamily({ fontFamily: 'Archivo' }, null, null)).toBe('Archivo');
    expect(resolvedTextFamily({}, null, 'Georgia')).toBe('Georgia');
  });

  it('reads the family and weight a style array ends with', () => {
    expect(flattenTextStyle([{ fontWeight: '400' }, false, null, [{ fontWeight: '700', fontSize: 12 }]]))
      .toEqual({ fontWeight: '700' });
    expect(flattenTextStyle({ fontFamily: 'Archivo', fontWeight: '800' })).toEqual({ fontFamily: 'Archivo', fontWeight: '800' });
    expect(flattenTextStyle(undefined)).toEqual({});
  });
});
