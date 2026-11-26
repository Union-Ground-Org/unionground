import spanishCopy from './nativeUiSpanish.json';
import { featureMatchesSearch, normalizeFeatureSearch, type HatFunction } from './hatFunctions';

// Member-facing native chrome uses the saved profile language on both platforms.
// Source text is the typed English catalogue; Spanish must cover every key.
// Call this only for app-owned copy, never for names or member-authored content.
export const nativeUiSpanish = spanishCopy satisfies Record<string, string>;

export type NativeLanguage = 'en' | 'es';
export type NativeUiKey = keyof typeof nativeUiSpanish;
export type NativeUiText = (key: NativeUiKey, values?: Record<string, string | number>) => string;

export function nativeUiText(language: NativeLanguage): NativeUiText {
  return (key, values = {}) => {
    const template = language === 'es' ? nativeUiSpanish[key] : key;
    return template.replace(/\{(\w+)\}/g, (match: string, name: string) => String(values[name] ?? match));
  };
}

/** For app-owned catalogues whose labels arrive as strings. Never pass user text. */
export function nativeCatalogLabel(language: NativeLanguage, label: string): string {
  return language === 'es' && Object.hasOwn(nativeUiSpanish, label)
    ? nativeUiSpanish[label as NativeUiKey]
    : label;
}

/** Fallback for records that carry a machine key and no display label. */
export function readableRecordKey(value: string): string {
  const words = value.replace(/[_.-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Search both catalogues irrespective of the current display language. Stable
// keys, authorized rows and Main's alternate search terms are retained.
export function nativeFeatureMatches(item: HatFunction, query: string): boolean {
  const english = Object.entries(nativeUiSpanish).find(([, spanish]) => spanish === item.label)?.[0] ?? item.label;
  return featureMatchesSearch({ ...item, label: english }, query)
    || normalizeFeatureSearch(nativeCatalogLabel('es', english)).includes(normalizeFeatureSearch(query));
}
