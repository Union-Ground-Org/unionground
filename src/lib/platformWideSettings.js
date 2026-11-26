// Platform setting definitions whose value is the same for every
// organization. The database refuses organization values for these keys
// (constraint organization_setting_values_platform_wide_keys, migration
// 20261002015000), so an admin page shows them read-only instead of offering
// a Save that can never succeed.
//
// The password sign-in limits are platform-wide because an attempt arrives
// before any organization is known; a per-organization limit would make the
// "try later" boundary reveal which addresses belong to that organization.
const PLATFORM_WIDE_SETTING_KEYS = Object.freeze([
  "limits.security.signin_attempts_per_email_hour",
  "limits.security.signin_attempts_per_ip_hour",
]);

export function isPlatformWideSetting(key) {
  return PLATFORM_WIDE_SETTING_KEYS.includes(String(key));
}
