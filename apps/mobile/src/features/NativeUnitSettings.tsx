import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { BUSINESS_SAVED_STALE, settleBusinessWrite } from '../lib/businessWriteContinuation';
import { useBusinessRequests, useBusinessWriter, useBusinessState } from '../lib/useBusinessWriter';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { TextInput } from '../components/Text';
import { Body, Button, Card, Heading } from '../components/ui';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { queueAccessibilityAnnouncement } from '../lib/announce';
import { ReadDeadlineError, withReadDeadline } from '../lib/readDeadline';
import { defineRetainedSurface, useRetainedDraft, type Held, type RetainedDraft } from '../lib/retainedDraft';
import { useNativeUi } from '../lib/useNativeUi';
import type { NativeLanguage, NativeUiKey, NativeUiText } from '../lib/nativeUiCopy';
import { canonicalWorkloadValues, workloadValueProblems } from '../../../../src/lib/workloadValues.js';
import { businessRpcProvenance } from '../services/businessWriters';
import { WriterSessionChanged } from '../../../../src/lib/sessionBoundWriter.js';
import { workloadChoiceText, workloadFieldLabel, workloadStatusText, workloadTitleText, workloadYesNoText } from '../lib/workloadEntryText';
import {
  loadNativeUnitSettings, loadNativeUnitEditor, saveNativeUnitOverrides, saveNativeChapterUnitSettings, saveNativeUnitWorkload,
  loadNativeOrganizationWorkload, saveNativeOrganizationWorkload,
  type OrganizationWorkload, type UnitConfiguration, type UnitContext, type UnitCategory, type UnitOverrides, type UnitSettingGroup, type UnitWorkspace,
} from '../services/unitSettings';

const GROUPS: readonly UnitSettingGroup[] = ['workload', 'forms', 'templates', 'capabilities'];
const GROUP_LABELS: Record<UnitSettingGroup, string> = {
  workload: 'Workload categories', forms: 'Forms', templates: 'Task templates', capabilities: 'Officer permissions',
};

export function useNativeUnitContext(onReadFailed?: (error: unknown) => void) {
  const { dashboard, mode, organizationID } = useApp();
  const failure = useRef(onReadFailed);
  failure.current = onReadFailed;
  const scope = `${dashboard?.member.id}:${organizationID}:${dashboard?.member.chapterID}`;
  const [selection, setSelection] = useBusinessDraftState<{ scope: string; unit: string | null }>({ scope, unit: null });
  const [revision, setRevision] = useBusinessDraftState(0);
  const [page, setPage] = useBusinessDraftState({ scope, offset: 0 });
  const offset = page.scope === scope ? page.offset : 0;
  const [state, setState] = useBusinessDraftState<{ scope: string; context: UnitContext | null; error: boolean }>({ scope, context: null, error: false });
  const generation = useRef(0);
  const selected = selection.scope === scope ? selection.unit : null;
  useEffect(() => {
    if (mode !== 'authenticated') return undefined;
    const current = ++generation.current;
    setState({ scope, context: null, error: false });
    void (offset ? loadNativeUnitSettings(selected, offset) : loadNativeUnitSettings(selected)).then((context) => {
      if (current !== generation.current) return;
      if (!context.legacy && (context.actorId !== dashboard?.member.id || context.organizationId !== organizationID || context.chapterId !== dashboard?.member.chapterID)) throw new Error('Work context changed');
      setState({ scope, context, error: false });
    }).catch((error: unknown) => { if (current === generation.current) { setState({ scope, context: null, error: true }); failure.current?.(error); } });
    return () => { generation.current += 1; };
  }, [scope, selected, offset, revision, mode, dashboard?.member.id, dashboard?.member.chapterID, organizationID, setState]);
  const select = (unit: string | null) => {
    // The same unit again changes nothing, so it starts no load and clears nothing.
    if (unit === selected) return;
    generation.current += 1; setState({ scope, context: null, error: false }); setSelection({ scope, unit });
  };
  const context = state.scope === scope ? state.context : null;
  return { context, error: state.scope === scope && state.error, select, offset, page: (next: number) => { generation.current += 1; setState({ scope, context: null, error: false }); setPage({ scope, offset: next }); },
    reload: () => { generation.current += 1; setState({ scope, context: null, error: false }); setSelection({ scope, unit: null }); setRevision((value) => value + 1); } };
}

export function NativeUnitChoice({ workflow, disabled = false }: { workflow: ReturnType<typeof useNativeUnitContext>; disabled?: boolean }) {
  const { context, error } = workflow;
  // Nothing about units shows until the server says they are released.
  if (context?.legacy || (!context && !error)) return null;
  return <Card>
    {error ? <><Body accessibilityRole="alert">Unit settings could not be loaded. Retry to check your current access.</Body><Button label="Retry unit settings" onPress={workflow.reload} /></>
      : !context ? <Body>Loading unit settings…</Body> : <>
        {(context.unitCount ?? context.units.length) > 1 ? <><Heading level={3}>Choose the unit for this work</Heading>{context.units.map((unit) => <Button key={unit.id} label={unit.name} selected={context.unitId === unit.id} variant={context.unitId === unit.id ? 'primary' : 'secondary'} disabled={disabled} onPress={() => workflow.select(unit.id)} />)}</>
          : <Body>{context.unitName ?? context.units.find((unit) => unit.id === context.unitId)?.name ?? 'Campaign settings'}</Body>}
        {workflow.offset || context.nextUnitOffset ? <><Button label="Previous units" variant="secondary" disabled={disabled || !workflow.offset} onPress={() => workflow.page(Math.max(0, workflow.offset - 30))} /><Button label="Next units" variant="secondary" disabled={disabled || context.nextUnitOffset == null} onPress={() => { if (context.nextUnitOffset != null) workflow.page(context.nextUnitOffset); }} /></> : null}
      </>}
  </Card>;
}

