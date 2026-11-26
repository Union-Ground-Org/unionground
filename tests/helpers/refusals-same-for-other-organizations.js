// SEC-UG-NON-INTERFERENCE-REFUSALS-REVEAL-OTHER-ORGANIZATIONS-OBJECTS-20261111
// (#8365) re-emits 17 functions from their live bodies with only the edits
// below. History tests that pin a function's newest body compare it, with
// those edits undone, to the body they already expect.
export const SAME_REFUSALS_MIGRATION = "20261112213500_refusals_same_for_other_organizations.sql";

// A strict lookup became a plain one followed by its named not-found refusal.
const LOOKUP = /\binto ((?:(?!\binto\b)[^;])*;) if not found then raise exception '[^']*' using errcode = 'P0002'; end if;/g;

const EDITS = {
  // The row check refuses with 42501, as the visibility check before it does.
  "private.coordinator_case_for_update": [["  if found.id is null then raise exception 'case unavailable' using errcode = '42501'; end if;",
    "  if found.id is null then raise exception 'case unavailable' using errcode = '22023'; end if;"]],
  // A member outside the caller's scope reads as a missing case.
  "public.assign_member_case": [["\n    raise exception 'case not found' using errcode = 'P0002';",
    "\n    raise exception 'member outside your scope' using errcode = '42501';"]],
  // The partner must already be visible to the caller
  // .
  "public.create_organization_coordination_record": [[`  -- An unverified organization cannot take a partner (its boundary trigger
  -- refuses the insert too); this refuses before the partner is looked at, so
  -- the answer is the same for every partner id.
  if resolved_partner is not null and not private.organization_clears_signup_boundary(organization) then
    raise exception 'organization verification required' using errcode = '42501';
  end if;
`, ""], [`
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
      ),
      false
    )`, ""]],
  // The token epoch is a fingerprint of what the caller can see
  // .
  "public.list_chapter_connection_profiles": [[`  if p_snapshot_token is null then
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.now()))::double precision);
  else
    if p_snapshot_token !~ '^[0-9]{1,18}:[0-9]{1,12}:[a-f0-9]{32}$' then
      raise exception 'connection registry snapshot token invalid' using errcode = '22023';
    end if;
    token_epoch := pg_catalog.split_part(p_snapshot_token, ':', 1)::bigint;
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.split_part(p_snapshot_token, ':', 2)::double precision);
    if pg_catalog.split_part(p_snapshot_token, ':', 3) <> scope_hash then
      raise exception 'connection registry snapshot scope changed' using errcode = '22023';
    end if;
  end if;
  -- The epoch is a fingerprint of every row the list may return at the
  -- snapshot time, cursor and limit aside: the same filters as the page below,
  -- so a profile or hide the caller cannot observe never moves it.
  select ('x' || pg_catalog.substr(pg_catalog.md5(coalesce(pg_catalog.string_agg(visible.fingerprint, '|' order by visible.fingerprint collate "C"), '')), 1, 14))::bit(56)::bigint
    into current_epoch
  from (
    select p.chapter_id || ':' || private.chapter_connection_profile_projection(p, c.name)::text as fingerprint
    from private.chapter_connection_profiles p
    join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
    join public.organizations o on o.id = p.organization_id and o.status = 'active' and o.kind = 'union'
    where p.publication_status = 'published'
      and (p.organization_id = org or private.organization_visible_in_directory(p.organization_id))
      and p.expires_at > snapshot_at
      and p.chapter_id <> viewer_chapter
      and private.organization_clears_signup_boundary(org)
      and not exists (
        select 1 from private.chapter_connection_hides h
        where (h.chapter_id = viewer_chapter and h.hidden_chapter_id = p.chapter_id)
           or (h.chapter_id = p.chapter_id and h.hidden_chapter_id = viewer_chapter)
      )
  ) visible;
  current_epoch := coalesce(current_epoch, 1);
  if p_snapshot_token is not null then
    -- An expired token is refused as expired whatever has changed since, so
    -- the order of the two refusals reveals nothing.
    if snapshot_at > pg_catalog.now() + interval '1 minute'
       or snapshot_at < pg_catalog.now() - interval '1 hour' then
      raise exception 'connection registry snapshot expired' using errcode = '22023';
    end if;
    if token_epoch <> current_epoch then
      raise exception 'connection registry snapshot changed' using errcode = '22023';
    end if;
  end if;
`,
    `  select e.epoch into current_epoch from private.chapter_connection_registry_epoch e where e.singleton;
  current_epoch := coalesce(current_epoch, 1);

  if p_snapshot_token is null then
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.now()))::double precision);
  else
    if p_snapshot_token !~ '^[0-9]{1,18}:[0-9]{1,12}:[a-f0-9]{32}$' then
      raise exception 'connection registry snapshot token invalid' using errcode = '22023';
    end if;
    token_epoch := pg_catalog.split_part(p_snapshot_token, ':', 1)::bigint;
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.split_part(p_snapshot_token, ':', 2)::double precision);
    if pg_catalog.split_part(p_snapshot_token, ':', 3) <> scope_hash then
      raise exception 'connection registry snapshot scope changed' using errcode = '22023';
    end if;
    if token_epoch <> current_epoch then
      raise exception 'connection registry snapshot changed' using errcode = '22023';
    end if;
    if snapshot_at > pg_catalog.now() + interval '1 minute'
       or snapshot_at < pg_catalog.now() - interval '1 hour' then
      raise exception 'connection registry snapshot expired' using errcode = '22023';
    end if;
  end if;
`]],
};

// The newest body of `name` (schema-qualified) with #8365's edits undone.
export function beforeSameRefusals(name, source) {
  const edits = EDITS[name];
  if (!edits) return source.replace(LOOKUP, "into strict $1");
  let text = source;
  for (const [after, before] of edits) {
    if (!text.includes(after)) throw new Error(`${name}: an #8365 edit is missing`);
    text = text.replace(after, () => before);
  }
  return text;
}
