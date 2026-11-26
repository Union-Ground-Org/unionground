-- REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031
-- (#6672, owner request, Oct 31, 2026).
--
-- A chapter can reach a partner office that is in the public union_orgs
-- catalogue but has no chapter on Union Ground yet:
--
-- 1. public.list_partner_offices_not_on_platform: catalogue organizations with
--    no verified chapter binding, marked as not yet on the platform, matched
--    to the caller's published connection profile (same state first, then
--    shared sector) or to a name search. Public catalogue fields only, plus
--    the caller's own open offer and pending invitation for each office.
-- 2. private.chapter_handshake_offers: a standing handshake offer bound to a
--    catalogue organization (title, purpose and data scope as a handshake
--    request), open with no counterpart. At most 10 open offers per chapter
--    and one per office; each expires 90 days after it is made, and the
--    offering chapter can withdraw it. It holds no member data, and nothing
--    about it is visible to the unclaimed office.
-- 3. Arrival: when an office's chapter binding becomes verified by a platform
--    operator (an active private.compass_platform_operators row), each open,
--    unexpired offer for that office becomes an ordinary two-sided handshake request
--    (public.chapter_handshakes, status requested) to the arriving chapter,
--    whose staff are notified, and the offering chapter's staff are notified
--    that it was delivered. Nothing is accepted for anyone: the arriving
--    chapter accepts or declines with public.respond_chapter_handshake and
--    countersigns with public.countersign_chapter_handshake, which notify the
--    offering chapter as they always have. A binding a tenant administrator
--    verified for their own chapter delivers nothing and leaves the offers
--    open; an operator who has confirmed that the chapter really is that
--    office delivers them with public.deliver_standing_handshake_offers.
-- 4. private.chapter_partner_invitation_requests: a chapter administrator's
--    request that Union Ground invite a named contact at that office. Only the
--    operator can start an organization (AGENTS.md, invitation-only accounts),
--    so the request waits for the operator, who sends it through the founder
--    invitation (scripts/invite-organization-founder.mjs from-request, which
--    calls public.create_organization_founder_invitation with its own limits,
--    audit and 15-minute expiry). The service-role
--    public.take_partner_invitation_request hands the operator the contact,
--    the office, the inviting chapter and the offered handshake, and
--    public.finish_partner_invitation_request records the outcome and erases
--    the contact's name and address. At most 5 pending requests per chapter
--    and one per office.
--
-- Every public function is SECURITY DEFINER with an empty search_path; the
-- chapter routines derive the organization from the session
-- (private.mi1_require_selected_organization: authentication, two-step
-- sign-in, active membership), require the selected hat as an exact advisor,
-- admin or vp grant on the chapter (staff hats may read), and take the
-- case-graph gate first when they write. The tables FORCE row level security
-- and carry no client grant. Each write lands one content-free row in the
-- organization audit ledger.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.chapter_handshake_offers (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  union_org_id text not null references public.union_orgs(id) on update cascade on delete cascade,
  title text not null check (pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 160),
  purpose text not null check (pg_catalog.char_length(pg_catalog.btrim(purpose)) between 1 and 4000),
  data_scope text not null check (data_scope in ('docs_only', 'no_member_data', 'aggregate_only')),
  status text not null default 'open' check (status in ('open', 'delivered', 'withdrawn')),
  expires_at timestamptz not null,
  idempotency_key uuid not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  delivered_handshake_id uuid references public.chapter_handshakes(id) on delete set null,
  delivered_at timestamptz,
  withdrawn_at timestamptz,
  -- Set only by private.deliver_chapter_handshake_offers for the one offer it
  -- is turning into a handshake, inside that transaction, and cleared with it.
  delivering_txid bigint,
  constraint chapter_handshake_offers_state check (
    (status = 'open' and delivered_at is null and withdrawn_at is null)
    or (status = 'delivered' and delivered_at is not null and withdrawn_at is null)
    or (status = 'withdrawn' and withdrawn_at is not null and delivered_at is null)
  )
);
create unique index chapter_handshake_offers_one_open
  on private.chapter_handshake_offers (chapter_id, union_org_id) where status = 'open';
create index chapter_handshake_offers_office_idx
  on private.chapter_handshake_offers (union_org_id) where status = 'open';
