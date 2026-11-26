-- FIX-UG-FMLA-FORMS-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261022
--
-- The FMLA templates asked for "Reason for leave" as free text (fmla_self and
-- fmla_family) and for the family member by name or initials. GINA Title II
-- covers labor organizations (42 U.S.C. 2000ff(2)(D)) and forbids requesting
-- family medical history outside FMLA certification (2000ff-3(b)). The
-- client now shows the EEOC safe-harbor notice of 29 CFR 1635.8(b)(1)(i)(B)
-- and a no-diagnosis hint before every FMLA form, keyed by template key; this
-- migration carries the field changes, as the record requires, by a NEW
-- platform seed version of each FMLA template rather than an edit of version 1:
--   reason         -> "Leave you need ... (not the condition itself)"
--   family_member  -> "initials or relationship only", maxLength 120 -> 40
-- Version 1 rows are untouched (payload and active flag); every reader that
-- picks a key's current template takes the newest platform seed, so new FMLA
-- drafts start on the new version, and forms already pinned to version 1 keep
-- rendering and submitting under it.
--
-- A platform seed newer than an organization's own copy must not replace it
-- (the organization edited or turned that template off). Every reader that
-- picks "the current template" for a caller now ranks the organization's own
-- row above a platform seed, then the highest version: save_form_draft,
-- form_points (both), form_template_label_localized and
-- get_admin_reward_economy. deactivate_form_template and
-- reactivate_form_template copy only the LATEST platform seed when they mint an
-- organization's first version (two seed versions would otherwise insert two
-- rows with the same new version). Signatures, security mode, grants and
-- every other line are unchanged; each installed body is md5-guarded.
-- Hosted application needs a separate go-ahead from the maintainers.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
declare
  installed text;
begin
  select array[
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.form_points(text)'::regprocedure),
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.form_points(text, integer)'::regprocedure),
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'private.form_template_label_localized(text, text)'::regprocedure),
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.deactivate_form_template(text)'::regprocedure),
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.reactivate_form_template(text)'::regprocedure),
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.save_form_draft(text, jsonb, integer)'::regprocedure),
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_admin_reward_economy()'::regprocedure)
    ]::text into strict installed;
  -- Reviewed predecessors, in order, from 20261007173502; Union Ground's
  -- form_points(text) is the retired `select 0` of 20261014003000.
  if installed is distinct from '{b3f2b7312868d837287ea4e43e5152df,f984f6cd9fbf8d461440d44ddec9bcd3,753f7307698c101b3593648a0e49fe0b,9e73133f9a7b42bb4cf02a8a99a2f550,655069b42fdb29d8a48c0167692a0341,816e7976d749553c5846d83a3904a001,af77324cf3ea3ddfee831429ba5468b3}' then
    raise exception 'unreviewed form template predecessor: %', installed using errcode = '55000';
  end if;
  if (select pg_catalog.count(*) from public.form_templates
       where is_platform_seed and key in ('fmla_self', 'fmla_family')) <> 2
     or exists (select 1 from public.form_templates
       where is_platform_seed and key in ('fmla_self', 'fmla_family') and version <> 1) then
    raise exception 'expected exactly the version-1 platform seeds of fmla_self and fmla_family' using errcode = '55000';
  end if;
end
$predecessor$;

insert into public.form_templates
  (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema, is_platform_seed, organization_id)
select s.key, (select pg_catalog.max(m.version) + 1 from public.form_templates m where m.key = s.key),
  s.label_en, s.label_es, s.blurb_en, s.blurb_es, s.icon, s.points, true, s.sort,
  '{"steps":[{"title":{"en":"Reason","es":"Motivo"},"fields":[{"key":"reason","type":"textarea","label":{"en":"Leave you need: for your own serious health condition or to care for a family member, continuous or intermittent (not the condition itself)","es":"Licencia que necesitas: por tu propia condición de salud grave o para cuidar a un familiar, continua o intermitente (no la condición en sí)"},"required":true,"maxLength":2000},{"key":"condition_type","type":"radio","label":{"en":"Leave pattern","es":"Tipo de licencia"},"required":true,"options":[{"value":"continuous","label":{"en":"Continuous","es":"Continua"}},{"value":"intermittent","label":{"en":"Intermittent","es":"Intermitente"}}]}]},{"title":{"en":"Dates","es":"Fechas"},"fields":[{"key":"start_date","type":"date","label":{"en":"Start date","es":"Fecha de inicio"},"required":true},{"key":"end_date","type":"date","label":{"en":"Expected end date","es":"Fecha estimada de fin"},"required":true}]},{"title":{"en":"Provider","es":"Proveedor"},"fields":[{"key":"provider","type":"text","label":{"en":"Health-care provider","es":"Proveedor de salud"},"required":false,"maxLength":200},{"key":"notes","type":"textarea","label":{"en":"Notes","es":"Notas"},"required":false,"maxLength":1000}]}]}'::jsonb, true, null
