-- Focus-window equal endpoints fix ( finding 7).
--
-- quiet_hours_start = quiet_hours_end fell into the wrap-around branch, whose
-- predicate (t >= start OR t < start) is a tautology: a member who set
-- 22:00–22:00 silenced every non-urgent channel 24 hours a day, and under
-- claim-time deferral each nudge just aged out at the 48-hour expiry. The
-- inherited trigger had the same hole; deferral made it quieter, not smaller.
-- A zero-length window now blocks nothing — "quiet all day" stays available
-- honestly through DND.

create or replace function private.member_focus_blocks(p_user_id uuid, p_kind text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  profile record;
  local_time time;
  in_quiet_hours boolean := false;
  urgent boolean := false;
begin
  select p.dnd_enabled, p.quiet_hours_start, p.quiet_hours_end,
         p.quiet_hours_timezone, p.urgent_notifications_enabled
    into profile
  from public.member_profiles p where p.id = p_user_id;
  if not found then
    return false;
  end if;
  urgent := p_kind in ('deadlines', 'cases')
    and coalesce(profile.urgent_notifications_enabled, true);
  if profile.quiet_hours_start is not null and profile.quiet_hours_end is not null
     and profile.quiet_hours_start <> profile.quiet_hours_end then
    begin
      local_time := (pg_catalog.now() at time zone profile.quiet_hours_timezone)::time;
      in_quiet_hours := case when profile.quiet_hours_start < profile.quiet_hours_end
        then local_time >= profile.quiet_hours_start and local_time < profile.quiet_hours_end
        else local_time >= profile.quiet_hours_start or local_time < profile.quiet_hours_end end;
    exception
      when invalid_parameter_value then
        -- Fail open for delivery if a legacy/corrupt timezone somehow exists.
        -- member_profiles_validate_focus_timezone prevents new invalid values.
        in_quiet_hours := false;
    end;
  end if;
  return (coalesce(profile.dnd_enabled, false) or in_quiet_hours) and not urgent;
end
$$;

revoke all on function private.member_focus_blocks(uuid, text) from public, anon, authenticated, service_role;
