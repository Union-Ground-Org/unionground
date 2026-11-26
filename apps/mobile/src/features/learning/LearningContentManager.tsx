// REQ-UG-QUOTES-MINI-LESSONS-20260928: the bounded native editor for
// governed quotes and mini-lessons. It opens inside Know your rights for an
// account the server says manages the selected scope, and offers only that
// scope's switches, selection and content. Saving always returns an item to
// draft; publishing and scheduling need a reviewed locale, reuse rights and
// review notes and, for attributed or factual items, a source; every change is
// revisioned and its history is paged forty at a time. There is no generated
// drafting: every word is typed or pasted by the editor.

import { Ionicons } from '@expo/vector-icons';
import { useIsFocused, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { Body, Button, Card, Heading, Screen, StateMessage, StatusPill } from '../../components/ui';
import {
  LEARNING_LIMITS,
  emptyLearningDraftForm,
  learningBodyLimit,
  learningDraftFormChanged,
  learningDraftFormFromItem,
  learningDraftFormIssues,
  learningDraftFormPayload,
  type LearningAudience,
  type LearningDraftForm,
  type LearningHistoryEntry,
  type LearningIssue,
  type LearningIssueField,
  type LearningItem,
  type LearningKind,
  type LearningLocale,
  type LearningLocaleState,
  type LearningPolicy,
  type LearningScope,
  type LearningScopePolicy,
  type LearningTransition,
} from '../../lib/learningContentModel';
import { learningActionDone, type LearningCopy } from '../../lib/learningContentCopy';
import { readRetainedDraft, retainedDraftKey, type ResumeScopeKind } from '../../lib/resumeDraftHolder';
import { defineRetainedSurface, useRetainedDraft, type Held, type RetainedPending } from '../../lib/retainedDraft';
import { withReadDeadline } from '../../lib/readDeadline';
import { useScreenBackInterceptor } from '../../lib/screenBack';
import { haptics } from '../../services/haptics';
import { LearningValidationError, learningFailureKind } from '../../services/learningContent';
import { useApp } from '../../state/AppProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';
import type { LearningScopeContext } from './learningControllers';
import {
  LearningCheckRow,
  LearningChoiceGroup,
  LearningFact,
  LearningListField,
  LearningMessages,
  LearningRowAction,
  LearningTextField,
  LearningToggleRow,
  type LearningChoice,
} from './LearningControls';
import { LearningItemView } from './LearningItemView';
import {
  defaultLearningWindowInput,
  formatLearningMoment,
  learningActionsFor,
  learningItemPublicationIssues,
  learningPolicyDraft,
  learningPolicyDraftChanged,
  learningProvenanceEntries,
  learningSelectionForSave,
  learningSelectionOutside,
  learningSelectionOverLimit,
  learningSnapshotTitle,
  learningStatusState,
  parseLearningWindowInput,
  toggleLearningSelection,
  type LearningPolicyDraft,
  type LearningSelectionMode,
  type LearningWindowInput,
} from './learningManagerModel';
import { manageableLearningScopes, useLearningCopy, useLearningScope } from './useLearningContent';

import { typeface } from '../../theme/typeface';
type Notice = { text: string; failed: boolean; conflict?: boolean };

// The copy key of a failure: kept with a held draft, so a session check or a
// remount shows the same line in the person's language.
type FailureKey = 'conflict' | 'notAuthorized' | 'invalid' | 'failed' | 'fixIssues';
const FAILURE_KEYS: readonly FailureKey[] = ['conflict', 'notAuthorized', 'invalid', 'failed', 'fixIssues'];

function failureKey(error: unknown): FailureKey {
  switch (learningFailureKind(error)) {
    case 'forbidden': return 'notAuthorized';
    case 'conflict': return 'conflict';
    case 'invalid': return 'invalid';
    default: return 'failed';
  }
}

function failureText(copy: LearningCopy, error: unknown): string {
  return copy[failureKey(error)];
}

function heldFailureText(copy: LearningCopy, key: string | null): string | null {
  if (key === null) return null;
  const known = FAILURE_KEYS.find((entry) => entry === key);
  return known ? copy[known] : copy.failed;
}

// Record 9240, pull request B (design R-9240D): a session check unmounts the manager
// (its scope is null while the session is checked, and both hosts close it),
// so only the unsent work waits, in memory, on the shared draft hook
// (src/lib/retainedDraft.ts): the item form, the policy draft and which
// editor was open. The holder keys each to the person, every role set and the
// hat; the content scope decides whether the chapter, the organization or
// neither is part of that key, and the item string adds the organization,
// chapter and content language the manager was opened for. No loaded row is
// kept: the editor opens again only on the fresh read's own row.
type Position = { scope: LearningScope | null; open: { id: string | null; kind: LearningKind } | null };
type HeldPolicy = { draft: LearningPolicyDraft; revision: number };
const positionSurface = defineRetainedSurface<Held<Position>>('learning-manager');
const policySurface = defineRetainedSurface<Held<HeldPolicy>>('learning-policy');
const itemSurface = defineRetainedSurface<Held<LearningDraftForm>>('learning-item');
const NO_POSITION: Position = { scope: null, open: null };
const NO_POLICY: HeldPolicy = { draft: { quotes: false, lessons: false, mode: 'all', selected: [] }, revision: 0 };

function heldKind(scope: LearningScope): ResumeScopeKind {
  return scope === 'chapter' ? 'chapter' : scope === 'organization' ? 'organization' : 'platform';
}

function heldPlace(scope: LearningScopeContext): string {
  return JSON.stringify([scope.organizationId, scope.chapterId, scope.locale]);
}

// A write begun by an earlier mount settles after this one has mounted: a
// definite failure shows through the hook, a landed write is read again (its
// answer went to the mount that sent it), and an unknown answer marks what
// may now hold it for reading again.
function useLandedElsewhere(shown: boolean, pending: RetainedPending, failed: string | null, own: MutableRefObject<boolean>, onLanded: () => void, onUnknown?: () => void) {
  const elsewhere = useRef(false);
  const landed = useRef(onLanded);
  landed.current = onLanded;
  const unknown = useRef(onUnknown);
  unknown.current = onUnknown;
  useEffect(() => {
    if (!shown) return;
    if (pending === 'sending') {
      if (!own.current) elsewhere.current = true;
      return;
    }
    if (!elsewhere.current) return;
    elsewhere.current = false;
    if (pending === false && failed === null) landed.current();
    if (pending === 'uncertain') unknown.current?.();
  }, [failed, own, pending, shown]);
}

function useAlive(): MutableRefObject<boolean> {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  return alive;
}

function BackAction({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Button
      label={label}
      variant="secondary"
      icon={<Ionicons name="chevron-back" size={18} color={theme.secondaryForeground} accessibilityElementsHidden />}
      onPress={onPress}
    />
  );
}

export type LearningManagerOrigin = 'learn' | 'account';

export function LearningContentManager({ onClose, origin = 'learn', bottomInset }: {
  onClose: () => void;
  /** Where the manager was opened: a level inside Know your rights, or inside Account. */
  origin?: LearningManagerOrigin;
  /** The hosting screen passes its bottom inset so the last control clears it. */
  bottomInset?: number;
}) {
  const scope = useLearningScope();
  const copy = useLearningCopy();
  const isFocused = useIsFocused();
  const navigation = useNavigation<{ setOptions: (options: { gestureEnabled: boolean }) => void }>();
  const backLabel = origin === 'account' ? copy.backToAccount : copy.backToLearn;
  // Know your rights and Account are pushed screens. Their edge swipe would
  // pop the whole screen past the manager's draft-discard confirmation, so
  // it stands down while the manager is open from either origin.
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: false });
    return () => navigation.setOptions({ gestureEnabled: true });
  }, [navigation]);

  if (!scope) {
    return (
      <ManagerFallback
        backLabel={backLabel}
        bottomInset={bottomInset}
        onClose={onClose}
        isFocused={isFocused}
        title={copy.workspaceLoadingTitle}
        body={copy.workspaceLoadingBody}
      />
    );
  }
  // A new session, account, chapter or language remounts the whole manager, so
  // nothing loaded under the previous scope survives the change. Unsent work
  // waits in the draft holder and comes back only to the same person, roles
  // and hat in the same organization, chapter and language (ManagerWorkspace). A
  // platform owner without a chapter reaches only the platform scope; anyone
  // else without a chapter is refused by the server and told to choose one.
  return <ManagerWorkspace key={scope.scopeKey} scope={scope} copy={copy} onClose={onClose} isFocused={isFocused} backLabel={backLabel} bottomInset={bottomInset} />;
}

