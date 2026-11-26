import { NEW_PASSWORD_MIN, NEW_PASSWORD_MAX, NEW_PASSWORD_RULE, NEW_PASSWORD_TOO_LONG, NEW_PASSWORD_TOO_SHORT,
  newPasswordLengthIssue } from "../../../../src/lib/passwordPolicy.js";
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';

import { Body, Button, Heading, Screen } from './ui';
import type { EmailAuthLink } from '../lib/emailAuth';
import { LEGAL_INSTRUMENTS } from '../../../../src/lib/legalInstruments.js';
import { ageRuleFor, isResidenceRegion } from '../../../../src/lib/residenceRegions.js';
import StoreAgeSignalModule from '../../modules/store-age-signal/src/StoreAgeSignalModule';
import { LEGAL_ACCEPTANCE_ACTION, LEGAL_ACCEPTANCE_CONSENT, legalAcceptanceInAppPath, legalAcceptanceLinks, legalAcceptanceMissing,
  LEGAL_ACCEPTANCE_STORE_BLOCKED, legalAcceptanceVersionLine, legalAcceptanceVersions } from '../lib/legalAcceptance';
import { readStoreAgeSignal, storeAgeSignalDecision, type StoreAgeSignal } from '../lib/storeAgeSignal';
import { ResidenceAgeFields } from './ResidenceAgeFields';
import { PasswordResetRequest } from './PasswordResetRequest';
import { acceptEmailInvitation, beginEmailPasswordReset, finishEmailPasswordReset, passwordResetRequestAvailable,
  type EmailAuthError, type EmailAuthFailure, type EmailRecovery } from '../services/emailAuth';
import { clearPendingReset, loadPendingReset, sameResetAccount, savePendingReset, shareBegin } from '../lib/pendingPasswordReset';
import { supportEmail } from '../lib/supportContact';
import { REFERRAL_COPY } from '../lib/memberReferral';
import { SupportLink } from './SupportLink';
import { cleanAuthenticatorCode, isAuthenticatorCode } from '../lib/authenticatorCode';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

// A failed link names a way forward that exists for every link
// (UX-UG-NATIVE-LINK-FAILURE-ASK-ADMINISTRATOR-20261018): a reset link
// can be re-sent from the sign-in screen; an invitation comes from the
// organization's administrator, with support as the fallback because SCIM and
// founder invitations have no human inviter.
// The password email's language follows the invitation's locale on the
// server, which this screen does not know (memberLanguage is null while
// signed out), so the accepted copy names both subjects.
// Owner ruling (September 20, 2026; confirmed October 20, 2026, 10:10 AM ET, item 3):
// native member copy is English only. The guidance added by  and  for
// an accepted invitation and a failed link renders in English for every member
// language; only the older screen copy keeps its Spanish block.
export const LINK_COPY = {
  noAdministrator: supportEmail ? `No administrator to ask? Email ${supportEmail}.` : 'No administrator to ask? Ask the person who invited you.',
  accepted: 'Your invitation is accepted. Your sign-in password is in a separate email from Union Ground with the subject "Your Union Ground sign-in password" (or, in Spanish, "Tu contraseña de Union Ground"). Sign in with your email address and that password. Then choose your own password in Account.',
  invitationPassword: 'For a new account, after you accept this invitation, we will email you a temporary sign-in password. Sign in with it, then choose your own password in Account. If this invitation restores an existing membership, keep using your existing password; no new password is sent.',
  passwordMissing: "Didn't get it? Check your spam folder. If it is still missing, reset your password and choose your own.",
  resetPassword: 'Reset your password',
  linkInvalidReset: 'This reset link is invalid, expired, or already used. Only the newest link works, and only for 15 minutes.',
  linkInvalidInvitation: "This invitation link is invalid, expired, or already used. Ask your organization's administrator to send a new invitation.",
  linkInvalidUnknown: "This link is invalid, expired, or already used. For a password reset, send yourself a new link below. For an invitation, ask your organization's administrator to send a new one.",
  linkInvalidUnknownNoReset: "This link is invalid, expired, or already used. For a password reset, sign in again and use Forgot your password? where it is offered. For an invitation, ask your organization's administrator to send a new one.",
  newResetLink: 'Send me a new reset link',
};

