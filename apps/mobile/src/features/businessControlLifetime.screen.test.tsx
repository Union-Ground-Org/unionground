// @vitest-environment jsdom
// Mount the real person-owned busy hooks and execute each production handler,
// including its actual awaits. API/proof/read promises are the fixture seams.
import { act, createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pressable, Text, getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import { completeBusinessOperation, useBusinessState, useBusinessOperation } from '../lib/useBusinessWriter';
import { checkBusinessContinuation, settleBusinessWrite, BUSINESS_SAVED_STALE } from '../lib/businessWriteContinuation';
import { createRequestGeneration } from '../lib/requestGeneration';
import { saveThenReload } from './caseRowTopicModel';

vi.mock('../state/AppProvider', () => ({ useApp: () => ({ mode: 'authenticated', session: { user: { id: 'actor-a' }, access_token: 'fixture' }, organizationID: 'org-a',
  dashboard: { member: { chapterID: 'chapter-a' } }, chapterMemberships: [{ chapterID: 'chapter-a', selected: true }], authorizedRoles: ['admin'] }) }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => ({ userId: 'actor-a' }) }));

type Row = { file: string; component: string; handler: string; args?: unknown[]; idle?: null; proof?: boolean; extra?: Record<string, unknown> };
const rows: Row[] = [
  // #9240 PR E: the attempt the press began on the held draft (useRetainedDraft).
  { file:'CoordinatorCaseWritesCard.tsx',component:'CoordinatorCaseWritesCard',handler:'write',args:['note',{value:{note:'An accepted note'},key:'fixture-key',settle:()=>true},async()=>{},()=>{}],proof:true,extra:{status:{kind:'ready'}} },
  { file:'CaseStewardAssignment.tsx',component:'CaseStewardAssignment',handler:'save',proof:true,extra:{changed:true,confirmed:true,selected:'steward-b',assignment:{stewardUserID:'steward-a',stewards:[]}} },
  { file:'StewardCaseNoteCard.tsx',component:'StewardCaseNoteCard',handler:'save',proof:true,extra:{status:'ready',body:'An accepted note',sending:false,uncertain:false,stewardCaseNoteProblem:()=>null,draft:{shown:true,begin:()=>({value:{body:'An accepted note'},key:'fixture-key',settle:()=>true})}} },
  { file:'CaseRowTopicCards.tsx',component:'useSetting',handler:'change',args:[true],proof:true,extra:{key:'case-a',setting:{value:false,note:'Fixture'}} },
];
function production(row: Row, context: Record<string, unknown>) {
  const path=`apps/mobile/src/features/${row.file}`;
  const source=readFileSync(new URL(row.file,import.meta.url),'utf8');
  const tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===row.component);
  if(!component||!ts.isFunctionDeclaration(component))throw new Error(row.component);
  let expression='';
  function visit(node:ts.Node){
    if(ts.isFunctionDeclaration(node)&&node.name?.text===row.handler) expression=node.getText(tree);
    if(ts.isVariableDeclaration(node)&&node.name.getText(tree)===row.handler&&node.initializer) expression=node.initializer.getText(tree);
    if(row.handler==='reportDone'&&ts.isJsxAttribute(node)&&node.name.getText(tree)==='onDone'&&node.initializer&&ts.isJsxExpression(node.initializer)&&node.initializer.expression) expression=node.initializer.expression.getText(tree);
    ts.forEachChild(node,visit);
  }
  visit(component);
  if(!expression)throw new Error(row.handler);
  return runInNewContext(ts.transpile(`(${expression})`,{target:ts.ScriptTarget.ES2022}),{
    checkBusinessContinuation,settleBusinessWrite,BUSINESS_SAVED_STALE,saveThenReload,...context,
  }) as (...args: unknown[])=>Promise<unknown>;
}
function assignmentCompletion(recordCaseUpdate:()=>Promise<unknown>):()=>Promise<unknown> {
  const path='apps/mobile/app/issue/[id].tsx';
  const source=readFileSync(new NodeURL('../../app/issue/[id].tsx',import.meta.url),'utf8');
  const tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let expression='';
  function visit(node:ts.Node){
    if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(tree)==='CaseStewardAssignment') {
      for(const attribute of node.attributes.properties) if(ts.isJsxAttribute(attribute)&&attribute.name.getText(tree)==='onSaved'&&attribute.initializer&&ts.isJsxExpression(attribute.initializer)&&attribute.initializer.expression)expression=attribute.initializer.expression.getText(tree);
    }
    ts.forEachChild(node,visit);
  }
  visit(tree);if(!expression)throw new Error('Assignment completion prop missing');
  return runInNewContext(ts.transpile(`(${expression})`,{target:ts.ScriptTarget.ES2022}),{recordCaseUpdate}) as ()=>Promise<unknown>;
}
let view:Rendered|null=null;
const releases=new Set<()=>void>();
function deferred(){let release=()=>{};const promise=new Promise<void>(resolve=>{release=resolve;});releases.add(release);return{promise,release};}
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});};
afterEach(async()=>{await act(async()=>{for(const release of releases)release();});releases.clear();await view?.unmount();view=null;setPlatform('ios');});

