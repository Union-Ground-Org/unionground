import { nativeUiText, type NativeLanguage, type NativeUiText } from './nativeUiCopy';

// The phone's own language, for the signed-out sign-in screen where no member
// language is saved yet. Hermes reports the device locale through Intl.
export function deviceLanguage(): NativeLanguage {
  try {
    return /^es(?:-|$)/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

// The demo's entry and exit speak English and Spanish: the member's saved
// language once the demo persona's profile is read, the phone's before that.
export function storeDemoText(memberLanguage: string | null | undefined, device: () => NativeLanguage = deviceLanguage): NativeUiText {
  const language: NativeLanguage = memberLanguage === 'es' || memberLanguage === 'en' ? memberLanguage : device();
  return nativeUiText(language);
}
