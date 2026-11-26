# Paired Mac, iOS simulator, and physical-device runbook

Use this guide to build and verify the iOS app on a simulator or a trusted device.

`org.example.unionground` below is the placeholder application id; use your
own `MOBILE_APPLICATION_ID` (apps/mobile/README.md, "Your own app identity").

## Connection requirements

Use a Mac with Xcode, Node, and a trusted iPhone or simulator. If you work from
another computer, set `IOS_BUILD_HOST` to the Mac's SSH host or alias.

## Repeatable fast path

1. Resolve one clean exact SHA on Linux; never use the dirty primary checkout.
2. Reach the logged-in Mac through `ssh "$IOS_BUILD_HOST"` and freshly discover Xcode,
   Node, the trusted phone, and both Xcode/CoreDevice identifiers.
3. Fetch the exact ref on the Mac, or transfer an incremental Git bundle; create a task-owned detached worktree and recheck
   its SHA and cleanliness.
4. Use Homebrew Node 22, `npm ci`, and Expo prebuild. Build a signed Release app
   for embedded-bundle proof or a signed Debug development client for Metro.
5. Verify codesign, bundle identifier, provisioning/device coverage, artifact
   mode, and exact source before installing with `devicectl`.
6. For Debug, start Metro from the same exact worktree on an unused task-owned
   port, then prove the listening PID/cwd and selected development-server URL.
7. Install and launch `org.example.unionground`; confirm the installed app
   and running process instead of trusting the version label.
8. Drive product paths with a temporary signed XCUITest target using semantic
   labels/identifiers. Use CoreDevice HID only for device chrome or fallback
   gestures.
9. Capture with CoreDevice/XCUITest or mirror with `pymobiledevice3`. Expect an
   authenticated Union Ground surface to be black/privacy-covered; use bounded
   accessibility assertions and direct observation instead of weakening the
   privacy control.
10. Save only sanitized evidence. Stop only task-owned PIDs/tunnels, remove the
    clean task worktree and secret-bearing temporary files, and preserve the
    installed app, app data, signing custody, unrelated servers, and Git branch.

## Source and refresh model

- `apps/mobile` is the only active native client. Route shells live under
  `apps/mobile/app`; reusable native UI lives under `apps/mobile/src`.
- Home's over/under left and right drawers are implemented in
  `src/components/HomeCarousel.tsx` and mounted by `app/(tabs)/home.tsx`.
- The native tab bar is mounted by `app/(tabs)/_layout.tsx`, with Home,
  Messages, Pulse and Work in that order.
- Compass is implemented in `src/components/CompassPanel.tsx`, mounted in the
  right-edge panel by `src/components/QuickActionsDrawer.tsx` and on the
  standalone `app/compass.tsx` route reached by Ask Compass in Know your rights.
  Compass is not a native tab.
- Native tab VoiceOver (expo-router `~57.0.21` /
  `unstable-native-tabs`): each `NativeTabs.Trigger` accepts
  `accessibilityLabel` and maps it to `UITabBarItem.accessibilityLabel`
  (pinned as `"Home, 1 of 4"`, `"Messages, 2 of 4"`, `"Pulse, 3 of 4"` and
  `"Work, 4 of 4"`). It does **not** accept an accessibility role or value.
  The Trigger `role` prop is
  `UITabBarItem.SystemItem` (bookmarks, contacts, …), not a VoiceOver trait.
  `react-native-screens` 4.26.0 only forwards `tabBarItemAccessibilityLabel`
  and `tabBarItemTestID` onto the item. iOS 26 composes the spoken caption as
  name + Button + Selected + Tab; the Button trait cannot be replaced with a
  Tab-only role from app code. Re-check this on the next expo-router /
  react-native-screens upgrade before hand-rolling a JavaScript tab bar.
- `src/components/iosMobbinChrome.test.ts` and
  `src/components/previewChrome.test.ts` carry native-shell regression
  coverage. Run `npm run check` from `apps/mobile` for the complete mobile
  typecheck, tests, assets, contrast, and platform bundle checks.
- The installed app does not acquire a merged JavaScript change by itself;
  `expo-updates` is not configured in this client. A merge is not a device
  deployment. Rebuild and reinstall the exact merged SHA whenever the user
  expects a physical phone or simulator to show new source.

