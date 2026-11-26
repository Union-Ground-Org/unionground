import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { useBusinessWriter, useBusinessState } from '../lib/useBusinessWriter';
// REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001 (CR-014): the native
// half of the reading-screen quick check. A screen calls useNativeContextualPulse
// with its registered context, passes onScroll to its Screen and renders
// <ContextualPulseCard pulse={...} />. Members only; English only (owner ruling).
import { useCallback, useEffect, useRef } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Body, Button, Card, Heading } from '../components/ui';
import {
  isProductPulseContext,
  normalizePulseDecision,
  pulseDecisionEndsSession,
  pulseSettings,
  pulseThresholdMet,
} from '../../../../src/features/engagement/contextualPulse.js';
import { optionLabel, optionValue } from '../../../../src/features/engagement/surveyModel.js';
import {
  evaluateNativePulse,
  loadPulseConfiguration,
  markNativePulseSessionUsed,
  nativePulseSessionUsed,
  respondNativePulse,
} from '../services/contextualPulse';

export type NativePulsePrompt = {
  eventId: string;
  question: string;
  options: unknown[];
};

export type NativeContextualPulse = {
  prompt: NativePulsePrompt | null;
  state: '' | 'saved' | 'dismissed' | 'failed';
  busy: boolean;
  onScrollProgress: (percent: number) => void;
  respond: (value: unknown, dismiss?: boolean) => Promise<void>;
};

// `live` is false in preview mode and wherever the screen is not a member
// reading surface; the hook then never calls the server. A new `scopeKey`
// (another question, another article) restarts the reading clock.
export function useNativeContextualPulse(contextKey: string, live: boolean, scopeKey = ''): NativeContextualPulse {
  const writer = useBusinessWriter();
  const [prompt, setPrompt] = useBusinessDraftState<NativePulsePrompt | null>(null);
  const [state, setState] = useBusinessDraftState<NativeContextualPulse['state']>('');
  const [busy, setBusy] = useBusinessState(false);
  const deepest = useRef(0);
  const checkRef = useRef<() => void>(() => undefined);
  const busyRef = useRef(false);

  useEffect(() => {
    setPrompt(null);
    setState('');
    deepest.current = 0;
    checkRef.current = () => undefined;
    if (!live || !isProductPulseContext(contextKey) || nativePulseSessionUsed()) return undefined;
    let cancelled = false;
    let asked = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // Reading time counts only while the app is in the foreground.
    let readMs = 0;
    let resumedAt: number | null = AppState.currentState === 'active' ? Date.now() : null;
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') resumedAt ??= Date.now();
      else if (resumedAt !== null) { readMs += Date.now() - resumedAt; resumedAt = null; }
    });
    const stop = (): void => {
      if (timer) clearInterval(timer);
      timer = null;
      appState.remove();
    };
    const readSeconds = (): number => Math.floor((readMs + (resumedAt === null ? 0 : Date.now() - resumedAt)) / 1000);
    void loadPulseConfiguration().then((configuration) => {
      if (cancelled) return;
      const settings = pulseSettings(configuration);
      if (!settings.enabled) { stop(); return; }
      const check = (): void => {
        if (asked || cancelled) return;
        const dwellSeconds = readSeconds();
        if (!pulseThresholdMet({ dwellSeconds, scrollPercent: deepest.current }, settings)) return;
        asked = true;
        stop();
        void evaluateNativePulse(writer, contextKey, dwellSeconds, deepest.current).then(async (value) => {
          if (await checkBusinessContinuation(writer, () => !cancelled) === 'changed') return;
          const decision = normalizePulseDecision(value);
          if (pulseDecisionEndsSession(decision)) markNativePulseSessionUsed();
          if (!cancelled && decision.eligible && decision.prompt) {
            setPrompt({ eventId: decision.prompt.eventId, question: decision.prompt.question, options: decision.prompt.options });
          }
        }).catch((): void => undefined);
      };
      checkRef.current = check;
      timer = setInterval(check, 1000);
    }).catch((): void => { stop(); });
    return () => {
      cancelled = true;
      checkRef.current = () => undefined;
      stop();
    };
  }, [contextKey, live, scopeKey, setPrompt, setState, writer]);

  const onScrollProgress = useCallback((percent: number) => {
    if (percent > deepest.current) {
      deepest.current = percent;
      checkRef.current();
    }
  }, []);

  const respond = useCallback(async (value: unknown, dismiss = false) => {
    if (!prompt || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setState('');
    try {
      await respondNativePulse(writer, prompt.eventId, value, dismiss);
      setPrompt(null);
      setState(dismiss ? 'dismissed' : 'saved');
    } catch {
      // The card stays so a failed write never looks like success.
      setState('failed');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [prompt, writer, setBusy, setState, setPrompt]);

  return { prompt, state, busy, onScrollProgress, respond };
}

export function ContextualPulseCard({ pulse }: { pulse: NativeContextualPulse }) {
  if (pulse.prompt) {
    const { prompt } = pulse;
    return (
      <Card>
        <Body muted>Quick check-in</Body>
        <Heading level={3}>{prompt.question}</Heading>
        <View style={styles.options}>
          {prompt.options.map((option) => (
            <Button
              key={String(optionValue(option))}
              label={String(optionLabel(option))}
              variant="secondary"
              disabled={pulse.busy}
              onPress={() => { void pulse.respond(optionValue(option)); }}
            />
          ))}
        </View>
        <Button label="Not now" variant="secondary" disabled={pulse.busy} onPress={() => { void pulse.respond(null, true); }} />
        {pulse.state === 'failed' ? <Body accessibilityRole="alert">Your answer could not be saved. Try again.</Body> : null}
      </Card>
    );
  }
  if (pulse.state === 'saved' || pulse.state === 'dismissed') {
    return <Body muted accessibilityRole="text">{pulse.state === 'saved' ? 'Thanks. Your answer was saved.' : 'Quick check dismissed.'}</Body>;
  }
  return null;
}

const styles = StyleSheet.create({
  options: { gap: 8 },
});
