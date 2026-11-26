-- 20260721211321 scoped a 120s statement timeout onto the six service-role
-- stress functions. The 20260808230000 create-or-replace of
-- member_stress_remove_batch (ballot-secrecy choices sweep, UB-VOTE-04)
-- rebuilt the function without carrying that SET clause forward — CREATE OR
-- REPLACE replaces proconfig wholesale. Restore it; the db-contract pin
-- (config: statement_timeout=120s) is the check that caught the loss.

alter function public.member_stress_remove_batch(uuid, integer, text, text)
  set statement_timeout to '120s';
