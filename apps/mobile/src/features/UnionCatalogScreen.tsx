import { useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { useRouter } from 'expo-router';

import { Body, Button, Card, Heading, Screen, SearchField, StateMessage } from '../components/ui';
import { useApp } from '../state/AppProvider';
import { getCatalogProfileClient, getPublicCatalogClient, readUnionProfile, readUnionSearch } from '../services/unionCatalog';
import { CATALOG_KEY_PATTERN } from '../../../../src/features/unionCatalog/catalogSearch.js';
import { PUBLIC_SITE_ORIGIN } from '../lib/publicSite';

const copy = {
  en: {
    title: 'Find a union to affiliate with', search: 'Search unions to affiliate with', hint: 'Union name, city or local number', go: 'Search',
    disclaimer: 'Public records describe existing unions a campaign might join or affiliate with. Listing a union here is not an endorsement and does not connect your campaign to it.',
    continueLabel: 'Read public downloads', unavailable: 'Catalog unavailable', unavailableBody: 'Public catalog data is not available in this environment. Nothing about your campaign has changed.',
    loading: 'Loading public records…', failed: 'Unable to load public records', retry: 'Try again', empty: 'No matching unions',
    previous: 'Previous page', next: 'Next page', results: 'Results', details: 'View union structure & resources', noDetails: 'Registry record; detailed catalog profile unavailable.',
    parents: 'Part of', children: 'Related union bodies', subunits: 'Locals & sub-units', seats: 'Seat outlines',
    splitParentNotice: 'More than one parent body is possible for this organization. This listing does not yet say which.',
    relationshipCertainty: { filed: 'from a public filing', confirmed: 'confirmed', inferred: 'not confirmed by a filing', split: 'one of several possible bodies' },
    documents: 'Published documents & resources', sources: 'Sources', contacts: 'Organization contacts', more: 'Show more',
    notFound: 'No published profile', notFoundBody: 'No active catalog profile matches this exact identity.',
    open: 'Open source', linkError: 'Unable to open this source.', sourceOnly: 'Opens the original public source.',
    registry: 'Registry results. Detailed catalog data is currently unavailable.', updated: 'Research date', confidence: 'Source confidence',
    counts: 'listed / vacant', noResources: 'No published document links in this profile.',
    fullName: 'Full name', membersOnly: 'Document links are for Union Ground workers.', requestInvitation: 'Request an invite', untitled: 'Untitled document',
    kinds: { contract: 'Contract', bylaws: 'Bylaws', form: 'Form', newsletter: 'Newsletter', handbook: 'Handbook', other: 'Other document' },
  },
  es: {
    title: 'Buscar un sindicato con el cual afiliarse', search: 'Buscar sindicatos para afiliarse', hint: 'Nombre, ciudad o número de local', go: 'Buscar',
    disclaimer: 'Los registros públicos describen sindicatos existentes a los que una campaña podría unirse o afiliarse. Que un sindicato aparezca aquí no es un respaldo ni conecta su campaña con él.',
    continueLabel: 'Leer descargas públicas', unavailable: 'Catálogo no disponible', unavailableBody: 'El catálogo público no está disponible en este entorno. Nada de su campaña ha cambiado.',
    loading: 'Cargando registros públicos…', failed: 'No se pudieron cargar los registros', retry: 'Reintentar', empty: 'No se encontraron sindicatos',
    previous: 'Página anterior', next: 'Página siguiente', results: 'Resultados', details: 'Ver estructura y recursos del sindicato', noDetails: 'Registro sin perfil detallado disponible.',
    parents: 'Forma parte de', children: 'Organizaciones relacionadas', subunits: 'Locales y subunidades', seats: 'Puestos',
    splitParentNotice: 'Esta organización puede depender de más de un organismo superior. Este listado todavía no indica cuál.',
    relationshipCertainty: { filed: 'según un informe público', confirmed: 'confirmado', inferred: 'sin confirmar en un informe público', split: 'uno de varios organismos posibles' },
    documents: 'Documentos publicados y recursos', sources: 'Fuentes', contacts: 'Contactos de la organización', more: 'Mostrar más',
    notFound: 'Sin perfil publicado', notFoundBody: 'Ningún perfil activo corresponde a esta identidad exacta.',
    open: 'Abrir fuente', linkError: 'No se pudo abrir esta fuente.', sourceOnly: 'Abre la fuente pública original.',
    registry: 'Resultados del registro. El catálogo detallado no está disponible.', updated: 'Fecha de investigación', confidence: 'Confianza de la fuente',
    counts: 'registrados / vacantes', noResources: 'Este perfil no tiene enlaces a documentos publicados.',
    fullName: 'Nombre completo', membersOnly: 'Los enlaces a los documentos son para trabajadores de Union Ground.', requestInvitation: 'Pedir una invitación', untitled: 'Documento sin título',
    kinds: { contract: 'Contrato', bylaws: 'Estatutos', form: 'Formulario', newsletter: 'Boletín', handbook: 'Manual', other: 'Otro documento' },
  },
} as const;

// Accounts are by invitation; a visitor asks for one on the public site. The
// button names the member invite the way the website does (#9540, C-11,
// option A): "Request an invite", in Spanish "Pedir una invitación".
// Requests to join go to the deployment's own public site (lib/publicSite);
// a copy with none configured offers no request link.
export const REQUEST_INVITATION_URL: string | null = PUBLIC_SITE_ORIGIN ? `${PUBLIC_SITE_ORIGIN}/request-invite` : null;

function catalogLabel(labels: Readonly<Record<string, string>>, key: string | null): string | null {
  return key && Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] ?? null : null;
}