describe.each<'ios'|'android'>(['ios','android'])('all sixteen production controls on %s',platform=>{
  for(const row of rows)for(const boundary of row.proof?['proof','follow-up']:['follow-up']){
    it(`${row.component}.${row.handler} holds through ${boundary}`,async()=>{
      setPlatform(platform);const held=deferred();const entered=vi.fn();
      const write=vi.fn(async()=>({ok:true,value:{id:'saved'}}));
      const proof=async()=>{if(boundary==='proof'){entered();await held.promise;}return 'current';};
      const follow=async()=>{if(boundary==='follow-up'){entered();await held.promise;}return row.component==='StewardCaseNoteCard'?'shown':null;};
      const api=Object.fromEntries(['saveMessage','saveAddress','flagLocal','withdrawAddress','saveCampaign','saveRating','saveJurisdiction','saveLocalOfficial','resolveLocalFlag'].map(name=>[name,write]));
      const setters=Object.fromEntries('setError setSetting setStatus setMessage setAccepted setChoice setConfirmed setReload setOutcome setSavedNoteID setBody setUnconfirmed setAcceptedStep setAttempt setErrors setFailure setNotice setMessageId setForm setDecisionDate setAcceptedMutations'.split(' ').map(name=>[name,vi.fn()]));
      const requests=createRequestGeneration();const reads={current:0,requireProof:false};const pending={current:null};const rereadFor={current:{after:'moved',step:'next-step'}};
      const writing={current:false};const generation={current:0};const check={current:null};let pendingRun:Promise<unknown>|undefined;
      function Probe(){
        const idle=row.idle===null?null:false;
        const [busy,setBusy]=useBusinessState<unknown>(idle);
        const [operate,control]=useBusinessOperation<unknown>(setBusy,idle);
        const handler=production(row,{
          ...setters,busy,setBusy,setSettling:setBusy,operate,control,settleOperation:operate,writing,reads,pending,rereadFor,generation,check,
          deadlines: [], setLoadFailure: vi.fn(), setSteps: vi.fn(), setNextStep: vi.fn(),
          requests,writer:{check:proof},continuation:()=>true,nativeUi:{t:(text:string)=>text},t:(text:string)=>text,
          caseID:'case-a',org:{org_id:'org-a'},session:{},api,server:{requestTrackBill:write},
          onSaved:row.component==='CaseStewardAssignment'?assignmentCompletion(follow):follow,onChanged:follow,onDone:follow,onRefresh:follow,read:async()=>{},reread:async()=>{},showReread:()=>{},
          loadCaseDeadlines:follow,save:async()=>{await write();},load: row.component==='useSetting'?follow:{reload:follow},
          assignCaseSteward:write,addStewardCaseNote:async()=>{await write();return 'note-a';},advanceCaseStep:async()=>{await write();},
          setAcceptedDeadline:vi.fn(),confirmDestructive:async()=>true,Crypto:{randomUUID:()=> 'fixture-key'},
          // #9440 round 1: the case writes end at a deadline; the fixture's awaits are the seams here.
          withReadDeadline:(request:Promise<unknown>)=>request,queueAccessibilityAnnouncement:vi.fn(),...row.extra,
        });
        return h(Pressable,{accessibilityLabel:'Submit',accessibilityRole:'button',disabled:Boolean(busy),accessibilityState:{disabled:Boolean(busy)},onPress:()=>{pendingRun=handler(...row.args??[]);}},h(Text,null,'Submit'));
      }
      view=await render(h(Probe));await press(getExposed(view.container,'Submit'));await settle();
      expect(entered,`${row.component} must reach the real ${boundary} await`).toHaveBeenCalled();
      expect(getExposed(view.container,'Submit').getAttribute('aria-disabled')).toBe('true');
      const before=write.mock.calls.length;await press(getExposed(view.container,'Submit'));expect(write).toHaveBeenCalledTimes(before);
      await act(async()=>held.release());await pendingRun;await settle();
      expect(getExposed(view.container,'Submit').getAttribute('aria-disabled')).not.toBe('true');
    });
  }
});
