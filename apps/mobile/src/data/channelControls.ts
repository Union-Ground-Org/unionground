// Native client for the campaign channel controls
// (REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001). The same SECURITY DEFINER
// RPCs responsive web calls; the rules come from the shared module so both
// clients highlight, order and explain the same way.
import { useCallback, useEffect, useRef, useState } from 'react';

import { captureSessionWriter, getSupabaseClient, type MobileSessionWriter } from '../services/supabase';
import { useApp } from '../state/AppProvider';
import { useAppActive } from '../state/useAppActive';
import {
  UNAVAILABLE_CHANNEL_CONTROLS,
  normalizeChannelControls,
  normalizeChannelSetting,
  type ChannelControls,
  type ChannelSetting,
} from '../lib/channelControlsShared';
import { useLearningUndone } from '../../../../src/features/learningPeriod/undoneSignal.js';

export type MentionCandidate = { id: string; name: string; initials: string };
export type MentionHit = {
  postId: string;
  threadId: string;
  spaceId: string;
  threadTitle: string;
  spaceName: string;
  body: string;
  authorName: string | null;
  createdAt: string;
  reason: 'mention' | 'here';
};

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const client = getSupabaseClient();
  if (!client) throw new Error('Union Ground is not connected.');
  const response: { data: unknown; error: unknown } = await client.rpc(name, args);
  if (response.error) throw response.error;
  return response.data as T;
}

async function writeRpc<T>(writer: MobileSessionWriter, name: string, args?: Record<string, unknown>): Promise<T> {
  const response: { data: unknown; error: unknown } = await (await writer.client()).rpc(name, args);
  if (response.error) throw response.error;
  return response.data as T;
}

export const channelControlsApi = {
  async load(): Promise<ChannelControls> {
    return normalizeChannelControls(await rpc<unknown>('get_my_channel_controls'));
  },
  async setLevel(writer: MobileSessionWriter, spaceID: string, level: string): Promise<Required<ChannelSetting>> {
    return normalizeChannelSetting(await writeRpc<unknown>(writer, 'set_channel_notification_level', { p_space_id: spaceID, p_level: level }), spaceID);
  },
  async setMute(writer: MobileSessionWriter, spaceID: string, muted: boolean, mutedUntil: string | null): Promise<Required<ChannelSetting>> {
    return normalizeChannelSetting(await writeRpc<unknown>(writer, 'set_channel_mute', { p_space_id: spaceID, p_muted: muted, p_muted_until: muted ? mutedUntil : null }), spaceID);
  },
  async setKeywords(writer: MobileSessionWriter, spaceID: string, keywords: string[]): Promise<Required<ChannelSetting>> {
    return normalizeChannelSetting(await writeRpc<unknown>(writer, 'set_channel_keyword_alerts', { p_space_id: spaceID, p_keywords: keywords }), spaceID);
  },
  async setPinned(writer: MobileSessionWriter, threadID: string, pinned: boolean): Promise<{ pinnedAt: string | null }> {
    const result = await writeRpc<{ pinnedAt?: string | null } | null>(writer, 'set_chapter_thread_pinned', { p_thread_id: threadID, p_pinned: pinned });
    return { pinnedAt: result?.pinnedAt ?? null };
  },
  async mentionCandidates(spaceID: string, query: string): Promise<MentionCandidate[]> {
    const rows = await rpc<MentionCandidate[] | null>('list_channel_mention_candidates', { p_space_id: spaceID, p_query: query || null, p_limit: 8 });
    return Array.isArray(rows) ? rows : [];
  },
  async searchMentions(query: string): Promise<MentionHit[]> {
    const rows = await rpc<MentionHit[] | null>('search_my_channel_mentions', { p_query: query || null, p_limit: 30 });
    return Array.isArray(rows) ? rows : [];
  },
  // @here reaches people who are online now. The presence row is the existing
  // one-per-member heartbeat; a channel screen keeps it fresh while it is open
  // and the app is in the foreground.
  async heartbeat(writer: MobileSessionWriter, status: 'online' | 'away'): Promise<void> {
    await writeRpc<unknown>(writer, 'heartbeat_member_presence', { p_status: status });
  },
};

const HEARTBEAT_MS = 60_000;

/**
 * The caller's channel controls for the current organization. Outside an
 * authenticated session nothing is offered: preview fixtures never render a
 * control as if it were persisted.
 */
export function useChannelControls(options: { heartbeat?: boolean } = {}) {
  const { mode, session, organizationID, dashboard } = useApp();
  const live = mode === 'authenticated';
  const active = useAppActive();
  const scope = `${session?.user.id ?? ''}:${organizationID ?? ''}:${dashboard?.member.chapterID ?? ''}`;
  const [controls, setControls] = useState<ChannelControls>(UNAVAILABLE_CHANNEL_CONTROLS);
  const [status, setStatus] = useState<'unavailable' | 'loading' | 'ready' | 'error'>(live ? 'loading' : 'unavailable');
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const run = ++generation.current;
    if (!live) {
      setControls(UNAVAILABLE_CHANNEL_CONTROLS);
      setStatus('unavailable');
      return;
    }
    try {
      const next = await channelControlsApi.load();
      if (run !== generation.current) return;
      setControls(next);
      setStatus('ready');
    } catch {
      if (run !== generation.current) return;
      setControls(UNAVAILABLE_CHANNEL_CONTROLS);
      setStatus('error');
    }
  }, [live]);
  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, [reload, scope]);
  useEffect(() => {
    if (!live || !options.heartbeat || !active) return undefined;
    const beat = () => { channelControlsApi.heartbeat(captureSessionWriter(session), 'online').catch(() => {}); };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [active, live, options.heartbeat, scope, session]);
  // #7027: an undo of your own level, mute or keyword change re-reads them.
  useLearningUndone(['own_channel_notifications'], () => { void reload(); });
  const applySetting = useCallback((spaceID: string, setting: Required<ChannelSetting>) => {
    setControls((current) => {
      const before = current.spaces[spaceID]?.keywords?.length ?? 0;
      return {
        ...current,
        keywordCount: Math.max(0, current.keywordCount - before + setting.keywords.length),
        spaces: { ...current.spaces, [spaceID]: setting },
      };
    });
  }, []);
  return { controls, status, reload, applySetting, live };
}
