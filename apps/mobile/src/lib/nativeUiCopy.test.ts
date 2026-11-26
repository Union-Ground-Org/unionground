import { describe, expect, it } from 'vitest';
import { FEATURE_TITLES } from './featureCatalog';
import { LIVE_STAFF_DESK_LINES, LIVE_STAFF_ROLE_LABELS, MEMBER_FEATURE_GROUPS, STAFF_HAT_FUNCTIONS, withMyCampaignGroup, type LiveStaffRole } from './hatFunctions';
import { staffDeskNumberDestination, staffDeskNumberLabels, staffDeskNumbers } from './staffDeskNumbers';
import { MEMBER_SESSIONS_COPY, memberSessionsCopy, memberSessionsFailureMessage } from './memberSessionInventory';
import { supportAccountBody } from './supportContact';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { chapterLifecycleCopy } from './chapterLifecycleCopy';
import { nativeConnectionCopy } from './connectionSuggestionsShared';
import { nativeCatalogLabel, nativeFeatureMatches, nativeUiSpanish, nativeUiText, type NativeUiKey } from './nativeUiCopy';
import { whatMattersCopy } from './whatMattersCopy';
import { welcomeBackStepCopy } from './welcomeBackCopy';
import { nativeHomeAttentionCopy, nativeHomeWelcomeCopy, nativeCaseDeadlineCopy } from './nativeHomeCopy';
import { whatMattersNowCatalogue } from '../../../../src/lib/i18n/whatMattersNow.js';
import { welcomeBackCatalogue } from '../../../../src/lib/i18n/welcomeBack.js';
import { caseSignalsCatalogue } from '../../../../src/lib/i18n/caseSignals.js';
import { stewardStrings as webStewardEnglish } from '../../../../src/lib/i18n/locales/en/steward.js';
import { stewardStrings as webStewardSpanish } from '../../../../src/lib/i18n/locales/es/steward.js';
import { homeStrings as webHomeEnglish } from '../../../../src/lib/i18n/locales/en/home.js';
import { homeStrings as webHomeSpanish } from '../../../../src/lib/i18n/locales/es/home.js';
import { adminStrings as webAdminEnglish } from '../../../../src/lib/i18n/locales/en/admin.js';
import { adminStrings as webAdminSpanish } from '../../../../src/lib/i18n/locales/es/admin.js';
import { analyticsStrings as webAnalyticsEnglish } from '../../../../src/lib/i18n/locales/en/analytics.js';
import { analyticsStrings as webAnalyticsSpanish } from '../../../../src/lib/i18n/locales/es/analytics.js';