function ManagerFallback({ backLabel, bottomInset, onClose, isFocused, title, body }: {
  backLabel: string;
  bottomInset?: number;
  onClose: () => void;
  isFocused: boolean;
  title: string;
  body: string;
}) {
  const back = useCallback(() => { onClose(); return true; }, [onClose]);
  useScreenBackInterceptor(isFocused ? back : null);
  return (
    <Screen bottomInset={bottomInset}>
      <BackAction label={backLabel} onPress={onClose} />
      <StateMessage title={title} body={body} />
    </Screen>
  );
}

type PageState = {
  status: 'idle' | 'loading' | 'ready' | 'unauthorized' | 'failed';
  items: LearningItem[];
  hasMore: boolean;
  nextOffset: number;
  loadingMore: boolean;
  loadMoreFailed: boolean;
};

const EMPTY_PAGE: PageState = { status: 'idle', items: [], hasMore: false, nextOffset: 0, loadingMore: false, loadMoreFailed: false };

function mergePage(current: PageState, offset: number, items: readonly LearningItem[], hasMore: boolean): PageState {
  const known = new Set(offset === 0 ? [] : current.items.map((item) => item.id));
  return {
    status: 'ready',
    items: offset === 0 ? [...items] : [...current.items, ...items.filter((item) => !known.has(item.id))],
    hasMore,
    nextOffset: offset + items.length,
    loadingMore: false,
    loadMoreFailed: false,
  };
}

type Editing = { key: string; item: LearningItem | null; kind: LearningKind };

