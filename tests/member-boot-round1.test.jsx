import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
// Retained er probes, adapted to the real authenticated App path
// through Vitest environment injection; all expectations assert repaired behavior.
import React from 'react';
import {render, screen, waitFor, act, cleanup, fireEvent} from '@testing-library/react';
import {it, expect, vi, beforeEach, afterEach} from 'vitest';
import {App} from '../src/App.jsx';
import {createMemberSessionLoader} from '../src/lib/memberSessionLoader.js';
import {loadMemberApp} from '../src/lib/memberApi.js';

const harness = vi.hoisted(() => {
  const user = {id:'member-1',email:'member@example.test'};
  const session = {user, access_token:'fictional-test-token'};
  const state = {fail:null,delay:null,pending:[],operations:[],rows:{},authChanged:null};
  const execute = async resource => {
    state.operations.push(resource);
    if(state.delay===resource) await new Promise(resolve=>state.pending.push(resolve));
    if(state.fail===resource) return {data:null,error:{message:'isolated lazy failure'}};
    if(resource==='table:member_profiles') return {data:{id:user.id,first_name:'Darnell',full_name:'Darnell Foster',initials:'DF',language:'en',chapter_id:'chapter-1'},error:null};
    if(resource in state.rows) return {data:structuredClone(state.rows[resource]),error:null};
    if(resource==='rpc:get_member_rewards_summary') return {data:{actionsYtd:100},error:null};
    return {data:resource.startsWith('rpc:')?null:[],error:null};
  };
  const client = {
    rpc(name){return execute('rpc:'+name);},
    auth:{getSession:async()=>({data:{session},error:null}),onAuthStateChange(fn){state.authChanged=fn;return {data:{subscription:{unsubscribe(){}}}};},mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal1',nextLevel:'aal1'},error:null})}},
    channel(){const c={on(){return c},subscribe(){return c},unsubscribe(){}};return c},removeChannel(){},realtime:{setAuth(){}}
  };
  // Supabase's query builders are thenables; execute only when awaited.
  client.from = table => {let p;p=new Proxy({}, {get(_t,key){if(key==='then')return (resolve,reject)=>execute('table:'+table).then(resolve,reject);return ()=>p;}});return p;};
  return {state,client,user,session};
});

vi.mock('../src/lib/supabase.js',async importOriginal=>({...await importOriginal(),appBackendKind:'live',hasAppBackend:true,appAuthStorageUnavailable:false,createCapturedAppSessionRpcClient: () => capturedAppClientFixture(harness.client), appSupabase:harness.client}));
vi.mock('../src/lib/guideApi.js',()=>({requestGuideReply:async()=>({answer:'A retained synthetic answer',sources:[]})}));

beforeEach(()=>{
  vi.stubEnv("MODE", "authenticated-test");
  harness.state.fail=null; harness.state.delay=null;harness.state.operations=[];harness.state.rows={};harness.state.pending=[];
  localStorage.clear();sessionStorage.clear();
  window.history.replaceState({},'', '/m');window.scrollTo=vi.fn();
  global.fetch=vi.fn().mockRejectedValue(new Error('offline test'));
});
afterEach(()=>{cleanup();vi.unstubAllEnvs();});
async function navigate(path){await act(async()=>{window.history.pushState({},'',path);window.dispatchEvent(new PopStateEvent('popstate'));});}

it('injected Messages failure leaves the real shell and Home usable and renders a route-local error',async()=>{
  harness.state.fail='table:member_conversations';
  render(<App/>);
  await screen.findByRole('heading',{name:/Darnell/});
  expect(harness.state.operations).not.toContain('table:member_conversations');
  await navigate('/m/messages');
  await waitFor(()=>expect(document.querySelector('.view-error')).not.toBeNull());
  expect(document.querySelector('.sg-app')).not.toBeNull();
  expect(document.querySelector('.view-error h1').textContent).toBe("This page didn't load");
  expect(document.querySelector('.view-error').textContent).toContain('Check your connection, then try again.');
  expect(document.querySelector('.view-error').textContent).not.toContain('isolated lazy failure');
  await navigate('/m');
  await screen.findByRole('heading',{name:/Darnell/});
});

it('REPRO: leave a pending route and return; completed request leaves it permanently loading',async()=>{
  harness.state.rows['table:member_conversations']=[{id:'cached-thread',title:'Cached conversation',initials:'CC'}];
  render(<App/>);
  await screen.findByRole('heading',{name:/Darnell/});
  harness.state.delay='table:member_conversations';
  await navigate('/m/messages');
  await waitFor(()=>expect(harness.state.pending.length).toBeGreaterThan(0));
  await navigate('/m');
  await screen.findByRole('heading',{name:/Darnell/});
  harness.state.delay=null;
  await act(async()=>{harness.state.pending.forEach(resolve=>resolve());});
  const count=harness.state.operations.length;
  await navigate('/m/messages');
  // Data can finish off-route before the lazy page module arrives. Wait for
  // both the page and its cached rows, rather than guessing a render delay.
  await screen.findByRole('heading',{name:'Messages',level:1});
  expect(await screen.findByRole('button',{name:/Cached conversation/})).toBeInTheDocument();
  expect(document.querySelector('.view-loading')).toBeNull(); expect(document.querySelector('.view-error')).toBeNull(); expect(document.querySelector('.sg-app')).not.toBeNull();
  expect(harness.state.operations.length).toBe(count);
});

it('REPRO: token refresh cancels pending route and suppresses its completion',async()=>{
  render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
  harness.state.delay='table:member_conversations';await navigate('/m/messages');
  await waitFor(()=>expect(harness.state.pending.length).toBeGreaterThan(0));
  await act(async()=>harness.state.authChanged('TOKEN_REFRESHED',{...harness.session}));
  harness.state.delay=null;
  await act(async()=>{harness.state.pending.forEach(resolve=>resolve());await new Promise(resolve=>setTimeout(resolve,100));});
  expect(document.querySelector('.view-loading')).toBeNull(); expect(document.querySelector('.view-error')).toBeNull(); expect(document.querySelector('.sg-app')).not.toBeNull();
});

it('REPRO: cold My Reports silently omits ballots and rights fetched by the original loader',async()=>{
  harness.state.rows['table:member_ballots']=[{id:'ballot-1',title:'Test ballot',active:true,closes_at:'2026-09-20T12:00:00Z',member_ballot_options:[]}];
  harness.state.rows['table:member_rights_lessons']=[{id:'lesson-1',title:'Rights',label:'Rights',total_steps:2}];
  const eager=await loadMemberApp(harness.client,harness.user);
  const lazy=await createMemberSessionLoader(harness.client,harness.user).loadRoute('numbers');
  expect(eager.planItems.length).toBeGreaterThan(0);
  expect(eager.rights.lessonRecords.length).toBe(1);
  expect(lazy.planItems).toEqual(eager.planItems);
  expect(lazy.rights.lessonRecords).toEqual(eager.rights.lessonRecords);
});

it('REPRO: a rights mutation refresh retains the old cached actions count from Home',async()=>{
  // Union Ground has no points: the shared summary carries only the
  // actions-this-year count, which a write on any route can advance.
  harness.state.rows['rpc:get_member_rewards_summary']={actionsYtd:100};
  const loader=createMemberSessionLoader(harness.client,harness.user);
  expect((await loader.loadRoute('today')).rewards.actionsYtd).toBe(100);
  await loader.loadRoute('rights');
  harness.state.rows['rpc:get_member_rewards_summary']={actionsYtd:120,totalPoints:999};
  await loader.loadRoute('rights',{force:true});
  expect((await loader.loadRoute('today')).rewards).toEqual({actionsYtd:120});
  expect((await loadMemberApp(harness.client,harness.user)).rewards).toEqual({actionsYtd:120});
});

it('REPRO: steward badge RPC is unreachable through every planned staff route',async()=>{
  harness.state.rows['table:member_roles']=[{role:'steward'}];
  harness.state.rows['rpc:get_steward_badge_counts']={requests:7};
  const loader=createMemberSessionLoader(harness.client,harness.user);
  await loader.loadShell();
  for(const route of ['today','steward','messages','tasks','hub']) await loader.loadRoute(route);
  expect(harness.state.operations).toContain('rpc:get_steward_badge_counts');
  expect((await loadMemberApp(harness.client,harness.user)).stewardBadges).toEqual({requests:7});
});

it('REPRO: successfully saved Guide answer disappears when opened from Home',async()=>{
  render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
  // Compass is the Union Ground Guide.
  const compass=[...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide'));
  fireEvent.click(compass);await screen.findByRole('dialog',{name:'Union Ground Guide'});
  harness.state.rows['rpc:save_member_guide_exchange']='thread-1';
  harness.state.rows['table:member_guide_threads']=[{id:'thread-1',title:'Synthetic question'}];
  harness.state.rows['table:member_guide_messages']=[{id:'message-1',thread_id:'thread-1',role:'assistant',body:'A retained synthetic answer'}];
  fireEvent.change(screen.getByLabelText('Ask Union Ground Guide a question'),{target:{value:'Synthetic question'}});
  fireEvent.click(screen.getByRole('button',{name:'Send'}));
  await waitFor(()=>expect(screen.getByLabelText('Ask Union Ground Guide a question')).toHaveValue(''));
  expect(harness.state.operations).toContain('rpc:save_member_guide_exchange');
  expect(harness.state.operations).toContain('table:member_guide_messages');
  expect(await screen.findByText('A retained synthetic answer')).toBeInTheDocument();
});

it('REPRO: even a forced refresh uses the session-start time after a ballot closes',async()=>{
  const start=Date.UTC(2026,8,6,12);
  vi.spyOn(Date,'now').mockReturnValue(start);
  try {
    harness.state.rows['table:member_ballots']=[{id:'ballot-1',title:'Closing ballot',active:true,closes_at:new Date(start+60000).toISOString(),member_ballot_options:[]}];
    const loader=createMemberSessionLoader(harness.client,harness.user);
    expect((await loader.loadRoute('voting')).planItems.find(x=>x.kind==='ballot').closed).toBe(false);
    Date.now.mockReturnValue(start+120000);
    expect((await loader.loadRoute('voting',{force:true})).planItems.find(x=>x.kind==='ballot').closed).toBe(true);
    expect((await loadMemberApp(harness.client,harness.user)).planItems.find(x=>x.kind==='ballot').closed).toBe(true);
  } finally {vi.restoreAllMocks();}
});
