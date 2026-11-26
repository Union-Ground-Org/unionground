import { useCallback, useState, type ReactNode } from 'react';
import { useWindowDimensions, type LayoutChangeEvent } from 'react-native';

import { textOfChildren, wordFitMultiplier, type WordFitFace } from '../lib/wordFit';

export type WordFitMetrics = { fontSize: number; lineHeight: number };

// Body and Heading's opt-in word fit (src/lib/wordFit.ts): the line's width
// comes from the text's own layout, and the cap follows it.
//
// BUG-UG-NATIVE-GUIDE-BULLET-CLIPPED-AT-LARGEST-TEXT-IOS-20261103: the
// cap used to travel as maxFontSizeMultiplier, which React Native's text
// measure cache leaves out of its key (areTextAttributesEquivalentLayoutWise
// in TextMeasureCache.h). A bullet could reuse a height measured under another
// cap and be drawn at the full size one pixel short: "• Take member requests
// and reply to them." ended at "and reply to t" with "hem." never drawn. A
// text that needs no cap now carries nothing that changes its size, and a
// capped text is drawn at explicit, already-scaled sizes, which the cache
// does key on.
export function useWordFit(enabled: boolean, children: ReactNode, metrics: WordFitMetrics, face: WordFitFace = 'body'): {
  onLayout?: (event: LayoutChangeEvent) => void;
  allowFontScaling?: false;
  style?: WordFitMetrics;
} {
  const { fontScale } = useWindowDimensions();
  const [lineWidth, setLineWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setLineWidth(Math.round(event.nativeEvent.layout.width));
  }, []);
  if (!enabled) return {};
  const cap = wordFitMultiplier(textOfChildren(children), metrics.fontSize, lineWidth, face);
  if (cap === undefined || !(cap < fontScale)) return { onLayout };
  return {
    onLayout,
    allowFontScaling: false,
    style: { fontSize: metrics.fontSize * cap, lineHeight: metrics.lineHeight * cap },
  };
}
