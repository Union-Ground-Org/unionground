import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '../src/components/MessageActions.jsx';
import { expectHeldWriteFocus, expectPendingFocus } from './helpers/busyWriteFocus.js';
import { MessageReactionPicker, MessageReactionSummary } from '../src/components/MessageReactions.jsx';
import { MESSAGE_REACTION_CHOICES, aggregateMessageReactions } from '../src/features/messaging/reactions.js';
import { REACTION_ARTWORK } from '../src/features/messaging/reactionArtwork.js';
import { LanguageProvider } from '../src/lib/LanguageContext.jsx';

function luminance(hex) {
  const values = hex.slice(1).match(/../g).map(part => parseInt(part, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
}
const aggregate = aggregateMessageReactions([], 'me');
afterEach(() => vi.unstubAllGlobals());

describe('message reaction summary semantics', () => {
  it.each([['en', 'Reactions'], ['es', 'Reacciones']])('names a nonempty group in %s', (lang, name) => {
    render(<LanguageProvider lang={lang}><MessageReactionSummary aggregate={aggregateMessageReactions([
      { actor_id: 'me', reaction: 'care' }, { actor_id: 'peer', reaction: 'care' },
    ], 'me')} onReact={() => {}} /></LanguageProvider>);
    const group = screen.getByRole('group', { name });
    expect(within(group).getAllByRole('button')).toHaveLength(1);
    expect(within(group).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button')).toHaveAccessibleName(/: 2$/);
  });
  it('does not name an empty summary or expose an empty group', () => {
    const { container } = render(<MessageReactionSummary aggregate={aggregate} onReact={() => {}} />);
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('[aria-label]')).toBeNull();
  });
  it('keeps the counted control named, pressed and actionable, and disables it while busy', () => {
    const react = vi.fn();
    const entries = aggregateMessageReactions([{ actor_id: 'me', reaction: 'care' }], 'me');
    const { rerender } = render(<MessageReactionSummary aggregate={entries} onReact={react} />);
    const button = screen.getByRole('button', { name: 'Care: 1', pressed: true });
    fireEvent.click(button);
    expect(react).toHaveBeenCalledWith('care');
    rerender(<MessageReactionSummary aggregate={entries} onReact={react} busy />);
    expect(button).toHaveAttribute("aria-disabled", "true");
  });
});

describe('owner-recovered six-reaction artwork', () => {
  it('shares precisely the six requested identities and the corrected flat fist geometry', () => {
    expect(MESSAGE_REACTION_CHOICES.map(row => row.kind)).toEqual(['seen', 'agreed', 'solidarity', 'care', 'grievance', 'victory']);
    expect(Object.keys(REACTION_ARTWORK)).toEqual(MESSAGE_REACTION_CHOICES.map(row => row.kind));
    expect(REACTION_ARTWORK.solidarity.shapes.slice(1).map(shape => [shape.tag, shape.attrs.x, shape.attrs.y, shape.attrs.width, shape.attrs.height]))
      .toEqual([['rect', '16', '17', '20', '7'], ['rect', '16', '26', '16', '5'], ['rect', '21', '33', '10', '6']]);
  });
  it.each(Object.keys(REACTION_ARTWORK))('%s preserves at least 3:1 internal artwork contrast in either app theme', kind => {
    const { background, foreground } = REACTION_ARTWORK[kind].palette;
    const [hi, lo] = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
    expect((hi + .05) / (lo + .05)).toBeGreaterThanOrEqual(3);
  });
  it('opens six named SVG controls, retains selection and restores focus on Escape', () => {
    const react = vi.fn();
    render(<LanguageProvider lang="en"><MessageReactionPicker aggregate={[{ kind: 'care', mine: true }]} onReact={react} /></LanguageProvider>);
    const trigger = screen.getByRole('button', { name: 'React' });
    fireEvent.click(trigger);
    const choices = screen.getByRole('group', { name: 'Reactions' });
    expect(within(choices).getAllByRole('button')).toHaveLength(6);
    expect(choices.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Care' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Victory' }));
    expect(react).toHaveBeenCalledWith('victory');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Victory' }), { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
  it('moves only the pin on interaction and cancels immediately when Reduce Motion changes', () => {
    const listeners = new Set();
    const media = { matches: false, addEventListener: (_type, cb) => listeners.add(cb), removeEventListener: (_type, cb) => listeners.delete(cb) };
    vi.stubGlobal('matchMedia', () => media);
    render(<MessageReactionPicker aggregate={aggregate} onReact={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'React' }));
    const button = screen.getByRole('button', { name: 'Seen' });
    const cancel = vi.fn();
    button.animate = vi.fn(() => ({ cancel }));
    fireEvent.pointerDown(button);
    expect(button.animate.mock.calls[0][0].at(-1)).toEqual({ transform: 'scale(.85)' });
    fireEvent.click(button);
    expect(button.animate.mock.calls[1][0][1]).toEqual({ transform: 'scale(1.15)', offset: .45 });
    expect(button.animate.mock.calls[1][1].duration).toBe(240);
    act(() => { media.matches = true; listeners.forEach(cb => cb()); });
    expect(cancel).toHaveBeenCalled();
    fireEvent.pointerDown(button); fireEvent.click(button);
    expect(button.animate).toHaveBeenCalledTimes(2);
  });
  it('keeps legacy counts honest and waits for the server before adding a recovered reaction', async () => {
    let finish;
    const api = { toggleReaction: vi.fn(() => new Promise(resolve => { finish = resolve; })), toggleSaved: vi.fn(), remind: vi.fn() };
    const message = { id: 'task-message', reactions: [{ actor_id: 'me', reaction: 'like' }, { actor_id: 'peer', reaction: 'like' }] };
    render(<MessageActions sourceKind="task" message={message} actorId="me" api={api} />);
    expect(screen.getByRole('button', { name: 'Like: 2' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'React' }));
    expect(screen.queryByRole('button', { name: 'Like' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Care' }));
    expect(api.toggleReaction).toHaveBeenCalledWith('task', 'task-message', 'care');
    expect(screen.queryByRole('button', { name: 'Care: 1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Care' })).toHaveAttribute("aria-disabled", "true");
    await act(async () => finish({ reacted: true }));
    expect(screen.getByRole('button', { name: 'Care: 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Like: 2' })).toBeInTheDocument();
  });
});

describe('reaction controls keep focus while a reaction is saved (#8435)', () => {
  it('cancels a press animation when the pointer is cancelled or leaves the reaction', () => {
    const cancel = vi.fn();
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
    const entries = aggregateMessageReactions([{ actor_id: 'me', reaction: 'care' }], 'me');
    render(<MessageReactionSummary aggregate={entries} onReact={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Care: 1', pressed: true });
    button.animate = vi.fn(() => ({ cancel }));
    fireEvent.pointerDown(button);
    fireEvent.pointerCancel(button);
    fireEvent.pointerDown(button);
    fireEvent.pointerLeave(button);
    expect(cancel).toHaveBeenCalled();
  });

  it('keeps the chosen reaction focused while the server confirms it, and reacts once', async () => {
    const api = { toggleReaction: vi.fn(async () => ({ reacted: true })), toggleSaved: vi.fn(), remind: vi.fn() };
    render(<MessageActions sourceKind="task" message={{ id: 'task-message', reactions: [] }} actorId="me" api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'React' }));
    await expectHeldWriteFocus(api.toggleReaction, screen.getByRole('button', { name: 'Care' }));
    expect(api.toggleReaction).toHaveBeenCalledTimes(1);
  });

  it('keeps a counted reaction focusable while its owner is busy', async () => {
    const entries = aggregateMessageReactions([{ actor_id: 'me', reaction: 'care' }], 'me');
    render(<MessageReactionSummary aggregate={entries} onReact={vi.fn()} busy />);
    await expectPendingFocus(screen.getByRole('button', { name: 'Care: 1', pressed: true }));
  });
});
