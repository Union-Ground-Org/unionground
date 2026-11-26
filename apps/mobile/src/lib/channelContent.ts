import type { ChannelMessage, DemoChannel } from '../data/demoChannels';

export type ChannelContentLanguage = 'en' | 'es';

// The device locale as a content language: channelReaderLanguage falls back to
// it only when the member's saved language is not known.
export function channelContentLanguage(locale: string): ChannelContentLanguage {
  return locale.toLowerCase().split('-')[0] === 'es' ? 'es' : 'en';
}

// The language a channel's posts are shown in: the member's saved language
// first (the profile choice, then the dashboard's), the device locale only
// when neither is known. The newest posts and every earlier history page read
// this one answer (UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117,
// Earlier pages used to follow the device locale alone).
export function channelReaderLanguage(memberLanguage: ChannelContentLanguage | null | undefined, dashboardLanguage: ChannelContentLanguage | null | undefined, deviceLocale: string): ChannelContentLanguage {
  return memberLanguage ?? dashboardLanguage ?? channelContentLanguage(deviceLocale);
}

// Mirrors src/lib/bilingualContent.js from #6633: keep the supplied Spanish
// version intact when nonblank; otherwise keep the original, field by field.
function readerText(original: string, spanish?: string | null): string {
  return typeof spanish === 'string' && spanish.trim() !== '' ? spanish : original;
}

export function channelInReaderLanguage(channel: DemoChannel, language: ChannelContentLanguage): DemoChannel {
  if (language !== 'es') return channel;
  return {
    ...channel,
    name: readerText(channel.name, channel.nameEs),
    topic: readerText(channel.topic, channel.topicEs),
    messages: channel.messages.map((message) => channelMessageInReaderLanguage(message, language)),
  };
}

// One post, as channelInReaderLanguage shows it; earlier history pages use it.
export function channelMessageInReaderLanguage<Message extends ChannelMessage>(message: Message, language: ChannelContentLanguage): Message {
  return language === 'es' ? { ...message, body: readerText(message.body, message.bodyEs) } : message;
}
