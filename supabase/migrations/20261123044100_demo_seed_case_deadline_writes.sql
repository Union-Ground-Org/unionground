-- BUG-UG-TAMARACK-DEMO-MEMBER-DEADLINE-AGES-DAILY-AND-MEETING-WEEKDAY-WRONG-20261122 (#9610)
--
-- The demo seed refresh (scripts/tamarack/demo-seed-maintenance.mjs,
-- renewCaseDeadlines) moves an open Tamarack history case's own deadline
-- forward from each refresh, but only while it can prove that the current
-- date is one the seed wrote. This table is that proof: one row per case
-- holding the exact deadline the seed's last committed write left on it.
-- It is written only by the refresh's own UPDATE ... RETURNING, in the same
-- statement, and by the one-time, signed adopt step of the L210 receipt.
--
-- Nobody else reads or writes it: row security is on with no policy, every
-- client role is revoked, and there is no reader function. On every database
-- but SAMPLE it stays empty (the seed bot refuses every target but a local
-- disposable stack and the bound SAMPLE installation). A row goes with its
-- case (cascade), and joins the case-graph locking protocol like every other
-- child of public.member_cases.
begin;
set local lock_timeout = '5s';

create table private.demo_seed_case_deadline_writes (
  case_id uuid primary key references public.member_cases(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  deadline date not null,
  run_clock timestamptz not null,
  written_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table private.demo_seed_case_deadline_writes enable row level security;
revoke all on table private.demo_seed_case_deadline_writes from public, anon, authenticated, service_role;

-- Join the established account/case locking protocol, including FK actions.
create trigger a00_case_graph_lock before insert or update or delete on private.demo_seed_case_deadline_writes
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.demo_seed_case_deadline_writes
for each row execute function private.lock_case_graph_row_keys('', '{case_id}');
-- The two lock triggers sit below a reviewed cascade from public.member_cases.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
where schema_name='private' and table_name='demo_seed_case_deadline_writes'
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;

insert into private.account_lifecycle_transitive_fk_manifest
  (parent_schema_name, parent_table_name, schema_name, table_name, constraint_name,
   delete_disposition, review_reason)
values
  ('public', 'member_cases', 'private', 'demo_seed_case_deadline_writes',
   'demo_seed_case_deadline_writes_case_id_fkey', 'cascade',
   'A seed-only proof of the deadline the demo refresh last wrote; it lives exactly as long as its case and holds no personal data.');

commit;
