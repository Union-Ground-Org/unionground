# Staged feature releases contract

Created November 12, 2026 upstream. `docs/contracts/README.md` lists every
area contract.

## Staged feature releases contract

Binding product direction of November 12, 2026.

### The rules

- A finished feature may be held back and released on an announced date. The
  aim is one release a week for about three months, each with a public post
  ("today we released this"). Features that are not fully finished may also be
  parked for a week or so while more important work goes first.
- Held means invisible. A held feature shows no control at all: no
  "coming soon" badge, no disabled button, no teaser.
- The SAMPLE tour follows the same hold as Production.
- Security and accessibility fixes never wait for a release date.
- Spanish is not held: a released feature ships with its Spanish copy, and
  Spanish copy is never held back on its own.
- A hold is not a deferral: every member-facing function still has to exist
  and work end to end; a hold only decides when organizations can see it.

### How a hold works

- A hold is a release time on an organization switch:
  `public.platform_setting_definitions.release_at`. Null means released. A time
  later than now holds the switch; `infinity` holds it with no date. Only
  boolean switches (`features.<area>.<name>`) can be held.
- While a switch is held, every server read answers off for every organization
  whatever its stored value or the default, the admin settings list leaves the
  switch out, the member switch map reports it as off, and the organization
  writes refuse it exactly as they refuse a key that does not exist. A stored
  organization value is kept, untouched.
- When the release time passes the switch behaves as before, with no deploy:
  listed, editable as its definition says, stored values and the default
  honored.
- The first hold of a switch is a reviewed migration. After that its release
  time is operator data: the platform operator sets a date, moves it,
  moves every date from a day on by whole weeks, holds it with no date or
  releases it, with no migration and no deploy, on Production and the SAMPLE
  tour together. Each change writes an audit row (who, key, old time, new
  time, reason). A switch that was never held cannot be held this way.
- Two database functions make the change and change only `release_at`:
  `public.set_platform_setting_release` (one switch) and
  `public.shift_platform_setting_releases` (every dated hold from an Eastern
  day on, keeping the Eastern time of day; never a hold with no date or a
  released switch; it moves nothing unless the holds it locks are exactly the
  ones the caller previewed, with the same times, and it refuses the whole
  shift, before writing anything, when a new Eastern time would fall in the
  spring-forward gap, naming the switch and the time; a time in the fall-back
  hour moves and keeps its wall time). They admit a platform operator in a stepped-up session
  (`private.compass_platform_operator()`) and the database owner session that
  `scripts/release-calendar.mjs` opens through the Supabase Management API,
  with the person's name. An organization admin never can.
- `scripts/release-calendar.mjs` reaches both databases in one command,
  Production first, then SAMPLE. It shows what will change on each and asks
  once before saving, refuses a change that would leave the two sites
  different, and its list marks any switch whose time differs between them.
  "Now" is the databases' clock, never the workstation's, and every saved
  switch must read back as it was shown or the command fails. It refuses a
  set, move or shift onto an Eastern time the clocks skip before it calls
  either site.
- The release calendar screen lists every switch with a release time
  for a stepped-up platform operator, and its Release and Hold buttons
  change both sites the same way: each press is confirmed with a reason and
  goes to the server route `api/release-calendar.js` (unionground.net only),
  never to a database from the browser. The route changes Production with the
  operator's own session, so the database's operator check decides who may
  press, then SAMPLE with SAMPLE's service key through
  `public.get_platform_setting_release_for_follow` (the read) and
  `public.follow_platform_setting_release`, which the service role alone may
  call (it has no direct read or write of the definitions table): the write takes Production's time, only while SAMPLE still holds the time the
  route read, refuses what `set_platform_setting_release` refuses (the shared
  `private.platform_setting_release_previous`) and audits the change under the
  operator's name. Release is the database clock and Hold is `infinity`; the
  client sends no site and no time, and the screen sets no date of its own.
  Both sites are read back. A press is refused before any write when the
  sites already differ, unless Production already shows the result and only
  SAMPLE is behind; a press that changed Production and not SAMPLE says so and
  names `sync`, and pressing again only copies Production's time to SAMPLE;
  that button stays on the switch until a press of that switch reads back the
  same on both sites, kept for each switch and action on its own, so a second
  unfinished switch or an uncertain opposite action on the same switch never
  takes the first action's button. A press whose read-back failed is
  called unconfirmed, never a SAMPLE failure; a press with no readable answer
  (lost in transit, a 5xx such as `production-unavailable` after the
  Production write, or an unreadable reply) is called uncertain and keeps the
  button too. The reason is one line with no control characters, in the box
  and in the route alike, and a reason not saved on both sites is kept, per
  switch and action, for the next press. Only a press confirmed saved on both
  sites clears both unfinished actions and both reason drafts for that switch.
  With no usable SAMPLE backend the route changes nothing.
- `tests/feature-switches-release-hold-db.test.js` fails when a database
  function reads stored switch values or defaults directly without checking the
  hold, unless a short reviewed allowlist names it with a reason.
