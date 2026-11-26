vi.mock('react', async () => await import('react'));
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  list: vi.fn(), open: vi.fn(), remove: vi.fn(), recheck: vi.fn(), alert: vi.fn(),
  writer: { userId: 'member-a', isCurrent: async () => (await native.writer.check()) === 'current', check: vi.fn(async () => 'current') },
}));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({ useApp: () => ({ session: { user: { id: 'member-a' }, access_token: 'test-a' } }) }));
vi.mock('../apps/mobile/src/services/supabase', () => ({ captureSessionWriter: () => native.writer }));
vi.mock('react-native', () => ({
  Alert: { alert: native.alert }, Linking: {}, Image: () => null,
  Text: ({ children }) => <span>{children}</span>,
  View: ({ children }) => <div>{children}</div>, TextInput: () => null,
  ActivityIndicator: () => null, Animated: { View: ({ children }) => <div>{children}</div> }, Platform: { OS: 'ios' },
  RefreshControl: () => null, ScrollView: () => null,
  StyleSheet: { create: value => value, hairlineWidth: 1 },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: () => null, useSafeAreaInsets: () => ({}) }));
vi.mock('react-native-screens/experimental', () => ({ ScrollViewMarker: () => null }));
vi.mock('../apps/mobile/src/components/PressableScale', () => ({
  PressableScale: ({ children, onPress, disabled, accessibilityRole, accessibilityLabel, accessibilityState }) => (
    <button role={accessibilityRole} aria-label={accessibilityLabel} aria-busy={accessibilityState.busy}
      aria-disabled={accessibilityState.disabled} disabled={disabled} onClick={onPress}>{children}</button>
  ),
  usePressSpring: () => ({}),
}));
vi.mock('../apps/mobile/src/components/FontScaleRelayout', () => ({ FontScaleRelayout: () => null }));
vi.mock('../apps/mobile/src/components/ScreenKeyboardReveal', () => ({ ScreenKeyboardReveal: () => null, useRevealAboveKeyboard: () => ({}) }));
vi.mock('../apps/mobile/src/components/useWordFit', () => ({ useWordFit: () => ({}) }));
vi.mock('../apps/mobile/src/components/PinnedHeader', () => ({ usePinnedHeaderChrome: () => null, useScreenNameAlreadySpoken: () => ({ hiddenProps: {} }) }));
vi.mock('../apps/mobile/src/components/NumberFlow', () => ({ NumberFlow: () => null }));
vi.mock('../apps/mobile/src/components/RowHighlight', () => ({ HighlightList: () => null, HighlightRow: () => null }));
vi.mock('../apps/mobile/src/components/TopChrome', () => ({ TopRamp: () => null }));
vi.mock('../apps/mobile/src/lib/chrome', () => ({}));
vi.mock('../apps/mobile/src/lib/reduceMotion', () => ({ useReduceMotion: () => true }));
// The real hook reads the router's navigation context, and the phone app's
// own packages are not installed for root tests.
vi.mock('../apps/mobile/src/lib/useChartArrival', () => ({ useChartArrival: () => ({ ref: { current: null }, elapsed: null }) }));
vi.mock('../apps/mobile/src/lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => () => {}, queueAccessibilityAnnouncement: () => {} }));
vi.mock('../apps/mobile/src/services/haptics', () => ({ haptics: { success: vi.fn(), warning: vi.fn() } }));
vi.mock('../apps/mobile/src/services/lifecycleDiagnostics', () => ({ recordLifecycleEvent: () => {} }));
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../apps/mobile/src/services/attachments', () => ({
  AttachmentSelectionLifecycle: class {
    updateTarget() {} invalidate() {} capture() { return 0; }
  },
  AttachmentError: class extends Error {
    constructor(code, message, details = {}) { super(message); this.code = code; Object.assign(this, details); }
  },
  listAuthorizedAttachments: native.list,
  openAuthorizedAttachment: native.open,
  removeAuthorizedAttachment: native.remove,
  recheckAuthorizedAttachment: native.recheck,
}));

import { AttachmentPanel } from '../apps/mobile/src/components/AttachmentPanel';
import { AttachmentError } from '../apps/mobile/src/services/attachments';
import { Button } from '../apps/mobile/src/components/ui';

