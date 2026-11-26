// REQ-UG-QUOTES-MINI-LESSONS-20260928: binds the learning controllers
// to the app session. The scope key carries the session instance, user,
// organization, chapter and content locale; when any of them changes the old
// controller is disposed in the same render that shows the new, empty one, so
// content from the previous account, chapter or language is never on screen
// and its late answers are dropped. Live sessions use the captured-session RPC
// client; PREVIEW uses its isolated fictional source.

import type { Session } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { useIsFocused } from 'expo-router';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { createPreviewLearningRpcClient, previewLearningStore } from '../../data/learningContentPreview';
import { PREVIEW_ORGANIZATION_ID } from '../../data/preview';
import type { LearningLocale, LearningPolicy, LearningScope } from '../../lib/learningContentModel';
import { learningCopy, type LearningCopy } from '../../lib/learningContentCopy';
import { createLearningContentApi, learningApiForSession } from '../../services/learningContent';
import { useApp } from '../../state/AppProvider';
import {
  EMPTY_LEARNING_HOME,
  EMPTY_LEARNING_LIBRARY,
  createLearningHomeController,
  createLearningLibraryController,
  createMemoryLearningNextStore,
  readLearningAdministration,
  type LearningHomeController,
  type LearningHomeSnapshot,
  type LearningLibraryController,
  type LearningLibrarySnapshot,
  type LearningNextStore,
  type LearningScopeContext,
} from './learningControllers';

// Next is a local convenience: a serialized day and index, never content.
const secureNextStore: LearningNextStore = {
  read: (key) => SecureStore.getItemAsync(key),
  write: (key, value) => SecureStore.setItemAsync(key, value),
};

// PREVIEW positions stay in memory with the rest of the fiction.
const previewNextStore = createMemoryLearningNextStore();

const sessionSerials = new WeakMap<Session, number>();
let sessionSerialCounter = 0;

function sessionSerial(session: Session): number {
  const known = sessionSerials.get(session);
  if (known !== undefined) return known;
  sessionSerialCounter += 1;
  sessionSerials.set(session, sessionSerialCounter);
  return sessionSerialCounter;
}

// PREVIEW has no session to lose: its fiction never outlives the preview scope key.
const previewGuard = () => () => true;

export function useLearningLocale(): LearningLocale {
  const { memberLanguage, dashboard } = useApp();
  return (memberLanguage ?? dashboard?.member.language) === 'es' ? 'es' : 'en';
}

export function useLearningCopy(): LearningCopy {
  return learningCopy(useLearningLocale());
}

/** The current learning scope, or null while no authorized workspace is loaded. */
export function useLearningScope(): LearningScopeContext | null {
  const { mode, session, dashboard, chapterMemberships, organizationID, previewHat, captureAuthenticatedSessionGuard } = useApp();
  const locale = useLearningLocale();
  const chapterId = chapterMemberships.find((entry) => entry.selected)?.chapterID ?? dashboard?.member.chapterID ?? null;
  const userId = mode === 'authenticated' ? session?.user.id ?? null : mode === 'preview' ? dashboard?.member.id ?? null : null;
  const serial = mode === 'authenticated' && session ? sessionSerial(session) : 0;
  const ready = dashboard !== null && userId !== null && (mode === 'preview' || (mode === 'authenticated' && session !== null));
  const scopeKey = ready
    ? [mode, serial, userId, organizationID ?? '', chapterId ?? '', locale, mode === 'preview' ? previewHat ?? '' : ''].join('|')
    : null;
  return useMemo<LearningScopeContext | null>(() => {
    if (!scopeKey || !userId) return null;
    if (mode === 'preview') {
      const organizationId = organizationID ?? PREVIEW_ORGANIZATION_ID;
      const client = createPreviewLearningRpcClient(previewLearningStore(organizationId), {
        userId,
        hat: previewHat ?? 'member',
        organizationId,
        chapterId,
      });
      return { scopeKey, source: 'preview', userId, organizationId, chapterId, locale, api: createLearningContentApi(client), nextStore: previewNextStore, captureGuard: previewGuard };
    }
    if (!session) return null;
    try {
      return {
        scopeKey,
        source: 'live',
        userId,
        organizationId: organizationID,
        chapterId,
        locale,
        api: learningApiForSession(session),
        nextStore: secureNextStore,
        captureGuard: captureAuthenticatedSessionGuard,
      };
    } catch {
      // No configured backend: the module stays absent rather than guessing.
      return null;
    }
    // Every input is represented in the scope key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);
}

function initiallyActive(state: AppStateStatus | null | undefined): boolean {
  return state !== 'background' && state !== 'inactive';
}

/** Focus and foreground drive the policy poll; covered screens read nothing. */
function useLearningActivity(controller: { setActive(active: boolean): void } | null) {
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(() => initiallyActive(AppState.currentState));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    controller?.setActive(focused && appActive);
  }, [appActive, controller, focused]);
}

