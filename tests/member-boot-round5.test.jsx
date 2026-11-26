import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
// Retained er probes, adapted to the real authenticated App path
// through Vitest environment injection; all expectations assert repaired behavior.
import React from 'react';
import {render, screen, waitFor, act, cleanup, fireEvent, within} from '@testing-library/react';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {App} from '../src/App.jsx';
import { ORG_START_SWITCH } from '../src/features/onboardingGuideEngine/orgStart.js';
import { keepKeyboardShortcutsOn } from './helpers/keyboardShortcuts.js';
import {createMemoryStore, enqueueWrite, sessionStamp} from '../src/lib/outbox.js';

// The app writes and reads no saved copy any more
// (BUG-UG-WEB-HOME-REPAINTS-PREVIOUS-CHAPTER-AFTER-SWITCH-20261111);
// a row an older build left behind is planted directly so the purges are
// still proven to erase it.
const plantSnapshot=(store,userId,data,savedAt,stamp)=>store.putSnapshot({userId,savedAt,data,...stamp});
const loadSnapshot=async(store,userId)=>{const snapshot=await store.getSnapshot(userId);return snapshot&&snapshot.data?snapshot:null;};



const harness = vi.hoisted(() => {
  const authStorageKey = 'sb-member-boot-auth-token';
  const user = {id:'member-1',email:'member@example.test'};
  const session = {user, access_token:'fictional-test-token'};
  const state = {fail:null,failMessage:null,delay:null,pending:[],operations:[],rows:{},authChanged:null,guideDelay:false,guidePending:[],rpcArgs:[],subscriptions:[],getSession:null,outbox:null};
  const execute = async resource => {
    state.operations.push(resource);
    if(state.delay===resource) await new Promise(resolve=>state.pending.push(resolve));
    if(state.fail===resource) { await new Promise(resolve=>setTimeout(resolve,10)); return {data:null,error:{message:state.failMessage||'isolated lazy failure'}}; }
    if(resource in state.rows) return {data:structuredClone(state.rows[resource]),error:null};
    if(resource==='table:member_profiles') return {data:{id:user.id,first_name:'Darnell',full_name:'Darnell Foster',initials:'DF',language:'en',chapter_id:'chapter-1'},error:null};
    if(resource==='rpc:get_member_rewards_summary') return {data:{totalPoints:100},error:null};
    return {data:resource.startsWith('rpc:')?null:[],error:null};
  };
  const client = {
    rpc(name,args){state.rpcArgs.push({name,args});return execute('rpc:'+name);},
    auth:{getSession:async()=>(state.getSession?state.getSession():{data:{session},error:null}),onAuthStateChange(fn){state.authChanged=fn;return {data:{subscription:{unsubscribe(){}}}};},mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal1',nextLevel:'aal1'},error:null})}},
    channel(name){const c={on(){return c},subscribe(callback){state.subscriptions.push(callback);(state.namedSubscriptions??={})[name]=callback;return c},unsubscribe(){}};return c},removeChannel(){},realtime:{setAuth(){}}
  };
  // Supabase's query builders are thenables; execute only when awaited.
  client.from = table => {let p;p=new Proxy({}, {get(_t,key){if(key==='then')return (resolve,reject)=>execute('table:'+table).then(resolve,reject);return ()=>p;}});return p;};
  return {state,client,user,session,authStorageKey};
});

vi.mock('../src/lib/supabase.js', async importOriginal => {
 const original = await importOriginal();
 return {...original, appBackendKind:'live', hasAppBackend:true, appAuthStorageUnavailable:false,
  appAuthStorageKey:harness.authStorageKey, appSupabase:capturedAppClientFixture(harness.client),
  // Bind the App's new bounded dispatch seam. Already captured learning
  // clients retain this fixture's original unconfigured-backend behavior.
  createCapturedAppSessionRpcClient: (session, options) => options?.boundedTransport
   ? capturedAppClientFixture(harness.client) : original.createCapturedAppSessionRpcClient(session, options),
  authStorageAdapter:()=>globalThis.localStorage};
});
vi.mock('../src/lib/outbox.js',async importOriginal=>({...await importOriginal(),createOutboxStore:()=>harness.state.outbox}));
vi.mock('../src/lib/memberSessionLoader.js', async importOriginal => {
 const original = await importOriginal();
 return {...original, createMemberSessionLoader: (...args) => {
   const loader = original.createMemberSessionLoader(...args);
   harness.state.loader = loader;
   return loader;
 }};
});
vi.mock('../src/lib/guideApi.js',()=>({requestGuideReply:async()=>{if(harness.state.guideDelay)await new Promise(resolve=>harness.state.guidePending.push(resolve));return {answer:'A retained synthetic answer',sources:[]};}}));

beforeEach(()=>{
  vi.stubEnv("MODE", "authenticated-test");
  harness.state.guideDelay=false;harness.state.guidePending=[];harness.state.rpcArgs=[];harness.state.subscriptions=[];harness.state.fail=null;harness.state.failMessage=null;harness.state.delay=null;harness.state.operations=[];harness.state.rows={};harness.state.pending=[];
  harness.state.getSession=null;harness.state.outbox=createMemoryStore();
  localStorage.clear();sessionStorage.clear();
  window.history.replaceState({},'', '/m');window.scrollTo=vi.fn();
  global.fetch=vi.fn().mockRejectedValue(new Error('offline test'));
});
afterEach(()=>{cleanup();vi.unstubAllEnvs();});
// After the storage reset above, so the choice survives it.
keepKeyboardShortcutsOn();
async function navigate(path){await act(async()=>{window.history.pushState({},'',path);window.dispatchEvent(new PopStateEvent('popstate'));});}

it.each([
  ["en", "Profile", "Save profile", "Profile updated"],
  ["es", "Perfil", "Guardar perfil", "Perfil actualizado"],
])("confirms a successful profile save in %s", async (language, profile, saveLabel, notice) => {
  harness.state.rows["table:member_profiles"] = {
    id: harness.user.id, first_name: "Darnell", full_name: "Darnell Foster", initials: "DF", role_line: "Member", language, chapter_id: "chapter-1",
  };
  try {
    render(<App />);
    await screen.findByRole("heading", { name: /Darnell/ });
    fireEvent.click((await screen.findAllByRole("button", { name: profile }))[0]);
    const dialog = await screen.findByRole("dialog", { name: profile });
    fireEvent.click(within(dialog).getByRole("button", { name: saveLabel }));
    expect(await screen.findByText(notice)).toBeVisible();
    expect(harness.state.operations).toContain("rpc:update_my_member_profile");
  } finally {
    delete harness.state.rows["table:member_profiles"];
  }
});

describe.each(["classic", "alt"])("%s Home organization setup", (shell) => {
  const guideRead = "rpc:get_organization_start_guide";

  function boot({ admin, enabled, guide }) {
    window.history.replaceState({}, "", `/m?shell=${shell}`);
    harness.state.rows["table:member_roles"] = admin ? [{ role: "admin" }] : [];
    harness.state.rows["rpc:get_member_organization_configuration"] = { switches: { [ORG_START_SWITCH]: enabled } };
    harness.state.rows[guideRead] = guide;
    render(<App />);
    return screen.findByRole("region", { name: "What matters for you now" }, { timeout: 10_000 });
  }

  it.each([
    ["member", false, true, "active", false],
    ["switched off", true, false, "active", false],
    ["finished", true, true, "done", true],
  ])("shows caught up for a %s guide case", async (_name, admin, enabled, state, readsGuide) => {
    const card = within(await boot({ admin, enabled, guide: { state } }));
    expect(await card.findByText("You're caught up")).toBeVisible();
    expect(harness.state.operations.includes(guideRead)).toBe(readsGuide);
    expect(card.queryByRole("button", { name: "Open the setup guide" })).toBeNull();
    // This edition's card has no setup line, so it carries none of the
    // setup line's live regions.
  });

});


it('R3: permanent Messages failure stays settled until an explicit Retry',async()=>{
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 harness.state.fail='table:member_conversations';await navigate('/m/messages');
 await waitFor(()=>expect(document.querySelector('.view-error')).not.toBeNull());
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,100));});
 expect(harness.state.operations.filter(x=>x==='table:member_conversations')).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'Try again'}));
 await waitFor(()=>expect(harness.state.operations.filter(x=>x==='table:member_conversations')).toHaveLength(2));
 await waitFor(()=>expect(document.querySelector('.view-error')).not.toBeNull());
 await navigate('/m');await screen.findByRole('heading',{name:/Darnell/});
});
it('CONTROL: global search loads only when command palette opens',async()=>{
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 expect(harness.state.operations).not.toContain('table:member_guide_threads');
 fireEvent.keyDown(window,{key:'k',ctrlKey:true});
 await waitFor(()=>expect(harness.state.operations).toContain('table:member_guide_threads'));
});
it('R3: reconnect authoritatively reconciles existing notification read state',async()=>{
 harness.state.rows['table:member_notifications']=[{id:'n1',title:'Reconciled notice',body:'Synthetic body',read_at:null,created_at:new Date().toISOString()}];
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 harness.state.rows['table:member_notifications'][0].read_at=new Date().toISOString();
 await act(async()=>{harness.state.subscriptions[0]('SUBSCRIBED');await new Promise(resolve=>setTimeout(resolve,100));});
 expect(document.querySelector('[aria-label="Notifications, 0 unread"]')).not.toBeNull();
});

