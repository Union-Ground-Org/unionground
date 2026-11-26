import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnnouncementApi } from '../../../../src/features/platformAnnouncements/api.js';

// Execute real native callbacks and the shared memory reader; only native
// host primitives, navigation focus and the RPC transport are substituted.
const host = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  let slots: Slot[] = []; let cursor = 0;
  const effects: Array<() => void> = [];
  // Every focus effect's cleanup, so a blur runs all of them as navigation does.
  const focusCleanups = new Set<() => void>();
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) => !a || !b || a.length !== b.length || a.some((x,i)=>x!==b[i]);
  const slot = () => slots[cursor++] ?? (slots[cursor-1] = {});
  return {
    begin() { cursor=0; },
    flush() { effects.splice(0).forEach(fn=>fn()); },
    reset() { slots.forEach(s=>s.cleanup?.()); slots=[]; effects.length=0; focusCleanups.clear(); },
    useState(initial: unknown) { const s=slot(); if(!('value' in s)) s.value=typeof initial==='function' ? (initial as ()=>unknown)() : initial; return [s.value,(next:unknown)=>{s.value=typeof next==='function' ? (next as (old:unknown)=>unknown)(s.value) : next;}]; },
    useRef(initial:unknown) {const s=slot(); if(!('value' in s)) s.value={current:initial};return s.value;},
    useCallback(fn:unknown,deps:readonly unknown[]) {const s=slot();if(changed(s.deps,deps)){s.value=fn;s.deps=deps;}return s.value;},
    useEffect(fn:()=>void|(()=>void),deps?:readonly unknown[]) {const s=slot();if(changed(s.deps,deps)){s.deps=deps;effects.push(()=>{s.cleanup?.();s.cleanup=fn()||undefined;});}},
    appState: null as null | ((state:string)=>void),
    focusCleanup: null as null | (()=>void),
    focusCleanups,
    app: {} as Record<string, unknown>,
  };
});
vi.mock('react',async original=>({...await original<typeof React>(),useState:host.useState,useRef:host.useRef,useCallback:host.useCallback,useEffect:host.useEffect}));
vi.mock('react-native',()=>({View:'View',AppState:{addEventListener:(_kind:string,fn:(state:string)=>void)=>{host.appState=fn;return {remove:()=>{host.appState=null;}};}}}));
vi.mock('expo-router',()=>({useFocusEffect:(fn:()=>void|(()=>void))=>host.useEffect(()=>{const cleanup=fn();host.focusCleanup=cleanup||null;const blur=()=>{host.focusCleanups.delete(blur);cleanup?.();};host.focusCleanups.add(blur);return()=>{if(host.focusCleanups.has(blur))blur();host.focusCleanup=null;};},[fn])}));
vi.mock('../components/ui',()=>({Body:'Body',Button:'Button',Card:'Card',Heading:'Heading',Notice:'Notice'}));
vi.mock('../services/supabase',()=>({createCapturedSessionRpcClient:vi.fn()}));
vi.mock('../state/AppProvider',()=>({useApp:()=>host.app}));
import { NativeAnnouncementFollow, NativeAnnouncementReader, NativeAnnouncementToggle } from './NativePlatformAnnouncements';

