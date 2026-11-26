import type { CompassSource, CompassSourceDestination } from '../models/member';
import { appRouteFromRouterPath, isPublicAppRoute, parseAppRoute, routerPath } from './routes';

type CompassSourcePayload = Omit<CompassSource, 'destination'>;

const RIGHTS_SOURCE_KINDS = new Set([
  'article',
  'contract',
  'contract-clause',
  'faq',
  'knowledge',
  'knowledge-article',
  'resource',
  'rights',
]);
const CHAPTER_SOURCE_KINDS = new Set(['chapter-document', 'document', 'library-document']);
const PUBLIC_SOURCE_KINDS = new Set(['page', 'public', 'public-page']);

function normalizedKind(kind: string): string {
  return kind.trim().toLocaleLowerCase().replace(/[\s_]+/g, '-');
}

function publicDestination(ref: string): CompassSourceDestination | null {
  const value = ref.trim();
  const route = value.startsWith('/')
    ? appRouteFromRouterPath(value)
    : parseAppRoute(value);
  if (!isPublicAppRoute(route)) return null;
  const path = route ? routerPath(route) : null;
  return path?.startsWith('/public/') ? path as CompassSourceDestination : null;
}

/**
 * Resolve only routes the native app already owns. The server's display ref is
 * not treated as an arbitrary href: public refs must parse as an allowlisted
 * app route, while approved knowledge kinds land in their existing readers.
 */
export function compassSourceDestination(
  source: Pick<CompassSourcePayload, 'id' | 'kind' | 'ref'>,
): CompassSourceDestination | null {
  const kind = normalizedKind(source.kind);
  if (PUBLIC_SOURCE_KINDS.has(kind)) return publicDestination(source.ref);
  // A kb: id is a knowledge-base article, which only the knowledge reader can
  // open (it matches kb:<slug>), even when its ref says "Chapter library"; the
  // chapter reader matches only raw or doc: chapter-document ids (#7536 review).
  if (source.id.startsWith('kb:')) return `/feature/rights?source=${encodeURIComponent(source.id)}`;
  if (CHAPTER_SOURCE_KINDS.has(kind) || /^chapter library\s*·/iu.test(source.ref)) {
    return `/feature/chapter?source=${encodeURIComponent(source.id)}`;
  }
  if (RIGHTS_SOURCE_KINDS.has(kind)
    || /^(contract|know your rights|knowledge base)\s*·?/iu.test(source.ref)) {
    return `/feature/rights?source=${encodeURIComponent(source.id)}`;
  }
  return null;
}

export function compassSourceMatchesReaderRecord(
  sourceID: string | undefined,
  prefix: 'kb' | 'rights' | 'doc',
  recordID: string,
): boolean {
  return sourceID === recordID || sourceID === `${prefix}:${recordID}`;
}

export function compassSourceWithDestination(source: CompassSourcePayload): CompassSource {
  return { ...source, destination: compassSourceDestination(source) };
}

export function compassSourcesWithDestinations(value: unknown): CompassSource[] {
  if (!Array.isArray(value)) return [];
  const entries: unknown[] = value;
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.kind !== 'string'
      || typeof record.title !== 'string' || typeof record.ref !== 'string') return [];
    return [compassSourceWithDestination({
      id: record.id,
      kind: record.kind,
      title: record.title,
      ref: record.ref,
    })];
  });
}

export function activateCompassSource(
  source: CompassSource,
  navigate: (destination: CompassSourceDestination) => void,
  populate: (draft: string) => void,
): 'opened' | 'populated' {
  if (source.destination) {
    navigate(source.destination);
    return 'opened';
  }
  populate(`Tell me more about ${source.title} (${source.ref}).`);
  return 'populated';
}