type WorkloadForm = { version: number; definition: UnitConfiguration['definition'] };
type WorkloadValues = Record<string, string | number | boolean>;
type WorkloadDraft = Record<string, string | boolean>;
type WorkloadProblem = { key: string; rule: string; limit?: number };

// BUG-UG-NATIVE-WORKLOAD-LOG-SAVE-REFUSAL-NAMES-NO-FIELD-20261118
// (#9101): a refused save says, beside each field, what to change. The rules
// are the shared ones (src/lib/workloadValues.js) the database checks again.
const WORKLOAD_RULE_TEXT: Record<string, NativeUiKey> = {
  required: 'Required: fill this in before saving.',
  number: 'Enter a number from 0 to {limit}.',
  wholeNumber: 'Enter a whole number from 0 to {limit}.',
  dayHours: 'Enter the hours for this one day: 24 or fewer, in quarter hours, such as 7.5. Log each day on its own.',
  textLength: 'Keep this to {limit} characters or fewer.',
  date: 'Enter a date as YYYY-MM-DD, such as 2026-11-16.',
  futureDate: 'Enter today or an earlier day.',
  choice: 'Choose one of the options.',
  overtimeHoursNeeded: 'You marked overtime: enter the overtime hours, 1 or more.',
  overtimeNotMarked: 'You did not mark overtime: clear these hours, or mark overtime.',
  partTimeHoursNeeded: 'You chose part-time: enter your part-time hours.',
  leaveTimingNeeded: 'You chose a leave: choose its timing.',
};
const CROSS_FIELD_RULES: ReadonlySet<string> = new Set(['overtimeHoursNeeded', 'overtimeNotMarked', 'partTimeHoursNeeded', 'leaveTimingNeeded']);
function workloadProblemText(problem: WorkloadProblem, fieldType: string, t: NativeUiText, language: NativeLanguage): string {
  if (problem.rule === 'required' && fieldType === 'date') return t('Required: enter a date as YYYY-MM-DD.');
  return t((Object.hasOwn(WORKLOAD_RULE_TEXT, problem.rule) ? WORKLOAD_RULE_TEXT[problem.rule] : undefined) ?? 'Required: fill this in before saving.', {
    // Grouped by hand (1,000,000 or 1.000.000), not through the engine's Intl.
    limit: problem.limit === undefined ? '' : String(problem.limit).replace(/\B(?=(\d{3})+(?!\d))/g, language === 'es' ? '.' : ','),
  });
}
// A decimal typed with a comma, as the Spanish iPhone keypad types it (7,5),
// is the same number; anything else stays as typed for the rules to refuse.
function workloadNumberValue(value: string): number {
  const text = value.trim();
  return Number(/^\d+,\d{1,2}$/.test(text) ? text.replace(',', '.') : text);
}

