import { captureSessionWriter } from '../src/services/supabase';
import { Redirect, Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, BackHandler, Platform, Pressable, StyleSheet, View, type AppStateStatus } from 'react-native';
import { Text, TextInput } from '../src/components/Text';

import { PinnedHeaderScreen } from '../src/components/PinnedHeader';
import { Body, Button, Card, Heading, Screen, StateMessage } from '../src/components/ui';
import { queueAccessibilityAnnouncement } from '../src/lib/announce';
import { explicitLiveStaffHat } from '../src/lib/hatFunctions';
import {
  acknowledgePendingSharedAttachmentUpload,
  beginPendingSharedAttachmentUpload,
  captureSecureShareCleanupBoundary,
  createShareUploadPresentationGate,
  discardAllPendingSharedAttachments,
  discardPendingSharedAttachment,
  discardPendingSharedAttachmentCreatedAtOrBefore,
  getPendingSharedAttachmentUpload,
  isStaffTaskAttachmentRole,
  loadAuthorizedShareTargets,
  markSecureShareStagingCleanupRequired,
  readPendingSharedAttachment,
  readPendingSharedAttachmentUploadRecovery,
  reconcilePendingSharedAttachmentUploadRecovery,
  shareUploadAllowsReshare,
  ShareIntakeError,
  withDistinctGuidance,
  type AuthorizedShareTarget,
  type PendingSharedAttachment,
  type PendingSharedAttachmentUploadOperation,
  type PendingSharedAttachmentUploadRecovery,
  type SecureShareCleanupBoundary,
} from '../src/services/secureShareIntake';
import { haptics } from '../src/services/haptics';
import { useApp } from '../src/state/AppProvider';
import { useTheme } from '../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../src/theme/tokens';

import { typeface } from '../src/theme/typeface';
import { useBusinessOperation, useBusinessRequestOwner } from '../src/lib/useBusinessWriter';
import { useNativeUi } from '../src/lib/useNativeUi';
export default function ShareIntakeScreen() {
  const { session } = useApp();
  const owner = useBusinessRequestOwner();
  return <OwnedShareIntakeScreen key={`${session?.user.id ?? 'signed-out'}:${owner.workspace}`} />;
}

