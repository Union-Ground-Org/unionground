// REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009: Account > Sessions on
// both native platforms. The list is the server's answer and nothing else:
// there is no cached copy, no local reconstruction, and no state in which an
// unreadable list is drawn as an empty one. "Sign out everywhere" takes an
// explicit second press, then hands the account-wide revoke to the existing
// sign-out path (scope `global`), which revokes every server session, clears
// this device's protected state and returns the app to sign-in. A failure
// leaves the member signed in and says so.
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { Body, Button, Card, Group, GroupRow, Heading } from '../components/ui';
import {
  memberSessionAccessibilityLabel,
  memberSessionDetail,
  memberSessionTitle,
  memberSessionsCopy,
  memberSessionsFailureMessage,
  type MemberSessionRow,
} from '../lib/memberSessionInventory';
import {
  MemberSessionsUnavailableError,
  loadMemberSessions,
  type MemberSessionsFailureKind,
} from '../services/memberSessions';
import { useNativeUi } from '../lib/useNativeUi';
import { useApp } from '../state/AppProvider';

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; rows: MemberSessionRow[] }
  | { status: 'failed'; kind: MemberSessionsFailureKind };

export function NativeSessionsCard() {
  const { mode, session, signOut, signOutError, signOutBusy, sampleEntryBusy, retrySessionAuthentication } = useApp();
  // The saved member language (#8303); the session rules below are unchanged.
  const { language, catalogLabel } = useNativeUi();
  const MEMBER_SESSIONS_COPY = memberSessionsCopy(language);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // The confirm press that started the sign-out is the only one that may end
  // the card's working state; a second tap before the re-render is ignored.
  const signOutStarted = useRef(false);
  // Re-authentication runs at most once per account while the card is mounted
  // and is not an effect dependency: 42501 also means an unsatisfied second
  // factor, where revalidation keeps the session, and a reload on every new
  // callback identity would loop.
  const reauthenticate = useRef(retrySessionAuthentication);
  reauthenticate.current = retrySessionAuthentication;
  const reauthenticationRequested = useRef<string | null>(null);
  // The PIN/step-up session cannot read or revoke sessions: the server's
  // session RPCs require a satisfied second factor, so offering the controls
  // here would only produce a refusal. The step-up prompt beside this card is
  // the honest route.
  const enabled = mode === 'authenticated';

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    const userID = session?.user.id ?? null;
    setExpanded(false);
    setState({ status: 'loading' });
    loadMemberSessions().then((rows) => {
      if (active) setState({ status: 'ready', rows });
    }).catch((error: unknown) => {
      if (!active) return;
      const kind = error instanceof MemberSessionsUnavailableError ? error.kind : 'transport';
      setState({ status: 'failed', kind });
      // The server no longer accepts this device's session: another device
      // signed out everywhere, or it was revoked or expired. That is a server
      // validation failing, so hand it to the provider's re-authentication
      // path, which covers protected content and returns a dead session to
      // sign-in, instead of leaving the authenticated shell on screen.
      if (kind === 'denied' && reauthenticationRequested.current !== userID) {
        // The latch is claimed before the call so two refused reads in flight
        // cannot both revalidate, and released again when the provider reports
        // it refused — a sign-out owns the session, so nothing ran and the
        // account's one revalidation has not been spent. Without the release a
        // 42501 list answer arriving during a sign-out would consume the latch
        // and the next refused read would leave the authenticated shell on
        // screen with no revalidation at all
        // (REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009).
        reauthenticationRequested.current = userID;
        void reauthenticate.current().then((revalidated) => {
          if (!revalidated && reauthenticationRequested.current === userID) {
            reauthenticationRequested.current = null;
          }
        }).catch(() => undefined);
      }
    });
    return () => { active = false; };
  }, [enabled, session?.user.id, revision]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  const signOutEverywhere = useCallback(async () => {
    if (signOutStarted.current) return;
    signOutStarted.current = true;
    setWorking(true);
    try {
      // The sign-out path owns both the server revoke and the local teardown,
      // and it reports its own failure through `signOutError`. It never throws
      // a success, so nothing here may claim one.
      await signOut({ scope: 'global' });
    } finally {
      signOutStarted.current = false;
      setWorking(false);
      setConfirming(false);
    }
  }, [signOut]);

  if (!enabled) return null;
  const busy = working || signOutBusy || sampleEntryBusy;
  // Keep the server-designated current device visible even for an unsorted
  // answer. Expansion affects presentation only; no sessions are discarded.
  const orderedRows = state.status === 'ready'
    ? [...state.rows].sort((left, right) => Number(right.current) - Number(left.current))
    : [];
  const visibleRows = expanded ? orderedRows : orderedRows.slice(0, 3);
  return (
    <Card>
      <Heading level={3}>{MEMBER_SESSIONS_COPY.title}</Heading>
      <Body muted>{MEMBER_SESSIONS_COPY.body}</Body>
      {state.status === 'loading' ? (
        <View accessibilityLiveRegion="polite">
          <Body accessibilityRole="progressbar" muted>{MEMBER_SESSIONS_COPY.loading}</Body>
        </View>
      ) : null}
      {state.status === 'failed' ? (
        <View accessibilityLiveRegion="polite">
          <Heading level={3}>{MEMBER_SESSIONS_COPY.failureTitle}</Heading>
          <Body accessibilityRole="alert">{memberSessionsFailureMessage(state.kind, language)}</Body>
          <Button label={MEMBER_SESSIONS_COPY.retry} variant="secondary" disabled={busy} onPress={reload} />
        </View>
      ) : null}
      {state.status === 'ready' && state.rows.length === 0 ? (
        <View accessibilityLiveRegion="polite">
          <Body muted>{MEMBER_SESSIONS_COPY.emptyBody}</Body>
        </View>
      ) : null}
      {state.status === 'ready' ? (
        <Button label={MEMBER_SESSIONS_COPY.refresh} variant="secondary" disabled={busy} onPress={reload} />
      ) : null}
      {confirming ? (
        <View accessibilityLiveRegion="polite">
          <Heading level={3}>{MEMBER_SESSIONS_COPY.confirmTitle}</Heading>
          <Body>{MEMBER_SESSIONS_COPY.confirmBody}</Body>
          <Button
            label={busy ? MEMBER_SESSIONS_COPY.working : MEMBER_SESSIONS_COPY.confirmAction}
            variant="danger"
            busy={busy}
            disabled={busy}
            onPress={() => { void signOutEverywhere(); }}
          />
          <Button
            label={MEMBER_SESSIONS_COPY.confirmCancel}
            variant="secondary"
            disabled={busy}
            onPress={() => setConfirming(false)}
          />
        </View>
      ) : (
        <Button
          label={MEMBER_SESSIONS_COPY.signOutEverywhere}
          variant="danger"
          disabled={busy}
          onPress={() => setConfirming(true)}
        />
      )}
      {/* The sign-out path's own refusal. It is shown here too so a member who
          pressed "Sign out everywhere" reads the outcome at the control they
          used, and it never overwrites the list's failure line. */}
      {signOutError ? (
        <View accessibilityLiveRegion="polite">
          <Body accessibilityRole="alert">{catalogLabel(signOutError)}</Body>
        </View>
      ) : null}
      {state.status === 'ready' && state.rows.length > 0 ? (
        <Group>
          {visibleRows.map((row, index) => (
            <GroupRow key={row.handle} last={index === visibleRows.length - 1} highlight={false}>
              {/* One accessible item per session: the row speaks its device,
                  its browser, whether it is this device and its last use. The
                  opaque handle is a React key only and is never spoken or
                  drawn. */}
              <View accessible accessibilityLabel={memberSessionAccessibilityLabel(row, language)}>
                <Body>{memberSessionTitle(row, language)}</Body>
                <Body muted>{memberSessionDetail(row, language)}</Body>
              </View>
            </GroupRow>
          ))}
        </Group>
      ) : null}
      {orderedRows.length > 3 ? (
        <Button
          label={expanded ? MEMBER_SESSIONS_COPY.collapse : MEMBER_SESSIONS_COPY.showMore}
          variant="secondary"
          disabled={busy}
          onPress={() => setExpanded((value) => !value)}
        />
      ) : null}
    </Card>
  );
}
