// The member forms editor (src/views/FormsView.jsx) keeps one ordered save
// lane per member and template. A rejected save's answers stay in that lane so
// a remounted editor can retry them, which makes them member data held in
// memory. They belong to one authentication session: the shell ends the
// session on every identity change, including sign-out and the next sign-in
// as the same member, so a later session never applies or replays them
// (BUG-UG-FORM-DRAFT-SNAPSHOT-SESSION-SCOPE-20261027). This lives
// outside the lazily loaded view so the shell can end the session without
// loading it.
import { OUTBOX_REPLAY_DEFERRED } from "./outbox.js";

let generation = 0;

export const memberDraftSaves = new Map();
// Outbox replays on their way, by member and template: an editor save made
// while one runs waits for it .
const replaysInFlight = new Map();
const replayKey = (owner, templateKey) => `${owner}\u0000${templateKey}`;
// New forms this session's replays wrote, by member and template (tooling
// a review note). A replay makes no lane, and App reads Your forms again only
// after it, so until that read lands the list has no row for the form: an
// editor opened from it would start blank on revision 0, its save would be
// refused (the form exists) and the person's edit lost. The editor opens on
// the replay's own write instead, exactly as the next list will show it.
const replayedNewForms = new Map();

export function formDraftSessionGeneration() {
  return generation;
}

export function endFormDraftSession() {
  generation += 1;
  memberDraftSaves.clear();
  replaysInFlight.clear();
  replayedNewForms.clear();
}

// The new form a replay of this session wrote for the member and template,
// while no forms list has named it yet; undefined otherwise.
export function replayedNewFormFor(owner, templateKey) {
  return owner && templateKey ? replayedNewForms.get(replayKey(owner, templateKey)) : undefined;
}

// Drops the member's note for the template once this page learns it is no
// longer the open form to open ( round 1, r1s1 and r2s1): any note when
// a save of the template was confirmed (the save lane now holds the form it
// wrote), or only a note naming formId when that form was found deleted,
// discarded, submitted or closed elsewhere.
export function forgetReplayedNewForm(owner, templateKey, formId = undefined) {
  if (!owner || !templateKey) return;
  const key = replayKey(owner, templateKey);
  const note = replayedNewForms.get(key);
  if (note && (formId === undefined || note.id === formId)) replayedNewForms.delete(key);
}

// A forms list that names the form (in progress, submitted or returned) was
// read after the replay wrote it, so the list is what an editor opens on now.
export function forgetListedReplayedForms(owner, listedIds) {
  if (!owner) return;
  for (const [key, form] of replayedNewForms) {
    if (key.startsWith(`${owner}\u0000`) && listedIds.has(form.id)) replayedNewForms.delete(key);
  }
}

const laneOf = (memberId, templateKey) => (memberId ? memberDraftSaves.get(`member:${memberId}`)?.get(templateKey) : undefined);

// Editor tokens . Each form editor mounted in this page has its
// own token: this page's session id and a serial taken at mount. An editor
// save carries its token into its arguments, so an outbox entry that save
// queued names the editor that typed it, and the token survives the outbox's
// structured clone as a plain string. A page reload starts a new page session,
// so no entry from an earlier page can name an editor of this one.
// The id only tells this page's editors from another page's (a reload,
// another tab or frame), so it must never be equal in two pages. It comes
// from the platform's random source: randomUUID, else getRandomValues. A
// realm with neither (no browser the app supports) gets no id at all: its
// editors carry no token, so an entry they queue moves no lane, as an entry
// from the previous build does (the next save is refused and shown instead).
// A clock id could be equal in two pages, so there is none ( round 1,
// r2s2).
export function pageSessionId(source = globalThis.crypto) {
  try {
    if (typeof source?.randomUUID === "function") return source.randomUUID();
    if (typeof source?.getRandomValues === "function") {
      return Array.from(source.getRandomValues(new Uint32Array(4)), (part) => part.toString(16).padStart(8, "0")).join("-");
    }
  } catch { // swallow-ok: a realm whose random source throws gets no page session, so its editors carry no token
  }
  return null;
}
const PAGE_SESSION = pageSessionId();
let editorSerial = 0;
// The editors mounted now, by member and template. A form shown twice at once
// in one page (two trees mounting an editor of the same template) has two
// tokens here, and then no replay moves the lane: which of them shows what is
// not known (refused instead, as on Main).
const mountedEditors = new Map();