## Operating expectation

When the user asks to see a native iOS change on an available device, complete
the build, install, launch, and verification. Do not stop at an artifact URL or
ask the user to download the build. Ask for user interaction only when a device
trust, unlock, or macOS security prompt truly blocks automation after the safe
checks below.

Keep these targets distinct:

- An EAS `ci-ios-simulator` artifact is unsigned and runs only in an iOS
  Simulator.
- A physical iPhone needs a separately compiled `Release-iphoneos` app signed
  by an existing authorized Apple Development identity and a provisioning
  profile that includes that device.
- Neither local path proves store readiness or changes the repository's later
  App Store release gates.

## Connect to the Mac safely

Set `IOS_BUILD_HOST` using your local SSH configuration.

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 "$IOS_BUILD_HOST" \
  'hostname; sw_vers; xcodebuild -version'
```

`BatchMode=yes` is useful for discovery because it fails instead of hanging on
an unexpected password prompt. Remove it only when the operator explicitly
expects an interactive SSH authentication step. Do not print `ssh -G` output
into durable evidence because it can contain local connection details.

The Mac must be logged in, the phone must be unlocked and trusted, Developer
Mode must already be authorized, and Xcode must recognize it. These are the
only normal user-interaction points. A user may need to accept an Apple trust,
Developer Mode, or macOS Keychain dialog; after that, the session resumes the
build and device work itself.

## Put the exact source on the Mac

Never build the Mac's ambient checkout or an uncommitted primary checkout.
First try a normal `git fetch` in the Mac clone for the exact Main or review
branch. An incremental Git bundle is an alternative when the Mac cannot fetch the source directly. Both routes preserve Git identity and make
the SHA independently checkable on both hosts.

For current Main, the simplest route is:

```sh
mac_repo=PASTE_ABSOLUTE_UNIONGROUND_REPO_PATH
source_sha="$(git rev-parse origin/Main)"
ssh "$IOS_BUILD_HOST" "git -C '$mac_repo' fetch --no-tags origin Main"
mac_sha="$(ssh "$IOS_BUILD_HOST" "git -C '$mac_repo' rev-parse origin/Main")"
test "$mac_sha" = "$source_sha"

task_slug=unionground-ios-proof-YYYYMMDD
mac_worktree="$mac_repo/.worktrees/$task_slug"
ssh "$IOS_BUILD_HOST" "git -C '$mac_repo' worktree add \
  --detach '$mac_worktree' '$source_sha'"
```

Set `mac_repo` to the paired Mac's absolute clone path for the current session.
It is operator-local metadata: do not commit a username-specific path or save it
in evidence intended for broad distribution.

If the Mac cannot fetch the ref directly, transfer an incremental Git bundle.

On the Linux host, create the bundle from the exact ref being proved:

```sh
task_slug=unionground-ios-proof-YYYYMMDD
mac_repo=PASTE_ABSOLUTE_UNIONGROUND_REPO_PATH
source_ref=refs/remotes/origin/Main
source_sha="$(git rev-parse "$source_ref")"
mac_base="$(ssh "$IOS_BUILD_HOST" "git -C '$mac_repo' rev-parse origin/Main")"
task_bundle="/tmp/${task_slug}.bundle"
task_metadata="/tmp/${task_slug}.git-metadata"

test -z "$(git status --porcelain)"
git cat-file -e "$mac_base^{commit}"
git merge-base --is-ancestor "$mac_base" "$source_sha"
test "$mac_base" != "$source_sha"
git bundle create "$task_bundle" "$source_ref" "^$mac_base"
git bundle verify "$task_bundle"
printf '%s\n%s\n' "$source_sha" "$mac_base" >"$task_metadata"
scp "$task_bundle" "$task_metadata" "$IOS_BUILD_HOST:/tmp/"
```

For a pre-merge preview, set `source_ref` to the clean review branch and record
that the evidence is unmerged. On the Mac, fetch only that bundle and create a
task-owned worktree:

```sh
mac_repo=PASTE_ABSOLUTE_UNIONGROUND_REPO_PATH
mac_worktree="$mac_repo/.worktrees/$task_slug"
mac_bundle="/tmp/${task_slug}.bundle"
mac_metadata="/tmp/${task_slug}.git-metadata"
source_ref=refs/remotes/origin/Main
source_sha="$(sed -n '1p' "$mac_metadata")"
mac_base="$(sed -n '2p' "$mac_metadata")"

