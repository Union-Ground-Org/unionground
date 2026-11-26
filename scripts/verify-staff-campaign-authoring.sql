\set ON_ERROR_STOP on

-- UB-VOTE-01 rollback-only local proof. The migration and every fixture live
-- inside one transaction, so this can run repeatedly without catalog or data
-- residue. Run from the repository root with psql -f.
begin;
\ir ../supabase/migrations/20260812140000_staff_campaign_authoring.sql

-- Live publication gate (20260925030300). That later file wraps BEGIN/COMMIT,
-- which would end this rollback-only transaction, so the same get_ballot_tally
-- body is installed here. Sweep/stamp repairs and the draft/open-past/staff-
-- closed lifecycle run in tests/ballot-results-publication-gate-db.test.js
-- against an already-migrated disposable catalog.
create or replace function public.get_ballot_tally(p_ballot_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  ballot record;
  total integer;
  option_counts jsonb;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select id, title, closes_at, active, quorum_target, campaign_state into ballot
  from public.member_ballots
  where id = p_ballot_id and campaign_state <> 'draft'
    and (chapter_id is null or chapter_id = private.current_member_chapter());
  if not found then raise exception 'ballot not found' using errcode = '22023'; end if;
  select count(*) into total from public.member_ballot_choices where ballot_id = ballot.id;
  if not ballot.active or ballot.closes_at <= now() then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'optionId', counts.option_id, 'label', counts.label, 'labelEs', counts.label_es,
      'votes', counts.votes) order by counts.order_index), '[]'::jsonb)
    into option_counts
    from (
      select options.id as option_id, options.label, options.label_es, options.order_index,
        count(choices.option_id) as votes
      from public.member_ballot_options options
      left join public.member_ballot_choices choices
        on choices.ballot_id = options.ballot_id and choices.option_id = options.id
      where options.ballot_id = ballot.id
      group by options.id, options.label, options.label_es, options.order_index
    ) counts;
  end if;
  return pg_catalog.jsonb_build_object('ballotId', ballot.id, 'totalVotes', total,
    'quorumTarget', ballot.quorum_target, 'closesAt', ballot.closes_at,
    'active', ballot.active, 'options', option_counts);
end;
$function$;

insert into auth.users (id) values
  ('a901cb01-1111-4111-8111-111111111111'),
  ('a902cb02-2222-4222-8222-222222222222'),
  ('a903cb03-3333-4333-8333-333333333333'),
  ('a904cb04-4444-4444-8444-444444444444'),
  ('a905cb05-5555-4555-8555-555555555555'),
  ('a906cb06-6666-4666-8666-666666666666');

update public.member_profiles p
set first_name = fixture.first_name, full_name = fixture.full_name,
    initials = fixture.initials, role_line = fixture.role_line,
    chapter_id = fixture.chapter_id
from (values
  ('a901cb01-1111-4111-8111-111111111111'::uuid, 'Staff', 'Worcester staff', 'WS', 'Staff', 'wor'),
  ('a902cb02-2222-4222-8222-222222222222'::uuid, 'Member', 'Worcester member', 'WM', 'Member', 'wor'),
  ('a903cb03-3333-4333-8333-333333333333'::uuid, 'Member', 'Boston member', 'BM', 'Member', 'bos'),
  ('a904cb04-4444-4444-8444-444444444444'::uuid, 'Admin', 'Union admin', 'UA', 'Admin', 'wor'),
  ('a905cb05-5555-4555-8555-555555555555'::uuid, 'Staff', 'Wrong-scope staff', 'XS', 'Staff', 'wor'),
  ('a906cb06-6666-4666-8666-666666666666'::uuid, 'Admin', 'Chapter admin', 'CA', 'Admin', 'wor')
) as fixture(id, first_name, full_name, initials, role_line, chapter_id)
where p.id = fixture.id;

insert into public.member_roles (user_id, role, chapter_id) values
  ('a901cb01-1111-4111-8111-111111111111', 'steward', 'wor'),
  ('a904cb04-4444-4444-8444-444444444444', 'admin', null),
  ('a905cb05-5555-4555-8555-555555555555', 'steward', 'bos'),
  ('a906cb06-6666-4666-8666-666666666666', 'admin', 'wor');

