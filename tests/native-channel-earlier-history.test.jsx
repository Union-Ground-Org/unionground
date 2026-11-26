import { stubSessionWriter } from '../apps/mobile/src/testing/stubSessionWriter';
vi.mock('react', async () => await import('react'));
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

// BUG-UG-NATIVE-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: the
// mounted native channel screen for a thread whose newest window was full.
// Earlier posts open above the window, page by page, with fictional Tamarack
// posts only.
const mock = vi.hoisted(() => ({
 session: {user:{id:'member-a'}}, channels: [], cursors: new Map(), earlier: vi.fn(), mode: 'authenticated', version: 0,
 screen: {props: null, scrollTo: vi.fn(), scrollToEnd: vi.fn()},
}));
vi.mock('@expo/vector-icons', () => ({Ionicons:()=>null}));
vi.mock('expo-router', () => ({ Redirect:()=>null, useLocalSearchParams:()=>({id:'thread-quiet'}), useRouter:()=>({push:vi.fn()}) }));
vi.mock('react-native', () => {
 const Host = ({children, accessibilityLabel}) => <div aria-label={accessibilityLabel}>{children}</div>;
 return {
  AppState:{currentState:'active',addEventListener:()=>({remove(){}})}, Platform:{OS:'android'},
  View:Host, ScrollView:Host, Pressable:({children,onPress,accessibilityLabel,disabled})=><button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>{children}</button>,
  Text:({children})=><span>{children}</span>,
  TextInput:({accessibilityLabel})=><textarea aria-label={accessibilityLabel}/>,
  StyleSheet:{create:(value)=>value,hairlineWidth:1},
  useWindowDimensions:()=>({width:390,height:844,scale:3,fontScale:1}),
 };
});
vi.mock('../apps/mobile/src/features/SavedPulseCharts', () => ({LiveChartMessage:()=>null}));
vi.mock('../apps/mobile/src/components/PinnedHeader', () => ({PinnedHeaderScreen:({children})=><div>{children}</div>,useScreenNameAlreadySpoken:()=>({duplicate:false,hiddenProps:{}})}));
vi.mock('../apps/mobile/src/components/ui', () => {
 const Host = ({children}) => <div>{children}</div>;
 return {
  Avatar:()=>null, Body:Host, StateMessage:({title})=><p>{title}</p>,
  Notice:({children})=><p role="alert">{children}</p>,
  Button:({label,onPress,busy})=><button aria-busy={busy ? 'true' : undefined} disabled={busy} onClick={onPress}>{label}</button>,
  Screen:(props) => {
   mock.screen.props = props;
   if (props.scrollRef) props.scrollRef.current = {scrollTo:mock.screen.scrollTo, scrollToEnd:mock.screen.scrollToEnd};
   return <div>{props.children}</div>;
  },
 };
});
vi.mock('../apps/mobile/src/components/WorkflowActions', () => ({WorkflowMessageActions:({children,accessibilityLabel})=><article aria-label={accessibilityLabel}>{children}</article>}));
vi.mock('../apps/mobile/src/components/MessageReactions', () => ({AddReactionChip:()=>null,MessageReactionButton:()=>null,MessageReactionPicker:()=>null}));
vi.mock('../apps/mobile/src/components/NativeMessageActions', () => ({NativeMessageActions:()=>null}));
vi.mock('../apps/mobile/src/components/ChannelPollCard', () => ({ChannelPollCard:()=>null}));
vi.mock('../apps/mobile/src/components/MessageReplies', () => ({MessageReplies:()=>null,ParentMessageControl:()=>null,ReplyCountControl:()=>null,useMessageReplyCounts:()=>({})}));
vi.mock('../apps/mobile/src/components/ChannelControls', () => ({
 CHANNEL_BODY_LINE_HEIGHT:21, ChannelHighlightedBody:({body})=><p>{body}</p>, ChannelSettingsPanel:()=>null, MentionPickerPanel:()=>null, channelHasAnyControl:()=>false,
}));
vi.mock('../apps/mobile/src/data/channelControls', () => ({channelControlsApi:{}, useChannelControls:()=>({controls:{switches:{}},live:false,applySetting:vi.fn()})}));
vi.mock('../apps/mobile/src/lib/announce', () => ({announceForAccessibility:vi.fn()}));
vi.mock('../apps/mobile/src/services/supabase', () => ({captureSessionWriter: () => stubSessionWriter(() => (null)),getSupabaseClient:()=>null}));
vi.mock('../apps/mobile/src/services/haptics', () => ({haptics:{impact:vi.fn(),select:vi.fn()}}));
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({useTheme:()=>({})}));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({useApp:()=>({mode:mock.mode,session:mock.session,dashboard:null,previewHat:null,authorizedRoles:[],organizationID:'tamarack'})}));
vi.mock('../apps/mobile/src/data/liveChannels', async (original) => {
 const actual = await original();
 const live = {
  ...actual.liveChannelStore,
  acquire:()=>undefined, release:()=>undefined,
  channels:()=>mock.channels, channel:(id)=>mock.channels.find((row)=>row.id===id) ?? null,
  getVersion:()=>mock.version, subscribe:()=>()=>undefined,
  status:()=>'ready', error:()=>null, loadFault:()=>null, poll:()=>null, markRead:()=>undefined,
  actionDiagnosis:()=>null, markReadFault:()=>null,
  earlierCursor:(id)=>mock.cursors.get(id) ?? null,
  earlierPosts:mock.earlier,
 };
 return {...actual, liveChannelStore:live};
});
import ChannelScreen from '../apps/mobile/app/channel/[id]';

