-- REQ-UG-FULL-DEPTH-20260723 PR2 (2/3): form lookup helpers read the
-- registry instead of hardcoded CASE expressions.
--
-- Signatures of the three 1-arg helpers are preserved exactly (house rule) so
-- every existing caller keeps working; only the bodies change, and IMMUTABLE
-- necessarily becomes STABLE now that they read a table. The unversioned
-- forms read the CURRENT (max version) row — label/points track the latest
-- admin edit, matching today's behavior where a CASE edit changed them
-- globally. Version-pinned completeness lives in the NEW 2-arg overload
-- (arity-resolved, so nothing calling the 1-arg form breaks), which
-- submit_form switches to in 20260723112000. form_template_label stays
-- English-default for legacy callers; the NEW localized variant powers
-- bilingual notifications.

create or replace function private.form_template_label(p_template_key text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select label_en from public.form_templates where key = p_template_key order by version desc limit 1),
    p_template_key);
$$;

create or replace function private.form_points(p_template_key text)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select points from public.form_templates where key = p_template_key order by version desc limit 1),
    15);
$$;

create or replace function private.form_required_keys(p_template_key text)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select pg_catalog.array_agg(f.field ->> 'key')
     from (select field_schema from public.form_templates
           where key = p_template_key order by version desc limit 1) tpl,
          lateral pg_catalog.jsonb_array_elements(tpl.field_schema -> 'steps') s(step),
          lateral pg_catalog.jsonb_array_elements(s.step -> 'fields') f(field)
     where (f.field ->> 'required')::boolean),
    array[]::text[]);
$$;

-- Version-pinned overload: submit_form validates a form against the exact
-- schema version it was filled under, not the latest — renamed/removed fields
-- in old drafts stay submittable under their original rules.
create function private.form_required_keys(p_template_key text, p_version integer)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select pg_catalog.array_agg(f.field ->> 'key')
     from (select field_schema from public.form_templates
           where key = p_template_key and version = p_version) tpl,
          lateral pg_catalog.jsonb_array_elements(tpl.field_schema -> 'steps') s(step),
          lateral pg_catalog.jsonb_array_elements(s.step -> 'fields') f(field)
     where (f.field ->> 'required')::boolean),
    array[]::text[]);
$$;

-- Bilingual notification labels (the fix for English-only steward-action
-- notifications): current-version label in the recipient's language.
create function private.form_template_label_localized(p_template_key text, p_lang text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select case when p_lang = 'es' then label_es else label_en end
     from public.form_templates where key = p_template_key order by version desc limit 1),
    p_template_key);
$$;

-- Version-pinned localized label: steward-action notifications name the
-- template exactly as the member's own form list renders it (the PINNED
-- version's label), not the current version's possibly-renamed one. Falls
-- back to the current-version label, then the key echo.
create function private.form_template_label_localized(p_template_key text, p_version integer, p_lang text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select case when p_lang = 'es' then label_es else label_en end
     from public.form_templates where key = p_template_key and version = p_version),
    private.form_template_label_localized(p_template_key, p_lang));
$$;

revoke all on function private.form_template_label(text) from public, anon, authenticated;
revoke all on function private.form_points(text) from public, anon, authenticated;
revoke all on function private.form_required_keys(text) from public, anon, authenticated;
revoke all on function private.form_required_keys(text, integer) from public, anon, authenticated;
revoke all on function private.form_template_label_localized(text, text) from public, anon, authenticated;
revoke all on function private.form_template_label_localized(text, integer, text) from public, anon, authenticated;