it('R3: Rights save completed over Events invalidates Rights progress before return',async()=>{
 harness.state.rows['table:member_rights_lessons']=[{id:'weingarten',label:'Weingarten',title:'Know your rights',description:'Synthetic guide',steps:['Ask for representation','Pause the interview'],script:'Please wait',order_index:1}];
 harness.state.rows['table:member_rights_progress']=[{lesson_id:'weingarten',completed_steps:[]}];
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 await navigate('/m/rights');await waitFor(()=>expect(document.querySelector('.view-loading')).toBeNull());
 const start=document.querySelector('.learn-hero__cta');if(start)fireEvent.click(start);
 await waitFor(()=>expect(document.querySelector('.learn-step')).not.toBeNull());
 harness.state.delay='table:member_rights_progress';fireEvent.click(document.querySelector('.learn-step'));
 await waitFor(()=>expect(harness.state.pending.length).toBe(1));
 await navigate('/m/events');await waitFor(()=>expect(document.querySelector('.view-loading')).toBeNull());
 harness.state.rows['table:member_rights_progress']=[{lesson_id:'weingarten',completed_steps:[0]}];
 harness.state.delay=null;await act(async()=>{harness.state.pending.forEach(resolve=>resolve());await new Promise(resolve=>setTimeout(resolve,100));});
 const count=harness.state.operations.filter(x=>x==='table:member_rights_progress').length;
 await navigate('/m/rights');await waitFor(()=>expect(document.querySelector('.view-loading')).toBeNull());
 const next=document.querySelector('.learn-hero__cta');if(next)fireEvent.click(next);
 await waitFor(()=>expect(document.querySelector('.learn-step')).not.toBeNull());
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,100));});
 await waitFor(()=>expect(document.querySelector('.learn-step').getAttribute('aria-pressed')).toBe('true'));
 expect(harness.state.operations.filter(x=>x==='table:member_rights_progress').length).toBeGreaterThan(count);
});

