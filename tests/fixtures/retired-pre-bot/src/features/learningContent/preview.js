// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
import {
  LEARNING_LIMITS,
  LEARNING_PAGE_SIZE,
  buildLearningItemPayload,
  isLearningItemLive,
  learningPublicationIssues,
  normalizeLearningHistoryPage,
  normalizeLearningItem,
  normalizeLearningPage,
  normalizeLearningPolicy,
  normalizeLearningScopePolicy,
  normalizeLearningWorkspace,
  validateLearningItem,
  validateLearningTransition,
} from "../../../../../../src/features/learningContent/model.js";

// Interactive fiction for the credential-free preview harness. It speaks the
// same interface as createLearningContentApi and applies the same rules
// through the shared model, but it never touches a network, a session or a
// real organization. Every fixture is explicitly fictional sample writing;
// nothing is attributed to a real person or source. State lives in this tab
// only and resets on reload.

const DAY_MS = 86400000;

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fixtureRows({ organizationId, chapterId, nowMs }) {
  const past = new Date(nowMs - DAY_MS).toISOString();
  const future = new Date(nowMs + 2 * DAY_MS).toISOString();
  const shared = {
    organization_id: organizationId, chapter_id: chapterId, scope: "chapter",
    audience: "all", tone: "", direction: "", topics: [], bullets: [], learning_outcome: "",
    is_default: false, revision: 2, provenance: {},
  };
  const reviewed = {
    locale_state: "reviewed", status: "published", starts_at: past, ends_at: null,
    rights_note: "Fictional sample written for this preview.", review_note: "Preview sample; never published.",
  };
  return [
    { ...shared, ...reviewed, id: "preview-quote-en-1", kind: "quote", locale: "en", priority: 0,
      title: "Sample quote: showing up", body: "Every meeting starts with someone deciding to walk through the door.",
      attribution: "A fictional sample speaker", source: "Union Ground preview sample", factual_claims: false },
    { ...shared, ...reviewed, id: "preview-quote-en-2", kind: "quote", locale: "en", priority: 0,
      title: "Sample quote: asking early", body: "A question asked early saves a dozen complaints later.",
      attribution: "", source: "", factual_claims: false },
    { ...shared, ...reviewed, id: "preview-lesson-en-1", kind: "mini_lesson", locale: "en", priority: 10,
      title: "Sample lesson: keep a simple work log",
      body: "Write down what happened as soon as you can: the date, who was there, and what was said. Short notes made at the time are easier to rely on than memories weeks later.",
      bullets: ["Date and time", "Who was present", "What was said or done"],
      learning_outcome: "Keep notes you can rely on later.", topics: ["Record keeping"],
      attribution: "", source: "", factual_claims: false },
    { ...shared, ...reviewed, id: "preview-lesson-en-2", kind: "mini_lesson", locale: "en", priority: 0,
      title: "Sample lesson: prepare for a meeting",
      body: "Before a meeting with a supervisor, write down the one or two points you most want to make and any question you want answered.",
      bullets: ["Pick one or two points", "Write your questions down"], learning_outcome: "Walk in with a short plan.",
      attribution: "", source: "", factual_claims: false },
    { ...shared, ...reviewed, id: "preview-quote-es-1", kind: "quote", locale: "es", priority: 0,
      title: "Cita de muestra: presentarse", body: "Cada reunión empieza cuando alguien decide cruzar la puerta.",
      attribution: "Una persona ficticia de muestra", source: "Muestra de vista previa de Union Ground", factual_claims: false },
    { ...shared, ...reviewed, id: "preview-lesson-es-1", kind: "mini_lesson", locale: "es", priority: 10,
      title: "Lección de muestra: lleva un registro sencillo",
      body: "Anota lo que pasó lo antes posible: la fecha, quién estaba y qué se dijo. Las notas breves tomadas en el momento son más confiables que los recuerdos de semanas después.",
      bullets: ["Fecha y hora", "Quién estaba presente", "Qué se dijo o se hizo"],
      learning_outcome: "Tener notas confiables para después.", topics: ["Registros"],
      attribution: "", source: "", factual_claims: false },
    { ...shared, ...reviewed, id: "preview-lesson-en-scheduled", kind: "mini_lesson", locale: "en", priority: 0,
      status: "scheduled", starts_at: future,
      title: "Sample lesson: know your meeting notes", body: "A scheduled sample that starts in two days.",
      attribution: "", source: "", factual_claims: false },
    { ...shared, id: "preview-quote-en-draft", kind: "quote", locale: "en", priority: 0, locale_state: "draft",
      status: "draft", starts_at: null, ends_at: null, revision: 1,
      title: "Sample draft: still in review", body: "A draft sample waiting for its rights and review notes.",
      attribution: "A fictional sample writer", source: "", rights_note: "", review_note: "", factual_claims: false },
  ];
}

