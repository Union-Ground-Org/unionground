begin;

-- Conversion review and correction IDs are retained audit attribution, not
-- ownership edges. Keep the UUID values as pseudonymous evidence after the
-- account-lifecycle contract removes the Auth row; an audit ledger must never
-- make an otherwise eligible account deletion fail with ON DELETE RESTRICT.
alter table public.organization_knowledge_conversions
  drop constraint organization_knowledge_conversions_conversion_reviewed_by_fkey,
  drop constraint organization_knowledge_conversions_corrected_by_fkey;

comment on column public.organization_knowledge_conversions.conversion_reviewed_by is
  'Pseudonymous Auth UUID of the reviewer; intentionally detached from auth.users so retained conversion evidence survives account deletion.';

comment on column public.organization_knowledge_conversions.corrected_by is
  'Pseudonymous Auth UUID of the correcting staff member; intentionally detached from auth.users so retained correction evidence survives account deletion.';

commit;
