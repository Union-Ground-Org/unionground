# Union Ground

Union Ground is a governed union-lifecycle workspace for organizing,
recognition and election outcomes, first contracts, worker participation,
campaign growth, and cooperation between organizing campaigns.

Union Ground is the open-source edition published by Union Ground LLC at
unionground.org. Every deployment brings its own hosting, database, domain and
repository targets; the repository ships placeholders only.

## Architecture

```text
Browser -> Vercel Vite build + authenticated guide function -> Supabase Auth/Data API -> Postgres
                                                        \-> Vercel AI Gateway
```

- Vercel serves the compiled React application.
- The same-origin `/api/guide` function verifies the Supabase access token, reserves a worker-scoped rate-limit slot, and calls Vercel AI Gateway using a statically configured `AI_GATEWAY_API_KEY` when one is set, otherwise server-only OIDC.
- The public `/connect` prototype encrypts an allowlisted minimal contact envelope before a service-only database RPC. It is disabled by four independent activation interlocks — the two enable flags, the exact confirmation token, and a `CRON_SECRET` of at least 32 characters — until ownership verification, an audited reviewer queue, and monitored deletion exist.
- Supabase owns authentication, REST, and Postgres.
- The browser receives only the project URL and publishable key. Row Level Security is the authorization boundary.
- Worker and campaign data is denied to anonymous users and scoped to `auth.uid()` for authenticated users.

## Local run

Prerequisites: Node.js 22+ (`.nvmrc` pins the major; `package.json` declares the same range in `engines`), Docker Desktop, and Docker Compose resources suitable for Supabase.

Node 22 is a hard floor, not a preference: `@supabase/supabase-js` declares `engines.node >= 22`, and `@vitejs/plugin-react`, `jsdom`, and `vitest` all require at least Node 20.19/22.13.

```powershell
npm install
npm run supabase:start
npm run supabase:reset
npm run build
```

Read the active local API URL and publishable key without committing either value:

```powershell
npx supabase status -o env
```

Set these values in an ignored `.env.local`:

- `VITE_SUPABASE_URL`: reported `API_URL`.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: reported `PUBLISHABLE_KEY`.
- `VITE_UNIONGROUND_SUPABASE_REF=local`.

Then run:

```powershell
npm run dev
```

Open the Vite URL at `/m`.

The application fails closed when Supabase variables are absent.

The in-repo fictional dataset is not test-only. `src/data/fallback.js` and `src/data/lifecycleFallback.js` are imported statically by `src/App.jsx` and therefore ship in the production bundle, downloaded by every real worker: they back the auth-free demo mode described below, and the worker data loader also falls back to the fixture's Section 7 rights lesson on the authenticated path when the campaign has no rights row of its own. Component tests are the third consumer, not the only one.

## Demo mode

Demo mode renders the whole member and staff shell over the fictional dataset with no account and no backend. It exists so a prospect can be shown the product without provisioning anything.

- Start it locally without keys:

  ```bash
  npm run dev:preview
  ```

  Then open `http://127.0.0.1:5173/m`. The command works the same in Windows Command Prompt, PowerShell, and Mac/Linux Terminal. `?demo=1` alone only works under the project's own e2e/visual-audit test harness, not an ordinary `npm run dev`.
- A synthetic session stands in for a real one, so the configuration gate is bypassed — demo mode works even when the `VITE_SUPABASE_*` variables are absent.
- A hat switcher moves between the Worker view and the Organizer, Committee, Campaign lead, Advisor, Admin, and Campaign chair planes.
- Every write is stubbed: the UI shows the toast it would show, and nothing is sent anywhere. No Supabase request is issued and no realtime channel is opened.
- Leaving demo mode clears the synthetic session and returns to the sign-in screen.

Because it is a shipped product surface rather than a fixture, treat the contents of `src/data/` as user-visible copy.

## Vercel

