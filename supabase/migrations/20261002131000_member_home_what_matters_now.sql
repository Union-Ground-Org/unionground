-- REQ-UG-MEMBER-WHAT-MATTERS-NOW-20261001
--
-- Restore-everything campaign,. The old member home led with
-- "What matters for you now": one ranked next action per visit
-- (de7df4b57c^:lib/attention/rules.ts, lib/attention/member-queue.ts,
-- components/home/lib/load-member-home.ts buildMemberAttention, and
-- components/home/lib/action-shelf-resolver.ts). The current Home shows only
-- the first active case (src/views/TodayView.jsx activeCase).
--
-- The ranking (filing deadline <= 3 days, ULP deadline <= 30 days with
-- critical <= 7, case in progress, retaliation flag, open vote, RSVP, caught
-- up) runs on web and native over the member's OWN snapshot rows, which RLS
-- already scopes to them: src/features/memberHome/whatMattersNow.js. It adds
-- no server read path, so the only server object is the organization switch.
-- The switch is member-visible so both clients can honour it; with it off,
-- Home keeps its previous next-case presentation.
--
-- Default ON: the old member home rendered the attention card for every member
-- with no setting in front of it
-- (de7df4b57c^:components/home/member-home-shell.tsx:345
-- `<MemberGuidanceHero attention={data.attention} />`), and the campaign rule
-- for behaviour the old app never flagged is ON (PLAN.md universal rule 2).

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.home.what_matters_now', 'boolean', 'What matters for you now',
   'Show members one ranked next action on Home: urgent case and ULP deadlines first, then cases, retaliation flags, open votes and this week''s events.',
   'true'::jsonb, null, null, null, 1310, 'home', true)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

commit;