git -C "$mac_repo" cat-file -e "$mac_base^{commit}"
git -C "$mac_repo" fetch "$mac_bundle" "$source_ref"
test "$(git -C "$mac_repo" cat-file -t "$source_sha")" = commit
git -C "$mac_repo" worktree add --detach "$mac_worktree" "$source_sha"
test "$(git -C "$mac_worktree" rev-parse HEAD)" = "$source_sha"
test -z "$(git -C "$mac_worktree" status --porcelain)"
```

Shell variables do not cross the SSH boundary automatically. Set the exact
non-secret values again in the Mac shell or place them in a mode-`600`
task-owned command file. Never copy environment dumps between hosts. A `git
archive` in a task-owned temporary directory remains an acceptable fallback,
but a detached worktree is preferred when later evidence must name and verify
the Git SHA.

## Freeze the source and discover the target

1. Resolve one exact, clean source commit. For post-merge acceptance, require
   the exact merged `Main` SHA and confirm the requested change is its
   ancestor. For an explicitly requested pre-merge preview, a clean commit on
   the reviewable feature branch is allowed; record it as unmerged preview
   evidence and never describe it as merged or release evidence. Do not build
   an uncommitted primary checkout.
2. Transfer a `git archive` of the repository root into a task-owned temporary
   directory on the Mac. Archive the root, not only `apps/mobile`, because
   mobile configuration imports repository-level files such as
   `config/sample-backend.json`.
3. Connect through the configured SSH host and inspect, without
   mutating, the available toolchain and devices:

   ```sh
   ssh "$IOS_BUILD_HOST" 'sw_vers; xcodebuild -version; \
     /opt/homebrew/opt/node@22/bin/node --version; \
     xcrun devicectl list devices'
   ```

4. Select the currently connected device from fresh output. Keep identifiers
   confined to the task's necessary diagnostic/command context; do not commit
   or repeat its CoreDevice identifier, hardware UDID, serial number,
   provisioning profile, certificate, or private-key path in durable notes or
   user-facing reports.
5. Confirm that an existing code-signing identity and device-covering profile
   are available. Do not create accounts, identities, profiles, or credentials
   as a shortcut.

The CoreDevice identifier used by `devicectl` and the hardware destination ID
used by `xcodebuild` may differ. Discover both during the session instead of
reusing a value from an old transcript.

## Generate and build the physical-device app

Use the supported Homebrew Node 22 binary explicitly. The Mac's ambient Node
may be newer than the repository's supported range.

Choose runtime configuration from the behavior being verified:

- For layout, navigation, gesture, and fictional-data UI work, use
  `MOBILE_RELEASE_ENV=development` with
  `EXPO_PUBLIC_PREVIEW_ENABLED=1`. This is offline preview evidence and cannot
  prove authentication, RLS, data mutations, notifications, or another
  backend-dependent path.
- For a backend-dependent device check, use
  `MOBILE_RELEASE_ENV=preview`, keep `EXPO_PUBLIC_PREVIEW_ENABLED=1`, choose
  email/password sign-in instead of the adjacent PREVIEW action, and inject
  the exact source-approved SAMPLE Supabase origin plus its publishable key
  from an existing authorized environment. Never echo or commit the value.
  `app.config.ts` must accept the origin/key pair. If those protected values
  are unavailable, report backend-device verification as blocked; never fall
  back to fictional records and call it equivalent. Networked Compass remains
  separately disabled until its issuer-validation gate is satisfied.

From the archived `apps/mobile` directory on the Mac:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export NODE_BINARY=/opt/homebrew/opt/node@22/bin/node
export EXPO_NO_TELEMETRY=1
export EXPO_PUBLIC_PREVIEW_ENABLED=1
export MOBILE_RELEASE_ENV=development

npm ci
npx expo prebuild --platform ios --clean

xcodebuild \
  -workspace ios/UnionGround.xcworkspace \
  -scheme UnionGround \
  -configuration Release \
  -destination "id=$IOS_HARDWARE_DESTINATION_ID" \
  -derivedDataPath "$TASK_DERIVED_DATA" \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="$AUTHORIZED_DEVELOPMENT_TEAM" \
  COMPILER_INDEX_STORE_ENABLE=NO \
  ONLY_ACTIVE_ARCH=YES \
  build
```