const noopSubscribe = () => () => undefined;
const emptyHome = () => EMPTY_LEARNING_HOME;
const emptyLibrary = () => EMPTY_LEARNING_LIBRARY;

export function useLearningHome(): { scope: LearningScopeContext | null; controller: LearningHomeController | null; snapshot: LearningHomeSnapshot } {
  const scope = useLearningScope();
  const controller = useMemo(() => (scope && scope.chapterId !== null ? createLearningHomeController(scope) : null), [scope]);
  const snapshot = useSyncExternalStore(controller ? controller.subscribe : noopSubscribe, controller ? controller.getSnapshot : emptyHome);
  useEffect(() => {
    if (!controller) return undefined;
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  useLearningActivity(controller);
  return { scope, controller, snapshot };
}

export function useLearningLibrary(): { scope: LearningScopeContext | null; controller: LearningLibraryController | null; snapshot: LearningLibrarySnapshot } {
  const scope = useLearningScope();
  const controller = useMemo(() => (scope && scope.chapterId !== null ? createLearningLibraryController(scope) : null), [scope]);
  const snapshot = useSyncExternalStore(controller ? controller.subscribe : noopSubscribe, controller ? controller.getSnapshot : emptyLibrary);
  useEffect(() => {
    if (!controller) return undefined;
    return () => controller.dispose();
  }, [controller]);
  useLearningActivity(controller);
  return { scope, controller, snapshot };
}

/**
 * Whether this account may open the learning-content manager from Account.
 * One policy-only read per scope and role set (a new session, account,
 * chapter, language or staff assignment reads again); the answer from an
 * earlier scope is never shown under a newer one.
 */
export function useLearningAdministration(): { allowed: boolean; policy: LearningPolicy | null } {
  const scope = useLearningScope();
  const { authorizedRoles } = useApp();
  const key = scope ? `${scope.scopeKey}|${authorizedRoles.join(',')}` : null;
  const [state, setState] = useState<{ key: string | null; policy: LearningPolicy | null }>({ key: null, policy: null });
  useEffect(() => {
    if (!scope || !key) return undefined;
    let active = true;
    const stillCurrent = scope.captureGuard();
    void readLearningAdministration(scope).then((policy) => {
      if (active && stillCurrent()) setState({ key, policy });
    });
    return () => { active = false; };
    // The key carries the scope (and so the scope object) and the roles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const policy = state.key === key ? state.policy : null;
  return { allowed: policy !== null, policy };
}

/**
 * The scopes the manager offers: the platform only to a provisioned platform
 * editor, and the organization and chapter only when the server says this
 * account manages the selected chapter (`canManage`), the organization further
 * narrowed to organization administrators and presidents. The server checks
 * every call again.
 */
export function manageableLearningScopes(
  policy: { canManage: boolean; isPlatformOwner: boolean } | null,
  organizationRoles: readonly string[],
): LearningScope[] {
  if (!policy) return [];
  const scopes: LearningScope[] = [];
  if (policy.isPlatformOwner) scopes.push('platform');
  if (policy.canManage && (organizationRoles.includes('admin') || organizationRoles.includes('vp'))) scopes.push('organization');
  if (policy.canManage) scopes.push('chapter');
  return scopes;
}
