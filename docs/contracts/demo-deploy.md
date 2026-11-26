# Static public demo: how it deploys

Written November 11, 2026 (owner order of November 11, 2026, unit 12).
`docs/contracts/README.md` indexes it.
`tests/demo-deploy.test.js` pins what this page says, and
`config/demo-deploy.json` holds every value it names.

The public demo is a static build of the auth-free surface: fictional data,
every write stubbed, no backend. The official demo is served by a Vercel
project at `https://unionground.org`. The repository names no Vercel team,
project or project id: `vercel.team`, `vercel.project` and
`vercel.projectId` in `config/demo-deploy.json` stay empty, and whoever runs a
demo uses their own (written `<team>` and `<project>` below) and lists their
own hostnames there. The real product (accounts, the
functions under `api/`, the crons) is not deployed anywhere, and its config,
the root `vercel.json`, must never reach the demo's origin.

## What must never reach the demo's origin

- a serverless or edge function, including any file under `api/`, and
  middleware;
- a cron;
- a rewrite or route to a server path (`/api/...`) or to another origin;
- a hosted database address (a Supabase project host or a Postgres
  connection string) in any served file;
- a secret or environment variable read at build time. The demo project has
  no environment variables, and the build inherits no `VITE_`, `SENTRY_` or
  `SUPABASE_` variable and refuses a root `.env` file a production build would
  load.

`/api/runtime-config` is the one `api/` path the demo serves, as a static
file: the inert script that says the surface is the demo and is not
configured, so the browser never looks for a backend.

## The design

**One build command.** `npm run build:demo` (`scripts/build-demo-site.mjs`)
does what the earlier hand recipe did on a build machine:
`VITE_APP_SURFACE=demo VITE_VISUAL_AUDIT=1 npm run build`, the bundle identity
scan, then the package. The package is Vercel's Build Output API layout at
`deploy/demo/.vercel/output`: every file of `dist/` under `static/`, the inert
runtime-config script at `static/api/runtime-config`, and a `config.json` with
three routes (that script's headers, the filesystem, a single-page fallback to
`/index.html`). It is the same `config.json` and the same runtime-config bytes
the hand recipe's `package-demo.py` wrote. The script ends by checking the
package with `staticDemoOutputProblems` (`scripts/lib/demo-site.mjs`) and fails
the build unless it is static only. Vercel takes a Build Output API package
as it is, with no framework adapter and no function detection; it adds only an
empty `crons` list, an empty `daemons` map and an error-phase route to the
static `404.html`, which the same check accepts (a `vercel build` of this
layout on November 11, 2026 showed exactly that, and no function).

**Its own Root Directory.** The demo project's Root Directory is
`deploy/demo`, which holds only its own `vercel.json` and a `package.json`
that pins Node. Vercel reads `vercel.json` and looks for `api/` and
middleware only inside the Root Directory, so the product's root `vercel.json`
(its functions, crons, rewrites and `npm run check` build) and the root `api/`
directory are never read for this project. The demo's `vercel.json` may set
only the framework (`null`, Other), the install, build and ignore commands and
the branch map; `tests/demo-deploy.test.js` refuses anything else. The root
`vercel.json` is unchanged and stays the product's.

So the product config cannot reach the demo's origin through three
independent locks: the Root Directory never reads it; the build writes a
package with no function or cron and fails if one appears; and the uptime
watch probes every product function and cron path on every hostname and fails
unless each answers with the static shell.

**Which branches deploy.** Production builds from `main`. A preview builds
only from a branch named `demo-preview/...`, for checking a change before it
reaches production. Every other branch, including Dependabot's and lane
branches, deploys nothing: `git.deploymentEnabled` turns every branch off
(`"**": false`) and turns on `main` and `demo-preview/**`, and the Ignored Build
Step (`scripts/demo-ignored-build-step.mjs`) repeats the rule.

## Vercel settings