it.each([false, true])('R3: a forced Rights request settles after navigation and return (failure=%s)', async fail => {
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 await navigate('/m/rights');await waitFor(()=>expect(document.querySelector('.view-loading')).toBeNull());
 harness.state.delay='table:member_rights_lessons';
 let forced;
 await act(async()=>{forced = harness.state.loader.loadRoute('rights',{force:true}).catch(()=>null);});
 await waitFor(()=>expect(harness.state.pending.length).toBeGreaterThan(0));
 await navigate('/m/messages');
 harness.state.fail = fail ? 'table:member_rights_lessons' : null;
 harness.state.delay=null;
 await act(async()=>{harness.state.pending.forEach(resolve=>resolve());await forced;});
 await waitFor(()=>expect(document.querySelector('.view-loading')).toBeNull());
 const count=harness.state.operations.length;
 await navigate('/m/rights');
 await screen.findByRole('heading',{name:'Learn'});
 expect(document.querySelector('.view-loading')).toBeNull();
 expect(harness.state.operations, JSON.stringify(harness.state.operations.slice(count))).toHaveLength(count);
});

it('preserves the eager loader fallback when an additive rewards read fails', async () => {
 harness.state.fail='rpc:get_member_rewards_summary';
 render(<App/>);
 await screen.findByRole('heading',{name:/Darnell/});
 expect(document.querySelector('.view-error')).toBeNull();
 expect(harness.state.loader.inspect().get('rpc:get_member_rewards_summary').status).toBe('error');
 await navigate('/m/rights');
 await screen.findByRole('heading',{name:'Learn'});
 await navigate('/m');
 await screen.findByRole('heading',{name:/Darnell/});
 expect(harness.state.operations.filter(resource=>resource==='rpc:get_member_rewards_summary')).toHaveLength(1);
});

