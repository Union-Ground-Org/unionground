vi.mock('react', async () => await import('react'));
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), texts: [], platform: { OS: 'ios' }, listeners: new Set() }));
vi.mock('react-native', () => ({
  Platform: mock.platform,
  AppState: { currentState: 'active', addEventListener: (_name, callback) => { mock.listeners.add(callback); return { remove: () => mock.listeners.delete(callback) }; } },
  Text: (props) => { mock.texts.push(props); return <span role={props.accessibilityRole === 'alert' ? 'alert' : undefined}>{props.children}</span>; },
  View: ({ children }) => <div>{children}</div>,
  Pressable: ({ children, onPress, accessibilityLabel }) => <button aria-label={accessibilityLabel} onClick={onPress}>{children}</button>,
  StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../apps/mobile/src/lib/reduceMotion', () => ({ useReduceMotion: () => false }));
vi.mock('../apps/mobile/src/components/ui', () => ({ Body: ({ children }) => <p>{children}</p>, Button: ({ label, onPress, disabled }) => <button onClick={onPress} disabled={disabled}>{label}</button> }));
vi.mock('../apps/mobile/src/components/NativeMessageActions', () => ({ NativeMessageActions: ({ children, onCompose, accessibilityLabel }) => <div aria-label={accessibilityLabel}>{children}<button onClick={() => onCompose('reply')}>Reply action</button></div> }));
vi.mock('../apps/mobile/src/services/supabase', () => ({ getSupabaseClient: () => ({ rpc: mock.rpc }) }));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({ useApp: () => ({ memberLanguage: 'en' }) }));
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({ useTheme: () => ({ foreground: 'ink', mutedForeground: 'muted', destructive: 'error' }) }));
// Root CI has no Expo SDK. Keep the chart viewer boundary native while
// exercising the reply renderer and its existing message actions here.
vi.mock('../apps/mobile/src/features/SavedPulseCharts', () => ({ LiveChartMessage: () => <button>Open shared chart</button> }));
import { MessageReplies } from '../apps/mobile/src/components/MessageReplies';
import { deviceDateTime } from '../apps/mobile/src/lib/evidenceTimestamp';
const parent = { id: 'old-parent', body: 'Outside the loaded window', author_name: 'Parent author', created_at: '2026-01-01T00:00:00Z' };
const reply = (id) => ({ id, body: id, author_name: 'Reply author', created_at: '2026-09-07T00:00:00Z', parent_id: parent.id });
const first = { parent, replies: [reply('reply-a')], count: 2, hasMore: true };
beforeEach(() => { vi.clearAllMocks(); mock.texts = []; mock.platform.OS = 'ios'; mock.rpc.mockResolvedValue({ data: first }); });

it.each(['private', 'channel'])('offers live charts and reply actions for %s chart parents and replies without revealing removed references', async sourceKind => {
  const reference = '[pulse-chart:123e4567-e89b-42d3-a456-426614174000]';
  const chartParent = { ...parent, body: reference };
  mock.rpc.mockResolvedValue({ data: { parent: chartParent, replies: [
    { ...reply('chart-reply'), body: reference },
    { ...reply('removed-reply'), body: reference, redacted_at: '2026-11-01' },
  ], count: 2, hasMore: false } });
  const compose = vi.fn();
  render(<MessageReplies sourceKind={sourceKind} targetID="target" parentID={parent.id} onCompose={compose} onClose={() => {}} />);
  expect(await screen.findAllByRole('button', { name: 'Open shared chart' })).toHaveLength(2);
  expect(screen.queryByText(reference)).not.toBeInTheDocument();
  expect(screen.getByText('Message removed.')).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'Reply action' })[0]);
  expect(compose).toHaveBeenCalledWith('reply', chartParent);
});

it.each(['private', 'channel'])('retrieves the unloaded %s parent, paginates without duplicates and exposes reply actions', async (sourceKind) => {
  const compose = vi.fn(), close = vi.fn();
  render(<MessageReplies sourceKind={sourceKind} targetID="target" parentID={parent.id} onCompose={compose} onClose={close} />);
  expect(await screen.findByText(parent.body)).toBeInTheDocument();
  expect(mock.rpc).toHaveBeenCalledWith('get_member_message_replies', expect.objectContaining({ p_source_kind: sourceKind, p_target_id: 'target', p_parent_id: parent.id }));
  mock.rpc.mockResolvedValueOnce({ data: { ...first, replies: [reply('reply-a'), reply('reply-b')], hasMore: false } });
  fireEvent.click(screen.getByRole('button', { name: 'Load more replies' }));
  await screen.findByText('reply-b');
  expect(screen.getAllByText('reply-a')).toHaveLength(1);
  expect(mock.rpc).toHaveBeenLastCalledWith('get_member_message_replies', expect.objectContaining({ p_after_id: 'reply-a', p_after_at: reply('reply-a').created_at }));
  expect(screen.queryByRole('button', { name: 'Load more replies' })).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'Reply action' })[0]);
  expect(compose).toHaveBeenCalledWith('reply', parent);
  fireEvent.click(screen.getByRole('button', { name: 'All messages' })); expect(close).toHaveBeenCalled();
});

