-- History alias for 20261018060300_retire_legacy_agency_chapters.sql.
-- This file carried the Union Ground adaptation of the legacy agency chapter
-- retirement before the upstream migration was imported at its own, earlier
-- version; that version now holds the adaptation. Keep this file as a no-op
-- so a replay retires the chapters once.
-- The transaction keeps the wrapper every migration carries; the one
-- read-only select names the alias, so no two no-op versions are identical.
begin;
select 'history alias of 20261018060300_retire_legacy_agency_chapters' as history_alias;
commit;