// A saved recovery code's length, read by the rule below and by the sentence
// that names it, so the two cannot drift apart .
export const RECOVERY_CODE_MIN_LENGTH = 18;
export const RECOVERY_CODE_MAX_LENGTH = 32;
const RECOVERY_CODE_PATTERN = new RegExp(`^[A-Za-z0-9-]{${RECOVERY_CODE_MIN_LENGTH},${RECOVERY_CODE_MAX_LENGTH}}$`);

export const COPY = {
  en: {
    invite: 'Accept your invitation', reset: 'Reset your password', checking: 'Checking your private link…',
    reactivated: 'Your access is restored. Sign in with your existing password.',
    completed: 'Your password has changed. Sign in with your new password and the code from your authenticator app. To prepare for a lost authenticator, sign in to Union Ground on the web and open Settings > Security > Recovery codes to generate and save backup codes, if your organization allows it.',
    sessionsOpen: 'Your password has changed, but some other sessions could not be ended. Contact your administrator. To prepare for a lost authenticator, sign in to Union Ground on the web with your new password and authenticator code, then open Settings > Security > Recovery codes to generate and save backup codes, if your organization allows it.',
    challenge: 'Enter your authenticator code and choose a new password.',
    useRecovery: 'Lost your authenticator? Use a saved recovery code instead', useAuthenticator: 'Use the code from my authenticator app instead',
    recoveryIntro: 'Enter one of your saved recovery codes and choose a new password. A recovery code works once. It removes the authenticator you lost and signs you out everywhere. After recovery, sign in on the website in a browser with your new password, open Settings > Security (Configuración > Seguridad) and choose Turn on two-step sign-in (Activar el inicio de sesión en dos pasos) to set up a replacement authenticator.',
    recoveryCode: 'One-time recovery code',
    completedRecovery: 'Your password has changed and the authenticator you lost is removed. You are signed out everywhere. Sign in on the website in a browser with your new password, open Settings > Security (Configuración > Seguridad) and choose Turn on two-step sign-in (Activar el inicio de sesión en dos pasos) to set up a replacement authenticator. Then open Settings > Security > Recovery codes to generate and save new backup codes, if your organization allows it.',
    'recovery-rejected': 'That recovery code was not accepted. It may be mistyped or already used, and repeated misses lock recovery for a while. Your password has not changed.',
    'recovery-incomplete': 'The recovery could not be finished, so your password was not changed. Wait two minutes, ask for a new reset link and try again. If it keeps failing, ask your campaign administrator for help.',
    'recovery-unfinished': 'Your password was changed, but we could not finish removing your old authenticator and signing out your other devices, so signing in may stay blocked. Ask your campaign administrator to reset your two-step sign-in.',
    'recovery-held': 'Your recovery could not be completed and is now on hold, so we cannot tell you whether your password changed. Ask your campaign administrator to reset your two-step sign-in; once they have, sign in and choose a new password.',
    enroll: 'This account does not have two-step sign-in yet, so this reset includes setting it up to protect your account if someone learns your password. An authenticator app generates sign-in codes; free options include Google Authenticator and Microsoft Authenticator. Setup takes about a minute. Add Union Ground to the app using this setup key, then enter its six-digit code and choose a new password. Your password changes only after the code is accepted. No phone, or unable to use an authenticator app? Stop here and ask your campaign administrator for help recovering access.',
    key: 'Add this key in your authenticator app', code: 'Authenticator code', password: 'New password', confirm: 'Confirm new password',
    requirements: `${NEW_PASSWORD_RULE.en} Use no more than ${NEW_PASSWORD_MAX} characters. The two passwords must match.`, finish: 'Change password',
    codeMissing: 'Enter the six-digit code from your authenticator app.',
    recoveryCodeShape: `A recovery code is ${RECOVERY_CODE_MIN_LENGTH} to ${RECOVERY_CODE_MAX_LENGTH} letters, numbers and dashes.`,
    mismatch: 'The two passwords do not match.',
    signIn: 'Continue to sign in', retry: 'Try again',
    readTerms: 'Read the current version of each document before accepting.',
    notOperative: 'These documents are not yet in effect.',
    documentFailed: 'The document could not be opened. Try again before accepting.',
    'terms-version-stale': 'These terms changed. Nothing was accepted. Update the app or open the original invitation in your browser to read and accept the current version.',
    'link-invalid': 'This link is invalid, expired, or already used.',
    unavailable: 'This link could not be completed. Try again or ask your administrator for help.',
    'rate-limited': 'Too many attempts. Wait before trying again.',
    'in-progress': 'This invitation is being processed. Wait a moment before trying again.',
    'code-not-accepted': 'That authenticator code was not accepted. Try a new code.',
    'password-rejected': 'That password was not accepted. Choose a different password.',
    'two-step-unavailable': 'Two-step verification cannot be completed here. Ask your administrator to reissue your password.',
    'email-domain-blocked': "Use a personal email address. Government and employer email addresses can't be used for a Union Ground account. Ask your administrator to invite your personal address.",
  },
  es: {
    invite: 'Acepta tu invitación', reset: 'Restablece tu contraseña', checking: 'Comprobando tu enlace privado…',
    reactivated: 'Tu acceso está restaurado. Entra con tu contraseña actual.',
    completed: 'Tu contraseña ha cambiado. Entra con tu contraseña nueva y el código de tu app de autenticación. Por si pierdes tu autenticador, entra en Union Ground desde la web y abre Configuración > Seguridad > Códigos de recuperación para generar y guardar códigos de respaldo, si tu organización lo permite.',
    sessionsOpen: 'Tu contraseña ha cambiado, pero no se pudieron cerrar algunas sesiones. Comunícate con tu administrador. Por si pierdes tu autenticador, entra en Union Ground desde la web con tu contraseña nueva y el código de tu autenticador, y abre Configuración > Seguridad > Códigos de recuperación para generar y guardar códigos de respaldo, si tu organización lo permite.',
    challenge: 'Escribe el código de tu autenticador y elige una contraseña nueva.',
    enroll: 'Esta cuenta todavía no tiene inicio de sesión en dos pasos, así que este restablecimiento incluye configurarlo para proteger tu cuenta si alguien descubre tu contraseña. Una app de autenticación genera códigos para entrar; Google Authenticator y Microsoft Authenticator son opciones gratuitas. La configuración tarda aproximadamente un minuto. Añade Union Ground a la app con esta clave, escribe su código de seis dígitos y elige una contraseña nueva. Tu contraseña cambia solo después de que se acepte el código. ¿No tienes teléfono o no puedes usar una app de autenticación? Detente aquí y pide ayuda a la administración de tu campaña para recuperar el acceso.',
    key: 'Añade esta clave en tu app de autenticación', code: 'Código del autenticador', password: 'Contraseña nueva', confirm: 'Confirma la contraseña nueva',
    requirements: `${NEW_PASSWORD_RULE.es} Usa un máximo de ${NEW_PASSWORD_MAX} caracteres. Las dos contraseñas deben coincidir.`, finish: 'Cambiar contraseña',
    codeMissing: 'Escribe el código de seis dígitos de tu app de autenticación.',
    recoveryCodeShape: `Un código de recuperación tiene de ${RECOVERY_CODE_MIN_LENGTH} a ${RECOVERY_CODE_MAX_LENGTH} letras, números y guiones.`,
    mismatch: 'Las dos contraseñas no coinciden.',
    signIn: 'Continuar para entrar', retry: 'Volver a intentar',
    readTerms: 'Lee la versión actual de cada documento antes de aceptar.',
    notOperative: 'Estos documentos todavía no están en vigor.',
    documentFailed: 'No se pudo abrir el documento. Inténtalo de nuevo antes de aceptar.',
    'terms-version-stale': 'Estos términos cambiaron. No se aceptó nada. Actualiza la app o abre la invitación original en tu navegador para leer y aceptar la versión actual.',
    'link-invalid': 'Este enlace no es válido, ha caducado o ya se usó.',
    unavailable: 'No se pudo completar el enlace. Inténtalo de nuevo o pide ayuda a tu administrador.',
    'rate-limited': 'Demasiados intentos. Espera antes de volver a intentar.',
    'in-progress': 'Se está procesando esta invitación. Espera un momento antes de volver a intentar.',
    'code-not-accepted': 'No se aceptó ese código. Prueba con un código nuevo.',
    'password-rejected': 'No se aceptó esa contraseña. Elige una diferente.',
    'two-step-unavailable': 'No se puede completar la verificación en dos pasos aquí. Pide a tu administrador una contraseña nueva.',
    'email-domain-blocked': 'Usa una dirección de correo personal. No se pueden usar direcciones de correo del gobierno ni del empleador para una cuenta de Union Ground. Pide a tu administrador que invite tu dirección personal.',
  },
};

