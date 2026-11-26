import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Button, Screen, StateMessage } from '../../src/components/ui';
import {
  AUTH_CALLBACK_INITIAL_STATE,
  AUTH_CALLBACK_WAIT_BUDGET_MS,
  authCallbackLanguage,
  authCallbackReduce,
  authCallbackScreenModel,
  type AuthCallbackButton,
} from '../../src/lib/authCallbackRecovery';
import { recordLifecycleEvent } from '../../src/services/lifecycleDiagnostics';
import { passwordResetRequestAvailable } from '../../src/services/emailAuth';
import { exchangeAuthCode } from '../../src/services/supabase';
import { useApp } from '../../src/state/AppProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { spacing } from '../../src/theme/tokens';
import { EmailAuthScreen } from '../../src/components/EmailAuthScreen';
import { PASSWORD_RESUME_PARAM, emailAuthFromParams } from '../../src/lib/emailAuth';
import { emailAuthExitHref, emailAuthExitStep, type EmailAuthExit, type EmailAuthSignOutState } from '../../src/lib/emailAuthExit';

export default function AuthCallbackScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const { mode, signOut, signOutError } = useApp();
  // The root Stack keeps this route's native header, drawn transparent over
  // the scene, so the invitation and reset-link heading starts below its
  // measured height rather than under the back arrow
  // (BUG-UG-NATIVE-INVITE-HEADING-UNDER-BACK-ARROW-20261102).
  const nativeHeaderHeight = useContext(HeaderHeightContext);
  // Leaving for sign-in follows the committed app mode, never the signOut()
  // promise (see src/lib/emailAuthExit.ts). `reset` opens the sign-in
  // screen's reset request after a failed reset link
  // (UX-UG-NATIVE-LINK-FAILURE-ASK-ADMINISTRATOR-20261018).
  const [exit, setExit] = useState<EmailAuthExit | null>(null);
  const [signOutState, setSignOutState] = useState<EmailAuthSignOutState>('idle');
  useEffect(() => {
    const step = emailAuthExitStep(mode, exit, signOutState);
    if (step === 'navigate' && exit) {
      setExit(null);
      setSignOutState('idle');
      router.replace(emailAuthExitHref(exit));
      return;
    }
    if (step === 'start-sign-out') {
      setSignOutState('in-flight');
      void signOut().then(() => undefined, () => undefined).then(() => setSignOutState('settled'));
      return;
    }
    if (step === 'refused') {
      // Still signed in after the teardown settled: its diagnosis is shown
      // below and the member stays here; a new tap asks again.
      setExit(null);
      setSignOutState('idle');
    }
  }, [exit, mode, router, signOut, signOutState]);
  if (params.invite !== undefined || params.resetTicket !== undefined || params[PASSWORD_RESUME_PARAM] !== undefined) {
    const link = emailAuthFromParams(params);
    return <EmailAuthScreen
      key={`${link?.kind}:${link?.token}`}
      link={link}
      notice={signOutError}
      nativeHeaderHeight={nativeHeaderHeight}
      onSignIn={() => setExit({ reset: false })}
      onRequestNewLink={passwordResetRequestAvailable() ? () => setExit({ reset: true }) : undefined}
    />;
  }
  return <CodeAuthCallbackScreen />;
}

function CodeAuthCallbackScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { mode, memberLanguage, signOut } = useApp();
  const params = useLocalSearchParams<{ code?: string; error?: string; error_code?: string }>();
  const code = params.code;
  const [state, dispatch] = useReducer(authCallbackReduce, AUTH_CALLBACK_INITIAL_STATE);
  const [leavingDemo, setLeavingDemo] = useState(false);
  const startedExchange = useRef<string | null>(null);

  useEffect(() => {
    if (!code) return;
    // One exchange per code: a re-run of this effect must not spend the
    // one-time code twice, and a superseded code must not settle state.
    if (startedExchange.current === code) return;
    startedExchange.current = code;
    dispatch({ type: 'exchangeStarted' });
    const settle = (exchange: 'complete' | 'failed') => {
      if (startedExchange.current === code) dispatch({ type: 'exchangeSettled', exchange });
    };
    // The thrown auth error is never rendered; every outcome uses fixed copy.
    void exchangeAuthCode(code).then(() => settle('complete'), () => settle('failed'));
  }, [code]);

  // Everything drawn below, and every place a button leads, is decided by the
  // pure model; this screen only renders it and runs its effects.
  const model = authCallbackScreenModel({
    hasCode: Boolean(code),
    // The auth server answers an expired or already-used link with error
    // parameters and no code; that link was refused, not cut short.
    linkRejected: Boolean(params.error || params.error_code),
    state,
    mode,
    language: authCallbackLanguage(memberLanguage, Intl.DateTimeFormat().resolvedOptions().locale),
  });
  const waitKey = model.waitKey;
  const diagnosticStep = model.kind === 'recovery' ? model.diagnostic.step : null;
  const diagnosticOutcome = model.kind === 'recovery' ? model.diagnostic.outcome : null;

  // No wait is unbounded: past the budget the spinner yields to a recovery
  // state. A new wait key (next phase, or "keep waiting") re-arms the budget.
  useEffect(() => {
    if (waitKey === null) return undefined;
    const timer = setTimeout(() => dispatch({ type: 'budgetElapsed' }), AUTH_CALLBACK_WAIT_BUDGET_MS);
    return () => clearTimeout(timer);
  }, [waitKey]);

  // Which recovery state a member reached, and from which app mode. Both are
  // enumerated; the thrown auth error never reaches this channel either.
  useEffect(() => {
    if (diagnosticStep === null || diagnosticOutcome === null) return;
    recordLifecycleEvent({ scope: 'auth-callback', step: diagnosticStep, outcome: diagnosticOutcome });
  }, [diagnosticStep, diagnosticOutcome]);

  if (model.kind === 'redirect') return <Redirect href={model.href} />;

  if (model.kind === 'waiting') {
    return (
      <Screen>
        <StateMessage
          title={model.title}
          body={model.body}
          action={<ActivityIndicator color={theme.primary} accessibilityLabel={model.spinnerLabel} />}
        />
      </Screen>
    );
  }

  const run = ({ effect }: AuthCallbackButton) => {
    if (effect.kind === 'dispatch') {
      dispatch(effect.event);
    } else if (effect.kind === 'navigate') {
      router.replace(effect.href);
    } else {
      if (leavingDemo) return;
      setLeavingDemo(true);
      // If the demo could not end, sign-in's redirect Home is still a way out.
      void signOut().catch(() => undefined).then(() => {
        setLeavingDemo(false);
        router.replace(effect.href);
      });
    }
  };
  return (
    <Screen>
      <StateMessage
        title={model.title}
        body={model.body}
        action={(
          <View style={styles.actions}>
            {model.buttons.map((button) => (
              <Button
                key={button.action}
                label={button.label}
                variant={button.variant}
                busy={button.effect.kind === 'endDemoThenNavigate' && leavingDemo}
                onPress={() => run(button)}
              />
            ))}
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { alignSelf: 'stretch', gap: spacing.md },
});
