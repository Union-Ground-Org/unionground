import { Children, createContext, isValidElement, useContext, type ComponentPropsWithRef, type ReactNode } from 'react';
import { Text as NativeText, TextInput as NativeTextInput } from 'react-native';

import { flattenTextStyle, resolvedTextFamily, textFace } from '../lib/textFace';
import { usesSingleFaceFamilies as singleFaceFamilies } from '../theme/typeface';

// The app's Text and TextInput (UX-UNIONGROUND-NATIVE-ARCHIVO-AND-PUBLIC-SANS-
// TYPEFACES-20261115). Every screen imports these instead of React Native's, so
// all text draws in the theme's Public Sans unless its style takes a role that
// names another face (Archivo for headings and the name; Georgia where a
// design already set it). A weight in a style picks the embedded face; see
// src/lib/textFace.ts. Font scaling and every other prop pass through.

// The family the nearest enclosing Text resolved, so nested Text inherits it.
const TextFamilyContext = createContext<string | null>(null);

// A nested Text resolves like an outermost one, which is right under Public
// Sans, so only another family (Archivo, Georgia, a single-face family) is
// handed down, and only to children that can hold a Text.
function holdsElement(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => isValidElement(child));
}

export function Text(props: ComponentPropsWithRef<typeof NativeText>) {
  const inheritedFamily = useContext(TextFamilyContext);
  const own = flattenTextStyle(props.style);
  const face = textFace(own, inheritedFamily, singleFaceFamilies);
  const family = resolvedTextFamily(own, face, inheritedFamily);
  const style = face ? [props.style, face] : props.style;
  if (family === null || family === 'Public Sans' || family === inheritedFamily || !holdsElement(props.children)) {
    return <NativeText {...props} style={style} />;
  }
  return (
    <NativeText {...props} style={style}>
      <TextFamilyContext.Provider value={family}>{props.children}</TextFamilyContext.Provider>
    </NativeText>
  );
}

// The native instance types, so `useRef<TextInput>(null)` keeps working.
export type Text = NativeText;
export type TextInput = NativeTextInput;

export function TextInput(props: ComponentPropsWithRef<typeof NativeTextInput>) {
  const face = textFace(flattenTextStyle(props.style), null, singleFaceFamilies);
  return <NativeTextInput {...props} style={face ? [props.style, face] : props.style} />;
}
