// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { notificationPreferencesCopy, notificationPreferencesFromRow } from '../lib/notificationPreferences';
import palette from '../theme/palette.json';

const port=vi.hoisted(()=>({user:'A',chapter:'chapter-a',pendingRead:null as Promise<void>|null,pendingSave:null as Promise<void>|null,reads:0,auth:null as Promise<void>|null}));
function app(){return {mode:'authenticated',session:{user:{id:port.user},access_token:'fixture-'+port.user},organizationID:'org',dashboard:{member:{id:port.user,chapterID:port.chapter,language:'en'}},chapterMemberships:[{chapterID:port.chapter,selected:true}],authorizedRoles:['admin'],chosenStaffRole:null,sessionRestricted:false,memberLanguage:'en',resumeDraftReads:{dashboard:true,memberships:true,staff:true}};}
const details=(phone:string)=>({pronouns:null,jobTitle:null,worksite:null,phone,detailsVisibility:'only_me',phoneVisibility:'only_me'});
vi.mock('react-native',()=>import('../testing/reactNativeStandIn'));
vi.mock('../components/ui',()=>import('../testing/uiStandIn'));
vi.mock('../state/AppProvider',()=>({useApp:app}));
vi.mock('../theme/ThemeProvider',()=>({useTheme:()=>palette['union-ground']}));
vi.mock('../services/supabase',()=>({
 captureSessionWriter:(session:{user:{id:string}})=>({...stubSessionWriter(()=>({}),session.user.id),check:async():Promise<'current'>=>{if(port.auth)await port.auth;return 'current';}}),
 loadMemberNotificationPreferences:async()=>{port.reads++;if(port.pendingRead)await port.pendingRead;return notificationPreferencesFromRow({dnd_enabled:false});},
 saveMemberNotificationPreferences:async()=>{if(port.pendingSave)await port.pendingSave;return notificationPreferencesFromRow({dnd_enabled:true});},
}));
vi.mock('../services/profileDetails',()=>({
 PROFILE_PHONE_MIN_LENGTH:7,PROFILE_PHONE_MAX_LENGTH:40,
 ProfileDetailsError:class extends Error{},
 loadMyProfileDetails:async()=>{port.reads++;const phone=port.pendingRead?'555 0200':'555 0100';if(port.pendingRead)await port.pendingRead;return details(phone);},
 saveMyProfilePhone:async()=>{if(port.pendingSave)await port.pendingSave;return details('555 0100');},
}));
vi.mock('./guideLayers/staffGuidesData',()=>({finishStaffGuide:vi.fn(),liveStaffGuideHat:()=>null}));
import { NotificationPreferencesCard } from './NotificationPreferencesCard';
import { ProfilePhoneCard } from './ProfilePhoneCard';

let view:Rendered|null=null;
const releases=new Set<()=>void>();
function held(){let release=()=>{};const promise=new Promise<void>(resolve=>{release=resolve;});releases.add(release);return {promise,release};}
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});};
beforeEach(()=>Object.assign(port,{user:'A',chapter:'chapter-a',pendingRead:null,pendingSave:null,reads:0,auth:null}));
afterEach(async()=>{await act(async()=>{for(const release of releases)release();});releases.clear();await view?.unmount();view=null;setPlatform('ios');});
describe.each(['ios','android'] as const)('retired save versus current read on %s',platform=>{
 it('does not start a retired phone Refresh after its Auth wait',async()=>{
  setPlatform(platform);view=await render(h(ProfilePhoneCard));await settle();
  const auth=held();port.auth=auth.promise;await press(getExposed(view.container,'Refresh'));await settle();
  const read=held();port.pendingRead=read.promise;port.chapter='chapter-b';
  await view.rerender(h(ProfilePhoneCard));await settle();const currentReads=port.reads;
  await act(async()=>auth.release());await settle();expect(port.reads).toBe(currentReads);
  await act(async()=>read.release());await settle();
  expect(view.container.querySelector<HTMLInputElement>('input[aria-label="Phone number"]')?.value).toBe('555 0200');
 });
 it.each([['preferences','account'],['preferences','chapter'],['phone','account'],['phone','chapter']] as const)('%s keeps the newer %s load',async (card,change)=>{
   setPlatform(platform);Object.assign(port,{user:'A',chapter:'chapter-a',pendingRead:null,pendingSave:null});
   const element=h(card==='phone'?ProfilePhoneCard:NotificationPreferencesCard);
   view=await render(element);await settle();
   const save=held();port.pendingSave=save.promise;
   await press(getExposed(view.container,card==='phone'?'Save phone number':notificationPreferencesCopy.en.dnd));await settle();
   const read=held();port.pendingRead=read.promise;
   if(change==='account')port.user='B';else port.chapter='chapter-b';
   const priorReads=port.reads;await view.rerender(h(card==='phone'?ProfilePhoneCard:NotificationPreferencesCard));await settle();expect(port.reads).toBeGreaterThan(priorReads);
   await act(async()=>save.release());await settle();
   await act(async()=>read.release());await settle();
   if(card==='phone')expect(view.container.querySelector<HTMLInputElement>('input[aria-label="Phone number"]')?.value).toBe('555 0200');
   else expect(getExposed(view.container,notificationPreferencesCopy.en.dnd).getAttribute('aria-checked')).toBe('false');
   await view.unmount();view=null;
 });
});
