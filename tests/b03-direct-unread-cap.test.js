import { it, expect, vi } from 'vitest';
import { loadMemberApp } from '../src/lib/memberApi.js';
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



vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { addEventListener: vi.fn() } }));
const backend = vi.hoisted(() => ({ client: null }));
vi.mock('@supabase/supabase-js', () => ({createClient:()=>backend.client,processLock:vi.fn()}));
vi.mock('react-native-url-polyfill/auto',()=>({}));
vi.mock('../apps/mobile/src/lib/config',()=>({mobileConfig:{backendConfigured:true,supabaseUrl:'http://localhost',supabasePublishableKey:'test'}}));
vi.mock('../apps/mobile/src/lib/secureSessionStorage',()=>({createBackendScopedSessionStorage:()=>({})}));
import {loadDashboard} from '../apps/mobile/src/services/supabase';
it('direct unread agrees across real loaders beyond the PostgREST row cap',async()=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 const messages=Array.from({length:1001},(_,i)=>({id:`m${i}`,conversation_id:'c1',user_id:'user-1',sender_kind:'steward',body:`message ${i}`,read_at:i===1000?null:'2026-08-01T00:00:00Z',created_at:new Date(Date.UTC(2025,0,1)+i*60000).toISOString()}));
 const conversation={id:'c1',title:'Steward',created_at:'2025-01-01T00:00:00Z',updated_at:messages.at(-1).created_at};
 const tables=memberAppTables({member_conversations:{data:[conversation],error:null},member_conversation_summaries:{data:[{conversation_id:'c1',latest_message:messages.at(-1).body,unread_count:1}],error:null}});
 const client=fakeClient({tables,rpcs:memberAppRpcs});
 const oldFrom=client.from; const reads=[];
 client.from=(table)=>{
  if(table!=='member_messages')return oldFrom(table);
  const state={ascending:true,limit:1000,columns:null,scope:{},cursor:null};reads.push(state);
  const q=new Proxy({}, {get(_,key){
   if (key === 'then') return (...args) => {
    const window = state.columns === 'id'
     ? [{ id: messages[0].id }]
     : [...messages].sort((a, b) => state.ascending ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at))
      .slice(0, Math.min(1000, state.limit));
    return Promise.resolve({ data: window, error: null }).then(...args);
   };
   if(key==='select')return columns=>{state.columns=columns;return q};
   if(key==='eq')return (column,value)=>{state.scope[column]=value;return q};
   if(key==='or')return cursor=>{state.cursor=cursor;return q};
   if(key==='order')return (col,opts)=>{state.ascending=opts.ascending;return q};
   if(key==='limit')return n=>{state.limit=n;return q};
   return ()=>q;
  }});return q;
 };
 backend.client=client;
 const web=await loadMemberApp(client,{id:'user-1',email:'review@example.invalid'});
 const native=await loadDashboard('user-1');
 // Union Ground reads the message history newest-first under an explicit
 // 1000-row limit (src/lib/memberApi.js), so a capped read drops the oldest
 // rows rather than a long-tenured worker's newest ones.
 expect(reads).toHaveLength(2);
 expect(reads[0]).toMatchObject({ascending:false,limit:1000,columns:'*',scope:{user_id:'user-1'}});
 expect(reads[1]).toMatchObject({limit:1,columns:'id',scope:{user_id:'user-1',conversation_id:'c1'}});
 expect(reads[1].cursor).toContain(messages[1].created_at);
 expect(native.conversations[0].unreadCount).toBe(1);
 expect(web.conversations[0].unread,'web must use the same unbounded server unread summary as native').toBe(native.conversations[0].unreadCount);
});
