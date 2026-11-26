import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';

import { ArrivingBars } from './ArrivingBars';
import { pollShares, type ChannelPoll } from '../data/demoChannels';
import { channelPollCopy, channelPollIsClosed } from '../lib/channelPoll';
import { minimumTouchTarget, radii, spacing, type ThemeTokens } from '../theme/tokens';

import { typeface } from '../theme/typeface';
export function ChannelPollCard({ poll, members, language, theme, onVote }: {
  poll: ChannelPoll;
  members?: number;
  language: 'en' | 'es';
  theme: ThemeTokens;
  onVote: (index: number) => void;
}) {
  const [clock, setClock] = useState(Date.now);
  // Close an already-visible card at its deadline, including after resume.
  useEffect(() => {
    const remaining = poll.closesAt ? new Date(poll.closesAt).getTime() - Date.now() : NaN;
    const timer = remaining > 0
      ? setTimeout(() => setClock(Date.now()), Math.min(remaining, 2_147_483_647))
      : undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setClock(Date.now());
    });
    return () => { clearTimeout(timer); subscription.remove(); };
  }, [poll.closesAt, clock]);
  const closed = channelPollIsClosed(poll);
  const copy = channelPollCopy[language];
  const withheld = poll.options.some((option) => option.votes === null);
  const total = poll.options.reduce((sum, option) => sum + (option.votes ?? 0), 0);
  const shares = pollShares(poll.options);

  return (
    <View style={[styles.poll, { borderColor: theme.border, borderLeftColor: theme.accent }]}>
      <View style={styles.pollLabelRow}>
        {closed ? null : <View style={[styles.liveDot, { backgroundColor: theme.compass }]} />}
        <Text style={[styles.pollLabel, { color: theme.primary }]}>{`${closed ? copy.closed : copy.live} · ${withheld ? copy.withheld : copy.tally(total, members)}`}</Text>
      </View>
      <Text style={[styles.pollQuestion, { color: theme.foreground }]}>{poll.question}</Text>
      {/* The results arrive once, the first time the card is seen; a vote or a
          new count later redraws them whole. */}
      <ArrivingBars arrivalKey={`channel-poll:${poll.question}`} count={poll.options.length} gap={spacing.sm}>{(grow) => poll.options.map((option, index) => {
        const share = shares[index] ?? 0;
        const mine = poll.mine === index;
        const resultLabel = withheld ? option.label : copy.result(option.label, share, option.votes ?? 0, total);
        const style = [styles.pollOption, { borderColor: mine ? theme.accent : theme.border, backgroundColor: theme.card }];
        const result = (
          <>
            {!withheld && <View style={[styles.pollFill, { width: `${share}%`, backgroundColor: mine ? theme.accent : theme.secondary }, grow(index)]} />}
            <View style={styles.pollOptionRow}>
              <Text style={[styles.pollOptionLabel, { color: theme.foreground }]}>{option.label}{mine ? '  ✓' : ''}</Text>
              {!withheld && <Text style={[styles.pollPct, { color: theme.mutedForeground }]}>{share}%</Text>}
            </View>
          </>
        );
        return closed ? (
          <View key={option.label} accessible accessibilityLabel={resultLabel} style={style}>{result}</View>
        ) : (
          <Pressable key={option.label} accessibilityRole="button" accessibilityState={{ selected: mine }}
            accessibilityLabel={copy.vote(resultLabel)} style={style}
            onPress={() => { if (!channelPollIsClosed(poll)) onVote(index); }}>
            {result}
          </Pressable>
        );
      })}</ArrivingBars>
      <Text style={[styles.pollMeta, { color: theme.mutedForeground }]}>
        {closed ? withheld ? copy.closed : copy.finalResults : poll.mine == null ? copy.prompt : copy.voted}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  poll: { borderWidth: StyleSheet.hairlineWidth, borderLeftWidth: 4, borderRadius: radii.sm, padding: spacing.md, gap: spacing.sm, maxWidth: 320 },
  pollLabelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  pollLabel: { fontSize: 10.5, lineHeight: 14, ...typeface.controlStrong, letterSpacing: 1 },
  pollQuestion: { fontSize: 15, lineHeight: 21, ...typeface.controlStrong },
  pollOption: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.sm, overflow: 'hidden', justifyContent: 'center' },
  pollFill: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  pollOptionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md },
  pollOptionLabel: { fontSize: 14, lineHeight: 19, ...typeface.controlStrong },
  pollPct: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  pollMeta: { fontSize: 11.5, lineHeight: 16 },
});
