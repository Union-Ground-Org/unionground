// Member Support outcome notices carry their tone with the message so a
// refused write can never render in the success treatment. The screen owns the
// rendering; this module owns the decision, which is what the tests run.

export type MemberSupportNoticeTone = 'success' | 'error';

export type MemberSupportNotice = { message: string; tone: MemberSupportNoticeTone } | null;

/** The one message every rejected Member Support write shows. */
export const MEMBER_SUPPORT_COMMIT_FAILURE = 'That change was not confirmed. Try again.';

export function successNotice(message: string): MemberSupportNotice {
  return message ? { message, tone: 'success' } : null;
}

export function failureNotice(message: string): MemberSupportNotice {
  return message ? { message, tone: 'error' } : null;
}

export function isFailureNotice(notice: MemberSupportNotice): boolean {
  return notice?.tone === 'error';
}

/**
 * Runs one Member Support write and reports the outcome with its notice. A
 * settled operation keeps the success tone; anything that throws — the write
 * itself, the preview update, or the workspace reload that follows it — is
 * reported as a failure so the destructive treatment renders.
 */
export async function settleMemberSupportCommit(
  operation: () => Promise<unknown>,
  success: string,
): Promise<{ ok: boolean; notice: MemberSupportNotice }> {
  try {
    await operation();
    return { ok: true, notice: successNotice(success) };
  } catch {
    return { ok: false, notice: failureNotice(MEMBER_SUPPORT_COMMIT_FAILURE) };
  }
}
