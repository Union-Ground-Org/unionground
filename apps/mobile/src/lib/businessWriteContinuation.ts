import type { MobileSessionWriter } from '../services/supabase';

export const BUSINESS_SAVED_STALE = 'The change was saved. Reopen this screen to see it.';
export type BusinessProof = 'current' | 'changed' | 'unavailable';

// Auth proof and a screen's own lifetime are independent. Recheck the latter
// after Auth's await, immediately before any shared read or navigation.
export async function checkBusinessContinuation(writer: Pick<MobileSessionWriter, 'check'>, current: () => boolean = () => true): Promise<BusinessProof> {
  if (!current()) return 'changed';
  let proof: BusinessProof;
  try { proof = await writer.check(); }
  catch { proof = 'unavailable'; }
  return current() ? proof : 'changed';
}

// A server acknowledgement survives unavailable Auth proof. Only a replaced
// account/scope discards it; only current proof permits shared-client reads.
// accepted owns local receipts and retry identity, never a shared reread.
export async function settleBusinessWrite(writer: Pick<MobileSessionWriter, 'check'>, options: {
  current?: () => boolean;
  accepted: (proof: 'current' | 'unavailable') => void;
  stale: () => void;
  refresh?: () => void | Promise<unknown>;
}): Promise<BusinessProof> {
  const proof = await checkBusinessContinuation(writer, options.current);
  if (proof === 'changed') return proof;
  options.accepted(proof);
  if (proof === 'unavailable') options.stale();
  else {
    try {
      const refreshed = await options.refresh?.();
      if (options.current?.() === false) return 'changed';
      if (refreshed === false) {
        options.stale();
        return 'unavailable';
      }
    } catch {
      if (options.current?.() === false) return 'changed';
      options.stale();
      return 'unavailable';
    }
  }
  return proof;
}
