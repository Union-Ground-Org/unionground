-- UB-RWD-02: fulfillment states for physical rewards need evidence. Historical
-- rows remain nullable; they cannot be backfilled with invented addresses or
-- tracking numbers.
alter table public.member_reward_grants add column shipping_address text;
alter table public.member_reward_grants add column shipping_carrier text;
alter table public.member_reward_grants add column tracking_number text;
alter table public.member_reward_grants add column shipped_at timestamptz;
alter table public.member_reward_grants add column delivered_at timestamptz;

alter table public.member_reward_grants add constraint member_reward_grants_shipping_address_shape
  check (shipping_address is null or (char_length(shipping_address) between 10 and 1000 and shipping_address = btrim(shipping_address) and translate(shipping_address, E'\n\r\t', '') !~ '[[:cntrl:]]')) not valid;
alter table public.member_reward_grants add constraint member_reward_grants_shipping_carrier_shape
  check (shipping_carrier is null or (char_length(shipping_carrier) between 1 and 100 and shipping_carrier = btrim(shipping_carrier) and shipping_carrier !~ '[[:cntrl:]]')) not valid;
alter table public.member_reward_grants add constraint member_reward_grants_tracking_number_shape
  check (tracking_number is null or (char_length(tracking_number) between 3 and 200 and tracking_number = btrim(tracking_number) and tracking_number !~ '[[:cntrl:]]')) not valid;
alter table public.member_reward_grants validate constraint member_reward_grants_shipping_address_shape;
alter table public.member_reward_grants validate constraint member_reward_grants_shipping_carrier_shape;
alter table public.member_reward_grants validate constraint member_reward_grants_tracking_number_shape;

-- Old physical shipped/delivered labels have no recoverable evidence. Move
-- them back to the appropriate pending state instead of fabricating proof or
-- continuing to present an unsupported fulfillment assertion.
update public.member_reward_grants g
set status = case when g.source = 'admin_grant' then 'granted' else 'claimed' end,
    updated_at = now()
from public.member_reward_items i
where i.key = g.item_key and i.fulfillment = 'ship'
  and g.status in ('shipped', 'delivered');

alter function public.claim_reward(text, text) rename to claim_reward_without_shipping_legacy;
revoke all on function public.claim_reward_without_shipping_legacy(text, text) from public, anon, authenticated, service_role;
drop function if exists public.claim_reward(text, text);

