import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A11Y-UG-NATIVE-IOS-SET-REMINDER-SHEET-HAS-NO-ACCESSIBLE-CONTROLS-20261111:
// the "Remind me…" sheet showed controls that VoiceOver could not reach; only
// a title (in the caller's language) was exposed and nobody could leave it.
// The mock below keeps React Native's documented accessibility rule: a View
// with `accessible` is ONE element named by its accessibilityLabel, and its
// children are not separately reachable by VoiceOver or TalkBack.
const escape = vi.hoisted(() => ({ handlers: [], language: 'en' }));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({ useApp: () => ({ memberLanguage: escape.language }) }));
vi.mock('react-native', async () => {
  const React = await import('react');
  const View = ({ children, accessible, accessibilityLabel, accessibilityViewIsModal, onAccessibilityEscape, accessibilityElementsHidden }) => {
    if (onAccessibilityEscape) escape.handlers.push(onAccessibilityEscape);
    if (accessible) {
      return React.createElement('div', { role: 'group', 'aria-label': accessibilityLabel },
        React.createElement('div', { 'aria-hidden': 'true' }, children));
    }
    return React.createElement('div', { 'aria-modal': accessibilityViewIsModal ? 'true' : undefined, 'aria-hidden': accessibilityElementsHidden ? 'true' : undefined }, children);
  };
  const Text = ({ children, accessibilityRole }) => React.createElement(accessibilityRole === 'header' ? 'h2' : 'span', null, children);
  return {
    Platform: { OS: 'ios' },
    // #9963: the composer announces its status lines through the app's queue on iOS.
    AccessibilityInfo: { announceForAccessibility: () => {}, announceForAccessibilityWithOptions: () => {} },
    Alert: { alert: vi.fn() },
    View, Text,
    StyleSheet: { create: (value) => value, hairlineWidth: 1, absoluteFill: {} },
    Modal: ({ children, visible }) => visible ? React.createElement('div', { role: 'dialog' }, children) : null,
    Pressable: ({ children, onPress, disabled, accessibilityLabel }) => React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, typeof children === 'function' ? children({ pressed: false }) : children),
    TextInput: ({ value, onChangeText, accessibilityLabel }) => React.createElement('textarea', { value, onChange: (event) => onChangeText(event.target.value), 'aria-label': accessibilityLabel }),
  };
});
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({ useTheme: () => ({ background: '#fff', popover: '#fff', popoverForeground: '#111', border: '#777', primary: '#155f40', primaryForeground: '#fff', mutedForeground: '#444', foreground: '#111', input: '#fff', destructive: '#800', appearance: 'light' }) }));
vi.mock('../apps/mobile/src/services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { ReminderPicker } from '../apps/mobile/src/components/ReminderPicker';

beforeEach(() => { escape.handlers.length = 0; escape.language = 'en'; });

const sheet = (props = {}) => <ReminderPicker visible onClose={vi.fn()} onConfirm={vi.fn()} minDate={new Date('2026-11-11T12:00:00Z')} {...props} />;

describe('"Remind me…" sheet for screen readers', () => {
  it.each([
    { language: 'en', title: 'Set reminder', time: /^Reminder time, currently/, note: 'Reminder note', cancel: 'Cancel' },
    { language: 'es', title: 'Crear recordatorio', time: /^Hora del recordatorio, actualmente/, note: 'Nota del recordatorio', cancel: 'Cancelar' },
  ])('exposes its title as a heading and every control by name in $language', ({ language, title, time, note, cancel }) => {
    escape.language = language;
    render(sheet());
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: time })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: note })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: cancel })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: title })).toBeInTheDocument();
    // No single grouped element swallows the controls.
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('can be left: Cancel and the VoiceOver escape gesture both close it', () => {
    const onClose = vi.fn();
    render(sheet({ onClose }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.handlers.length).toBeGreaterThan(0);
    escape.handlers.at(-1)();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps focus inside the sheet while it is open', () => {
    render(sheet());
    expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();
  });

  it('takes no caller label, so a trigger cannot rename the sheet', () => {
    const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(source('../apps/mobile/src/components/ReminderPicker.tsx')).not.toMatch(/accessibilityLabel\?: string/);
    for (const caller of ['ConnectedRecordActions.tsx', 'NativeMessageActions.tsx']) {
      const text = source(`../apps/mobile/src/components/${caller}`);
      const picker = text.slice(text.indexOf('<ReminderPicker'), text.indexOf('/>', text.indexOf('<ReminderPicker')));
      expect(picker, caller).not.toContain('accessibilityLabel');
    }
  });
});
