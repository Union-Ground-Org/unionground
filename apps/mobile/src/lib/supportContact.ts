// The one support contact the native app quotes (Account, sign-in, the MFA
// screen, Messages and account deletion read it from here). Union Ground
// publishes no support mailbox yet (src/lib/publicContact.js on the web), so
// the address is null: the Help and support link renders nothing and the
// bodies below say so instead of inventing an address. Add an owner-approved
// Union Ground mailbox here once it exists; never a sibling product's address.
export const supportEmail: string | null = null;
export const supportEmailUrl: string | null = supportEmail ? `mailto:${supportEmail}` : null;

export type SupportLanguage = 'en' | 'es';

export type SupportLinkCopy = {
  /** Spoken and visible name of the link. */
  label: string;
  /** Accessibility hint: where one tap goes. */
  hint: string;
  /** In-app text when the OS refuses the mailto URL; keeps the address visible. */
  openFailure: string;
};

export const supportLinkCopy: Record<SupportLanguage, SupportLinkCopy> = {
  en: {
    label: 'Help and support',
    hint: `Opens a new email to ${supportEmail} in your mail app.`,
    openFailure: `Union Ground could not open a mail app. Write to ${supportEmail} from any email account.`,
  },
  es: {
    label: 'Ayuda y soporte',
    hint: `Abre un correo nuevo a ${supportEmail} en tu aplicación de correo.`,
    openFailure: `Union Ground no pudo abrir una aplicación de correo. Escribe a ${supportEmail} desde cualquier cuenta de correo.`,
  },
};

/** Account row body: what the mailbox is for, and where chapter questions go instead. */
export const supportAccountBody = supportEmail
  ? `Email ${supportEmail} about sign-in, your account or the app. Campaign questions go to the committee in Messages.`
  : 'No support mailbox is published yet. Campaign questions go to the committee in Messages.';
/** Sign-in screen body under the link. */
export const supportSignInBody = supportEmail
  ? `Trouble signing in or with an invitation? Email ${supportEmail}.`
  : 'Trouble signing in or with an invitation? Ask the person who invited you.';
/** MFA screen body under the link. */
export const supportMfaBody = supportEmail
  ? `Cannot reach them? Email ${supportEmail} and we will put you in touch.`
  : 'Cannot reach them? Ask the person who invited you.';

export type SupportOpenResult =
  | { opened: true }
  | { opened: false; message: string };

export async function openSupportEmail(
  openUrl: (url: string) => Promise<unknown>,
): Promise<void> {
  if (!supportEmailUrl) throw new Error('No support mailbox is published.');
  await openUrl(supportEmailUrl);
}

// Never throws: a phone with no mail app, or an OS that refuses mailto, leaves
// the member on a working screen with the address still readable instead of
// an unhandled rejection or an OS alert that ignores the app theme.
export async function openSupportEmailWithFallback(
  openUrl: (url: string) => Promise<unknown>,
  language: SupportLanguage = 'en',
): Promise<SupportOpenResult> {
  try {
    await openSupportEmail(openUrl);
    return { opened: true };
  } catch {
    return { opened: false, message: supportLinkCopy[language].openFailure };
  }
}
