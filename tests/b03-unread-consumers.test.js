import { it, expect, vi } from 'vitest';
import { loadMemberApp } from '../src/lib/memberApi.js';
import { channelUnreadCount, inboxUnreadCount } from '../src/features/messaging/unread.js';
// Generic chainable fake: every builder method returns the proxy again and
// awaiting it resolves the canned result, so query shape changes don't break
// these tests — only the table/rpc routing and the mapped output are pinned.
function chainable(result) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
      return () => proxy;
    },
  });
  return proxy;
}

function fakeClient({ tables = {}, rpcs = {} } = {}) {
  return {
    // A table value may be an array of per-call results consumed FIFO (same
    // convention as deskClient in tests/steward-appointments-paging.test.js)
    // — member_forms is queried once per page of the SOL-20260813-06 walk.
    // The array's last entry repeats once exhausted, so an over-call shows up
    // as extra rows/loops instead of silently running out of canned data.
    from: (table) => {
      const canned = tables[table];
      if (typeof canned === 'function') return chainable(canned());
      const result = Array.isArray(canned) ? (canned.length > 1 ? canned.shift() : canned[0]) : canned;
      return chainable(result ?? { data: [], error: null });
    },
    rpc: (name, args) => {
      const handler = rpcs[name];
      const result = typeof handler === "function" ? handler(args) : handler;
      return Promise.resolve(result ?? { data: null, error: { message: `no fake for rpc ${name}` } });
    },
  };
}

const baseProfile = {
  id: "user-1",
  first_name: "Darnell",
  full_name: "Darnell Foster",
  initials: "DF",
  role_line: "Member",
  member_since: 2023,
  language: "en",
  notification_prefs: { deadlines: true, cases: true, votes: true, events: true },
  chapter_id: "wor",
};

function memberAppTables(overrides = {}) {
  return {
    member_profiles: { data: baseProfile, error: null },
    chapters: { data: [{ id: "wor", name: "Harborview Care United" }], error: null },
    ...overrides,
  };
}

const memberAppRpcs = {
  get_member_rewards_summary: { data: {}, error: null },
  get_workload_stats: { data: {}, error: null },
  list_chapter_task_assignees: {
    data: [{ user_id: "user-2", full_name: "Maria Santos", initials: "MS" }],
    error: null,
  },
  list_reward_peer_contact: {
    data: { available: true, canRequest: false, code: "PSG-0123456789ABCDEF0123", incoming: [], outgoing: [], conversations: [] },
    error: null,
  },
  list_reward_experimental_content: { data: [], error: null },
};


it('web loader must derive channel unread from the same server cursor as native', async()=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 const posts=[{id:'post-1',thread_id:'thread-1',body:'New post',created_at:'2026-09-01T12:01:00Z',author_id:'user-2'}];
 const cursor='2026-09-01T12:00:00Z';
 const client=fakeClient({tables:memberAppTables({chapter_spaces:{data:[{id:'space-1',name:'General'}],error:null},chapter_threads:{data:[{id:'thread-1',space_id:'space-1',title:'Discussion'}],error:null},chapter_thread_posts:{data:posts,error:null},chapter_space_reads:{data:[{space_id:'space-1',last_read_at:cursor}],error:null}}),rpcs:memberAppRpcs});
 const out=await loadMemberApp(client,{id:'user-1',email:'review@example.invalid'});
 const thread=out.product.spaces[0].threads[0];
 expect(thread.posts).toHaveLength(1);
 const webCount=inboxUnreadCount('channel',thread.unreadCount??thread.unread);
 const nativeRuleCount=channelUnreadCount(posts,cursor);
 expect(nativeRuleCount).toBe(1);
 expect(webCount).toBe(nativeRuleCount);
});

