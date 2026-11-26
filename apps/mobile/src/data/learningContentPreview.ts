// REQ-UG-QUOTES-MINI-LESSONS-20260928: the PREVIEW (demo) source for
// governed quotes and mini-lessons. It is an in-memory stand-in for the
// learning RPCs that follows the server's rules (module switches, selection,
// locale review, publication windows, revisions and audit history), so the
// demo exercises the same client validation and normalization as a live
// session. Every row is fictional and lives only in this process: nothing here
// can reach a live account, and a live session never reads it.

import {
  LEARNING_EDITABLE_FIELDS,
  LEARNING_WORKSPACE_PAGE,
  isLearningItemLive,
  learningPublicationIssues,
  normalizeLearningItem,
  validateLearningItem,
  type LearningAudience,
  type LearningItem,
  type LearningKind,
  type LearningLocale,
  type LearningLocaleState,
  type LearningScope,
} from '../lib/learningContentModel';
import type { LearningRpcClient } from '../services/learningContent';

type PreviewPolicyRow = {
  quotes_enabled: boolean;
  lessons_enabled: boolean;
  selected_ids: string[] | null;
  revision: number;
};

type PreviewHistoryRow = {
  contentId: string;
  revision: number;
  action: string;
  changedAt: string;
  changedBy: string | null;
  snapshot: LearningItem;
};

export type PreviewLearningStore = {
  items: LearningItem[];
  policies: Map<string, PreviewPolicyRow>;
  hidden: Map<string, boolean>;
  history: PreviewHistoryRow[];
  sequence: number;
};

export type PreviewLearningActor = {
  userId: string;
  hat: string;
  organizationId: string;
  chapterId: string | null;
};

type RpcResult = { data: unknown; error: unknown };

type FixtureFields = {
  kind: LearningKind;
  locale: LearningLocale;
  title: string;
  body: string;
  locale_state?: LearningLocaleState;
  attribution?: string;
  source?: string;
  rights_note?: string;
  review_note?: string;
  bullets?: string[];
  learning_outcome?: string;
  factual_claims?: boolean;
  priority?: number;
  audience?: LearningAudience;
};

const PUBLISHED_AT = '2026-01-05T14:00:00.000Z';

function fixtureId(sequence: number): string {
  return `ecececec-ecec-4ece-8ece-${sequence.toString(16).padStart(12, '0')}`;
}

function fixture(
  sequence: number,
  organizationId: string,
  fields: FixtureFields,
  publication: { status: LearningItem['status']; startsAt: string | null } = { status: 'published', startsAt: PUBLISHED_AT },
): LearningItem {
  return {
    id: fixtureId(sequence),
    scope: 'organization',
    organization_id: organizationId,
    chapter_id: null,
    kind: fields.kind,
    locale: fields.locale,
    locale_state: fields.locale_state ?? 'reviewed',
    audience: fields.audience ?? 'all',
    status: publication.status,
    title: fields.title,
    body: fields.body,
    attribution: fields.attribution ?? '',
    source: fields.source ?? '',
    rights_note: fields.rights_note ?? 'Written for the campaign by its own committee; reuse inside the campaign approved.',
    review_note: fields.review_note ?? 'Reviewed by the Harborview Care United organizing committee.',
    direction: '',
    tone: '',
    learning_outcome: fields.learning_outcome ?? '',
    bullets: fields.bullets ?? [],
    topics: [],
    factual_claims: fields.factual_claims ?? fields.kind === 'mini_lesson',
    priority: fields.priority ?? 0,
    is_default: false,
    starts_at: publication.startsAt,
    ends_at: null,
    revision: publication.status === 'draft' ? 1 : 2,
    provenance: {},
  };
}

