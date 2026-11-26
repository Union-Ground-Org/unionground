import XCTest

/// The nine physical-matrix rows the iOS half can attempt once a UI observation
/// and driving channel exists.
///
/// Six of them (`member-journeys`, `attachments`, `calendar`, `custom-links`,
/// `background-privacy`, `screen-reader`) were recorded `not_executed` on
/// 2026-09-06 for the absent UI channel alone. Three more (`offline`,
/// `text-scaling`, `reduced-motion`) also need a device-settings capability,
/// which `DrillChannel` supplies through Settings.app and a content-size
/// relaunch. The remaining six UI-blocked rows carry an independent
/// hosted-schema or approved-identity gate and are deliberately absent from
/// this class - `apps/mobile/ios-drill/row-manifest.json` keeps them listed
/// with the gate that still holds them.
///
/// Every row reports what it observed. A row that cannot be observed is
/// recorded `not_executed` with the reason; no Android verdict is ever copied
/// across, and nothing is inferred from the other platform's matrix.
final class DrillRows: DrillChannel {
  private let memberFeatures: [(String, String)] = [
    ("voting", "Voting"), ("rewards", "Rewards"), ("cases", "My cases"), ("forms", "Forms"),
    ("workload", "Workload log"), ("numbers", "My reports"), ("appointments", "Appointments"),
    ("rights", "Know your rights"), ("chapter", "My chapter"), ("voice", "Be heard"),
    ("events", "Events"), ("search", "Search"), ("chapters", "Chapters"),
    ("member-support", "Member support"), ("pay", "Pay tools"), ("dues", "Dues"),
    ("actions", "Digital Picket Line"), ("qa", "Member questions"),
  ]

  private let staffDesks = [
    "steward", "coordinator", "advisor", "admin", "vp", "partners", "analytics", "organization-map",
  ]

  private let unknownIdentifier = "33333333-3333-4333-8333-333333333333"

  /// The explicit PREVIEW chrome, as `HatSwitcher` labels it and as the Android
  /// half asserted it. "Try the demo" - the signed-out entry button -
  /// deliberately does not match it.
  private static let previewMarker = "PREVIEW demo, switch hat"

  // MARK: - helpers

  private func labels(_ tree: [String: Any]) -> [String] {
    DrillChannel.flatten(tree).compactMap { $0["label"] as? String }.filter { !$0.isEmpty }
  }

  private func shows(_ tree: [String: Any], _ needle: String) -> Bool {
    labels(tree).contains { $0.contains(needle) }
  }

  /// `pass` only when nothing failed and nothing was left unobserved; the
  /// committed matrix vocabulary otherwise.
  private func verdict(failures: Int, gaps: Int) -> String {
    if failures > 0 { return "fail" }
    return gaps > 0 ? "partial" : "pass"
  }

  /// Reach the explicit PREVIEW surface the Android half also drove. Returns
  /// nil when the surface is unreachable, which makes the row `not_executed`
  /// rather than a fabricated failure.
  private func enterPreview() -> [String: Any]? {
    guard launchApp(cold: true) else { return nil }
    // Classify the surface before anything is serialised. A phone that kept an
    // authenticated Keychain session would otherwise have its whole tree -
    // labels and values included - written to the test log and to an
    // attachment merely because a row was attempted.
    if probe("Try the demo", timeout: 10) {
      _ = tap(label: "Try the demo")
    }
    guard probe(DrillRows.previewMarker, timeout: 10) else {
      step("preview-entry", "not-preview",
           ["reason": "the explicit PREVIEW marker was absent, so no hierarchy was emitted from this surface"])
      app.terminate()
      return nil
    }
    return hierarchy("preview-ready")
  }

  /// The most specific stable label on a captured screen: the first
  /// header-trait label, else the first non-empty one. Used to recognise a
  /// destination from the application itself rather than from a copy string
  /// this drill has never observed.
  private func landmark(_ tree: [String: Any]) -> String? {
    let nodes = DrillChannel.flatten(tree)
    let header = nodes.first { node in
      (node["traits"] as? [String] ?? []).contains("header")
        && !((node["label"] as? String) ?? "").isEmpty
    }
    if let label = header?["label"] as? String { return label }
    return nodes.compactMap { $0["label"] as? String }.first { !$0.isEmpty }
  }

