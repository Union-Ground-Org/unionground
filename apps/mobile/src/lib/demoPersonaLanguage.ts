import type { MemberProfile } from '../models/member';
import type { NativeLanguage } from './nativeUiCopy';
import { deviceLanguage } from './storeDemoCopy';

// #9776 (BUG-UG-DEMO-SHELL-ROLE-MENU-STUCK-OPEN-AND-STEWARD-OPENS-IN-SPANISH-20261124):
// the six demo people are shared accounts, so the language one of them has
// saved belongs to nobody in particular (the Steward had Spanish saved, and
// every English visitor who switched to Steward got the whole app in Spanish).
// In the demo the app shows the visitor's language instead: the phone's own
// language, or the one the visitor chose in the demo. The choice is kept in
// memory only for the current demo visit, including role switches. It is
// never saved on the shared account.
let visitorChoice: NativeLanguage | null = null;

export function demoVisitorLanguage(device: () => NativeLanguage = deviceLanguage): NativeLanguage {
  return visitorChoice ?? device();
}

export function chooseDemoVisitorLanguage(language: NativeLanguage): void {
  visitorChoice = language;
}

/** Forget the visitor's choice when their demo visit ends. */
export function resetDemoVisitorLanguage(): void {
  visitorChoice = null;
}

/** The member as the app shows it: a shared demo person speaks the visitor's language. */
export function shownDemoMember<T extends Pick<MemberProfile, 'language'>>(sharedDemoPerson: boolean, member: T, device?: () => NativeLanguage): T {
  if (!sharedDemoPerson) return member;
  const language = demoVisitorLanguage(device);
  return member.language === language ? member : { ...member, language };
}
