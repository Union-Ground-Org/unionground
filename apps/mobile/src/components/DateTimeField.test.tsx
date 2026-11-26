// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';

// #9091 part 3: the deadline date field. iOS picks date and time in one
// dialog; Android picks the date, then the time, and the field keeps both.
const port = vi.hoisted(() => ({ available: true, answers: [] as number[], modes: [] as string[] }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('./ui', () => import('../testing/uiStandIn'));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: 'en', dashboard: null }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ foreground: '#21152C', destructive: '#9A1B1B' }) }));
vi.mock('../lib/nativeDateTimePicker', async () => {
  const { Pressable, Text } = await import('../testing/reactNativeStandIn');
  return {
    loadNativeDateTimePicker: () => port.available
      ? ({ mode, onChange }: { mode: string; onChange: (event: { type: string; nativeEvent: { timestamp?: number } }) => void }) => {
        port.modes.push(mode);
        return h(Pressable, { accessibilityLabel: `Pick ${mode}`, onPress: () => { const next = port.answers.shift(); onChange(next === undefined ? { type: 'dismissed', nativeEvent: {} } : { type: 'set', nativeEvent: { timestamp: next } }); } }, h(Text, null, mode));
      }
      : null,
  };
});
import { DateTimeField } from './DateTimeField';

let screen: Rendered | null = null;
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); port.available = true; port.answers = []; port.modes = []; });

describe('deadline date field', () => {
  it('takes date and time from one dialog on iOS', async () => {
    const onChange = vi.fn();
    port.answers = [Date.parse('2026-12-15T17:30:00Z')];
    screen = await render(h(DateTimeField, { label: 'Due date and time', value: null, onChange }));
    await press(getExposed(screen.container, 'Due date and time: Choose date and time'));
    await press(getExposed(screen.container, 'Pick datetime'));
    expect(onChange).toHaveBeenCalledWith(new Date('2026-12-15T17:30:00Z'));
  });

  it('takes the date, then the time, on Android', async () => {
    setPlatform('android');
    const onChange = vi.fn();
    port.answers = [Date.parse('2026-12-15T09:00:00Z'), Date.parse('2026-12-15T17:30:00Z')];
    screen = await render(h(DateTimeField, { label: 'Due date and time', value: null, onChange }));
    await press(getExposed(screen.container, 'Due date and time: Choose date and time'));
    await press(getExposed(screen.container, 'Pick date'));
    await press(getExposed(screen.container, 'Pick time'));
    expect(port.modes).toEqual(['date', 'time']);
    expect(onChange).toHaveBeenCalledWith(new Date('2026-12-15T17:30:00Z'));
  });

  it('changes nothing when the dialog is dismissed', async () => {
    const onChange = vi.fn();
    screen = await render(h(DateTimeField, { label: 'Due date and time', value: null, onChange }));
    await press(getExposed(screen.container, 'Due date and time: Choose date and time'));
    await press(getExposed(screen.container, 'Pick datetime'));
    expect(onChange).not.toHaveBeenCalled();
    expect(() => getExposed(screen!.container, 'Pick datetime')).toThrow();
  });

  it('shows a chosen time in Eastern time with the zone named', async () => {
    screen = await render(h(DateTimeField, { label: 'Due date and time', value: new Date('2026-12-15T22:30:00Z'), onChange: vi.fn() }));
    expect(getExposed(screen.container, 'Due date and time: Dec 15, 2026 · 5:30 PM ET')).toBeTruthy();
  });

  it('says so when the build has no system date picker', async () => {
    port.available = false;
    screen = await render(h(DateTimeField, { label: 'Due date and time', value: null, onChange: vi.fn() }));
    await press(getExposed(screen.container, 'Due date and time: Choose date and time'));
    expect(screen.container.textContent).toContain('This build cannot open the system date picker.');
  });
});