Do not pass `PRODUCT_BUNDLE_IDENTIFIER` as an `xcodebuild` command-line
override. Xcode applies that override to every target in the scheme, including
the secure-share extension, and iOS rejects an archive when the parent app and
an embedded extension have the same identifier. The generated project already
pins the approved identifiers on their respective targets.

Use task-specific variable names and explicit validated paths. Never repurpose
`HOME`, recursively delete a broad directory, or print signing/private-key
material.

The command above builds a bundled Release app. For the Metro-backed
development-client path below, build the same generated workspace with
`-configuration Debug`; its expected artifact is
`Build/Products/Debug-iphoneos/UnionGround.app`. Do not describe a Debug app as
a Release artifact, and do not describe a Metro-served bundle as embedded.

### Development client and exact Metro source

A signed Release build contains its JavaScript bundle and does not need Metro.
For rapid authenticated development-client proof, the native app and Metro
must both come from the same clean exact-SHA worktree. The 2026-08-21 proof
used this development-client path.

Start Metro on a task-owned, unused port and record its PID:

```sh
task_metro_port=8082
task_metro_log="/tmp/${task_slug}-metro.log"
task_metro_pid="/tmp/${task_slug}-metro.pid"

cd "$mac_worktree/apps/mobile"
test -z "$(git status --porcelain)"

# Set authorized public SAMPLE configuration with shell tracing disabled.
set +x
export EXPO_PUBLIC_SUPABASE_URL="$AUTHORIZED_SAMPLE_SUPABASE_URL"
export EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$AUTHORIZED_SAMPLE_PUBLISHABLE_KEY"
export EXPO_PUBLIC_PREVIEW_ENABLED=1
export MOBILE_RELEASE_ENV=development

nohup npm run start -- --port "$task_metro_port" --host lan \
  >"$task_metro_log" 2>&1 &
printf '%s\n' "$!" >"$task_metro_pid"
```

Verify that the listening process and its working directory belong to this
task before launching the app:

```sh
metro_pid="$(sed -n '1p' "$task_metro_pid")"
lsof -a -p "$metro_pid" -d cwd
lsof -nP -iTCP:"$task_metro_port" -sTCP:LISTEN
```

Do not rely on a remembered development-server entry from an earlier build.
Launch the installed development client and select or open the server URL for
the task-owned Metro port. Confirm the selected host/port in the development
client or sanitized Metro connection log. If LAN discovery fails, inspect the
current Mac/phone network and USB transport; do not switch to an unrelated
server or call a stale bundle exact-SHA evidence.

The SAMPLE origin and publishable key are public-client configuration, not a
service-role credential, but they still must not appear in command output,
logs, screenshots, committed files, or user-facing reports. Unset the values
after the build/Metro process has inherited them.

### Remote Keychain failure

An SSH-started Xcode build can compile and bundle successfully, then fail while
signing an embedded framework with `errSecInternalComponent` or `User
interaction is not allowed`. That indicates the SSH process cannot use the
login Keychain's private key; it is not an application-code failure.

First confirm the same identity can sign from the Mac's logged-in desktop
session. If it can, run the identical incremental `xcodebuild` command in that
GUI session—for example, through a task-owned Terminal command launched with
AppleScript—and capture its exit status and log in task-owned temporary files.
Do not reveal a Keychain password, change key partition lists, relax ACLs,
export the private key, or rotate credentials to bypass this boundary. Close
only the Terminal windows created by the session when finished.

## Verify before installation

Treat the generated app as untrusted until fresh checks pass. A bundled Release
artifact is beneath the selected derived-data directory at
`Build/Products/Release-iphoneos/UnionGround.app`; a development client is at
`Build/Products/Debug-iphoneos/UnionGround.app`.