type VisibleFailure = Exclude<EmailAuthFailure, 'reset-invalidated'>;
function visibleFailure(status: EmailAuthFailure, reason?: EmailAuthError['reason']): VisibleFailure {
  return status === 'reset-invalidated'
    ? reason === 'two-step-unavailable' ? 'two-step-unavailable' : 'link-invalid'
    : status;
}

export function EmailAuthScreen({ link, onSignIn, onRequestNewLink, notice = null, nativeHeaderHeight }: {
  link: EmailAuthLink | null;
  onSignIn: () => void;
  /** Opens the sign-in screen's reset request; offered after a failed reset link where a reset email can be sent. */
  onRequestNewLink?: () => void;
  /** The host's sign-out diagnosis while a signed-in member could not be signed out before leaving. */
  notice?: string | null;
  /** The measured height of the native header auth/callback keeps over this screen. */
  nativeHeaderHeight?: number;
}) {
  const theme = useTheme();
  const { memberLanguage } = useApp();
  const router = useRouter();
  // Reader success and failure belong to the instrument attempted. A history
  // refusal cannot erase a failed instrument or undo a successful fallback.
  const openedInstruments = useRef(new Set<string>());
  const failedDocuments = useRef(new Set<string>());
  const documentAttempts = useRef(new Map<string, number>());
  // Native recovery-code strings retain their reviewed English fallback.
  const copy = { ...COPY.en, ...(memberLanguage === 'es' ? COPY.es : {}) };
  const started = useRef(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const resetLink = link?.kind === 'passwordReset' || link?.kind === 'passwordResume';
  const [busy, setBusy] = useState(resetLink);
  const [agreed, setAgreed] = useState(false);
  // The account is created only after the
  // person says which state they live in and confirms the age rule it selects.
  const [residenceState, setResidenceState] = useState('');
  const [ageAttested, setAgeAttested] = useState(false);
  //: an optional referral code from the member who brought this person in.
  const [referralCode, setReferralCode] = useState('');
  const consentComplete = agreed && ageAttested && isResidenceRegion(residenceState);
  // REQ-UG-MOBILE-STORE-AGE-SIGNAL-20261016: this clickwrap is native
  // account creation. In an app-store age-law state the store's age signal is
  // read once, when the person presses Accept and before the token crosses
  // the network; a store-reported minor is stopped here with nothing sent,
  // and every other outcome leaves the self-attested answer in charge.
  const storeSignal = useRef<StoreAgeSignal | null>(null);
  const [storeBlocked, setStoreBlocked] = useState(false);
  const [acceptedVersions] = useState(legalAcceptanceVersions);
  const [documentFailed, setDocumentFailed] = useState(false);
  const [failure, setFailure] = useState<VisibleFailure | null>(link ? null : 'link-invalid');
  const [recovery, setRecovery] = useState<EmailRecovery | null>(null);
  const [done, setDone] = useState<'accepted' | 'reactivated' | 'completed' | 'sessionsOpen' | 'completedRecovery' | null>(null);
  // A member who lost the authenticator may type a saved recovery code instead.
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  // After acceptance the sign-in password travels in a second email; when it
  // is late, filtered or deleted the member can reset it here instead of
  // asking the owner (UX-UG-NATIVE-INVITE-ACCEPTED-SECOND-EMAIL-DEAD-END-20261018).
  // Offered only where a reset email can be sent, never on SAMPLE.
  const resetOffered = done === 'accepted' && passwordResetRequestAvailable();
  const [resetOpen, setResetOpen] = useState(false);

  function documentOpened(url: string) {
    failedDocuments.current.delete(url);
    if (legalAcceptanceInAppPath(url)) {
      // A completed browser open and a completed fallback both show the
      // instrument; a later history refusal must treat them alike.
      openedInstruments.current.add(url);
      // History is supplementary; a completed instrument open settles its
      // older refusal, while failures of other instruments remain held.
      for (const failedUrl of failedDocuments.current) {
        if (!legalAcceptanceInAppPath(failedUrl)) failedDocuments.current.delete(failedUrl);
      }
    }
    setDocumentFailed(failedDocuments.current.size > 0);
  }

  async function openDocument(url: string) {
    // Only this URL's latest request may navigate or publish its outcome.
    // Starting a different instrument must not supersede this one's result.
    const attempt = (documentAttempts.current.get(url) ?? 0) + 1;
    documentAttempts.current.set(url, attempt);
    const isCurrent = () => mounted.current && documentAttempts.current.get(url) === attempt;
    try {
      await Linking.openURL(url);
      if (isCurrent()) documentOpened(url);
    } catch {
      if (!isCurrent()) return;
      const inAppPath = legalAcceptanceInAppPath(url);
      if (inAppPath) {
        try {
          router.push(inAppPath as never);
          if (isCurrent()) documentOpened(url);
          return;
        } catch {
          if (!isCurrent()) return;
          openedInstruments.current.delete(url);
        }
      } else if (openedInstruments.current.size > 0) {
        failedDocuments.current.delete(url);
        setDocumentFailed(failedDocuments.current.size > 0);
        return;
      }
      failedDocuments.current.add(url);
      setDocumentFailed(true);
    }
  }

  async function begin() {
    if (!link || inFlight.current || (link.kind === 'invitation' && !consentComplete)) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      if (link.kind === 'invitation' && ageRuleFor(residenceState) === 'adult') {
        if (!storeSignal.current) storeSignal.current = await readStoreAgeSignal(StoreAgeSignalModule);
        if (!mounted.current) return;
        if (storeAgeSignalDecision(storeSignal.current, residenceState) === 'block-minor') {
          setStoreBlocked(true);
          return;
        }
      }
      const result = link.kind === 'invitation'
        ? await acceptEmailInvitation(link.token, acceptedVersions, residenceState, true, referralCode) : await beginOrResumeReset(link);
      if (!mounted.current) return;
      if (result.status === 'accepted') setDone(result.reactivated ? 'reactivated' : 'accepted');
      else if (result.status === 'challenge' || result.status === 'enroll') setRecovery(result);
      else setFailure(visibleFailure(result.status, result.status === 'reset-invalidated' ? result.reason : undefined));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  // Opening the link spends it, so the sealed state is kept for its 15 minutes
  // (BUG-UG-RESET-LINK-SPENT-ON-PAGE-OPEN-20261018): the same link
  // opened again, or a relaunch from the sign-in screen, resumes the step
  // without a second begin. A different ticket replaces the saved reset only
  // once the server accepts it, so an expired link cannot destroy a usable one.
  async function beginOrResumeReset(resetFor: Exclude<EmailAuthLink, { kind: 'invitation' }>): Promise<EmailRecovery | EmailAuthError> {
    const pending = await loadPendingReset();
    if (pending && (resetFor.kind === 'passwordResume' || pending.ticket === resetFor.token)) {
      return { status: pending.status, state: pending.state, secret: pending.secret };
    }
    if (resetFor.kind === 'passwordResume') return { status: 'link-invalid' };
    return shareBegin(resetFor.token, async (attempt) => {
      // Read after earlier queued begins have persisted their enrollment.
      const captured = await loadPendingReset();
      const result = await beginEmailPasswordReset(resetFor.token);
      if (result.status === 'challenge' || result.status === 'enroll') {
        await savePendingReset({ ticket: resetFor.token, ...attempt, recovery: result });
      } else if (result.status === 'reset-invalidated') {
        // Only the account whose enrolment this begin changed loses its saved
        // reset; another account's live one, or a newer save, stays.
        if (captured?.status === 'enroll' && captured.ticket !== resetFor.token
          && sameResetAccount(captured.account, result.account)) await clearPendingReset(captured.state);
      }
      return result;
    });
  }

  useEffect(() => {
    mounted.current = true;
    if (!started.current) {
      started.current = true;
      // Opening an invitation only displays the clickwrap. The person must
      // agree before its one-time token crosses the network.
      if (resetLink) void begin();
    }
    return () => { mounted.current = false; };
    // The callback mounts this component with a key for the one incoming link.
    // Strict Mode replays must not redeem its one-time credential twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finish() {
    if (!recovery || inFlight.current || !canFinish) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const result = await finishEmailPasswordReset(recovery.state, code, password);
    inFlight.current = false;
    // The saved reset is dropped whatever the screen is doing: a finish that
    // lands after the member navigated away must not leave the spent setup key.
    if (result.status === 'completed' || result.status === 'link-invalid' || result.status === 'two-step-unavailable' || result.status === 'recovery-unfinished' || result.status === 'recovery-held') {
      void clearPendingReset(recovery.state);
    }
    if (!mounted.current) return;
    setBusy(false);
    setCode('');
    if (result.status === 'completed') {
      setRecovery(null); setPassword(''); setConfirmation('');
      setDone(result.recoveryCodeUsed ? 'completedRecovery' : result.sessionsEnded ? 'completed' : 'sessionsOpen');
    } else {
      setFailure(result.status === 'code-not-accepted' && useRecovery ? 'recovery-rejected' : visibleFailure(result.status, result.status === 'reset-invalidated' ? result.reason : undefined));
      if (result.status === 'link-invalid' || result.status === 'two-step-unavailable' || result.status === 'recovery-unfinished' || result.status === 'recovery-held') {
        setRecovery(null); setPassword(''); setConfirmation('');
      }
    }
  }

  const codeReady = useRecovery ? RECOVERY_CODE_PATTERN.test(code) : isAuthenticatorCode(code);
  const canFinish = password.length >= NEW_PASSWORD_MIN && password.length <= NEW_PASSWORD_MAX
    && confirmation === password && codeReady && !busy;
  //  (M1-1), the phone twin of: the new-password field says as it is
  // typed when the length rule is missed, in the web's words, and a press on the
  // unavailable Change password names the first unmet rule, in field order.
  const lengthIssue = newPasswordLengthIssue(password);
  const lengthReason = lengthIssue ? (lengthIssue === 'short' ? NEW_PASSWORD_TOO_SHORT : NEW_PASSWORD_TOO_LONG)[memberLanguage === 'es' ? 'es' : 'en']
    .replace('{count}', String(password.length)) : '';
  const finishReason = !codeReady ? (useRecovery ? copy.recoveryCodeShape : copy.codeMissing)
    : !password ? copy.requirements : lengthReason || (confirmation !== password ? copy.mismatch : '');
  const fieldStyle = [styles.input, { color: theme.foreground, borderColor: theme.border, backgroundColor: theme.card }];
  const invitationConsent = link?.kind === 'invitation' && !done
    && failure !== 'link-invalid' && failure !== 'terms-version-stale' && failure !== 'email-domain-blocked';
  // The failed-link words name the way forward for the kind of link that
  // failed; a link whose kind is unknown names both.
  const newResetLinkOffered = failure === 'link-invalid' && link?.kind !== 'invitation' && Boolean(onRequestNewLink);
  const failureText = failure !== 'link-invalid' ? (failure ? copy[failure] : null)
    : link?.kind === 'invitation' ? LINK_COPY.linkInvalidInvitation
      : link?.kind === 'passwordReset' ? LINK_COPY.linkInvalidReset
        : newResetLinkOffered ? LINK_COPY.linkInvalidUnknown : LINK_COPY.linkInvalidUnknownNoReset;
  // Failed invitations and held recovery both need a contact when the member
  // has no administrator to ask. Reuse the shared mail link and its fallback.
  const recoveryHeld = failure === 'recovery-held';
  const supportOffered = recoveryHeld || (failure === 'link-invalid' && link?.kind !== 'passwordReset');
  return (
    <Screen nativeHeaderHeight={nativeHeaderHeight}>
      <View style={styles.content}>
        <Heading level={1}>{link?.kind === 'invitation' ? copy.invite : copy.reset}</Heading>
        {busy && <><ActivityIndicator color={theme.primary} accessibilityLabel={copy.checking} /><Body>{copy.checking}</Body></>}
        {done && <Body>{done === 'accepted' ? LINK_COPY.accepted : copy[done]}</Body>}
        {(invitationConsent || done === 'accepted') && <Body>{NEW_PASSWORD_RULE.en}</Body>}
        {resetOffered && !resetOpen && <>
          <Body muted>{LINK_COPY.passwordMissing}</Body>
          <Button label={LINK_COPY.resetPassword} variant="secondary" onPress={() => setResetOpen(true)} />
        </>}
        {/* The form's own back control says "Back to sign in", so it goes there. */}
        {resetOffered && resetOpen && <PasswordResetRequest initialEmail="" onBack={onSignIn} />}
        {invitationConsent && <>
          <Body>{LINK_COPY.invitationPassword}</Body>
          <Body>{copy.readTerms}</Body>
          <Body>{legalAcceptanceVersionLine()}</Body>
          {LEGAL_INSTRUMENTS.some((entry) => entry.status === 'pending-review') && <Body>{copy.notOperative}</Body>}
          {legalAcceptanceLinks().map((document) => <Pressable
            key={document.url}
            accessibilityRole="link"
            accessibilityLabel={document.label}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            style={styles.documentLink}
            onPress={() => { void openDocument(document.url); }}
          ><Body style={{ color: theme.primary, textDecorationLine: 'underline' }}>{document.label}</Body></Pressable>)}
          {documentFailed && <Body accessibilityRole="alert">{copy.documentFailed}</Body>}
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={LEGAL_ACCEPTANCE_CONSENT}
            accessibilityState={{ checked: agreed, disabled: busy }}
            disabled={busy}
            style={[styles.consent, { borderColor: theme.border }]}
            onPress={() => { setAgreed((value) => !value); }}
          ><Body>{agreed ? '☑' : '☐'} {LEGAL_ACCEPTANCE_CONSENT}</Body></Pressable>
          <ResidenceAgeFields
            residenceState={residenceState}
            onResidenceState={(code) => { setResidenceState(code); setStoreBlocked(false); }}
            ageAttested={ageAttested}
            onAgeAttested={setAgeAttested}
            disabled={busy}
          />
          <Body>{REFERRAL_COPY.fieldLabel}</Body>
          <TextInput accessibilityLabel={REFERRAL_COPY.fieldLabel} accessibilityHint={REFERRAL_COPY.fieldHint} style={fieldStyle} keyboardAppearance={theme.appearance} value={referralCode} editable={!busy} autoCapitalize="characters" autoCorrect={false} autoComplete="off" spellCheck={false} maxLength={16} onChangeText={setReferralCode} />
          <Body muted>{REFERRAL_COPY.fieldHint}</Body>
          {storeBlocked
            ? <View accessibilityLiveRegion="assertive" testID="email-auth-store-blocked">
              <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{LEGAL_ACCEPTANCE_STORE_BLOCKED}</Body>
            </View>
            : <Button label={failure ? copy.retry : LEGAL_ACCEPTANCE_ACTION}
              disabled={!consentComplete || busy || documentFailed} busy={busy} onPress={() => { void begin(); }}
              disabledReason={documentFailed ? undefined : legalAcceptanceMissing(agreed, isResidenceRegion(residenceState), ageAttested)} />}
        </>}
        {recovery && <>
          <Body>{recovery.status === 'challenge' && useRecovery ? copy.recoveryIntro : copy[recovery.status]}</Body>
          {recovery.status === 'enroll' && <><Body>{copy.key}</Body><Text selectable style={{ color: theme.foreground }}>{recovery.secret}</Text></>}
          <Body>{useRecovery ? copy.recoveryCode : copy.code}</Body>
          {useRecovery
            ? <TextInput accessibilityLabel={copy.recoveryCode} style={fieldStyle} keyboardAppearance={theme.appearance} value={code} editable={!busy} autoCapitalize="characters" autoCorrect={false} autoComplete="off" maxLength={32} onChangeText={(value) => setCode(value.replace(/[^A-Za-z0-9-]/g, ''))} />
            : <TextInput accessibilityLabel={copy.code} style={fieldStyle} keyboardAppearance={theme.appearance} value={code} editable={!busy} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" onChangeText={(value) => setCode(cleanAuthenticatorCode(value))} />}
          {recovery.status === 'challenge' && <Button label={useRecovery ? copy.useAuthenticator : copy.useRecovery} variant="secondary" disabled={busy}
            onPress={() => { setUseRecovery((value) => !value); setCode(''); setFailure(null); }} />}
          <Body>{copy.password}</Body>
          <TextInput accessibilityLabel={copy.password} accessibilityHint={lengthReason ? `${lengthReason} ${copy.requirements}` : copy.requirements} style={fieldStyle} keyboardAppearance={theme.appearance} value={password} editable={!busy} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" maxLength={NEW_PASSWORD_MAX} onChangeText={setPassword} />
          {lengthReason ? <Body style={{ color: theme.destructive }}>{lengthReason}</Body> : null}
          <Body>{copy.confirm}</Body>
          <TextInput accessibilityLabel={copy.confirm} accessibilityHint={copy.requirements} style={fieldStyle} keyboardAppearance={theme.appearance} value={confirmation} editable={!busy} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" maxLength={NEW_PASSWORD_MAX} onChangeText={setConfirmation} />
          <Body muted>{copy.requirements}</Body>
          <Button label={copy.finish} onPress={() => { void finish(); }} disabled={!canFinish} disabledReason={finishReason} busy={busy} />
        </>}
        {failureText && <Body accessibilityRole="alert">{failureText}</Body>}
        {supportOffered && <SupportLink language={!recoveryHeld && memberLanguage === 'es' ? 'es' : 'en'} description={LINK_COPY.noAdministrator} />}
        {newResetLinkOffered && <Button label={LINK_COPY.newResetLink} disabled={busy} onPress={() => onRequestNewLink?.()} />}
        {notice ? <Body accessibilityRole="alert">{notice}</Body> : null}
        {/* After an unfinished or held recovery the password outcome is uncertain
            and the recovery lock may still refuse a sign-in: only an
            administrator's two-step reset opens the way, so no sign-in here. */}
        {failure !== 'recovery-unfinished' && failure !== 'recovery-held' && <Button label={copy.signIn} variant="secondary" disabled={busy} onPress={onSignIn} />}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  documentLink: { minHeight: minimumTouchTarget, justifyContent: 'center', paddingVertical: spacing.sm },
  consent: { minHeight: minimumTouchTarget, justifyContent: 'center', padding: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, padding: spacing.md, fontSize: 16 },
});
