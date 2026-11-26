import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import type { PulseCard } from '../lib/pulseCatalog';
import { loadPulseHistory } from '../services/pulseHistory';
import { useApp } from '../state/AppProvider';

// Weekly trend cards for the current hat. A failed read is reported as such,
// never as an empty or zero history; the preview workspace reads nothing.
export function usePulseHistory(hat: string, attempt: number, enabled = true) {
  const { mode, session } = useApp();
  const [state, setState] = useState<{ cards: PulseCard[]; failed: boolean }>({ cards: [], failed: false });
  useFocusEffect(useCallback(() => {
    setState({ cards: [], failed: false });
    if (!enabled || mode !== 'authenticated' || !session) return;
    let current = true;
    void loadPulseHistory(session, hat)
      .then((cards) => { if (current) setState({ cards, failed: false }); })
      .catch(() => { if (current) setState({ cards: [], failed: true }); });
    return () => { current = false; };
  }, [enabled, mode, session, hat, attempt]));
  return state;
}
