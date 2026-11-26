import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { ResidenceAgeFields } from '../components/ResidenceAgeFields';
import { Body, Button, Card, Heading } from '../components/ui';
import { ageRuleFor, isResidenceRegion } from '../../../../src/lib/residenceRegions.js';
import StoreAgeSignalModule from '../../modules/store-age-signal/src/StoreAgeSignalModule';
import {
  LEGAL_ACCEPTANCE_ACTION,
  LEGAL_ACCEPTANCE_CONSENT,
  LEGAL_ACCEPTANCE_FAILED,
  LEGAL_ACCEPTANCE_REQUIRED,
  LEGAL_ACCEPTANCE_STORE_CHECKING,
  LEGAL_ACCEPTANCE_STORE_BLOCKED,
  LEGAL_ACCEPTANCE_TITLE,
  legalAcceptanceBody,
  legalAcceptanceLinks,
  legalAcceptanceRequirement,
  legalAcceptanceVersionLine,
  legalAcceptanceVersions,
  type LegalAcceptanceState,
} from '../lib/legalAcceptance';
import { mobileConfig } from '../lib/config';
import { readStoreAgeSignal, storeAgeSignalDecision, type StoreAgeSignal } from '../lib/storeAgeSignal';
import {
  loadLegalAcceptance,
  recordLegalAcceptance,
} from '../services/legalAcceptance';
import { isLiveSampleBackend } from '../services/sampleSession';
import { getSupabaseClient } from '../services/supabase';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

