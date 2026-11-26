# Area contracts

Product and subsystem rules that matter when you work in that area. Read the
row's file before changing anything in its scope.

## Rules that apply everywhere

- **Never commit on `main`.** Work on a branch and open a pull request.
- **Never name a source-system target.** The refs and hosts whose sha256
  digests are listed in `forbiddenSupabaseRefSha256` / `forbiddenAppHostSha256`
  (`config/sample-backend.json`, enforced by `src/lib/providerContract.js`) are
  hard-blocked at runtime and asserted absent by
  `tests/provider-boundary.test.js`. The API uses a configured backend only
  through `api/_lib/providerBoundary.js`. If a migration, script, deploy
  target or document needs a project ref, use a placeholder.
- **`npm run check` is the gate.** CI runs every part of it as parallel lanes
  of `.github/workflows/ci.yml` on each pull request and push to `main`
  (`ci.md`). Run the parts your change touches before you claim it works.
- **Row Level Security is the authorization boundary.** The browser gets only
  the project URL and publishable key. Client writes go through bounded
  security-definer RPCs; do not add anonymous table grants and do not widen a
  policy to make a view easier to build.
- **`src/sg-tokens.css` is SHA256-pinned** by `tests/sg-tokens.test.js`.
  Change the pin in the same pull request as the tokens.

## House style

Double-quoted strings, semicolons, two-space indent. Comments explain *why* a
non-obvious decision was made, not what the next line does.

## Contracts

| Contract | Scope | Path |
| --- | --- | --- |
| Web shell and native mobile | No phone frame in the web shell; one native Expo codebase; light canvas; Home drawers, the Work destination and the five-tab dock; organizing-only concepts; native sign-in | [`web-shell-and-native-mobile.md`](web-shell-and-native-mobile.md) |
| Native interaction and depth | Native theme and palette, the Home card and drawer, the Guide composer, the Work screen, and physical-phone acceptance | [`native-interaction-and-depth.md`](native-interaction-and-depth.md) |
| Mobile release | Building the native app and uploading to the stores, and the hand-dispatched iOS release workflow that keeps building apart from uploading | [`mobile-release.md`](mobile-release.md) |
| Superseded role-grant RPCs | The two retired role-grant RPCs that must never return | [`superseded-role-grant-rpcs.md`](superseded-role-grant-rpcs.md) |
| CI lanes and the required `check` | The parallel lanes of `ci.yml`, what the `check` aggregate means, what blocks a merge and what only reports, and the runner rule | [`ci.md`](ci.md) |
| Static public demo deploy | How the public demo deploys: the static-only build and package, the `deploy/demo` Root Directory, the Vercel settings, the watchers and rollback | [`demo-deploy.md`](demo-deploy.md) |
| Visible-control honesty | Every visible control acts or says why it cannot; what a person is told when a control is blocked, limited or fails | [`visible-control-honesty.md`](visible-control-honesty.md) |
| Time zones per group | Each group works in its own named time zone; how days, deadlines, clocks and send times are worked out, and the fixed-zone inventory | [`time-zones-per-group.md`](time-zones-per-group.md) |
| Staged feature releases | Holding a finished organization switch until its release date, how a hold is set and moved, and the held keys | [`staged-feature-releases.md`](staged-feature-releases.md) |

Conventions for migrations, RLS policy comments and provenance live in
`docs/conventions/`.
