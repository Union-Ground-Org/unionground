-- Civic advocacy layer: bills, roll calls and votes (worker-written reference
-- data), campaigns, member messages and union ratings (member/officer data),
-- and the read views members and officers use.
--
-- Ported from civic-data-resolver migrations/005_advocacy.sql. The one type
-- change from the source: org_id is the host chapter, so it is text holding a
-- public.chapters.id value instead of a uuid. It carries no foreign key for
-- the same reason public.member_saved_views declines one: public.chapters is
-- a case-graph relation, and a reference to it would put every civic writer
-- behind private.lock_case_graph(). Rows are only reachable through the
-- membership/officer seam in 20260922210200, which joins public.chapters, so
-- a row naming a chapter that does not exist is inert.
--
-- People are keyed by a stable official_key ('bioguide:A000370',
-- 'openstates:ocd-person/...', 'local:<uuid>'), never civic_officials.id.
--
-- RLS is enabled here with only the restrictive mfa_assurance floor, so every
-- table starts service_role only. Member and officer policies, column grants
-- and view grants are added in 20260922210200_civic_member_app.sql.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Bills the union cares about. Only tracked bills are refreshed.
create table public.civic_bills (
  bill_key text primary key,
  jurisdiction text not null,
  session text not null,
  identifier text not null,
  title text not null,
  summary text,
  policy_area text,
  status text not null default 'introduced'
    check (status in ('introduced', 'passed_one_chamber', 'passed_both',
                      'enacted', 'vetoed', 'failed', 'died')),
  law_number text,
  latest_action text,
  latest_action_date date,
  source_url text,
  tracked boolean not null default true,
  source text not null,
  source_retrieved_at timestamptz not null
);

create table public.civic_roll_calls (
  roll_call_key text primary key,
  bill_key text not null references public.civic_bills(bill_key) on delete cascade,
  chamber text not null check (chamber in ('house', 'senate', 'upper', 'lower')),
  voted_at timestamptz not null,
  question text,
  result text,
  -- Derived from the bill's action text; passage_override lets an officer
  -- correct it and is never touched by a refresh.
  is_passage boolean not null default false,
  passage_override boolean,
  source_url text not null,
  source text not null,
  source_retrieved_at timestamptz not null
);

create index civic_roll_calls_bill_idx on public.civic_roll_calls (bill_key, chamber, voted_at);

-- Every member of the chamber, not just officials we currently hold.
create table public.civic_official_votes (
  roll_call_key text not null references public.civic_roll_calls(roll_call_key) on delete cascade,
  voter_key text not null,
  position text not null check (position in ('yea', 'nay', 'present', 'not_voting')),
  voter_name text,
  party text,
  state text,
  primary key (roll_call_key, voter_key)
);

create index civic_official_votes_voter_idx on public.civic_official_votes (voter_key);

-- A chapter's call to action.
create table public.civic_campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  title text not null,
  topic text not null,
  summary text,
  talking_points jsonb not null default '[]',
  bill_key text references public.civic_bills(bill_key),
  union_position text check (union_position in ('support', 'oppose')),
  target_offices text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'active', 'closed')),
  opens_at timestamptz,
  closes_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A position without a bill cannot be scored; a bill without a position cannot either.
  check ((bill_key is null) = (union_position is null))
);

create index civic_campaigns_org_idx on public.civic_campaigns (org_id, status);

-- One message per member per official per campaign. The body is the member's
-- own political speech: readable by that member only. Officers see counts
-- through public.civic_campaign_stats_for_org, never rows.
create table public.civic_member_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.civic_campaigns(id) on delete cascade,
  user_id uuid not null,
  official_key text not null,
  official_name text not null,
  office text not null,
  channel text not null check (channel in ('email', 'contact_form', 'phone', 'letter')),
  status text not null default 'drafted' check (status in ('drafted', 'sent', 'abandoned')),
  subject text,
  body text,
  -- Shingle fingerprint of the body; the drafter rejects a draft too close to
  -- any other in the campaign so officials never receive form letters.
  body_fingerprint text,
  drafted_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (campaign_id, user_id, official_key)
);

create index civic_member_messages_user_idx on public.civic_member_messages (user_id);

-- The chapter's election-time report card.
create table public.civic_official_ratings (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  official_key text not null,
  official_name text not null,
  office text not null,
  cycle text not null,
  grade text not null check (grade in ('A', 'B', 'C', 'D', 'F')),
  endorsed boolean not null default false,
  rationale text,
  published boolean not null default false,
  rated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, official_key, cycle)
);

-- ---------------------------------------------------------------------------
-- Read surface. Every view runs as the caller (security_invoker), so the
-- table policies are never bypassed through a view.
-- ---------------------------------------------------------------------------

-- civic_member_officials plus the person key everything above joins on.
create view public.civic_member_officials_keyed
with (security_invoker = on) as
select mo.*,
       coalesce('bioguide:' || nullif(mo.external_ids->>'bioguide', ''),
                'openstates:' || nullif(mo.external_ids->>'openstates', '')) as official_key
from public.civic_member_officials mo;

-- The vote that decided each bill in each chamber: the latest passage roll call.
create view public.civic_bill_deciding_votes
with (security_invoker = on) as
select distinct on (bill_key, chamber)
       bill_key, chamber, roll_call_key, voted_at, question, result, source_url
from public.civic_roll_calls
where coalesce(passage_override, is_passage)
order by bill_key, chamber, voted_at desc;

