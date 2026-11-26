import { useCallback, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useApp } from '../state/AppProvider';
import { captureSessionWriter } from '../services/supabase';
import { useRequestGeneration } from './useRequestGeneration';
import { resumeDraftOwnerFacts, type ResumeDraftOwner } from './resumeDraftOwnership';

// Account proof cannot detect a retained card changing its subject, or an
// unmount. A captured ticket covers those independent continuation boundaries.
export function useBusinessRequestOwner() {
  const app = useApp();
  const previous = useRef<ResumeDraftOwner | null>(null);
  const facts = resumeDraftOwnerFacts(app, previous.current);
  const confirmed = facts.checkingSamePerson && !facts.knownScopeChange ? previous.current! : facts;
  useLayoutEffect(() => { previous.current = confirmed; }, [confirmed]);
  return useMemo(() => ({ person: confirmed.person, workspace: confirmed.scope }), [confirmed.person, confirmed.scope]);
}

export function useBusinessRequests(_writer: object, scope: unknown = null) {
  const confirmed = useBusinessRequestOwner();
  const owner = useMemo(() => ({ ...confirmed, scope }), [confirmed, scope]);
  return useRequestGeneration(owner);
}

// Retry factories are retained per person and semantic scope, including a
// return to an earlier workspace. A transport/owner object is not a cache key.
export function useBusinessOperationCache<T>(key: string | null, create: () => T): T {
  const [entries] = useBusinessState(() => new Map<string | null, T>());
  if (!entries.has(key)) entries.set(key, create());
  return entries.get(key)!;
}

// One control remains owned until the write, proof and follow-up all settle.
// The synchronous flag also refuses a second press before React renders busy.
export async function completeBusinessOperation<T>(control: { current: boolean }, active: T, idle: T,
  setBusy: Dispatch<SetStateAction<T>>, work: () => Promise<void>): Promise<void> {
  if (control.current) return;
  control.current = true;
  setBusy(active);
  try { await work(); }
  finally { control.current = false; setBusy(idle); }
}

export function useBusinessOperation<T>(setBusy: Dispatch<SetStateAction<T>>, idle: T): [
  (active: T, work: () => Promise<void>) => Promise<void>, { current: boolean },
] {
  const [control] = useBusinessState(() => ({ current: false }));
  const run = useCallback((active: T, work: () => Promise<void>) =>
    completeBusinessOperation(control, active, idle, setBusy, work), [control, idle, setBusy]);
  return [run, control];
}

// A completed write settles only its composing subject's draft and receipt,
// even when this mounted card now displays another case or civic target.
export function useBusinessSubjectState<T>(subject: string | null, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const initialize = () => typeof initial === 'function' ? (initial as () => T)() : initial;
  const [subjects, setSubjects] = useBusinessState(() => new Map<string | null, T>());
  const value = subjects.has(subject) ? subjects.get(subject)! : initialize();
  if (!subjects.has(subject)) setSubjects(new Map(subjects).set(subject, value));
  const set = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    setSubjects(current => {
      const previous = current.get(subject) as T;
      const next = typeof update === 'function' ? (update as (value: T) => T)(previous) : update;
      return Object.is(previous, next) ? current : new Map(current).set(subject, next);
    });
  }, [subject, setSubjects]);
  return [value, set];
}

// Capture the rendered person synchronously. A retained event handler keeps
// that writer; batch (a)'s Auth-lock check decides whether it can dispatch.
export function useBusinessWriter() {
  const { mode, session } = useApp();
  const person = mode === 'authenticated' ? session?.user?.id ?? null : null;
  const valid = Boolean(session?.access_token);
  // Keep stateful retry-key factories through the same person's refresh. The
  // binder checks their current token at dispatch; it does not reuse this one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => captureSessionWriter(mode === 'authenticated' ? session : null), [mode, person, valid]);
}

// A retained screen may render another account before an old request settles.
// Keep each person's state in a separate in-memory bucket, selected before
// children render. Old callbacks update only their captured bucket. Drafts
// survive returning to their owner while this screen remains mounted.
export function useBusinessState<T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const app = useApp();
  const { mode, session } = app;
  const checking = resumeDraftOwnerFacts(app, null).checking;
  const owner = mode === 'authenticated' || checking ? session?.user?.id ?? 'signed-out' : mode;
  const initialize = () => typeof initial === 'function' ? (initial as () => T)() : initial;
  const [buckets, setBuckets] = useState<Map<string, T>>(() => new Map([[owner, initialize()]]));
  const present = buckets.has(owner);
  const value = present ? buckets.get(owner) as T : initialize();
  if (!present) setBuckets(new Map(buckets).set(owner, value));
  const set = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    setBuckets((current) => {
      const previous = current.get(owner) as T;
      const next = typeof update === 'function' ? (update as (value: T) => T)(previous) : update;
      return Object.is(previous, next) ? current : new Map(current).set(owner, next);
    });
  }, [owner]);
  return [value, set];
}
