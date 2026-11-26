// TEST-UG-SMALL-NEW-ORGANIZATION-FIXTURE-AND-WEB-ROUTE-JOURNEYS-20261111
// (#8318): loads the small new organization into the member backend stand-in
// (tests/helpers/memberBackendHarness.js), never through demo mode. Each
// journey signs in as one fixture person; the rows below are what that person
// may read, and the stand-in keeps what the journey writes.
import { createMemberBackendHarness } from "../../helpers/memberBackendHarness.js";
import {
  notice,
  organization,
  otherOrganization,
  otherPeople,
  people,
  sharedGrievanceDraft,
  studioSurvey,
} from "./organization.js";

const everyone = [...Object.values(people), ...Object.values(otherPeople)];
const personById = new Map(everyone.map((person) => [person.id, person]));
const organizationOf = (person) => (Object.values(otherPeople).includes(person) ? otherOrganization : organization);

function profileRow(person) {
  return {
    id: person.id,
    first_name: person.firstName,
    full_name: person.fullName,
    initials: person.initials,
    language: "en",
    chapter_id: person.chapterId,
    // A new organization has imported no join years.
    member_since: null,
    role_line: null,
  };
}

function membershipRows(person) {
  const home = organizationOf(person);
  const roles = [...person.organizationRoles, ...person.chapterRoles];
  return home.chapters
    .filter((chapter) => person.organizationRoles.length > 0 || chapter.id === person.chapterId)
    .map((chapter) => ({
      chapterId: chapter.id,
      organizationId: home.id,
      name: chapter.name,
      selected: chapter.id === person.chapterId,
      roles: chapter.id === person.chapterId ? roles : person.organizationRoles,
      organizationRoles: person.organizationRoles,
      chapterRoles: chapter.id === person.chapterId ? person.chapterRoles : [],
    }));
}

const NOW = "2026-11-10T14:00:00.000Z";

// The survey as the current Engagement studio publishes it: an organization
// survey in the member engagement snapshot. A new organization has no rows in
// the retired member_surveys table.
function studioSurveySnapshot(person, published = []) {
  return {
    surveys: [{
      id: studioSurvey.id,
      title: studioSurvey.title,
      description: studioSurvey.body,
      cadence: "one_off",
      periodKey: null,
      status: "published",
      // No close: Home applies a survey's close at render time against the
      // real clock, so any fixed date would stop counting the seed once it
      // passed (#8389).
      closesAt: null,
      session: null,
      questions: [{
        id: `${studioSurvey.id}-question-1`,
        type: "single_choice",
        label: studioSurvey.title,
        required: true,
        options: studioSurvey.options.map((label, index) => ({ value: `option-${index + 1}`, label })),
      }],
    }, ...published.filter((survey) => !survey.chapterId || survey.chapterId === person.chapterId).map(memberSurveyRow)],
    livePolls: [],
    pulsePrompts: [],
    actions: [],
    workspace: null,
    quarterlyGate: null,
  };
}

// A survey the studio published in this test (publishOrganizationSurvey), as
// the member engagement snapshot lists it to a member it is open to.
function memberSurveyRow(survey) {
  return {
    id: survey.id,
    title: survey.title,
    description: survey.description,
    // The snapshot passes the cadence the studio saved straight through.
    cadence: survey.cadence,
    periodKey: survey.periodKey,
    status: "published",
    closesAt: survey.closesAt,
    session: null,
    questions: survey.questions.map((question, index) => ({
      id: `${survey.id}-question-${index + 1}`,
      type: question.type,
      label: question.label,
      required: true,
      options: (question.options ?? []).map((label, option) => ({ value: `option-${option + 1}`, label })),
    })),
  };
}

// The studio's own list for an organization officer: the studio survey and
// whatever this test published.
function staffSnapshot(published) {
  return {
    surveys: [
      { id: studioSurvey.id, title: studioSurvey.title, status: "open", cadence: "one_off", responseCount: 0 },
      ...published.map((survey) => ({ id: survey.id, title: survey.title, status: "open", cadence: survey.cadence, responseCount: 0 })),
    ],
    livePolls: [], pulsePrompts: [], channels: [], members: [], presence: { online: 0 }, delivery: {},
  };
}

function noticeRow() {
  return {
    id: notice.id,
    sender: people.organizationOfficer.fullName,
    title: notice.title,
    body: notice.body,
    published_at: NOW,
    locale: "en",
    audience_scope: "organization",
  };
}

