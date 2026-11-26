import { Fragment, type PropsWithChildren } from 'react';
import { useWindowDimensions } from 'react-native';

import { fontScaleLayoutKey } from '../lib/fontScaleRelayout';

/**
 * Mounts its children again when the system text size changes, so every text
 * under it is measured at the size it is drawn at
 * (BUG-UG-NATIVE-HOME-ACCESSIBILITY-TEXT-CLIPPED-20261103, the reason
 * is in src/lib/fontScaleRelayout.ts). A keyed Fragment adds no view, so the
 * parent's gap and padding still apply to the children directly. State held
 * by the screen that renders this survives; state inside the children resets
 * once, at the moment the text size changes.
 */
export function FontScaleRelayout({ children }: PropsWithChildren) {
  const { fontScale } = useWindowDimensions();
  return <Fragment key={fontScaleLayoutKey(fontScale)}>{children}</Fragment>;
}
