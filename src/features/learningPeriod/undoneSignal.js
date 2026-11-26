import { useEffect, useRef } from "react";

// REQ-UG-LEARNING-PERIOD-PREFERENCE-TABLES-JOURNAL-20261104 (#7027):
// an undo changes the database, but the screens that show what it changed
// hold their own copy (the shell's member data, a form seeded once, a feature
// panel's own read). The practice history announces each successful undo with
// the kinds it took back, and each surface that shows one of those kinds
// re-reads it, so a later save cannot write the undone choice back. Shared by
// the web and native apps, so it uses a plain listener set, not EventTarget.
const listeners = new Set();

/** @param {string[]} kinds */
export function announceLearningUndone(kinds) {
  if (!kinds.length) return;
  const taken = [...new Set(kinds)];
  for (const listener of [...listeners]) listener(taken);
}

/**
 * Calls onUndone(kinds) after an undo that took back any of the given kinds.
 * @param {string[]} kinds
 * @param {(kinds: string[]) => void} onUndone
 */
export function useLearningUndone(kinds, onUndone) {
  const latest = useRef(onUndone);
  latest.current = onUndone;
  const watched = kinds.join("|");
  useEffect(() => {
    const wanted = new Set(watched.split("|"));
    /** @param {string[]} taken */
    const listener = (taken) => {
      if (taken.some((kind) => wanted.has(kind))) latest.current(taken);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [watched]);
}
