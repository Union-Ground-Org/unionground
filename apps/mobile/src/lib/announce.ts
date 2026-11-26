import { useCallback, useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

// The one screen-reader announcement path in the app.
//
// `accessibilityLiveRegion` is Android-only, so every surface that relied on it
// alone was silent on iOS — the defect PR #1002 finding F1 filed against the
// transactional confirmation, and the same defect the #1021 rounds filed
// against the Be heard submit-condition line (follow-up 5). Both now speak
// through this function, so a third surface cannot land with a fourth
// behaviour.
//
// iOS interrupts: an unqueued announcement arriving while VoiceOver is still
// reading the control the member just pressed replaces it, and the arrival is
// the half of that pair worth keeping. Queueing waits for the current utterance
// instead of talking over it. The option is iOS-only — TalkBack has no queue
// argument, and the Android path is already the plain call.
// The coordinator flush is the ownership boundary; this platform sink has no
// component lifetime and is intentionally fire-and-forget once a batch wins.
export function announceForAccessibility(message: string): void {
  if (Platform.OS === 'ios') {
    AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
  } else {
    AccessibilityInfo.announceForAccessibility(message);
  }
}

type PendingAnnouncement = {
  message: string;
  attemptIdentity?: string | number;
  cancelled: boolean;
};

export type AnnouncementCoordinator = {
  enqueue: (message: string, attemptIdentity?: string | number) => () => void;
};

export function createAnnouncementCoordinator({
  announce,
  schedule = (flush) => { setTimeout(flush, 0); },
}: {
  announce: (message: string) => void;
  schedule?: (flush: () => void) => void;
}): AnnouncementCoordinator {
  let pending: PendingAnnouncement[] = [];
  let flushScheduled = false;

  const flush = () => {
    flushScheduled = false;
    const batch = pending;
    pending = [];

    const unique = new Map<string, PendingAnnouncement>();
    for (const item of batch) {
      if (item.cancelled) continue;
      const previous = unique.get(item.message);
      if (!previous || previous.attemptIdentity !== item.attemptIdentity) {
        // One utterance per message still wins within a render batch. Keeping
        // the newest attempt means an immediately superseded retry cannot lend
        // its ownership to the surviving item.
        unique.set(item.message, item);
      }
    }

    const next = [...unique.values()];
    if (next.length === 0) return;

    announce(next.map(({ message }) => message).join(' '));
  };

  return {
    enqueue(message, attemptIdentity) {
      const normalized = message.trim();
      if (!normalized) return () => {};
      const item: PendingAnnouncement = {
        message: normalized,
        ...(attemptIdentity === undefined ? {} : { attemptIdentity }),
        cancelled: false,
      };
      pending.push(item);
      if (!flushScheduled) {
        flushScheduled = true;
        schedule(flush);
      }
      return () => { item.cancelled = true; };
    },
  };
}

const sharedAnnouncementCoordinator = createAnnouncementCoordinator({
  announce: announceForAccessibility,
});

export function queueAccessibilityAnnouncement(
  message: string,
  attemptIdentity?: string | number,
): () => void {
  return sharedAnnouncementCoordinator.enqueue(message, attemptIdentity);
}

/**
 * Owns announcements issued by component callbacks.
 *
 * Every call is a distinct attempt, so identical retry outcomes are retained.
 * The latest pending item is cancelled when another attempt supersedes it, and
 * changing the owner identity or unmounting cancels feedback that no longer
 * belongs to the visible surface. A callback captured by an obsolete async
 * request is also refused after the owner changes.
 */
export function useAccessibilityAnnouncementQueue(
  ownerIdentity: string,
): (message: string) => () => void {
  const currentOwner = useRef(ownerIdentity);
  const active = useRef(true);
  const attempt = useRef(0);
  const cancelPending = useRef<(() => void) | null>(null);
  currentOwner.current = ownerIdentity;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      cancelPending.current?.();
      cancelPending.current = null;
    };
  }, [ownerIdentity]);

  return useCallback((message: string) => {
    if (!active.current || currentOwner.current !== ownerIdentity) return () => {};

    cancelPending.current?.();
    const cancelQueued = queueAccessibilityAnnouncement(
      message,
      `${ownerIdentity}:${++attempt.current}`,
    );
    const cancel = () => {
      cancelQueued();
      if (cancelPending.current === cancel) cancelPending.current = null;
    };
    cancelPending.current = cancel;
    return cancel;
  }, [ownerIdentity]);
}