At minimum verify:

```sh
test -d "$PHYSICAL_APP"
codesign --verify --deep --strict --verbose=2 "$PHYSICAL_APP"
task_app_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  "$PHYSICAL_APP/Info.plist")"
task_share_extension="$PHYSICAL_APP/PlugIns/expo-sharing-extension.appex"
test -d "$task_share_extension"
task_share_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  "$task_share_extension/Info.plist")"
test "$task_app_bundle_id" = org.example.unionground
test "$task_share_bundle_id" = org.example.unionground.secure-share-intake
test "$task_share_bundle_id" != "$task_app_bundle_id"
security cms -D -i "$PHYSICAL_APP/embedded.mobileprovision" \
  > "$TASK_PROFILE_PLIST"
```

- The parent bundle identifier must be `org.example.unionground`; the secure
  share extension must remain the distinct
  `org.example.unionground.secure-share-intake` identifier.
- The signing authority/team must be the intended existing development team.
- The embedded profile's application identifier must match and its
  `ProvisionedDevices` array must contain the freshly discovered physical
  device UDID.
- For Release, require `main.jsbundle`. Its JavaScript must contain markers for
  the requested UI and omit the exact copy that was removed. Hermes output is
  binary, so use `grep -a -q -F` for bounded presence/absence checks and
  suppress bundle contents from logs.
- For a development client, do not require an embedded `main.jsbundle`.
  Instead, prove that the signed Debug app and the task-owned Metro process
  both use the same clean exact-SHA worktree, and confirm the selected Metro
  host/port after launch.
- For material UI changes, also install and exercise the simulator build or
  inspect a simulator screenshot. String checks prove bundle composition, not
  layout or gesture behavior.

Stop on any failed check. Do not install a stale, unsigned, mismatched, or
wrong-device artifact.

## Install, launch, and prove the running copy

Installing in place preserves application data; do not uninstall first unless
the user explicitly requests destructive reset behavior.

```sh
xcrun devicectl device install app \
  --device "$CORE_DEVICE_ID" "$PHYSICAL_APP"

xcrun devicectl device process launch \
  --device "$CORE_DEVICE_ID" org.example.unionground

xcrun devicectl device info apps \
  --device "$CORE_DEVICE_ID" \
  --bundle-id org.example.unionground \
  --columns '*'

xcrun devicectl device info processes \
  --device "$CORE_DEVICE_ID" \
  --columns '*'
```

Require all of the following before reporting completion:

- `devicectl` reports a successful install for the expected bundle identifier;
- launch succeeds;
- the installed-app query shows Union Ground at a current installation path;
- the process list still contains the installed `UnionGround.app/UnionGround`
  executable after launch; and
- the exact source SHA, bundle hash, device class, signing verification, and
  requested UI checks are retained in the session evidence without exposing
  device or signing secrets.

For a physical-device layout, navigation, or gesture claim, directly inspect
the installed phone display and exercise the requested path on that phone.
Use authorized screen mirroring/capture automation when available. A simulator
screenshot, bundle-string match, successful launch, or live process alone is
not physical UI proof. If the environment cannot observe or interact with the
physical display after installation, request only the minimum targeted user
confirmation and keep the physical UI claim explicitly blocked until it is
received.

If the marketing/build version did not change, a successful replacement path,
fresh install output, and running process are stronger evidence than the
unchanged version label alone.

## Control the physical display

Use semantic XCUITest control for product verification. It is more reliable
than coordinates, produces an `.xcresult`, and proves that the accessibility
surface exposes the same controls a person uses. The successful proof created
a temporary, separately signed UI-test target outside the repository and used
`XCUIApplication(bundleIdentifier: "org.example.unionground")` to attach to
the installed app.

A minimal test follows this shape:

```swift
import XCTest

final class UnionGroundPhysicalProof: XCTestCase {
  private let app = XCUIApplication(
    bundleIdentifier: "org.example.unionground"
  )

  override func setUpWithError() throws {
    continueAfterFailure = false
    app.launch()
  }

  func testVotingIsReachable() throws {
    let voting = app.descendants(matching: .any)["Voting"].firstMatch
    XCTAssertTrue(voting.waitForExistence(timeout: 20))
    voting.tap()

    let heading = app.staticTexts["Voting"].firstMatch
    XCTAssertTrue(heading.waitForExistence(timeout: 20))
    app.swipeUp()
  }
}
```

