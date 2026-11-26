import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { readResumeDraft, resumeDraftIsCurrent, resumeDraftKey, syncResumeDraftContext, writeResumeDraft } from '../lib/resumeDraftHolder';

const port = vi.hoisted(() => ({ app: {} as Record<string, unknown>, params: { id: 'thread-a' } as { id: string; post?: string }, client: null as unknown, reply: null as null | (() => void) }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', async () => ({ ...await import('../testing/uiStandIn'), Avatar: () => null }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => port.params, Redirect: () => null, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user: { id: string } } | null) => stubSessionWriter(() => port.client, session?.user.id ?? 'signed-out'), getSupabaseClient: () => port.client }));
vi.mock('../state/AppProvider', () => ({ useApp: () => { syncResumeDraftContext(port.app as Parameters<typeof syncResumeDraftContext>[0]); return port.app; } }));
vi.mock('./channelControls', async () => {
  const shared = await import('../lib/channelControlsShared');
  const controls = { ...shared.UNAVAILABLE_CHANNEL_CONTROLS, available: true,
    switches: { ...shared.UNAVAILABLE_CHANNEL_CONTROLS.switches, mentions: true } };
  return { useChannelControls: () => ({ controls, live: true, applySetting: vi.fn() }), channelControlsApi: {} };
});
vi.mock('../components/ChannelControls', () => ({
  CHANNEL_BODY_LINE_HEIGHT: 22, channelHasAnyControl: () => false, ChannelSettingsPanel: () => null,
  ChannelHighlightedBody: ({ body }: { body: string }) => h('p', null, body),
  MentionPickerPanel: ({ onPick }: { onPick: (person: { id: string; name: string; initials: string }) => void }) => h('button', { onClick: () => onPick({ id: 'ana', name: 'Ana Vale', initials: 'AV' }) }, 'Mention Ana'),
}));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), impact: vi.fn(), warning: vi.fn() } }));
vi.mock('../lib/announce', () => ({ announceForAccessibility: vi.fn() }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children, screenName }: { children?: ReactNode; screenName: string }) => h('div', null, h('header', null, screenName), children), useScreenNameAlreadySpoken: () => ({ hiddenProps: {} }) }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowMessageActions: ({ children, onCompose }: { children?: ReactNode; onCompose: () => void }) => { port.reply = onCompose; return h('div', null, children); } }));
vi.mock('../components/MessageReactions', () => ({ AddReactionChip: () => null, MessageReactionButton: () => null, MessageReactionPicker: () => null }));
vi.mock('../components/NativeMessageActions', () => ({ NativeMessageActions: ({ children }: { children?: ReactNode }) => children }));
vi.mock('../components/ChannelPollCard', () => ({ ChannelPollCard: () => null }));
vi.mock('../components/MessageReplies', () => ({ MessageReplies: () => null, ParentMessageControl: () => null, ReplyCountControl: () => null, useMessageReplyCounts: () => ({}) }));
vi.mock('../features/SavedPulseCharts', () => ({ LiveChartMessage: () => null }));

import { createChannelBackend } from '../testing/channelBackendStandIn';
import { liveChannelStore } from './liveChannels';
import ChannelScreen from '../../app/channel/[id]';

