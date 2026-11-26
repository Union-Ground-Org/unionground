import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { applyMessageTombstone } from '../src/features/messaging/bodyLifecycle.js';
vi.mock('../src/features/engagement/api.js', async importOriginal => ({...(await importOriginal()), requestMessageBriefing: vi.fn().mockResolvedValue({briefing:{summary:'Derived removal verification content',actionItems:[]}})}));
import { MessagesView } from '../src/views/MessagesView.jsx';
it.each([true,false])('removal updates the mounted conversation and preview (desktop=%s)', async (desktop) => {
 const body = 'Removal verification content';
 const data={member:{id:'member-1'},conversations:[{id:'conv-1',counterpartRole:'steward',sender:'Chapter steward',initials:'CS',preview:body,dateLabel:'Jul 12',unread:0,scheduled:[{id:'s1',conversation_id:'conv-1',status:'pending',body,scheduled_for:'2026-07-11T10:00:00Z'},{id:'s2',conversation_id:'conv-1',status:'pending',body:'Keep unrelated draft',scheduled_for:'2026-07-12T10:00:00Z'}],messages:[{id:'m0',sender_kind:'steward',body:'Keep unrelated message',created_at:'2026-07-10T10:00:00Z'},{id:'m1',sender_kind:'member',sender_name:'Example',body,created_at:'2026-07-11T10:00:00Z',read_at:null}]}],broadcasts:[],product:{spaces:[],documents:[]}};
 const api={toggleReaction:vi.fn(),toggleSaved:vi.fn(),remind:vi.fn(),redactMessage:vi.fn(async()=>({redacted:true}))};
 const onNotice=vi.fn();
 render(<MessagesView data={data} desktop={desktop} staffAccess engagementSession={{access_token:"test-session"}} messagingApi={api} onNotice={onNotice} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn().mockResolvedValue(null)} onOpenTopics={vi.fn()} />);
 fireEvent.click(screen.getByRole('button',{name:'Message your committee contact'}));
 const pane=desktop ? screen.getByRole('region',{name:'Message detail'}) : screen.getByRole('dialog');
 expect(within(pane).getAllByText(body).length).toBeGreaterThan(0);
 fireEvent.click(within(pane).getByText('Brief this thread'));
 expect(await within(pane).findByText('Derived removal verification content')).toBeInTheDocument();
 fireEvent.click(within(pane).getByText('Remove'));
 fireEvent.click(within(pane).getByText('Confirm removal'));
 await waitFor(()=>expect(onNotice).toHaveBeenCalled());
 expect(api.redactMessage).toHaveBeenCalledWith('m1');
 expect(within(pane).queryByText(body)).not.toBeInTheDocument();
 expect(screen.queryByText(body)).not.toBeInTheDocument();
 expect(screen.queryByText("Derived removal verification content")).not.toBeInTheDocument();
 expect(within(pane).getByText('Keep unrelated message')).toBeInTheDocument();
 expect(within(pane).queryByText(/Keep unrelated draft/)).not.toBeInTheDocument();
 expect(onNotice).toHaveBeenCalledWith('Message removed. Other devices update when they reconnect.');
});

it('clears private-source activity and uncertain conversation drafts, preserving later previews', () => {
 const removed = {id:'m1', body:'old text'};
 const survivor = {id:'m2', body:'Later message'};
 const data = {conversations:[{id:'conv-1', messages:[removed,survivor], preview:'Later message', scheduled:[{id:'s1',conversation_id:'conv-1',status:'pending',body:'old text'},{id:'s2',conversation_id:'conv-1',status:'pending',body:'Keep draft'}]}, {id:'other',messages:[],scheduled:[{id:'s3',conversation_id:'other',status:'pending',body:'Other conversation draft'}]}, {id:'empty'}],
  savedMessages:[{sourceKind:'private',sourceId:'m1',preview:'old text'},{sourceKind:'private',messageId:'m1',preview:'old text'},{sourceKind:'channel',sourceId:'m1',preview:'Authorized channel text'},{sourceKind:'private',sourceId:'m2',preview:'Later message'}],
  messageReminders:[{sourceKind:'private',messageId:'m1',preview:'old text'}]};
 const next=applyMessageTombstone(data,{id:'m1',redacted_at:'2026-09-06T12:00:00Z',body:'must not leak'});
 expect(next.conversations[0].messages[0].body).toBe('');
 expect(next.conversations[0].messages[1]).toBe(survivor);
 expect(next.conversations[0].preview).toBe('Later message');
 expect(next.conversations[0].scheduled.map(x=>x.body)).toEqual([]);
 expect(next.conversations[1].scheduled).toEqual(data.conversations[1].scheduled);
 expect(next.savedMessages.map(x=>x.preview)).toEqual(['','','Authorized channel text','Later message']);
 expect(next.messageReminders[0]).toMatchObject({preview:'',redacted:true});
 expect(data.conversations[0].messages[0].body).toBe('old text');
});
it('ignores unconfirmed removals and tolerates an empty authorized snapshot', () => {
 const data={conversations:[]};
 for(const message of [undefined,{}, {id:'m1'}, {redacted_at:'2026-09-06T12:00:00Z'}]) expect(applyMessageTombstone(data,message)).toBe(data);
 expect(applyMessageTombstone({}, {id:'m1',redacted_at:'2026-09-06T12:00:00Z'})).toEqual({conversations:[],savedMessages:[],messageReminders:[]});
});