export function newFormEditorToken() {
  if (!PAGE_SESSION) return null;
  editorSerial += 1;
  return `${PAGE_SESSION}:${editorSerial}`;
}

// Registers a mounted editor; the function it returns unregisters exactly
// that mount. React's StrictMode runs the effect, its cleanup and the effect
// again, which leaves the token registered once; one editor's cleanup never
// removes another's token.
export function mountFormEditor(owner, templateKey, token) {
  if (!owner || !templateKey || !token) return () => {};
  const key = replayKey(owner, templateKey);
  let tokens = mountedEditors.get(key);
  if (!tokens) { tokens = new Set(); mountedEditors.set(key, tokens); }
  tokens.add(token);
  return () => {
    const current = mountedEditors.get(key);
    if (!current) return;
    current.delete(token);
    if (current.size === 0) mountedEditors.delete(key);
  };
}

// The order of a member's lane for one template: an editor save starts only
// once the saves and the outbox replay already in it have finished,
// so it never builds its base while a replay is about to move it. A replay
// never waits for an editor save: it is deferred instead (replayFormDraft).
export function formDraftLaneTurn(queue, owner = null, templateKey = null) {
  return Promise.allSettled([queue?.tail, owner ? replaysInFlight.get(replayKey(owner, templateKey)) : undefined]);
}

// An ordinary form names each write of its answers by a revision the database
// owns (member_forms.revision,): 1 on insert, one more each time the
// answers change. A lane holds the answers it last knew as stored together
// with their revision, and only ever moves to a higher one of the same form:
// a save's reply, a replay's reply and a load all go through here or through
// the same comparison in the editor's load (pendingDraftFor). Equal answers
// never order two writes; the revision does ( option a). formEpoch counts
// the lane's resets: a reply from before a reset belongs to a form the lane no
// longer writes.
export function advanceFormDraftLane(queue, { formId, revision, answers, epoch }) {
  if (!queue || typeof formId !== "string" || !formId || !Number.isSafeInteger(revision)) return false;
  if ((queue.formEpoch ?? 0) !== epoch || (queue.formId && queue.formId !== formId)) return false;
  if (revision <= (queue.confirmed?.revision ?? 0)) return false;
  queue.formId = formId;
  queue.confirmed = { answers: answers ?? {}, baseVersion: queue.confirmed?.baseVersion ?? null, revision };
  return true;
}

// The one rule for a replay's reply: it moves a lane only when the entry names
// the editor that queued it, that editor is the only one mounted on the lane
// and made its last save, and the lane is unchanged at exactly the entry's
// base; then that editor shows the replayed answers, because it typed them.
// In every other case nothing moves.
function moveTheQueuingEditorsLane(queue, fields, result, { token, epoch, owner }) {
  const formId = result?.formId;
  if (typeof formId !== "string" || !formId) return false;
  if (typeof token !== "string" || !token || queue.editorToken !== token) return false;
  const mounted = mountedEditors.get(replayKey(owner, fields.templateKey));
  if (!mounted || mounted.size !== 1 || !mounted.has(token)) return false;
  if ((queue.formEpoch ?? 0) !== epoch || (queue.formId && queue.formId !== formId)) return false;
  if (Number.isSafeInteger(result.revision)) {
    if (!Number.isSafeInteger(fields.baseRevision) || (queue.confirmed?.revision ?? 0) !== fields.baseRevision) return false;
    return advanceFormDraftLane(queue, { formId, revision: result.revision, answers: fields.answers, epoch });
  }
  if (typeof result.dataVersion !== "string" && result.dataVersion !== null) return false;
  // A sealed form: its dataVersion names one write and has no order, so only
  // the lane still at exactly the version the replay was based on moves.
  if ((queue.baseVersion ?? null) !== (fields.expectedDataVersion ?? null)) return false;
  queue.formId = formId;
  queue.baseVersion = result.dataVersion;
  queue.versions?.delete(result.dataVersion);
  queue.versions?.add(result.dataVersion);
  queue.confirmed = { answers: fields.answers ?? {}, baseVersion: result.dataVersion, revision: queue.confirmed?.revision ?? 0 };
  return true;
}

