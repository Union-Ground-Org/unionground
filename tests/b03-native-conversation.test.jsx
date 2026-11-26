import { stubSessionWriter } from '../apps/mobile/src/testing/stubSessionWriter';
vi.mock('react', async () => await import('react'));
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ load: vi.fn(), react: vi.fn(), refresh: vi.fn(), previewThread: vi.fn(), appState: new Set(), session: {user:{id:'me'}}, sheet: vi.fn(), rpc: vi.fn(), diagnostic: null, dropCompose: false, hideCancel: false }));
vi.mock('@expo/vector-icons', () => ({Ionicons:()=>null}));
vi.mock('expo-router', () => ({ Redirect:()=>null, useLocalSearchParams:()=>({id:'c1'}), useRouter:()=>({push:vi.fn()}) }));
vi.mock('react-native-safe-area-context', () => ({useSafeAreaInsets:()=>({top:0,bottom:0})}));
vi.mock('react-native', () => ({
 Animated:{Value:class {setValue(){} stopAnimation(){}},timing:()=>({start(){}}),sequence:()=>({start(){}}),View:({children})=><span>{children}</span>},
 ActionSheetIOS:{showActionSheetWithOptions:mock.sheet},
 AppState:{currentState:'active',addEventListener:(_event, listener)=>{mock.appState.add(listener);return {remove(){mock.appState.delete(listener);}}}}, Platform:{OS:'ios'},
 StyleSheet:{create:value=>value,hairlineWidth:1},
 View:({children})=><div>{children}</div>, Text:({children})=><span>{children}</span>,
 KeyboardAvoidingView:({children})=><div>{children}</div>, ScrollView:({children})=><div>{children}</div>,
 TextInput:({value,onChangeText,accessibilityLabel,placeholder})=><textarea aria-label={accessibilityLabel} placeholder={placeholder} value={value} onChange={(event)=>onChangeText(event.target.value)}/>,
 useWindowDimensions:()=>({width:390,height:844,scale:3,fontScale:1}),
 Pressable:({children,onPress,accessibilityLabel,disabled})=><button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>{children}</button>,
}));
vi.mock('react-native-svg', () => ({
 default:({children,viewBox})=><svg viewBox={viewBox}>{children}</svg>,
 Path:props=><path {...props}/>,Circle:props=><circle {...props}/>,Rect:props=><rect {...props}/>,
 Line:props=><line {...props}/>,Polygon:props=><polygon {...props}/>,
}));
vi.mock('../apps/mobile/src/lib/reduceMotion', () => ({useReduceMotion:()=>false}));
vi.mock('../apps/mobile/src/components/NumberFlow', () => ({NumberFlow:({value})=><span>{value}</span>}));
vi.mock('../apps/mobile/src/components/PinnedHeader', () => ({PinnedHeaderScreen:({children})=><div>{children}</div>,usePinnedHeaderChrome:()=>null,usePinnedHeaderScreenName:()=>null,useScreenNameAlreadySpoken:()=>({duplicate:false,hiddenProps:{accessibilityElementsHidden:false,importantForAccessibility:'auto'}})}));
// TopChrome is the one module that imports the native blur, gradient and
// mask boundaries, which the root resolver leaves unresolved on purpose.
vi.mock('../apps/mobile/src/components/TopChrome', () => ({TopRamp:()=>null,FrostedCapsule:({children})=><div>{children}</div>}));
vi.mock('../apps/mobile/src/components/ui', () => ({Avatar:()=>null,Body:({children})=><span>{children}</span>,Button:({label,onPress})=>{
 if (label === mock.diagnostic?.cancelLabel) {
  // ConversationScreen derives this prop from composeAction. This observes
  // state reaching render, separately from the control reaching the DOM.
  mock.diagnostic.record('compose-state-rendered', {label});
  if (mock.hideCancel) return null;
 }
 return <button onClick={onPress}>{label}</button>;
},Screen:({children})=><div>{children}</div>,StateMessage:({title})=><p>{title}</p>}));
vi.mock('../apps/mobile/src/components/NativeMessageActions', async (importOriginal) => {
 const actual = await importOriginal();
 return {...actual, NativeMessageActions: ({onCompose, ...props}) => <actual.NativeMessageActions {...props} onCompose={(kind) => {
  mock.diagnostic?.record('compose-callback', {kind, messageID:props.messageID});
  if (!mock.dropCompose) onCompose(kind);
 }}/>};
});
// The step-up prompt asks nativeAuth whether Auth has passkeys on (#8546).
// nativeAuth loads the native auth SDKs (expo-apple-authentication through
// expo-modules-core), which do not run in this root harness.
vi.mock('../apps/mobile/src/services/nativeAuth', () => ({ nativePasskeysEnabled: async () => false }));
vi.mock('../apps/mobile/src/services/supabase', () => ({captureSessionWriter: () => stubSessionWriter(() => ({rpc:mock.rpc})),getSupabaseClient:()=>({rpc:mock.rpc}),loadConversationThread:mock.load,reactToConversationMessage:mock.react,markConversationRead:vi.fn(),sendMemberMessage:vi.fn()}));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({useApp:()=>({mode:'authenticated',session:mock.session,refresh:mock.refresh,previewThread:mock.previewThread})}));
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({useTheme:()=>({})}));
vi.mock('../apps/mobile/src/lib/screenReader', () => ({ useScreenReader: () => false, useScreenReaderKnownOff: () => true }));
vi.mock('../apps/mobile/src/services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029: the staff guide finisher (and its expo-crypto key) stays out of a member conversation.
vi.mock('../apps/mobile/src/features/guideLayers/staffGuidesData', () => ({ finishStaffGuide: vi.fn(), liveStaffGuideHat: () => null }));
// The root conversation suite has no Expo file/sharing SDK installation.
// Chart references and their viewer scope are exercised by the mobile suite;
// keep that native boundary out of these ordinary-message/reaction checks.
vi.mock('../apps/mobile/src/features/SavedPulseCharts', () => ({ LiveChartMessage: () => null }));
import ConversationScreen from '../apps/mobile/app/conversation/[id]';
import { MESSAGE_REACTION_CHOICES, messageReactionLabel } from '../src/features/messaging/index.js';

beforeEach(() => {
 mock.diagnostic = null;
 mock.dropCompose = false;
 mock.hideCancel = false;
});

// TEST-UG-NATIVE-CONVERSATION-EDIT-DRAFT-CI-FOLLOWUP-20260909:
// Retain the actual boundaries without interpreting an absent control as a
// scheduling cause. The original 1000 ms lookup and 10000 ms test budgets stay.
function composeTimeline(kind, {chooseSheet = true} = {}) {
 const origin = performance.now();
 const events = [];
 const cancelLabel = kind === 'edit' ? 'Cancel editing' : 'Cancel reply';
 const at = () => Math.round((performance.now() - origin) * 10) / 10;
 const record = (event, detail = {}) => events.push({event, at:at(), ...detail});
 const has = (event) => events.some((entry) => entry.event === event);
 const snapshot = () => {
  const choice = events.find((entry) => entry.event === 'sheet-choice');
  const boundary = !has('sheet-opened') ? 'sheet-not-invoked'
   : !choice ? 'sheet-choice-not-invoked'
   : choice.index < 0 ? 'sheet-choice-unavailable'
   : !has('compose-callback') ? 'compose-callback-not-invoked'
   : !has('compose-state-rendered') ? `${kind}-state-not-rendered`
   : !has('cancel-control-found') ? `${kind}-state-rendered-control-not-found`
   : 'cancel-control-found';
  return {kind, boundary, now:at(), events:events.map((entry) => ({...entry}))};
 };
 const sheet = (options, choose) => {
  record('sheet-opened', {options:[...options.options], cancelButtonIndex:options.cancelButtonIndex});
  if (!chooseSheet) return;
  const index = options.options.indexOf(kind === 'edit' ? 'Edit message' : 'Reply');
  record('sheet-choice', {index, label:options.options[index] ?? null});
  choose(index);
 };
 const findCancel = async () => {
  record('cancel-lookup-started');
  try {
   const control = await screen.findByRole('button', {name:cancelLabel});
   record('cancel-control-found');
   return control;
  } catch (cause) {
   record('cancel-lookup-failed');
   const diagnosis = snapshot();
   const error = new Error(`${cause.message}\n\nNative compose diagnostics: ${JSON.stringify(diagnosis)}`, {cause});
   error.composeDiagnosis = diagnosis;
   throw error;
  }
 };
 return {cancelLabel, record, snapshot, sheet, findCancel};
}

it('direct screen offers all six recovered choices on an empty message and reconciles denial', async () => {
 const thread={conversation:{id:'c1',title:'Conversation',unreadCount:0,updatedAt:'2026-09-01'},messages:[{id:'m1',senderKind:'member',senderName:'Member',body:'Hello',createdAt:'2026-09-01',reactions:[]}]};
 mock.load.mockResolvedValue(thread);
 mock.react.mockResolvedValue({thread:null,failed:true});
 render(<ConversationScreen/>);
 fireEvent.click(await screen.findByRole('button',{name:'Add reaction'}));
 for(const {kind} of MESSAGE_REACTION_CHOICES) expect(screen.getByRole('button',{name:messageReactionLabel(kind)})).toBeEnabled();
 expect(screen.queryByRole('button',{name:'Like'})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Solidarity'}));
 await waitFor(()=>expect(mock.react).toHaveBeenCalledWith(expect.any(Object),'me','c1','m1','solidarity',{messageID:undefined,staff:false}));
 expect(await screen.findByText('Conversation not available')).toBeInTheDocument();
 expect(screen.queryByText('Hello')).not.toBeInTheDocument();
});

it.each(['foreground', 'timer'])('%s refresh during a reaction releases controls without applying stale data', async (refreshKind) => {
 const thread = {conversation:{id:'c1',title:'Conversation',unreadCount:0,updatedAt:'2026-09-01'},messages:[{id:'m1',senderKind:'member',senderName:'Member',body:'Before refresh',createdAt:'2026-09-01',reactions:[]}]};
 mock.load.mockResolvedValue(thread);
 let finish;
 mock.react.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 const interval = vi.spyOn(globalThis, 'setInterval');
 render(<ConversationScreen/>);
 const timerRefresh = interval.mock.calls.filter(([, delay]) => delay === 30000).at(-1)[0];
 interval.mockRestore();
 fireEvent.click(await screen.findByRole('button', {name:'Add reaction'}));
 fireEvent.click(screen.getByRole('button', {name:'Care'}));
 expect(screen.getByRole('button', {name:'Add reaction'})).toBeDisabled();
 mock.load.mockResolvedValue({...thread, messages:[{...thread.messages[0], body:'Authoritative refresh'}]});
 await act(async () => refreshKind === 'timer' ? timerRefresh() : mock.appState.forEach(listener => listener('active')));
 await act(async () => finish({thread, failed:false}));
 expect(screen.getByRole('button', {name:'Add reaction'})).toBeEnabled();
 expect(screen.getByText('Authoritative refresh')).toBeInTheDocument();
 expect(screen.queryByText('Before refresh')).not.toBeInTheDocument();
});

it.each(['reply', 'edit'])('native %s draft survives a same-message foreground snapshot and cancels deliberately', async (kind) => {
 const thread = {conversation:{id:'c1',title:'Conversation',unreadCount:0,updatedAt:'2026-09-01'},messages:[{id:'m1',senderKind:'member',senderName:'Member',body:'Original',createdAt:'2026-09-01',reactions:[]}]};
 mock.load.mockResolvedValue(thread);
 mock.rpc.mockResolvedValue({data:{canEdit:true,saved:false,reminders:[],reactions:[]},error:null});
 const diagnostic = mock.diagnostic = composeTimeline(kind);
 mock.sheet.mockImplementation(diagnostic.sheet);
 render(<ConversationScreen/>);
 fireEvent.click(await screen.findByRole('button', {name:'Open message actions'}));
 await diagnostic.findCancel();
 expect(diagnostic.snapshot()).toMatchObject({boundary:'cancel-control-found', events:expect.arrayContaining([
  expect.objectContaining({event:'sheet-choice', label:kind === 'edit' ? 'Edit message' : 'Reply'}),
  expect.objectContaining({event:'compose-callback', kind, messageID:'m1'}),
  expect.objectContaining({event:'compose-state-rendered', label:diagnostic.cancelLabel}),
 ])});
 fireEvent.change(screen.getByPlaceholderText('Conversation reply'), {target:{value:'Unsent native draft'}});
 mock.load.mockResolvedValue({...thread,messages:thread.messages.map(message=>({...message,reactions:[]}))});
 await act(async () => mock.appState.forEach(listener=>listener('active')));
 expect(screen.getByPlaceholderText('Conversation reply')).toHaveValue('Unsent native draft');
 fireEvent.click(screen.getByRole('button', {name:kind === 'edit' ? 'Cancel editing' : 'Cancel reply'}));
 expect(screen.getByPlaceholderText('Conversation reply')).toHaveValue('');
});

it.each([
 ['sheet-not-invoked', 'no-sheet'],
 ['sheet-choice-not-invoked', 'no-choice'],
 ['sheet-choice-unavailable', 'edit-unavailable'],
 ['compose-callback-not-invoked', 'ignore-choice'],
 ['edit-state-not-rendered', 'drop-compose'],
 ['edit-state-rendered-control-not-found', 'hide-control'],
])('native edit diagnostics identify %s using the real action path', async (boundary, fault) => {
 const thread = {conversation:{id:'c1',title:'Conversation',unreadCount:0,updatedAt:'2026-09-01'},messages:[{id:'m1',senderKind:'member',senderName:'Member',body:'Original',createdAt:'2026-09-01',reactions:[]}]};
 mock.load.mockResolvedValue(thread);
 mock.rpc.mockResolvedValue(fault === 'no-sheet'
  ? {data:null,error:{message:'deterministic denied state'}}
  : {data:{canEdit:fault !== 'edit-unavailable',saved:false,reminders:[],reactions:[]},error:null});
 const diagnostic = mock.diagnostic = composeTimeline('edit', {chooseSheet:fault !== 'no-choice'});
 mock.sheet.mockImplementation((options, choose) => diagnostic.sheet(options, fault === 'ignore-choice' ? () => {} : choose));
 mock.dropCompose = fault === 'drop-compose';
 mock.hideCancel = fault === 'hide-control';
 // Settle this synthetic fixture's initial load before injecting its one fault.
 // The original reply/edit reproduction above deliberately keeps its own mount.
 await act(async () => { render(<ConversationScreen/>); });
 fireEvent.click(await screen.findByRole('button', {name:'Open message actions'}));
 const failure = await diagnostic.findCancel().catch(error => error);
 expect(failure).toBeInstanceOf(Error);
 expect(failure.cause.name).toBe('TestingLibraryElementError');
 expect(failure.message).toContain('Unable to find role="button" and name "Cancel editing"');
 expect(failure.message).toContain('Native compose diagnostics:');
 expect(failure.composeDiagnosis.boundary, failure.message).toBe(boundary);
 expect(screen.queryByRole('button', {name:'Cancel editing'})).not.toBeInTheDocument();
 if (fault === 'no-choice') {
  expect(failure.composeDiagnosis.events).toContainEqual(expect.objectContaining({event:'sheet-opened', options:expect.arrayContaining(['Edit message'])}));
 }
 if (fault === 'drop-compose' || fault === 'hide-control') {
  expect(failure.composeDiagnosis.events).toContainEqual(expect.objectContaining({event:'compose-callback', kind:'edit', messageID:'m1'}));
  expect(screen.getByPlaceholderText('Conversation reply')).toHaveValue(fault === 'hide-control' ? 'Original' : '');
 }
});

it('a rejected reaction releases controls and permits retry', async () => {
 const thread = {conversation:{id:'c1',title:'Conversation',unreadCount:0,updatedAt:'2026-09-01'},messages:[{id:'m1',senderKind:'member',senderName:'Member',body:'Original',createdAt:'2026-09-01',reactions:[]}]};
 mock.load.mockResolvedValue(thread);
 mock.react.mockRejectedValueOnce(new Error('offline'));
 render(<ConversationScreen/>);
 fireEvent.click(await screen.findByRole('button', {name:'Add reaction'}));
 fireEvent.click(screen.getByRole('button', {name:'Care'}));
 await screen.findByText('Reaction not confirmed. Conversation refreshed.');
 expect(screen.getByRole('button', {name:'Add reaction'})).toBeEnabled();
});

it('hides incoming sender metadata so VoiceOver names each row once', () => {
 const conversation = readFileSync(resolve(process.cwd(), 'apps/mobile/app/conversation/[id].tsx'), 'utf8');
 expect(conversation).toContain('const rowName = `${message.senderName}: ${bodyText}`;');
 expect(conversation).toContain('accessibilityLabel={rowName}');
 expect(conversation).toMatch(
  /!mine && !sameSender \? \(\s*<View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">\s*<Avatar initials=\{initialsFor\(message\.senderName\)\}/,
 );
 expect(conversation).toContain('style={styles.senderRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"');
});

it('foreground refresh replaces delivered text with the confirmed tombstone', async () => {
 const body = 'Native lifecycle verification content';
 const thread = {conversation:{id:'c1',title:'Conversation',unreadCount:0,updatedAt:'2026-09-01'},messages:[{id:'m1',senderKind:'member',senderName:'Member',body,createdAt:'2026-09-01',reactions:[]}]};
 mock.load.mockResolvedValue(thread);
 render(<ConversationScreen/>);
 expect(await screen.findByText(body)).toBeInTheDocument();
 mock.load.mockResolvedValue({...thread,messages:[{...thread.messages[0],body:'',redactedAt:'2026-09-07T12:00:00Z',redactionReason:'sender_removed'}]});
 await act(async () => mock.appState.forEach((listener) => listener('active')));
 expect(screen.queryByText(body)).not.toBeInTheDocument();
 expect(screen.getByText('The sender removed this message.')).toBeInTheDocument();
});