it('R4 ADV: saved Compass exchange remains visible when previously loaded guide history fails refresh', async()=>{
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
 await screen.findByRole('dialog',{name:'Union Ground Guide'});
 await waitFor(()=>expect(harness.state.loader.inspect().get('table:member_guide_threads')?.status).toBe('loaded'));
 harness.state.rows['rpc:save_member_guide_exchange']='new-thread';
 harness.state.rows['table:member_guide_threads']=[{id:'new-thread',title:'New saved question'}];
 harness.state.rows['table:member_guide_messages']=[{id:'new-message',thread_id:'new-thread',role:'assistant',body:'A retained synthetic answer'}];
 harness.state.fail='table:member_guide_threads';
 fireEvent.change(screen.getByLabelText('Ask Union Ground Guide a question'),{target:{value:'New saved question'}});
 fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(harness.state.operations).toContain('rpc:save_member_guide_exchange'));
 await waitFor(()=>expect(screen.getByLabelText('Ask Union Ground Guide a question')).toHaveValue(''));
 // The retained answer arrives after the save RPC and a failed history refresh;
 // Testing Library's 1s findBy default is below that on a contended runner, and
 // 8s was still short of it there (CI run 35727656681), so this waits past the
 // file's own 10s vitest default with a matching per-test budget.
 expect(await screen.findByText('A retained synthetic answer',{},{timeout:20_000})).toBeInTheDocument();
 // The retained exchange must live in the loader, not only in a React state
 // update that has not rendered yet: an unrelated projection commits from the
 // last rendered snapshot, so a Home/realtime commit landing before that render
 // would otherwise restore the pre-save history and lose the answer for good.
 const projection = await harness.state.loader.loadRoute('today');
 expect((projection.guideThreads.find(thread=>thread.id==='new-thread')?.messages ?? []).map(message=>message.body))
  .toContain('A retained synthetic answer');
},30_000);

it('R4 ADV: initial Compass history failure has an explicit usable retry', async()=>{
 harness.state.fail='table:member_guide_threads';
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
 await screen.findByRole('dialog',{name:'Union Ground Guide'});
 await waitFor(()=>expect(harness.state.loader.inspect().get('table:member_guide_threads')?.status).toBe('error'));
 harness.state.fail=null;
 fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
 await screen.findByRole('dialog',{name:'Union Ground Guide'});
 await act(async()=>{await new Promise(r=>setTimeout(r,100));});
 expect(harness.state.operations.filter(x=>x==='table:member_guide_threads').length).toBeGreaterThan(1);
});

