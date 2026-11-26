-- The realistic ledger and exact-count verification exceed the hosted API's
-- short default statement timeout. Scope the larger limit to the six
-- service-role-only stress functions rather than changing the database default.

alter function public.member_stress_begin(uuid, text, integer, integer, text, text, text)
  set statement_timeout to '120s';
alter function public.member_stress_apply_batch(uuid, integer, integer, text, text, text)
  set statement_timeout to '120s';
alter function public.member_stress_status(uuid)
  set statement_timeout to '180s';
alter function public.member_stress_verify(uuid, text)
  set statement_timeout to '180s';
alter function public.member_stress_begin_remove(uuid, text, text)
  set statement_timeout to '120s';
alter function public.member_stress_remove_batch(uuid, integer, text, text)
  set statement_timeout to '120s';