| Setting (Project Settings) | Value |
| --- | --- |
| Root Directory | `deploy/demo` |
| Include files outside the Root Directory in the Build Step | Enabled (the build reads the repository root) |
| Skip deployments when there are no changes to the root directory or its dependencies | Disabled (every `main` commit deploys) |
| Framework Preset | Other (`vercel.json` sets `framework: null`) |
| Build Command | override off; `vercel.json` runs `node ../../scripts/build-demo-site.mjs` |
| Install Command | override off; `vercel.json` runs `cd ../.. && npm ci` |
| Output Directory | override off and empty; the build writes `.vercel/output`, which Vercel serves as is |
| Ignored Build Step | Automatic; `vercel.json` runs `node ../../scripts/demo-ignored-build-step.mjs` |
| Node.js Version | `22.x` (also `engines` in `deploy/demo/package.json`; CI uses `.nvmrc`, 22) |
| Production Branch | `main` |
| Branches that deploy | `main` (production) and `demo-preview/` branches (preview); no other |
| Environment Variables | none |
| Domains | the hostnames in `config/demo-deploy.json` (`unionground.org` for the official demo) on Production, unchanged |
| Deployment Protection | unchanged (previews behind Vercel Authentication) |

## Watchers

Both run on `main` only, by schedule or by hand, on `ubuntu-24.04`, read no
secret beyond the run's own token, install nothing, and report a red run
through `.github/actions/watcher-red` (one deduplicated issue, closed by the
next green run). Neither needs Vercel's API: they read what the demo serves
publicly.

| Workflow | When (UTC) | What it reads and when it is red |
| --- | --- | --- |
| `demo-freshness-watch.yml` | every two hours at :37 | `build-info.json` on every hostname. Red when they differ, when the commit is not on `main`'s fetched first-parent history (about 300 commits), and, once `deploySource` in `config/demo-deploy.json` is `git`, when the oldest `main` commit the demo does not serve yet has been on `main` more than 60 minutes. While it is `hand` the run reports how far behind the demo is and stays green. |
| `demo-uptime-watch.yml` | every six hours at :23 | On both hostnames: the landing page answers 200 with the build marker; `build-info.json` names an exact commit; `/api/runtime-config` is the inert script; every path the product serves from a function or cron (each `api/` file and each function and cron in the root `vercel.json`, 48 today) answers with the static shell; the certificate is trusted and has at least 14 days left. |

About 225 runner minutes a week: 12 freshness runs a day and 4 uptime runs a
day, each a check job and a watcher-red job of about a minute.

## Deployments