const target = { kind: 'case', id: 'case-a' };
const rows = [
  { id: 'file-a', filename: 'Schedule notes.txt', sizeBytes: 83, createdAt: '2026-11-08T12:00:00Z' },
  { id: 'file-b', filename: 'Meeting summary.pdf', sizeBytes: 1024, createdAt: '2026-11-08T12:00:00Z' },
];
beforeEach(() => {
  vi.clearAllMocks();
  native.list.mockResolvedValue(rows);
  native.open.mockResolvedValue(undefined);
  native.remove.mockResolvedValue(undefined);
  native.recheck.mockResolvedValue(undefined);
  native.writer.check.mockResolvedValue('current');
});

it('holds removal busy through the receipt and awaited list read', async () => {
  let releaseReceipt; let releaseList;
  const receipt = new Promise(resolve => { releaseReceipt = resolve; });
  const list = new Promise(resolve => { releaseList = resolve; });
  render(<AttachmentPanel target={target} canWrite onChanged={() => receipt} />);
  await screen.findByText(rows[0].filename);
  native.list.mockImplementationOnce(() => list);
  fireEvent.click(screen.getByRole('button', { name: `Remove file: ${rows[0].filename}` }));
  const confirm = native.alert.mock.calls.at(-1)[2].find(item => item.style === 'destructive');
  let operation;
  await act(async () => { operation = confirm.onPress(); });
  expect(screen.getByRole('button', { name: `Open securely: ${rows[1].filename}` })).toBeDisabled();
  expect(native.list).toHaveBeenCalledTimes(1);
  await act(async () => { releaseReceipt(); });
  expect(screen.getByRole('button', { name: `Open securely: ${rows[1].filename}` })).toBeDisabled();
  await act(async () => { releaseList([rows[1]]); await operation; });
  expect(await screen.findByRole('button', { name: `Open securely: ${rows[1].filename}` })).toBeEnabled();
  expect(native.remove).toHaveBeenCalledTimes(1);
});

