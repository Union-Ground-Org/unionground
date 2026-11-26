import type { AppMode } from '../state/AppProvider';

export type WorkSurfaceState = 'signedOut' | 'mfaRequired' | 'loading' | 'refreshFailed' | 'ready';

type WorkSurfaceInput = {
  mode: AppMode;
  hasDashboard: boolean;
  refreshing: boolean;
};

/**
 * Resolves what the My work surface should present for the current session.
 *
 * A null dashboard is not automatically a signed-out session: an authenticated
 * (or preview) session can hold no dashboard while the initial load or a
 * chapter refresh is still in flight, or because that load failed. Those
 * sessions get loading / refresh-failure recovery guidance instead of
 * sign-in copy, and only genuinely signed-out or two-step-challenged sessions
 * keep authentication guidance.
 */
export function workSurfaceState(input: WorkSurfaceInput): WorkSurfaceState {
  if (input.mode === 'signedOut') return 'signedOut';
  if (input.mode === 'mfaRequired') return 'mfaRequired';
  if (input.hasDashboard) return 'ready';
  if (input.mode === 'booting' || input.refreshing) return 'loading';
  return 'refreshFailed';
}
