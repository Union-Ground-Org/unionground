import { AppState, type AppStateStatus } from 'react-native';

export type SupabaseAuthRefreshControl = {
  startAutoRefresh(): void;
  stopAutoRefresh(): void;
};

export function startSupabaseAuthRefreshLifecycle(auth: SupabaseAuthRefreshControl): () => void {
  let subscribed = true;

  const applyState = (state: AppStateStatus) => {
    if (!subscribed) return;
    if (state === 'active') auth.startAutoRefresh();
    else auth.stopAutoRefresh();
  };

  applyState(AppState.currentState);
  const subscription = AppState.addEventListener('change', applyState);

  return () => {
    subscribed = false;
    subscription.remove();
    auth.stopAutoRefresh();
  };
}