export function useUnionCatalogCopy() {
  const { memberLanguage, dashboard } = useApp();
  const language = memberLanguage ?? dashboard?.member.language ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return copy[language.toLowerCase().startsWith('es') ? 'es' : 'en'];
}

type SearchResult = Awaited<ReturnType<typeof readUnionSearch>>;
type Profile = Awaited<ReturnType<typeof readUnionProfile>>;

export function UnionCatalogScreen({ catalogKey }: { catalogKey?: string }) {
  const t = useUnionCatalogCopy();
  const { mode, session } = useApp();
  // A token refresh must not reload the screen; only signing in or out does.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const memberId = mode === 'authenticated' ? session?.user?.id ?? null : null;
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [request, setRequest] = useState({ query: '', page: 0, attempt: 0 });
  const [result, setResult] = useState<SearchResult | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('idle');
  const [limit, setLimit] = useState(50);
  const [linkError, setLinkError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResult(null); setProfile(null); setLimit(50); setLinkError(false);
    const client = mode === 'preview' ? null : getPublicCatalogClient();
    if (!client) { setState('unavailable'); return; }
    // Only a profile read carries the member's session (document links are
    // for members); searches stay anonymous.
    const profileClient = getCatalogProfileClient(memberId ? sessionRef.current : null) ?? client;
    if (!catalogKey && !request.query) { setState('idle'); return; }
    setState('loading');
    void (async () => {
      try {
        if (catalogKey) {
          const data = await readUnionProfile(profileClient, catalogKey);
          if (!cancelled) setProfile(data);
        } else {
          const data = await readUnionSearch(client, request.query, request.page);
          if (!cancelled) setResult(data);
        }
        if (!cancelled) setState('ready');
      } catch { if (!cancelled) setState('error'); }
    })();
    return () => { cancelled = true; };
  }, [catalogKey, mode, memberId, request]);

  const openProfile = (key: string) => {
    if (CATALOG_KEY_PATTERN.test(key)) router.push(`/public/unions/${key}` as never);
  };
  const openSource = (href: string) => {
    setLinkError(false);
    void Linking.openURL(href).catch(() => setLinkError(true));
  };
  const details = profile?.found ? profile : null;
  const visibleParents = details?.parents.filter((parent) => parent.certainty !== 'split') ?? [];
  const retry = () => setRequest((r) => ({ ...r, attempt: r.attempt + 1 }));

  return <Screen>
    <Heading>{details?.organization?.name ?? t.title}</Heading>
    {/* The page title stays at two lines (ui.tsx), and a catalog name can be up
        to 1,000 characters (record #8743), so the profile also gives the full
        name as wrapping text. A screen reader already reads the whole title,
        so this line is hidden from it and the name is announced once. */}
    {details?.organization?.name && <Body accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{t.fullName}: {details.organization.name}</Body>}
    <Body muted>{t.disclaimer}</Body>
    {/* With no catalog there is nothing to search, so the field is not
        offered as if it worked (audit MOB-PUBLIC-03). */}
    {!catalogKey && state !== 'unavailable' && <>
      <SearchField value={query} onChangeText={setQuery} placeholder={t.hint} accessibilityLabel={t.search} />
      <Button label={t.go} disabled={state === 'loading' || query.trim().length < 1 || query.trim().length > 80}
        onPress={() => setRequest({ query: query.trim(), page: 0, attempt: request.attempt + 1 })} />
    </>}
    {state === 'loading' && <Body accessibilityRole="alert">{t.loading}</Body>}
    {state === 'error' && <StateMessage title={t.failed} body={t.disclaimer} action={<Button label={t.retry} onPress={retry} />} />}
    {state === 'unavailable' && <StateMessage title={t.unavailable} body={t.unavailableBody} action={<Button label={t.continueLabel} variant="secondary" onPress={() => router.push('/offline' as never)} />} />}
    {linkError && <Body accessibilityRole="alert">{t.linkError}</Body>}
    {state === 'ready' && result && <>
      <Heading level={2}>{t.results}: {result.total}{result.totalCapped ? '+' : ''}</Heading>
      {result.source === 'registry' && <Body muted>{t.registry}</Body>}
      {!result.rows.length && <Body>{t.empty}</Body>}
      {result.rows.map((row) => row && <Card key={row.id}>
        <Heading level={3}>{row.name}</Heading>
        <Body muted>{[row.affiliation, row.designation, row.localNumber, row.city, row.state].filter(Boolean).join(' · ')}</Body>
        {CATALOG_KEY_PATTERN.test(row.id) && !('registryOnly' in row && row.registryOnly)
          ? <Button label={t.details} variant="secondary" onPress={() => openProfile(row.id)} />
          : <Body muted>{t.noDetails}</Body>}
        {row.website && <Button label={`${t.open}: ${row.website.host}`} variant="secondary" onPress={() => openSource(row.website!.href)} />}
      </Card>)}
      <Button label={t.previous} disabled={request.page === 0} variant="secondary" onPress={() => setRequest((r) => ({ ...r, page: r.page - 1 }))} />
      <Button label={t.next} disabled={!result.hasNext} variant="secondary" onPress={() => setRequest((r) => ({ ...r, page: r.page + 1 }))} />
    </>}
    {state === 'ready' && catalogKey && !details && <StateMessage title={t.notFound} body={t.notFoundBody} />}
    {state === 'ready' && details && <>
      <Body muted>{[details.organization?.affiliation, details.organization?.city, details.organization?.state].filter(Boolean).join(' · ')}</Body>
      {details.organization?.confidence && <Body muted>{t.confidence}: {details.organization.confidence}</Body>}
      {details.organization?.researchedOn && <Body muted>{t.updated}: {details.organization.researchedOn}</Body>}
      {details.parents.length > 0 && <Card>
        <Heading level={2}>{t.parents}</Heading>
        {visibleParents.map(({ key, parentKey, parentName, parentLabel, certainty }) => {
          const name = parentKey ? parentName ?? parentLabel ?? parentKey : parentLabel;
          const label = [name, catalogLabel(t.relationshipCertainty, certainty)].filter(Boolean).join(' · ');
          return parentKey
            ? <Button key={key} label={label} variant="secondary" onPress={() => openProfile(parentKey)} />
            : <Body key={key}>{label}</Body>;
        })}
        {visibleParents.length < details.parents.length && <Body>{t.splitParentNotice}</Body>}
      </Card>}
      {!!details.children.length && <Card>
        <Heading level={2}>{t.children} ({details.childrenTotal})</Heading>
        {details.children.slice(0, limit).map((child) => <Button
          key={`${child.key}:${child.edgeKind}`}
          label={[child.name ?? child.key, catalogLabel(t.relationshipCertainty, child.certainty)].filter(Boolean).join(' · ')}
          variant="secondary"
          onPress={() => openProfile(child.key)}
        />)}
      </Card>}
      {!!details.subunits.length && <Card><Heading level={2}>{t.subunits} ({details.subunits.length})</Heading>{details.subunits.slice(0, limit).map((unit) => <Body key={unit.key}>{unit.name}{(unit.kindLabel ?? unit.kind) ? ` · ${unit.kindLabel ?? unit.kind}` : ''}</Body>)}</Card>}
      {!!details.seats.length && <Card><Heading level={2}>{t.seats}</Heading>{details.seats.slice(0, limit).map((seat) => <Body key={seat.key}>{seat.title} — {seat.listed} / {seat.vacant} ({t.counts})</Body>)}</Card>}
      {!!details.contacts.length && <Card><Heading level={2}>{t.contacts}</Heading>{details.contacts.map((contact) => contact.link
        ? <Button key={contact.key} label={contact.link.host} variant="secondary" onPress={() => openSource(contact.link!.href)} />
        : <Body key={contact.key}>{contact.value}</Body>)}</Card>}
      <Card><Heading level={2}>{t.documents} ({details.documents.length})</Heading>
        {details.documentLinks === 'members' && !!details.documents.length
          ? <><Body muted>{t.membersOnly}</Body>{REQUEST_INVITATION_URL ? <Button label={t.requestInvitation} variant="secondary" onPress={() => openSource(REQUEST_INVITATION_URL)} /> : null}</>
          : <Body muted>{t.sourceOnly}</Body>}
        {!details.documents.length && <Body>{t.noResources}</Body>}
        {details.documents.slice(0, limit).map((document) => document.link
          ? <Button key={document.key} label={[document.title ?? t.open, document.link.host, document.asOf].filter(Boolean).join(' · ')} variant="secondary" onPress={() => openSource(document.link!.href)} />
          : <Body key={document.key}>{[catalogLabel(t.kinds, document.kind), document.title ?? t.untitled, document.asOf].filter(Boolean).join(' · ')}</Body>)}
      </Card>
      <Card><Heading level={2}>{t.sources}</Heading>{details.sources.map((source) => <Button key={source.href} label={source.host} variant="secondary" onPress={() => openSource(source.href)} />)}</Card>
      {Math.max(details.subunits.length, details.documents.length, details.children.length, details.seats.length) > limit && <Button label={t.more} variant="secondary" onPress={() => setLimit((n) => n + 50)} />}
    </>}
  </Screen>;
}