create index chapter_handshake_offers_creator_idx on private.chapter_handshake_offers (created_by);
create index chapter_handshake_offers_organization_idx on private.chapter_handshake_offers (organization_id);
create index chapter_handshake_offers_handshake_idx on private.chapter_handshake_offers (delivered_handshake_id);
alter table private.chapter_handshake_offers enable row level security;
alter table private.chapter_handshake_offers force row level security;
revoke all on private.chapter_handshake_offers from public, anon, authenticated, service_role;
comment on table private.chapter_handshake_offers is
  'REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031: a chapter''s standing handshake offer to a catalogue organization with no verified chapter yet. No member data. Read and written only through the chapter offer routines; delivered as a handshake request when the office''s chapter binding is verified.';

create table private.chapter_partner_invitation_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  union_org_id text not null references public.union_orgs(id) on update cascade on delete cascade,
  offer_id uuid references private.chapter_handshake_offers(id) on delete set null,
  contact_name text,
  contact_email text,
  locale text not null check (locale in ('en', 'es')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'declined', 'cancelled')),
  idempotency_key uuid not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  decided_at timestamptz,
  -- The latest founder invitation the operator issued for this request. A
  -- resend supersedes an invitation with a new id, so a rerun resends this
  -- one rather than the first. No foreign key: the invitation row is the
  -- founder flow's own record.
  founder_invitation_id uuid,
  -- The contact's name and address are kept only while the request waits.
  constraint chapter_partner_invitation_requests_contact check (
    (status = 'pending' and decided_at is null
      and pg_catalog.char_length(contact_name) between 2 and 120 and contact_name !~ '[[:cntrl:]<>]'
      and pg_catalog.char_length(contact_email) between 3 and 254
      and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
    or (status <> 'pending' and decided_at is not null and contact_name is null and contact_email is null)
  )
);
create unique index chapter_partner_invitation_requests_one_pending
  on private.chapter_partner_invitation_requests (chapter_id, union_org_id) where status = 'pending';
create index chapter_partner_invitation_requests_pending_idx
  on private.chapter_partner_invitation_requests (created_at) where status = 'pending';
create index chapter_partner_invitation_requests_creator_idx on private.chapter_partner_invitation_requests (created_by);
create index chapter_partner_invitation_requests_organization_idx on private.chapter_partner_invitation_requests (organization_id);
create index chapter_partner_invitation_requests_offer_idx on private.chapter_partner_invitation_requests (offer_id);
alter table private.chapter_partner_invitation_requests enable row level security;
alter table private.chapter_partner_invitation_requests force row level security;
revoke all on private.chapter_partner_invitation_requests from public, anon, authenticated, service_role;
comment on table private.chapter_partner_invitation_requests is
  'REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031: a chapter administrator''s request that the operator invite a named contact at a catalogue office through the founder invitation. The contact''s name and address are erased when the operator records the outcome.';

create trigger a00_case_graph_lock before insert or update or delete on private.chapter_handshake_offers
for each statement execute function private.lock_case_graph_statement();
create or replace trigger z99_case_graph_keys before insert or update or delete on private.chapter_handshake_offers
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_partner_invitation_requests
for each statement execute function private.lock_case_graph_statement();
create or replace trigger z99_case_graph_keys before insert or update or delete on private.chapter_partner_invitation_requests
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');

insert into private.account_lifecycle_manifest(schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note) values
 ('private','chapter_handshake_offers','created_by','pseudonymize','excluded_with_reason','auth_user_fk','Chapter-owned partnership offer accountability, not content authored for the member.','Creator detached on account deletion; an undelivered offer with no creator is not delivered.'),
 ('private','chapter_partner_invitation_requests','created_by','pseudonymize','excluded_with_reason','auth_user_fk','Chapter-owned invitation request accountability, not member content.','Requester detached on account deletion.');

-- ---------------------------------------------------------------------------
-- Shared checks
-- ---------------------------------------------------------------------------

-- An office is on the platform once some chapter's binding to it is verified.
create function private.partner_office_on_platform(p_union_org_id text)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (select 1 from public.chapter_union_org_bindings b
    where b.union_org_id = p_union_org_id and b.status = 'verified');
$function$;
revoke all on function private.partner_office_on_platform(text) from public, anon, authenticated, service_role;

-- The selected chapter of the caller's organization under a hat the chapter
-- grants. Writes need the selected chapter itself, as handshake requests do.
create function private.partner_offer_chapter(p_selected_hat text, p_chapter_id text, p_hats text[], p_write boolean)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
begin
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter, p_hats);
  if p_write and (chapter is distinct from private.current_member_chapter()
      or not private.member_has_chapter_role(chapter, array[p_selected_hat])) then
    raise exception 'select the chapter before making an offer' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object('organization', org, 'chapter', chapter);
end;
$function$;
revoke all on function private.partner_offer_chapter(text, text, text[], boolean) from public, anon, authenticated, service_role;