export function createLearningPreviewStore({ organizationId, chapterId, now = () => Date.now() }) {
  const createdAt = now();
  const rows = new Map(fixtureRows({ organizationId, chapterId, nowMs: createdAt }).map((row) => [row.id, row]));
  const history = new Map([...rows.keys()].map((id) => [id, [{
    revision: rows.get(id).revision, action: rows.get(id).status === "draft" ? "save_draft" : "publish",
    changed_at: new Date(createdAt - DAY_MS).toISOString(), changed_by: "preview-editor", snapshot: { ...rows.get(id) },
  }]]));
  const policies = {
    // Fiction starts with both modules on so the preview has something to show.
    platform: { quotes_enabled: true, lessons_enabled: true, selected_ids: null, revision: 1 },
    organization: { quotes_enabled: true, lessons_enabled: true, selected_ids: null, revision: 1 },
    chapter: { quotes_enabled: true, lessons_enabled: true, selected_ids: null, revision: 1 },
  };
  return { organizationId, chapterId, now, rows, history, policies, homeHidden: false, sequence: 0 };
}

function touch(store, scope) {
  store.policies[scope] = { ...store.policies[scope], revision: store.policies[scope].revision + 1 };
}

function audit(store, row, action) {
  const entries = store.history.get(row.id) || [];
  entries.unshift({ revision: row.revision, action, changed_at: new Date(store.now()).toISOString(), changed_by: "preview-self", snapshot: { ...row } });
  store.history.set(row.id, entries);
  touch(store, row.scope);
}

function policyFor(store) {
  const { platform, organization, chapter } = store.policies;
  return {
    organizationId: store.organizationId,
    chapterId: store.chapterId,
    quotesEnabled: platform.quotes_enabled && organization.quotes_enabled && chapter.quotes_enabled,
    lessonsEnabled: platform.lessons_enabled && organization.lessons_enabled && chapter.lessons_enabled,
    homeHidden: store.homeHidden,
    canManage: true,
    isPlatformOwner: true,
    version: [platform.revision, organization.revision, chapter.revision, store.homeHidden].join(":"),
  };
}

function pageOf(list, offset, limit) {
  return { items: list.slice(offset, offset + limit), hasMore: list.length > offset + limit };
}

function asynchronously(work) {
  return Promise.resolve().then(work);
}

function checked(value, normalize) {
  const normalized = normalize(JSON.parse(JSON.stringify(value)));
  if (normalized == null) throw refuse("P0001", "invalid preview response");
  return normalized;
}