configure({asyncUtilTimeout:5000});

const BASE = Date.parse('2026-09-01T15:00:00.000Z');
function post(number) {
 const label = String(number).padStart(4, '0');
 return {id:`post-${label}`, author:'Member B', initials:'MB', time:'', body:`Tamarack post ${label}`, createdAt:new Date(BASE + number * 60_000).toISOString()};
}
const range = (from, to) => Array.from({length:to - from + 1}, (_, index) => post(from + index));
const shownBodies = () => screen.queryAllByText(/^Tamarack post \d{4}$/).map((node) => node.textContent);
function thread(messages) {
 return {id:'thread-quiet', spaceID:'space-1', name:'quiet', topic:'general', unread:0, messages};
}

beforeEach(() => {
 mock.mode = 'authenticated';
 mock.version += 1;
 mock.channels = [thread(range(401, 403))];
 mock.cursors = new Map([['thread-quiet', {createdAt:post(401).createdAt, id:post(401).id}]]);
 mock.earlier.mockReset();
 mock.screen.scrollTo.mockReset();
 mock.screen.scrollToEnd.mockReset();
});

it('opens earlier posts above a full window, oldest first, keeps the reader in place and states the start', async () => {
 let finish;
 mock.earlier.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
 render(<ChannelScreen/>);
 const show = await screen.findByRole('button', {name:'Show earlier messages'});
 expect(shownBodies()).toEqual(['Tamarack post 0401', 'Tamarack post 0402', 'Tamarack post 0403']);
 act(() => { mock.screen.props.onScrollOffset(40); mock.screen.props.onContentHeight(2_000); });
 fireEvent.click(show);
 expect(screen.getByRole('button', {name:'Loading earlier messages'})).toHaveAttribute('aria-busy', 'true');
 expect(mock.earlier).toHaveBeenCalledWith('thread-quiet', {createdAt:post(401).createdAt, id:post(401).id});
 // The loading layout first, then the page.
 act(() => { mock.screen.props.onContentHeight(1_982); });
 expect(mock.screen.scrollTo).toHaveBeenLastCalledWith({y:22, animated:false});
 await act(async () => { finish({messages:range(1, 400), earlierCursor:null}); });
 expect(shownBodies()).toEqual(range(1, 403).map((row) => row.body));
 expect(screen.getByText('This is the start of this channel.')).toBeInTheDocument();
 expect(screen.getByText('400 earlier messages shown above.')).toBeInTheDocument();
 act(() => { mock.screen.props.onContentHeight(41_982); });
 expect(mock.screen.scrollTo).toHaveBeenLastCalledWith({y:40_022, animated:false});
});

it('offers the earlier posts of a thread with none in the window', async () => {
 mock.channels = [thread([])];
 mock.earlier.mockResolvedValueOnce({messages:range(1, 3), earlierCursor:null});
 render(<ChannelScreen/>);
 fireEvent.click(await screen.findByRole('button', {name:'Show earlier messages'}));
 await waitFor(() => expect(shownBodies()).toEqual(range(1, 3).map((row) => row.body)));
 expect(screen.getByText('This is the start of this channel.')).toBeInTheDocument();
});

it('keeps the posts shown when an earlier page fails, and loads them on Try again with the same cursor', async () => {
 mock.earlier.mockRejectedValueOnce(new Error('Earlier messages did not load. Try again.'));
 render(<ChannelScreen/>);
 fireEvent.click(await screen.findByRole('button', {name:'Show earlier messages'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Earlier messages did not load. The messages shown stay here. Try again.');
 expect(shownBodies()).toHaveLength(3);
 mock.earlier.mockResolvedValueOnce({messages:range(201, 400), earlierCursor:{createdAt:post(201).createdAt, id:post(201).id}});
 fireEvent.click(screen.getByRole('button', {name:'Try again'}));
 await waitFor(() => expect(shownBodies()).toHaveLength(203));
 expect(mock.earlier.mock.calls.map((call) => call[1])).toEqual([{createdAt:post(401).createdAt, id:post(401).id}, {createdAt:post(401).createdAt, id:post(401).id}]);
 // The next page continues before the oldest post shown.
 mock.earlier.mockResolvedValueOnce({messages:range(1, 200), earlierCursor:null});
 fireEvent.click(screen.getByRole('button', {name:'Show earlier messages'}));
 await waitFor(() => expect(shownBodies()).toHaveLength(403));
 expect(mock.earlier.mock.calls[2][1]).toEqual({createdAt:post(201).createdAt, id:post(201).id});
});

it('shows no earlier control while the window holds every post, and none in preview', async () => {
 mock.cursors = new Map();
 const { unmount } = render(<ChannelScreen/>);
 await waitFor(() => expect(shownBodies()).toHaveLength(3));
 expect(screen.queryByRole('button', {name:'Show earlier messages'})).not.toBeInTheDocument();
 expect(screen.queryByText('This is the start of this channel.')).not.toBeInTheDocument();
 unmount();
 mock.mode = 'preview';
 mock.cursors = new Map([['thread-quiet', {createdAt:post(401).createdAt, id:post(401).id}]]);
 render(<ChannelScreen/>);
 expect(screen.queryByRole('button', {name:'Show earlier messages'})).not.toBeInTheDocument();
 expect(mock.earlier).not.toHaveBeenCalled();
});
