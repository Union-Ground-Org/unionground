import { act, fireEvent, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { loadMemberApp } from '../src/lib/memberApi.js';
import { MessagesView } from '../src/views/MessagesView.jsx';
afterEach(cleanup);
const body='Scheduled lifecycle verification content';
const draft={id:'s1',conversation_id:'conv-1',sender_kind:'member',body,scheduled_for:'2026-09-08T10:00:00Z',status:'pending'};
// Exercise the real loader, including its selected columns and pending filter.
// Fixture identities exist only in this local mounted test.
async function data(messages = [], scheduled = [draft]) {
  const tables = {
    member_profiles: { id: 'member-1', first_name: 'Example', full_name: 'Example Member', chapter_id: 'chapter-1', language: 'en' },
    member_conversations: [{ id: 'conv-1', title: 'Chapter steward', initials: 'CS' }],
    member_messages: messages,
    member_scheduled_messages: scheduled,
  };
  const client = {
    from(table) {
      let columns;
      const query = new Proxy({}, { get(_, key) {
        if (key === 'then') return (...args) => {
          let rows = tables[table] ?? [];
          if (table === 'member_scheduled_messages') rows = rows.map(row => Object.fromEntries(columns.split(',').map(column => [column, row[column] ?? null])));
          return Promise.resolve({ data: rows, error: null }).then(...args);
        };
        if (key === 'select') return value => { columns = value; return query; };
        return () => query;
      } });
      return query;
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
  const loaded = await loadMemberApp(client, { id: 'member-1', email: 'member@example.invalid' });
  for (const row of loaded.conversations[0].scheduled) {
    expect(row).not.toHaveProperty('sent_message_id');
    expect(row).not.toHaveProperty('redacted_at');
  }
  return loaded;
}
function props(d){return {data:d,desktop:true,messagingApi:{toggleReaction:vi.fn(),toggleSaved:vi.fn(),remind:vi.fn(),redactMessage:vi.fn(async()=>({redacted:true,message:{id:'m1',redacted_at:'2026-09-07T10:00:00Z',redaction_reason:'sender_removed',body:''}}))},onNotice:vi.fn(),onReadConversation:vi.fn().mockResolvedValue(null),onReadBroadcast:vi.fn().mockResolvedValue(null),onOpenTopics:vi.fn()};}
it.each([true, false])('a refreshed redacted pending draft removes its old mounted scheduled body (desktop=%s)',async(desktop)=>{
 const p={...props(await data()),desktop};const mounted=render(<MessagesView {...p}/>);fireEvent.click(screen.getByRole('button',{name:'Message your committee contact'}));
 expect(screen.getByText(new RegExp(body))).toBeInTheDocument();
 mounted.rerender(<MessagesView {...p} data={await data([],[{...draft,body:''}])}/>);
 await waitFor(()=>expect(screen.queryByText(new RegExp(body))).not.toBeInTheDocument());
 expect(screen.queryByRole('region',{name:'Scheduled messages'})).not.toBeInTheDocument();
 expect(screen.getByRole('textbox',{name:'Write a message…'})).toHaveValue('');
});
it.each([true, false])('dispatch refresh followed by confirmed removal clears the original mounted scheduled copy (desktop=%s)',async(desktop)=>{
 const p={...props(await data()),desktop};const mounted=render(<MessagesView {...p}/>);fireEvent.click(screen.getByRole('button',{name:'Message your committee contact'}));
 const message={id:'m1',conversation_id:'conv-1',sender_kind:'member',sender_name:'Example',body,created_at:'2026-09-07T10:00:00Z',read_at:null};
 mounted.rerender(<MessagesView {...p} data={await data([message],[])}/>);
 const pane=desktop ? screen.getByRole('region',{name:'Message detail'}) : screen.getByRole('dialog');
 fireEvent.click(await within(pane).findByText('Remove'));fireEvent.click(within(pane).getByText('Confirm removal'));
 await waitFor(()=>expect(p.onNotice).toHaveBeenCalled());
 expect(within(pane).queryByText(new RegExp(body))).not.toBeInTheDocument();
});

it('a confirmed removal discards uncertain drafts until a tombstoned authoritative refresh', async () => {
  const message = { id: 'm1', conversation_id: 'conv-1', sender_kind: 'member', body, created_at: '2026-09-07T10:00:00Z' };
  const p = props(await data([message]));
  const mounted = render(<MessagesView {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Message your committee contact' }));
  const pane = screen.getByRole('region', { name: 'Message detail' });
  fireEvent.click(within(pane).getByText('Remove'));
  fireEvent.click(within(pane).getByText('Confirm removal'));
  await waitFor(() => expect(p.messagingApi.redactMessage).toHaveBeenCalledWith('m1'));
  await waitFor(() => expect(screen.queryByText(new RegExp(body))).not.toBeInTheDocument());
  mounted.rerender(<MessagesView {...p} data={await data([{ ...message, body: '', redacted_at: '2026-09-07T12:00:00Z' }], [{ ...draft, body: 'Remaining pending draft' }])} />);
  expect(await screen.findByText(/Remaining pending draft/)).toBeInTheDocument();
});

it.each(['resolve', 'reject'])('a scheduling response after refresh cannot restore its body (%s)', async (outcome) => {
  let resolveSchedule, rejectSchedule;
  const p = props(await data([], []));
  p.messagingApi.schedule = vi.fn(() => new Promise((resolve, reject) => { resolveSchedule = resolve; rejectSchedule = reject; }));
  const mounted = render(<MessagesView {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Message your committee contact' }));
  const composer = screen.getByRole('textbox', { name: 'Write a message…' });
  fireEvent.change(composer, { target: { value: body } });
  fireEvent.change(screen.getByLabelText('Schedule for'), { target: { value: '2099-09-08T10:00' } });
  fireEvent.submit(composer.closest('form'));
  expect(p.messagingApi.schedule).toHaveBeenCalled();
  mounted.rerender(<MessagesView {...p} data={await data([], [])} />);
  await act(async () => { if (outcome === 'resolve') resolveSchedule({ id: draft.id }); else rejectSchedule(new Error('Schedule unavailable')); });
  expect(screen.queryByText(new RegExp(body))).not.toBeInTheDocument();
  expect(composer).toHaveValue('');
});

it('a successful local schedule remains until the next snapshot replaces it', async () => {
  const p = props(await data([], []));
  p.messagingApi.schedule = vi.fn().mockResolvedValue({ id: draft.id });
  const mounted = render(<MessagesView {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Message your committee contact' }));
  const composer = screen.getByRole('textbox', { name: 'Write a message…' });
  fireEvent.change(composer, { target: { value: body } });
  fireEvent.change(screen.getByLabelText('Schedule for'), { target: { value: '2099-09-08T10:00' } });
  fireEvent.submit(composer.closest('form'));
  expect(await screen.findByText(new RegExp(body))).toBeInTheDocument();
  mounted.rerender(<MessagesView {...p} data={await data([], [{ ...draft, status: 'dispatched' }])} />);
  await waitFor(() => expect(screen.queryByText(new RegExp(body))).not.toBeInTheDocument());
  expect(composer).toHaveValue('');
});
