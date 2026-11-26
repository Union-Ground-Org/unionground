import type { NativeUiKey } from './nativeUiCopy';

// #9369: the own-text view may show only strings the person typed, under a
// fixed local label. This allowlist is the whole of it: no ids, recipients,
// audiences, attempt keys, selections or server names ever leave the holder
// through it. A surface with no row here (token surfaces, id-only sends)
// shows nothing.
export type HeldWorkText = { label: NativeUiKey; lines: readonly string[]; uncertain: boolean };
// The dispatch state of the entry's companion send record, where a surface
// keeps one (#9417 gate r1s2/r2s2): pending or attempted shows the
// uncertainty line; a receipt means the work is not unsent at all.
export type HeldDispatch = { pending: boolean; attempted: boolean; receipt: boolean };
export const NO_DISPATCH: HeldDispatch = { pending: false, attempted: false, receipt: false };

type NamedValue = Record<string, unknown>;
const text = (value: unknown): string[] => (typeof value === 'string' && value.trim() !== '' ? [value] : []);
const record = (value: unknown): NamedValue => (value && typeof value === 'object' ? value as NamedValue : {});

export function heldWorkText(surface: string, value: unknown, pending: boolean, dispatch: HeldDispatch = NO_DISPATCH): HeldWorkText | null {
  if (dispatch.receipt) return null;
  const draft = record(value);
  let label: NativeUiKey;
  let lines: string[];
  let attempted = false;
  switch (surface) {
    case 'notice':
      label = 'Unsent notice';
      lines = [...text(draft.title), ...text(draft.body)];
      attempted = draft.attempt !== null && draft.attempt !== undefined;
      break;
    case 'meeting': {
      label = 'Unsent meeting';
      const meeting = record(draft.draft);
      lines = [...text(meeting.title), ...text(meeting.summary)];
      attempted = record(draft.identity).uncertain === true;
      break;
    }
    case 'workflow':
      label = 'Unsent message';
      lines = text(draft.body);
      attempted = draft.attempt !== null && draft.attempt !== undefined;
      break;
    case 'workflowReminder':
      label = 'Unsent reminder';
      lines = text(draft.note);
      break;
    case 'invitation':
      label = 'Unsent invitation';
      lines = [...text(draft.fullName), ...text(draft.email)];
      // A lost reply settles with the generic 'failed' code; a named server
      // code (not-permitted, a rate limit) is a known outcome.
      attempted = record(draft.notice).code === 'failed';
      break;
    case 'channelSettings':
      label = 'Channel keyword';
      lines = text(draft.keyword);
      // Stamped when the settings panel consumes a failed keyword save
      // (ledger 680); typing new words clears it with the draft they replace.
      attempted = draft.attempted === true;
      break;
    default:
      return null;
  }
  return lines.length ? { label, lines, uncertain: pending || attempted || dispatch.pending || dispatch.attempted } : null;
}
