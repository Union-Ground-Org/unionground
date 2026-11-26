// Retained er probes, adapted to the real authenticated App path
// through Vitest environment injection; all expectations assert repaired behavior.
import React from 'react';
import {render, screen, waitFor, act, cleanup, fireEvent} from '@testing-library/react';
import {it, expect, vi, beforeEach, afterEach} from 'vitest';
import {App} from '../src/App.jsx';
import {MEMBER_REQUEST_CONCURRENCY,createMemberSessionLoader} from '../src/lib/memberSessionLoader.js';
import {loadMemberApp} from '../src/lib/memberApi.js';
import {MEMBER_HOME_BOOTSTRAP_RESOURCE} from '../src/lib/memberHomeBootstrap.js';
import {composeMemberHomeBootstrap} from './helpers/member-home-bootstrap-fixture.js';
import {memberHomeBootstrapRequested} from '../src/lib/memberHomeBootstrap.js';

const harness = vi.hoisted(() => {
  const user = {id:'member-1',email:'member@example.test'};
  const session = {user, access_token:'fictional-test-token'};
  const state = {fail:null,delay:null,pending:[],operations:[],rows:{},authChanged:null,guideDelay:false,guidePending:[],rpcArgs:[],subscriptions:[]};
  const execute = async (resource, args) => {
    state.operations.push(resource);
    state.active += 1; state.maximumActive = Math.max(state.maximumActive, state.active);
    try {
    await Promise.resolve();
    if(state.delay===resource) await new Promise(resolve=>state.pending.push(resolve));
    if(state.fail===resource) return {data:null,error:{message:'isolated lazy failure'}};
    // One call answers the eighteen covered reads from the same rows; a failing
    // covered read fails the call, and the loader then reads that table itself.
    if(resource===MEMBER_HOME_BOOTSTRAP_RESOURCE) return composeMemberHomeBootstrap(r=>r===state.fail?{data:null,error:{message:'isolated lazy failure'}}:{data:structuredClone(state.rows[r]??[]),error:null},user.id,memberHomeBootstrapRequested(args));
    if(resource==='table:member_profiles') return {data:{id:user.id,first_name:'Darnell',full_name:'Darnell Foster',initials:'DF',language:'en',chapter_id:'chapter-1'},error:null};
    if(resource in state.rows) return {data:structuredClone(state.rows[resource]),error:null};
    if(resource==='rpc:get_member_rewards_summary') return {data:{totalPoints:100},error:null};
    return {data:resource.startsWith('rpc:')?null:[],error:null};
    } finally { state.active -= 1; }
  };
  const client = {
    rpc(name,args){state.rpcArgs.push({name,args});return execute('rpc:'+name,args);},
    auth:{getSession:async()=>({data:{session},error:null}),onAuthStateChange(fn){state.authChanged=fn;return {data:{subscription:{unsubscribe(){}}}};},mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal1',nextLevel:'aal1'},error:null})}},
    channel(){const c={on(){return c},subscribe(callback){state.subscriptions.push(callback);return c},unsubscribe(){}};return c},removeChannel(){},realtime:{setAuth(){}}
  };
  // Supabase's query builders are thenables; execute only when awaited.
  client.from = table => {let p;p=new Proxy({}, {get(_t,key){if(key==='then')return (resolve,reject)=>execute('table:'+table).then(resolve,reject);return ()=>p;}});return p;};
  return {state,client,user,session};
});

vi.mock('../src/lib/supabase.js',async importOriginal=>({...await importOriginal(),appBackendKind:'live',hasAppBackend:true,appAuthStorageUnavailable:false,appSupabase:harness.client}));
vi.mock('../src/lib/guideApi.js',()=>({requestGuideReply:async()=>{if(harness.state.guideDelay)await new Promise(resolve=>harness.state.guidePending.push(resolve));return {answer:'A retained synthetic answer',sources:[]};}}));

beforeEach(()=>{
  vi.stubEnv("MODE", "authenticated-test");
  harness.state.active=0;harness.state.maximumActive=0;
  harness.state.guideDelay=false;harness.state.guidePending=[];harness.state.rpcArgs=[];harness.state.subscriptions=[];harness.state.fail=null; harness.state.delay=null;harness.state.operations=[];harness.state.rows={};harness.state.pending=[];
  harness.state.rows['rpc:get_my_mfa_requirement']={required:false,enrolled:false};
  localStorage.clear();sessionStorage.clear();
  window.history.replaceState({},'', '/m');window.scrollTo=vi.fn();
  global.fetch=vi.fn().mockRejectedValue(new Error('offline test'));
});
afterEach(()=>{cleanup();vi.unstubAllEnvs();});
async function navigate(path){await act(async()=>{window.history.pushState({},'',path);window.dispatchEvent(new PopStateEvent('popstate'));});}


it('REPRO R2: a moving production clock erases cached Home tasks after Rights navigation',async()=>{
  let now=Date.UTC(2026,8,6,12);
  harness.state.rows['table:chapter_tasks']=[{id:'task-clock',title:'Keep this task',status:'in_progress',assignee_id:'member-1',created_at:new Date(now).toISOString()}];
  const loader=createMemberSessionLoader(harness.client,harness.user,{now:()=>now});
  const first=await loader.loadRoute('today');expect(first.tasks.map(t=>t.id)).toContain('task-clock');
  now+=1000;
  const next=await loader.loadRoute('rights');
  expect(next.tasks.map(t=>t.id)).toContain('task-clock');
});

it('REPRO R2: the advertised zero-request warm Home load refetches with a moving clock',async()=>{
  let now=Date.UTC(2026,8,6,12);
  const loader=createMemberSessionLoader(harness.client,harness.user,{now:()=>now});
  await loader.loadShell();await loader.loadRoute('today');const cold=harness.state.operations.length;
  now+=1000;await loader.loadRoute('today');
  expect(harness.state.operations.length-cold).toBe(0);
});

it('REPRO R2 DOM: Home loaded marker lets wiped tasks stay absent on return',async()=>{
  harness.state.rows['table:chapter_tasks']=[{id:'task-clock',title:'Keep this task',status:'in_progress',assignee_id:'member-1',created_at:new Date().toISOString()}];
  render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
  expect(await screen.findByText('Keep this task')).toBeInTheDocument();
  await navigate('/m/rights');await waitFor(()=>expect(document.querySelector('.view-loading')).toBeNull());
  const count=harness.state.operations.length;
  await navigate('/m');await screen.findByRole('heading',{name:/Darnell/});
  expect(screen.queryByText('Keep this task')).toBeInTheDocument();expect(harness.state.operations.length).toBe(count);
});

it('REPRO R2: returning to an in-flight Messages route before an older request finishes strands it idle',async()=>{
  harness.state.rows['table:member_conversations']=[{id:'pending-thread',title:'Pending conversation',initials:'PC'}];
  render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
  harness.state.delay='table:member_conversations';await navigate('/m/messages');
  await waitFor(()=>expect(harness.state.pending.length).toBeGreaterThan(0));
  await navigate('/m/rights');
  await screen.findByRole('heading',{name:/^(Learn|Know your rights)$/,level:1});
  // Return while the original read is still held: Rights has its own data,
  // and Messages must join the pending read instead of getting stranded.
  await navigate('/m/messages');
  expect(document.querySelector('.view-loading')).not.toBeNull();
  expect(screen.queryByRole('button',{name:/Pending conversation/})).not.toBeInTheDocument();
  harness.state.delay=null;await act(async()=>{harness.state.pending.forEach(resolve=>resolve());});
  await screen.findByRole('heading',{name:'Messages',level:1});
  expect(await screen.findByRole('button',{name:/Pending conversation/})).toBeInTheDocument();
  expect(document.querySelector('.view-loading')).toBeNull();
  expect(document.querySelector('.view-error')).toBeNull();
  expect(document.querySelector('.sg-app')).not.toBeNull();
  expect(harness.state.operations.filter(resource=>resource==='table:member_conversations')).toHaveLength(1);
});


it('REPRO R2: reconnect refresh wipes loaded Compass history without reloading overlay resources',async()=>{
 harness.state.rows['table:member_guide_threads']=[{id:'prior-thread',title:'Prior saved question'}];
 harness.state.rows['table:member_guide_messages']=[{id:'m1',thread_id:'prior-thread',role:'assistant',body:'Prior saved answer'}];
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
 await screen.findByRole('dialog',{name:'Union Ground Guide'});
 fireEvent.click(screen.getByRole('button',{name:'Open conversations'}));
 expect(await screen.findByRole('button',{name:'Prior saved question'})).toBeInTheDocument();
 const count=harness.state.operations.filter(x=>x==='table:member_guide_threads').length;
 await act(async()=>{harness.state.subscriptions[0]('SUBSCRIBED');await new Promise(resolve=>setTimeout(resolve,100));});
 expect(screen.queryByRole('button',{name:'Prior saved question'})).toBeInTheDocument();
 expect(harness.state.operations.filter(x=>x==='table:member_guide_threads')).toHaveLength(count);
});
it('real cold App settles at 20 reads and first SUBSCRIBED at 22',async()=>{
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 await waitFor(()=>expect(document.querySelector('.view-loading')).toBeNull());
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,100));});
 const bootCount=harness.state.operations.length;
 // 33 -> 34 on 2026-09-22: the default-on Find-my-steward Home card reads its
 // roster at boot (REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922).
 // 34 -> 35 on 2026-10-01: the member's own ULP case summary is Home data
 // (REQ-UG-ULP-FILING-DEADLINE-20261001, MEMBER_COLD_HOME_REQUEST_CEILING).
 // 35 -> 36 on 2026-10-12: terms of use 0.2.0 (adults-only, 18+) is the first
 // material legal change, so App reads the member's own acceptance state once
 // at sign-in (REQ-UG-ADULTS-ONLY-18-PLUS-20261012). It is an App read,
 // not Home data, so MEMBER_COLD_HOME_REQUEST_CEILING is unchanged.
 // 36 -> 31 for Union Ground: ULP filing deadlines are left out (-1);
 // with no points economy Home drops point rules, reward tiers, reward
 // effects and chapter cards (-4); and the verified participation week
 // replaces Union Ground's action log read one for one. That is the 30
 // loader reads of MEMBER_COLD_HOME_REQUEST_CEILING plus the legal read.
 // 31 -> 19: the plain cold-Home table reads arrive in one
 // get_member_home_bootstrap call (the merged session loader). 19 -> 20: Home
 // counts open organization surveys from get_member_engagement_snapshot.
 expect(bootCount).toBe(20);
 expect(harness.state.operations.filter(resource=>resource==='rpc:get_member_home_bootstrap')).toHaveLength(1);
 for(const retired of ['table:member_point_rules','table:member_reward_tiers','rpc:get_member_reward_effects','rpc:get_reward_cross_chapter_cards','table:member_point_events','table:member_action_log']) expect(harness.state.operations).not.toContain(retired);
 expect(harness.state.operations.filter(resource=>resource==='rpc:get_my_legal_acceptance_state')).toHaveLength(1);
 expect(harness.state.operations.filter(resource=>resource==='rpc:get_my_mfa_requirement')).toHaveLength(1);
 // The loader queue's window, plus App's own legal-acceptance read beside it
 // (REQ-UG-PAGE-LOADING-STALLS-20261030 widened the window to eight).
 expect(harness.state.maximumActive).toBeLessThanOrEqual(MEMBER_REQUEST_CONCURRENCY+1);
 expect(harness.state.operations.filter(resource=>resource==='table:member_profiles')).toHaveLength(1);
 await act(async()=>{harness.state.subscriptions[0]('SUBSCRIBED');await new Promise(resolve=>setTimeout(resolve,100));});
 expect(harness.state.operations.length).toBe(22);
 process.stdout.write(JSON.stringify({bootCount,afterSubscribed:harness.state.operations.length,maximumActive:harness.state.maximumActive})+'\n');
});
it('REPRO R2: delayed mutation refresh for old Home route strands the current Rights route',async()=>{
 render(<App/>);await screen.findByRole('heading',{name:/Darnell/});
 fireEvent.click([...document.querySelectorAll('.morehub-row')].find(row=>row.textContent.includes('Union Ground Guide')));
 await screen.findByRole('dialog',{name:'Union Ground Guide'});
 harness.state.guideDelay=true;
 fireEvent.change(screen.getByLabelText('Ask Union Ground Guide a question'),{target:{value:'Pending question'}});
 fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(harness.state.guidePending.length).toBe(1));
 await navigate('/m/rights');await waitFor(()=>expect(document.querySelector('.view-loading')).toBeNull());
 harness.state.guideDelay=false;
 await act(async()=>{harness.state.guidePending.forEach(resolve=>resolve());await new Promise(resolve=>setTimeout(resolve,150));});
 expect(window.location.pathname).toBe('/m/rights');
 expect(document.querySelector('.view-loading')).toBeNull();
 expect(document.querySelector('.view-error')).toBeNull();
});
it('REPRO R2: cold Search still omits saved Compass exchanges present in eager search',async()=>{
 harness.state.rows['table:member_guide_threads']=[{id:'prior-thread',title:'Searchable saved question'}];
 harness.state.rows['table:member_guide_messages']=[{id:'m1',thread_id:'prior-thread',role:'assistant',body:'Searchable saved answer'}];
 const {buildSearchIndex}=await import('../src/lib/searchIndex.js');
 const eager=await loadMemberApp(harness.client,harness.user);
 const coldSearch=await createMemberSessionLoader(harness.client,harness.user).loadRoute('search');
 expect(buildSearchIndex(eager).some(x=>x.type==='guide'&&x.title==='Searchable saved question')).toBe(true);
 expect(buildSearchIndex(coldSearch).some(x=>x.type==='guide')).toBe(true);
});
