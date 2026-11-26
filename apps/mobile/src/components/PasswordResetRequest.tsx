import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';

import { Body, Button } from './ui';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { authCallbackLanguage } from '../lib/authCallbackRecovery';
import { requestEmailPasswordReset, resetRequestEmailValid, type EmailAuthFailure } from '../services/emailAuth';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
export const COPY = {
  en: {
    title: 'Reset your password',
    intro: 'Enter the email address for your account. If it has an account, we will email a private link to choose a new password. Open the link on this phone to continue in the app.',
    email: 'Email address', submit: 'Email me a reset link', sending: 'Sending…', back: 'Back to sign in',
    sent: (address: string) => `If ${address} has an account, a reset link is on its way. It works once, for 15 minutes, and only the newest link works. Nothing arrived? Check your spam folder, then ask for a new link.`,
    invalid: 'Enter a full email address, like you@example.org.',
    'rate-limited': 'Too many attempts. Wait before trying again.',
    unavailable: 'The reset request could not be sent. Try again or ask your administrator for help.',
  },
  es: {
    title: 'Restablece tu contraseña',
    intro: 'Escribe el correo de tu cuenta. Si tiene una cuenta, te enviaremos un enlace privado para elegir una contraseña nueva. Abre el enlace en este teléfono para continuar en la app.',
    email: 'Correo electrónico', submit: 'Envíame un enlace', sending: 'Enviando…', back: 'Volver a entrar',
    sent: (address: string) => `Si ${address} tiene una cuenta, el enlace va en camino. Funciona una sola vez, durante 15 minutos, y solo funciona el más reciente. ¿No llegó nada? Revisa el correo no deseado y pide un enlace nuevo.`,
    invalid: 'Escribe un correo completo, como tu@example.org.',
    'rate-limited': 'Demasiados intentos. Espera antes de volver a intentar.',
    unavailable: 'No se pudo enviar la solicitud. Inténtalo de nuevo o pide ayuda a tu administrador.',
  },
};

// Self-service reset from the native sign-in screen
// (BUG-UG-NATIVE-NO-FORGOT-PASSWORD-20261018). The emailed link opens
// the app's existing auth callback, which finishes the reset with two-step
// verification; nothing here touches a credential.
export function PasswordResetRequest({ initialEmail, onBack }: { initialEmail: string; onBack: (email: string) => void }) {
  const theme = useTheme();
  const { memberLanguage } = useApp();
  // Signed out, the member's saved language is usually unknown; the device
  // locale picks the copy and the language of the email.
  const locale = authCallbackLanguage(memberLanguage, Intl.DateTimeFormat().resolvedOptions().locale);
  const copy = COPY[locale];
  const queueAnnouncement = useAccessibilityAnnouncementQueue('password-reset-request');
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const [email, setEmail] = useState(initialEmail.trim());
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [failure, setFailure] = useState<EmailAuthFailure | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const emailValid = resetRequestEmailValid(email);

  async function submit() {
    if (inFlight.current || !emailValid) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await requestEmailPasswordReset(email, locale);
      if (!mounted.current) return;
      if (result.status === 'sent') setSent(email.trim());
      else setFailure(result.status);
      // The shared queue speaks on both platforms; a live region alone is silent on iOS.
      queueAnnouncement(result.status === 'sent' ? copy.sent(email.trim())
        : result.status === 'rate-limited' ? copy['rate-limited'] : copy.unavailable);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const failureText = failure === 'rate-limited' ? copy['rate-limited'] : failure ? copy.unavailable : null;
  return (
    <View style={styles.form}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={2} style={[styles.title, { color: theme.foreground }]}>{copy.title}</Text>
      {sent ? (
        <Body accessibilityRole="alert">{copy.sent(sent)}</Body>
      ) : (
        <>
          <Body muted>{copy.intro}</Body>
          <Text maxFontSizeMultiplier={2} style={[styles.label, { color: theme.foreground }]}>{copy.email}</Text>
          <TextInput
            accessibilityLabel={copy.email}
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            spellCheck={false}
            keyboardType="email-address"
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            returnKeyType="send"
            placeholder="you@example.org"
            placeholderTextColor={theme.mutedForeground}
            value={email}
            editable={!busy}
            onChangeText={setEmail}
            maxFontSizeMultiplier={2}
            onSubmitEditing={() => { void submit(); }}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
          />
          {email.trim() && !emailValid ? <Body muted>{copy.invalid}</Body> : null}
          <Button label={busy ? copy.sending : copy.submit} disabled={busy || !emailValid} onPress={() => { void submit(); }} />
        </>
      )}
      {failureText ? (
        <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{failureText}</Body>
      ) : null}
      {/* Back stays available while a request is in flight; unmounting drops its result. */}
      <Button label={copy.back} variant="secondary" onPress={() => onBack(sent ?? email.trim())} />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  title: { fontSize: 20, lineHeight: 26, ...typeface.heading },
  label: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.lg, fontSize: 17 },
});
