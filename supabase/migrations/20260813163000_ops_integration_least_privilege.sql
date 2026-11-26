-- Supabase's public-schema default ACL grants service_role the full table
-- privilege set before explicit grants run. Narrow the router ledger to the
-- three operations its REST client actually uses.

revoke all on table public.ops_integration_incidents from service_role;
revoke all on table public.ops_integration_deliveries from service_role;
grant select, insert, update on table public.ops_integration_incidents to service_role;
grant select, insert, update on table public.ops_integration_deliveries to service_role;
