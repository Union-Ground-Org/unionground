-- REQ-UG-CASEWORK-CONSOLE-57-CASE-SEARCH-20260917
--
-- Full-text case search. Until now the only case search in the product was
-- src/lib/searchIndex.js: a substring match over the member snapshot that
-- loadMemberApp had already fetched. That surface cannot find a case the
-- snapshot does not carry (a steward's assigned caseload, a coordinator's
-- chapter queue), it cannot match a stemmed word ("filing" against "filed"),
-- and it only sees the case-note bodies that rode along with the boot read.
--
-- Two GIN indexes over a weighted tsvector EXPRESSION give Postgres the index
-- it needs; public.search_member_cases is the one authenticated entry point
-- over them. No extension is installed: to_tsvector, websearch_to_tsquery and
-- ts_headline are core Postgres.
--
-- WHY AN EXPRESSION INDEX AND NOT A STORED GENERATED COLUMN. The first
-- revision of this migration added `search_document tsvector generated always
-- as (...) stored` to both case tables. That is the textbook shape and it is
-- wrong here, for two independent reasons.
--
--   1. It silently disables two BEFORE UPDATE triggers this schema already
--      carries. PostgreSQL computes a stored generated column AFTER the BEFORE
--      triggers have run, so inside such a trigger NEW.search_document is
--      always NULL while OLD.search_document holds the stored value. Both
--      private.guard_casework_restriction_update() and
--      private.touch_member_case_updated_at() (20260907150000) decide with a
--      whole-row comparison — `to_jsonb(new) - 'restricted_by'` against
--      `to_jsonb(old) - 'restricted_by'` — so the added column makes those rows
--      unconditionally distinct. The guard's nested-auth-detachment arm can
--      then never be reached and every `delete from auth.users` that detaches a
--      restricted case's attribution raises 42501 "restricted-case attribution
--      cannot be detached". tests/account-lifecycle-manifest-db.test.js proved
--      it on a disposable stack. Repairing the two guards instead would mean
--      teaching an account-lifecycle invariant about a search column and moving
--      their manifest md5 pins; the column is the thing that does not belong.
--   2. Adding a stored generated column to public.member_cases is a full table
--      rewrite under ACCESS EXCLUSIVE. This deployment sizes that table at
--      ~400k rows, so every reader — including loadMemberApp's boot read —
--      would block for the duration of the rewrite.
--
-- The expression index carries neither cost. It adds no column, so no BEFORE
-- trigger sees a new field and no whole-row comparison changes; and CREATE
-- INDEX takes only a SHARE lock, which blocks writers for the build but leaves
-- every reader running. See the rollout note above the two CREATE INDEX
-- statements.
--
-- WHY THE EXPRESSION IS INLINE AND NOT A HELPER FUNCTION. A single IMMUTABLE
-- helper would keep one definition of the document, but a user-defined function
-- inside an index expression is evaluated during index maintenance and
-- PostgreSQL checks EXECUTE on it as the WRITING role (ExecInitFunc runs for
-- the index expression state that FormIndexDatum evaluates). Verified on a
-- disposable stack: with the helper revoked, an ordinary `insert` as
-- `authenticated` fails with "permission denied for function". Every role that
-- writes member_cases or member_case_updates would therefore need an explicit
-- grant — authenticated, service_role, and whatever role performs the
-- auth.users delete whose ON DELETE SET NULL cascade updates member_cases —
-- and the db-contract sweep forbids the blanket PUBLIC grant that would make
-- that safe. Built-in functions carry no such hazard, so the document is
-- written out of pg_catalog built-ins on both sides. The index-driving copies
-- in public.search_member_cases are byte-identical to the two index
-- expressions apart from the `c.` / `u.` table alias, which changes the parse
-- tree not at all; tests/member-case-search-db.test.js pins that equality
-- statically and EXPLAINs the real statement to prove the planner takes both
-- index paths.
--
-- VISIBILITY, AND WHY IT IS SET-BASED RATHER THAN A PER-ROW PREDICATE. The RPC
-- is SECURITY DEFINER because it reads the GIN indexes on both tables in one
-- statement, so it must re-state the boundary that RLS would otherwise apply.
-- What it re-states is the exact disjunction of the three SELECT policies
-- installed on public.member_cases — member_cases_select_own (20260720191847),
-- member_cases_select_steward (20260808210000) and
-- member_cases_select_coordinator as last rewritten by 20260829001850 — ANDed
-- with the RESTRICTIVE mfa_assurance policy (20260724030000) that both case
-- tables carry: a caller who has not satisfied step-up can select no case at
-- all, so search must return none.
--
-- The first two revisions of this migration expressed that mirror as
-- private.member_case_visible_to_actor(public.member_cases), one function call
-- per candidate row. It was exactly equal to the policies and it did not work.
-- Measured on a disposable stack with an 80,000-case corpus and a term that
-- matches 8,001 of them: 1.4 s for the owner of the corpus, 44.5 s for a member
-- who owns one matching case, 75.7 s for an in-scope coordinator. The cost was
-- public.staff_can_see_user(c.user_id, 'coordinator') at ~3 ms per candidate,
-- evaluated for EVERY candidate even when the caller holds no coordinator hat,
-- plus private.has_organization_role per restricted candidate. Because
-- case_type carries weight B in the indexed document, the word a member is
-- most likely to type ("grievance") matches most of a ~400k-row deployment,
-- and the authenticated role carries statement_timeout = 8s: every such search
-- would have failed with 57014 after burning eight seconds of database CPU,
-- on every debounced keystroke.
--
-- Ranking and LIMITing the candidates BEFORE the visibility predicate is not
-- available as a repair. The limit is over the rows the caller may see, so
-- pruning first changes the answer: every candidate the predicate removes
-- would have to be refilled from the next-ranked candidate, and a caller who
-- can see one case out of 8,001 hits would get an empty page instead of that
-- case. A capped candidate arm with a "truncated" flag is the same contract
-- change in a different place. The repair is therefore to make the predicate
-- itself cheap, not to apply it to fewer rows.
--
-- So the mirror is now evaluated as a set, inside the one statement, and the
-- three policy branches are restated in the RPC's actor_scope / staff_visible /
-- visible CTEs rather than in a row function:
--
--   * actor_scope resolves everything that depends only on the caller EXACTLY
--     ONCE, in the statement's own snapshot (materialized, so the planner
--     cannot re-run it per row): private.mfa_satisfied(),
--     public.member_has_role(array['steward']), the caller's coordinator
--     chapter scope, private.current_mobile_staff_organization() with the
--     advisor/admin/vp grant on it, and the caller's live casework access
--     grants.
--   * staff_visible is member_cases_select_coordinator as a set: candidates
--     joined to the case owner's public.member_profiles row, kept when that
--     owner's chapter is in the caller's coordinator scope and the restriction
--     branch admits the case. No function is called per row.
--   * visible ORs the two column-only policies (own, steward) with a semijoin
--     against staff_visible. A caller with no coordinator scope never touches
--     public.member_profiles at all: the join carries a one-time
--     `coordinator_chapters <> '{}'` filter.
--
-- EQUALITY OF THE STAFF BRANCH. public.staff_can_see_user(t, r) is
--
--   t is not null and r is not null and auth.uid() is not null
--   and private.mfa_satisfied()
--   and exists (select 1
--                 from public.member_profiles target
--                 join public.chapters target_chapter
--                   on target_chapter.id = target.chapter_id
--                where target.id = t and P(target_chapter))
--
-- and every conjunct of P references target_chapter (or the caller) and
-- nothing else — the one apparent exception, `rc.chapter_id = target.chapter_id`
-- in its legacy arm, is `rc.chapter_id = target_chapter.id` by the join
-- condition itself. public.member_profiles.id and public.chapters.id are both
-- primary keys, so the EXISTS is satisfied by at most one (target,
-- target_chapter) pair. staff_can_see_user(t, r) is therefore, exactly,
--
--   exists (select 1 from public.member_profiles p
--            where p.id = t and p.chapter_id in private.staff_visible_chapter_scope(r))
--
-- where private.staff_visible_chapter_scope below is P lifted off the target:
-- the same FROM, the same guards and the same predicate, with `target.id = t`
-- and the public.member_profiles join removed and `target.chapter_id` written
-- as `target_chapter.id`. It is the same text otherwise, so a change to
-- staff_can_see_user still moves both at once — and
-- tests/member-case-search-db.test.js pins the SHA-256 of
-- public.staff_can_see_user's body as 20260822010000 wrote it, so a future
-- rewrite of that helper cannot silently leave this lift behind, and proves
-- the two forms agree for every actor and every profile in its fixture.
--
-- private.has_organization_role(p_case.organization_id, array['advisor','admin','vp'])
-- is hoisted the same way: the function returns false unless
-- p_case.organization_id is non-null and equal to
-- private.current_mobile_staff_organization(), so it equals
-- `organization_id is not null and organization_id = <that organization>
-- and private.has_organization_role(<that organization>, array[...])` with the
-- second factor resolved once. private.casework_actor_has_active_grant(id) is
-- `id = any(<the caller's unrevoked grants>)` by its own definition.
--
-- private.casework_can_read is deliberately NOT the predicate here even though
-- the MI1 casework suite reads through it, because it is not equal to
-- member_cases SELECT: its staff branch additionally requires
-- private.actor_has_chapter_staff_role and a non-null organization/chapter,
-- which is narrower than member_cases_select_steward for an assigned steward on
-- an unscoped case, and its steward branch does not carry the
-- public.member_has_role(array['steward']) test that embeds
-- private.mfa_satisfied(), which is WIDER than the policy for a steward who has
-- not completed step-up. Search must be neither: a result set that differs from
-- the caller's own `select ... from public.member_cases` in either direction is
-- a bug. tests/member-case-search-db.test.js proves the two sets are equal
-- row-for-row for an owner, an assigned steward, an in-scope coordinator, a
-- restricted-case coordinator, a granted coordinator and an unrelated member.
--
-- A case-note hit may surface its parent case, but only through a note the
-- caller can select: the lateral carries the exact disjunction of the three
-- public.member_case_updates SELECT policies, with the same two hoists — the
-- steward hat and the coordinator chapter scope come from actor_scope instead
-- of a call per note. The note predicate can never widen case visibility
-- because the case predicate is applied first, in the `visible` CTE the
-- lateral hangs off.
--
-- Finally, ts_headline is the other unbounded cost this revision removes: it is
-- the most expensive expression in the projection and the first two revisions
-- evaluated it for every visible candidate, because a projection is computed
-- before the ORDER BY sort. It now runs over the `ranked` CTE, so at most
-- p_limit (<= 50) snippets are ever built.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ROLLOUT. Neither statement below rewrites a table and neither takes ACCESS
-- EXCLUSIVE: an ordinary CREATE INDEX holds SHARE on its table, which blocks
-- INSERT/UPDATE/DELETE on that one table for the duration of the build and
-- blocks no reader at all. The builds cannot be CONCURRENTLY, because a
-- repository migration is required to be one transaction (BEGIN..COMMIT, see
-- docs/conventions/migration-naming.md and scripts/verify-repository-
-- conventions.mjs) and CREATE INDEX CONCURRENTLY cannot run inside one. Apply
-- in the nightly window and record the elapsed time; lock_timeout bounds the
-- wait for the SHARE lock and statement_timeout bounds each build, so a slow
-- apply rolls the whole migration back cleanly rather than holding the lock.
-- Pre-building both indexes CONCURRENTLY through the Management API first (as
-- 20260723160000 did for this same table) would need the CREATE INDEX lines to
-- become `if not exists`, which is a separate reviewed change, not something to
-- leave latent here.
--
-- Weighted so a reference or title hit outranks a body hit on the same query.
-- One configuration ('english') on both sides: a document built with a
-- different configuration than the query would silently stop matching stems.
create index member_cases_search_document_idx
  on public.member_cases using gin ((
    pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(reference, '')), 'A')
    || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(title, '')), 'A')
    || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(case_type, '')), 'B')
    || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(articles, '')), 'C')
  ));
