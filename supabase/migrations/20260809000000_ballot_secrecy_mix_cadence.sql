-- Ballot-secrecy mix cadence — findings on 3e2529075.
--
--   (R2-1) The nightly mixer left a fresh vote xmin-joinable to its receipt
--          for up to 24 hours. private.mix_recent_ballot_choices() targets
--          exactly the still-joinable rows — choices whose xmin matches any
--          receipt's xmin, i.e. rows still carrying their vote transaction —
--          and runs every 5 minutes. It is self-limiting: a rewritten row
--          takes the mixer's xmin, and the mixer writes no receipts, so it is
--          never selected again. The nightly full mix stays as the backstop
--          that periodically collapses everything to one shared value.
--   (R2-2) Every mix leaves dead predecessor tuples that still carry the old
--          xmins until vacuum. The table now runs effectively-always-on
--          autovacuum (zero scale factor, 50-row threshold, no cost delay),
--          so dead versions are destroyed within minutes rather than at the
--          default 20% churn threshold.
--
-- Threat-model boundary, stated plainly rather than papered over: a privileged
-- adversary CONTINUOUSLY observing the live database (statement logging,
-- logical decoding, tailing inserts as they commit) can capture the pairing at
-- cast time no matter what the schema does afterward — no post-hoc rewrite can
-- revoke an observation already made. The property this design delivers is
-- unlinkability of data at rest: someone who gains direct database access
-- cannot reconstruct who voted for what from what is stored — beyond, at
-- worst, the last few minutes of votes — and WAL/PITR/managed-backup history
-- ages out with retention. That boundary is recorded in the role-map record
-- UB-VOTE-04 alongside this migration.
--
-- db-contract co-edits in this commit: ballot-choices-mix-recent cron pin +
-- private.mix_recent_ballot_choices entry.

create function private.mix_recent_ballot_choices()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- xmin equality with a receipt row means "written in the same transaction
  -- as a receipt" — precisely the votes cast since the last mix. After one
  -- rewrite the row's xmin belongs to a receiptless mixer transaction and can
  -- never match again (xid reuse across wraparound epochs can produce a rare
  -- spurious match, which costs one pointless rewrite and nothing else).
  update public.member_ballot_choices c
  set ballot_id = c.ballot_id
  where c.xmin::text in (
    select r.xmin::text from public.member_ballot_receipts r);
end;
$$;

revoke all on function private.mix_recent_ballot_choices() from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    return;
  end if;
  execute 'create extension if not exists pg_cron';

  perform cron.unschedule(jobid) from cron.job where jobname = 'ballot-choices-mix-recent';
  perform cron.schedule(
    'ballot-choices-mix-recent',
    '*/5 * * * *',
    $job$ select private.mix_recent_ballot_choices(); $job$);
end
$$;

-- Dead predecessors of mixed rows keep the joinable xmins until vacuum;
-- make vacuum on this table effectively continuous. The table is ~100k
-- narrow rows — the cost is noise.
alter table public.member_ballot_choices set (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 50,
  autovacuum_vacuum_cost_delay = 0
);

-- Run the targeted mix once now for any votes cast since the full mix.
select private.mix_recent_ballot_choices();