// #9240 pull request D (design R-9240D): an unsaved workload entry waits
// through a foreground session check on the shared draft hook (memory only).
// The holder keys it to the person, every role set, the hat and the
// organization; the item names the form family (the chapter's units, or the
// organization's form) and the value names the unit it was typed for, so it
// opens again only on that unit's fresh form. Any confirmed chapter or
// organization change, sign-out, another account or MFA retires it, and so does
// an authoritative refusal of the form's own read. The form's version and
// settings revision are the basis: an entry typed against a form that changed
// meanwhile stays on screen, says so, and is never saved onto the new form.
// A save inserts a new entry and carries no key, so an answer lost on the way
// back may have landed: the entry stays locked until a deliberate Save again or
// Discard, and nothing is ever sent again on its own.
type WorkloadHeld = { unit: string | null; values: WorkloadDraft; status: string };
const workloadSurface = defineRetainedSurface<Held<WorkloadHeld>>('workload-entry');
const WORKLOAD_RELOAD: NativeUiKey = 'Your settings or access may have changed. Reload before saving again.';
const visibleWorkloadFields = (definition: UnitConfiguration['definition']) => definition.fields.filter((field) => field.visible && !field.retired);
function workloadBlank(form: WorkloadForm | null, unit: string | null): WorkloadHeld {
  const fields = form ? visibleWorkloadFields(form.definition) : [];
  return { unit, values: Object.fromEntries(fields.filter((field) => field.type === 'boolean').map((field) => [field.key, false])), status: form?.definition.statuses[0] ?? '' };
}
const workloadBasis = (form: WorkloadForm & { settingsRevision?: string }) => JSON.stringify([form.version, form.settingsRevision ?? null]);
// Only these failures prove no entry was inserted, so only they unlock an
// ordinary Save:
// - the session writer's refusal, made before anything is sent: only the
//   WriterSessionChanged object the writer itself throws
//   (src/lib/sessionBoundWriter.js), never a response that merely carries
//   its 'writer_session_changed' marker;
// - an answer PostgREST itself made (its error shape, as businessRpc records
//   it) with a 4xx status and one of the exact codes below. PostgREST runs the
//   call in one transaction, so such an answer means it rolled back or never
//   ran.
// Everything else stays unconfirmed and locks the entry: no answer, the
// deadline, a transport failure (status 0), any 5xx or missing status (a
// gateway can answer after a committed insert, with any body and any code),
// a body without PostgREST's shape, and any other code.
const WORKLOAD_REFUSAL_CODES: ReadonlySet<string> = new Set([
  // Raised by save_unit_workload_log, save_configured_workload_log, their
  // helpers and submit_workload_log (supabase/migrations up to
  // 20261113124000_per_unit_settings.sql): access, a changed form or settings
  // revision, a refused value, the daily limit, a concurrent write. A code
  // PostgREST answers with a 5xx never passes the status check.
  '42501', 'PT409', '22023', '40001',
  // Statement errors the entry's casts and insert can hit; each aborts the
  // call's transaction, and PostgREST answers them with a 4xx.
  '22P02', '22003', '23502', '23503', '23505', '23514',
  // PostgREST's 4xx refusals before the function runs: no such function, a
  // refused token.
  'PGRST202', 'PGRST301', 'PGRST302', 'PGRST303',
]);
function workloadOutcomeUnknown(error: unknown): boolean {
  const fields = error && typeof error === 'object' ? error as { code?: unknown; details?: unknown } : null;
  if (!fields || error instanceof ReadDeadlineError) return true;
  const provenance = businessRpcProvenance(error);
  // The writer's own refusal object, made before dispatch, never an answer.
  if (error instanceof WriterSessionChanged && provenance === null) return false;
  if (!provenance?.postgrestShape || provenance.httpStatus < 400 || provenance.httpStatus > 499) return true;
  return !(typeof fields.code === 'string' && WORKLOAD_REFUSAL_CODES.has(fields.code));
}