// One prompt at the first sign-in
// after a material change, and the acceptance is recorded with its version,
// the time, the person and the organization. The decision to ask comes from
// the same server read and the same material-change flag the website uses, so
// a person who already holds the current version is never asked here either.
// Nothing renders while the acceptance state is unknown.
export function LegalAcceptanceCard({ onRequiredChange }: {
  onRequiredChange?: (required: boolean) => void;
  language?: string | null;
} = {}) {
  const theme = useTheme();
  const { session } = useApp();
  const currentSession = useRef(session);
  currentSession.current = session;
  const lifetime = useRef<object | null>(null);
  const [state, setState] = useState<LegalAcceptanceState>(null);
  const [agreed, setAgreed] = useState(false);
  // Every acceptance carries the state the
  // person lives in and the age attestation it selects, and the database
  // refuses one without them.
  const [residenceState, setResidenceState] = useState('');
  const [ageAttested, setAgeAttested] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // REQ-UG-MOBILE-STORE-AGE-SIGNAL-20261016: in an app-store age-law
  // state the store's age signal is read once, when the person presses
  // Accept, before the self-attested box counts. A store-reported minor is
  // stopped here; every other outcome (adult, indeterminate, declined,
  // verification required, not eligible, unavailable) leaves the existing
  // 18-or-older attestation in charge. The signal is kept per card so the
  // store is not asked again on a retry after a failed record.
  const storeSignal = useRef<StoreAgeSignal | null>(null);
  // The state the person has chosen right now. The fields are disabled while
  // the store answers, and should an edit still land during that await, the
  // answer is dropped rather than applied to a state no longer on the form.
  const chosenResidence = useRef('');
  const [checkingStore, setCheckingStore] = useState(false);
  const [storeBlocked, setStoreBlocked] = useState(false);

  useEffect(() => {
    const owner = {};
    lifetime.current = owner;
    // A mounted Home can change account too: neither consent nor a cached
    // store answer belongs to its replacement.
    storeSignal.current = null;
    chosenResidence.current = '';
    setState(null);
    setAgreed(false);
    setResidenceState('');
    setAgeAttested(false);
    setMissing(false);
    setFailed(null);
    setCheckingStore(false);
    setStoreBlocked(false);
    setBusy(false);
    // Owner ruling, October 29, 2026: "NO TERMS FOR SAMPLE. SAMPLE HAS NO REAL
    // USERS". A SAMPLE build never reads, so the card never renders there.
    if (isLiveSampleBackend(mobileConfig)) return () => { if (lifetime.current === owner) lifetime.current = null; };
    let active = true;
    void loadLegalAcceptance().then((loaded) => {
      if (active) setState(loaded);
    });
    return () => { active = false; if (lifetime.current === owner) lifetime.current = null; };
  }, [session?.user.id]);

  const accept = useCallback(async () => {
    const initiatingSession = session ? { ...session, user: { ...session.user } } : null;
    const owner = lifetime.current;
    const stillCurrent = () => owner !== null && lifetime.current === owner
      && currentSession.current?.user.id === initiatingSession?.user.id
      && currentSession.current?.access_token === initiatingSession?.access_token;
    if (!initiatingSession || !stillCurrent()) return;
    const ownsSession = async () => {
      const current = await getSupabaseClient()?.auth.getSession().catch(() => null);
      return stillCurrent() && !current?.error
        && current?.data.session?.user.id === initiatingSession.user.id
        && current?.data.session?.access_token === initiatingSession.access_token;
    };
    if (!isResidenceRegion(residenceState)) {
      setMissing(true);
      return;
    }
    if (ageRuleFor(residenceState) === 'adult') {
      if (!storeSignal.current) {
        setMissing(false);
        setFailed(null);
        setCheckingStore(true);
        const signal = await readStoreAgeSignal(StoreAgeSignalModule);
        const owned = await ownsSession();
        if (lifetime.current !== owner) return;
        setCheckingStore(false);
        if (!owned) return;
        if (chosenResidence.current !== residenceState) return;
        storeSignal.current = signal;
      }
      if (storeAgeSignalDecision(storeSignal.current, residenceState) === 'block-minor') {
        setStoreBlocked(true);
        return;
      }
    }
    if (!agreed || !ageAttested) {
      setMissing(true);
      return;
    }
    // Auth can change before React renders the replacement. Check it directly
    // before dispatch; the RPC also uses the captured session, never B's token.
    setBusy(true);
    if (!await ownsSession() || chosenResidence.current !== residenceState) {
      if (lifetime.current === owner) setBusy(false);
      return;
    }
    setMissing(false);
    setFailed(null);
    const recorded = await recordLegalAcceptance(legalAcceptanceVersions(), residenceState, ageAttested, initiatingSession);
    if (!stillCurrent()) {
      if (lifetime.current === owner) setBusy(false);
      return;
    }
    if (!recorded) {
      setFailed(LEGAL_ACCEPTANCE_FAILED);
      setBusy(false);
      return;
    }
    const refreshed = await loadLegalAcceptance();
    if (!stillCurrent()) {
      if (lifetime.current === owner) setBusy(false);
      return;
    }
    setState(refreshed);
    setBusy(false);
  }, [ageAttested, agreed, residenceState, session]);

  const requirement = legalAcceptanceRequirement(state);
  const required = requirement.reacceptanceRequired && !isLiveSampleBackend(mobileConfig);
  // Home reserves the Android tab/pill band only while this form is present.
  // Release it on acceptance, an unknown requirement, or unmount as well.
  useEffect(() => {
    onRequiredChange?.(required);
    return () => { onRequiredChange?.(false); };
  }, [onRequiredChange, required]);
  if (!required) return null;

  return (
    <Card>
      <Heading level={2}>{LEGAL_ACCEPTANCE_TITLE}</Heading>
      <Body muted>{legalAcceptanceBody(requirement.instruments)}</Body>
      <Body>{legalAcceptanceVersionLine()}</Body>
      {legalAcceptanceLinks().map((link) => (
        <Pressable
          key={link.url}
          accessibilityRole="link"
          accessibilityLabel={link.label}
          style={styles.documentLink}
          onPress={() => {
            setFailed(null);
            void Linking.openURL(link.url).catch(() => {
              setFailed('The document could not be opened. Try again before accepting.');
            });
          }}
        >
          <Body style={{ color: theme.primary, textDecorationLine: 'underline' }}>{link.label}</Body>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={LEGAL_ACCEPTANCE_CONSENT}
        accessibilityState={{ checked: agreed, disabled: busy || checkingStore }}
        disabled={busy || checkingStore}
        onPress={() => { setAgreed((value) => !value); setMissing(false); }}
        style={[styles.consent, { borderColor: theme.border }]}
      >
        <View
          style={[styles.box, {
            borderColor: theme.border,
            backgroundColor: agreed ? theme.primary : theme.input,
          }]}
        />
        <Body>{LEGAL_ACCEPTANCE_CONSENT}</Body>
      </Pressable>
      <ResidenceAgeFields
        residenceState={residenceState}
        onResidenceState={(code) => { chosenResidence.current = code; setResidenceState(code); setMissing(false); setStoreBlocked(false); }}
        ageAttested={ageAttested}
        onAgeAttested={(value) => { setAgeAttested(value); setMissing(false); }}
        disabled={busy || checkingStore}
      />
      {missing ? (
        <View accessibilityLiveRegion="polite">
          <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{LEGAL_ACCEPTANCE_REQUIRED}</Body>
        </View>
      ) : null}
      {storeBlocked ? (
        <View accessibilityLiveRegion="assertive" testID="legal-acceptance-store-blocked">
          <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{LEGAL_ACCEPTANCE_STORE_BLOCKED}</Body>
        </View>
      ) : (
        <Button
          label={checkingStore ? LEGAL_ACCEPTANCE_STORE_CHECKING : busy ? 'Recording…' : LEGAL_ACCEPTANCE_ACTION}
          disabled={busy || checkingStore}
          onPress={() => { void accept(); }}
        />
      )}
      {failed ? (
        <View accessibilityLiveRegion="polite">
          <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{failed}</Body>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  documentLink: {
    minHeight: minimumTouchTarget,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
  },
  consent: {
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: minimumTouchTarget,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  box: {
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    height: 22,
    width: 22,
  },
});