create index member_case_updates_search_document_idx
  on public.member_case_updates using gin ((
    pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(body, ''))
  ));

comment on index public.member_cases_search_document_idx is
  'GIN over the english-configuration search document (reference/title weight A, case_type B, articles C) that public.search_member_cases restates verbatim. An expression index, not a stored generated column: a generated column is computed after BEFORE triggers, so it would make NEW and OLD unconditionally distinct inside private.guard_casework_restriction_update() and private.touch_member_case_updated_at(), and adding it would rewrite this ~400k-row table.';
comment on index public.member_case_updates_search_document_idx is
  'GIN over the english-configuration search document for the note body, restated verbatim by public.search_member_cases. Expression index for the same reason as member_cases_search_document_idx.';

-- public.staff_can_see_user(p_target, p_role) lifted off its target. Every
-- conjunct below is copied from that function's EXISTS body; the edits are
-- exactly four: `public.member_profiles target` and `target.id = p_target` are
-- gone; `target.chapter_id` is written `target_chapter.id`, which the dropped
-- join condition made equal; private.has_organization_role is called with the
-- caller-only expression the conjunct above it makes its argument equal to;
-- and one necessary condition (a role row for the caller in any of the three
-- role tables) is added ahead of the chapter scan. The CASE guards become
-- WHERE conjuncts, which is the same predicate. See the equality argument in
-- this file's header. Returning the scope once per statement is what removes
-- ~3 ms of per-candidate work from public.search_member_cases.
create or replace function private.staff_visible_chapter_scope(p_role text)
returns setof text
language sql
stable
security definer
set search_path = ''
as $function$
  select target_chapter.id
  from public.chapters target_chapter
  where (select auth.uid()) is not null
    and p_role is not null
    and (select private.mfa_satisfied())
    -- A necessary condition for EVERY branch below, hoisted so a caller who
    -- holds the hat nowhere never reads public.chapters at all. Each branch
    -- reaches p_role only through private.has_organization_role (a row in
    -- public.organization_role_grants), private.member_has_chapter_role (that
    -- same table, or a row in public.member_role_chapters), or the legacy
    -- public.member_roles arm, so an empty answer to all three is an empty
    -- scope. Adding a necessary condition narrows nothing; it is here because
    -- most callers hold no staff hat and this is three index probes against
    -- (user_id, role) primary keys instead of a scan of every chapter.
    and (select
          exists (
            select 1 from public.member_roles role_probe
            where role_probe.user_id = (select auth.uid()) and role_probe.role = p_role
          )
          or exists (
            select 1 from public.member_role_chapters chapter_probe
            where chapter_probe.user_id = (select auth.uid()) and chapter_probe.role = p_role
          )
          or exists (
            select 1 from public.organization_role_grants organization_probe
            where organization_probe.user_id = (select auth.uid()) and organization_probe.role = p_role
          ))
    and (
      (
        target_chapter.organization_id is not null
        and target_chapter.organization_id = (select private.current_member_organization())
        and (
          -- The conjunct immediately above makes target_chapter.organization_id
          -- and private.current_member_organization() the same value, so this
          -- is staff_can_see_user's call with its argument written as the
          -- caller-only expression it is equal to. That turns a call per
          -- chapter into one InitPlan for the statement.
          (select private.has_organization_role((select private.current_member_organization()), array[p_role]))
          or private.member_has_chapter_role(target_chapter.id, array[p_role])
        )
      )
      or (
        target_chapter.organization_id is null
        and (select private.current_member_organization()) is null
        and exists (
          select 1
          from public.member_profiles caller_profile
          left join public.chapters caller_chapter
            on caller_chapter.id = caller_profile.chapter_id
          where caller_profile.id = (select auth.uid())
            and (caller_chapter.id is null or caller_chapter.organization_id is null)
        )
        and (
          not (select private.staff_mfa_required())
          or (select private.has_second_factor((select auth.uid())))
        )
        and exists (
          select 1
          from public.member_roles r
          where r.user_id = (select auth.uid())
            and r.role = p_role
            and (
              r.chapter_id is null
              or exists (
                select 1
                from public.member_role_chapters rc
                join public.member_chapter_memberships m
                  on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
                join public.chapters mapped on mapped.id = rc.chapter_id
                where rc.user_id = r.user_id
                  and rc.role = r.role
                  and rc.chapter_id = target_chapter.id
                  and mapped.organization_id is null
                  and m.status = 'active'
              )
            )
        )
      )
    );
