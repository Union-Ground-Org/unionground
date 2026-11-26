begin;

create table private.membership_card_verification_nonces (
  nonce text not null check (nonce ~ '^[A-Za-z0-9_-]{22}$'),
  origin_surface text not null check (origin_surface in ('saas', 'demo')),
  expires_at timestamptz not null,
  primary key (origin_surface, nonce)
);

create index membership_card_verification_nonces_expiry_idx
  on private.membership_card_verification_nonces (expires_at, origin_surface, nonce);

alter table private.membership_card_verification_nonces enable row level security;
alter table private.membership_card_verification_nonces force row level security;
revoke all on table private.membership_card_verification_nonces
  from public, anon, authenticated, service_role;

create function public.consume_membership_card_verification_nonce(
  p_nonce text,
  p_origin_surface text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  moment timestamptz := pg_catalog.clock_timestamp();
  -- Hard ceiling on live (unexpired) rows. EXECUTE is granted to anon, so
  -- anyone holding a publishable key can allocate one opaque row per call with
  -- an expiry up to six minutes ahead, while the maintenance step below removes
  -- at most 200 already-expired rows per call: a burst outruns the prune and,
  -- once stopped, leaves a durable backlog that only time clears. 20000 rows of
  -- (22-character nonce, short surface label, timestamp) are roughly 1-2 MiB of
  -- heap plus index together, which is far above any legitimate five-minute
  -- verification rate -- a real deployment presents a handful of codes a minute,
  -- so a genuine population is three orders of magnitude below this -- and far
  -- below a size that threatens the database. At or above the ceiling the
  -- function fails closed: no row is inserted and it returns the same false
  -- that a replay returns, so the refusal discloses nothing, no legitimate code
  -- is ever recorded as consumed when it was not, and the backlog drains
  -- without operator action as the parked rows expire and are pruned.
  live_nonce_cap constant bigint := 20000;
  live_nonce_count bigint;
  inserted_count bigint;
begin
  if coalesce((select auth.role()), '') <> 'anon' then
    raise exception 'anonymous verifier required' using errcode = '42501';
  end if;
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{22}$'
     or p_origin_surface is null or p_origin_surface not in ('saas', 'demo')
     or p_expires_at is null then
    raise exception 'invalid verification nonce' using errcode = '22023';
  end if;

  -- One non-waiting maintainer removes at most 200 old opaque rows per call.
  if pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('membership-card-verification-nonce-prune', 509)
  ) then
    delete from private.membership_card_verification_nonces as stale
    where stale.ctid in (
      select candidate.ctid
      from private.membership_card_verification_nonces as candidate
      where candidate.expires_at <= moment
      order by candidate.expires_at, candidate.origin_surface, candidate.nonce
      limit 200
      for update skip locked
    );
  end if;

  -- The signed token already caps its own five-minute life against the issuing
  -- node's clock, and the route re-checks that cap before calling here. This
  -- upper bound therefore exists to stop a direct anonymous caller from parking
  -- long-lived rows, not to re-date a legitimate code: it allows one minute of
  -- node-to-database clock skew rather than failing a genuine first check
  -- closed and indistinguishably from a replay.
  if p_expires_at <= moment or p_expires_at > moment + interval '6 minutes' then
    return false;
  end if;

  -- Bounded live-row ceiling; see live_nonce_cap above. The subquery stops at
  -- the ceiling so the check costs at most one capped scan of the expiry index
  -- rather than a full count, and it is evaluated after the prune so reclaimed
  -- space counts towards the caller.
  select pg_catalog.count(*) into live_nonce_count
  from (
    select 1
    from private.membership_card_verification_nonces as live
    where live.expires_at > moment
    limit live_nonce_cap
  ) as capped;
  if live_nonce_count >= live_nonce_cap then
    return false;
  end if;

  insert into private.membership_card_verification_nonces
    (nonce, origin_surface, expires_at)
  values (p_nonce, p_origin_surface, p_expires_at)
  on conflict (origin_surface, nonce) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end;
$function$;

revoke all on function public.consume_membership_card_verification_nonce(text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_membership_card_verification_nonce(text, text, timestamptz)
  to anon;

comment on table private.membership_card_verification_nonces is
  'Opaque, short-lived membership-card verification nonces; contains no member, tenant, or card payload.';
comment on function public.consume_membership_card_verification_nonce(text, text, timestamptz) is
  'Atomically consumes one anonymous membership-card nonce, performs bounded expired-row pruning, and fails closed above a fixed 20000 live-row allocation ceiling.';

notify pgrst, 'reload schema';

commit;
