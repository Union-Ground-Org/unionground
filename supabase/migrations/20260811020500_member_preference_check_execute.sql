-- CHECK constraints execute referenced functions as the role performing the
-- write. The navigation-preference migration revoked this pure validator from
-- every API role, which unintentionally made every authenticated profile
-- update fail with 42501 before the constraint could evaluate.
--
-- The helper is immutable, has an empty search_path, and reads no database
-- state. Exposing only EXECUTE to the two roles that can legitimately write
-- profile rows restores constraint evaluation without widening table access.

grant execute on function private.valid_member_preference_keys(text[], text[], integer)
  to authenticated, service_role;
