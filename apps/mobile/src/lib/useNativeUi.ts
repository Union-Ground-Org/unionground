import { useApp } from '../state/AppProvider';
import { nativeCatalogLabel, nativeUiText, type NativeLanguage } from './nativeUiCopy';

export function useNativeUi() {
  const { memberLanguage, dashboard } = useApp();
  const language: NativeLanguage = (memberLanguage ?? dashboard?.member?.language) === 'es' ? 'es' : 'en';
  const locale: 'en-US' | 'es-US' = language === 'es' ? 'es-US' : 'en-US';
  return {
    language,
    locale,
    t: nativeUiText(language),
    catalogLabel: (label: string) => nativeCatalogLabel(language, label),
  };
}
