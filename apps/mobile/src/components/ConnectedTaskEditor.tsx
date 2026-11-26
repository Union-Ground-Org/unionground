import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { BUSINESS_SAVED_STALE, settleBusinessWrite } from '../lib/businessWriteContinuation';
import { nativeUiText } from '../lib/nativeUiCopy';
import { useBusinessRequests, useBusinessWriter, useBusinessState } from '../lib/useBusinessWriter';
// The follow-up task form inside the connected-record sheet
// (BUG-UG-NATIVE-IOS-EVENT-FOLLOW-UP-TASK-OPENS-NOTHING-20261117, #9080).
// "Create follow-up task" made a task the server titles "Follow up on event"
// with nobody assigned, and the phone had no way to change either. This form
// opens on that task (and on a linked task Chapter work cannot open) so a
// chapter leader can give it a title, a person and a due date. The server
// rechecks every grant; the form only says plainly why a save did not go through.
// A save's outcome shows directly above Save task and is spoken on both phones
// (UX-UG-NATIVE-TASK-FORM-SAVE-CONFIRMATION-OFF-SCREEN-20261118, #9140):
// at the top of the form it sat off screen below a long assignee list, and
// `accessibilityLiveRegion` alone is Android-only, so VoiceOver heard nothing.

import { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { type ConnectedLanguage, connectedTaskEditorCopy } from '../lib/connectedWorkflowsCopy';
import {
  type EditableTask,
  type TaskAssignee,
  TASK_TITLE_MAX,
  isTaskDate,
  isTaskTitle,
  loadEditableTask,
  loadTaskAssignees,
  saveTaskEdits,
  taskEditFailure,
} from '../services/taskEditing';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, spacing } from '../theme/tokens';
import { typeface } from '../theme/typeface';

// A chapter can hold hundreds of people; the list shows this many matches and
// asks for a name to narrow it, so the Save button stays within reach.
const PEOPLE_SHOWN = 20;

type Props = {
  taskId: string;
  language: ConnectedLanguage;
  /** Why the form opened (created here, or Chapter work could not open it). */
  intro?: string;
  /** Present only when Chapter work can open this task for the worn role. */
  onOpenInWork?: () => void;
  onSaved?: (task: EditableTask) => void;
};