const nativeBackend = vi.hoisted(() => ({ client: null }));
vi.mock('../apps/mobile/src/services/supabase', () => ({ getSupabaseClient: () => nativeBackend.client }));
import { liveChannelStore } from '../apps/mobile/src/data/liveChannels';
import { UNREAD_CONFORMANCE_CASES } from '../src/features/messaging/unreadFixtures.js';
import { markChapterSpaceRead } from '../src/lib/memberApi.js';
for (const fixture of UNREAD_CONFORMANCE_CASES.filter(row => row.op === 'channel')) {
 it(`both actual loaders: ${fixture.name}`, async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // A fixture's own post (its viewer wrote it) is the signed-in user's here.
  const author = fixture.input.post.author_id ?? fixture.input.post.authorId;
  const own = fixture.input.post.mine === true || (fixture.input.viewerId != null && author === fixture.input.viewerId);
  const post = { id:'post-1',thread_id:'thread-1',body:'New post',author_id: own ? 'user-1' : 'user-2',
    created_at: fixture.input.post.created_at ?? fixture.input.post.createdAt };
  const client = fakeClient({ tables: memberAppTables({
    chapter_spaces:{data:[{id:'space-1',name:'General'}],error:null},
    chapter_threads:{data:[{id:'thread-1',space_id:'space-1',title:'Discussion'}],error:null},
    chapter_thread_posts:{data:[post],error:null},
    chapter_space_reads:{data:[{space_id:'space-1',last_read_at:fixture.input.cursor}],error:null},
  }),rpcs:memberAppRpcs });
  client.auth = {getSession: async () => ({data:{session:{user:{id:'user-1'}}}})};
  nativeBackend.client=client;
  const web=await loadMemberApp(client,{id:'user-1',email:'proof@example.invalid'});
  await liveChannelStore.refresh();
  expect(liveChannelStore.status()).toBe('ready');
  expect(web.product.spaces[0].threads[0].unreadCount).toBe(Number(fixture.expected));
  expect(liveChannelStore.channel('space-1').unread).toBe(Number(fixture.expected));
  liveChannelStore.release();
 });
}
it('web read markers use the server RPC and propagate denials', async () => {
 const client={rpc:vi.fn().mockResolvedValue({data:null,error:null})};
 await markChapterSpaceRead(client,'space-1');
 expect(client.rpc).toHaveBeenCalledWith('mark_chapter_space_read',{p_space_id:'space-1'});
 client.rpc.mockResolvedValue({error:{code:'42501',message:'denied'}});
 await expect(markChapterSpaceRead(client,'space-1')).rejects.toMatchObject({code:'42501'});
});

it('TEST-UG-SHARED-UNREAD-CONTRACT-20260904 reconciles unread state and keeps both consumers read after replay', async () => {
 const initialCursor='2026-09-01T12:00:00.000Z';
 const advancedCursor='2026-09-01T12:01:00.000Z';
 const server={cursor:initialCursor};
 const client=fakeClient({tables:memberAppTables({
  chapter_spaces:{data:[{id:'space-1',name:'General',description:'Chapter updates',visibility:'chapter'}],error:null},
  chapter_threads:{data:[{id:'thread-1',space_id:'space-1',title:'Discussion',created_at:initialCursor}],error:null},
  chapter_thread_posts:{data:[{id:'post-1',thread_id:'thread-1',body:'Replayed post',author_id:'user-2',author_name:'Chapter member',created_at:advancedCursor}],error:null},
  chapter_space_reads:()=>({data:[{space_id:'space-1',last_read_at:server.cursor}],error:null}),
 }),rpcs:memberAppRpcs});
 client.auth={getSession:async()=>({data:{session:{user:{id:'user-1'}}}})};
 nativeBackend.client=client;
 try {
  const webBefore=await loadMemberApp(client,{id:'user-1',email:'proof@example.invalid'});
  await liveChannelStore.refresh();
  expect(webBefore.product.spaces[0].threads[0].unreadCount).toBe(1);
  expect(liveChannelStore.channel('space-1').unread).toBe(1);

  server.cursor=advancedCursor;
  await liveChannelStore.refresh();
  expect(liveChannelStore.channel('space-1').unread).toBe(0);

  const webReplay=await loadMemberApp(client,{id:'user-1',email:'proof@example.invalid'});
  expect(webReplay.product.spaces[0].threads[0].unreadCount).toBe(0);

  await liveChannelStore.refresh();
  expect(liveChannelStore.channel('space-1').unread).toBe(0);
  const webReplayAgain=await loadMemberApp(client,{id:'user-1',email:'proof@example.invalid'});
  expect(webReplayAgain.product.spaces[0].threads[0].unreadCount).toBe(0);
 } finally {
  liveChannelStore.release();
 }
});
