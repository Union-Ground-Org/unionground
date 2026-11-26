import type { NativeUiText } from './nativeUiCopy';

// Only these release-reviewed, public product guides may enter the offline
// library. Campaign records, worker lists and uploaded documents are never inputs.
export type PublicLearningGuide = {
  id: string;
  title: string;
  revision: string;
  reviewedAt: string;
  body: string;
};

export const PUBLIC_LEARNING_GUIDES: readonly PublicLearningGuide[] = [
  {
    id: 'getting-started',
    title: 'Find your way around',
    revision: '2',
    reviewedAt: '2026-10-13',
    body: 'Home brings your campaign work together. Home sits above two drawers: All tools is under the left edge and Campaign work is under the right edge. Move Home aside to open a drawer, and tap the visible edge of Home to close it again.\n\nThe dock has five tabs: Home, Work, Guide, Campaign and Account. Work shows what needs your attention, Guide answers questions about organizing, Campaign holds meetings and campaign records, and Account holds your display, privacy and data settings. Organizing rights and other tools are in All tools.\n\nThe hat you wear, such as Worker, Committee or Organizer, decides which tools you can use. Use Refresh when you want current information. If a connection fails, check the error before trying again. A saved public guide is a local copy and may be older than the current app.',
  },
  {
    id: 'prepare-for-a-conversation',
    title: 'Prepare for a conversation',
    revision: '2',
    reviewedAt: '2026-10-13',
    body: 'Before starting a conversation, decide what you want to ask and who can help: an organizer, a committee member or your campaign lead. Check the channel or person, and who can read it, before sending. The committee channel is private; other channels can be open to every worker in the campaign.\n\nUse personal learning notes for reminders about using the app. Keep coworker names, the worker list, card details and notes about what a manager said out of those notes. Those belong in Campaign work while connected, where the committee decides who can see them.\n\nSending messages requires a connection. A note saved on this phone is not a sent message and is not shared with the campaign. Check the conversation after an interrupted send before sending again.',
  },
  {
    id: 'data-and-offline',
    title: 'Use the app with less data',
    revision: '3',
    reviewedAt: '2026-11-25',
    body: 'Low data and offline settings are in Account, the last tab in the dock. Low data changes optional loading. Auto follows supported device network signals; On keeps the reduction active; Off uses the normal loading policy. You can still request a refresh or open a file yourself.\n\nSaved guides and notes are separate. Download a public guide while connected and read the saved copy later. Saved guides show their age and expire after 30 days. Clear downloads removes them from this phone.\n\nSigning in, refreshing campaign records, sending messages, answering polls, uploading notes or documents and saving changes to the server require a connection. The app does not queue these actions for later. Personal learning notes stay on this phone and expire seven days after creation.',
  },
];

export const PUBLIC_LEARNING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type PublicLearningDownload = { id: string; downloadedAt: number; bytes: number };
export type PublicLearningLibrary = { enabled: boolean; downloads: PublicLearningDownload[]; bytes: number };

export function readablePublicDownload(value: unknown, now: number): PublicLearningDownload | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'body,downloadedAt,id,reviewedAt,revision,title') return null;
  const guide = PUBLIC_LEARNING_GUIDES.find((item) => item.id === row.id);
  if (!guide || row.revision !== guide.revision || row.body !== guide.body || row.title !== guide.title
    || row.reviewedAt !== guide.reviewedAt || typeof row.downloadedAt !== 'number'
    || !Number.isFinite(row.downloadedAt) || row.downloadedAt > now
    || now - row.downloadedAt >= PUBLIC_LEARNING_MAX_AGE_MS) return null;
  return { id: guide.id, downloadedAt: row.downloadedAt, bytes: utf8Bytes(JSON.stringify(row)) };
}

export function utf8Bytes(text: string): number {
  // TextEncoder is not present in every supported Hermes runtime.
  return unescape(encodeURIComponent(text)).length;
}

export function savedAge(t: NativeUiText, timestamp: number, now = Date.now()): string {
  const hours = Math.floor(Math.max(0, now - timestamp) / 3_600_000);
  if (hours < 1) return t('Saved just now');
  if (hours < 24) return t('Saved {hours}h ago', { hours });
  return t('Saved {days}d ago', { days: Math.floor(hours / 24) });
}
