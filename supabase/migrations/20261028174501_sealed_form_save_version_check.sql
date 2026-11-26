-- SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022: reject stale
-- prepared saves, including no-ops, while holding the current form row lock.
-- Existing migration bytes and function ACLs stay unchanged.
begin;
set local lock_timeout = '5s';
create or replace function public.save_sealed_form_draft(p_form_id uuid, p_step integer, p_changed boolean,
  p_filled jsonb, p_data_version text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  rec record;
  ticket_arguments jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if nullif(current_setting('app.sensitive_ticket', true), '') is null then
    raise exception 'sensitive-data-trusted-write-required' using errcode = '42501';
  end if;
  select arguments into ticket_arguments from private.sensitive_write_tickets
    where id = nullif(current_setting('app.sensitive_ticket',true),'')::uuid
      and actor = caller and operation = 'save_sealed_form_draft' and expires_at > clock_timestamp();
  perform private.lock_member_form(p_form_id);
  select id, user_id, status, template_key, encrypted_content into rec from public.member_forms where id = p_form_id for update;
  if not found or rec.user_id <> caller or not private.form_template_is_sealed(rec.template_key)
    or rec.status not in ('draft', 'returned') then
    raise exception 'form not found' using errcode = '22023';
  end if;
  if not coalesce(ticket_arguments ? 'p_expected_data_version', false)
    or (ticket_arguments->>'p_expected_data_version') is distinct from (rec.encrypted_content #>> '{answers,dataVersion}') then
    raise exception 'sensitive-data-conflict' using errcode = '40001';
  end if;
  if p_changed then
    delete from private.member_form_signatures where form_id = p_form_id;
    update public.member_forms
      set filer_signed_at = null, filer_signature_digest = null, content_digest = null,
        answers = pg_catalog.jsonb_build_object('sealed', true, 'filled', coalesce(p_filled, '[]'::jsonb),
          'dataVersion', p_data_version),
        step = least(greatest(coalesce(p_step, 0), 0), 50), updated_at = now()
      where id = p_form_id and user_id = caller;
  else
    update public.member_forms set step = least(greatest(coalesce(p_step, 0), 0), 50), updated_at = now()
      where id = p_form_id and user_id = caller;
  end if;
  return p_form_id;
end;
end
$$;
revoke all on function public.save_sealed_form_draft(uuid, integer, boolean, jsonb, text)
  from public, anon, authenticated, service_role;


comment on function public.save_sealed_form_draft(uuid,integer,boolean,jsonb,text) is 'Ticket-bound FMLA save: compare the prepared dataVersion under the form lock before writing or accepting a no-op.';
update private.account_lifecycle_trigger_review r set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef('public.save_sealed_form_draft(uuid,integer,boolean,jsonb,text)'::regprocedure)) where r.kind = 'function' and r.schema_name = 'public' and r.table_name = '' and r.object_name = 'save_sealed_form_draft(p_form_id uuid, p_step integer, p_changed boolean, p_filled jsonb, p_data_version text)';
notify pgrst, 'reload schema';
commit;