// Answers compared as the database compares jsonb: key order does not matter.
// Used only to recognise a replay's own lost reply, never to order writes.
function sameAnswers(left, right) {
  const canonical = (value) => (Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value);
  return JSON.stringify(canonical(left ?? {})) === JSON.stringify(canonical(right ?? {}));
}

// Whether a stored draft read for recovery is the very draft a queued entry
// was for ( round 1, r2s2;  round 1, r2s1). The read's own filter is
// the person and the template. Each other field is compared only where the
// database stores it for that kind of form:
// - The form id, when the entry names one.
// - The unit: settings_scope is stamped by the a01_unit_form_settings trigger
//   on every insert or update of the member's own row, {chapterId, unitId,
//   unitName} while unit settings are released and {} while they are held
//   (20261113124000, lines 498 to 557). A unit entry (the unit workflow,
//   FormsView.jsx line 620) matches only its own unit, and then the draft's
//   stamped chapter must be the entry's chapter. An entry with no unit (the
//   legacy workflow, which sends no unit fields) that names its form matches
//   that exact form whatever its stamp: while settings are held the server
//   keeps an existing stamp (lines 502 to 508), and save_member_form_draft
//   wrote that very row, the person's own open form of the template named by
//   its id (20261120222533 lines 108 to 117);  final, r4s1. An entry
//   with no unit that names no form matches only a draft with no unit.
// - The organization: member_forms.organization_id is set only for a sealed
//   (FMLA) form, by prepare_sealed_form (20261028174500, lines 30 to 31 and
//   173); ordinary and unit saves leave it null (save_form_draft inserts only
//   user_id, template_key, template_version, answers and step, 20261113134400
//   line 120). So it is compared only when it is set. When it is null, the
//   organization is proven by the person and the stamped chapter: the stamp is
//   the person's own chapter at the write (20261113124000 line 510, built at
//   lines 523 to 524), and a chapter belongs to one organization; a draft with
//   no stamp is the one the server's own save would pick (the same person and
//   template filter, 20261120222533 lines 121 to 123).
// Equal answers in another unit's or another organization's draft are another
// write, never this one's.
function storedIsEntryDraft(stored, fields) {
  if (!stored?.id || (fields?.formId && stored.id !== fields.formId)) return false;
  const scope = stored.settingsScope && typeof stored.settingsScope === "object" ? stored.settingsScope : {};
  const storedUnit = scope.unitId || null;
  if (fields?.unitId === undefined) {
    if (!fields?.formId && storedUnit !== null) return false;
    return stored.organizationId == null || fields?.organizationId === undefined || stored.organizationId === fields.organizationId;
  }
  if ((fields.unitId || null) !== storedUnit) return false;
  if ((storedUnit !== null || scope.chapterId !== undefined) && scope.chapterId !== fields.chapterId) return false;
  return stored.organizationId == null || fields.organizationId === undefined || stored.organizationId === fields.organizationId;
}