function ManagerWorkspace({ scope, copy, onClose, isFocused, backLabel, bottomInset }: {
  scope: LearningScopeContext;
  copy: LearningCopy;
  onClose: () => void;
  isFocused: boolean;
  backLabel: string;
  bottomInset?: number;
}) {
  const theme = useTheme();
  const app = useApp();
  const { organizationRoles } = app;
  const alive = useAlive();
  const [policy, setPolicy] = useState<LearningPolicy | null>(null);
  const [policyFailed, setPolicyFailed] = useState(false);
  const [policyAttempt, setPolicyAttempt] = useState(0);
  const [activeScope, setActiveScope] = useState<LearningScope | null>(null);
  const [workspace, setWorkspace] = useState<PageState>(EMPTY_PAGE);
  const [savedPolicy, setSavedPolicy] = useState<LearningScopePolicy | null>(null);
  const [choices, setChoices] = useState<PageState>(EMPTY_PAGE);
  const [policyNotice, setPolicyNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [listNotice, setListNotice] = useState<string | null>(null);
  const workspaceRequest = useRef(0);
  const choicesRequest = useRef(0);
  const workspaceStale = useRef(false);
  // The scope whose first page the workspace holds.
  const workspaceScope = useRef<LearningScope | null>(null);
  const rolesRef = useRef(organizationRoles);
  rolesRef.current = organizationRoles;
  const place = heldPlace(scope);
  const workspaceFresh = workspace.status === 'ready' && savedPolicy !== null && workspaceScope.current === activeScope;

  // The policy draft waits through a session check; it is shown again only on
  // this mount's own read of the same scope. Its revision travels with it, so
  // a save never lands on settings that moved while the person was away.
  const policyHeld = useRetainedDraft<HeldPolicy>({
    surface: policySurface,
    item: JSON.stringify([activeScope, place]),
    empty: savedPolicy ? { draft: learningPolicyDraft(savedPolicy), revision: savedPolicy.revision ?? 0 } : NO_POLICY,
    fresh: workspaceFresh,
    scope: heldKind(activeScope ?? 'platform'),
    basis: savedPolicy ? String(savedPolicy.revision ?? 0) : null,
  });
  const draft = policyHeld.shown && savedPolicy ? policyHeld.value.draft : null;
  const policySaving = policyHeld.pending === 'sending';
  const ownPolicySave = useRef(false);
  // Which editor was open, so the person returns to it.
  const position = useRetainedDraft<Position>({ surface: positionSurface, item: place, empty: NO_POSITION, fresh: policy !== null, scope: 'platform' });
  const restored = useRef(false);
  const setPosition = useRef(position.set);
  setPosition.current = position.set;

  useEffect(() => {
    const stillCurrent = scope.captureGuard();
    setPolicyFailed(false);
    void scope.api.getPolicy(scope.chapterId).then((next) => {
      if (!alive.current || !stillCurrent()) return;
      setPolicy(next);
      const offered = manageableLearningScopes(next, rolesRef.current);
      setActiveScope(offered.includes('chapter') ? 'chapter' : offered[0] ?? null);
    }).catch(() => {
      if (alive.current && stillCurrent()) setPolicyFailed(true);
    });
  }, [alive, policyAttempt, scope]);

  const loadWorkspace = useCallback(async (target: LearningScope, offset: number) => {
    const request = ++workspaceRequest.current;
    const stillCurrent = scope.captureGuard();
    setWorkspace((current) => (offset === 0 ? { ...EMPTY_PAGE, status: 'loading' } : { ...current, loadingMore: true, loadMoreFailed: false }));
    try {
      const page = await scope.api.getWorkspace({ chapterId: scope.chapterId, scope: target, offset });
      if (!alive.current || request !== workspaceRequest.current || !stillCurrent()) return;
      setWorkspace((current) => mergePage(current, offset, page.items, page.hasMore));
      if (offset === 0) {
        workspaceScope.current = target;
        setSavedPolicy(page.policy);
        setPolicyNotice(null);
      }
    } catch (error) {
      if (!alive.current || request !== workspaceRequest.current || !stillCurrent()) return;
      if (offset > 0) {
        setWorkspace((current) => ({ ...current, loadingMore: false, loadMoreFailed: true }));
        return;
      }
      setWorkspace({ ...EMPTY_PAGE, status: learningFailureKind(error) === 'forbidden' ? 'unauthorized' : 'failed' });
      workspaceScope.current = null;
      setSavedPolicy(null);
    }
  }, [alive, scope]);

  // The selection picker reads the reviewed published and scheduled items
  // this scope may choose from (list_learning_choices), forty at a time, even
  // while a module switch is off.
  const loadChoices = useCallback(async (target: LearningScope, offset: number) => {
    const request = ++choicesRequest.current;
    const stillCurrent = scope.captureGuard();
    setChoices((current) => (offset === 0 ? { ...EMPTY_PAGE, status: 'loading' } : { ...current, loadingMore: true, loadMoreFailed: false }));
    try {
      const page = await scope.api.listChoices({ chapterId: scope.chapterId, scope: target, offset });
      if (!alive.current || request !== choicesRequest.current || !stillCurrent()) return;
      setChoices((current) => mergePage(current, offset, page.items, page.hasMore));
    } catch {
      if (!alive.current || request !== choicesRequest.current || !stillCurrent()) return;
      setChoices((current) => (offset > 0 ? { ...current, loadingMore: false, loadMoreFailed: true } : { ...EMPTY_PAGE, status: 'failed' }));
    }
  }, [alive, scope]);

  useEffect(() => {
    if (!activeScope) return;
    choicesRequest.current += 1;
    setChoices(EMPTY_PAGE);
    void loadWorkspace(activeScope, 0);
  }, [activeScope, loadWorkspace]);

  const selecting = activeScope !== null && activeScope !== 'platform' && draft?.mode === 'some';
  useEffect(() => {
    if (selecting && activeScope && choices.status === 'idle') void loadChoices(activeScope, 0);
  }, [activeScope, choices.status, loadChoices, selecting]);

  // The person's own navigation replaces whatever the holder would restore.
  const openEditor = useCallback((next: Editing) => {
    restored.current = true;
    setListNotice(null);
    setEditing(next);
  }, []);
  const chooseScope = useCallback((next: LearningScope) => {
    restored.current = true;
    setListNotice(null);
    setActiveScope(next);
  }, []);

  // Once this mount's reads are back, return to the editor that was open: its
  // scope first, then its row from the fresh list. A row that is gone (or not
  // on the first page) opens nothing; its held text waits for the row.
  useEffect(() => {
    if (restored.current || !position.shown || !policy || !activeScope) return;
    const held = position.value;
    if (!held.open || !held.scope || !manageableLearningScopes(policy, organizationRoles).includes(held.scope)) {
      restored.current = true;
      return;
    }
    if (activeScope !== held.scope) { setActiveScope(held.scope); return; }
    if (workspace.status === 'idle' || workspace.status === 'loading' || (workspace.status === 'ready' && workspaceScope.current !== held.scope)) return;
    restored.current = true;
    if (workspace.status !== 'ready') return;
    const { id, kind } = held.open;
    // A new editor comes back only while its held work does: a create that
    // landed during the unmount left nothing held, and the fresh list shows it.
    if (id === null) {
      const work = retainedDraftKey(app, itemSurface, JSON.stringify([held.scope, `new:${kind}`, place]), heldKind(held.scope));
      if (readRetainedDraft(work)) setEditing({ key: `new-${kind}-restored`, item: null, kind });
      return;
    }
    const item = workspace.items.find((entry) => entry.id === id);
    if (item) setEditing({ key: item.id, item, kind: item.kind });
  }, [activeScope, app, organizationRoles, place, policy, position.shown, position.value, workspace]);

  const openedID = editing ? editing.item?.id ?? null : null;
  const openedKind = editing?.kind ?? null;
  useEffect(() => {
    if (!restored.current || !position.shown) return;
    setPosition.current(openedKind && activeScope ? { scope: activeScope, open: { id: openedID, kind: openedKind } } : NO_POSITION);
  }, [activeScope, openedID, openedKind, position.shown]);

  const closeEditor = useCallback(() => {
    setEditing(null);
    setEditorDirty(false);
    if (workspaceStale.current && activeScope) {
      workspaceStale.current = false;
      choicesRequest.current += 1;
      setChoices(EMPTY_PAGE);
      void loadWorkspace(activeScope, 0);
    }
  }, [activeScope, loadWorkspace]);

  // Back belongs to the manager's own levels: the editor (after a native
  // discard confirmation when it holds unsaved changes), then the manager
  // itself, and only then Know your rights.
  const backState = useRef({ editing: false, dirty: false });
  backState.current = { editing: editing !== null, dirty: editorDirty };
  // The open editor's own Discard, so the confirmation also drops its held work.
  const discardEditor = useRef<(() => void) | null>(null);
  const handleBack = useCallback(() => {
    const state = backState.current;
    if (state.editing && state.dirty) {
      Alert.alert(copy.discardTitle, undefined, [
        { text: copy.keepEditing, style: 'cancel' },
        { text: copy.discard, style: 'destructive', onPress: () => { discardEditor.current?.(); closeEditor(); } },
      ]);
    } else if (state.editing) closeEditor();
    else onClose();
    return true;
  }, [closeEditor, copy, onClose]);
  useScreenBackInterceptor(isFocused ? handleBack : null);

  // One save at a time, held through an unmount and settled after it. The
  // revision sent is the one the draft was typed against.
  async function savePolicy() {
    if (!activeScope || !draft || !savedPolicy) return;
    const target = activeScope;
    const attempt = policyHeld.begin();
    if (!attempt) return;
    ownPolicySave.current = true;
    const stillCurrent = scope.captureGuard();
    setPolicyNotice(null);
    const sent = attempt.value;
    try {
      // Ledger 667: a hung save ends at the deadline as a definite failure
      // (its revision makes sending again conflict, never duplicate).
      const saved = await withReadDeadline(scope.api.savePolicy({
        chapterId: scope.chapterId,
        scope: target,
        quotesEnabled: sent.draft.quotes,
        lessonsEnabled: sent.draft.lessons,
        selectedIds: learningSelectionForSave(target, sent.draft),
        expectedRevision: sent.revision,
      }));
      attempt.settle('done');
      if (!alive.current || !stillCurrent()) return;
      setSavedPolicy(saved);
      setPolicyNotice({ text: copy.policySaved, failed: false });
      void haptics.success();
    } catch (error) {
      // A revision-guarded save: sending it again conflicts, never duplicates.
      attempt.settle({ failed: failureKey(error) });
      if (!alive.current || !stillCurrent()) return;
      setPolicyNotice({ text: failureText(copy, error), failed: true, conflict: learningFailureKind(error) === 'conflict' });
      void haptics.warning();
    } finally {
      if (alive.current) ownPolicySave.current = false;
    }
  }

  // Reload takes the current settings: the held draft goes, as on Main.
  function reloadPolicy(target: LearningScope) {
    policyHeld.discard();
    void loadWorkspace(target, 0);
  }

  // A policy save from an earlier mount that landed: read the settings again.
  useLandedElsewhere(policyHeld.shown, policyHeld.pending, policyHeld.failed, ownPolicySave, () => {
    if (activeScope) void loadWorkspace(activeScope, 0);
  });
  // An item save from an earlier mount that landed: back to the fresh list.
  const editorLanded = useCallback(() => {
    workspaceStale.current = true;
    closeEditor();
    setListNotice(copy.saved);
  }, [closeEditor, copy]);

  const upsertItem = useCallback((item: LearningItem) => {
    workspaceStale.current = true;
    setWorkspace((current) => ({
      ...current,
      items: current.items.some((entry) => entry.id === item.id)
        ? current.items.map((entry) => (entry.id === item.id ? item : entry))
        : [...current.items, item],
    }));
    // A first save turns the open new editor into that item's editor, so a
    // session check returns to the saved item, not to a blank new one.
    setEditing((current) => (current && (current.item === null ? current.kind === item.kind : current.item.id === item.id) ? { ...current, item } : current));
  }, []);

  if (editing && activeScope) {
    return (
      <Screen bottomInset={bottomInset}>
        <BackAction label={copy.backToList} onPress={() => { handleBack(); }} />
        <LearningItemEditor
          key={editing.key}
          scope={scope}
          copy={copy}
          contentScope={activeScope}
          item={editing.item}
          kind={editing.kind}
          fresh={workspaceFresh}
          discardRef={discardEditor}
          onDirtyChange={setEditorDirty}
          onSaved={upsertItem}
          onConflict={() => { workspaceStale.current = true; }}
          onLandedElsewhere={editorLanded}
        />
      </Screen>
    );
  }

  const policyFailure = heldFailureText(copy, policyHeld.failed);
  const policyLine: Notice | null = policyNotice ?? (policyFailure ? { text: policyFailure, failed: true, conflict: policyHeld.failed === 'conflict' } : null);
  const scopes = manageableLearningScopes(policy, organizationRoles);
  const scopeOptions: LearningChoice<LearningScope>[] = scopes.map((value) => ({ value, label: copy.scope[value] }));

  return (
    <Screen bottomInset={bottomInset}>
      <BackAction label={backLabel} onPress={onClose} />
      <Heading>{copy.managerTitle}</Heading>
      <Body muted>{copy.managerIntro}</Body>
      {policyFailed && scope.chapterId === null ? (
        <StateMessage compact title={copy.learnNoChapterTitle} body={copy.learnNoChapterBody} />
      ) : policyFailed ? (
        <StateMessage
          compact
          title={copy.learnErrorTitle}
          body={copy.failed}
          action={<Button label={copy.retry} variant="secondary" onPress={() => setPolicyAttempt((value) => value + 1)} />}
        />
      ) : policy === null ? (
        <StateMessage compact title={copy.workspaceLoadingTitle} body={copy.workspaceLoadingBody} />
      ) : scopes.length === 0 || !activeScope ? (
        <StateMessage compact title={copy.scopeHeading} body={copy.scopeUnavailable} />
      ) : (
        <>
          <Card>
            {scopeOptions.length > 1
              ? <LearningChoiceGroup label={copy.scopeHeading} options={scopeOptions} value={activeScope} onChange={chooseScope} />
              : <LearningFact label={copy.scopeHeading} value={copy.scope[activeScope]} />}
          </Card>
          {workspace.status === 'unauthorized' ? (
            <StateMessage compact title={copy.scope[activeScope]} body={copy.scopeUnavailable} />
          ) : workspace.status === 'failed' ? (
            <StateMessage
              compact
              title={copy.learnErrorTitle}
              body={copy.failed}
              action={<Button label={copy.retry} variant="secondary" onPress={() => { void loadWorkspace(activeScope, 0); }} />}
            />
          ) : workspace.status !== 'ready' || !savedPolicy ? (
            <StateMessage compact title={copy.workspaceLoadingTitle} body={copy.workspaceLoadingBody} />
          ) : (
            <>
              {draft ? (
                <PolicyPanel
                  copy={copy}
                  scope={activeScope}
                  draft={draft}
                  saved={savedPolicy}
                  choices={choices}
                  saving={policySaving}
                  stale={policyHeld.stale}
                  notice={policyLine}
                  onChange={(next) => { policyHeld.set({ draft: next }); setPolicyNotice(null); }}
                  onSave={() => { void savePolicy(); }}
                  onLoadMoreChoices={() => { void loadChoices(activeScope, choices.nextOffset); }}
                  onRetryChoices={() => { void loadChoices(activeScope, 0); }}
                />
              ) : (
                // Only the held switches and selection wait; the list stays.
                <Card>
                  <Heading level={3}>{copy.policyHeading}</Heading>
                  <Body muted>{copy.heldLoading}</Body>
                  {policyLine ? <LearningMessages tone={policyLine.failed ? 'error' : 'status'} messages={[policyLine.text]} /> : null}
                </Card>
              )}
              {draft && (policyLine?.conflict || policyHeld.stale) ? <Button label={copy.policyReload} variant="secondary" disabled={policySaving} onPress={() => { reloadPolicy(activeScope); }} /> : null}
              <View style={styles.section}>
                <Heading level={2}>{copy.contentHeading}</Heading>
                {listNotice ? <LearningMessages tone="status" messages={[listNotice]} /> : null}
                <View style={styles.actions}>
                  <Button
                    label={copy.newQuote}
                    icon={<Ionicons name="add" size={18} color={theme.primaryForeground} accessibilityElementsHidden />}
                    onPress={() => openEditor({ key: `new-quote-${Date.now()}`, item: null, kind: 'quote' })}
                  />
                  <Button
                    label={copy.newLesson}
                    variant="secondary"
                    icon={<Ionicons name="add" size={18} color={theme.secondaryForeground} accessibilityElementsHidden />}
                    onPress={() => openEditor({ key: `new-lesson-${Date.now()}`, item: null, kind: 'mini_lesson' })}
                  />
                </View>
                {workspace.items.length === 0 ? <Body muted>{copy.workspaceEmpty}</Body> : workspace.items.map((item) => (
                  <Card key={item.id}>
                    <StatusPill label={copy.status[item.status]} state={learningStatusState(item.status)} />
                    <Text style={[styles.cardTitle, { color: theme.cardForeground }]}>{item.title}</Text>
                    <Body muted>{copy.itemMeta(copy.kind[item.kind], copy.locale[item.locale], item.revision)}</Body>
                    {item.starts_at ? (
                      <Body muted>{copy.liveWindow(formatLearningMoment(item.starts_at, scope.locale), item.ends_at ? formatLearningMoment(item.ends_at, scope.locale) : null)}</Body>
                    ) : null}
                    <LearningRowAction
                      label={copy.edit}
                      accessibilityLabel={copy.editLabel(item.title)}
                      icon={<Ionicons name="create-outline" size={18} color={theme.secondaryForeground} accessibilityElementsHidden />}
                      onPress={() => openEditor({ key: item.id, item, kind: item.kind })}
                    />
                  </Card>
                ))}
                {workspace.loadMoreFailed ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.destructive }]}>{copy.failed}</Text> : null}
                {workspace.hasMore ? (
                  <Button label={copy.loadMoreItems} variant="secondary" busy={workspace.loadingMore} onPress={() => { void loadWorkspace(activeScope, workspace.nextOffset); }} />
                ) : null}
              </View>
            </>
          )}
        </>
      )}
    </Screen>
  );
}