function previewFixtures(organizationId: string, now: Date): LearningItem[] {
  // Every source is a fictional Union Ground guide written for the
  // fictional Harborview Care United campaign. The rights lessons describe
  // what workers can do and record; they never decide whether a given act
  // breaks the law, because that is a question for an advisor with the facts.
  const guide = 'Harborview Care United organizing guide, 2026 edition (fictional Union Ground guide)';
  const guideEs = 'Guía de organización de Harborview Care United, edición 2026 (guía ficticia de Union Ground)';
  const rights = 'Organizing rights in plain language, Union Ground guide (fictional)';
  const rightsEs = 'Derechos al organizarse en lenguaje sencillo, guía de Union Ground (ficticia)';
  const inThreeDays = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  return [
    fixture(1, organizationId, { kind: 'quote', locale: 'en', title: 'Showing up', body: 'Nobody on this floor got a better schedule by waiting alone. We get there by showing up for each other.', attribution: 'Maya Thompson, organizing committee, evening shift', source: 'Harborview Care United open meeting, March 2026', priority: 10 }),
    fixture(2, organizationId, { kind: 'quote', locale: 'en', title: 'Guard the list', body: 'The list of who has talked with us belongs to the committee. Keep it off work phones and out of group chats.', attribution: 'Elena Cruz, organizer', source: 'Harborview Care United committee training, April 2026' }),
    fixture(3, organizationId, { kind: 'quote', locale: 'en', title: 'Asking together', body: 'A question asked together is harder to ignore than a complaint made alone.', attribution: 'Jordan Kim, campaign chair', source: 'Harborview Care United campaign newsletter, June 2026' }),
    fixture(4, organizationId, { kind: 'mini_lesson', locale: 'en', title: 'Having a first conversation', body: 'A first organizing conversation is mostly listening. Ask what your coworker would change at work, why it matters to them, and whether they want to do something about it with others. Have it away from work time and work property when you can.', bullets: ['Ask open questions and listen more than you talk.', 'Find the issue your coworker cares about most.', 'Close with one small next step, like coming to a meeting.'], learning_outcome: 'Hold a first conversation that starts with your coworker’s issue.', factual_claims: false, source: guide, priority: 20 }),
    fixture(5, organizationId, { kind: 'mini_lesson', locale: 'en', title: 'Writing down what you saw', body: 'If a manager says or does something about the campaign, write it down the same day in your own words. Record what happened, not what you think it means. Keep the note at home, outside work systems, and share it with the committee.', bullets: ['Write the date, time and place.', 'Note who was there and the exact words used.', 'Keep copies of any notices, posters or messages.'], learning_outcome: 'Keep a dated, factual note the committee can use.', factual_claims: false, source: guide }),
    fixture(6, organizationId, { kind: 'mini_lesson', locale: 'en', title: 'Your rights while organizing', body: 'In many private workplaces, the law protects workers who act together to improve pay and working conditions. This is often called protected concerted activity. How it applies depends on the facts, so this lesson does not decide whether anything that happened to you was legal. Bring your notes to an advisor who can look at the details.', bullets: ['Talking with coworkers about pay and conditions is often protected.', 'Coverage depends on your employer and your job, so ask.', 'Write down what happened and let an advisor review it.'], learning_outcome: 'Know in plain language what acting together can cover, and where to ask.', source: rights }),
    fixture(7, organizationId, { kind: 'quote', locale: 'es', title: 'Presentarse', body: 'Nadie en este piso consiguió un mejor horario esperando a solas. Lo logramos cuando nos apoyamos unos a otros.', attribution: 'Maya Thompson, comité organizador, turno de la tarde', source: 'Reunión abierta de Harborview Care United, marzo de 2026', priority: 10 }),
    fixture(8, organizationId, { kind: 'quote', locale: 'es', title: 'Cuida la lista', body: 'La lista de quienes han hablado con nosotros le pertenece al comité. No la guardes en teléfonos del trabajo ni en chats de grupo.', attribution: 'Elena Cruz, organizadora', source: 'Capacitación del comité de Harborview Care United, abril de 2026' }),
    fixture(9, organizationId, { kind: 'mini_lesson', locale: 'es', title: 'Tener una primera conversación', body: 'Una primera conversación para organizarse consiste, sobre todo, en escuchar. Pregúntale a tu compañero qué cambiaría en el trabajo, por qué le importa y si quiere hacer algo al respecto junto con otras personas. Cuando puedas, tenla fuera del horario y del lugar de trabajo.', bullets: ['Haz preguntas abiertas y escucha más de lo que hablas.', 'Descubre el tema que más le importa a tu compañero.', 'Termina con un paso pequeño, como venir a una reunión.'], learning_outcome: 'Tener una primera conversación que parta del tema de tu compañero.', factual_claims: false, source: guideEs, priority: 20 }),
    fixture(10, organizationId, { kind: 'mini_lesson', locale: 'es', title: 'Tus derechos al organizarte', body: 'En muchos lugares de trabajo privados, la ley protege a quienes actúan juntos para mejorar el salario y las condiciones de trabajo. A esto se le suele llamar actividad concertada protegida. Cómo se aplica depende de los hechos, así que esta lección no decide si algo que te pasó fue legal o no. Lleva tus notas a una persona asesora que pueda revisar los detalles.', bullets: ['Hablar con tus compañeros sobre salario y condiciones suele estar protegido.', 'La protección depende de tu empleador y de tu puesto, así que pregunta.', 'Anota lo que pasó y pide a una persona asesora que lo revise.'], learning_outcome: 'Entender en lenguaje sencillo qué puede cubrir actuar en conjunto y a quién preguntar.', source: rightsEs }),
    fixture(11, organizationId, { kind: 'mini_lesson', locale: 'en', title: 'What happens after cards', body: 'Draft for review: why a card majority is not certification, and how voluntary recognition and an election are separate paths.', factual_claims: true, locale_state: 'draft', rights_note: '', review_note: '' }, { status: 'draft', startsAt: null }),
    fixture(12, organizationId, { kind: 'quote', locale: 'en', title: 'Bargaining a first contract', body: 'A first contract starts with the priorities workers wrote down together long before anyone sat at the table.', attribution: 'Andre Lewis, campaign lead', source: 'Harborview Care United first-contract priorities meeting, August 2026' }, { status: 'scheduled', startsAt: inThreeDays }),
  ];
}

