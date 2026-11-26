-- DEBT-UG-LIVE-POLL-OPTION-ORG-POLICY-TAUTOLOGY-20260921
--
-- organization_live_poll_options_member_read (20260828034122) meant to check
-- that an option row belongs to the same organization as its poll, but wrote
-- the clause unqualified inside the subquery:
--
--     where p.id = poll_id and p.organization_id = organization_id ...
--
-- In that scope the bare organization_id resolves to the innermost relation,
-- organization_live_polls p, so the clause read p.organization_id =
-- p.organization_id and was always true. poll_id is what carries the
-- organization, so nothing leaks today, but the cross-check the policy appears
-- to make was dead code.
--
-- Qualify it against the option row. The command, the role and every other
-- conjunct are unchanged, so the admitted set is unchanged for every option
-- whose organization matches its poll. An option whose organization disagrees
-- with its poll is no longer readable through this policy.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter policy organization_live_poll_options_member_read on public.organization_live_poll_options
  using (
    exists (
      select 1 from public.organization_live_polls p
      where p.id = organization_live_poll_options.poll_id
        and p.organization_id = organization_live_poll_options.organization_id
        and private.is_organization_member(p.organization_id)
        and (p.chapter_id is null or p.chapter_id = private.current_member_chapter())
    )
  );

comment on policy organization_live_poll_options_member_read on public.organization_live_poll_options is
  'A member reads an option only through its poll: the poll must be in an organization the caller belongs to and in their chapter or organization-wide, and the option row''s own organization must equal the poll''s. Both columns are qualified; the unqualified 20260828034122 clause compared the poll''s organization with itself.';

notify pgrst, 'reload schema';

commit;