function PolicyPanel({ copy, scope, draft, saved, choices, saving, stale, notice, onChange, onSave, onLoadMoreChoices, onRetryChoices }: {
  copy: LearningCopy;
  scope: LearningScope;
  draft: LearningPolicyDraft;
  saved: LearningScopePolicy;
  choices: PageState;
  saving: boolean;
  // The settings moved since this draft was started.
  stale: boolean;
  notice: Notice | null;
  onChange: (draft: LearningPolicyDraft) => void;
  onSave: () => void;
  onLoadMoreChoices: () => void;
  onRetryChoices: () => void;
}) {
  const theme = useTheme();
  const changed = learningPolicyDraftChanged(scope, draft, saved);
  const overLimit = learningSelectionOverLimit(draft);
  const outside = learningSelectionOutside(draft.selected, choices.items);
  const modes: LearningChoice<LearningSelectionMode>[] = [
    { value: 'all', label: copy.selectionAll },
    { value: 'none', label: copy.selectionNone },
    { value: 'some', label: copy.selectionSome },
  ];
  const modeBody = draft.mode === 'all' ? copy.selectionAllBody : draft.mode === 'none' ? copy.selectionNoneBody : copy.selectionSomeBody;
  return (
    <Card>
      <Heading level={3}>{copy.policyHeading}</Heading>
      <Body muted>{scope === 'platform' ? copy.platformPolicyNote : copy.tenantPolicyNote}</Body>
      <LearningToggleRow label={copy.quotesSwitch} value={draft.quotes} onValueChange={(quotes) => onChange({ ...draft, quotes })} />
      <LearningToggleRow label={copy.lessonsSwitch} value={draft.lessons} onValueChange={(lessons) => onChange({ ...draft, lessons })} />
      {scope !== 'platform' ? (
        <View style={styles.stack}>
          <LearningChoiceGroup label={copy.selectionHeading} options={modes} value={draft.mode} onChange={(mode) => onChange({ ...draft, mode })} />
          <Body muted>{modeBody}</Body>
          {draft.mode === 'some' ? (
            <>
              <Body>{copy.selectionCount(new Set(draft.selected).size)}</Body>
              {choices.status === 'failed' ? (
                <Button label={copy.retry} variant="secondary" onPress={onRetryChoices} />
              ) : choices.status !== 'ready' ? (
                <Body muted>{copy.workspaceLoadingTitle}</Body>
              ) : (
                <>
                  {choices.items.map((item) => (
                    <LearningCheckRow
                      key={item.id}
                      label={`${item.title} · ${copy.kind[item.kind]} · ${copy.locale[item.locale]}`}
                      checked={draft.selected.includes(item.id)}
                      onToggle={() => onChange({ ...draft, selected: toggleLearningSelection(draft.selected, item.id) })}
                    />
                  ))}
                  {choices.loadMoreFailed ? <Text style={[styles.error, { color: theme.destructive }]}>{copy.failed}</Text> : null}
                  {choices.hasMore ? <Button label={copy.loadMoreItems} variant="secondary" busy={choices.loadingMore} onPress={onLoadMoreChoices} /> : null}
                </>
              )}
              {choices.status === 'ready' && outside > 0 ? <Body muted>{copy.selectionKept(outside)}</Body> : null}
            </>
          ) : null}
          {overLimit ? <Text style={[styles.error, { color: theme.destructive }]}>{copy.selectionLimit(LEARNING_LIMITS.selectedIds)}</Text> : null}
        </View>
      ) : null}
      {stale ? <LearningMessages messages={[copy.heldPolicyStale]} /> : null}
      {notice ? <LearningMessages tone={notice.failed ? 'error' : 'status'} messages={[notice.text]} /> : null}
      <Button label={copy.savePolicy} busy={saving} disabled={!changed || overLimit} onPress={onSave} />
    </Card>
  );
}

