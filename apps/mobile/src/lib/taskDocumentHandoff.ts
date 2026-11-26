import type { LifecycleEventInput, LifecycleOutcome } from '../services/lifecycleDiagnostics';

export type TaskAttachmentKind = 'document' | 'scan';
export type TaskAttachmentFailureReason = 'document' | 'scan' | 'camera-denied-retry' | 'camera-denied-settings';

export type TaskAttachmentFailure = { taskID: string; reason: TaskAttachmentFailureReason };
export type TaskAttachmentProducerPhase = 'preparing' | 'converting';

type AttachmentOwner = { releaseForSessionEnd(): Promise<void> };
const sessionOwners = new Set<AttachmentOwner>();
export function registerTaskAttachmentOwner(owner: AttachmentOwner): () => void {
  sessionOwners.add(owner);
  return () => { sessionOwners.delete(owner); };
}
export async function releaseTaskAttachmentHandoffs(isCurrent: () => boolean): Promise<void> {
  for (const owner of [...sessionOwners]) {
    if (!isCurrent()) return;
    await owner.releaseForSessionEnd();
  }
}

export class TaskCameraPermissionError extends Error {
  constructor(readonly canAskAgain: boolean) { super('Camera permission denied'); }
}

export type TaskDocumentPhase = 'checking' | 'authorized' | 'denied';

type PendingDocument<T> = {
  taskID: string;
  kind: TaskAttachmentKind;
  generation: number;
  candidate: T | null;
  converted: boolean;
  producerPhase: TaskAttachmentProducerPhase | null;
};

export type TaskDocumentSnapshot<T> = {
  identity: string | null;
  chapterID: string | null;
  phase: TaskDocumentPhase;
  query: string;
  openTaskIDs: readonly string[];
  pending: Readonly<PendingDocument<T>> | null;
  failed: boolean;
  failure: TaskAttachmentFailure | null;
  discardedKind: TaskAttachmentKind | null;
};

/** One route's picker ownership survives its protected child being remounted. */
export class TaskDocumentHandoff<T> {
  private identity: string | null = null;
  private chapterID: string | null = null;
  private phase: TaskDocumentPhase = 'denied';
  private query = '';
  private openTaskIDs: string[] = [];
  private pending: PendingDocument<T> | null = null;
  private authorizedTaskIDs: Set<string> | null = null;
  private failed = false;
  private failure: TaskAttachmentFailure | null = null;
  private discardedKind: TaskAttachmentKind | null = null;
  private releases = new Set<Promise<void>>();
  private generation = 0;
  private listeners = new Set<() => void>();
  private snapshot: TaskDocumentSnapshot<T>;

