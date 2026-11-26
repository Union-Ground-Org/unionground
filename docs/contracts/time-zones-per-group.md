# Time zones per group contract

Created November 22, 2026 upstream. `docs/contracts/README.md` lists every
area contract.

## Time zones per group contract

Binding product direction of November 22, 2026. It replaces the earlier
Eastern-only rule (one shared Eastern day and Eastern display for everyone):
Eastern time must not be the default for anyone outside the Eastern time zone.

### The rules

- Accounts are created anywhere: Eastern, Central, Pacific, Europe, Asia.
  Every group works natively in its own time zone, at every level of the
  website and the phone apps, and nothing is worked out on one zone for
  everyone.
- A zone is a named region (`America/Chicago`, `Europe/Berlin`), never a fixed
  number of hours, so each country's own daylight rules apply, including the
  countries that have none and the weeks when two countries have changed on
  different dates.
- Three levels carry a zone: the organization, the chapter, and the unit or
  worksite. A unit with no zone of its own takes its chapter's. A level above
  the organization (a national union above a local, an agency above a
  department) is a box on the organization chart and carries none.
- A person has no zone of their own, and the phone or browser is never read to
  decide one. A person takes the zone of the lowest-level group they belong
  to: unit or worksite, then chapter, then organization. For a person in more
  than one group, the chapter they have open decides what they see, and their
  home chapter decides when their notices arrive.
- Everything uses the clock of the group it belongs to:
  - A case, deadline, meeting, appointment, dues item or report belongs to a
    group. Its day, its "overdue", its business days and its week are counted
    in that group's zone, and a notice about it goes out on that group's
    clock, once, to everyone it is for. A recipient in another zone gets it at
    the same moment, so a notice never arrives after the deadline it warns of.
  - Quiet hours, a personal reminder, a scheduled message and a workload
    reminder belong to a person, and use the clock of that person's home
    group.
- A moment on a screen, in an email, in push text or in an export is shown in
  the zone of the viewer's or recipient's own group, with the zone's label
  beside it. When the item belongs to a group in another zone, that group's
  time is shown too. A fact that is a day and not a moment (a filing date, a
  contract end date, a holiday) shows as that date for everyone and never
  shifts.
- Nothing can know where a brand-new group is, so an organization's zone is
  one confirm. A new organization starts on a starting value, and until an
  organization admin confirms the zone once the apps keep asking an admin to,
  with the browser's zone offered as the suggestion. A chapter, and a unit or
  worksite, takes the level above unless whoever manages it gives it a zone of
  its own, which the screen that creates it offers. An admin can change a
  zone later; a deadline already set keeps its date and the zone it was set
  in, and the change applies to what is set afterwards. (The first wording of
  this rule made the zone a required field of every creation form. One
  confirm step reaches the same end for all five ways an organization or
  chapter is created without rewriting them, and it also asks the admins of
  the organizations that existed before.)
- Anything that repeats, or means a local clock time, stores that clock time,
  its zone and its anchor, not only a moment, so a daylight change moves the
  moment and not the clock. One rule decides a clock time that a daylight
  change skips or repeats, and it is Postgres's own, since the database works
  out the schedules: a clock time that comes twice means the second one
  (standard time), and one that is skipped moves forward by the length of the
  skip (2:30 AM becomes 3:30 AM). A day begins at the first instant that has
  its date, which is not always midnight. JavaScript follows the same rule;
  `zonedDateTimeInputToIso` in `src/lib/localDateTime.js` does not yet (it
  takes the first of a repeated time in the Americas and the second in Europe
  and Australia) and is brought into line by the part that owns schedules. A
  form may still refuse a skipped time a person typed.
- No scheduled job that means a local time of day fires at one fixed hour for
  every organization.
- Every zone picker offers the full world list.
- Platform operator screens (the signup queue, the release calendar, job
  alerts) are the operator's own and stay Eastern, each with a stated
  exemption. The usage digest and the issue digest belong to organizations and
  are not exempt.
- Reports that hide small groups keep the periods they have published. New
  boundaries start at a clean cut and an old period is never published again
  under new bounds.

### How it is delivered

- The record is delivered in parts, each behind the organization switch
  `features.governance.group_time_zones`, created held with no date. Until it
  is released every group reads Eastern exactly as before, and nobody can
  choose another zone. The switch is released
  only after the test grid passes: one of each structure in Los Angeles,
  Phoenix, New York, Berlin, Kolkata, Kathmandu, Tokyo, Sydney, Lord Howe and
  Chatham, against every notice and reminder type, at both daylight changes of
  each zone, with duplicate workers, missed runs and retries, on the database
  and the phone engine as well as Node.
