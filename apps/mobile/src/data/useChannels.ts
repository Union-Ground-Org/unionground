import { captureSessionWriter } from '../services/supabase';
import { useEffect, useMemo } from 'react';

import { channelStore, type ChannelPoll, type DemoChannel } from './demoChannels';
import { liveChannelStore, type ChannelLoadStatus } from './liveChannels';
import type { ChannelLoadDiagnosis, ChannelLoadFault } from '../lib/channelLoadDiagnosis';
import { channelInReaderLanguage, channelReaderLanguage } from '../lib/channelContent';
import { useApp } from '../state/AppProvider';

// The store surface the channel screens render from. The demo store (seeded,
// in-memory, preview mode) and the live store (real backend, authenticated
// mode) both satisfy it; poll() is nullable because a live chapter may have
// no open poll.
export type ChannelStoreLike = {
  subscribe(listener: () => void): () => void;
  getVersion(): number;
  status(): ChannelLoadStatus;
  error(): string | null;
  loadFault(): ChannelLoadFault | null;
  diagnosis(): ChannelLoadDiagnosis | null;
  markReadFault(id: string): ChannelLoadDiagnosis | null;
  refresh(): Promise<void> | void;
  channels(): DemoChannel[];
  channel(id: string): DemoChannel | null;
  poll(): ChannelPoll | null;
  pollTotal(): number | null;
  markRead(id: string): void;
  toggleReaction(channelID: string, messageID: string, emoji: string): void;
  vote(index: number): void;
  send(channelID: string, body: string, author: string, initials: string, mentionIDs?: readonly string[]): boolean | Promise<boolean>;
};

export function useChannelStore(): ChannelStoreLike {
  const { mode, session, memberLanguage, dashboard } = useApp();
  const live = mode === 'authenticated';
  const store = useMemo(() => {
    if (!live) return channelStore;
    const writer = captureSessionWriter(session);
    return {
      ...liveChannelStore,
      markRead: (id: string) => liveChannelStore.markRead(writer, id),
      toggleReaction: (channelID: string, messageID: string, kind: string) => liveChannelStore.toggleReaction(writer, channelID, messageID, kind),
      vote: (index: number) => liveChannelStore.vote(writer, index),
      send: (id: string, body: string, author: string, initials: string, mentions?: readonly string[]) => liveChannelStore.send(writer, id, body, author, initials, mentions),
    };
  }, [live, session]);
  const language = channelReaderLanguage(memberLanguage, dashboard?.member.language, Intl.DateTimeFormat().resolvedOptions().locale);
  useEffect(() => {
    if (!live) return;
    liveChannelStore.acquire();
    return () => liveChannelStore.release();
  }, [live]);
  return useMemo(() => {
    if (!live || language !== 'es') return store;
    // Keep the store and each displayed row stable between emissions. Callers
    // subscribe to getVersion; writes continue to use the original content.
    let projectedVersion = -1;
    let channels: DemoChannel[] = [];
    const snapshot = () => {
      const version = store.getVersion();
      if (projectedVersion !== version) {
        channels = store.channels().map((channel) => channelInReaderLanguage(channel, language));
        projectedVersion = version;
      }
      return channels;
    };
    return {
      ...store,
      channels: snapshot,
      channel: (id: string) => {
        const original = store.channel(id);
        return original ? snapshot().find((channel) => channel.id === original.id) ?? null : null;
      },
    };
  }, [store, live, language]);
}