- A feature on the calendar that is not built yet (per-unit settings,
  the contracts library, per-organization rewards, iPad) lands
  behind its own switch, held from the migration that creates it, so it is
  never visible before its date (product decision of November 12, 2026, 10:36 PM
  ET; REQ-UG-HOLD-RELEASE-CALENDAR-SWITCHES-20261112,).
- Out of scope of the switch hold, each with its own record: a switch for the
  Neuro Map tab (REQ-UG-NEURO-MAP-ORGANIZATION-SWITCH-20261112), and
  controls that appear before a person has an organization. A feature with no
  organization switch cannot be held until it gets one.

### Controls on the sign-in screens

Added by REQ-UG-RELEASE-HOLD-ON-ENTRY-SCREEN-CONTROLS-20261112 (
product decision of November 12, 2026, 5:18 AM ET, option A).

- Three sign-in controls appear before anyone has an organization, so each
  carries its release time on a platform definition: the Apple button
  (`features.identity_providers.apple`), the Google button
  (`features.identity_providers.google`), both platform-only and default on,
  and the single sign-on control (`features.security.sso`, the organization
  switch it already had). They are held the same way as any switch.
- `public.get_entry_screen_release_state()` answers, for those three keys only,
  whether each is released. `/api/auth-signin-options` returns that as
  `released` and offers a provider only when it is released. SAMPLE, a failed
  read and every 503 answer all three as held.
- The web sign-in card and the native sign-in screen (iPhone and Android) draw
  a provider button, its notes and the single sign-on control only when that
  key is released. Held, or after a failed read, they draw nothing for it. A
  native build without native provider support reads the route too. Released,
  the screens are unchanged, including the disabled, explained button for a
  provider that is released but not offered ( narrowed only for held
  keys and failed reads).
- While `features.security.sso` is held, single sign-on discovery
  (`/api/sso-signin`) answers as for a domain with no provider, and the
  organization switch is off and out of the admin list like any held switch.
- Store builds older than do not read `released`: while those controls
  are held they keep drawing the provider buttons (disabled) and the single
  sign-on control, and the server refuses them either way (no provider is
  offered; discovery answers no provider).

### The learning period

Added by REQ-UG-HOLD-LEARNING-PERIOD-OFFER-UNTIL-RELEASE-20261112
under the product decision of November 12, 2026, about 10:36 PM ET, that
every function on the calendar is off and invisible until its release day.

- The learning period with undo had no switch. It now has a platform-only one,
  `features.guidance_onboarding.learning_period` (default on, organizations
  cannot change it), created already held in the migration that adds it.
- While it is held, no organization is offered a learning period and none can
  start one: `public.get_organization_learning_period()` returns null and the
  start is refused like an organization the period is not available to. The
  web app and the iPhone and Android apps draw nothing on a null read, so the
  installed store builds follow the hold with no new build.
- A period that is already running keeps working until it ends: the read still
  returns it, and its banner, practice history, end early and undo are
  unchanged. Undo is a safety behaviour and never waits for a release date. A
  period that ended shows nothing until the release.
- The web fixture preview, which draws a fictional running period without a
  server, draws none.

### Per-unit settings

Added by REQ-UG-PER-UNIT-SETTINGS-20261109, which builds the
feature behind its own platform-only switch,
`features.governance.per_unit_settings` (default on, organizations cannot
change it), created already held with no date.

- While it is held, `public.get_my_unit_settings()` answers only
  `released: false`, and the web app and the iPhone and Android apps take that
  as a server without units: no unit choice, no unit label, no settings
  editor, and every form, workload entry and template task saves as before.
  The settings editor read and both settings saves are refused as for a
  person who may not edit them, and a unit chosen by a stale client is
  refused.
- Held, every unit resolves to none, the chapter's own settings apply, the
  shared form, task and workload triggers stamp nothing, and a unit's stored
  settings narrow no officer permission. Stored settings are kept.
- When the release time passes the feature works as built, with no deploy.

### Sections of the public pages

Added by REQ-UG-PUBLIC-PAGE-SECTION-SWITCHES-AND-SIGN-IN-DESIGNS-2-TO-4-20261117
for the Sunday release plan's choices 6 and 7 (product decision of
November 13, 2026, 1:48 PM ET): sign-in designs 2 to 4 and the 3D map on Find
your union are built behind switches and released by hand.

- A part of a signed-out page that waits for its release carries its release
  time on a platform-only boolean definition `features.public_pages.<section>`
  (default on, organizations cannot change it), created already held with no
  date: `sign_in_design_2`, `sign_in_design_3`, `sign_in_design_4` and
  `unions_map_3d`. `scripts/release-calendar.mjs release KEY` releases one.
- `public.get_public_section_release_state()` answers `{ released: [...] }`,
  the short names of the sections whose release time has passed. A held
  section is not named at all. `/api/public-sections` returns the same list,
  narrowed to the sections that build knows; a failed read or a missing
  backend names none.
