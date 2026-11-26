-- BUG-UG-ORG-SETUP-CONFIRM-REWRITES-ROOT-NODE-20261008
-- Later setup confirms add units without replacing the existing cat.root anchor.
-- Preserve the existing importer and all authorization/validation boundaries.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $predecessor$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = 'public.import_organization_structure(text,jsonb,boolean)'::regprocedure)
      is distinct from '0fa906870c97deda20c1bfebfffd7be2' then
    raise exception 'unreviewed import_organization_structure predecessor' using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function public.import_organization_structure(
  p_selected_hat text,
  p_payload jsonb,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid;
  caller uuid;
  report jsonb;
  v_counts jsonb;
  keys jsonb;
  import_id uuid;
  audit_events integer;
  committed boolean;
  dry boolean;
  kind text;
  entity text;
  entry jsonb;
  node jsonb;
  child jsonb;
  v_node_id uuid;
  target_id uuid;
  v_section_id uuid;
  chapter_key text;
  chapter_row text;
  key_text text;
  attestation jsonb;
  preserved_root_id uuid;
  payload_nodes jsonb;
  walk_id uuid;
  walk_key text;
  root_path text;
  hops integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  org := private.mi1_require_selected_organization();
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is null or p_selected_hat not in ('advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  dry := coalesce(p_dry_run, true);
  report := private.org_structure_validate(org, p_payload);
  if pg_catalog.jsonb_typeof(p_payload) = 'object' then
    if p_payload ? 'selectedHat' and (p_payload ->> 'selectedHat') is distinct from p_selected_hat then
      report := pg_catalog.jsonb_set(report, array['errors'], private.org_structure_note(
        report -> 'errors', 'selectedHat', 'hat_disagreement',
        'the payload names a different hat than the call'));
    end if;
    -- A payload that asks for a dry run may not be committed by the argument.
    if (p_payload -> 'dryRun') = 'true'::jsonb and not dry then
      report := pg_catalog.jsonb_set(report, array['errors'], private.org_structure_note(
        report -> 'errors', 'dryRun', 'dry_run_disagreement',
        'the payload asks for a dry run, so this call cannot commit'));
    end if;
  end if;

  v_counts := report -> 'counts';
  -- cat.root is the setup wizard's shared anchor, not a replacement record.
  -- Keep it in the key map so newly added units still resolve their parent.
  -- Validation and authorization above apply even to a preserved root.
  if pg_catalog.jsonb_array_length(report -> 'errors') = 0 then
    select item into node
    from pg_catalog.jsonb_array_elements(coalesce(p_payload #> '{charts,union,nodes}', '[]'::jsonb)) item
    where item ->> 'nodeKey' = 'cat.root';
    if node is not null then
      select n.id into preserved_root_id
      from public.organization_chart_nodes n
      where n.organization_id = org and n.chart_kind = 'union' and n.import_key = 'cat.root';
      if preserved_root_id is not null then
        -- Report only rows this import will write, in dry runs and commits.
        v_counts := v_counts || pg_catalog.jsonb_build_object(
          'chart_node', (v_counts ->> 'chart_node')::integer - 1,
          'chart_node_contact', (v_counts ->> 'chart_node_contact')::integer - pg_catalog.jsonb_array_length(coalesce(node -> 'contacts', '[]'::jsonb)),
          'chart_node_note', (v_counts ->> 'chart_node_note')::integer - pg_catalog.jsonb_array_length(coalesce(node -> 'notes', '[]'::jsonb)),
          'chart_node_metric', (v_counts ->> 'chart_node_metric')::integer - pg_catalog.jsonb_array_length(coalesce(node -> 'metrics', '[]'::jsonb)),
          'chart_cross_reference', (v_counts ->> 'chart_cross_reference')::integer - pg_catalog.jsonb_array_length(coalesce(node -> 'crossReferences', '[]'::jsonb))
        );
      end if;
    end if;

    -- Validate the chart this import leaves behind, not only the payload. The
    -- kept anchor keeps its saved parent and member, and rows the payload does
    -- not name keep theirs, so a dry run must refuse whatever the write would
    -- turn into a cycle or a unique-identity failure (gate round 3 on #4101).
    payload_nodes := pg_catalog.jsonb_build_object('union', '{}'::jsonb, 'agency', '{}'::jsonb);
    foreach kind in array array['union', 'agency'] loop
      if not (coalesce(p_payload -> 'charts', '{}'::jsonb) ? kind) then continue; end if;
      for idx in 0 .. pg_catalog.jsonb_array_length(((p_payload -> 'charts') -> kind) -> 'nodes') - 1 loop
        node := (((p_payload -> 'charts') -> kind) -> 'nodes') -> idx;
        payload_nodes := pg_catalog.jsonb_set(payload_nodes, array[kind, node ->> 'nodeKey'],
          pg_catalog.jsonb_build_object('parentKey', node -> 'parentKey', 'index', idx), true);
      end loop;
    end loop;

    -- Payload parents only name payload nodes, so a new cycle has to pass
    -- through the anchor's saved parent. Walk up from it: saved rows keep their
    -- saved parent until the walk meets a payload node, after which the
    -- payload decides every remaining parent.
    if preserved_root_id is not null then
      root_path := 'charts.union.nodes[' || (((payload_nodes -> 'union') -> 'cat.root') ->> 'index') || ']';
      select n.parent_id into walk_id from public.organization_chart_nodes n where n.id = preserved_root_id;
      walk_key := null;
      hops := 0;
      while walk_id is not null and hops < 64 loop
        if walk_id = preserved_root_id then
          report := pg_catalog.jsonb_set(report, array['errors'], private.org_structure_note(
            report -> 'errors', root_path, 'cycle', 'the saved chart already loops through cat.root'));
          exit;
        end if;
        select n.import_key into walk_key
        from public.organization_chart_nodes n
        where n.id = walk_id and n.organization_id = org and n.chart_kind = 'union';
        exit when walk_key is not null and (payload_nodes -> 'union') ? walk_key;
        walk_key := null;
        select n.parent_id into walk_id from public.organization_chart_nodes n where n.id = walk_id;
        hops := hops + 1;
      end loop;
      while walk_key is not null and hops < 64 loop
        node := (payload_nodes -> 'union') -> walk_key;
        if (node ->> 'parentKey') = 'cat.root' then
          report := pg_catalog.jsonb_set(report, array['errors'], private.org_structure_note(
            report -> 'errors', 'charts.union.nodes[' || (node ->> 'index') || '].parentKey', 'cycle',
            'cat.root is kept with its saved parent, so this parent would close a cycle'));
          exit;
        end if;
        walk_key := node ->> 'parentKey';
        hops := hops + 1;
      end loop;
      if hops >= 64 then
        report := pg_catalog.jsonb_set(report, array['errors'], private.org_structure_note(
          report -> 'errors', root_path, 'chain_too_deep', 'the saved parent chain above cat.root does not end'));
      end if;
    end if;

    -- A member stays bound to a kept row: report the clash instead of letting
    -- the write fail on the one-node-per-identity index.
    foreach kind in array array['union', 'agency'] loop
      if not (coalesce(p_payload -> 'charts', '{}'::jsonb) ? kind) then continue; end if;
      for idx in 0 .. pg_catalog.jsonb_array_length(((p_payload -> 'charts') -> kind) -> 'nodes') - 1 loop
        node := (((p_payload -> 'charts') -> kind) -> 'nodes') -> idx;
        if pg_catalog.jsonb_typeof(node -> 'memberUserId') is distinct from 'string' then continue; end if;
        if kind = 'union' and (node ->> 'nodeKey') = 'cat.root' and preserved_root_id is not null then continue; end if;
        if exists (
          select 1 from public.organization_chart_nodes n
          where n.organization_id = org and n.chart_kind = kind
            and n.user_id = (node ->> 'memberUserId')::uuid
            and (n.id = preserved_root_id or n.import_key is null
                 or not ((payload_nodes -> kind) ? n.import_key))
        ) then
          report := pg_catalog.jsonb_set(report, array['errors'], private.org_structure_note(
            report -> 'errors', 'charts.' || kind || '.nodes[' || idx || '].memberUserId', 'identity_in_use',
            'this member already holds a position this import keeps'));
        end if;
      end loop;
    end loop;
  end if;
  committed := false;
  audit_events := 0;
  import_id := null;

  if pg_catalog.jsonb_array_length(report -> 'errors') = 0 and not dry then
    begin
      attestation := p_payload -> 'attestation';
      keys := pg_catalog.jsonb_build_object('union', '{}'::jsonb, 'agency', '{}'::jsonb);

      -- Chapters first: a chapter node cannot reference a chapter row that does
      -- not exist yet.
      if p_payload ? 'chapters' then
        for idx in 0 .. pg_catalog.jsonb_array_length(p_payload -> 'chapters') - 1 loop
          entry := (p_payload -> 'chapters') -> idx;
          chapter_key := entry ->> 'chapterKey';
          chapter_row := null;
          select c.id into chapter_row
          from public.chapters c
          where c.organization_id = org and (c.slug = chapter_key or c.id = chapter_key)
          limit 1;
          if chapter_row is null then
            insert into public.chapters (
              id, name, region, is_default, order_index, organization_id, slug
            ) values (
              chapter_key, pg_catalog.btrim(entry ->> 'name'),
              nullif(pg_catalog.btrim(coalesce(entry ->> 'region', '')), ''),
              false, (entry ->> 'orderIndex')::integer, org, chapter_key
            );
          else
            update public.chapters set
              name = pg_catalog.btrim(entry ->> 'name'),
              region = nullif(pg_catalog.btrim(coalesce(entry ->> 'region', '')), ''),
              order_index = (entry ->> 'orderIndex')::integer
            where id = chapter_row and organization_id = org;
          end if;
        end loop;
      end if;

      -- Nodes, parents unset: a parent may appear after its child in the payload.
      foreach kind in array array['union', 'agency'] loop
        if not (coalesce(p_payload -> 'charts', '{}'::jsonb) ? kind) then continue; end if;
        for idx in 0 .. pg_catalog.jsonb_array_length(((p_payload -> 'charts') -> kind) -> 'nodes') - 1 loop
          node := (((p_payload -> 'charts') -> kind) -> 'nodes') -> idx;
          key_text := node ->> 'nodeKey';
          if kind = 'union' and key_text = 'cat.root' and preserved_root_id is not null then
            keys := pg_catalog.jsonb_set(keys, array[kind, key_text], pg_catalog.to_jsonb(preserved_root_id::text), true);
            continue;
          end if;
          chapter_row := null;
          if node ? 'chapterKey' and pg_catalog.jsonb_typeof(node -> 'chapterKey') <> 'null' then
            select c.id into chapter_row
            from public.chapters c
            where c.organization_id = org
              and (c.slug = (node ->> 'chapterKey') or c.id = (node ->> 'chapterKey'))
            limit 1;
          end if;
          v_node_id := null;
          select n.id into v_node_id
          from public.organization_chart_nodes n
          where n.organization_id = org and n.chart_kind = kind and n.import_key = key_text;
          if v_node_id is null then
            v_node_id := extensions.gen_random_uuid();
            insert into public.organization_chart_nodes (
              id, organization_id, chapter_id, chart_kind, node_kind, parent_id, label, subtitle,
              position_x, position_y, sort_order, created_by, updated_by, user_id, import_key,
              badge, role_class, vacant, collapsed_by_default, reports_to_label, chip_label,
              source_label, source_as_of
            ) values (
              v_node_id, org, chapter_row, kind, node ->> 'nodeKind', null,
              pg_catalog.btrim(node ->> 'label'),
              nullif(pg_catalog.btrim(coalesce(node ->> 'subtitle', '')), ''),
              0, 0, coalesce((node ->> 'sortOrder')::integer, idx), caller, caller,
              (node ->> 'memberUserId')::uuid, key_text,
              nullif(pg_catalog.btrim(coalesce(node ->> 'badge', '')), ''),
              node ->> 'roleClass',
              coalesce((node ->> 'vacant')::boolean, false),
              coalesce((node ->> 'collapsedByDefault')::boolean, false),
              nullif(pg_catalog.btrim(coalesce(node ->> 'reportsToLabel', '')), ''),
              nullif(pg_catalog.btrim(coalesce(node ->> 'chipLabel', '')), ''),
              nullif(pg_catalog.btrim(coalesce(node ->> 'sourceLabel', '')), ''),
              (node ->> 'sourceAsOf')::date
            );
          else
            update public.organization_chart_nodes set
              chapter_id = chapter_row,
              node_kind = node ->> 'nodeKind',
              label = pg_catalog.btrim(node ->> 'label'),
              subtitle = nullif(pg_catalog.btrim(coalesce(node ->> 'subtitle', '')), ''),
              sort_order = coalesce((node ->> 'sortOrder')::integer, idx),
              user_id = (node ->> 'memberUserId')::uuid,
              badge = nullif(pg_catalog.btrim(coalesce(node ->> 'badge', '')), ''),
              role_class = node ->> 'roleClass',
              vacant = coalesce((node ->> 'vacant')::boolean, false),
              collapsed_by_default = coalesce((node ->> 'collapsedByDefault')::boolean, false),
              reports_to_label = nullif(pg_catalog.btrim(coalesce(node ->> 'reportsToLabel', '')), ''),
              chip_label = nullif(pg_catalog.btrim(coalesce(node ->> 'chipLabel', '')), ''),
              source_label = nullif(pg_catalog.btrim(coalesce(node ->> 'sourceLabel', '')), ''),
              source_as_of = (node ->> 'sourceAsOf')::date,
              updated_by = caller,
              updated_at = pg_catalog.now()
            where id = v_node_id and organization_id = org;
          end if;
          keys := pg_catalog.jsonb_set(keys, array[kind, key_text], pg_catalog.to_jsonb(v_node_id::text), true);
        end loop;
      end loop;

      -- Parents, then the rows that belong to a node. A node's contacts, notes
      -- and metrics are replaced wholesale: the payload is the record of what
      -- the organization publishes, so withdrawing a contact is an import away.
      foreach kind in array array['union', 'agency'] loop
        if not (coalesce(p_payload -> 'charts', '{}'::jsonb) ? kind) then continue; end if;
        for idx in 0 .. pg_catalog.jsonb_array_length(((p_payload -> 'charts') -> kind) -> 'nodes') - 1 loop
          node := (((p_payload -> 'charts') -> kind) -> 'nodes') -> idx;
          v_node_id := ((keys -> kind) ->> (node ->> 'nodeKey'))::uuid;
          -- Do not detach the anchor or replace its contacts, notes or metrics.
          if kind = 'union' and v_node_id = preserved_root_id then continue; end if;
          if node ? 'parentKey' and pg_catalog.jsonb_typeof(node -> 'parentKey') <> 'null' then
            update public.organization_chart_nodes
            set parent_id = ((keys -> kind) ->> (node ->> 'parentKey'))::uuid,
                updated_by = caller,
                updated_at = pg_catalog.now()
            where id = v_node_id and organization_id = org;
          else
            update public.organization_chart_nodes
            set parent_id = null, updated_by = caller, updated_at = pg_catalog.now()
            where id = v_node_id and organization_id = org;
          end if;

          delete from public.organization_chart_node_contacts where organization_id = org and node_id = v_node_id;
          delete from public.organization_chart_node_notes where organization_id = org and node_id = v_node_id;
          delete from public.organization_chart_node_metrics where organization_id = org and node_id = v_node_id;

          if node ? 'contacts' then
            for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'contacts') - 1 loop
              child := (node -> 'contacts') -> jdx;
              insert into public.organization_chart_node_contacts (
                organization_id, node_id, contact_kind, contact_value, dial_href,
                confirmation_state, contact_visibility, is_personal_address, consent_source, sort_order
              ) values (
                org, v_node_id, child ->> 'contactKind', pg_catalog.btrim(child ->> 'contactValue'),
                nullif(pg_catalog.btrim(coalesce(child ->> 'dialHref', '')), ''),
                coalesce(child ->> 'confirmationState', 'unconfirmed'),
                coalesce(child ->> 'contactVisibility', 'staff'),
                coalesce((child ->> 'isPersonalAddress')::boolean, false),
                nullif(pg_catalog.btrim(coalesce(child ->> 'consentSource', '')), ''),
                coalesce((child ->> 'sortOrder')::integer, jdx)
              );
            end loop;
          end if;
          if node ? 'notes' then
            for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'notes') - 1 loop
              child := (node -> 'notes') -> jdx;
              insert into public.organization_chart_node_notes (
                organization_id, node_id, note_kind, body, sort_order
              ) values (
                org, v_node_id, coalesce(child ->> 'noteKind', 'note'),
                pg_catalog.btrim(child ->> 'body'),
                coalesce((child ->> 'sortOrder')::integer, jdx)
              );
            end loop;
          end if;
          if node ? 'metrics' then
            for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'metrics') - 1 loop
              child := (node -> 'metrics') -> jdx;
              insert into public.organization_chart_node_metrics (
                organization_id, node_id, metric_key, metric_label, metric_value, metric_unit, sort_order
              ) values (
                org, v_node_id, child ->> 'metricKey',
                nullif(pg_catalog.btrim(coalesce(child ->> 'metricLabel', '')), ''),
                (child ->> 'metricValue')::numeric,
                child ->> 'metricUnit',
                coalesce((child ->> 'sortOrder')::integer, jdx)
              );
            end loop;
          end if;
        end loop;
      end loop;

      -- Cross-references last among the node rows: a tag may point at a node of
      -- the other chart, which only exists once both charts are written.
      foreach kind in array array['union', 'agency'] loop
        if not (coalesce(p_payload -> 'charts', '{}'::jsonb) ? kind) then continue; end if;
        for idx in 0 .. pg_catalog.jsonb_array_length(((p_payload -> 'charts') -> kind) -> 'nodes') - 1 loop
          node := (((p_payload -> 'charts') -> kind) -> 'nodes') -> idx;
          v_node_id := ((keys -> kind) ->> (node ->> 'nodeKey'))::uuid;
          if kind = 'union' and v_node_id = preserved_root_id then continue; end if;
          delete from public.organization_chart_cross_references
          where organization_id = org and node_id = v_node_id;
          if node ? 'crossReferences' then
            for jdx in 0 .. pg_catalog.jsonb_array_length(node -> 'crossReferences') - 1 loop
              child := (node -> 'crossReferences') -> jdx;
              target_id := null;
              if child ? 'targetNodeKey' and pg_catalog.jsonb_typeof(child -> 'targetNodeKey') <> 'null' then
                target_id := ((keys -> (case when kind = 'union' then 'agency' else 'union' end))
                  ->> (child ->> 'targetNodeKey'))::uuid;
              end if;
              insert into public.organization_chart_cross_references (
                organization_id, node_id, target_node_id, reference_kind, label, sort_order
              ) values (
                org, v_node_id, target_id, child ->> 'referenceKind',
                pg_catalog.btrim(child ->> 'label'),
                coalesce((child ->> 'sortOrder')::integer, jdx)
              );
            end loop;
          end if;
        end loop;
      end loop;

      -- Reference tabs. A section's block tree is replaced wholesale.
      if p_payload ? 'referenceSections' then
        for idx in 0 .. pg_catalog.jsonb_array_length(p_payload -> 'referenceSections') - 1 loop
          entry := (p_payload -> 'referenceSections') -> idx;
          v_section_id := null;
          select s.id into v_section_id
          from public.organization_reference_sections s
          where s.organization_id = org
            and s.chart_kind = (entry ->> 'chartKind')
            and s.section_key = (entry ->> 'sectionKey');
          if v_section_id is null then
            v_section_id := extensions.gen_random_uuid();
            insert into public.organization_reference_sections (
              id, organization_id, chart_kind, section_key, tab_label, panel_title,
              sort_order, source_label, source_as_of
            ) values (
              v_section_id, org, entry ->> 'chartKind', entry ->> 'sectionKey',
              pg_catalog.btrim(entry ->> 'tabLabel'),
              nullif(pg_catalog.btrim(coalesce(entry ->> 'panelTitle', '')), ''),
              coalesce((entry ->> 'sortOrder')::integer, idx),
              nullif(pg_catalog.btrim(coalesce(entry ->> 'sourceLabel', '')), ''),
              (entry ->> 'sourceAsOf')::date
            );
          else
            update public.organization_reference_sections set
              tab_label = pg_catalog.btrim(entry ->> 'tabLabel'),
              panel_title = nullif(pg_catalog.btrim(coalesce(entry ->> 'panelTitle', '')), ''),
              sort_order = coalesce((entry ->> 'sortOrder')::integer, idx),
              source_label = nullif(pg_catalog.btrim(coalesce(entry ->> 'sourceLabel', '')), ''),
              source_as_of = (entry ->> 'sourceAsOf')::date,
              updated_at = pg_catalog.now()
            where id = v_section_id and organization_id = org;
            delete from public.organization_reference_blocks
            where organization_id = org and section_id = v_section_id;
          end if;
          perform private.org_structure_write_blocks(
            org, v_section_id, null, coalesce(entry -> 'blocks', '[]'::jsonb), 0);
        end loop;
      end if;

      -- Timeline events, including the organization's attributed payroll rows.
      if p_payload ? 'timelineEvents' then
        for idx in 0 .. pg_catalog.jsonb_array_length(p_payload -> 'timelineEvents') - 1 loop
          entry := (p_payload -> 'timelineEvents') -> idx;
          v_node_id := null;
          if entry ? 'nodeKey' and pg_catalog.jsonb_typeof(entry -> 'nodeKey') <> 'null' then
            v_node_id := ((keys -> (entry ->> 'chartKind')) ->> (entry ->> 'nodeKey'))::uuid;
          end if;
          chapter_row := null;
          if entry ? 'chapterKey' and pg_catalog.jsonb_typeof(entry -> 'chapterKey') <> 'null' then
            select c.id into chapter_row
            from public.chapters c
            where c.organization_id = org
              and (c.slug = (entry ->> 'chapterKey') or c.id = (entry ->> 'chapterKey'))
            limit 1;
          end if;
          delete from public.organization_timeline_events
          where organization_id = org and import_key = (entry ->> 'importKey');
          insert into public.organization_timeline_events (
            organization_id, chapter_id, node_id, import_key, event_kind, title, detail,
            effective_on, ended_on, amount_cents, amount_basis, secondary_amount_cents,
            partial_period, visibility, source_label, source_as_of, created_by, updated_by
          ) values (
            org, chapter_row, v_node_id, entry ->> 'importKey', entry ->> 'eventKind',
            pg_catalog.btrim(entry ->> 'title'),
            nullif(pg_catalog.btrim(coalesce(entry ->> 'detail', '')), ''),
            (entry ->> 'effectiveOn')::date, (entry ->> 'endedOn')::date,
            (entry ->> 'amountCents')::bigint,
            nullif(pg_catalog.btrim(coalesce(entry ->> 'amountBasis', '')), ''),
            (entry ->> 'secondaryAmountCents')::bigint,
            coalesce((entry ->> 'partialPeriod')::boolean, false),
            coalesce(entry ->> 'visibility', 'staff'),
            nullif(pg_catalog.btrim(coalesce(entry ->> 'sourceLabel', '')), ''),
            (entry ->> 'sourceAsOf')::date, caller, caller
          );
        end loop;
      end if;

      -- The ledger row is the attestation: who supplied this content, when, and
      -- under what authority the organization publishes it.
      import_id := extensions.gen_random_uuid();
      insert into public.organization_structure_imports (
        id, organization_id, schema_version, selected_hat, supplied_by, supplied_on,
        authority, personal_contact_consent, consent_note, sources, counts, actor_user_id
      ) values (
        import_id, org, p_payload ->> 'schemaVersion', p_selected_hat,
        pg_catalog.btrim(attestation ->> 'suppliedBy'),
        (attestation ->> 'suppliedOn')::date,
        pg_catalog.btrim(attestation ->> 'authority'),
        attestation ->> 'personalContactConsent',
        nullif(pg_catalog.btrim(coalesce(attestation ->> 'consentNote', '')), ''),
        coalesce(p_payload -> 'sources', '[]'::jsonb), v_counts, caller
      );

      -- One counted audit event per entity kind this run wrote.
      foreach entity in array array[
        'chapter', 'chart_node', 'chart_node_contact', 'chart_node_note',
        'chart_node_metric', 'chart_cross_reference', 'reference_section',
        'reference_block', 'timeline_event'
      ] loop
        if coalesce((v_counts ->> entity)::integer, 0) > 0 then
          perform private.write_organization_intelligence_audit(
            org, 'structure_imported', entity, import_id::text,
            pg_catalog.jsonb_build_object('rowCount', (v_counts ->> entity)::integer, 'importId', import_id::text)
          );
          audit_events := audit_events + 1;
        end if;
      end loop;
      committed := true;
    exception when others then
      -- Nothing above survives: the block is one subtransaction, so a late
      -- constraint failure takes every row of this run with it.
      committed := false;
      import_id := null;
      audit_events := 0;
      report := pg_catalog.jsonb_set(report, array['errors'], private.org_structure_note(
        report -> 'errors', '', 'write_refused',
        'the import was refused while writing and nothing was written (' || sqlstate || ')'));
    end;
  end if;

  return pg_catalog.jsonb_build_object(
    'schemaVersion', 'org-structure/1',
    'organizationId', org,
    'importId', import_id,
    'dryRun', dry,
    'committed', committed,
    'generatedAt', pg_catalog.now(),
    'counts', v_counts,
    'identity', report -> 'identity',
    'errors', report -> 'errors',
    'warnings', report -> 'warnings',
    'auditEvents', audit_events
  );
end;
end;
$function$;

revoke all on function public.import_organization_structure(text, jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.import_organization_structure(text, jsonb, boolean) to authenticated;
commit;
