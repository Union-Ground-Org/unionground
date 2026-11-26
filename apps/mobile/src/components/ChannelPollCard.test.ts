import { createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (element: ReactNode) => string };
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the real card with native primitives mapped to semantic host nodes.
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove() {} }) },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('div', { 'aria-label': accessibilityLabel }, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  Pressable: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('button', { 'aria-label': accessibilityLabel }, children),
}));

import { ChannelPollCard } from './ChannelPollCard';
import { channelPollIsClosed } from '../lib/channelPoll';
import { resolveTheme } from '../theme/tokens';
import { pollShares, type ChannelPoll } from '../data/demoChannels';

const deadline = '2026-10-08T12:00:00-04:00';
const poll: ChannelPoll = {
  closesAt: deadline, question: 'Which night?', mine: 0,
  options: [{ label: 'Tuesday', votes: 3 }, { label: 'Wednesday', votes: 1 }],
};
function card(language: 'en' | 'es', value = poll) {
  return createElement(ChannelPollCard, { poll: value, members: 10, language, theme: resolveTheme(), onVote: vi.fn() });
}
afterEach(() => { vi.useRealTimers(); });

describe('channel poll card', () => {
  it.each(['en', 'es'] as ('en' | 'es')[])('keeps withheld options votable and hides counts and percentages in %s', (language) => {
    const value = { ...poll, closesAt: null, options: poll.options.map(option => ({ ...option, votes: null })) };
    const html = renderToStaticMarkup(card(language, value));
    expect(html).toContain(language === 'en' ? 'Vote counts are withheld.' : 'Los recuentos de votos están ocultos.');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('Tuesday  ✓');
    expect(html).not.toMatch(/percent|por ciento|\d+%|0 VOTED|0 VOTARON/);
    expect(pollShares(value.options)).toEqual([]);
    const closed = renderToStaticMarkup(card(language, { ...value, closesAt: deadline }));
    expect(closed).not.toContain('<button');
    expect(closed).not.toMatch(/Final results|Resultados finales/);
  });
  it.each([
    ['en', 'POLL CLOSED', 'This poll is closed. Final results.'],
    ['es', 'ENCUESTA CERRADA', 'Esta encuesta está cerrada. Resultados finales.'],
  ] as const)('renders closed results without voting controls in %s', (language, heading, results) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(deadline));
    const html = renderToStaticMarkup(card(language));
    expect(html).toContain(heading);
    expect(html).toContain(results);
    expect(html).toContain('75%');
    expect(html).toContain('25%');
    expect(html).toContain('Tuesday');
    expect(html).toContain('Wednesday');
    expect(html).not.toContain('<button');
    const unvoted = renderToStaticMarkup(card(language, { ...poll, mine: null }));
    expect(unvoted).toContain(results);
    expect(unvoted).not.toMatch(/<button|Tap to vote|Toca para votar/);
    expect(html).not.toMatch(/Tap to vote|Toca para votar|aria-label="Vote |aria-label="Votar /);
  });
  it.each([
    ['en', 'Tap to vote', 'Vote Tuesday'],
    ['es', 'Toca para votar', 'Votar Tuesday'],
  ] as const)('keeps open-ended polls votable in %s', (language, prompt, label) => {
    const html = renderToStaticMarkup(card(language, { ...poll, closesAt: null, mine: null }));
    expect(html).toContain(prompt);
    expect(html).toContain(`aria-label="${label}`);
    expect(html.match(/<button/g)).toHaveLength(2);
  });
  it('matches web closure semantics for missing, invalid, future and elapsed deadlines', () => {
    const now = new Date(deadline).getTime();
    expect(channelPollIsClosed({}, now)).toBe(false);
    expect(channelPollIsClosed({ closesAt: null }, now)).toBe(false);
    expect(channelPollIsClosed({ closesAt: 'invalid' }, now)).toBe(false);
    expect(channelPollIsClosed(poll, now - 1)).toBe(false);
    expect(channelPollIsClosed(poll, now)).toBe(true);
    expect(channelPollIsClosed(poll, now + 1)).toBe(true);
  });
});