-- How a person voted on each scored campaign, from the union's point of view.
create view public.civic_campaign_official_votes
with (security_invoker = on) as
select c.id as campaign_id,
       c.org_id,
       c.bill_key,
       c.union_position,
       v.voter_key as official_key,
       dv.roll_call_key,
       dv.voted_at,
       dv.question,
       dv.result as roll_call_result,
       dv.source_url as roll_call_url,
       v.position,
       case
         when v.position in ('present', 'not_voting') then null
         else (v.position = 'yea') = (c.union_position = 'support')
       end as voted_with_union
from public.civic_campaigns c
join public.civic_bill_deciding_votes dv on dv.bill_key = c.bill_key
join public.civic_official_votes v on v.roll_call_key = dv.roll_call_key
where c.bill_key is not null;

-- "What came of my message": one row per message with the official's vote
-- and the bill's fate.
create view public.civic_member_message_outcomes
with (security_invoker = on) as
select m.id as message_id,
       m.user_id,
       m.campaign_id,
       c.title as campaign_title,
       c.topic,
       c.union_position,
       m.official_key,
       m.official_name,
       m.office,
       m.channel,
       m.status as message_status,
       m.sent_at,
       b.bill_key,
       b.identifier as bill_identifier,
       b.title as bill_title,
       b.status as bill_status,
       b.law_number,
       b.latest_action,
       b.latest_action_date,
       cv.position as vote_position,
       cv.voted_at,
       cv.roll_call_url,
       cv.voted_with_union,
       (cv.voted_at is not null and m.sent_at is not null and m.sent_at < cv.voted_at) as sent_before_vote,
       case
         when b.bill_key is null then null
         when b.status = 'enacted' then case c.union_position when 'support' then 'won' else 'lost' end
         when b.status in ('vetoed', 'failed', 'died') then case c.union_position when 'oppose' then 'won' else 'lost' end
         else 'pending'
       end as outcome_for_union
from public.civic_member_messages m
join public.civic_campaigns c on c.id = m.campaign_id
left join public.civic_bills b on b.bill_key = c.bill_key
left join public.civic_campaign_official_votes cv
       on cv.campaign_id = c.id and cv.official_key = m.official_key;

-- The evidence behind a grade: how often each person voted with this chapter.
create view public.civic_official_alignment
with (security_invoker = on) as
select org_id,
       official_key,
       count(*) filter (where voted_with_union) as votes_with_union,
       count(*) filter (where voted_with_union = false) as votes_against_union,
       count(*) filter (where voted_with_union is null) as votes_missed,
       count(*) as votes_scored,
       round(100.0 * count(*) filter (where voted_with_union)
             / nullif(count(*) filter (where voted_with_union is not null), 0))::integer as alignment_pct
from public.civic_campaign_official_votes
group by org_id, official_key;

-- Election-time screen: my officials, my chapter's published grade, the record.
create view public.civic_member_official_ratings
with (security_invoker = on) as
select mo.user_id,
       r.org_id,
       mo.official_key,
       mo.full_name,
       mo.office,
       mo.party,
       mo.term_end,
       mo.level_rank,
       r.cycle,
       r.grade,
       r.endorsed,
       r.rationale,
       a.votes_with_union,
       a.votes_against_union,
       a.votes_missed,
       a.alignment_pct
from public.civic_member_officials_keyed mo
join public.civic_official_ratings r
       on r.official_key = mo.official_key and r.published
left join public.civic_official_alignment a
       on a.org_id = r.org_id and a.official_key = mo.official_key;

-- What the union may see about participation: counts, never members or
-- bodies. Not granted to any client role; officers read it through
-- public.civic_campaign_stats_for_org.
create view public.civic_campaign_stats
with (security_invoker = on) as
select c.id as campaign_id,
       c.org_id,
       count(m.id) filter (where m.status = 'sent') as messages_sent,
       count(m.id) filter (where m.status = 'drafted') as messages_drafted,
       count(distinct m.user_id) filter (where m.status = 'sent') as members_participating,
       count(distinct m.official_key) filter (where m.status = 'sent') as officials_contacted
from public.civic_campaigns c
left join public.civic_member_messages m on m.campaign_id = c.id
group by c.id, c.org_id;

alter table public.civic_bills enable row level security;
alter table public.civic_roll_calls enable row level security;
alter table public.civic_official_votes enable row level security;
alter table public.civic_campaigns enable row level security;
alter table public.civic_member_messages enable row level security;
alter table public.civic_official_ratings enable row level security;

create policy mfa_assurance on public.civic_bills
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_roll_calls
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_official_votes
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_campaigns
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_member_messages
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_official_ratings
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

revoke all on public.civic_bills, public.civic_roll_calls, public.civic_official_votes,
  public.civic_campaigns, public.civic_member_messages, public.civic_official_ratings,
  public.civic_member_officials_keyed, public.civic_bill_deciding_votes,
  public.civic_campaign_official_votes, public.civic_member_message_outcomes,
  public.civic_official_alignment, public.civic_member_official_ratings,
  public.civic_campaign_stats
  from public, anon, authenticated;
grant all on public.civic_bills, public.civic_roll_calls, public.civic_official_votes,
  public.civic_campaigns, public.civic_member_messages, public.civic_official_ratings,
  public.civic_member_officials_keyed, public.civic_bill_deciding_votes,
  public.civic_campaign_official_votes, public.civic_member_message_outcomes,
  public.civic_official_alignment, public.civic_member_official_ratings,
  public.civic_campaign_stats
  to service_role;

comment on policy mfa_assurance on public.civic_bills is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_roll_calls is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_official_votes is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_campaigns is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_member_messages is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_official_ratings is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';

notify pgrst, 'reload schema';

commit;