function fieldError(copy: LearningCopy, issues: readonly LearningIssue[], field: LearningIssueField): string | null {
  const issue = issues.find((entry) => entry.field === field && entry.index === undefined);
  return issue ? copy.issue(issue) : null;
}

function entryErrors(copy: LearningCopy, issues: readonly LearningIssue[], field: 'bullets' | 'topics', length: number): (string | null)[] {
  return Array.from({ length }, (_, index) => {
    const issue = issues.find((entry) => entry.field === field && entry.index === index);
    return issue ? copy.issue(issue) : null;
  });
}

function LearningItemEditor({ scope, copy, contentScope, item, kind, fresh, discardRef, onDirtyChange, onSaved, onConflict, onLandedElsewhere }: {
  scope: LearningScopeContext;
  copy: LearningCopy;
  contentScope: LearningScope;
  item: LearningItem | null;
  kind: LearningKind;
  // The manager's read of this scope's items is back on this mount.
  fresh: boolean;
  discardRef: MutableRefObject<(() => void) | null>;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (item: LearningItem) => void;
  onConflict: () => void;
  onLandedElsewhere: () => void;
}) {
  const alive = useAlive();
  const [saved, setSaved] = useState<LearningItem | null>(item);
  const baseline = useMemo(() => (saved ? learningDraftFormFromItem(saved) : emptyLearningDraftForm(kind, scope.locale, contentScope)), [contentScope, kind, saved, scope.locale]);
  // The typed form waits through a session check. The item's revision is the
  // basis: if it moved meanwhile the text stays, the editor says so, and a save
  // still carries the revision it was typed against, so the server refuses it.
  const held = useRetainedDraft<LearningDraftForm>({
    surface: itemSurface,
    item: JSON.stringify([contentScope, saved?.id ?? `new:${kind}`, heldPlace(scope)]),
    empty: baseline,
    fresh,
    scope: heldKind(contentScope),
    basis: saved ? String(saved.revision) : null,
  });
  const form = held.value;
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const ownSave = useRef(false);
  const saving = held.pending === 'sending';
  const uncertain = held.pending === 'uncertain';
  const locked = held.pending !== false;
  const dirty = held.shown && learningDraftFormChanged(form, baseline);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const discard = useRef(held.discard);
  discard.current = held.discard;
  useEffect(() => {
    discardRef.current = () => discard.current();
    return () => { discardRef.current = null; };
  }, [discardRef]);
  // Held text the fresh item already carries (its save landed) is let go, so
  // the form follows the item instead of an older revision.
  const settledStale = held.shown && held.stale && !dirty && !locked;
  useEffect(() => { if (settledStale) discard.current(); }, [settledStale]);
  useLandedElsewhere(held.shown, held.pending, held.failed, ownSave, onLandedElsewhere, onConflict);

  const issues = attempted && held.shown ? learningDraftFormIssues(form) : [];
  const update = (patch: Partial<LearningDraftForm>) => {
    held.set(patch);
    setNotice(null);
  };
  const lesson = form.kind === 'mini_lesson';
  const existing = form.id !== null;

  // One save at a time, held through an unmount and settled after it. Only a
  // create is unkeyed: an answer lost on the way back leaves it unconfirmed and
  // locked until a deliberate Save again or Discard. An update carries its
  // revision, so sending it again conflicts instead of making a copy.
  async function save() {
    setAttempted(true);
    if (learningDraftFormIssues(form).length > 0) {
      setNotice(null);
      void haptics.warning();
      return;
    }
    const attempt = held.begin();
    if (!attempt) return;
    ownSave.current = true;
    const stillCurrent = scope.captureGuard();
    const create = attempt.value.id === null;
    setNotice(null);
    try {
      // Ledger 667: a hung save ends at the deadline. Its expiry is a network
      // failure: unconfirmed for an unkeyed create, a definite failure for a
      // revision-guarded update.
      const result = await withReadDeadline(scope.api.saveContent({ chapterId: scope.chapterId, form: attempt.value }));
      attempt.settle('done');
      if (!alive.current || !stillCurrent()) return;
      setSaved(result);
      setAttempted(false);
      setNotice({ text: copy.saved, failed: false });
      onSaved(result);
      void haptics.success();
    } catch (error) {
      const failure = learningFailureKind(error);
      const unknown = create && (failure === 'network' || failure === 'unknown' || failure === 'contract');
      attempt.settle(unknown ? 'uncertain' : { failed: error instanceof LearningValidationError ? 'fixIssues' : failureKey(error) });
      if (!alive.current || !stillCurrent()) return;
      // Keep the open draft intact; refresh its cached revision only after
      // the editor leaves through the existing discard/back confirmation.
      // An unknown create may have landed: the list the person checks is read
      // again when the editor closes, as after a conflict.
      if (failure === 'conflict' || unknown) onConflict();
      setNotice(unknown ? null : { text: error instanceof LearningValidationError ? copy.fixIssues : failureText(copy, error), failed: true });
      void haptics.warning();
    } finally {
      if (alive.current) ownSave.current = false;
    }
  }

  function discardUnconfirmed() {
    held.discard();
    setNotice(null);
    setAttempted(false);
  }

  const localeOptions: LearningChoice<LearningLocale>[] = [{ value: 'en', label: copy.locale.en }, { value: 'es', label: copy.locale.es }];
  const reviewOptions: LearningChoice<LearningLocaleState>[] = [{ value: 'draft', label: copy.localeState.draft }, { value: 'reviewed', label: copy.localeState.reviewed }];
  const audienceOptions: LearningChoice<LearningAudience>[] = [
    { value: 'all', label: copy.audience.all },
    { value: 'members', label: copy.audience.members },
    { value: 'staff', label: copy.audience.staff },
  ];
  // A failure line from this mount, or the one held with the draft.
  const heldFailure = heldFailureText(copy, held.failed);
  const failureLine: Notice | null = notice ?? (heldFailure ? { text: heldFailure, failed: true } : null);
  const listIssues = issues.filter((entry) => (entry.field === 'bullets' || entry.field === 'topics') && entry.index === undefined).map(copy.issue);
  const payload = learningDraftFormPayload(form);

  return (
    <>
      <Heading>{existing ? copy.editItemTitle : copy.newItemTitle(copy.kind[form.kind])}</Heading>
      {saved ? <StatusPill label={copy.status[saved.status]} state={learningStatusState(saved.status)} /> : null}
      {!held.shown ? (
        // Only the held text and Save wait for this mount's reads; the failure
        // line, Back and the publication panel below stay.
        <Card>
          <Body muted>{copy.heldLoading}</Body>
          {failureLine ? <LearningMessages tone={failureLine.failed ? 'error' : 'status'} messages={[failureLine.text]} /> : null}
        </Card>
      ) : (
      <Card>
        <LearningFact label={copy.fields.kind} value={copy.kind[form.kind]} />
        {existing
          ? <LearningFact label={copy.fields.locale} value={copy.locale[form.locale]} />
          : <LearningChoiceGroup label={copy.fields.locale} options={localeOptions} value={form.locale} onChange={(locale) => update({ locale })} />}
        {existing ? <Body muted>{copy.fixedIdentity}</Body> : null}
        <LearningTextField label={copy.fields.title} value={form.title} onChangeText={(title) => update({ title })} limit={LEARNING_LIMITS.title} copy={copy} error={fieldError(copy, issues, 'title')} editable={!locked} />
        <LearningTextField label={lesson ? copy.lessonBodyLabel : copy.quoteBodyLabel} value={form.body} onChangeText={(body) => update({ body })} limit={learningBodyLimit(form.kind) ?? LEARNING_LIMITS.body.mini_lesson} copy={copy} multiline error={fieldError(copy, issues, 'body')} editable={!locked} />
        <LearningTextField label={copy.fields.attribution} value={form.attribution} onChangeText={(attribution) => update({ attribution })} limit={LEARNING_LIMITS.attribution} copy={copy} error={fieldError(copy, issues, 'attribution')} editable={!locked} />
        <LearningTextField label={copy.fields.source} value={form.source} onChangeText={(source) => update({ source })} limit={LEARNING_LIMITS.source} copy={copy} multiline error={fieldError(copy, issues, 'source')} editable={!locked} />
        {lesson || form.bullets.length > 0 ? (
          <LearningListField label={copy.fields.bullets} addLabel={copy.addBullet} values={form.bullets} max={LEARNING_LIMITS.bulletCount} entryLimit={LEARNING_LIMITS.bullet} onChange={(bullets) => update({ bullets })} copy={copy} errors={entryErrors(copy, issues, 'bullets', form.bullets.length)} editable={!locked} />
        ) : null}
        {lesson || form.learning_outcome ? (
          <LearningTextField label={copy.fields.learning_outcome} value={form.learning_outcome} onChangeText={(value) => update({ learning_outcome: value })} limit={LEARNING_LIMITS.learning_outcome} copy={copy} multiline error={fieldError(copy, issues, 'learning_outcome')} editable={!locked} />
        ) : null}
        <LearningListField label={copy.fields.topics} addLabel={copy.addTopic} values={form.topics} max={LEARNING_LIMITS.topicCount} entryLimit={LEARNING_LIMITS.topic} onChange={(topics) => update({ topics })} copy={copy} errors={entryErrors(copy, issues, 'topics', form.topics.length)} editable={!locked} />
        <LearningMessages messages={listIssues} />
        <LearningChoiceGroup label={copy.fields.audience} options={audienceOptions} value={form.audience} onChange={(audience) => update({ audience })} />
        <LearningTextField label={copy.fields.tone} value={form.tone} onChangeText={(tone) => update({ tone })} limit={LEARNING_LIMITS.tone} copy={copy} error={fieldError(copy, issues, 'tone')} editable={!locked} />
        <LearningTextField label={`${copy.fields.priority} (0–100)`} value={form.priority} onChangeText={(priority) => update({ priority })} limit={3} counter={false} copy={copy} inputMode="numeric" error={fieldError(copy, issues, 'priority')} editable={!locked} />
        <LearningToggleRow label={copy.fields.factual_claims} body={copy.factualHint} value={form.factual_claims} onValueChange={(value) => update({ factual_claims: value })} />
        {contentScope === 'platform' ? (
          <LearningToggleRow label={copy.fields.is_default} body={copy.isDefaultHint} value={form.is_default} onValueChange={(value) => update({ is_default: value })} />
        ) : null}
        <LearningTextField label={copy.fields.direction} hint={copy.directionHint} value={form.direction} onChangeText={(direction) => update({ direction })} limit={LEARNING_LIMITS.direction} copy={copy} multiline error={fieldError(copy, issues, 'direction')} editable={!locked} />
        <LearningTextField label={copy.fields.rights_note} value={form.rights_note} onChangeText={(value) => update({ rights_note: value })} limit={LEARNING_LIMITS.rights_note} copy={copy} multiline error={fieldError(copy, issues, 'rights_note')} editable={!locked} />
        <LearningTextField label={copy.fields.review_note} value={form.review_note} onChangeText={(value) => update({ review_note: value })} limit={LEARNING_LIMITS.review_note} copy={copy} multiline error={fieldError(copy, issues, 'review_note')} editable={!locked} />
        <LearningChoiceGroup label={copy.fields.locale_state} options={reviewOptions} value={form.locale_state} onChange={(value) => update({ locale_state: value })} />
        {issues.length > 0 ? <LearningMessages heading={copy.fixIssues} messages={[...new Set(issues.map(copy.issue))]} /> : null}
        {held.stale && dirty ? <LearningMessages messages={[copy.heldStale]} /> : null}
        {uncertain ? <LearningMessages messages={[copy.heldUncertain]} /> : null}
        {failureLine ? <LearningMessages tone={failureLine.failed ? 'error' : 'status'} messages={[failureLine.text]} /> : null}
        <Body muted>{copy.saveNote}</Body>
        <Button label={uncertain ? copy.saveAgain : copy.saveDraft} busy={saving} disabled={!dirty && existing && !uncertain} onPress={() => { void save(); }} />
        {uncertain ? <Button label={copy.discard} variant="secondary" onPress={discardUnconfirmed} /> : null}
      </Card>
      )}

      {held.shown ? (
        <Button
          label={previewOpen ? copy.hidePreview : copy.preview}
          variant="secondary"
          icon={<PreviewIcon open={previewOpen} />}
          onPress={() => setPreviewOpen((open) => !open)}
        />
      ) : null}
      {held.shown && previewOpen ? (
        <LearningPreview
          copy={copy}
          item={{ kind: form.kind, title: payload.title, body: payload.body, attribution: payload.attribution, source: payload.source, bullets: payload.bullets, learning_outcome: payload.learning_outcome }}
        />
      ) : null}

      {saved ? (
        <PublicationPanel
          scope={scope}
          copy={copy}
          item={saved}
          dirty={dirty}
          waiting={!held.shown}
          onConflict={onConflict}
          onChanged={(next) => {
            // As before, a publication change resets the form to the item.
            held.discard();
            setSaved(next);
            onSaved(next);
          }}
        />
      ) : null}
      {saved ? <ProvenanceCard copy={copy} provenance={saved.provenance} /> : null}
      {saved ? <HistoryPanel scope={scope} copy={copy} item={saved} /> : null}
    </>
  );
}

