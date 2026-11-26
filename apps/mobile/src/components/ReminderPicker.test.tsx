// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessibilityEscape, exposedNames, getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
const language = vi.hoisted(() => ({ current: 'en' as 'en' | 'es' }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: language.current }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import { ReminderPicker } from './ReminderPicker';

// A11Y-UG-NATIVE-IOS-SET-REMINDER-SHEET-HAS-NO-ACCESSIBLE-CONTROLS-20261111
// (#8227), executed on the shared stand-in (#8319): the "Remind me…" sheet
// was one accessible View, so VoiceOver and TalkBack reached none of its
// controls and could not leave it.
let screen: Rendered | null = null;
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); language.current = 'en'; });

describe.each(['ios', 'android'] as const)('Remind me sheet on %s', (os) => {
  it('exposes the heading and every control by name, and Cancel and the escape gesture close it', async () => {
    setPlatform(os);
    const onClose = vi.fn();
    screen = await render(h(ReminderPicker, { visible: true, onClose, onConfirm: vi.fn() }));
    const names = exposedNames(screen.container);
    expect(names).toContain('Set reminder');
    expect(names.filter((name) => name === 'Set reminder')).toHaveLength(2);
    getExposed(screen.container, /^Reminder time, currently /);
    getExposed(screen.container, 'Reminder note');
    await press(getExposed(screen.container, 'Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => accessibilityEscape());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the selected time and omits the zone line if Intl cannot name the zone', async () => {
    setPlatform(os);
    const date = new Date('2026-11-19T15:00:00Z');
    const parts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([]);
    try {
      screen = await render(h(ReminderPicker, {
        visible: true, onClose: vi.fn(), onConfirm: vi.fn(),
        retained: {
          value: { open: true, date: date.getTime(), chosen: true, note: '', step: null },
          onChange: vi.fn(), pending: false, locked: false, failed: '', retryLabel: '', discardLabel: '', onDiscard: vi.fn(),
        },
      }));
      expect(screen.container.textContent).toContain(date.toLocaleString('en-US'));
      expect(screen.container.textContent).not.toContain('Time unavailable');
    } finally {
      parts.mockRestore();
    }
  });
});

it.each<['en' | 'es', string, string]>([
  ['en', 'Set reminder', 'Choose date and time'],
  ['es', 'Crear recordatorio', 'Elegir fecha y hora'],
])('explains in %s why a reminder cannot be set yet', async (lang, label, reason) => {
  language.current = lang;
  const onConfirm = vi.fn();
  screen = await render(h(ReminderPicker, { visible: true, onClose: vi.fn(), onConfirm }));
  const submit = [...screen.container.querySelectorAll('[role="button"]')]
    .find((control) => control.getAttribute('aria-label') === label)!;
  expect(submit.getAttribute('aria-disabled')).toBe('true');
  expect(submit.getAttribute('aria-description')).toBe(reason);
  await press(submit);
  expect(onConfirm).not.toHaveBeenCalled();
});

// UX-UG-LIMITS-NEVER-STATED-BEFORE-THEY-ARE-TRIPPED-20261122 (#9467,
// M1-15): the note box stops at 500 characters, so it counts near the limit
// and says when the limit is reached. It never claims text was cut: the
// field's maxLength drops any extra before the app sees it.
describe('Remind me note limit', () => {
  async function type(value: string) {
    const input = getExposed(screen!.container, language.current === 'en' ? 'Reminder note' : 'Nota del recordatorio') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  const cases: Array<['en' | 'es', string, string]> = [
    ['en', '400 of 500 characters', 'Limit reached: 500 characters.'],
    ['es', '400 de 500 caracteres', 'Llegó al límite de 500 caracteres.'],
  ];
  it.each(cases)('says nothing for a short note, counts from 400 and says the limit at exactly 500, in %s', async (lang, near, limit) => {
    language.current = lang;
    screen = await render(h(ReminderPicker, { visible: true, onClose: vi.fn(), onConfirm: vi.fn() }));
    await type('Call the committee member back');
    expect(screen.container.textContent).not.toMatch(/characters|caracteres/);
    await type('x'.repeat(399));
    expect(screen.container.textContent).not.toMatch(/characters|caracteres/);
    await type('x'.repeat(400));
    expect(screen.container.textContent).toContain(near);
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
    await type('x'.repeat(500));
    expect(screen.container.querySelector('[role="alert"]')?.textContent).toBe(limit);
    expect(screen.container.textContent).not.toMatch(/cut off|se cort/);
  });
});