$function$;

revoke all on function private.staff_visible_chapter_scope(text)
  from public, anon, authenticated, service_role;

comment on function private.staff_visible_chapter_scope(text) is
  'public.staff_can_see_user lifted off its target: the set of chapter ids in which that function would admit a member to this caller, resolved once per statement instead of once per candidate row. staff_can_see_user(t, r) is exactly "t has a public.member_profiles row whose chapter_id is in this set", because every conjunct of its EXISTS body references the target only through the chapter it joins. Used by public.search_member_cases so a full-text search does not pay a staff-scope function call per candidate.';

create or replace function public.search_member_cases(p_query text, p_limit integer default 20)
returns table (
  case_id uuid,
  reference text,
  title text,
  case_type text,
  articles text,
  step text,
  status text,
  deadline date,
  updated_at timestamptz,
  rank real,
  headline text,
  headline_source text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_query tsquery := pg_catalog.websearch_to_tsquery(
    'pg_catalog.english'::pg_catalog.regconfig, coalesce(p_query, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_actor uuid := (select auth.uid());
begin
  -- An anonymous caller and an empty or stop-word-only query are the same
  -- answer: nothing. Returning early keeps both off the indexes entirely.
  -- Both tests read the request's JWT and the argument, never the database, so
  -- deciding them before the statement below costs the boundary nothing.
  if v_actor is null or pg_catalog.numnode(v_query) = 0 then
    return;
  end if;

  return query
  -- Everything that depends only on the caller, resolved exactly once, in this
  -- statement's snapshot — the same snapshot the row reads below use, which is
  -- what RLS gives the policies. MATERIALIZED is load-bearing: a single-row CTE
  -- referenced once would be inlined and these helpers would run per row again.
  with actor_scope as materialized (
    select
      -- mfa_assurance, the RESTRICTIVE policy both case tables carry. It ANDs
      -- over every permissive branch, so it gates the whole `visible` CTE.
      (select private.mfa_satisfied()) as mfa_satisfied,
      -- member_cases_select_steward's second conjunct.
      public.member_has_role(array['steward']) as steward_hat,
      -- public.staff_can_see_user(user_id, 'coordinator') as a set of chapters.
      array(select private.staff_visible_chapter_scope('coordinator')) as coordinator_chapters,
      -- private.has_organization_role(organization_id, array['advisor','admin','vp'])
      -- is false unless organization_id is this organization, so the grant test
      -- is a constant and the per-row test is a column comparison.
      (select private.current_mobile_staff_organization()) as staff_organization,
      coalesce((select private.has_organization_role(
        (select private.current_mobile_staff_organization()),
        array['advisor','admin','vp'])), false) as organization_officer,
      -- private.casework_actor_has_active_grant(id), as the set it tests.
      array(
        select g.case_id
        from public.casework_access_grants g
        where g.grantee_user_id = v_actor
          and g.revoked_at is null
      ) as granted_cases
  ),
  -- The candidate list is what makes the two GIN indexes load-bearing, and it
  -- is not a micro-optimisation. `<case document> @@ v_query OR note.body is
  -- not null` sits above a LEFT JOIN LATERAL, so the planner cannot push the
  -- case-side predicate into the scan: driving straight off public.member_cases
  -- reads EVERY row of a table this deployment sizes at ~400k and runs the
  -- lateral once per row. Selecting the candidate ids through the indexes first
  -- and joining back on the primary key returns the same set: the union is a
  -- superset of the final predicate, and every row it adds is re-tested below.
  --
  -- The two expressions in this CTE are the two index expressions verbatim,
  -- down to the argument order and the weight letters, because an expression
  -- index only serves a query whose expression matches it. Changing one without
  -- the other silently returns this statement to a sequential scan;
  -- tests/member-case-search-db.test.js pins the equality and EXPLAINs the
  -- statement cut out of this file.
  --
  -- Which arm matched is carried forward instead of recomputed: `case_hit` IS
  -- `<case document> @@ v_query` for that row, so the WHERE clause below needs
  -- no second evaluation of a four-call tsvector expression, and `note_hit` is
  -- false exactly when no note on the case can match, which turns the note
  -- lateral into a one-time filter for those rows.
  candidate_hits as (
    select c.id as candidate_id, true as case_hit, false as note_hit
    from public.member_cases c
    where (
      pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
      || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C')
    ) @@ v_query
    union all
    select u.case_id as candidate_id, false as case_hit, true as note_hit
    from public.member_case_updates u
    where (
      pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, ''))
    ) @@ v_query
  ),
  candidates as (
    select
      candidate_id,
      pg_catalog.bool_or(case_hit) as case_hit,
      pg_catalog.bool_or(note_hit) as note_hit
    from candidate_hits
    group by candidate_id
  ),
  -- member_cases_select_coordinator, as a set. No function call per row: the
  -- staff scope is the chapter array resolved once above, the organization
  -- officer test is a column comparison against the one organization
  -- private.has_organization_role can accept, and the access grant is an array
  -- membership test. A caller with no coordinator scope produces this set
  -- without reading public.member_profiles at all.
  --
  -- Every actor_scope value below is read through a scalar subquery rather
  -- than a join to the CTE, here and in the `visible` CTE and the note
  -- lateral. That is deliberate and load-bearing: an uncorrelated scalar
  -- subquery becomes an InitPlan the executor runs once, so each scope value
  -- reaches the row predicates as a constant. Joining actor_scope in instead
  -- makes those values ordinary columns, and the planner is then free to drive
  -- this join from public.member_profiles and re-derive the whole set per outer
  -- row: measured at 48,006 primary-key lookups over an 8,001-candidate
  -- corpus, and unbounded on a deployment where the caller's chapter scope
  -- holds thousands of members. The same rewrite turned the note lateral's
  -- author lookup from a rescan of public.member_profiles per note into one
  -- hashed probe for the statement.
  --
  -- `offset 0` is the optimisation fence explained above the same construct in
  -- the `visible` CTE below: it keeps the candidate list the driving relation
  -- so this CTE reads one case row per candidate and never scans the table.
  staff_visible as (
    select k.candidate_id
    from candidates k
    cross join lateral (
      select row_case.user_id, row_case.is_restricted, row_case.coordinator_user_id,
             row_case.organization_id, row_case.id
      from public.member_cases row_case
      where row_case.id = k.candidate_id
      offset 0
    ) c
    join public.member_profiles case_owner on case_owner.id = c.user_id
    where (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
      and case_owner.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
      and (
        not c.is_restricted
        or c.coordinator_user_id = v_actor
        or (
          c.organization_id is not null
          and c.organization_id = (select s.staff_organization from actor_scope s)
          and (select s.organization_officer from actor_scope s)
        )
        or c.id = any((select s.granted_cases from actor_scope s)::uuid[])
      )
  ),
  -- The mirror itself: mfa_assurance ANDed over the three permissive SELECT
  -- policies, the first two as column tests and the third as a semijoin.
  visible as (
    select
      k.case_hit,
      k.note_hit,
      c.id,
      c.reference,
      c.title,
      c.case_type,
      c.articles,
      c.step,
      c.status,
      c.deadline,
      c.updated_at,
      c.user_id,
      c.steward_user_id
    from candidates k
    cross join lateral (
      select
        row_case.id,
        row_case.reference,
        row_case.title,
        row_case.case_type,
        row_case.articles,
        row_case.step,
        row_case.status,
        row_case.deadline,
        row_case.updated_at,
        row_case.user_id,
        row_case.steward_user_id
      from public.member_cases row_case
      where row_case.id = k.candidate_id
      -- `offset 0` is the standard PostgreSQL optimisation fence, and it is
      -- load-bearing rather than decorative. Without it the planner flattens
      -- this LATERAL back into an ordinary join, and because a GIN @@
      -- selectivity estimate over a CTE defaults to 200 rows it then prices a
      -- sequential scan of the whole case table plus a hash join below this
      -- primary-key lookup: measured at 79,999 rows removed by filter for a
      -- query with ONE candidate. The fence keeps the candidate list the
      -- driving relation, so the work is one primary-key probe per candidate
      -- and nothing in this function ever reads a case row the two GIN indexes
      -- did not name.
      offset 0
    ) c
    -- mfa_assurance
    where (select s.mfa_satisfied from actor_scope s)
      and (
        -- member_cases_select_own
        c.user_id = v_actor
        -- member_cases_select_steward
        or (c.steward_user_id = v_actor and (select s.steward_hat from actor_scope s))
        -- member_cases_select_coordinator
        or c.id in (select candidate_id from staff_visible)
      )
  ),
  scored as (
    select
      c.id,
      c.reference,
      c.title,
      c.case_type,
      c.articles,
      c.step,
      c.status,
      c.deadline,
      c.updated_at,
      note.body as note_body,
      pg_catalog.ts_rank(
        pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.reference, '')), 'A')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.title, '')), 'A')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.case_type, '')), 'B')
        || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(c.articles, '')), 'C'),
        v_query)
        + coalesce(note.note_rank, 0) * 0.5 as rank_value
    from visible c
    left join lateral (
      select
        n.body,
        pg_catalog.ts_rank(n.note_document, v_query) as note_rank
      from (
        select
          u.body,
          u.user_id,
          u.created_at,
          u.id,
          pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, coalesce(u.body, '')) as note_document
        from public.member_case_updates u
        where c.note_hit
          and u.case_id = c.id
      ) n
      where n.note_document @@ v_query
        -- The exact disjunction of the three public.member_case_updates SELECT
        -- policies: _select_own (20260720191847), _select_steward (20260808210000)
        -- and _select_coordinator (20260723160000), with the steward hat and the
        -- coordinator staff scope read from actor_scope instead of called per
        -- note. A note the caller cannot read contributes neither the headline
        -- nor the match. The notes table's own restrictive mfa_assurance policy
        -- needs no repetition here: the `visible` CTE this lateral hangs off
        -- already refuses every row without step-up.
        and (
          (n.user_id = v_actor and c.user_id = v_actor)
          or ((select s.steward_hat from actor_scope s) and c.steward_user_id = v_actor)
          or (
            (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
            and exists (
              select 1
              from public.member_profiles note_author
              where note_author.id = n.user_id
                and note_author.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
            )
          )
        )
      order by note_rank desc, n.created_at desc, n.id
      limit 1
    ) note on true
    -- `case_hit` is the case-document match the candidate CTE already made.
    where c.case_hit or note.body is not null
  ),
  -- Rank and cut FIRST, then build the snippets. ts_headline is by far the most
  -- expensive expression in this function and a projection is evaluated before
  -- the sort, so leaving it in `scored` would have built one snippet per
  -- visible candidate instead of at most p_limit of them.
  ranked as (
    select r.*
    from scored r
    order by r.rank_value desc, r.updated_at desc, r.id
    limit v_limit
  )
  select
    r.id,
    r.reference,
    r.title,
    r.case_type,
    r.articles,
    r.step,
    r.status,
    r.deadline,
    r.updated_at,
    r.rank_value::real,
    pg_catalog.ts_headline(
      'pg_catalog.english'::pg_catalog.regconfig,
      case
        when r.note_body is not null then r.note_body
        when coalesce(r.articles, '') <> '' then r.articles
        else r.title
      end,
      v_query,
      'StartSel="[[",StopSel="]]",MaxFragments=1,MaxWords=28,MinWords=8,ShortWord=2'),
    case
      when r.note_body is not null then 'update'
      when coalesce(r.articles, '') <> '' then 'articles'
      else 'title'
    end
  from ranked r
  order by r.rank_value desc, r.updated_at desc, r.id;
end;
$function$;

revoke all on function public.search_member_cases(text, integer) from public, anon, service_role;
grant execute on function public.search_member_cases(text, integer) to authenticated;

comment on function public.search_member_cases(text, integer) is
  'Ranked full-text search over the cases the caller can already select, with a ts_headline snippet drawn from the best matching visible case note, the articles line, or the title. Visibility is the exact mirror of the three member_cases SELECT policies ANDed with the restrictive mfa_assurance policy, evaluated as a set: actor_scope resolves the caller''s step-up, steward hat, coordinator chapter scope, organization officer grant and casework access grants once per statement, and staff_visible is member_cases_select_coordinator as a semijoin, so no visibility function runs per candidate row. Case notes are filtered by the member_case_updates SELECT policies with the same hoists. p_limit is clamped to 1..50 and ts_headline runs only over the ranked page. The candidate CTE restates the two GIN expression indexes verbatim; changing one without the other returns this statement to a sequential scan.';

commit;