function ProvenanceCard({ copy, provenance }: { copy: LearningCopy; provenance: Readonly<Record<string, unknown>> | null }) {
  const theme = useTheme();
  const entries = learningProvenanceEntries(provenance);
  if (entries.length === 0) return null;
  return (
    <Card>
      <Heading level={3}>{copy.provenanceHeading}</Heading>
      <Body muted>{copy.provenanceIntro}</Body>
      {entries.map(([key, value]) => (
        <View key={key} accessible accessibilityLabel={`${key}: ${value}`} style={[styles.historyRow, { borderTopColor: theme.border }]}>
          <Text style={[styles.historyTitle, { color: theme.cardForeground }]}>{key}</Text>
          <Text selectable style={[styles.historyDetail, { color: theme.cardForeground }]}>{value}</Text>
        </View>
      ))}
    </Card>
  );
}

function PreviewIcon({ open }: { open: boolean }) {
  const theme = useTheme();
  return <Ionicons name={open ? 'eye-off-outline' : 'eye-outline'} size={18} color={theme.secondaryForeground} accessibilityElementsHidden />;
}

type PreviewItem = {
  kind: LearningKind;
  title: string;
  body: string;
  attribution: string;
  source: string;
  bullets: readonly string[];
  learning_outcome: string;
};