describe('native English and Spanish UI catalogue', () => {
  it('keeps bounded native Home copy equal to the existing area locales', () => {
    const pairs: Array<{ native: Record<'en' | 'es', Record<string, string>>; source: Record<'en' | 'es', Record<string, string>> }> = [
      { native: nativeHomeAttentionCopy, source: whatMattersNowCatalogue },
      { native: nativeHomeWelcomeCopy, source: welcomeBackCatalogue },
      { native: nativeCaseDeadlineCopy, source: caseSignalsCatalogue },
    ];
    const languages: Array<'en' | 'es'> = ['en', 'es'];
    for (const { native, source } of pairs) {
      expect(Object.keys(native.en).sort()).toEqual(Object.keys(native.es).sort());
      for (const language of languages) for (const [key, text] of Object.entries(native[language])) expect(text, key).toBe(source[language][key]);
    }
  });
  it('covers every entry and preserves interpolation fields', () => {
    for (const [english, spanish] of Object.entries(nativeUiSpanish)) {
      expect(spanish.trim(), english).not.toBe('');
      expect(spanish, english).not.toBe(english);
      expect(spanish.match(/\{\w+\}/g)?.sort() ?? [], english).toEqual(english.match(/\{\w+\}/g)?.sort() ?? []);
    }
  });
  // BUG-UG-NATIVE-IOS-TASK-DISCUSSION-HAS-NO-REPLY-FIELD-20261117
  //: the task conversation's reply
  // composer has Spanish for every word it shows or announces.
  it('covers the task conversation reply composer', () => {
    const t = nativeUiText('es');
    const keys: NativeUiKey[] = ['Reply in this task', 'Write a private update about this task…', 'Send message', 'Sending message', 'Reply sent.', 'That message could not be sent. Your draft is still here.'];
    for (const key of keys) {
      expect(t(key), key).not.toBe(key);
    }
  });
  it('uses informal Spanish in both private message send notices', () => {
    const t = nativeUiText('es');
    expect(t('That message could not be sent. Your draft is still here.'))
      .toBe('No se pudo enviar ese mensaje. Tu borrador sigue aquí.');
    expect(t('We could not confirm that your message was sent. Check the conversation before sending again.'))
      .toBe('No pudimos confirmar que se envió tu mensaje. Revisa la conversación antes de volver a enviarlo.');
  });
  it('covers worker navigation and every feature title', () => {
    const labels = [...Object.values(FEATURE_TITLES), ...MEMBER_FEATURE_GROUPS.flatMap((group) => [group.label, ...group.items.map((item) => item.label)])];
    for (const label of labels) expect(nativeCatalogLabel('es', label), label).not.toBe(label);
    expect(nativeCatalogLabel('en', 'Organizing rights')).toBe('Organizing rights');
    expect(nativeCatalogLabel('es', 'Organization-authored title')).toBe('Organization-authored title');
  });
  it('keeps navigation identity and permission-filtered catalogues unchanged', () => {
    const original = JSON.stringify({ MEMBER_FEATURE_GROUPS, STAFF_HAT_FUNCTIONS });
    const matches = MEMBER_FEATURE_GROUPS.flatMap((group) => group.items).filter((item) => nativeFeatureMatches(item, 'derechos'));
    expect(matches.map((item) => item.key)).toEqual(['rights']);
    expect(matches.every((item) => nativeFeatureMatches({ ...item, label: nativeCatalogLabel('es', item.label) }, 'rights'))).toBe(true);
    expect(MEMBER_FEATURE_GROUPS.flatMap((group) => group.items).filter((item) => nativeFeatureMatches(item, 'tasks'))).toEqual([]);
    expect(JSON.stringify({ MEMBER_FEATURE_GROUPS, STAFF_HAT_FUNCTIONS })).toBe(original);
    expect(nativeUiText('es')('Reminder from {author} · #{space}', { author: 'Robin', space: 'General' })).toBe('Recordatorio de Robin · #General');
  });
  it('uses existing Spanish home copy and preserves authored content', () => {
    const notice = { kind: 'unread_notice', urgency: 'info', notice: { id: 'n', title: 'Original campaign title' }, unread: 2, action: { kind: 'open_notices' } } satisfies Parameters<typeof whatMattersCopy>[0];
    expect(whatMattersCopy(notice, 'es')).toMatchObject({ reason: 'Tienes 2 avisos sin leer', line: 'Original campaign title', action: 'Abrir avisos' });
    expect(whatMattersCopy({ kind: 'caught_up', urgency: 'calm', action: null }, 'es').line).toBe('Nada necesita tu atención en este momento.');
    expect(welcomeBackStepCopy({ kind: 'poll', id: 'p', title: 'Original vote title' }, 'es')).toMatchObject({ label: 'Votar en la encuesta abierta', detail: 'Original vote title' });
  });
  // UX-UG-NATIVE-STAFF-DESKS-POLISH-BATCH-20261111 .
  const roles: LiveStaffRole[] = ['steward', 'coordinator', 'advisor', 'admin', 'vp'];
  it('covers every staff desk row, blurb, desk line, role and desk number', () => {
    const copy = [
      ...Object.values(STAFF_HAT_FUNCTIONS).flat().flatMap((item) => [item.label, ...(item.blurb ? [item.blurb] : [])]),
      ...Object.values(LIVE_STAFF_DESK_LINES), ...Object.values(LIVE_STAFF_ROLE_LABELS),
      ...roles.flatMap((role) => staffDeskNumberLabels(role).flatMap((label) => [label, ...[staffDeskNumberDestination(role, label).name ?? []].flat()])),
    ];
    for (const text of copy) expect(nativeCatalogLabel('es', text), text).not.toBe(text);
  });
  it('keeps shared desk wording and the native plain-language roles label in both languages', () => {
    const web: Record<string, string> = {
      'Open requests': 'steward.kpiOpen', 'Awaiting reply': 'steward.kpiAwaiting', 'Open issues': 'coordinator.kpiOpen', 'Due this week': 'coordinator.kpiDueWeek',
      'In arbitration': 'coordinator.kpiArb', 'Workers covered': 'advisor.kpiMembers', 'Staff seats': 'admin.kpiSeats',
      'Active issues': 'vp.kpiGrievances', 'Campaign workers': 'vp.kpiMembers',
      'Upcoming deadlines': 'coordinator.deadlinesTitle', 'Escalation funnel': 'coordinator.funnelTitle', 'Leadership team': 'vp.rosterTitle', 'Participation trend': 'vp.trendTitle',
    };
    const english: Record<string, string> = { ...webStewardEnglish, ...webHomeEnglish, ...webAdminEnglish, ...webAnalyticsEnglish };
    const spanish: Record<string, string> = { ...webStewardSpanish, ...webHomeSpanish, ...webAdminSpanish, ...webAnalyticsSpanish };
    for (const role of roles) for (const label of staffDeskNumberLabels(role)) expect([...Object.keys(web), 'Assigned roles'], label).toContain(label);
    //  intentionally replaces the web's developer-facing role label on native.
    expect(nativeCatalogLabel('en', 'Assigned roles')).toBe('Assigned roles');
    expect(nativeCatalogLabel('es', 'Assigned roles')).toBe('Roles asignados');
    for (const [label, key] of Object.entries(web)) {
      expect(english[key], key).toBe(label);
      expect(nativeCatalogLabel('es', label), key).toBe(spanish[key]);
    }
  });
  // UX-UG-NATIVE-ACCOUNT-SECURITY-SETTINGS-POLISH-BATCH-20261111 .
  it('covers every Account security message that arrives from a helper', () => {
    const kinds: Array<'transport' | 'service' | 'denied'> = ['transport', 'service', 'denied'];
    // deletionIssueCopy's own messages, read from its source (the component imports react-native).
    const deletion = readFileSync(new URL('../features/NativeAccountDeletion.tsx', import.meta.url), 'utf8');
    const issueBody = deletion.slice(deletion.indexOf('export function deletionIssueCopy'), deletion.indexOf('const styles'));
    const issueCopy = [...issueBody.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => (match[1] ?? "").replace(/\\'/g, "'")).filter((text) => text.includes(' '));
    expect(issueCopy).toHaveLength(5);
    const copy = [
      ...Object.values(MEMBER_SESSIONS_COPY),
      ...kinds.map((kind) => memberSessionsFailureMessage(kind)),
      ...issueCopy,
      supportAccountBody,
    ];
    for (const text of copy) expect(nativeCatalogLabel('es', text), text).not.toBe(text);
    expect(memberSessionsCopy('en')).toEqual(MEMBER_SESSIONS_COPY);
    expect(memberSessionsFailureMessage('denied', 'es')).toMatch(/^No se pudieron cargar sus sesiones/);
  });
});

const mobile = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, mobile), 'utf8');
type CopyPair = [string, string];
const replacements: [CopyPair, CopyPair, CopyPair, CopyPair, CopyPair, CopyPair, CopyPair, CopyPair] = [
  ["See your campaign's connected services and their setup.", 'Vea los servicios conectados de su campaña y su configuración.'],
  ['Create meetings and check-in codes.', 'Cree reuniones y códigos de registro.'],
  ['Campaign and local totals', 'Totales de la campaña y del local'],
  ["To remind this channel's staff, type /remind here, a time like tomorrow 9am, then your note.", 'Para recordarle algo al equipo de este canal, escribe “/remind here”, una hora como “tomorrow 9am” y tu nota.'],
  ['The channels you see depend on your current role and campaign.', 'Los canales que ves dependen de tu rol y tu campaña actuales.'],
  ['Assigned roles', 'Roles asignados'],
  ['Campaign agreements', 'Acuerdos entre campañas'],
  ['Connected services', 'Servicios conectados'],
];