-- Enrolled staff must step up. This factor makes the aal1 refusal observable.
insert into auth.mfa_factors
  (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values
  ('a907cb07-7777-4777-8777-777777777777',
   'a901cb01-1111-4111-8111-111111111111', 'proof factor', 'totp', 'verified', now(), now());

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a901cb01-1111-4111-8111-111111111111","role":"authenticated","aal":"aal1"}', true);
do $$
begin
  perform public.get_staff_vote_campaigns();
  raise exception 'aal1 staff unexpectedly passed the campaign boundary';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- An ordinary member cannot list or author; the failed call mutates nothing.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a902cb02-2222-4222-8222-222222222222","role":"authenticated","aal":"aal2"}', true);
do $$
begin
  perform public.save_vote_campaign_draft(
    'ballot', null, 'chapter', 'Member attempt', 'Intento de miembro', now() + interval '2 days', 2,
    '', '', '[{"labelEn":"Yes","labelEs":"Sí"},{"labelEn":"No","labelEs":"No"}]'::jsonb);
  raise exception 'ordinary member unexpectedly authored a campaign';
exception when insufficient_privilege then null;
end
$$;
reset role;
do $$ begin
  if exists (select 1 from public.member_ballots where title = 'Member attempt') then
    raise exception 'refused member call mutated ballots';
  end if;
end $$;

-- A role grant for another chapter cannot be used against the caller's own
-- member chapter, and the caller cannot supply a different target id at all.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a905cb05-5555-4555-8555-555555555555","role":"authenticated","aal":"aal2"}', true);
do $$
begin
  perform public.save_vote_campaign_draft(
    'pulse', null, 'chapter', 'Wrong scope', 'Ámbito incorrecto', now() + interval '2 days', null,
    '', '', '[{"labelEn":"One","labelEs":"Uno"},{"labelEn":"Two","labelEs":"Dos"}]'::jsonb);
  raise exception 'cross-chapter role unexpectedly authored a campaign';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- A chapter-scoped admin is still not an org-wide admin.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a906cb06-6666-4666-8666-666666666666","role":"authenticated","aal":"aal2"}', true);
do $$
begin
  perform public.save_vote_campaign_draft(
    'pulse', null, 'union', 'Union attempt', 'Intento sindical', now() + interval '2 days', null,
    '', '', '[{"labelEn":"One","labelEs":"Uno"},{"labelEn":"Two","labelEs":"Dos"}]'::jsonb);
  raise exception 'chapter admin unexpectedly authored union-wide content';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- A stepped-up Worcester steward can create and revise only a draft.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a901cb01-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}', true);
select public.save_vote_campaign_draft(
  'ballot', null, 'chapter', 'Contract proposal', 'Propuesta de contrato', now() + interval '2 days', 2,
  'Review the proposal.', 'Revise la propuesta.',
  '[{"labelEn":"Approve","labelEs":"Aprobar"},{"labelEn":"Reject","labelEs":"Rechazar"}]'::jsonb
)->>'id' as ballot_id \gset
select set_config('proof.ballot_id', :'ballot_id', true);
select public.save_vote_campaign_draft(
  'ballot', :'ballot_id', 'chapter', 'Contract proposal — final', 'Propuesta de contrato — final',
  now() + interval '2 days', 2, 'Review the final proposal.', 'Revise la propuesta final.',
  '[{"labelEn":"Approve","labelEs":"Aprobar"},{"labelEn":"Reject","labelEs":"Rechazar"}]'::jsonb
);
select public.publish_vote_campaign('ballot', :'ballot_id');
do $$
begin
  perform public.save_vote_campaign_draft(
    'ballot', current_setting('proof.ballot_id'), 'chapter', 'Changed after publish', 'Cambio después de publicar',
    now() + interval '3 days', 2, '', '',
    '[{"labelEn":"Approve","labelEs":"Aprobar"},{"labelEn":"Reject","labelEs":"Rechazar"}]'::jsonb);
  raise exception 'published content unexpectedly remained mutable';
exception when invalid_parameter_value then null;
end
$$;
reset role;

-- Published chapter content is readable only in the eligible member chapter.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a902cb02-2222-4222-8222-222222222222","role":"authenticated","aal":"aal2"}', true);
do $$ begin
  if (select count(*) from public.member_ballots where id = current_setting('proof.ballot_id')) <> 1 then
    raise exception 'eligible member cannot read published ballot';
  end if;
  if (public.get_ballot_tally(current_setting('proof.ballot_id'))->'options') <> 'null'::jsonb then
    raise exception 'open ballot released result options';
  end if;
