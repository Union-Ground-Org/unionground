// BUG-UG-VOTE-TURNOUT-READS-IMPOSSIBLE-20261106: "{votes} of {target}
// voted" read the quorum target as the number of eligible voters, so a vote
// past quorum showed "68 of 40 voted". The turnout line names the quorum
// instead: how many of the votes it needs, or that it was reached.
export function quorumTurnoutText(t, quorum) {
  const votes = Number(quorum?.totalVotes) || 0;
  const target = Number(quorum?.quorumTarget) || 0;
  return t(votes >= target ? "vp.turnoutQuorumReached" : "vp.turnoutVotesOf", { votes, target });
}