  // MARK: - rows blocked on the UI channel alone

  func testMemberJourneys() {
    guard enterPreview() != nil else {
      finish(row: "member-journeys", status: "not_executed",
             notes: "The explicit PREVIEW surface was not reachable, so no member journey was observed.")
      return
    }
    var failures = 0
    var gaps = 0
    for (route, title) in memberFeatures {
      guard openScheme("feature/\(route)", cold: false) else { gaps += 1; continue }
      let tree = hierarchy("member-\(route)")
      if !shows(tree, title) { failures += 1 }
    }
    for desk in staffDesks {
      guard openScheme("feature/\(desk)", cold: false) else { gaps += 1; continue }
      let tree = hierarchy("member-denied-\(desk)")
      // Fail-closed means the staff surface is refused, not merely absent.
      if !(shows(tree, "is a staff tool") || shows(tree, "opens under another hat")) { failures += 1 }
    }
    for (kind, missing) in [("case", "Case not available"),
                            ("conversation", "Conversation not available"),
                            ("channel", "Channel not available")] {
      guard openScheme("\(kind)/\(unknownIdentifier)", cold: false) else { gaps += 1; continue }
      let tree = hierarchy("member-missing-\(kind)")
      if !shows(tree, missing) { failures += 1 }
    }
    shot("member-journeys-final")
    finish(row: "member-journeys", status: verdict(failures: failures, gaps: gaps),
           notes: "Drove \(memberFeatures.count) member feature routes, \(staffDesks.count) staff-desk denials and three unknown-identifier routes through the XCUITest channel. failures=\(failures) unobserved=\(gaps). The session's authentication state was not established, so nothing behind an authenticated gate is claimed.")
  }

  func testAttachments() {
    guard enterPreview() != nil else {
      finish(row: "attachments", status: "not_executed", notes: "PREVIEW surface unreachable.")
      return
    }
    var failures = 0
    var gaps = 0
    guard openScheme("feature/cases", cold: false) else {
      finish(row: "attachments", status: "not_executed", notes: "The cases route did not open, so no attachment panel was reached.")
      return
    }
    let cases = hierarchy("attachments-cases")
    if !shows(cases, "My cases") { failures += 1 }
    if tap(label: "Add attachment") {
      let picker = hierarchy("attachments-picker")
      // The permission prompt and the document picker both belong to system
      // surfaces; record what appeared rather than asserting a fixed label.
      if picker.isEmpty { gaps += 1 }
      for name in ["Cancel", "Don’t Allow", "Don't Allow"] {
        if tap(label: name, timeout: 4) { break }
      }
      let after = hierarchy("attachments-after-dismiss")
      if !shows(after, "attachment") { gaps += 1 }
    } else {
      gaps += 1
    }
    // The row's acceptance is "Camera/file capture, upload, confirm, remove and
    // interruption cleanup". Opening and dismissing the picker is the only part
    // of that lifecycle this channel drives, so the rest is recorded unobserved
    // and the row can never report `pass`.
    gaps += 1
    step("attachment-lifecycle", "not-observed",
         ["reason": "no file was selected, uploaded, confirmed, removed, or interrupted mid-upload"])
    shot("attachments-final")
    finish(row: "attachments", status: verdict(failures: failures, gaps: gaps),
           notes: "The attachment entry point was opened and dismissed through the XCUITest channel. failures=\(failures) unobserved=\(gaps). Selecting, uploading, confirming, removing and interrupting a file were not exercised - upload confirmation additionally waits on the hosted begin/confirm shapes - so this row is reported partial at best and never as a completed attachment lifecycle.")
  }

