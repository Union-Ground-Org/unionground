// REQ-UG-LEARNING-PERIOD-BANNER-HISTORY-UNDO-UI-20261103 (#6947):
// the learning-period client, shared by web and the native app. It calls the
// engine's RPCs as they are (20261103163000_learning_period_engine.sql) and
// adds nothing of its own on the server. A failure keeps the server's code
// and message so the line can show the reason; nothing here retries a write.
import { normalizeHistory, normalizePeriod, undoChain } from "./model.js";

export const HISTORY_PAGE = 50;

/**
 * @typedef {object} LearningPeriodApi
 * @property {import("./model.js").LearningPeriod | null | undefined} [initialPeriod] A synchronous fixture snapshot, when already known.
 * @property {() => Promise<import("./model.js").LearningPeriod | null>} period
 * @property {(lengthDays: 7 | 14) => Promise<import("./model.js").LearningPeriod | null>} start
 * @property {() => Promise<import("./model.js").LearningPeriod | null>} endEarly
 * @property {(before?: string | null) => Promise<import("./model.js").LearningHistory | null>} history
 * @property {(entryId: string, version: number) => Promise<{ status: string, undoneCount: number }>} undo
 */

function failure(error, fallback) {
  const out = new Error(typeof error?.message === "string" && error.message ? error.message : fallback);
  out.code = typeof error?.code === "string" ? error.code : null;
  return out;
}

/**
 * @param {{ rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown, error: unknown }> }} client
 * @returns {LearningPeriodApi}
 */
export function createLearningPeriodApi(client) {
  async function call(request, clean) {
    const { data, error } = await request;
    if (error) throw failure(error, "learning period request failed");
    const cleaned = clean(data);
    if (!cleaned) throw failure(null, "learning period response unreadable");
    return cleaned;
  }
  return {
    period: () => call(client.rpc("get_organization_learning_period", {}), normalizePeriod),
    start: (lengthDays) => call(client.rpc("start_organization_learning_period", { p_length_days: lengthDays === 7 ? 7 : 14 }), normalizePeriod),
    endEarly: () => call(client.rpc("end_organization_learning_period_early", {}), normalizePeriod),
    history: (before = null) => call(client.rpc("list_my_learning_history", { p_limit: HISTORY_PAGE, p_before: before }), normalizeHistory),
    undo: (entryId, version) => call(client.rpc("undo_my_learning_action", { p_entry_id: entryId, p_expected_version: version }),
      (data) => data && typeof data === "object" && typeof data.status === "string"
        ? { status: data.status, undoneCount: Number.isInteger(data.undoneCount) ? data.undoneCount : 0 } : null),
  };
}

const DAY = 24 * 60 * 60 * 1000;

// Fictional fixture rows for the preview and the tests: a period that ends
// in nine days and a history with every kind of line. Targets are made-up
// ids; nothing here names a real person or organization.
export function demoLearningFixture(now = Date.now(), { isAdmin = true, taskIds = [] } = {}) {
  const [first = "demo-task-1", second = "demo-task-2"] = taskIds;
  const at = (minutesAgo) => new Date(now - minutesAgo * 60 * 1000).toISOString();
  const startsAt = new Date(now - 5 * DAY).toISOString();
  const entry = (id, actionKind, domain, disposition, targetTable, targetId, minutesAgo, extra = {}) => ({
    id, actionKind, domain, disposition, targetTable, targetId, parentEntryId: null, state: disposition === "permanent" ? "kept" : "active",
    version: 1, createdAt: at(minutesAgo), undoneAt: null, keptAt: disposition === "permanent" ? at(minutesAgo) : null,
    sent: disposition === "permanent", undoable: disposition === "reverse", ...extra,
  });
  return {
    period: {
      organizationId: "demo-organization", used: true, running: true, periodId: "demo-period", lengthDays: 14,
      startsAt, endsAt: new Date(now - 5 * DAY + 14 * DAY).toISOString(), endedEarlyAt: null, closedAt: null, isAdmin,
    },
    entries: [
      entry("00000000-0000-4000-8000-000000000006", "task_move", "tasks", "reverse", "public.chapter_tasks", first, 12),
      entry("00000000-0000-4000-8000-000000000005", "task_comment", "tasks", "permanent", "public.chapter_task_comments", "demo-comment-1", 25),
      entry("00000000-0000-4000-8000-000000000004", "task_edit", "tasks", "reverse", "public.chapter_tasks", first, 40),
      entry("00000000-0000-4000-8000-000000000003", "task_create", "tasks", "reverse", "public.chapter_tasks", first, 55),
      entry("00000000-0000-4000-8000-000000000002", "task_file_remove", "tasks", "permanent", "public.chapter_task_files", "demo-file-1", 80),
      entry("00000000-0000-4000-8000-000000000001", "task_create", "tasks", "reverse", "public.chapter_tasks", second, 120,
        { state: "undone", version: 2, undoneAt: at(100), undoable: false }),
    ],
    flags: new Map([[`public.chapter_tasks:${first}`, "practice"], [`public.chapter_tasks:${second}`, "practice_edit"]]),
  };
}

