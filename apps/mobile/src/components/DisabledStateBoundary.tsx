import type { ReactNode } from 'react';
import { StyleSheet, View, type AccessibilityRole, type AccessibilityValue } from 'react-native';

// Disabled-state boundary for native controls whose `disabled` /
// `editable={false}` + `accessibilityState.disabled` never reach the element
// VoiceOver focuses.
//
// Records:
//   BUG-UG-MOBILE-IOS-SWITCH-DISABLED-STATE-NOT-EXPOSED-20260918 (c15)
//   BUG-UG-MOBILE-IOS-COMPASS-QUESTION-FIELD-NOT-DIMMED-WHEN-PAUSED-20260918 (c16)
//
// The React Native limitation, as the 2026-09-18 physical-iPhone captures
// retained by #2137 show it: for `Switch` and multiline `TextInput` the Fabric
// component view is a plain host UIView that receives `accessibilityState` and
// therefore carries the `notEnabled` trait (the unlabelled "Other
// traits=[notEnabled] enabled=false" element in the tree), but the control
// VoiceOver actually focuses is the native UISwitch / UITextView subview, which
// reports `enabled=true` with no `notEnabled` trait. Only `Pressable`/`View`
// based controls expose the state on the focusable element itself.
//
// Mechanism (stated once, used by both records): while `disabled` is true the
// boundary renders an `accessible` host element that OWNS the label, role,
// value and `accessibilityState.disabled` (plus `checked` for a switch), and it
// hides the wrapped native control from both platform trees
// (`accessibilityElementsHidden` on iOS, `importantForAccessibility=
// "no-hide-descendants"` on Android). The element VoiceOver focuses is then the
// boundary, and the boundary carries notEnabled. While `disabled` is false the
// boundary renders its children bare, so an available Switch still reads as an
// operable switch with its on/off state and an editable field is still a
// normal text view. The inner control keeps its own `disabled` / `editable`
// props: those are what refuse the interaction; the boundary only repairs what
// is announced.
export function DisabledStateBoundary({
  disabled,
  accessibilityLabel,
  accessibilityRole,
  accessibilityValue,
  checked,
  fill = false,
  children,
}: {
  disabled: boolean;
  accessibilityLabel: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityValue?: AccessibilityValue;
  /** Switch-style controls: the on/off state the boundary reports while disabled. */
  checked?: boolean;
  /** Keep a `flex: 1` row child (the Compass composer input) filling its row. */
  fill?: boolean;
  children: ReactNode;
}) {
  if (!disabled) return <>{children}</>;
  const layout = fill ? styles.fill : undefined;
  return (
    <View
      accessible
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={accessibilityValue}
      accessibilityState={checked === undefined ? { disabled: true } : { disabled: true, checked }}
      style={layout}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={layout}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, flexDirection: 'row' },
});
