import { Button, StateMessage } from './ui';

// The Account screen's fail-closed state when the dashboard is missing while
// the session is still live. It retries in place with the same user refresh
// Home offers (UX-UG-NATIVE-ACCOUNT-DETAILS-NO-RETRY-20261018).
export function AccountUnavailable({ refreshing, onRetry }: { refreshing: boolean; onRetry: () => void }) {
  return (
    <StateMessage
      title="Account details unavailable"
      body="You’re still signed in. Try again here, or sign out below."
      action={<Button label={refreshing ? 'Retrying…' : 'Try again'} disabled={refreshing} onPress={onRetry} />}
    />
  );
}