function grievanceDraftRow(owner) {
  return {
    id: sharedGrievanceDraft.id,
    user_id: owner.id,
    template_key: sharedGrievanceDraft.templateKey,
    template_version: 1,
    status: "draft",
    step: 0,
    answers: {},
    revision: 1,
    // What the database stores on a row an ordinary save creates: save_form_draft
    // inserts only user_id, template_key, template_version, answers and step
    // (20261113134400 line 120), so organization_id stays null (set only for a
    // sealed form, 20261028174500 line 173) and settings_scope keeps its
    // default {} (20261113124000 line 529; these chapters have no units and
    // unit settings are held). tests/form-draft-row-shape.test.js pins this.
    organization_id: null,
    settings_scope: {},
    created_at: NOW,
    updated_at: NOW,
  };
}

function weeklyWorkspace(person) {
  return {
    organizationId: organization.id,
    chapterId: person.chapterId,
    policy: { enabled: false, cadence_days: 7, minimum_pool_size: 3, selection_count: 1, priority_rule: "support_then_oldest" },
    items: [{ id: "5e117000-0000-4000-8000-000000000601", body: "Should the North Clinic ask for a second break room?", options: ["Yes", "No"], editorialState: "submitted", score: 0 }],
    nextCursor: null,
  };
}

// What the server refuses this person, as it would: organization-wide staff
// reads need an organization role, so a chapter-only officer gets 42501.
export function smallNewOrganizationRefusals(person) {
  const refused = { code: "42501", message: "not authorized" };
  return person.organizationRoles.length === 0
    ? { "rpc:get_staff_engagement_snapshot": refused, "rpc:get_staff_engagement_surveys": refused }
    : {};
}

// The rows the signed-in person reads. Fernbrook people see Fernbrook rows;
// the other organization's people never reach them, and the reverse.
export function smallNewOrganizationRows(person, published = []) {
  const home = organizationOf(person);
  const inFernbrook = home === organization;
  const roleRows = [...person.organizationRoles, ...person.chapterRoles].map((role) => ({ role }));
  return {
    "table:member_roles": roleRows,
    // A new organization does not yet require two-step sign-in for staff.
    "rpc:get_staff_mfa_standing": roleRows.length > 0
      ? { required: false, holdsStaffRole: true, enrolled: false, blocked: false, suspendedRoles: [] }
      : null,
    "table:chapters": home.chapters.map((chapter) => ({ ...chapter })),
    "rpc:get_my_chapter_memberships": membershipRows(person),
    "table:member_surveys": [],
    "rpc:get_member_engagement_snapshot": inFernbrook ? studioSurveySnapshot(person, published) : { surveys: [], livePolls: [], pulsePrompts: [], actions: [], workspace: null, quarterlyGate: null },
    ...(inFernbrook && person.organizationRoles.length > 0 ? { "rpc:get_staff_engagement_snapshot": staffSnapshot(published) } : {}),
    "table:member_broadcasts": inFernbrook ? [noticeRow()] : [],
    "table:member_forms": person === people.member ? [grievanceDraftRow(person)] : [],
    // A chapter officer's own chapter weekly-question workspace.
    "rpc:get_weekly_question_selection_workspace": person.chapterRoles.length > 0 ? weeklyWorkspace(person) : null,
    "rpc:list_weekly_question_selection_page": { items: [], nextCursor: null },
    "rpc:list_member_draft_sharing": person === people.member
      ? [{ id: people.chapterOfficer.id, name: people.chapterOfficer.fullName, shared: true }]
      : [],
  };
}

// The person's authenticator, when they have verified one.
const TOTP_FACTOR = Object.freeze({ id: "5e11e000-0000-4000-8000-000000000701", factor_type: "totp", status: "verified" });

// The claims of a fixture access token (sessionToken below).
function tokenClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8")); } catch { return {}; }
}

