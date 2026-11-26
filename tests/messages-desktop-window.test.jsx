import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessagesView } from '../src/views/MessagesView.jsx';
import { LanguageProvider } from '../src/lib/LanguageContext.jsx';

const originalScroll = Element.prototype.scrollIntoView;
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  if (originalScroll) Element.prototype.scrollIntoView = originalScroll;
  else delete Element.prototype.scrollIntoView;
});
function data(count = 300) {
  return { member: { id: 'tamarack-reader' }, product: { spaces: [] }, broadcasts: [],
    conversations: Array.from({ length: count }, (_, i) => ({ id: `tamarack-${i}`, sender: `Tamarack colleague ${String(i).padStart(3, '0')}`, preview: 'Tamarack agenda', unread: i === 0 ? 2 : 0,
      updatedAt: '2026-11-09T17:00:00Z', dateLabel: 'Nov 9, 12:00 PM ET', messages: [{ id: `tamarack-message-${i}`, body: 'Tamarack agenda', sender_kind: 'steward', sender_name: 'Alex Chen', created_at: '2026-11-09T17:00:00Z' }] })) };
}
function mount(snapshot, extra = {}) {
  return render(<MessagesView data={snapshot} desktop onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onSendMessage={vi.fn()} onOpenTopics={vi.fn()} {...extra} />);
}
const rows = () => document.querySelectorAll('.inbox-row');

it('bounds a 300-conversation desktop inbox, pages with focus and keeps the opened conversation selected', async () => {
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  mount(data());
  expect(rows()).toHaveLength(20);
  expect(screen.getByText('300 items')).toBeInTheDocument();
  fireEvent.click(rows()[0]);
  expect(rows()[0]).toHaveAttribute('aria-pressed', 'true');
  const next = screen.getByRole('button', { name: 'Next' });
  next.focus();
  fireEvent.click(next);
  expect(rows()).toHaveLength(20);
  expect(rows()[0]).toHaveTextContent('Tamarack colleague 020');
  expect(rows()[0]).toHaveFocus();
  expect(scroll).toHaveBeenCalled();
  expect(within(screen.getByRole('region', { name: 'Message detail' })).getByText('Tamarack colleague 000')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  expect(rows()[0]).toHaveAttribute('aria-pressed', 'true');
  fireEvent.change(screen.getByPlaceholderText('Search people & threads…'), { target: { value: 'colleague 299' } });
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent('Tamarack colleague 299');
});

it('reuses rendered inbox dates when a conversation opens, and retains its date output', () => {
  const snapshot = data(2);
  snapshot.broadcasts = Array.from({ length: 100 }, (_, i) => ({ id: `tamarack-notice-${i}`, title: `Tamarack notice ${i}`, body: 'Agenda', sender: 'Tamarack', publishedAt: new Date(Date.UTC(2026, 10, 8) - i * 3600000).toISOString() }));
  const Original = Intl.DateTimeFormat;
  const format = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args) { return new Original(...args); });
  mount(snapshot);
  const before = format.mock.calls.length;
  fireEvent.click(rows()[0]);
  expect(format.mock.calls.length - before).toBeLessThan(5);
  expect(document.querySelector('.inbox-detail time')).toHaveTextContent(/2026/);
});

it('opens a conversation without rescanning the entire unchanged inbox', () => {
  let reads = 0;
  const snapshot = data();
  snapshot.conversations.forEach(row => {
    const updatedAt = row.updatedAt;
    Object.defineProperty(row, 'updatedAt', { enumerable: true, get: () => { reads += 1; return updatedAt; } });
  });
  const view = mount(snapshot);
  const before = reads;
  fireEvent.click(rows()[0]);
  expect(reads - before).toBeLessThan(60);
  expect(document.querySelector('.inbox-detail__head-name')).toHaveTextContent('Tamarack colleague 000');
  // A new server snapshot must still reorder the full result, retain unread
  // cues and update a match snippet rather than reusing an obsolete window.
  const updated = { ...snapshot, conversations: snapshot.conversations.map((row, i) => i === 299
    ? { ...row, sender: 'Tamarack updated colleague', preview: 'Updated Tamarack agenda', updatedAt: '2026-11-10T17:00:00Z', unread: 1 }
    : row) };
  view.rerender(<MessagesView data={updated} desktop onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onSendMessage={vi.fn()} onOpenTopics={vi.fn()} />);
  expect(rows()[0]).toHaveTextContent('Tamarack updated colleague');
  expect(rows()[0]).toHaveTextContent('Updated Tamarack agenda');
  expect(rows()[0].querySelector('.inbox-count')).toHaveTextContent('1');
});

it('replaces cached dates when the language changes and keeps the visible Contacts count in its name', () => {
  const snapshot = data(0);
  snapshot.broadcasts = [{ id: 'tamarack-notice', title: 'Tamarack notice', sender: 'Tamarack', body: 'Agenda', publishedAt: '2026-11-08T17:00:00Z' }];
  snapshot.peerContact = { incoming: [{ id: 'tamarack-request' }], outgoing: [], conversations: [] };
  const element = (lang) => <LanguageProvider lang={lang}><MessagesView data={snapshot} desktop onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} /></LanguageProvider>;
  const view = render(element('en'));
  expect(document.querySelector('.inbox-row time')).toHaveTextContent('Nov');
  expect(screen.getByRole('button', { name: 'Contacts 1 (pending)' })).toHaveTextContent('Contacts 1 (pending)');
  view.rerender(element('es'));
  expect(document.querySelector('.inbox-row time')).toHaveTextContent('nov');
  expect(document.querySelector('.inbox-row time')).not.toHaveTextContent('Nov');
});

it('opens the thread before acknowledging it after the first paint', async () => {
  let paint;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { paint = callback; return 1; });
  const read = vi.fn();
  mount(data(2), { onReadConversation: read });
  fireEvent.click(rows()[0]);
  expect(document.querySelector('.inbox-detail .inbox-thread')).toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
  act(() => paint());
  await waitFor(() => expect(read).toHaveBeenCalledWith('tamarack-0'));
});

it('keeps the alternate desktop window bounded and preserves selection across pages', () => {
  mount(data(), { alt: true });
  const items = () => document.querySelectorAll('.ug-msg-item');
  expect(items()).toHaveLength(20);
  expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeInTheDocument();
  fireEvent.click(items()[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(items()).toHaveLength(20);
  expect(items()[0]).toHaveFocus();
  expect(items()[0]).toHaveTextContent('Tamarack colleague 020');
  expect(screen.getByRole('heading', { name: 'Tamarack colleague 000' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  expect(items()[0]).toHaveAttribute('aria-current', 'true');
});

it('keeps the phone opener available while its private conversation is open', () => {
  mount(data(2), { desktop: false });
  const opener = rows()[0];
  fireEvent.click(opener);
  expect(screen.getByRole('dialog', { name: 'Tamarack colleague 000' })).toBeInTheDocument();
  expect(opener).toBeInTheDocument();
});