- `src/lib/zoneTime.js` is the one time-zone module for web and native. Its
  functions take the zone as an argument; `groupTimeZone(group)` answers a
  group's zone as the server delivered it, and `America/New_York` until one is
  delivered. `src/lib/easternTime.js` keeps its names as that module with New
  York's zone filled in, for its existing importers only.
- In the database a zone is stored on `public.organizations.time_zone`
  (every organization has one), `public.chapters.time_zone` and
  `private.chapter_units.time_zone` (null takes the level above), each with
  a check that it is a region name the server's time zone data knows (never
  an abbreviation or an offset). It is read only through
  `private.group_time_zone(organization, chapter, unit)`, which refuses a
  chapter outside that organization or a unit outside that chapter and
  answers New York's zone while the switch is held. A day is counted with
  `private.local_day(zone, instant)` and begins at
  `private.local_day_start(zone, day)`, which agree with `zoneDay` and
  `zoneMidnight` for every region. From the migration that adds these on, a
  migration may not name New York's zone or call `private.eastern_day`
  without a `-- fixed-zone:` reason on the line.
- A zone is set only through `public.set_group_time_zone(chapter, unit,
  zone)`: an organization admin for the organization (no chapter, no unit),
  and whoever may manage a chapter's units for that chapter and its units,
  where an empty zone clears it. The zone must be a region name spelled as
  the server lists it. A group that is missing, in another organization or not
  the caller's to manage gets one and the same refusal, and each change
  writes one row of the organization's configuration audit.
  `public.organizations.time_zone_confirmed_at` is null until an admin has
  set the organization's zone. The apps read zones only through
  `public.get_group_time_zones()`: the organization's zone and whether it is
  confirmed, and each chapter and unit with its own zone and the zone it
  works on. While the switch is held the setter refuses everyone and the read
  answers only `{released: false}`.
- A deadline keeps the zone it was set in. `public.member_cases.time_zone` is
  the zone a case's dates are counted in, written when the case is created
  and whenever its deadline is set or changed; `public.casework_deadlines.time_zone`
  is a step deadline's, written when it is set and whenever its moment moves.
  Only a trigger writes them, through `private.record_time_zone(organization,
  chapter, unit)`, which answers `private.group_time_zone` for a stored record
  and never refuses: a chapter outside its organization takes the
  organization's zone, and a record with no organization New York's. Every
  reader of those deadlines in the database (the notices, overdue, the next
  due day, the boards, queues and automations) counts each deadline on its
  own stored zone, never one deadline's date
  against another zone's today. An undo that puts a deadline back puts back
  the zone it was set in. A write made with triggers switched off takes New
  York's zone; that default goes before the switch is released.
- New code never names a zone. It calls the zone functions with
  `groupTimeZone(group)` for the group the item belongs to. A line that must
  stay on a fixed zone says why at its end: `fixed-zone: <reason>`,
  `device-zone: <reason>` or `utc-day: <reason>`.
- `config/fixed-zone-inventory.json` lists what is left on a fixed zone.
  - `source` is checked by `scripts/lib/fixed-zone-scan.mjs` on every
    conventions run and only shrinks: each web, native and server file with
    its number of lines that name New York's zone or Eastern time, read the
    device's zone, or take the UTC day of an instant as a date. A file's
    count may not pass its entry, and the total of each kind may not pass the
    total in Main's list, so an entry cannot be raised beside the code; a
    file may still be renamed or split with the lines it carries. Comments
    are not counted.
  - `database` is read from the catalog of a migrated database by
    `node scripts/fixed-zone-inventory.mjs --write-database`: every function,
    column default, constraint, view, index, policy, trigger and scheduled job
    that names New York's zone, reads the session's day, converts through UTC
    by name or fires at stated hours. It is a snapshot that each part
    refreshes. A cast of a stored instant to a date with no zone cannot be
    seen in text; the test grid covers that class.
- The last part replaces the Eastern-only messages of
  `scripts/lib/eastern-time-scan.mjs` and removes `src/lib/easternTime.js`.
  Until then that scan still asks for a zone label beside every time shown,
  which this contract keeps.

### Decisions recorded with their source

- The plan went through three revisions after review; every review finding
  was answered in the last one.
- Confirmed with the product owner the same morning: the rule for a person in
  more than one group, the one confirm at creation, and that daylight time is
  reflected for the United States and its equivalent in every other country.