//  / screenshot defect 13: scan actual literals and JSX text, excluding
// comments and tests. Match the reported phrases, not unrelated legal copy or
// RPC identifiers containing words such as aggregates or grants.
const developerTerms = /optional chapter connections and their setup status|separate desk row|chapter and local aggregates|staff tip:|live chapter channels honor|role grants|chapter handshakes|integration controls|controles de integraci[oó]n|consejo para el personal|fila de [aá]rea aparte|roles otorgados|(?<![\w-])handshake(?![\w-])|partners & handshakes|privacy-safe aggregates|aggregate only|integration credentials|solo (?:datos )?agregados (?:seguros|con privacidad)/i;
function interfaceStrings(source: ts.SourceFile): string[] {
  const strings: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) strings.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return strings;
}
describe('plain native staff copy (#9336)', () => {
  it('checks Spanish phrases and every interpolated template part without treating identifiers as copy', () => {
    const source = ts.createSourceFile('copy.ts', 'const handshakeOperations = `Controles de integración ${name} Handshake title ${name} Roles otorgados`;', ts.ScriptTarget.Latest, true);
    expect(interfaceStrings(source).filter((text) => developerTerms.test(text))).toEqual(['Controles de integración ', ' Handshake title ', ' Roles otorgados']);
    expect(interfaceStrings(ts.createSourceFile('ids.ts', 'const handshakeOperations = "connection-handshake:id";', ts.ScriptTarget.Latest, true)).some((text) => developerTerms.test(text))).toBe(false);
  });
  it('refuses the reported developer wording in interface strings', () => {
    const violations: string[] = [];
    for (const dir of ['app/', 'src/']) {
      for (const path of readdirSync(new URL(dir, mobile), { recursive: true, encoding: 'utf8' })) {
        if (!/\.tsx?$/.test(path) || /\.test\./.test(path)) continue;
        const source = ts.createSourceFile(path, read(`${dir}${path}`), ts.ScriptTarget.Latest, true);
        for (const text of interfaceStrings(source)) if (developerTerms.test(text)) violations.push(`${dir}${path}: ${text.trim()}`);
      }
    }
    for (const [english, spanish] of Object.entries(nativeUiSpanish)) {
      if (developerTerms.test(english) || developerTerms.test(spanish)) violations.push(`nativeUiSpanish: ${english}`);
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
  it.each(replacements)('provides English and Spanish for %s', (english, spanish) => {
    expect(nativeCatalogLabel('en', english)).toBe(english);
    expect(nativeCatalogLabel('es', english)).toBe(spanish);
  });
  it('uses the new desk descriptions in both Home and Work', () => {
    expect(STAFF_HAT_FUNCTIONS.admin.find((item) => item.key === 'admin')?.blurb).toBe(replacements[0][0]);
    expect(LIVE_STAFF_DESK_LINES.admin).toBe(replacements[0][0]);
    expect(STAFF_HAT_FUNCTIONS.admin.find((item) => item.key === 'admin-events')?.blurb).toBe(replacements[1][0]);
  });
  it('uses the new channel hints with translation and keeps the reminder command', () => {
    const channel = read('app/channel/[id].tsx');
    expect(channel).toContain(`t("${replacements[3][0]}")`);
    expect(channel).toContain(`t('${replacements[4][0]}')`);
    expect(channel).toContain('remindHereOn && !closed');
    expect(channel).toContain('if (remindCommand) { await remindHere(remindCommand); return; }');
    expect(replacements[3][1]).toContain('“/remind here”');
    expect(replacements[3][1]).toContain('“tomorrow 9am”');
  });
  it('translates the Pulse subtitle instead of leaving it in JSX text', () => {
    expect(read('src/features/LeadershipPulseScreen.tsx')).toContain(`catalogLabel('${replacements[2][0]}')`);
  });
  it('labels assigned roles without changing their count or destination', () => {
    expect(staffDeskNumberLabels('admin')).toEqual(['Staff seats', 'Assigned roles']);
    expect(staffDeskNumbers('admin', { data: [{ roles: ['admin', 'steward'] }, { roles: ['advisor'] }], error: null })).toEqual([
      { label: 'Staff seats', value: 2 }, { label: 'Assigned roles', value: 3 },
    ]);
    expect(staffDeskNumberDestination('admin', 'Assigned roles')).toEqual({ href: '/feature/chapter-memberships', name: 'Roles & access' });
  });
  it('keeps feature identities and destinations while naming agreements and services consistently', () => {
    expect(FEATURE_TITLES.partners).toBe('Campaign agreements');
    expect(FEATURE_TITLES.integrations).toBe('Connected services');
    for (const row of Object.values(STAFF_HAT_FUNCTIONS).flat()) {
      if (row.key === 'partners') expect(row).toMatchObject({ label: FEATURE_TITLES.partners, href: '/feature/partners' });
      if (row.key === 'integrations') expect(row).toMatchObject({ label: FEATURE_TITLES.integrations, href: '/feature/integrations' });
    }
    expect(chapterLifecycleCopy.en.title).toBe(FEATURE_TITLES.partners);
    expect(chapterLifecycleCopy.es.title).toBe(replacements[6][1]);
    expect(read('src/features/mi1/IntegrationControlsScreen.tsx')).toContain("catalogLabel('Connected services')");
  });
  it('uses agreements and privacy-safe totals throughout the same flow in both languages', () => {
    expect(chapterLifecycleCopy.en.startRequest).toBe('Start agreement request');
    expect(chapterLifecycleCopy.en.requestTitleA11y).toBe('Agreement request title');
    expect(chapterLifecycleCopy.en.purposeA11y).toBe('Agreement request purpose');
    expect(nativeConnectionCopy('en')('requestHandshake')).toBe('Request agreement');
    expect(nativeConnectionCopy('es')('requestHandshake')).toBe('Solicitar acuerdo');
    for (const language of ['en', 'es'] satisfies Array<'en' | 'es'>) {
      const expected = language === 'en' ? 'Privacy-safe totals only' : 'Solo totales que protegen la privacidad';
      expect(chapterLifecycleCopy[language].scopes.aggregate_only).toBe(expected);
      expect(nativeConnectionCopy(language)('aggregate_only')).toBe(expected);
    }
  });
  it.each([
    ['Partners & agreements', 'Aliados y acuerdos'],
    ['Find campaign connections, request an agreement, and follow your partnerships.', 'Busque conexiones con otras campañas, solicite un acuerdo y siga sus alianzas.'],
    ['Only organization administrators and the campaign chair set up connected services. This role cannot start a connection.', 'Solo los administradores de la organización y la presidencia configuran los servicios conectados. Este rol no puede iniciar una conexión.'],
    ['Membership movement over time. Totals only.', 'Cambios en la membresía con el tiempo. Solo totales.'],
    ['Staff with access in this organization now', 'Personal con acceso en esta organización ahora'],
  ])('translates the remaining same-flow copy: %s', (english, spanish) => {
    expect(nativeCatalogLabel('es', english)).toBe(spanish);
  });
});
