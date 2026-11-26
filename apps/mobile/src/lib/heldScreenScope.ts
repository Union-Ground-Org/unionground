import { useState } from 'react';

// #9227 round 1 (r1s1): a screen keys its content by who is signed in and
// where (organization, chapter), so another person or place never inherits it.
// Every return to the foreground re-checks the session (AppProvider's resume),
// and while it does the app is 'booting' with the dashboard and organization
// cleared for a moment. Keyed by the raw values, the content was thrown away
// by that gap, and with it what the person had picked and typed. The scope is
// held across that gap only: the same person on the same item while the app is
// booting keeps the last scope; another person or item, or any other value once
// the app is signed in again, is a new scope.
export type HeldScope = { fixed: string; parts: string; scope: string; provisional?: true };

export function nextHeldScope(previous: HeldScope | null, booting: boolean, fixed: readonly unknown[], parts: readonly unknown[], adoptFirst = false): HeldScope {
  const fixedKey = JSON.stringify(fixed);
  const partsKey = JSON.stringify(parts);
  if (booting && previous && previous.fixed === fixedKey) return previous;
  if (previous && previous.fixed === fixedKey && !previous.provisional && previous.parts === partsKey) return previous;
  // A scope first made while its parts were unknown has no earlier answer to
  // lose: the first known answer for the same fixed owner adopts it.
  if (adoptFirst && !booting && previous?.provisional && previous.fixed === fixedKey) return { fixed: fixedKey, parts: partsKey, scope: previous.scope };
  // A later confirmed loss can equal the initial fallback parts; its answered
  // key must still differ from the adopted provisional key.
  const scope = adoptFirst && booting ? JSON.stringify({ fixed, parts, provisional: true }) : JSON.stringify([...fixed, ...parts]);
  return adoptFirst && booting ? { fixed: fixedKey, parts: partsKey, scope, provisional: true } : { fixed: fixedKey, parts: partsKey, scope };
}

export function useHeldScreenScope(booting: boolean, fixed: readonly unknown[], parts: readonly unknown[], adoptFirst = false): string {
  const [held, setHeld] = useState<HeldScope | null>(null);
  const next = nextHeldScope(held, booting, fixed, parts, adoptFirst);
  // React's "information from previous renders" pattern: the update lands
  // before the children render, so the key is the held one from the start.
  if (held !== next) setHeld(next);
  return next.scope;
}
