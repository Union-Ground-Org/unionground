import { stubSessionWriter } from '../apps/mobile/src/testing/stubSessionWriter';
vi.mock('react', async () => await import('react'));
import { forwardRef, useImperativeHandle } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { READ_DEADLINE_MS } from '../apps/mobile/src/lib/readDeadline';

// BUG-UG-NATIVE-DIRECT-THREAD-HIDES-OLDER-MESSAGES-20261109: the
// mounted native conversation screen with 201 fictional Tamarack exchanges.
// The newest read serves 200; earlier history is opened above them.
const mock = vi.hoisted(() => ({
 load: vi.fn(), earlier: vi.fn(), read: vi.fn(), refresh: vi.fn(), previewThread: vi.fn(), dashboard: {member:{chapterID:'north'}}, session: {user:{id:'marcus'}}, sampleHat: null, authorizedRoles: [],
 scroll: {props: null, scrollTo: vi.fn(), scrollToEnd: vi.fn()}, intervals: [], pinned: null,
}));
vi.mock('@expo/vector-icons', () => ({Ionicons:()=>null}));
vi.mock('expo-router', () => ({ Redirect:()=>null, useLocalSearchParams:()=>({id:'marcus-thread'}), useRouter:()=>({push:vi.fn()}) }));
vi.mock('react-native-safe-area-context', () => ({useSafeAreaInsets:()=>({top:0,bottom:0})}));
vi.mock('react-native', () => ({
 Animated:{Value:class {setValue(){} stopAnimation(){}},timing:()=>({start(){}}),sequence:()=>({start(){}}),View:({children})=><span>{children}</span>},
 ActionSheetIOS:{showActionSheetWithOptions:vi.fn()},
 AppState:{currentState:'active',addEventListener:()=>({remove(){}})}, Platform:{OS:'android'},
 Modal:({children,visible})=>visible ? <div>{children}</div> : null,
 StyleSheet:{create:value=>value,hairlineWidth:1},
 View:({children})=><div>{children}</div>, Text:({children})=><span>{children}</span>,
 KeyboardAvoidingView:({children})=><div>{children}</div>,
 ScrollView:forwardRef(function ScrollView(props, ref) {
  mock.scroll.props = props;
  useImperativeHandle(ref, () => ({scrollTo:mock.scroll.scrollTo, scrollToEnd:mock.scroll.scrollToEnd}));
  return <div>{props.children}</div>;
 }),
 TextInput:({value,onChangeText,accessibilityLabel})=><textarea aria-label={accessibilityLabel} value={value} onChange={(event)=>onChangeText(event.target.value)}/>,
 useWindowDimensions:()=>({width:390,height:844,scale:3,fontScale:1}),
 Pressable:({children,onPress,accessibilityLabel,disabled})=><button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>{children}</button>,
}));
vi.mock('react-native-svg', () => ({default:({children})=><svg>{children}</svg>,Path:()=>null,Circle:()=>null,Rect:()=>null,Line:()=>null,Polygon:()=>null}));
vi.mock('../apps/mobile/src/lib/reduceMotion', () => ({useReduceMotion:()=>false}));
vi.mock('../apps/mobile/src/components/NumberFlow', () => ({NumberFlow:({value})=><span>{value}</span>}));
vi.mock('../apps/mobile/src/components/PinnedHeader', () => ({PinnedHeaderScreen:({children})=><div>{children}</div>,usePinnedHeaderChrome:()=>mock.pinned,usePinnedHeaderScreenName:()=>null,useScreenNameAlreadySpoken:()=>({duplicate:false,hiddenProps:{}})}));
vi.mock('../apps/mobile/src/components/TopChrome', () => ({TopRamp:()=>null,FrostedCapsule:({children})=><div>{children}</div>}));
vi.mock('../apps/mobile/src/components/ui', () => ({
 Avatar:()=>null, Body:({children})=><span>{children}</span>, Screen:({children})=><div>{children}</div>, StateMessage:({title,action})=><div>{title}{action}</div>,
 Notice:({children})=><p role="alert">{children}</p>,
 Button:({label,onPress,busy})=><button aria-busy={busy ? 'true' : undefined} disabled={busy} onClick={onPress}>{label}</button>,
}));
vi.mock('../apps/mobile/src/services/supabase', () => ({captureSessionWriter: () => stubSessionWriter(() => ({rpc:vi.fn()})),
 getSupabaseClient:()=>({rpc:vi.fn()}), loadConversationThread:mock.load, loadEarlierConversationMessages:mock.earlier,
 reactToConversationMessage:vi.fn(), markConversationRead:mock.read, sendMemberMessage:vi.fn(), sendStewardReply:vi.fn(),
}));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({useApp:()=>({mode:'authenticated',session:mock.session,refresh:mock.refresh,previewThread:mock.previewThread,sampleHat:mock.sampleHat,authorizedRoles:mock.authorizedRoles,organizationID:'tamarack',dashboard:mock.dashboard})}));
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({useTheme:()=>({})}));
vi.mock('../apps/mobile/src/lib/screenReader', () => ({ useScreenReader: () => false, useScreenReaderKnownOff: () => true }));
vi.mock('../apps/mobile/src/services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('../apps/mobile/src/features/guideLayers/staffGuidesData', () => ({ finishStaffGuide: vi.fn(), liveStaffGuideHat: () => null }));
vi.mock('../apps/mobile/src/features/SavedPulseCharts', () => ({ LiveChartMessage: () => null }));
import ConversationScreen from '../apps/mobile/app/conversation/[id]';

// A loaded runner can miss the 1 s default for findBy and waitFor here.
configure({asyncUtilTimeout:5000});

const SAME = '2026-11-02T14:00:00.000Z';
function exchange(number) {
 const label = String(number).padStart(3, '0');
 return {
  id:`00000000-0000-4000-8000-000000000${label}`, conversationID:'marcus-thread',
  senderKind:number % 2 ? 'member' : 'steward', senderName:number % 2 ? 'Marcus Greene' : 'Dylan Steward',
  body:`Exchange ${label}`, readAt:null, reactions:[],
  createdAt:number <= 101 ? SAME : new Date(Date.parse(SAME) + (number - 101) * 60_000).toISOString(),
 };
}
const range = (from, to) => Array.from({length:to - from + 1}, (_, index) => exchange(from + index));
function thread(from, to, readerIsStaff = false) {
 return {
  conversation:{id:'marcus-thread',title:'Marcus Greene',initials:'MG',unreadCount:0,createdAt:SAME,updatedAt:SAME},
  messages:range(from, to), readerIsStaff, earlierCursor:{createdAt:exchange(from).createdAt,id:exchange(from).id},
 };
}
const shownBodies = () => screen.queryAllByText(/^Exchange \d{3}$/).map((node) => node.textContent);

beforeEach(() => {
 mock.session = {user:{id:'marcus'}};
 mock.sampleHat = null;
 mock.authorizedRoles = [];
 mock.load.mockReset().mockResolvedValue(thread(2, 201));
 mock.earlier.mockReset();
 mock.read.mockReset().mockResolvedValue(undefined);
 mock.scroll.scrollTo.mockReset();
 mock.scroll.scrollToEnd.mockReset();
 mock.intervals = [];
 mock.pinned = null;
});

it('opens the earliest exchange above the newest 200, keeps the reader in place and states the start', async () => {
 let finish;
 mock.earlier.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
 render(<ConversationScreen/>);
 const show = await screen.findByRole('button', {name:'Show earlier messages'});
 expect(shownBodies()).toHaveLength(200);
 expect(screen.queryByText('Exchange 001')).not.toBeInTheDocument();
 expect(screen.queryByText('This is the start of the conversation.')).not.toBeInTheDocument();
 act(() => { mock.scroll.props.onScroll({nativeEvent:{contentOffset:{y:40}}}); mock.scroll.props.onContentSizeChange(390, 18_000); });
 mock.scroll.scrollToEnd.mockClear();
 fireEvent.click(show);
 expect(screen.getByRole('button', {name:'Loading earlier messages'})).toHaveAttribute('aria-busy', 'true');
 expect(mock.earlier).toHaveBeenCalledWith('marcus', 'marcus-thread', {createdAt:SAME, id:exchange(2).id}, {staff:false});
 await act(async () => { finish({messages:[exchange(1)], earlierCursor:null}); });
 expect(shownBodies()).toEqual(range(1, 201).map((row) => row.body));
 expect(screen.getByText('This is the start of the conversation.')).toBeInTheDocument();
 expect(screen.getByText('1 earlier message shown above.')).toBeInTheDocument();
 act(() => { mock.scroll.props.onContentSizeChange(390, 18_090); });
 expect(mock.scroll.scrollTo).toHaveBeenLastCalledWith({y:130, animated:false});
 expect(mock.scroll.scrollToEnd).not.toHaveBeenCalled();
});

// The server stub answers by cursor, as the server does: the page before
// Exchange 401 at once, the page before Exchange 201 when the test says so.
// The history may read a page again at any time (a newest page asks for a
// re-read, and when that runs depends on when React flushes the effect), so a
// stub that answered in call order handed such a re-read the second page and
// it replaced the first (#8376).
function twoEarlierPages() {
 const pending = {finish:null};
 mock.earlier.mockImplementation((_user, _thread, before) => {
  if (before.id === exchange(401).id) return Promise.resolve({messages:range(201, 400), earlierCursor:{createdAt:exchange(201).createdAt, id:exchange(201).id}});
  if (before.id === exchange(201).id) return new Promise((resolve) => { pending.finish = resolve; });
  return Promise.reject(new Error(`no earlier page before ${before.id}`));
 });
 return pending;
}

it('keeps the reader in place on a second earlier page when the loading state lays out before it arrives', async () => {
 mock.load.mockResolvedValue(thread(401, 600));
 const pending = twoEarlierPages();
 const finish = (page) => pending.finish(page);
 render(<ConversationScreen/>);
 const show = await screen.findByRole('button', {name:'Show earlier messages'});
 act(() => { mock.scroll.props.onScroll({nativeEvent:{contentOffset:{y:40}}}); mock.scroll.props.onContentSizeChange(390, 18_000); });
 fireEvent.click(show);
 await waitFor(() => expect(shownBodies()).toHaveLength(400));
 act(() => { mock.scroll.props.onContentSizeChange(390, 36_000); });
 expect(mock.scroll.scrollTo).toHaveBeenLastCalledWith({y:18_040, animated:false});
 act(() => { mock.scroll.props.onScroll({nativeEvent:{contentOffset:{y:18_040}}}); });
 fireEvent.click(screen.getByRole('button', {name:'Show earlier messages'}));
 expect(screen.getByRole('button', {name:'Loading earlier messages'})).toHaveAttribute('aria-busy', 'true');
 // The loading state lays out first: "200 earlier messages shown above." goes.
 act(() => { mock.scroll.props.onContentSizeChange(390, 35_982); });
 expect(mock.scroll.scrollTo).toHaveBeenLastCalledWith({y:18_022, animated:false});
 await act(async () => { finish({messages:range(1, 200), earlierCursor:null}); });
 expect(shownBodies()).toEqual(range(1, 600).map((row) => row.body));
 mock.scroll.scrollToEnd.mockClear();
 act(() => { mock.scroll.props.onContentSizeChange(390, 53_982); });
 expect(mock.scroll.scrollTo).toHaveBeenLastCalledWith({y:36_022, animated:false});
 expect(mock.scroll.scrollToEnd).not.toHaveBeenCalled();
});

// Reconciles may reread the first earlier page any number of times. The
// initial newest-page effect can also ask for a reread after the first press.
// Each explicit reconcile must trigger another read and keep exactly the
// opened messages; total request count is not the number of history pages.
it('keeps both earlier pages when reconciles read the first one again before the second arrives', async () => {
 const interval = vi.spyOn(globalThis, 'setInterval');
 mock.load.mockResolvedValue(thread(401, 600));
 const pending = twoEarlierPages();
 render(<ConversationScreen/>);
 fireEvent.click(await screen.findByRole('button', {name:'Show earlier messages'}));
 await waitFor(() => expect(shownBodies()).toHaveLength(400));
 const timers = interval.mock.calls.filter(([, delay]) => delay === 30000).map(([callback]) => callback);
 interval.mockRestore();
 // The reconcile reads the same newest 200 as a new page, which asks the
 // history to read its earlier page again.
 const firstPageReads = () => mock.earlier.mock.calls.filter((call) => call[2].id === exchange(401).id).length;
 for (let refresh = 0; refresh < 2; refresh += 1) {
  const before = firstPageReads();
  mock.load.mockResolvedValue(thread(401, 600));
  await act(async () => { timers.forEach((callback) => callback()); });
  await waitFor(() => expect(firstPageReads()).toBeGreaterThan(before));
  expect(shownBodies()).toEqual(range(201, 600).map((row) => row.body));
 }
 fireEvent.click(screen.getByRole('button', {name:'Show earlier messages'}));
 await waitFor(() => expect(pending.finish).toBeTypeOf('function'));
 await act(async () => { pending.finish({messages:range(1, 200), earlierCursor:null}); });
 expect(shownBodies()).toEqual(range(1, 600).map((row) => row.body));
 expect(screen.getByText('This is the start of the conversation.')).toBeInTheDocument();
});

it('keeps the reader in place when the busy label wraps before the earlier page arrives', async () => {
 let finish;
 mock.earlier.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
 render(<ConversationScreen/>);
 const show = await screen.findByRole('button', {name:'Show earlier messages'});
 act(() => { mock.scroll.props.onScroll({nativeEvent:{contentOffset:{y:40}}}); mock.scroll.props.onContentSizeChange(390, 18_000); });
 fireEvent.click(show);
 expect(screen.getByRole('button', {name:'Loading earlier messages'})).toHaveAttribute('aria-busy', 'true');
 // At a large text size "Loading earlier messages" takes a second line.
 act(() => { mock.scroll.props.onContentSizeChange(390, 18_020); });
 expect(mock.scroll.scrollTo).toHaveBeenLastCalledWith({y:60, animated:false});
 await act(async () => { finish({messages:[exchange(1)], earlierCursor:null}); });
 expect(shownBodies()).toHaveLength(201);
 act(() => { mock.scroll.props.onContentSizeChange(390, 18_090); });
 expect(mock.scroll.scrollTo).toHaveBeenLastCalledWith({y:130, animated:false});
});

it('keeps loaded history when an earlier page fails and loads it on Try again', async () => {
 mock.earlier.mockRejectedValueOnce(new Error('Earlier messages did not load. Try again.'));
 render(<ConversationScreen/>);
 fireEvent.click(await screen.findByRole('button', {name:'Show earlier messages'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Earlier messages did not load. The messages shown stay here. Try again.');
 expect(shownBodies()).toHaveLength(200);
 mock.earlier.mockResolvedValueOnce({messages:[exchange(1)], earlierCursor:null});
 fireEvent.click(screen.getByRole('button', {name:'Try again'}));
 await waitFor(() => expect(shownBodies()).toHaveLength(201));
 expect(mock.earlier.mock.calls.map((call) => call[2])).toEqual([{createdAt:SAME, id:exchange(2).id}, {createdAt:SAME, id:exchange(2).id}]);
});

it('keeps opened history through an incoming-message refresh, with no gap or duplicate', async () => {
 const interval = vi.spyOn(globalThis, 'setInterval');
 // The server stub honors the cursor: each refresh re-reads the opened history.
 mock.earlier.mockImplementation(async (_user, _thread, before) => ({messages:range(1, 202).filter((row) => row.createdAt < before.createdAt || (row.createdAt === before.createdAt && row.id < before.id)).slice(-200), earlierCursor:null}));
 render(<ConversationScreen/>);
 fireEvent.click(await screen.findByRole('button', {name:'Show earlier messages'}));
 await waitFor(() => expect(shownBodies()).toHaveLength(201));
 // The prepend lays out once and keeps the reader in place.
 act(() => { mock.scroll.props.onContentSizeChange(390, 18_090); });
 mock.scroll.scrollToEnd.mockClear();
 // The screen's 30 s reconcile is one of several 30 s timers on screen.
 const timers = interval.mock.calls.filter(([, delay]) => delay === 30000).map(([callback]) => callback);
 interval.mockRestore();
 // Exchange 202 arrives; the newest 200 now start at Exchange 003.
 mock.load.mockResolvedValue(thread(3, 202));
 await act(async () => { timers.forEach((callback) => callback()); });
 expect(mock.load).toHaveBeenCalledTimes(2);
 await waitFor(() => expect(shownBodies()).toHaveLength(202));
 expect(shownBodies()).toEqual(range(1, 202).map((row) => row.body));
 act(() => { mock.scroll.props.onContentSizeChange(390, 19_000); });
 expect(mock.scroll.scrollToEnd).toHaveBeenCalled();
});

it('reads earlier history for a steward with the steward read and starts over for another account', async () => {
 mock.sampleHat = 'steward';
 mock.authorizedRoles = ['steward'];
 mock.session = {user:{id:'dylan'}};
 mock.load.mockResolvedValue(thread(2, 201, true));
 mock.earlier.mockResolvedValue({messages:[exchange(1)], earlierCursor:null});
 const view = render(<ConversationScreen/>);
 fireEvent.click(await screen.findByRole('button', {name:'Show earlier messages'}));
 await waitFor(() => expect(screen.getByText('Exchange 001')).toBeInTheDocument());
 expect(mock.load).toHaveBeenCalledWith('dylan', 'marcus-thread', {messageID:undefined, staff:true});
 expect(mock.earlier).toHaveBeenCalledWith('dylan', 'marcus-thread', {createdAt:SAME, id:exchange(2).id}, {staff:true});
 mock.sampleHat = null;
 mock.authorizedRoles = [];
 mock.session = {user:{id:'marcus'}};
 mock.load.mockResolvedValue(thread(2, 201));
 view.rerender(<ConversationScreen/>);
 await screen.findByRole('button', {name:'Show earlier messages'});
 expect(screen.queryByText('Exchange 001')).not.toBeInTheDocument();
 expect(mock.load).toHaveBeenLastCalledWith('marcus', 'marcus-thread', {messageID:undefined, staff:false});
});

// Same defect class as G6-7900-1 on #7900: when the server shows nothing in a
// conversation, no earlier page kept in memory may outlive it.
async function openEarlierThenReconcile(next) {
 const interval = vi.spyOn(globalThis, 'setInterval');
 mock.earlier.mockResolvedValue({messages:[exchange(1)], earlierCursor:null});
 const view = render(<ConversationScreen/>);
 fireEvent.click(await screen.findByRole('button', {name:'Show earlier messages'}));
 await waitFor(() => expect(shownBodies()).toHaveLength(201));
 const timers = interval.mock.calls.filter(([, delay]) => delay === 30000).map(([callback]) => callback);
 interval.mockRestore();
 mock.load.mockResolvedValue(next);
 await act(async () => { timers.forEach((callback) => callback()); });
 return {view, timers};
}

it('keeps no earlier page when a refresh returns an empty newest page', async () => {
 await openEarlierThenReconcile({...thread(2, 201), messages:[], earlierCursor:null});
 await waitFor(() => expect(shownBodies()).toEqual([]));
 expect(screen.queryByText('Exchange 001')).not.toBeInTheDocument();
});

it('keeps no earlier page when access to the thread is lost and later returns', async () => {
 const {timers} = await openEarlierThenReconcile(null);
 await waitFor(() => expect(screen.getByText('Conversation not available')).toBeInTheDocument());
 mock.load.mockResolvedValue(thread(2, 201));
 await act(async () => { timers.forEach((callback) => callback()); });
 await waitFor(() => expect(shownBodies()).toHaveLength(200));
 expect(screen.queryByText('Exchange 001')).not.toBeInTheDocument();
 expect(screen.getByRole('button', {name:'Show earlier messages'})).toBeInTheDocument();
});

it('keeps no earlier page across a hat change in the same account', async () => {
 mock.sampleHat = 'steward';
 mock.authorizedRoles = ['steward'];
 mock.load.mockResolvedValue(thread(2, 201, true));
 mock.earlier.mockResolvedValue({messages:[exchange(1)], earlierCursor:null});
 const view = render(<ConversationScreen/>);
 fireEvent.click(await screen.findByRole('button', {name:'Show earlier messages'}));
 await waitFor(() => expect(screen.getByText('Exchange 001')).toBeInTheDocument());
 mock.sampleHat = 'member';
 mock.authorizedRoles = [];
 mock.load.mockResolvedValue(thread(2, 201));
 view.rerender(<ConversationScreen/>);
 await screen.findByRole('button', {name:'Show earlier messages'});
 expect(screen.queryByText('Exchange 001')).not.toBeInTheDocument();
});

it('states the start of a short conversation with no earlier control', async () => {
 mock.load.mockResolvedValue({...thread(1, 12), earlierCursor:null});
 render(<ConversationScreen/>);
 expect(await screen.findByText('This is the start of the conversation.')).toBeInTheDocument();
 expect(screen.queryByRole('button', {name:'Show earlier messages'})).not.toBeInTheDocument();
 expect(mock.earlier).not.toHaveBeenCalled();
});

it('a steward can retry an unanswered conversation read and never sees its late reply', async () => {
 vi.useFakeTimers();
 let finish;
 mock.sampleHat = 'steward'; mock.authorizedRoles = ['steward'];
 mock.load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
 const view = render(<ConversationScreen/>);
 try {
  expect(screen.getByText('Loading conversation')).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
  expect(screen.queryByText('Loading conversation')).not.toBeInTheDocument();
  expect(screen.getByRole('button', {name:'Try again'})).toBeEnabled();
  await act(async () => finish({...thread(1, 1, true), messages:[{...exchange(1), body:'Expired conversation'}]}));
  expect(screen.queryByText('Expired conversation')).not.toBeInTheDocument();
  mock.load.mockResolvedValue({...thread(2, 2, true), earlierCursor:null});
  await act(async () => { fireEvent.click(screen.getByRole('button', {name:'Try again'})); });
  expect(screen.getByText('Exchange 002')).toBeInTheDocument();
  expect(mock.load).toHaveBeenLastCalledWith('marcus', 'marcus-thread', {messageID:undefined, staff:true});
 } finally { view.unmount(); vi.useRealTimers(); }
});

it('shows a loaded conversation while its read acknowledgement is unanswered', async () => {
 vi.useFakeTimers();
 mock.read.mockReturnValue(new Promise(() => {}));
 const reply = {...thread(2, 2), earlierCursor:null};
 reply.conversation.unreadCount = 1;
 mock.load.mockResolvedValue(reply);
 const view = render(<ConversationScreen/>);
 try {
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText('Exchange 002')).toBeInTheDocument();
  expect(screen.queryByText('Loading conversation')).not.toBeInTheDocument();
  expect(mock.read).toHaveBeenCalledTimes(1);
 } finally { view.unmount(); vi.useRealTimers(); }
});

// BUG-UG-NATIVE-CONVERSATION-REFRESH-FAILURE-HIDES-LOADED-MESSAGES-20261115
// (#8769): a refresh that reaches its read deadline no longer replaces the open
// conversation with Try again; it keeps the messages with a not-updated notice
// and the next refresh brings the thread up to date by itself.
it('keeps the open conversation with a not-updated notice when a refresh reaches its read deadline', async () => {
 vi.useFakeTimers();
 mock.load.mockResolvedValueOnce({...thread(2, 2), earlierCursor:null}).mockReturnValueOnce(new Promise(() => {}));
 const view = render(<ConversationScreen/>);
 try {
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText('Exchange 002')).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000 + READ_DEADLINE_MS); });
  expect(screen.getByText('Exchange 002')).toBeInTheDocument();
  expect(screen.getByText(/^Not updated\./)).toBeInTheDocument();
  expect(screen.queryByRole('button', {name:'Try again'})).toBeNull();
  mock.load.mockResolvedValue({...thread(3, 3), earlierCursor:null});
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000 - READ_DEADLINE_MS); });
  expect(screen.getByText('Exchange 003')).toBeInTheDocument();
  expect(screen.queryByText(/^Not updated\./)).toBeNull();
 } finally { view.unmount(); vi.useRealTimers(); }
});

// UX-UG-NATIVE-TITLE-BESIDE-BACK-CONTROL-20261115: the thread's own
// scroll view starts its content below the title row beside Back.
// UX-UG-NATIVE-SHARED-CHROME-EDGE-BANDS-20261118: the row no longer
// draws a hairline once messages pass under it, so the scroll view no longer
// reports its offset to the row.
it('starts below the title row and does not report its scroll offset to it', async () => {
 mock.pinned = {contentInset:126};
 render(<ConversationScreen/>);
 await screen.findByRole('button', {name:'Show earlier messages'});
 expect(mock.scroll.props.contentContainerStyle).toEqual(expect.arrayContaining([expect.objectContaining({paddingTop:126})]));
 expect(() => act(() => { mock.scroll.props.onScroll({nativeEvent:{contentOffset:{y:40}}}); })).not.toThrow();
});