  constructor(private readonly release: (candidate: T) => Promise<void>,
    private readonly recorder: (event: LifecycleEventInput) => void = () => undefined) {
    this.snapshot = this.makeSnapshot();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = () => this.snapshot;

  private makeSnapshot(): TaskDocumentSnapshot<T> {
    const visible = this.phase === 'authorized';
    return {
      identity: this.identity, chapterID: this.chapterID, phase: this.phase,
      query: visible ? this.query : '',
      openTaskIDs: visible ? [...this.openTaskIDs] : [],
      pending: visible && this.pending && this.authorizedTaskIDs?.has(this.pending.taskID)
        ? { ...this.pending } : null,
      failed: visible && this.failed,
      failure: visible && this.failure && this.authorizedTaskIDs?.has(this.failure.taskID) ? this.failure : null,
      discardedKind: visible ? this.discardedKind : null,
    };
  }

  private publish() {
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }

  private record(step: LifecycleEventInput['step'], outcome: LifecycleOutcome, matched?: boolean, kind = this.pending?.kind) {
    try { this.recorder({ scope: 'attachment-selection', step, outcome, detail: {
      generation: this.generation, hasCandidate: Boolean(this.pending?.candidate),
      isScan: kind === 'scan', ...(matched === undefined ? {} : { matched }),
    } }); } catch { /* Observation must never change cleanup or capture. */ }
  }

  private releaseSafely(candidate: T) {
    let released: Promise<void>;
    try { released = this.release(candidate).catch(() => undefined); }
    catch { released = Promise.resolve(); }
    this.releases.add(released);
    void released.then(() => this.releases.delete(released));
  }

  private invalidate(reason: LifecycleOutcome, retainNotice = false) {
    this.record('handoff-invalidated', reason);
    this.discardedKind = retainNotice ? this.pending?.kind ?? this.discardedKind : null;
    this.generation += 1;
    if (this.pending?.candidate) this.releaseSafely(this.pending.candidate);
    this.pending = null;
    this.failed = false;
    this.failure = null;
  }

  async releaseForSessionEnd() {
    this.invalidate('session-end');
    this.query = '';
    this.openTaskIDs = [];
    this.publish();
    await Promise.all([...this.releases]);
  }

  observe(identity: string | null, chapterID: string | null, phase: TaskDocumentPhase) {
    const identityChanged = identity !== this.identity;
    const chapterChanged = phase === 'authorized' && chapterID !== this.chapterID;
    if (identityChanged || chapterChanged || phase === 'denied') {
      this.invalidate(identityChanged ? 'identity-changed' : chapterChanged ? 'chapter-changed' : 'access-denied', !identityChanged && !chapterChanged);
      this.query = '';
      this.openTaskIDs = [];
    }
    if (identityChanged || chapterChanged || phase !== 'authorized') this.authorizedTaskIDs = null;
    this.identity = identity;
    // Empty bootstrap scope is temporary, never an authorization grant.
    if (phase !== 'checking' || identityChanged) this.chapterID = chapterID;
    this.phase = identity && (phase !== 'authorized' || chapterID) ? phase : 'denied';
    if (this.phase === 'denied' && this.pending) this.invalidate('access-denied');
    this.publish();
  }

  setQuery(query: string) {
    if (this.phase !== 'authorized') return;
    this.query = query;
    this.publish();
  }

  setOpen(taskID: string, open: boolean) {
    if (this.phase !== 'authorized') return;
    this.openTaskIDs = this.openTaskIDs.filter((id) => id !== taskID);
    if (open) this.openTaskIDs.push(taskID);
    else if (this.pending?.taskID === taskID || this.failure?.taskID === taskID) this.invalidate('panel-closed');
    this.publish();
  }

  authorizeTasks(taskIDs: readonly string[]) {
    if (this.phase !== 'authorized') return;
    const allowed = new Set(taskIDs);
    this.authorizedTaskIDs = allowed;
    this.openTaskIDs = this.openTaskIDs.filter((id) => allowed.has(id));
    if (this.pending && !allowed.has(this.pending.taskID)) this.invalidate('task-unavailable', true);
    if (this.failure && !allowed.has(this.failure.taskID)) { this.failure = null; this.failed = false; }
    this.publish();
  }

  async choose(taskID: string, pick: (progress: (phase?: TaskAttachmentProducerPhase) => void) => Promise<T | null>, kind: TaskAttachmentKind = 'document') {
    if (this.phase !== 'authorized' || !this.identity || !this.chapterID || this.pending
      || !this.authorizedTaskIDs?.has(taskID)) return;
    const generation = ++this.generation;
    this.pending = { taskID, kind, generation, candidate: null, converted: false, producerPhase: null };
    this.failed = false;
    this.failure = null;
    this.discardedKind = null;
    this.record('handoff-started', kind);
    this.publish();
    try {
      const candidate = await pick((phase = 'converting') => {
        if (this.pending?.generation !== generation) return;
        this.pending.producerPhase = phase;
        if (phase === 'converting') this.pending.converted = true;
        this.record('handoff-phase', phase);
        this.publish();
      });
      this.record('handoff-settled', candidate ? 'selected' : 'cancelled', this.pending?.generation === generation, kind);
      if (this.pending?.generation !== generation) {
        if (candidate) this.releaseSafely(candidate);
        return;
      }
      if (candidate) this.pending.candidate = candidate;
      else this.pending = null;
    } catch (error) {
      this.record('handoff-settled', error instanceof TaskCameraPermissionError ? 'camera-permission-denied' : 'producer-failed', this.pending?.generation === generation, kind);
      if (this.pending?.generation !== generation) return;
      this.pending = null;
      this.failed = true;
      this.failure = { taskID, reason: kind === 'scan' && error instanceof TaskCameraPermissionError
        ? error.canAskAgain ? 'camera-denied-retry' : 'camera-denied-settings'
        : kind };
    }
    this.publish();
  }

  take(taskID: string, candidate: T): boolean {
    if (this.phase !== 'authorized' || this.pending?.taskID !== taskID
      || this.pending.candidate !== candidate || !this.authorizedTaskIDs?.has(taskID)) {
      this.record('handoff-taken', 'discarded', false); return false;
    }
    this.record('handoff-taken', 'selected', true);
    this.pending = null;
    this.failure = null;
    this.failed = false;
    this.publish();
    return true;
  }

  discard(taskID: string) {
    if (this.pending?.taskID !== taskID) return;
    this.invalidate('list-failed', true);
    this.publish();
  }

  dispose() {
    this.record('handoff-invalidated', 'route-exit');
    this.observe(null, null, 'denied');
  }
}
