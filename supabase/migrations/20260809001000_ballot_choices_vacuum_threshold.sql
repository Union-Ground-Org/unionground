-- With autovacuum_vacuum_threshold = 50,
-- a final mixed batch of 1-49 rows leaves its dead predecessor tuples — which
-- still carry the vote-transaction xmins — unvacuumed until later churn or
-- the nightly full mix. Threshold 1: any dead tuple on this table triggers
-- vacuum at the next autovacuum naptime (~1 minute), making "destroyed within
-- minutes" actually true for every batch size.

alter table public.member_ballot_choices set (
  autovacuum_vacuum_threshold = 1
);
