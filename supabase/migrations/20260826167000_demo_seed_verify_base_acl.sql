-- The hosted-compatibility verifier wrappers call these moved implementations
-- as their security-definer owner. No API role needs direct EXECUTE, including
-- service_role; keep the only callable verification surface in public behind
-- the explicit service-role guard.

revoke all on function private.presg_demo_verify_pre_function_parity(uuid, text)
  from public, anon, authenticated, service_role;

revoke all on function private.uniondemo_verify_pre_function_parity(uuid, text)
  from public, anon, authenticated, service_role;
