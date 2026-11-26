// TEST-UG-PHONE-TESTS-EXECUTE-SCREENS-ON-ONE-SHARED-STAND-IN-20261111 (#8319):
// the app's components/ui primitives, drawn with the shared React Native
// stand-in so a screen test keeps its platform rules without loading the
// real chrome (animation values, blur, safe areas). Use it with
//   vi.mock('../components/ui', () => import('../testing/uiStandIn'));
import { createElement as h, Fragment, useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, View } from './reactNativeStandIn';

type Children = { children?: ReactNode };

export const Screen = ({ children }: Children) => h(View, null, children);
export const Card = ({ children, testID }: Children & { testID?: string }) => h(View, { testID }, children);
export const Heading = ({ children, testID }: Children & { level?: number; testID?: string }) => h(Text, { accessibilityRole: 'header', testID }, children);
export const Body = ({ children }: Children & { muted?: boolean }) => h(Text, null, children);
export const StatValue = ({ children }: Children) => h(Text, null, children);
export const StatusPill = ({ label, children }: Children & { label?: string }) => h(Text, null, label ?? children);
export const Notice = ({ title, body, children }: Children & { title?: string; body?: string }) =>
  h(View, null, title ? h(Text, null, title) : null, body ? h(Text, null, body) : null, children);
export const StateMessage = ({ title, body }: { title: string; body?: string }) =>
  h(View, null, h(Text, { accessibilityRole: 'header' }, title), body ? h(Text, null, body) : null);
// As the shared Button (#9458): a disabled, idle button given a reason stays
// pressable with the reason as its hint, and a press shows the reason under it
// instead of acting (the real one also announces it; buttonDisabledReason.test.ts).
export function Button({ label, onPress, disabled, disabledReason, busy, accessibilityLabel, accessibilityHint }: {
  label: string; onPress?: () => void; disabled?: boolean; disabledReason?: string; busy?: boolean; accessibilityLabel?: string; accessibilityHint?: string; variant?: string;
}) {
  const reason = disabled && !busy ? disabledReason ?? '' : '';
  const [explained, setExplained] = useState(false);
  if (explained && !reason) setExplained(false);
  // #9460: the real one keeps a held button announced as dimmed while the press
  // still reaches the reason (accessibilityState without `disabled`); the
  // Pressable stand-in refuses any dimmed press, so this case is drawn as the
  // Pressable stand-in draws a button.
  const control = reason
    ? h('div', { role: 'button', 'aria-label': accessibilityLabel ?? label, 'aria-description': reason, 'aria-disabled': true,
      onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); setExplained(true); } },
    h('div', { 'aria-hidden': 'true' }, h(Text, null, label)))
    : h(Pressable, { accessibilityRole: 'button', accessibilityLabel: accessibilityLabel ?? label, accessibilityHint,
      disabled: disabled || busy, onPress }, h(Text, null, label));
  return explained && reason ? h(Fragment, null, control, h(Text, null, reason)) : control;
}
export const SearchField = ({ value, onChangeText, placeholder, accessibilityLabel }: {
  value: string; onChangeText: (value: string) => void; placeholder?: string; accessibilityLabel?: string;
}) => h(TextInput, { value, onChangeText, placeholder, accessibilityLabel: accessibilityLabel ?? placeholder });
