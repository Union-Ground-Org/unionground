vi.mock('react', async () => await import('react'));
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ reduced: false, timing: vi.fn(), sequence: vi.fn(), targets: [] }));
vi.mock('react-native', () => ({
  Animated: {
    Value: class { setValue() {} stopAnimation() {} },
    timing: mock.timing, sequence: mock.sequence,
    View: ({ children }) => <span>{children}</span>,
  },
  StyleSheet: { create: value => value },
  Text: ({ children }) => <span>{children}</span>,
  View: ({ children, accessibilityLabel }) => <div aria-label={accessibilityLabel}>{children}</div>,
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
  Pressable: props => {
    mock.targets.push(props);
    return <button aria-label={props.accessibilityLabel} aria-pressed={props.accessibilityState.selected} disabled={props.disabled}
      onPointerDown={props.onPressIn} onPointerUp={props.onPressOut} onClick={props.onPress}>{props.children}</button>;
  },
}));
// Root CI has no Expo SDK; the add-reaction chip's icons render nothing here.
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-svg', () => ({
  default: ({ children, viewBox }) => <svg viewBox={viewBox}>{children}</svg>,
  Path: props => <path {...props} />, Circle: props => <circle {...props} />, Rect: props => <rect {...props} />,
  Line: props => <line {...props} />, Polygon: props => <polygon {...props} />,
}));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({ useApp: () => ({ memberLanguage: 'en' }) }));
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../apps/mobile/src/lib/reduceMotion', () => ({ useReduceMotion: () => mock.reduced }));
vi.mock('../apps/mobile/src/components/NumberFlow', () => ({ NumberFlow: ({ value }) => <span>{value}</span> }));
import { MessageReactionPicker, MessageReactionButton } from '../apps/mobile/src/components/MessageReactions';
beforeEach(() => {
  vi.clearAllMocks(); mock.reduced = false; mock.targets = [];
  mock.timing.mockReturnValue({ start: vi.fn() }); mock.sequence.mockReturnValue({ start: vi.fn() });
});
it('renders six SVG choices and separately keeps a legacy own reaction removable', () => {
  const react = vi.fn();
  render(<MessageReactionPicker mine={['like', 'care']} onReact={react} />);
  expect(screen.getByLabelText('Reaction choices').querySelectorAll('button')).toHaveLength(6);
  expect(screen.getByLabelText('Reaction choices').querySelectorAll('svg')).toHaveLength(6);
  expect(screen.getByRole('button', { name: 'Care' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Like' }));
  expect(react).toHaveBeenCalledWith('like');
  const solidarity = screen.getByRole('button', { name: 'Solidarity' });
  expect(solidarity.querySelector('rect')).toHaveAttribute('width', '20');
  for (const target of mock.targets) expect(target.style[0].minHeight).toBeGreaterThanOrEqual(48);
});
it('uses the 85% press and 115%-to-rest release, with no movement under Reduce Motion', () => {
  const props = { entry: { kind: 'seen' }, onPress: vi.fn() };
  const view = render(<MessageReactionButton {...props} />);
  const button = screen.getByRole('button', { name: 'Seen' });
  fireEvent.pointerDown(button); fireEvent.pointerUp(button);
  expect(mock.timing.mock.calls.map(call => [call[1].toValue, call[1].duration])).toEqual([[.85, 80], [1.15, 108], [1, 132]]);
  mock.reduced = true; view.rerender(<MessageReactionButton {...props} />);
  fireEvent.pointerDown(button); fireEvent.pointerUp(button);
  expect(mock.timing).toHaveBeenCalledTimes(3);
});
it('announces confirmed counts once and prevents disabled actions', () => {
  const press = vi.fn();
  const view = render(<MessageReactionButton entry={{ kind: 'victory', count: 2, mine: true }} showCount disabled onPress={press} />);
  const button = screen.getByRole('button', { name: 'Victory: 2' });
  fireEvent.click(button); expect(press).not.toHaveBeenCalled();
  view.rerender(<MessageReactionButton entry={{ kind: 'victory', count: 3, mine: true }} showCount onPress={press} />);
  expect(screen.getByRole('button', { name: 'Victory: 3' })).toHaveAttribute('aria-pressed', 'true');
});
