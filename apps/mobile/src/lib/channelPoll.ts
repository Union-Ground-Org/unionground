import type { ChannelPoll } from '../data/demoChannels';

// Match the web's channelPollIsClosed, including open-ended/invalid dates.
export function channelPollIsClosed(poll: Pick<ChannelPoll, 'closesAt'>, now = Date.now()): boolean {
  if (!poll.closesAt) return false;
  const closes = new Date(poll.closesAt).getTime();
  return !Number.isNaN(closes) && closes <= now;
}

type PollCopy = {
  live: string;
  closed: string;
  finalResults: string;
  prompt: string;
  voted: string;
  withheld: string;
  tally: (total: number, members?: number) => string;
  result: (label: string, share: number, votes: number, total: number) => string;
  vote: (result: string) => string;
};

export const channelPollCopy: Record<'en' | 'es', PollCopy> = {
  en: {
    live: 'LIVE POLL',
    closed: 'POLL CLOSED',
    finalResults: 'This poll is closed. Final results.',
    prompt: 'Tap to vote — you can change it any time.',
    voted: 'You voted. Results update live in Campaign Pulse.',
    withheld: 'Vote counts are withheld.',
    tally: (total, members) => `${total}${members ? ` OF ${members}` : ''} VOTED`,
    result: (label, share, votes, total) => `${label}, currently ${share} percent, ${votes} of ${total} votes`,
    vote: (result) => `Vote ${result}`,
  },
  es: {
    live: 'ENCUESTA ABIERTA',
    closed: 'ENCUESTA CERRADA',
    finalResults: 'Esta encuesta está cerrada. Resultados finales.',
    prompt: 'Toca para votar; puedes cambiar tu voto en cualquier momento.',
    voted: 'Ya votaste. Los resultados se actualizan en vivo en Pulso de la campaña.',
    withheld: 'Los recuentos de votos están ocultos.',
    tally: (total, members) => `${total}${members ? ` DE ${members}` : ''} VOTARON`,
    result: (label, share, votes, total) => `${label}, actualmente ${share} por ciento, ${votes} de ${total} votos`,
    vote: (result) => `Votar ${result}`,
  },
};
