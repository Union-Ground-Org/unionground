import type { ExactSessionIdentity } from '../services/sessionResume';
import { accessTokensShareSessionLineage } from './sessionLineage';

/** A ref whose ownership changes only when its authenticated login changes. */
export function createAccountSessionIdentity() {
  let current: ExactSessionIdentity | null = null;
  let ownership = Symbol();
  return {
    get current(): ExactSessionIdentity | null { return current; },
    set current(next: ExactSessionIdentity | null) {
      const sameLogin = current !== null && next !== null
        && current.userID === next.userID
        && (current.accessToken === next.accessToken
          || accessTokensShareSessionLineage(current.accessToken, next.accessToken));
      if (!sameLogin) ownership = Symbol();
      current = next;
    },
    captureGuard(userID: string | null): () => boolean {
      const capturedOwnership = ownership;
      const authorized = userID !== null && current?.userID === userID;
      return () => authorized && ownership === capturedOwnership && current?.userID === userID;
    },
  };
}