it('R4 ADV: board reconnect snapshot survives an unrelated notification reconciliation', async()=>{
 harness.state.rows['table:member_roles']=[{role:'steward'}];
 harness.state.rows['table:chapter_workstreams']=[{id:'workstream-general',name:'General'}];
 harness.state.rows['table:chapter_tasks']=[{id:'task-gap',title:'Original task title',workstream:'General',priority:'normal',status:'in_progress',assignee_id:'member-1',chapter_id:'chapter-1',created_at:new Date().toISOString(),updated_at:new Date().toISOString()}];
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 const {applyDeviceParityState}=await import('../src/lib/deviceParity.js');
 await act(async()=>applyDeviceParityState('app.selectedStaffHat','steward'));
 await navigate('/m/tasks');
 await waitFor(()=>expect(harness.state.namedSubscriptions['chapter-tasks:chapter-1']).toBeTypeOf('function'));
 await waitFor(()=>expect(document.querySelector('.view-loading')).toBeNull());
 expect(await screen.findByText('Original task title')).toBeInTheDocument();
 harness.state.rows['table:chapter_tasks'][0].title='Authoritative reconnect title';
 await act(async()=>{harness.state.namedSubscriptions['chapter-tasks:chapter-1']('SUBSCRIBED');await new Promise(r=>setTimeout(r,100));});
 expect(await screen.findByText('Authoritative reconnect title')).toBeInTheDocument();
 await act(async()=>{harness.state.namedSubscriptions['member-notifications-member-1']('SUBSCRIBED');await new Promise(r=>setTimeout(r,100));});
 expect(screen.queryByText('Original task title')).not.toBeInTheDocument();
 expect(screen.getByText('Authoritative reconnect title')).toBeInTheDocument();
});

// Labs (list_reward_experimental_content) left with the points economy; the
// weekly questions are the Guide's one optional suggestion read.
it.each(['rpc:list_weekly_questions'])('optional Compass suggestion failure does not duplicate a successfully reconciled saved answer: %s', async resource=>{
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
 await screen.findByRole('dialog',{name:'Union Ground Guide'});
 await waitFor(()=>expect(harness.state.loader.inspect().get('table:member_guide_threads')?.status).toBe('loaded'));
 harness.state.rows['rpc:save_member_guide_exchange']='new-thread';
 harness.state.rows['table:member_guide_threads']=[{id:'new-thread',title:'New saved question'}];
 harness.state.rows['table:member_guide_messages']=[{id:'new-message',thread_id:'new-thread',role:'assistant',body:'A retained synthetic answer'}];
 harness.state.fail=resource;
 fireEvent.change(screen.getByLabelText('Ask Union Ground Guide a question'),{target:{value:'New saved question'}});
 fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(screen.getByLabelText('Ask Union Ground Guide a question')).toHaveValue(''));
 expect(await screen.findAllByText('A retained synthetic answer')).toHaveLength(1);
});

// Partial history authority: the thread list read fails while the MESSAGE read
// succeeds and carries the rows the RPC just committed. Retention must then
// carry THOSE rows — a second synthetic copy would render twice, and
// commitMemberData would store the duplicate in the last-good snapshot the
// offline path restores from. Asserted in all three places: the loader's
// projection, the stored snapshot, and that snapshot rendered through Compass.
it('R4 ADV: a saved exchange read back by the messages query alone is retained exactly once', async()=>{
 harness.state.rows['table:member_guide_threads']=[{id:'prior-thread',title:'Existing conversation'}];
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
 await screen.findByRole('dialog',{name:'Union Ground Guide'});
 fireEvent.click(screen.getByRole('button',{name:'Open conversations'}));
 fireEvent.click(await screen.findByRole('button',{name:'Existing conversation'}));
 harness.state.rows['rpc:save_member_guide_exchange']='prior-thread';
 harness.state.rows['table:member_guide_messages']=[
  {id:'db-answer',thread_id:'prior-thread',role:'assistant',body:'A retained synthetic answer'},
  {id:'db-question',thread_id:'prior-thread',role:'user',body:'Saved question'},
 ];
 harness.state.fail='table:member_guide_threads';
 fireEvent.change(screen.getByLabelText('Ask Union Ground Guide a question'),{target:{value:'Saved question'}});
 fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(screen.getByLabelText('Ask Union Ground Guide a question')).toHaveValue(''));
 await screen.findAllByText('A retained synthetic answer');
 let projection;
 await act(async()=>{projection=await harness.state.loader.loadRoute('today');});
 await navigate('/m/rights');await navigate('/m');
 const answers=data=>(data.guideThreads.find(thread=>thread.id==='prior-thread')?.messages??[]).filter(message=>message.role==='assistant');
 expect(answers(projection)).toHaveLength(1);
 expect(await loadSnapshot(harness.state.outbox,'member-1')).toBeNull();
 cleanup();
 const {Assistant}=await import('../src/components/FloatingControls.jsx');
 const {LanguageProvider}=await import('../src/lib/LanguageContext.jsx');
 render(<LanguageProvider lang="en"><Assistant threads={projection.guideThreads} onClose={()=>{}} onSend={async()=>null}/></LanguageProvider>);
 expect(await screen.findAllByText('A retained synthetic answer')).toHaveLength(1);
});