  func testCalendar() {
    guard enterPreview() != nil else {
      finish(row: "calendar", status: "not_executed", notes: "PREVIEW surface unreachable.")
      return
    }
    var failures = 0
    var gaps = 0
    guard openScheme("feature/events", cold: false) else {
      finish(row: "calendar", status: "not_executed", notes: "The events route did not open.")
      return
    }
    if !shows(hierarchy("calendar-events"), "Events") { failures += 1 }
    // The acceptance names two outcomes, "native calendar export" and
    // "permission denial". An injected tap proves neither: each outcome is
    // credited only from a readback after the tap. On a phone that denies the
    // permission the export cannot follow in the same run, so this row stays
    // partial until both have been observed; it never passes on injection or
    // on a surface merely appearing.
    var exportConfirmed = false
    var denialConfirmed = false
    let denyLabels = ["Don’t Allow", "Don't Allow"]
    let allowLabels = ["Allow Full Access", "Allow"]
    guard tap(label: "Add to calendar") else {
      gaps += 2
      step("calendar-export", "entry-point-missing")
      finish(row: "calendar", status: verdict(failures: failures, gaps: gaps),
             notes: "The calendar export entry point was not found. export_confirmed=false denial_confirmed=false failures=\(failures) unobserved=\(gaps).")
      return
    }
    let permission = systemSurface(labels: allowLabels + denyLabels, timeout: 8)
    if let alert = permission, alert.hasPrefix("springboard:") {
      step("calendar-permission", alert)
      let deny = springboard.descendants(matching: .any)
        .matching(NSPredicate(format: "label == %@ OR label == %@", denyLabels[0], denyLabels[1])).firstMatch
      if deny.waitForExistence(timeout: 4) {
        deny.tap()
        step("calendar-denial", "tap-injected")
        // Readback 1: the alert is gone. Readback 2: the application is back.
        // Readback 3: the same entry point no longer raises the alert, which is
        // how iOS behaves once the permission has actually been denied.
        let alertGone = deny.waitForNonExistence(timeout: 6)
        let returned = app.wait(for: .runningForeground, timeout: 10)
        var reprompted = true
        if alertGone && returned && tap(label: "Add to calendar") {
          reprompted = systemSurface(labels: allowLabels + denyLabels, timeout: 4) != nil
          if reprompted { for name in denyLabels where tapSystem(label: name, timeout: 2) { break } }
        }
        if alertGone && returned && !reprompted {
          denialConfirmed = true
          step("calendar-denial", "confirmed", ["alert_gone": alertGone, "returned": returned, "reprompted": reprompted])
        } else {
          failures += 1
          step("calendar-denial", "unconfirmed", ["alert_gone": alertGone, "returned": returned, "reprompted": reprompted])
        }
      } else {
        failures += 1
        step("calendar-denial", "deny-control-missing")
      }
    } else {
      gaps += 1
      step("calendar-denial", "no-permission-alert", ["observed": permission ?? "none"])
    }
    // Export: only an EventKit editor that then SAVES, with the editor gone
    // afterwards and the application back, counts. Cancel is cleanup, not an
    // outcome. A saved event remains on the operator's phone; the runbook
    // says to remove it after the drill.
    let editor = systemSurface(labels: ["New Event", "Add Event", "Add"], timeout: 8)
    if let sheet = editor, sheet.hasPrefix("springboard:") {
      step("calendar-export", sheet)
      let add = springboard.buttons["Add"].firstMatch
      if add.waitForExistence(timeout: 4) && add.isHittable {
        add.tap()
        step("calendar-export-save", "tap-injected")
        let editorGone = add.waitForNonExistence(timeout: 6)
        let returned = app.wait(for: .runningForeground, timeout: 10)
        if editorGone && returned {
          exportConfirmed = true
          step("calendar-export-save", "confirmed", ["editor_gone": editorGone, "returned": returned])
        } else {
          failures += 1
          step("calendar-export-save", "unconfirmed", ["editor_gone": editorGone, "returned": returned])
          _ = tapSystem(label: "Cancel", timeout: 4)
        }
      } else {
        gaps += 1
        step("calendar-export-save", "add-control-missing")
        if !tapSystem(label: "Cancel", timeout: 4) {
          failures += 1
          step("calendar-export-dismiss", "cancel-tap-failed")
        }
      }
    } else {
      gaps += 1
      step("calendar-export", "no-export-surface", ["observed": editor ?? "none"])
    }
    shot("calendar-handoff")
    _ = launchApp(cold: false)
    if !shows(hierarchy("calendar-returned"), "Events") { failures += 1 }
    finish(row: "calendar", status: verdict(failures: failures, gaps: gaps),
           notes: "The calendar export entry point was driven through the XCUITest channel. export_confirmed=\(exportConfirmed) denial_confirmed=\(denialConfirmed) failures=\(failures) unobserved=\(gaps). Denial is credited only after the alert disappeared, the application returned and the entry point no longer re-prompted; export only after the EventKit editor saved and disappeared with the application back. A surface that never appeared or an injected tap without those readbacks keeps the row partial or failed; both outcomes cannot occur in one run on a phone that denies the permission, so this row is expected to stay partial until observed under both states. Session-guarded export branches stay unreachable without an established authenticated session.")
  }