// Replays one queued form save for the member who queued it (the outbox's
// formDraft executor). memberId and isCurrent come from the session-guard
// operation the caller captured before anything was awaited (
// 364). Every await can end that session, and the app's client then speaks
// for the next member, so the operation is checked again after each one,
// before anything else is sent or read ( round 1, r1s1 and r2s1). The
// caller pins save and readStored to that member as well (App's executor,
// asUser): they send nothing unless the member is still signed in, and go out
// with the member's token.
// - It never makes a lane. It is ordered with the member's editor saves of the
//   template: an editor save started after it waits for it, and while
//   an editor save is already on its way it is not sent at all. It is deferred
//   instead: the entry stays queued and the outbox's next pass, after that
//   save settled, replays it. It never waits for that save, because the outbox
//   runs it under its entry's cross-tab lock and the save, if it fails offline,
//   queues under the same lock: each would wait for the other for ever.
// - An ordinary entry names the revision it was based on (baseRevision). A
//   save that committed but whose reply was lost is refused on replay as
//   form_saved_elsewhere, because it moved the revision itself. When the
//   stored draft is the entry's own draft (form, unit, organization) and holds
//   exactly the queued answers, the replay counts as committed at the stored
//   revision; anything else stays a refusal.
// - Its reply moves a lane only by the one rule above
//   (moveTheQueuingEditorsLane), and only to a higher revision, so a late reply
//   never puts older answers back over a newer save or load . Otherwise
//   it only confirms or refuses the entry; App then reads Your forms again,
//   and an editor that did not queue it is refused at its next save and shown
//   the stored answers, as on Main.
export async function replayFormDraft({ memberId, fields, save, readStored = null, isCurrent = () => true }) {
  const superseded = new Error("Superseded form-draft replay: the member who queued it is no longer signed in");
  const assertCurrent = () => { if (!isCurrent()) throw superseded; };
  assertCurrent();
  const owner = memberId ? `member:${memberId}` : null;
  const key = replayKey(owner, fields?.templateKey);
  const queue = laneOf(memberId, fields?.templateKey);
  const epoch = queue?.formEpoch ?? 0;
  if (queue?.tail || (owner && replaysInFlight.has(key))) {
    throw Object.assign(new Error("form-draft-replay-deferred: a save of this form is on its way"), { code: OUTBOX_REPLAY_DEFERRED });
  }
  let finish;
  const replay = new Promise((resolve) => { finish = resolve; });
  if (owner) replaysInFlight.set(key, replay);
  try {
    let result;
    try {
      result = await save(fields);
    } catch (error) {
      if (error === superseded || error?.details !== "form_saved_elsewhere" || !readStored) throw error;
      assertCurrent();
      const stored = await readStored(fields);
      assertCurrent();
      if (!storedIsEntryDraft(stored, fields) || !sameAnswers(stored.answers, fields?.answers)) throw error;
      result = Number.isSafeInteger(fields?.baseRevision) && Number.isSafeInteger(stored.revision)
        ? { formId: stored.id, revision: stored.revision } : stored.id;
    }
    assertCurrent();
    // An ordinary new form's entry (no form named, a base revision) that the
    // server wrote, or that committed before its reply was lost: its form id,
    // revision and the answers it stored are remembered for the next editor
    // of the template. A sealed form (a data version, no
    // revision) and an entry of the previous build (a form id only) are not.
    if (owner && !fields?.formId && Number.isSafeInteger(fields?.baseRevision) && result && typeof result === "object"
      && typeof result.formId === "string" && result.formId && Number.isSafeInteger(result.revision)) {
      replayedNewForms.set(key, { id: result.formId, templateKey: fields.templateKey, answers: fields.answers ?? {}, step: fields.step ?? 0,
        revision: result.revision, unitId: fields.unitId, chapterId: fields.chapterId, organizationId: fields.organizationId });
    } else if (owner && result && typeof result === "object" && Number.isSafeInteger(result.revision)) {
      // A later replay that wrote the remembered form itself (an entry naming
      // it) moves the note to that higher revision and its answers, so the
      // note never offers an older write of its form ( round 1 sweep).
      const note = replayedNewForms.get(key);
      if (note && result.formId === note.id && result.revision > note.revision) {
        replayedNewForms.set(key, { ...note, answers: fields.answers ?? {}, step: fields.step ?? note.step, revision: result.revision });
      }
    }
    if (queue && laneOf(memberId, fields.templateKey) === queue && result && typeof result === "object") {
      moveTheQueuingEditorsLane(queue, fields, result, { token: fields.editorToken, epoch, owner });
    }
    return result;
  } finally {
    finish();
    if (owner && replaysInFlight.get(key) === replay) replaysInFlight.delete(key);
  }
}