from public.form_templates s
where s.key = 'fmla_self' and s.version = 1 and s.is_platform_seed;

insert into public.form_templates
  (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema, is_platform_seed, organization_id)
select s.key, (select pg_catalog.max(m.version) + 1 from public.form_templates m where m.key = s.key),
  s.label_en, s.label_es, s.blurb_en, s.blurb_es, s.icon, s.points, true, s.sort,
  '{"steps":[{"title":{"en":"Who","es":"Quién"},"fields":[{"key":"relationship","type":"select","label":{"en":"Relationship","es":"Parentesco"},"required":true,"options":[{"value":"spouse","label":{"en":"Spouse","es":"Cónyuge"}},{"value":"child","label":{"en":"Child","es":"Hijo/a"}},{"value":"parent","label":{"en":"Parent","es":"Padre/madre"}},{"value":"other","label":{"en":"Other family","es":"Otro familiar"}}]},{"key":"family_member","type":"text","label":{"en":"Family member: initials or relationship only","es":"Familiar: solo iniciales o parentesco"},"required":true,"maxLength":40}]},{"title":{"en":"Reason","es":"Motivo"},"fields":[{"key":"reason","type":"textarea","label":{"en":"Leave you need: for your own serious health condition or to care for a family member, continuous or intermittent (not the condition itself)","es":"Licencia que necesitas: por tu propia condición de salud grave o para cuidar a un familiar, continua o intermitente (no la condición en sí)"},"required":true,"maxLength":2000},{"key":"condition_type","type":"radio","label":{"en":"Leave pattern","es":"Tipo de licencia"},"required":true,"options":[{"value":"continuous","label":{"en":"Continuous","es":"Continua"}},{"value":"intermittent","label":{"en":"Intermittent","es":"Intermitente"}}]}]},{"title":{"en":"Dates","es":"Fechas"},"fields":[{"key":"start_date","type":"date","label":{"en":"Start date","es":"Fecha de inicio"},"required":true},{"key":"end_date","type":"date","label":{"en":"Expected end date","es":"Fecha estimada de fin"},"required":true}]}]}'::jsonb, true, null
from public.form_templates s
where s.key = 'fmla_family' and s.version = 1 and s.is_platform_seed;

-- Union Ground keeps private.form_points(text) as the retired `select 0`
-- (20261014003000): no award path reads it, so it is not re-emitted.

CREATE OR REPLACE FUNCTION private.form_points(p_template_key text, p_template_version integer)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(
    (select points from public.form_templates where key = p_template_key and (is_platform_seed or organization_id=(select private.current_member_organization())) order by (organization_id is not null) desc, version desc limit 1),
    (select points from public.form_templates where key = p_template_key and version = p_template_version),
    15);
$function$;

