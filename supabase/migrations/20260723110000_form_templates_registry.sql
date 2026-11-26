-- REQ-UG-FULL-DEPTH-20260723 PR2 (1/3): form template registry.
--
-- The 7 form templates move from client/SQL hardcoding into a versioned
-- reference table. Immutability rules:
--   * key is permanently immutable (a rename = retire + new key).
--   * every content column on a (key, version) row is immutable once
--     inserted — ANY edit (even a points tweak) inserts a new version via
--     upsert_form_template; past versions are never UPDATEd, so historical
--     submissions always render under the exact schema they were filed with.
--   * active is the ONE in-place-mutable column, only ever on the current
--     (max) version row; upsert force-clears the prior active row in the same
--     transaction, so at most one row per key is active.
-- Admin-authored content cannot join the compiled i18n catalogue, so each row
-- carries inline {en, es} pairs inside field_schema and label/blurb columns.
-- MUST apply BEFORE 20260723112000 (the member_forms FK migration) — that FK
-- validates against the version=1 rows seeded here.

create table public.form_templates (
  key           text not null check (key ~ '^[a-z][a-z0-9_]{2,49}$'),
  version       integer not null check (version >= 1),
  label_en      text not null check (char_length(label_en) between 1 and 120),
  label_es      text not null check (char_length(label_es) between 1 and 120),
  blurb_en      text check (blurb_en is null or char_length(blurb_en) <= 400),
  blurb_es      text check (blurb_es is null or char_length(blurb_es) <= 400),
  icon          text check (icon is null or char_length(icon) <= 8),
  points        integer not null default 15 check (points between 0 and 100),
  active        boolean not null default true,
  sort          smallint not null default 0 check (sort between 0 and 9999),
  field_schema  jsonb not null check (
    pg_catalog.jsonb_typeof(field_schema) = 'object'
    and pg_catalog.length(field_schema::text) <= 60000
  ),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id) on delete set null,
  primary key (key, version)
);

create index form_templates_active_sort_idx on public.form_templates (sort) where active;

alter table public.form_templates enable row level security;

-- Reference data, same tier as member_rights_lessons / member_kb_articles.
create policy form_templates_select_all on public.form_templates
  for select to authenticated using (true);

-- updated_by (an admin identity) stays out of the client read; the definer
-- RPCs below are the only writers.
revoke all on public.form_templates from anon, authenticated;
grant select (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema, created_at, updated_at)
  on public.form_templates to authenticated;

