// Bridge to the shared chapter channel controls module in
// src/features/messaging/channelControls.js (REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001).
// The Expo app does not restate a matching or precedence rule: the @here
// token, keyword whole-word matching, pinned ordering and the mute/level
// precedence mirror all come from the module responsive web imports.
import * as shared from '../../../../src/features/messaging/channelControls.js';

export type ChannelNotificationLevel = 'all' | 'mentions' | 'none';
export type ChannelAlertReason = 'mention' | 'here' | 'keyword' | 'post';
export type ChannelSetting = {
  spaceId?: string;
  level?: ChannelNotificationLevel;
  muted?: boolean;
  mutedUntil?: string | null;
  muteActive?: boolean;
  keywords?: string[];
};
export type ChannelControlSwitches = {
  channelPinning: boolean;
  notificationLevels: boolean;
  channelMute: boolean;
  mentions: boolean;
  hereMentions: boolean;
  mentionSearch: boolean;
  keywordAlerts: boolean;
};
export type ChannelControls = {
  available: boolean;
  organizationId: string | null;
  switches: ChannelControlSwitches;
  keywordLimit: number;
  keywordCount: number;
  canPin: boolean;
  spaces: Record<string, ChannelSetting>;
};
export type HighlightSegment = { text: string; highlight: null | 'keyword' | 'here' };
export type KeywordProblem = null | 'length' | 'per-channel' | 'limit';

export const CHANNEL_NOTIFICATION_LEVELS: readonly ChannelNotificationLevel[] = shared.CHANNEL_NOTIFICATION_LEVELS;
export const CHANNEL_MUTE_DURATIONS: readonly { id: string; hours: number | null }[] = shared.CHANNEL_MUTE_DURATIONS;
export const UNAVAILABLE_CHANNEL_CONTROLS: ChannelControls = shared.UNAVAILABLE_CHANNEL_CONTROLS;

export const normalizeChannelControls: (raw: unknown) => ChannelControls = shared.normalizeChannelControls;
export const normalizeChannelSetting: (raw: unknown, spaceId?: string) => Required<ChannelSetting> = shared.normalizeChannelSetting;
export const channelSettingFor: (controls: ChannelControls, spaceId: string) => Required<ChannelSetting> = shared.channelSettingFor;
export const isMuteActive: (setting: ChannelSetting | null | undefined, now?: Date) => boolean = shared.isMuteActive;
export const muteUntilFor: (durationId: string, now?: Date) => string | null = shared.muteUntilFor;
export const containsHereMention: (body: string | null | undefined) => boolean = shared.containsHereMention;
export const normalizeKeywords: (values: readonly unknown[]) => string[] = shared.normalizeKeywords;
export const keywordListProblem: (keywords: readonly string[], budget?: { elsewhere?: number; limit?: number }) => KeywordProblem = shared.keywordListProblem;
export const segmentChannelText: (text: string, options?: { keywords?: readonly string[]; here?: boolean }) => HighlightSegment[] = shared.segmentChannelText;
export const appendMentionText: (draft: string, person: { name: string }) => string = shared.appendMentionText;
export const mentionIdsForBody: (body: string, picked: readonly { id: string; name: string }[]) => string[] = shared.mentionIdsForBody;
export const isChannelControlDisabled: (error: unknown) => boolean = shared.isChannelControlDisabled;
export const isKeywordLimitError: (error: unknown) => boolean = shared.isKeywordLimitError;
export const orderThreadsForChannel: <T extends { pinned_at?: string | null }>(threads: readonly T[], pinningOn?: boolean) => T[] = shared.orderThreadsForChannel;