let screen: Rendered | null = null;
let backend: ReturnType<typeof createChannelBackend>;
const field = () => getExposed(screen!.container, 'Message Campaign chat') as HTMLInputElement;
const until = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); check(); }, { interval: 1, timeout: 3000 });
beforeEach(() => {
  syncResumeDraftContext({ mode: 'anonymous', session: null, organizationID: null });
  backend = createChannelBackend({
    chapter_spaces: [{ id: 'space-a', chapter_id: 'chapter-a', name: 'Campaign chat', description: 'Protected campaign', visibility: 'chapter', archived_at: null }],
    chapter_threads: [{ id: 'thread-a', space_id: 'space-a', title: 'Campaign chat', status: 'open' }],
    chapter_thread_posts: [{ id: '9b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10', thread_id: 'thread-a', author_id: 'other', body: 'Protected channel history', author_name: 'Ana Vale', author_initials: 'AV', created_at: '2026-11-19T12:00:00Z' }],
  });
  port.client = { ...backend.client, rpc: (name: string) => name === 'get_connected_workflow_context' ? Promise.resolve({ data: { available: true }, error: null }) : backend.client.rpc() };
  port.params = { id: 'thread-a' };
  port.app = { mode: 'authenticated', session: { user: { id: 'member-a' } }, organizationID: 'org-a', authorizedRoles: [], memberLanguage: 'en', dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' } } };
  liveChannelStore.resetForSession();
});
afterEach(async () => { await screen?.unmount(); screen = null; liveChannelStore.resetForSession(); vi.restoreAllMocks(); setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('channel draft across foreground checks on %s', (os) => {
  beforeEach(() => { setPlatform(os); });
  async function open() { screen = await render(h(ChannelScreen)); await until(() => { field(); }); }
  async function boot() {
    const actor = port.app;
    port.app = { ...actor, mode: 'booting', dashboard: null, organizationID: null, authorizedRoles: [] };
    await act(async () => { liveChannelStore.resetForSession(); });
    await screen!.rerender(h(ChannelScreen));
    expect(screen!.container.querySelector('input')).toBeNull();
    expect(screen!.container.textContent).not.toContain('Protected channel history');
    expect(screen!.container.querySelector('header')!.textContent).toBe('Channel');
    return actor;
  }

  // The real store dispatches and settles the insert. Only its backend
  // acknowledgement is delayed; a send spy would hide cache retirement.
  function delayPostAcknowledgement(outcome: 'confirmed' | 'failed' | 'unconfirmed' = 'confirmed') {
    let finish!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { finish = resolve; });
    port.client = { ...backend.client, from: (table: string) => {
      const query = backend.client.from(table);
      if (table === 'chapter_thread_posts') {
        const single = query.single;
        query.single = async () => {
          if (outcome === 'failed') { await acknowledgement; throw new TypeError('Connection failed before insert'); }
          if (outcome === 'unconfirmed') { await acknowledgement; return { data: null, error: null }; }
          const result = await single();
          await acknowledgement;
          return result;
        };
      }
      return query;
    } };
    return finish;
  }

  it('settles a confirmed insert across resume without offering a duplicate post', async () => {
    await open();
    const finish = delayPostAcknowledgement();
    await type(field(), 'Confirmed exactly once');
    await press(getExposed(screen!.container, 'Send message'));
    expect(backend.writes.filter((entry) => entry.table === 'chapter_thread_posts')).toHaveLength(1);
    port.app = await boot();
    await screen!.rerender(h(ChannelScreen));
    await until(() => expect(field().value).toBe('Confirmed exactly once'));
    expect(getExposed(screen!.container, 'Send message').getAttribute('aria-disabled')).toBe('true');
    await act(async () => { finish(); });
    expect(field().value).toBe('');
    expect(screen!.container.textContent).not.toContain('Your message could not be sent securely');
    await press(getExposed(screen!.container, 'Send message'));
    expect(backend.writes.filter((entry) => entry.table === 'chapter_thread_posts')).toHaveLength(1);
  });

  it.each<'failed' | 'unconfirmed'>(['failed', 'unconfirmed'])('keeps the draft when the real insert is %s across resume', async (outcome) => {
    await open();
    const finish = delayPostAcknowledgement(outcome);
    await type(field(), 'Unconfirmed post stays');
    await press(getExposed(screen!.container, 'Send message'));
    port.app = await boot();
    await screen!.rerender(h(ChannelScreen));
    await until(() => { field(); });
    await act(async () => { finish(); });
    expect(field().value).toBe('Unconfirmed post stays');
    expect(screen!.container.textContent).toContain('Your message could not be sent securely');
    expect(backend.writes.filter((entry) => entry.table === 'chapter_thread_posts')).toHaveLength(0);
  });

  it.each(['missing', '42501', 'PGRST301', 'PGRST303', '401', '403', 'PGRST303+403', 'nested-PGRST303', 'nested-403'])('keeps the message policy and distinguishes settings retirement (%s)', async (decision) => {
    await open();
    const key = resumeDraftKey(port.app as Parameters<typeof resumeDraftKey>[0], 'channelSettings', 'thread-a')!;
    const sendKey = resumeDraftKey(port.app as Parameters<typeof resumeDraftKey>[0], 'channelSettingSend', 'thread-a')!;
    writeResumeDraft(key, { keyword: 'Retire this keyword', duration: '1h' });
    const pending = writeResumeDraft(sendKey, { failed: false, saved: null }, true)!;
    await type(field(), 'Retire the old reply');
    await press(getExposed(screen!.container, 'Mention Ana'));
    await act(async () => { port.reply!(); });
    await type(field(), 'Retire the old reply to @Ana Vale');
    const spaces = backend.rows.chapter_spaces ?? [];
    const actor = await boot();
    if (decision === 'missing') backend.rows.chapter_spaces = [];
    else {
      const refusal = Object.assign(new Error('Read refused'), decision === 'PGRST303+403' ? { code: 'PGRST303', status: 403 }
        : decision === 'nested-PGRST303' ? { error: { code: 'PGRST303' }, status: 401 }
          : decision === 'nested-403' ? { error: { code: 'PGRST303' }, status: 403 }
            : /^\d{3}$/.test(decision) ? { status: Number(decision) } : { code: decision });
      port.client = { ...backend.client, auth: { getSession: async () => { throw refusal; } } };
    }
    port.app = actor;
    await screen!.rerender(h(ChannelScreen));
    await until(() => {
      expect(liveChannelStore.status()).toBe(decision === 'missing' || decision === '42501' ? 'ready' : 'error');
      expect(screen!.container.querySelector('input')).toBeNull();
    });
    const retireSettings = ['missing', '42501', '403', 'PGRST303+403', 'nested-403'].includes(decision);
    expect(liveChannelStore.authoritativeReadRefused()).toBe(decision !== 'missing' && retireSettings);
    backend.rows.chapter_spaces = spaces;
    port.client = backend.client;
    await act(async () => { await liveChannelStore.refresh(); });
    await until(() => expect(field().value).toBe(''));
    expect(liveChannelStore.authoritativeReadRefused()).toBe(false);
    if (retireSettings) expect(readResumeDraft(key)).toBeNull();
    else expect(readResumeDraft(key)?.value.keyword).toBe('Retire this keyword');
    expect(resumeDraftIsCurrent(pending)).toBe(!retireSettings);
    expect(screen!.container.textContent).not.toContain('Cancel reply');
    // Merely typing the same name must not resurrect the retired picked ID.
    await type(field(), 'New text naming @Ana Vale');
    await press(getExposed(screen!.container, 'Send message'));
    const post = backend.writes.find((entry) => entry.table === 'chapter_thread_posts')?.row;
    expect(post?.body).toBe('New text naming @Ana Vale');
    expect(post?.mentioned_user_ids ?? []).toEqual([]);
    expect(post?.parent_post_id).toBeUndefined();
  });

  it('keeps a concealed draft through a transient failed channel read', async () => {
    await open();
    await type(field(), 'Keep through a network outage');
    const actor = await boot();
    port.client = { ...backend.client, auth: { getSession: async () => { throw new TypeError('Network unavailable'); } } };
    port.app = actor;
    await screen!.rerender(h(ChannelScreen));
    await until(() => expect(liveChannelStore.status()).toBe('error'));
    expect(screen!.container.querySelector('input')).toBeNull();
    port.client = backend.client;
    await act(async () => { await liveChannelStore.refresh(); });
    await until(() => expect(field().value).toBe('Keep through a network outage'));
  });

  it.each([false, true])('retires the pending continuation after a missing channel (failed=%s)', async (failed) => {
    await open();
    const finish = delayPostAcknowledgement(failed ? 'failed' : 'confirmed');
    await type(field(), 'Old pending post');
    await press(getExposed(screen!.container, 'Send message'));
    const spaces = backend.rows.chapter_spaces ?? [];
    const actor = await boot();
    backend.rows.chapter_spaces = [];
    port.app = actor;
    await screen!.rerender(h(ChannelScreen));
    await until(() => expect(screen!.container.textContent).toContain('Channel not available'));
    backend.rows.chapter_spaces = spaces;
    await act(async () => { await liveChannelStore.refresh(); });
    await until(() => expect(field().value).toBe(''));
    await type(field(), 'New owner after restored access');
    expect(getExposed(screen!.container, 'Send message').getAttribute('aria-disabled')).toBeNull();
    await act(async () => { finish(); });
    expect(field().value).toBe('New owner after restored access');
    expect(screen!.container.textContent).not.toContain('Your message could not be sent securely');
  });

  it.each(['account', 'channel'])('ignores a real confirmed acknowledgement after the %s changes', async (change) => {
    await open();
    const finish = delayPostAcknowledgement();
    await type(field(), 'Old owner confirmed post');
    await press(getExposed(screen!.container, 'Send message'));
    const actor = await boot();
    if (change === 'account') {
      backend = createChannelBackend({ chapter_spaces: backend.rows.chapter_spaces ?? [], chapter_threads: backend.rows.chapter_threads ?? [] }, 'member-b');
      port.app = { ...actor, session: { user: { id: 'member-b' } }, dashboard: { member: { id: 'member-b', chapterID: 'chapter-a', language: 'en' } } };
    } else {
      backend.rows.chapter_threads!.push({ id: 'thread-b', space_id: 'space-a', title: 'Another thread', status: 'open' });
      backend.rows.chapter_thread_posts = [];
      port.params = { id: 'thread-b' };
      port.app = actor;
    }
    port.client = backend.client;
    await screen!.rerender(h(ChannelScreen));
    const nextField = () => getExposed(screen!.container, change === 'account' ? 'Message Campaign chat' : 'Message Another thread') as HTMLInputElement;
    await until(() => expect(nextField().value).toBe(''));
    await type(nextField(), 'Replacement owner draft');
    const cacheVersion = liveChannelStore.getVersion();
    await act(async () => { finish(); });
    expect(nextField().value).toBe('Replacement owner draft');
    expect(liveChannelStore.getVersion()).toBe(cacheVersion);
    expect(liveChannelStore.channels().flatMap((channel) => channel.messages).some((message) => message.body === 'Old owner confirmed post')).toBe(false);
  });

  it('holds text and structured mentions without sending, until fresh campaign access loads', async () => {
    await open();
    await type(field(), 'Unfinished post');
    await press(getExposed(screen!.container, 'Mention Ana'));
    const draft = field().value;
    const actor = await boot();
    let allow!: () => void;
    const permission = new Promise<void>((resolve) => { allow = resolve; });
    port.client = { ...backend.client, auth: { getSession: async () => { await permission; return backend.client.auth.getSession(); } } };
    port.app = actor;
    await screen!.rerender(h(ChannelScreen));
    expect(screen!.container.querySelector('input')).toBeNull();
    expect(screen!.container.textContent).not.toContain('Protected channel history');
    await act(async () => { allow(); });
    await until(() => expect(field().value).toBe(draft));
    expect(backend.writes.filter((entry) => entry.table === 'chapter_thread_posts')).toHaveLength(0);
    await press(getExposed(screen!.container, 'Send message'));
    await until(() => expect(backend.writes.find((entry) => entry.table === 'chapter_thread_posts')?.row).toMatchObject({ body: draft.trim(), mentioned_user_ids: ['ana'] }));
  });

  it('keeps the chosen reply with the draft', async () => {
    await open();
    await act(async () => { port.reply!(); });
    await type(field(), 'Unfinished channel reply');
    port.app = await boot();
    await screen!.rerender(h(ChannelScreen));
    await until(() => expect(field().value).toBe('Unfinished channel reply'));
    getExposed(screen!.container, 'Cancel reply');
  });

  it.each(['removed', 'refused'])('retires only the held reply when its source is %s, keeping channel settings', async (decision) => {
    await open();
    const key = resumeDraftKey(port.app as Parameters<typeof resumeDraftKey>[0], 'channelSettings', 'thread-a')!;
    const sendKey = resumeDraftKey(port.app as Parameters<typeof resumeDraftKey>[0], 'channelSettingSend', 'thread-a')!;
    writeResumeDraft(key, { keyword: 'Unfinished channel keyword', duration: '8h' });
    const pending = writeResumeDraft(sendKey, { failed: false, saved: null }, true)!;
    await act(async () => { port.reply!(); });
    await type(field(), 'Draft for a removed channel post');
    const actor = await boot();
    backend.rows.chapter_thread_posts = [];
    port.client = { ...backend.client, rpc: (name: string) => name === 'get_connected_workflow_context'
      ? Promise.resolve(decision === 'removed' ? { data: { available: false }, error: null } : { data: null, error: { code: '42501' } }) : backend.client.rpc() };
    port.app = actor;
    await screen!.rerender(h(ChannelScreen));
    await until(() => expect(field().value).toBe(''));
    expect(screen!.container.textContent).toContain('Campaign chat');
    expect(screen!.container.textContent).not.toContain('Cancel reply');
    expect(screen!.container.textContent).not.toContain('Draft for a removed channel post');
    expect(readResumeDraft(key)?.value).toEqual({ keyword: 'Unfinished channel keyword', duration: '8h' });
    expect(resumeDraftIsCurrent(pending)).toBe(true);
    expect(backend.writes.filter((entry) => entry.table === 'chapter_thread_posts')).toHaveLength(0);
  });

  it.each([true, false])('waits for the linked post access check before showing a held draft (allowed=%s)', async (available) => {
    port.params = { id: 'thread-a', post: '9b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10' };
    port.client = { ...backend.client, rpc: async () => ({ data: { available: true }, error: null }) };
    await open();
    await type(field(), 'Linked post draft');
    const actor = await boot();
    let finish!: (value: { data: { available: boolean }; error: null }) => void;
    const decision = new Promise<{ data: { available: boolean }; error: null }>((resolve) => { finish = resolve; });
    port.client = { ...backend.client, rpc: (name: string) => name === 'get_connected_workflow_context' ? decision : backend.client.rpc() };
    port.app = actor;
    await screen!.rerender(h(ChannelScreen));
    await until(() => expect(liveChannelStore.status()).toBe('ready'));
    expect(screen!.container.querySelector('input')).toBeNull();
    expect(screen!.container.querySelector('header')!.textContent).toBe('Channel');
    expect(screen!.container.textContent).not.toContain('Protected channel history');
    await act(async () => { finish({ data: { available }, error: null }); });
    if (available) await until(() => expect(field().value).toBe('Linked post draft'));
    else {
      expect(screen!.container.querySelector('input')).toBeNull();
      expect(screen!.container.textContent).not.toContain('Linked post draft');
      expect(screen!.container.textContent).not.toContain('Protected channel history');
    }
  });

  it('keeps a pending channel post busy and lands its completion once', async () => {
    await open();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const send = vi.spyOn(liveChannelStore, 'send').mockImplementationOnce(async () => { await pending; return true; });
    await type(field(), 'Send once');
    await press(getExposed(screen!.container, 'Send message'));
    port.app = await boot();
    await screen!.rerender(h(ChannelScreen));
    await until(() => expect(field().value).toBe('Send once'));
    expect(getExposed(screen!.container, 'Send message').getAttribute('aria-disabled')).toBe('true');
    await act(async () => { finish(); });
    expect(field().value).toBe('');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('drops the channel draft and reply after sign-out and a different account, ignoring the pending send', async () => {
    await open();
    let finish!: () => void;
    vi.spyOn(liveChannelStore, 'send').mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = () => resolve(true); }));
    await type(field(), 'First account only');
    await press(getExposed(screen!.container, 'Send message'));
    port.app = { ...port.app, mode: 'signedOut', session: null, dashboard: null };
    await screen!.rerender(h(ChannelScreen));
    port.app = { ...port.app, mode: 'authenticated', session: { user: { id: 'member-b' } }, dashboard: { member: { id: 'member-b', chapterID: 'chapter-a', language: 'en' } } };
    await act(async () => { liveChannelStore.resetForSession(); });
    await screen!.rerender(h(ChannelScreen));
    await until(() => expect(field().value).toBe(''));
    await type(field(), 'Second account draft');
    await act(async () => { finish(); });
    expect(field().value).toBe('Second account draft');
  });

  it.each<'removed' | 'role changed' | 'campaign changed' | 'organization changed'>(['removed', 'role changed', 'campaign changed', 'organization changed'])('does not restore a draft when %s', async (change) => {
    await open();
    await type(field(), 'No stale draft');
    const actor = await boot();
    if (change === 'removed') backend.rows.chapter_spaces = [];
    port.app = { ...actor,
      ...(change === 'role changed' ? { authorizedRoles: ['steward'] } : {}),
      ...(change === 'campaign changed' ? { dashboard: { member: { chapterID: 'chapter-b' } } } : {}),
      ...(change === 'organization changed' ? { organizationID: 'org-b' } : {}),
    };
    await screen!.rerender(h(ChannelScreen));
    await until(() => {
      expect(liveChannelStore.status()).toBe('ready');
      expect(screen!.container.querySelector<HTMLInputElement>('input')?.value ?? '').toBe('');
    });
    expect(screen!.container.textContent).not.toContain('No stale draft');
  });

  it('drops the draft and reply if a different channel opens during booting', async () => {
    await open();
    await act(async () => { port.reply!(); });
    await type(field(), 'Old channel only');
    const actor = await boot();
    backend.rows.chapter_threads!.push({ id: 'thread-b', space_id: 'space-a', title: 'Another thread', status: 'open' });
    port.params = { id: 'thread-b' };
    await screen!.rerender(h(ChannelScreen));
    port.app = actor;
    await screen!.rerender(h(ChannelScreen));
    await until(() => expect((getExposed(screen!.container, 'Message Another thread') as HTMLInputElement).value).toBe(''));
    expect(screen!.container.textContent).not.toContain('Cancel reply');
    expect(screen!.container.textContent).not.toContain('Old channel only');
  });
});
