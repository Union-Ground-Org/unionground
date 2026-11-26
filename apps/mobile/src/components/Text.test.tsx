import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flattenTextStyle } from '../lib/textFace';

// UX-UG-NATIVE-ARCHIVO-AND-PUBLIC-SANS-TYPEFACES-20261115 (#8928): the
// app's Text and TextInput draw in the theme's faces and pass everything else on.
const drawn: { name: string; face: ReturnType<typeof flattenTextStyle>; numberOfLines?: number }[] = [];

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '27.0' },
  Text: ({ style, children, numberOfLines }: { style?: unknown; children?: ReactNode; numberOfLines?: number }) => {
    drawn.push({ name: 'Text', face: flattenTextStyle(style), numberOfLines });
    return h('span', null, children);
  },
  TextInput: ({ style }: { style?: unknown }) => {
    drawn.push({ name: 'TextInput', face: flattenTextStyle(style) });
    return h('input');
  },
}));

const { Text, TextInput } = await import('./Text');
const { typeface } = await import('../theme/typeface');

beforeEach(() => { drawn.length = 0; });

describe("the app's Text", () => {
  it('draws plain text in Public Sans and keeps its other props', () => {
    renderToStaticMarkup(h(Text, { numberOfLines: 2 }, 'Hello'));
    expect(drawn).toEqual([{ name: 'Text', face: { fontFamily: 'Public Sans' }, numberOfLines: 2 }]);
  });

  it('turns a weight into an embedded face', () => {
    renderToStaticMarkup(h(Text, { style: [{ fontSize: 11 }, { fontWeight: '900' }] }, 'LABEL'));
    expect(drawn[0]?.face).toEqual({ fontFamily: 'Public Sans', fontWeight: '700' });
  });

  it('leaves a heading in Archivo, with the Text nested in it', () => {
    renderToStaticMarkup(h(Text, { style: { ...typeface.heading, fontSize: 22 } }, 'Issues ', h(Text, { style: { fontWeight: '700' } }, '(3)'), h(Text, null, 'open')));
    expect(drawn.map((entry) => entry.face)).toEqual([
      { fontFamily: 'Archivo', fontWeight: '800' },
      { fontWeight: '700' },
      {},
    ]);
  });

  it('lets a Text nested in Public Sans keep its parent weight', () => {
    renderToStaticMarkup(h(Text, { style: { fontWeight: '600' } }, 'Due ', h(Text, null, 'today')));
    expect(drawn.map((entry) => entry.face)).toEqual([
      { fontFamily: 'Public Sans', fontWeight: '600' },
      { fontFamily: 'Public Sans' },
    ]);
  });

  it('leaves Georgia where a design set it', () => {
    renderToStaticMarkup(h(Text, { style: { fontFamily: 'Georgia', fontWeight: '600' } }, 'Union Ground'));
    expect(drawn[0]?.face).toEqual({ fontFamily: 'Georgia', fontWeight: '600' });
  });

  it('draws typed input in Public Sans', () => {
    renderToStaticMarkup(h(TextInput, { style: { fontSize: 16 } }));
    expect(drawn).toEqual([{ name: 'TextInput', face: { fontFamily: 'Public Sans' } }]);
  });
});