/** Renders the unsaved form exactly as Home and Know your rights would. */
function LearningPreview({ copy, item }: { copy: LearningCopy; item: PreviewItem }) {
  const theme = useTheme();
  const renderable = item.title.trim() !== '' && item.body.trim() !== '';
  return (
    <View style={styles.stack}>
      <Body muted>{copy.previewNote}</Body>
      {renderable ? (
        <>
          <Text style={[styles.previewLabel, { color: theme.mutedForeground }]}>{copy.previewHomeLabel}</Text>
          <Card><LearningItemView item={item} copy={copy} compact expanded={false} /></Card>
          <Text style={[styles.previewLabel, { color: theme.mutedForeground }]}>{copy.previewLearnLabel}</Text>
          <Card><LearningItemView item={item} copy={copy} compact={false} expanded /></Card>
        </>
      ) : (
        <Body muted>{copy.issue({ field: 'title', code: 'required' })}</Body>
      )}
    </View>
  );
}

function PublicationPanel({ scope, copy, item, dirty, waiting, onChanged, onConflict }: {
  scope: LearningScopeContext;
  copy: LearningCopy;
  item: LearningItem;
  dirty: boolean;
  // The editor's held text is waiting for this mount's reads: no new
  // publication starts; an open confirmation and a change in flight go on.
  waiting: boolean;
  onChanged: (item: LearningItem) => void;
  onConflict: () => void;
}) {
  const theme = useTheme();
  const alive = useAlive();
  const [pending, setPending] = useState<LearningTransition | null>(null);
  const [input, setInput] = useState<LearningWindowInput>(() => defaultLearningWindowInput(new Date()));
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const blockers = [...new Set(learningItemPublicationIssues(item).map(copy.issue))];
  const actions = learningActionsFor(item);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';

  function begin(action: LearningTransition) {
    setPending(action);
    setProblems([]);
    setNotice(null);
    setInput(defaultLearningWindowInput(new Date()));
  }

  async function confirm() {
    if (!pending) return;
    const parsed = parseLearningWindowInput(pending, input);
    if (!parsed.ok) {
      setProblems([copy.invalidDateTime]);
      return;
    }
    const stillCurrent = scope.captureGuard();
    const action = pending;
    setBusy(true);
    setProblems([]);
    setNotice(null);
    try {
      const next = await scope.api.transition({ chapterId: scope.chapterId, id: item.id, action, expectedRevision: item.revision, startsAt: parsed.startsAt, endsAt: parsed.endsAt });
      if (!alive.current || !stillCurrent()) return;
      setPending(null);
      setNotice({ text: learningActionDone(copy, action), failed: false });
      onChanged(next);
      void haptics.success();
    } catch (error) {
      if (!alive.current || !stillCurrent()) return;
      if (learningFailureKind(error) === 'conflict') onConflict();
      if (error instanceof LearningValidationError) setProblems([...new Set(error.issues.map(copy.issue))]);
      else setNotice({ text: failureText(copy, error), failed: true });
      void haptics.warning();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const prompt = pending === 'publish' ? copy.confirmPublish : pending === 'schedule' ? copy.confirmSchedule : copy.confirmWithdraw;
  const blocked = dirty || waiting || blockers.length > 0;
  return (
    <Card>
      <Heading level={3}>{copy.publicationHeading}</Heading>
      <StatusPill label={copy.status[item.status]} state={learningStatusState(item.status)} />
      {item.starts_at ? (
        <Body muted>{copy.liveWindow(formatLearningMoment(item.starts_at, scope.locale), item.ends_at ? formatLearningMoment(item.ends_at, scope.locale) : null)}</Body>
      ) : null}
      {dirty ? <Body muted>{copy.publicationSaveFirst}</Body> : null}
      {!dirty && blockers.length > 0 ? <LearningMessages heading={copy.publicationBlocked} messages={blockers} /> : null}
      {pending === null ? (
        <View style={styles.actions}>
          <Button label={copy.publishNow} disabled={blocked} onPress={() => begin('publish')} />
          <Button label={copy.schedule} variant="secondary" disabled={blocked} onPress={() => begin('schedule')} />
          {actions.includes('withdraw') ? <Button label={copy.withdraw} variant="danger" disabled={dirty || waiting} onPress={() => begin('withdraw')} /> : null}
        </View>
      ) : (
        <View style={styles.stack}>
          <Text accessibilityRole="header" style={[styles.prompt, { color: theme.cardForeground }]}>{prompt}</Text>
          {pending === 'schedule' ? (
            <>
              <LearningTextField label={copy.startDate} hint={copy.dateHint} placeholder={copy.dateHint} value={input.startDate} onChangeText={(startDate) => setInput({ ...input, startDate })} limit={10} counter={false} copy={copy} editable={!busy} />
              <LearningTextField label={copy.startTime} hint={copy.timeHint} placeholder="09:00" value={input.startTime} onChangeText={(startTime) => setInput({ ...input, startTime })} limit={5} counter={false} copy={copy} editable={!busy} />
            </>
          ) : null}
          {pending !== 'withdraw' ? (
            <>
              <LearningTextField label={copy.endDate} hint={copy.dateHint} placeholder={copy.dateHint} value={input.endDate} onChangeText={(endDate) => setInput({ ...input, endDate })} limit={10} counter={false} copy={copy} editable={!busy} />
              <LearningTextField label={copy.endTime} hint={copy.timeHint} placeholder="17:00" value={input.endTime} onChangeText={(endTime) => setInput({ ...input, endTime })} limit={5} counter={false} copy={copy} editable={!busy} />
              {zone ? <Body muted>{copy.timeZoneNote(zone)}</Body> : null}
            </>
          ) : null}
          <LearningMessages messages={problems} />
          <View style={styles.actions}>
            <Button label={copy.confirm} variant={pending === 'withdraw' ? 'danger' : 'primary'} busy={busy} onPress={() => { void confirm(); }} />
            <Button label={copy.cancel} variant="secondary" disabled={busy} onPress={() => { setPending(null); setProblems([]); }} />
          </View>
        </View>
      )}
      {notice ? <LearningMessages tone={notice.failed ? 'error' : 'status'} messages={[notice.text]} /> : null}
    </Card>
  );
}

function HistoryPanel({ scope, copy, item }: { scope: LearningScopeContext; copy: LearningCopy; item: LearningItem }) {
  const theme = useTheme();
  const alive = useAlive();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LearningHistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);

  const load = useCallback(async (offset: number) => {
    const current = ++request.current;
    const stillCurrent = scope.captureGuard();
    setLoading(true);
    setFailed(false);
    try {
      const page = await scope.api.getHistory({ chapterId: scope.chapterId, id: item.id, offset });
      if (!alive.current || current !== request.current || !stillCurrent()) return;
      setEntries((previous) => (offset === 0 ? [...page.items] : [...previous, ...page.items]));
      setHasMore(page.hasMore);
      setNextOffset(offset + page.items.length);
    } catch {
      if (!alive.current || current !== request.current || !stillCurrent()) return;
      setFailed(true);
    } finally {
      if (alive.current && current === request.current) setLoading(false);
    }
  }, [alive, item.id, scope]);

  // Opening, or a new revision while open, reads the newest page again.
  useEffect(() => {
    if (open) void load(0);
  }, [item.revision, load, open]);

  const by = (entry: LearningHistoryEntry) => (entry.changedBy === null ? copy.historyByRemoved : entry.changedBy === scope.userId ? copy.historyByYou : copy.historyByOther);

  return (
    <Card>
      <Heading level={3}>{copy.historyHeading}</Heading>
      <Button
        label={open ? copy.hideHistory : copy.showHistory}
        variant="secondary"
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <View style={styles.stack}>
          {failed ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.destructive }]}>{copy.failed}</Text> : null}
          {!loading && !failed && entries.length === 0 ? <Body muted>{copy.historyEmpty}</Body> : null}
          {entries.map((entry) => {
            const line = `${copy.historyRevision(entry.revision)} · ${copy.historyAction(entry.action)}`;
            const meta = `${formatLearningMoment(entry.changedAt, scope.locale)} · ${by(entry)}`;
            const title = learningSnapshotTitle(entry.snapshot);
            return (
              <View key={`${entry.revision}:${entry.action}:${entry.changedAt}`} accessible accessibilityLabel={`${line}. ${meta}. ${title}`} style={[styles.historyRow, { borderTopColor: theme.border }]}>
                <Text style={[styles.historyTitle, { color: theme.cardForeground }]}>{line}</Text>
                <Body muted>{meta}</Body>
                {title ? <Text numberOfLines={2} style={[styles.historyDetail, { color: theme.cardForeground }]}>{title}</Text> : null}
              </View>
            );
          })}
          {hasMore || (failed && entries.length > 0) ? (
            <Button label={copy.loadMoreHistory} variant="secondary" busy={loading} onPress={() => { void load(nextOffset); }} />
          ) : failed ? (
            <Button label={copy.retry} variant="secondary" busy={loading} onPress={() => { void load(0); }} />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  stack: { gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cardTitle: { fontSize: 17, lineHeight: 23, ...typeface.heading },
  error: { fontSize: 14, lineHeight: 19, ...typeface.control },
  prompt: { fontSize: 16, lineHeight: 22, ...typeface.controlStrong },
  previewLabel: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong, letterSpacing: 1.2 },
  historyRow: { gap: 2, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
  historyTitle: { fontSize: 15, lineHeight: 20, ...typeface.heading },
  historyDetail: { fontSize: 15, lineHeight: 21 },
});
