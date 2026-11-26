#!/bin/bash
# Re-sign the built XCUITest runner for the paired phone and emit the drill's
# .xctestrun. Called by apps/mobile/scripts/ios-device-drill.mjs; safe to run by
# hand. It signs only the runner it just built, and it changes no Keychain ACL,
# no key partition list and no signing identity.
set -euo pipefail

DERIVED=${1:?derived data path}
DONOR=${2:?a previously device-signed UnionGroundDrillUITests-Runner.app}
DEVICE=${3:?the paired phone name exactly as xcrun devicectl list devices shows it}

RUNNER="$DERIVED/Build/Products/Debug-iphoneos/UnionGroundDrillUITests-Runner.app"
BUNDLE="$RUNNER/PlugIns/UnionGroundDrillUITests.xctest"
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

test -d "$RUNNER"
test -d "$BUNDLE"
test -f "$DONOR/embedded.mobileprovision"

cp "$DONOR/embedded.mobileprovision" "$RUNNER/embedded.mobileprovision"
security cms -D -i "$RUNNER/embedded.mobileprovision" > "$SCRATCH/profile.plist"
codesign -d --entitlements :- "$DONOR" > "$SCRATCH/entitlements.plist" 2>/dev/null

# Sign only with an installed Apple Development identity the donor profile
# actually carries; refuse an unrelated certificate.
fingerprints=$(python3 - "$SCRATCH/profile.plist" <<'PY'
import hashlib, plistlib, sys
profile = plistlib.load(open(sys.argv[1], "rb"))
print("\n".join(hashlib.sha1(c).hexdigest().upper() for c in profile.get("DeveloperCertificates", [])))
PY
)
identity=""
while read -r _ hash _; do
  if grep -qx "$hash" <<<"$fingerprints"; then identity="$hash"; break; fi
done < <(security find-identity -v -p codesigning | grep '"Apple Development:')
test -n "$identity" || { echo "no installed Apple Development identity matches the donor profile" >&2; exit 1; }

# The donor profile must already cover the phone this drill targets.
xcrun devicectl list devices --json-output "$SCRATCH/devices.json" >/dev/null
udid=$(python3 - "$SCRATCH/devices.json" "$DEVICE" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1])).get("result", {}).get("devices", [])
match = [d for d in devices if (d.get("deviceProperties") or {}).get("name") == sys.argv[2]]
print((match[0].get("hardwareProperties") or {}).get("udid", "") if len(match) == 1 else "")
PY
)
test -n "$udid" || { echo "the named device did not resolve to exactly one paired phone" >&2; exit 1; }
grep -q "$udid" "$SCRATCH/profile.plist" || { echo "the donor profile does not cover the target phone" >&2; exit 1; }

while IFS= read -r framework; do
  codesign --force --sign "$identity" --timestamp=none "$framework"
done < <(find "$RUNNER" -type d -name '*.framework' -print | LC_ALL=C sort)
codesign --force --sign "$identity" --timestamp=none "$BUNDLE"
codesign --force --sign "$identity" --timestamp=none --entitlements "$SCRATCH/entitlements.plist" "$RUNNER"
codesign --verify --deep --strict --verbose=2 "$RUNNER"

source_run=$(find "$DERIVED/Build/Products" -maxdepth 1 -name '*.xctestrun' ! -name 'ios-device-drill.xctestrun' -print -quit)
test -n "$source_run"
target="$(dirname "$source_run")/ios-device-drill.xctestrun"
cp "$source_run" "$target"
plist=/usr/libexec/PlistBuddy
key=UnionGroundDrillUITests
$plist -c "Set :$key:PreferredScreenCaptureFormat screenshots" "$target" 2>/dev/null \
  || $plist -c "Add :$key:PreferredScreenCaptureFormat string screenshots" "$target"
$plist -c "Set :$key:UserAttachmentLifetime keepAlways" "$target" 2>/dev/null \
  || $plist -c "Add :$key:UserAttachmentLifetime string keepAlways" "$target"
printf 'XCTESTRUN\t%s\n' "$target"