Added November 13, 2026 (#106). The deployment resolver reads only what a
workflow gets for free: the GitHub deployments and deployment statuses that
Vercel's Git integration writes for this repository, through the run's own
token, and `build-info.json` on the hostnames. No Vercel token, no secret, no
repository variable. Until the project is connected to Git (the cutover
below) Vercel writes no deployment here, so the
resolver answers from `build-info.json` alone.

A deployment counts only when Vercel's bot (`vercel[bot]`) created it, for an
exact commit, in the GitHub environment `Production` (or
`Production – <project>`, the name Vercel uses when several projects
share a repository). Its statuses say what happened: a `success` means it
succeeded (a later `inactive` only means a newer deployment replaced it); a
`failure` or `error` with no success means it failed; only `inactive` means
Vercel skipped the build because the Ignored Build Step said there was nothing
to build, and the previous deployment still serves.

**The resolver.** `node scripts/resolve-vercel-deployment.mjs <commit>`
(an exact 40-character SHA) says whether the demo serves that `main` commit:
`served` when what the hostnames serve (or, when they cannot be read, the
newest successful Production deployment) is that commit or a later one
containing it, with the deployment that serves it; otherwise `failed` (its
own deployment failed), `skipped` (Vercel skipped its build and an earlier
deployment still serves), `pending` (still building) or `not-served`
(nothing carries it yet, or its deployment was rolled back). A commit with no
deployment of its own is still live once a later deployment contains it. Exit
0 when served, 2 when not, 1 when it cannot tell.

## Cutover from hand deploys to Git (done by a person, in order)

Until step 10 merges, the demo is deployed by hand and `deploySource` is
`hand`. Run the `vercel` commands from an empty scratch directory, never from
a checkout, so no `.vercel` link or pulled file lands in a repository.

1. **Record the rollback target.** `vercel ls <project> --scope <team> --environment production`
   and note the newest Ready production deployment URL and its commit.
2. **Confirm there are no environment variables.**
   `vercel env ls --scope <team>` (linked to `<project>`)
   lists none. Remove any that appear before going on.
3. **Apply the settings** in the table above (Project Settings, Build and
   Deployment, and Git). Then
   `vercel project inspect <project> --scope <team>` shows
   Root Directory `deploy/demo`, Framework Preset Other and Node.js `22.x`.
4. **Connect the Git repository** (this repository or your fork; Project
   Settings, Git) and set the Production Branch to `main`. Connecting deploys
   nothing by itself. If Vercel does start a production build here, let it
   finish and run the checks in steps 6 and 8 against it.
5. **Build a preview.** Push a preview branch at `main`'s head:
   `git push origin origin/main:refs/heads/demo-preview/cutover-YYYYMMDD`.
   Vercel builds a Preview deployment; its build log ends with
   `build-demo-site: static-only package of ... files ... no function, cron, server rewrite or hosted database address.`
6. **Check the preview before production.** With its URL from `vercel ls`:
   - `vercel inspect <preview-url> --scope <team>` lists no function
     (no λ output);
   - `vercel curl /build-info.json --deployment <preview-url> --scope <team>`
     names `main`'s head;
   - `vercel curl /api/runtime-config --deployment <preview-url> --scope <team>`
     prints the inert script (`surface:"demo",configured:false`);
   - `vercel curl /api/notifications-dispatch --deployment <preview-url> --scope <team>`
     prints the HTML shell, not a function's answer;
   - open the preview in a browser signed in to Vercel: the landing page,
     then `/m?demo=1` and the five tabs.
7. **Promote it.** `vercel promote <preview-url> --scope <team> --yes`.
8. **Check production.** Every hostname serves `main`'s head in
   `/build-info.json`; the project's Cron Jobs settings page lists none;
   dispatch `demo-uptime-watch.yml` and `demo-freshness-watch.yml` on `main`
   and both are green.
9. **Delete the preview branch.**
   `git push origin --delete demo-preview/cutover-YYYYMMDD`.
10. **Flip the records to Git in one pull request:** `deploySource` to `git`
    in `config/demo-deploy.json`. Its merge is
    the first ordinary Git production deploy: within the hour every hostname
    serves the merge commit and the next freshness run is green while
    enforcing.
11. **Check the deployment.** `node scripts/resolve-vercel-deployment.mjs <merge commit>`
    prints `served` with that deployment's id.

## Rollback

- **One bad deploy:** `vercel rollback <previous-production-url> --scope <team> --yes`
  points every domain back at an earlier production deployment at once (the
  dashboard's Instant Rollback does the same). After a rollback Vercel stops
  assigning the domains to new production builds until a person runs
  `vercel promote <deployment-url> --scope <team> --yes` for a good
  deployment (or Undo Rollback in the dashboard), so the freshness watch turns
  red after an hour as a reminder.
- **A failed build** changes nothing on the origin: the previous production
  deployment keeps serving, and the freshness watch turns red after an hour.
- **Undo the cutover:** roll back as above, disconnect the Git repository
  (Project Settings, Git), and set `deploySource` back to `hand`. Hand deploys
  can continue with `vercel deploy --prebuilt` from a fresh
  `npm run build:demo` package; the Root Directory setting does not affect a
  prebuilt upload.

## What only the cutover can prove

The repository proves the package is static only and the demo config names
nothing else, and a local `vercel build` from `deploy/demo` proves Vercel's
builder runs the install and build from there and adds no function or cron.
Only a real Git build on Vercel proves that Vercel reads
`deploy/demo/vercel.json` and not the root one, that it serves the Build
Output API package as is, that the install from the repository root succeeds
on Vercel's image, and that the branch map and Ignored Build Step behave as
written. Steps 5 to 8 are those proofs. Only a real Git deployment proves
the shape of what Vercel writes to GitHub (the environment name, the bot, the
statuses of a skipped build) and that the resolver reads it: step 11.