Prefer stable accessibility identifiers when the application provides them;
otherwise use bounded labels and assert the expected heading after every tap.
Useful operations are `waitForExistence`, `tap`, `swipeUp`, `swipeDown`,
`typeText`, `isHittable`, and explicit element-count assertions. Do not dump
the entire authenticated accessibility tree: it may contain SAMPLE member
content or, on a real tenant later, protected information.

Build the temporary harness once, then run it repeatedly without rebuilding:

```sh
xcodebuild \
  -project "$TASK_HARNESS/UnionGroundProof.xcodeproj" \
  -scheme UnionGroundProof \
  -destination "id=$IOS_HARDWARE_DESTINATION_ID" \
  -derivedDataPath "$TASK_HARNESS_DERIVED_DATA" \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="$AUTHORIZED_DEVELOPMENT_TEAM" \
  build-for-testing

xcodebuild \
  -xctestrun "$TASK_XCTESTRUN" \
  -destination "id=$IOS_HARDWARE_DESTINATION_ID" \
  -resultBundlePath "$TASK_XCRESULT" \
  test-without-building
```

Discover the generated `.xctestrun` path rather than guessing it. Keep the
harness, derived data, result bundle, logs, and any test plan in one validated
task directory. If a test must type an authorized demo credential, obtain it
from the existing authorized source with tracing disabled, keep it only in a
mode-`600` temporary test configuration, and delete the raw `.xcresult` and
configuration after producing a redacted summary. Never embed a password in a
committed Swift file, shell command argument, screenshot, or PR comment.

For low-level gestures or capture diagnostics, use a task-owned
`pymobiledevice3` virtual environment. Record the resolved version in the
session evidence because its command surface evolves:

```sh
task_pmd_venv="/tmp/${task_slug}-pymobiledevice3"
python3 -m venv "$task_pmd_venv"
"$task_pmd_venv/bin/python" -m pip install --upgrade pymobiledevice3
"$task_pmd_venv/bin/python" -m pymobiledevice3 usbmux list
```

On current iOS 17.4+ devices, individual developer commands normally create a
no-root in-process userspace tunnel automatically. The successful proof used a
shared, persistent routed tunnel because repeated external control/capture
commands needed the same RSD connection:

```sh
sudo "$task_pmd_venv/bin/python" -m pymobiledevice3 \
  lockdown start-tunnel --script-mode
```

Use the exact RSD address and port printed by that process in later commands.
The address and port are ephemeral. Keep the tunnel process alive while it is in use.
For iOS 17.0–17.3.1, the documented fallback is `remote start-tunnel`; do not
use that older path by habit on newer phones.

Current CoreDevice commands can capture the screen, query display geometry,
and deliver normalized HID gestures:

```sh
pmd() {
  "$task_pmd_venv/bin/python" -m pymobiledevice3 "$@"
}

pmd developer core-device get-display-info
pmd developer core-device screen-capture screenshot \
  "/tmp/${task_slug}-screen.png"
pmd developer core-device universal-hid-service tap -- 32768 32768
pmd developer core-device universal-hid-service drag -- \
  32768 56000 32768 12000
```

Those examples use the current automatic userspace tunnel. To reuse the
persistent proof-session tunnel, pass its exact tool-printed connection option
to the command, for example:

```sh
pmd developer core-device screen-capture screenshot \
  "/tmp/${task_slug}-screen.png" --rsd "$rsd_address" "$rsd_port"
```

Coordinates are normalized from `0` through `65535`; query display geometry
before converting pixel coordinates. Use coordinate gestures only for device
chrome or as a fallback. Product navigation should remain label/identifier
driven through XCUITest so a layout change does not silently tap the wrong
control. The tool also supports a browser display stream with `developer
core-device display serve-web`; use it only on an authorized local interface
and stop it after the session.