export function createLearningPreviewApi(store) {
  return {
    preview: true,
    getPolicy() {
      return asynchronously(() => checked(policyFor(store), normalizeLearningPolicy));
    },
    listContent({ locale, kind = null, offset = 0, limit = LEARNING_PAGE_SIZE.home }) {
      return asynchronously(() => {
        const policy = policyFor(store);
        const nowMs = store.now();
        const idsO = store.policies.organization.selected_ids;
        const idsC = store.policies.chapter.selected_ids;
        const visible = [...store.rows.values()].filter((row) => (
          isLearningItemLive(row, nowMs)
          && row.locale === locale
          && (kind == null || row.kind === kind)
          && (row.kind === "quote" ? policy.quotesEnabled : policy.lessonsEnabled)
          && (row.scope !== "platform" || row.is_default || idsO?.includes(row.id) || idsC?.includes(row.id))
          && (idsO == null || idsO.includes(row.id))
          && (idsC == null || idsC.includes(row.id))
        )).sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : 1))
          .map(({ provenance: _provenance, review_note: _review, rights_note: _rights, direction: _direction, ...delivered }) => delivered);
        return checked(pageOf(visible, offset, limit), normalizeLearningPage);
      });
    },
    getWorkspace({ scope, offset = 0 }) {
      return asynchronously(() => {
        const list = [...store.rows.values()].filter((row) => row.scope === scope).sort((a, b) => (a.id < b.id ? -1 : 1));
        return checked({ ...pageOf(list, offset, LEARNING_PAGE_SIZE.workspace), policy: store.policies[scope], canManage: true, isPlatformOwner: true }, normalizeLearningWorkspace);
      });
    },
    listChoices({ scope, offset = 0 }) {
      return asynchronously(() => {
        const nowMs = store.now();
        const list = [...store.rows.values()].filter((row) => (
          (row.status === "published" || row.status === "scheduled") && row.locale_state === "reviewed"
          && (row.ends_at == null || Date.parse(row.ends_at) > nowMs)
          && (row.scope === "platform" || (scope !== "platform" && (row.scope === "organization" || scope === "chapter")))
        )).sort((a, b) => (a.id < b.id ? -1 : 1))
          .map(({ provenance: _provenance, review_note: _review, rights_note: _rights, direction: _direction, ...choice }) => choice);
        return checked(pageOf(list, offset, LEARNING_PAGE_SIZE.workspace), normalizeLearningPage);
      });
    },
    savePolicy({ scope, quotesEnabled, lessonsEnabled, selectedIds, expectedRevision }) {
      return asynchronously(() => {
        if (expectedRevision !== store.policies[scope].revision) throw refuse("PT409", "revision conflict");
        if (typeof quotesEnabled !== "boolean" || typeof lessonsEnabled !== "boolean") throw refuse("22023", "invalid content policy");
        if (selectedIds != null && (scope === "platform" || selectedIds.length > LEARNING_LIMITS.selectedIds)) throw refuse("22023", "invalid content policy");
        store.policies[scope] = {
          quotes_enabled: quotesEnabled, lessons_enabled: lessonsEnabled,
          selected_ids: selectedIds == null ? null : [...selectedIds], revision: store.policies[scope].revision + 1,
        };
        return checked(store.policies[scope], normalizeLearningScopePolicy);
      });
    },
    saveContent({ scope, draft, expectedRevision = null }) {
      return asynchronously(() => {
        if (validateLearningItem(draft, { mode: "save", scope }).length) throw refuse("22023", "invalid content limits or fields");
        const { id, ...payload } = buildLearningItemPayload(draft);
        let row;
        if (!id) {
          if (expectedRevision != null) throw refuse("PT409", "revision conflict");
          store.sequence += 1;
          row = {
            ...payload, id: `preview-new-${store.sequence}`, scope, organization_id: scope === "platform" ? null : store.organizationId,
            chapter_id: scope === "chapter" ? store.chapterId : null, status: "draft", starts_at: null, ends_at: null,
            revision: 1, provenance: {},
          };
        } else {
          const current = store.rows.get(id);
          if (!current || current.scope !== scope) throw refuse("42501", "content unavailable");
          if (expectedRevision !== current.revision) throw refuse("PT409", "revision conflict");
          row = { ...current, ...payload, status: "draft", starts_at: null, ends_at: null, revision: current.revision + 1 };
        }
        store.rows.set(row.id, row);
        audit(store, row, "save_draft");
        return checked(row, normalizeLearningItem);
      });
    },
    transition({ id, action, expectedRevision, startsAt = null, endsAt = null }) {
      return asynchronously(() => {
        const current = store.rows.get(id);
        if (!current) throw refuse("42501", "content unavailable");
        if (expectedRevision !== current.revision) throw refuse("PT409", "revision conflict");
        const nowMs = store.now();
        if (!["publish", "schedule", "withdraw"].includes(action)) throw refuse("22023", "invalid publication action");
        if (action !== "withdraw") {
          if (learningPublicationIssues(current).length) throw refuse("22023", "source, reuse rights and locale review required");
          if (validateLearningTransition({ action, startsAt, endsAt, nowMs }).length) throw refuse("22023", "invalid publication window");
        }
        const start = action === "publish" ? new Date(nowMs).toISOString() : startsAt;
        const row = {
          ...current,
          status: action === "publish" ? "published" : action === "schedule" ? "scheduled" : "withdrawn",
          starts_at: action === "withdraw" ? null : start,
          ends_at: action === "withdraw" ? null : endsAt,
          revision: current.revision + 1,
        };
        store.rows.set(id, row);
        audit(store, row, action);
        return checked(row, normalizeLearningItem);
      });
    },
    getHistory({ id, offset = 0 }) {
      return asynchronously(() => {
        if (!store.rows.has(id)) throw refuse("42501", "content unavailable");
        return checked(pageOf(store.history.get(id) || [], offset, LEARNING_PAGE_SIZE.history), normalizeLearningHistoryPage);
      });
    },
    setHomeHidden({ hidden }) {
      return asynchronously(() => {
        if (typeof hidden !== "boolean") throw refuse("22023", "hidden flag required");
        store.homeHidden = hidden;
        return hidden;
      });
    },
  };
}

// One fiction per preview tab and scope, so the Learn editor and the Home
// card see the same sample world.
const previewStores = new Map();

export function sharedLearningPreviewApi({ organizationId, chapterId }) {
  const key = `${organizationId}|${chapterId}`;
  if (!previewStores.has(key)) previewStores.set(key, createLearningPreviewStore({ organizationId, chapterId }));
  return createLearningPreviewApi(previewStores.get(key));
}