-- A catalogue office this chapter may reach: visible, not fictional unless the
-- caller may see fictional entries, and not yet on the platform.
create function private.partner_office_offerable(p_union_org_id text)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (select 1 from public.union_orgs u where u.id = p_union_org_id)
    and private.catalog_registry_identity_visible(p_union_org_id)
    and not private.partner_office_on_platform(p_union_org_id);
$function$;
revoke all on function private.partner_office_offerable(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

create function public.list_partner_offices_not_on_platform(
  p_selected_hat text, p_chapter_id text, p_query text default null, p_limit integer default 25, p_offset integer default 0
)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  scope jsonb;
  chapter text;
  profile_state text;
  profile_sectors text[];
  clean_query text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
  terms text[];
  size integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  skip integer := greatest(coalesce(p_offset, 0), 0);
  page jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  scope := private.partner_offer_chapter(p_selected_hat, p_chapter_id, array['steward','coordinator','advisor','admin','vp'], false);
  chapter := scope ->> 'chapter';
  if clean_query is not null and pg_catalog.char_length(clean_query) not between 2 and 80 then
    raise exception 'invalid query' using errcode = '22023';
  end if;
  -- Every word of a search must appear in the office's name, affiliation,
  -- designation, local number or city: names repeat heavily across locals.
  terms := case when clean_query is null then '{}'::text[] else pg_catalog.regexp_split_to_array(clean_query, '[[:space:]]+') end;
  select p.location_state, p.sector_keys into profile_state, profile_sectors
  from private.chapter_connection_profiles p where p.chapter_id = chapter;
  -- Without a search the list is the offices in the profile's state; a
  -- chapter with no published state gets none until it searches.
  if clean_query is null and profile_state is null then
    return pg_catalog.jsonb_build_object('rows', '[]'::jsonb, 'matchedOn', 'none', 'hasMore', false);
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'unionOrgId', u.id, 'name', u.name, 'affiliation', u.affiliation, 'designation', u.designation,
      'localNumber', u.local_number, 'city', u.city, 'state', u.state,
      'sector', u.sector_public_private, 'sectorTags', pg_catalog.to_jsonb(u.sector_tags),
      'notOnPlatform', true,
      'sameState', coalesce(profile_state is not null and u.state = profile_state, false),
      'sharedSectors', ranked.rank_sector,
      'openOffer', (select pg_catalog.jsonb_build_object('id', o.id, 'title', o.title, 'expiresAt', o.expires_at)
        from private.chapter_handshake_offers o
        where o.chapter_id = chapter and o.union_org_id = u.id and o.status = 'open' and o.expires_at > pg_catalog.now()),
      'invitationPending', exists (select 1 from private.chapter_partner_invitation_requests r
        where r.chapter_id = chapter and r.union_org_id = u.id and r.status = 'pending')
    ) order by ranked.rank_state desc, ranked.rank_sector desc, u.name, u.id), '[]'::jsonb)
  into page
  from (
    select u.id,
      coalesce(profile_state is not null and u.state = profile_state, false)::integer as rank_state,
      (select pg_catalog.count(*) from pg_catalog.unnest(u.sector_tags) t where t = any(coalesce(profile_sectors, '{}'::text[]))) as rank_sector
    from public.union_orgs u
    where private.catalog_registry_identity_visible(u.id)
      and not private.partner_office_on_platform(u.id)
      and (case when clean_query is not null
            then not exists (select 1 from pg_catalog.unnest(terms) term
              where pg_catalog.concat_ws(' ', u.name, u.affiliation, u.designation, u.local_number, u.city) not ilike
                '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(term, '\', '\\'), '%', '\%'), '_', '\_') || '%')
            else u.state = profile_state end)
    order by rank_state desc, rank_sector desc, u.name, u.id
    limit size + 1 offset skip
  ) ranked
  join public.union_orgs u on u.id = ranked.id;
  -- One extra row was read to tell whether another page exists.
  return pg_catalog.jsonb_build_object(
    'matchedOn', case when clean_query is not null then 'name' else 'state' end,
    'hasMore', pg_catalog.jsonb_array_length(page) > size,
    'rows', case when pg_catalog.jsonb_array_length(page) > size then page - size else page end
  );
end;
$function$;
revoke all on function public.list_partner_offices_not_on_platform(text, text, text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_partner_offices_not_on_platform(text, text, text, integer, integer) to authenticated;
comment on function public.list_partner_offices_not_on_platform(text, text, text, integer, integer) is
  'REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031: catalogue offices with no verified chapter, marked not on the platform, in the caller''s published profile state (or matching every word of a 2-80 character search across name, affiliation, designation, local number and city), ranked by state then shared sectors, a page of at most 50 with hasMore; public catalogue fields plus the caller chapter''s own open offer and pending invitation.';

create function public.list_chapter_handshake_offers(p_selected_hat text, p_chapter_id text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  scope jsonb;
  chapter text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  scope := private.partner_offer_chapter(p_selected_hat, p_chapter_id, array['steward','coordinator','advisor','admin','vp'], false);
  chapter := scope ->> 'chapter';
  return pg_catalog.jsonb_build_object(
    'offers', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', o.id, 'unionOrgId', o.union_org_id, 'officeName', u.name,
        'title', o.title, 'purpose', o.purpose, 'dataScope', o.data_scope,
        'status', case when o.status = 'open' and o.expires_at <= pg_catalog.now() then 'expired' else o.status end,
        'expiresAt', o.expires_at, 'createdAt', o.created_at, 'deliveredAt', o.delivered_at,
        'handshakeId', o.delivered_handshake_id, 'withdrawnAt', o.withdrawn_at
      ) order by o.created_at desc, o.id)
      -- Every open offer, so its withdrawal stays reachable, plus the newest 50.
      from (select * from private.chapter_handshake_offers x where x.chapter_id = chapter
        and (x.status = 'open' or x.id in (select h.id from private.chapter_handshake_offers h
          where h.chapter_id = chapter order by h.created_at desc, h.id limit 50))) o
      join public.union_orgs u on u.id = o.union_org_id), '[]'::jsonb),
    'invitations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'unionOrgId', r.union_org_id, 'officeName', u.name, 'status', r.status,
        'createdAt', r.created_at, 'decidedAt', r.decided_at
      ) order by r.created_at desc, r.id)
      from (select * from private.chapter_partner_invitation_requests x where x.chapter_id = chapter order by x.created_at desc, x.id limit 50) r
      join public.union_orgs u on u.id = r.union_org_id), '[]'::jsonb),
    'openLimit', 10,
    'pendingInvitationLimit', 5
  );