CREATE OR REPLACE FUNCTION private.form_template_label_localized(p_template_key text, p_lang text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(
    (select case when p_lang = 'es' then label_es else label_en end
     from public.form_templates where key = p_template_key and (is_platform_seed or organization_id=(select private.current_member_organization())) order by (organization_id is not null) desc, version desc limit 1),
    p_template_key);
$function$;

CREATE OR REPLACE FUNCTION public.deactivate_form_template(p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  template_org uuid := (select private.current_member_organization());
  updated integer;
begin
  if caller is null or template_org is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- Same per-key lock as upsert: without it, a deactivate racing an upsert can
  -- re-target the OLD max version after EvalPlanQual and silently miss the
  -- just-minted active row.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('form-template-' || p_key, 509));
  update public.form_templates
    set active = false, updated_at = now(), updated_by = caller
    where key = p_key and organization_id = template_org and version = (select max(version) from public.form_templates where key = p_key and organization_id = template_org);
  get diagnostics updated = row_count;
  if updated = 0 then
    -- Changing a shared default creates an organization-local immutable version.
    -- The shared row and every other organization's version remain untouched.
    insert into public.form_templates
      (key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,sort,field_schema,updated_by,organization_id)
      select t.key,(select max(version)+1 from public.form_templates where key=p_key),
        t.label_en,t.label_es,t.blurb_en,t.blurb_es,t.icon,t.points,'f'::boolean,t.sort,t.field_schema,caller,template_org
      from public.form_templates t where t.key=p_key and t.is_platform_seed
      order by t.version desc limit 1;
    get diagnostics updated = row_count;
    if updated = 0 then
      raise exception 'template not found' using errcode = '22023';
    end if;
  end if;
  return pg_catalog.jsonb_build_object('key', p_key, 'active', false);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reactivate_form_template(p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  template_org uuid := (select private.current_member_organization());
  updated integer;
begin
  if caller is null or template_org is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- Same per-key lock as upsert: without it, a reactivate racing an upsert can
  -- set active on the PREVIOUS version after the upsert mints a new active one,
  -- leaving two active rows for the key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('form-template-' || p_key, 509));
  update public.form_templates
    set active = true, updated_at = now(), updated_by = caller
    where key = p_key and organization_id = template_org and version = (select max(version) from public.form_templates where key = p_key and organization_id = template_org);
  get diagnostics updated = row_count;
  if updated = 0 then
    -- Changing a shared default creates an organization-local immutable version.
    -- The shared row and every other organization's version remain untouched.
    insert into public.form_templates
      (key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,sort,field_schema,updated_by,organization_id)
      select t.key,(select max(version)+1 from public.form_templates where key=p_key),
        t.label_en,t.label_es,t.blurb_en,t.blurb_es,t.icon,t.points,'t'::boolean,t.sort,t.field_schema,caller,template_org
      from public.form_templates t where t.key=p_key and t.is_platform_seed
      order by t.version desc limit 1;
    get diagnostics updated = row_count;
    if updated = 0 then
      raise exception 'template not found' using errcode = '22023';
    end if;
  end if;
  return pg_catalog.jsonb_build_object('key', p_key, 'active', true);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  existing uuid;
  clean jsonb := coalesce(p_answers, '{}'::jsonb);
  prev_answers jsonb;
  tpl record;
  reaffirmed uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if pg_catalog.jsonb_typeof(clean) <> 'object' or pg_catalog.length(clean::text) > 20000 then
    raise exception 'answers too large' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-form-' || caller::text || '-' || p_template_key, 509));
  select id, answers into existing, prev_answers from public.member_forms
    where user_id = caller and template_key = p_template_key and status in ('draft', 'returned')
    order by updated_at desc limit 1;
  if existing is null then
    -- With no selected organization only platform seeds match below.
    select version,active into tpl from public.form_templates
      where key=p_template_key and (is_platform_seed
        or organization_id=(select private.current_member_organization()))
      order by (organization_id is not null) desc, version desc limit 1;
    if not found then raise exception 'invalid template' using errcode='22023'; end if;
    if not tpl.active then
      raise exception 'this form is no longer accepting new submissions' using errcode = '22023';
    end if;
    insert into public.member_forms (user_id, template_key, template_version, answers, step)
      values (caller, p_template_key, tpl.version, clean,
        least(greatest(coalesce(p_step, 0), 0), 50))
      returning id into existing;
  else
    if clean is distinct from prev_answers then
      delete from private.member_form_signatures where form_id = existing;
      update public.member_forms
        set filer_signed_at = null, filer_signature_digest = null, content_digest = null
        where id = existing;
      if p_template_key = 'alliance_grievance' then
        for reaffirmed in
          update public.member_form_cosigners
            set status='reaffirm_needed', responded_at=now(), signed_at=null, signature_digest=null
            where form_id=existing and status='accepted'
            returning cosigner_user_id
        loop
          if reaffirmed is not null then
            perform private.notify_member(reaffirmed, 'cosign.reaffirm', '{}'::jsonb, 'forms');
          end if;
        end loop;
      end if;
    end if;
    update public.member_forms
      set answers = clean, step = least(greatest(coalesce(p_step, 0), 0), 50), updated_at = now()
      where id = existing and user_id = caller;
  end if;
  return existing;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_reward_economy()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.assert_reward_economy_admin();
  return pg_catalog.jsonb_build_object(
    'rules', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.action_kind) from public.member_point_rules r), '[]'::jsonb),
    'tiers', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.tier) from public.member_reward_tiers t), '[]'::jsonb),
    'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) order by i.sort, i.key) from public.member_reward_items i), '[]'::jsonb),
    'formTemplatePoints', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', f.key, 'version', f.version, 'labelEn', f.label_en, 'labelEs', f.label_es, 'points', f.points) order by f.sort, f.key)
      from (select distinct on (key) key, version, label_en, label_es, points, sort from public.form_templates where is_platform_seed or organization_id=(select private.current_member_organization()) order by key, (organization_id is not null) desc, version desc) f
    ), '[]'::jsonb),
    'revisions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc, x.id desc)
      from (select * from public.member_reward_economy_revisions order by created_at desc, id desc limit 50) x), '[]'::jsonb)
  );
end;
$function$;

-- Both form_points overloads are reachable from the award_member_points
-- trigger, so the account-lifecycle trigger review fingerprints them. Refresh
-- only those two, then require a clean inventory.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
where kind='function' and table_name='' and schema_name='private'
  and pg_catalog.split_part(object_name,'(',1) = 'form_points'
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;
do $inventory$
begin
  if exists(select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger inventory differs from review';
  end if;
end;
$inventory$;

notify pgrst, 'reload schema';

commit;