`vercel.json` runs the contrast/test/build gate, configures SPA routing, emits build metadata, and sets security headers. The demo must use a dedicated Union Ground project and origin.

Set these Vercel variables for Production and Preview:

- `VITE_SUPABASE_URL`: the Supabase project URL.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: the Supabase publishable key.
- `VITE_UNIONGROUND_SUPABASE_REF`: the exact browser-expected project ref.
- `UNIONGROUND_SUPABASE_PROJECT_REF`: the same exact ref for server functions. The API uses a
  hosted backend only when this ref matches `VITE_SUPABASE_URL` and that origin is an owner-approved
  pair in `src/lib/trustedBackends.js` (empty today, so every hosted backend is refused). For a local
  backend set it to `local` with `VITE_SUPABASE_URL=http://127.0.0.1:<port>` (or `localhost`). That
  loopback backend is used only with positive evidence of local work and no sign of a deployment
  (`VERCEL` or any `VERCEL_*` variable other than the build SHA, branch and CLI token, or a Lambda
  runtime variable such as `AWS_LAMBDA_FUNCTION_NAME`): `npm run dev` and Vitest provide it through
  `NODE_ENV`, and a local production preview sets `UNIONGROUND_LOCAL_BACKEND=1`. The rule and the
  exact list live in `api/_lib/providerBoundary.js`.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only key used by bounded server RPCs. Never expose it with a `VITE_` prefix.
- `UNIONGROUND_APP_URL`: the canonical HTTPS app origin.
- `CRON_SECRET`, `RESEND_API_KEY`, `NOTIFY_FROM_ADDRESS`, `NOTIFY_APP_URL`, and `NOTIFY_KILL_SWITCH`: notification and purge operations. Generate `CRON_SECRET` and every other shared secret in `.env.example` with `openssl rand -hex 32`. Every scheduled route answers 503 while its secret is missing, shorter than 32 characters or a placeholder such as `replace-with-...` (`api/_lib/cronAuth.js`).
- `VITE_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_CONTACT`: web push.
- `AI_GATEWAY_API_KEY` (optional, server-only): a static Vercel AI Gateway key. When set it takes precedence over OIDC. Leave it unset on Vercel so the deployment uses OIDC; a non-Vercel host has no OIDC to fall back to and must set it or `/api/guide` returns 503.

The encrypted public intake additionally needs `UNIONGROUND_CONNECT_SECRET` and `UNIONGROUND_CONNECT_KEY_VERSION`. Keep all three activation controls closed:

```text
VITE_UNIONGROUND_CONNECT_ENABLED=0
UNIONGROUND_CONNECT_ENABLED=0
UNIONGROUND_CONNECT_ACTIVATION_CONFIRM=disabled
```

Do not enable them until neutral contact ownership verification, an MFA-protected audited reviewer claim/decrypt/close workflow, and monitored daily purge are operational. The server also refuses intake when `CRON_SECRET` is absent, shorter than 32 characters or a placeholder — the same rule every scheduled route enforces — because a monitored daily purge is one of the activation preconditions.

`/build-info.json` reports `VERCEL_GIT_COMMIT_SHA` on a Vercel build and falls back to the local `git rev-parse HEAD`, or to the literal `unknown` when git is unavailable (`vite.config.mjs`). Only a Vercel-produced value is deployment-immutable; treat a SHA from any other build as unverified provenance.

## Running your own copy

The code is free software, but the Union Ground name, logo and app icon are
trademarks of Union Ground LLC ([`TRADEMARKS.md`](TRADEMARKS.md)). A copy runs
under its own name and logo, says who runs it, and offers its own source code.
The product enforces this:

| Setting | Where | Required | What it does |
|---|---|---|---|
| `VITE_BRAND_NAME` | Web build | Yes, for a production build | Your product's name, printed wherever the app names itself (pages, titles, the web app manifest, mail, notifications). A production `vite build` fails while it is unset, and when it is "Union Ground" in any case or spacing. Development and tests fall back to "Union workspace (development build)". |
| `BRAND_NAME` | Phone app (`apps/mobile`) | Yes, for a store build | The same, for the phone app's name, permission prompts and screens. A staging or production EAS build fails without it. |
| `OPERATOR_NAME`, `OPERATOR_CONTACT_EMAIL` | Server | Yes, on a deployed server | Who runs this server and how to reach them, shown on the public `/operator` page ("Who runs this server"). A deployed server refuses sign-in (`/api/runtime-config` answers not configured) until both are set. |
| `OPERATOR_URL`, `OPERATOR_JURISDICTION` | Server | No | Your website and the jurisdiction you operate under, also shown on `/operator`. |
| `SOURCE_CODE_URL` | Web build and phone app | Yes, if you changed the code | Where the "Source code" link on the about and legal screens points. It defaults to this repository; the AGPL requires a modified network service to offer its own source. |

Without official branding every build is unbranded: the mark is a plain
rounded square with your name's initial, drawn in code, and the icons under
`public/` and `apps/mobile/assets/` are neutral placeholders you can replace
with your own. Every about and legal screen keeps the notice "Based on Union
Ground (https://unionground.org)", which `NOTICE` requires of every modified
version.

**Official branding** is for Union Ground LLC's own builds only. It needs
`VITE_OFFICIAL_BRANDING=1` (phone: `OFFICIAL_BRANDING=1`) and the files in
[`branding/official/`](branding/official/LICENSE.md), which are not covered by
the AGPL and may not be used by modified versions. Only an official build
served from one of the LLC's own hosts (`config/official-domains.json`) shows
"Official Union Ground service", and an official phone app talks only to the
official service's backend. Releases published from this repository are
official and signed; see [`docs/RELEASES.md`](docs/RELEASES.md).

## Supabase production

- Apply every committed migration to a fresh, dedicated Union Ground project. The renamed lifecycle/canonical migrations are intentionally fresh-project-only and refuse unexplained pre-existing participation rows.
- Stop app traffic before applying the lifecycle writer-hardening migration; it is not an online or rolling-safe migration.
- Turn public sign-up off. Accounts are invitation-only and the server creates every account itself, but `enable_signup = false` in `supabase/config.toml` applies only to the local stack. On the hosted project open Authentication > Sign In / Providers and turn off "Allow new users to sign up" and "Allow anonymous sign-ins". Leave the Email provider enabled so members can sign in with a password. While public sign-up is on, the deployment refuses to serve: `/api/runtime-config` answers not configured and the invitation endpoints answer 503 (`api/_lib/signupPosture.js` reads the project's `/auth/v1/settings`). Set `ALLOW_OPEN_SIGNUP=true` only if open sign-up is intended.
- Keep email confirmation enabled unless the chapter explicitly chooses another authentication policy.
- Do not add anonymous table grants. All member workflows require an authenticated session. New tables in `public` are born with no client privileges (`20261125120300_client_default_table_privileges_revoke.sql`): the migration that creates a table grants `authenticated` exactly what it needs and enables row security.
- Set the Auth Site URL to the production app origin, and allow as Supabase Auth redirect URLs only the exact production and preview URLs the app uses (`/m` and `/reset` under each origin). Remove any wildcard or localhost entry from the hosted project.
- Verify database lint, security advisors, the full disposable runtime harness, and exact migration history before any hosted apply.
- Do not activate admin MFA reset until the chosen GoTrue deployment can fence in-flight factor enrollment or a reviewed recovery protocol covers that provider race.
- Clearing a ratification integrity hold goes through `public.resolve_ratification_integrity_hold`, which takes the bargaining writer lock, requires MFA, and leaves an append-only `union_lifecycle_audit_events` receipt. `ALTER TABLE ... DISABLE TRIGGER` is never the answer: it turns off an integrity control on live evidence data and leaves no record that it happened.

## Verification

System-Repair: the Vitest pool is pinned to two worker threads in `vite.config.mjs` (not in the `npm test` script) so Windows test runs cannot fan out into a large process tree, and so a bare `npx vitest run` gets the same bound.

```powershell
npm run check
npx supabase db reset --local
npx supabase migration list --local
```

`npm run check` covers token contrast, Vitest, and the production build. It does not run PostgreSQL fixtures, a secret scan, or deployed exact-SHA proof.

`.github/workflows/ci.yml` runs every part of `npm run check`, the repository conventions check, the native app check, the scanner self-test and a dependency audit as parallel lanes on every pull request and push to `main`, so the gate no longer depends on a Vercel project that does not exist yet. When a change touches a database input, its `db` lane restores disposable `unionground-lab-ci-*` labs on the runner from `main`'s database snapshot (`disposable-db-baseline.yml` replays every migration from zero to build it), applies only the change's newer migrations, and runs the migration history, the database contract and the required database proofs. The required status is its aggregate job `check` (`docs/contracts/ci.md`).

`.gitattributes` normalizes text files to LF, but the attribute only applies when a file is materialized — files checked out before the rule landed still have CRLF in the working tree. List them with `git ls-files --eol | Select-String 'w/crlf'`. Re-materializing the whole tree (`git ls-files -z | xargs -0 rm -f; git checkout -- .`) clears the backlog, but it overwrites every working-tree file: run it only when `git status` is clean, never with uncommitted work in the tree.

Run the mutating database verifier only against an empty, disposable project whose Docker label and name both match `unionground-lab-*`:

```powershell
$env:UNIONGROUND_DB_CONTAINER="supabase_db_unionground-lab-<id>"
$env:UNIONGROUND_DB_CONTAINER_ID=(docker inspect --format '{{.Id}}' $env:UNIONGROUND_DB_CONTAINER)
$env:UNIONGROUND_DB_CONFIRM="RUN_DISPOSABLE_UNIONGROUND_DB_TESTS:$($env:UNIONGROUND_DB_CONTAINER_ID)"
npm run test:unionground-db
```

The verifier binds permission to the immutable container ID and intentionally leaves fixtures for failure inspection. Use one fresh lab per run, then destroy that exact lab with `npx supabase stop --workdir <disposable-lab-path> --no-backup`; it never truncates a shared database.

The inherited `test:rls` entry point fails closed: it runs a refusal stub (`scripts/unionground-legacy-rls-disabled.mjs`), and the destructive source-system script it replaced has been removed from the working tree. It is not a safe Union Ground gate.

## Licensing and attribution

Union Ground is copyright Union Ground LLC and is licensed under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`); the full text is in [`LICENSE`](LICENSE). If you run a modified version as a network service, the AGPL requires you to offer its source code to that service's users.

[`NOTICE`](NOTICE) carries the copyright notice, two additional terms under section 7 of the AGPL, and the third-party notices:

- **Attribution:** modified versions must keep the notice "Based on Union Ground (https://unionground.org)" on their about or legal screen.
- **No trademark rights:** the license does not grant use of the Union Ground name or logo; forks use their own name and logo. See [`TRADEMARKS.md`](TRADEMARKS.md).

The self-hosted webfonts (Archivo, Public Sans and Spline Sans Mono) are SIL Open Font License 1.1 material, so their license and copyright notices travel with the binaries at `public/assets/FONT-LICENSE.txt` (served at `/assets/FONT-LICENSE.txt` in a deployment). `npm run verify:licenses` checks that every dependency in the lock files declares an AGPL-compatible license.

`package.json` stays `"private": true`: the repository is an application, not a package published to npm.

Contributions are accepted under the [Contributor License Agreement](CLA.md); see [`CONTRIBUTING.md`](CONTRIBUTING.md). Report security problems privately as described in [`SECURITY.md`](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