// UX-UG-DEMO-ADMIN-OPENS-ON-ONE-TIME-LEARNING-PERIOD-20261108: the
// shared demo organization's period is one-time and belongs to every
// visitor, so a demo session reads it as a member does. The Admin desk opens
// on its work instead of the offer, no surface shows Start or End early, and
// a start or end that still reaches this client is refused before any
// request is sent. Real organizations use the client unchanged. The member
// reads are named one by one, so a later organization-level method is closed
// here until it is added on purpose.
/**
 * @param {LearningPeriodApi | null} api
 * @returns {LearningPeriodApi | null}
 */
export function withoutOrganizationControls(api) {
  if (!api) return api;
  const refused = async () => {
    const error = new Error("learning period controls are closed in the shared demo");
    error.code = "shared-demo-account";
    throw error;
  };
  return Object.defineProperty({
    history: (before) => api.history(before),
    undo: (entryId, version) => api.undo(entryId, version),
    period: async () => {
      const period = await api.period();
      return period ? { ...period, isAdmin: false } : period;
    },
    start: refused,
    endEarly: refused,
  }, "initialPeriod", { get() {
    const period = api.initialPeriod;
    return period === undefined ? undefined : period ? { ...period, isAdmin: false } : null;
  } });
}

// The fixture twin of the client: same shapes, kept in memory, so the
// preview walks the whole flow without a backend.
export function createDemoLearningPeriodApi(fixture = demoLearningFixture()) {
  const state = { period: { ...fixture.period }, entries: fixture.entries.map((entry) => ({ ...entry })) };
  const running = () => state.period.running && !state.period.endedEarlyAt;
  const historyPayload = () => ({
    running: running(),
    entries: state.entries.map((entry) => ({ ...entry, undoable: running() && entry.state === "active" && entry.disposition === "reverse" })),
  });
  return Object.defineProperty({
    period: async () => normalizePeriod(state.period),
    start: async (lengthDays) => {
      if (state.period.used) { const error = new Error("learning period already used"); error.code = "55000"; throw error; }
      const startsAt = new Date();
      state.period = { ...state.period, used: true, running: true, lengthDays, startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + lengthDays * DAY).toISOString() };
      return normalizePeriod(state.period);
    },
    endEarly: async () => {
      if (!running()) { const error = new Error("learning period not running"); error.code = "55000"; throw error; }
      const ending = new Date().toISOString();
      state.period = { ...state.period, running: false, endedEarlyAt: ending, closedAt: ending };
      state.entries = state.entries.map((entry) => entry.state === "active" ? { ...entry, state: "kept", keptAt: ending, version: entry.version + 1 } : entry);
      return normalizePeriod(state.period);
    },
    history: async () => normalizeHistory(historyPayload()),
    undo: async (entryId, version) => {
      const requested = state.entries.find((entry) => entry.id === entryId);
      if (!requested) { const error = new Error("learning entry not found"); error.code = "P0002"; throw error; }
      if (requested.state === "undone") return { status: "already_undone", undoneCount: 0 };
      if (!running()) { const error = new Error("the learning period has ended"); error.code = "55000"; throw error; }
      if (requested.version !== version) { const error = new Error("learning entry changed"); error.code = "40001"; throw error; }
      const chain = undoChain(entryId, normalizeHistory(historyPayload()).entries);
      const ids = new Set(chain.map((entry) => entry.id));
      const undoneAt = new Date().toISOString();
      state.entries = state.entries.map((entry) => ids.has(entry.id) ? { ...entry, state: "undone", undoneAt, version: entry.version + 1 } : entry);
      return { status: "undone", undoneCount: ids.size };
    },
  // Non-enumerable boot metadata keeps the closed action surface unchanged.
  // The fixture already knows this value; no asynchronous read is needed to paint.
  }, "initialPeriod", { get() { return normalizePeriod(state.period); } });
}
