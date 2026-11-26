// Reuse the web's reviewed Spanish for native welcome-back copy.
import { nativeHomeWelcomeCopy } from './nativeHomeCopy';
import type { NativeLanguage } from './nativeUiCopy';

import type { WelcomeBackStep } from './welcomeBackShared';

export type WelcomeBackStepCopy = { label: string; detail: string; href: string };

export function welcomeBackText(language: NativeLanguage, key: keyof typeof nativeHomeWelcomeCopy.en, values: Record<string, string | number> = {}): string {
  return nativeHomeWelcomeCopy[language][key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
}

export function welcomeBackStepCopy(step: WelcomeBackStep, language: NativeLanguage = 'en'): WelcomeBackStepCopy {
  const tr = (key: keyof typeof nativeHomeWelcomeCopy.en, values?: Record<string, string | number>) => welcomeBackText(language, key, values);
  switch (step.kind) {
    case 'updates':
      return {
        label: tr(step.count === 1 ? 'welcomeBack.ctaUpdatesOne' : 'welcomeBack.ctaUpdates', { count: step.count }),
        detail: language === 'es' ? tr('welcomeBack.detailUpdates') : 'Your Activity list is the fastest way to see announcements, reminders and alerts meant for you.',
        href: '/notifications',
      };
    case 'poll':
      return { label: tr('welcomeBack.ctaPoll'), detail: step.title, href: '/feature/voting' };
    case 'event':
      return { label: tr('welcomeBack.ctaEvent'), detail: language === 'es' ? `${step.title} es lo próximo.` : `${step.title} is coming up next.`, href: '/feature/events' };
    case 'case':
      return {
        label: tr('welcomeBack.ctaCase', { reference: step.reference ?? tr('welcomeBack.caseFallback') }),
        detail: tr('welcomeBack.detailCase'),
        href: `/issue/${step.id}`,
      };
    default:
      return {
        label: tr('welcomeBack.ctaResources'),
        detail: tr('welcomeBack.detailResources'),
        href: '/feature/rights',
      };
  }
}
