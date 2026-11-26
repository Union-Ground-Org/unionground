import { stubSessionWriter } from '../apps/mobile/src/testing/stubSessionWriter';
vi.mock('react', async () => await import('react'));
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), sheet: vi.fn(), alert: vi.fn(), reader: false, platform: { OS: 'ios' }, compose: vi.fn(), success: vi.fn(), targets: [], texts: [], views: [], layouts: [], readerKnownOff: true, language: 'en' }));
// Root CI has no Expo SDK; the actions control's icon renders nothing here.
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native', () => ({
  Platform: mock.platform, ActionSheetIOS: { showActionSheetWithOptions: mock.sheet }, Alert: { alert: mock.alert },
  StyleSheet: { create: (s) => s }, View: ({ children, style, onLayout }) => { mock.views.push(style); if (onLayout) mock.layouts.push(onLayout); return <div>{children}</div>; }, Text: (props) => { mock.texts.push(props); return <span>{props.children}</span>; },
  Pressable: (props) => { mock.targets.push(props); return <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress} onContextMenu={props.onLongPress} onKeyDown={() => props.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } })}>{props.children}</button>; },
}));
vi.mock('../apps/mobile/src/components/MessageReactions', () => ({
  MessageReactionPicker: ({ mine, disabled, onReact }) => <div>{['seen', 'agreed', 'solidarity', 'care', 'grievance', 'victory'].map(kind => <button key={kind} disabled={disabled} aria-pressed={mine.includes(kind)} onClick={() => onReact(kind)}>{kind}</button>)}</div>,
}));
vi.mock('../apps/mobile/src/services/supabase', () => ({captureSessionWriter: () => stubSessionWriter(() => ({rpc:mock.rpc})), getSupabaseClient: () => ({ rpc: mock.rpc }) }));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({ useApp: () => ({ memberLanguage: mock.language }) }));
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../apps/mobile/src/lib/screenReader', () => ({ useScreenReader: () => mock.reader, useScreenReaderKnownOff: () => mock.readerKnownOff }));
vi.mock('../apps/mobile/src/services/haptics', () => ({ haptics: { select: vi.fn(), success: mock.success, warning: vi.fn() } }));
import { NativeMessageActions } from '../apps/mobile/src/components/NativeMessageActions';
import { reconcileOwnReactions } from '../src/features/messaging/reactions.js';
const state = { canEdit: true, saved: false, reminders: [], reactions: [] };
const mount = () => render(<NativeMessageActions sourceKind="private" messageID="m1" onCompose={mock.compose}>Message</NativeMessageActions>);
beforeEach(() => { vi.clearAllMocks(); mock.sheet.mockReset(); mock.targets = []; mock.texts = []; mock.views = []; mock.layouts = []; mock.readerKnownOff = true; mock.reader = false; mock.platform.OS = 'ios'; mock.language = 'en'; mock.rpc.mockResolvedValue({ data: state }); });
it.each(['reply', 'edit'])('the first native %s menu opens before passive mount effects settle', async (kind) => {
  mock.sheet.mockImplementation((options, choose) => choose(options.options.indexOf(kind === 'edit' ? 'Edit message' : 'Reply')));
  const host = document.createElement('div');
  document.body.append(host);
  let clicked = false;
  // Observe the real DOM commit, before React flushes passive mount effects.
  // Wrapping this initial render/click in act would hide the reported boundary.
  const observer = new MutationObserver(() => {
    const button = host.querySelector('[aria-label="Open message actions"]');
    if (!button || clicked) return;
    clicked = true;
    observer.disconnect();
    button.click();
  });
  observer.observe(host, { subtree: true, childList: true });
  const root = createRoot(host);
  try {
    root.render(<NativeMessageActions sourceKind="private" messageID="m1" onCompose={mock.compose}>Message</NativeMessageActions>);
    await waitFor(() => expect(clicked).toBe(true));
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mock.compose).toHaveBeenCalledWith(kind));
    expect(mock.sheet).toHaveBeenCalledTimes(1);
    expect(mock.compose).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[aria-label="Open message actions"]')).toBeEnabled();
  } finally {
    observer.disconnect();
    await act(async () => root.unmount());
    host.remove();
  }
});