create function public.claim_reward(p_item_key text, p_note text default null, p_shipping_address text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  fulfillment_kind text;
  clean_address text := nullif(btrim(coalesce(p_shipping_address, '')), '');
  result jsonb;
begin
  -- Authenticate before catalog lookup so the wrapper does not become an
  -- item-kind oracle for unauthenticated callers.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select i.fulfillment into fulfillment_kind from public.member_reward_items i
  where i.key = p_item_key and i.active;
  if fulfillment_kind = 'ship' and (clean_address is null or char_length(clean_address) not between 10 and 1000) then
    raise exception 'reward shipping address is required' using errcode = '22023';
  end if;
  if fulfillment_kind <> 'ship' and clean_address is not null then
    raise exception 'shipping address is not used for this reward' using errcode = '22023';
  end if;
  result := public.claim_reward_without_shipping_legacy(p_item_key, p_note);
  if fulfillment_kind = 'ship' then
    update public.member_reward_grants set shipping_address = clean_address
    where id = (result->>'grantId')::uuid and user_id = caller;
  end if;
  return result || pg_catalog.jsonb_build_object('shippingAddress', clean_address);
end
$$;
revoke all on function public.claim_reward(text, text, text) from public, anon;
grant execute on function public.claim_reward(text, text, text) to authenticated;

create function public.set_reward_shipping_address(p_grant_id uuid, p_shipping_address text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  clean_address text := btrim(coalesce(p_shipping_address, ''));
  g record;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if char_length(clean_address) not between 10 and 1000 then
    raise exception 'reward shipping address is required' using errcode = '22023';
  end if;
  select gr.id, gr.user_id into g
  from public.member_reward_grants gr join public.member_reward_items i on i.key = gr.item_key
  where gr.id = p_grant_id and gr.user_id = caller and i.fulfillment = 'ship'
    and gr.status in ('claimed', 'granted') for update of gr;
  if not found then raise exception 'reward is not addressable' using errcode = '22023'; end if;
  update public.member_reward_grants set shipping_address = clean_address, updated_at = now()
  where id = g.id and g.user_id = caller;
  return pg_catalog.jsonb_build_object('grantId', g.id, 'shippingAddress', clean_address);
end
$$;
revoke all on function public.set_reward_shipping_address(uuid, text) from public, anon;
grant execute on function public.set_reward_shipping_address(uuid, text) to authenticated;

alter function public.fulfill_reward(uuid) rename to fulfill_reward_without_evidence_legacy;
revoke all on function public.fulfill_reward_without_evidence_legacy(uuid) from public, anon, authenticated, service_role;
drop function if exists public.fulfill_reward(uuid);

create function public.fulfill_reward(p_grant_id uuid, p_carrier text default null, p_tracking_number text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g record;
  clean_carrier text := nullif(btrim(coalesce(p_carrier, '')), '');
  clean_tracking text := nullif(btrim(coalesce(p_tracking_number, '')), '');
  result jsonb;
begin
  if (select auth.uid()) is null or not public.member_has_role(array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select gr.id, gr.status, gr.shipping_address, i.fulfillment into g
  from public.member_reward_grants gr join public.member_reward_items i on i.key = gr.item_key
  where gr.id = p_grant_id for update of gr;
  if not found then raise exception 'grant not found' using errcode = '22023'; end if;
  if g.fulfillment = 'ship' and g.status in ('claimed', 'granted') then
    if g.shipping_address is null then raise exception 'shipping address is required' using errcode = '22023'; end if;
    if clean_carrier is null or char_length(clean_carrier) > 100
       or clean_tracking is null or char_length(clean_tracking) not between 3 and 200 then
      raise exception 'carrier and tracking are required' using errcode = '22023';
    end if;
  elsif clean_carrier is not null or clean_tracking is not null then
    raise exception 'shipping evidence is not accepted for this transition' using errcode = '22023';
  end if;
  result := public.fulfill_reward_without_evidence_legacy(p_grant_id);
  if result->>'status' = 'shipped' then
    update public.member_reward_grants set shipping_carrier = clean_carrier,
      tracking_number = clean_tracking, shipped_at = now() where id = p_grant_id;
  elsif result->>'status' = 'delivered' then
    update public.member_reward_grants set delivered_at = now() where id = p_grant_id;
  end if;
  return result || pg_catalog.jsonb_build_object('shippingCarrier', clean_carrier, 'trackingNumber', clean_tracking);
end
$$;
revoke all on function public.fulfill_reward(uuid, text, text) from public, anon;
grant execute on function public.fulfill_reward(uuid, text, text) to authenticated;

alter function public.get_admin_reward_queue() rename to get_admin_reward_queue_without_shipping_legacy;
revoke all on function public.get_admin_reward_queue_without_shipping_legacy() from public, anon, authenticated, service_role;
create function public.get_admin_reward_queue() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(row.value || pg_catalog.jsonb_build_object(
    'shippingAddress', g.shipping_address, 'shippingCarrier', g.shipping_carrier,
    'trackingNumber', g.tracking_number, 'shippedAt', g.shipped_at,
    'deliveredAt', g.delivered_at) order by row.ordinality), '[]'::jsonb)
  from pg_catalog.jsonb_array_elements(public.get_admin_reward_queue_without_shipping_legacy())
    with ordinality row(value, ordinality)
  join public.member_reward_grants g on g.id = (row.value->>'id')::uuid
$$;
revoke all on function public.get_admin_reward_queue() from public, anon;
grant execute on function public.get_admin_reward_queue() to authenticated;