type Node = React.ReactElement<Record<string,unknown>>;
function nodes(value:unknown):Node[] {
  if(Array.isArray(value)) return value.flatMap(nodes);
  if(!React.isValidElement<Record<string,unknown>>(value)) return [];
  return [value,...nodes(value.props.children)];
}
function text(value:unknown):string {
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(text).join(' ');
  return React.isValidElement<Record<string,unknown>>(value)?text(value.props.children):'';
}
function press(tree:unknown,label:string) {
  const button=nodes(tree).find(node=>node.type==='Button'&&node.props.label===label);
  expect(button, label).toBeDefined();
  (button?.props.onPress as ()=>void)();
}
const settle=async()=>{for(let i=0;i<12;i+=1)await Promise.resolve();};
const item={id:'a',announcementId:'p',revision:1,title:'Product update',body:'Plain text https://example.test',publishedAt:'2026-10-29T15:00:00-04:00',expiresAt:'2099-10-29T15:00:00-04:00',sourceType:'platform-announcement' as const};
function api():AnnouncementApi {
  return {feed:vi.fn().mockResolvedValue({items:[item],generation:1,hidden:false}),preference:vi.fn().mockResolvedValue({hidden:true}),settings:vi.fn().mockResolvedValue({enabled:false,generation:0,consentVersion:'platform-updates-v1',platformOrganizationId:null}),follow:vi.fn().mockResolvedValue({enabled:true,generation:1,consentVersion:'platform-updates-v1',platformOrganizationId:'platform'})};
}
afterEach(()=>host.reset());
describe('native private platform announcements',()=>{
  it('keeps the updates toggle usable when the dashboard member is absent',()=>{
    const session={user:{id:'member'},access_token:`header.${btoa(JSON.stringify({session_id:'session'}))}.signature`};
    for(const dashboard of [undefined,null,{}, {member:null}]) {
      host.app={mode:'authenticated',session,organizationID:'organization',dashboard};host.begin();
      const tree=NativeAnnouncementToggle({query:''});
      expect(nodes(tree).some(node=>node.type==='Button'&&node.props.label==='Union Ground updates')).toBe(true);
    }
  });
  it('offers the updates toggle only when its actual reader can render',()=>{
    const session={user:{id:'member'},access_token:`header.${btoa(JSON.stringify({session_id:'session'}))}.signature`};
    const live={mode:'authenticated',session,organizationID:'organization'};
    for(const change of [{mode:'preview'},{session:null},{organizationID:null},{locked:true},{privacyCovered:true},{assuranceUnavailable:true},{sessionRestricted:true}]) {
      host.app={...live,...change};host.begin();expect(NativeAnnouncementToggle({query:''})).toBeNull();
    }
    host.app=live;host.begin();expect(NativeAnnouncementToggle({query:'search'})).toBeNull();
    host.begin();let tree=NativeAnnouncementToggle({query:''});press(tree,'Union Ground updates');
    host.begin();tree=NativeAnnouncementToggle({query:''});expect(nodes(tree).some(node=>node.type==='Button'&&node.props.label==='Close product updates')).toBe(true);
  });
  it('reads plain authorized content in English and clears memory on background',async()=>{
    const transport=api();
    const render=()=>{host.begin();const tree=NativeAnnouncementReader({api:transport});host.flush();return tree;};
    render();await settle();
    expect(text(render())).toContain(item.body);
    expect(transport.feed).toHaveBeenCalledWith('en',null);
    host.appState?.('background');
    expect(text(render())).not.toContain(item.body);
    host.appState?.('active');await settle();expect(text(render())).toContain(item.body);
  });
  it('requires explicit personal undo after hiding, without changing organizational consent',async()=>{
    const transport=api();
    const render=()=>{host.begin();const tree=NativeAnnouncementReader({api:transport});host.flush();return tree;};
    render();await settle();
    vi.mocked(transport.feed).mockResolvedValueOnce({items:[],generation:1,hidden:true});
    press(render(),'Hide these updates');await settle();
    expect(text(render())).not.toContain(item.body);expect(text(render())).toContain('Product updates are hidden for you.');
    press(render(),'Show these updates');await settle();
    expect(transport.preference).toHaveBeenLastCalledWith(false);
    expect(transport.follow).not.toHaveBeenCalled();
  });
  it('does not reactivate a reader after navigation focus was lost',async()=>{
    const transport=api();
    host.begin();NativeAnnouncementReader({api:transport});host.flush();await settle();
    const activate=host.appState;
    host.focusCleanup?.();
    const calls=vi.mocked(transport.feed).mock.calls.length;
    activate?.('active');await settle();
    expect(transport.feed).toHaveBeenCalledTimes(calls);
    expect(host.appState).toBeNull();
  });
  it('follows with the displayed token and confirms revoke for everyone',async()=>{
    const transport=api();
    const render=()=>{host.begin();const tree=NativeAnnouncementFollow({api:transport});host.flush();return tree;};
    render();await settle();press(render(),'Follow product updates');await settle();
    expect(transport.follow).toHaveBeenCalledWith(true,0);
    press(render(),'Stop following');expect(transport.follow).toHaveBeenCalledTimes(1);
    press(render(),'Stop following for everyone');await settle();
    expect(transport.follow).toHaveBeenLastCalledWith(false,1);
  });
  it('drops a delayed reader response after leaving the scope',async()=>{
    const transport=api();let finish:(value:Awaited<ReturnType<AnnouncementApi['feed']>>)=>void=()=>{};
    vi.mocked(transport.feed).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    host.begin();NativeAnnouncementReader({api:transport});host.flush();host.reset();
    finish({items:[item],generation:1,hidden:false});await settle();
    const next=api();vi.mocked(next.feed).mockResolvedValue({items:[],generation:2,hidden:false});
    host.begin();const tree=NativeAnnouncementReader({api:next});host.flush();expect(text(tree)).not.toContain(item.body);
  });
  // A renewed api (a refreshed token for the same scope)
  // reloads the settings but keeps a follow that is still writing, so its
  // acknowledgement is shown, and a reload that read before the write lands
  // never puts the old answer back over it.
  it.each<'before'|'after'>(['before','after'])('keeps a follow acknowledgement when the api is renewed during the write (renewed read lands %s it)',async order=>{
    const first=api();
    let finishFollow:(value:Awaited<ReturnType<AnnouncementApi['follow']>>)=>void=()=>{};
    vi.mocked(first.follow).mockImplementation(()=>new Promise(resolve=>{finishFollow=resolve;}));
    let transport=first;
    const render=()=>{host.begin();const tree=NativeAnnouncementFollow({api:transport});host.flush();return tree;};
    render();await settle();
    press(render(),'Follow product updates');await settle();
    const renewed=api();
    let finishRead:(value:Awaited<ReturnType<AnnouncementApi['settings']>>)=>void=()=>{};
    vi.mocked(renewed.settings).mockImplementation(()=>new Promise(resolve=>{finishRead=resolve;}));
    transport=renewed;render();await settle();
    expect(renewed.settings).toHaveBeenCalledTimes(1);
    const stale={enabled:false,generation:0,consentVersion:'platform-updates-v1',platformOrganizationId:null};
    if(order==='before'){finishRead(stale);await settle();}
    finishFollow({enabled:true,generation:1,consentVersion:'platform-updates-v1',platformOrganizationId:'platform'});await settle();
    if(order==='after'){finishRead(stale);await settle();}
    const shown=text(render());
    expect(shown).toContain('Preference saved.');
    expect(shown).toContain('Your organization is following product updates.');
    expect(nodes(render()).find(node=>node.type==='Button'&&node.props.label==='Stop following')?.props.disabled).toBe(false);
    expect(first.follow).toHaveBeenCalledTimes(1);
  });
  it('still drops a follow answer after navigation focus was lost',async()=>{
    const transport=api();
    let finishFollow:(value:Awaited<ReturnType<AnnouncementApi['follow']>>)=>void=()=>{};
    vi.mocked(transport.follow).mockImplementation(()=>new Promise(resolve=>{finishFollow=resolve;}));
    const render=()=>{host.begin();const tree=NativeAnnouncementFollow({api:transport});host.flush();return tree;};
    render();await settle();
    press(render(),'Follow product updates');await settle();
    [...host.focusCleanups].forEach(blur=>blur());
    finishFollow({enabled:true,generation:1,consentVersion:'platform-updates-v1',platformOrganizationId:'platform'});await settle();
    expect(text(render())).not.toContain('Preference saved.');
    expect(text(render())).not.toContain('Your organization is following product updates.');
  });
  it('reloads through the renewed api when a follow fails after the api was renewed',async()=>{
    const first=api();
    let failFollow:(cause:unknown)=>void=()=>{};
    vi.mocked(first.follow).mockImplementation(()=>new Promise((_resolve,reject)=>{failFollow=reject;}));
    let transport=first;
    const render=()=>{host.begin();const tree=NativeAnnouncementFollow({api:transport});host.flush();return tree;};
    render();await settle();
    press(render(),'Follow product updates');await settle();
    const renewed=api();
    transport=renewed;render();await settle();
    const firstReads=vi.mocked(first.settings).mock.calls.length;
    const renewedReads=vi.mocked(renewed.settings).mock.calls.length;
    failFollow(new Error('unavailable'));await settle();
    expect(renewed.settings).toHaveBeenCalledTimes(renewedReads+1);
    expect(first.settings).toHaveBeenCalledTimes(firstReads);
    expect(text(render())).toContain('Updates are unavailable. Refresh to try again.');
  });
  it('shows no follow failure after navigation focus was lost during its reload',async()=>{
    const transport=api();
    let failFollow:(cause:unknown)=>void=()=>{};
    vi.mocked(transport.follow).mockImplementation(()=>new Promise((_resolve,reject)=>{failFollow=reject;}));
    const render=()=>{host.begin();const tree=NativeAnnouncementFollow({api:transport});host.flush();return tree;};
    render();await settle();
    press(render(),'Follow product updates');await settle();
    let finishRead:(value:Awaited<ReturnType<AnnouncementApi['settings']>>)=>void=()=>{};
    vi.mocked(transport.settings).mockImplementation(()=>new Promise(resolve=>{finishRead=resolve;}));
    failFollow(new Error('unavailable'));await settle();
    [...host.focusCleanups].forEach(blur=>blur());
    finishRead({enabled:false,generation:0,consentVersion:'platform-updates-v1',platformOrganizationId:null});await settle();
    expect(text(render())).not.toContain('Updates are unavailable. Refresh to try again.');
  });
  // Round 1 r1s1 of #9391: the server's generation only grows (a follow makes
  // it odd, a revoke the next even number), so a settings answer older than
  // the one on screen is stale wherever it comes from. Administrator A's
  // follow (generation 1) is delayed; administrator B revokes (generation 2)
  // and a renewed read shows that; A's late answer must not show following.
  type Order='read first'|'answer first';
  it.each<[Order,number,boolean]>([
    ['read first',1,true],['answer first',1,true],
    ['read first',2,false],['answer first',2,false],
  ])('orders a renewed read and a late follow answer by generation (%s, read at generation %i)',async(order,readGeneration,acknowledged)=>{
    const first=api();
    let finishFollow:(value:Awaited<ReturnType<AnnouncementApi['follow']>>)=>void=()=>{};
    vi.mocked(first.follow).mockImplementation(()=>new Promise(resolve=>{finishFollow=resolve;}));
    let transport=first;
    const render=()=>{host.begin();const tree=NativeAnnouncementFollow({api:transport});host.flush();return tree;};
    render();await settle();
    press(render(),'Follow product updates');await settle();
    const renewed=api();
    let finishRead:(value:Awaited<ReturnType<AnnouncementApi['settings']>>)=>void=()=>{};
    vi.mocked(renewed.settings).mockImplementation(()=>new Promise(resolve=>{finishRead=resolve;}));
    transport=renewed;render();await settle();
    const read={enabled:readGeneration%2===1,generation:readGeneration,consentVersion:'platform-updates-v1',platformOrganizationId:readGeneration%2===1?'platform':null};
    if(order==='read first'){finishRead(read);await settle();}
    finishFollow({enabled:true,generation:1,consentVersion:'platform-updates-v1',platformOrganizationId:'platform'});await settle();
    if(order==='answer first'){finishRead(read);await settle();}
    const shown=text(render());
    expect(shown).toContain(acknowledged?'Your organization is following product updates.':'Your organization is not following product updates.');
    if(acknowledged)expect(shown).toContain('Preference saved.');else expect(shown).not.toContain('Preference saved.');
    expect(nodes(render()).some(node=>node.type==='Button'&&node.props.label===(acknowledged?'Stop following':'Follow product updates')&&node.props.disabled===false)).toBe(true);
  });
});