  func testCustomLinks() {
    var failures = 0
    var gaps = 0
    guard openScheme("home", cold: true) else {
      finish(row: "custom-links", status: "not_executed",
             notes: "A cold custom-scheme hand-off did not reach the application, so no routing was observed.")
      return
    }
    // Classify before serialising: a restored authenticated session must not be
    // written to the evidence just because this row started.
    guard probe(DrillRows.previewMarker, timeout: 10) else {
      step("cold-entry", "not-preview",
           ["reason": "the explicit PREVIEW marker was absent after the cold hand-off, so no hierarchy was emitted"])
      app.terminate()
      finish(row: "custom-links", status: "not_executed",
             notes: "The cold custom-scheme hand-off did not land on the explicit PREVIEW surface, so no hierarchy was emitted and no routing was observed.")
      return
    }
    let home = hierarchy("links-cold-home")
    shot("links-cold-home")
    // Calibrate the Home landmark from the application itself; the unknown
    // routes below must reach *this* screen, and a blank or wrong destination
    // with enough nodes on it must not pass as a fallback.
    let homeLandmark = landmark(home)
    step("home-landmark", homeLandmark ?? "none")
    for (path, expected) in [("compass", "Compass"), ("legal/privacy", "Privacy"),
                             ("feature/rights", "Know your rights")] {
      guard openScheme(path, cold: false) else { gaps += 1; continue }
      if !shows(hierarchy("links-warm-\(path.replacingOccurrences(of: "/", with: "-"))"), expected) { failures += 1 }
    }
    for kind in ["case", "conversation", "channel"] {
      guard openScheme("\(kind)/\(unknownIdentifier)", cold: false) else { gaps += 1; continue }
      if !shows(hierarchy("links-missing-\(kind)"), "not available") { failures += 1 }
    }
    // The Android half found five unknown top-level routes dead-ending on a
    // blank screen instead of falling back to Home; probe the same set. Tree
    // size is not a destination check - the previous route, a sign-in screen or
    // an error screen would all clear it - so require Home's own landmark.
    for route in ["auth", "login", "preview_exit", "sign-in", "sign-out"] {
      guard openScheme(route, cold: false) else { gaps += 1; continue }
      let tree = hierarchy("links-unknown-\(route)")
      guard let expected = homeLandmark else { gaps += 1; continue }
      if !shows(tree, expected) { failures += 1 }
    }
    finish(row: "custom-links", status: verdict(failures: failures, gaps: gaps),
           notes: "Cold and warm custom-scheme routing, fail-closed unknown identifiers and five unknown top-level routes were driven through Safari hand-off; each unknown route was required to reach Home's own landmark (\(homeLandmark ?? "none observed")) rather than merely a non-blank screen. failures=\(failures) unobserved=\(gaps). Authenticated routing is not claimed: no session was established.")
  }