function WorkloadEntry({ form, draft, write, onSaved, reload, reloadLabel, onBusy }: {
  form: WorkloadForm; draft: RetainedDraft<WorkloadHeld>; write: (values: WorkloadValues, status: string) => Promise<void>; onSaved?: () => void;
  reload: () => void; reloadLabel: NativeUiKey; onBusy: (value: boolean) => void;
}) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, form.version);
  const theme = useTheme();
  const { t, language } = useNativeUi();
  const definition = form.definition;
  const fields = visibleWorkloadFields(definition);
  const values = draft.value.values;
  // Own answers only (#9123): an empty field keyed constructor, valueOf or
  // toString is empty, not the inherited Object.prototype function.
  const answer = (key: string): string | boolean | undefined => (Object.hasOwn(values, key) ? values[key] : undefined);
  const status = draft.value.status;
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  const [message, setMessage] = useBusinessDraftState<NativeUiKey | null>(null, String(form.version));
  const [problems, setProblems] = useBusinessDraftState<Record<string, WorkloadProblem>>({}, String(form.version));
  const [refusal, setRefusal] = useBusinessDraftState<string[] | null>(null, String(form.version));
  const uncertain = draft.pending === 'uncertain';
  const locked = busy || draft.pending !== false;
  const refusalText = (keys: string[]) => t('Check the marked fields: {fields}.', {
    fields: keys.map((key) => fields.find((field) => field.key === key)).filter((field) => field !== undefined).map((field) => workloadFieldLabel(field, language)).join(', '),
  });
  // Own entries only: a field keyed constructor or toString has no note unless one was set.
  const problemFor = (key: string): WorkloadProblem | undefined => (Object.hasOwn(problems, key) ? problems[key] : undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusy(false); }; }, [onBusy]);
  const setValue = (key: string, value: string | boolean) => {
    draft.set((current) => ({ ...current, values: { ...current.values, [key]: value } })); setMessage(null); setRefusal(null);
    // A changed field drops its own note, and every note that depends on
    // another field's answer (overtime, part-time, leave timing).
    setProblems((current) => Object.fromEntries(Object.entries(current).filter(([field, problem]) => field !== key && !CROSS_FIELD_RULES.has(problem.rule))));
  };
  const setStatus = (value: string) => { draft.set({ status: value }); setMessage(null); };
  async function save() {
    await operate(true, async () => {
    if (!draft.shown || draft.pending === 'sending') return;
    const current = requests.capture().isCurrent;
    const prepare = (entry: WorkloadHeld) => {
      const own = (key: string) => (Object.hasOwn(entry.values, key) ? entry.values[key] : undefined);
      const typed: WorkloadValues = {};
      for (const field of fields) {
        const value = own(field.key);
        if (value === '' || value === undefined) continue;
        typed[field.key] = field.type === 'number' ? workloadNumberValue(String(value)) : value;
      }
      // The website's own cleaning: a "no overtime" answer is a measured zero.
      return canonicalWorkloadValues(definition, typed) as WorkloadValues;
    };
    const clean = prepare(draft.value);
    const checked = workloadValueProblems(definition, clean, status, form.version === 0) as { form: string | null; fields: WorkloadProblem[] };
    if (checked.form === 'status' || checked.form === 'unknown' || draft.stale) { setProblems({}); setRefusal(null); setMessage(WORKLOAD_RELOAD); return; }
    if (checked.form === 'size') { setProblems({}); setRefusal(null); setMessage('This entry is too long to save. Shorten the note.'); return; }
    if (checked.fields.length) {
      // What was typed stays; each refused field says what to change.
      const keys = checked.fields.map((problem) => problem.key);
      setProblems(Object.fromEntries(checked.fields.map((problem) => [problem.key, problem])));
      setMessage(null); setRefusal(keys); queueAccessibilityAnnouncement(refusalText(keys));
      return;
    }
    // One attempt at a time, held through an unmount and settled after it. An
    // untouched form has nothing held and sends as it is.
    const attempt = draft.begin();
    const sent = attempt ? { values: prepare(attempt.value), status: attempt.value.status } : { values: clean, status };
     onBusy(true); setMessage(null); setProblems({}); setRefusal(null);
    try {
      // A hung save ends at the deadline, as a save with no answer.
      await withReadDeadline(write(sent.values, sent.status));
      attempt?.settle('done');
      { setMessage('Workload saved.'); if (current()) queueAccessibilityAnnouncement(t('Workload saved.')); await settleBusinessWrite(writer, { current, accepted: () => {}, stale: () => setMessage(BUSINESS_SAVED_STALE), refresh: () => onSaved?.() }); }
    } catch (error) {
      const unknown = workloadOutcomeUnknown(error);
      attempt?.settle(unknown ? 'uncertain' : { failed: 'reload' });
      if (current()) setMessage(unknown && attempt ? null : WORKLOAD_RELOAD);
    }
    finally {  if (mounted.current) onBusy(false); }

    });
  }
  function discard() { draft.discard(); setMessage(null); setProblems({}); setRefusal(null); }
  // A failure line from this mount, or the one held with the entry.
  const shownMessage: NativeUiKey | null = message ?? (draft.failed === 'reload' ? WORKLOAD_RELOAD : null);
  return <Card><Heading level={2}>{workloadTitleText(definition, language)}</Heading>
    {fields.map((field) => <View key={field.key} style={styles.group}>
      <Body>{workloadFieldLabel(field, language)}{field.required ? ' *' : ''}</Body>
      {field.type === 'boolean' ? <Button label={`${workloadFieldLabel(field, language)}: ${workloadYesNoText(answer(field.key) === true, language)}`} selected={answer(field.key) === true} variant="secondary" disabled={locked} onPress={() => setValue(field.key, answer(field.key) !== true)} />
        // Pressing the chosen option again clears an optional answer.
        : field.type === 'select' ? field.options.map((option) => <Button key={option} label={workloadChoiceText(field, option, language)} selected={answer(field.key) === option} variant="secondary" disabled={locked} onPress={() => setValue(field.key, answer(field.key) === option ? '' : option)} />)
          : <TextInput accessibilityLabel={workloadFieldLabel(field, language)} value={String(answer(field.key) ?? '')} onChangeText={(value) => setValue(field.key, value)} editable={!locked}
            keyboardType={field.type === 'number' ? 'decimal-pad' : 'default'} keyboardAppearance={theme.appearance} selectionColor={theme.primary}
            placeholder={field.type === 'date' ? 'YYYY-MM-DD' : undefined}
            accessibilityHint={problemFor(field.key) ? workloadProblemText(problemFor(field.key)!, field.type, t, language) : undefined}
            maxLength={field.type === 'text' ? (form.version === 0 && field.key === 'note' ? 4000 : 500) : 80} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: problemFor(field.key) ? theme.destructive : theme.border }]} />}
      {problemFor(field.key) ? <Body style={{ color: theme.destructive }}>{workloadProblemText(problemFor(field.key)!, field.type, t, language)}</Body> : null}
    </View>)}
    <Body>{t('Status')}</Body>{definition.statuses.map((item) => <Button key={item} label={workloadStatusText(item, language)} selected={status === item} variant="secondary" disabled={locked} onPress={() => setStatus(item)} />)}
    {draft.stale ? <Body accessibilityRole="alert">{t('This form changed while you were away. Your entry is kept here; discard it to use the new form.')}</Body> : null}
    {uncertain ? <Body accessibilityRole="alert">{t('We could not confirm this entry was saved. Check your workload log before saving it again.')}</Body> : null}
    <Button label={t(uncertain ? 'Save workload again' : 'Save workload')} busy={busy} onPress={() => { void save(); }} disabled={Boolean(busy) || draft.pending === 'sending'} />
    {uncertain || draft.stale ? <Button label={t('Discard this entry')} variant="secondary" disabled={Boolean(busy)} onPress={discard} /> : null}
    {refusal ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{refusalText(refusal)}</Body> : null}
    {shownMessage ? <><Body accessibilityRole="alert">{t(shownMessage)}</Body>{shownMessage.startsWith('Your settings') ? <Button label={t(reloadLabel)} variant="secondary" onPress={reload} /> : null}</> : null}
  </Card>;
}

