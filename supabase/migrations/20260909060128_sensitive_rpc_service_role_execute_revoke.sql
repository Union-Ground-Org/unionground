begin;

-- Hosted postgres/public default privileges grant service_role EXECUTE when a
-- function is created. The ENC migration revoked PUBLIC and anon but retained
-- that direct grant on these caller-authorized RPCs. Match the existing contract
-- without rewriting their bodies, historical migrations, or shared defaults.
-- The separate stage_sensitive_write RPC intentionally remains service-role-only.
revoke execute on function public.sensitive_pattern_source(text, uuid) from service_role;
revoke execute on function public.sensitive_data_organization() from service_role;
revoke execute on function public.write_sensitive_content(text, jsonb, jsonb, uuid) from service_role;
revoke execute on function public.sensitive_case_upload_target(uuid) from service_role;

notify pgrst, 'reload schema';

commit;