end;
$function$;
revoke all on function public.list_chapter_handshake_offers(text, text) from public, anon, authenticated, service_role;
grant execute on function public.list_chapter_handshake_offers(text, text) to authenticated;
comment on function public.list_chapter_handshake_offers(text, text) is
  'REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031: the caller chapter''s own standing offers (every open one plus the newest 50; expired shown as expired) and invitation requests (newest 50); the invitation contact''s name and address are never returned.';

-- ---------------------------------------------------------------------------
-- Offer writes
-- ---------------------------------------------------------------------------

create function public.create_chapter_handshake_offer(
  p_selected_hat text, p_chapter_id text, p_union_org_id text,
  p_title text, p_purpose text, p_data_scope text, p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  scope jsonb;
  org uuid;
  chapter text;
  office text;
  created private.chapter_handshake_offers%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  office := nullif(pg_catalog.btrim(coalesce(p_union_org_id, '')), '');
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  scope := private.partner_offer_chapter(p_selected_hat, p_chapter_id, array['advisor','admin','vp'], true);
  org := (scope ->> 'organization')::uuid;
  chapter := scope ->> 'chapter';
  if p_idempotency_key is null or office is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose, ''))) not between 1 and 4000
     or p_data_scope is null or p_data_scope not in ('docs_only', 'no_member_data', 'aggregate_only') then
    raise exception 'invalid offer' using errcode = '22023';
  end if;
  -- The same onboarding rule as a two-sided handshake request.
  if not private.organization_clears_signup_boundary(org) then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chapter-handshake-offer:' || chapter, 509672));
  select * into created from private.chapter_handshake_offers o where o.idempotency_key = p_idempotency_key;
  if found then
    if created.chapter_id <> chapter or created.union_org_id <> office or created.created_by is distinct from (select auth.uid())
       or created.title <> pg_catalog.btrim(p_title) or created.purpose <> pg_catalog.btrim(p_purpose)
       or created.data_scope <> p_data_scope then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('id', created.id, 'status', created.status, 'expiresAt', created.expires_at, 'idempotent', true);
  end if;
  if not private.partner_office_offerable(office) then
    raise exception 'office unavailable or already on the platform' using errcode = '22023';
  end if;
  -- An expired open offer no longer holds its slot.
  update private.chapter_handshake_offers set status = 'withdrawn', withdrawn_at = pg_catalog.now()
  where chapter_id = chapter and status = 'open' and expires_at <= pg_catalog.now();
  if exists (select 1 from private.chapter_handshake_offers o where o.chapter_id = chapter and o.union_org_id = office and o.status = 'open') then
    raise exception 'an open offer to this office already exists' using errcode = '23505';
  end if;
  if (select pg_catalog.count(*) from private.chapter_handshake_offers o where o.chapter_id = chapter and o.status = 'open') >= 10 then
    raise exception 'open offer limit reached' using errcode = '22023';
  end if;
  insert into private.chapter_handshake_offers
    (organization_id, chapter_id, union_org_id, title, purpose, data_scope, expires_at, idempotency_key, created_by)
  values (org, chapter, office, pg_catalog.btrim(p_title), pg_catalog.btrim(p_purpose), p_data_scope,
    pg_catalog.now() + interval '90 days', p_idempotency_key, (select auth.uid()))
  returning * into created;
  perform private.chapter_connection_audit(org, chapter, 'chapter_handshake_offer_created',
    pg_catalog.jsonb_build_object('entityType', 'chapter_handshake_offer', 'entityId', created.id, 'sourceKind', 'union_org', 'sourceId', office));
  return pg_catalog.jsonb_build_object('id', created.id, 'status', created.status, 'expiresAt', created.expires_at, 'idempotent', false);