function UnitWorkloadEntry({ context, draft, onSaved, reload, onBusy }: { context: UnitContext; draft: RetainedDraft<WorkloadHeld>; onSaved?: () => void; reload: () => void; onBusy: (value: boolean) => void }) {
  const writer = useBusinessWriter();
  const configuration = context.effective?.configuration;
  if (!configuration) return null;
  return <WorkloadEntry form={configuration} draft={draft} write={(values, status) => saveNativeUnitWorkload(writer, context, values, status)} onSaved={onSaved} reload={reload} reloadLabel="Reload unit settings" onBusy={onBusy} />;
}

// Nothing else on this screen waits on an organization entry's save.
const ignoreBusy = () => {};

// BUG-UG-NATIVE-IOS-WORKLOAD-LOG-HAS-NO-ENTRY-20261117: while units
// are held, the website's Workload log still takes this week's entry on the
// organization's form, so the phone offers the same form and the same write.
function OrganizationWorkloadEntry({ onSaved }: { onSaved?: () => void }) {
  const writer = useBusinessWriter();
  const { dashboard, organizationID } = useApp();
  const { t } = useNativeUi();
  const scope = `${dashboard?.member.id}:${organizationID}:${dashboard?.member.chapterID}`;
  const [state, setState] = useBusinessDraftState<{ scope: string; form: OrganizationWorkload | null; error: boolean }>({ scope, form: null, error: false });
  const [revision, setRevision] = useBusinessDraftState(0);
  const generation = useRef(0);
  const loaded = state.scope === scope ? state.form : null;
  const draft = useRetainedDraft<WorkloadHeld>({
    surface: workloadSurface, item: JSON.stringify(['organization', dashboard?.member.chapterID ?? null]), empty: workloadBlank(loaded, null),
    fresh: loaded !== null, scope: 'organization', basis: loaded ? workloadBasis(loaded) : undefined,
  });
  const refused = useRef(draft.refused);
  refused.current = draft.refused;
  useEffect(() => {
    const current = ++generation.current;
    setState({ scope, form: null, error: false });
    void loadNativeOrganizationWorkload().then((form) => {
      if (current !== generation.current) return;
      if (form.organizationId !== organizationID) throw new Error('Work context changed');
      setState({ scope, form, error: false });
    }).catch((error: unknown) => { if (current === generation.current) { setState({ scope, form: null, error: true }); refused.current(error); } });
    return () => { generation.current += 1; };
  }, [scope, revision, organizationID, setState]);
  const reload = () => { generation.current += 1; setState({ scope, form: null, error: false }); setRevision((value) => value + 1); };
  if (state.scope !== scope) return null;
  if (state.error) return <Card><Body accessibilityRole="alert">{t('The workload form could not be loaded.')}</Body><Button label={t('Retry workload form')} onPress={reload} /></Card>;
  if (!state.form) return null;
  const form = state.form;
  if (!draft.shown) return <Card><Body>{t('Loading your entry…')}</Body></Card>;
  return <WorkloadEntry key={`${scope}:${form.version}`} form={form} draft={draft} write={(values, status) => saveNativeOrganizationWorkload(writer, form, values, status)} onSaved={onSaved} reload={reload} reloadLabel="Reload workload form" onBusy={ignoreBusy} />;
}

export function NativeUnitWorkloadEntry({ onSaved }: { onSaved?: () => void }) {
  const { dashboard } = useApp();
  const refused = useRef<(error: unknown) => void>(() => {});
  const workflow = useNativeUnitContext((error) => refused.current(error));
  const [busy, setBusy] = useBusinessState(false);
  const context = workflow.context;
  const configuration = context && !context.legacy && !context.needsChoice ? context.effective?.configuration ?? null : null;
  const draft = useRetainedDraft<WorkloadHeld>({
    surface: workloadSurface, item: JSON.stringify(['unit', dashboard?.member.chapterID ?? null]),
    empty: workloadBlank(configuration, configuration ? context?.unitId ?? null : null),
    fresh: context !== null && !context.legacy, scope: 'organization', basis: configuration ? workloadBasis(configuration) : undefined,
  });
  refused.current = draft.refused;
  // The unit an entry was typed for opens again; the server decides whether
  // this person may still log for it. A unit it no longer answers for retires
  // the entry, and choosing another unit drops it, as leaving the form did.
  const heldUnit = draft.shown ? draft.value.unit : null;
  const restoring = useRef<string | null>(null);
  const discard = useRef(draft.discard);
  discard.current = draft.discard;
  useEffect(() => {
    if (!context || context.legacy || !heldUnit || context.unitId === heldUnit) return;
    if (restoring.current === heldUnit) { if (draft.pending === false) discard.current(); return; }
    restoring.current = heldUnit;
    workflow.select(heldUnit);
  }, [context, draft.pending, heldUnit, workflow]);
  if (context?.legacy) return <OrganizationWorkloadEntry onSaved={onSaved} />;
  const choose = { ...workflow, select: (unit: string | null) => { if (heldUnit && heldUnit !== unit && draft.pending === false) draft.discard(); restoring.current = null; workflow.select(unit); } };
  const heldElsewhere = heldUnit !== null && heldUnit !== context?.unitId;
  return <><NativeUnitChoice workflow={choose} disabled={busy || draft.pending !== false} />{context?.effective && !context.needsChoice && draft.shown && !heldElsewhere
    ? <UnitWorkloadEntry key={`${context.actorId}:${context.chapterId}:${context.unitId}:${context.effective.configuration?.settingsRevision}`} context={context} draft={draft} onSaved={onSaved} reload={workflow.reload} onBusy={setBusy} /> : null}</>;
}

