-- BUG-UG-COALITION-OWNER-CANNOT-NAME-AN-ACCEPTED-PARTICIPANT-AS-PARTNER-20261115 (#8775).
--
-- public.create_organization_coordination_record accepts a partner the caller
-- already knows (20261112213500, #8365): one it can discover in the network
-- directory, the owner or partner of a coordination record it can read, or an
-- organization an existing record pairs it with. An organization that accepted
-- a coalition can name the coalition's owner that way, but the owner could not
-- name the accepted participant in return: the guard never read participant
-- rows, so the owner got 'partner organization unavailable'.
--
-- The partner check now also accepts an organization with an active
-- (accepted) participant row on a coordination record the caller's
-- organization owns. An invited, declined or revoked row does not count, so
-- such an organization is refused exactly as a missing one, with the same
-- code and message. The body is the live definition from 20261112213500 with
-- only that clause added; grants are unchanged by CREATE OR REPLACE.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.create_organization_coordination_record(p_kind text, p_title text, p_summary text DEFAULT ''::text, p_visibility text DEFAULT 'staff'::text, p_partner_organization_id uuid DEFAULT NULL::uuid, p_parent_id uuid DEFAULT NULL::uuid, p_chapter_id text DEFAULT NULL::text, p_config jsonb DEFAULT '{}'::jsonb, p_idempotency_key uuid DEFAULT extensions.gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  created public.organization_coordination_records%rowtype;
  parent_item public.organization_coordination_records%rowtype;
  resolved_partner uuid := p_partner_organization_id;
  handshake_id uuid;
  initial_status text := 'draft';
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
     or not private.organization_coordination_is_staff(organization) then
    raise exception 'organization staff role required' using errcode = '42501';
  end if;
  if p_kind not in (
    'mission', 'mission_objective', 'network_link', 'network_conversation',
    'network_request', 'network_export_schedule', 'handshake_workspace_item',
    'coalition', 'coalition_campaign', 'coalition_work_item', 'merger_plan',
    'microsite_page', 'coverage_schedule', 'coverage_override', 'committee',
    'mobilization_campaign', 'mobilization_cohort'
  ) then
    raise exception 'unsupported coordination record kind' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_config, '{}'::jsonb)) <> 'object'
     or pg_catalog.octet_length(coalesce(p_config, '{}'::jsonb)::text) > 12000 then
    raise exception 'coordination config unavailable' using errcode = '22023';
  end if;
  if p_parent_id is not null then
    select * into parent_item
    from public.organization_coordination_records r
    where r.id = p_parent_id;
    if not found or not private.organization_coordination_can_read(parent_item.id) then
      raise exception 'coordination parent unavailable' using errcode = '22023';
    end if;
    if resolved_partner is null then
      resolved_partner := case
        when parent_item.organization_id = organization then parent_item.partner_organization_id
        else parent_item.organization_id
      end;
    end if;
  end if;
  -- An unverified organization cannot take a partner (its boundary trigger
  -- refuses the insert too); this refuses before the partner is looked at, so
  -- the answer is the same for every partner id.
  if resolved_partner is not null and not private.organization_clears_signup_boundary(organization) then
    raise exception 'organization verification required' using errcode = '42501';
  end if;
  if resolved_partner is not null and (
    resolved_partner = organization
    or not exists (
      select 1 from public.organizations o
      where o.id = resolved_partner and o.status = 'active'
    )
    or not coalesce(
      private.organization_network_can_discover(resolved_partner)
      -- The owner or partner of a coordination record the caller may read (a
      -- parent, or a coalition it joined as an accepted participant) is
      -- already known to it, whether named or taken from a parent.
      or exists (
        select 1 from public.organization_coordination_records readable
        where (readable.organization_id = resolved_partner or readable.partner_organization_id = resolved_partner)
          and private.organization_coordination_can_read(readable.id)
      )
      or exists (
        select 1 from public.organization_coordination_records known
        where (known.organization_id = organization and known.partner_organization_id = resolved_partner)
           or (known.organization_id = resolved_partner and known.partner_organization_id = organization)
      )
      -- #8775: an organization that accepted a coordination record this
      -- organization owns (an active participant row, such as a coalition it
      -- joined) is known to the owner, as the owner is known to it. Invited,
      -- declined and revoked rows do not count.
      or exists (
        select 1
        from public.organization_coordination_records owned
        join public.organization_coordination_organization_participants accepted
          on accepted.record_id = owned.id
        where owned.organization_id = organization
          and accepted.organization_id = resolved_partner
          and accepted.status = 'active'
      ),
      false
    )
  ) then
    raise exception 'partner organization unavailable' using errcode = '22023';
  end if;
  if p_chapter_id is not null and not exists (
    select 1 from public.chapters c
    where c.id = p_chapter_id and c.organization_id = organization
  ) then
    raise exception 'chapter unavailable' using errcode = '22023';
  end if;
  if p_kind in ('network_link', 'merger_plan') and resolved_partner is null then
    raise exception 'partner organization required' using errcode = '22023';
  end if;
  if p_kind = 'microsite_page' and p_chapter_id is null then
    raise exception 'chapter required for microsite page' using errcode = '22023';
  end if;
  if p_kind = 'handshake_workspace_item' then
    begin
      handshake_id := nullif(p_config ->> 'handshakeId', '')::uuid;
    exception when invalid_text_representation then
      handshake_id := null;
    end;
    if handshake_id is null or not exists (
      select 1
      from public.chapter_handshakes h
      join public.chapters c on c.id in (h.chapter_id, h.receiving_chapter_id)
      where h.id = handshake_id and h.status = 'active'
        and c.organization_id = organization
    ) then
      raise exception 'active chapter handshake required' using errcode = '22023';
    end if;
  end if;
  if p_kind in ('mission', 'coalition', 'committee', 'mobilization_campaign') then
    initial_status := 'active';
  elsif p_kind in ('network_link', 'merger_plan') then
    initial_status := 'requested';
  elsif p_kind = 'microsite_page' then
    initial_status := 'draft';
  end if;

  insert into public.organization_coordination_records (
    organization_id, partner_organization_id, chapter_id, parent_id, kind,
    title, summary, status, visibility, config, created_by, idempotency_key
  ) values (
    organization, resolved_partner, p_chapter_id, p_parent_id, p_kind,
    pg_catalog.btrim(p_title), coalesce(p_summary, ''), initial_status,
    p_visibility, coalesce(p_config, '{}'::jsonb), caller, p_idempotency_key
  )
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into created;

  if created.organization_id <> organization then
    raise exception 'idempotency key unavailable' using errcode = '42501';
  end if;

  insert into public.organization_coordination_organization_participants (
    record_id, organization_id, role, status, invited_by, responded_by
  ) values (created.id, organization, 'owner', 'active', caller, caller)
  on conflict (record_id, organization_id) do nothing;

  if created.partner_organization_id is not null then
    insert into public.organization_coordination_organization_participants (
      record_id, organization_id, role, status, invited_by
    ) values (created.id, created.partner_organization_id, 'partner', 'invited', caller)
    on conflict (record_id, organization_id) do nothing;
  end if;

  if p_parent_id is not null then
    insert into public.organization_coordination_organization_participants (
      record_id, organization_id, role, status, invited_by, responded_by
    )
    select created.id, participant.organization_id,
      case when participant.organization_id = organization then 'owner' else 'member' end,
      participant.status, caller,
      case when participant.status = 'active' then caller else null end
    from public.organization_coordination_organization_participants participant
    where participant.record_id = p_parent_id
      and participant.status in ('active', 'invited')
    on conflict (record_id, organization_id) do nothing;
  end if;

  insert into public.organization_coordination_events (
    record_id, organization_id, actor_user_id, event_type, to_status,
    metadata, idempotency_key
  ) values (
    created.id, organization, caller, 'record_created', created.status,
    pg_catalog.jsonb_build_object('kind', created.kind),
    extensions.gen_random_uuid()
  );

  return pg_catalog.jsonb_build_object(
    'id', created.id, 'kind', created.kind, 'status', created.status,
    'organizationId', created.organization_id
  );
end;
end;
$function$;

notify pgrst, 'reload schema';

commit;
