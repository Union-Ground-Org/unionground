// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103 (audit P0
// MOB-COORDINATOR-04): the Voting screen called the ballot secret beside a
// sentence saying choices were recorded on the member record. What the ballot
// service stores, read from submit_ballot_vote and
// 20260808230000_ballot_secrecy_unlinkable_votes.sql:
//
//   * public.member_ballot_choices holds one row per cast ballot with the
//     ballot, the option and a random id. It has no member id and no time, and
//     no client role can read it; only the tally aggregates it.
//   * public.member_ballot_receipts holds the member, the ballot, the receipt
//     code and when it was issued. It proves that the member voted, never how,
//     and its (ballot, member) key is why a vote is final.
//
// Each sentence below states only that. Change them only with the storage.

export const BALLOT_STORAGE_SENTENCE = 'Secret vote. Your choice is stored without your name, worker ID or the time you voted. Your worker record keeps only a dated receipt that shows you voted, never how. Votes are final.';

export const BALLOT_RECEIPT_SENTENCE = 'Your choice is not stored with your name. The receipt shows that you voted, not how.';

export const BALLOT_FINAL_HINT = 'Your choice stays on this screen until you cast it. You confirm before anything is sent.';

export type BallotCastConfirmation = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
};

// The confirmation names the voter's own choice on the voter's own screen,
// which is the one place it may appear: it is never announced, logged or sent
// anywhere but the cast itself.
export function ballotCastConfirmation(choiceLabel: string): BallotCastConfirmation {
  return {
    title: 'Cast your vote?',
    body: `You are voting: ${choiceLabel}. You can't change your vote after you cast it.`,
    confirmLabel: 'Cast vote',
    cancelLabel: 'Go back',
  };
}
