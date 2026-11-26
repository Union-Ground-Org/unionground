-- Synthetic validation-only regression. Run after the import draft is loaded.
-- Does not import a dataset or grant application authorization.
begin;
do $test$
declare
  payload jsonb := '{"schemaVersion":"org-structure/1","attestation":{"suppliedBy":"Synthetic test operator","suppliedOn":"2026-09-23","authority":"Disposable synthetic proof","personalContactConsent":"not_obtained"},"charts":{"union":{"nodes":[{"nodeKey":"test-node","nodeKind":"person","label":"Synthetic test node","contacts":[{"contactKind":"email","contactValue":"synthetic@example.invalid","contactVisibility":"members","isPersonalAddress":"garbage"}]}]}}}'::jsonb;
  report jsonb;
  nested text;
  org uuid := '00000000-0000-0000-0000-000000000001';
begin
  -- Invalid personal-contact flags must be reported, never cast before validation.
  report := private.org_structure_validate(org, payload);
  if not report->'errors' @> '[{"code":"not_boolean"}]'::jsonb then
    raise exception 'malformed personal flag was not reported';
  end if;
  payload := jsonb_set(payload, '{charts,union,nodes,0,contacts,0,isPersonalAddress}', 'true');
  report := private.org_structure_validate(org, payload);
  if not report->'errors' @> '[{"code":"personal_contact_without_consent"}]'::jsonb then
    raise exception 'personal member contact without consent was admitted';
  end if;
  payload := payload #- '{charts,union,nodes,0,contacts,0,contactVisibility}';
  report := private.org_structure_validate(org, payload);
  if jsonb_array_length(report->'errors') <> 0 then
    raise exception 'omitted visibility must use staff default: %', report->'errors';
  end if;
  payload := jsonb_set(payload, '{charts,union,nodes,0,contacts,0,sortOrder}', '"garbage"');
  report := private.org_structure_validate(org, payload);
  if not report->'errors' @> '[{"code":"sort_order"}]'::jsonb then
    raise exception 'invalid nested sortOrder was silently accepted';
  end if;
  foreach nested in array array['notes', 'metrics', 'crossReferences'] loop
    report := private.org_structure_validate(org,
      jsonb_set(payload #- '{charts,union,nodes,0,contacts}',
        array['charts','union','nodes','0',nested], '[{"sortOrder":"garbage"}]'));
    if not report->'errors' @> '[{"code":"sort_order"}]'::jsonb then
      raise exception 'invalid % sortOrder was silently accepted', nested;
    end if;
  end loop;
  payload := jsonb_set(payload, '{charts,union,nodes,0,contacts,0,contactVisibility}', 'null');
  report := private.org_structure_validate(org, payload);
  if not report->'errors' @> '[{"code":"invalid_enum"}]'::jsonb then
    raise exception 'explicit null visibility was admitted';
  end if;
  report := private.org_structure_validate(org, null);
  if not report->'errors' @> '[{"code":"payload_not_object"}]'::jsonb then
    raise exception 'SQL null payload did not report the object boundary error';
  end if;
end;
$test$;
rollback;
