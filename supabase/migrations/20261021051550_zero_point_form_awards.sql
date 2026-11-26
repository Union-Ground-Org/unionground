-- BUG-UG-ZERO-POINT-FORM-SUBMISSION-20261020
-- Upstream, this preserved valid form submissions when the configured reward
-- is zero by re-emitting private.award_member_points(). Union Ground dropped
-- that function and its member_action_log trigger with the points economy
-- (20261014003000), so no submission reaches an award path and re-creating
-- the function would bring back a retired minting routine. Kept as a no-op
-- so the version stays in the history (the transaction keeps the wrapper
-- every imported migration carries; its one read-only select names it).
begin;
select 'retired: zero-point form awards (points economy dropped)' as history_note;
commit;