end $$;
select id as option_id from public.member_ballot_options
where ballot_id = :'ballot_id' order by order_index limit 1 \gset
select set_config('proof.option_id', :'option_id', true);
select public.submit_ballot_vote(:'ballot_id', :'option_id');
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a903cb03-3333-4333-8333-333333333333","role":"authenticated","aal":"aal2"}', true);
do $$
begin
  if exists (select 1 from public.member_ballots where id = current_setting('proof.ballot_id')) then
    raise exception 'cross-chapter member read a chapter ballot';
  end if;
  perform public.submit_ballot_vote(current_setting('proof.ballot_id'), current_setting('proof.option_id'));
  raise exception 'cross-chapter member unexpectedly voted';
exception when invalid_parameter_value then null;
end
$$;
reset role;
do $$ begin
  if (select count(*) from public.member_ballot_choices where ballot_id = current_setting('proof.ballot_id')) <> 1 then
    raise exception 'refused cross-chapter vote mutated voterless choices';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'member_ballot_choices'
      and column_name in ('user_id', 'member_id', 'voter_id')) then
    raise exception 'ballot choice store contains voter identity';
  end if;
end $$;

-- Time elapsed while the lifecycle row remains open publishes results.
-- Staff close is no longer the publication gate (20260925030300).
update public.member_ballots
set closes_at = now() - interval '1 minute'
where id = current_setting('proof.ballot_id');
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a902cb02-2222-4222-8222-222222222222","role":"authenticated","aal":"aal2"}', true);
do $$ begin
  if jsonb_array_length(public.get_ballot_tally(current_setting('proof.ballot_id'))->'options') <> 2 then
    raise exception 'elapsed open ballot did not publish option totals';
  end if;
end $$;
reset role;

-- Explicit staff close still publishes, and counts remain readable after close.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a901cb01-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}', true);
select public.close_vote_campaign('ballot', :'ballot_id');
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a902cb02-2222-4222-8222-222222222222","role":"authenticated","aal":"aal2"}', true);
do $$ begin
  if jsonb_array_length(public.get_ballot_tally(current_setting('proof.ballot_id'))->'options') <> 2 then
    raise exception 'closed eligible ballot did not release option totals';
  end if;
end $$;
reset role;

-- Only an org-wide admin/vp may author union-wide; pulses carry no quorum.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a904cb04-4444-4444-8444-444444444444","role":"authenticated","aal":"aal2"}', true);
select public.save_vote_campaign_draft(
  'pulse', null, 'union', 'Union pulse', 'Pulso sindical', now() + interval '2 days', null,
  'Choose one.', 'Elija una.',
  '[{"labelEn":"Ready","labelEs":"Listo"},{"labelEn":"Need time","labelEs":"Necesito tiempo"}]'::jsonb
)->>'id' as pulse_id \gset
select set_config('proof.pulse_id', :'pulse_id', true);
select public.publish_vote_campaign('pulse', :'pulse_id');
select public.close_vote_campaign('pulse', :'pulse_id');
reset role;

do $$
begin
  if (select count(*) from public.member_admin_audit
      where detail->>'campaignId' in (current_setting('proof.ballot_id'), current_setting('proof.pulse_id'))) <> 7 then
    raise exception 'effective campaign transitions were not audited exactly';
  end if;
  if has_table_privilege('authenticated', 'public.member_ballots', 'insert')
     or has_table_privilege('authenticated', 'public.member_ballots', 'update')
     or has_table_privilege('authenticated', 'public.member_ballots', 'delete')
     or has_table_privilege('authenticated', 'public.member_ballot_options', 'insert')
     or has_table_privilege('authenticated', 'public.member_surveys', 'insert')
     or has_table_privilege('authenticated', 'public.member_survey_options', 'insert') then
    raise exception 'authenticated retained direct campaign DML';
  end if;
  if has_table_privilege('authenticated', 'public.member_ballots', 'select')
     or has_table_privilege('authenticated', 'public.member_surveys', 'select') then
    raise exception 'authenticated retained table-wide campaign SELECT';
  end if;
  if has_column_privilege('authenticated', 'public.member_ballots', 'created_by', 'select')
     or has_column_privilege('authenticated', 'public.member_surveys', 'created_by', 'select') then
    raise exception 'member catalog exposed campaign authorship';
  end if;
  if not has_column_privilege('authenticated', 'public.member_ballots', 'title', 'select')
     or not has_column_privilege('authenticated', 'public.member_surveys', 'title', 'select') then
    raise exception 'member catalog lost required safe columns';
  end if;
end
$$;

\echo 'UB-VOTE-01 rollback-only proof passed'
rollback;
