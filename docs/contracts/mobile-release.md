# Mobile release contract

Union Ground's own rules for building the native app on EAS and putting it
in the stores, and the hand-dispatched workflow that enforces them. Owner
decision of November 11, 2026, 10:15 PM ET: no store upload without the
owner's typed go, and at most one store release in any 7 days.
`docs/contracts/README.md` lists every area contract.

## Store rhythm

- **The owner's typed go, every time.** No App Store Connect or TestFlight
  upload, no Beta App Review or App Review submission, and no Google Play
  upload happens without the owner's written authorization for that exact
  release. Authorization is never inferred, never carried over from an earlier
  release, and never standing. The same holds for any EAS build: each one
  needs its own authorization, because builds spend EAS build minutes.
- **One store release in any 7 days.** Never more than one App Store upload
  in any 7-day window. An upload that falls inside 7 days of the previous one
  needs a fresh written authorization that says so.
- **One general line.** App Store "What's New" and TestFlight "What to test"
  carry one general line, "General updates and improvements", never an
  itemized list, record ids or screen names.
- **No new signing material without the owner.** Creating, rotating or
  storing a certificate, provisioning profile, keystore or store API key is a
  credential action. No authorization manifest here allows one; the owner
  authorizes it separately.
- **Identity.** Every build uses the deployment's own Expo owner, EAS
  project and application id, from the `EXPO_OWNER`, `EAS_PROJECT_ID` and
  `MOBILE_APPLICATION_ID` variables over the placeholder defaults in
  `config/mobile-release-foundation.json` (apps/mobile/README.md, "Your own
  app identity"). `apps/mobile/app.config.ts` refuses a store build on the
  placeholders, and the release workflow refuses a build that does not match
  the repository variables.

## The written authorization

The owner's go takes the form of a one-line JSON manifest and its SHA-256,
checked by `scripts/lib/mobile-release-foundation-policy.mjs`: schema version,
an authorization id, mode (`sole-owner`), the exact source commit, platform,
profile, build count (one), explicit possible paid usage, credential actions
(none), version-counter action, distribution target, and an issue and expiry
time at most 7 days apart. `config/mobile-release-foundation.json` lists the
only scopes a manifest may name:

| Profile | Distribution target | Version counter | Can reach a store |
| --- | --- | --- | --- |
| `ci-ios-simulator` | `ios-simulator-internal` | `none` | never |
| `production` | `app-store-connect` | `increment` | only through a separate submit dispatch |

`npm run preflight:mobile-release` (`scripts/verify-mobile-release-foundation.mjs`)
checks a manifest kept outside the repository against a clean checkout of a
`main` commit before anything is dispatched.

## The iOS release workflow

`.github/workflows/mobile-ios-eas.yml` runs only when dispatched by hand
(`workflow_dispatch`), from `main`, on GitHub's `ubuntu-24.04` runner. Its
inputs are the exact commit, the operation (`build` or `submit`), the profile,
for a submit the EAS build id, and the authorization manifest with its
SHA-256. `scripts/verify-mobile-ios-eas-dispatch.mjs` is its gate; its tests
are `tests/mobile-ios-eas-dispatch.test.js`.

- **`attest`** reads no secret and names no environment. It refuses the
  dispatch when the authorization is missing, does not match its SHA-256, is
  for another commit, profile or platform, is expired or wider than its
  scope; when the commit is not the dispatched `main` commit; when the
  operation or profile is unknown; when a build names a build id; when a
  submit names no build id, names a simulator scope, or `apps/mobile/eas.json`
  has no `submit.production.ios.ascAppId`; when the release environment is
  not protected as below; and when the identity in the repository is not the
  one above. A build authorization is spent at this step (an artifact named
  after its SHA-256), so it cannot build twice.
- **`ios-build`** (operation `build`) runs one
  `eas build --platform ios --non-interactive --freeze-credentials --wait`
  for the authorized profile with the pinned eas-cli from `eas.json`, then
  checks the finished build's project, owner, application id, commit, profile
  and state. It has no submit step and never passes an auto-submit flag, so a
  build can never upload. `--freeze-credentials` makes EAS refuse to create
  or change signing material.
- **`ios-submit`** (operation `submit`, profile `production` only) builds
  nothing. It reads the named EAS build, refuses it unless it is a finished
  store build of the authorized commit in this project, refuses when an App
  Store upload was recorded in the last 7 days, records this upload (an
  artifact kept 14 days; a failed upload still counts), and then runs
  `eas submit --platform ios --id <build> --what-to-test "General updates and improvements" --no-auto-testflight-setup`.
  Submitting for Beta App Review or App Review stays a separate owner step.

Both secret-bearing jobs run in the `mobile-ios-release` environment, the only
place `EXPO_TOKEN` is stored (a robot token of the configured Expo account).
The environment must require a reviewer, disable administrator bypass and
allow only `main`. This repository has one developer, so the owner is the
reviewer and approves their own dispatch. The identity comes from three
repository variables, `EXPO_OWNER`, `EAS_PROJECT_ID` and
`MOBILE_APPLICATION_ID`, the only variables the workflow reads (never a
runner). `attest` checks them and passes them on; each build or submit job
compares them again before it talks to EAS. Until all three are set, every
job but `not-configured` is skipped and the dispatch only reports that the
release is not configured.

## Before the first store release

Read-only check of November 11, 2026: EAS holds no signing material for this
project and has never built it. App Store Connect app `6812377195` exists.
Before a `production` build and upload can run, the owner must authorize, as
separate credential actions: EAS-managed iOS distribution credentials, and an
App Store Connect API key stored on EAS for submissions. A pull request then
adds `submit.production.ios.ascAppId` to `apps/mobile/eas.json`. A
`ci-ios-simulator` build needs none of these.

There is no Android release workflow yet. Play Console state could not be read
from the development workstation; Android store work waits on the owner.