Upstream command references are the `pymobiledevice3`
[iOS 17+ tunnel guide](https://doronz88.github.io/pymobiledevice3/guides/ios17-tunnels/)
and [CLI recipes](https://doronz88.github.io/pymobiledevice3/guides/cli-recipes/).
Recheck them before changing transport flags because the tool intentionally
continues to simplify its automatic userspace-tunnel behavior.

### Screen capture protection is expected

Authenticated Union Ground sessions intentionally enable native screen-capture
protection. A CoreDevice screenshot, XCUITest screenshot attachment, QuickTime
mirror, or browser display stream may therefore show a black or privacy-covered
application surface. The 2026-08-21 authenticated physical proof reproduced
that behavior. It is evidence that the privacy control is working, not a
capture-tool failure.

Do not disable `expo-screen-capture`, weaken the iOS privacy overlay, switch to
fictional preview mode, or expose protected values merely to obtain a prettier
screenshot. Use the appropriate evidence channel:

- For visual layout evidence, capture the signed-out or fictional preview
  surface, or use the iOS Simulator where capture is intentionally supported.
- For authenticated physical behavior, use XCUITest element existence,
  enabled/hittable state, post-action headings, bounded counts, sanitized
  activity logs, and direct observation of the connected phone.
- Retain a black protected capture only when proving the privacy boundary;
  label it as such so a later reviewer does not mistake it for missing proof.
- If a protected screen requires human visual judgment that accessibility
  assertions cannot establish, request only that specific observation from
  the person holding the phone.

## Evidence checklist

Keep a sanitized, task-owned record of:

- exact source SHA on Linux and the matching clean Mac worktree SHA;
- Mac OS, Xcode, Node, `devicectl`, and `pymobiledevice3` versions;
- device class and iOS version, but not device IDs or serial number;
- code-sign verification, bundle identifier, application hash, install path,
  successful launch, and running process;
- development-client Metro port plus PID/cwd ownership when Metro was used;
- UI-test name, pass/fail result, expected labels/headings, and redacted
  `.xcresult` summary;
- capture mode and whether privacy protection intentionally blanked it; and
- every scope boundary: backend used, no service role, no production seed or
  data write, and whether any rollback-only mutation was exercised.

Never publish the raw accessibility tree, raw `.xcresult`, Metro environment,
device identifiers, signing details, credentials, or backend key. Preserve
only the minimum redacted evidence needed to reproduce the claim.

## Simulator path

For an EAS simulator archive, verify the completed build is pinned to the exact
resolved source commit (and to merged `Main` when it is post-merge evidence),
verify the downloaded archive hash, unpack `UnionGround.app`, and inspect its
`main.jsbundle` before installation. Then target a freshly booted simulator:

```sh
xcrun simctl install "$SIMULATOR_UDID" "$SIMULATOR_APP"
xcrun simctl launch "$SIMULATOR_UDID" org.example.unionground
```

Use `simctl` screenshot to confirm the relevant layout and gestures. A
simulator result is useful UI evidence but is never physical
device, push-token, Keychain, or App Store proof.

## Cleanup and handoff

- Leave the requested app launched on the target device.
- Stop only the task-owned Metro process. Before `kill`, verify both the PID's
  working directory and its listening port; do not stop another session's
  Metro process. The successful proof stopped 8082 and deliberately preserved
  the unrelated server on 8081.
- Stop a persistent RSD tunnel only after its command path and task-owned
  virtual environment match. An ephemeral userspace tunnel exits with its
  command and needs no separate cleanup.
- Verify the Mac worktree is clean and still resolves the recorded exact SHA,
  then remove it from the parent clone with `git worktree remove` and run `git
  worktree prune`. Never use `--force`; keep the task branch unless deletion
  was explicitly requested.
- Remove only the validated task-owned source/build temporary directory and
  task-owned status/log files, Git bundle, temporary UI-test harness,
  `.xcresult`, credential configuration, and `pymobiledevice3` virtual
  environment. State that this temporary material was removed and is not
  recoverable; the installed app and Git history are unaffected.
- Preserve user application data, the Mac's certificates and profiles, shared
  derived data that predated the task, other worktrees, and unrelated Terminal
  windows.
- Report the installed device class, exact source SHA, app/bundle identifier,
  install and launch evidence, and any remaining external gate. Do not hand the
  user a download instruction after installation has already succeeded.