export function createPreviewLearningStore(organizationId: string, now: Date = new Date()): PreviewLearningStore {
  const items = previewFixtures(organizationId, now);
  // The fictional platform switches are on so the demo shows the module; a
  // real platform starts with both off until its owner enables them.
  const policies = new Map<string, PreviewPolicyRow>([['platform', { quotes_enabled: true, lessons_enabled: true, selected_ids: null, revision: 1 }]]);
  return { items, policies, hidden: new Map(), history: [], sequence: items.length };
}

function scopeKey(scope: LearningScope, organizationId: string, chapterId: string | null): string {
  return scope === 'platform' ? 'platform' : scope === 'organization' ? `organization:${organizationId}` : `chapter:${chapterId ?? ''}`;
}

function scopeOf(value: unknown): LearningScope | null {
  return value === 'platform' || value === 'organization' || value === 'chapter' ? value : null;
}

function refuse(code: string, message: string): RpcResult {
  return { data: null, error: { code, message } };
}

function page<T>(rows: readonly T[], offset: number, size: number): { items: T[]; hasMore: boolean } {
  const slice = rows.slice(offset, offset + size + 1);
  return { items: slice.slice(0, size), hasMore: slice.length > size };
}

/** Member delivery and the selection picker never carry notes, direction or provenance. */
function delivered(item: LearningItem): Record<string, unknown> {
  const row: Record<string, unknown> = { ...item };
  for (const field of ['provenance', 'review_note', 'rights_note', 'direction']) delete row[field];
  return row;
}