function OwnedShareIntakeScreen() {
  const { catalogLabel, t } = useNativeUi();
  const router = useRouter();
  const theme = useTheme();
  const { authorizedRoles, locked, mode, privacyCovered, signOut, session } = useApp();
  const [pending, setPendingState] = useState<PendingSharedAttachment | null>(null);
  const pendingRef = useRef<PendingSharedAttachment | null>(null);
  const committed = useRef(false);
  const uploadCompleted = useRef(false);
  const uploadAttempted = useRef(false);
  const interrupted = useRef(false);
  const interruptedCleanupBoundary = useRef<SecureShareCleanupBoundary | null>(null);
  const loadGeneration = useRef(0);
  const observedActive = useRef(AppState.currentState === 'active');
  const mounted = useRef(true);
  const observedUploadID = useRef<string | null>(null);
  const recoveryInFlight = useRef(0);
  const recoveryBlocked = useRef(true);
  const recoveredUpload = useRef<Pick<PendingSharedAttachmentUploadRecovery, 'attachmentID' | 'target' | 'token'> | null>(null);
  const [uploadPresentationGate] = useState(() => createShareUploadPresentationGate(false));
  const [foregroundReady, setForegroundReady] = useState(observedActive.current);
  const [foregroundEpoch, setForegroundEpoch] = useState(0);
  const [targets, setTargets] = useState<AuthorizedShareTarget[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [cleanupRequired, setCleanupRequired] = useState(false);
  const [remoteCleanupUnconfirmed, setRemoteCleanupUnconfirmed] = useState(false);
  const [retryRequiresReshare, setRetryRequiresReshare] = useState(false);
  // DECISIONS E4: authorize_private_upload_inspection requires a satisfied MFA
  // session for every kind, with no share-sheet carve-out. The share sheet is
  // the entry point where that session is most likely stale, so a refusal of
  // the SESSION is surfaced as a re-auth prompt rather than the generic
  // interruption copy — every retry would otherwise fail identically and the
  // worker would never be told why. It stays fail-closed either way: nothing is
  // confirmed, nothing is aborted, and the durable recovery marker is kept.
  const [reauthRequired, setReauthRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runOperation] = useBusinessOperation<boolean>(setBusy, false);
  const [loadRequested, setLoadRequested] = useState(true);
  const liveStaffHat = mode === 'authenticated' ? explicitLiveStaffHat(authorizedRoles) : null;
  const safeToPresentUpload = mode === 'authenticated' && !locked && !privacyCovered && foregroundReady;

  const setCurrentPending = useCallback((next: PendingSharedAttachment | null) => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);

  useEffect(() => {
    uploadPresentationGate.setReady(safeToPresentUpload);
  }, [safeToPresentUpload, uploadPresentationGate]);

  const completePresentedUpload = useCallback(async (
    operation: Pick<PendingSharedAttachmentUploadOperation, 'attachmentID' | 'target' | 'token'>,
  ): Promise<boolean> => {
    if (!mounted.current) return false;
    try {
      if (!await acknowledgePendingSharedAttachmentUpload(operation.attachmentID)) return false;
    } catch (error) {
      if (!mounted.current) return false;
      recoveryBlocked.current = true;
      recoveredUpload.current = recoveredUpload.current ?? {
        attachmentID: operation.attachmentID,
        target: operation.target,
        token: operation.token,
      };
      uploadCompleted.current = true;
      setCleanupRequired(true);
      const message = error instanceof Error
        ? error.message
        : 'The attachment is uploaded, but its protected recovery marker still needs cleanup.';
      setUploadError(message);
      void haptics.warning();
      return false;
    }
    // Acknowledgement can yield after its owner check while native cleanup runs.
    // A retired owner's router and accessibility queue are global effects.
    if (!mounted.current) return false;
    committed.current = true;
    recoveryBlocked.current = false;
    uploadCompleted.current = false;
    uploadAttempted.current = false;
    setCleanupRequired(false);
    setRemoteCleanupUnconfirmed(false);
    setRetryRequiresReshare(false);
    setCurrentPending(null);
    const message = 'Shared attachment uploaded securely.';
    queueAccessibilityAnnouncement(message);
    void haptics.success();
    router.replace((operation.target.kind === 'case'
      ? `/issue/${operation.target.id}`
      : '/feature/tasks') as never);
    return true;
  }, [router, setCurrentPending]);

  const observeUploadOperation = useCallback(async (operation: PendingSharedAttachmentUploadOperation) => {
    if (observedUploadID.current === operation.attachmentID) return;
    observedUploadID.current = operation.attachmentID;
    uploadAttempted.current = true;
    setLoadingError(null);
    setUploadError(null);
    setReauthRequired(false);
    const settlement = await uploadPresentationGate.waitForSettlement(operation.settlement);
      const currentUpload = getPendingSharedAttachmentUpload(session?.user.id);
      if (!mounted.current
        || (currentUpload && currentUpload.attachmentID !== operation.attachmentID)) return;
      if (settlement.status === 'uploaded') {
        await completePresentedUpload(operation);
        return;
      }

      let error = settlement.error;
      const cleanupOnly = error.code === 'cleanup';
      let reshareAllowed = shareUploadAllowsReshare(error);
      if (reshareAllowed) {
        try {
          reshareAllowed = await acknowledgePendingSharedAttachmentUpload(operation.attachmentID);
          if (!mounted.current) return;
          if (reshareAllowed) recoveryBlocked.current = false;
        } catch (cleanupFailure) {
          reshareAllowed = false;
          recoveryBlocked.current = true;
          error = cleanupFailure instanceof ShareIntakeError
            ? cleanupFailure
            : new ShareIntakeError(
              'remote-cleanup',
              'The upload recovery marker could not be cleared. Keep this item blocked and try recovery again.',
            );
        }
      }
      if (!reshareAllowed) {
        recoveryBlocked.current = true;
        recoveredUpload.current = operation;
        setCurrentPending(null);
      }
      uploadCompleted.current = cleanupOnly;
      setCleanupRequired(cleanupOnly);
      setRemoteCleanupUnconfirmed(!cleanupOnly && !reshareAllowed);
      setRetryRequiresReshare(reshareAllowed);
      setReauthRequired(error.reauthRequired);
      const message = cleanupOnly || !reshareAllowed
        ? error.message
        : 'The upload could not be completed. Share the item to Union Ground again before retrying.';
      setUploadError(message);
      void haptics.warning();
  }, [completePresentedUpload, setCurrentPending, uploadPresentationGate]);

  const abandon = useCallback(async (message?: string) => {
    if (busy || !mounted.current) return;
    await runOperation(true, async () => {
    const current = pendingRef.current;
    const lifecycleCleanupBoundary = captureSecureShareCleanupBoundary();
    try {
      if (current) await discardPendingSharedAttachment(current.token);
      else await discardPendingSharedAttachmentCreatedAtOrBefore(lifecycleCleanupBoundary);
    } catch (error) {
      if (!mounted.current) return;
      const cleanupMessage = error instanceof Error
        ? error.message
        : 'The local staged copy could not be cleared. Keep Union Ground open and try again.';
      if (loadingError === cleanupMessage) {
        queueAccessibilityAnnouncement(cleanupMessage);
      }
      setLoadingError(cleanupMessage);
      return;
    }
    if (!mounted.current) return;
    committed.current = true;
    uploadCompleted.current = false;
    uploadAttempted.current = false;
    setCleanupRequired(false);
    setRemoteCleanupUnconfirmed(false);
    setRetryRequiresReshare(false);
    setCurrentPending(null);
    if (message) {
      setLoadingError(message);
      return;
    }
    router.replace('/(tabs)/home' as never);
    });
  // runOperation's lock and setter stay stable for this user/workspace key.
  }, [busy, loadingError, router, setCurrentPending]);

  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void abandon();
      return true;
    });
    return () => subscription.remove();
  }, [abandon]));

  useEffect(() => {
    loadGeneration.current += 1;
    setTargets(null);
    setSelectedKey(null);
    setLoadRequested(true);
  }, [foregroundEpoch, foregroundReady, liveStaffHat, locked, mode, privacyCovered]);
  useEffect(() => {
    if (mode === 'preview') {
      const previewCleanupGeneration = ++loadGeneration.current;
      void discardAllPendingSharedAttachments(
        () => loadGeneration.current === previewCleanupGeneration,
      )
        .then(() => {
          if (loadGeneration.current === previewCleanupGeneration) {
            router.replace('/(tabs)/home' as never);
          }
        })
        .catch((error: unknown) => {
          if (loadGeneration.current === previewCleanupGeneration) {
            setLoadingError(error instanceof Error ? error.message : 'The local staged copy could not be cleared.');
          }
        });
      return () => {
        if (loadGeneration.current === previewCleanupGeneration) loadGeneration.current += 1;
      };
    }
    if (mode !== 'authenticated' || locked || privacyCovered || !foregroundReady || interrupted.current) return;
    if (busy || !loadRequested) return;
    setLoadRequested(false);
    const activeUpload = getPendingSharedAttachmentUpload(session?.user.id);
    if (activeUpload && recoveredUpload.current?.attachmentID !== activeUpload.attachmentID) {
      void runOperation(true, async () => observeUploadOperation(activeUpload));
      return;
    }
    const generation = ++loadGeneration.current;
    const loadCleanupBoundary = captureSecureShareCleanupBoundary();
    committed.current = false;
    uploadCompleted.current = false;
    uploadAttempted.current = false;
    setCleanupRequired(false);
    setRemoteCleanupUnconfirmed(false);
    setRetryRequiresReshare(false);
    setReauthRequired(false);
    setCurrentPending(null);
    setTargets(null);
    setSelectedKey(null);
    setQuery('');
    setLoadingError(null);
    setUploadError(null);
    recoveryInFlight.current += 1;
    recoveryBlocked.current = true;
    void runOperation(true, async () => {
      const writer = captureSessionWriter(session);
      let recoveryChecked = false;
      try {
        if (await writer.check() !== 'current') throw new Error(t('The shared item could not be refreshed. Try again when your connection returns.'));
        if (!mounted.current || generation !== loadGeneration.current) return;
        const recovery = await readPendingSharedAttachmentUploadRecovery(captureSessionWriter(session));
        if (generation !== loadGeneration.current) return;
        recoveryChecked = true;
        recoveryBlocked.current = recovery !== null;
        if (recovery) {
          recoveredUpload.current = recovery;
          const recovered = await reconcilePendingSharedAttachmentUploadRecovery(captureSessionWriter(session));
          if (generation !== loadGeneration.current) return;
          if (recovered.status === 'reauth-required') {
            // The marker is deliberately NOT acknowledged: the upload is still
            // pending and still recoverable once the session is verified.
            uploadAttempted.current = true;
            setReauthRequired(true);
            setRemoteCleanupUnconfirmed(true);
            setTargets([]);
            setLoadingError('Verify it is you to finish checking the interrupted attachment upload. Nothing has been attached.');
            return;
          }
          if (recovered.status === 'uncertain') {
            uploadAttempted.current = true;
            setRemoteCleanupUnconfirmed(true);
            setTargets([]);
            setLoadingError('An interrupted attachment upload is still being reconciled. No new upload is permitted until its exact result is known.');
            return;
          }
          if (recovered.status === 'uploaded') {
            await uploadPresentationGate.waitUntilReady();
            if (generation !== loadGeneration.current || !mounted.current) return;
            await completePresentedUpload(recovery);
            return;
          }
          await acknowledgePendingSharedAttachmentUpload(recovery.attachmentID);
          if (!mounted.current || generation !== loadGeneration.current) return;
          if (recovered.status === 'rejected') {
            // The rollback is already proven, so sharing is unblocked; the
            // worker is still told the file was refused rather than silently
            // finding nothing attached.
            setUploadError('This file was rejected by the safety check and was not attached.');
          }
          if (recovered.status === 'cleanup-queued') {
            setUploadError('This file was not attached. Its temporary upload is being removed.');
          }
          recoveredUpload.current = null;
          recoveryBlocked.current = false;
        }

        if (await writer.check() !== 'current') throw new Error(t('The shared item could not be refreshed. Try again when your connection returns.'));
        if (!mounted.current || generation !== loadGeneration.current) return;
        const [nextPending, nextTargets] = await Promise.all([
          readPendingSharedAttachment(),
          loadAuthorizedShareTargets({
            coordinatorAccess: liveStaffHat === 'coordinator',
            staffTaskAccess: liveStaffHat ? isStaffTaskAttachmentRole([liveStaffHat]) : false,
          }),
        ]);
        if (generation !== loadGeneration.current) return;
        if (interrupted.current) {
          interrupted.current = true;
          setCurrentPending(null);
          setTargets([]);
          if (nextPending) {
            void discardPendingSharedAttachment(nextPending.token).then(() => {
              if (!mounted.current || generation !== loadGeneration.current) return;
              committed.current = true;
            }).catch((error) => {
              if (!mounted.current || generation !== loadGeneration.current) return;
              setLoadingError(error instanceof Error ? error.message : 'The local staged copy could not be cleared.');
            });
          }
          return;
        }
        setCurrentPending(nextPending);
        setTargets(nextTargets);
        if (!nextPending) setLoadingError('That shared item is no longer available. Share it to Union Ground again.');
      } catch (error) {
        if (generation !== loadGeneration.current) return;
        let message = error instanceof Error ? error.message : 'The shared item could not be loaded securely.';
        if (error instanceof ShareIntakeError && error.code === 'cleanup' && recoveredUpload.current) {
          uploadCompleted.current = true;
          setCleanupRequired(true);
          setUploadError(message);
          setTargets([]);
          return;
        }
        if (!recoveryChecked) {
          setRemoteCleanupUnconfirmed(true);
        } else {
          try {
            await discardPendingSharedAttachmentCreatedAtOrBefore(loadCleanupBoundary);
            if (!mounted.current || generation !== loadGeneration.current) return;
            committed.current = true;
          } catch (cleanupFailure) {
            message = cleanupFailure instanceof Error ? cleanupFailure.message : 'The local staged copy could not be cleared.';
          }
        }
        if (generation !== loadGeneration.current) return;
        setLoadingError(message);
        setTargets([]);
      } finally {
        recoveryInFlight.current = Math.max(0, recoveryInFlight.current - 1);
      }
    });
  }, [busy, completePresentedUpload, foregroundEpoch, foregroundReady, liveStaffHat, loadRequested, locked, mode, observeUploadOperation, privacyCovered, router, runOperation, setCurrentPending, uploadPresentationGate]);

  useEffect(() => {
    function observeAppState(state: AppStateStatus | null) {
      if (state === 'active') {
        const returningToForeground = !observedActive.current;
        observedActive.current = true;
        if (returningToForeground) {
          committed.current = false;
          if (interrupted.current) {
            const cleanupBoundary = interruptedCleanupBoundary.current
              ?? captureSecureShareCleanupBoundary();
            interruptedCleanupBoundary.current = cleanupBoundary;
            setForegroundReady(false);
            void discardPendingSharedAttachmentCreatedAtOrBefore(cleanupBoundary).then(() => {
              if (!mounted.current || interruptedCleanupBoundary.current !== cleanupBoundary) return;
              interrupted.current = false;
              interruptedCleanupBoundary.current = null;
              committed.current = true;
              setForegroundReady(true);
              setForegroundEpoch((current) => current + 1);
            }).catch((error: unknown) => {
              if (!mounted.current || interruptedCleanupBoundary.current !== cleanupBoundary) return;
              setLoadingError(error instanceof Error ? error.message : 'The local staged copy could not be cleared.');
            });
            return;
          }
          setForegroundEpoch((current) => current + 1);
        }
        setForegroundReady(true);
        return;
      }
      const leavingForeground = observedActive.current;
      observedActive.current = false;
      setForegroundReady(false);
      uploadPresentationGate.setReady(false);
      if (!leavingForeground || committed.current) return;
      if (getPendingSharedAttachmentUpload(session?.user.id) || recoveryInFlight.current || recoveryBlocked.current) return;
      const message = 'The shared item was discarded when Union Ground left the foreground. Share it again when you are ready.';
      const current = pendingRef.current;
      const lifecycleCleanupBoundary = captureSecureShareCleanupBoundary();
      interruptedCleanupBoundary.current = lifecycleCleanupBoundary;
      loadGeneration.current += 1;
      interrupted.current = true;
      setCurrentPending(null);
      setLoadingError(message);
      void (current
        ? discardPendingSharedAttachment(current.token)
        : discardPendingSharedAttachmentCreatedAtOrBefore(lifecycleCleanupBoundary)).then(() => {
          if (!mounted.current || interruptedCleanupBoundary.current !== lifecycleCleanupBoundary) return;
          // Keep the original capture until foreground recovery consumes it.
          // Recapturing on return could include a newer OS share staged while
          // this screen was away, even though the old cleanup already finished.
          committed.current = true;
        }).catch((error: unknown) => {
          if (!mounted.current || interruptedCleanupBoundary.current !== lifecycleCleanupBoundary) return;
          setLoadingError(error instanceof Error ? error.message : 'The local staged copy could not be cleared.');
        });
    }
    const subscription = AppState.addEventListener('change', observeAppState);
    observeAppState(AppState.currentState);
    return () => subscription.remove();
  }, [setCurrentPending, uploadPresentationGate]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadGeneration.current += 1;
      uploadPresentationGate.setReady(false);
      const current = pendingRef.current;
      const lifecycleCleanupBoundary = captureSecureShareCleanupBoundary();
      if (!committed.current) {
        void (current
          ? discardPendingSharedAttachment(current.token)
          : discardPendingSharedAttachmentCreatedAtOrBefore(lifecycleCleanupBoundary)).catch(() => {
            if (current) markSecureShareStagingCleanupRequired(current.token);
          });
      }
    };
  }, [uploadPresentationGate]);

  const filteredTargets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return targets ?? [];
    return (targets ?? []).filter((target) => (
      `${target.label} ${target.title} ${target.meta}`.toLocaleLowerCase().includes(normalized)
    ));
  }, [query, targets]);
  const selected = targets?.find((target) => targetKey(target) === selectedKey) ?? null;
  const uploadErrorGuidance = cleanupRequired
    ? 'The upload is complete. Retry only local cleanup; Union Ground will not upload the file again.'
    : remoteCleanupUnconfirmed
      ? 'Upload is blocked until you return to the record and confirm its current attachment list.'
      : 'Share the item to Union Ground again before retrying.';
  const uploadErrorBody = uploadError ? withDistinctGuidance(uploadError, uploadErrorGuidance) : null;

  async function upload() {
    if (!mounted.current || busy) return;
    await runOperation(true, async () => {
    const activeUpload = getPendingSharedAttachmentUpload(session?.user.id);
    if (cleanupRequired) {
      const completion = activeUpload ?? recoveredUpload.current;
      if (!completion || busy) return;
      setUploadError(null);
      try {
        await discardPendingSharedAttachment(completion.token);
        if (!mounted.current) return;
        await completePresentedUpload(completion);
      } catch (error) {
        if (!mounted.current) return;
        const message = error instanceof Error
          ? error.message
          : 'The local staged copy could not be cleared. Keep Union Ground open and try again.';
        setUploadError(message);
        void haptics.warning();
      }
      return;
    }

    if (!pending || !selected || busy || uploadAttempted.current) return;
    setUploadError(null);
    setReauthRequired(false);
    uploadAttempted.current = true;
    try {
      const operation = beginPendingSharedAttachmentUpload(
        { kind: selected.kind, id: selected.id },
        pending.token,
        captureSessionWriter(session),
      );
      await observeUploadOperation(operation);
    } catch (error) {
      const reshareAllowed = shareUploadAllowsReshare(error);
      if (!reshareAllowed) recoveryBlocked.current = true;
      setRemoteCleanupUnconfirmed(!reshareAllowed);
      setRetryRequiresReshare(reshareAllowed);
      const message = reshareAllowed
        ? 'The upload could not be completed. Share the item to Union Ground again before retrying.'
        : error instanceof Error
          ? error.message
          : 'The upload state could not be confirmed. Refresh the record before sharing again.';
      setUploadError(message);
      void haptics.warning();
    }
    });
  }

  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <PinnedHeaderScreen title="Save attachment" onBack={() => { void abandon(); }}>
        <Screen>
          <Heading>{catalogLabel("Save shared attachment")}</Heading>
          <Body muted>Choose one record you can currently access. Nothing uploads until you confirm.</Body>

          {mode === 'booting' || locked || privacyCovered ? (
            <StateMessage title="Checking authorization" body="Verifying the shared item and current record access." />
          ) : reauthRequired ? (
            <StateMessage
              title="Verify it is you"
              body={uploadError ?? loadingError ?? 'Your secure session expired before this file could be checked. Nothing was attached.'}
              action={(
                <View style={styles.actions}>
                  <Button label="Verify and continue" onPress={() => {
                    router.push({
                      pathname: '/mfa-challenge',
                      params: { forceReverify: '1', resume: 'share-intake' },
                    });
                  }} />
                  <Button label="Sign out instead" variant="secondary" disabled={busy} onPress={() => { void signOut(); }} testID="native-security-sign-out" />
                </View>
              )}
            />
          ) : cleanupRequired && recoveredUpload.current && !pending ? (
            <StateMessage
              title="Attachment uploaded"
              body={uploadError ?? 'The protected recovery marker still needs cleanup before this upload can close.'}
              action={<Button label="Try protected cleanup again" busy={busy} onPress={() => { void upload(); }} />}
            />
          ) : remoteCleanupUnconfirmed && recoveredUpload.current && !pending ? (
            <StateMessage
              title="Checking interrupted upload"
              body={loadingError ?? 'No new upload is permitted until the exact prior result is known.'}
              action={<Button label={busy ? t('Checking…') : 'Check exact upload again'} disabled={busy} onPress={() => {
                setLoadingError(null);
                setTargets(null);
                setForegroundEpoch((current) => current + 1);
              }} />}
            />
          ) : targets === null && !loadingError ? (
            <StateMessage title="Checking authorization" body="Verifying the shared item and current record access." />
          ) : loadingError || !pending ? (
            <StateMessage
              title="Shared item unavailable"
              body={loadingError ?? 'Share the document or image to Union Ground again.'}
              action={<View style={styles.actions}><Button label="Return home" disabled={busy} onPress={() => { void abandon(); }} /><Button label={busy ? t('Refreshing shared item…') : t('Refresh shared item')} disabled={busy} onPress={() => { setForegroundEpoch(current => current + 1); }} /></View>}
            />
          ) : (
            <>
              <Card>
                <Text style={[styles.eyebrow, { color: theme.primary }]}>READY FOR REVIEW</Text>
                <Heading level={3}>{pending.candidate.filename}</Heading>
                <Body muted>{formatMime(pending.candidate.mimeType)} · {formatBytes(pending.candidate.sizeBytes)}</Body>
                <Body muted>Local staging expires within five minutes and is deleted if this screen closes or leaves the foreground.</Body>
              </Card>

              <Heading level={2}>Authorized destination</Heading>
              <TextInput
                accessibilityLabel="Filter authorized attachment destinations"
                autoCapitalize="none"
                value={query}
                onChangeText={setQuery}
                placeholder="Filter issues and tasks"
                placeholderTextColor={theme.quietForeground}
                style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]}
              />
              {filteredTargets.length ? filteredTargets.map((target) => {
                const key = targetKey(target);
                const checked = key === selectedKey;
                return (
                  <Pressable
                    key={key}
                    accessibilityRole="radio"
                    accessibilityState={{ checked, disabled: busy }}
                    disabled={busy}
                    onPress={() => setSelectedKey(key)}
                    style={({ pressed }) => [
                      styles.target,
                      {
                        backgroundColor: checked ? theme.secondary : theme.card,
                        borderColor: checked ? theme.ring : theme.border,
                        opacity: pressed ? 0.82 : 1,
                      },
                    ]}
                  >
                    <View style={styles.targetCopy}>
                      <Text style={[styles.targetLabel, { color: theme.primary }]}>{target.label} · {target.kind === 'case' ? 'ISSUE' : 'TASK'}</Text>
                      <Text style={[styles.targetTitle, { color: theme.cardForeground }]}>{target.title}</Text>
                      <Body muted>{target.meta}</Body>
                    </View>
                    <View style={[styles.radio, { borderColor: checked ? theme.primary : theme.border }]}>
                      {checked ? <View style={[styles.radioFill, { backgroundColor: theme.primary }]} /> : null}
                    </View>
                  </Pressable>
                );
              }) : (
                <StateMessage
                  title={targets?.length ? 'No matching destinations' : 'No writable destinations'}
                  body={targets?.length
                    ? 'Clear the filter to restore your authorized list.'
                    : 'Your current account has no issue or task that accepts this attachment.'}
                />
              )}

              {uploadErrorBody ? <StateMessage compact title="Attachment needs attention" body={uploadErrorBody} /> : null}
              <View style={styles.actions}>
                <Button label={busy ? (cleanupRequired ? 'Clearing local copy…' : 'Uploading securely…') : cleanupRequired ? 'Try local cleanup again' : remoteCleanupUnconfirmed ? 'Refresh record before retry' : retryRequiresReshare ? 'Discard and share again' : 'Upload attachment'} disabled={busy || !selected || remoteCleanupUnconfirmed} onPress={retryRequiresReshare ? () => { void abandon(); } : () => { void upload(); }} />
                <Button label="Discard" variant="secondary" disabled={busy} onPress={() => { void abandon(); }} />
              </View>
            </>
          )}
        </Screen>
      </PinnedHeaderScreen>
    </>
  );
}

function targetKey(target: AuthorizedShareTarget) {
  return `${target.kind}:${target.id}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMime(mime: string) {
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('image/')) return mime.slice('image/'.length).toLocaleUpperCase();
  if (mime === 'text/plain') return 'Text';
  if (mime === 'text/csv') return 'CSV';
  if (mime.endsWith('wordprocessingml.document')) return 'Word';
  if (mime.endsWith('spreadsheetml.sheet')) return 'Excel';
  return 'Document';
}

const styles = StyleSheet.create({
  eyebrow: { fontSize: 12, lineHeight: 17, ...typeface.controlStrong, letterSpacing: 0.5 },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16, lineHeight: 22 },
  target: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, padding: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  targetCopy: { flex: 1, gap: spacing.xs },
  targetLabel: { fontSize: 12, lineHeight: 17, ...typeface.controlStrong, letterSpacing: 0.4 },
  targetTitle: { fontSize: 16, lineHeight: 22, ...typeface.controlStrong },
  radio: { width: 24, height: 24, borderWidth: 2, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  radioFill: { width: 12, height: 12, borderRadius: 6 },
  actions: { gap: spacing.sm },
});
