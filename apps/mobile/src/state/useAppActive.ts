import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

// Whether the app is in the foreground. The privacy cover labels itself only
// while active; in the background it stays blank for the app switcher.
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => setActive(next === 'active'));
    return () => subscription.remove();
  }, []);
  return active;
}
