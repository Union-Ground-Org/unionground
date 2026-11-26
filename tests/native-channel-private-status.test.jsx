import { stubSessionWriter } from '../apps/mobile/src/testing/stubSessionWriter';
vi.mock('react', async () => await import('react'));
import { configure, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

// UX-UG-NATIVE-TITLE-BESIDE-BACK-CONTROL-20261115 (review of #8944):
// once a channel's name moves to the title row beside Back, the scene stops
// painting `#name`, and a private channel must still say it is private: a
// lock and its words on their own line, read once, in English and Spanish.
// The mounted native channel screen, fictional Tamarack channels only.
const mock = vi.hoisted(() => ({
 session: {user:{id:'member-a'}}, channels: [], cursors: new Map(), earlier: vi.fn(), mode: 'authenticated', version: 0, duplicate: true, language: 'en',
 screen: {props: null, scrollTo: vi.fn(), scrollToEnd: vi.fn()},
}));
vi.mock('@expo/vector-icons', () => ({Ionicons:({name})=><i data-icon={name}/>}));
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
vi.mock('../apps/mobile/src/components/PinnedHeader', () => ({PinnedHeaderScreen:({children})=><div>{children}</div>,useScreenNameAlreadySpoken:(text)=>({duplicate:mock.duplicate && text==='quiet',hiddenProps:{}})}));
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
vi.mock('../apps/mobile/src/state/AppProvider', () => ({useApp:()=>({memberLanguage:mock.language,mode:mock.mode,session:mock.session,dashboard:null,previewHat:null,authorizedRoles:[],organizationID:'tamarack'})}));
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

function channel(locked) {
 return {id:'thread-quiet', spaceID:'space-1', name:'quiet', topic:'general', unread:0, locked, messages:[
  {id:'post-1', author:'Member B', initials:'MB', time:'', body:'Tamarack post one', createdAt:'2026-09-01T15:00:00.000Z'},
 ]};
}

beforeEach(() => {
 mock.mode = 'authenticated';
 mock.version += 1;
 mock.duplicate = true;
 mock.language = 'en';
 mock.cursors = new Map();
 mock.earlier.mockReset();
});

it('keeps the lock and "Private channel" once when the name has moved to the title row', async () => {
 mock.channels = [channel(true)];
 const { container } = render(<ChannelScreen/>);
 await screen.findByText('Tamarack post one');
 // The name is the row's now: no second `#quiet` in the scene.
 expect(screen.queryByText('#quiet')).not.toBeInTheDocument();
 // One visible marker, with its lock, read as one element.
 expect(screen.getAllByText('Private channel')).toHaveLength(1);
 const marker = screen.getByLabelText('Private channel');
 expect(marker.querySelector('[data-icon="lock-closed"]')).not.toBeNull();
 expect(container.querySelectorAll('[data-icon="lock-closed"]')).toHaveLength(1);
});

it('says it in Spanish for a Spanish-speaking member', async () => {
 mock.language = 'es';
 mock.channels = [channel(true)];
 render(<ChannelScreen/>);
 await screen.findByText('Tamarack post one');
 expect(screen.getAllByText('Canal privado')).toHaveLength(1);
 expect(screen.getByLabelText('Canal privado').querySelector('[data-icon="lock-closed"]')).not.toBeNull();
 expect(screen.queryByText('Private channel')).not.toBeInTheDocument();
});

it('keeps the marker, with one lock, before the name has moved to the row', async () => {
 mock.duplicate = false;
 mock.channels = [channel(true)];
 const { container } = render(<ChannelScreen/>);
 await screen.findByText('Tamarack post one');
 expect(screen.getByText('quiet')).toBeInTheDocument();
 expect(screen.queryByText('#quiet')).not.toBeInTheDocument();
 expect(screen.getAllByText('Private channel')).toHaveLength(1);
 expect(container.querySelectorAll('[data-icon="lock-closed"]')).toHaveLength(1);
});

it('shows no private marker on an open channel', async () => {
 mock.channels = [channel(false)];
 const { container } = render(<ChannelScreen/>);
 await screen.findByText('Tamarack post one');
 expect(screen.queryByText('Private channel')).not.toBeInTheDocument();
 expect(container.querySelector('[data-icon="lock-closed"]')).toBeNull();
});
