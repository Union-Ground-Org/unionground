-- REQ-UG-CATALOG-ORGANIZATION-NAMES-OVER-200-CHARACTERS-20261114 (#8743).
--
-- The union catalog refused an organization name longer than 200 characters,
-- and the exporter never shortens a name, so 1,113 bodies of the Americas
-- research build (mostly registered Mexican union names, up to 622
-- characters) could not be loaded, searched or picked. The name check now
-- allows up to 1,000 characters; it still requires 2 or more characters
-- after trimming and no control character. Sub-unit names keep their limit.
-- Search text stays bounded at 4,000 characters by the exporter and loader.
-- Schema only: every existing row already meets the wider check, and no row
-- is read or written beyond the constraint's own validation.

begin;

alter table private.catalog_organizations
  drop constraint catalog_organizations_name_check,
  add constraint catalog_organizations_name_check
    check (char_length(btrim(name)) between 2 and 1000 and name !~ '[[:cntrl:]]');

commit;