function byId(left: LearningItem, right: LearningItem): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function createPreviewLearningRpcClient(
  store: PreviewLearningStore,
  actor: PreviewLearningActor,
  clock: () => Date = () => new Date(),
): LearningRpcClient {
  const manager = actor.hat === 'admin' || actor.hat === 'vp';
  const staff = actor.hat !== 'member';
  const policyRow = (key: string): PreviewPolicyRow | undefined => store.policies.get(key);
  const canManage = (scope: LearningScope) => scope !== 'platform' && manager;
  const inTenant = (item: LearningItem, chapterId: string | null) => item.scope === 'platform'
    || (item.organization_id === actor.organizationId && (item.scope === 'organization' || item.chapter_id === chapterId));
  const touch = (key: string) => {
    const row = policyRow(key);
    if (row) row.revision += 1;
    else store.policies.set(key, { quotes_enabled: true, lessons_enabled: true, selected_ids: null, revision: 1 });
  };
  const audit = (item: LearningItem, action: string) => {
    store.history.unshift({ contentId: item.id, revision: item.revision, action, changedAt: clock().toISOString(), changedBy: actor.userId, snapshot: item });
    touch(scopeKey(item.scope, actor.organizationId, item.chapter_id));
  };

  function effectivePolicy(chapterId: string | null) {
    const platform = policyRow('platform');
    const organization = policyRow(`organization:${actor.organizationId}`);
    const chapter = policyRow(`chapter:${chapterId ?? ''}`);
    const hidden = store.hidden.get(actor.userId) ?? false;
    return {
      organizationId: actor.organizationId,
      chapterId,
      quotesEnabled: Boolean(platform?.quotes_enabled) && (organization?.quotes_enabled ?? true) && (chapter?.quotes_enabled ?? true),
      lessonsEnabled: Boolean(platform?.lessons_enabled) && (organization?.lessons_enabled ?? true) && (chapter?.lessons_enabled ?? true),
      homeHidden: hidden,
      canManage: canManage('chapter'),
      isPlatformOwner: false,
      version: [platform?.revision ?? 0, organization?.revision ?? 0, chapter?.revision ?? 0, hidden].join(':'),
    };
  }

  async function rpc(name: string, args: Record<string, unknown>): Promise<RpcResult> {
    const chapterId = typeof args.p_chapter_id === 'string' ? args.p_chapter_id : null;
    if (chapterId === null || chapterId !== actor.chapterId) return refuse('42501', 'campaign unavailable');
    const now = clock();
    const offset = args.p_offset === undefined ? 0 : Number(args.p_offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) return refuse('22023', 'invalid offset');
    switch (name) {
      case 'get_learning_policy':
        return { data: effectivePolicy(chapterId), error: null };
      case 'list_learning_content': {
        const locale = args.p_locale;
        const kind = args.p_kind ?? null;
        const limit = Number(args.p_limit);
        if ((locale !== 'en' && locale !== 'es') || (kind !== null && kind !== 'quote' && kind !== 'mini_lesson') || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          return refuse('22023', 'invalid content query');
        }
        const policy = effectivePolicy(chapterId);
        const organizationIds = policyRow(`organization:${actor.organizationId}`)?.selected_ids ?? null;
        const chapterIds = policyRow(`chapter:${chapterId}`)?.selected_ids ?? null;
        const rows = store.items
          .filter((item) => isLearningItemLive(item, now.getTime())
            && item.locale === locale
            && (kind === null || item.kind === kind)
            && ((item.kind === 'quote' && policy.quotesEnabled) || (item.kind === 'mini_lesson' && policy.lessonsEnabled))
            && (item.audience === 'all' || (item.audience === 'staff' && staff) || (item.audience === 'members' && !staff))
            && (item.scope === 'platform'
              ? item.is_default || Boolean(organizationIds?.includes(item.id)) || Boolean(chapterIds?.includes(item.id))
              : inTenant(item, chapterId))
            && (organizationIds === null || organizationIds.includes(item.id))
            && (chapterIds === null || chapterIds.includes(item.id)))
          .sort((left, right) => (right.priority - left.priority) || byId(left, right))
          .map(delivered);
        return { data: page(rows, offset, limit), error: null };
      }
      case 'list_learning_choices': {
        const scope = scopeOf(args.p_scope ?? 'chapter');
        if (!scope || !canManage(scope)) return refuse('42501', 'content administration unavailable');
        const rows = store.items
          .filter((item) => (item.status === 'published' || item.status === 'scheduled') && item.locale_state === 'reviewed'
            && (item.ends_at === null || Date.parse(item.ends_at) > now.getTime())
            && (item.scope === 'platform' || (scope !== 'platform' && item.organization_id === actor.organizationId
              && (item.scope === 'organization' || (scope === 'chapter' && item.chapter_id === chapterId)))))
          .sort(byId)
          .map(delivered);
        return { data: page(rows, offset, LEARNING_WORKSPACE_PAGE), error: null };
      }
      case 'get_learning_workspace': {
        const scope = scopeOf(args.p_scope ?? 'chapter');
        if (!scope || !canManage(scope)) return refuse('42501', 'content administration unavailable');
        const row = policyRow(scopeKey(scope, actor.organizationId, chapterId));
        const rows = store.items
          .filter((item) => item.scope === scope && inTenant(item, chapterId))
          .sort(byId);
        return {
          data: {
            ...page(rows, offset, LEARNING_WORKSPACE_PAGE),
            policy: row
              ? { quotes_enabled: row.quotes_enabled, lessons_enabled: row.lessons_enabled, selected_ids: row.selected_ids, revision: row.revision }
              : { quotes_enabled: true, lessons_enabled: true, selected_ids: null, revision: 0 },
            canManage: true,
            isPlatformOwner: false,
          },
          error: null,
        };
      }
      case 'save_learning_policy': {
        const scope = scopeOf(args.p_scope);
        if (!scope || !canManage(scope)) return refuse('42501', 'content administration unavailable');
        const quotes = args.p_quotes_enabled;
        const lessons = args.p_lessons_enabled;
        const requested = args.p_selected_ids;
        if (typeof quotes !== 'boolean' || typeof lessons !== 'boolean'
          || (requested !== null && requested !== undefined && (!Array.isArray(requested) || requested.length > 500))) {
          return refuse('22023', 'invalid content policy');
        }
        const ids = Array.isArray(requested) ? requested.map(String) : null;
        const selectable = (item: LearningItem) => item.scope === 'platform'
          || (item.organization_id === actor.organizationId && (item.scope === 'organization' || (scope === 'chapter' && item.chapter_id === chapterId)));
        if (ids?.some((id) => !store.items.some((item) => item.id === id && selectable(item)))) return refuse('42501', 'selection outside scope');
        const key = scopeKey(scope, actor.organizationId, chapterId);
        if (args.p_expected_revision !== (policyRow(key)?.revision ?? 0)) return refuse('PT409', 'revision conflict');
        const saved: PreviewPolicyRow = { quotes_enabled: quotes, lessons_enabled: lessons, selected_ids: ids, revision: (policyRow(key)?.revision ?? 0) + 1 };
        store.policies.set(key, saved);
        return { data: { scope, ...saved }, error: null };
      }
      case 'save_learning_content': {
        const scope = scopeOf(args.p_scope);
        if (!scope || !canManage(scope)) return refuse('42501', 'content administration unavailable');
        const input = args.p_item && typeof args.p_item === 'object' && !Array.isArray(args.p_item) ? args.p_item as Record<string, unknown> : null;
        if (!input || Object.keys(input).some((key) => key !== 'id' && !(LEARNING_EDITABLE_FIELDS as readonly string[]).includes(key))) {
          return refuse('22023', 'invalid content limits or fields');
        }
        const id = typeof input.id === 'string' ? input.id : null;
        const index = id === null ? -1 : store.items.findIndex((item) => item.id === id);
        const existing = index >= 0 ? store.items[index] : undefined;
        if (id !== null && (!existing || existing.scope !== scope || !inTenant(existing, chapterId))) return refuse('42501', 'content unavailable');
        if (id === null && args.p_expected_revision !== null && args.p_expected_revision !== undefined) return refuse('PT409', 'revision conflict');
        if (existing && args.p_expected_revision !== existing.revision) return refuse('PT409', 'revision conflict');
        // The row is rebuilt through the same strict normalizer the client
        // applies to server answers; anything it cannot verify is refused.
        const row = normalizeLearningItem({
          ...input,
          id: existing ? existing.id : fixtureId(store.sequence + 1),
          scope,
          organization_id: actor.organizationId,
          chapter_id: scope === 'chapter' ? chapterId : null,
          status: 'draft',
          starts_at: null,
          ends_at: null,
          revision: existing ? existing.revision + 1 : 1,
          provenance: existing?.provenance ?? {},
        });
        if (!row || validateLearningItem(row, { mode: 'save', scope }).length > 0) return refuse('22023', 'invalid content limits or fields');
        if (existing) store.items[index] = row;
        else {
          store.sequence += 1;
          store.items.push(row);
        }
        audit(row, 'save_draft');
        return { data: row, error: null };
      }
      case 'transition_learning_content': {
        const index = store.items.findIndex((item) => item.id === args.p_id);
        const existing = store.items[index];
        if (!existing || !inTenant(existing, chapterId)) return refuse('42501', 'content unavailable');
        if (!canManage(existing.scope)) return refuse('42501', 'content administration unavailable');
        if (args.p_expected_revision !== existing.revision) return refuse('PT409', 'revision conflict');
        const action = args.p_action;
        if (action !== 'publish' && action !== 'schedule' && action !== 'withdraw') return refuse('22023', 'invalid publication action');
        const endsAt = typeof args.p_ends_at === 'string' ? args.p_ends_at : null;
        const startsAt = action === 'publish' ? now.toISOString() : typeof args.p_starts_at === 'string' ? args.p_starts_at : null;
        if (action !== 'withdraw') {
          if (learningPublicationIssues(existing).length > 0) return refuse('22023', 'source, reuse rights and locale review required');
          if (!startsAt || (action === 'schedule' && Date.parse(startsAt) <= now.getTime()) || (endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt))) {
            return refuse('22023', 'invalid publication window');
          }
        }
        const updated: LearningItem = {
          ...existing,
          status: action === 'publish' ? 'published' : action === 'schedule' ? 'scheduled' : 'withdrawn',
          starts_at: action === 'withdraw' ? null : startsAt,
          ends_at: action === 'withdraw' ? null : endsAt,
          revision: existing.revision + 1,
        };
        store.items[index] = updated;
        audit(updated, action);
        return { data: updated, error: null };
      }
      case 'get_learning_history': {
        const existing = store.items.find((item) => item.id === args.p_id);
        if (!existing || !inTenant(existing, chapterId) || !canManage(existing.scope)) return refuse('42501', 'content unavailable');
        const rows = store.history
          .filter((entry) => entry.contentId === existing.id)
          .map((entry) => ({ revision: entry.revision, action: entry.action, changed_at: entry.changedAt, changed_by: entry.changedBy, snapshot: entry.snapshot }));
        return { data: page(rows, offset, LEARNING_WORKSPACE_PAGE), error: null };
      }
      case 'set_learning_home_hidden':
        if (typeof args.p_hidden !== 'boolean') return refuse('22023', 'hidden flag required');
        store.hidden.set(actor.userId, args.p_hidden);
        return { data: { homeHidden: args.p_hidden }, error: null };
      default:
        return refuse('42883', 'function does not exist');
    }
  }

  return { rpc };
}

// One fictional store for the whole demo session, so hiding on Home and
// restoring from Know your rights (or an edit in the manager) agree.
let sharedPreviewStore: PreviewLearningStore | null = null;
let sharedPreviewOrganization: string | null = null;

export function previewLearningStore(organizationId: string): PreviewLearningStore {
  if (!sharedPreviewStore || sharedPreviewOrganization !== organizationId) {
    sharedPreviewStore = createPreviewLearningStore(organizationId);
    sharedPreviewOrganization = organizationId;
  }
  return sharedPreviewStore;
}