// #9240 pull request D (design R-9240D): unsaved unit configuration changes
// wait through a foreground session check on the shared draft hook (memory
// only), one draft per chapter and unit, with the unit last chosen (an id,
// never a row) so the editor returns to it. The holder keys both to the
// person, every role set, the hat and the organization, and the item names the
// chapter; any confirmed chapter or organization change, sign-out, another
// account or MFA retires them, and so does an authoritative refusal of the
// editor's own read. The version the change was typed against travels with
// it: settings that changed meanwhile keep the change on screen, say so, and
// the save carries the old version, so the server refuses it instead of
// writing over the new settings. Sending again therefore never repeats a
// change, and an answer lost on the way back is a definite failure.
type UnitSettingsHeld = { values: UnitOverrides; allowed: UnitWorkspace['allowed']; version: number };
type UnitChoiceHeld = { unit: string | null };
const unitSettingsSurface = defineRetainedSurface<Held<UnitSettingsHeld>>('unit-settings');
const unitChoiceSurface = defineRetainedSurface<Held<UnitChoiceHeld>>('unit-settings-choice');
const NO_UNIT_SETTINGS: UnitSettingsHeld = { values: {}, allowed: {}, version: 0 };
const NO_UNIT_CHOICE: UnitChoiceHeld = { unit: null };
function editableUnitOverrides(next: UnitWorkspace, unit: string | null): UnitOverrides {
  if (!unit) return next.chapterOverrides;
  const editable: UnitOverrides = {};
  if (next.allowed.workload && next.overrides.workload) editable.workload = next.overrides.workload;
  if (next.allowed.forms && next.overrides.forms) editable.forms = next.overrides.forms;
  if (next.allowed.templates && next.overrides.templates) editable.templates = next.overrides.templates;
  if (next.allowed.capabilities && next.overrides.capabilities) editable.capabilities = next.overrides.capabilities;
  return editable;
}
const unitSettingsVersion = (next: UnitWorkspace, unit: string | null) => (unit ? next.unitVersion : next.chapterVersion);