it.each(['private', 'channel'])('exposes nested %s reply navigation and the ancestor outside this page', async (sourceKind) => {
  mock.rpc.mockResolvedValue({ data: { ...first, parent: { ...parent, parent_id: 'ancestor' } } });
  const open = vi.fn();
  render(<MessageReplies sourceKind={sourceKind} targetID="target" parentID={parent.id} onCompose={() => {}} onClose={() => {}} onOpenParent={open} />);
  fireEvent.click(await screen.findByRole('button', { name: 'View parent message' }));
  expect(open).toHaveBeenLastCalledWith('ancestor');
  fireEvent.click(screen.getByRole('button', { name: 'View replies' }));
  expect(open).toHaveBeenLastCalledWith('reply-a');
});

it('keeps loaded text on a transient load-more failure and retries from the first page', async () => {
  render(<MessageReplies sourceKind="private" targetID="target" parentID={parent.id} onCompose={() => {}} onClose={() => {}} />);
  await screen.findByText(parent.body);
  mock.rpc.mockResolvedValueOnce({ error: new Error('temporary network failure') });
  fireEvent.click(screen.getByRole('button', { name: 'Load more replies' }));
  await screen.findByRole('alert'); expect(screen.getByText(parent.body)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try replies again' }));
  await screen.findByText(parent.body);
  expect(mock.rpc).toHaveBeenLastCalledWith('get_member_message_replies', expect.objectContaining({ p_after_id: null }));
});

it('clears stale text on a 42501 authorization denial and retries from the first page', async () => {
  render(<MessageReplies sourceKind="private" targetID="target" parentID={parent.id} onCompose={() => {}} onClose={() => {}} />);
  await screen.findByText(parent.body);
  mock.rpc.mockResolvedValueOnce({ error: Object.assign(new Error('message unavailable'), { code: '42501' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Load more replies' }));
  await screen.findByRole('alert'); expect(screen.queryByText(parent.body)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try replies again' }));
  await screen.findByText(parent.body);
  expect(mock.rpc).toHaveBeenLastCalledWith('get_member_message_replies', expect.objectContaining({ p_after_id: null }));
});

it('discards a late page after route change and authoritative refresh replaces cached text', async () => {
  let finish;
  mock.rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const props = { sourceKind: 'channel', targetID: 'target', parentID: parent.id, onCompose: () => {}, onClose: () => {} };
  const view = render(<MessageReplies {...props} />);
  mock.rpc.mockResolvedValue({ data: { parent: { ...parent, id: 'new', body: 'New parent' }, replies: [], count: 0, hasMore: false } });
  view.rerender(<MessageReplies {...props} parentID="new" />);
  await screen.findByText('New parent');
  await act(async () => finish({ data: first }));
  expect(screen.queryByText(parent.body)).not.toBeInTheDocument();
  mock.rpc.mockResolvedValue({ error: new Error('temporary network failure') });
  await act(async () => mock.listeners.forEach((callback) => callback('active')));
  expect(screen.getByText('New parent')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Replies unavailable.');
});

// A11Y-UG-MOBILE-CHANNEL-AND-REPLY-ROW-NAMES-OMIT-SENDER-20260915: the row
// control was named by its body alone, so VoiceOver read a reply with no writer.
it('names each reply control as sender then body and says the sender once', async () => {
  render(<MessageReplies sourceKind="private" targetID="target" parentID={parent.id} onCompose={() => {}} onClose={() => {}} />);
  await screen.findByText(parent.body);
  expect(screen.getByLabelText(`${parent.author_name}: ${parent.body}`)).toBeInTheDocument();
  expect(screen.getByLabelText('Reply author: reply-a')).toBeInTheDocument();
  // The metadata line still shows the author, and announces only what the row
  // name does not already say.
  const metaLabels = mock.texts.map((props) => props.accessibilityLabel).filter(Boolean);
  expect(metaLabels.some((label) => label.includes(parent.author_name))).toBe(false);
  expect(metaLabels).toContain(deviceDateTime(parent.created_at, 'en-US'));
});

it('names a removed reply by its sender and the tombstone rather than the stored body', async () => {
  mock.rpc.mockResolvedValue({ data: { parent: { ...parent, redacted_at: '2026-09-08T00:00:00Z' }, replies: [], count: 0, hasMore: false } });
  render(<MessageReplies sourceKind="private" targetID="target" parentID={parent.id} onCompose={() => {}} onClose={() => {}} />);
  expect(await screen.findByLabelText(`${parent.author_name}: Message removed.`)).toBeInTheDocument();
  expect(screen.queryByText(parent.body)).not.toBeInTheDocument();
});

it('new action and reply components delegate native menu motion and contain no app-owned animation', () => {
  for (const path of ['apps/mobile/src/components/NativeMessageActions.tsx', 'apps/mobile/src/components/MessageReplies.tsx']) {
    const source = readFileSync(path, 'utf8');
    expect(source).not.toMatch(/Animated\.|withSpring\(|withTiming\(|LayoutAnimation|allowFontScaling=\{false\}/);
  }
  const primitives = readFileSync('apps/mobile/src/components/PressableScale.tsx', 'utf8');
  expect(primitives).toContain('useReduceMotion');
});

it.each(['ios', 'android'])('%s reply text retains system scaling without app-owned motion or fixed text boxes', async (platform) => {
  mock.platform.OS = platform;
  render(<MessageReplies sourceKind="private" targetID="target" parentID={parent.id} onCompose={() => {}} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText(parent.body)).toBeInTheDocument());
  for (const text of mock.texts) {
    expect(text.allowFontScaling).not.toBe(false);
    expect(text.maxFontSizeMultiplier).toBeUndefined();
    expect(text.numberOfLines).toBeUndefined();
    expect(text.style?.height).toBeUndefined();
  }
});