// A backend stand-in signed in as one fixture person (a key of `people` or
// `otherPeople`). The harness options pass through. With { twoStep: true }
// the person starts from a verified two-step session: an aal2 token, the
// verified authenticator on the user, and staff two-step standing enrolled.
// With { answeredSurvey: true } the person has already submitted the studio
// survey, so Home no longer ranks it first ("What matters for you now" shows
// one item, and an open survey outranks an unread notice).
export function createSmallNewOrganizationBackend(options) {
  const backend = createMemberBackendHarness(options);
  // What the organization's staff published in this test. It outlives a
  // sign-in, so the next person to sign in reads it; resetOrganization()
  // starts the organization over (once per test).
  backend.published = [];
  backend.resetOrganization = () => { backend.published = []; };
  backend.profiles = Object.fromEntries(everyone.map((person) => [person.id, profileRow(person)]));
  backend.signInAs = (key, { twoStep = false, answeredSurvey = false } = {}) => {
    const person = people[key] ?? otherPeople[key];
    if (!person) throw new Error(`No fixture person named ${key}`);
    Object.assign(backend.state, {
      session: {
        user: { id: person.id, email: `${person.firstName.toLowerCase()}@fernbrook.example.test`, factors: twoStep ? [{ ...TOTP_FACTOR }] : [] },
        access_token: sessionToken(person, twoStep ? "aal2" : "aal1"),
        refresh_token: "fixture-refresh",
      },
      factorReads: 0,
      profiles: backend.profiles,
      loader: null, pending: [], operations: [], hold: false, holdResource: null, fail: null,
      errors: smallNewOrganizationRefusals(person), restrictionCheck: null, restrictionChecks: 0,
      subscribers: [], namedSubscribers: {}, feeds: [], liveSequences: new Map(),
      rows: smallNewOrganizationRows(person, backend.published),
      person, writes: [],
    });
    if (answeredSurvey) {
      for (const survey of backend.state.rows["rpc:get_member_engagement_snapshot"].surveys) {
        survey.session = { status: "submitted", answers: { [survey.questions[0].id]: "option-3" }, submittedAt: NOW };
      }
    }
    if (twoStep && backend.state.rows["rpc:get_staff_mfa_standing"]) {
      backend.state.rows["rpc:get_staff_mfa_standing"] = { required: true, holdsStaffRole: true, enrolled: true, blocked: false, suspendedRoles: [] };
    }
    return person;
  };
  backend.personNamed = (id) => personById.get(id) ?? null;
  // Writes the journeys make are kept, as the server would keep them, so the
  // next read (a reopened draft, a reloaded route) sees them.
  const rpc = backend.client.rpc;
  backend.client.rpc = async (name, args) => {
    if (name === "publish_organization_survey_with_operations") return { data: publishOrganizationSurvey(backend, args), error: null };
    if (name === "save_form_draft" || name === "save_unit_form_draft") {
      const refused = closedFormRefusal(backend.state, args) ?? savedElsewhereRefusal(backend.state, args);
      return refused ? { data: null, error: refused, status: 409 } : { data: saveFormDraft(backend.state, args), error: null };
    }
    if (name === "save_member_form_draft" || name === "save_unit_member_form_draft") {
      const refused = (name === "save_unit_member_form_draft" ? unitWrapperRefusal(backend.state, args) : null)
        ?? closedFormRefusal(backend.state, args) ?? revisionRefusal(backend.state, args);
      if (refused) return { data: null, error: refused, status: refused.code === "22023" ? 400 : 409 };
      const formId = saveFormDraft(backend.state, args, name);
      const revision = (backend.state.rows["table:member_forms"] ?? []).find((form) => form.id === formId).revision;
      return { data: { formId, revision }, error: null };
    }
    // #7667: these chapters have no units, so every person works under the
    // chapter's own settings and is never asked to choose a unit.
    if (name === "get_my_unit_settings") return { data: chapterUnitSettings(backend.state), error: null };
    // The session restriction check answers "not restricted" unless a
    // journey holds it (state.restrictionCheck returns a pending answer).
    if (name === "get_my_session_restriction") {
      backend.state.restrictionChecks = (backend.state.restrictionChecks ?? 0) + 1;
      return backend.state.restrictionCheck ? backend.state.restrictionCheck() : { data: { restricted: false }, error: null };
    }
    if (name === "generate_mfa_recovery_codes") return { data: { codes: ["fern-0001-aaaa", "fern-0002-bbbb"], generation: 1 }, error: null };
    return rpc(name, args);
  };
  // Like a Supabase request builder, a call can carry its own Authorization
  // header (a form save pins the member it was started for, #8966).
  const answerRpc = backend.client.rpc;
  backend.client.rpc = (name, args) => Object.assign(answerRpc(name, args), { setHeader() { return this; } });
  // Two-step sign-in, as Supabase answers it: the current level is the
  // signed-in token's own aal claim, the next level is aal2 once the user has
  // a verified factor, and the factor list is the user's. Each read of the
  // list is counted (one per mount of the two-step panel).
  const verifiedFactors = () => (backend.state.session?.user?.factors ?? []).filter((factor) => factor.status === "verified");
  Object.assign(backend.client.auth, {
    setSession: async (candidate) => {
      if (candidate.access_token !== backend.state.session?.access_token) throw new Error('Fixture adoption mismatch');
      return { data: { session: backend.state.session }, error: null };
    },
    getUser: async () => ({ data: { user: backend.state.session?.user ?? null }, error: null }),
    mfa: {
      getAuthenticatorAssuranceLevel: async () => ({
        data: {
          currentLevel: tokenClaims(backend.state.session?.access_token).aal ?? "aal1",
          nextLevel: verifiedFactors().length > 0 ? "aal2" : "aal1",
        },
        error: null,
      }),
      listFactors: async () => {
        backend.state.factorReads += 1;
        const all = verifiedFactors().map((factor) => ({ ...factor }));
        return { data: { all, totp: all.filter((factor) => factor.factor_type === "totp") }, error: null };
      },
      enroll: async () => ({ data: { id: TOTP_FACTOR.id, totp: { qr_code: "", secret: "FIXTURESECRET" } }, error: null }),
      challenge: async () => ({ data: { id: "5e11e000-0000-4000-8000-000000000702" }, error: null }),
      // Verifying adds the factor and mints an aal2 token for the same
      // session, then tells the auth listener, as Supabase does.
      verify: async () => {
        const user = { ...backend.state.session.user, factors: [{ ...TOTP_FACTOR }] };
        backend.state.session = { ...backend.state.session, user, access_token: sessionToken(backend.state.person, "aal2") };
        await backend.state.auth?.("MFA_CHALLENGE_VERIFIED", backend.state.session);
        return { data: backend.state.session, error: null };
      },
      unenroll: async () => ({ error: null }),
    },
  });
  // A token refresh of the same session at the same level: Supabase stores
  // the new token and tells the app's auth listener.
  backend.refreshToken = async () => {
    const aal = tokenClaims(backend.state.session.access_token).aal ?? "aal1";
    backend.state.session = { ...backend.state.session, access_token: sessionToken(backend.state.person, aal) };
    await backend.state.auth?.("TOKEN_REFRESHED", backend.state.session);
  };
  return backend;
}