- The web pages ask through `usePublicSectionReleased(section)`
  (`src/lib/publicSections.js`): false while the read runs and after it
  fails, so a held section never shows, not even for a moment.
- A new section is one more definition, created held by a reviewed migration,
  and one more name in the route's and the web list.

### The calendar

The keys held by a reviewed migration, each with the time that migration set.
This list and the held-keys pin in
`tests/feature-switches-release-hold-db.test.js` say the same thing. The dates
after that are operator data and live only in the two databases:
`node scripts/release-calendar.mjs list` shows them, in Eastern time, for
Production and SAMPLE side by side. No test pins a date set that way.

| Key | Feature | Held by | Time the migration set |
| --- | --- | --- | --- |
| `features.identity_providers.apple` | Apple sign-in button | `hold_identity_provider_buttons` | none yet (`infinity`) |
| `features.identity_providers.google` | Google sign-in button | `hold_identity_provider_buttons` | none yet (`infinity`) |
| `features.ai_assistant.field_notes_packet` | Draft a packet from field notes | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.attention.dashboard` | Attention queue on the steward desk | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.attention.guided_portal` | Attention-guided steward home (master switch) | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.attention.member_surfaces` | Attention badges in member lists | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.attention.navigation` | Attention shortcuts in the command palette | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.automation.default_recipes` | Default automation recipes | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.civic.watchlist` | Civic watchlist and contract calendar | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.engagement_voice.bargaining_survey_template` | Bargaining survey from the Units 8 and 10 agreement | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.governance.per_unit_settings` | Per-unit settings: a unit set up differently from its chapter | `per_unit_settings`, held from its creation | none yet (`infinity`) |
| `features.guidance_onboarding.learning_period` | Learning period with undo: the offer and the start | `hold_learning_period_offer`, held from its creation | none yet (`infinity`) |
| `features.integrations.scim` | Directory sync (SCIM), held with single sign-on | `hold_scim_directory_sync` | none yet (`infinity`) |
| `features.intelligence.neuro_map` | Neuro Map | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.intelligence.neuro_map_auto_progress` | Neuro Map add-on: automatic topic readiness | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.intelligence.neuro_map_derived_graph` | Neuro Map add-on: derived connections | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.intelligence.weekly_digest` | Weekly issue digest | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.intelligence.weekly_digest_ai` | Weekly digest add-on: Compass summary | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.member_invitations.enabled` | Members send invitations | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.public_pages.sign_in_design_2` | Sign-in page, design 2 | `public_page_section_switches`, held from its creation | none yet (`infinity`) |
| `features.public_pages.sign_in_design_3` | Sign-in page, design 3 | `public_page_section_switches`, held from its creation | none yet (`infinity`) |
| `features.public_pages.sign_in_design_4` | Sign-in page, design 4 | `public_page_section_switches`, held from its creation | none yet (`infinity`) |
| `features.public_pages.unions_map_3d` | Find your union, 3D map | `public_page_section_switches`, held from its creation | none yet (`infinity`) |
| `features.security.member_pin_signin` | Member PIN sign-in | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.security.sso` | Single sign-on control and switch | `hold_release_calendar_switches` | none yet (`infinity`) |
| `features.tasks.coop_checkoff_lists` | Member check-off lists on tasks | `hold_release_calendar_switches` | none yet (`infinity`) |

Two held features had surfaces their organization switch did not hide, so the
same migration makes them read the hold itself (and only the hold: released
but switched off by an organization, they behave as before). While
`features.automation.default_recipes` is held, the automation workspace has no
default-recipes block, recipe definitions and their runs are left out of every
automation read, and a recipe's detail or run is refused like an unknown one;
the rows stay stored. While `features.security.sso` is held,
`public.get_sso_control()` answers only `released: false`, every single
sign-on setup write is refused, and the web Integrations page shows no Single
sign-on tab and sends a link to it to the first tab.

Directory sync (SCIM) is held with single sign-on (product plan choice 8,
November 13, 2026) by `hold_scim_directory_sync`, which makes its setup
read the hold the same way. While `features.integrations.scim` is held,
`public.get_scim_control()` answers only `released: false`, no token is issued
and `/scim/v2` answers 403 for every token, and the web Integrations page shows
no SCIM tab, no SCIM row under Providers and sends a link to the tab to the
first tab; the phone Integration controls screen shows no SCIM card.

The two provider buttons are one release. The learning period keeps a period
that is already running, with its undo (see "The learning period" above). An add-on is held with its parent
when it has no use while the parent is held. Left out on purpose:
`features.security.member_pin_restricted_sessions`, a safety restriction that
is on by default. A held switch reads off, which would lift the restriction
from a PIN session that is still live; with member PIN sign-in held, no new
PIN session starts. Calendar features with no switch cannot be held until
they get one. Each date is set later, one release at a time, with
`scripts/release-calendar.mjs`.
