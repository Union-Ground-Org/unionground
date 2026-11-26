import { Image, StyleSheet, View } from 'react-native';
import { Text } from './Text';

import { phoneBrand } from '../lib/brand';
import { typeface } from '../theme/typeface';

// The product mark. An official Union Ground LLC build draws the official
// mark (branding/official/, written into the bundle only in that build by
// plugins/babel-brand-name.js). Every other build draws a neutral glyph: a
// plain rounded square with the initial of the build's own name, and no Union
// Ground artwork.
export const NEUTRAL_MARK_FILL = '#3F4A46';
export const NEUTRAL_MARK_INK = '#FFFFFF';

export function BrandMark({ size = 38 }: { size?: number }) {
  if (phoneBrand.officialMarkUri) {
    return (
      <Image
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        source={{ uri: phoneBrand.officialMarkUri }}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.tile, { width: size, height: size, borderRadius: size * (15 / 64), backgroundColor: NEUTRAL_MARK_FILL }]}
    >
      <Text allowFontScaling={false} style={[styles.initial, { fontSize: size * 0.47, color: NEUTRAL_MARK_INK }]}>{phoneBrand.initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center' },
  initial: { ...typeface.controlStrong },
});