  func testBackgroundPrivacy() {
    guard enterPreview() != nil else {
      finish(row: "background-privacy", status: "not_executed", notes: "PREVIEW surface unreachable.")
      return
    }
    var failures = 0
    let before = hierarchy("privacy-before-background")
    shot("privacy-before-background")
    guard background(seconds: 4) else {
      finish(row: "background-privacy", status: "not_executed",
             notes: "The application did not leave the foreground, so no background behaviour was observed.")
      return
    }
    // Policy: the app switcher is never captured. The protected state is read
    // from the application's own hierarchy after it returns.
    step("app-switcher", "not-captured", ["reason": "capturing another application's snapshot of this session is out of policy"])
    guard launchApp(cold: false) else {
      finish(row: "background-privacy", status: "not_executed", notes: "The application did not return to the foreground.")
      return
    }
    let after = hierarchy("privacy-after-foreground")
    if DrillChannel.count(after) < 5 { failures += 1 }
    if labels(after).isEmpty && !labels(before).isEmpty { failures += 1 }
    shot("privacy-after-foreground")
    // Neither protection this row's acceptance names is observed here: the
    // app-switcher snapshot is out of policy to capture, and foreground relock
    // needs an authenticated session and an enrolled biometric this drill never
    // establishes. Both stay unobserved, so the row cannot report `pass`.
    step("relock", "not-observed",
         ["reason": "no authenticated session and no enrolled biometric were established, so foreground relock was never exercised"])
    finish(row: "background-privacy", status: verdict(failures: failures, gaps: 2),
           notes: "Backgrounded and restored the application through the XCUITest channel and read the returned state from its own hierarchy. failures=\(failures) unobserved=2. Neither protection the row's acceptance names was observed: the app-switcher snapshot is deliberately not captured, and foreground relock needs an enrolled biometric and an authenticated session this drill does not establish. The row is therefore partial at best and never clears its acceptance.")
  }

  func testScreenReader() {
    guard enterPreview() != nil else {
      finish(row: "screen-reader", status: "not_executed", notes: "PREVIEW surface unreachable.")
      return
    }
    var actionable = 0
    var unnamed = 0
    var screens = 0
    for (route, _) in memberFeatures {
      guard openScheme("feature/\(route)", cold: false) else { continue }
      let tree = hierarchy("a11y-\(route)")
      screens += 1
      for element in DrillChannel.flatten(tree) {
        let traits = element["traits"] as? [String] ?? []
        let isActionable = traits.contains("button") || traits.contains("link")
          || traits.contains("adjustable") || traits.contains("toggleButton")
        guard isActionable else { continue }
        actionable += 1
        if (element["label"] as? String ?? "").isEmpty { unnamed += 1 }
      }
    }
    // Turning VoiceOver on takes touch delivery away from XCUITest, so this row
    // evidences control semantics, not spoken traversal - the same downgrade
    // the Android half took when TalkBack utterances were not captured.
    step("voiceover-traversal", "not-captured", ["reason": "VoiceOver intercepts touch delivery and ends the XCUITest session"])
    finish(row: "screen-reader", status: verdict(failures: unnamed, gaps: 1),
           notes: "Across \(screens) screens the channel read \(actionable) actionable nodes, of which \(unnamed) carried no accessible name. Spoken VoiceOver traversal order and utterances were not captured because enabling VoiceOver ends the automation session.")
  }

  // MARK: - rows that also need a device-settings capability

  func testOffline() {
    guard ProcessInfo.processInfo.environment["PSG_DRILL_ALLOW_AIRPLANE"] == "1" else {
      finish(row: "offline", status: "not_executed",
             notes: "Airplane-mode control was not authorised for this run (PSG_DRILL_ALLOW_AIRPLANE is unset). The drill must be driven over USB before the radios may be switched.")
      return
    }
    guard enterPreview() != nil else {
      finish(row: "offline", status: "not_executed", notes: "PREVIEW surface unreachable.")
      return
    }
    // Cleanup is registered BEFORE the first attempted mutation, so a toggle
    // that settles after an early return is still put back; the recipe
    // certifies restoration only from the recorded steps.
    defer { _ = restoreAirplaneMode() }
    guard setAirplaneMode(true) else {
      finish(row: "offline", status: "not_executed",
             notes: "The Airplane Mode switch was not reachable, unrecognised, or did not settle on, so no offline transition was observed.")
      return
    }
    var failures = 0
    var gaps = 0
    for route in ["home", "messages", "feature/cases", "feature/search"] {
      guard openScheme(route, cold: false) else { gaps += 1; continue }
      let tree = hierarchy("offline-\(route.replacingOccurrences(of: "/", with: "-"))")
      // Offline must collapse to a guard, never to member content.
      if shows(tree, "GR-2026-") { failures += 1 }
    }
    if !restoreAirplaneMode() { failures += 1 }
    _ = openScheme("home", cold: false)
    let restored = hierarchy("offline-restored")
    if !shows(restored, "PREVIEW demo") { failures += 1 }
    finish(row: "offline", status: verdict(failures: failures, gaps: gaps),
           notes: "Four routes were driven with the radios off through the Settings.app Airplane Mode switch and the session was restored afterwards. failures=\(failures) unobserved=\(gaps). Airplane Mode was returned to its original value before the row ended, or the row records that it could not be.")
  }