end;
$function$;
revoke all on function public.create_chapter_handshake_offer(text, text, text, text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_chapter_handshake_offer(text, text, text, text, text, text, uuid) to authenticated;
comment on function public.create_chapter_handshake_offer(text, text, text, text, text, text, uuid) is
  'REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031: an advisor, admin or vp of the selected chapter leaves a 90-day standing handshake offer for a catalogue office not yet on the platform; at most 10 open per chapter, one per office; idempotent by key.';

create function public.withdraw_chapter_handshake_offer(p_selected_hat text, p_chapter_id text, p_offer_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  scope jsonb;
  chapter text;
  changed private.chapter_handshake_offers%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  scope := private.partner_offer_chapter(p_selected_hat, p_chapter_id, array['advisor','admin','vp'], true);
  chapter := scope ->> 'chapter';
  update private.chapter_handshake_offers set status = 'withdrawn', withdrawn_at = pg_catalog.now()
  where id = p_offer_id and chapter_id = chapter and status = 'open'
  returning * into changed;
  if not found then
    raise exception 'offer unavailable' using errcode = 'P0002';
  end if;
  perform private.chapter_connection_audit((scope ->> 'organization')::uuid, chapter, 'chapter_handshake_offer_withdrawn',
    pg_catalog.jsonb_build_object('entityType', 'chapter_handshake_offer', 'entityId', changed.id, 'sourceKind', 'union_org', 'sourceId', changed.union_org_id));
  return pg_catalog.jsonb_build_object('id', changed.id, 'status', changed.status);
end;
$function$;
revoke all on function public.withdraw_chapter_handshake_offer(text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.withdraw_chapter_handshake_offer(text, text, uuid) to authenticated;
comment on function public.withdraw_chapter_handshake_offer(text, text, uuid) is
  'REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031: the offering chapter withdraws one of its open standing offers (an expired one too).';

-- ---------------------------------------------------------------------------
-- Invitation requests
-- ---------------------------------------------------------------------------

create function public.request_partner_founder_invitation(
  p_selected_hat text, p_chapter_id text, p_union_org_id text, p_offer_id uuid,
  p_contact_name text, p_contact_email text, p_locale text, p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  scope jsonb;
  org uuid;
  chapter text;
  office text;
  clean_name text;
  clean_email text;
  created private.chapter_partner_invitation_requests%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  office := nullif(pg_catalog.btrim(coalesce(p_union_org_id, '')), '');
  clean_name := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_contact_name, ''), '[[:space:]]+', ' ', 'g'));
  clean_email := pg_catalog.lower(pg_catalog.btrim(coalesce(p_contact_email, '')));
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  scope := private.partner_offer_chapter(p_selected_hat, p_chapter_id, array['advisor','admin','vp'], true);
  org := (scope ->> 'organization')::uuid;
  chapter := scope ->> 'chapter';
  if p_idempotency_key is null or office is null or p_locale is null or p_locale not in ('en', 'es')
     or pg_catalog.char_length(clean_name) not between 2 and 120 or clean_name ~ '[[:cntrl:]<>]'
     or pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;
  if not private.organization_clears_signup_boundary(org) then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chapter-partner-invitation:' || chapter, 509672));
  select * into created from private.chapter_partner_invitation_requests r where r.idempotency_key = p_idempotency_key;
  if found then
    if created.chapter_id <> chapter or created.union_org_id <> office or created.created_by is distinct from (select auth.uid()) then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('id', created.id, 'status', created.status, 'idempotent', true);
  end if;
  if not private.partner_office_offerable(office) then
    raise exception 'office unavailable or already on the platform' using errcode = '22023';
  end if;
  if p_offer_id is not null and not exists (select 1 from private.chapter_handshake_offers o
      where o.id = p_offer_id and o.chapter_id = chapter and o.union_org_id = office and o.status = 'open') then
    raise exception 'offer unavailable' using errcode = '22023';
  end if;
  if exists (select 1 from private.chapter_partner_invitation_requests r
      where r.chapter_id = chapter and r.union_org_id = office and r.status = 'pending') then
    raise exception 'an invitation to this office is already waiting' using errcode = '23505';
  end if;
  if (select pg_catalog.count(*) from private.chapter_partner_invitation_requests r where r.chapter_id = chapter and r.status = 'pending') >= 5 then
    raise exception 'pending invitation limit reached' using errcode = '22023';
  end if;
  insert into private.chapter_partner_invitation_requests
    (organization_id, chapter_id, union_org_id, offer_id, contact_name, contact_email, locale, idempotency_key, created_by)
  values (org, chapter, office, p_offer_id, clean_name, clean_email, p_locale, p_idempotency_key, (select auth.uid()))
  returning * into created;
  perform private.chapter_connection_audit(org, chapter, 'chapter_partner_invitation_requested',
    pg_catalog.jsonb_build_object('entityType', 'chapter_partner_invitation_request', 'entityId', created.id, 'sourceKind', 'union_org', 'sourceId', office));
  return pg_catalog.jsonb_build_object('id', created.id, 'status', created.status, 'idempotent', false);
end;
$function$;
revoke all on function public.request_partner_founder_invitation(text, text, text, uuid, text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.request_partner_founder_invitation(text, text, text, uuid, text, text, text, uuid) to authenticated;
comment on function public.request_partner_founder_invitation(text, text, text, uuid, text, text, text, uuid) is
  'REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031: an advisor, admin or vp of the selected chapter asks the operator to invite a named contact at a catalogue office not yet on the platform through the founder invitation; at most 5 pending per chapter, one per office.';

create function public.take_partner_invitation_request(p_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return (select pg_catalog.jsonb_build_object(
      'id', r.id, 'status', r.status, 'contactName', r.contact_name, 'contactEmail', r.contact_email,
      'locale', r.locale, 'unionOrgId', r.union_org_id, 'officeName', u.name,
      'invitingChapter', c.name, 'offerTitle', o.title,
      -- The newest invitation in the recorded one's resend chain: a resend
      -- whose replacement was never recorded is still found.
      'invitationId', (with recursive chain as (
          select i.id, 0 as depth from public.member_invitations i
          where i.id = r.founder_invitation_id and i.kind = 'founder' and i.invited_by is null
          union all
          select i.id, chain.depth + 1 from chain
          join public.member_invitations i on i.replaces_id = chain.id and i.kind = 'founder' and i.invited_by is null
          where chain.depth < 100)
        select chain.id from chain order by chain.depth desc limit 1),
      'onPlatform', private.partner_office_on_platform(r.union_org_id))
    from private.chapter_partner_invitation_requests r
    join public.union_orgs u on u.id = r.union_org_id
    join public.chapters c on c.id = r.chapter_id
    left join private.chapter_handshake_offers o on o.id = r.offer_id and o.status = 'open' and o.expires_at > pg_catalog.now()
    where r.id = p_request_id and r.status = 'pending');
end;
$function$;
revoke all on function public.take_partner_invitation_request(uuid) from public, anon, authenticated, service_role;
grant execute on function public.take_partner_invitation_request(uuid) to service_role;
comment on function public.take_partner_invitation_request(uuid) is
  'REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031: service role only; the pending request''s contact, office, inviting chapter and open offer title for the operator''s founder invitation, or null.';

create function public.note_partner_founder_invitation(p_request_id uuid, p_invitation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  changed private.chapter_partner_invitation_requests%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_invitation_id is null or not exists (select 1 from public.member_invitations i
      where i.id = p_invitation_id and i.kind = 'founder' and i.invited_by is null) then
    raise exception 'founder invitation unavailable' using errcode = '22023';
  end if;
  update private.chapter_partner_invitation_requests
  set founder_invitation_id = p_invitation_id
  where id = p_request_id and status = 'pending'
  returning * into changed;
  if not found then
    raise exception 'request unavailable' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object('id', changed.id, 'invitationId', changed.founder_invitation_id);
end;
$function$;
revoke all on function public.note_partner_founder_invitation(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.note_partner_founder_invitation(uuid, uuid) to service_role;
comment on function public.note_partner_founder_invitation(uuid, uuid) is
  'REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031: service role only; records the latest operator founder invitation issued for a waiting request, so a rerun resends that invitation.';

create function public.finish_partner_invitation_request(p_request_id uuid, p_outcome text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  changed private.chapter_partner_invitation_requests%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('sent', 'declined') then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;
  update private.chapter_partner_invitation_requests
  set status = p_outcome, decided_at = pg_catalog.now(), contact_name = null, contact_email = null
  where id = p_request_id and status = 'pending'
  returning * into changed;
  if not found then
    raise exception 'request unavailable' using errcode = 'P0002';
  end if;
  perform private.notify_handshake_staff(changed.chapter_id,
    case when p_outcome = 'sent' then 'Partner invitation sent' else 'Partner invitation not sent' end,
    case when p_outcome = 'sent' then 'Union Ground sent the invitation you asked for to the partner office.'
      else 'Union Ground did not send the invitation you asked for to the partner office.' end);
  return pg_catalog.jsonb_build_object('id', changed.id, 'status', changed.status);
end;
$function$;
revoke all on function public.finish_partner_invitation_request(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.finish_partner_invitation_request(uuid, text) to service_role;
comment on function public.finish_partner_invitation_request(uuid, text) is
  'REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031: service role only; records sent or declined, erases the contact''s name and address and notifies the requesting chapter''s staff.';

-- ---------------------------------------------------------------------------
-- Arrival
-- ---------------------------------------------------------------------------

-- Whether a binding's verifier is a platform operator. Tenant organization
-- administrators can verify their own chapter's binding, which proves nothing
-- about the office, so only an operator's verification delivers offers.
create function private.partner_binding_verifier_is_operator(p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select p_user_id is not null and exists (select 1 from private.compass_platform_operators o
    where o.user_id = p_user_id and o.revoked_at is null);
$function$;
revoke all on function private.partner_binding_verifier_is_operator(uuid) from public, anon, authenticated, service_role;

-- Every open, unexpired offer to the office becomes a two-sided handshake
-- request to the arriving chapter. Nothing is accepted; an offer whose
-- creator left, whose chapter is the arriving one or whose organization no
-- longer clears onboarding is withdrawn instead. Returns how many it delivered.
-- Callers have established that the binding is operator-verified; the gate
-- is re-entered first, as in every case-graph writer.
create function private.deliver_standing_offers_to(p_chapter_id text, p_union_org_id text)
returns integer language plpgsql security definer set search_path = ''
as $function$
declare
  offer private.chapter_handshake_offers%rowtype;
  created public.chapter_handshakes%rowtype;
  delivered integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  delivered := 0;
  for offer in
    select * from private.chapter_handshake_offers o
    where o.union_org_id = p_union_org_id and o.status = 'open'
    order by o.created_at, o.id
    for update
  loop
    if offer.expires_at <= pg_catalog.now() or offer.created_by is null or offer.chapter_id = p_chapter_id
       or not private.organization_clears_signup_boundary(offer.organization_id) then
      update private.chapter_handshake_offers set status = 'withdrawn', withdrawn_at = pg_catalog.now() where id = offer.id;
      continue;
    end if;
    -- The caller runs under the service credential, so the handshake's
    -- chapter and requester come from the offer: see
    -- private.restore_standing_offer_identity below.
    update private.chapter_handshake_offers set delivering_txid = pg_catalog.txid_current() where id = offer.id;
    insert into public.chapter_handshakes
      (chapter_id, receiving_chapter_id, partner_org_id, title, purpose, data_scope, status, requested_by, requested_at)
    values (offer.chapter_id, p_chapter_id, offer.union_org_id, offer.title, offer.purpose, offer.data_scope,
      'requested', offer.created_by, pg_catalog.clock_timestamp())
    returning * into created;
    insert into public.chapter_handshake_events
      (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
    values (created.id, extensions.gen_random_uuid(), offer.created_by, offer.chapter_id, 'requested', 'draft', 'requested');
    update private.chapter_handshake_offers
    set status = 'delivered', delivered_at = pg_catalog.now(), delivered_handshake_id = created.id, delivering_txid = null
    where id = offer.id;
    perform private.notify_handshake_staff(p_chapter_id, 'Partnership request received',
      'A chapter left a standing partnership offer for your office before you joined. Review it to accept or decline.');
    perform private.notify_handshake_staff(offer.chapter_id, 'Standing offer delivered',
      'The partner office you made a standing offer to has joined Union Ground. Your offer is now a partnership request waiting for its answer.');
    delivered := delivered + 1;
  end loop;
  return delivered;
end;
$function$;
revoke all on function private.deliver_standing_offers_to(text, text) from public, anon, authenticated, service_role;

-- Delivers on a binding a platform operator verified. A binding verified by
-- anyone else (a tenant administrator approving their own chapter) delivers
-- nothing and the offers stay open.
create function private.deliver_chapter_handshake_offers()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[new.verified_by], array[]::uuid[]);
  if new.status <> 'verified' or (tg_op = 'UPDATE' and old.status = 'verified')
     or not private.partner_binding_verifier_is_operator(new.verified_by) then
    return null;
  end if;
  perform private.deliver_standing_offers_to(new.chapter_id, new.union_org_id);
  return null;
end;
$function$;
revoke all on function private.deliver_chapter_handshake_offers() from public, anon, authenticated, service_role;
create trigger z70_deliver_chapter_handshake_offers
after insert or update of status on public.chapter_union_org_bindings
for each row execute function private.deliver_chapter_handshake_offers();

-- Service role only: a platform operator who has confirmed that a chapter
-- with a verified binding really is that office delivers the office's open
-- offers to it, for a binding someone other than an operator verified.
create function public.deliver_standing_handshake_offers(p_chapter_id text, p_union_org_id text, p_operator_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  delivered integer;
begin
  perform private.lock_case_graph(array[p_operator_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not private.partner_binding_verifier_is_operator(p_operator_user_id) then
    raise exception 'platform operator required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.chapter_union_org_bindings b
      where b.chapter_id = p_chapter_id and b.union_org_id = p_union_org_id and b.status = 'verified') then
    raise exception 'verified binding unavailable' using errcode = '22023';
  end if;
  delivered := private.deliver_standing_offers_to(p_chapter_id, p_union_org_id);
  return pg_catalog.jsonb_build_object('chapterId', p_chapter_id, 'unionOrgId', p_union_org_id, 'delivered', delivered);
end;
$function$;
revoke all on function public.deliver_standing_handshake_offers(text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.deliver_standing_handshake_offers(text, text, uuid) to service_role;
comment on function public.deliver_standing_handshake_offers(text, text, uuid) is
  'REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031: service role only, on behalf of an active platform operator; delivers the office''s open standing offers to a chapter whose binding to it is verified, when the verifier was not an operator. Nothing is accepted.';

-- private.stamp_product_identity sets a new handshake's chapter_id and
-- requested_by from the caller, which is right for a member's own request but
-- not for a delivery the operator's verification triggers. This trigger runs
-- after it (and before z99_case_graph_keys) and, only for the offer the
-- delivery marked in this transaction, puts back the offering chapter and the
-- offer's creator. No client can set the marker: the table has no grants.
create function private.restore_standing_offer_identity()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  offer private.chapter_handshake_offers%rowtype;
begin
  select * into offer from private.chapter_handshake_offers o
  where o.delivering_txid = pg_catalog.txid_current() and o.status = 'open'
    and o.union_org_id = new.partner_org_id and o.title = new.title;
  if found then
    new.chapter_id := offer.chapter_id;
    new.requested_by := offer.created_by;
  end if;
  return new;
end;
$function$;
revoke all on function private.restore_standing_offer_identity() from public, anon, authenticated, service_role;
create trigger stamp_standing_offer_identity
before insert on public.chapter_handshakes
for each row execute function private.restore_standing_offer_identity();

-- The arrival trigger also makes private.notify_handshake_staff reachable from
-- a trigger, so it joins the reviewed surface unchanged.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
 select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
 where (schema_name = 'private' and (table_name in ('chapter_handshake_offers', 'chapter_partner_invitation_requests')
   or object_name in ('deliver_chapter_handshake_offers()', 'restore_standing_offer_identity()',
     'deliver_standing_offers_to(p_chapter_id text, p_union_org_id text)',
     'partner_binding_verifier_is_operator(p_user_id uuid)',
     'notify_handshake_staff(p_chapter_id text, p_title text, p_body text)')))
   or (schema_name = 'public' and table_name = 'chapter_union_org_bindings' and object_name = 'z70_deliver_chapter_handshake_offers')
   or (schema_name = 'public' and table_name = 'chapter_handshakes' and object_name = 'stamp_standing_offer_identity')
 on conflict(kind,schema_name,table_name,object_name) do update set definition_hash = excluded.definition_hash;

do $assert_standing_offer_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after standing handshake offers';
  end if;
end;
$assert_standing_offer_trigger_review$;

notify pgrst, 'reload schema';

commit;