export function NativeUnitSettingsEditor({ chapterId }: { chapterId?: string | null }) {
  const writer = useBusinessWriter();
  const { dashboard, mode, chosenStaffRole, organizationID } = useApp();
  const theme = useTheme();
  const chapter = chapterId ?? dashboard?.member.chapterID ?? null;
  const enabled = mode === 'authenticated' && ['steward', 'admin', 'vp'].includes(chosenStaffRole ?? '');
  const scope = `${dashboard?.member.id}:${organizationID}:${chapter}`;
  const [selection, setSelection] = useBusinessDraftState<{ scope: string; unit: string | null }>({ scope, unit: null }, scope);
  const unit = selection.scope === scope ? selection.unit : null;
  const [workspace, setWorkspace] = useBusinessDraftState<UnitWorkspace | null>(null, JSON.stringify([scope, unit]));
  const [stateScope, setStateScope] = useBusinessDraftState(scope, JSON.stringify([scope, unit]));
  const [revision, setRevision] = useBusinessDraftState(0, JSON.stringify([scope, unit]));
  const [page, setPage] = useBusinessDraftState({ scope, offset: 0 }, JSON.stringify([scope, unit]));
  const offset = page.scope === scope ? page.offset : 0;
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  const [error, setError] = useBusinessDraftState(false, JSON.stringify([scope, unit]));
  const [hidden, setHidden] = useBusinessDraftState(false, JSON.stringify([scope, unit]));
  const [saved, setSaved] = useBusinessDraftState(false, JSON.stringify([scope, unit]));
  // Nothing shows before the first answer: held, the server refuses the editor.
  const [shown, setShown] = useBusinessDraftState(false, JSON.stringify([scope, unit]));
  const generation = useRef(0);
  const hydrate = (next: UnitWorkspace) => {
    setShown(true);
    setWorkspace(next); setStateScope(scope);
  };
  const current = stateScope === scope ? workspace : null;
  const choice = useRetainedDraft<UnitChoiceHeld>({
    surface: unitChoiceSurface, item: JSON.stringify([chapter]), empty: NO_UNIT_CHOICE, fresh: current !== null, scope: 'organization',
  });
  const held = useRetainedDraft<UnitSettingsHeld>({
    surface: unitSettingsSurface, item: JSON.stringify([chapter, unit]),
    empty: current ? { values: editableUnitOverrides(current, unit), allowed: current.allowed, version: unitSettingsVersion(current, unit) } : NO_UNIT_SETTINGS,
    fresh: current !== null, scope: 'organization', basis: current ? String(unitSettingsVersion(current, unit)) : undefined,
  });
  const values = held.value.values;
  const allowed = held.value.allowed;
  const locked = busy || held.pending !== false;
  const refused = useRef((cause: unknown) => { held.refused(cause); choice.refused(cause); });
  refused.current = (cause: unknown) => { held.refused(cause); choice.refused(cause); };
  const restored = useRef(false);
  useEffect(() => {
    if (!enabled || !chapter) return undefined;
    const current = ++generation.current;
    setWorkspace(null); setStateScope(scope); setSaved(false); setError(false); setHidden(false);
    void (offset ? loadNativeUnitEditor(chapter, unit, offset) : loadNativeUnitEditor(chapter, unit)).then((next) => {
      if (current !== generation.current) return;
      if (next.actorId !== dashboard?.member.id) throw new Error('Account changed');
      if (!next.canSetChapter && !unit && (next.unitCount ?? next.units.length) === 1 && next.units[0]) { setSelection({ scope, unit: next.units[0].id }); return; }
      hydrate(next);
    }).catch((cause: unknown) => {
      if (current !== generation.current) return;
      if (cause instanceof Error && 'code' in cause && (cause.code === '42501' || cause.code === 'PGRST202')) { setHidden(true); refused.current(cause); }
      else setError(true);
    });
    return () => { generation.current += 1; };
    // hydrate uses the unit captured by this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, chapter, scope, unit, offset, revision, dashboard?.member.id, setWorkspace, setStateScope, setBusy, setSaved, setError, setHidden, setSelection]);
  const choose = (value: string | null) => { generation.current += 1; setWorkspace(null); setSelection({ scope, unit: value }); setRevision((n) => n + 1); if (choice.shown) choice.set({ unit: value }); };
  // The unit last chosen opens again once this mount's first answer is back;
  // its own read then decides whether this person may still change it.
  const restore = useRef(choose);
  restore.current = choose;
  useEffect(() => {
    if (restored.current || !choice.shown) return;
    restored.current = true;
    if (choice.value.unit && choice.value.unit !== unit) restore.current(choice.value.unit);
  }, [choice.shown, choice.value.unit, unit]);
  if (!enabled || !chapter || hidden || (!shown && !error)) return null;
  const setValues = (next: UnitOverrides) => held.set({ values: next });
  const setAllowed = (next: UnitWorkspace['allowed']) => held.set({ allowed: next });
  function inherit(group: UnitSettingGroup, enabled: boolean) {
    if (!current) return;
    if (enabled) { const next = { ...values }; delete next[group]; setValues(next); return; }
    switch (group) {
      case 'workload': setValues({ ...values, workload: current.defaults.workload }); break;
      case 'forms': setValues({ ...values, forms: current.defaults.forms }); break;
      case 'templates': setValues({ ...values, templates: current.defaults.templates }); break;
      case 'capabilities': setValues({ ...values, capabilities: current.defaults.capabilities }); break;
    }
  }
  async function save() {
    await operate(true, async () => {
    if (!current || !held.shown || held.pending !== false) return;
    // One attempt at a time, held through an unmount and settled after it.
    // Unchanged settings have nothing held and send as they are.
    const attempt = held.begin();
    const sent = attempt ? attempt.value : held.value;
    const request = generation.current;  setError(false); setSaved(false);
    try {
      // The version the change was typed against goes with it, and a hung
      // save ends at the deadline.
      const next = await withReadDeadline(unit ? saveNativeUnitOverrides(writer, { ...current, unitVersion: sent.version }, sent.values)
        : saveNativeChapterUnitSettings(writer, { ...current, chapterVersion: sent.version }, sent.values, sent.allowed));
      attempt?.settle('done');
      hydrate(next); setSaved(true); if (await writer.isCurrent() && request === generation.current) queueAccessibilityAnnouncement('Settings saved.');
    } catch { attempt?.settle({ failed: 'reload' }); if (request === generation.current) setError(true); }


    });
  }
  // Reload takes the current settings, as it always did: the held change goes.
  const reload = () => void operate(true, async () => { if (await writer.check() === 'current') { held.discard(); choose(null); } });
  const failed = error || held.failed === 'reload';
  const parent = unit ? current?.defaults : current?.organizationDefaults;
  return <Card><Heading level={2}>Unit settings</Heading><Body muted>Units inherit campaign settings. Campaign leadership decides what unit committee members may customize.</Body>
    {failed ? <><Body accessibilityRole="alert">Settings or access may have changed. Reload before saving again.</Body><Button label="Reload unit settings" variant="secondary" disabled={locked} onPress={reload} /></> : null}
    {saved ? <Body>Settings saved.</Body> : null}
    {(!current || !held.shown) && !error ? <Body>Loading unit settings…</Body> : null}
    {current && parent && held.shown ? <>
      <Heading level={3}>Settings for</Heading>
      {current.canSetChapter ? <Button label="Campaign settings" variant={unit ? 'secondary' : 'primary'} selected={!unit} disabled={locked} onPress={() => void operate(true, async () => { if (await writer.check() === 'current') choose(null); })} /> : null}
      {current.units.map((item) => <Button key={item.id} label={item.name} selected={unit === item.id} variant={unit === item.id ? 'primary' : 'secondary'} disabled={locked} onPress={() => choose(item.id)} />)}
      {offset || current.nextUnitOffset ? <><Button label="Previous units" variant="secondary" disabled={locked || !offset} onPress={() => setPage({ scope, offset: Math.max(0, offset - 30) })} /><Button label="Next units" variant="secondary" disabled={locked || current.nextUnitOffset == null} onPress={() => { if (current.nextUnitOffset != null) setPage({ scope, offset: current.nextUnitOffset }); }} /></> : null}
      {unit || current.canSetChapter ? <>
        {GROUPS.map((group) => {
          const active = Object.hasOwn(values, group), editable = !unit || current.allowed[group] === true;
          return <View key={group} style={styles.group}><Heading level={3}>{GROUP_LABELS[group]}</Heading>
            {unit ? <Button label={`Use campaign settings for ${GROUP_LABELS[group]}: ${active ? 'Off' : 'On'}`} selected={!active} variant="secondary" disabled={locked || !editable} onPress={() => inherit(group, active)} />
              : <Button label={`Allow unit committee members to customize ${GROUP_LABELS[group]}: ${allowed[group] ? 'On' : 'Off'}`} selected={allowed[group]} variant="secondary" disabled={locked} onPress={() => setAllowed({ ...allowed, [group]: !allowed[group] })} />}
            {!unit && active && group !== 'capabilities' ? <Button label={`Use organization settings for ${GROUP_LABELS[group]}`} variant="secondary" disabled={locked} onPress={() => inherit(group, true)} /> : null}
            {unit && !editable ? <Body muted>Your campaign keeps these settings the same across units.</Body> : null}
            {group === 'workload' ? (values.workload ?? parent.workload).map((category, index, rows) => {
              const change = (patch: Partial<UnitCategory>) => setValues({ ...values, workload: rows.map((item) => item.key === category.key ? { ...item, ...patch } : item) });
              const label = workloadFieldLabel(category);
              return <View key={category.key} style={styles.group}><Body>{label}</Body>
                <TextInput accessibilityLabel={`${label} category name`} value={label} maxLength={80} editable={!locked && editable && (!unit || active)} onChangeText={(text) => change({ label: text })}
                  keyboardAppearance={theme.appearance} selectionColor={theme.primary} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
                <Button label={`${label} shown: ${category.visible ? 'On' : 'Off'}`} selected={category.visible} variant="secondary" disabled={locked || !editable || Boolean(unit && !active)} onPress={() => change({ visible: !category.visible })} />
                <Button label={`Move ${label} up`} variant="secondary" disabled={locked || !editable || Boolean(unit && !active) || index === 0} onPress={() => {
                  const previous = rows[index - 1];
                  if (!previous) return;
                  const next = [...rows]; next[index - 1] = category; next[index] = previous; setValues({ ...values, workload: next });
                }} />
              </View>;
            }) : null}
            {group === 'forms' || group === 'templates' ? parent[group].map((key) => {
              const selected = (values[group] ?? parent[group]).includes(key);
              const label = (group === 'forms' ? current.formChoices : current.templateChoices).find((item) => item.key === key)?.labelEn ?? GROUP_LABELS[group];
              return <Button key={key} label={`${label}: ${selected ? 'Shown' : 'Hidden'}`} selected={selected} variant="secondary" disabled={locked || !editable || Boolean(unit && !active)} onPress={() => {
                const next = selected ? (values[group] ?? parent[group]).filter((value) => value !== key) : [...(values[group] ?? parent[group]), key];
                setValues({ ...values, [group]: next });
              }} />;
            }) : null}
            {group === 'capabilities' && unit ? Object.entries(parent.capabilities).map(([key, enabled]) => {
              const selected = (values.capabilities ?? parent.capabilities)[key] ?? enabled;
              return <Button key={key} label={`${key.split(':').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' · ')}: ${selected ? 'On' : 'Off'}`} selected={selected} variant="secondary" disabled={locked || !editable || !active || !enabled} onPress={() => setValues({ ...values, capabilities: { ...(values.capabilities ?? parent.capabilities), [key]: !selected } })} />;
            }) : null}
            {group === 'capabilities' && !unit ? <Body muted>Unit overrides can only reduce the campaign's officer permissions.</Body> : null}
          </View>;
        })}
        {held.stale ? <><Body accessibilityRole="alert">These settings changed while you were away. Your changes are kept here, but they cannot be saved over the new settings.</Body>
          <Button label="Discard my changes" variant="secondary" disabled={locked} onPress={() => { held.discard(); setError(false); }} /></> : null}
        <Button label="Save unit settings" busy={busy} onPress={() => { void save(); }} disabled={locked} />
      </> : null}
      <Heading level={3}>Recent changes</Heading>{current.audit.map((entry) => <Body key={entry.id}>{entry.unitName ?? 'Campaign settings'} · {new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }).format(new Date(entry.createdAt))} ET · Settings saved</Body>)}
    </> : null}
  </Card>;
}

const styles = StyleSheet.create({ group: { gap: 10 }, input: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 } });