// An access token shaped like Supabase's, for a one-time-code sign-in: the
// claims the app reads (session_id, aal, amr), with a fresh value each mint.
let minted = 0;
export function sessionToken(person, aal = "aal1") {
  const claims = {
    sub: person.id, aal, session_id: `5e110e00-0000-4000-8000-${person.id.slice(-12)}`, n: (minted += 1),
    amr: aal === "aal2" ? [{ method: "totp" }, { method: "otp" }] : [{ method: "otp" }],
  };
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
}

// publish_organization_survey_with_operations keeps the survey for the
// organization (the same organization, the chapter it names or all of it),
// and the studio's list shows it at once.
function publishOrganizationSurvey(backend, { p_draft: draft, p_operations: operations }) {
  const survey = {
    id: `5e115000-0000-4000-8000-${String(backend.published.length + 900).padStart(12, "0")}`,
    title: draft.title,
    description: draft.description ?? "",
    chapterId: draft.chapterId ?? null,
    cadence: operations?.cadence ?? "one_off",
    periodKey: operations?.periodKey ?? null,
    closesAt: operations?.closesAt ?? null,
    questions: structuredClone(draft.questions ?? []),
  };
  backend.published.push(survey);
  backend.state.rows["rpc:get_staff_engagement_snapshot"] = staffSnapshot(backend.published);
  (backend.state.writes ??= []).push({ name: "publish_organization_survey_with_operations", surveyId: survey.id, title: survey.title });
  return { id: survey.id, status: "open" };
}

// A save naming its form (p_expected_form_id, #8702) is refused, as the
// server refuses it, once that form is not this member's open form of the
// template any more; nothing is written.
function closedFormRefusal(state, { p_template_key: templateKey, p_expected_form_id: formId }) {
  if (!formId) return null;
  const open = (state.rows["table:member_forms"] ?? []).some((form) => form.id === formId && form.user_id === state.person.id
    && form.template_key === templateKey && (form.status === "draft" || form.status === "returned"));
  return open ? null : { code: "PT409", message: "form no longer editable", details: "form_not_editable" };
}