// The render-order race itself. The failing history read is held, so an
// unrelated projection can start AFTER the save's own refresh — its commit is
// the newest request, not a superseded one — and be read back before the
// exchange is retained anywhere. That projection is then held between its read
// and its commit, and released while the retained append is still a queued
// React update (asserted inside the window). commitMemberData rebuilds data
// from dataRef.current, so without the synchronous ref write in
// commitGuideExchangeLocal that commit restores the pre-save history, and with
// the history read still failing nothing appends the answer again.
it('R4 ADV: a projection committing between the queued append and its render keeps the answer and the reconciled read state', async()=>{
 harness.state.rows['table:member_notifications']=[{id:'n1',title:'Synthetic notice',body:'Synthetic body',read_at:null,created_at:new Date().toISOString()}];
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 expect(document.querySelector('[aria-label="Notifications, 1 unread"]')).not.toBeNull();
 fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
 await screen.findByRole('dialog',{name:'Union Ground Guide'});
 await waitFor(()=>expect(harness.state.loader.inspect().get('table:member_guide_threads')?.status).toBe('loaded'));
 const loader=harness.state.loader;
 const loadRoute=loader.loadRoute.bind(loader);
 let releaseCommit=null;let holdUnrelated=false;
 loader.loadRoute=async(...args)=>{
  const projection=await loadRoute(...args);
  if(holdUnrelated&&args[0]==='today'){holdUnrelated=false;await new Promise(resolve=>{releaseCommit=resolve;});}
  return projection;
 };
 harness.state.rows['table:member_notifications'][0].read_at=new Date().toISOString();
 harness.state.rows['rpc:save_member_guide_exchange']='new-thread';
 harness.state.fail='table:member_guide_threads';harness.state.delay='table:member_guide_threads';
 fireEvent.change(screen.getByLabelText('Ask Union Ground Guide a question'),{target:{value:'Interleaved question'}});
 fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(harness.state.pending.length).toBeGreaterThan(0));
 holdUnrelated=true;
 await act(async()=>{harness.state.namedSubscriptions['member-notifications-member-1']('SUBSCRIBED');await new Promise(resolve=>setTimeout(resolve,100));});
 await waitFor(()=>expect(releaseCommit).toBeTypeOf('function'));
 // One act scope: React renders nothing until it closes, so the held commit
 // really does land while the appended exchange is only queued.
 await act(async()=>{
  harness.state.delay=null;harness.state.pending.forEach(resolve=>resolve());
  await new Promise(resolve=>setTimeout(resolve,200));
  expect(document.querySelector('.assistant').textContent).not.toContain('A retained synthetic answer');
  releaseCommit();
  await new Promise(resolve=>setTimeout(resolve,200));
 });
 expect(screen.getAllByText('A retained synthetic answer')).toHaveLength(1);
 expect(document.querySelector('[aria-label="Notifications, 0 unread"]')).not.toBeNull();
});

const PRIOR_LOAD = 'a-previous-page-load';
const DEPARTED_DRAFT = 'the departed member typed this into a grievance form';
const authToken = sessionId => `header.${btoa(JSON.stringify({session_id:sessionId})).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}.signature`;

