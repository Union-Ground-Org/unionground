// BUG-UG-MOBILE-MESSAGES-TAB-BADGE-COUNTS-DIRECT-THREADS-ONLY-20260914:
// the last Messages tab badge count a completed channel load produced, kept
// outside React so it survives the tab host remounting (the deep-link + back
// sequence that produced the defect) and is forgotten the moment the signed-in
// user changes. Preview mode never records (its store is always ready).
let settledKey: string | null = null;
let settledCount: number | null = null;

export function settledBadgeFor(key: string | null): number | null {
  if (key === null || key !== settledKey) {
    settledKey = key;
    settledCount = null;
  }
  return settledCount;
}

export function rememberSettledBadge(key: string | null, count: number): void {
  if (key === null) return;
  settledKey = key;
  settledCount = count;
}

export function resetSettledBadgeForTests(): void {
  settledKey = null;
  settledCount = null;
}
