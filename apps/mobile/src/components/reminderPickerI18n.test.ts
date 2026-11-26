import { createElement as h, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const state = vi.hoisted(() => ({ platform: 'ios', language: 'en' as 'en' | 'es' }));
type Props = { children?: ReactNode; accessibilityLabel?: string; accessibilityHint?: string; placeholder?: string };
vi.mock('react-native', () => {
  const Host = ({ children, accessibilityLabel, accessibilityHint }: Props) => h('div', { 'aria-label': accessibilityLabel, 'data-hint': accessibilityHint }, children);
  return {
    Platform: { get OS() { return state.platform; } }, StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    Modal: Host, View: Host, Text: Host, Pressable: Host,
    TextInput: ({ accessibilityLabel, placeholder }: Props) => h('textarea', { 'aria-label': accessibilityLabel, placeholder }),
    Alert: { alert: vi.fn() },
  };
});
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: state.language }) }));
vi.mock('../theme/ThemeProvider', async () => {
  const { resolveTheme } = await import('../theme/tokens');
  return { useTheme: () => resolveTheme() };
});
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
import { ReminderPicker } from './ReminderPicker';

describe.each(['ios', 'android'])('reminder sheet language on %s', (platform) => {
  it.each(['en', 'es'])('localizes its fields, actions and accessibility hints for %s', (language) => {
    state.platform = platform; state.language = language === 'es' ? 'es' : 'en';
    const html = renderToStaticMarkup(h(ReminderPicker, { visible: true, onClose: vi.fn(), onConfirm: vi.fn() }));
    const spanish = language === 'es';
    for (const text of spanish ? ['Crear recordatorio', 'Cuándo', 'Elegir fecha y hora', 'Nota (opcional)', 'Nota del recordatorio', 'Añada una nota…', 'Cancelar'] : ['Set reminder', 'When', 'Choose date and time', 'Note (optional)', 'Reminder note', 'Add a note…', 'Cancel']) expect(html).toContain(text);
    expect(html).toContain(spanish
      ? platform === 'android' ? 'Abre el selector de fecha y después el de hora' : 'Abre el selector de fecha y hora del sistema'
      : platform === 'android' ? 'Opens the date picker, then the time picker' : 'Opens the system date and time picker');
    if (spanish) for (const text of ['>When<', '>Set reminder<', 'Note (optional)', 'Choose date and time']) expect(html).not.toContain(text);
  });
});