export function ConnectedTaskEditor({ taskId, language, intro, onOpenInWork, onSaved }: Props) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, taskId);
  const theme = useTheme();
  const copy = connectedTaskEditorCopy[language];
  const [task, setTask] = useBusinessDraftState<EditableTask | null>(null, taskId);
  const [people, setPeople] = useBusinessDraftState<TaskAssignee[]>([], taskId);
  const [title, setTitle] = useBusinessDraftState('', taskId);
  const [assigneeId, setAssigneeId] = useBusinessDraftState<string | null>(null, taskId);
  const [due, setDue] = useBusinessDraftState('', taskId);
  const [query, setQuery] = useBusinessDraftState('', taskId);
  const [busy, setBusy] = useBusinessState(true);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  const [error, setError] = useBusinessDraftState('', taskId);
  const [notice, setNotice] = useBusinessDraftState('', taskId);
  const [revision, setRevision] = useBusinessDraftState(0, taskId);
  const announce = useAccessibilityAnnouncementQueue(`connected-task:${taskId}`);

  useEffect(() => {
    let current = true;
    setBusy(true); setError(''); setNotice('');
    void Promise.all([loadEditableTask(taskId), loadTaskAssignees()]).then(([loaded, roster]) => {
      if (!current) return;
      setTask(loaded); setPeople(roster);
      setTitle(loaded.title); setAssigneeId(loaded.assigneeId); setDue(loaded.dueDate ?? '');
    }).catch((failure: unknown) => {
      if (!current) return;
      setTask(null);
      setError(copy.failures[taskEditFailure(failure)]);
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [taskId, requests, revision, copy, setBusy, setError, setNotice, setTask, setPeople, setTitle, setAssigneeId, setDue]);

  const { shown, hiddenPeople } = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = needle ? people.filter((person) => person.label.toLocaleLowerCase().includes(needle)) : people;
    const first = matches.slice(0, PEOPLE_SHOWN);
    const chosen = people.find((person) => person.id === assigneeId);
    return { shown: chosen && !first.includes(chosen) ? [chosen, ...first] : first, hiddenPeople: matches.length > PEOPLE_SHOWN };
  }, [people, query, assigneeId]);

  const dueText = due.trim();
  const titleOk = isTaskTitle(title);
  const dueOk = dueText === '' || isTaskDate(dueText);
  const saveBlock = !titleOk ? copy.titleInvalid : !dueOk ? copy.dueDateInvalid : undefined;
  const saveFill = saveBlock ? theme.muted : theme.primary;

  const save = async () => {
    await operate(true, async () => {
    if (!task || busy || !titleOk || !dueOk) return;
    const current = requests.capture().isCurrent;
     setError(''); setNotice('');
    try {
      const saved = await saveTaskEdits(writer, task, { title, assigneeId, dueDate: dueText || null });
      setTask(saved); setTitle(saved.title); setAssigneeId(saved.assigneeId); setDue(saved.dueDate ?? '');
      setNotice(copy.saved);
      if (await writer.isCurrent() && current()) announce(copy.saved);
      await settleBusinessWrite(writer, { current, accepted: () => {}, stale: () => setNotice(BUSINESS_SAVED_STALE), refresh: () => onSaved?.(saved) });
    } catch (failure) {
      if (!current()) return;
      const reason = copy.failures[taskEditFailure(failure)];
      setError(reason);
      if (await writer.isCurrent() && current()) announce(reason);
    }

    });
  };

  const fieldStyle = [styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }];
  // A load failure has no form to sit in, so it shows at the top; once the task
  // is open, every outcome (saved, or why not) shows next to Save task.
  // A save's outcome is spoken once, by the announcement queue alone; a live
  // region as well made Android speak it twice. A load failure has no
  // announcement, so its polite live region stays.
  const failure = error ? (
    <View accessibilityRole="alert" accessibilityLiveRegion={task ? 'none' : 'polite'} style={styles.root}>
      <Text style={{ color: theme.destructive }}>{error}</Text>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => setRevision((value) => value + 1)} style={[styles.button, { borderColor: theme.border }]}>
        <Text style={{ color: theme.primary }}>{copy.reload}</Text>
      </Pressable>
    </View>
  ) : null;
  return (
    <View accessibilityRole="none" accessibilityLabel={copy.form} style={styles.root}>
      <Text accessibilityRole="header" style={[styles.heading, { color: theme.foreground }]}>{copy.form}</Text>
      {intro ? <Text style={{ color: theme.mutedForeground }}>{intro}</Text> : null}
      {!task ? failure : null}
      {!task ? (busy ? <Text style={{ color: theme.mutedForeground }}>{copy.loading}</Text> : null) : (
        <>
          <Text style={[styles.label, { color: theme.mutedForeground }]}>{copy.title}</Text>
          <TextInput
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            accessibilityLabel={copy.title}
            value={title}
            onChangeText={setTitle}
            editable={!busy}
            maxLength={TASK_TITLE_MAX}
            style={fieldStyle}
          />
          {!titleOk ? <Text style={{ color: theme.destructive }}>{copy.titleInvalid}</Text> : null}

          <Text style={[styles.label, { color: theme.mutedForeground }]}>{copy.assignee}</Text>
          <TextInput
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            accessibilityLabel={copy.findPerson}
            placeholder={copy.findPerson}
            placeholderTextColor={theme.mutedForeground}
            value={query}
            onChangeText={setQuery}
            editable={!busy}
            maxLength={80}
            style={fieldStyle}
          />
          <View accessibilityRole="radiogroup" accessibilityLabel={copy.assignee} style={styles.people}>
            {[{ id: '', label: copy.unassigned }, ...shown].map((person) => {
              const selected = (assigneeId ?? '') === person.id;
              return (
                <Pressable
                  key={person.id || 'nobody'}
                  accessibilityRole="radio"
                  accessibilityLabel={person.label}
                  accessibilityState={{ selected, disabled: busy }}
                  disabled={busy}
                  onPress={() => setAssigneeId(person.id || null)}
                  style={styles.personRow}
                >
                  <Text style={{ color: selected ? theme.primary : theme.foreground }}>
                    {selected ? '✓ ' : '○ '}{person.label}
                  </Text>
                </Pressable>
              );
            })}
            {shown.length === 0 && query.trim() ? <Text style={{ color: theme.mutedForeground }}>{copy.noPeople}</Text> : null}
            {hiddenPeople ? <Text style={{ color: theme.mutedForeground }}>{copy.narrowPeople}</Text> : null}
          </View>

          <Text style={[styles.label, { color: theme.mutedForeground }]}>{copy.dueDate}</Text>
          <TextInput
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            accessibilityLabel={copy.dueDate}
            placeholder="2026-12-01"
            placeholderTextColor={theme.mutedForeground}
            value={due}
            onChangeText={setDue}
            editable={!busy}
            maxLength={10}
            autoCapitalize="none"
            autoCorrect={false}
            style={fieldStyle}
          />
          {!dueOk ? <Text style={{ color: theme.destructive }}>{copy.dueDateInvalid}</Text> : null}

          {notice ? <Text accessibilityRole="text" style={{ color: theme.primary }}>{notice === BUSINESS_SAVED_STALE ? nativeUiText(language)(BUSINESS_SAVED_STALE) : notice}</Text> : null}
          {failure}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityHint={busy ? undefined : saveBlock}
              accessibilityState={{ busy }}
              disabled={busy || Boolean(saveBlock)}
              onPress={() => { void save(); }}
              style={[styles.button, { backgroundColor: saveFill, borderColor: saveFill }]}
            >
              <Text style={{ color: saveBlock ? theme.mutedForeground : theme.primaryForeground }}>{copy.save}</Text>
            </Pressable>
            {onOpenInWork ? (
              <Pressable accessibilityRole="button" disabled={busy} onPress={onOpenInWork} style={[styles.button, { borderColor: theme.border }]}>
                <Text style={{ color: theme.primary }}>{copy.openInWork}</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm, marginTop: spacing.md },
  heading: { fontSize: 16, lineHeight: 22, ...typeface.heading },
  label: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  input: { minHeight: minimumTouchTarget, paddingHorizontal: spacing.sm, borderWidth: 1, borderRadius: 12 },
  people: { gap: spacing.xs },
  personRow: { minHeight: minimumTouchTarget, justifyContent: 'center', paddingHorizontal: spacing.xs },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  button: {
    minHeight: minimumTouchTarget,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
