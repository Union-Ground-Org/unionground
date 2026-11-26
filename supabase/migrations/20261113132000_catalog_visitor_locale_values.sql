-- BUG-UG-CATALOG-VISITOR-TIMEZONE-BLANKED-BY-PUBLIC-TEXT-RULE-20261114 (#8742).
--
-- A caller with no account reads the union catalog search and profile
-- through private.catalog_public_json, which puts every string through the
-- visitor text rule (private.catalog_public_text). That rule drops a word
-- with a slash that is not a link, so an IANA timezone with an underscore or
-- a second slash (America/Sao_Paulo, America/Mexico_City,
-- America/Argentina/Buenos_Aires) reached visitors as an empty string, while
-- members read it unchanged.
--
-- The locale values of the answers (country, subdivision, postalCode,
-- language, timezone) are codes the catalog tables already constrain
-- (private.catalog_locale_valid). Here a value under one of those keys, at
-- any depth, is returned unchanged when it is a valid value of its kind, the
-- same check the tables apply; anything else under those keys, and every
-- other string, still goes through the visitor text rule. Schema only: no
-- row is read or written.

begin;

create function private.catalog_public_locale_value(p_key text, p_value jsonb)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select case
    when p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'string' then false
    when p_key = 'country' then private.catalog_country_valid(p_value #>> '{}')
    when p_key = 'subdivision' then private.catalog_subdivision_valid(p_value #>> '{}')
    when p_key = 'postalCode' then pg_catalog.char_length(p_value #>> '{}') between 1 and 32
      and (p_value #>> '{}') ~ '^[[:alnum:]][[:alnum:] -]*$'
    when p_key = 'language' then private.catalog_language_valid(p_value #>> '{}')
    when p_key = 'timezone' then pg_catalog.char_length(p_value #>> '{}') <= 100
      and (p_value #>> '{}') ~ '^([A-Za-z_+-]+/)+[A-Za-z0-9_+/-]+$|^UTC$'
      and exists (select 1 from pg_catalog.pg_timezone_names as tz where tz.name = p_value #>> '{}')
    else false
  end;
$function$;

create or replace function private.catalog_public_json(p_value jsonb, p_withheld text[])
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'string' then
      return pg_catalog.to_jsonb(private.catalog_public_text(p_value #>> '{}', p_withheld));
    when 'array' then
      return (select coalesce(pg_catalog.jsonb_agg(private.catalog_public_json(e.value, p_withheld) order by e.n), '[]'::jsonb)
                from pg_catalog.jsonb_array_elements(p_value) with ordinality as e(value, n));
    when 'object' then
      -- A valid locale value is a code, never a link or prose: it is returned
      -- as stored, so a visitor reads what a member reads (#8742).
      return (select coalesce(pg_catalog.jsonb_object_agg(e.key,
                case when private.catalog_public_locale_value(e.key, e.value) then e.value
                     else private.catalog_public_json(e.value, p_withheld) end), '{}'::jsonb)
                from pg_catalog.jsonb_each(p_value) as e(key, value));
    else
      return p_value;
  end case;
end;
$function$;

revoke all on function private.catalog_public_locale_value(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.catalog_public_json(jsonb, text[]) from public, anon, authenticated, service_role;

comment on function private.catalog_public_locale_value(text, jsonb) is
  'Whether a catalog answer value under a locale key (country, subdivision, postalCode, language, timezone) is a valid value of its kind, by the same checks private.catalog_locale_valid applies to the tables. Called by catalog_public_json; no role executes it directly (BUG-UG-CATALOG-VISITOR-TIMEZONE-BLANKED-BY-PUBLIC-TEXT-RULE-20261114).';
comment on function private.catalog_public_json(jsonb, text[]) is
  'A JSON answer as a visitor with no account may see it: every string at any depth through private.catalog_public_text, except a valid locale value under a locale key (private.catalog_public_locale_value), which is returned as stored (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110; BUG-UG-CATALOG-VISITOR-TIMEZONE-BLANKED-BY-PUBLIC-TEXT-RULE-20261114).';

commit;