it('retires the accepted removed row under unavailable proof and permits only a read refresh', async () => {
  render(<AttachmentPanel target={target} canWrite />);
  await screen.findByText(rows[0].filename);
  native.writer.check.mockResolvedValue('unavailable');
  fireEvent.click(screen.getByRole('button', { name: `Remove file: ${rows[0].filename}` }));
  const confirm = native.alert.mock.calls.at(-1)[2].find(item => item.style === 'destructive');
  await act(async () => confirm.onPress());
  await act(async () => confirm.onPress());
  expect(screen.queryByRole('button', { name: `Remove file: ${rows[0].filename}` })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh attachments' }));
  await act(async () => {});
  expect(native.list).toHaveBeenCalledTimes(1);
  expect(native.remove).toHaveBeenCalledTimes(1);
});

it('a retained remove confirmation cannot act after its target changes', async () => {
  const rendered = render(<AttachmentPanel target={target} canWrite />);
  await screen.findByText(rows[0].filename);
  fireEvent.click(screen.getByRole('button', { name: `Remove file: ${rows[0].filename}` }));
  const confirm = native.alert.mock.calls.at(-1)[2].find(item => item.style === 'destructive');
  rendered.rerender(<AttachmentPanel target={{ kind: 'case', id: 'case-b' }} canWrite />);
  await screen.findByText(rows[1].filename);
  await act(async () => confirm.onPress());
  expect(native.remove).not.toHaveBeenCalled();
});

it('acknowledges an accepted removal when the continuation proof becomes unavailable', async () => {
  render(<AttachmentPanel target={target} canWrite />);
  await screen.findByText(rows[0].filename);
  native.writer.check.mockResolvedValue('unavailable');
  fireEvent.click(screen.getByRole('button', { name: `Remove file: ${rows[0].filename}` }));
  const confirm = native.alert.mock.calls.at(-1)[2].find(item => item.style === 'destructive');
  await act(async () => confirm.onPress());
  expect(await screen.findByText(/attachment was removed, but its list could not be refreshed/i)).toBeInTheDocument();
  expect(native.remove).toHaveBeenCalledTimes(1);
  expect(screen.getByText(rows[1].filename)).toBeInTheDocument();
});

it('explains a completed safety check when its continuation proof becomes unavailable', async () => {
  native.open.mockRejectedValueOnce(new AttachmentError('open', 'This file needs a fresh safety check.', { recheckable: true }));
  render(<AttachmentPanel target={target} canWrite />);
  fireEvent.click(await screen.findByRole('button', { name: `Open securely: ${rows[0].filename}` }));
  const retry = await screen.findByRole('button', { name: 'Re-check this file' });
  native.writer.check.mockResolvedValue('unavailable');
  fireEvent.click(retry);
  expect(await screen.findByText(/safety check finished, but authorization could not be verified/i)).toBeInTheDocument();
  expect(native.recheck).toHaveBeenCalledTimes(1);
  expect(screen.getByText(rows[0].filename)).toBeInTheDocument();
});

it('names every rendered attachment action by file while keeping its visible wording', async () => {
  render(<AttachmentPanel target={target} canWrite />);
  await screen.findByText(rows[0].filename);
  // These names belong to the controls themselves, independent of static text.
  for (const { filename } of rows) {
    const open = screen.getByRole('button', { name: `Open securely: ${filename}` });
    const remove = screen.getByRole('button', { name: `Remove file: ${filename}` });
    expect(open).toHaveTextContent(/^Open securely$/);
    expect(remove).toHaveTextContent(/^Remove file$/);
    for (const button of [open, remove]) {
      expect(button).toBeEnabled();
      expect(button).toHaveAttribute('aria-busy', 'false');
      expect(button).toHaveAttribute('aria-disabled', 'false');
    }
  }
  expect(screen.queryByRole('button', { name: 'Open securely', exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Remove file', exact: true })).not.toBeInTheDocument();
});

it('retains the target name and busy/disabled states while an authorized open is pending', async () => {
  let finish;
  native.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<AttachmentPanel target={target} canWrite />);
  const open = await screen.findByRole('button', { name: 'Open securely: Schedule notes.txt' });
  fireEvent.click(open);
  expect(native.open).toHaveBeenCalledExactlyOnceWith(target, 'file-a', native.writer);
  expect(open).toHaveAttribute('aria-busy', 'true');
  expect(open).toBeDisabled();
  for (const name of ['Remove file: Schedule notes.txt', 'Open securely: Meeting summary.pdf', 'Remove file: Meeting summary.pdf']) {
    expect(screen.getByRole('button', { name })).toBeDisabled();
  }
  await act(async () => finish());
  expect(open).toBeEnabled();
  expect(open).toHaveAttribute('aria-busy', 'false');
});

it('keeps removal confirmation and its target-specific pending state', async () => {
  let finish;
  native.remove.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<AttachmentPanel target={target} canWrite />);
  const remove = await screen.findByRole('button', { name: 'Remove file: Meeting summary.pdf' });
  fireEvent.click(remove);
  expect(native.remove).not.toHaveBeenCalled();
  const actions = native.alert.mock.calls[0][2];
  expect(actions.map(action => action.text)).toEqual(['Cancel', 'Remove']);
  act(() => actions.find(action => action.text === 'Remove').onPress());
  expect(native.remove).toHaveBeenCalledExactlyOnceWith(target, 'file-b', native.writer);
  expect(remove).toHaveAttribute('aria-busy', 'true');
  expect(remove).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Open securely: Schedule notes.txt' })).toBeDisabled();
  await act(async () => finish());
  expect(screen.queryByRole('button', { name: 'Remove file: Meeting summary.pdf' })).toBeNull();
  expect(await screen.findByRole('button', { name: 'Remove file: Schedule notes.txt' })).toBeEnabled();
  expect(screen.getByText('Attachment removed.')).toBeInTheDocument();
});

it('keeps read-only authorization: file-specific open actions and no remove actions', async () => {
  render(<AttachmentPanel target={target} canWrite={false} />);
  await screen.findByRole('button', { name: 'Open securely: Schedule notes.txt' });
  expect(screen.getByRole('button', { name: 'Open securely: Meeting summary.pdf' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: /^Remove file/ })).not.toBeInTheDocument();
});

it('defaults shared buttons to their visible name and forwards an explicit accessible name', () => {
  render(<><Button label="Refresh attachments" onPress={() => {}} />
    <Button label="Open securely" accessibilityLabel="Open securely: Schedule notes.txt" onPress={() => {}} /></>);
  expect(screen.getByRole('button', { name: 'Refresh attachments' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Open securely: Schedule notes.txt' })).toHaveTextContent(/^Open securely$/);
});