async function seedDepartedResidue(owner='member-9', stamp=sessionStamp(6, PRIOR_LOAD)) {
 const store = harness.state.outbox;
 await plantSnapshot(store, owner, {member:{id:owner}, cases:['the departed session']}, 1000, stamp);
 await enqueueWrite(store, owner, {kind:'formDraft',key:'grievance',args:{fields:{statement:DEPARTED_DRAFT}}}, 1000, stamp);
 await enqueueWrite(store, owner, {kind:'profile',key:'profile',args:{fields:{phone:'617-555-0134'}}}, 1000, stamp);
 await enqueueWrite(store, owner, {kind:'rsvp',key:'evt-1',args:{status:'going'}}, 1000, stamp);
 return store;
}
const residueText = async store => JSON.stringify(await store.listAllEntries());

it('SEC: a boot that finds the refresh token revoked erases the prior member from the device', async () => {
 const store = await seedDepartedResidue();
 localStorage.removeItem(harness.authStorageKey);
 harness.state.getSession = () => ({data:{session:null},error:Object.assign(new Error('Invalid Refresh Token: Already Used'),{name:'AuthApiError',status:400})});

 render(<App/>);

 await waitFor(async () => expect(await loadSnapshot(store,'member-9')).toBeNull());
 await waitFor(async () => expect(await residueText(store)).not.toContain(DEPARTED_DRAFT));
 expect(await residueText(store)).not.toContain('617-555-0134');
 expect((await store.listEntries('member-9')).map(entry=>entry.kind)).toEqual(['rsvp']);
 expect(document.querySelector('.data-error')).not.toBeNull();
});

it('SEC: a boot whose auth storage is merely unreadable keeps the signed-in member\'s work', async () => {
 const store = await seedDepartedResidue();
 localStorage.setItem(harness.authStorageKey, JSON.stringify({access_token:'a',refresh_token:'r',user:{id:'member-9'}}));
 harness.state.getSession = () => ({data:{session:null},error:new Error('Persistent browser authentication storage is unavailable')});

 render(<App/>);

 await screen.findByText('Try again');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
 expect(await loadSnapshot(store,'member-9')).not.toBeNull();
 expect(await residueText(store)).toContain(DEPARTED_DRAFT);
});

it('SEC: a readable cold start with no session erases the prior member from the device', async () => {
 const store = await seedDepartedResidue();
 harness.state.getSession = () => ({data:{session:null},error:null});

 render(<App/>);

 await waitFor(async () => expect(await loadSnapshot(store,'member-9')).toBeNull());
 await waitFor(async () => expect(await residueText(store)).not.toContain(DEPARTED_DRAFT));
 expect((await store.listEntries('member-9')).map(entry=>entry.kind)).toEqual(['rsvp']);
});

it('SEC: a successful cold start sweeps stale lineages and preserves the restored session', async () => {
 const activeLineage='44444444-4444-4444-8444-444444444444';
 const staleLineage='11111111-1111-4111-8111-111111111111';
 const activeSession={user:harness.user,access_token:authToken(activeLineage),refresh_token:'active-refresh'};
 const store=await seedDepartedResidue('member-9',sessionStamp(6,PRIOR_LOAD,staleLineage));
 localStorage.setItem(harness.authStorageKey,JSON.stringify(activeSession));
 harness.state.getSession=()=>({data:{session:activeSession},error:null});

 render(<App/>);

 await screen.findByRole('heading',{name:/Darnell/});
 await waitFor(async()=>expect(await loadSnapshot(store,'member-9')).toBeNull());
 await waitFor(async()=>expect(await residueText(store)).not.toContain(DEPARTED_DRAFT));
 expect(await enqueueWrite(store,harness.user.id,{kind:'formDraft',key:'after-restore',args:{fields:{statement:'still writable'}}},3000,sessionStamp(1,undefined,activeLineage),()=>true,()=>activeLineage)).toBe(true);
});

