# Demo bots

Fictional personas that drive the auth-free demo (`/m?demo=1`) in a real
browser, one script at a time, the way that person would use it. Adapted from
an earlier Tamarack Valley bot kit: the persona format, the function catalog
with coverage and lint, the checks against the app's own i18n copy, and the
one-fresh-browser-per-script runner come from there. The SAMPLE project,
seeded accounts, sign-in, MFA enrollment, mail and mobile runners do not,
because Union Ground has no provider of its own yet. Nothing here seeds a
database.

- `personas.json`: nine invented people. Six of them already appear in
  `src/data/fallback.js` (Darnell Foster, the demo Worker, and five
  staff-desk names), plus Miguel Serrano (Spanish, phone) and Jun Park (lead
  organizer). Ruth Adebayo is a prospect who opens the demo from the
  sign-in screen. Each one has one seat: the Worker (`member`), a staff hat
  (a `STAFF_PLANES` key), or `prospect`. The data they read is the demo's
  own: `src/data/fallback.js` expanded by `src/data/demoSeed.js`.
- `function-catalog.json`: the demo functions (`DM-*`) the bots exercise.
- `scripts.mjs`: what each bot does. Each script names its persona and the
  functions it covers.
- `target.mjs`: the guard. It refuses any app that is not served from
  loopback.
- `run.mjs`: the runner.

## Safety rails

- **Loopback only.** `resolveDemoTarget` accepts `127.0.0.1`, `localhost` and
  `[::1]` and refuses everything else, including a hosted Union Ground
  deployment. It runs before a server or browser starts.
- **No backend.** Every request a page makes off the app's own origin is
  aborted and fails the script, so a write that escapes the demo stub cannot
  reach any Supabase project and shows up as a failure instead. Request
  routing does not see everything (the later hops of a redirect, WebSockets,
  service workers), so each bot's browser context also sends every connection
  except the app's own host and port through a proxy that forwards nothing and
  records what it refused. The browser is launched with WebRTC's non-proxied
  UDP disabled, since the proxy carries TCP only. Another port on loopback
  counts as off-origin: a
  local Supabase stack listens there. `tests/demo-bots-rails.test.js` proves
  both rails against a trap server.
- **No sign-in.** The bots hold no credentials and never type any.

## Running

```bash
node demo-bots/run.mjs list        # scripts, their bots and titles
node demo-bots/run.mjs coverage    # every DM-* function has a script
node demo-bots/run.mjs lint        # personas, catalog and scripts agree

npm run build
npm run bots:demo                  # serves dist/ on a free loopback port, runs every script
npm run bots:demo -- --only W-MEMBER-01,W-CHAIR-01 --headed
npm run bots:demo -- --base-url http://127.0.0.1:5173   # against a running `npm run dev`
```

Every script starts by dismissing the welcome dialog (except the prospect,
who enters from the sign-in screen). The phone shell has no Exit demo button
and shows a "Demo tour" chip instead of the preview banner; `seeBanner`
accepts either.

Each run writes `report.json`, plus a full-page screenshot of every failed
script, to `demo-bots/.runs/<timestamp>/` (ignored by git), or to `--out <dir>`.

`tests/demo-bots.test.js` pins the guard, the kit's consistency and the
command line in `npm test`, and `tests/demo-bots-rails.test.js` pins the
network rails in a real Chromium. The bot run itself is not part of
`npm run check`.

A failed script's report entry lists the requests that failed while it ran, so
a view that did not load can be told apart from a check that is wrong.

## Adding a script

1. Add the function to `function-catalog.json` if it is new.
2. Add the script to `scripts.mjs`. Use the `ui` helpers (`hat`, `click`,
   `section`, `tab`, `seeHeading`, `seeText`, `seeToast`, `seeBanner`, `gone`,
   `voteOnce`, `openRights`, `dismissDialogs`, `exitDemo`) and check app copy
   through `copy(key, lang)` where a catalogue key exists. A step that only
   clicks proves nothing: `section` and `tab` take the text that destination
   itself shows, and a script should end each move on something only the
   place it reached renders.
3. `node demo-bots/run.mjs lint`, then run the script with `--only`.