-- Server-side schema gate. The admin editor's client-side validation is UX
-- only; this is the real boundary. Type allow-list mirrors FieldControl's
-- switch in FormsView.jsx exactly. Field keys must be unique across the WHOLE
-- template (answers jsonb is flat — a repeated key would silently overwrite).
create function private.validate_form_template_schema(p_schema jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  steps jsonb;
  step jsonb;
  field jsonb;
  options jsonb;
  opt jsonb;
  seen_keys text[] := array[]::text[];
  field_key text;
  field_type text;
  max_len numeric;
  step_count integer;
  field_count integer;
  opt_count integer;
begin
  if p_schema is null or pg_catalog.jsonb_typeof(p_schema) <> 'object' then
    raise exception 'field_schema must be an object' using errcode = '22023';
  end if;
  steps := p_schema -> 'steps';
  if steps is null or pg_catalog.jsonb_typeof(steps) <> 'array' then
    raise exception 'field_schema.steps must be an array' using errcode = '22023';
  end if;
  step_count := pg_catalog.jsonb_array_length(steps);
  if step_count < 1 or step_count > 12 then
    raise exception 'templates need 1-12 steps' using errcode = '22023';
  end if;

  for step in select * from pg_catalog.jsonb_array_elements(steps) loop
    -- jsonb_typeof guard: #>> stringifies objects/arrays to non-empty text, so a
    -- btrim check alone would let a non-string title through to React (which
    -- throws on object children). Same guard on every label below.
    if pg_catalog.jsonb_typeof(step #> '{title,en}') is distinct from 'string'
       or pg_catalog.jsonb_typeof(step #> '{title,es}') is distinct from 'string'
       or pg_catalog.btrim(step #>> '{title,en}') = ''
       or pg_catalog.btrim(step #>> '{title,es}') = '' then
      raise exception 'every step needs string title.en and title.es' using errcode = '22023';
    end if;
    if step -> 'fields' is null or pg_catalog.jsonb_typeof(step -> 'fields') <> 'array' then
      raise exception 'every step needs a fields array' using errcode = '22023';
    end if;
    field_count := pg_catalog.jsonb_array_length(step -> 'fields');
    if field_count < 1 or field_count > 30 then
      raise exception 'steps need 1-30 fields' using errcode = '22023';
    end if;

    for field in select * from pg_catalog.jsonb_array_elements(step -> 'fields') loop
      field_key := field ->> 'key';
      if field_key is null or field_key !~ '^[a-z][a-z0-9_]{1,60}$' then
        raise exception 'invalid field key %', coalesce(field_key, '(missing)') using errcode = '22023';
      end if;
      if field_key = any(seen_keys) then
        raise exception 'duplicate field key % (answers are flat — keys must be unique across the template)', field_key using errcode = '22023';
      end if;
      seen_keys := seen_keys || field_key;

      field_type := field ->> 'type';
      if field_type is null or field_type not in ('text', 'textarea', 'date', 'select', 'radio', 'checkbox', 'multiselect', 'number') then
        raise exception 'field % has unsupported type %', field_key, coalesce(field_type, '(missing)') using errcode = '22023';
      end if;
      if pg_catalog.jsonb_typeof(field #> '{label,en}') is distinct from 'string'
         or pg_catalog.jsonb_typeof(field #> '{label,es}') is distinct from 'string'
         or pg_catalog.btrim(field #>> '{label,en}') = ''
         or pg_catalog.btrim(field #>> '{label,es}') = '' then
        raise exception 'field % needs string label.en and label.es', field_key using errcode = '22023';
      end if;
      if field -> 'required' is null or pg_catalog.jsonb_typeof(field -> 'required') <> 'boolean' then
        raise exception 'field % needs a boolean required flag', field_key using errcode = '22023';
      end if;
      if field ? 'maxLength' then
        if pg_catalog.jsonb_typeof(field -> 'maxLength') <> 'number' then
          raise exception 'field % maxLength must be a number', field_key using errcode = '22023';
        end if;
        max_len := (field ->> 'maxLength')::numeric;
        if max_len <> pg_catalog.trunc(max_len) or max_len < 1 or max_len > 4000 then
          raise exception 'field % maxLength must be an integer 1-4000', field_key using errcode = '22023';
        end if;
      end if;

      if field_type in ('select', 'radio', 'multiselect') then
        options := field -> 'options';
        if options is null or pg_catalog.jsonb_typeof(options) <> 'array' then
          raise exception 'field % needs an options array', field_key using errcode = '22023';
        end if;
        opt_count := pg_catalog.jsonb_array_length(options);
        if opt_count < 1 or opt_count > 40 then
          raise exception 'field % needs 1-40 options', field_key using errcode = '22023';
        end if;
        for opt in select * from pg_catalog.jsonb_array_elements(options) loop
          if coalesce(opt ->> 'value', '') !~ '^[a-z0-9_\-]{1,60}$' then
            raise exception 'field % has an invalid option value', field_key using errcode = '22023';
          end if;
          if pg_catalog.jsonb_typeof(opt #> '{label,en}') is distinct from 'string'
             or pg_catalog.jsonb_typeof(opt #> '{label,es}') is distinct from 'string'
             or pg_catalog.btrim(opt #>> '{label,en}') = ''
             or pg_catalog.btrim(opt #>> '{label,es}') = '' then
            raise exception 'field % options need string label.en and label.es', field_key using errcode = '22023';
          end if;
        end loop;
      elsif field ? 'options' then
        -- templateFromDbRow maps options unconditionally when present; a
        -- non-array here would TypeError inside loadMemberApp for every member.
        raise exception 'field % is not a choice type and must not carry options', field_key using errcode = '22023';
      end if;
    end loop;
  end loop;
end;
$$;

-- Admin write path. ALWAYS inserts a new version — content is never edited in
-- place — and force-deactivates the prior active row in the same transaction.
-- The advisory lock serializes concurrent upserts of the same key so two
-- admins cannot both compute max(version)+1 and collide.
create function public.upsert_form_template(
  p_key text, p_label_en text, p_label_es text, p_blurb_en text, p_blurb_es text,
  p_icon text, p_points integer, p_sort smallint, p_active boolean, p_field_schema jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  next_version integer;
  new_row record;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_key is null or p_key !~ '^[a-z][a-z0-9_]{2,49}$' then
    raise exception 'invalid key format' using errcode = '22023';
  end if;
  if pg_catalog.btrim(coalesce(p_label_en, '')) = '' or pg_catalog.btrim(coalesce(p_label_es, '')) = '' then
    raise exception 'label_en and label_es are required' using errcode = '22023';
  end if;
  if p_points is null or p_points < 0 or p_points > 100 then
    raise exception 'points must be 0-100' using errcode = '22023';
  end if;
  if p_icon is not null and pg_catalog.char_length(p_icon) > 8 then
    raise exception 'icon too long' using errcode = '22023';
  end if;
  perform private.validate_form_template_schema(p_field_schema);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('form-template-' || p_key, 509));
  select coalesce(max(version), 0) + 1 into next_version from public.form_templates where key = p_key;

  update public.form_templates
    set active = false, updated_at = now(), updated_by = caller
    where key = p_key and active = true;

  insert into public.form_templates
    (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema, updated_by)
  values
    (p_key, next_version, pg_catalog.btrim(p_label_en), pg_catalog.btrim(p_label_es),
     nullif(pg_catalog.btrim(coalesce(p_blurb_en, '')), ''), nullif(pg_catalog.btrim(coalesce(p_blurb_es, '')), ''),
     nullif(pg_catalog.btrim(coalesce(p_icon, '')), ''), p_points, coalesce(p_active, true),
     coalesce(p_sort, 0::smallint), p_field_schema, caller)
  returning key, version, active into new_row;

  return pg_catalog.jsonb_build_object('key', new_row.key, 'version', new_row.version, 'active', new_row.active);
end;
$$;

-- Deactivate = "stop new starts", never delete, never touch past versions.
-- In-flight drafts of a deactivated template stay completable (save_form_draft
-- gates active only on the new-draft branch — see 20260723112000).
create function public.deactivate_form_template(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  updated integer;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- Same per-key lock as upsert: without it, a deactivate racing an upsert can
  -- re-target the OLD max version after EvalPlanQual and silently miss the
  -- just-minted active row.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('form-template-' || p_key, 509));
  update public.form_templates
    set active = false, updated_at = now(), updated_by = caller
    where key = p_key and version = (select max(version) from public.form_templates where key = p_key);
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'template not found' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('key', p_key, 'active', false);
end;
$$;

create function public.reactivate_form_template(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  updated integer;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- Same per-key lock as upsert: without it, a reactivate racing an upsert can
  -- set active on the PREVIOUS version after the upsert mints a new active one,
  -- leaving two active rows for the key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('form-template-' || p_key, 509));
  update public.form_templates
    set active = true, updated_at = now(), updated_by = caller
    where key = p_key and version = (select max(version) from public.form_templates where key = p_key);
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'template not found' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('key', p_key, 'active', true);
end;
$$;

-- Seed: the 7 live templates as version 1, ported EXACTLY from
-- src/lib/formTemplates.js with every i18n *Key resolved to its {en, es} pair
-- from src/lib/i18n.js (generated mechanically from those sources). Points
-- match the live private.form_points CASE; sort matches the client list order.

insert into public.form_templates (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema) values
  ('grievance', 1, 'Workplace issue report', 'Reporte de asunto laboral', 'Report a workplace problem and the remedy you want.', 'Reporta un problema en el trabajo y el remedio que buscas.', '⚖', 25, true, 1,
   '{"steps":[{"title":{"en":"The issue","es":"El asunto"},"fields":[{"key":"summary","type":"text","label":{"en":"Issue summary","es":"Resumen del asunto"},"required":true,"maxLength":200},{"key":"articles","type":"text","label":{"en":"Article(s) cited","es":"Artículo(s) citado(s)"},"required":false,"maxLength":200},{"key":"incident_date","type":"date","label":{"en":"Date of incident","es":"Fecha del incidente"},"required":true}]},{"title":{"en":"What happened","es":"Qué pasó"},"fields":[{"key":"narrative","type":"textarea","label":{"en":"What happened","es":"Qué pasó"},"required":true,"maxLength":4000},{"key":"remedy","type":"textarea","label":{"en":"Desired remedy","es":"Remedio deseado"},"required":true,"maxLength":2000},{"key":"witnesses","type":"textarea","label":{"en":"Witnesses","es":"Testigos"},"required":false,"maxLength":1000}]}]}'::jsonb);

insert into public.form_templates (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema) values
  ('fmla_self', 1, 'FMLA — my own health', 'FMLA — mi propia salud', 'Request job-protected leave for your own serious health condition.', 'Solicita licencia protegida por tu propia condición de salud grave.', '🏥', 15, true, 2,
   '{"steps":[{"title":{"en":"Reason","es":"Motivo"},"fields":[{"key":"reason","type":"textarea","label":{"en":"Reason for leave","es":"Motivo de la licencia"},"required":true,"maxLength":2000},{"key":"condition_type","type":"radio","label":{"en":"Leave pattern","es":"Tipo de licencia"},"required":true,"options":[{"value":"continuous","label":{"en":"Continuous","es":"Continua"}},{"value":"intermittent","label":{"en":"Intermittent","es":"Intermitente"}}]}]},{"title":{"en":"Dates","es":"Fechas"},"fields":[{"key":"start_date","type":"date","label":{"en":"Start date","es":"Fecha de inicio"},"required":true},{"key":"end_date","type":"date","label":{"en":"Expected end date","es":"Fecha estimada de fin"},"required":true}]},{"title":{"en":"Provider","es":"Proveedor"},"fields":[{"key":"provider","type":"text","label":{"en":"Health-care provider","es":"Proveedor de salud"},"required":false,"maxLength":200},{"key":"notes","type":"textarea","label":{"en":"Notes","es":"Notas"},"required":false,"maxLength":1000}]}]}'::jsonb);

insert into public.form_templates (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema) values
  ('fmla_family', 1, 'FMLA — family care', 'FMLA — cuidado familiar', 'Request leave to care for a family member.', 'Solicita licencia para cuidar a un familiar.', '👪', 15, true, 3,
   '{"steps":[{"title":{"en":"Who","es":"Quién"},"fields":[{"key":"relationship","type":"select","label":{"en":"Relationship","es":"Parentesco"},"required":true,"options":[{"value":"spouse","label":{"en":"Spouse","es":"Cónyuge"}},{"value":"child","label":{"en":"Child","es":"Hijo/a"}},{"value":"parent","label":{"en":"Parent","es":"Padre/madre"}},{"value":"other","label":{"en":"Other family","es":"Otro familiar"}}]},{"key":"family_member","type":"text","label":{"en":"Family member (initials or relation)","es":"Familiar (iniciales o relación)"},"required":true,"maxLength":120}]},{"title":{"en":"Reason","es":"Motivo"},"fields":[{"key":"reason","type":"textarea","label":{"en":"Reason for leave","es":"Motivo de la licencia"},"required":true,"maxLength":2000},{"key":"condition_type","type":"radio","label":{"en":"Leave pattern","es":"Tipo de licencia"},"required":true,"options":[{"value":"continuous","label":{"en":"Continuous","es":"Continua"}},{"value":"intermittent","label":{"en":"Intermittent","es":"Intermitente"}}]}]},{"title":{"en":"Dates","es":"Fechas"},"fields":[{"key":"start_date","type":"date","label":{"en":"Start date","es":"Fecha de inicio"},"required":true},{"key":"end_date","type":"date","label":{"en":"Expected end date","es":"Fecha estimada de fin"},"required":true}]}]}'::jsonb);

insert into public.form_templates (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema) values
  ('alliance_grievance', 1, 'Group workplace issue', 'Asunto laboral de grupo', 'Raise an issue that affects a group of coworkers.', 'Plantea un problema que afecta a un grupo de compañeras.', '🤝', 25, true, 4,
   '{"steps":[{"title":{"en":"The issue","es":"El asunto"},"fields":[{"key":"summary","type":"text","label":{"en":"Shared issue","es":"Asunto compartido"},"required":true,"maxLength":200},{"key":"articles","type":"text","label":{"en":"Article(s) cited","es":"Artículo(s) citado(s)"},"required":false,"maxLength":200},{"key":"incident_date","type":"date","label":{"en":"Date of incident","es":"Fecha del incidente"},"required":true}]},{"title":{"en":"What happened","es":"Qué pasó"},"fields":[{"key":"narrative","type":"textarea","label":{"en":"What happened","es":"Qué pasó"},"required":true,"maxLength":4000},{"key":"affected","type":"textarea","label":{"en":"Affected members","es":"Miembros afectados"},"required":true,"maxLength":2000},{"key":"remedy","type":"textarea","label":{"en":"Desired remedy","es":"Remedio deseado"},"required":true,"maxLength":2000}]}]}'::jsonb);

insert into public.form_templates (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema) values
  ('non_selection', 1, 'Non-selection appeal', 'Apelación de no selección', 'Appeal being passed over for a posting.', 'Apela no haber sido seleccionado para un puesto.', '📄', 20, true, 5,
   '{"steps":[{"title":{"en":"The posting","es":"El puesto"},"fields":[{"key":"posting","type":"text","label":{"en":"Position / posting","es":"Puesto / vacante"},"required":true,"maxLength":200},{"key":"applied_date","type":"date","label":{"en":"Date applied","es":"Fecha de solicitud"},"required":true},{"key":"notified_date","type":"date","label":{"en":"Date notified","es":"Fecha de notificación"},"required":true}]},{"title":{"en":"Your grounds","es":"Tus fundamentos"},"fields":[{"key":"grounds","type":"textarea","label":{"en":"Grounds for appeal","es":"Fundamentos de la apelación"},"required":true,"maxLength":4000}]}]}'::jsonb);

insert into public.form_templates (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema) values
  ('alt_work', 1, 'Alternative work arrangement', 'Arreglo de trabajo alternativo', 'Request telework or a schedule change.', 'Solicita teletrabajo o un cambio de horario.', '🗓', 15, true, 6,
   '{"steps":[{"title":{"en":"Current schedule","es":"Horario actual"},"fields":[{"key":"schedule","type":"text","label":{"en":"Current schedule","es":"Horario actual"},"required":false,"maxLength":200},{"key":"requested","type":"text","label":{"en":"Requested arrangement","es":"Arreglo solicitado"},"required":true,"maxLength":200},{"key":"telework_days","type":"multiselect","label":{"en":"Preferred telework days","es":"Días de teletrabajo preferidos"},"required":false,"options":[{"value":"mon","label":{"en":"Mon","es":"Lun"}},{"value":"tue","label":{"en":"Tue","es":"Mar"}},{"value":"wed","label":{"en":"Wed","es":"Mié"}},{"value":"thu","label":{"en":"Thu","es":"Jue"}},{"value":"fri","label":{"en":"Fri","es":"Vie"}}]}]},{"title":{"en":"Why","es":"Por qué"},"fields":[{"key":"reason","type":"textarea","label":{"en":"Reason","es":"Motivo"},"required":true,"maxLength":2000},{"key":"duration","type":"text","label":{"en":"Duration","es":"Duración"},"required":false,"maxLength":120}]}]}'::jsonb);

insert into public.form_templates (key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema) values
  ('service_request', 1, 'Committee help request', 'Solicitud de ayuda al comité', 'Ask the committee for help with scheduling, outreach, or training.', 'Pide al comité ayuda con horarios, alcance o capacitación.', '🧰', 10, true, 7,
   '{"steps":[{"title":{"en":"Your request","es":"Tu solicitud"},"fields":[{"key":"category","type":"select","label":{"en":"Category","es":"Categoría"},"required":true,"options":[{"value":"dues","label":{"en":"Dues / membership","es":"Cuotas / membresía"}},{"value":"benefits","label":{"en":"Benefits","es":"Beneficios"}},{"value":"training","label":{"en":"Training","es":"Capacitación"}},{"value":"other","label":{"en":"Other","es":"Otro"}}]},{"key":"description","type":"textarea","label":{"en":"Description","es":"Descripción"},"required":true,"maxLength":4000}]}]}'::jsonb);

revoke all on function private.validate_form_template_schema(jsonb) from public, anon, authenticated;
revoke all on function public.upsert_form_template(text, text, text, text, text, text, integer, smallint, boolean, jsonb) from public, anon;
revoke all on function public.deactivate_form_template(text) from public, anon;
revoke all on function public.reactivate_form_template(text) from public, anon;

grant execute on function public.upsert_form_template(text, text, text, text, text, text, integer, smallint, boolean, jsonb) to authenticated;
grant execute on function public.deactivate_form_template(text) to authenticated;
grant execute on function public.reactivate_form_template(text) to authenticated;