it('publishes confirmed reactions to surrounding rows without erasing peer counts', async () => {
  const confirmed = vi.fn();
  mock.rpc.mockResolvedValue({ data: { state: { ...state, reactions: ['strength'] } } });
  render(<NativeMessageActions sourceKind="channel" messageID="p1" onCompose={mock.compose} onConfirmed={confirmed}>Post</NativeMessageActions>);
  const row = screen.getByRole('button', { name: 'Post' }); fireEvent.click(row); fireEvent.click(row);
  await waitFor(() => expect(confirmed).toHaveBeenCalledWith(expect.objectContaining({ reactions: ['strength'] })));
  const result = reconcileOwnReactions([{ kind: 'like', count: 3, mine: true }, { kind: 'strength', count: 2, mine: false }], ['strength']);
  expect(result.find((entry) => entry.kind === 'like')).toMatchObject({ count: 2, mine: false });
  expect(result.find((entry) => entry.kind === 'strength')).toMatchObject({ count: 3, mine: true });
});

it('long press and the visible button open the native menu with edit and reply', async () => {
  mount(); fireEvent.contextMenu(screen.getByRole('button', { name: 'Message' }));
  await waitFor(() => expect(mock.sheet).toHaveBeenCalled());
  expect(mock.sheet.mock.calls[0][0].options).toEqual(['Reply', 'Edit message', 'React', 'Save message', 'Remind me…', 'Cancel']);
  await act(async () => { await mock.sheet.mock.calls[0][1](1); }); expect(mock.compose).toHaveBeenCalledWith('edit');
  fireEvent.click(screen.getByRole('button', { name: 'Open message actions' }));
  await waitFor(() => expect(mock.sheet).toHaveBeenCalledTimes(2));
});
it('double tap toggles Like and preserves confirmed state without a second read', async () => {
  mock.rpc.mockResolvedValue({ data: { state: { ...state, saved: true } } });
  mount(); const row = screen.getByRole('button', { name: 'Message' });
  fireEvent.click(row); fireEvent.click(row);
  await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('act_on_member_message', expect.objectContaining({ p_action: 'react', p_value: 'like' })));
  // The status run is its own Text (full colour), so match the whole label.
  const label = (_content, element) => element?.tagName === 'SPAN' && element.textContent.trim() === 'Actions · Saved'
    && ![...element.children].some((child) => child.textContent.trim() === 'Actions · Saved');
  expect(await screen.findByText(label)).toBeInTheDocument(); expect(mock.success).toHaveBeenCalled();
});
it('screen-reader activation opens actions rather than interpreting double taps', async () => {
  mock.reader = true; mount(); fireEvent.click(screen.getByRole('button', { name: 'Message' }));
  await waitFor(() => expect(mock.sheet).toHaveBeenCalled());
  expect(mock.rpc).toHaveBeenCalledWith('get_member_message_actions', expect.anything());
});
it('names first and grouped conversation rows as sender then body', () => {
  render(
    <>
      <NativeMessageActions sourceKind="private" messageID="m1" accessibilityLabel="Member: Original" onCompose={mock.compose}>Original</NativeMessageActions>
      <NativeMessageActions sourceKind="private" messageID="m2" accessibilityLabel="Member: Follow-up" onCompose={mock.compose}>Follow-up</NativeMessageActions>
    </>,
  );
  expect(screen.getByRole('button', { name: /^Member: Original/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Member: Follow-up/ })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Open message actions' })).toHaveLength(2);
});
it('hides incoming sender metadata that would duplicate the row VoiceOver name', () => {
  const conversation = readFileSync(resolve(process.cwd(), 'apps/mobile/app/conversation/[id].tsx'), 'utf8');
  expect(conversation).toContain('const rowName = `${message.senderName}: ${bodyText}`;');
  expect(conversation).toContain('accessibilityLabel={rowName}');
  expect(conversation).toMatch(
    /!mine && !sameSender \? \(\s*<View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">\s*<Avatar initials=\{initialsFor\(message\.senderName\)\}/,
  );
  expect(conversation).toContain('style={styles.senderRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"');
  expect(conversation).toContain('<WorkflowMessageActions');
});
it.each(['ios', 'android'])('%s accessibility activation uses the native menu and scalable, unconstrained labels', async (platform) => {
  mock.platform.OS = platform; mock.reader = true; mount();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Message' }), { key: 'Enter' });
  await waitFor(() => expect(platform === 'ios' ? mock.sheet : mock.alert).toHaveBeenCalled());
  for (const target of mock.targets) {
    expect(target.accessibilityRole).toBe('button');
    // The row wrapper is named by the bubble children (sender + text), never a fixed
    // label (A11Y-UG-MOBILE-VOICEOVER-CONVERSATION-BUBBLE-TEXT-20260913); every
    // other control keeps an explicit label.
    if (Array.isArray(target.accessibilityActions)) expect(target.accessibilityLabel).toBeUndefined();
    else expect(target.accessibilityLabel).toBeTruthy();
    // A pressed-state style keeps the same full-height target at rest and pressed.
    const states = typeof target.style === 'function' ? [target.style({ pressed: false }), target.style({ pressed: true })] : [target.style];
    for (const style of states) {
      const flat = Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
      expect(flat.minHeight).toBeGreaterThanOrEqual(48);
      expect(flat.height).toBeUndefined();
    }
  }
  for (const text of mock.texts) {
    expect(text.allowFontScaling).not.toBe(false);
    expect(text.maxFontSizeMultiplier).toBeUndefined();
    expect(text.numberOfLines).toBeUndefined();
  }
  expect(mock.rpc).not.toHaveBeenCalledWith('act_on_member_message', expect.anything());
});

// A one-line channel body centred in its 48 pt target had a band of space
// above and below its words. Reaching up over the plain author line keeps the
// full target, at rest and pressed, with no space added around the words.
it('a body that reaches over the line above keeps its whole 48 pt target', () => {
  const flat = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
  const body = (label) => flat(mock.targets.filter((target) => target.accessibilityLabel === label).at(-1).style);
  render(<NativeMessageActions sourceKind="channel" messageID="m1" reachAbove={19} accessibilityLabel="Ana: Hi" onCompose={mock.compose}>Hi</NativeMessageActions>);
  expect(body('Ana: Hi')).toMatchObject({ minHeight: 48, justifyContent: 'flex-start', paddingTop: 23, paddingVertical: 4 });
  expect(body('Ana: Hi').height).toBeUndefined();
  expect(mock.views).toContainEqual({ marginTop: -19 });
  // A measured one-line body keeps the reach; a longer body, which fills its
  // target, reaches no further than it must, and the words stay put.
  act(() => mock.layouts.at(-1)({ nativeEvent: { layout: { height: 21 } } }));
  expect(body('Ana: Hi')).toMatchObject({ minHeight: 48, paddingTop: 23 });
  act(() => mock.layouts.at(-1)({ nativeEvent: { layout: { height: 30 } } }));
  expect(body('Ana: Hi')).toMatchObject({ minHeight: 48, paddingTop: 14 });
  expect(mock.views.at(-2)).toEqual({ marginTop: -10 });
  act(() => mock.layouts.at(-1)({ nativeEvent: { layout: { height: 42 } } }));
  expect(body('Ana: Hi')).toMatchObject({ minHeight: 48, justifyContent: 'center', paddingVertical: 4 });
  expect(body('Ana: Hi').paddingTop).toBeUndefined();
  mock.targets = []; mock.views = []; mock.layouts = [];
  mount();
  expect(flat(mock.targets.find((target) => Array.isArray(target.accessibilityActions)).style)).toMatchObject({ minHeight: 48, justifyContent: 'center', paddingVertical: 4 });
  // A body with nothing to reach is not measured.
  expect(mock.layouts).toHaveLength(0);
  expect(mock.views.filter(Boolean)).not.toContainEqual(expect.objectContaining({ marginTop: expect.any(Number) }));
  // Until no screen reader is known to run (probe pending, failed, or a reader
  // on), the body keeps its own frame so the elements in the line above stay
  // apart for touch exploration.
  for (const [reader, knownOff] of [[false, false], [true, false]]) {
    mock.targets = []; mock.views = []; mock.reader = reader; mock.readerKnownOff = knownOff;
    render(<NativeMessageActions sourceKind="channel" messageID="m2" reachAbove={19} accessibilityLabel="Bo: Hi" onCompose={mock.compose}>Hi</NativeMessageActions>);
    expect(body('Bo: Hi')).toMatchObject({ minHeight: 48, justifyContent: 'center', paddingVertical: 4 });
    expect(mock.views.filter(Boolean)).not.toContainEqual(expect.objectContaining({ marginTop: expect.any(Number) }));
  }
});
it('Android uses reachable native dialog pages', async () => {
  mock.platform.OS = 'android'; mount(); fireEvent.click(screen.getByRole('button', { name: 'Open message actions' }));
  await waitFor(() => expect(mock.alert).toHaveBeenCalled());
  expect(mock.alert.mock.calls[0][2][0].text).toBe('Reply');
  act(() => mock.alert.mock.calls[0][2][1].onPress());
  expect(mock.alert.mock.calls[1][2][0].text).toBe('Edit message');
});
it.each(['message', 'source', 'disabled', 'unmount'])('refuses a retained native menu callback after %s changes', async (change) => {
  const view = mount(); fireEvent.click(screen.getByRole('button', { name: 'Open message actions' }));
  await waitFor(() => expect(mock.sheet).toHaveBeenCalled());
  const callback = mock.sheet.mock.calls[0][1];
  if (change === 'unmount') view.unmount();
  else view.rerender(<NativeMessageActions sourceKind={change === 'source' ? 'channel' : 'private'}
    messageID={change === 'message' ? 'm2' : 'm1'} enabled={change !== 'disabled'} onCompose={mock.compose}>Other</NativeMessageActions>);
  await act(async () => { await callback(1); }); expect(mock.compose).not.toHaveBeenCalled();
});
it.each(['message', 'source', 'disabled', 'unmount'])('discards an in-flight native menu response after %s changes', async (change) => {
  let finish;
  mock.rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Open message actions' }));
  await waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(1));
  const props = { sourceKind: change === 'source' ? 'channel' : 'private', messageID: change === 'message' ? 'm2' : 'm1', onCompose: mock.compose };
  if (change === 'unmount') view.unmount();
  else view.rerender(<NativeMessageActions {...props} enabled={change !== 'disabled'}>Other</NativeMessageActions>);
  await act(async () => finish({ data: state }));
  expect(mock.sheet).not.toHaveBeenCalled();
  expect(mock.compose).not.toHaveBeenCalled();
  if (change === 'unmount') return;
  if (change === 'disabled') view.rerender(<NativeMessageActions {...props}>Other</NativeMessageActions>);
  mock.sheet.mockImplementation((options, choose) => choose(options.options.indexOf('Reply')));
  fireEvent.click(screen.getByRole('button', { name: 'Open message actions' }));
  await waitFor(() => expect(mock.compose).toHaveBeenCalledWith('reply'));
  expect(mock.sheet).toHaveBeenCalledTimes(1);
  expect(mock.rpc).toHaveBeenLastCalledWith('get_member_message_actions',
    { p_source_kind: props.sourceKind, p_message_id: props.messageID });
});
it('loading disables repeat actions and a denied request exposes retryable failure', async () => {
  let finish; mock.rpc.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  mount(); const button = screen.getByRole('button', { name: 'Open message actions' }); fireEvent.click(button);
  expect(button).toBeDisabled();
  await waitFor(() => expect(finish).toEqual(expect.any(Function)));
  await act(async () => finish({ error: new Error('denied') }));
  expect(screen.getByText('Action not confirmed. Try again.')).toBeInTheDocument(); expect(button).toBeEnabled();
  expect(mock.sheet).not.toHaveBeenCalled();
});

// UX-UG-NATIVE-MESSAGE-ACTIONS-POLISH-BATCH-20261111 (#8304): with the
// saved member language Spanish, both platforms' sheets, the control's names and
// the failure notice are Spanish; the choice ids and requests stay the same.
it('iOS shows the action sheet in the saved Spanish and keeps each choice wired to its id', async () => {
  mock.language = 'es';
  mock.sheet.mockImplementation((options, choose) => choose(options.options.indexOf('Responder')));
  mount();
  expect(mock.targets.find((props) => props.accessibilityLabel === 'Abrir acciones del mensaje')).toBeTruthy();
  expect(mock.targets.find((props) => props.accessibilityHint)?.accessibilityHint)
    .toBe('Abre las acciones. Sin lector de pantalla, dos toques marcan o quitan Me gusta.');
  expect(mock.targets.find((props) => props.accessibilityActions)?.accessibilityActions.map((action) => action.label))
    .toEqual(['Acciones del mensaje', 'Acciones del mensaje']);
  fireEvent.click(screen.getByRole('button', { name: 'Abrir acciones del mensaje' }));
  await waitFor(() => expect(mock.compose).toHaveBeenCalledWith('reply'));
  const [options] = mock.sheet.mock.calls[0];
  expect(options.title).toBe('Acciones del mensaje');
  expect(options.options).toEqual(['Responder', 'Editar mensaje', 'Reaccionar', 'Guardar mensaje', 'Recordarme…', 'Cancelar']);
  expect(options.cancelButtonIndex).toBe(5);
});
it('Android pages the saved Spanish action dialogs with Spanish More actions and Cancel', async () => {
  mock.language = 'es'; mock.platform.OS = 'android';
  mock.rpc.mockResolvedValue({ data: { ...state, saved: true, reminders: [{ id: 'r1' }] } });
  mount(); fireEvent.click(screen.getByRole('button', { name: 'Abrir acciones del mensaje' }));
  await waitFor(() => expect(mock.alert).toHaveBeenCalled());
  const first = mock.alert.mock.calls[0];
  expect(first[0]).toBe('Acciones del mensaje');
  expect(first[2].map((button) => button.text)).toEqual(['Responder', 'Más acciones', 'Cancelar']);
  for (let page = 1; page < 5; page += 1) act(() => mock.alert.mock.calls[page - 1][2][1].onPress());
  expect(mock.alert.mock.calls.map((call) => call[2][0].text))
    .toEqual(['Responder', 'Editar mensaje', 'Reaccionar', 'Quitar de guardados', 'Quitar recordatorios']);
  expect(mock.alert.mock.calls[4][2].map((button) => button.text)).toEqual(['Quitar recordatorios', 'Cancelar']);
});
it.each(['ios', 'android'])('%s shows the confirmed state and the retryable failure in the saved Spanish', async (os) => {
  mock.language = 'es'; mock.platform.OS = os;
  let finish; mock.rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  mount(); const button = screen.getByRole('button', { name: 'Abrir acciones del mensaje' }); fireEvent.click(button);
  expect(button.textContent).toContain('Actualizando…');
  await waitFor(() => expect(finish).toEqual(expect.any(Function)));
  await act(async () => finish({ error: new Error('denied') }));
  expect(screen.getByText('Acción no confirmada. Inténtalo de nuevo.')).toBeInTheDocument();
  expect(button).toBeEnabled();
  expect(button.textContent.trim()).toBe('Acciones');
});