it('SEC: a tombstoned raw auth tuple cannot shield departed cold-start residue', async () => {
 const lineage='33333333-3333-4333-8333-333333333333';
 const departedSession={user:{id:'member-9'},access_token:authToken(lineage),refresh_token:'departed-refresh'};
 const store=await seedDepartedResidue('member-9',sessionStamp(6,PRIOR_LOAD,lineage));
 localStorage.setItem(harness.authStorageKey,JSON.stringify(departedSession));
 localStorage.setItem(`${harness.authStorageKey}.closed-session.${lineage}`,'closed');
 harness.state.getSession=()=>({data:{session:null},error:null});

 render(<App/>);

 await waitFor(async()=>expect(await loadSnapshot(store,'member-9')).toBeNull());
 await waitFor(async()=>expect(await residueText(store)).not.toContain(DEPARTED_DRAFT));
 expect((await store.listEntries('member-9')).map(entry=>entry.kind)).toEqual(['rsvp']);
});

it('SEC: a re-login during the cold-start purge still erases the departed saved copy and writes none of its own', async () => {
 const base = createMemoryStore();
 let releaseDelete;
 let deleteStarted;
 const deleteStartedPromise = new Promise(resolve=>{deleteStarted=resolve;});
 const deleteGate = new Promise(resolve=>{releaseDelete=resolve;});
 harness.state.outbox = {...base, deleteSnapshotIf: async (userId, matches) => {
  deleteStarted();
  await deleteGate;
  return base.deleteSnapshotIf(userId, matches);
 }};
 await seedDepartedResidue('member-1');
 harness.state.getSession = () => ({data:{session:null},error:null});

 render(<App/>);
 await deleteStartedPromise;
 await act(async()=>{harness.state.authChanged('SIGNED_IN',harness.session);});
 await screen.findByRole('heading',{name:/Darnell/});
 await act(async()=>{releaseDelete();await new Promise(resolve=>setTimeout(resolve,50));});

 await waitFor(async () => expect(await loadSnapshot(base,'member-1')).toBeNull());
 expect(await residueText(base)).not.toContain(DEPARTED_DRAFT);
});

it('SEC: a distinct same-user sign-in purges the displaced auth lineage', async () => {
 const sessionA={user:harness.user,access_token:authToken('11111111-1111-4111-8111-111111111111')};
 const sessionB={user:harness.user,access_token:authToken('22222222-2222-4222-8222-222222222222')};
 const store=await seedDepartedResidue(harness.user.id,sessionStamp(1,'departed-tab','11111111-1111-4111-8111-111111111111'));
 harness.state.getSession=()=>({data:{session:sessionA},error:null});
 localStorage.setItem(harness.authStorageKey,JSON.stringify(sessionA));

 render(<App/>);
 await screen.findByRole('heading',{name:/Darnell/});
 localStorage.setItem(harness.authStorageKey,JSON.stringify(sessionB));
 await act(async()=>{harness.state.authChanged('SIGNED_IN',sessionB);});

 await waitFor(async()=>expect(await residueText(store)).not.toContain(DEPARTED_DRAFT));
 expect((await store.listEntries(harness.user.id)).filter(entry=>entry.kind==='formDraft' || entry.kind==='profile')).toEqual([]);
});

it('SEC: an offline write after implicit departure and re-login uses the live generation', async () => {
 const store = await seedDepartedResidue();
 harness.state.getSession = () => ({data:{session:null},error:null});

 render(<App/>);
 await waitFor(async () => expect(await loadSnapshot(store,'member-9')).toBeNull());
 harness.state.getSession = () => ({data:{session:harness.session},error:null});
 await act(async()=>{harness.state.authChanged('SIGNED_IN',harness.session);});
 await screen.findByRole('heading',{name:/Darnell/});

 harness.state.fail='rpc:update_my_member_profile';
 harness.state.failMessage='Failed to fetch';
 fireEvent.click(screen.getAllByRole('button',{name:'Profile'})[0]);
 const firstName = await screen.findByLabelText('First name');
 fireEvent.change(firstName,{target:{value:'Offline Darnell'}});
 fireEvent.submit(screen.getByRole('button',{name:'Save profile'}).closest('form'));

 await waitFor(async()=>expect(await store.listEntries('member-1')).toHaveLength(1));
 expect((await store.listEntries('member-1'))[0]).toMatchObject({
  kind:'profile',
  sessionGeneration:1,
 });
});
