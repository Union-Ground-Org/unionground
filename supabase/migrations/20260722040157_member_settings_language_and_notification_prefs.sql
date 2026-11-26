-- REQ-UG-DESIGN-BACKEND-P3-20260722 (part B): member settings.
-- language drives the in-app locale; notification_prefs stores the member's
-- in-app topic preferences. Both are additive columns on member_profiles with
-- non-volatile defaults (fast metadata-only add) so every existing and future
-- member is covered without touching the signup trigger. notification_prefs
-- carries a shape/size CHECK so a member cannot store an arbitrary or oversized
-- blob through the self-update path (and it is steward-readable via the P2
-- policy, so it must stay a bounded, non-sensitive object). Delivery infra
-- (push/email/SMS) is intentionally NOT built; these are in-app preferences.
alter table public.member_profiles
  add column language text not null default 'en' check (language in ('en', 'es')),
  add column notification_prefs jsonb not null
    default '{"deadlines": true, "cases": true, "votes": true, "events": true}'::jsonb
    check (
      pg_catalog.jsonb_typeof(notification_prefs) = 'object'
      and pg_catalog.length(notification_prefs::text) < 512
    );