// A save naming the answers it was based on (p_base_answers, #8719) is
// refused, as the server refuses it, when the stored draft differs; nothing
// is written.
function savedElsewhereRefusal(state, { p_template_key: templateKey, p_expected_form_id: formId, p_base_answers: base }) {
  if (!base) return null;
  const forms = state.rows["table:member_forms"] ?? [];
  const draft = formId ? forms.find((form) => form.id === formId)
    : forms.find((form) => form.user_id === state.person.id && form.template_key === templateKey && form.status === "draft");
  if (!draft) return null;
  const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))));
  return canonical(draft.answers) === canonical(base) ? null : { code: "PT409", message: "form changed elsewhere", details: "form_saved_elsewhere" };
}

// save_unit_member_form_draft's own checks, run BEFORE any revision is
// compared (20261120222533 lines 153 to 162): require_unit_workflow_context
// refuses (42501) unless the actor, chapter and organization are the signed-in
// person's current ones (20261113124000 lines 578 to 585; the organization is
// the signed-in person's own, never the first fixture organization), and
// resolve_settings_unit refuses (42501) a named unit the person is not in
// (lines 216 to 222). These chapters have no units, so any named unit is
// refused; a save naming none (null) resolves to the chapter's settings.
function unitWrapperRefusal(state, { p_unit: unit, p_actor: actor, p_chapter: chapter, p_organization: organizationId }) {
  const person = state.person;
  if (actor !== person.id || chapter !== person.chapterId || organizationId !== organizationOf(person).id) return { code: "42501", message: "work context changed; reload" };
  return unit ? { code: "42501", message: "unit membership changed" } : null;
}

// A save naming the revision it was based on (p_base_revision, #9092) is
// refused, as save_member_form_draft refuses it, unless that revision is the
// stored one (0: no open draft); a base above 0 must name its form.
function revisionRefusal(state, { p_template_key: templateKey, p_expected_form_id: formId, p_base_revision: base }) {
  if (base > 0 && !formId) return { code: "22023", message: "form required with a base revision" };
  const forms = state.rows["table:member_forms"] ?? [];
  const draft = formId ? forms.find((form) => form.id === formId) : openDraft(state, templateKey);
  return (draft?.revision ?? 0) === base ? null : { code: "PT409", message: "form changed elsewhere", details: "form_saved_elsewhere" };
}

// The member's open draft of a template with no form named, as
// save_member_form_draft finds it (20261120222533 line 121 to 123): status
// draft or returned, the newest updated_at first.
function openDraft(state, templateKey) {
  return (state.rows["table:member_forms"] ?? [])
    .filter((form) => form.user_id === state.person.id && form.template_key === templateKey && (form.status === "draft" || form.status === "returned"))
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0];
}
// jsonb equality, as the member_forms_revision trigger compares answers
// (20261120222533 line 56, "is distinct from"): key order does not matter.
function sameJsonb(left, right) {
  const canonical = (value) => (Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value);
  return JSON.stringify(canonical(left ?? {})) === JSON.stringify(canonical(right ?? {}));
}

// save_form_draft keeps one draft per member and template: it updates that
// draft's answers and step, or starts one, and returns its id. The revision
// moves when the answers change, as the member_forms_revision trigger moves it.
function chapterUnitSettings(state) {
  const person = state.person;
  const forms = [...new Set((state.rows["table:form_template_registry"] ?? []).map((row) => row.key))];
  return {
    actorId: person.id, chapterId: person.chapterId, organizationId: organization.id,
    units: [], unitCount: 0, nextUnitOffset: null, unitId: null, unitName: null, needsChoice: false, canManage: false,
    effective: { workload: [], forms, templates: [], capabilities: {}, configuration: null },
  };
}

function saveFormDraft(state, { p_template_key: templateKey, p_answers: answers, p_step: step }, name = "save_form_draft") {
  const forms = state.rows["table:member_forms"] ?? [];
  let draft = openDraft(state, templateKey);
  if (!draft) {
    draft = { ...grievanceDraftRow(state.person), id: `5e11f000-0000-4000-8000-${String(forms.length + 900).padStart(12, "0")}`, template_key: templateKey, answers: structuredClone(answers ?? {}) };
    forms.push(draft);
  }
  const changed = !sameJsonb(draft.answers, answers);
  Object.assign(draft, { answers: structuredClone(answers ?? {}), step: step ?? 0, updated_at: NOW, revision: (draft.revision ?? 1) + (changed ? 1 : 0) });
  state.rows["table:member_forms"] = forms;
  (state.writes ??= []).push({ name, formId: draft.id, answers: structuredClone(answers ?? {}), step });
  return draft.id;
}