  func testTextScaling() {
    let category = "UICTContentSizeCategoryAccessibilityXXXL"
    guard relaunchWithContentSizeCategory(category) else {
      finish(row: "text-scaling", status: "not_executed",
             notes: "The application did not relaunch with the requested content size category.")
      return
    }
    defer { app.launchArguments = DrillChannel.appLaunchArguments }
    guard enterPreview() != nil else {
      finish(row: "text-scaling", status: "not_executed", notes: "PREVIEW surface unreachable at the extreme text size.")
      return
    }
    var zeroSized = 0
    var overflowing = 0
    var screens = 0
    var gaps = 0
    for route in ["home", "account", "feature/cases", "feature/member-support"] {
      // A hand-off that never lands is an unobserved screen, not a clean one:
      // without this the row could measure nothing at all and still pass.
      guard openScheme(route, cold: false) else { gaps += 1; continue }
      let tree = hierarchy("scaling-\(route.replacingOccurrences(of: "/", with: "-"))")
      screens += 1
      let width = (((tree["frame"] as? [String: Any])?["w"]) as? Int) ?? 0
      for element in DrillChannel.flatten(tree) {
        guard !((element["label"] as? String) ?? "").isEmpty else { continue }
        let frame = element["frame"] as? [String: Any] ?? [:]
        let w = (frame["w"] as? Int) ?? 0
        let h = (frame["h"] as? Int) ?? 0
        let x = (frame["x"] as? Int) ?? 0
        if w == 0 || h == 0 { zeroSized += 1 }
        if width > 0 && x + w > width { overflowing += 1 }
      }
      shot("scaling-\(route.replacingOccurrences(of: "/", with: "-"))")
    }
    guard screens > 0 else {
      finish(row: "text-scaling", status: "not_executed",
             notes: "No screen was reached at \(category): every custom-scheme hand-off failed, so nothing was measured.")
      return
    }
    finish(row: "text-scaling", status: verdict(failures: zeroSized + overflowing, gaps: gaps),
           notes: "Relaunched under \(category) and measured \(screens) screens: \(zeroSized) zero-size and \(overflowing) viewport-overflowing labelled nodes. unobserved=\(gaps) routes did not open and were not measured. The category is a per-process override, not a change to the device's system text size.")
  }

  func testReducedMotion() {
    // Cleanup precedes the first attempted mutation (see testOffline).
    defer { _ = restoreReduceMotion() }
    guard setReduceMotion(true) else {
      finish(row: "reduced-motion", status: "not_executed",
             notes: "The Reduce Motion switch was not reachable, unrecognised, or did not settle on, so no reduce-motion behaviour was observed.")
      return
    }
    guard enterPreview() != nil else {
      finish(row: "reduced-motion", status: "not_executed", notes: "PREVIEW surface unreachable with Reduce Motion on.")
      return
    }
    let reduced = hierarchy("motion-reduced-home")
    shot("motion-reduced-home")
    // The comparison needs the setting OFF; restoration to the original value
    // happens in the deferred call, whatever that original was.
    guard setReduceMotion(false) else {
      finish(row: "reduced-motion", status: "not_executed", notes: "Reduce Motion could not be restored, so the comparison was not completed.")
      return
    }
    guard launchApp(cold: true), enterPreview() != nil else {
      finish(row: "reduced-motion", status: "not_executed", notes: "The application did not return after Reduce Motion was restored.")
      return
    }
    let normal = hierarchy("motion-normal-home")
    shot("motion-normal-home")
    // Two hierarchies of one static screen cannot show a motion difference by
    // themselves; the row reports the observation and its own limit.
    let sameShape = DrillChannel.count(reduced) == DrillChannel.count(normal)
    finish(row: "reduced-motion", status: "partial",
           notes: "Reduce Motion was set on and off through Settings.app and the same surface was captured in both states (node parity: \(sameShape)); the switch is returned to its original value as the row ends. A static hierarchy pair does not prove an animation responded to the signal; that needs a frame capture the runner does not take.")
  }
}
